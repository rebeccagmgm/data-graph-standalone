import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import {
  canonicalJson,
  sha256,
} from "../machine-facts/machine-facts-contract.ts";

export const DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT =
  "E:\\02_area\\股衍数据-数据cookbook\\sql-static-lineage-cache";
export const SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION = "1.0.0" as const;
export const SCHEDULE_EVIDENCE_CACHE_ARTIFACT_TYPE =
  "HORAE_RELATION_SCHEDULE_EVIDENCE" as const;
export type HoraeRelationDirection = "up" | "down";
export const SCHEDULE_EVIDENCE_CACHE_DIRECTION = "up" as const;
export const SCHEDULE_EVIDENCE_CACHE_DEPTH = 1 as const;
export const SCHEDULE_EVIDENCE_CACHE_FILE_NAME =
  "horae-relation-up-depth-1.json" as const;
export const SCHEDULE_EVIDENCE_DOWN_CACHE_FILE_NAME =
  "horae-relation-down-depth-1.json" as const;
export const HORAE_TASK_TYPE_CACHE_FILE_NAME = "horae-task-type.json" as const;
export const HORAE_TASK_TYPE_CACHE_ARTIFACT_TYPE =
  "HORAE_TASK_TYPE_EVIDENCE" as const;
export const TASK_PARTITION_BINDINGS_CACHE_FILE_NAME =
  "task-partition-bindings.json" as const;
export const TASK_PARTITION_BINDINGS_CACHE_ARTIFACT_TYPE =
  "TASK_PARTITION_BINDINGS_EVIDENCE" as const;

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;

type JsonRecord = Record<string, unknown>;

export type ScheduleEvidenceCacheStatus =
  "HIT" | "MISS" | "INVALID" | "DISABLED";

export interface HoraeRelationCacheDocument {
  readonly schema_version: typeof SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION;
  readonly artifact_type: typeof SCHEDULE_EVIDENCE_CACHE_ARTIFACT_TYPE;
  readonly task_id: string;
  readonly direction: HoraeRelationDirection;
  readonly depth: typeof SCHEDULE_EVIDENCE_CACHE_DEPTH;
  readonly observed_at: string;
  readonly rows: readonly JsonRecord[];
  readonly content_sha256: string;
}

/**
 * The filename is kept for compatibility with the agreed cache layout, but
 * the payload stores the complete normalized `horae detail` JSON row. This
 * lets later type-specific collectors reuse target, SQL, partition, and
 * scheduling fields without issuing another detail request.
 */
export interface HoraeTaskTypeCacheDocument {
  readonly schema_version: typeof SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION;
  readonly artifact_type: typeof HORAE_TASK_TYPE_CACHE_ARTIFACT_TYPE;
  readonly task_id: string;
  readonly observed_at: string;
  readonly detail: JsonRecord;
  readonly content_sha256: string;
}

export type HoraeTaskTypeCacheRead =
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
      readonly detail: JsonRecord;
      readonly observedAt: string;
    };
export type HoraeRelationCacheRead =
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
      readonly rows: readonly JsonRecord[];
      readonly observedAt: string;
    };

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function safeTaskId(taskId: string): void {
  if (!SAFE_TASK_ID.test(taskId)) throw new Error("INVALID_TASK_ID");
}

function cachePayload(
  taskId: string,
  observedAt: string,
  rows: readonly JsonRecord[],
  direction: HoraeRelationDirection,
): Omit<HoraeRelationCacheDocument, "content_sha256"> {
  return {
    schema_version: SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION,
    artifact_type: SCHEDULE_EVIDENCE_CACHE_ARTIFACT_TYPE,
    task_id: taskId,
    direction,
    depth: SCHEDULE_EVIDENCE_CACHE_DEPTH,
    observed_at: observedAt,
    rows,
  };
}

function cacheDocument(
  taskId: string,
  observedAt: string,
  rows: readonly JsonRecord[],
  direction: HoraeRelationDirection,
): HoraeRelationCacheDocument {
  const payload = cachePayload(taskId, observedAt, rows, direction);
  return {
    ...payload,
    content_sha256: sha256(canonicalJson(payload)),
  };
}

function cachePathForRoot(
  cacheRoot: string,
  taskId: string,
  direction: HoraeRelationDirection,
): string {
  safeTaskId(taskId);
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks",
    taskId,
    direction === "up"
      ? SCHEDULE_EVIDENCE_CACHE_FILE_NAME
      : SCHEDULE_EVIDENCE_DOWN_CACHE_FILE_NAME,
  );
}

export function resolveScheduleEvidenceCacheRoot(cacheRoot: string): string {
  const root = resolve(cacheRoot);
  return basename(root).toLowerCase() === "schedule-evidence"
    ? root
    : join(root, "schedule-evidence");
}

function taskTypeCachePathForRoot(cacheRoot: string, taskId: string): string {
  safeTaskId(taskId);
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks",
    taskId,
    HORAE_TASK_TYPE_CACHE_FILE_NAME,
  );
}

export function scheduleEvidenceCachePath(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  direction: HoraeRelationDirection = SCHEDULE_EVIDENCE_CACHE_DIRECTION,
): string {
  return cachePathForRoot(cacheRoot, taskId, direction);
}

export function horaeTaskTypeCachePath(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): string {
  return taskTypeCachePathForRoot(cacheRoot, taskId);
}

function validateRows(value: unknown, taskId: string): JsonRecord[] | null {
  if (!Array.isArray(value)) return null;
  const rows: JsonRecord[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (!row) return null;
    const rowTaskId = nonEmptyString(row.task_id ?? row.taskId);
    if (!rowTaskId || !SAFE_TASK_ID.test(rowTaskId)) return null;
    rows.push(row);
  }
  return rows;
}

function taskTypeCachePayload(
  taskId: string,
  observedAt: string,
  detail: JsonRecord,
): Omit<HoraeTaskTypeCacheDocument, "content_sha256"> {
  return {
    schema_version: SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION,
    artifact_type: HORAE_TASK_TYPE_CACHE_ARTIFACT_TYPE,
    task_id: taskId,
    observed_at: observedAt,
    detail,
  };
}

function taskTypeCacheDocument(
  taskId: string,
  observedAt: string,
  detail: JsonRecord,
): HoraeTaskTypeCacheDocument {
  const payload = taskTypeCachePayload(taskId, observedAt, detail);
  return {
    ...payload,
    content_sha256: sha256(canonicalJson(payload)),
  };
}

function validateDetail(value: unknown): JsonRecord | null {
  return asRecord(value);
}

export function readHoraeTaskTypeCache(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): HoraeTaskTypeCacheRead {
  const path = taskTypeCachePathForRoot(cacheRoot, taskId);
  if (!existsSync(path)) return { status: "MISS", path };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = asRecord(parsed);
    if (!record)
      return { status: "INVALID", path, reason: "ENVELOPE_NOT_OBJECT" };
    if (record.schema_version !== SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION)
      return { status: "INVALID", path, reason: "SCHEMA_VERSION_MISMATCH" };
    if (record.artifact_type !== HORAE_TASK_TYPE_CACHE_ARTIFACT_TYPE)
      return { status: "INVALID", path, reason: "ARTIFACT_TYPE_MISMATCH" };
    if (record.task_id !== taskId)
      return { status: "INVALID", path, reason: "TASK_ID_MISMATCH" };
    const observedAt = nonEmptyString(record.observed_at);
    if (!observedAt)
      return { status: "INVALID", path, reason: "OBSERVED_AT_MISSING" };
    const detail = validateDetail(record.detail);
    if (!detail) return { status: "INVALID", path, reason: "DETAIL_INVALID" };
    if (
      typeof record.content_sha256 !== "string" ||
      !SHA256.test(record.content_sha256)
    )
      return { status: "INVALID", path, reason: "CONTENT_HASH_INVALID" };
    const payload = taskTypeCachePayload(taskId, observedAt, detail);
    if (sha256(canonicalJson(payload)) !== record.content_sha256)
      return { status: "INVALID", path, reason: "CONTENT_HASH_MISMATCH" };
    return { status: "HIT", path, taskId, detail, observedAt };
  } catch (error) {
    return {
      status: "INVALID",
      path,
      reason: error instanceof SyntaxError ? "JSON_INVALID" : "READ_FAILED",
    };
  }
}

export function writeHoraeTaskTypeCache(
  taskId: string,
  observedAt: string,
  detail: JsonRecord,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): string {
  safeTaskId(taskId);
  if (!nonEmptyString(observedAt)) throw new Error("OBSERVED_AT_MISSING");
  if (!validateDetail(detail)) throw new Error("DETAIL_INVALID");
  const path = taskTypeCachePathForRoot(cacheRoot, taskId);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(
      temporaryPath,
      canonicalJson(taskTypeCacheDocument(taskId, observedAt, detail)),
      { encoding: "utf8", flag: "wx" },
    );
    renameSync(temporaryPath, path);
    return path;
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function invalid(path: string, reason: string): HoraeRelationCacheRead {
  return { status: "INVALID", path, reason };
}

export function readHoraeRelationCache(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  direction: HoraeRelationDirection = SCHEDULE_EVIDENCE_CACHE_DIRECTION,
): HoraeRelationCacheRead {
  const path = cachePathForRoot(cacheRoot, taskId, direction);
  if (!existsSync(path)) return { status: "MISS", path };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = asRecord(parsed);
    if (!record) return invalid(path, "ENVELOPE_NOT_OBJECT");
    if (record.schema_version !== SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION)
      return invalid(path, "SCHEMA_VERSION_MISMATCH");
    if (record.artifact_type !== SCHEDULE_EVIDENCE_CACHE_ARTIFACT_TYPE)
      return invalid(path, "ARTIFACT_TYPE_MISMATCH");
    if (record.task_id !== taskId) return invalid(path, "TASK_ID_MISMATCH");
    if (record.direction !== direction)
      return invalid(path, "DIRECTION_MISMATCH");
    if (record.depth !== SCHEDULE_EVIDENCE_CACHE_DEPTH)
      return invalid(path, "DEPTH_MISMATCH");
    const observedAt = nonEmptyString(record.observed_at);
    if (!observedAt) return invalid(path, "OBSERVED_AT_MISSING");
    const rows = validateRows(record.rows, taskId);
    if (!rows) return invalid(path, "ROWS_INVALID");
    if (
      typeof record.content_sha256 !== "string" ||
      !SHA256.test(record.content_sha256)
    )
      return invalid(path, "CONTENT_HASH_INVALID");
    const payload = cachePayload(taskId, observedAt, rows, direction);
    if (sha256(canonicalJson(payload)) !== record.content_sha256)
      return invalid(path, "CONTENT_HASH_MISMATCH");
    return { status: "HIT", path, taskId, rows, observedAt };
  } catch (error) {
    return invalid(
      path,
      error instanceof SyntaxError ? "JSON_INVALID" : "READ_FAILED",
    );
  }
}

export interface TaskPartitionBindingsCacheDocument {
  readonly schema_version: typeof SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION;
  readonly artifact_type: typeof TASK_PARTITION_BINDINGS_CACHE_ARTIFACT_TYPE;
  readonly task_id: string;
  readonly observed_at: string;
  readonly bindings: JsonRecord;
  readonly content_sha256: string;
}

export type TaskPartitionBindingsCacheRead =
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
      readonly bindings: JsonRecord;
      readonly observedAt: string;
    };

function partitionBindingsCachePathForRoot(
  cacheRoot: string,
  taskId: string,
): string {
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks",
    taskId,
    TASK_PARTITION_BINDINGS_CACHE_FILE_NAME,
  );
}

function partitionBindingsCachePayload(
  taskId: string,
  observedAt: string,
  bindings: JsonRecord,
): Omit<TaskPartitionBindingsCacheDocument, "content_sha256"> {
  return {
    schema_version: SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION,
    artifact_type: TASK_PARTITION_BINDINGS_CACHE_ARTIFACT_TYPE,
    task_id: taskId,
    observed_at: observedAt,
    bindings,
  };
}

function partitionBindingsCacheDocument(
  taskId: string,
  observedAt: string,
  bindings: JsonRecord,
): TaskPartitionBindingsCacheDocument {
  const payload = partitionBindingsCachePayload(taskId, observedAt, bindings);
  return {
    ...payload,
    content_sha256: sha256(canonicalJson(payload)),
  };
}

function validateBindings(bindings: JsonRecord): boolean {
  return Object.values(bindings).every(
    (value) => typeof value === "string" && value.trim() !== "",
  );
}

export function readTaskPartitionBindingsCache(
  taskId: string,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): TaskPartitionBindingsCacheRead {
  const path = partitionBindingsCachePathForRoot(cacheRoot, taskId);
  if (!existsSync(path)) return { status: "MISS", path };
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
    const bindingsRecord = asRecord(record.bindings);
    if (
      record.schema_version !== SCHEDULE_EVIDENCE_CACHE_SCHEMA_VERSION ||
      record.artifact_type !== TASK_PARTITION_BINDINGS_CACHE_ARTIFACT_TYPE ||
      record.task_id !== taskId ||
      typeof record.observed_at !== "string" ||
      typeof record.content_sha256 !== "string" ||
      !SHA256.test(record.content_sha256) ||
      !bindingsRecord ||
      !validateBindings(bindingsRecord)
    )
      return { status: "INVALID", path, reason: "ENVELOPE_INVALID" };
    const bindings = bindingsRecord;
    const payload = partitionBindingsCachePayload(
      taskId,
      record.observed_at,
      bindings,
    );
    if (sha256(canonicalJson(payload)) !== record.content_sha256)
      return { status: "INVALID", path, reason: "CONTENT_HASH_MISMATCH" };
    return {
      status: "HIT",
      path,
      taskId,
      bindings,
      observedAt: record.observed_at,
    };
  } catch (error) {
    return {
      status: "INVALID",
      path,
      reason: error instanceof SyntaxError ? "JSON_INVALID" : "READ_FAILED",
    };
  }
}

export function writeTaskPartitionBindingsCache(
  taskId: string,
  observedAt: string,
  bindings: JsonRecord,
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): string {
  safeTaskId(taskId);
  if (!nonEmptyString(observedAt)) throw new Error("OBSERVED_AT_MISSING");
  if (!validateBindings(bindings)) throw new Error("BINDINGS_INVALID");
  const path = partitionBindingsCachePathForRoot(cacheRoot, taskId);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(
      temporaryPath,
      canonicalJson(partitionBindingsCacheDocument(taskId, observedAt, bindings)),
      { encoding: "utf8", flag: "wx" },
    );
    renameSync(temporaryPath, path);
    return path;
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

export function writeHoraeRelationCache(
  taskId: string,
  observedAt: string,
  rows: readonly JsonRecord[],
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  direction: HoraeRelationDirection = SCHEDULE_EVIDENCE_CACHE_DIRECTION,
): string {
  safeTaskId(taskId);
  if (!nonEmptyString(observedAt)) throw new Error("OBSERVED_AT_MISSING");
  if (!validateRows(rows, taskId)) throw new Error("ROWS_INVALID");
  const path = cachePathForRoot(cacheRoot, taskId, direction);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(
      temporaryPath,
      canonicalJson(cacheDocument(taskId, observedAt, rows, direction)),
      { encoding: "utf8", flag: "wx" },
    );
    renameSync(temporaryPath, path);
    return path;
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}
