import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  HoraeSerialGate,
  runHoraeDetail,
} from "./collect-one-task-input-pack-sparkindex.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeTaskTypeCache,
  resolveScheduleEvidenceCacheRoot,
  writeHoraeTaskTypeCache,
} from "../../evidence/schedule-evidence-cache.ts";
import { taskIdsFromFile } from "./fill-horae-relation-cache.ts";
import {
  excludeManualTaskIds,
  readManualTaskIds,
} from "../shared/manual-task-exclusion.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_MAX_ERRORS = 3;
const DEFAULT_MIN_INTERVAL_MS = 2_000;

export interface FillHoraeTaskDetailCacheOptions {
  readonly cacheRoot?: string;
  readonly taskIds?: readonly string[];
  readonly maxErrors?: number;
  readonly minIntervalMs?: number;
  /** When true, rewrite HIT caches instead of skipping them. */
  readonly force?: boolean;
  readonly manualTaskIds?: ReadonlySet<string>;
  readonly gate?: HoraeSerialGate;
  readonly runner?: (taskId: string) => unknown;
  readonly now?: () => Date;
}

export interface FillHoraeTaskDetailCacheSummary {
  readonly total: number;
  readonly skipped: number;
  readonly cached: number;
  readonly errors: number;
  readonly maxErrors: number;
  readonly failedTaskIds: readonly string[];
  readonly stopped: boolean;
}

function taskIdsFromCache(cacheRoot: string): string[] {
  const tasksRoot = join(resolveScheduleEvidenceCacheRoot(cacheRoot), "tasks");
  if (!existsSync(tasksRoot))
    throw new Error(`CACHE_TASKS_ROOT_MISSING:${tasksRoot}`);
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_TASK_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) =>
      left.localeCompare(right, "en-US", { numeric: true }),
    );
}

function detailOfHorae(
  value: unknown,
  taskId: string,
): Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new Error(`HORAE_TASK_DETAIL_INVALID:${taskId}`);
  return row as Record<string, unknown>;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("MAX_ERRORS_INVALID");
  return parsed;
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("HORAE_DETAIL_MIN_INTERVAL_INVALID");
  return parsed;
}

function boundedTaskIds(taskIds: readonly string[]): string[] {
  const rawLimit = option("--limit");
  if (rawLimit === undefined) return [...taskIds];
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("LIMIT_INVALID");
  return taskIds.slice(0, limit);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fillHoraeTaskDetailCache(
  options: FillHoraeTaskDetailCacheOptions = {},
): Promise<FillHoraeTaskDetailCacheSummary> {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const maxErrors = options.maxErrors ?? DEFAULT_MAX_ERRORS;
  if (!Number.isSafeInteger(maxErrors) || maxErrors < 1)
    throw new Error("MAX_ERRORS_INVALID");
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0)
    throw new Error("HORAE_DETAIL_MIN_INTERVAL_INVALID");
  const taskIds = excludeManualTaskIds(
    options.taskIds ?? taskIdsFromCache(cacheRoot),
    options.manualTaskIds ?? readManualTaskIds(cacheRoot),
  );
  const force = options.force === true;
  const gate = options.gate ?? new HoraeSerialGate({ minIntervalMs });
  const runner = options.runner ?? runHoraeDetail;
  const now = options.now ?? (() => new Date());
  let skipped = 0;
  let cached = 0;
  let errors = 0;
  let stopped = false;
  const failedTaskIds: string[] = [];

  for (const [index, taskId] of taskIds.entries()) {
    const existing = readHoraeTaskTypeCache(taskId, cacheRoot);
    if (!force && existing.status === "HIT") {
      skipped += 1;
      continue;
    }
    try {
      gate.beforeCall();
      const response = await Promise.resolve(runner(taskId));
      const detail = detailOfHorae(response, taskId);
      writeHoraeTaskTypeCache(taskId, now().toISOString(), detail, cacheRoot);
      cached += 1;
    } catch (error) {
      errors += 1;
      failedTaskIds.push(taskId);
      process.stderr.write(
        `[horae-task-detail-cache] error ${JSON.stringify({
          taskId,
          errors,
          message: errorMessage(error),
        })}\n`,
      );
      if (errors >= maxErrors) {
        stopped = true;
        process.stderr.write(
          `[horae-task-detail-cache] stopped ${JSON.stringify({
            index: index + 1,
            total: taskIds.length,
            skipped,
            cached,
            errors,
            maxErrors,
          })}\n`,
        );
        break;
      }
    }
    if ((index + 1) % 25 === 0)
      process.stderr.write(
        `[horae-task-detail-cache] progress ${JSON.stringify({
          processed: index + 1,
          total: taskIds.length,
          skipped,
          cached,
          errors,
        })}\n`,
      );
  }

  return {
    total: taskIds.length,
    skipped,
    cached,
    errors,
    maxErrors,
    failedTaskIds,
    stopped,
  };
}

async function main(): Promise<void> {
  const cacheRoot =
    option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const maxErrors = positiveInteger(option("--max-errors"), DEFAULT_MAX_ERRORS);
  const minIntervalMs = nonNegativeInteger(
    option("--interval-ms"),
    DEFAULT_MIN_INTERVAL_MS,
  );
  const force = process.argv.includes("--force");
  const taskIdsFile = option("--task-ids-file");
  const manualTaskIds = readManualTaskIds(
    cacheRoot,
    option("--manual-task-ids-file") ?? undefined,
  );
  const taskIds = boundedTaskIds(
    taskIdsFile ? taskIdsFromFile(taskIdsFile) : taskIdsFromCache(cacheRoot),
  );
  process.stderr.write(
    `[horae-task-detail-cache] start ${JSON.stringify({
      total: taskIds.length,
      cacheRoot,
      taskIdsFile: taskIdsFile ?? null,
      maxErrors,
      minIntervalMs,
      force,
    })}\n`,
  );
  const summary = await fillHoraeTaskDetailCache({
    cacheRoot,
    taskIds,
    maxErrors,
    minIntervalMs,
    force,
    manualTaskIds,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.stopped) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("fill-horae-task-detail-cache.ts")) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
