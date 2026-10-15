import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  DEFAULT_SZDATA_SCHEDULE_DETAIL_MIN_INTERVAL_MS,
  normalizeSzdataScheduleDetail,
  readSzdataScheduleDetailCache,
  runSzdataScheduleDetail,
  ScheduleDetailSerialGate,
  writeSzdataScheduleDetailCache,
  type ScheduleDetailRunner,
} from "./szdata-schedule-detail-cache.ts";
import {
  parseTaskIdOrder,
  sortTaskIds,
  taskIdsFromFile,
  type TaskIdOrder,
} from "./fill-horae-relation-cache.ts";
import { resolveScheduleEvidenceCacheRoot } from "../../evidence/schedule-evidence-cache.ts";
import {
  excludeManualTaskIds,
  readManualTaskIds,
} from "../shared/manual-task-exclusion.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_MAX_ERRORS = 3;

export interface FillSzdataScheduleDetailOptions {
  readonly cacheRoot?: string;
  readonly taskIds?: readonly string[];
  readonly order?: TaskIdOrder;
  readonly startTaskId?: string;
  readonly limit?: number;
  readonly maxErrors?: number;
  readonly minIntervalMs?: number;
  readonly runner?: ScheduleDetailRunner;
  readonly gate?: ScheduleDetailSerialGate;
  readonly now?: () => Date;
  readonly manualTaskIds?: ReadonlySet<string>;
}

export interface SzdataScheduleDetailFillError {
  readonly taskId: string;
  readonly message: string;
}

export interface FillSzdataScheduleDetailSummary {
  readonly total: number;
  readonly skipped: number;
  readonly cached: number;
  readonly errors: number;
  readonly maxErrors: number;
  readonly minIntervalMs: number;
  readonly order: TaskIdOrder;
  readonly failedTaskIds: readonly string[];
  readonly errorDetails: readonly SzdataScheduleDetailFillError[];
  readonly stopped: boolean;
}

export function taskIdsFromScheduleEvidenceCache(cacheRoot: string): string[] {
  const tasksRoot = join(resolveScheduleEvidenceCacheRoot(cacheRoot), "tasks");
  if (!existsSync(tasksRoot))
    throw new Error(`CACHE_TASKS_ROOT_MISSING:${tasksRoot}`);
  const taskIds = readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_TASK_ID.test(entry.name))
    .map((entry) => entry.name);
  return sortTaskIds(taskIds);
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

function fromStartTaskId(
  taskIds: readonly string[],
  startTaskId: string | undefined,
  order: TaskIdOrder,
): string[] {
  if (startTaskId === undefined) return [...taskIds];
  if (!SAFE_TASK_ID.test(startTaskId)) throw new Error("START_TASK_ID_INVALID");
  const index = taskIds.findIndex((taskId) => {
    const comparison = taskId.localeCompare(startTaskId, "en-US", {
      numeric: true,
    });
    return order === "desc" ? comparison <= 0 : comparison >= 0;
  });
  return index < 0 ? [] : taskIds.slice(index);
}

function selectedTaskIds(
  taskIds: readonly string[],
  limit: number | undefined,
): string[] {
  const selected = [...taskIds];
  if (limit === undefined) return selected;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("LIMIT_INVALID");
  return selected.slice(0, limit);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fill the independent SZData/Portal schedule-detail artifact serially.
 * The runner is awaited before the next task starts, and a successful task is
 * written before the loop advances to the next one.
 */
export async function fillSzdataScheduleDetailCache(
  options: FillSzdataScheduleDetailOptions = {},
): Promise<FillSzdataScheduleDetailSummary> {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const order = options.order ?? "asc";
  const maxErrors = positiveInteger(
    options.maxErrors,
    DEFAULT_MAX_ERRORS,
    "MAX_ERRORS_INVALID",
  );
  const minIntervalMs = nonNegativeInteger(
    options.minIntervalMs,
    DEFAULT_SZDATA_SCHEDULE_DETAIL_MIN_INTERVAL_MS,
    "SZDATA_SCHEDULE_DETAIL_MIN_INTERVAL_INVALID",
  );
  const taskIds = selectedTaskIds(
    fromStartTaskId(
      sortTaskIds(
        excludeManualTaskIds(
          options.taskIds ?? taskIdsFromScheduleEvidenceCache(cacheRoot),
          options.manualTaskIds ?? readManualTaskIds(cacheRoot),
        ),
        order,
      ),
      options.startTaskId,
      order,
    ),
    options.limit,
  );
  const gate = options.gate ?? new ScheduleDetailSerialGate({ minIntervalMs });
  const runner = options.runner ?? runSzdataScheduleDetail;
  const now = options.now ?? (() => new Date());
  let skipped = 0;
  let cached = 0;
  let errors = 0;
  let stopped = false;
  const failedTaskIds: string[] = [];
  const errorDetails: SzdataScheduleDetailFillError[] = [];

  for (const taskId of taskIds) {
    const existing = readSzdataScheduleDetailCache(taskId, cacheRoot);
    if (existing.status === "HIT") {
      skipped += 1;
      continue;
    }
    try {
      gate.beforeCall();
      const response = await Promise.resolve(runner(taskId));
      const detail = normalizeSzdataScheduleDetail(response, taskId);
      writeSzdataScheduleDetailCache(
        taskId,
        now().toISOString(),
        detail,
        cacheRoot,
      );
      cached += 1;
    } catch (error) {
      errors += 1;
      failedTaskIds.push(taskId);
      errorDetails.push({ taskId, message: errorMessage(error) });
      // Keep the original error text. In particular, 403/429/auth/rate-limit
      // failures are upstream signals, not NOT_FOUND and not empty evidence.
      if (errors >= maxErrors) {
        stopped = true;
        break;
      }
    }
  }

  return {
    total: taskIds.length,
    skipped,
    cached,
    errors,
    maxErrors,
    minIntervalMs,
    order,
    failedTaskIds,
    errorDetails,
    stopped,
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function parseIntegerOption(
  name: string,
  fallback: number | undefined,
  allowZero: boolean,
): number | undefined {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1))
    throw new Error(
      `${name.slice(2).toUpperCase().replaceAll("-", "_")}_INVALID`,
    );
  return value;
}

async function main(): Promise<void> {
  const taskIdsFile = option("--task-ids-file");
  const order = parseTaskIdOrder(option("--order"));
  const cacheRoot = option("--cache-root");
  const summary = await fillSzdataScheduleDetailCache({
    cacheRoot,
    order,
    startTaskId: option("--start-task-id"),
    taskIds: taskIdsFile ? taskIdsFromFile(taskIdsFile, order) : undefined,
    manualTaskIds: readManualTaskIds(
      cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
      option("--manual-task-ids-file") ?? undefined,
    ),
    limit: parseIntegerOption("--limit", undefined, false),
    maxErrors: parseIntegerOption("--max-errors", undefined, false),
    minIntervalMs: parseIntegerOption("--interval-ms", undefined, true),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.errors > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("fill-szdata-schedule-detail-cache.ts")) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
