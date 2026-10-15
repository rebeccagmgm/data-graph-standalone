import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { HoraeSerialGate } from "./collect-one-task-input-pack-sparkindex.ts";
import {
  taskIdsFromFile,
  taskIdsFromScheduleEvidenceCache,
} from "./fill-horae-relation-cache.ts";
import {
  runHoraeLog,
  isHoraeLogInstanceMissing,
} from "./fill-run-script-sql-cache.ts";
import {
  DEFAULT_RUN_SCRIPT_LOG_DATE,
  runScriptLogCachePath,
} from "./run-script-sql-cache.ts";
import {
  extractHiveDdlFromHoraeLog,
  parseHiveDdlFromLogCache,
  writeHiveDdlFromLogCache,
  type HiveDdlFromLogEvidence,
} from "./hive-ddl-from-log-cache.ts";
import {
  inventoryPartialGapsFromSummaries,
  type PartialGapBucket,
} from "../shared/partial-gap-from-summaries.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeTaskTypeCache,
} from "../../evidence/schedule-evidence-cache.ts";
import {
  excludeManualTaskIds,
  readManualTaskIds,
} from "../shared/manual-task-exclusion.ts";

/** Sync-to-Hive types that emit `Process hive ddl:` in Horae AnyLoader logs. */
export const HIVE_DDL_FROM_LOG_TASK_TYPES = new Set([
  "oracle2hive",
  "mysql2hive",
  "postgre2hive",
  "oceanbase2hive",
  "sqlserver2hive",
  "db2hive",
  "teradata2hive",
  "greenplum2hive",
  "postgres2hive",
]);

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DATA_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_ERRORS = 0;
const DEFAULT_MIN_INTERVAL_MS = 2_000;

export type HiveDdlLogRunner = (
  taskId: string,
  dataDate: string,
) => string | Promise<string>;

export interface FillHiveDdlFromLogCacheOptions {
  readonly cacheRoot?: string;
  readonly taskIds?: readonly string[];
  readonly startTaskId?: string;
  readonly limit?: number;
  readonly dataDate?: string;
  readonly maxErrors?: number;
  readonly minIntervalMs?: number;
  readonly force?: boolean;
  readonly manualTaskIds?: ReadonlySet<string>;
  readonly logRunner?: HiveDdlLogRunner;
  readonly gate?: HoraeSerialGate;
  readonly now?: () => Date;
}

export interface FillHiveDdlFromLogCacheSummary {
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

export function toHiveSyncIdsFromHoraeTypeCache(cacheRoot: string): string[] {
  return taskIdsFromScheduleEvidenceCache(cacheRoot).filter((taskId) => {
    const cached = readHoraeTaskTypeCache(taskId, cacheRoot);
    return (
      cached.status === "HIT" &&
      typeof cached.detail.taskType === "string" &&
      HIVE_DDL_FROM_LOG_TASK_TYPES.has(cached.detail.taskType)
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

function shouldStop(errors: number, maxErrors: number): boolean {
  return maxErrors > 0 && errors >= maxErrors;
}

function defaultLogRunner(cacheRoot: string): HiveDdlLogRunner {
  return (taskId, dataDate) => {
    const logPath = runScriptLogCachePath(taskId, dataDate, cacheRoot);
    if (existsSync(logPath)) return readFileSync(logPath, "utf8");
    const saveTo = dirname(logPath);
    return runHoraeLog(taskId, dataDate, saveTo);
  };
}

export async function fillHiveDdlFromLogCache(
  options: FillHiveDdlFromLogCacheOptions = {},
): Promise<FillHiveDdlFromLogCacheSummary> {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const dataDate = options.dataDate ?? DEFAULT_RUN_SCRIPT_LOG_DATE;
  if (!DATA_DATE.test(dataDate)) throw new Error("DATA_DATE_INVALID");
  const maxErrors = nonNegativeInteger(
    options.maxErrors,
    DEFAULT_MAX_ERRORS,
    "MAX_ERRORS_INVALID",
  );
  const minIntervalMs = nonNegativeInteger(
    options.minIntervalMs,
    DEFAULT_MIN_INTERVAL_MS,
    "MIN_INTERVAL_MS_INVALID",
  );
  const gate = options.gate ?? new HoraeSerialGate({ minIntervalMs });
  const now = options.now ?? (() => new Date());
  const logRunner = options.logRunner ?? defaultLogRunner(cacheRoot);
  const force = options.force === true;

  const baseIds = options.taskIds ?? toHiveSyncIdsFromHoraeTypeCache(cacheRoot);
  const taskIds = selectedTaskIds(
    fromStartTaskId(
      excludeManualTaskIds(
        baseIds,
        options.manualTaskIds ?? readManualTaskIds(cacheRoot),
      ),
      options.startTaskId,
    ),
    options.limit,
  );

  let skipped = 0;
  let cached = 0;
  let empty = 0;
  let errors = 0;
  let stopped = false;
  const failedTaskIds: string[] = [];

  for (const taskId of taskIds) {
    try {
      const existing = parseHiveDdlFromLogCache(taskId, cacheRoot);
      if (
        !force &&
        existing.status === "HIT" &&
        existing.evidence.ddlStatus === "AVAILABLE" &&
        existing.evidence.createSql
      ) {
        skipped += 1;
        continue;
      }

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

      const extracted = extractHiveDdlFromHoraeLog(logText);
      const evidence: HiveDdlFromLogEvidence = {
        source: "HORAE_LOG",
        dataDate,
        ddlStatus: extracted.createSql ? "AVAILABLE" : "UNAVAILABLE",
        createSql: extracted.createSql,
        qualifiedName: extracted.qualifiedName,
        hiveDb: extracted.hiveDb,
        hiveTable: extracted.hiveTable,
      };
      writeHiveDdlFromLogCache(
        taskId,
        now().toISOString(),
        evidence,
        cacheRoot,
        { overwrite: existing.status === "HIT" },
      );
      if (evidence.ddlStatus === "AVAILABLE") cached += 1;
      else {
        empty += 1;
        process.stderr.write(
          `[hive-ddl-from-log] ${taskId} HIVE_DDL_NOT_IN_LOG:${dataDate}\n`,
        );
      }
    } catch (error) {
      if (isHoraeLogInstanceMissing(error)) {
        writeHiveDdlFromLogCache(
          taskId,
          now().toISOString(),
          {
            source: "HORAE_LOG",
            ddlStatus: "UNAVAILABLE",
            dataDate,
            createSql: null,
            qualifiedName: null,
            hiveDb: null,
            hiveTable: null,
          },
          cacheRoot,
          {
            overwrite:
              parseHiveDdlFromLogCache(taskId, cacheRoot).status === "HIT",
          },
        );
        empty += 1;
        process.stderr.write(
          `[hive-ddl-from-log] ${taskId} HORAE_LOG_INSTANCE_MISSING:${dataDate}\n`,
        );
        continue;
      }
      errors += 1;
      failedTaskIds.push(taskId);
      process.stderr.write(
        `[hive-ddl-from-log] ${taskId} ${errorMessage(error)}\n`,
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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
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

function taskIdsFromSummariesBucket(
  summariesPath: string,
  bucket: PartialGapBucket,
): string[] {
  const inventory = inventoryPartialGapsFromSummaries(summariesPath);
  return [...(inventory.byBucket.get(bucket) ?? [])];
}

async function main(): Promise<void> {
  const cacheRoot =
    option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const dataDate = option("--data-date") ?? DEFAULT_RUN_SCRIPT_LOG_DATE;
  const startTaskId = option("--start-task-id");
  const taskIdsFile = option("--task-ids-file");
  const manualTaskIds = readManualTaskIds(
    cacheRoot,
    option("--manual-task-ids-file") ?? undefined,
  );
  const summariesPath = option("--from-summaries");
  const bucket = (option("--bucket") ??
    "ONLY_HIVE_TARGET_GAP") as PartialGapBucket;
  let taskIds: string[] | undefined;
  if (taskIdsFile) taskIds = taskIdsFromFile(taskIdsFile);
  else if (summariesPath) {
    taskIds = taskIdsFromSummariesBucket(summariesPath, bucket);
    const outDir = option("--write-ids-dir");
    if (outDir !== undefined) {
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `ids-${bucket}.txt`);
      writeFileSync(outPath, `${taskIds.join("\n")}\n`, "utf8");
      process.stderr.write(
        `[hive-ddl-from-log] wrote ${taskIds.length} ids → ${outPath}\n`,
      );
    }
  }
  const limit = parseIntegerOption("--limit", undefined, false);
  if (taskIds !== undefined && limit !== undefined)
    taskIds = taskIds.slice(0, limit);
  process.stderr.write(
    `[hive-ddl-from-log] start ${JSON.stringify({
      cacheRoot,
      dataDate,
      taskCount: taskIds?.length ?? "auto-toHive",
      bucket: summariesPath ? bucket : null,
      force: hasFlag("--force"),
    })}\n`,
  );
  const summary = await fillHiveDdlFromLogCache({
    cacheRoot,
    taskIds,
    manualTaskIds,
    startTaskId,
    limit: taskIds === undefined ? limit : undefined,
    dataDate,
    maxErrors: parseIntegerOption("--max-errors", DEFAULT_MAX_ERRORS, true),
    minIntervalMs: parseIntegerOption(
      "--min-interval-ms",
      DEFAULT_MIN_INTERVAL_MS,
      true,
    ),
    force: hasFlag("--force"),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.stopped || summary.errors > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("fill-hive-ddl-from-log-cache.ts")) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
