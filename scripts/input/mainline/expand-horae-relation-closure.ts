import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  resolveScheduleEvidenceCacheRoot,
  type HoraeRelationDirection,
} from "../../evidence/schedule-evidence-cache.ts";
import {
  expandHoraeRelationClosureFromLookup,
  neighborIdFromRelationRow,
  taskIdsFromFile,
  type HoraeRelationHopLookup,
} from "./fill-horae-relation-cache.ts";

const RELATION_UP = "horae-relation-up-depth-1";
const RELATION_DOWN = "horae-relation-down-depth-1";

export function defaultScheduleEvidenceSqlitePath(cacheRoot: string): string {
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks-sqlite",
    "schedule-evidence.sqlite",
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function neighborsFromPayloadJson(payloadJson: string | null): string[] {
  if (payloadJson === null || payloadJson.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  const root = asRecord(parsed);
  const rows = Array.isArray(root?.rows)
    ? root.rows
    : Array.isArray(parsed)
      ? parsed
      : [];
  const ids: string[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (record === undefined) continue;
    const neighbor = neighborIdFromRelationRow(record);
    if (neighbor !== undefined) ids.push(neighbor);
  }
  return ids;
}

export function horaeRelationLookupFromSqlite(
  database: DatabaseSync,
): HoraeRelationHopLookup {
  const present = {
    up: new Set<string>(),
    down: new Set<string>(),
  };
  const neighborMap = {
    up: new Map<string, readonly string[]>(),
    down: new Map<string, readonly string[]>(),
  };
  const rows = database
    .prepare(
      `SELECT task_id AS taskId, direction AS direction, payload_json AS payloadJson
         FROM evidence
        WHERE evidence_type IN (?, ?)
          AND depth = 1`,
    )
    .all(RELATION_UP, RELATION_DOWN) as Array<{
    readonly taskId: unknown;
    readonly direction: unknown;
    readonly payloadJson: unknown;
  }>;
  for (const row of rows) {
    const taskId = String(row.taskId);
    const direction = row.direction === "down" ? "down" : "up";
    present[direction].add(taskId);
    neighborMap[direction].set(
      taskId,
      neighborsFromPayloadJson(
        typeof row.payloadJson === "string" ? row.payloadJson : null,
      ),
    );
  }
  return {
    hasEvidence: (taskId, direction) => present[direction].has(taskId),
    neighbors: (taskId, direction) => neighborMap[direction].get(taskId) ?? [],
  };
}

export function expandHoraeRelationClosureFromSqlite(options: {
  readonly databasePath: string;
  readonly seedTaskIds: readonly string[];
  readonly directions?: readonly HoraeRelationDirection[];
}): ReturnType<typeof expandHoraeRelationClosureFromLookup> {
  const databasePath = resolve(options.databasePath);
  if (!existsSync(databasePath))
    throw new Error(`SQLITE_DATABASE_MISSING:${databasePath}`);
  const database = new DatabaseSync(
    `file:${databasePath.replaceAll("\\", "/")}?immutable=1`,
    { readOnly: true },
  );
  try {
    return expandHoraeRelationClosureFromLookup({
      seedTaskIds: options.seedTaskIds,
      directions: options.directions,
      lookup: horaeRelationLookupFromSqlite(database),
    });
  } finally {
    database.close();
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function writeIds(path: string, ids: readonly string[]): void {
  writeFileSync(path, ids.length === 0 ? "" : `${ids.join("\n")}\n`, "utf8");
}

function parseDirections(
  value: string | undefined,
): readonly HoraeRelationDirection[] {
  if (value === undefined || value === "both") return ["up", "down"];
  if (value === "up" || value === "down") return [value];
  throw new Error("DIRECTION_INVALID");
}

function main(): void {
  const taskIdsFile = option("--task-ids-file");
  if (taskIdsFile === undefined) throw new Error("TASK_IDS_FILE_MISSING");
  const cacheRoot =
    option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const databasePath =
    option("--database-path") ?? defaultScheduleEvidenceSqlitePath(cacheRoot);
  const outDir = resolve(
    option("--out-dir") ?? join(cacheRoot, "relation-closure"),
  );
  const directions = parseDirections(option("--direction"));
  const seedTaskIds = taskIdsFromFile(taskIdsFile);
  const result = expandHoraeRelationClosureFromSqlite({
    databasePath,
    seedTaskIds,
    directions,
  });
  mkdirSync(outDir, { recursive: true });
  writeIds(join(outDir, "ids-closure.txt"), result.closure);
  writeIds(join(outDir, "missing-up.txt"), result.missingUp);
  writeIds(join(outDir, "missing-down.txt"), result.missingDown);
  const summary = {
    generatedAt: new Date().toISOString(),
    source: "sqlite",
    databasePath,
    taskIdsFile,
    directions,
    seed: result.seed,
    hops: result.hops,
    closure: result.closure.length,
    missingUp: result.missingUp.length,
    missingDown: result.missingDown.length,
  };
  writeFileSync(
    join(outDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("expand-horae-relation-closure.ts")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
