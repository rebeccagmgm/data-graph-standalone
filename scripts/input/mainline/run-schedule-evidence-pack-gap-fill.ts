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

import { assembleCacheTaskEvidence } from "../shared/cache-task-evidence.ts";
import { readManualTaskIds } from "../shared/manual-task-exclusion.ts";
import { taskIdsFromScheduleEvidenceCache } from "./fill-horae-relation-cache.ts";
import { resolveScheduleEvidenceCacheRoot } from "../../evidence/schedule-evidence-cache.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultDataRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data";
const defaultCacheRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-cache";
const defaultGapDir = join(
  defaultDataRoot,
  "tmp/schedule-evidence-pack-gap",
);

export type GapEvidenceTier =
  | "FULL_CORE"
  | "PARTIAL_CORE"
  | "ASSEMBLE_BUILDABLE"
  | "ASSEMBLE_SKIP"
  | "ASSEMBLE_FAILED"
  | "MANUAL_OR_FROZEN"
  | "NOT_FOUND";

export type GapInventoryRow = {
  readonly taskId: string;
  readonly tier: GapEvidenceTier;
  readonly taskCategory?: string;
  readonly reason?: string;
  readonly cacheArtifacts?: readonly string[];
};

export type GapInventory = {
  readonly cacheTaskCount: number;
  readonly existingPackCount: number;
  readonly gapCount: number;
  readonly countsByTier: Record<GapEvidenceTier, number>;
  readonly rows: readonly GapInventoryRow[];
};

export type BatchManifestRow = {
  readonly batchPath: string;
  readonly batchIndex: number;
  readonly requested: number;
  readonly exitCode: number;
  readonly counts: Record<string, number>;
  readonly finishedAt: string;
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

function readIds(path: string): string[] {
  if (!existsSync(path)) return [];
  return [
    ...new Set(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function indexExistingPackTaskIds(dataRoot: string): Set<string> {
  const tasksRoot = join(dataRoot, "tasks");
  const ids = new Set<string>();
  if (!existsSync(tasksRoot)) return ids;
  for (const category of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = join(tasksRoot, category.name);
    for (const task of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!task.isDirectory()) continue;
      if (existsSync(join(categoryDir, task.name, "task.json"))) ids.add(task.name);
    }
  }
  return ids;
}

function classifyGapTask(
  taskId: string,
  cacheRoot: string,
  manualTaskIds: ReadonlySet<string>,
): GapInventoryRow {
  if (manualTaskIds.has(taskId))
    return { taskId, tier: "MANUAL_OR_FROZEN", reason: "MANUAL_TASK_IDS_FILE" };

  const taskDir = join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks",
    taskId,
  );
  const hasHorae = existsSync(join(taskDir, "horae-task-type.json"));
  const hasSchedule = existsSync(join(taskDir, "szdata-schedule-detail.json"));
  if (!hasHorae && !hasSchedule)
    return { taskId, tier: "NOT_FOUND", reason: "MISSING_CORE_CACHE_FILES" };
  if (!hasHorae || !hasSchedule) {
    return {
      taskId,
      tier: "PARTIAL_CORE",
      reason: hasHorae ? "MISSING_SZDATA_SCHEDULE_DETAIL" : "MISSING_HORAE_TASK_TYPE",
      cacheArtifacts: [
        ...(hasHorae ? ["horae-task-type.json"] : []),
        ...(hasSchedule ? ["szdata-schedule-detail.json"] : []),
      ],
    };
  }

  try {
    const assembled = assembleCacheTaskEvidence(taskId, cacheRoot);
    if (assembled.kind === "MANUAL_OR_FROZEN")
      return {
        taskId,
        tier: "MANUAL_OR_FROZEN",
        reason: "MANUAL_OR_FROZEN",
        cacheArtifacts: assembled.cacheArtifacts,
      };
    if (assembled.kind === "NOT_FOUND")
      return {
        taskId,
        tier: "NOT_FOUND",
        reason: "HORAE_TASK_NOT_FOUND",
        cacheArtifacts: assembled.cacheArtifacts,
      };
    if (assembled.kind === "SKIPPED")
      return {
        taskId,
        tier: "ASSEMBLE_SKIP",
        taskCategory: assembled.taskCategory,
        reason: assembled.reason,
        cacheArtifacts: assembled.cacheArtifacts,
      };
    if (assembled.kind === "FAILED")
      return {
        taskId,
        tier: "ASSEMBLE_FAILED",
        reason: assembled.reason,
        cacheArtifacts: assembled.cacheArtifacts,
      };
    return {
      taskId,
      tier: hasHorae && hasSchedule ? "FULL_CORE" : "ASSEMBLE_BUILDABLE",
      taskCategory: assembled.evidence.taskCategory,
      cacheArtifacts: assembled.cacheArtifacts,
    };
  } catch (error) {
    return {
      taskId,
      tier: "ASSEMBLE_FAILED",
      reason: error instanceof Error ? error.message : String(error),
      cacheArtifacts: [
        ...(hasHorae ? ["horae-task-type.json"] : []),
        ...(hasSchedule ? ["szdata-schedule-detail.json"] : []),
      ],
    };
  }
}

export function computeScheduleEvidencePackGap(options: {
  readonly dataRoot: string;
  readonly cacheRoot: string;
}): GapInventory {
  const dataRoot = options.dataRoot;
  const cacheRoot = options.cacheRoot;
  const cacheTaskIds = taskIdsFromScheduleEvidenceCache(cacheRoot);
  const existing = indexExistingPackTaskIds(dataRoot);
  const manualTaskIds = readManualTaskIds(cacheRoot);
  const gapIds = cacheTaskIds.filter((taskId) => !existing.has(taskId));
  const countsByTier: Record<GapEvidenceTier, number> = {
    FULL_CORE: 0,
    PARTIAL_CORE: 0,
    ASSEMBLE_BUILDABLE: 0,
    ASSEMBLE_SKIP: 0,
    ASSEMBLE_FAILED: 0,
    MANUAL_OR_FROZEN: 0,
    NOT_FOUND: 0,
  };
  const rows: GapInventoryRow[] = [];
  for (const taskId of gapIds) {
    const row = classifyGapTask(taskId, cacheRoot, manualTaskIds);
    rows.push(row);
    countsByTier[row.tier] += 1;
  }
  return {
    cacheTaskCount: cacheTaskIds.length,
    existingPackCount: existing.size,
    gapCount: gapIds.length,
    countsByTier,
    rows,
  };
}

export function writeGapInventory(
  inventory: GapInventory,
  gapDir: string,
): Record<string, string> {
  mkdirSync(gapDir, { recursive: true });
  const paths: Record<string, string> = {};
  const writeTier = (name: string, tier: GapEvidenceTier | GapEvidenceTier[]): void => {
    const tiers = Array.isArray(tier) ? tier : [tier];
    const ids = inventory.rows
      .filter((row) => tiers.includes(row.tier))
      .map((row) => row.taskId)
      .sort((left, right) => left.localeCompare(right));
    const path = join(gapDir, `${name}.txt`);
    writeFileSync(path, `${ids.join("\n")}\n`, "utf8");
    paths[name] = path;
  };
  writeFileSync(
    join(gapDir, "gap-summary.json"),
    `${JSON.stringify(
      {
        cacheTaskCount: inventory.cacheTaskCount,
        existingPackCount: inventory.existingPackCount,
        gapCount: inventory.gapCount,
        countsByTier: inventory.countsByTier,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeTier("gap-all", [
    "FULL_CORE",
    "PARTIAL_CORE",
    "ASSEMBLE_BUILDABLE",
    "ASSEMBLE_SKIP",
    "ASSEMBLE_FAILED",
  ]);
  writeTier("gap-full-core-priority", "FULL_CORE");
  writeTier("gap-partial-core", "PARTIAL_CORE");
  writeTier("gap-assemble-buildable", "ASSEMBLE_BUILDABLE");
  writeTier("gap-assemble-skip", "ASSEMBLE_SKIP");
  writeTier("gap-assemble-failed", "ASSEMBLE_FAILED");
  writeTier("gap-manual-or-frozen", "MANUAL_OR_FROZEN");
  writeTier("gap-not-found", "NOT_FOUND");
  paths.summary = join(gapDir, "gap-summary.json");
  paths.all = paths["gap-all"];
  paths.fullCore = paths["gap-full-core-priority"];
  return paths;
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

function runNpm(args: string[]): number {
  try {
    execFileSync("npm", args, { stdio: "inherit", cwd: repoRoot, shell: true });
    return 0;
  } catch (error) {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : 1;
    return status;
  }
}

function parseSummaryCounts(logDir: string): Record<string, number> {
  const summaryPath = join(logDir, "summaries.jsonl");
  if (!existsSync(summaryPath)) return {};
  const counts: Record<string, number> = {};
  for (const line of readFileSync(summaryPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { collectionStatus?: string };
      const key = row.collectionStatus ?? "UNKNOWN";
      counts[key] = (counts[key] ?? 0) + 1;
    } catch {
      counts.PARSE_ERROR = (counts.PARSE_ERROR ?? 0) + 1;
    }
  }
  return counts;
}

function resolveTierList(gapDir: string, tier: string): string {
  switch (tier) {
    case "full-core":
      return join(gapDir, "gap-full-core-priority.txt");
    case "all-buildable":
      return join(gapDir, "gap-all.txt");
    case "partial-core":
      return join(gapDir, "gap-partial-core.txt");
    default:
      throw new Error(`UNKNOWN_TIER:${tier}`);
  }
}

function main(): void {
  const dataRoot = option("--data-root") ?? defaultDataRoot;
  const cacheRoot = option("--cache-root") ?? defaultCacheRoot;
  const gapDir = option("--gap-dir") ?? defaultGapDir;
  const logPath = join(gapDir, "orchestrator.log");
  const inventoryOnly = process.argv.includes("--inventory-only");
  const runBatches = process.argv.includes("--run-batches");
  const chunkSize = Number.parseInt(option("--batch-size") ?? "300", 10);
  const maxBatches = option("--max-batches");
  const startBatch = Number.parseInt(option("--start-batch") ?? "0", 10);
  const tier = option("--tier") ?? "full-core";

  mkdirSync(gapDir, { recursive: true });
  log("schedule_evidence_pack_gap_fill_start", logPath);

  const inventory = computeScheduleEvidencePackGap({ dataRoot, cacheRoot });
  const paths = writeGapInventory(inventory, gapDir);
  log(
    `inventory cache=${inventory.cacheTaskCount} existing=${inventory.existingPackCount} gap=${inventory.gapCount} tiers=${JSON.stringify(inventory.countsByTier)}`,
    logPath,
  );

  if (inventoryOnly && !runBatches) {
    process.stdout.write(
      `${JSON.stringify({ gapDir, paths, inventory: { ...inventory, rows: undefined, rowCount: inventory.rows.length } }, null, 2)}\n`,
    );
    return;
  }

  if (!runBatches) {
    process.stdout.write(
      `${JSON.stringify(
        {
          gapDir,
          paths,
          inventory: {
            cacheTaskCount: inventory.cacheTaskCount,
            existingPackCount: inventory.existingPackCount,
            gapCount: inventory.gapCount,
            countsByTier: inventory.countsByTier,
          },
          hint: "Re-run with --run-batches to construct packs",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const tierPath = resolveTierList(gapDir, tier);
  const taskIds = readIds(tierPath);
  if (taskIds.length === 0) throw new Error(`NO_TASK_IDS_FOR_TIER:${tierPath}`);
  const batchDir = join(gapDir, "from-cache-batches", tier);
  const batchPaths = writeBatches(taskIds, batchDir, chunkSize);
  const manifestPath = join(gapDir, "batch-manifest.jsonl");
  const limit =
    maxBatches === undefined
      ? batchPaths.length
      : Math.min(batchPaths.length, startBatch + Number.parseInt(maxBatches, 10));
  const manifests: BatchManifestRow[] = [];

  for (let index = startBatch; index < limit; index += 1) {
    const batchPath = batchPaths[index];
    if (batchPath === undefined) break;
    const logDir = join(gapDir, "batch-logs", tier, `batch-${String(index).padStart(4, "0")}`);
    log(`from_cache batch=${index} path=${batchPath} tasks=${readIds(batchPath).length}`, logPath);
    const exitCode = runNpm([
      "run",
      "input-pack:from-cache",
      "--",
      "--data-root",
      dataRoot,
      "--cache-root",
      cacheRoot,
      "--task-ids-file",
      batchPath,
      "--force",
      "--log-dir",
      logDir,
    ]);
    const counts = parseSummaryCounts(logDir);
    const row: BatchManifestRow = {
      batchPath,
      batchIndex: index,
      requested: readIds(batchPath).length,
      exitCode,
      counts,
      finishedAt: new Date().toISOString(),
    };
    manifests.push(row);
    appendFileSync(manifestPath, `${JSON.stringify(row)}\n`, "utf8");
    log(
      `from_cache_done batch=${index} exit=${exitCode} counts=${JSON.stringify(counts)}`,
      logPath,
    );
  }

  log("schedule_evidence_pack_gap_fill_complete", logPath);
  process.stdout.write(
    `${JSON.stringify(
      {
        gapDir,
        tier,
        batchesRun: manifests.length,
        manifests,
        inventory: {
          gapCount: inventory.gapCount,
          countsByTier: inventory.countsByTier,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main();
