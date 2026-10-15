import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultDataRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data";
const defaultCacheRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-cache";
const defaultRepairDir = join(
  defaultDataRoot,
  "tmp/sparkindex-schedule-pack-repair",
);
const defaultMissingIds = join(
  repoRoot,
  "docs/material-gap-exports/titans-otc-1fc9dd20/sparkIndex--MISSING_PACK-ids.txt",
);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function log(message: string, logPath: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, line, { flag: "a" });
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

function staleHalfPackTaskIds(dataRoot: string, cacheRoot: string): string[] {
  const tasksRoot = join(dataRoot, "tasks", "sparkIndex");
  const cacheTasksRoot = join(cacheRoot, "schedule-evidence", "tasks");
  if (!existsSync(tasksRoot)) return [];
  const stale: string[] = [];
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskId = entry.name;
    const taskPath = join(tasksRoot, taskId, "task.json");
    if (!existsSync(taskPath)) continue;
    const schedulePath = join(cacheTasksRoot, taskId, "szdata-schedule-detail.json");
    if (!existsSync(schedulePath)) continue;
    const pack = JSON.parse(readFileSync(taskPath, "utf8")) as {
      target?: unknown;
      sqlFiles?: readonly { slot?: string }[];
    };
    const hasTarget =
      typeof pack.target === "string"
        ? pack.target.trim() !== ""
        : pack.target !== null &&
          pack.target !== undefined &&
          typeof pack.target === "object";
    const slots = new Set((pack.sqlFiles ?? []).map((file) => file.slot));
    const schedule = JSON.parse(readFileSync(schedulePath, "utf8")) as {
      detail?: { prepareSql?: string; targetTable?: string };
    };
    const prepareInCache =
      typeof schedule.detail?.prepareSql === "string" &&
      schedule.detail.prepareSql.trim() !== "";
    const targetInCache =
      typeof schedule.detail?.targetTable === "string" &&
      schedule.detail.targetTable.trim() !== "";
    if (
      targetInCache &&
      (!hasTarget || (prepareInCache && !slots.has("prepare")))
    ) {
      stale.push(taskId);
    }
  }
  return stale.sort((left, right) => left.localeCompare(right));
}

function writeBatches(ids: readonly string[], batchDir: string, chunkSize: number): string[] {
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

function main(): void {
  const dataRoot = option("--data-root") ?? defaultDataRoot;
  const cacheRoot = option("--cache-root") ?? defaultCacheRoot;
  const repairDir = option("--repair-dir") ?? defaultRepairDir;
  const logPath = join(repairDir, "orchestrator.log");
  const chunkSize = Number.parseInt(option("--batch-size") ?? "100", 10);
  const skipLikeRepair = process.argv.includes("--skip-like-repair");
  const skipFromCache = process.argv.includes("--skip-from-cache");

  mkdirSync(repairDir, { recursive: true });
  log("sparkindex_schedule_pack_repair_start", logPath);

  const missingIds = readIds(option("--missing-ids-file") ?? defaultMissingIds);
  const staleIds = staleHalfPackTaskIds(dataRoot, cacheRoot);
  const phaseAIds = [...new Set([...missingIds, ...staleIds])].sort((a, b) =>
    a.localeCompare(b),
  );
  writeFileSync(
    join(repairDir, "phase-a-task-ids.txt"),
    `${phaseAIds.join("\n")}\n`,
    "utf8",
  );
  log(
    `phase_a workset missing=${missingIds.length} staleHalfPack=${staleIds.length} total=${phaseAIds.length}`,
    logPath,
  );

  if (!skipFromCache && phaseAIds.length > 0) {
    const batchDir = join(repairDir, "from-cache-batches");
    for (const batchPath of writeBatches(phaseAIds, batchDir, chunkSize)) {
      log(`from_cache ${batchPath}`, logPath);
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
      ]);
      if (exitCode !== 0)
        log(`from_cache_nonzero_exit ${batchPath} exit=${exitCode}`, logPath);
    }
  }

  if (!skipLikeRepair) {
    log("like_source_repair_start", logPath);
    const manifestPath = join(repairDir, "like-source-manifest.jsonl");
    runNpm([
      "run",
      "input-pack:repair-like-sources",
      "--",
      "--data-root",
      dataRoot,
      "--cache-root",
      cacheRoot,
      "--task-categories",
      "sparkIndex",
      "--manifest",
      manifestPath,
    ]);
    const affectedPath = join(repairDir, "affected-task-ids.txt");
    if (!skipFromCache && existsSync(affectedPath)) {
      const affectedIds = readIds(affectedPath);
      if (affectedIds.length > 0) {
        log(`from_cache_after_like count=${affectedIds.length}`, logPath);
        for (const batchPath of writeBatches(
          affectedIds,
          join(repairDir, "like-from-cache-batches"),
          chunkSize,
        )) {
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
          ]);
          if (exitCode !== 0)
            log(`like_from_cache_nonzero_exit ${batchPath} exit=${exitCode}`, logPath);
        }
      }
    }
  }

  log("sparkindex_schedule_pack_repair_complete", logPath);
  process.stdout.write(
    `${JSON.stringify(
      {
        repairDir,
        phaseA: {
          missingPack: missingIds.length,
          staleHalfPack: staleIds.length,
          total: phaseAIds.length,
        },
      },
      null,
      2,
    )}\n`,
  );
}

main();
