import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultTaskStatusFile, loadTaskStatus } from "../input/mainline/task-status.ts";
import { loadMachineFactsIndex } from "./machine-facts-index-reader.ts";
import { resolveWorkspacePaths } from "../config/workspace-paths.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export type FactsGapInventory = {
  readonly successPackCount: number;
  readonly indexedFactsCount: number;
  readonly manifestCount: number;
  readonly missingFactsCount: number;
  readonly rebuildSep6Success: number | null;
  readonly rebuildSep6Frozen: number | null;
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function log(message: string, logPath: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line, "utf8");
}

function readIndexedTaskIds(factsRoot: string): Set<string> {
  return new Set(loadMachineFactsIndex(factsRoot, { allowMissing: true }).byTaskId.keys());
}

function countManifests(factsRoot: string): number {
  const tasksRoot = join(factsRoot, "registry", "tasks");
  if (!existsSync(tasksRoot)) return 0;
  let count = 0;
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(tasksRoot, entry.name, "bundle", "manifest.json")))
      count += 1;
  }
  return count;
}

function readRebuildProgress(dataRoot: string): { success: number | null; frozen: number | null } {
  const rebuildDir = join(
    dataRoot,
    "tmp/machine-facts-rebuild-20260906-v1",
  );
  const progressPath = join(rebuildDir, "progress.json");
  const frozenPath = join(rebuildDir, "frozen-ids.txt");
  let success: number | null = null;
  let frozen: number | null = null;
  if (existsSync(progressPath)) {
    try {
      const progress = JSON.parse(readFileSync(progressPath, "utf8")) as {
        success?: number;
      };
      success = progress.success ?? null;
    } catch {
      success = null;
    }
  }
  if (existsSync(frozenPath)) {
    frozen = readFileSync(frozenPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean).length;
  }
  return { success, frozen };
}

export function computeFactsGap(options: {
  readonly dataRoot: string;
  readonly factsRoot: string;
  readonly statusFile?: string;
}): { inventory: FactsGapInventory; missingTaskIds: string[] } {
  const statusFile = options.statusFile ?? defaultTaskStatusFile(options.dataRoot);
  const status = loadTaskStatus(statusFile, options.dataRoot);
  const successPackIds = Object.values(status.tasks)
    .filter((record) => record.status === "SUCCESS")
    .map((record) => record.taskId)
    .sort((left, right) => left.localeCompare(right));
  const indexed = readIndexedTaskIds(options.factsRoot);
  const missingTaskIds = successPackIds.filter((taskId) => !indexed.has(taskId));
  const rebuild = readRebuildProgress(options.dataRoot);
  return {
    inventory: {
      successPackCount: successPackIds.length,
      indexedFactsCount: indexed.size,
      manifestCount: countManifests(options.factsRoot),
      missingFactsCount: missingTaskIds.length,
      rebuildSep6Success: rebuild.success,
      rebuildSep6Frozen: rebuild.frozen,
    },
    missingTaskIds,
  };
}

function writeBatches(
  ids: readonly string[],
  batchDir: string,
  chunkSize: number,
): string[] {
  mkdirSync(batchDir, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    const path = join(
      batchDir,
      `batch-${String(Math.floor(index / chunkSize)).padStart(4, "0")}.txt`,
    );
    writeFileSync(path, `${chunk.join("\n")}\n`, "utf8");
    paths.push(path);
  }
  return paths;
}

function runNpmMachineFacts(
  dataRoot: string,
  factsRoot: string,
  taskIds: readonly string[],
): { exitCode: number; stdout: string } {
  try {
    const stdout = execFileSync(
      "npm",
      [
        "run",
        "input-pack:machine-facts",
        "--",
        "--data-root",
        dataRoot,
        "--output",
        factsRoot,
        "--task-id",
        taskIds.join(","),
      ],
      { cwd: repoRoot, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return { exitCode: 0, stdout };
  } catch (error) {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 1;
    const stdout =
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
    return { exitCode: status, stdout };
  }
}

function parseMachineFactsCounts(stdout: string): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    const parsed = JSON.parse(stdout) as {
      tasks?: readonly { status?: string; state?: string }[];
    };
    for (const task of parsed.tasks ?? []) {
      const key = task.status ?? task.state ?? "UNKNOWN";
      counts[key] = (counts[key] ?? 0) + 1;
    }
  } catch {
    counts.PARSE_ERROR = 1;
  }
  return counts;
}

function main(): void {
  const paths = resolveWorkspacePaths({ configPath: option("--config"), overrides: { dataRoot: option("--data-root"), factsRoot: option("--facts-root") } });
  const dataRoot = paths.inputPackRoot;
  const factsRoot = paths.factsRoot;
  const workDir = option("--work-dir") ?? join(paths.dataRoot, "tmp/field-facts-gap-fill");
  const statusFile = option("--status-file");
  const inventoryOnly = process.argv.includes("--inventory-only");
  const runBatches = process.argv.includes("--run-batches");
  const chunkSize = Number.parseInt(option("--batch-size") ?? "50", 10);
  const maxBatches = option("--max-batches");
  const startBatch = Number.parseInt(option("--start-batch") ?? "0", 10);
  const logPath = join(workDir, "orchestrator.log");

  mkdirSync(workDir, { recursive: true });
  log("field_facts_gap_fill_start", logPath);

  const { inventory, missingTaskIds } = computeFactsGap({
    dataRoot,
    factsRoot,
    statusFile,
  });
  writeFileSync(
    join(workDir, "facts-gap-summary.json"),
    `${JSON.stringify({ ...inventory, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(workDir, "missing-facts-task-ids.txt"),
    `${missingTaskIds.join("\n")}\n`,
    "utf8",
  );
  log(
    `inventory successPacks=${inventory.successPackCount} indexed=${inventory.indexedFactsCount} manifests=${inventory.manifestCount} missing=${inventory.missingFactsCount}`,
    logPath,
  );

  if (!runBatches || inventoryOnly) {
    process.stdout.write(
      `${JSON.stringify({ workDir, inventory, missingSample: missingTaskIds.slice(0, 20) }, null, 2)}\n`,
    );
    return;
  }

  const batchPaths = writeBatches(
    missingTaskIds,
    join(workDir, "machine-facts-batches"),
    chunkSize,
  );
  const limit =
    maxBatches === undefined
      ? batchPaths.length
      : Math.min(batchPaths.length, startBatch + Number.parseInt(maxBatches, 10));
  const manifestPath = join(workDir, "batch-manifest.jsonl");
  const manifests: Record<string, unknown>[] = [];

  for (let index = startBatch; index < limit; index += 1) {
    const batchPath = batchPaths[index];
    if (batchPath === undefined) break;
    const taskIds = readFileSync(batchPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    log(`machine_facts batch=${index} tasks=${taskIds.length}`, logPath);
    const result = runNpmMachineFacts(dataRoot, factsRoot, taskIds);
    const counts = parseMachineFactsCounts(result.stdout);
    const row = {
      batchIndex: index,
      batchPath,
      requested: taskIds.length,
      exitCode: result.exitCode,
      counts,
      finishedAt: new Date().toISOString(),
    };
    manifests.push(row);
    appendFileSync(manifestPath, `${JSON.stringify(row)}\n`, "utf8");
    log(
      `machine_facts_done batch=${index} exit=${result.exitCode} counts=${JSON.stringify(counts)}`,
      logPath,
    );
  }

  const after = computeFactsGap({ dataRoot, factsRoot, statusFile });
  writeFileSync(
    join(workDir, "facts-gap-summary-after.json"),
    `${JSON.stringify(after.inventory, null, 2)}\n`,
    "utf8",
  );
  log("field_facts_gap_fill_complete", logPath);
  process.stdout.write(
    `${JSON.stringify({ workDir, batchesRun: manifests.length, manifests, before: inventory, after: after.inventory }, null, 2)}\n`,
  );
}

main();
