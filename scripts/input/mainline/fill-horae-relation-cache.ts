import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { HoraeSerialGate } from "./collect-one-task-input-pack-sparkindex.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeRelationCache,
  resolveScheduleEvidenceCacheRoot,
  writeHoraeRelationCache,
  type HoraeRelationDirection,
} from "../../evidence/schedule-evidence-cache.ts";
import {
  excludeManualTaskIds,
  readManualTaskIds,
} from "../shared/manual-task-exclusion.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_MAX_ERRORS = 3;
const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_DIRECTION: HoraeRelationDirection = "down";
const DEFAULT_HORAE_TIMEOUT_MS = 90_000;

export type TaskIdOrder = "asc" | "desc";

export function parseTaskIdOrder(value: string | undefined): TaskIdOrder {
  if (value === undefined || value === "asc") return "asc";
  if (value === "desc") return "desc";
  throw new Error("ORDER_INVALID");
}

export function sortTaskIds(
  taskIds: readonly string[],
  order: TaskIdOrder = "asc",
): string[] {
  const direction = order === "desc" ? -1 : 1;
  return [...taskIds].sort(
    (left, right) =>
      direction * left.localeCompare(right, "en-US", { numeric: true }),
  );
}

export type HoraeRelationRunner = (
  taskId: string,
  direction: HoraeRelationDirection,
) => unknown;

export interface FillHoraeRelationCacheOptions {
  readonly cacheRoot?: string;
  readonly taskIds?: readonly string[];
  readonly order?: TaskIdOrder;
  readonly startTaskId?: string;
  readonly limit?: number;
  readonly maxErrors?: number;
  readonly minIntervalMs?: number;
  readonly direction?: HoraeRelationDirection;
  readonly runner?: HoraeRelationRunner;
  readonly gate?: HoraeSerialGate;
  readonly now?: () => Date;
  readonly manualTaskIds?: ReadonlySet<string>;
}

export interface HoraeRelationFillError {
  readonly taskId: string;
  readonly message: string;
}

export interface FillHoraeRelationCacheSummary {
  readonly total: number;
  readonly skipped: number;
  readonly cached: number;
  readonly errors: number;
  readonly maxErrors: number;
  readonly minIntervalMs: number;
  readonly direction: HoraeRelationDirection;
  readonly order: TaskIdOrder;
  readonly startTaskId: string | null;
  readonly failedTaskIds: readonly string[];
  readonly errorDetails: readonly HoraeRelationFillError[];
  readonly stopped: boolean;
}

export function taskIdsFromScheduleEvidenceCache(
  cacheRoot: string,
  order: TaskIdOrder = "asc",
): string[] {
  const tasksRoot = join(resolveScheduleEvidenceCacheRoot(cacheRoot), "tasks");
  if (!existsSync(tasksRoot))
    throw new Error(`CACHE_TASKS_ROOT_MISSING:${tasksRoot}`);
  const taskIds = readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_TASK_ID.test(entry.name))
    .map((entry) => entry.name);
  return sortTaskIds(taskIds, order);
}

/** Load one task id per line; blank lines and `#` comments are ignored. */
export function taskIdsFromFile(
  path: string,
  order: TaskIdOrder = "asc",
): string[] {
  if (!existsSync(path)) throw new Error(`TASK_IDS_FILE_MISSING:${path}`);
  const seen = new Set<string>();
  const taskIds: string[] = [];
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!SAFE_TASK_ID.test(line))
      throw new Error(`TASK_IDS_FILE_INVALID:${line}`);
    if (seen.has(line)) continue;
    seen.add(line);
    taskIds.push(line);
  }
  return sortTaskIds(taskIds, order);
}

/**
 * Collect neighbor task ids from existing one-hop relation cache files.
 * By default returns ids that do not yet have a task directory under the cache.
 */
export function neighborTaskIdsFromRelationCache(
  cacheRoot: string,
  direction: HoraeRelationDirection,
  options: { readonly onlyMissingTaskDirs?: boolean } = {},
): string[] {
  const onlyMissing = options.onlyMissingTaskDirs ?? true;
  const tasksRoot = join(resolveScheduleEvidenceCacheRoot(cacheRoot), "tasks");
  if (!existsSync(tasksRoot))
    throw new Error(`CACHE_TASKS_ROOT_MISSING:${tasksRoot}`);
  const known = new Set(taskIdsFromScheduleEvidenceCache(cacheRoot));
  const neighbors = new Set<string>();
  for (const taskId of known) {
    const cached = readHoraeRelationCache(taskId, cacheRoot, direction);
    if (cached.status !== "HIT") continue;
    for (const row of cached.rows) {
      const neighbor =
        typeof row.task_id === "string"
          ? row.task_id
          : typeof row.taskId === "string"
            ? row.taskId
            : null;
      if (!neighbor || !SAFE_TASK_ID.test(neighbor)) continue;
      if (onlyMissing && known.has(neighbor)) continue;
      neighbors.add(neighbor);
    }
  }
  return [...neighbors].sort((left, right) =>
    left.localeCompare(right, "en-US", { numeric: true }),
  );
}

export interface HoraeRelationClosure {
  readonly seed: number;
  readonly hops: number;
  readonly closure: readonly string[];
  readonly missingUp: readonly string[];
  readonly missingDown: readonly string[];
}

export function neighborIdFromRelationRow(
  row: Record<string, unknown>,
): string | undefined {
  const neighbor =
    typeof row.task_id === "string"
      ? row.task_id.trim()
      : typeof row.taskId === "string"
        ? row.taskId.trim()
        : "";
  return SAFE_TASK_ID.test(neighbor) ? neighbor : undefined;
}

export interface HoraeRelationHopLookup {
  readonly hasEvidence: (
    taskId: string,
    direction: HoraeRelationDirection,
  ) => boolean;
  readonly neighbors: (
    taskId: string,
    direction: HoraeRelationDirection,
  ) => readonly string[];
}

/**
 * BFS over one-hop up/down relations. Missing evidence is recorded, not guessed.
 */
export function expandHoraeRelationClosureFromLookup(options: {
  readonly seedTaskIds: readonly string[];
  readonly lookup: HoraeRelationHopLookup;
  readonly directions?: readonly HoraeRelationDirection[];
}): HoraeRelationClosure {
  const directions = options.directions ?? ["up", "down"];
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const raw of options.seedTaskIds) {
    const taskId = raw.trim();
    if (!SAFE_TASK_ID.test(taskId) || seen.has(taskId)) continue;
    seen.add(taskId);
    queue.push(taskId);
  }
  const missingUp = new Set<string>();
  const missingDown = new Set<string>();
  const seed = seen.size;
  let hops = 0;
  let layerSize = queue.length;
  let index = 0;
  while (index < queue.length) {
    if (layerSize === 0) {
      layerSize = queue.length - index;
      if (layerSize === 0) break;
      hops += 1;
    }
    const taskId = queue[index]!;
    index += 1;
    layerSize -= 1;
    for (const direction of directions) {
      if (!options.lookup.hasEvidence(taskId, direction)) {
        if (direction === "up") missingUp.add(taskId);
        else missingDown.add(taskId);
        continue;
      }
      for (const neighbor of options.lookup.neighbors(taskId, direction)) {
        if (neighbor === taskId || seen.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return {
    seed,
    hops,
    closure: sortTaskIds([...seen]),
    missingUp: sortTaskIds([...missingUp]),
    missingDown: sortTaskIds([...missingDown]),
  };
}

/**
 * File-cache BFS. Prefer expandHoraeRelationClosureFromSqlite for inventory work.
 */
export function expandHoraeRelationClosure(options: {
  readonly cacheRoot: string;
  readonly seedTaskIds: readonly string[];
  readonly directions?: readonly HoraeRelationDirection[];
}): HoraeRelationClosure {
  return expandHoraeRelationClosureFromLookup({
    seedTaskIds: options.seedTaskIds,
    directions: options.directions,
    lookup: {
      hasEvidence: (taskId, direction) =>
        readHoraeRelationCache(taskId, options.cacheRoot, direction).status ===
        "HIT",
      neighbors: (taskId, direction) => {
        const cached = readHoraeRelationCache(
          taskId,
          options.cacheRoot,
          direction,
        );
        if (cached.status !== "HIT") return [];
        const ids: string[] = [];
        for (const row of cached.rows) {
          const neighbor = neighborIdFromRelationRow(row);
          if (neighbor !== undefined) ids.push(neighbor);
        }
        return ids;
      },
    },
  });
}

export function horaeRelationCommandArguments(
  taskId: string,
  direction: HoraeRelationDirection,
): readonly string[] {
  return [
    "horae",
    "relation",
    taskId,
    "--direction",
    direction,
    "--depth",
    "1",
    "-f",
    "json",
  ];
}

export function runHoraeRelation(
  taskId: string,
  direction: HoraeRelationDirection = DEFAULT_DIRECTION,
): unknown {
  if (!SAFE_TASK_ID.test(taskId))
    throw new Error(`HORAE_RELATION_INVALID_TASK:${taskId}`);
  const executable =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : "opencli";
  const executableArgs =
    process.platform === "win32"
      ? [
          "/d",
          "/s",
          "/c",
          "opencli.cmd",
          ...horaeRelationCommandArguments(taskId, direction),
        ]
      : [...horaeRelationCommandArguments(taskId, direction)];
  const timeoutMs = Number.parseInt(
    process.env.INPUT_PACK_HORAE_RELATION_TIMEOUT_MS ?? "",
    10,
  );
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_HORAE_TIMEOUT_MS;
  const output = execFileSync(executable, executableArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      OPENCLI_BROWSER_COMMAND_TIMEOUT: String(
        Math.ceil(effectiveTimeoutMs / 1000),
      ),
    },
    timeout: effectiveTimeoutMs,
  });
  return JSON.parse(output);
}

export function rowsOfHoraeRelation(
  value: unknown,
  taskId: string,
): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.map((row) => {
      if (typeof row !== "object" || row === null || Array.isArray(row))
        throw new Error(`HORAE_RELATION_INVALID_ROWS:${taskId}`);
      const record = row as Record<string, unknown>;
      const rowTask = record.task_id ?? record.taskId;
      if (typeof rowTask !== "string" || !SAFE_TASK_ID.test(rowTask))
        throw new Error(`HORAE_RELATION_INVALID_ROWS:${taskId}`);
      return record;
    });
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`HORAE_RELATION_INVALID_ENVELOPE:${taskId}`);
  const record = value as Record<string, unknown>;
  if (
    record.error !== undefined ||
    record.success === false ||
    ["fail", "failed", "failure", "error"].includes(
      String(record.status ?? "").toLowerCase(),
    )
  )
    throw new Error(`HORAE_RELATION_INVALID_ENVELOPE:${taskId}`);
  for (const field of ["records", "rows", "data", "results"]) {
    if (Array.isArray(record[field]))
      return rowsOfHoraeRelation(record[field], taskId);
  }
  throw new Error(`HORAE_RELATION_INVALID_ENVELOPE:${taskId}`);
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

function parseDirection(value: string | undefined): HoraeRelationDirection {
  if (value === undefined) return DEFAULT_DIRECTION;
  if (value === "up" || value === "down") return value;
  throw new Error("DIRECTION_INVALID");
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
  if (limit === undefined) return [...taskIds];
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("LIMIT_INVALID");
  return taskIds.slice(0, limit);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fill one-hop Horae relation cache files serially.
 * Existing HIT artifacts are skipped; resume with --start-task-id.
 */
export async function fillHoraeRelationCache(
  options: FillHoraeRelationCacheOptions = {},
): Promise<FillHoraeRelationCacheSummary> {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const direction = options.direction ?? DEFAULT_DIRECTION;
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
  const gate = options.gate ?? new HoraeSerialGate({ minIntervalMs });
  const runner = options.runner ?? runHoraeRelation;
  const now = options.now ?? (() => new Date());
  let skipped = 0;
  let cached = 0;
  let errors = 0;
  let stopped = false;
  const failedTaskIds: string[] = [];
  const errorDetails: HoraeRelationFillError[] = [];

  for (const taskId of taskIds) {
    const existing = readHoraeRelationCache(taskId, cacheRoot, direction);
    if (existing.status === "HIT") {
      skipped += 1;
      continue;
    }
    try {
      gate.beforeCall();
      const response = await Promise.resolve(runner(taskId, direction));
      const rows = rowsOfHoraeRelation(response, taskId);
      writeHoraeRelationCache(
        taskId,
        now().toISOString(),
        rows,
        cacheRoot,
        direction,
      );
      cached += 1;
    } catch (error) {
      errors += 1;
      failedTaskIds.push(taskId);
      errorDetails.push({ taskId, message: errorMessage(error) });
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
    direction,
    order,
    startTaskId: options.startTaskId ?? null,
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
  const cacheRoot =
    option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const direction = parseDirection(option("--direction"));
  const order = parseTaskIdOrder(option("--order"));
  const startTaskId = option("--start-task-id");
  const maxErrors = parseIntegerOption("--max-errors", undefined, false);
  const minIntervalMs = parseIntegerOption("--interval-ms", undefined, true);
  const taskIdsFile = option("--task-ids-file");
  const taskIds = taskIdsFile ? taskIdsFromFile(taskIdsFile, order) : undefined;
  const manualTaskIds = readManualTaskIds(
    cacheRoot,
    option("--manual-task-ids-file") ?? undefined,
  );
  process.stderr.write(
    `[horae-relation-cache] start ${JSON.stringify({
      cacheRoot,
      direction,
      order,
      startTaskId: startTaskId ?? null,
      taskIdsFile: taskIdsFile ?? null,
      taskIds: taskIds?.length ?? null,
      maxErrors: maxErrors ?? DEFAULT_MAX_ERRORS,
      minIntervalMs: minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    })}\n`,
  );
  const summary = await fillHoraeRelationCache({
    cacheRoot,
    direction,
    order,
    startTaskId,
    taskIds,
    manualTaskIds,
    limit: parseIntegerOption("--limit", undefined, false),
    maxErrors,
    minIntervalMs,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.errors > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("fill-horae-relation-cache.ts")) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
