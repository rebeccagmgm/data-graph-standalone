import { clusterParams, clusterTablePredicate, clusterTaskPredicate } from "./cluster-filter.ts";
import { int, type Driver } from "neo4j-driver";
import type { AssetNode, AssetEdge, CompiledTask } from "./compile.ts";
import { parseTaskTableId, physicalTableNodeId } from "./task-table-context.ts";
import { traverseTaskTables, type TableNode, type TableEdge, type TableTraversalReader } from "./task-table-traversal.ts";
const chunks = <T>(xs: readonly T[], size = 500) =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) =>
    xs.slice(i * size, (i + 1) * size),
  );
const key = (graphId: string, id: string) => `${graphId}|${id}`;

type AssetGraphCounts = {
  nodes: Record<string, number>;
  edges: Record<string, number>;
};

function countDelta(
  before: unknown,
  after: AssetGraphCounts,
): AssetGraphCounts | null {
  if (!before || typeof before !== "object" || Array.isArray(before))
    return null;
  const candidate = before as { nodes?: unknown; edges?: unknown };
  if (
    !candidate.nodes ||
    typeof candidate.nodes !== "object" ||
    Array.isArray(candidate.nodes) ||
    !candidate.edges ||
    typeof candidate.edges !== "object" ||
    Array.isArray(candidate.edges)
  )
    return null;
  const delta = (prior: unknown, current: Record<string, number>) => {
    const values = prior as Record<string, unknown>;
    return Object.fromEntries(
      [...new Set([...Object.keys(values), ...Object.keys(current)])]
        .sort()
        .map((kind) => [
          kind,
          (current[kind] ?? 0) - Number(values[kind] ?? 0),
        ]),
    );
  };
  return {
    nodes: delta(candidate.nodes, after.nodes),
    edges: delta(candidate.edges, after.edges),
  };
}

export class AssetGraphStore {
  constructor(
    readonly driver: Driver,
    readonly database: string,
    readonly graphId: string,
  ) {}
  async run(query: string, params: Record<string, unknown> = {}) {
    const session = this.driver.session({ database: this.database });
    try {
      return await session.run(query, {
        graphId: this.graphId,
        ...params,
        ...(typeof params.limit === "number"
          ? { limit: int(params.limit) }
          : {}),
        ...(typeof params.offset === "number"
          ? { offset: int(params.offset) }
          : {}),
      });
    } finally {
      await session.close();
    }
  }
  async initialize() {
    for (const query of [
      "CREATE CONSTRAINT sl_asset_node_key IF NOT EXISTS FOR (n:SLAssetNode) REQUIRE n.key IS UNIQUE",
      "CREATE CONSTRAINT sl_asset_owner_key IF NOT EXISTS FOR (n:SLAssetOwner) REQUIRE n.key IS UNIQUE",
      "CREATE CONSTRAINT sl_asset_graph_id IF NOT EXISTS FOR (n:SLAssetGraph) REQUIRE n.id IS UNIQUE",
      "CREATE INDEX sl_asset_task_field IF NOT EXISTS FOR (n:SLAssetNode) ON (n.graphId,n.kind,n.taskId,n.column)",
      "CREATE INDEX sl_asset_task_fields IF NOT EXISTS FOR (n:SLAssetNode) ON (n.graphId,n.kind,n.taskId)",
      "CREATE INDEX sl_asset_table_field IF NOT EXISTS FOR (n:SLAssetNode) ON (n.graphId,n.kind,n.table,n.column)",
      "CREATE INDEX sl_asset_kind IF NOT EXISTS FOR (n:SLAssetNode) ON (n.graphId,n.kind)",
      "CREATE INDEX sl_asset_edge_owner IF NOT EXISTS FOR ()-[r:SL_ASSET_EDGE]-() ON (r.ownerKey)",
    ])
      await this.run(query);
  }
  async state() {
    const r = await this.run(
      "MATCH (g:SLAssetGraph {id:$graphId}) RETURN properties(g) AS g",
    );
    return r.records[0]?.get("g") ?? null;
  }
  async owners(): Promise<Map<string, string>> {
    const r = await this.run(
      "MATCH (o:SLAssetOwner {graphId:$graphId}) RETURN o.id AS id,o.hash AS hash",
    );
    return new Map(
      r.records.map((r) => [String(r.get("id")), String(r.get("hash"))]),
    );
  }
  async begin(version: string) {
    await this.run(
      "MERGE (g:SLAssetGraph {id:$graphId}) SET g.state='UPDATING',g.pendingVersion=$version",
      { version },
    );
  }
  /** Upgrade storage metadata even when unchanged content hashes skip replacement. */
  async upgradeOwnerEdgeSources(): Promise<number> {
    const session = this.driver.session({ database: this.database });
    try {
      return await session.executeWrite(async (tx) => {
        const missing = await tx.run(
          "MATCH (o:SLAssetOwner {graphId:$graphId}) WHERE o.edgeSourceKeys IS NULL RETURN o.key AS ownerKey,o.hash AS hash",
          { graphId: this.graphId },
        );
        if (!missing.records.length) return 0;
        const rows = new Map(
          missing.records.map((r) => [
            String(r.get("ownerKey")),
            {
              key: String(r.get("ownerKey")),
              hash: String(r.get("hash")),
              sources: [] as string[],
            },
          ]),
        );
        // Scan once for the entire upgrade, including edge-only owners. Starting
        // from SL_ASSET_OWNS would miss continuation and scheduling edges.
        const sources = await tx.run(
          "MATCH (a:SLAssetNode)-[r:SL_ASSET_EDGE]->() WHERE r.ownerKey IN $ownerKeys RETURN DISTINCT r.ownerKey AS ownerKey,a.key AS sourceKey",
          { ownerKeys: [...rows.keys()] },
        );
        for (const r of sources.records)
          rows
            .get(String(r.get("ownerKey")))
            ?.sources.push(String(r.get("sourceKey")));
        for (const batch of chunks([...rows.values()])) {
          const result = await tx.run(
            "UNWIND $rows AS row MATCH (o:SLAssetOwner {key:row.key}) WHERE o.hash=row.hash AND o.edgeSourceKeys IS NULL SET o.edgeSourceKeys=row.sources RETURN count(o) AS updated",
            { rows: batch },
          );
          if (result.records[0]!.get("updated").toNumber() !== batch.length)
            throw new Error("ASSET_OWNER_METADATA_CHANGED");
        }
        return rows.size;
      });
    } finally {
      await session.close();
    }
  }
  async replace(
    owner: string,
    hash: string,
    graph: Pick<CompiledTask, "nodes" | "edges">,
  ) {
    const session = this.driver.session({ database: this.database });
    try {
      await session.executeWrite(async (tx) => {
        const params = {
          graphId: this.graphId,
          ownerKey: key(this.graphId, owner),
          owner,
          hash,
          edgeSourceKeys: [
            ...new Set(graph.edges.map((e) => key(this.graphId, e.from))),
          ],
        };
        // Start deletion from this owner's prior edge sources. A relationship
        // property index is not used by every Bolt-compatible query planner.
        const prior = await tx.run(
          "MATCH (o:SLAssetOwner {key:$ownerKey}) RETURN o.edgeSourceKeys AS sourceKeys",
          params,
        );
        if (prior.records.length) {
          const sourceKeys: unknown = prior.records[0]!.get("sourceKeys");
          if (Array.isArray(sourceKeys)) {
            for (const sourceBatch of chunks(sourceKeys))
              await tx.run(
                "UNWIND $sourceKeys AS sourceKey MATCH (a:SLAssetNode {key:sourceKey})-[r:SL_ASSET_EDGE {ownerKey:$ownerKey}]->() DELETE r",
                { ...params, sourceKeys: sourceBatch },
              );
          } else {
            // Existing publications did not retain source keys. Upgrade each
            // owner on its first replacement without leaving historical edges.
            await tx.run(
              "MATCH ()-[r:SL_ASSET_EDGE {ownerKey:$ownerKey}]->() DELETE r",
              params,
            );
          }
        }
        await tx.run(
          "MERGE (o:SLAssetOwner {key:$ownerKey}) SET o.graphId=$graphId,o.id=$owner,o.hash=$hash,o.edgeSourceKeys=$edgeSourceKeys WITH o OPTIONAL MATCH (o)-[r:SL_ASSET_OWNS]->() DELETE r",
          params,
        );
        for (const batch of chunks(graph.nodes))
          await tx.run(
            "UNWIND $nodes AS row MERGE (n:SLAssetNode {key:row.key}) SET n += row WITH n MATCH (o:SLAssetOwner {key:$ownerKey}) MERGE (o)-[:SL_ASSET_OWNS]->(n)",
            {
              ...params,
              nodes: batch.map((n) => ({
                ...n,
                key: key(this.graphId, n.id),
                graphId: this.graphId,
              })),
            },
          );
        for (const batch of chunks(graph.edges)) {
          const result = await tx.run(
            "UNWIND $edges AS row MATCH (a:SLAssetNode {key:row.fromKey}), (b:SLAssetNode {key:row.toKey}) MERGE (a)-[r:SL_ASSET_EDGE {key:row.key}]->(b) SET r += row RETURN count(r) AS written",
            {
              ...params,
              edges: batch.map((e) => ({
                ...e,
                key: key(this.graphId, `${owner}|${e.id}`),
                ownerKey: params.ownerKey,
                graphId: this.graphId,
                fromKey: key(this.graphId, e.from),
                toKey: key(this.graphId, e.to),
              })),
            },
          );
          if (result.records[0]!.get("written").toNumber() !== batch.length)
            throw new Error("ASSET_EDGE_ENDPOINT_MISSING");
        }
      });
    } finally {
      await session.close();
    }
  }
  async remove(owner: string) {
    await this.replace(owner, "REMOVED", { nodes: [], edges: [] });
    await this.run("MATCH (o:SLAssetOwner {key:$key}) DETACH DELETE o", {
      key: key(this.graphId, owner),
    });
  }
  async finish(
    version: string,
    manifestPath: string,
    report: Record<string, unknown>,
  ) {
    await this.run(
      "MATCH (n:SLAssetNode {graphId:$graphId}) WHERE NOT EXISTS {MATCH (:SLAssetOwner)-[:SL_ASSET_OWNS]->(n)} DETACH DELETE n",
    );
    const counts = await this.counts();
    const confirmedFieldContinuations = counts.edges.CONTINUES ?? 0;
    const candidateFieldContinuations = counts.edges.CANDIDATE ?? 0;
    const metrics = report.continuationMetrics;
    const finalizedReport = {
      ...report,
      confirmedFieldContinuations,
      candidateFieldContinuations,
      ...(metrics && typeof metrics === "object" && !Array.isArray(metrics)
        ? {
            continuationMetrics: {
              ...metrics,
              continuationEdgeMetrics: {
                totalContinuationEdges: confirmedFieldContinuations + candidateFieldContinuations,
                confirmedContinuationEdges: confirmedFieldContinuations,
              },
            },
          }
        : {}),
      counts,
      countBasis: "LIVE_AFTER_UNOWNED_CLEANUP",
      preCleanupCounts: report.counts ?? null,
      countDelta: countDelta(report.counts, counts),
    };
    await this.run(
      "MATCH (g:SLAssetGraph {id:$graphId}) SET g.state='READY',g.version=$version,g.manifestPath=$manifestPath,g.report=$report,g.publishedAt=datetime() REMOVE g.pendingVersion",
      { version, manifestPath, report: JSON.stringify(finalizedReport) },
    );
    return finalizedReport;
  }
  async counts() {
    const n = await this.run(
      "MATCH (n:SLAssetNode {graphId:$graphId}) RETURN n.kind AS kind,count(*) AS count",
    );
    const e = await this.run(
      "MATCH ()-[r:SL_ASSET_EDGE {graphId:$graphId}]->() RETURN r.kind AS kind,count(*) AS count",
    );
    return {
      nodes: Object.fromEntries(
        n.records.map((r) => [r.get("kind"), r.get("count").toNumber()]),
      ),
      edges: Object.fromEntries(
        e.records.map((r) => [r.get("kind"), r.get("count").toNumber()]),
      ),
    };
  }
  async ready() {
    const state = await this.state();
    if (state?.state !== "READY") throw new Error("ASSET_GRAPH_NOT_PUBLISHED");
    return state;
  }
  async search(
    text: string,
    limit = 30,
    offset = 0,
    metadataIdentities: readonly {
      platform: string;
      dataSource: string;
      qualifiedName: string;
    }[] = [],
    clusterTaskIds?: string[],
  ) {
    await this.ready();
    const taskId = /^(?:task:)?(\d+)$/i.exec(text.trim())?.[1];
    if (taskId) {
      const result = await this.run(
        `MATCH (n:SLAssetNode {graphId:$graphId,kind:'TASK',id:$task}) WHERE ${clusterTaskPredicate("n")} RETURN properties(n) AS node SKIP $offset LIMIT $limit`,
        {
          task: `task:${taskId}`,
          ...clusterParams(clusterTaskIds),
          limit: Math.max(1, Math.min(101, Math.trunc(limit))),
          offset: Math.max(0, Math.trunc(offset)),
        },
      );
      return result.records.map((record) => cleanNode(record.get("node")));
    }
    const r = await this.run(
      `CALL { MATCH (n:SLAssetNode {graphId:$graphId,kind:'TASK'}) RETURN n UNION ALL MATCH (n:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'}) RETURN n } WITH n WHERE (toLower(n.label) CONTAINS $text OR n.id=$task OR (n.kind='PHYSICAL_DATASET' AND any(identity IN $metadataIdentities WHERE n.detail CONTAINS ('\\\"platform\\\":\\\"' + identity.platform + '\\\"') AND n.detail CONTAINS ('\\\"dataSource\\\":\\\"' + identity.dataSource + '\\\"') AND n.detail CONTAINS ('\\\"qualifiedName\\\":\\\"' + identity.qualifiedName + '\\\"')))) WITH collect(n) AS matchedNodes UNWIND matchedNodes AS n WITH n WHERE ((n.kind='TASK' AND ${clusterTaskPredicate("n")}) OR (n.kind='PHYSICAL_DATASET' AND ${clusterTablePredicate("n")})) RETURN properties(n) AS node ORDER BY n.kind,n.label,n.id SKIP $offset LIMIT $limit`,
      {
        text: text.toLowerCase(),
        task: `task:${text}`,
        metadataIdentities: [...metadataIdentities],
        ...clusterParams(clusterTaskIds),
        limit: Math.max(1, Math.min(101, Math.trunc(limit))),
        offset: Math.max(0, Math.trunc(offset)),
      },
    );
    return r.records.map((r) => cleanNode(r.get("node")));
  }
  async fields(input: {
    taskId?: string;
    table?: string;
    nodeId?: string;
    limit?: number;
    offset?: number;
  }) {
    if (input.nodeId) input = {...input, nodeId: physicalTableNodeId(input.nodeId)};
    await this.ready();
    const selectors = [input.taskId, input.table, input.nodeId].filter(
      (value) => value !== undefined,
    );
    if (selectors.length !== 1 || !selectors[0]!.trim())
      throw new Error(
        selectors.length > 1
          ? "FIELDS_SELECTORS_MUTUALLY_EXCLUSIVE"
          : "FIELDS_SELECTOR_REQUIRED",
      );
    const byDataset = input.nodeId !== undefined;
    const match = byDataset
      ? "MATCH (dataset:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET',key:$datasetKey})<-[:SL_ASSET_EDGE {graphId:$graphId,kind:'WRITES'}]-(target:SLAssetNode {graphId:$graphId,kind:'TARGET_WRITE'})-[:SL_ASSET_EDGE {graphId:$graphId,kind:'HAS_FIELD'}]->(n:SLAssetNode {graphId:$graphId,kind:'WRITE_FIELD'})"
      : input.taskId
        ? "UNWIND [$value] AS taskId MATCH (n:SLAssetNode {graphId:$graphId,kind:'WRITE_FIELD',taskId:taskId})"
        : "MATCH (n:SLAssetNode {graphId:$graphId,kind:'WRITE_FIELD'})";
    const filter = input.taskId
      ? "n.taskId=$value"
      : input.table
        ? "n.table=$value"
        : "true";
    const r = await this.run(
      `${match} WHERE ${filter} OPTIONAL MATCH (n)<-[:SL_ASSET_EDGE {graphId:$graphId,kind:'HAS_FIELD'}]-(target:SLAssetNode {graphId:$graphId,kind:'TARGET_WRITE'})-[:SL_ASSET_EDGE {graphId:$graphId,kind:'WRITES'}]->(dataset:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'}) WITH DISTINCT n,dataset RETURN properties(n) AS node,properties(dataset) AS dataset ORDER BY n.column,n.writeId,n.id SKIP $offset LIMIT $limit`,
      {
        value: input.taskId ?? input.table?.toLowerCase(),
        datasetKey: key(this.graphId, input.nodeId ?? ""),
        limit: Math.max(1, Math.min(1001, Math.trunc(input.limit ?? 300))),
        offset: Math.max(0, Math.trunc(input.offset ?? 0)),
      },
    );
    return r.records.map((r) => {
      const node = cleanNode(r.get("node"));
      const dataset = r.get("dataset") as Record<string, unknown> | null;
      return dataset
        ? { ...node, metadataIdentity: cleanNode(dataset).detail }
        : node;
    });
  }
  async metadataIdentities(nodeIds: readonly string[]) {
    if (!nodeIds.length) return new Map<string, Record<string, unknown>>();
    const r = await this.run(
      "UNWIND $keys AS key MATCH (n:SLAssetNode {key:key}) OPTIONAL MATCH (n)<-[:SL_ASSET_EDGE {graphId:$graphId,kind:'HAS_FIELD'}]-(target:SLAssetNode {graphId:$graphId,kind:'TARGET_WRITE'})-[:SL_ASSET_EDGE {graphId:$graphId,kind:'WRITES'}]->(dataset:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'}) RETURN n.id AS nodeId,properties(dataset) AS dataset",
      { keys: nodeIds.map((id) => key(this.graphId, id)) },
    );
    const identities = new Map<string, Record<string, unknown>>();
    for (const record of r.records) {
      const dataset = record.get("dataset") as Record<string, unknown> | null;
      if (!dataset) continue;
      const detail = cleanNode(dataset).detail;
      if (detail && typeof detail === "object")
        identities.set(
          String(record.get("nodeId")),
          detail as Record<string, unknown>,
        );
    }
    return identities;
  }
  async traverse(input: {
    taskId?: string;
    column?: string;
    table?: string;
    nodeId?: string;
    writeId?: string;
    layer: "field" | "table" | "schedule";
    depthUnit?: "edge" | "table-hop";
    direction?: "up" | "down";
    depth?: number;
    limit?: number;
    includeCandidates?: boolean;
  }) {
    const initial = await this.ready(),
      start = Date.now(),
      limit = Math.max(1, Math.min(1000, Math.trunc(input.limit ?? 150))),
      depth = Math.max(0, Math.min(12, Math.trunc(input.depth ?? 4)));
    const taskTableAnchor = input.nodeId ?? (!input.table && input.taskId ? `task:${input.taskId}` : undefined);
    if (input.layer === "table" && taskTableAnchor &&
        (taskTableAnchor.startsWith("task:") || parseTaskTableId(taskTableAnchor))) {
      const reader: TableTraversalReader = {
        node: async id => {
          // Keep the unique-key lookup separate: combining the graph guard lets
          // ArcadeDB select a graph-wide scan even for one exact task ID.
          const result = await this.run("MATCH (n:SLAssetNode {key:$key}) WITH n LIMIT 1 WHERE n.graphId=$graphId RETURN properties(n) AS node LIMIT 1", {key: key(this.graphId, id)});
          return result.records[0] ? cleanNode(result.records[0].get("node")) as TableNode : undefined;
        },
        adjacent: async (id, direction, layer, rowLimit, allowedTaskIds) => {
          const pattern = direction === "down" ? "(n)-[r:SL_ASSET_EDGE]->(m)" : "(n)<-[r:SL_ASSET_EDGE]-(m)";
          const result = await this.run(
            `MATCH (n:SLAssetNode {key:$key}) WITH n LIMIT 1 MATCH ${pattern} WHERE r.layer=$layer AND r.graphId=$graphId AND r.kind IN $kinds AND ($unrestricted OR m.id IN $allowedTaskIds) AND ($candidates OR r.status<>'CANDIDATE') RETURN properties(m) AS node,properties(r) AS edge ORDER BY r.key LIMIT $limit`,
            {key: key(this.graphId, id), layer, kinds: layer === "schedule" ? ["SCHEDULE"] : ["READS_TABLE", "WRITES_TABLE"],
              unrestricted: allowedTaskIds === undefined, allowedTaskIds: allowedTaskIds ?? [], candidates: input.includeCandidates !== false, limit: rowLimit},
          );
          return result.records.map(row => ({node: cleanNode(row.get("node")) as TableNode, edge: cleanEdge(row.get("edge")) as TableEdge}));
        },
      };
      const trace = await traverseTaskTables(reader, {nodeId: taskTableAnchor, direction: input.direction ?? "up", depth,
        depthUnit: input.depthUnit, limit, includeCandidates: input.includeCandidates !== false});
      if ((await this.ready()).version !== initial.version) throw new Error("ASSET_GRAPH_CHANGED_DURING_QUERY");
      return {...trace, version: initial.version, layer: input.layer, direction: input.direction ?? "up",
        depthLimit: depth, edgeLimit: limit, elapsedMs: Date.now() - start, projectionGenerations: 0};
    }
    const nodes = new Map<string, Record<string, unknown>>(),
      edges = new Map<string, Record<string, unknown>>();
    const terminalNodes = new Map<
      string,
      { nodeId: string; role: string; reason: string; ruleRef: string }
    >();
    let truncated = false;
    const stopsUpstream =
      (input.direction ?? "up") === "up" &&
      (input.layer === "field" || input.layer === "table");
    const terminal = (node: Record<string, unknown>) => {
      if (!stopsUpstream) return null;
      const detail = node.detail;
      if (!detail || typeof detail !== "object") return null;
      const d = detail as Record<string, unknown>;
      const disposition = d.continuationDisposition;
      if (
        disposition !== "POLICY_TERMINAL" &&
        disposition !== "SOURCE_ENDPOINT_BOUNDARY"
      )
        return null;
      if (
        disposition === "POLICY_TERMINAL" &&
        d.boundaryRole !== "REFERENCE_CONFIG"
      )
        return null;
      return {
        nodeId: String(node.id),
        role: String(d.boundaryRole ?? ""),
        reason: String(
          d.terminalReason ??
            (disposition === "SOURCE_ENDPOINT_BOUNDARY"
              ? "源端点边界，停止展开"
              : "按定义/参数表规则停止展开"),
        ),
        ruleRef: String(d.terminalRuleRef ?? ""),
      };
    };
    // Isolate the unique-key seek before the graphId guard. ArcadeDB otherwise
    // prefers the broad graphId index, even when key is in the pattern.
    const anchorPattern = input.nodeId
      ? "key:$key"
      : input.layer !== "field"
        ? input.table
          ? "graphId:$graphId,kind:'PHYSICAL_DATASET',table:$table"
          : "key:$key"
        : `graphId:$graphId,kind:'WRITE_FIELD',${input.taskId ? "taskId:anchorValue" : "table:anchorValue"},column:$column`;
    // A single input row uses the native indexed matcher rather than the
    // cost planner's competing task/table composite-index choice (26.9.1).
    const anchorInput =
      input.layer === "field" && !input.nodeId
        ? `UNWIND [${input.taskId ? "$taskId" : "$table"}] AS anchorValue `
        : "";
    const anchorFilter =
      input.layer === "field" && !input.nodeId
        ? "n.graphId=$graphId AND ($writeId='' OR n.writeId=$writeId)"
        : "n.graphId=$graphId";
    const anchor = await this.run(
      `${anchorInput}MATCH (n:SLAssetNode {${anchorPattern}}) ${anchorPattern === "key:$key" ? "WITH n LIMIT 1 " : ""}WHERE ${anchorFilter} RETURN properties(n) AS node ORDER BY n.id LIMIT $limit`,
      {
        key: key(this.graphId, input.nodeId ?? `task:${input.taskId}`),
        taskId: input.taskId ?? "",
        table: input.table?.toLowerCase() ?? "",
        column: input.column?.toLowerCase() ?? "",
        writeId: input.writeId ?? "",
        limit,
      },
    );
    for (const record of anchor.records) {
      const node = cleanNode(record.get("node"));
      nodes.set(String(node.id), {
        ...node,
        depth: 0,
        ...(input.depthUnit === "table-hop" ? { lineageDepth: 0 } : {}),
      });
      const stop = terminal(node);
      if (stop) terminalNodes.set(stop.nodeId, stop);
    }
    let frontier = [...nodes.keys()].filter(
      (nodeId) => !terminalNodes.has(nodeId),
    );
    const direction =
      input.direction === "down"
        ? "(n)-[r:SL_ASSET_EDGE]->(m)"
        : "(n)<-[r:SL_ASSET_EDGE]-(m)";
    if (input.depthUnit === "table-hop") {
      const bestCost = new Map([...nodes.keys()].map((id) => [id, 0]));
      const rawDepth = new Map([...nodes.keys()].map((id) => [id, 0]));
      const expanded = new Set<string>();
      const boundary = new Set<string>();
      for (let cost = 0; cost <= depth && !truncated; cost++) {
        let sameCost = new Set(
          [...bestCost]
            .filter(
              ([id, value]) =>
                value === cost && !expanded.has(id) && !terminalNodes.has(id),
            )
            .map(([id]) => id),
        );
        while (sameCost.size && !truncated) {
          const current = [...sameCost];
          sameCost = new Set<string>();
          current.forEach((id) => expanded.add(id));
          if (cost === depth && input.layer !== "field") {
            current.forEach((id) => boundary.add(id));
            continue;
          }
          const r = await this.run(
            `UNWIND $keys AS anchor MATCH (n:SLAssetNode {key:anchor}) MATCH ${direction} WHERE r.layer=$layer AND r.kind<>'CONDITION' AND ($candidates OR r.kind<>'CANDIDATE') AND (NOT $fieldBoundary OR r.kind IN ['CONTINUES','CANDIDATE']) RETURN properties(n) AS source,properties(m) AS node,properties(r) AS edge ORDER BY r.key LIMIT $limit`,
            {
              keys: current.map((id) => key(this.graphId, id)),
              layer: input.layer,
              candidates: input.includeCandidates !== false,
              fieldBoundary: cost === depth,
              limit: limit - edges.size + 1,
            },
          );
          for (const record of r.records) {
            const edge = cleanEdge(record.get("edge")) as Record<
              string,
              unknown
            >;
            const edgeKind = String(edge.kind);
            const weight =
              input.layer === "field"
                ? edgeKind === "VALUE"
                  ? 1
                  : 0
                : input.layer === "table"
                  ? input.direction === "down"
                    ? edgeKind === "WRITES_TABLE"
                      ? 1
                      : 0
                    : edgeKind === "READS_TABLE"
                      ? 1
                      : 0
                  : 1;
            const source = cleanNode(record.get("source"));
            const sourceId = String(source.id);
            const node = cleanNode(record.get("node"));
            const nodeId = String(node.id);
            const nextCost = cost + weight;
            const nextRawDepth = (rawDepth.get(sourceId) ?? 0) + 1;
            const stopsAtTableBoundary =
              input.layer === "table" && weight === 0 && cost === depth;
            if (nextCost > depth || stopsAtTableBoundary) {
              boundary.add(sourceId);
              continue;
            }
            const edgeKey = String(edge.key ?? edge.id);
            if (edges.size >= limit && !edges.has(edgeKey)) {
              truncated = true;
              boundary.add(sourceId);
              break;
            }
            edges.set(edgeKey, edge);
            const priorCost = bestCost.get(nodeId);
            const priorRawDepth = rawDepth.get(nodeId);
            if (
              priorCost === undefined ||
              nextCost < priorCost ||
              (nextCost === priorCost &&
                (priorRawDepth === undefined || nextRawDepth < priorRawDepth))
            ) {
              bestCost.set(nodeId, nextCost);
              rawDepth.set(nodeId, nextRawDepth);
              nodes.set(nodeId, {
                ...node,
                depth: nextRawDepth,
                lineageDepth: nextCost,
              });
            }
            const stop = terminal(node);
            if (stop) terminalNodes.set(stop.nodeId, stop);
            else {
              if (nextCost === depth) {
                if (weight === 0) boundary.delete(sourceId);
                boundary.add(nodeId);
              }
              if (nextCost === cost && !expanded.has(nodeId))
                sameCost.add(nodeId);
            }
          }
        }
      }
      frontier = [...boundary];
    } else
      for (let hop = 1; hop <= depth && frontier.length; hop++) {
        const r = await this.run(
          `UNWIND $keys AS anchor MATCH (n:SLAssetNode {key:anchor}) MATCH ${direction} WHERE r.layer=$layer AND r.kind<>'CONDITION' AND ($candidates OR r.kind<>'CANDIDATE') RETURN properties(n) AS source,properties(m) AS node,properties(r) AS edge ORDER BY r.key LIMIT $limit`,
          {
            keys: frontier.map((id) => key(this.graphId, id)),
            layer: input.layer,
            candidates: input.includeCandidates !== false,
            limit: limit - edges.size + 1,
          },
        );
        const next: string[] = [];
        for (const record of r.records) {
          const edge = record.get("edge");
          if (edges.size >= limit && !edges.has(edge.key)) {
            truncated = true;
            break;
          }
          edges.set(edge.key, cleanEdge(edge));
          const node = cleanNode(record.get("node"));
          if (!nodes.has(String(node.id))) {
            nodes.set(String(node.id), { ...node, depth: hop });
            const stop = terminal(node);
            if (stop) terminalNodes.set(stop.nodeId, stop);
            else next.push(String(node.id));
          }
        }
        if (truncated) {
          frontier = [...new Set([...frontier, ...next])];
          break;
        }
        frontier = next;
      }
    const final = await this.ready();
    if (final.version !== initial.version)
      throw new Error("ASSET_GRAPH_CHANGED_DURING_QUERY");
    return {
      version: initial.version,
      layer: input.layer,
      direction: input.direction ?? "up",
      depthLimit: depth,
      edgeLimit: limit,
      truncated,
      stoppedBy: truncated
        ? "EDGE_LIMIT"
        : frontier.length
          ? "DEPTH_LIMIT"
          : null,
      frontierNodeIds: frontier,
      terminalNodes: [...terminalNodes.values()],
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      elapsedMs: Date.now() - start,
      projectionGenerations: 0,
    };
  }
}
function cleanNode(n: Record<string, unknown>): Record<string, unknown> {
  const { key: _key, graphId: _graph, ...rest } = n;
  return { ...rest, detail: JSON.parse(String(n.detail ?? "{}")) };
}
function cleanEdge(e: Record<string, unknown>) {
  const {
    key: _key,
    graphId: _graph,
    fromKey: _from,
    toKey: _to,
    ownerKey: _owner,
    ...rest
  } = e;
  return { ...rest, detail: JSON.parse(String(e.detail ?? "{}")) };
}
