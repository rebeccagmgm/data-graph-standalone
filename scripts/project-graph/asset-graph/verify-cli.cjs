const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  { spawnSync } = require("child_process"),
  assert = require("assert/strict");
const root = process.cwd(),
  launcher = path.join(root, "scripts", "lineage-graph.ps1");
const runs = [];
function query(name, args, expectedExit = 0) {
  const start = Date.now();
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, ...args],
    { cwd: os.tmpdir(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(r.status, expectedExit, name + ": " + r.stderr);
  const json = JSON.parse(r.stdout.trim());
  assert.equal(json.ok, expectedExit === 0);
  if (expectedExit === 0 && name !== "help")
    assert.equal(json.meta.projectionGenerations, 0);
  runs.push({
    name,
    exitCode: r.status,
    wallMs: Date.now() - start,
    queryMs:
      name.includes("trace") ||
      name === "t98-writers" ||
      name === "principal-confirmed"
        ? (json.data?.elapsedMs ?? null)
        : null,
    bytes: Buffer.byteLength(r.stdout),
    version: json.graph?.version ?? null,
  });
  fs.writeFileSync(
    path.join(root, "studies/titans-otc-graph-acceptance", name + ".json"),
    JSON.stringify(json, null, 2),
  );
  return json;
}
query("help", ["help"]);
const status = query("status", ["status"]);
assert.equal(status.data.taskCount, 3615);
query("search", [
  "search",
  "--text",
  "t98_otc_deri_comp_sale_info",
  "--limit",
  "10",
]);
const table = query("t98-writers", [
  "trace",
  "--table",
  "pdata_n.t98_otc_deri_comp_sale_info",
  "--layer",
  "table",
  "--depth",
  "1",
]);
assert.deepEqual(
  table.data.nodes
    .filter((n) => n.kind === "TASK")
    .map((n) => n.taskId)
    .sort(),
  ["220650", "86840", "86841", "86842"].sort(),
);
const p1 = query("fields-page-1", [
  "fields",
  "--task-id",
  "86842",
  "--limit",
  "5",
]);
const p2 = query("fields-page-2", [
  "fields",
  "--task-id",
  "86842",
  "--limit",
  "5",
  "--offset",
  "5",
]);
assert.equal(p1.data.pagination.nextOffset, 5);
assert.equal(
  new Set([...p1.data.items, ...p2.data.items].map((x) => x.id)).size,
  10,
);
const cold = query("principal-trace", [
  "trace",
  "--task-id",
  "86842",
  "--column",
  "init_nom_prin",
  "--depth",
  "6",
]);
assert(cold.data.edges.length > 0);
assert(!cold.data.edges.some((e) => e.kind === "CONDITION"));
const warm = query("principal-trace-repeat", [
  "trace",
  "--task-id",
  "86842",
  "--column",
  "init_nom_prin",
  "--depth",
  "6",
]);
assert.deepEqual(cold.data.edges, warm.data.edges);
const confirmed = query("principal-confirmed", [
  "trace",
  "--task-id",
  "86842",
  "--column",
  "init_nom_prin",
  "--confirmed-only",
]);
assert(!confirmed.data.edges.some((e) => e.kind === "CANDIDATE"));
const compare = query("four-product-formulas", [
  "compare",
  "--task-ids",
  "86840,86841,86842,220650",
  "--column",
  "init_nom_prin",
]);
assert(compare.data.tasks.every((t) => t.bindings.length > 0));
assert(
  compare.data.tasks
    .find((t) => t.taskId === "86842")
    .bindings[0].expression.includes("dynamic_notional"),
);
const sales = query("sales-allocation", [
  "processing",
  "--task-id",
  "93338",
  "--text",
  "dyna_nom_prin",
  "--limit",
  "20",
]);
assert(
  sales.data.expressions.some((e) => e.expression.includes("allo_prop_1")),
);
assert(sales.data.expressions.some((e) => /datediff/i.test(e.expression)));
const daily = query("sales-report", [
  "detail",
  "--task-id",
  "162610",
  "--column",
  "index_val",
  "--limit",
  "100",
]);
assert(
  daily.data.controls.some((c) => JSON.stringify(c).includes("SKIP_REPORT")),
);
const sql = query("sql-lines", [
  "processing",
  "--task-id",
  "86842",
  "--sql",
  "--slot",
  "query",
  "--line-start",
  "1",
  "--line-count",
  "8",
  "--limit",
  "1",
]);
assert(sql.data.sqlSources[0].content.split("\n").length <= 8);
assert(sql.data.sqlSources[0].nextLine === 9);
query("invalid-option", ["trace", "--task-idx", "86842"], 2);
query("missing-column", ["trace", "--task-id", "86842"], 2);
query(
  "depth-limit",
  [
    "trace",
    "--task-id",
    "86842",
    "--column",
    "init_nom_prin",
    "--depth",
    "999",
  ],
  2,
);
const summary = {
  generatedAt: new Date().toISOString(),
  passed: true,
  cwd: os.tmpdir(),
  cases: runs.length,
  runs,
};
fs.writeFileSync(
  path.join(root, "studies/titans-otc-graph-acceptance", "cli-acceptance.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary));
