import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import {
  canonicalJson,
  sha256,
} from "../../machine-facts/machine-facts-contract.ts";
import { resolveScheduleEvidenceCacheRoot } from "../../evidence/schedule-evidence-cache.ts";

export const SZDATA_SCHEDULE_DETAIL_CACHE_SCHEMA_VERSION = "1.0.0" as const;
export const SZDATA_SCHEDULE_DETAIL_CACHE_ARTIFACT_TYPE =
  "SZDATA_PORTAL_SCHEDULE_DETAIL" as const;
export const SZDATA_SCHEDULE_DETAIL_CACHE_PROVENANCE =
  "opencli:szdata.schedule-detail" as const;
export const SZDATA_SCHEDULE_DETAIL_CACHE_FILE_NAME =
  "szdata-schedule-detail.json" as const;
export const DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT =
  "E:\\02_area\\股衍数据-数据cookbook\\sql-static-lineage-cache";
export const DEFAULT_SZDATA_SCHEDULE_DETAIL_TIMEOUT_MS = 30_000;
export const DEFAULT_SZDATA_SCHEDULE_DETAIL_MIN_INTERVAL_MS = 5_000;

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SQL_SLOTS = ["create", "query", "prepare", "truncate", "finish"] as const;
type SqlSlot = (typeof SQL_SLOTS)[number];
type JsonRecord = Record<string, unknown>;

const SQL_FIELD_ALIASES: Readonly<Record<SqlSlot, readonly string[]>> = {
  create: ["createSql", "createSQL", "create_sql"],
  query: ["querySql", "querySQL", "query_sql"],
  prepare: ["prepareSql", "prepareSQL", "prepare_sql"],
  truncate: ["truncateSql", "truncateSQL", "truncate_sql"],
  finish: ["finishSql", "finishSQL", "finish_sql"],
};

const SQL_PREVIEW_FIELD_ALIASES = new Set([
  "createSqlPreview",
  "querySqlPreview",
  "prepareSqlPreview",
  "truncateSqlPreview",
  "finishSqlPreview",
]);

const TRUNCATION_MARKERS = [
  /\.\.\.\s*<\s*(?:truncated\s+)?\d+\s+chars?\s*>/i,
  /<\s*truncated\b/i,
  /<\s*omitted\b/i,
  /\[\s*truncated\b/i,
];

export type SzdataScheduleDetailCacheStatus = "HIT" | "MISS" | "INVALID";

export interface SzdataScheduleDetailCacheDocument {
  readonly schema_version: typeof SZDATA_SCHEDULE_DETAIL_CACHE_SCHEMA_VERSION;
  readonly artifact_type: typeof SZDATA_SCHEDULE_DETAIL_CACHE_ARTIFACT_TYPE;
  readonly task_id: string;
  readonly observed_at: string;
  readonly provenance: typeof SZDATA_SCHEDULE_DETAIL_CACHE_PROVENANCE;
  readonly detail: JsonRecord;
  readonly content_sha256: string;
}

export type SzdataScheduleDetailCacheRead =
  | { readonly status: "MISS"; readonly path: string }
  | {
      readonly status: "INVALID";
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly status: "HIT";
      readonly path: string;
      readonly taskId: string;
      readonly observedAt: string;
      readonly detail: JsonRecord;
    };

export interface ScheduleDetailRunnerOptions {
  readonly timeoutMs?: number;
}

export type ScheduleDetailRunner = (taskId: string) => unknown;

export interface ScheduleDetailSerialGateOptions {
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => void;
}

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

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const record = asRecord(value);
  if (!record) return false;
  return Object.values(record).every(isJsonValue);
}

function cachePathForRoot(cacheRoot: string, taskId: string): string {
  safeTaskId(taskId);
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks",
    taskId,
    SZDATA_SCHEDULE_DETAIL_CACHE_FILE_NAME,
  );
}

export function szdataScheduleDetailCachePath(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): string {
  return cachePathForRoot(cacheRoot, taskId);
}

function payload(
  taskId: string,
  observedAt: string,
  detail: JsonRecord,
): Omit<SzdataScheduleDetailCacheDocument, "content_sha256"> {
  return {
    schema_version: SZDATA_SCHEDULE_DETAIL_CACHE_SCHEMA_VERSION,
    artifact_type: SZDATA_SCHEDULE_DETAIL_CACHE_ARTIFACT_TYPE,
    task_id: taskId,
    observed_at: observedAt,
    provenance: SZDATA_SCHEDULE_DETAIL_CACHE_PROVENANCE,
    detail,
  };
}

function document(
  taskId: string,
  observedAt: string,
  detail: JsonRecord,
): SzdataScheduleDetailCacheDocument {
  const withoutHash = payload(taskId, observedAt, detail);
  return {
    ...withoutHash,
    content_sha256: sha256(canonicalJson(withoutHash)),
  };
}

function invalid(path: string, reason: string): SzdataScheduleDetailCacheRead {
  return { status: "INVALID", path, reason };
}

function containsTruncationMarker(value: string): boolean {
  return TRUNCATION_MARKERS.some((marker) => marker.test(value));
}

function validateDetail(
  value: unknown,
  taskId: string,
): { readonly detail: JsonRecord } | { readonly reason: string } {
  const detail = asRecord(value);
  if (!detail) return { reason: "DETAIL_NOT_OBJECT" };
  if (!isJsonValue(detail)) return { reason: "DETAIL_NOT_JSON" };
  if (Object.keys(detail).length <= 1) return { reason: "DETAIL_EMPTY" };

  const rawDetailTaskId = detail.taskId ?? detail.task_id;
  if (
    rawDetailTaskId !== undefined &&
    rawDetailTaskId !== null &&
    typeof rawDetailTaskId !== "string"
  )
    return { reason: "DETAIL_TASK_ID_INVALID" };
  const detailTaskId = nonEmptyString(rawDetailTaskId);
  if (detailTaskId !== undefined && detailTaskId !== taskId)
    return { reason: "DETAIL_TASK_ID_MISMATCH" };

  for (const [key, rawValue] of Object.entries(detail)) {
    if (SQL_PREVIEW_FIELD_ALIASES.has(key)) {
      if (
        rawValue !== null &&
        rawValue !== undefined &&
        typeof rawValue !== "string"
      )
        return { reason: "SQL_PREVIEW_FIELD_NOT_STRING" };
      if (nonEmptyString(rawValue) !== undefined)
        return { reason: "SQL_PREVIEW_FIELD_PRESENT" };
      continue;
    }
    if (!(SQL_SLOTS as readonly string[]).some((slot) =>
      SQL_FIELD_ALIASES[slot as SqlSlot]?.includes(key),
    ))
      continue;
    if (rawValue === null || rawValue === undefined || rawValue === "-")
      continue;
    if (typeof rawValue !== "string")
      return { reason: `SQL_${key.toUpperCase()}_NOT_STRING` };
    if (rawValue.trim() === "") return { reason: `SQL_${key.toUpperCase()}_EMPTY` };
    if (containsTruncationMarker(rawValue))
      return { reason: `SQL_${key.toUpperCase()}_TRUNCATED` };
  }

  const target = detail.targetTable;
  if (target !== undefined && target !== null && target !== "-") {
    if (typeof target !== "string" || target.trim() === "")
      return { reason: "TARGET_TABLE_INVALID" };
  }
  const insertMode = detail.insertMode;
  if (insertMode !== undefined && insertMode !== null && insertMode !== "-") {
    if (typeof insertMode !== "string" || insertMode.trim() === "")
      return { reason: "INSERT_MODE_INVALID" };
  }
  return { detail };
}

export function readSzdataScheduleDetailCache(
  taskId: string,
  cacheRoot: string,
): SzdataScheduleDetailCacheRead {
  const path = cachePathForRoot(cacheRoot, taskId);
  if (!existsSync(path)) return { status: "MISS", path };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = asRecord(parsed);
    if (!record) return invalid(path, "ENVELOPE_NOT_OBJECT");
    const allowed = new Set([
      "schema_version",
      "artifact_type",
      "task_id",
      "observed_at",
      "provenance",
      "detail",
      "content_sha256",
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key)))
      return invalid(path, "UNKNOWN_ENVELOPE_FIELD");
    if (record.schema_version !== SZDATA_SCHEDULE_DETAIL_CACHE_SCHEMA_VERSION)
      return invalid(path, "SCHEMA_VERSION_MISMATCH");
    if (record.artifact_type !== SZDATA_SCHEDULE_DETAIL_CACHE_ARTIFACT_TYPE)
      return invalid(path, "ARTIFACT_TYPE_MISMATCH");
    if (record.task_id !== taskId) return invalid(path, "TASK_ID_MISMATCH");
    const observedAt = nonEmptyString(record.observed_at);
    if (!observedAt) return invalid(path, "OBSERVED_AT_MISSING");
    if (record.provenance !== SZDATA_SCHEDULE_DETAIL_CACHE_PROVENANCE)
      return invalid(path, "PROVENANCE_MISMATCH");
    const detailResult = validateDetail(record.detail, taskId);
    if ("reason" in detailResult) return invalid(path, detailResult.reason);
    if (typeof record.content_sha256 !== "string" || !SHA256.test(record.content_sha256))
      return invalid(path, "CONTENT_HASH_INVALID");
    const expectedHash = sha256(
      canonicalJson(payload(taskId, observedAt, detailResult.detail)),
    );
    if (expectedHash !== record.content_sha256)
      return invalid(path, "CONTENT_HASH_MISMATCH");
    return {
      status: "HIT",
      path,
      taskId,
      observedAt,
      detail: detailResult.detail,
    };
  } catch (error) {
    return invalid(
      path,
      error instanceof SyntaxError ? "JSON_INVALID" : "READ_FAILED",
    );
  }
}

export function writeSzdataScheduleDetailCache(
  taskId: string,
  observedAt: string,
  detail: JsonRecord,
  cacheRoot: string,
): string {
  safeTaskId(taskId);
  if (!nonEmptyString(observedAt)) throw new Error("OBSERVED_AT_MISSING");
  const detailResult = validateDetail(detail, taskId);
  if ("reason" in detailResult) throw new Error(detailResult.reason);
  const path = cachePathForRoot(cacheRoot, taskId);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporaryPath, canonicalJson(document(taskId, observedAt, detail)), {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporaryPath, path);
    return path;
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function readPath(record: JsonRecord, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(record, path)) return record[path];
  let current: unknown = record;
  for (const part of path.split(".")) {
    const object = asRecord(current);
    if (!object || !Object.prototype.hasOwnProperty.call(object, part)) return undefined;
    current = object[part];
  }
  return current;
}

function sourceContainers(record: JsonRecord): readonly JsonRecord[] {
  const values = [
    record,
    asRecord(record.task),
    asRecord(record.schedule),
    asRecord(record.newScheduleInfo),
    asRecord(record.currentScheduleInfo),
  ];
  return values.filter((value): value is JsonRecord => value !== null);
}

function extensionValue(record: JsonRecord, names: readonly string[]): unknown {
  for (const container of sourceContainers(record)) {
    const extensions = container.taskext ?? container.taskExt ?? container.task_ext;
    if (!Array.isArray(extensions)) continue;
    for (const item of extensions) {
      const extension = asRecord(item);
      if (!extension) continue;
      const name = nonEmptyString(
        extension.prop_name ?? extension.propName ?? extension.name ?? extension.prop,
      );
      if (!name || !names.includes(name)) continue;
      return extension.prop_value ?? extension.propValue ?? extension.value;
    }
  }
  return undefined;
}

function candidateValues(
  record: JsonRecord,
  fields: readonly string[],
  extensionFields: readonly string[] = [],
): unknown[] {
  const candidates: unknown[] = [];
  for (const container of sourceContainers(record)) {
    for (const field of fields) {
      const value = readPath(container, field);
      if (value !== undefined && value !== null) candidates.push(value);
    }
  }
  for (const field of extensionFields) {
    const value = extensionValue(record, [field]);
    if (value !== undefined && value !== null) candidates.push(value);
  }
  return candidates;
}

function textFromValue(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(textFromValue).filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const field of ["name", "qualifiedName", "tableName", "value", "text"]) {
    const text = textFromValue(readPath(record, field));
    if (text !== undefined) return text;
  }
  return undefined;
}

function firstText(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const text = textFromValue(value);
    if (text !== undefined) return text;
  }
  return undefined;
}

function targetTextFromValue(value: unknown): string | undefined {
  const direct = nonEmptyString(value);
  if (direct !== undefined) return direct;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const path of [
    "table.name",
    "table.qualifiedName",
    "qualifiedName",
    "targetTable",
    "name",
  ]) {
    const target = targetTextFromValue(readPath(record, path));
    if (target !== undefined) return target;
  }
  return undefined;
}

function targetText(record: JsonRecord): string | undefined {
  const values = candidateValues(
    record,
    [
      "targetTable",
      "target_table",
      "syncTarget",
      "sync_target",
      "target.table.name",
      "db.table.name",
      "target",
    ],
    ["target.table.name", "db.table.name"],
  );
  for (const value of values) {
    const target = targetTextFromValue(value);
    if (target !== undefined) return target;
  }
  return undefined;
}

function targetSide(record: JsonRecord, side: "database" | "tableName"): string | undefined {
  const fields =
    side === "database"
      ? ["database", "databaseName", "target.database", "hive.database"]
      : ["tableName", "table_name", "target.table", "hive.table.name"];
  return firstText(candidateValues(record, fields));
}

function taskValue(record: JsonRecord, fields: readonly string[]): string | undefined {
  const expanded = fields.flatMap((field) => [field, `task.${field}`]);
  return firstText(candidateValues(record, expanded));
}

interface SqlCandidate {
  readonly value: string;
  readonly preview: boolean;
}

function sqlText(value: unknown): string | undefined {
  // SQL is source evidence. Use trim only to decide whether a value is
  // missing, but preserve the original bytes for comparison and cache write.
  if (typeof value === "string")
    return value.trim() === "" || value.trim() === "-" ? undefined : value;
  if (Array.isArray(value)) {
    const parts = value.map(sqlText).filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const field of ["sql", "sqls", "content", "value", "text"]) {
    const text = sqlText(readPath(record, field));
    if (text !== undefined) return text;
  }
  return undefined;
}

function sqlCandidates(
  record: JsonRecord,
  slot: SqlSlot,
): SqlCandidate[] {
  const fields = SQL_FIELD_ALIASES[slot];
  const previewFields = fields.map((field) => `${field}Preview`);
  const nestedFields: readonly string[] =
    slot === "create"
      ? ["create.sql", "create.sqls", "ddl.sql"]
      : slot === "query"
        ? ["query.sql", "query.sqls", "query.content", "select.sql"]
        : slot === "prepare"
          ? ["prepare.sqls", "prepare.sql", "prepare.content"]
          : slot === "truncate"
            ? ["truncate.sql", "truncate.sqls", "truncate.content"]
            : ["finish.sqls", "finish.sql", "finish.content"];
  const extensionFields =
    slot === "create"
      ? ["create.sql", "ddl.sql"]
      : slot === "query"
        ? ["query.sql", "select.sql"]
        : slot === "prepare"
          ? ["prepare.sqls", "prepare.sql"]
          : slot === "truncate"
            ? ["truncate.sql", "truncate.sqls"]
            : ["finish.sqls", "finish.sql"];
  const candidates: SqlCandidate[] = [];
  for (const container of sourceContainers(record)) {
    for (const field of fields) {
      const value = sqlText(readPath(container, field));
      if (value !== undefined) candidates.push({ value, preview: false });
    }
    for (const field of nestedFields) {
      const value = sqlText(readPath(container, field));
      if (value !== undefined) candidates.push({ value, preview: false });
    }
    for (const field of previewFields) {
      const value = sqlText(readPath(container, field));
      if (value !== undefined) candidates.push({ value, preview: true });
    }
  }
  for (const field of extensionFields) {
    const value = sqlText(extensionValue(record, [field]));
    if (value !== undefined) candidates.push({ value, preview: false });
  }
  return candidates;
}

function selectSql(record: JsonRecord, slot: SqlSlot): string | undefined {
  const candidates = sqlCandidates(record, slot);
  const full = candidates.filter((candidate) => !candidate.preview);
  if (full.length === 0 && candidates.some((candidate) => candidate.preview)) {
    if (
      candidates.some(
        (candidate) =>
          candidate.preview && containsTruncationMarker(candidate.value),
      )
    )
      throw new Error(`SZDATA_SCHEDULE_DETAIL_SQL_TRUNCATED:${slot}`);
    throw new Error(`SZDATA_SCHEDULE_DETAIL_SQL_PREVIEW_ONLY:${slot}`);
  }
  const selected = full.length > 0 ? full : candidates;
  if (selected.length === 0) return undefined;
  const values = [...new Set(selected.map((candidate) => candidate.value))];
  if (values.length > 1) throw new Error(`SZDATA_SCHEDULE_DETAIL_SQL_CONFLICT:${slot}`);
  const value = values[0]!;
  if (containsTruncationMarker(value))
    throw new Error(`SZDATA_SCHEDULE_DETAIL_SQL_TRUNCATED:${slot}`);
  return value;
}

function unwrapScheduleDetail(value: unknown, taskId: string): JsonRecord {
  let current: unknown = value;
  if (Array.isArray(current)) {
    if (current.length !== 1) {
      throw new Error(
        current.length === 0
          ? `SZDATA_SCHEDULE_DETAIL_EMPTY:${taskId}`
          : `SZDATA_SCHEDULE_DETAIL_MULTIPLE_ROWS:${taskId}`,
      );
    }
    current = current[0];
  }
  const object = asRecord(current);
  if (!object) throw new Error(`SZDATA_SCHEDULE_DETAIL_EMPTY:${taskId}`);
  for (const key of ["data", "rows", "result"]) {
    const nested = object[key];
    if (Array.isArray(nested) || asRecord(nested)) return unwrapScheduleDetail(nested, taskId);
  }
  return object;
}

const METADATA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  taskName: ["taskName", "task_name", "task.name"],
  taskDesc: ["taskDesc", "task_desc", "task.desc"],
  status: ["status", "taskStatus", "task_status", "task.status"],
  taskType: ["taskType", "task_type", "typeId", "type_id", "task.type", "task.task_type"],
  topicName: ["topicName", "topic_name", "topic", "task.topicName", "task.topic_name"],
  cycle: ["cycle", "scheduleCycle", "schedule_cycle", "task.cycle"],
  cycleUnit: ["cycleUnit", "cycle_unit", "task.cycleUnit", "task.cycle_unit"],
  cluster: ["cluster", "clusterName", "cluster_name", "task.cluster"],
  inCharge: ["inCharge", "in_charge", "task.inCharge", "task.in_charge"],
  businessUsername: [
    "businessUsername",
    "business_username",
    "task.businessUsername",
    "task.business_username",
  ],
  scenarioType: ["scenarioType", "scenario_type", "task.scenarioType", "task.scenario_type"],
  scenarioDesc: ["scenarioDesc", "scenario_desc", "task.scenarioDesc", "task.scenario_desc"],
  lastRunDate: ["lastRunDate", "last_run_date", "task.lastRunDate", "task.last_run_date"],
  lastRunState: ["lastRunState", "last_run_state", "task.lastRunState", "task.last_run_state"],
  lastRunStateName: [
    "lastRunStateName",
    "last_run_state_name",
    "task.lastRunStateName",
    "task.last_run_state_name",
  ],
  lastEndTime: ["lastEndTime", "last_end_time", "task.lastEndTime", "task.last_end_time"],
  tryLimit: ["tryLimit", "try_limit", "task.tryLimit", "task.try_limit"],
  source: ["source", "sourceTable", "source_table", "syncSource", "sync_source"],
  hivePartition: ["hivePartition", "hive_partition", "partition"],
};

export function normalizeSzdataScheduleDetail(
  value: unknown,
  taskId: string,
): JsonRecord {
  safeTaskId(taskId);
  const record = unwrapScheduleDetail(value, taskId);
  if (
    record.error !== undefined ||
    record.success === false ||
    ["error", "failed", "failure"].includes(
      String(record.status ?? "").trim().toLowerCase(),
    )
  ) {
    const detail =
      typeof record.error === "string"
        ? record.error
        : JSON.stringify(record.error ?? record);
    throw new Error(`SZDATA_SCHEDULE_DETAIL_UPSTREAM_ERROR:${taskId}:${detail}`);
  }
  const returnedTaskId = firstText(
    candidateValues(record, ["taskId", "task_id", "task.taskId", "task.task_id"]),
  );
  if (returnedTaskId !== undefined && returnedTaskId !== taskId)
    throw new Error(`SZDATA_SCHEDULE_DETAIL_TASK_ID_MISMATCH:${taskId}`);

  const detail: JsonRecord = { taskId };
  for (const [field, aliases] of Object.entries(METADATA_FIELDS)) {
    const valueForField = firstText(candidateValues(record, aliases));
    if (valueForField !== undefined) detail[field] = valueForField;
  }

  const target = targetText(record);
  if (target !== undefined) {
    detail.targetTable = target;
    const split = target.indexOf(".");
    if (split > 0) {
      if (detail.database === undefined) detail.database = target.slice(0, split);
      if (detail.tableName === undefined) detail.tableName = target.slice(split + 1);
    }
  }
  const database = targetSide(record, "database");
  const tableName = targetSide(record, "tableName");
  if (database !== undefined) detail.database = database;
  if (tableName !== undefined) detail.tableName = tableName;

  const insertMode = firstText(
    candidateValues(
      record,
      [
        "insertMode",
        "insert_mode",
        "loadMode",
        "load_mode",
        "writeMode",
        "write_mode",
        "target.table.save.mode",
        "target.table.saveMode",
        "target.save.mode",
      ],
      ["target.table.save.mode", "load.mode", "insertMode"],
    ),
  );
  if (insertMode !== undefined) detail.insertMode = insertMode;

  for (const slot of SQL_SLOTS) {
    const sql = selectSql(record, slot);
    if (sql !== undefined) detail[`${slot}Sql`] = sql;
  }
  if (Object.keys(detail).length <= 1)
    throw new Error(`SZDATA_SCHEDULE_DETAIL_EMPTY:${taskId}`);
  return detail;
}

export function scheduleDetailCommandArguments(
  taskId: string,
): readonly string[] {
  safeTaskId(taskId);
  return [
    "szdata",
    "schedule-detail",
    "--task-id",
    taskId,
    "--full",
    "true",
    "--sql-preview",
    "0",
    "-f",
    "json",
  ];
}

function configuredPositiveInteger(
  value: number | undefined,
  fallback: number,
  errorCode: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(errorCode);
  return value;
}

export function runSzdataScheduleDetail(
  taskId: string,
  options: ScheduleDetailRunnerOptions = {},
): unknown {
  const timeoutMs = configuredPositiveInteger(
    options.timeoutMs,
    DEFAULT_SZDATA_SCHEDULE_DETAIL_TIMEOUT_MS,
    "SZDATA_SCHEDULE_DETAIL_TIMEOUT_MUST_BE_POSITIVE",
  );
  const args = scheduleDetailCommandArguments(taskId);
  const appData = process.env.APPDATA;
  const installedEntry = appData
    ? resolve(
        appData,
        "npm",
        "node_modules",
        "@jackwener",
        "opencli",
        "dist",
        "src",
        "main.js",
      )
    : undefined;
  const useInstalledEntry =
    process.platform === "win32" &&
    installedEntry !== undefined &&
    existsSync(installedEntry);
  const executable = useInstalledEntry
    ? process.execPath
    : process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.OPENCLI_EXECUTABLE ?? "opencli");
  const executableArgs =
    useInstalledEntry
      ? [installedEntry!, ...args]
      : process.platform === "win32"
        ? ["/d", "/s", "/c", "opencli.cmd", ...args]
        : [...args];
  const output = execFileSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      OPENCLI_BROWSER_COMMAND_TIMEOUT: String(Math.ceil(timeoutMs / 1000)),
    },
    timeout: timeoutMs,
  });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("SZDATA_SCHEDULE_DETAIL_JSON_INVALID");
  }
}

function sleepSynchronously(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export class ScheduleDetailSerialGate {
  private lastCallAt: number | undefined;

  private readonly minIntervalMs: number;

  private readonly now: () => number;

  private readonly sleep: (milliseconds: number) => void;

  public constructor(options: ScheduleDetailSerialGateOptions = {}) {
    this.minIntervalMs =
      options.minIntervalMs ?? DEFAULT_SZDATA_SCHEDULE_DETAIL_MIN_INTERVAL_MS;
    if (!Number.isFinite(this.minIntervalMs) || this.minIntervalMs < 0)
      throw new Error("SZDATA_SCHEDULE_DETAIL_MIN_INTERVAL_MUST_BE_NON_NEGATIVE");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleepSynchronously;
  }

  public beforeCall(): void {
    const previous = this.lastCallAt;
    if (previous !== undefined) {
      const remaining = this.minIntervalMs - (this.now() - previous);
      if (remaining > 0) this.sleep(remaining);
    }
    this.lastCallAt = this.now();
  }
}
