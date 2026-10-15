import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { openMap, queryMap, defaultOutput, failure } from "./query.mjs";
import { readSql, readKnowledge } from "./evidence.mjs";
import { queryAnalysis } from "./analysis-query.mjs";

export function parseArgs(args) {
  const command = args.shift() || "summary",
    params = {};
  let output = defaultOutput;
  const names = {
    region: "region",
    stage: "stage",
    schema: "schema",
    q: "q",
    kind: "kind",
    focus: "focus",
    expanded: "expanded",
    slot: "slot",
    id: "id",
    "task-id": "id",
    direction: "direction",
    depth: "depth",
    limit: "limit",
    offset: "offset",
    "edge-limit": "edgeLimit",
    "source-region": "sourceRegion",
    "target-region": "targetRegion",
    "source-stage": "sourceStage",
    "target-stage": "targetStage",
    "line-start": "lineStart",
    "line-count": "lineCount",
  };
  while (args.length) {
    const key = args.shift();
    if (!key.startsWith("--") || !args.length)
      throw failure("参数必须使用 --名称 值");
    const value = args.shift();
    if (key === "--output") output = resolve(value);
    else if (names[key.slice(2)]) params[names[key.slice(2)]] = value;
    else throw failure(`未知参数 ${key}`);
  }
  return { command, params, output };
}
export async function dispatch(ctx, command, params) {
  if (command.startsWith("analysis-"))
    return queryAnalysis(ctx, command, params);
  if (command === "sql") return readSql(ctx, params);
  if (command === "knowledge") return readKnowledge(ctx, params);
  return queryMap(ctx, command, params);
}
async function main() {
  if (process.argv[2] === "help" || process.argv.includes("--help")) {
    console.log(
      JSON.stringify({
        commands: [
          "summary",
          "overview",
          "regions",
          "tasks",
          "task",
          "flows",
          "neighbors",
          "sql",
          "knowledge",
          "analysis-search",
          "analysis-view",
          "analysis-fields",
          "analysis-sql",
        ],
        examples: [
          "node scripts/inventory-map/cli.mjs summary",
          "node scripts/inventory-map/cli.mjs tasks --q pdata_n --limit 20",
          "node scripts/inventory-map/cli.mjs neighbors --id 209119 --direction up --depth 2 --limit 60",
          "node scripts/inventory-map/cli.mjs sql --id 107491 --line-count 80",
        ],
        limits: { pageSize: 100, depth: 4, nodes: 150, edges: 400 },
      }),
    );
    return;
  }
  let ctx;
  try {
    const { command, params, output } = parseArgs(process.argv.slice(2));
    ctx = openMap(output);
    const start = performance.now();
    const data = await dispatch(ctx, command, params);
    console.log(
      JSON.stringify({
        ok: true,
        command,
        version: ctx.summary.version,
        data,
        meta: {
          elapsedMs: Math.round(performance.now() - start),
          projectionGenerations: 0,
        },
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        error: {
          code: error.code || "QUERY_ERROR",
          message: error.code
            ? error.message
            : "查询失败；请检查本地快照是否完整",
        },
      }),
    );
    process.exitCode = 1;
  } finally {
    ctx?.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
