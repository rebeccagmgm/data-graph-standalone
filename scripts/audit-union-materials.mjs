import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { indexTaskInputPacks } from "./machine-facts/input-pack-machine-facts.ts";
import { loadMachineFactsIndex } from "./machine-facts/machine-facts-index-reader.ts";
import { resolveWorkspacePaths } from "./config/workspace-paths.ts";
import { defaultTaskStatusFile, loadTaskStatus } from "./input/mainline/task-status.ts";
import { loadCurrentTaskBundle } from "./query/current-task-bundle.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const paths = resolveWorkspacePaths();
const dataRoot = paths.inputPackRoot;
const factsRoot = paths.factsRoot;
const ids = readFileSync(
  join(repoRoot, "tmp/dm-otc-n-titans-union-20260907/ids-union.txt"),
  "utf8",
)
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const packIndex = indexTaskInputPacks(dataRoot);
const status = loadTaskStatus(defaultTaskStatusFile(dataRoot), dataRoot);

const indexRows = loadMachineFactsIndex(factsRoot).byTaskId;

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
  packSuccess: 0,
  noPack: 0,
  indexSuccess: 0,
  indexNonSuccess: 0,
  noIndex: 0,
  bundleCurrentL1: 0,
  bundleStale: 0,
  bundleLegacy: 0,
  bundleInvalid: 0,
  bundleNoFacts: 0,
  projection: 0,
  noProjection: 0,
  packAndIndexSuccess: 0,
  packAndCurrentL1: 0,
  graphReady: 0,
};

for (const taskId of ids) {
  const hasPack = Boolean(packIndex.get(taskId)?.length);
  if (hasPack) summary.packAny += 1;
  else summary.noPack += 1;
  if (status.tasks[taskId]?.status === "SUCCESS") summary.packSuccess += 1;

  const indexRow = indexRows.get(taskId);
  if (!indexRow) summary.noIndex += 1;
  else if (indexRow.status === "SUCCESS") summary.indexSuccess += 1;
  else summary.indexNonSuccess += 1;

  let bundleState = "NO_FACTS";
  if (hasPack) {
    const bundle = loadCurrentTaskBundle(factsRoot, taskId, { cacheLoads: false });
    bundleState = bundle.state;
    if (bundle.state === "CURRENT_L1") summary.bundleCurrentL1 += 1;
    else if (bundle.state === "STALE") summary.bundleStale += 1;
    else if (bundle.state === "LEGACY_NOT_L1") summary.bundleLegacy += 1;
    else if (bundle.state === "INVALID") summary.bundleInvalid += 1;
    else summary.bundleNoFacts += 1;
  }

  if (hasProjection(taskId)) summary.projection += 1;
  else summary.noProjection += 1;

  if (hasPack && indexRow?.status === "SUCCESS") summary.packAndIndexSuccess += 1;
  if (hasPack && bundleState === "CURRENT_L1") summary.packAndCurrentL1 += 1;
  if (hasPack && bundleState === "CURRENT_L1" && hasProjection(taskId)) {
    summary.graphReady += 1;
  }
}

console.log(JSON.stringify(summary, null, 2));
