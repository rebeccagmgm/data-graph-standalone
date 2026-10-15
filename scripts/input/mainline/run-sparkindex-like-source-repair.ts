import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultDataRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data";
const defaultCacheRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-cache";
const defaultRepairDir = join(
  defaultDataRoot,
  "tmp/sparkindex-like-source-repair",
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

function runNpm(args: string[]): void {
  execFileSync("npm", args, { stdio: "inherit", cwd: repoRoot, shell: true });
}

function main(): void {
  const dataRoot = option("--data-root") ?? defaultDataRoot;
  const cacheRoot = option("--cache-root") ?? defaultCacheRoot;
  const repairDir = option("--repair-dir") ?? defaultRepairDir;
  const taskIdsFile = option("--task-ids-file");
  const allowOnlineBackup = process.argv.includes("--allow-online-backup");
  const dryRun = process.argv.includes("--dry-run");
  const skipFromCache = process.argv.includes("--skip-from-cache");
  const logPath = join(repairDir, "orchestrator.log");
  const manifestPath = join(repairDir, "like-source-manifest.jsonl");

  mkdirSync(repairDir, { recursive: true });
  log("phase1_like_source_repair_start", logPath);

  const repairArgs = [
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
  ];
  if (taskIdsFile !== undefined) {
    repairArgs.push("--task-ids-file", taskIdsFile);
  }
  if (allowOnlineBackup) repairArgs.push("--allow-online-backup");
  if (dryRun) repairArgs.push("--dry-run");
  runNpm(repairArgs);

  const affectedIdsPath = join(dirname(manifestPath), "affected-task-ids.txt");
  if (skipFromCache || dryRun || !existsSync(affectedIdsPath)) {
    log(
      skipFromCache
        ? "skip_from_cache_requested"
        : dryRun
          ? "dry_run_skip_from_cache"
          : "no_affected_task_ids",
      logPath,
    );
    return;
  }

  const affectedIds = readFileSync(affectedIdsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (affectedIds.length === 0) {
    log("no_affected_task_ids_after_repair", logPath);
    return;
  }

  const batchDir = join(repairDir, "from-cache-batches");
  mkdirSync(batchDir, { recursive: true });
  const chunkSize = Number.parseInt(option("--batch-size") ?? "200", 10);
  for (let index = 0; index < affectedIds.length; index += chunkSize) {
    const chunk = affectedIds.slice(index, index + chunkSize);
    const batchPath = join(
      batchDir,
      `affected-${String(Math.floor(index / chunkSize)).padStart(4, "0")}.txt`,
    );
    writeFileSync(batchPath, `${chunk.join("\n")}\n`, "utf8");
    log(`from_cache_batch ${batchPath} count=${chunk.length}`, logPath);
    runNpm([
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
  }
  log("phase1_like_source_repair_complete", logPath);
}

main();
