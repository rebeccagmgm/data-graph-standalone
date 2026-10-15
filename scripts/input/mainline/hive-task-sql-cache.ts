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
  canonicalJson,
  sha256,
} from "../../machine-facts/machine-facts-contract.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  resolveScheduleEvidenceCacheRoot,
} from "../../evidence/schedule-evidence-cache.ts";
import { isTemporalSqlTemplateVariable } from "../shared/temporal-template.ts";

export const HIVE_TASK_SQL_CACHE_SCHEMA_VERSION = "1.0.0" as const;
export const HIVE_TASK_SQL_CACHE_ARTIFACT_TYPE = "HIVE_TASK_SQL_EVIDENCE" as const;
export const HIVE_TASK_SQL_CACHE_FILE_NAME = "hive-task.sql" as const;
export const HIVE_TASK_SQL_LEGACY_CACHE_FILE_NAME = "hive-task-sql.json" as const;
export const HIVE_TASK_SQL_SOURCES = ["LOCAL_CODE", "SQL_MCP", "HORAE_LOG"] as const;
export type HiveTaskSqlSource = (typeof HIVE_TASK_SQL_SOURCES)[number];

const LINE_PREFIX = /^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [^\]]+\]-\[INFO\] /;
const INNER_LOG_PREFIX =
  /^(?:\d{4}-\d{2}-\d{2} [0-9:.]+-\[(?:INFO|WARN|ERROR)\]-?\s*)?(?:\[DUBBO\]\s*)?/;

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const SQL_ASSIGNMENT_PREFIX = /\b(?:sql|hql)\s*=/gi;
const EXEC_SQL_CALL_PREFIX = /\bexec_sql\s*\(/gi;

type JsonRecord = Record<string, unknown>;

export type HiveTaskSqlStatus = "AVAILABLE" | "UNAVAILABLE";

export interface HiveTaskSqlEvidence {
  readonly source: HiveTaskSqlSource;
  readonly sqlStatus: HiveTaskSqlStatus;
  readonly scriptPath: string | null;
  readonly hiveDb: string | null;
  readonly createSql: string | null;
  readonly querySql: string | null;
}

export interface HiveTaskSqlCacheDocument {
  readonly schema_version: typeof HIVE_TASK_SQL_CACHE_SCHEMA_VERSION;
  readonly artifact_type: typeof HIVE_TASK_SQL_CACHE_ARTIFACT_TYPE;
  readonly task_id: string;
  readonly observed_at: string;
  readonly provenance: string;
  readonly source: HiveTaskSqlSource;
  readonly sqlStatus: HiveTaskSqlStatus;
  readonly scriptPath: string | null;
  readonly hiveDb: string | null;
  readonly createSql: string | null;
  readonly querySql: string | null;
  readonly content_sha256: string;
}

export type HiveTaskSqlCacheRead =
  | { readonly status: "MISS"; readonly path: string }
  | { readonly status: "INVALID"; readonly path: string; readonly reason: string }
  | {
      readonly status: "HIT";
      readonly path: string;
      readonly taskId: string;
      readonly observedAt: string;
      readonly source: HiveTaskSqlSource;
      readonly sqlStatus: HiveTaskSqlStatus;
      readonly scriptPath: string | null;
      readonly hiveDb: string | null;
      readonly createSql: string | null;
      readonly querySql: string | null;
    };

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" || normalized === "-" ? undefined : normalized;
}

function safeTaskId(taskId: string): void {
  if (!SAFE_TASK_ID.test(taskId)) throw new Error("INVALID_TASK_ID");
}

function nullableSql(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function defaultHiveTaskCodeRoot(cacheRoot: string): string {
  return join(resolveScheduleEvidenceCacheRoot(cacheRoot), "code-BigData");
}

export function hiveTaskSqlCachePath(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): string {
  safeTaskId(taskId);
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks",
    taskId,
    HIVE_TASK_SQL_CACHE_FILE_NAME,
  );
}

function hiveTaskSqlLegacyCachePath(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): string {
  safeTaskId(taskId);
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks",
    taskId,
    HIVE_TASK_SQL_LEGACY_CACHE_FILE_NAME,
  );
}

/** Legacy Horae repos folded into a successor BigData checkout. */
export const HIVE_TASK_LEGACY_REPO_ALIASES: Readonly<
  Record<string, readonly string[]>
> = {
  GF_FDM: ["GF_FDM_N"],
};

export function normalizeHiveTaskScriptPath(
  scriptPath: string | null | undefined,
): string | null {
  const raw = String(scriptPath ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!raw) return null;
  if (/^BigData-/i.test(raw)) return raw;
  if (raw.startsWith("BigData/")) {
    const parts = raw.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[0] === "BigData") {
      return `BigData-${parts[1]}/${parts.slice(2).join("/")}`;
    }
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 2) return raw;
  const prefix = parts[0]!;
  if (prefix.includes("-")) return raw;
  return `BigData-${prefix}/${parts.slice(1).join("/")}`;
}

export function isLegacyGfFdmHiveTaskScriptPath(
  scriptPath: string | null | undefined,
): boolean {
  const normalized = normalizeHiveTaskScriptPath(scriptPath);
  if (!normalized) return false;
  return /^BigData-GF_FDM\//iu.test(normalized);
}

type ParsedHiveTaskScriptLocation = {
  repo: string;
  rest: string[];
};

function parseHiveTaskScriptLocation(
  scriptPath: string | null | undefined,
): ParsedHiveTaskScriptLocation | null {
  const raw = normalizeHiveTaskScriptPath(scriptPath);
  if (!raw) return null;
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const prefix = parts[0]!;
  let repo: string;
  let rest: string[];
  if (prefix === "BigData" && parts.length >= 3) {
    repo = parts[1]!;
    rest = parts.slice(2);
  } else {
    const separator = prefix.indexOf("-");
    if (separator <= 0 || separator === prefix.length - 1) return null;
    repo = prefix.slice(separator + 1);
    rest = parts.slice(1);
  }
  if (repo === "" || rest.length === 0) return null;
  if (rest.some((part) => part === "." || part === "..")) return null;
  return { repo, rest };
}

function hiveTaskReposToTry(repo: string): readonly string[] {
  const aliases = HIVE_TASK_LEGACY_REPO_ALIASES[repo] ?? [];
  return [repo, ...aliases.filter((alias) => alias !== repo)];
}

/** Only explicit repository paths and aliases with the same relative path. */
export function listLocalHiveTaskScriptPathCandidates(
  codeRoot: string,
  scriptPath: string | null | undefined,
): readonly string[] {
  const parsed = parseHiveTaskScriptLocation(scriptPath);
  if (!parsed) return [];

  return [...new Set(hiveTaskReposToTry(parsed.repo).map((repo) =>
    join(codeRoot, repo, ...parsed.rest),
  ))];
}

export function resolveLocalHiveTaskScriptPath(
  codeRoot: string,
  scriptPath: string | null | undefined,
): string | null {
  return listLocalHiveTaskScriptPathCandidates(codeRoot, scriptPath)[0] ?? null;
}

export function resolveExistingLocalHiveTaskScriptPath(
  codeRoot: string,
  scriptPath: string | null | undefined,
): string | null {
  for (const candidate of listLocalHiveTaskScriptPathCandidates(
    codeRoot,
    scriptPath,
  )) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
  return cursor;
}

function parseConcatenatedPythonString(
  source: string,
  start: number,
): string | null {
  let cursor = skipWhitespace(source, start);
  let output = "";
  let found = false;
  while (cursor < source.length) {
    cursor = skipWhitespace(source, cursor);
    if (source.startsWith('"""', cursor) || source.startsWith("'''", cursor)) {
      const quote = source.slice(cursor, cursor + 3);
      const end = source.indexOf(quote, cursor + 3);
      if (end < 0) break;
      output += source.slice(cursor + 3, end);
      cursor = end + 3;
      found = true;
      continue;
    }
    const quote = source[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      while (cursor < source.length && source[cursor] !== quote) {
        if (source[cursor] === "\\") {
          output += source.slice(cursor, cursor + 2);
          cursor += 2;
          continue;
        }
        output += source[cursor];
        cursor += 1;
      }
      if (source[cursor] === quote) cursor += 1;
      found = true;
      continue;
    }
    if (source[cursor] === "+") {
      cursor = skipWhitespace(source, cursor + 1);
      const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(cursor));
      if (ident) {
        output += `\${${ident[0]}}`;
        cursor += ident[0].length;
        found = true;
      }
      continue;
    }
    break;
  }
  const trimmed = output.trim();
  return found && trimmed !== "" ? trimmed : null;
}

function skipQuotedAndParens(sql: string, start: number): number | undefined {
  let index = start;
  let depth = 0;
  let quote: string | undefined;
  while (index < sql.length) {
    const current = sql[index]!;
    if (quote !== undefined) {
      if (current === "\\" && index + 1 < sql.length) {
        index += 2;
        continue;
      }
      if (current === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      index += 1;
      continue;
    }
    if (current === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (current === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (current === ";" && depth === 0) return index;
    index += 1;
  }
  return undefined;
}

function firstCreateTableEnd(sql: string): number | undefined {
  const match = sql.match(/\bCREATE\s+(?:EXTERNAL\s+)?TABLE\b/iu);
  if (match?.index === undefined) return undefined;
  const semicolon = skipQuotedAndParens(sql, match.index);
  return semicolon === undefined ? undefined : semicolon + 1;
}

/** First CREATE TABLE statement when it is the leading statement in `sql`. */
export function leadingCreateTableStatement(sql: string): string | undefined {
  const trimmed = sql.trim();
  const match = trimmed.match(/\bCREATE\s+(?:EXTERNAL\s+)?TABLE\b/iu);
  if (match?.index === undefined) return undefined;
  if (trimmed.slice(0, match.index).trim() !== "") return undefined;
  const end = firstCreateTableEnd(trimmed);
  if (end === undefined) return undefined;
  return nullableSql(trimmed.slice(0, end)) ?? undefined;
}

function firstWriteStatementStart(sql: string): number | undefined {
  const match = sql.match(/\bINSERT\s+(?:OVERWRITE|INTO)\b/iu);
  return match?.index;
}

export function splitCombinedHiveTaskSql(sql: string | null): {
  readonly createSql: string | null;
  readonly querySql: string | null;
} {
  if (sql === null) return { createSql: null, querySql: null };
  const trimmed = sql.trim();
  if (trimmed === "") return { createSql: null, querySql: null };
  const createMatch = trimmed.match(/\bCREATE\s+(?:EXTERNAL\s+)?TABLE\b/iu);
  const writeStart = firstWriteStatementStart(trimmed);
  if (
    createMatch?.index !== undefined &&
    writeStart !== undefined &&
    writeStart > createMatch.index
  ) {
    const createEnd =
      firstCreateTableEnd(trimmed.slice(0, writeStart)) ?? writeStart;
    return {
      createSql: nullableSql(trimmed.slice(0, createEnd)) ?? null,
      querySql: nullableSql(trimmed.slice(writeStart)) ?? null,
    };
  }
  if (createMatch !== null && writeStart === undefined)
    return { createSql: nullableSql(trimmed) ?? null, querySql: null };
  return { createSql: null, querySql: nullableSql(trimmed) ?? null };
}

function mergeHiveTaskSqlSlots(
  createSql: string | null,
  querySql: string | null,
): { readonly createSql: string | null; readonly querySql: string | null } {
  const splitCreate = splitCombinedHiveTaskSql(createSql);
  const splitQuery =
    querySql === null ? { createSql: null, querySql: null } : splitCombinedHiveTaskSql(querySql);
  const create = splitCreate.createSql ?? splitQuery.createSql;
  const queryParts = [splitCreate.querySql, splitQuery.querySql].filter(
    (part): part is string => part !== null,
  );
  return {
    createSql: create,
    querySql: queryParts.length === 0 ? null : queryParts.join("\n\n"),
  };
}

function findMatchingParen(source: string, openIndex: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  let index = openIndex;
  while (index < source.length) {
    const current = source[index]!;
    if (quote !== undefined) {
      if (current === "\\" && index + 1 < source.length) {
        index += 2;
        continue;
      }
      if (
        quote.length === 3 &&
        source.startsWith(quote, index)
      ) {
        quote = undefined;
        index += 3;
        continue;
      }
      if (quote.length === 1 && current === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
      quote = source.slice(index, index + 3);
      index += 3;
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      index += 1;
      continue;
    }
    if (current === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (current === ")") {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
      continue;
    }
    index += 1;
  }
  return undefined;
}

function resolveLastStringAssignment(
  source: string,
  identifier: string,
  beforeIndex: number,
): string | null {
  const pattern = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*`, "g");
  let last: string | null = null;
  for (const match of source.matchAll(pattern)) {
    const assignIndex = match.index ?? 0;
    if (assignIndex >= beforeIndex) break;
    const value = parseConcatenatedPythonString(
      source,
      assignIndex + match[0].length,
    );
    if (value !== null) last = value;
  }
  return last;
}

function extractSqlFromExecSqlCall(
  source: string,
  execSqlIndex: number,
): string | null {
  const openParen = source.indexOf("(", execSqlIndex);
  if (openParen < 0) return null;
  const closeParen = findMatchingParen(source, openParen);
  if (closeParen === undefined) return null;
  const callBody = source.slice(openParen + 1, closeParen);
  const sqlArg = /\bsql\s*=\s*/i.exec(callBody);
  if (!sqlArg || sqlArg.index === undefined) return null;
  const valueStart = openParen + 1 + sqlArg.index + sqlArg[0].length;
  const inline = parseConcatenatedPythonString(source, valueStart);
  if (inline !== null) return inline;
  const identMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(valueStart));
  if (!identMatch) return null;
  return resolveLastStringAssignment(source, identMatch[0], valueStart);
}

function extractHiveTaskSqlFromAssignments(source: string): {
  readonly createSql: string | null;
  readonly querySql: string | null;
} {
  const create: string[] = [];
  const query: string[] = [];
  for (const match of source.matchAll(SQL_ASSIGNMENT_PREFIX)) {
    const block = parseConcatenatedPythonString(
      source,
      (match.index ?? 0) + match[0].length,
    );
    if (block === null) continue;
    const split = splitCombinedHiveTaskSql(block);
    if (split.createSql !== null) create.push(split.createSql);
    if (split.querySql !== null) query.push(split.querySql);
  }
  return {
    createSql: create.length === 0 ? null : create.join("\n\n"),
    querySql: query.length === 0 ? null : query.join("\n\n"),
  };
}

export function extractHiveTaskSqlFromScript(source: string): {
  readonly createSql: string | null;
  readonly querySql: string | null;
} {
  const create: string[] = [];
  const query: string[] = [];
  let foundExecSql = false;
  for (const match of String(source).matchAll(EXEC_SQL_CALL_PREFIX)) {
    foundExecSql = true;
    const block = extractSqlFromExecSqlCall(source, match.index ?? 0);
    if (block === null) continue;
    const split = splitCombinedHiveTaskSql(block);
    if (split.createSql !== null) create.push(split.createSql);
    if (split.querySql !== null) query.push(split.querySql);
  }
  if (!foundExecSql) {
    // Scripts without exec_sql may still expose sql/hql assignments directly.
    return extractHiveTaskSqlFromAssignments(source);
  }
  return {
    createSql: create.length === 0 ? null : create.join("\n\n"),
    querySql: query.length === 0 ? null : query.join("\n\n"),
  };
}

export function provenanceFor(source: HiveTaskSqlSource): string {
  if (source === "LOCAL_CODE") return "local-code";
  if (source === "HORAE_LOG") return "opencli:horae.log";
  return "opencli:szdata.task-sql";
}

/** All `${var}` names in SQL text, de-duplicated in appearance order. */
export function listSqlTemplateVariables(
  ...sqlParts: Array<string | null | undefined>
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of sqlParts) {
    if (typeof part !== "string" || part === "") continue;
    for (const match of part.matchAll(/\$\{([^{}\r\n]+)\}/g)) {
      const name = match[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function isDateLikeSqlTemplateVariable(name: string): boolean {
  return isTemporalSqlTemplateVariable(name);
}

/**
 * True when SQL still has `${…}` placeholders that are not date/batch vars
 * (e.g. `${DB_TEMP}`, `${DB_ODATA_N_GKS}`). Those need MCP or Horae log expand.
 */
export function sqlHasStructuralTemplateVars(
  ...sqlParts: Array<string | null | undefined>
): boolean {
  return listSqlTemplateVariables(...sqlParts).some(
    (name) => !isDateLikeSqlTemplateVariable(name),
  );
}

function stripHoraeLogLine(line: string): string {
  return line.replace(LINE_PREFIX, "").replace(INNER_LOG_PREFIX, "");
}

/**
 * Pull `hive -e"…"` bodies from a Horae task log (already variable-expanded).
 */
export function extractHiveEBodiesFromHoraeLog(
  logText: string,
): readonly string[] {
  const lines = String(logText)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(stripHoraeLogLine);
  const bodies: string[] = [];
  let collecting: string[] | null = null;
  let quote: '"' | "'" | null = null;
  for (const line of lines) {
    if (collecting === null) {
      const start = /^\s*hive\s+-e\s*(["'])\s*$/i.exec(line);
      if (!start) continue;
      quote = start[1] as '"' | "'";
      collecting = [];
      continue;
    }
    if (quote !== null && line.trim() === quote) {
      const body = collecting.join("\n").trim();
      if (body !== "") bodies.push(body);
      collecting = null;
      quote = null;
      continue;
    }
    collecting.push(line);
  }
  return bodies;
}

export type HoraeLogSqlExtractionHints = {
  readonly taskName?: string | null;
  readonly hiveDb?: string | null;
};

const HORAE_LOG_DIAGNOSTIC_WRITE =
  /\bINSERT\s+(?:OVERWRITE\s+)?(?:INTO\s+)?TABLE\s+[\w.]*(?:LOAD_LOG|_LOG_S)\b/iu;

function normalizeHoraeLogTableToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function taskNameTableTokens(taskName: string | null | undefined): readonly string[] {
  const firstLine = String(taskName ?? "")
    .split(/\r?\n/u)[0]
    ?.trim();
  if (!firstLine) return [];
  const parts = firstLine.split(".").filter(Boolean);
  const tokens = new Set<string>();
  tokens.add(normalizeHoraeLogTableToken(firstLine.replace(/\./g, "_")));
  if (parts.length > 0) {
    tokens.add(normalizeHoraeLogTableToken(parts[parts.length - 1]!));
  }
  if (parts.length > 1) {
    tokens.add(normalizeHoraeLogTableToken(parts.slice(1).join("_")));
  }
  return [...tokens].filter((token) => token.length > 0);
}

function writeTablesFromSql(sql: string | null | undefined): readonly string[] {
  if (!sql) return [];
  const tables: string[] = [];
  for (const match of sql.matchAll(
    /\bINSERT\s+(?:OVERWRITE\s+)?(?:INTO\s+)?TABLE\s+([\w.]+)/giu,
  )) {
    const qualified = match[1]?.trim();
    if (!qualified) continue;
    const leaf = qualified.split(".").pop() ?? qualified;
    const token = normalizeHoraeLogTableToken(leaf);
    if (token) tables.push(token);
  }
  return tables;
}

function scoreHoraeLogBody(
  slots: { readonly createSql: string | null; readonly querySql: string | null },
  hints: HoraeLogSqlExtractionHints,
): number {
  const sql = [slots.createSql, slots.querySql].filter(Boolean).join("\n");
  if (sql.trim() === "") return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (slots.createSql !== null) score += 10;
  if (slots.querySql !== null) score += 20;
  if (/\bINSERT\s+OVERWRITE\b/iu.test(sql)) score += 5;
  if (HORAE_LOG_DIAGNOSTIC_WRITE.test(sql)) score -= 100;

  const taskTokens = taskNameTableTokens(hints.taskName);
  const writeTables = writeTablesFromSql(slots.querySql ?? sql);
  for (const table of writeTables) {
    for (const token of taskTokens) {
      if (table === token || table.endsWith(`_${token}`) || token.endsWith(`_${table}`)) {
        score += 100;
      }
    }
  }

  const hiveDb = normalizeHoraeLogTableToken(String(hints.hiveDb ?? ""));
  if (hiveDb && writeTables.some((table) => sql.toLowerCase().includes(`${hiveDb}.${table}`))) {
    score += 5;
  }

  return score;
}

function isDiagnosticHoraeLogBody(body: string): boolean {
  const slots = splitCombinedHiveTaskSql(body);
  const sql = [slots.createSql, slots.querySql].filter(Boolean).join("\n");
  if (sql.trim() === "") return true;
  const writeTables = writeTablesFromSql(slots.querySql ?? sql);
  if (writeTables.length === 0) return false;
  return writeTables.every(
    (table) => /load_log|_log_s$/iu.test(table) || HORAE_LOG_DIAGNOSTIC_WRITE.test(sql),
  );
}

function horaeLogBodyHasStatement(body: string): boolean {
  const slots = splitCombinedHiveTaskSql(body);
  const sql = [slots.createSql, slots.querySql].filter(Boolean).join("\n");
  return /\b(CREATE|INSERT|MERGE|UPDATE|DELETE)\b/iu.test(sql);
}

function selectBestHoraeLogBody(
  bodies: readonly string[],
  hints: HoraeLogSqlExtractionHints,
): { readonly createSql: string | null; readonly querySql: string | null } {
  const ranked = bodies
    .map((body) => {
      const slots = splitCombinedHiveTaskSql(body);
      return { body, slots, score: scoreHoraeLogBody(slots, hints) };
    })
    .sort((left, right) => right.score - left.score);

  const best = ranked[0];
  if (best && best.score > Number.NEGATIVE_INFINITY) {
    if (best.slots.createSql !== null || best.slots.querySql !== null) {
      return best.slots;
    }
  }

  const createSql =
    ranked.find((entry) => entry.slots.createSql !== null)?.slots.createSql ?? null;
  const querySql =
    ranked.find(
      (entry) =>
        entry.slots.querySql !== null &&
        !HORAE_LOG_DIAGNOSTIC_WRITE.test(entry.slots.querySql),
    )?.slots.querySql ?? null;
  return mergeHiveTaskSqlSlots(createSql, querySql);
}

function selectHiveTaskSqlFromHoraeLogBodies(
  bodies: readonly string[],
  hints: HoraeLogSqlExtractionHints = {},
): { readonly createSql: string | null; readonly querySql: string | null } {
  if (bodies.length === 0) return { createSql: null, querySql: null };
  if (bodies.length === 1) return splitCombinedHiveTaskSql(bodies[0]!);

  const create: string[] = [];
  const query: string[] = [];
  for (const body of bodies) {
    if (isDiagnosticHoraeLogBody(body) || !horaeLogBodyHasStatement(body)) continue;
    const slots = splitCombinedHiveTaskSql(body);
    if (slots.createSql !== null) create.push(slots.createSql);
    if (slots.querySql !== null) query.push(slots.querySql);
  }
  if (create.length > 0 || query.length > 0) {
    return {
      createSql: create.length === 0 ? null : create.join("\n\n"),
      querySql: query.length === 0 ? null : query.join("\n\n"),
    };
  }

  return selectBestHoraeLogBody(bodies, hints);
}

/**
 * Build create/query slots from expanded hive -e blocks in a Horae log.
 * Non-diagnostic blocks are kept in log order (whole-script semantics, like
 * multiple exec_sql calls). Progress LOAD_LOG / *_LOG_S blocks are dropped.
 */
export function extractHiveTaskSqlFromHoraeLog(
  logText: string,
  hints: HoraeLogSqlExtractionHints = {},
): {
  readonly createSql: string | null;
  readonly querySql: string | null;
} {
  return selectHiveTaskSqlFromHoraeLogBodies(
    extractHiveEBodiesFromHoraeLog(logText),
    hints,
  );
}

function normalizeSqlText(sql: string): string {
  return sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function headerValue(value: string | null | undefined): string {
  return value == null ? "" : String(value);
}

export function formatHiveTaskSqlFile(
  taskId: string,
  observedAt: string,
  evidence: HiveTaskSqlEvidence,
): string {
  const header = [
    `-- task_id: ${taskId}`,
    `-- hiveDb: ${headerValue(evidence.hiveDb)}`,
    `-- source: ${evidence.source}`,
    `-- sqlStatus: ${evidence.sqlStatus}`,
    `-- scriptPath: ${headerValue(evidence.scriptPath)}`,
    `-- observed_at: ${observedAt}`,
    "",
  ];
  const body: string[] = [];
  if (evidence.createSql !== null) {
    body.push("-- createSql", normalizeSqlText(evidence.createSql), "");
  }
  if (evidence.querySql !== null) {
    if (evidence.createSql !== null) body.push("-- querySql");
    body.push(normalizeSqlText(evidence.querySql), "");
  }
  return `${[...header, ...body].join("\n").trimEnd()}\n`;
}

function parseHiveTaskSqlFile(
  taskId: string,
  path: string,
  text: string,
): HiveTaskSqlCacheRead {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const meta: JsonRecord = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const match = /^-- ([A-Za-z_]+): ?(.*)$/.exec(line);
    if (!match) break;
    meta[match[1]!] = match[2]!.trim();
    index += 1;
  }
  while (index < lines.length && lines[index]!.trim() === "") index += 1;
  const body = lines.slice(index).join("\n").trim();
  const observedAt = nonEmptyString(meta.observed_at) ?? nonEmptyString(meta.observedAt);
  if (!observedAt) return invalid(path, "OBSERVED_AT_MISSING");
  if (meta.task_id !== undefined && meta.task_id !== taskId)
    return invalid(path, "TASK_ID_MISMATCH");
  let createSql: string | null = null;
  let querySql: string | null = null;
  const createMark = /^-- createSql\s*$/m;
  const queryMark = /^-- querySql\s*$/m;
  if (createMark.test(body) || queryMark.test(body)) {
    const createIndex = body.search(createMark);
    const queryIndex = body.search(queryMark);
    if (createIndex >= 0) {
      const start = body.indexOf("\n", createIndex);
      const end = queryIndex >= 0 ? queryIndex : body.length;
      createSql = nullableSql(body.slice(start < 0 ? body.length : start, end)) ?? null;
    }
    if (queryIndex >= 0) {
      const start = body.indexOf("\n", queryIndex);
      querySql = nullableSql(body.slice(start < 0 ? body.length : start)) ?? null;
    }
  } else {
    querySql = nullableSql(body) ?? null;
  }
  ({ createSql, querySql } = mergeHiveTaskSqlSlots(createSql, querySql));
  const evidence = validateEvidence({
    source: meta.source,
    sqlStatus: meta.sqlStatus,
    scriptPath: meta.scriptPath === "" ? null : (meta.scriptPath ?? null),
    hiveDb: meta.hiveDb === "" ? null : (meta.hiveDb ?? null),
    createSql,
    querySql,
  });
  if ("reason" in evidence) return invalid(path, evidence.reason);
  return {
    status: "HIT",
    path,
    taskId,
    observedAt,
    ...evidence,
  };
}

function payload(
  taskId: string,
  observedAt: string,
  evidence: HiveTaskSqlEvidence,
): Omit<HiveTaskSqlCacheDocument, "content_sha256"> {
  return {
    schema_version: HIVE_TASK_SQL_CACHE_SCHEMA_VERSION,
    artifact_type: HIVE_TASK_SQL_CACHE_ARTIFACT_TYPE,
    task_id: taskId,
    observed_at: observedAt,
    provenance: provenanceFor(evidence.source),
    source: evidence.source,
    sqlStatus: evidence.sqlStatus,
    scriptPath: evidence.scriptPath,
    hiveDb: evidence.hiveDb,
    createSql: evidence.createSql,
    querySql: evidence.querySql,
  };
}

function invalid(
  path: string,
  reason: string,
): Extract<HiveTaskSqlCacheRead, { status: "INVALID" }> {
  return { status: "INVALID", path, reason };
}

function validateEvidence(
  record: JsonRecord,
): HiveTaskSqlEvidence | { reason: string } {
  const source = record.source;
  if (source !== "LOCAL_CODE" && source !== "SQL_MCP" && source !== "HORAE_LOG")
    return { reason: "SOURCE_INVALID" };
  const scriptPath =
    record.scriptPath === null ? null : nonEmptyString(record.scriptPath);
  if (record.scriptPath !== null && scriptPath === undefined)
    return { reason: "SCRIPT_PATH_INVALID" };
  const hiveDb = record.hiveDb === null ? null : nonEmptyString(record.hiveDb);
  if (record.hiveDb !== null && hiveDb === undefined)
    return { reason: "HIVE_DB_INVALID" };
  const createSql = nullableSql(record.createSql);
  const querySql = nullableSql(record.querySql);
  if (createSql === undefined) return { reason: "CREATE_SQL_INVALID" };
  if (querySql === undefined) return { reason: "QUERY_SQL_INVALID" };
  const sqlStatus: HiveTaskSqlStatus =
    record.sqlStatus === "AVAILABLE" || record.sqlStatus === "UNAVAILABLE"
      ? record.sqlStatus
      : createSql !== null || querySql !== null
        ? "AVAILABLE"
        : "UNAVAILABLE";
  if (sqlStatus === "AVAILABLE" && createSql === null && querySql === null)
    return { reason: "SQL_EMPTY" };
  return {
    source,
    sqlStatus,
    scriptPath: scriptPath ?? null,
    hiveDb: hiveDb ?? null,
    createSql,
    querySql,
  };
}

export function readHiveTaskSqlCache(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): HiveTaskSqlCacheRead {
  const path = hiveTaskSqlCachePath(taskId, cacheRoot);
  if (existsSync(path)) {
    try {
      return parseHiveTaskSqlFile(taskId, path, readFileSync(path, "utf8"));
    } catch {
      return invalid(path, "READ_FAILED");
    }
  }
  const legacyPath = hiveTaskSqlLegacyCachePath(taskId, cacheRoot);
  if (!existsSync(legacyPath)) return { status: "MISS", path };
  try {
    const parsed: unknown = JSON.parse(readFileSync(legacyPath, "utf8"));
    const record = asRecord(parsed);
    if (!record) return invalid(legacyPath, "ENVELOPE_NOT_OBJECT");
    if (record.schema_version !== HIVE_TASK_SQL_CACHE_SCHEMA_VERSION)
      return invalid(legacyPath, "SCHEMA_VERSION_MISMATCH");
    if (record.artifact_type !== HIVE_TASK_SQL_CACHE_ARTIFACT_TYPE)
      return invalid(legacyPath, "ARTIFACT_TYPE_MISMATCH");
    if (record.task_id !== taskId) return invalid(legacyPath, "TASK_ID_MISMATCH");
    const observedAt = nonEmptyString(record.observed_at);
    if (!observedAt) return invalid(legacyPath, "OBSERVED_AT_MISSING");
    const evidence = validateEvidence(record);
    if ("reason" in evidence) return invalid(legacyPath, evidence.reason);
    if (
      typeof record.content_sha256 !== "string" ||
      !SHA256.test(record.content_sha256)
    )
      return invalid(legacyPath, "CONTENT_HASH_INVALID");
    const expected = payload(taskId, observedAt, evidence);
    if (sha256(canonicalJson(expected)) !== record.content_sha256)
      return invalid(legacyPath, "CONTENT_HASH_MISMATCH");
    return {
      status: "HIT",
      path: legacyPath,
      taskId,
      observedAt,
      ...evidence,
    };
  } catch (error) {
    return invalid(
      legacyPath,
      error instanceof SyntaxError ? "JSON_INVALID" : "READ_FAILED",
    );
  }
}

export function writeHiveTaskSqlCache(
  taskId: string,
  observedAt: string,
  evidence: Omit<HiveTaskSqlEvidence, "sqlStatus"> & {
    readonly sqlStatus?: HiveTaskSqlStatus;
  },
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  options: { readonly overwrite?: boolean } = {},
): string {
  safeTaskId(taskId);
  if (!nonEmptyString(observedAt)) throw new Error("OBSERVED_AT_MISSING");
  const validated = validateEvidence({ ...evidence });
  if ("reason" in validated) throw new Error(validated.reason);
  const path = hiveTaskSqlCachePath(taskId, cacheRoot);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporaryPath, formatHiveTaskSqlFile(taskId, observedAt, validated), {
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
    const legacyPath = hiveTaskSqlLegacyCachePath(taskId, cacheRoot);
    if (existsSync(legacyPath)) rmSync(legacyPath, { force: true });
    return path;
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

export function sqlSlotsFromMcpResponse(
  value: unknown,
  taskId: string,
): { readonly createSql: string | null; readonly querySql: string | null } {
  const row = Array.isArray(value) ? value[0] : value;
  const record = asRecord(row);
  if (!record) throw new Error(`HIVE_TASK_SQL_MCP_INVALID:${taskId}`);
  const createSql = nullableSql(record.createSql) ?? null;
  const querySql = nullableSql(record.querySql) ?? null;
  return { createSql, querySql };
}
