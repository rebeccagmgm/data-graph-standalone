import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { indexTaskInputPacks } from "./machine-facts/input-pack-machine-facts.ts";
import { loadMachineFactsIndex } from "./machine-facts/machine-facts-index-reader.ts";
import { resolveWorkspacePaths } from "./config/workspace-paths.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const paths = resolveWorkspacePaths();
const dataRoot = paths.inputPackRoot;
const ids = readFileSync(
  join(repoRoot, "tmp/dm-otc-n-titans-union-20260907/ids-union.txt"),
  "utf8",
)
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const packIndex = indexTaskInputPacks(dataRoot);
const indexRows = loadMachineFactsIndex(paths.factsRoot).byTaskId;

function hasProjection(taskId) {
  const dir = join(dataRoot, "task-projections/tasks", taskId, "versions");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(
    (name) => name.endsWith(".json") && !name.includes("evidence"),
  );
}

const summary = {
  union: ids.length,
  packAny: 0,
  noPack: 0,
  indexSuccess: 0,
  indexStale: 0,
  indexOther: 0,
  noIndex: 0,
  packAndIndexSuccess: 0,
  packAndIndexStale: 0,
  projection: 0,
  noProjection: 0,
  graphReady: 0,
  needsProjection: [],
};

for (const taskId of ids) {
  const hasPack = Boolean(packIndex.get(taskId)?.length);
  if (hasPack) summary.packAny += 1;
  else summary.noPack += 1;

  const indexRow = indexRows.get(taskId);
  if (!indexRow) summary.noIndex += 1;
  else if (indexRow.status === "SUCCESS") summary.indexSuccess += 1;
  else if (indexRow.status === "STALE") summary.indexStale += 1;
  else summary.indexOther += 1;

  if (hasPack && indexRow?.status === "SUCCESS") summary.packAndIndexSuccess += 1;
  if (hasPack && indexRow?.status === "STALE") summary.packAndIndexStale += 1;

  if (hasProjection(taskId)) {
    summary.projection += 1;
    if (hasPack && indexRow?.status === "SUCCESS") summary.graphReady += 1;
  } else {
    summary.noProjection += 1;
    if (hasPack && indexRow?.status === "SUCCESS") summary.needsProjection.push(taskId);
  }
}

if (process.argv.includes("--export-needs-projection")) {
  const outPath = join(
    repoRoot,
    "tmp/dm-otc-n-titans-union-20260907/ids-needs-projection.txt",
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${summary.needsProjection.join("\n")}\n`, "utf8");
  summary.exportedNeedsProjection = summary.needsProjection.length;
  summary.exportPath = outPath;
}
delete summary.needsProjection;

console.log(JSON.stringify(summary, null, 2));
