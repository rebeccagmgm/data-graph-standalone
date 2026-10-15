import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HoraeSerialGate } from "./collect-one-task-input-pack-sparkindex.ts";
import {
  taskIdsFromFile,
  taskIdsFromScheduleEvidenceCache,
} from "./fill-horae-relation-cache.ts";
import {
  DEFAULT_RUN_SCRIPT_LOG_DATE,
  extractRunScriptSqlFromLog,
  parseRunScriptSqlCache,
  runScriptLogCachePath,
  writeRunScriptSqlCache,
} from "./run-script-sql-cache.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeTaskTypeCache,
} from "../../evidence/schedule-evidence-cache.ts";
import {
  excludeManualTaskIds,
  readManualTaskIds,
} from "../shared/manual-task-exclusion.ts";

/** Task types whose SQL evidence is extracted from Horae execution logs. */
export const SCRIPT_SQL_FROM_LOG_TASK_TYPES = new Set([
  "runScript",
  "runScript-2.0",
  "sparkScript",
]);
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DATA_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_ERRORS = 0;
const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_HORAE_LOG_TIMEOUT_MS = 120_000;

export type RunScriptLogRunner = (
  taskId: string,
  dataDate: string,
) => string | Promise<string>;

export interface FillRunScriptSqlCacheOptions {
  readonly cacheRoot?: string;
  readonly taskIds?: readonly string[];
  readonly startTaskId?: string;
  readonly limit?: number;
  readonly dataDate?: string;
  readonly maxErrors?: number;
  readonly minIntervalMs?: number;
  readonly logRunner?: RunScriptLogRunner;
  readonly gate?: HoraeSerialGate;
  readonly now?: () => Date;
  /** Retry only an existing UNAVAILABLE cache; AVAILABLE evidence is immutable. */
  readonly force?: boolean;
  readonly manualTaskIds?: ReadonlySet<string>;
}

export interface FillRunScriptSqlCacheSummary {
  readonly total: number;
  readonly skipped: number;
  readonly cached: number;
  readonly empty: number;
  readonly errors: number;
  readonly maxErrors: number;
  readonly minIntervalMs: number;
  readonly dataDate: string;
  readonly startTaskId: string | null;
  readonly failedTaskIds: readonly string[];
  readonly stopped: boolean;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? null : trimmed;
}

export function runScriptIdsFromHoraeTypeCache(cacheRoot: string): string[] {
  return taskIdsFromScheduleEvidenceCache(cacheRoot).filter((taskId) => {
    const cached = readHoraeTaskTypeCache(taskId, cacheRoot);
    return (
      cached.status === "HIT" &&
      typeof cached.detail.taskType === "string" &&
      SCRIPT_SQL_FROM_LOG_TASK_TYPES.has(cached.detail.taskType)
    );
  });
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
): string[] {
  if (startTaskId === undefined) return [...taskIds];
  if (!SAFE_TASK_ID.test(startTaskId)) throw new Error("START_TASK_ID_INVALID");
  const index = taskIds.findIndex(
    (taskId) =>
      taskId.localeCompare(startTaskId, "en-US", { numeric: true }) >= 0,
  );
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

export function isHoraeLogInstanceMissing(error: unknown): boolean {
  const parts = [errorMessage(error)];
  if (error !== null && typeof error === "object") {
    const record = error as { stdout?: unknown; stderr?: unknown };
    if (typeof record.stdout === "string") parts.push(record.stdout);
    if (typeof record.stderr === "string") parts.push(record.stderr);
  }
  return /HORAE_LOG_INSTANCE_MISSING(?:[:\s]|$)/.test(parts.join("\n"));
}

function shouldStop(errors: number, maxErrors: number): boolean {
  return maxErrors > 0 && errors >= maxErrors;
}

export function horaeLogCommandArguments(
  taskId: string,
  dataDate: string,
  saveTo: string,
): readonly string[] {
  return [
    "horae",
    "log",
    taskId,
    "--data-date",
    dataDate,
    "--save-to",
    saveTo,
    "-f",
    "json",
  ];
}

export function runHoraeLog(
  taskId: string,
  dataDate: string,
  saveTo: string,
): string {
  if (!SAFE_TASK_ID.test(taskId))
    throw new Error(`RUN_SCRIPT_LOG_INVALID_TASK:${taskId}`);
  if (!DATA_DATE.test(dataDate))
    throw new Error(`RUN_SCRIPT_LOG_DATE_INVALID:${dataDate}`);
  const timeoutMs = Number.parseInt(
    process.env.INPUT_PACK_HORAE_LOG_TIMEOUT_MS ?? "",
    10,
  );
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_HORAE_LOG_TIMEOUT_MS;
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
          ...horaeLogCommandArguments(taskId, dataDate, saveTo),
        ]
      : [...horaeLogCommandArguments(taskId, dataDate, saveTo)];
  execFileSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: effectiveTimeoutMs,
    // Keep opencli "Extension update available" off our terminal.
    stdio: ["ignore", "pipe", "pipe"],
  });
  const expected = join(
    saveTo,
    `${taskId}_${dataDate.replaceAll("-", "")}.log`,
  );
  if (!existsSync(expected))
    throw new Error(`RUN_SCRIPT_LOG_MISSING:${taskId}:${dataDate}`);
  return readFileSync(expected, "utf8");
}

export async function fillRunScriptSqlCache(
  options: FillRunScriptSqlCacheOptions = {},
): Promise<FillRunScriptSqlCacheSummary> {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const dataDate = options.dataDate ?? DEFAULT_RUN_SCRIPT_LOG_DATE;
  if (!DATA_DATE.test(dataDate))
    throw new Error(`RUN_SCRIPT_LOG_DATE_INVALID:${dataDate}`);
  const maxErrors = nonNegativeInteger(
    options.maxErrors,
    DEFAULT_MAX_ERRORS,
    "MAX_ERRORS_INVALID",
  );
  const minIntervalMs = nonNegativeInteger(
    options.minIntervalMs,
    DEFAULT_MIN_INTERVAL_MS,
    "RUN_SCRIPT_SQL_MIN_INTERVAL_INVALID",
  );
  const taskIds = selectedTaskIds(
    fromStartTaskId(
      excludeManualTaskIds(
        options.taskIds ?? runScriptIdsFromHoraeTypeCache(cacheRoot),
        options.manualTaskIds ?? readManualTaskIds(cacheRoot),
      ),
      options.startTaskId,
    ),
    options.limit,
  );
  const gate = options.gate ?? new HoraeSerialGate({ minIntervalMs });
  const logRunner =
    options.logRunner ??
    ((taskId, dataDate) =>
      runHoraeLog(
        taskId,
        dataDate,
        dirname(runScriptLogCachePath(taskId, dataDate, cacheRoot)),
      ));
  const now = options.now ?? (() => new Date());
  let skipped = 0;
  let cached = 0;
  let empty = 0;
  let errors = 0;
  let stopped = false;
  const failedTaskIds: string[] = [];

  for (const taskId of taskIds) {
    const existing = parseRunScriptSqlCache(taskId, cacheRoot);
    if (
      existing.status === "HIT" &&
      (!options.force || existing.sqlStatus === "AVAILABLE")
    ) {
      skipped += 1;
      continue;
    }
    const typeCache = readHoraeTaskTypeCache(taskId, cacheRoot);
    const hiveDb =
      typeCache.status === "HIT" ? optionalText(typeCache.detail.hiveDb) : null;
    const configuredPath =
      typeCache.status === "HIT"
        ? (optionalText(typeCache.detail.scriptPath) ??
          optionalText(typeCache.detail.fileName))
        : null;
    try {
      const logPath = runScriptLogCachePath(taskId, dataDate, cacheRoot);
      let logText: string;
      if (existsSync(logPath)) {
        logText = readFileSync(logPath, "utf8");
      } else {
        gate.beforeCall();
        logText = await Promise.resolve(logRunner(taskId, dataDate));
        mkdirSync(dirname(logPath), { recursive: true });
        if (!existsSync(logPath)) writeFileSync(logPath, logText, "utf8");
      }
      const extracted = extractRunScriptSqlFromLog(logText);
      const available = extracted.querySql !== null;
      writeRunScriptSqlCache(
        taskId,
        now().toISOString(),
        {
          source: "HORAE_LOG",
          sqlStatus: available ? "AVAILABLE" : "UNAVAILABLE",
          hiveDb,
          dataDate,
          querySql: extracted.querySql,
          sqlFile: extracted.sqlFile,
          scriptPath: extracted.scriptPath ?? configuredPath,
        },
        cacheRoot,
        { overwrite: existing.status === "HIT" },
      );
      if (available) cached += 1;
      else empty += 1;
    } catch (error) {
      if (isHoraeLogInstanceMissing(error)) {
        writeRunScriptSqlCache(
          taskId,
          now().toISOString(),
          {
            source: "HORAE_LOG",
            sqlStatus: "UNAVAILABLE",
            hiveDb,
            dataDate,
            querySql: null,
            sqlFile: null,
            scriptPath: configuredPath,
          },
          cacheRoot,
          { overwrite: existing.status === "HIT" },
        );
        empty += 1;
        process.stderr.write(
          `[run-script-sql-cache] ${taskId} HORAE_LOG_INSTANCE_MISSING:${dataDate}\n`,
        );
        continue;
      }
      errors += 1;
      failedTaskIds.push(taskId);
      process.stderr.write(
        `[run-script-sql-cache] ${taskId} ${errorMessage(error)}\n`,
      );
      if (shouldStop(errors, maxErrors)) {
        stopped = true;
        break;
      }
    }
  }

  return {
    total: taskIds.length,
    skipped,
    cached,
    empty,
    errors,
    maxErrors,
    minIntervalMs,
    dataDate,
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
  const dataDate = option("--data-date") ?? DEFAULT_RUN_SCRIPT_LOG_DATE;
  const startTaskId = option("--start-task-id");
  const taskIdsFile = option("--task-ids-file");
  const taskIds = taskIdsFile ? taskIdsFromFile(taskIdsFile) : undefined;
  const manualTaskIds = readManualTaskIds(
    cacheRoot,
    option("--manual-task-ids-file") ?? undefined,
  );
  process.stderr.write(
    `[run-script-sql-cache] start ${JSON.stringify({
      cacheRoot,
      dataDate,
      startTaskId: startTaskId ?? null,
      taskIdsFile: taskIdsFile ?? null,
      taskIds: taskIds?.length ?? null,
    })}\n`,
  );
  const summary = await fillRunScriptSqlCache({
    cacheRoot,
    dataDate,
    startTaskId,
    taskIds,
    manualTaskIds,
    limit: parseIntegerOption("--limit", undefined, false),
    maxErrors: parseIntegerOption("--max-errors", undefined, true),
    minIntervalMs: parseIntegerOption("--interval-ms", undefined, true),
    force: process.argv.includes("--force"),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.errors > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("fill-run-script-sql-cache.ts")) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
