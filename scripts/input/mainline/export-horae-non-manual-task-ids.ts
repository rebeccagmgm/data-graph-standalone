import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT } from "../../evidence/schedule-evidence-cache.ts";

const DEFAULT_CHUNK_SIZE = 5_000;

export interface ExportHoraeNonManualTaskIdsOptions {
  readonly databasePath: string;
  readonly outputDir: string;
  readonly chunkSize?: number;
}

export interface ExportHoraeNonManualTaskIdsResult {
  readonly databasePath: string;
  readonly outputDir: string;
  readonly taskCount: number;
  readonly chunkCount: number;
  readonly manifestPath: string;
}

function databaseUri(databasePath: string): string {
  return `file:${resolve(databasePath).replaceAll("\\", "/")}?immutable=1`;
}

export function exportHoraeNonManualTaskIds(
  options: ExportHoraeNonManualTaskIdsOptions,
): ExportHoraeNonManualTaskIdsResult {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new Error("CHUNK_SIZE_INVALID");
  mkdirSync(resolve(options.outputDir), { recursive: true });
  const database = new DatabaseSync(databaseUri(options.databasePath), {
    readOnly: true,
  });
  try {
    const taskIds = (
      database
        .prepare(
          `SELECT task_id AS taskId
             FROM horae_task_catalog
            WHERE is_manual = 0
            ORDER BY CAST(task_id AS INTEGER), task_id`,
        )
        .all() as Array<{ readonly taskId: unknown }>
    ).map((row) => String(row.taskId));
    const outputDir = resolve(options.outputDir);
    const chunkCount = Math.ceil(taskIds.length / chunkSize);
    const chunks: string[] = [];
    for (let offset = 0; offset < taskIds.length; offset += chunkSize) {
      const chunkName = `part-${String(chunks.length + 1).padStart(5, "0")}.txt`;
      const chunkPath = join(outputDir, chunkName);
      writeFileSync(
        chunkPath,
        `${taskIds.slice(offset, offset + chunkSize).join("\n")}\n`,
        "utf8",
      );
      chunks.push(chunkName);
    }
    const manifestPath = join(outputDir, "manifest.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: "1.0.0",
          source: basename(options.databasePath),
          filter: { isManual: 0 },
          taskCount: taskIds.length,
          chunkSize,
          chunkCount,
          chunks,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return {
      databasePath: resolve(options.databasePath),
      outputDir,
      taskCount: taskIds.length,
      chunkCount,
      manifestPath,
    };
  } finally {
    database.close();
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

if (process.argv[1]?.endsWith("export-horae-non-manual-task-ids.ts")) {
  try {
    const cacheRoot = resolve(
      option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
    );
    const databasePath = resolve(
      option("--database-path") ??
        join(
          cacheRoot,
          "schedule-evidence",
          "tasks-sqlite",
          "schedule-evidence.sqlite",
        ),
    );
    const outputDir = resolve(
      option("--output-dir") ??
        join(cacheRoot, "schedule-evidence", "horae-non-manual-task-ids"),
    );
    const chunkSize = option("--chunk-size");
    console.log(
      JSON.stringify(
        exportHoraeNonManualTaskIds({
          databasePath,
          outputDir,
          chunkSize: chunkSize === undefined ? undefined : Number(chunkSize),
        }),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
