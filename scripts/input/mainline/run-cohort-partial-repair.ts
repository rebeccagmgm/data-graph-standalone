import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data";
const cacheRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-cache";
const cohortDir =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data/tmp/hivetask-empty-script-miss";
const repairDir = join(cohortDir, "partial-repair");
const logPath = join(repairDir, "orchestrator.log");

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  mkdirSync(repairDir, { recursive: true });
  writeFileSync(logPath, line, { flag: "a" });
}

function runNode(script: string): void {
  execFileSync("node", [join(repoRoot, script)], {
    stdio: "inherit",
    cwd: repoRoot,
  });
}

function runNpm(args: string[]): void {
  execFileSync("npm", args, { stdio: "inherit", cwd: repoRoot, shell: true });
}

function foreignFromCacheWriters(): number {
  const output = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'input-pack:from-cache') -and ($_.CommandLine -notmatch 'partial-repair') }).Count",
    ],
    { encoding: "utf8" },
  ).trim();
  return Number.parseInt(output, 10) || 0;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForSafeCollect(maxMinutes = 90): boolean {
  const deadline = Date.now() + maxMinutes * 60_000;
  let quietChecks = 0;
  while (Date.now() < deadline) {
    const foreign = foreignFromCacheWriters();
    if (foreign === 0) {
      quietChecks += 1;
      if (quietChecks >= 2) {
        log("safe_to_collect");
        return true;
      }
    } else {
      quietChecks = 0;
      log(`waiting foreign_from_cache=${foreign}`);
    }
    sleepMs(60_000);
  }
  return false;
}

function chunkFile(idsPath: string, chunkSize: number, prefix: string): string[] {
  const ids = readFileSync(idsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const batchDir = join(repairDir, "collect-batches");
  mkdirSync(batchDir, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    const filePath = join(
      batchDir,
      `${prefix}-${String(Math.floor(index / chunkSize) + 1).padStart(3, "0")}.txt`,
    );
    writeFileSync(filePath, `${chunk.join("\n")}\n`, "utf8");
    paths.push(filePath);
  }
  return paths;
}

async function main(): Promise<void> {
  mkdirSync(repairDir, { recursive: true });
  log("start cohort partial recollect (skip repair-partials to avoid table-pack conflicts with full-corpus heal)");
  runNode("scripts/survey/export-cohort-partial-inventory.mjs");
  const scope = JSON.parse(
    readFileSync(join(repairDir, "cohort-partial-scope.json"), "utf8"),
  ) as { cohortPartial: number; partialIdsPath: string };

  if (!waitForSafeCollect()) {
    log("collect deferred");
    writeFileSync(
      join(repairDir, "collect-deferred.json"),
      `${JSON.stringify({ deferredAt: new Date().toISOString(), partialIdsPath: scope.partialIdsPath }, null, 2)}\n`,
    );
    return;
  }

  const progressPath = join(repairDir, "collect-progress.jsonl");
  const batches = chunkFile(scope.partialIdsPath, 120, "collect");
  const logDir = join(repairDir, "collect-logs");
  mkdirSync(logDir, { recursive: true });
  for (const [index, batchPath] of batches.entries()) {
    while (foreignFromCacheWriters() > 0) {
      log(`pause before chunk ${index + 1}: foreign from-cache active`);
      if (!waitForSafeCollect(30)) throw new Error("COLLECT_YIELD_TIMEOUT");
    }
    log(`collect chunk ${index + 1}/${batches.length}`);
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
      "--log-dir",
      logDir,
    ]);
    writeFileSync(
      progressPath,
      `${JSON.stringify({ at: new Date().toISOString(), chunk: index + 1, total: batches.length, batchPath })}\n`,
      { flag: "a" },
    );
  }

  runNode("scripts/survey/accept-hivetask-empty-script-miss-batch.mjs");
  writeFileSync(
    join(repairDir, "done.json"),
    `${JSON.stringify({ finishedAt: new Date().toISOString(), chunks: batches.length }, null, 2)}\n`,
  );
  log("done");
}

main().catch((error) => {
  log(`fatal ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
