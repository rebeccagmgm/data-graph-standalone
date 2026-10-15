import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  resolveScheduleEvidenceCacheRoot,
} from "../../evidence/schedule-evidence-cache.ts";

export interface ListMissingEvidenceOptions {
  readonly cacheRoot?: string;
  readonly databasePath?: string;
  readonly outputPath?: string;
  readonly evidenceType?: string;
  readonly direction?: string;
  readonly depth?: number;
}

export interface ListMissingEvidenceResult {
  readonly databasePath: string;
  readonly outputPath: string;
  readonly evidenceType: string;
  readonly direction: string;
  readonly depth: number;
  readonly missing: number;
}

function requiredString(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`${name}_MISSING`);
  return value.trim();
}

function databaseUri(databasePath: string): string {
  return `file:${databasePath.replaceAll("\\", "/")}?immutable=1`;
}

export function listMissingEvidenceFromSqlite(
  options: ListMissingEvidenceOptions = {},
): ListMissingEvidenceResult {
  const cacheRoot = resolve(options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT);
  const scheduleEvidenceRoot = resolveScheduleEvidenceCacheRoot(cacheRoot);
  const databasePath = resolve(
    options.databasePath ?? join(scheduleEvidenceRoot, "tasks-sqlite", "schedule-evidence.sqlite"),
  );
  if (!existsSync(databasePath)) throw new Error(`SQLITE_DATABASE_MISSING:${databasePath}`);
  const evidenceType = requiredString(options.evidenceType ?? "horae-task-type", "EVIDENCE_TYPE");
  const direction = options.direction?.trim() ?? "";
  const depth = options.depth ?? 0;
  if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("DEPTH_INVALID");
  const outputPath = resolve(
    options.outputPath ??
      join(
        scheduleEvidenceRoot,
        `missing-${evidenceType}${direction ? `-${direction}` : ""}-sqlite.txt`,
      ),
  );

  const database = new DatabaseSync(databaseUri(databasePath), { readOnly: true });
  try {
    const rows = database
      .prepare(`
        SELECT t.task_id AS taskId
        FROM task_inventory t
        LEFT JOIN evidence e
          ON e.task_id = t.task_id
         AND e.evidence_type = ?
         AND e.direction = ?
         AND e.depth = ?
        WHERE e.task_id IS NULL
        ORDER BY CAST(t.task_id AS INTEGER), t.task_id
      `)
      .all(evidenceType, direction, depth) as Array<{ readonly taskId: unknown }>;
    const taskIds = rows.map((row) => String(row.taskId));
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, taskIds.length === 0 ? "" : `${taskIds.join("\n")}\n`, "utf8");
    return {
      databasePath,
      outputPath,
      evidenceType,
      direction,
      depth,
      missing: taskIds.length,
    };
  } finally {
    database.close();
  }
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

if (process.argv[1]?.endsWith("list-missing-evidence-sqlite.ts")) {
  const args = process.argv.slice(2);
  const depthValue = option(args, "--depth");
  const result = listMissingEvidenceFromSqlite({
    cacheRoot: option(args, "--cache-root"),
    databasePath: option(args, "--database-path"),
    outputPath: option(args, "--output"),
    evidenceType: option(args, "--evidence-type"),
    direction: option(args, "--direction"),
    depth: depthValue === undefined ? undefined : Number(depthValue),
  });
  console.log(JSON.stringify(result));
}
