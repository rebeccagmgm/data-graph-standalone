import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultOutDir =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data/tmp/hivetask-empty-script-miss";
const defaultDataRoot =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function runStep(
  label: string,
  command: string,
  args: string[],
  options: { tolerateErrors?: boolean } = {},
): void {
  process.stderr.write(`[batch] ${label} ${JSON.stringify({ command, args })}\n`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const message = `${label} failed exit=${result.status ?? "?"} ${result.stderr?.slice(0, 400) ?? ""}`;
    if (options.tolerateErrors) {
      process.stderr.write(`[batch] warn ${message}\n`);
      return;
    }
    throw new Error(message);
  }
}

function main(): void {
  const outDir = option("--out-dir") ?? defaultOutDir;
  const dataRoot = option("--data-root") ?? defaultDataRoot;
  const fillChunkSize = Number(option("--fill-chunk-size") ?? "400");
  const packChunkSize = Number(option("--pack-chunk-size") ?? "1000");
  const intervalMs = option("--interval-ms") ?? "2000";
  const includeSecondary = flag("--include-secondary");
  const skipHoraeDetail = flag("--skip-horae-detail");
  const skipSqlFill = flag("--skip-sql-fill");
  const skipInputPack = flag("--skip-input-pack");
  const skipExport = flag("--skip-export");
  const startChunk = Number(option("--start-chunk") ?? "1");
  const startPackChunk = Number(option("--start-pack-chunk") ?? "1");
  const strict = flag("--strict");
  const force = !process.argv.includes("--no-force");

  if (!skipExport) {
    const exportScript = join(
      repoRoot,
      "scripts/survey/export-hivetask-empty-script-miss-cohort.mjs",
    );
    runStep("export-cohort", "node", [exportScript], {
      tolerateErrors: !strict,
    });
  }

  const primaryPath = join(outDir, "target-primary-task-ids.txt");
  const secondaryPath = join(outDir, "target-secondary-task-ids.txt");
  const taskIds = readFileSync(primaryPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (includeSecondary && existsSync(secondaryPath)) {
    taskIds.push(
      ...readFileSync(secondaryPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }

  const batchDir = join(outDir, "batches");
  mkdirSync(batchDir, { recursive: true });
  const fillChunks = chunk(taskIds, fillChunkSize);
  const progressPath = join(outDir, "batch-progress.jsonl");

  for (const [index, ids] of fillChunks.entries()) {
    const chunkNumber = index + 1;
    if (chunkNumber < startChunk) continue;

    const chunkFile = join(batchDir, `chunk-${String(chunkNumber).padStart(3, "0")}.txt`);
    writeFileSync(chunkFile, `${ids.join("\n")}\n`, "utf8");
    const chunkLabel = `${chunkNumber}/${fillChunks.length}`;
    const skipHoraeForChunk =
      skipHoraeDetail || (chunkNumber === 1 && flag("--skip-horae-chunk-1"));

    if (!skipHoraeForChunk) {
      runStep(
        `horae-detail ${chunkLabel}`,
        "npm",
        [
          "run",
          "input-pack:fill-horae-detail-cache",
          "--",
          "--task-ids-file",
          chunkFile,
          "--max-errors",
          "999999",
          "--interval-ms",
          intervalMs,
          ...(force ? ["--force"] : []),
        ],
        { tolerateErrors: !strict },
      );
    }

    if (!skipSqlFill) {
      runStep(
        `hive-task-sql ${chunkLabel}`,
        "npm",
        [
          "run",
          "input-pack:fill-hive-task-sql-cache",
          "--",
          "--task-ids-file",
          chunkFile,
          "--interval-ms",
          intervalMs,
          ...(force ? ["--force"] : []),
        ],
        { tolerateErrors: !strict },
      );
    }

    appendProgress(progressPath, {
      phase: "fill",
      chunk: chunkLabel,
      taskCount: ids.length,
      at: new Date().toISOString(),
    });
  }

  if (!skipInputPack) {
    const packChunks = chunk(taskIds, packChunkSize);
    for (const [index, ids] of packChunks.entries()) {
      const packChunkNumber = index + 1;
      if (packChunkNumber < startPackChunk) continue;
      const chunkFile = join(batchDir, `pack-${String(packChunkNumber).padStart(3, "0")}.txt`);
      writeFileSync(chunkFile, `${ids.join("\n")}\n`, "utf8");
      const chunkLabel = `${packChunkNumber}/${packChunks.length}`;
      runStep(
        `input-pack ${chunkLabel}`,
        "npm",
        [
          "run",
          "input-pack:from-cache",
          "--",
          "--data-root",
          dataRoot,
          "--task-ids-file",
          chunkFile,
          ...(force ? ["--force"] : []),
        ],
        { tolerateErrors: !strict },
      );
      appendProgress(progressPath, {
        phase: "input-pack",
        chunk: chunkLabel,
        taskCount: ids.length,
        at: new Date().toISOString(),
      });
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      taskCount: taskIds.length,
      fillChunks: fillChunks.length,
      outDir,
      dataRoot,
    })}\n`,
  );
}

function appendProgress(path: string, record: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "a" });
}

if (process.argv[1]?.endsWith("run-hivetask-empty-script-miss-batch.ts")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
