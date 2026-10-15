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
const onlineDir = join(repairDir, "online-repair");
const logPath = join(onlineDir, "orchestrator.log");

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  mkdirSync(onlineDir, { recursive: true });
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

function chunkIds(ids: string[], size: number, prefix: string): string[] {
  const batchDir = join(onlineDir, "batches");
  mkdirSync(batchDir, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < ids.length; index += size) {
    const chunk = ids.slice(index, index + size);
    const filePath = join(
      batchDir,
      `${prefix}-${String(Math.floor(index / size) + 1).padStart(3, "0")}.txt`,
    );
    writeFileSync(filePath, `${chunk.join("\n")}\n`, "utf8");
    paths.push(filePath);
  }
  return paths;
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

function waitForSafeCollect(maxMinutes = 30): boolean {
  const deadline = Date.now() + maxMinutes * 60_000;
  let quiet = 0;
  while (Date.now() < deadline) {
    if (foreignFromCacheWriters() === 0) {
      quiet += 1;
      if (quiet >= 2) return true;
    } else quiet = 0;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  }
  return false;
}

function manifestChangedTasks(manifestPath: string): string[] {
  if (!existsSync(manifestPath)) return [];
  const changed = new Set<string>();
  for (const line of readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { taskId?: string; changed?: boolean };
    if (row.changed === true && row.taskId) changed.add(row.taskId);
  }
  return [...changed];
}

async function main(): Promise<void> {
  mkdirSync(onlineDir, { recursive: true });
  log("start cohort online table repair");
  runNode("scripts/survey/export-cohort-partial-inventory.mjs");
  const inventoryPath = join(repairDir, "cohort-partial-inventory.json");
  const partialIds = readFileSync(
    join(repairDir, "cohort-partial-task-ids.txt"),
    "utf8",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const manifestPath = join(onlineDir, "online-table-repair-manifest.jsonl");
  writeFileSync(manifestPath, "");
  const batches = chunkIds(partialIds, 40, "repair");
  const summaryRows: Array<Record<string, unknown>> = [];
  for (const [index, batchPath] of batches.entries()) {
    log(`online repair chunk ${index + 1}/${batches.length}`);
    try {
      runNpm([
        "run",
        "input-pack:repair-partials",
        "--",
        "--data-root",
        dataRoot,
        "--cache-root",
        cacheRoot,
        "--inventory",
        inventoryPath,
        "--task-ids-file",
        batchPath,
        "--manifest",
        manifestPath,
        "--table-only",
        "--allow-online-backup",
        "--max-errors",
        "200",
      ]);
      summaryRows.push({ chunk: index + 1, status: "ok" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`chunk ${index + 1} failed ${message.slice(0, 200)}`);
      summaryRows.push({ chunk: index + 1, status: "failed", error: message.slice(0, 500) });
    }
  }
  writeFileSync(
    join(onlineDir, "repair-chunks.json"),
    `${JSON.stringify(summaryRows, null, 2)}\n`,
  );
  const changed = manifestChangedTasks(manifestPath);
  log(`online repair changedTasks=${changed.length}`);

  if (!waitForSafeCollect()) {
    log("collect deferred after online repair");
    writeFileSync(
      join(onlineDir, "collect-deferred.json"),
      `${JSON.stringify({ changedCount: changed.length, at: new Date().toISOString() }, null, 2)}\n`,
    );
    return;
  }

  runNpm(["run", "input-pack:repair-cohort-partials"]);

  runNode("scripts/survey/accept-hivetask-empty-script-miss-batch.mjs");
  const acceptance = JSON.parse(
    readFileSync(join(cohortDir, "acceptance-report.json"), "utf8"),
  );
  writeFileSync(
    join(cohortDir, "COHORT-RESULT.json"),
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        phase: "after-online-table-repair",
        combined: {
          packSuccess: acceptance.combined.packSuccess,
          packPartial: acceptance.combined.packPartial,
          packSuccessPct: acceptance.combined.packSuccessPct,
          hiveSqlStillMiss: acceptance.combined.hiveSqlStillMiss,
          packFailed: acceptance.combined.packFailed,
        },
        onlineRepair: { changedTasks: changed.length, chunks: batches.length },
      },
      null,
      2,
    )}\n`,
  );
  log("done");
}

main().catch((error) => {
  log(`fatal ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
