import { ClusterCatalog, parseClusters } from "./cluster-filter.ts";
import { join } from "node:path";
import { readTargetDdls } from "./target-ddl.ts";
import { createServer, type Server } from "node:http";
import { regionTopics } from "./region-topics.ts";
import { cancellableRead } from "./cancellable-read.ts";
import { queryExperimentalUpstreamScope } from "./experimental-upstream-scope/endpoint.ts";
import { readFileSync } from "node:fs";
import { PublishedFieldOrigins, evidenceOrigins, bindingKey } from "./field-value-origin.ts";
import { fileURLToPath } from "node:url";
import { openAssetGraph } from "./config.ts";
import { AssetGraphStore } from "./store.ts";
import {
  getAssetGraphOverview,
  listAssetGraphRegionDatasets,
} from "./overview.ts";
import { readJson, type PreparedManifest, type Evidence } from "./publish.ts";
import type { FactRecord } from "./compile.ts";
import type { TaskLocalProjection } from "../../../../scripts/project-graph/task-local/contract.ts";
import { unpackTaskLocalProjectionEnvelope } from "../continuation/task-local-projection.ts";
import {
  defaultTableMetadataCatalogRoot,
  TableMetadataResolver,
  type MetadataIdentity,
  type TableMetadata,
} from "./table-metadata.ts";
import { SchedulerTaskNameResolver } from "./scheduler-task-names.ts";
import { SchemaAnnotationResolver } from "./schema-annotation.ts";
import { buildTraceConsumptionFromRecords } from "./trace-consumption.ts";
import { queryTaskFieldExplanation } from "./task-field-explanation-query.ts";
import { PartitionQueries } from "./partition-query.ts";
import { parsePartitionSelection } from "./partition-selection.ts";
import { physicalTableNodeId } from "./task-table-context.ts";
import { RequestPerformanceLog } from "./performance-log.ts";

type GraphNode = Record<string, unknown>;

const traceTaskIds = (nodes: readonly GraphNode[]) =>
  nodes
    .map((node) => node.taskId)
    .filter((taskId): taskId is string => typeof taskId === "string");

export function metadataIdentity(
  node: GraphNode,
  linkedIdentity?: MetadataIdentity,
): MetadataIdentity | undefined {
  const candidate =
    node.metadataIdentity && typeof node.metadataIdentity === "object"
      ? node.metadataIdentity
      : node.detail;
  const own = candidate && typeof candidate === "object"
    ? candidate as MetadataIdentity
    : undefined;
  const normalized = (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : "";
  const complete = (identity?: MetadataIdentity) =>
    !!identity && ["platform", "dataSource", "qualifiedName"].every(
      (field) => normalized(identity[field as keyof MetadataIdentity]),
    );
  // Only use the physical dataset linked by the write occurrence. Explicit
  // uncertainty or conflicting identity evidence must retain the missing state.
  if (complete(own) || (own?.identityStatus && own.identityStatus !== "CONFIRMED"))
    return own;
  if (!complete(linkedIdentity) ||
      (linkedIdentity?.identityStatus && linkedIdentity.identityStatus !== "CONFIRMED"))
    return own;
  for (const field of ["platform", "dataSource", "qualifiedName", "stableTableId"] as const) {
    if (normalized(own?.[field]) &&
        normalized(own?.[field]) !== normalized(linkedIdentity?.[field]))
      return own;
  }
  return linkedIdentity;
}

async function annotateNodes(
  resolver: TableMetadataResolver,
  schemaResolver: SchemaAnnotationResolver,
  nodes: readonly GraphNode[],
  identities = new Map<string, Record<string, unknown>>(),
): Promise<GraphNode[]> {
  const selected = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) =>
      [
        "PHYSICAL_DATASET",
        "PHYSICAL_FIELD",
        "READ_FIELD",
        "WRITE_FIELD",
      ].includes(String(node.kind)),
    );
  const requests = selected.map(({ node }) => ({
    identity: metadataIdentity(node, identities.get(String(node.id))),
    column: typeof node.column === "string" ? node.column : undefined,
  }));
  const values = await resolver.resolveMany(requests);
  const schemaValues = schemaResolver.resolveMany(
    requests.map(({ identity }) => identity),
  );
  const result = [...nodes];
  selected.forEach(({ node, index }, valueIndex) => {
    const schema = schemaValues[valueIndex];
    result[index] = {
      ...node,
      metadata: {
        ...values[valueIndex],
        ...(schema ? { schema } : {}),
      },
    };
  });
  return result;
}

async function taskBindingMetadata(
  projectionPath: string,
  contentHash: string,
  bindings: readonly FactRecord[],
  resolver: Pick<TableMetadataResolver, "resolveMany">,
): Promise<
  readonly {
    metadata: Omit<TableMetadata, "metadataCatalog">;
    outputScope: "FINAL" | "OTHER" | "UNKNOWN";
  }[]
> {
  if (!bindings.length) return [];
  try {
    const { projection: body } = unpackTaskLocalProjectionEnvelope({
      envelope: readJson<unknown>(projectionPath),
      manifestTaskContentHash: contentHash,
    });
    const projection = body as TaskLocalProjection;
    const nodes = new Map(projection.nodes.map((node) => [node.nodeId, node]));
    const normalize = (value: unknown) =>
      typeof value === "string" ? value.trim().toLowerCase() : "";
    const requests = bindings.map((binding) => {
      const writes = (projection.localClosure?.finalWrites ?? []).filter(
        (write) =>
          Boolean(binding.write_observation_id) &&
          write.writeObservationId === binding.write_observation_id,
      );
      const write = writes.length === 1 ? writes[0] : undefined;
      const target = write && nodes.get(write.targetWriteNodeId);
      const dataset = write && nodes.get(write.datasetNodeId);
      const identity =
        target?.nodeType === "TARGET_WRITE" &&
        dataset?.nodeType === "PHYSICAL_DATASET"
          ? metadataIdentity({ detail: target.properties }, dataset.properties)
          : undefined;
      const matchesTable =
        !normalize(binding.target_dataset) ||
        normalize(binding.target_dataset) ===
          normalize(identity?.qualifiedName);
      return {
        outputScope:
          write && write.outputQualification !== "SQL_UNCONSUMED"
            ? ("FINAL" as const)
            : ("OTHER" as const),
        identity: matchesTable ? identity : undefined,
        column:
          typeof binding.target_field === "string"
            ? binding.target_field
            : undefined,
      };
    });
    const values = await resolver.resolveMany(requests);
    return values.map((metadata, index) => ({
      metadata,
      outputScope: requests[index]!.outputScope,
    }));
  } catch {
    // Annotation failures must not hide the original processing evidence.
    return bindings.map(() => ({
      outputScope: "UNKNOWN",
      metadata: {
        table: {
          status: "METADATA_READ_FAILED",
          reason: "PROCESSING_METADATA_READ_FAILED",
        },
        field: {
          status: "METADATA_READ_FAILED",
          reason: "PROCESSING_METADATA_READ_FAILED",
        },
      },
    }));
  }
}

export async function taskDetail(
  store: AssetGraphStore,
  taskId: string,
  column?: string,
  writeId?: string,
  sql = false,
  metadata?: Pick<TableMetadataResolver, "resolveMany">,
) {
  const state = await store.ready(),
    manifest = readJson<PreparedManifest>(String(state.manifestPath));
  const task = manifest.tasks.find((t) => t.taskId === taskId);
  if (!task) throw new Error("TASK_NOT_IN_PUBLISHED_GRAPH");
  const e = readJson<Evidence>(task.evidencePath),
    expressions = new Map(e.expressions.map((x) => [x.expression_id, x]));
  const origins = evidenceOrigins(e);
  const bindings = e.bindings.filter(
    (b) =>
      (!column ||
        String(b.target_field).toLowerCase() === column.toLowerCase()) &&
      (!writeId || b.write_observation_id === writeId),
  );
  const statementIds = new Set(
    bindings.map((b) => b.write_statement_id ?? b.statement_id),
  );
  const metadataValues = metadata
    ? await taskBindingMetadata(task.path, task.contentHash, bindings, metadata)
    : undefined;
  const controls = e.relations
    .filter(
      (r) =>
        (!column || statementIds.has(r.statement_id)) &&
        ["filter", "join", "aggregate", "window", "setop"].includes(
          String(r.relation_type),
        ),
    )
    .map((r) => {
      const body = (r.relation ?? {}) as FactRecord;
      return {
        kind: r.relation_type,
        relationId: r.relation_id,
        joinType: body.join_type ?? null,
        condition:
          body.condition_display ??
          body.condition_expr ??
          body.predicate ??
          null,
        groupBy: body.group_by ?? body.group_columns ?? null,
        window: body.window ?? body.window_spec ?? null,
        sourceText: r.source_text ?? null,
      };
    });
  const value = {
    taskId,
    taskName: task.taskName,
    taskCategory: task.taskCategory,
    coverage: task.coverageStatus,
    failureReason: task.failureReasonCode,
    bindings: bindings.map((b, index) => ({
      column: b.target_field,
      table: b.target_dataset,
      writeId: b.write_observation_id,
      ...(metadataValues ? metadataValues[index] : {}),
      expression:
        expressions.get(b.expression_id)?.expression_text ??
        expressions.get(b.expression_id)?.display_text ??
        null,
      sourceSpan: expressions.get(b.expression_id)?.source_span ?? null,
      inputFields: expressions.get(b.expression_id)?.input_fields ?? [],
      valueOrigin: origins.get(bindingKey(b.write_observation_id, b.target_field)),
    })),
    controls,
    sqlSources: sql ? e.sqlSources : undefined,
    version: state.version,
  };
  return value;
}
export async function startAssetGraphServer(
  configPath?: string,
  port = 8791,
  options: {
    readonly metadataCatalogRoot?: string;
    readonly datasourceCatalogPath?: string;
  } = {},
): Promise<{ server: Server; close: () => Promise<void> }> {
  const connection = await openAssetGraph(configPath);
  const store = new AssetGraphStore(
    connection.driver,
    connection.database,
    connection.graphId,
  );
  const metadata = new TableMetadataResolver(
    options.metadataCatalogRoot ??
      defaultTableMetadataCatalogRoot(connection.paths?.evidenceRoot ?? "."),
  );
  const fieldOrigins = new PublishedFieldOrigins();
  const schedulerTaskNames = new SchedulerTaskNameResolver(
    connection.paths?.evidenceRoot ?? ".",
  );
  const schemaAnnotations = new SchemaAnnotationResolver(
    options.datasourceCatalogPath,
  );
  const html = readFileSync(
    fileURLToPath(new URL("./viewer.html", import.meta.url)),
    "utf8",
  );
  const clusterCatalog = new ClusterCatalog(store, schedulerTaskNames);
  const partitionQueries = new PartitionQueries(store, connection.paths.graphOutputRoot);
  const performanceLog = new RequestPerformanceLog();
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    const signal = controller.signal;
    res.once("close", () => { if (!res.writableFinished) controller.abort(); });
    const overviewStore = {
      ready: () => cancellableRead(signal, () => store.ready()),
      run: (...args: Parameters<typeof store.run>) => cancellableRead(signal, () => store.run(...args)),
    };
    const requestId = performanceLog.start(req.url ?? "/");
    res.setHeader("X-Graph-Request-Id", requestId);
    res.once("finish", () => performanceLog.finish(requestId, res.statusCode));
    res.once("close", () => { if (!res.writableFinished) performanceLog.disconnect(requestId); });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const browserReport = req.method === "POST" && url.pathname === "/api/diagnostics/browser";
    if (req.method !== "GET" && !browserReport) {
      res.writeHead(405);
      res.end();
      return;
    }
    const q = url.searchParams;
    const num = (key: string, defaultValue: number) => {
      const raw = q.get(key);
      const n = raw === null ? defaultValue : Number(raw);
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error(
          key === "offset" ? "INVALID_QUERY_OFFSET" : "INVALID_QUERY_LIMIT",
        );
      return n;
    };
    try {
      if (browserReport) {
        const origin = req.headers.origin;
        if (req.headers["content-type"]?.split(";")[0] !== "application/json" || (origin && new URL(origin).host !== req.headers.host) || req.headers["sec-fetch-site"] === "cross-site") {
          res.writeHead(403); res.end(); return;
        }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 64000) throw new Error("BROWSER_DIAGNOSTICS_TOO_LARGE");
          chunks.push(Buffer.from(chunk));
        }
        performanceLog.recordBrowser(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(204); res.end(); return;
      }
      if (url.pathname === "/api/diagnostics") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(performanceLog.snapshot()));
        return;
      }
      if (url.pathname === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }
      let value: unknown;
      const clusters = parseClusters(q.get("clusters"));
      const clusterTaskIds = await clusterCatalog.select(clusters);
      if (signal.aborted) return;
      if (url.pathname === "/api/clusters") {
        const catalog = await clusterCatalog.read();
        value = { version: catalog.version, clusters: catalog.clusters };
      } else if (url.pathname === "/api/region-topics") {
        value = await regionTopics(store, schedulerTaskNames, q, clusterTaskIds, signal);
      } else if (url.pathname === "/api/experimental/upstream-scope") {
        value = await queryExperimentalUpstreamScope(store, q, clusterTaskIds);
      } else if (url.pathname === "/api/status") {
        const s = await store.ready();
        value = {
          state: s.state,
          version: s.version,
          metadataCatalog: metadata.status(),
          ...JSON.parse(s.report),
        };
      } else if (url.pathname === "/api/search") {
        const text = q.get("q") ?? "";
        const limit = Math.max(1, Math.min(100, num("limit", 30)));
        const offset = num("offset", 0);
        value = await annotateNodes(
          metadata,
          schemaAnnotations,
          await store.search(
            text,
            limit,
            offset,
            await metadata.searchDescription(text, {
              // The graph store applies the final offset across technical-name and
              // description matches. Supply the bounded prefix it needs;
              // applying the offset here as well would skip description hits
              // twice.
              limit: Math.min(100, limit + offset),
            }),
            clusterTaskIds,
          ),
        );
        const searchNodes = value as GraphNode[];
        const names = schedulerTaskNames.resolve(
          searchNodes.filter(node => node.kind === "TASK").map(node => String(node.id).replace(/^task:/, "")),
        );
        value = searchNodes.map(node => node.kind === "TASK"
          ? { ...node, label: names[String(node.id).replace(/^task:/, "")] ?? `任务 ${String(node.id).replace(/^task:/, "")}（名称未收录）` }
          : node);
      } else if (url.pathname === "/api/partitions") {
        const catalog = await partitionQueries.catalog(physicalTableNodeId(q.get("nodeId") ?? ""));
        const taskIds = catalog.options.flatMap(option => option.writes.map(write => write.taskId));
        value = {...catalog, taskClusters: schedulerTaskNames.resolveClusters(taskIds)};
      } else if (url.pathname === "/api/fields")
        value = await annotateNodes(
          metadata,
          schemaAnnotations,
          await store.fields({
            taskId: q.get("taskId") ?? undefined,
            table: q.get("table") ?? undefined,
            nodeId: q.get("nodeId") ?? undefined,
            limit: num("limit", 300),
            offset: num("offset", 0),
          }),
        );
      else if (url.pathname === "/api/overview")
        value = await getAssetGraphOverview(overviewStore, {
          hiddenTables: JSON.parse(q.get("hiddenTables") ?? "[]"),
          clusterTaskIds,
          regionLimit: num("regionLimit", 100),
          flowLimit: num("flowLimit", 150),
        });
      else if (url.pathname === "/api/regions") {
        const region = await listAssetGraphRegionDatasets(store, {
          schema: q.get("schema") ?? "",
          hiddenTables: JSON.parse(q.get("hiddenTables") ?? "[]"),
          clusterTaskIds,
          limit: num("limit", 50),
          offset: num("offset", 0),
        });
        value = {
          ...region,
          items: await annotateNodes(metadata, schemaAnnotations, region.items),
        };
      } else if (url.pathname === "/api/explain") {
        value = await queryTaskFieldExplanation(store, {
          taskId: q.get("taskId") ?? "", writeId: q.get("writeId") ?? "", column: q.get("column") ?? "",
          publicationVersion: q.get("publicationVersion") ?? undefined,
          maxDepth: num("maxDepth", 32), maxNodes: num("maxNodes", 500), maxEdges: num("maxEdges", 1000),
        });
      } else if (url.pathname === "/api/task") {
        const taskId = q.get("taskId") ?? "";
        const detail = await taskDetail(
          store,
          taskId,
          q.get("column") ?? undefined,
          q.get("writeId") ?? undefined,
          q.get("sql") === "1",
          metadata,
        );
        value = {
          ...detail,
          ...(q.get("ddl") === "1" ? {
            targetDdls: readTargetDdls(join(connection.paths.inputPackRoot, "tables"), detail.bindings),
          } : {}),
          bindings: detail.bindings.filter((binding) => binding.outputScope === "FINAL"),
          taskName: schedulerTaskNames.resolve([taskId])[taskId],
          owner: schedulerTaskNames.resolveOwners([taskId])[taskId],
          cluster: schedulerTaskNames.resolveClusters([taskId])[taskId],
        };
      } else if (url.pathname === "/api/trace") {
        const layer = q.get("layer") ?? "table";
        if (!["table", "field", "schedule"].includes(layer))
          throw new Error("INVALID_GRAPH_LAYER");
        const direction = q.get("direction") ?? "up";
        if (!["up", "down"].includes(direction))
          throw new Error("INVALID_GRAPH_DIRECTION");
        const depthUnit = q.get("depthUnit") ?? "edge";
        if (!["edge", "table-hop"].includes(depthUnit))
          throw new Error("INVALID_DEPTH_UNIT");
        const partitionSelection = parsePartitionSelection(q.get("partitionSelection"));
        if (partitionSelection && layer === "field") await partitionQueries.validateField(partitionSelection, q.get("nodeId") ?? "");
        const trace = partitionSelection && layer === "table" ? await partitionQueries.trace(partitionSelection, {
          direction: direction as "up" | "down", depth: num("depth", 4), limit: num("limit", 150), includeCandidates: q.get("candidates") !== "0",
          focusNodeId: q.get("scopeFocus") ?? undefined, scopeDepth: num("scopeDepth", 1), scopeDirection: q.get("scopeDirection") === "down" ? "down" : "up", clusterTaskIds,
        }) : await store.traverse({
          taskId: q.get("taskId") ?? undefined,
          nodeId: q.get("nodeId") ?? undefined,
          column: q.get("column") ?? undefined,
          table: q.get("table") ?? undefined,
          writeId: q.get("writeId") ?? undefined,
          layer: layer as "table" | "field" | "schedule",
          direction: direction as "up" | "down",
          depthUnit: depthUnit as "edge" | "table-hop",
          depth: num("depth", 4),
          limit: num("limit", 150),
          includeCandidates: q.get("candidates") !== "0",
        });
        const identities = await store.metadataIdentities(
          trace.nodes.map((node) => String(node.id)),
        );
        let annotatedTraceNodes = trace.nodes;
        if (layer === "field" && trace.nodes.some(node => node.kind === "WRITE_FIELD")) {
          const state = await store.ready();
          if (String(state.version) !== trace.version) throw new Error("ASSET_GRAPH_CHANGED_DURING_QUERY");
          const incoming = new Set(trace.edges.map(edge => edge.to));
          const frontier = new Set(trace.frontierNodeIds);
          const stopped = new Set(trace.direction === "up" ? trace.nodes
            .filter(node => node.kind === "WRITE_FIELD" && !incoming.has(String(node.id)) && !frontier.has(String(node.id)))
            .map(node => String(node.id)) : []);
          annotatedTraceNodes = fieldOrigins.annotate(trace.nodes, String(state.manifestPath), stopped);
        }
        // A trace can synthesize task cards from VALUE edges. Read task names
        // from the local scheduler catalog, not evidence descriptions.
        const taskLabels = schedulerTaskNames.resolve(
          traceTaskIds(trace.nodes),
        );
        const consumption = buildTraceConsumptionFromRecords({
          direction: trace.direction,
          nodes: trace.nodes.map((node) => ({
            ...node,
            metadataIdentity: identities.get(String(node.id)),
          })),
          edges: trace.edges,
        });
        value = {
          ...trace,
          taskLabels,
          taskTopics: schedulerTaskNames.resolveTopics(traceTaskIds(trace.nodes)),
          taskClusters: schedulerTaskNames.resolveClusters(traceTaskIds(trace.nodes)),
          taskTopicDescriptions: schedulerTaskNames.resolveTopicDescriptions(traceTaskIds(trace.nodes)),
          consumption,
          nodes: await annotateNodes(
            metadata,
            schemaAnnotations,
            annotatedTraceNodes,
            identities,
          ),
        };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      if (signal.aborted) return;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Server-Timing", `graph;dur=${performanceLog.elapsed(requestId)}`);
      res.end(JSON.stringify(value));
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : "QUERY_FAILED";
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: /^[A-Z0-9_: -]+$/.test(message)
            ? message
            : "ASSET_GRAPH_QUERY_FAILED",
        }),
      );
    } finally {
      performanceLog.finish(requestId, res.statusCode);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    server,
    close: async () => {
      metadata.close();
      schemaAnnotations.close();
      schedulerTaskNames.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await connection.driver.close();
    },
  };
}
