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
import { leadingCreateTableStatement } from "./hive-task-sql-cache.ts";

export const HIVE_DDL_FROM_LOG_CACHE_FILE_NAME = "hive-target-ddl.sql" as const;
export const HIVE_DDL_FROM_LOG_SOURCE = "HORAE_LOG" as const;

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PROCESS_HIVE_DDL = /Process\s+hive\s+ddl\s*:/iu;
const CREATE_TABLE =
  /\bCREATE\s+(?:EXTERNAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/iu;

export type HiveDdlFromLogStatus = "AVAILABLE" | "UNAVAILABLE";

export interface HiveDdlFromLogExtract {
  readonly createSql: string | null;
  readonly qualifiedName: string | null;
  readonly hiveDb: string | null;
  readonly hiveTable: string | null;
}

export interface HiveDdlFromLogEvidence extends HiveDdlFromLogExtract {
  readonly source: typeof HIVE_DDL_FROM_LOG_SOURCE;
  readonly ddlStatus: HiveDdlFromLogStatus;
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

function decodeLogEscapes(text: string): string {
  return text
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function stripLogNoise(line: string): string {
  return line
    .replace(/^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [^\]]+\]-\[(?:INFO|WARN|ERROR)\]\s*/u, "")
    .replace(
      /^(?:\d{4}-\d{2}-\d{2} [0-9:.]+-\[(?:INFO|WARN|ERROR)\]-?\s*)?(?:\[[^\]]+\]\s*)+/u,
      "",
    );
}

function unquoteBlock(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replaceAll('\\"', '"')
      .replaceAll("\\n", "\n");
  }
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function skipBalancedParens(sql: string, start: number): number {
  if (sql[start] !== "(") return start;
  let depth = 0;
  for (let index = start; index < sql.length; index += 1) {
    const current = sql[index];
    if (current === "(") depth += 1;
    else if (current === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return sql.length;
}

function firstCreateTableStatement(sql: string): string | null {
  const normalized = normalizeSqlText(sql);
  const match = CREATE_TABLE.exec(normalized);
  if (match?.index === undefined) return null;
  let index = match.index + match[0].length;
  while (index < normalized.length && /\s/u.test(normalized[index]!)) index += 1;
  while (index < normalized.length) {
    const current = normalized[index]!;
    if (current === "`" || current === '"' || current === "'") {
      const quote = current;
      index += 1;
      while (index < normalized.length && normalized[index] !== quote) index += 1;
      index += 1;
      continue;
    }
    if (current === "(") {
      index = skipBalancedParens(normalized, index);
      continue;
    }
    if (current === ";") {
      return normalizeSqlText(normalized.slice(match.index, index + 1));
    }
    index += 1;
  }
  const leading = leadingCreateTableStatement(normalized.slice(match.index));
  return leading === undefined ? null : normalizeSqlText(leading);
}

function parseQualifiedNameFromCreate(createSql: string): {
  readonly qualifiedName: string | null;
  readonly hiveDb: string | null;
  readonly hiveTable: string | null;
} {
  const match =
    /\bCREATE\s+(?:EXTERNAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|`[^`]+`|[A-Za-z0-9_]+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[A-Za-z0-9_]+))?)/iu.exec(
      createSql,
    );
  if (!match?.[1]) {
    return { qualifiedName: null, hiveDb: null, hiveTable: null };
  }
  const raw = match[1].replaceAll("`", "").replaceAll('"', "").replace(/\s+/gu, "");
  const parts = raw.split(".");
  if (parts.length === 1) {
    return {
      qualifiedName: parts[0]!.toLowerCase(),
      hiveDb: null,
      hiveTable: parts[0]!.toLowerCase(),
    };
  }
  const hiveDb = parts[0]!.toLowerCase();
  const hiveTable = parts.slice(1).join(".").toLowerCase();
  return {
    qualifiedName: `${hiveDb}.${hiveTable}`,
    hiveDb,
    hiveTable,
  };
}

/**
 * Extract Hive target DDL emitted by AnyLoader `HiveAssistant` in Horae logs.
 * Marker: `Process hive ddl:` followed by USE + CREATE EXTERNAL TABLE.
 */
export function extractHiveDdlFromHoraeLog(source: string): HiveDdlFromLogExtract {
  const text = decodeLogEscapes(String(source).replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  const marker = PROCESS_HIVE_DDL.exec(text);
  if (marker?.index === undefined) {
    return {
      createSql: null,
      qualifiedName: null,
      hiveDb: null,
      hiveTable: null,
    };
  }
  const after = text.slice(marker.index + marker[0].length);
  const stop = /Hive\s+DDL\s+finished/iu.exec(after);
  const window = stop?.index === undefined ? after.slice(0, 20_000) : after.slice(0, stop.index);
  const cleaned = window
    .split("\n")
    .map(stripLogNoise)
    .join("\n");
  const block = unquoteBlock(cleaned);
  const createSql = firstCreateTableStatement(block);
  if (createSql === null) {
    return {
      createSql: null,
      qualifiedName: null,
      hiveDb: null,
      hiveTable: null,
    };
  }
  return { createSql, ...parseQualifiedNameFromCreate(createSql) };
}

export function hiveDdlFromLogCachePath(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): string {
  safeTaskId(taskId);
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks",
    taskId,
    HIVE_DDL_FROM_LOG_CACHE_FILE_NAME,
  );
}

export function formatHiveDdlFromLogFile(
  taskId: string,
  observedAt: string,
  evidence: HiveDdlFromLogEvidence,
): string {
  const header = [
    `-- task_id: ${taskId}`,
    `-- hiveDb: ${headerValue(evidence.hiveDb)}`,
    `-- hiveTable: ${headerValue(evidence.hiveTable)}`,
    `-- qualifiedName: ${headerValue(evidence.qualifiedName)}`,
    `-- source: ${evidence.source}`,
    `-- ddlStatus: ${evidence.ddlStatus}`,
    `-- dataDate: ${evidence.dataDate}`,
    `-- observed_at: ${observedAt}`,
    "",
  ];
  const body =
    evidence.createSql === null
      ? []
      : [normalizeSqlText(evidence.createSql), ""];
  return `${[...header, ...body].join("\n").trimEnd()}\n`;
}

export function writeHiveDdlFromLogCache(
  taskId: string,
  observedAt: string,
  evidence: HiveDdlFromLogEvidence,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  options: { readonly overwrite?: boolean } = {},
): string {
  safeTaskId(taskId);
  const path = hiveDdlFromLogCachePath(taskId, cacheRoot);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(
      temporaryPath,
      formatHiveDdlFromLogFile(taskId, observedAt, evidence),
      { encoding: "utf8", flag: "wx" },
    );
    if (options.overwrite && existsSync(path)) {
      const backupPath = `${path}.${process.pid}.${randomUUID()}.bak`;
      renameSync(path, backupPath);
      try {
        renameSync(temporaryPath, path);
        rmSync(backupPath, { force: true });
      } catch (error) {
        if (!existsSync(path) && existsSync(backupPath)) {
          renameSync(backupPath, path);
        }
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

function headerField(text: string, name: string): string | null {
  const match = new RegExp(`^--\\s*${name}:\\s*(.*)$`, "imu").exec(text);
  if (!match) return null;
  const value = match[1]!.trim();
  return value === "" ? null : value;
}

export function parseHiveDdlFromLogCache(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
):
  | { readonly status: "MISS"; readonly path: string }
  | {
      readonly status: "HIT";
      readonly path: string;
      readonly evidence: HiveDdlFromLogEvidence;
    } {
  const path = hiveDdlFromLogCachePath(taskId, cacheRoot);
  if (!existsSync(path)) return { status: "MISS", path };
  const text = readFileSync(path, "utf8");
  const ddlStatusRaw = headerField(text, "ddlStatus");
  const ddlStatus: HiveDdlFromLogStatus =
    ddlStatusRaw === "UNAVAILABLE" ? "UNAVAILABLE" : "AVAILABLE";
  const body = text
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith("--") && line.trim() !== "")
    .join("\n")
    .trim();
  const createSql =
    ddlStatus === "AVAILABLE" && body !== ""
      ? firstCreateTableStatement(body) ?? normalizeSqlText(body)
      : null;
  const parsed =
    createSql === null
      ? { qualifiedName: null, hiveDb: null, hiveTable: null }
      : parseQualifiedNameFromCreate(createSql);
  return {
    status: "HIT",
    path,
    evidence: {
      source: HIVE_DDL_FROM_LOG_SOURCE,
      ddlStatus,
      dataDate: headerField(text, "dataDate") ?? "",
      createSql,
      qualifiedName:
        headerField(text, "qualifiedName") ?? parsed.qualifiedName,
      hiveDb: headerField(text, "hiveDb") ?? parsed.hiveDb,
      hiveTable: headerField(text, "hiveTable") ?? parsed.hiveTable,
    },
  };
}
