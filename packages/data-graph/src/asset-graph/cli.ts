import { CLI_HELP } from "./cli-help.ts";
import { resolveWorkspacePaths } from "../../../../scripts/config/workspace-paths.ts";

const allowed = new Set([
  "--config",
  "--text",
  "--task-id",
  "--task-ids",
  "--table",
  "--column",
  "--write-id",
  "--node-id",
  "--relation-id",
  "--layer",
  "--direction",
  "--depth",
  "--max-depth",
  "--max-nodes",
  "--max-edges",
  "--limit",
  "--offset",
  "--slot",
  "--line-start",
  "--line-count",
  "--port",
  "--confirmed-only",
  "--sql",
  "--gap-layer",
  "--reason-code",
  "--terminal-role",
  "--read-occurrence-id",
  "--consumer-task-id",
  "--publication-version",
  "--metadata-catalog-root",
  "--datasource-catalog-path",
]);

/** Milliseconds from assetGraphMain() entry until the response object is built. */
function mainElapsedMs(started: number) {
  return Date.now() - started;
}

export function parseAgentArgs(args: readonly string[]) {
  const command = args[0] ?? "help",
    values: Record<string, string | boolean> = {};
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!;
    if (!allowed.has(key)) throw new Error("INVALID_ARGUMENT:" + key);
    if (key === "--confirmed-only" || key === "--sql") {
      values[key] = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error("ARGUMENT_VALUE_REQUIRED:" + key);
    values[key] = value;
  }
  const option = (key: string) =>
    typeof values[key] === "string" ? String(values[key]) : undefined;
  const integer = (key: string, defaultValue: number, max: number, min = 0) => {
    const raw = option(key),
      n = raw === undefined ? defaultValue : Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw new Error("INVALID_ARGUMENT:" + key);
    return n;
  };
  return {
    command,
    option,
    integer,
    flag: (key: string) => values[key] === true,
  };
}

export async function assetGraphMain(args = process.argv.slice(2)) {
  const started = Date.now();
  let command = args[0] ?? "help";
  let backend = "neo4j";
  try {
    const a = parseAgentArgs(args);
    command = a.command;
    const { option, integer, flag } = a,
      config = option("--config");
    if (command === "help" || command === "--help") {
      console.log(JSON.stringify({ ok: true, ...CLI_HELP }));
      return;
    }
    if (command === "metrics") {
      const { readPublishedContinuationMetrics } =
        await import("./continuation-metrics-query.ts");
      const paths = resolveWorkspacePaths({ configPath: config });
      console.log(
        JSON.stringify({
          schemaVersion: "1.0.0",
          ok: true,
          command,
          data: readPublishedContinuationMetrics({
            graphOutputRoot: paths.graphOutputRoot,
            gapLayer: option("--gap-layer"),
            reasonCode: option("--reason-code"),
            publicationVersion: option("--publication-version"),
            terminalRole: option("--terminal-role"),
            offset: integer("--offset", 0, 1_000_000),
            limit: integer("--limit", 25, 100, 1),
          }),
        }),
      );
      return;
    }
    if (command === "query-read-candidates") {
      const readOccurrenceId = option("--read-occurrence-id");
      if (!readOccurrenceId)
        throw new Error("ARGUMENT_VALUE_REQUIRED:--read-occurrence-id");
      const { readPublishedContinuationCandidates } =
        await import("./continuation-candidates-query.ts");
      const paths = resolveWorkspacePaths({ configPath: config });
      console.log(
        JSON.stringify({
          schemaVersion: "1.0.0",
          ok: true,
          command,
          data: readPublishedContinuationCandidates({
            graphOutputRoot: paths.graphOutputRoot,
            readOccurrenceId,
            consumerTaskId: option("--consumer-task-id"),
            publicationVersion: option("--publication-version"),
            offset: integer("--offset", 0, 1_000_000),
            limit: integer("--limit", 25, 100, 1),
          }),
        }),
      );
      return;
    }
    if (
      ![
        "publish",
        "serve",
        "status",
        "search",
        "fields",
        "trace",
        "detail",
        "explain",
        "processing",
        "compare",
      ].includes(command)
    )
      throw new Error("INVALID_COMMAND");
    if (command === "publish" || command === "serve") {
      const { assetGraphConfig } = await import("./config.ts");
      backend = assetGraphConfig(config).provider;
    }
    if (command === "publish") {
      const { publishAssetGraph } = await import("./publish.ts");
      console.log(
        JSON.stringify({
          schemaVersion: "1.0.0",
          ok: true,
          command,
          data: await publishAssetGraph(config),
        }),
      );
      return;
    }
    if (command === "serve") {
      const { startAssetGraphServer } = await import("./service.ts");
      const port = integer("--port", 8791, 65535, 1024),
        server = await startAssetGraphServer(config, port, {
          metadataCatalogRoot: option("--metadata-catalog-root"),
          datasourceCatalogPath: option("--datasource-catalog-path"),
        });
      console.log(
        JSON.stringify({ ok: true, url: `http://127.0.0.1:${port}` }),
      );
      process.once("SIGINT", () => void server.close());
      return;
    }
    const [{ openAssetGraph }, { AssetGraphStore }] = await Promise.all([
      import("./config.ts"),
      import("./store.ts"),
    ]);
    const c = await openAssetGraph(config),
      store = new AssetGraphStore(c.driver, c.database, c.graphId);
    backend = c.provider;
    try {
      const state = await store.ready();
      let data: unknown;
      const offset = integer("--offset", 0, 1000000),
        limit = integer(
          "--limit",
          command === "fields" ? 100 : command === "trace" ? 150 : 25,
          command === "trace" || command === "fields" ? 1000 : 100,
          1,
        );
      const requireTask = () => {
        const id = option("--task-id");
        if (!id) throw new Error("ARGUMENT_VALUE_REQUIRED:--task-id");
        return id;
      };
      if (command === "status") {
        data = {
          state: state.state,
          publishedAt: String(state.publishedAt),
          ...JSON.parse(state.report),
        };
      } else if (command === "search") {
        const rows = await store.search(
          option("--text") ?? "",
          limit + 1,
          offset,
        );
        data = {
          items: rows.slice(0, limit),
          pagination: {
            offset,
            limit,
            nextOffset: rows.length > limit ? offset + limit : null,
          },
        };
      } else if (command === "fields") {
        if (!option("--task-id") && !option("--table"))
          throw new Error("ARGUMENT_VALUE_REQUIRED:--task-id_or_--table");
        const rows = await store.fields({
          taskId: option("--task-id"),
          table: option("--table"),
          limit: limit + 1,
          offset,
        });
        data = {
          items: rows.slice(0, limit),
          pagination: {
            offset,
            limit,
            nextOffset: rows.length > limit ? offset + limit : null,
          },
        };
      } else if (command === "explain") {
        if (!option("--write-id") || !option("--column")) throw new Error("ARGUMENT_VALUE_REQUIRED:--write-id_and_--column");
        const { queryTaskFieldExplanation } = await import("./task-field-explanation-query.ts");
        data = await queryTaskFieldExplanation(store, {
          taskId: requireTask(), writeId: option("--write-id") ?? "", column: option("--column") ?? "",
          publicationVersion: option("--publication-version"),
          maxDepth: integer("--max-depth", 32, 64, 1), maxNodes: integer("--max-nodes", 500, 2000, 1), maxEdges: integer("--max-edges", 1000, 4000, 1),
        });
      } else if (command === "detail") {
        const { taskDetail } = await import("./service.ts");
        const d = await taskDetail(
          store,
          requireTask(),
          option("--column"),
          option("--write-id"),
        );
        data = {
          ...d,
          bindings: d.bindings.slice(offset, offset + limit),
          controls: d.controls.slice(offset, offset + limit),
          pagination: {
            offset,
            limit,
            bindingTotal: d.bindings.length,
            controlTotal: d.controls.length,
            nextOffset:
              offset + limit < Math.max(d.bindings.length, d.controls.length)
                ? offset + limit
                : null,
          },
        };
      } else if (command === "processing") {
        const { processingDetail } = await import("./agent-api.ts");
        data = await processingDetail(store, {
          taskId: requireTask(),
          text: option("--text"),
          relationId: option("--relation-id"),
          limit,
          offset,
          sql: flag("--sql"),
          slot: option("--slot"),
          lineStart: integer("--line-start", 1, 1000000, 1),
          lineCount: integer("--line-count", 80, 300, 1),
        });
      } else if (command === "compare") {
        const { taskDetail } = await import("./service.ts");
        const ids = [
          ...new Set((option("--task-ids") ?? "").split(",").filter(Boolean)),
        ];
        if (!ids.length || ids.length > 10 || !option("--column"))
          throw new Error("ARGUMENT_VALUE_REQUIRED:--task-ids_and_--column");
        data = {
          column: option("--column"),
          tasks: await Promise.all(
            ids.map(async (id) => {
              const d = await taskDetail(store, id, option("--column"));
              return {
                taskId: id,
                taskName: d.taskName,
                coverage: d.coverage,
                bindings: d.bindings,
                controlCount: d.controls.length,
              };
            }),
          ),
        };
      } else {
        const { buildTraceConsumptionFromRecords } =
          await import("./trace-consumption.ts");
        const layer = option("--layer") ?? "field",
          direction = option("--direction") ?? "up";
        if (
          !["table", "field", "schedule"].includes(layer) ||
          !["up", "down"].includes(direction)
        )
          throw new Error("INVALID_ARGUMENT:layer_or_direction");
        if (!option("--node-id") && !option("--task-id") && !option("--table"))
          throw new Error("ARGUMENT_VALUE_REQUIRED:anchor");
        if (layer === "field" && !option("--node-id") && !option("--column"))
          throw new Error("ARGUMENT_VALUE_REQUIRED:--column");
        const trace = await store.traverse({
          taskId: option("--task-id"),
          column: option("--column"),
          table: option("--table"),
          nodeId: option("--node-id"),
          writeId: option("--write-id"),
          layer: layer as "table" | "field" | "schedule",
          direction: direction as "up" | "down",
          depth: integer("--depth", 4, 12),
          limit,
          includeCandidates: !flag("--confirmed-only"),
        });
        const identities = await store.metadataIdentities(
          trace.nodes.map((node) => String(node.id)),
        );
        data = {
          ...trace,
          consumption: buildTraceConsumptionFromRecords({
            direction: trace.direction,
            nodes: trace.nodes.map((node) => ({
              ...node,
              metadataIdentity: identities.get(String(node.id)),
            })),
            edges: trace.edges,
          }),
        };
      }
      const elapsedMs = mainElapsedMs(started);
      console.log(
        JSON.stringify({
          schemaVersion: "1.0.0",
          ok: true,
          command,
          graph: { id: c.graphId, version: state.version },
          data,
          meta: {
            backend,
            elapsedMs,
            projectionGenerations: 0,
          },
        }),
      );
    } finally {
      await c.driver.close();
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : "QUERY_FAILED",
      argument = /^(INVALID_|ARGUMENT_)/.test(raw);
    const driverCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    const code = /ServiceUnavailable|SessionExpired/.test(driverCode)
      ? `${backend.toUpperCase()}_UNAVAILABLE`
      : /Security/.test(driverCode)
        ? `${backend.toUpperCase()}_AUTH_FAILED`
        : /^[A-Z0-9_:a-z-]+$/.test(raw)
          ? raw
          : "ASSET_GRAPH_QUERY_FAILED";
    console.log(
      JSON.stringify({
        schemaVersion: "1.0.0",
        ok: false,
        command,
        error: { code },
        meta: { elapsedMs: mainElapsedMs(started) },
      }),
    );
    process.exitCode = argument ? 2 : 1;
  }
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/asset-graph/cli.ts"))
  await assetGraphMain();
