import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { validateWriteColumnEvidence, type TaskWriteColumnEvidence } from "./write-column-evidence.ts";

export const INPUT_PACK_SCHEMA_VERSION = "1.0.0" as const;
export const SQL_SLOTS = [
  "create",
  "query",
  "prepare",
  "truncate",
  "finish",
] as const;
export type SqlSlot = (typeof SQL_SLOTS)[number];

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export interface SqlSlotEvidence {
  readonly content: string;
  readonly evidenceProvider?: string;
}

/**
 * Evidence returned by task-source when the configured original script is
 * fetched. Script parameters describe scheduler/code configuration; they are
 * deliberately not a partition map or a rendered runtime invocation.
 */
export interface TaskCodeEvidence {
  readonly status: string;
  readonly codePathStatus?: string;
  readonly codePath?: string;
  readonly scriptParams?: string;
  readonly repository?: string;
  readonly repositoryPath?: string;
  readonly commit?: string;
  readonly evidenceProvider: string;
}

export interface TaskSchedulerEvidence {
  readonly hivePartition?: string;
  readonly evidenceProvider: string;
}

export type TaskPartitionMap = Readonly<Record<string, string>>;
export type TaskPartitionValue = TaskPartitionMap | readonly TaskPartitionMap[];

export type TaskPartitionStatus =
  "NOT_PARTITIONED" | "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | "CONFLICT";

export type TaskPartitionAssignmentStatus =
  "CONFIRMED" | "RUNTIME_EXPRESSION" | "UNKNOWN" | "CONFLICT";

export interface TaskPartitionEvidenceRef {
  readonly source:
    "TABLE_PACK" | "INPUT_PACK_SQL" | "SCHEDULER_CONFIG" | "CODE_EVIDENCE";
  readonly locator: string;
  readonly detail?: string;
}

export interface TaskPartitionAssignment {
  readonly field: string;
  readonly expression: string | null;
  readonly value: string | null;
  readonly status: TaskPartitionAssignmentStatus;
  readonly mappingMethod:
    | "STATIC_SQL_ASSIGNMENT"
    | "DYNAMIC_PARTITION_OUTPUT_ORDINAL"
    | "SCHEDULER_EXPLICIT_FIELD_VALUE"
    | "UNKNOWN"
    | "CONFLICT";
  readonly evidence: readonly TaskPartitionEvidenceRef[];
  readonly reason?: string;
}

export interface TaskPartitionWrite {
  readonly target: string;
  readonly sqlSlot: SqlSlot | null;
  readonly statementOrdinal: number | null;
  /** Character offsets within the source SQL slot for an explicit write. */
  readonly statementSpan?: { readonly start: number; readonly end: number };
  readonly mode: "STATIC" | "DYNAMIC" | "MIXED" | "NONE" | "UNKNOWN";
  readonly status: TaskPartitionStatus;
  readonly assignments: readonly TaskPartitionAssignment[];
  /** Internal-only complete assignment sets for multiple SQL write branches. */
  readonly assignmentVariants?: readonly (readonly TaskPartitionAssignment[])[];
  readonly evidence: readonly TaskPartitionEvidenceRef[];
  readonly reasonCodes: readonly string[];
}

export interface TaskPartitionTarget {
  readonly target: string;
  readonly tableStatus: "PARTITIONED" | "NOT_PARTITIONED" | "UNKNOWN";
  readonly fields: readonly string[];
  readonly status: TaskPartitionStatus;
  readonly writes: readonly TaskPartitionWrite[];
  readonly reasonCodes: readonly string[];
}

export interface TaskPartitionEvidence {
  readonly status: TaskPartitionStatus;
  readonly targets: readonly TaskPartitionTarget[];
  readonly reasonCodes: readonly string[];
}

export interface TaskEvidence {
  readonly taskId: string;
  readonly taskCategory?: string | null;
  readonly taskType?: string | null;
  readonly taskName?: string | null;
  readonly topicName?: string | null;
  /** Direct Horae scheduling-cycle label, when available. */
  readonly scheduleCycle?: string | null;
  /** Direct Horae task-status code/label, when available. */
  readonly scheduleStatus?: string | null;
  /**
   * Direct one-hop Horae upstream task IDs (schedule neighbors).
   * Present only when up-relation evidence is proven; empty means no upstream.
   */
  readonly upstreamTaskIds?: readonly string[];
  /**
   * Direct one-hop Horae downstream task IDs (schedule neighbors).
   * Present only when down-relation evidence is proven; empty means no downstream.
   */
  readonly downstreamTaskIds?: readonly string[];
  /** Direct platform endpoint config; table endpoints may include dataSource. */
  readonly source?: JsonValue | null;
  /** Direct platform endpoint config; table endpoints may include dataSource. */
  readonly target?: JsonValue | null;
  /** Internal-only exact RDBMS identity hints derived from unique Horae servers. */
  readonly endpointDataSourceHints?: {
    readonly source?: string;
    readonly target?: string;
  };
  /** Explains the evidence level of a populated target endpoint. */
  readonly targetEvidenceKind?:
    | "DIRECT_PLATFORM_TARGET"
    | "TABLE_TASK_RELATION_DIRECTION_UNKNOWN"
    | "SQL_EXACT_TABLE_TARGET"
    | null;
  readonly writeMode?: string | null;
  /** Confirmed target partition values; arrays preserve multiple partition instances. */
  readonly partition?: TaskPartitionValue | null;
  readonly schedulerEvidence?: TaskSchedulerEvidence;
  readonly codeEvidence?: TaskCodeEvidence;
  readonly writeColumnEvidence?: TaskWriteColumnEvidence;
  readonly sql?: Partial<Record<SqlSlot, SqlSlotEvidence | string | null>>;
  readonly evidenceProvider?: string;
  readonly collectedAt?: string;
}

export function isManualScheduleCycle(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["手工", "手动", "manual"].includes(value.trim().toLowerCase())
  );
}

export function isFrozenScheduleStatus(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["F", "冻结", "FROZEN"].includes(value.trim().toUpperCase())
  );
}

export interface TableEvidence {
  readonly guid?: string | null;
  readonly platform: string;
  readonly dataSource: string;
  readonly qualifiedName: string;
  readonly schema?: string | null;
  readonly name?: string | null;
  /** Platform-supplied display description; never used for identity. */
  readonly description?: string | null;
  readonly objectType: string;
  readonly status?: string | null;
  readonly primaryKey?: readonly string[] | null;
  readonly partitionFields?: readonly string[] | null;
  readonly ddl: string;
  readonly evidenceProvider: string;
  readonly collectedAt?: string;
}

export interface TaskDocument extends JsonObject {
  readonly schemaVersion: typeof INPUT_PACK_SCHEMA_VERSION;
  readonly taskId: string;
  readonly taskCategory: string;
  readonly sqlFiles: JsonValue[];
  readonly collectedAt: string;
  readonly contentHash: string;
}

export interface TableDocument extends JsonObject {
  readonly schemaVersion: typeof INPUT_PACK_SCHEMA_VERSION;
  readonly stableTableId: string;
  readonly platform: string;
  readonly dataSource: string;
  readonly qualifiedName: string;
  readonly objectType: string;
  readonly ddlFile: JsonObject;
  readonly collectedAt: string;
  readonly contentHash: string;
}

export interface WriteResult {
  readonly changed: boolean;
  readonly directory: string;
  readonly contentHash: string;
  readonly stableTableId?: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_DERIVED_FIELDS = new Set([
  "inputs",
  "outputs",
  "tableRef",
  "statementRole",
  "statement_role",
  "lineage",
  "fieldLineage",
  "field_lineage",
  "processingRelation",
  "processing_relation",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Input Pack validation failed: ${message}`);
}

function requireNonEmpty(
  value: string | null | undefined,
  field: string,
): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim() === "-")
    fail(`${field} must be a non-empty string`);
  return value;
}

function requireOptionalNonEmpty(
  value: string | null | undefined,
  field: string,
): void {
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "string" || value.trim() === "" || value.trim() === "-")
  ) {
    fail(`${field} must be omitted, null, or a non-empty string`);
  }
}

function validateTaskPartitionValue(
  value: unknown,
  field = "task.partition",
): asserts value is TaskPartitionValue {
  const maps = Array.isArray(value) ? value : [value];
  if (maps.length === 0) fail(`${field} must not be an empty array`);
  for (const [index, map] of maps.entries()) {
    const mapField = Array.isArray(value) ? `${field}[${index}]` : field;
    if (!isObject(map) || Object.keys(map).length === 0)
      fail(`${mapField} must be a non-empty object`);
    for (const [key, partitionValue] of Object.entries(map)) {
      requireNonEmpty(key, "partition key");
      if (typeof partitionValue !== "string")
        fail(`${mapField}.${key} must be a string`);
      requireNonEmpty(partitionValue, `${mapField}.${key}`);
    }
  }
}

function safeSegment(value: string, field: string): string {
  requireNonEmpty(value, field);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) ||
    /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i.test(value)
  ) {
    fail(`${field} is not a safe path segment`);
  }
  return value;
}

function safePlatformToken(value: string, field: string): string {
  requireNonEmpty(value, field);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value))
    fail(`${field} must be a standard platform token`);
  return value;
}

function safeTableStableId(value: string): string {
  requireNonEmpty(value, "stableTableId");
  if (
    value.length > 240 ||
    value === "." ||
    value === ".." ||
    /[\\/:*?"<>|\u0000-\u001f]/.test(value) ||
    /[. ]$/.test(value)
  )
    fail(
      "stableTableId contains characters that cannot be used as a directory name",
    );
  return value;
}

function validateJson(
  value: unknown,
  path: string,
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail(`${path} must contain finite JSON numbers`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJson(item, `${path}[${index}]`));
    return;
  }
  if (isObject(value)) {
    Object.entries(value).forEach(([key, item]) => {
      if (item === undefined) fail(`${path}.${key} cannot be undefined`);
      validateJson(item, `${path}.${key}`);
    });
    return;
  }
  fail(`${path} is not JSON serializable`);
}

function validateNoPlaceholders(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value.trim() === "" || value.trim() === "-")
      fail(`${path} cannot use an empty string or '-' placeholder`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateNoPlaceholders(item, `${path}[${index}]`),
    );
    return;
  }
  if (isObject(value)) {
    Object.entries(value).forEach(([key, item]) =>
      validateNoPlaceholders(item, `${path}.${key}`),
    );
  }
}

export function validateTaskCodeEvidence(
  value: unknown,
  field = "task.codeEvidence",
): asserts value is TaskCodeEvidence {
  if (!isObject(value)) fail(`${field} must be an object`);
  const allowed = new Set([
    "status",
    "codePathStatus",
    "codePath",
    "scriptParams",
    "repository",
    "repositoryPath",
    "commit",
    "evidenceProvider",
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(`${field}.${key} is not allowed`);
  if (typeof value.status !== "string")
    fail(`${field}.status must be a string`);
  requireNonEmpty(value.status, `${field}.status`);
  for (const key of [
    "codePathStatus",
    "codePath",
    "scriptParams",
    "repository",
    "repositoryPath",
    "commit",
    "evidenceProvider",
  ])
    requireOptionalNonEmpty(
      value[key] as string | null | undefined,
      `${field}.${key}`,
    );
  if (value.evidenceProvider === undefined || value.evidenceProvider === null)
    fail(`${field}.evidenceProvider is required`);
}

function validatePartitionEvidenceRef(
  value: unknown,
  field: string,
): asserts value is TaskPartitionEvidenceRef {
  if (!isObject(value)) fail(`${field} must be an object`);
  const allowed = new Set(["source", "locator", "detail"]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(`${field}.${key} is not allowed`);
  if (
    ![
      "TABLE_PACK",
      "INPUT_PACK_SQL",
      "SCHEDULER_CONFIG",
      "CODE_EVIDENCE",
    ].includes(String(value.source))
  )
    fail(`${field}.source is invalid`);
  requireNonEmpty(String(value.locator), `${field}.locator`);
  requireOptionalNonEmpty(
    value.detail as string | undefined,
    `${field}.detail`,
  );
}

function validateTaskPartitionEvidence(
  value: unknown,
  field = "task.partition",
): asserts value is TaskPartitionEvidence {
  if (!isObject(value)) fail(`${field} must be an object`);
  const allowed = new Set(["status", "targets", "reasonCodes"]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(`${field}.${key} is not allowed`);
  const statuses: readonly TaskPartitionStatus[] = [
    "NOT_PARTITIONED",
    "COMPLETE",
    "INCOMPLETE",
    "UNKNOWN",
    "CONFLICT",
  ];
  if (!statuses.includes(value.status as TaskPartitionStatus))
    fail(`${field}.status is invalid`);
  if (!Array.isArray(value.targets)) fail(`${field}.targets must be an array`);
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.length === 0)
    fail(`${field}.reasonCodes must be a non-empty array`);
  value.reasonCodes.forEach((reason, index) =>
    requireNonEmpty(String(reason), `${field}.reasonCodes[${index}]`),
  );
  (value.targets as unknown[]).forEach((rawTarget, targetIndex) => {
    const targetField = `${field}.targets[${targetIndex}]`;
    if (!isObject(rawTarget)) fail(`${targetField} must be an object`);
    const targetAllowed = new Set([
      "target",
      "tableStatus",
      "fields",
      "status",
      "writes",
      "reasonCodes",
    ]);
    for (const key of Object.keys(rawTarget))
      if (!targetAllowed.has(key)) fail(`${targetField}.${key} is not allowed`);
    requireNonEmpty(String(rawTarget.target), `${targetField}.target`);
    if (
      rawTarget.tableStatus !== "PARTITIONED" &&
      rawTarget.tableStatus !== "NOT_PARTITIONED" &&
      rawTarget.tableStatus !== "UNKNOWN"
    )
      fail(`${targetField}.tableStatus is invalid`);
    if (!Array.isArray(rawTarget.fields))
      fail(`${targetField}.fields must be an array`);
    rawTarget.fields.forEach((fieldName, fieldIndex) =>
      requireNonEmpty(
        String(fieldName),
        `${targetField}.fields[${fieldIndex}]`,
      ),
    );
    if (!statuses.includes(rawTarget.status as TaskPartitionStatus))
      fail(`${targetField}.status is invalid`);
    if (!Array.isArray(rawTarget.writes))
      fail(`${targetField}.writes must be an array`);
    if (
      !Array.isArray(rawTarget.reasonCodes) ||
      rawTarget.reasonCodes.length === 0
    )
      fail(`${targetField}.reasonCodes must be a non-empty array`);
    rawTarget.reasonCodes.forEach((reason, reasonIndex) =>
      requireNonEmpty(
        String(reason),
        `${targetField}.reasonCodes[${reasonIndex}]`,
      ),
    );
    (rawTarget.writes as unknown[]).forEach((rawWrite, writeIndex) => {
      const writeField = `${targetField}.writes[${writeIndex}]`;
      if (!isObject(rawWrite)) fail(`${writeField} must be an object`);
      const writeAllowed = new Set([
        "target",
        "sqlSlot",
        "statementOrdinal",
        "mode",
        "status",
        "assignments",
        "evidence",
        "reasonCodes",
      ]);
      for (const key of Object.keys(rawWrite))
        if (!writeAllowed.has(key)) fail(`${writeField}.${key} is not allowed`);
      requireNonEmpty(String(rawWrite.target), `${writeField}.target`);
      if (
        rawWrite.sqlSlot !== null &&
        !(SQL_SLOTS as readonly unknown[]).includes(rawWrite.sqlSlot)
      )
        fail(`${writeField}.sqlSlot is invalid`);
      if (
        rawWrite.statementOrdinal !== null &&
        (!Number.isInteger(rawWrite.statementOrdinal) ||
          Number(rawWrite.statementOrdinal) < 1)
      )
        fail(`${writeField}.statementOrdinal is invalid`);
      if (
        !["STATIC", "DYNAMIC", "MIXED", "NONE", "UNKNOWN"].includes(
          String(rawWrite.mode),
        )
      )
        fail(`${writeField}.mode is invalid`);
      if (!statuses.includes(rawWrite.status as TaskPartitionStatus))
        fail(`${writeField}.status is invalid`);
      if (!Array.isArray(rawWrite.assignments))
        fail(`${writeField}.assignments must be an array`);
      if (!Array.isArray(rawWrite.evidence) || rawWrite.evidence.length === 0)
        fail(`${writeField}.evidence must be a non-empty array`);
      rawWrite.evidence.forEach((item, evidenceIndex) =>
        validatePartitionEvidenceRef(
          item,
          `${writeField}.evidence[${evidenceIndex}]`,
        ),
      );
      if (
        !Array.isArray(rawWrite.reasonCodes) ||
        rawWrite.reasonCodes.length === 0
      )
        fail(`${writeField}.reasonCodes must be a non-empty array`);
      rawWrite.reasonCodes.forEach((reason, reasonIndex) =>
        requireNonEmpty(
          String(reason),
          `${writeField}.reasonCodes[${reasonIndex}]`,
        ),
      );
      (rawWrite.assignments as unknown[]).forEach(
        (rawAssignment, assignmentIndex) => {
          const assignmentField = `${writeField}.assignments[${assignmentIndex}]`;
          if (!isObject(rawAssignment))
            fail(`${assignmentField} must be an object`);
          const assignmentAllowed = new Set([
            "field",
            "expression",
            "value",
            "status",
            "mappingMethod",
            "evidence",
            "reason",
          ]);
          for (const key of Object.keys(rawAssignment))
            if (!assignmentAllowed.has(key))
              fail(`${assignmentField}.${key} is not allowed`);
          requireNonEmpty(
            String(rawAssignment.field),
            `${assignmentField}.field`,
          );
          if (
            rawAssignment.expression !== null &&
            typeof rawAssignment.expression !== "string"
          )
            fail(`${assignmentField}.expression must be a string or null`);
          if (
            rawAssignment.value !== null &&
            typeof rawAssignment.value !== "string"
          )
            fail(`${assignmentField}.value must be a string or null`);
          if (
            ![
              "CONFIRMED",
              "RUNTIME_EXPRESSION",
              "UNKNOWN",
              "CONFLICT",
            ].includes(String(rawAssignment.status))
          )
            fail(`${assignmentField}.status is invalid`);
          if (
            ![
              "STATIC_SQL_ASSIGNMENT",
              "DYNAMIC_PARTITION_OUTPUT_ORDINAL",
              "SCHEDULER_EXPLICIT_FIELD_VALUE",
              "UNKNOWN",
              "CONFLICT",
            ].includes(String(rawAssignment.mappingMethod))
          )
            fail(`${assignmentField}.mappingMethod is invalid`);
          if (
            !Array.isArray(rawAssignment.evidence) ||
            rawAssignment.evidence.length === 0
          )
            fail(`${assignmentField}.evidence must be a non-empty array`);
          if (
            rawAssignment.status === "CONFIRMED" &&
            (typeof rawAssignment.expression !== "string" ||
              typeof rawAssignment.value !== "string")
          )
            fail(`${assignmentField} CONFIRMED requires expression and value`);
          if (
            rawAssignment.status === "RUNTIME_EXPRESSION" &&
            (typeof rawAssignment.expression !== "string" ||
              rawAssignment.value !== null)
          )
            fail(
              `${assignmentField} RUNTIME_EXPRESSION requires expression and null value`,
            );
          if (
            (rawAssignment.status === "UNKNOWN" ||
              rawAssignment.status === "CONFLICT") &&
            rawAssignment.value !== null
          )
            fail(
              `${assignmentField} ${rawAssignment.status} requires null value`,
            );
          rawAssignment.evidence.forEach((item, evidenceIndex) =>
            validatePartitionEvidenceRef(
              item,
              `${assignmentField}.evidence[${evidenceIndex}]`,
            ),
          );
          requireOptionalNonEmpty(
            rawAssignment.reason as string | undefined,
            `${assignmentField}.reason`,
          );
        },
      );
    });
  });
}

function validateTaskSchedulerEvidence(
  value: unknown,
): asserts value is TaskSchedulerEvidence {
  if (!isObject(value)) fail("task.schedulerEvidence must be an object");
  const allowed = new Set(["hivePartition", "evidenceProvider"]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(`task.schedulerEvidence.${key} is not allowed`);
  requireOptionalNonEmpty(
    value.hivePartition as string | undefined,
    "task.schedulerEvidence.hivePartition",
  );
  requireNonEmpty(
    String(value.evidenceProvider),
    "task.schedulerEvidence.evidenceProvider",
  );
}

const SAFE_SCHEDULE_NEIGHBOR_TASK_ID =
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function canonicalizeScheduleNeighborTaskIds(
  value: readonly string[],
  field: string,
  selfTaskId?: string,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || raw.trim() === "")
      fail(`task.${field} entries must be non-empty strings`);
    const taskId = raw.trim();
    if (!SAFE_SCHEDULE_NEIGHBOR_TASK_ID.test(taskId))
      fail(`task.${field} has an invalid taskId`);
    if (selfTaskId !== undefined && taskId === selfTaskId) continue;
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    ids.push(taskId);
  }
  return ids.sort((left, right) =>
    left.localeCompare(right, "en-US", { numeric: true }),
  );
}

function validateScheduleNeighborTaskIds(
  value: unknown,
  field: "upstreamTaskIds" | "downstreamTaskIds",
  selfTaskId: string,
): asserts value is readonly string[] {
  if (!Array.isArray(value)) fail(`task.${field} must be an array`);
  const canonical = canonicalizeScheduleNeighborTaskIds(
    value as readonly string[],
    field,
    selfTaskId,
  );
  if (value.length !== canonical.length)
    fail(`task.${field} must be unique and must not include the task itself`);
  for (let index = 0; index < canonical.length; index += 1) {
    if (value[index] !== canonical[index])
      fail(`task.${field} must be sorted uniquely`);
  }
}

function isStructuredTaskPartitionEvidence(
  value: unknown,
): value is TaskPartitionEvidence {
  return (
    isObject(value) &&
    typeof value.status === "string" &&
    Array.isArray(value.targets) &&
    Array.isArray(value.reasonCodes)
  );
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

export function canonicalHash(
  value: JsonValue,
  excludedFields: readonly string[] = [],
): string {
  if (!isObject(value)) fail("canonicalHash requires a JSON object");
  const excluded = new Set(excludedFields);
  const filtered: JsonObject = {};
  for (const [key, item] of Object.entries(value))
    if (!excluded.has(key)) filtered[key] = item as JsonValue;
  return sha256Text(canonicalJson(filtered));
}

export function stableTableId(
  evidence: Pick<
    TableEvidence,
    "guid" | "platform" | "dataSource" | "qualifiedName"
  >,
): { stableTableId: string; guid?: string } {
  const guid =
    evidence.guid === undefined || evidence.guid === null
      ? undefined
      : requireNonEmpty(evidence.guid, "guid");
  safePlatformToken(evidence.platform, "platform");
  const dataSource = requireNonEmpty(evidence.dataSource, "dataSource");
  const qualifiedName = requireNonEmpty(
    evidence.qualifiedName,
    "qualifiedName",
  );
  return {
    stableTableId: safeTableStableId(`${qualifiedName}__${dataSource}`),
    ...(guid === undefined ? {} : { guid }),
  };
}

function collectAt(value: string | undefined): string {
  return value ?? new Date().toISOString();
}

function validateForbiddenFields(document: Record<string, unknown>): void {
  for (const key of Object.keys(document))
    if (FORBIDDEN_DERIVED_FIELDS.has(key))
      fail(`derived field ${key} is not allowed in Task/Table documents`);
}

function validateHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value))
    fail(`${field} must be a lowercase SHA-256`);
}

function buildTaskDocument(evidence: TaskEvidence): {
  document: TaskDocument;
  sql: readonly { slot: SqlSlot; content: string; evidenceProvider: string }[];
} {
  const taskId = safeSegment(evidence.taskId, "taskId");
  const document: JsonObject = {
    schemaVersion: INPUT_PACK_SCHEMA_VERSION,
    taskId,
    sqlFiles: [],
    collectedAt: collectAt(evidence.collectedAt),
  };
  for (const [key, value] of Object.entries({
    taskCategory: evidence.taskCategory,
    taskType: evidence.taskType,
    taskName: evidence.taskName,
    topicName: evidence.topicName,
    scheduleCycle: evidence.scheduleCycle,
    scheduleStatus: evidence.scheduleStatus,
    source: evidence.source,
    target: evidence.target,
    targetEvidenceKind: evidence.targetEvidenceKind,
    writeMode: evidence.writeMode,
    partition: evidence.partition,
    schedulerEvidence: evidence.schedulerEvidence,
    codeEvidence: evidence.codeEvidence,
    writeColumnEvidence: evidence.writeColumnEvidence,
    evidenceProvider: evidence.evidenceProvider,
  })) {
    if (value !== undefined) document[key] = value as JsonValue;
  }
  if (evidence.upstreamTaskIds !== undefined) {
    document.upstreamTaskIds = canonicalizeScheduleNeighborTaskIds(
      evidence.upstreamTaskIds,
      "upstreamTaskIds",
      taskId,
    );
  }
  if (evidence.downstreamTaskIds !== undefined) {
    document.downstreamTaskIds = canonicalizeScheduleNeighborTaskIds(
      evidence.downstreamTaskIds,
      "downstreamTaskIds",
      taskId,
    );
  }
  validateJson(document, "task");
  if (document.source !== undefined && document.source !== null)
    validateNoPlaceholders(document.source, "task.source");
  if (document.target !== undefined && document.target !== null)
    validateNoPlaceholders(document.target, "task.target");
  for (const field of [
    "taskCategory",
    "taskType",
    "taskName",
    "topicName",
    "scheduleCycle",
    "scheduleStatus",
    "writeMode",
    "evidenceProvider",
  ])
    requireOptionalNonEmpty(
      document[field] as string | null | undefined,
      `task.${field}`,
    );
  if (document.partition !== undefined && document.partition !== null) {
    validateTaskPartitionValue(document.partition);
  }
  if (document.schedulerEvidence !== undefined)
    validateTaskSchedulerEvidence(document.schedulerEvidence);
  if (document.codeEvidence !== undefined)
    validateTaskCodeEvidence(document.codeEvidence);
  if (document.upstreamTaskIds !== undefined)
    validateScheduleNeighborTaskIds(
      document.upstreamTaskIds,
      "upstreamTaskIds",
      taskId,
    );
  if (document.downstreamTaskIds !== undefined)
    validateScheduleNeighborTaskIds(
      document.downstreamTaskIds,
      "downstreamTaskIds",
      taskId,
    );
  const sql: { slot: SqlSlot; content: string; evidenceProvider: string }[] =
    [];
  for (const slot of SQL_SLOTS) {
    const raw = evidence.sql?.[slot];
    if (raw === undefined || raw === null) continue;
    const content = typeof raw === "string" ? raw : raw.content;
    const evidenceProvider =
      typeof raw === "string"
        ? evidence.evidenceProvider
        : (raw.evidenceProvider ?? evidence.evidenceProvider);
    requireNonEmpty(content, `sql.${slot}`);
    const provider = requireNonEmpty(
      evidenceProvider,
      `sql.${slot}.evidenceProvider`,
    );
    sql.push({ slot, content, evidenceProvider: provider });
  }
  return { document: document as TaskDocument, sql };
}

export function createTaskDocument(evidence: TaskEvidence): TaskDocument {
  const built = buildTaskDocument(evidence);
  const sqlFiles = built.sql.map(({ slot, content, evidenceProvider }) => ({
    slot,
    path: `sql/${slot}.sql`,
    sha256: sha256Text(content),
    evidenceProvider,
  }));
  const withoutHash = { ...built.document, sqlFiles } as JsonObject;
  const document = {
    ...withoutHash,
    contentHash: canonicalHash(withoutHash, ["collectedAt", "contentHash"]),
  } as TaskDocument;
  validateTaskDocument(document);
  return document;
}

export function validateTaskDocument(
  document: unknown,
): asserts document is TaskDocument {
  if (!isObject(document)) fail("task document must be an object");
  validateForbiddenFields(document);
  const allowed = new Set([
    "schemaVersion",
    "taskId",
    "taskCategory",
    "taskType",
    "taskName",
    "topicName",
    "scheduleCycle",
    "scheduleStatus",
    "upstreamTaskIds",
    "downstreamTaskIds",
    "source",
    "target",
    "targetEvidenceKind",
    "writeMode",
    "partition",
    "schedulerEvidence",
    "codeEvidence",
    "writeColumnEvidence",
    "sqlFiles",
    "evidenceProvider",
    "collectedAt",
    "contentHash",
  ]);
  for (const key of Object.keys(document))
    if (!allowed.has(key)) fail(`unknown task field ${key}`);
  if (document.writeColumnEvidence !== undefined) validateWriteColumnEvidence(document.writeColumnEvidence);
  if (document.schemaVersion !== INPUT_PACK_SCHEMA_VERSION)
    fail("unsupported task schemaVersion");
  safeSegment(String(document.taskId), "taskId");
  safeSegment(String(document.taskCategory), "taskCategory");
  if (document.upstreamTaskIds !== undefined)
    validateScheduleNeighborTaskIds(
      document.upstreamTaskIds,
      "upstreamTaskIds",
      String(document.taskId),
    );
  if (document.downstreamTaskIds !== undefined)
    validateScheduleNeighborTaskIds(
      document.downstreamTaskIds,
      "downstreamTaskIds",
      String(document.taskId),
    );
  if (!Array.isArray(document.sqlFiles)) fail("task.sqlFiles must be an array");
  const seen = new Set<string>();
  for (const item of document.sqlFiles) {
    if (!isObject(item)) fail("task.sqlFiles entries must be objects");
    const slot = item.slot;
    if (
      typeof slot !== "string" ||
      !(SQL_SLOTS as readonly string[]).includes(slot) ||
      seen.has(slot)
    )
      fail("task.sqlFiles has an invalid or duplicate slot");
    seen.add(slot);
    if (item.path !== `sql/${slot}.sql`)
      fail(`task.sqlFiles.${slot}.path is invalid`);
    validateHash(item.sha256, `task.sqlFiles.${slot}.sha256`);
    requireNonEmpty(
      String(item.evidenceProvider),
      `task.sqlFiles.${slot}.evidenceProvider`,
    );
  }
  for (const field of [
    "taskCategory",
    "taskType",
    "scheduleCycle",
    "scheduleStatus",
    "writeMode",
    "evidenceProvider",
  ])
    requireOptionalNonEmpty(
      document[field] as string | null | undefined,
      `task.${field}`,
    );
  if (document.partition !== undefined && document.partition !== null) {
    validateTaskPartitionValue(document.partition);
  }
  if (document.schedulerEvidence !== undefined)
    validateTaskSchedulerEvidence(document.schedulerEvidence);
  if (document.codeEvidence !== undefined)
    validateTaskCodeEvidence(document.codeEvidence);
  if (
    document.targetEvidenceKind !== undefined &&
    document.targetEvidenceKind !== null &&
    document.targetEvidenceKind !== "DIRECT_PLATFORM_TARGET" &&
    document.targetEvidenceKind !== "TABLE_TASK_RELATION_DIRECTION_UNKNOWN" &&
    document.targetEvidenceKind !== "SQL_EXACT_TABLE_TARGET"
  )
    fail("task.targetEvidenceKind is invalid");
  if (document.targetEvidenceKind === "DIRECT_PLATFORM_TARGET") {
    if (document.target === undefined || document.target === null)
      fail("task.targetEvidenceKind DIRECT_PLATFORM_TARGET requires target");
  }
  if (document.targetEvidenceKind === "TABLE_TASK_RELATION_DIRECTION_UNKNOWN") {
    const target = document.target;
    if (
      !isObject(target) ||
      ["platform", "qualifiedName", "dataSource"].some(
        (field) =>
          typeof target[field] !== "string" || target[field].trim() === "",
      )
    )
      fail(
        "task.targetEvidenceKind TABLE_TASK_RELATION_DIRECTION_UNKNOWN requires a physical target",
      );
    if (
      typeof document.evidenceProvider !== "string" ||
      !document.evidenceProvider.includes("table-task-relation")
    )
      fail(
        "task.targetEvidenceKind TABLE_TASK_RELATION_DIRECTION_UNKNOWN requires table-task-relation evidence",
      );
  }
  if (document.targetEvidenceKind === "SQL_EXACT_TABLE_TARGET") {
    const target = document.target;
    if (
      !isObject(target) ||
      ["platform", "qualifiedName", "dataSource"].some(
        (field) =>
          typeof target[field] !== "string" || target[field].trim() === "",
      )
    )
      fail(
        "task.targetEvidenceKind SQL_EXACT_TABLE_TARGET requires a physical target",
      );
    if (
      typeof document.evidenceProvider !== "string" ||
      !document.evidenceProvider.includes("sql-mcp:explicit-table-target") ||
      !document.evidenceProvider.includes("opencli:szdata.table")
    )
      fail(
        "task.targetEvidenceKind SQL_EXACT_TABLE_TARGET requires SQL target and Table evidence",
      );
  }
  requireNonEmpty(String(document.collectedAt), "task.collectedAt");
  validateHash(document.contentHash, "task.contentHash");
  if (
    canonicalHash(document as JsonObject, ["collectedAt", "contentHash"]) !==
    document.contentHash
  )
    fail("task.contentHash does not match document");
}

function buildTableDocument(evidence: TableEvidence): {
  document: TableDocument;
  ddl: string;
} {
  const platform = safePlatformToken(evidence.platform, "platform");
  const dataSource = requireNonEmpty(evidence.dataSource, "dataSource");
  const qualifiedName = requireNonEmpty(
    evidence.qualifiedName,
    "qualifiedName",
  );
  if (qualifiedName.includes("@") || /\s/.test(qualifiedName))
    fail("qualifiedName must not contain a data-source suffix or whitespace");
  const objectType = requireNonEmpty(evidence.objectType, "objectType");
  const ddl = requireNonEmpty(evidence.ddl, "ddl");
  const identity = stableTableId(evidence);
  const document: JsonObject = {
    schemaVersion: INPUT_PACK_SCHEMA_VERSION,
    stableTableId: identity.stableTableId,
    platform,
    dataSource,
    qualifiedName,
    objectType,
    ddlFile: {
      path: "ddl.sql",
      sha256: sha256Text(ddl),
      evidenceProvider: requireNonEmpty(
        evidence.evidenceProvider,
        "evidenceProvider",
      ),
    },
    collectedAt: collectAt(evidence.collectedAt),
  };
  if (identity.guid !== undefined) document.guid = identity.guid;
  for (const [key, value] of Object.entries({
    schema: evidence.schema,
    name: evidence.name,
    description: evidence.description,
    status: evidence.status,
    primaryKey: evidence.primaryKey,
    partitionFields: evidence.partitionFields,
    evidenceProvider: evidence.evidenceProvider,
  })) {
    if (value !== undefined) document[key] = value as JsonValue;
  }
  validateJson(document, "table");
  for (const field of [
    "schema",
    "name",
    "description",
    "status",
    "evidenceProvider",
  ])
    requireOptionalNonEmpty(
      document[field] as string | null | undefined,
      `table.${field}`,
    );
  if (document.primaryKey !== undefined && document.primaryKey !== null) {
    if (!Array.isArray(document.primaryKey))
      fail("table.primaryKey must be an array or omitted");
    for (const field of document.primaryKey)
      requireNonEmpty(String(field), "primary key field");
  }
  if (
    document.partitionFields !== undefined &&
    document.partitionFields !== null
  ) {
    if (!Array.isArray(document.partitionFields))
      fail("table.partitionFields must be an array or omitted");
    for (const field of document.partitionFields)
      requireNonEmpty(String(field), "partition field");
  }
  return { document: document as TableDocument, ddl };
}

export function createTableDocument(evidence: TableEvidence): TableDocument {
  const built = buildTableDocument(evidence);
  const document = {
    ...built.document,
    contentHash: canonicalHash(built.document, ["collectedAt", "contentHash"]),
  } as TableDocument;
  validateTableDocument(document);
  return document;
}

export function validateTableDocument(
  document: unknown,
): asserts document is TableDocument {
  if (!isObject(document)) fail("table document must be an object");
  validateForbiddenFields(document);
  const allowed = new Set([
    "schemaVersion",
    "stableTableId",
    "platform",
    "guid",
    "dataSource",
    "qualifiedName",
    "schema",
    "name",
    "description",
    "objectType",
    "status",
    "primaryKey",
    "partitionFields",
    "ddlFile",
    "evidenceProvider",
    "collectedAt",
    "contentHash",
  ]);
  for (const key of Object.keys(document))
    if (!allowed.has(key)) fail(`unknown table field ${key}`);
  if (document.schemaVersion !== INPUT_PACK_SCHEMA_VERSION)
    fail("unsupported table schemaVersion");
  safeTableStableId(String(document.stableTableId));
  safePlatformToken(String(document.platform), "table.platform");
  for (const field of ["dataSource", "qualifiedName", "objectType"])
    requireNonEmpty(String(document[field]), `table.${field}`);
  if (
    String(document.qualifiedName).includes("@") ||
    /\s/.test(String(document.qualifiedName))
  )
    fail("table.qualifiedName has a data-source suffix or whitespace");
  if (document.guid !== undefined)
    requireNonEmpty(String(document.guid), "table.guid");
  for (const field of [
    "schema",
    "name",
    "description",
    "status",
    "evidenceProvider",
  ])
    requireOptionalNonEmpty(
      document[field] as string | null | undefined,
      `table.${field}`,
    );
  if (
    document.primaryKey !== undefined &&
    document.primaryKey !== null &&
    (!Array.isArray(document.primaryKey) || document.primaryKey.length === 0)
  )
    fail("table.primaryKey must be a non-empty array or omitted");
  if (document.primaryKey !== undefined && document.primaryKey !== null)
    for (const field of document.primaryKey)
      requireNonEmpty(String(field), "primary key field");
  if (
    document.partitionFields !== undefined &&
    document.partitionFields !== null
  ) {
    if (!Array.isArray(document.partitionFields))
      fail("table.partitionFields must be an array");
    for (const field of document.partitionFields)
      requireNonEmpty(String(field), "partition field");
  }
  if (!isObject(document.ddlFile) || document.ddlFile.path !== "ddl.sql")
    fail("table.ddlFile is invalid");
  validateHash(document.ddlFile.sha256, "table.ddlFile.sha256");
  requireNonEmpty(
    String(document.ddlFile.evidenceProvider),
    "table.ddlFile.evidenceProvider",
  );
  requireNonEmpty(String(document.collectedAt), "table.collectedAt");
  validateHash(document.contentHash, "table.contentHash");
  if (
    canonicalHash(document as JsonObject, ["collectedAt", "contentHash"]) !==
    document.contentHash
  )
    fail("table.contentHash does not match document");
}

export function findMalformedTableDirectories(dataRoot: string): string[] {
  const tablesRoot = join(dataRoot, "tables");
  if (!existsSync(tablesRoot)) return [];
  const malformed: string[] = [];
  for (const entry of readdirSync(tablesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      safePlatformToken(entry.name, "tables.platform");
    } catch {
      malformed.push(join(tablesRoot, entry.name));
    }
  }
  return malformed;
}

export function assertExistingTableLayout(dataRoot: string): void {
  const malformed = findMalformedTableDirectories(dataRoot);
  if (malformed.length > 0)
    throw new Error(
      `Input Pack data root contains malformed Table platform directories: ${malformed.join(
        ", ",
      )}. Use a new empty data root or migrate/quarantine these directories first; no existing files were deleted.`,
    );
}

function filesystemPath(path: string): string {
  if (process.platform !== "win32") return path;
  const absolute = resolve(path);
  return absolute.startsWith("\\\\?\\") ? absolute : `\\\\?\\${absolute}`;
}

export function quarantineMalformedTableDirectories(
  dataRoot: string,
): { quarantineRoot: string; moved: string[] } | undefined {
  const absoluteRoot = resolve(dataRoot);
  const malformed = findMalformedTableDirectories(absoluteRoot);
  if (malformed.length === 0) return undefined;
  const quarantineRoot = mkdtempSync(`${absoluteRoot}.quarantine-`);
  const quarantineTablesRoot = join(quarantineRoot, "tables");
  mkdirSync(quarantineTablesRoot, { recursive: true });
  const destinations = malformed.map((source) =>
    join(quarantineTablesRoot, basename(source)),
  );
  if (destinations.some((destination) => existsSync(destination)))
    throw new Error(
      `Cannot quarantine malformed Table directories because a destination already exists under ${quarantineRoot}`,
    );
  malformed.forEach((source, index) =>
    renameSync(filesystemPath(source), filesystemPath(destinations[index]!)),
  );
  return { quarantineRoot, moved: destinations };
}

function writeJson(path: string, value: JsonValue): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readContentHash(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) && typeof parsed.contentHash === "string"
      ? parsed.contentHash
      : undefined;
  } catch {
    return undefined;
  }
}

function replaceDirectory(
  stagedDirectory: string,
  targetDirectory: string,
): void {
  const parent = dirname(targetDirectory);
  mkdirSync(parent, { recursive: true });
  const backup = `${targetDirectory}.previous-${randomUUID()}`;
  const hadTarget = existsSync(targetDirectory);
  if (hadTarget) renameSync(targetDirectory, backup);
  try {
    renameSync(stagedDirectory, targetDirectory);
    if (hadTarget) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(targetDirectory))
      rmSync(targetDirectory, { recursive: true, force: true });
    if (hadTarget && existsSync(backup)) renameSync(backup, targetDirectory);
    throw error;
  }
}

export function writeTaskInput(
  dataRoot: string,
  evidence: TaskEvidence,
): WriteResult {
  mkdirSync(dataRoot, { recursive: true });
  const built = buildTaskDocument(evidence);
  let document = createTaskDocument(evidence);
  const taskId = document.taskId;
  const taskCategory = safeSegment(
    String(document.taskCategory),
    "taskCategory",
  );
  const targetDirectory = join(dataRoot, "tasks", taskCategory, taskId);
  // Keep explicit mapping evidence across recollection, including its old hashes.
  // Changed inputs must fail verification instead of reopening positional fallback.
  const existingPath = join(targetDirectory, "task.json");
  if (evidence.writeColumnEvidence === undefined && existsSync(existingPath)) {
    const previous = JSON.parse(readFileSync(existingPath, "utf8"));
    if (previous.writeColumnEvidence) {
        validateWriteColumnEvidence(previous.writeColumnEvidence);
        const mapping = previous.writeColumnEvidence;
        const merged = {...document, writeColumnEvidence: mapping} as unknown as JsonObject;
        merged.contentHash = canonicalHash(merged, ["collectedAt", "contentHash"]);
        validateTaskDocument(merged);
        document = merged;
    }
  }
  if (
    readContentHash(join(targetDirectory, "task.json")) === document.contentHash
  )
    return {
      changed: false,
      directory: targetDirectory,
      contentHash: document.contentHash,
    };
  const stagingRoot = mkdtempSync(join(dataRoot, ".input-pack-task-"));
  const stagingDirectory = join(stagingRoot, taskCategory, taskId);
  try {
    writeJson(join(stagingDirectory, "task.json"), document);
    for (const item of built.sql) {
      const path = join(stagingDirectory, "sql", `${item.slot}.sql`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, item.content, "utf8");
      const indexedFile = document.sqlFiles.find(
        (file): file is JsonObject => isObject(file) && file.slot === item.slot,
      );
      const expectedHash =
        indexedFile && typeof indexedFile.sha256 === "string"
          ? indexedFile.sha256
          : undefined;
      if (sha256File(path) !== expectedHash)
        fail(`staged SQL hash mismatch for ${item.slot}`);
    }
    validateTaskDocument(
      JSON.parse(readFileSync(join(stagingDirectory, "task.json"), "utf8")),
    );
    replaceDirectory(stagingDirectory, targetDirectory);
    return {
      changed: true,
      directory: targetDirectory,
      contentHash: document.contentHash,
    };
  } finally {
    if (existsSync(stagingRoot))
      rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function writeTableInput(
  dataRoot: string,
  evidence: TableEvidence,
): WriteResult {
  mkdirSync(dataRoot, { recursive: true });
  const built = buildTableDocument(evidence);
  const document = createTableDocument(evidence);
  const targetDirectory = join(
    dataRoot,
    "tables",
    document.platform,
    document.stableTableId,
  );
  if (
    readContentHash(join(targetDirectory, "table.json")) ===
    document.contentHash
  )
    return {
      changed: false,
      directory: targetDirectory,
      contentHash: document.contentHash,
      stableTableId: document.stableTableId,
    };
  const stagingRoot = mkdtempSync(join(dataRoot, ".input-pack-table-"));
  const stagingDirectory = join(stagingRoot, document.stableTableId);
  try {
    writeJson(join(stagingDirectory, "table.json"), document);
    writeFileSync(join(stagingDirectory, "ddl.sql"), built.ddl, "utf8");
    if (
      sha256File(join(stagingDirectory, "ddl.sql")) !== document.ddlFile.sha256
    )
      fail("staged DDL hash mismatch");
    validateTableDocument(
      JSON.parse(readFileSync(join(stagingDirectory, "table.json"), "utf8")),
    );
    replaceDirectory(stagingDirectory, targetDirectory);
    return {
      changed: true,
      directory: targetDirectory,
      contentHash: document.contentHash,
      stableTableId: document.stableTableId,
    };
  } finally {
    if (existsSync(stagingRoot))
      rmSync(stagingRoot, { recursive: true, force: true });
  }
}
