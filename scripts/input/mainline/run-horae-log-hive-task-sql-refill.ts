import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultOutDir =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data/tmp/hivetask-empty-script-miss";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function main(): void {
  const outDir = option("--out-dir") ?? defaultOutDir;
  const chunkSize = Number(option("--chunk-size") ?? "200");
  const startChunk = Number(option("--start-chunk") ?? "1");
  const idsPath = join(outDir, "horae-log-hive-task-ids.txt");
  if (!existsSync(idsPath)) {
    execFileSync(
      "node",
      [join(repoRoot, "scripts/survey/export-horae-log-hive-task-ids.mjs")],
      { stdio: "inherit", cwd: repoRoot },
    );
  }
  const taskIds = readFileSync(idsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const batchDir = join(outDir, "horae-log-refill-batches");
  mkdirSync(batchDir, { recursive: true });
  const chunks = chunk(taskIds, chunkSize);
  process.stderr.write(
    `[horae-log-refill] tasks=${taskIds.length} chunks=${chunks.length} startChunk=${startChunk}\n`,
  );
  for (let index = startChunk - 1; index < chunks.length; index += 1) {
    const label = String(index + 1).padStart(3, "0");
    const chunkPath = join(batchDir, `chunk-${label}.txt`);
    writeFileSync(chunkPath, `${chunks[index]!.join("\n")}\n`, "utf8");
    process.stderr.write(
      `[horae-log-refill] chunk ${index + 1}/${chunks.length} ${JSON.stringify({
        count: chunks[index]!.length,
        file: chunkPath,
      })}\n`,
    );
    execFileSync(
      "npm",
      [
        "run",
        "input-pack:fill-hive-task-sql-cache",
        "--",
        "--task-ids-file",
        chunkPath,
        "--horae-log-only",
        "--interval-ms",
        "0",
      ],
      { stdio: "inherit", cwd: repoRoot, shell: true },
    );
  }
  process.stderr.write("[horae-log-refill] done\n");
}

main();
