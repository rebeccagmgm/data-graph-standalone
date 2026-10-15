import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const repoRoot = process.argv[2] ?? process.cwd();
const dataRoot = join(repoRoot, "../sql-static-lineage-data");
const current = JSON.parse(
  readFileSync(join(dataRoot, "artifacts/graphs/titans-otc/current.json"), "utf8"),
);
const manifest = JSON.parse(readFileSync(current.manifestPath, "utf8"));
const outDir = join(
  repoRoot,
  `docs/material-gap-exports/titans-otc-${current.version.slice(0, 8)}`,
);
mkdirSync(outDir, { recursive: true });

const tasksRoot = join(dataRoot, "tasks");
const factsRoot = join(dataRoot, "field-facts");

function hasFacts(taskId, category) {
  const dir = join(factsRoot, category, taskId);
  if (!existsSync(dir)) return false;
  return (
    existsSync(join(dir, "facts.json")) ||
    existsSync(join(dir, "field-facts.json"))
  );
}

function analyzePack(category, taskId) {
  const packPath = join(tasksRoot, category, taskId, "task.json");
  if (!existsSync(packPath)) {
    return {
      hasPack: false,
      hasQuery: false,
      hasAnySql: false,
      hasTarget: false,
      targetKind: "none",
      packStatus: null,
      taskName: null,
    };
  }
  const pack = JSON.parse(readFileSync(packPath, "utf8"));
  const sqlFiles = pack.sqlFiles ?? [];
  const hasQuery = sqlFiles.some((f) => f.slot === "query");
  const hasAnySql = sqlFiles.length > 0;
  const target = pack.target;
  let targetKind = "none";
  if (typeof target === "string" && target.trim()) targetKind = "bare_string";
  else if (
    target &&
    typeof target === "object" &&
    (target.qualifiedName || target.platform)
  )
    targetKind = "structured";
  return {
    hasPack: true,
    hasQuery,
    hasAnySql,
    hasTarget: targetKind !== "none",
    targetKind,
    packStatus: pack.collectionStatus ?? null,
    taskName: pack.taskName ?? null,
  };
}

function subReason(m, packInfo) {
  if (m.failureReasonCode === "SCHEMA_UNRESOLVED") return "SCHEMA_UNRESOLVED";
  if (!packInfo.hasPack) return "MISSING_PACK";
  if (!hasFacts(m.taskId, m.taskCategory)) {
    if (!packInfo.hasQuery && !packInfo.hasAnySql)
      return "PACK_NO_SQL_NEED_FACTS_OR_SCHEDULE_ONLY";
    if (packInfo.targetKind === "bare_string")
      return "NEED_FACTS_AND_TARGET_SCHEMA";
    return "NEED_MACHINE_FACTS";
  }
  return "OTHER";
}

function actionFor(sub) {
  switch (sub) {
    case "MISSING_PACK":
      return "collect-input-pack-from-cache";
    case "NEED_MACHINE_FACTS":
      return "input-pack:repair-like-sources / input-pack:repair-partials (Table Pack first)";
    case "NEED_FACTS_AND_TARGET_SCHEMA":
      return "input-pack:repair-partials (target schema) then machine-facts";
    case "PACK_NO_SQL_NEED_FACTS_OR_SCHEDULE_ONLY":
      return "input-pack:fill-hive-task-sql-cache OR accept schedule-only";
    case "SCHEMA_UNRESOLVED":
      return "input-pack:repair-partials (target table DDL/schema)";
    default:
      return "investigate";
  }
}

const gaps = manifest.tasks.filter((t) => t.coverageDisposition === "MATERIAL_GAP");
const enriched = gaps.map((t) => {
  const packInfo = analyzePack(t.taskCategory, t.taskId);
  const sub = subReason(t, packInfo);
  return {
    taskId: t.taskId,
    taskCategory: t.taskCategory,
    taskName: t.taskName ?? packInfo.taskName ?? null,
    coverageStatus: t.coverageStatus,
    failureReasonCode: t.failureReasonCode ?? null,
    factsState: t.factsState ?? null,
    hasPack: packInfo.hasPack,
    hasQuerySql: packInfo.hasQuery,
    hasAnySql: packInfo.hasAnySql,
    targetKind: packInfo.targetKind,
    subReason: sub,
    recommendedAction: actionFor(sub),
    packPath: packInfo.hasPack
      ? join("tasks", t.taskCategory, t.taskId)
      : null,
  };
});

const summary = {
  graphVersion: current.version,
  manifestPath: current.manifestPath,
  exportedAt: new Date().toISOString(),
  totalMaterialGap: enriched.length,
  byCategory: {},
  bySubReason: {},
  focusCategories: {},
};

for (const row of enriched) {
  summary.byCategory[row.taskCategory] =
    (summary.byCategory[row.taskCategory] ?? 0) + 1;
  summary.bySubReason[row.subReason] =
    (summary.bySubReason[row.subReason] ?? 0) + 1;
}

const focus = [
  "hive2starrocks",
  "MISSING_PACK",
  "sparkIndex",
  "hive2postgre",
  "hive2mysql",
];
for (const cat of focus) {
  const rows = enriched.filter((r) => r.taskCategory === cat);
  const sub = {};
  for (const r of rows) sub[r.subReason] = (sub[r.subReason] ?? 0) + 1;
  summary.focusCategories[cat] = { total: rows.length, bySubReason: sub };
}

writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(
  join(outDir, "all-material-gap.json"),
  JSON.stringify(enriched, null, 2),
);

const csvHeader =
  "taskId,taskCategory,taskName,coverageStatus,failureReasonCode,factsState,hasPack,hasQuerySql,targetKind,subReason,recommendedAction";
const csvLines = enriched.map((r) =>
  [
    r.taskId,
    r.taskCategory,
    JSON.stringify(r.taskName ?? ""),
    r.coverageStatus,
    r.failureReasonCode ?? "",
    r.factsState ?? "",
    r.hasPack,
    r.hasQuerySql,
    r.targetKind,
    r.subReason,
    r.recommendedAction,
  ].join(","),
);
writeFileSync(join(outDir, "all-material-gap.csv"), [csvHeader, ...csvLines].join("\n"));

for (const cat of focus) {
  const rows = enriched.filter((r) => r.taskCategory === cat);
  writeFileSync(join(outDir, `${cat}.json`), JSON.stringify(rows, null, 2));
  writeFileSync(
    join(outDir, `${cat}-ids.txt`),
    `${rows.map((r) => r.taskId).join("\n")}\n`,
  );
  const bySub = {};
  for (const r of rows) {
    if (!bySub[r.subReason]) bySub[r.subReason] = [];
    bySub[r.subReason].push(r.taskId);
  }
  for (const [sub, ids] of Object.entries(bySub)) {
    writeFileSync(
      join(outDir, `${cat}--${sub}-ids.txt`),
      `${ids.join("\n")}\n`,
    );
  }
}

const otherCats = [...new Set(enriched.map((r) => r.taskCategory))]
  .filter((c) => !focus.includes(c))
  .sort();
const other = enriched.filter((r) => !focus.includes(r.taskCategory));
writeFileSync(
  join(outDir, "other-categories.json"),
  JSON.stringify(other, null, 2),
);
writeFileSync(
  join(outDir, "other-categories-ids.txt"),
  `${other.map((r) => r.taskId).join("\n")}\n`,
);

const readme = [
  "# MATERIAL_GAP export (titans-otc)",
  "",
  `Graph version: \`${current.version}\``,
  `Total: **${enriched.length}** tasks`,
  "",
  "## Focus categories",
  "",
  "| Category | Count |",
  "|----------|------:|",
  ...focus.map(
    (cat) =>
      `| ${cat} | ${summary.focusCategories[cat]?.total ?? 0} |`,
  ),
  "",
  "## Files",
  "",
  "- `summary.json` — counts by category and sub-reason",
  "- `all-material-gap.csv` — full list for spreadsheet",
  "- `<category>.json` / `<category>-ids.txt` — per-category lists",
  "- `<category>--<subReason>-ids.txt` — sub-reason splits",
  `- \`other-categories.json\` — ${other.length} tasks in ${otherCats.length} categories: ${otherCats.join(", ")}`,
  "",
  "## Sub-reason legend",
  "",
  "| subReason | Meaning |",
  "|-----------|---------|",
  "| MISSING_PACK | No task pack on disk |",
  "| NEED_MACHINE_FACTS | Pack exists with SQL; supplement Table Pack evidence before Facts |",
  "| NEED_FACTS_AND_TARGET_SCHEMA | Pack has bare target name; repair target schema in Table Pack first |",
  "| PACK_NO_SQL_NEED_FACTS_OR_SCHEDULE_ONLY | Pack has no query SQL (common hive2* log tasks) |",
  "| SCHEMA_UNRESOLVED | Facts exist but target schema cannot be resolved; repair Table Pack |",
  "",
].join("\n");
writeFileSync(join(outDir, "README.md"), readme);

console.log(JSON.stringify(summary, null, 2));
console.log(`Wrote to ${outDir}`);
