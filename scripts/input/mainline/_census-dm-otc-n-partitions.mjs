import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const idsPath =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data/tmp/from-cache-full/partial-analysis/dm-otc-n/ids-dm-otc-n-sparkindex.txt";
const tasksRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data/tasks/sparkIndex";

const ids = readFileSync(idsPath, "utf8")
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const byTable = new Map();
let packs = 0;
let noPack = 0;
let withPartition = 0;
let templatePartition = 0;
let starOrEmpty = 0;
const partitionShapes = {};

function isTemplate(value) {
  if (typeof value !== "string") return false;
  return /\$\{|YYYY|yyyy|data_day|\*/.test(value);
}

for (const id of ids) {
  const p = join(tasksRoot, id, "task.json");
  if (!existsSync(p)) {
    noPack += 1;
    continue;
  }
  packs += 1;
  const doc = JSON.parse(readFileSync(p, "utf8"));
  const target =
    typeof doc.target === "string"
      ? doc.target
      : doc.target?.qualifiedName || "";
  const key = String(target).toLowerCase();
  const partition = doc.partition && typeof doc.partition === "object" ? doc.partition : null;
  if (partition && Object.keys(partition).length > 0) {
    withPartition += 1;
    const vals = Object.values(partition);
    if (vals.some((v) => isTemplate(String(v)))) templatePartition += 1;
    const shape = Object.keys(partition)
      .sort()
      .map((k) => `${k}=${String(partition[k])}`)
      .join(",");
    partitionShapes[shape] = (partitionShapes[shape] || 0) + 1;
  } else {
    starOrEmpty += 1;
  }
  if (!byTable.has(key)) byTable.set(key, []);
  byTable.get(key).push({
    id,
    writeMode: doc.writeMode,
    partition,
  });
}

const multi = [...byTable.entries()]
  .filter(([, writers]) => writers.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

const multiDifferentPartition = multi.filter(([, writers]) => {
  const sigs = new Set(
    writers.map((w) => JSON.stringify(w.partition ?? null)),
  );
  return sigs.size > 1;
});

process.stdout.write(
  `${JSON.stringify(
    {
      ids: ids.length,
      packs,
      noPack,
      withPartition,
      templatePartition,
      noPartitionObject: starOrEmpty,
      distinctTables: byTable.size,
      tablesWithMultipleWriters: multi.length,
      tablesWithDifferentPartitionMaps: multiDifferentPartition.length,
      topMulti: multi.slice(0, 8).map(([table, writers]) => ({
        table,
        n: writers.length,
        sample: writers.slice(0, 4),
      })),
      topShapes: Object.entries(partitionShapes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
    },
    null,
    2,
  )}\n`,
);
