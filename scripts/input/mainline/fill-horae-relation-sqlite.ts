import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  sha256,
} from "../../machine-facts/machine-facts-contract.ts";
import { HoraeSerialGate } from "./collect-one-task-input-pack-sparkindex.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  resolveScheduleEvidenceCacheRoot,
  SCHEDULE_EVIDENCE_CACHE_ARTIFACT_TYPE,
  SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION,
} from "../../evidence/schedule-evidence-cache.ts";
import {
  readManualTaskIds,
  excludeManualTaskIds,
} from "../shared/manual-task-exclusion.ts";
import {
  openScheduleEvidenceDatabase,
  upsertSqliteJsonEvidence,
} from "../shared/sqlite-evidence-store.ts";
import {
  rowsOfHoraeRelation,
  sortTaskIds,
  taskIdsFromFile,
  taskIdsFromScheduleEvidenceCache,
  runHoraeRelation,
  type HoraeRelationRunner,
  type TaskIdOrder,
} from "./fill-horae-relation-cache.ts";

type Direction = "up" | "down" | "both";

const DEFAULT_MAX_ERRORS = 10;
const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_DEPTH = 1;

export interface FillHoraeRelationSqliteOptions {
  readonly cacheRoot?: string;
  readonly databasePath?: string;
  readonly taskIds?: readonly string[];
  readonly direction?: Direction;
  readonly order?: TaskIdOrder;
  readonly startTaskId?: string;
  readonly maxErrors?: number;
  readonly minIntervalMs?: number;
  readonly runner?: HoraeRelationRunner;
  readonly gate?: HoraeSerialGate;
  readonly database?: DatabaseSync;
}

export interface FillHoraeRelationSqliteSummary {
  readonly totalTasks: number;
  readonly totalRequests: number;
  readonly skipped: number;
  readonly cached: number;
  readonly errors: number;
  readonly maxErrors: number;
  readonly minIntervalMs: number;
  readonly direction: Direction;
  readonly order: TaskIdOrder;
  readonly startTaskId: string | null;
  readonly failedTaskIds: readonly string[];
  readonly stopped: boolean;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  code: string,
): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < 1) throw new Error(code);
  return effective;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  code: string,
): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < 0) throw new Error(code);
  return effective;
}

function taskIdsFromStart(
  taskIds: readonly string[],
  startTaskId: string | undefined,
  order: TaskIdOrder,
): string[] {
  if (startTaskId === undefined) return [...taskIds];
  const index = taskIds.findIndex((taskId) => {
    const comparison = taskId.localeCompare(startTaskId, "en-US", {
      numeric: true,
    });
    return order === "desc" ? comparison <= 0 : comparison >= 0;
  });
  return index < 0 ? [] : taskIds.slice(index);
}

function directions(value: Direction): readonly ("up" | "down")[] {
  return value === "both" ? ["up", "down"] : [value];
}

function relationDocument(
  taskId: string,
  direction: "up" | "down",
  observedAt: string,
  rows: readonly Record<string, unknown>[],
): { readonly contentSha256: string; readonly payloadJson: string } {
  const payload = {
    schema_version: SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION,
    artifact_type: SCHEDULE_EVIDENCE_CACHE_ARTIFACT_TYPE,
    task_id: taskId,
    direction,
    depth: DEFAULT_DEPTH,
    observed_at: observedAt,
    rows,
  };
  const contentSha256 = sha256(canonicalJson(payload));
  return {
    contentSha256,
    payloadJson: JSON.stringify({ ...payload, content_sha256: contentSha256 }),
  };
}

export async function fillHoraeRelationSqlite(
  options: FillHoraeRelationSqliteOptions = {},
): Promise<FillHoraeRelationSqliteSummary> {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const direction = options.direction ?? "both";
  const order = options.order ?? "asc";
  const maxErrors = positiveInteger(
    options.maxErrors,
    DEFAULT_MAX_ERRORS,
    "MAX_ERRORS_INVALID",
  );
  const minIntervalMs = nonNegativeInteger(
    options.minIntervalMs,
    DEFAULT_MIN_INTERVAL_MS,
    "HORAE_RELATION_MIN_INTERVAL_INVALID",
  );
  const manualTaskIds = readManualTaskIds(cacheRoot);
  const sourceTaskIds =
    options.taskIds ?? taskIdsFromScheduleEvidenceCache(cacheRoot, order);
  const taskIds = taskIdsFromStart(
    sortTaskIds(excludeManualTaskIds(sourceTaskIds, manualTaskIds), order),
    options.startTaskId,
    order,
  );
  const database =
    options.database ??
    openScheduleEvidenceDatabase(
      options.databasePath ??
        `${resolveScheduleEvidenceCacheRoot(cacheRoot)}\\tasks-sqlite\\schedule-evidence.sqlite`,
    );
  const ownsDatabase = options.database === undefined;
  const gate = options.gate ?? new HoraeSerialGate({ minIntervalMs });
  const runner = options.runner ?? runHoraeRelation;
  let skipped = 0;
  let cached = 0;
  let errors = 0;
  let stopped = false;
  const failedTaskIds: string[] = [];
  const evidenceExists = database.prepare(
    `SELECT 1 FROM evidence
     WHERE task_id = ? AND evidence_type = ? AND direction = ? AND depth = ?`,
  );

  try {
    for (const taskId of taskIds) {
      for (const currentDirection of directions(direction)) {
        const exists = evidenceExists.get(
          taskId,
          `horae-relation-${currentDirection}-depth-1`,
          currentDirection,
          DEFAULT_DEPTH,
        );
        if (exists !== undefined) {
          skipped += 1;
          continue;
        }
        try {
          gate.beforeCall();
          const rows = rowsOfHoraeRelation(
            await Promise.resolve(runner(taskId, currentDirection)),
            taskId,
          );
          const observedAt = new Date().toISOString();
          const document = relationDocument(
            taskId,
            currentDirection,
            observedAt,
            rows,
          );
          upsertSqliteJsonEvidence(database, {
            taskId,
            evidenceType: `horae-relation-${currentDirection}-depth-1`,
            direction: currentDirection,
            depth: DEFAULT_DEPTH,
            observedAt,
            contentSha256: document.contentSha256,
            payloadJson: document.payloadJson,
            sourcePath: `horae-api:/Hive/downstream/getById?direction=${currentDirection}&depth=1`,
          });
          cached += 1;
        } catch (error) {
          errors += 1;
          failedTaskIds.push(taskId);
          if (errors >= maxErrors) {
            stopped = true;
            break;
          }
        }
      }
      if (stopped) break;
    }
  } finally {
    if (ownsDatabase) database.close();
  }

  return {
    totalTasks: taskIds.length,
    totalRequests: taskIds.length * directions(direction).length,
    skipped,
    cached,
    errors,
    maxErrors,
    minIntervalMs,
    direction,
    order,
    startTaskId: options.startTaskId ?? null,
    failedTaskIds,
    stopped,
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function parseDirection(value: string | undefined): Direction {
  if (
    value === undefined ||
    value === "both" ||
    value === "up" ||
    value === "down"
  ) {
    return value ?? "both";
  }
  throw new Error("DIRECTION_INVALID");
}

function parseOrder(value: string | undefined): TaskIdOrder {
  if (value === undefined || value === "asc") return "asc";
  if (value === "desc") return "desc";
  throw new Error("ORDER_INVALID");
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  allowZero = false,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed < 1)) {
    throw new Error("INTEGER_OPTION_INVALID");
  }
  return parsed;
}

async function main(): Promise<void> {
  const cacheRoot =
    option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const taskIdsFile = option("--task-ids-file");
  const order = parseOrder(option("--order"));
  const summary = await fillHoraeRelationSqlite({
    cacheRoot,
    databasePath: option("--database-path"),
    taskIds: taskIdsFile ? taskIdsFromFile(taskIdsFile, order) : undefined,
    direction: parseDirection(option("--direction")),
    order,
    startTaskId: option("--start-task-id"),
    maxErrors: parseInteger(option("--max-errors"), DEFAULT_MAX_ERRORS),
    minIntervalMs: parseInteger(
      option("--interval-ms"),
      DEFAULT_MIN_INTERVAL_MS,
      true,
    ),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.errors > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("fill-horae-relation-sqlite.ts")) {
  await main();
}
