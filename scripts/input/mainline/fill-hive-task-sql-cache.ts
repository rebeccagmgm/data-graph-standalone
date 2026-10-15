import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HoraeSerialGate } from "./collect-one-task-input-pack-sparkindex.ts";
import {
  parseTaskIdOrder,
  sortTaskIds,
  taskIdsFromFile,
  taskIdsFromScheduleEvidenceCache,
  type TaskIdOrder,
} from "./fill-horae-relation-cache.ts";
import {
  isHoraeLogInstanceMissing,
  runHoraeLog,
} from "./fill-run-script-sql-cache.ts";
import {
  DEFAULT_RUN_SCRIPT_LOG_DATE,
  runScriptLogCachePath,
} from "./run-script-sql-cache.ts";
import {
  defaultHiveTaskCodeRoot,
  extractHiveTaskSqlFromHoraeLog,
  extractHiveTaskSqlFromScript,
  isLegacyGfFdmHiveTaskScriptPath,
  readHiveTaskSqlCache,
  resolveExistingLocalHiveTaskScriptPath,
  sqlHasStructuralTemplateVars,
  sqlSlotsFromMcpResponse,
  writeHiveTaskSqlCache,
  HIVE_TASK_SQL_LEGACY_CACHE_FILE_NAME,
  type HiveTaskSqlEvidence,
} from "./hive-task-sql-cache.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeTaskTypeCache,
} from "../../evidence/schedule-evidence-cache.ts";
import {
  excludeManualTaskIds,
  readManualTaskIds,
} from "../shared/manual-task-exclusion.ts";

const HIVE_TASK_TYPES = new Set(["hiveTask", "hiveTask-2.0"]);
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_MAX_ERRORS = 0;
const DEFAULT_MIN_INTERVAL_MS = 5_000;
const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const DEFAULT_TASK_CODE_TIMEOUT_MS = 120_000;

export type HiveTaskSqlMcpRunner = (taskId: string) => unknown;
export type HiveTaskSqlTaskCodeRunner = (taskId: string) => unknown;
export type HiveTaskSqlLogRunner = (
  taskId: string,
  dataDate: string,
) => string | Promise<string>;

export interface FillHiveTaskSqlCacheOptions {
  readonly cacheRoot?: string;
  readonly codeRoot?: string;
  readonly taskIds?: readonly string[];
  readonly order?: TaskIdOrder;
  readonly startTaskId?: string;
  readonly limit?: number;
  readonly maxErrors?: number;
  readonly minIntervalMs?: number;
  readonly dataDate?: string;
  readonly mcpRunner?: HiveTaskSqlMcpRunner;
  readonly taskCodeRunner?: HiveTaskSqlTaskCodeRunner;
  readonly logRunner?: HiveTaskSqlLogRunner;
  readonly gate?: HoraeSerialGate;
  readonly now?: () => Date;
  readonly force?: boolean;
  readonly manualTaskIds?: ReadonlySet<string>;
  /** Re-extract SQL from cached script-log only (skip local/MCP). */
  readonly horaeLogOnly?: boolean;
}

export interface HiveTaskSqlFillError {
  readonly taskId: string;
  readonly message: string;
}

export interface FillHiveTaskSqlCacheSummary {
  readonly total: number;
  readonly skipped: number;
  readonly cached: number;
  readonly localCached: number;
  readonly mcpCached: number;
  readonly mcpEmpty: number;
  readonly logCached: number;
  readonly logEmpty: number;
  readonly structuralUpgrades: number;
  readonly errors: number;
  readonly maxErrors: number;
  readonly minIntervalMs: number;
  readonly order: TaskIdOrder;
  readonly dataDate: string;
  readonly startTaskId: string | null;
  readonly failedTaskIds: readonly string[];
  readonly errorDetails: readonly HiveTaskSqlFillError[];
  readonly stopped: boolean;
}

function hiveTaskScriptPath(detail: Record<string, unknown>): string | null {
  return optionalText(detail.scriptPath) ?? optionalText(detail.fileName);
}

export function hiveTaskIdsFromHoraeTypeCache(cacheRoot: string): string[] {
  return taskIdsFromScheduleEvidenceCache(cacheRoot).filter((taskId) => {
    const cached = readHoraeTaskTypeCache(taskId, cacheRoot);
    if (cached.status !== "HIT") return false;
    const taskType = cached.detail.taskType;
    if (typeof taskType !== "string" || !HIVE_TASK_TYPES.has(taskType))
      return false;
    return hiveTaskScriptPath(cached.detail) !== null;
  });
}

export function hiveTaskSqlMcpCommandArguments(
  taskId: string,
): readonly string[] {
  return [
    "szdata",
    "task-sql",
    "--task-id",
    taskId,
    "--full",
    "true",
    "-f",
    "json",
  ];
}

export function runHiveTaskSqlMcp(taskId: string): unknown {
  if (!SAFE_TASK_ID.test(taskId))
    throw new Error(`HIVE_TASK_SQL_INVALID_TASK:${taskId}`);
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
          ...hiveTaskSqlMcpCommandArguments(taskId),
        ]
      : [...hiveTaskSqlMcpCommandArguments(taskId)];
  const timeoutMs = Number.parseInt(
    process.env.INPUT_PACK_HIVE_TASK_SQL_MCP_TIMEOUT_MS ?? "",
    10,
  );
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_MCP_TIMEOUT_MS;
  const output = execFileSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: effectiveTimeoutMs,
    // Keep opencli "Extension update available" off our terminal.
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

export function hiveTaskSqlTaskCodeCommandArguments(
  taskId: string,
): readonly string[] {
  return [
    "szdata",
    "task-code",
    "--task-id",
    taskId,
    "--preview",
    "0",
    "-f",
    "json",
  ];
}

export function runHiveTaskTaskCode(taskId: string): unknown {
  if (!SAFE_TASK_ID.test(taskId))
    throw new Error(`HIVE_TASK_SQL_INVALID_TASK:${taskId}`);
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
          ...hiveTaskSqlTaskCodeCommandArguments(taskId),
        ]
      : [...hiveTaskSqlTaskCodeCommandArguments(taskId)];
  const timeoutMs = Number.parseInt(
    process.env.INPUT_PACK_HIVE_TASK_SQL_TASK_CODE_TIMEOUT_MS ?? "",
    10,
  );
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TASK_CODE_TIMEOUT_MS;
  const output = execFileSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: effectiveTimeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

function readTaskCodeScriptContent(response: unknown): string | null {
  const rows = Array.isArray(response) ? response : [response];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const cachePath = record.codeCachePath;
    if (typeof cachePath === "string" && cachePath.includes("::")) {
      const separator = cachePath.indexOf("::");
      const cacheDir = cachePath.slice(0, separator);
      const repositoryPath = cachePath
        .slice(separator + 2)
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");
      const localPath = join(cacheDir, ...repositoryPath.split("/"));
      if (existsSync(localPath)) return readFileSync(localPath, "utf8");
    }
    if (typeof record.preview === "string" && record.preview.trim() !== "") {
      return record.preview;
    }
  }
  return null;
}

export function evidenceFromTaskCodeResponse(
  response: unknown,
  scriptPath: string | null,
  hiveDb: string | null,
): HiveTaskSqlEvidence | null {
  const content = readTaskCodeScriptContent(response);
  if (content === null) return null;
  const extracted = extractHiveTaskSqlFromScript(content);
  if (extracted.createSql === null && extracted.querySql === null) return null;
  return {
    source: "LOCAL_CODE",
    sqlStatus: "AVAILABLE",
    scriptPath,
    hiveDb,
    createSql: extracted.createSql,
    querySql: extracted.querySql,
  };
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
  if (limit === undefined) return [...taskIds];
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("LIMIT_INVALID");
  return taskIds.slice(0, limit);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? null : trimmed;
}

function logDataDateForTask(
  dataDate: string,
  detail: Record<string, unknown> | null,
): string {
  const cycle = optionalText(detail?.cycle);
  if (cycle === "每月" || /^\d+\s*M$/i.test(cycle ?? "")) {
    const match = /^(\d{4}-\d{2})-\d{2}$/.exec(dataDate);
    if (match?.[1]) return `${match[1]}-01`;
  }
  return dataDate;
}

function evidenceFromLocal(
  codeRoot: string,
  scriptPath: string | null,
  hiveDb: string | null,
): HiveTaskSqlEvidence | null {
  const localPath = resolveExistingLocalHiveTaskScriptPath(codeRoot, scriptPath);
  if (localPath === null) return null;
  const extracted = extractHiveTaskSqlFromScript(
    readFileSync(localPath, "utf8"),
  );
  if (extracted.createSql === null && extracted.querySql === null) return null;
  return {
    source: "LOCAL_CODE",
    sqlStatus: "AVAILABLE",
    scriptPath,
    hiveDb,
    createSql: extracted.createSql,
    querySql: extracted.querySql,
  };
}

function shouldStop(errors: number, maxErrors: number): boolean {
  return maxErrors > 0 && errors >= maxErrors;
}

function hiveTaskSqlPayloadLength(
  createSql: string | null | undefined,
  querySql: string | null | undefined,
): number {
  return (createSql ?? "").length + (querySql ?? "").length;
}

function shouldKeepExistingHoraeLogOverMcp(
  existing: ReturnType<typeof readHiveTaskSqlCache>,
  mcpSlots: { readonly createSql: string | null; readonly querySql: string | null },
): boolean {
  if (existing.status !== "HIT") return false;
  if (existing.source !== "HORAE_LOG" || existing.sqlStatus !== "AVAILABLE") {
    return false;
  }
  if (sqlHasStructuralTemplateVars(existing.createSql, existing.querySql)) {
    return false;
  }
  return (
    hiveTaskSqlPayloadLength(existing.createSql, existing.querySql) >
    hiveTaskSqlPayloadLength(mcpSlots.createSql, mcpSlots.querySql)
  );
}

async function fillHoraeLogOnlyHiveTaskSqlCache(
  options: FillHiveTaskSqlCacheOptions & { readonly taskIds: readonly string[] },
): Promise<FillHiveTaskSqlCacheSummary> {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const order = options.order ?? "asc";
  const dataDate = options.dataDate ?? DEFAULT_RUN_SCRIPT_LOG_DATE;
  const maxErrors = nonNegativeInteger(
    options.maxErrors,
    DEFAULT_MAX_ERRORS,
    "MAX_ERRORS_INVALID",
  );
  const minIntervalMs = nonNegativeInteger(
    options.minIntervalMs,
    DEFAULT_MIN_INTERVAL_MS,
    "HIVE_TASK_SQL_MIN_INTERVAL_INVALID",
  );
  const taskIds = selectedTaskIds(
    fromStartTaskId(sortTaskIds([...options.taskIds], order), options.startTaskId, order),
    options.limit,
  );
  const now = options.now ?? (() => new Date());
  let skipped = 0;
  let logCached = 0;
  let logEmpty = 0;
  let errors = 0;
  let stopped = false;
  const failedTaskIds: string[] = [];
  const errorDetails: HiveTaskSqlFillError[] = [];

  for (const taskId of taskIds) {
    const typeCache = readHoraeTaskTypeCache(taskId, cacheRoot);
    const taskType =
      typeCache.status === "HIT" &&
      typeof typeCache.detail.taskType === "string"
        ? typeCache.detail.taskType
        : null;
    if (taskType !== null && !HIVE_TASK_TYPES.has(taskType)) {
      skipped += 1;
      continue;
    }
    const scriptPath =
      typeCache.status === "HIT" ? hiveTaskScriptPath(typeCache.detail) : null;
    const hiveDb =
      typeCache.status === "HIT" ? optionalText(typeCache.detail.hiveDb) : null;
    const taskName =
      typeCache.status === "HIT" ? optionalText(typeCache.detail.name) : null;
    const logDataDate = logDataDateForTask(
      dataDate,
      typeCache.status === "HIT" ? typeCache.detail : null,
    );
    const logPath = runScriptLogCachePath(taskId, logDataDate, cacheRoot);
    if (!existsSync(logPath)) {
      logEmpty += 1;
      process.stderr.write(
        `[hive-task-sql-cache] ${taskId} HORAE_LOG_CACHE_MISS:${logDataDate}\n`,
      );
      continue;
    }
    try {
      const fromLog = extractHiveTaskSqlFromHoraeLog(readFileSync(logPath, "utf8"), {
        taskName,
        hiveDb,
      });
      const logAvailable =
        (fromLog.createSql !== null || fromLog.querySql !== null) &&
        !sqlHasStructuralTemplateVars(fromLog.createSql, fromLog.querySql);
      if (!logAvailable) {
        logEmpty += 1;
        if (sqlHasStructuralTemplateVars(fromLog.createSql, fromLog.querySql)) {
          process.stderr.write(
            `[hive-task-sql-cache] ${taskId} HORAE_LOG_STRUCTURAL_TEMPLATE\n`,
          );
        }
        continue;
      }
      writeHiveTaskSqlCache(
        taskId,
        now().toISOString(),
        {
          source: "HORAE_LOG",
          sqlStatus: "AVAILABLE",
          scriptPath,
          hiveDb,
          createSql: fromLog.createSql,
          querySql: fromLog.querySql,
        },
        cacheRoot,
        { overwrite: true },
      );
      logCached += 1;
    } catch (error) {
      errors += 1;
      failedTaskIds.push(taskId);
      errorDetails.push({ taskId, message: errorMessage(error) });
      if (shouldStop(errors, maxErrors)) {
        stopped = true;
        break;
      }
    }
  }

  return {
    total: taskIds.length,
    skipped,
    cached: logCached,
    localCached: 0,
    mcpCached: 0,
    mcpEmpty: 0,
    logCached,
    logEmpty,
    structuralUpgrades: 0,
    errors,
    maxErrors,
    minIntervalMs,
    order,
    dataDate,
    startTaskId: options.startTaskId ?? null,
    failedTaskIds,
    errorDetails,
    stopped,
  };
}

/**
 * Fill hiveTask / hiveTask-2.0 SQL cache files.
 * Only tasks with scriptPath/fileName are selected. Local BigData checkout
 * is written first; MCP is used for remaining misses.
 *
 * When cached/local SQL still has structural `${…}` (not date-like vars such as
 * `data_day_str`), try MCP; if MCP returns empty SQL, fall back to expanded
 * `hive -e` bodies from the Horae run log.
 */
export async function fillHiveTaskSqlCache(
  options: FillHiveTaskSqlCacheOptions = {},
): Promise<FillHiveTaskSqlCacheSummary> {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const order = options.order ?? "asc";
  const codeRoot = options.codeRoot ?? defaultHiveTaskCodeRoot(cacheRoot);
  const force = options.force === true;
  const dataDate = options.dataDate ?? DEFAULT_RUN_SCRIPT_LOG_DATE;
  const maxErrors = nonNegativeInteger(
    options.maxErrors,
    DEFAULT_MAX_ERRORS,
    "MAX_ERRORS_INVALID",
  );
  const minIntervalMs = nonNegativeInteger(
    options.minIntervalMs,
    DEFAULT_MIN_INTERVAL_MS,
    "HIVE_TASK_SQL_MIN_INTERVAL_INVALID",
  );
  const taskIds = selectedTaskIds(
    fromStartTaskId(
      sortTaskIds(
        excludeManualTaskIds(
          options.taskIds ?? hiveTaskIdsFromHoraeTypeCache(cacheRoot),
          options.manualTaskIds ?? readManualTaskIds(cacheRoot),
        ),
        order,
      ),
      options.startTaskId,
      order,
    ),
    options.limit,
  );
  if (options.horaeLogOnly === true) {
    return fillHoraeLogOnlyHiveTaskSqlCache({ ...options, taskIds });
  }
  const gate = options.gate ?? new HoraeSerialGate({ minIntervalMs });
  const mcpRunner = options.mcpRunner ?? runHiveTaskSqlMcp;
  const taskCodeRunner = options.taskCodeRunner ?? runHiveTaskTaskCode;
  const logRunner = options.logRunner ?? defaultHiveTaskLogRunner(cacheRoot);
  const now = options.now ?? (() => new Date());
  let skipped = 0;
  let localCached = 0;
  let mcpCached = 0;
  let mcpEmpty = 0;
  let logCached = 0;
  let logEmpty = 0;
  let structuralUpgrades = 0;
  let errors = 0;
  let stopped = false;
  const failedTaskIds: string[] = [];
  const errorDetails: HiveTaskSqlFillError[] = [];
  type Pending = {
    readonly taskId: string;
    readonly taskName: string | null;
    readonly scriptPath: string | null;
    readonly hiveDb: string | null;
    readonly logDataDate: string;
    readonly overwrite: boolean;
    readonly reason: "miss" | "structural";
  };
  const pendingMcp: Pending[] = [];

  for (const taskId of taskIds) {
    const existing = readHiveTaskSqlCache(taskId, cacheRoot);
    const typeCache = readHoraeTaskTypeCache(taskId, cacheRoot);
    const taskType =
      typeCache.status === "HIT" &&
      typeof typeCache.detail.taskType === "string"
        ? typeCache.detail.taskType
        : null;
    // Explicit task-id lists may include up-neighbors (exeSql / check* / …).
    // Only hiveTask* go through local → MCP → Horae-log SQL fill.
    if (taskType !== null && !HIVE_TASK_TYPES.has(taskType)) {
      skipped += 1;
      continue;
    }
    const scriptPath =
      typeCache.status === "HIT" ? hiveTaskScriptPath(typeCache.detail) : null;
    const hiveDb =
      typeCache.status === "HIT" ? optionalText(typeCache.detail.hiveDb) : null;
    const taskName =
      typeCache.status === "HIT" ? optionalText(typeCache.detail.name) : null;
    const logDataDate = logDataDateForTask(
      dataDate,
      typeCache.status === "HIT" ? typeCache.detail : null,
    );

    if (
      existing.status === "HIT" &&
      !force &&
      existing.sqlStatus === "AVAILABLE" &&
      !sqlHasStructuralTemplateVars(existing.createSql, existing.querySql)
    ) {
      if (existing.path.endsWith(HIVE_TASK_SQL_LEGACY_CACHE_FILE_NAME)) {
        writeHiveTaskSqlCache(taskId, existing.observedAt, existing, cacheRoot);
      }
      skipped += 1;
      continue;
    }

    if (
      existing.status === "HIT" &&
      !force &&
      existing.sqlStatus === "AVAILABLE" &&
      existing.source === "LOCAL_CODE" &&
      sqlHasStructuralTemplateVars(existing.createSql, existing.querySql)
    ) {
      pendingMcp.push({
        taskId,
        taskName,
        scriptPath,
        hiveDb,
        logDataDate,
        overwrite: true,
        reason: "structural",
      });
      continue;
    }

    try {
      const local = evidenceFromLocal(codeRoot, scriptPath, hiveDb);
      if (local === null) {
        if (
          existing.status === "HIT" &&
          !force &&
          existing.sqlStatus === "AVAILABLE" &&
          !sqlHasStructuralTemplateVars(existing.createSql, existing.querySql)
        ) {
          skipped += 1;
          continue;
        }
        pendingMcp.push({
          taskId,
          taskName,
          scriptPath,
          hiveDb,
          logDataDate,
          overwrite: existing.status === "HIT",
          reason:
            existing.status === "HIT" &&
            sqlHasStructuralTemplateVars(existing.createSql, existing.querySql)
              ? "structural"
              : "miss",
        });
        continue;
      }
      writeHiveTaskSqlCache(taskId, now().toISOString(), local, cacheRoot, {
        overwrite: existing.status === "HIT",
      });
      localCached += 1;
      if (sqlHasStructuralTemplateVars(local.createSql, local.querySql)) {
        pendingMcp.push({
          taskId,
          taskName,
          scriptPath,
          hiveDb,
          logDataDate,
          overwrite: true,
          reason: "structural",
        });
      }
    } catch (error) {
      errors += 1;
      failedTaskIds.push(taskId);
      errorDetails.push({ taskId, message: errorMessage(error) });
      if (shouldStop(errors, maxErrors)) {
        stopped = true;
        break;
      }
    }
  }

  if (!stopped) {
    process.stderr.write(
      `[hive-task-sql-cache] local done ${JSON.stringify({
        localCached,
        skipped,
        pendingMcp: pendingMcp.length,
      })}\n`,
    );
    const progressEvery = 25;
    for (let index = 0; index < pendingMcp.length; index += 1) {
      const item = pendingMcp[index]!;
      try {
        if (isLegacyGfFdmHiveTaskScriptPath(item.scriptPath)) {
          try {
            gate.beforeCall();
            const fromTaskCode = evidenceFromTaskCodeResponse(
              await Promise.resolve(taskCodeRunner(item.taskId)),
              item.scriptPath,
              item.hiveDb,
            );
            if (fromTaskCode !== null) {
              writeHiveTaskSqlCache(
                item.taskId,
                now().toISOString(),
                fromTaskCode,
                cacheRoot,
                { overwrite: item.overwrite },
              );
              localCached += 1;
              if (item.reason === "structural") structuralUpgrades += 1;
              if (
                (index + 1) % progressEvery === 0 ||
                index + 1 === pendingMcp.length
              ) {
                process.stderr.write(
                  `[hive-task-sql-cache] mcp progress ${index + 1}/${pendingMcp.length} ${JSON.stringify(
                    {
                      mcpCached,
                      mcpEmpty,
                      logCached,
                      logEmpty,
                      structuralUpgrades,
                      errors,
                    },
                  )}\n`,
                );
              }
              continue;
            }
          } catch (error) {
            process.stderr.write(
              `[hive-task-sql-cache] ${item.taskId} task-code miss ${errorMessage(error).slice(0, 160)}\n`,
            );
          }
        }

        gate.beforeCall();
        const slots = sqlSlotsFromMcpResponse(
          await Promise.resolve(mcpRunner(item.taskId)),
          item.taskId,
        );
        const available = slots.createSql !== null || slots.querySql !== null;
        const mcpHasStructuralTemplateVars = sqlHasStructuralTemplateVars(
          slots.createSql,
          slots.querySql,
        );
        if (available && !mcpHasStructuralTemplateVars) {
          const existingForMcp = readHiveTaskSqlCache(item.taskId, cacheRoot);
          if (shouldKeepExistingHoraeLogOverMcp(existingForMcp, slots)) {
            process.stderr.write(
              `[hive-task-sql-cache] ${item.taskId} keep HORAE_LOG over shorter MCP\n`,
            );
            if (
              (index + 1) % progressEvery === 0 ||
              index + 1 === pendingMcp.length
            ) {
              process.stderr.write(
                `[hive-task-sql-cache] mcp progress ${index + 1}/${pendingMcp.length} ${JSON.stringify(
                  {
                    mcpCached,
                    mcpEmpty,
                    logCached,
                    logEmpty,
                    structuralUpgrades,
                    errors,
                  },
                )}\n`,
              );
            }
            continue;
          }
          writeHiveTaskSqlCache(
            item.taskId,
            now().toISOString(),
            {
              source: "SQL_MCP",
              sqlStatus: "AVAILABLE",
              scriptPath: item.scriptPath,
              hiveDb: item.hiveDb,
              createSql: slots.createSql,
              querySql: slots.querySql,
            },
            cacheRoot,
            { overwrite: item.overwrite },
          );
          mcpCached += 1;
          if (item.reason === "structural") structuralUpgrades += 1;
        } else {
          if (!available) mcpEmpty += 1;
          if (mcpHasStructuralTemplateVars) {
            process.stderr.write(
              `[hive-task-sql-cache] ${item.taskId} MCP_STRUCTURAL_TEMPLATE -> HORAE_LOG\n`,
            );
          }

          // MCP unavailable or still structural → Horae log (expanded hive -e).
          let logText: string;
          try {
            const logPath = runScriptLogCachePath(
              item.taskId,
              item.logDataDate,
              cacheRoot,
            );
            if (existsSync(logPath)) logText = readFileSync(logPath, "utf8");
            else {
              gate.beforeCall();
              logText = await Promise.resolve(
                logRunner(item.taskId, item.logDataDate),
              );
              mkdirSync(dirname(logPath), { recursive: true });
              if (!existsSync(logPath)) writeFileSync(logPath, logText, "utf8");
            }
          } catch (error) {
            if (isHoraeLogInstanceMissing(error)) {
              logEmpty += 1;
              process.stderr.write(
                `[hive-task-sql-cache] ${item.taskId} HORAE_LOG_INSTANCE_MISSING:${item.logDataDate}\n`,
              );
            } else {
              throw error;
            }
            if (
              (index + 1) % progressEvery === 0 ||
              index + 1 === pendingMcp.length
            ) {
              process.stderr.write(
                `[hive-task-sql-cache] mcp progress ${index + 1}/${pendingMcp.length} ${JSON.stringify(
                  {
                    mcpCached,
                    mcpEmpty,
                    logCached,
                    logEmpty,
                    structuralUpgrades,
                    errors,
                  },
                )}\n`,
              );
            }
            continue;
          }
          const fromLog = extractHiveTaskSqlFromHoraeLog(logText, {
            taskName: item.taskName,
            hiveDb: item.hiveDb,
          });
          const logAvailable =
            (fromLog.createSql !== null || fromLog.querySql !== null) &&
            !sqlHasStructuralTemplateVars(fromLog.createSql, fromLog.querySql);
          if (logAvailable) {
            writeHiveTaskSqlCache(
              item.taskId,
              now().toISOString(),
              {
                source: "HORAE_LOG",
                sqlStatus: "AVAILABLE",
                scriptPath: item.scriptPath,
                hiveDb: item.hiveDb,
                createSql: fromLog.createSql,
                querySql: fromLog.querySql,
              },
              cacheRoot,
              { overwrite: item.overwrite },
            );
            logCached += 1;
            if (item.reason === "structural") structuralUpgrades += 1;
          } else {
            logEmpty += 1;
            if (sqlHasStructuralTemplateVars(fromLog.createSql, fromLog.querySql)) {
              process.stderr.write(
                `[hive-task-sql-cache] ${item.taskId} HORAE_LOG_STRUCTURAL_TEMPLATE\n`,
              );
            }
          }
        }
        if (
          (index + 1) % progressEvery === 0 ||
          index + 1 === pendingMcp.length
        ) {
          process.stderr.write(
            `[hive-task-sql-cache] mcp progress ${index + 1}/${pendingMcp.length} ${JSON.stringify(
              {
                mcpCached,
                mcpEmpty,
                logCached,
                logEmpty,
                structuralUpgrades,
                errors,
              },
            )}\n`,
          );
        }
      } catch (error) {
        errors += 1;
        failedTaskIds.push(item.taskId);
        errorDetails.push({
          taskId: item.taskId,
          message: errorMessage(error),
        });
        if (shouldStop(errors, maxErrors)) {
          stopped = true;
          break;
        }
      }
    }
  }

  return {
    total: taskIds.length,
    skipped,
    cached: localCached + mcpCached + logCached,
    localCached,
    mcpCached,
    mcpEmpty,
    logCached,
    logEmpty,
    structuralUpgrades,
    errors,
    maxErrors,
    minIntervalMs,
    order,
    dataDate,
    startTaskId: options.startTaskId ?? null,
    failedTaskIds,
    errorDetails,
    stopped,
  };
}

function defaultHiveTaskLogRunner(cacheRoot: string): HiveTaskSqlLogRunner {
  return (taskId, dataDate) => {
    const saveTo = dirname(runScriptLogCachePath(taskId, dataDate, cacheRoot));
    return runHoraeLog(taskId, dataDate, saveTo);
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
  const order = parseTaskIdOrder(option("--order"));
  const startTaskId = option("--start-task-id");
  const maxErrors = parseIntegerOption("--max-errors", undefined, true);
  const minIntervalMs = parseIntegerOption("--interval-ms", undefined, true);
  const taskIdsFile = option("--task-ids-file");
  const taskIds = taskIdsFile ? taskIdsFromFile(taskIdsFile, order) : undefined;
  const manualTaskIds = readManualTaskIds(
    cacheRoot,
    option("--manual-task-ids-file") ?? undefined,
  );
  const force = process.argv.includes("--force");
  const horaeLogOnly = process.argv.includes("--horae-log-only");
  process.stderr.write(
    `[hive-task-sql-cache] start ${JSON.stringify({
      cacheRoot,
      codeRoot: option("--code-root") ?? defaultHiveTaskCodeRoot(cacheRoot),
      startTaskId: startTaskId ?? null,
      taskIdsFile: taskIdsFile ?? null,
      order,
      taskIds: taskIds?.length ?? null,
      maxErrors: maxErrors ?? DEFAULT_MAX_ERRORS,
      minIntervalMs: minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      force,
      horaeLogOnly,
    })}\n`,
  );
  const summary = await fillHiveTaskSqlCache({
    cacheRoot,
    codeRoot: option("--code-root"),
    startTaskId,
    taskIds,
    manualTaskIds,
    order,
    limit: parseIntegerOption("--limit", undefined, false),
    maxErrors,
    minIntervalMs,
    dataDate: option("--data-date") ?? DEFAULT_RUN_SCRIPT_LOG_DATE,
    force,
    horaeLogOnly,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.errors > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("fill-hive-task-sql-cache.ts")) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
