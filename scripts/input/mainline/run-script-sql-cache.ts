import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  resolveScheduleEvidenceCacheRoot,
} from "../../evidence/schedule-evidence-cache.ts";

export const RUN_SCRIPT_SQL_CACHE_FILE_NAME = "run-script.sql" as const;
export const RUN_SCRIPT_LOG_CACHE_DIR_NAME = "script-log" as const;
export const DEFAULT_RUN_SCRIPT_LOG_DATE = "2026-08-27" as const;

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LINE_PREFIX = /^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [^\]]+\]-\[INFO\] /;
const INNER_PREFIX =
  /^(?:\d{4}-\d{2}-\d{2} [0-9:.]+-\[(?:INFO|WARN|ERROR)\]-?\s*)?(?:\[DUBBO\]\s*)?/;
const SQL_MARKER = "待执行sql为[";
const KEEP_SQL = /^(?:insert|create|select|with|merge|update|delete)\b/i;

export type RunScriptSqlStatus = "AVAILABLE" | "UNAVAILABLE";

export interface RunScriptSqlExtract {
  readonly querySql: string | null;
  readonly sqlFile: string | null;
  readonly scriptPath: string | null;
}

export interface RunScriptSqlEvidence extends RunScriptSqlExtract {
  readonly source: "HORAE_LOG";
  readonly sqlStatus: RunScriptSqlStatus;
  readonly hiveDb: string | null;
  readonly dataDate: string;
}

function safeTaskId(taskId: string): void {
  if (!SAFE_TASK_ID.test(taskId)) throw new Error("INVALID_TASK_ID");
}

function normalizeSqlText(sql: string): string {
  return sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function headerValue(value: string | null | undefined): string {
  return value == null ? "" : String(value);
}

function stripLogLine(line: string): string {
  return line.replace(LINE_PREFIX, "").replace(INNER_PREFIX, "");
}

function findClosingBracket(source: string, start: number): number {
  let depth = 1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractSqlFile(stripped: string): string | null {
  const flagged = /(?:^|\s)-q\s+(\S+\.sql)\b/m.exec(stripped);
  if (flagged) return flagged[1]!.replaceAll("\\", "/");
  const fileFlag = /(?:^|\s)--file\s+(\S+\.sql)\b/m.exec(stripped);
  if (!fileFlag) return null;
  const raw = fileFlag[1]!.replaceAll("\\", "/");
  const src = raw.indexOf("/src/");
  if (src >= 0) return raw.slice(src + "/src/".length);
  const parts = raw.split("/");
  return parts[parts.length - 1] ?? raw;
}

function extractScriptPath(stripped: string): string | null {
  const match = /\/opt\/schedule\/(BigData-[^\s,'\]]+\.sh)/.exec(stripped);
  if (match) return match[1]!.replaceAll("\\", "/");
  const relative = /\b(BigData-[^\s,'\]]+\.sh)\b/.exec(stripped);
  return relative ? relative[1]!.replaceAll("\\", "/") : null;
}

export function extractRunScriptSqlFromLog(source: string): RunScriptSqlExtract {
  const stripped = String(source)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(stripLogLine)
    .join("\n");
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < stripped.length) {
    const start = stripped.indexOf(SQL_MARKER, cursor);
    if (start < 0) break;
    const contentStart = start + SQL_MARKER.length;
    const end = findClosingBracket(stripped, contentStart);
    if (end < 0) break;
    const block = normalizeSqlText(stripped.slice(contentStart, end));
    if (block !== "" && KEEP_SQL.test(block)) blocks.push(block);
    cursor = end + 1;
  }
  return {
    querySql: blocks.length === 0 ? null : blocks.join("\n\n"),
    sqlFile: extractSqlFile(stripped),
    scriptPath: extractScriptPath(stripped),
  };
}

export function runScriptLogCachePath(
  taskId: string,
  dataDate: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): string {
  safeTaskId(taskId);
  const stamp = dataDate.replaceAll("-", "");
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    RUN_SCRIPT_LOG_CACHE_DIR_NAME,
    `${taskId}_${stamp}.log`,
  );
}

export function runScriptSqlCachePath(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): string {
  safeTaskId(taskId);
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks",
    taskId,
    RUN_SCRIPT_SQL_CACHE_FILE_NAME,
  );
}

export function formatRunScriptSqlFile(
  taskId: string,
  observedAt: string,
  evidence: RunScriptSqlEvidence,
): string {
  const header = [
    `-- task_id: ${taskId}`,
    `-- hiveDb: ${headerValue(evidence.hiveDb)}`,
    `-- source: ${evidence.source}`,
    `-- sqlStatus: ${evidence.sqlStatus}`,
    `-- dataDate: ${evidence.dataDate}`,
    `-- scriptPath: ${headerValue(evidence.scriptPath)}`,
    `-- sqlFile: ${headerValue(evidence.sqlFile)}`,
    `-- observed_at: ${observedAt}`,
    "",
  ];
  const body =
    evidence.querySql === null ? [] : [normalizeSqlText(evidence.querySql), ""];
  return `${[...header, ...body].join("\n").trimEnd()}\n`;
}

export function writeRunScriptSqlCache(
  taskId: string,
  observedAt: string,
  evidence: RunScriptSqlEvidence,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  options: { readonly overwrite?: boolean } = {},
): string {
  safeTaskId(taskId);
  const path = runScriptSqlCachePath(taskId, cacheRoot);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporaryPath, formatRunScriptSqlFile(taskId, observedAt, evidence), {
      encoding: "utf8",
      flag: "wx",
    });
    if (options.overwrite && existsSync(path)) {
      const backupPath = `${path}.${process.pid}.${randomUUID()}.bak`;
      renameSync(path, backupPath);
      try {
        renameSync(temporaryPath, path);
        rmSync(backupPath, { force: true });
      } catch (error) {
        if (!existsSync(path) && existsSync(backupPath))
          renameSync(backupPath, path);
        throw error;
      }
    } else {
      renameSync(temporaryPath, path);
    }
    return path;
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

export function readRunScriptSqlCache(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): { readonly status: "MISS" | "HIT"; readonly path: string } {
  const path = runScriptSqlCachePath(taskId, cacheRoot);
  if (!existsSync(path)) return { status: "MISS", path };
  try {
    const text = readFileSync(path, "utf8");
    return text.trim() === "" ? { status: "MISS", path } : { status: "HIT", path };
  } catch {
    return { status: "MISS", path };
  }
}

export type RunScriptSqlCacheRead =
  | { readonly status: "MISS"; readonly path: string }
  | { readonly status: "INVALID"; readonly path: string; readonly reason: string }
  | {
      readonly status: "HIT";
      readonly path: string;
      readonly querySql: string | null;
      readonly sqlStatus: RunScriptSqlStatus;
    };

export function parseRunScriptSqlCache(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): RunScriptSqlCacheRead {
  const path = runScriptSqlCachePath(taskId, cacheRoot);
  if (!existsSync(path)) return { status: "MISS", path };
  try {
    const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (text.trim() === "") return { status: "MISS", path };
    const lines = text.split("\n");
    let index = 0;
    const meta: Record<string, string> = {};
    while (index < lines.length) {
      const match = /^-- ([A-Za-z_]+): ?(.*)$/.exec(lines[index]!);
      if (!match) break;
      meta[match[1]!] = match[2]!.trim();
      index += 1;
    }
    while (index < lines.length && lines[index]!.trim() === "") index += 1;
    const body = lines.slice(index).join("\n").trim();
    if (meta.task_id !== undefined && meta.task_id !== taskId)
      return { status: "INVALID", path, reason: "TASK_ID_MISMATCH" };
    const sqlStatus: RunScriptSqlStatus =
      meta.sqlStatus === "UNAVAILABLE" ? "UNAVAILABLE" : "AVAILABLE";
    const querySql = body === "" ? null : body;
    if (sqlStatus === "AVAILABLE" && querySql === null)
      return { status: "INVALID", path, reason: "SQL_EMPTY" };
    return { status: "HIT", path, querySql, sqlStatus };
  } catch {
    return { status: "INVALID", path, reason: "READ_FAILED" };
  }
}
