import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  isFrozenScheduleStatus,
  isManualScheduleCycle,
  type JsonValue,
  type SqlSlotEvidence,
  type SqlSlot,
  type TaskEvidence,
} from "../shared/input-pack.ts";
import {
  materializeSparkIndexTaskAndTables,
  SparkIndexTableMcpGate,
  type SparkIndexTableDdlRunner,
  type SparkIndexTableGuidRunner,
} from "../shared/sparkindex-table-evidence.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeTaskTypeCache,
  writeHoraeTaskTypeCache,
} from "../../evidence/schedule-evidence-cache.ts";
import {
  normalizeSzdataScheduleDetail,
  readSzdataScheduleDetailCache,
  runSzdataScheduleDetail,
  ScheduleDetailSerialGate,
  writeSzdataScheduleDetailCache,
  type SzdataScheduleDetailCacheStatus,
  type ScheduleDetailRunner,
} from "./szdata-schedule-detail-cache.ts";
import { relocateTaskPacks } from "./collect-one-task-input-pack.ts";

const HORAE_EVIDENCE_PROVIDER = "opencli:horae.detail";
const SZDATA_SCHEDULE_DETAIL_EVIDENCE_PROVIDER =
  "opencli:szdata.schedule-detail";
const DEFAULT_HORAE_MIN_INTERVAL_MS = 2_000;
const DEFAULT_HORAE_TIMEOUT_MS = 30_000;
const SQL_SLOTS: readonly SqlSlot[] = [
  "create",
  "query",
  "prepare",
  "truncate",
  "finish",
];

type HoraeRecord = Record<string, unknown>;

export type HoraeDetailRunner = (taskId: string) => unknown;
type EvidenceProvider =
  | typeof HORAE_EVIDENCE_PROVIDER
  | typeof SZDATA_SCHEDULE_DETAIL_EVIDENCE_PROVIDER
  | string;

export interface HoraeSerialGateOptions {
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => void;
}

/**
 * A process-local gate for Horae calls. The default collector shares one gate
 * across calls, so a batch can remain serial without adding a second worker
 * pool or making the generic collector depend on Horae.
 */
export class HoraeSerialGate {
  private lastCallAt: number | undefined;

  private readonly minIntervalMs: number;

  private readonly now: () => number;

  private readonly sleep: (milliseconds: number) => void;

  public constructor(options: HoraeSerialGateOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_HORAE_MIN_INTERVAL_MS;
    if (!Number.isFinite(this.minIntervalMs) || this.minIntervalMs < 0)
      throw new Error("HORAE_MIN_INTERVAL_MUST_BE_NON_NEGATIVE");
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

function sleepSynchronously(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function runHoraeDetail(taskId: string): unknown {
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
          ...horaeDetailCommandArguments(taskId),
        ]
      : [...horaeDetailCommandArguments(taskId)];
  const timeoutMs = Number.parseInt(
    process.env.INPUT_PACK_SPARKINDEX_HORAE_TIMEOUT_MS ?? "",
    10,
  );
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_HORAE_TIMEOUT_MS;
  const output = execFileSync(executable, executableArgs, {
    encoding: "utf8",
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

export function horaeDetailCommandArguments(taskId: string): readonly string[] {
  return ["horae", "detail", taskId, "-f", "json"];
}

function firstValue(record: HoraeRecord, fields: readonly string[]): unknown {
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function stringValue(
  record: HoraeRecord,
  fields: readonly string[],
): string | undefined {
  const value = firstValue(record, fields);
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized === "" ? undefined : normalized;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string")
    return value.trim() === "" || value.trim() === "-" ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value)) {
    const values: JsonValue[] = [];
    for (const item of value) {
      const jsonValue = toJsonValue(item);
      if (jsonValue === undefined) return undefined;
      values.push(jsonValue);
    }
    return values;
  }
  if (typeof value !== "object") return undefined;
  const object: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    const jsonValue = toJsonValue(item);
    if (jsonValue === undefined) return undefined;
    object[key] = jsonValue;
  }
  return object;
}

function asHoraeRecord(value: unknown, taskId: string): HoraeRecord {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new Error(`HORAE_DETAIL_EMPTY:${taskId}`);
  return row as HoraeRecord;
}

const SQL_FIELD_ALIASES: Readonly<Record<SqlSlot, readonly string[]>> = {
  create: ["createSql", "createSQL", "create_sql"],
  query: ["querySql", "querySQL", "query_sql"],
  prepare: ["prepareSql", "prepareSQL", "prepare_sql", "preSql", "beforeSql"],
  truncate: ["truncateSql", "truncateSQL", "truncate_sql"],
  finish: ["finishSql", "finishSQL", "finish_sql", "postSql", "afterSql"],
};

function sqlSlotsFromHorae(
  record: HoraeRecord,
  evidenceProvider: EvidenceProvider,
): Partial<
  Record<
    SqlSlot,
    { readonly content: string; readonly evidenceProvider: string }
  >
> {
  const result: Partial<
    Record<
      SqlSlot,
      { readonly content: string; readonly evidenceProvider: string }
    >
  > = {};
  for (const slot of SQL_SLOTS) {
    const value = firstValue(record, SQL_FIELD_ALIASES[slot]);
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      value.trim() !== "-"
    )
      result[slot] = {
        content: value,
        evidenceProvider,
      };
  }
  return result;
}

function sqlSlotsFromNestedHorae(
  record: HoraeRecord,
  evidenceProvider: EvidenceProvider,
): Partial<
  Record<
    SqlSlot,
    { readonly content: string; readonly evidenceProvider: string }
  >
> {
  const nested = record.sqlSlots;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return {};
  const result: Partial<
    Record<
      SqlSlot,
      { readonly content: string; readonly evidenceProvider: string }
    >
  > = {};
  for (const slot of SQL_SLOTS) {
    const item = (nested as HoraeRecord)[slot];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const content = (item as HoraeRecord).sql ?? (item as HoraeRecord).content;
    if (
      typeof content === "string" &&
      content.trim() !== "" &&
      content.trim() !== "-"
    )
      result[slot] = {
        content,
        evidenceProvider,
      };
  }
  return result;
}

function buildSqlEvidence(
  record: HoraeRecord,
  evidenceProvider: EvidenceProvider,
): Partial<
  Record<
    SqlSlot,
    { readonly content: string; readonly evidenceProvider: string }
  >
> {
  return {
    ...sqlSlotsFromNestedHorae(record, evidenceProvider),
    ...sqlSlotsFromHorae(record, evidenceProvider),
  };
}

function buildSparkIndexTaskEvidenceInternal(
  taskId: string,
  detail: unknown,
  evidenceProvider: EvidenceProvider,
  requireSql: boolean,
): TaskEvidence {
  const record =
    evidenceProvider === SZDATA_SCHEDULE_DETAIL_EVIDENCE_PROVIDER
      ? normalizeSzdataScheduleDetail(detail, taskId)
      : asHoraeRecord(detail, taskId);
  const sql = buildSqlEvidence(record, evidenceProvider);
  if (requireSql && Object.keys(sql).length === 0)
    throw new Error(`HORAE_SPARKINDEX_SQL_UNAVAILABLE:${taskId}`);

  const target = toJsonValue(
    firstValue(record, [
      "target",
      "targetTable",
      "target_table",
      "writeTable",
      "write_table",
    ]),
  );
  const source = toJsonValue(
    firstValue(record, ["source", "sourceTable", "source_table"]),
  );
  const partition = stringValue(record, [
    "hivePartition",
    "hive_partition",
    "partition",
  ]);

  return {
    taskId,
    taskCategory: "sparkIndex",
    taskType: stringValue(record, [
      "taskType",
      "task_type",
      "typeId",
      "type_id",
      "type",
    ]),
    taskName: stringValue(record, ["taskName", "task_name", "name"]),
    topicName: stringValue(record, ["topicName", "topic_name"]),
    scheduleCycle: stringValue(record, [
      "scheduleCycle",
      "schedule_cycle",
      "cycle",
    ]),
    scheduleStatus: stringValue(record, [
      "scheduleStatus",
      "schedule_status",
      "taskStatus",
      "status",
    ]),
    source: source ?? null,
    target: target ?? null,
    writeMode: stringValue(record, [
      "loadMode",
      "load_mode",
      "insertMode",
      "insert_mode",
      "writeMode",
      "write_mode",
      "mode",
    ]),
    ...(partition
      ? {
          schedulerEvidence: {
            hivePartition: partition,
            evidenceProvider,
          },
        }
      : {}),
    sql,
    evidenceProvider,
  };
}

export function buildSparkIndexTaskEvidence(
  taskId: string,
  detail: unknown,
  evidenceProvider: EvidenceProvider = HORAE_EVIDENCE_PROVIDER,
): TaskEvidence {
  return buildSparkIndexTaskEvidenceInternal(
    taskId,
    detail,
    evidenceProvider,
    false,
  );
}

export interface CollectSparkIndexOptions {
  readonly runScheduleDetail?: ScheduleDetailRunner;
  readonly runHoraeDetail?: HoraeDetailRunner;
  readonly scheduleDetailGate?: ScheduleDetailSerialGate;
  readonly horaeGate?: HoraeSerialGate;
  readonly cacheRoot?: string;
  readonly manualDataRoot?: string;
  readonly metadataSnapshotPath?: string | null;
  readonly runTableGuid?: SparkIndexTableGuidRunner;
  readonly runTableDdl?: SparkIndexTableDdlRunner;
  readonly tableMcpGate?: SparkIndexTableMcpGate;
  readonly tableMcpMinIntervalMs?: number;
  readonly now?: () => Date;
}

export type SparkIndexCacheStatus =
  "HIT" | "MISS_REFRESHED" | "INVALID_REFRESHED";

export interface SparkIndexCollectionSummary {
  readonly taskId: string;
  readonly taskCategory: "sparkIndex";
  readonly changed: boolean;
  readonly directory: string;
  readonly contentHash: string;
  readonly sqlSlots: readonly SqlSlot[];
  readonly evidenceProvider: string;
  readonly cacheStatus: SparkIndexCacheStatus;
  readonly scheduleDetailCacheStatus: SzdataScheduleDetailCacheStatus | "DISABLED";
  readonly horaeCacheStatus: "HIT" | "MISS" | "INVALID" | "DISABLED";
  readonly collectionStatus: "SUCCESS" | "PARTIAL" | "EXCLUDED";
  readonly exclusionReason?: "MANUAL_OR_FROZEN";
  readonly tableCandidates: readonly string[];
  readonly tablesWritten: number;
  readonly tablesUnavailable: readonly string[];
  readonly tableResolutionReasons: readonly string[];
}

function manualArchiveRoot(dataRoot: string, configured?: string): string {
  const dataRootAbsolute = resolve(dataRoot);
  const archiveRoot = resolve(
    configured ?? `${dataRootAbsolute}.manual-tasks`,
  );
  const archiveRelative = relative(dataRootAbsolute, archiveRoot);
  if (
    archiveRoot === dataRootAbsolute ||
    (archiveRelative !== "" &&
      archiveRelative !== ".." &&
      !archiveRelative.startsWith(`..${sep}`) &&
      !isAbsolute(archiveRelative))
  )
    throw new Error(
      `--manual-data-root must be outside --data-root: ${archiveRoot}`,
    );
  return archiveRoot;
}

const defaultHoraeGate = new HoraeSerialGate();
const defaultScheduleDetailGate = new ScheduleDetailSerialGate();

type CacheReadStatus = "HIT" | "MISS" | "INVALID";

interface LoadedSparkIndexEvidence {
  readonly evidence: TaskEvidence;
  readonly cacheStatus: SparkIndexCacheStatus;
  readonly cacheReadStatus: CacheReadStatus;
}

function hasEvidenceValue(value: unknown): boolean {
  return !(
    value === undefined ||
    value === null ||
    (typeof value === "string" &&
      (value.trim() === "" || value.trim() === "-"))
  );
}

function sqlContent(value: unknown): string | undefined {
  if (typeof value === "string")
    return hasEvidenceValue(value) ? value : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const content = (value as Record<string, unknown>).content;
  return typeof content === "string" && hasEvidenceValue(content)
    ? content
    : undefined;
}

function comparableTarget(value: unknown): string | undefined {
  if (!hasEvidenceValue(value)) return undefined;
  if (typeof value === "string") return value.trim().toLocaleLowerCase("en-US");
  if (!value || typeof value !== "object" || Array.isArray(value))
    return JSON.stringify(value);
  const object = value as Record<string, unknown>;
  for (const key of ["qualifiedName", "targetTable", "tableName", "name"]) {
    if (typeof object[key] === "string" && hasEvidenceValue(object[key]))
      return object[key]!.trim().toLocaleLowerCase("en-US");
  }
  return JSON.stringify(object);
}

function comparableMode(value: unknown): string | undefined {
  return typeof value === "string" && hasEvidenceValue(value)
    ? value.trim().toLocaleLowerCase("en-US")
    : undefined;
}

function mergeProviders(
  primary: string | undefined,
  fallback: string | undefined,
): string | undefined {
  const providers = [primary, fallback].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return providers.length === 0 ? undefined : [...new Set(providers)].join("+");
}

export function mergeSparkIndexEvidence(
  primary: TaskEvidence,
  fallback: TaskEvidence,
): TaskEvidence {
  const primaryTarget = comparableTarget(primary.target);
  const fallbackTarget = comparableTarget(fallback.target);
  if (
    primaryTarget !== undefined &&
    fallbackTarget !== undefined &&
    primaryTarget !== fallbackTarget
  )
    throw new Error("SPARKINDEX_EVIDENCE_CONFLICT:target");

  const primaryMode = comparableMode(primary.writeMode);
  const fallbackMode = comparableMode(fallback.writeMode);
  if (
    primaryMode !== undefined &&
    fallbackMode !== undefined &&
    primaryMode !== fallbackMode
  )
    throw new Error("SPARKINDEX_EVIDENCE_CONFLICT:writeMode");

  const sql: Partial<Record<SqlSlot, SqlSlotEvidence>> = {};
  for (const slot of SQL_SLOTS) {
    const primarySql = sqlContent(primary.sql?.[slot]);
    const fallbackSql = sqlContent(fallback.sql?.[slot]);
    if (
      primarySql !== undefined &&
      fallbackSql !== undefined &&
      primarySql.trim() !== fallbackSql.trim()
    )
      throw new Error(`SPARKINDEX_EVIDENCE_CONFLICT:sql.${slot}`);
    const fallbackValue = fallback.sql?.[slot];
    if (fallbackSql !== undefined) {
      const fallbackProvider =
        fallbackValue &&
        typeof fallbackValue === "object" &&
        !Array.isArray(fallbackValue) &&
        typeof fallbackValue.evidenceProvider === "string"
          ? fallbackValue.evidenceProvider
          : fallback.evidenceProvider ?? HORAE_EVIDENCE_PROVIDER;
      sql[slot] = {
        content: fallbackSql,
        evidenceProvider: fallbackProvider,
      };
    }
    const primaryValue = primary.sql?.[slot];
    if (primarySql !== undefined) {
      const value = primaryValue;
      if (typeof value === "string") {
        sql[slot] = {
          content: primarySql,
          evidenceProvider:
            primary.evidenceProvider ?? SZDATA_SCHEDULE_DETAIL_EVIDENCE_PROVIDER,
        };
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        sql[slot] = {
          content: primarySql,
          evidenceProvider:
            typeof value.evidenceProvider === "string"
              ? value.evidenceProvider
              : primary.evidenceProvider ??
                SZDATA_SCHEDULE_DETAIL_EVIDENCE_PROVIDER,
        };
      }
    }
  }

  const pick = <T>(primaryValue: T | null | undefined, fallbackValue: T | null | undefined): T | null | undefined =>
    hasEvidenceValue(primaryValue) ? primaryValue : fallbackValue;
  return {
    ...fallback,
    ...primary,
    source: pick(primary.source, fallback.source) ?? null,
    target: pick(primary.target, fallback.target) ?? null,
    writeMode: pick(primary.writeMode, fallback.writeMode) ?? null,
    schedulerEvidence: primary.schedulerEvidence ?? fallback.schedulerEvidence,
    sql,
    evidenceProvider: mergeProviders(
      primary.evidenceProvider,
      fallback.evidenceProvider,
    ),
  };
}

function loadScheduleDetailEvidence(
  taskId: string,
  options: CollectSparkIndexOptions,
): LoadedSparkIndexEvidence {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const cached = readSzdataScheduleDetailCache(taskId, cacheRoot);
  if (cached.status === "HIT")
    return {
      evidence: buildSparkIndexTaskEvidenceInternal(
        taskId,
        cached.detail,
        SZDATA_SCHEDULE_DETAIL_EVIDENCE_PROVIDER,
        false,
      ),
      cacheStatus: "HIT",
      cacheReadStatus: "HIT",
    };

  const gate = options.scheduleDetailGate ?? defaultScheduleDetailGate;
  const runner = options.runScheduleDetail ?? runSzdataScheduleDetail;
  gate.beforeCall();
  const detail = normalizeSzdataScheduleDetail(runner(taskId), taskId);
  const evidence = buildSparkIndexTaskEvidenceInternal(
    taskId,
    detail,
    SZDATA_SCHEDULE_DETAIL_EVIDENCE_PROVIDER,
    false,
  );
  writeSzdataScheduleDetailCache(
    taskId,
    (options.now ?? (() => new Date()))().toISOString(),
    detail,
    cacheRoot,
  );
  return {
    evidence,
    cacheStatus: cached.status === "MISS" ? "MISS_REFRESHED" : "INVALID_REFRESHED",
    cacheReadStatus: cached.status,
  };
}

function loadHoraeDetailEvidence(
  taskId: string,
  options: CollectSparkIndexOptions,
  cachedStatus: "MISS" | "INVALID",
): LoadedSparkIndexEvidence {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const gate = options.horaeGate ?? defaultHoraeGate;
  const runner = options.runHoraeDetail ?? runHoraeDetail;
  gate.beforeCall();
  const detail = asHoraeRecord(runner(taskId), taskId);
  const evidence = buildSparkIndexTaskEvidenceInternal(
    taskId,
    detail,
    HORAE_EVIDENCE_PROVIDER,
    false,
  );
  writeHoraeTaskTypeCache(
    taskId,
    (options.now ?? (() => new Date()))().toISOString(),
    detail,
    cacheRoot,
  );
  return {
    evidence,
    cacheStatus: cachedStatus === "MISS" ? "MISS_REFRESHED" : "INVALID_REFRESHED",
    cacheReadStatus: cachedStatus,
  };
}

function collectSparkIndexEvidence(
  taskId: string,
  options: CollectSparkIndexOptions,
): {
  readonly evidence: TaskEvidence;
  readonly cacheStatus: SparkIndexCacheStatus;
  readonly scheduleDetailCacheStatus: SzdataScheduleDetailCacheStatus | "DISABLED";
  readonly horaeCacheStatus: CacheReadStatus | "DISABLED";
} {
  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;

  // Existing callers that inject only a Horae runner are kept on the old
  // path. Production/default calls still make schedule-detail the primary
  // source and do not silently turn the legacy cache into the new artifact.
  const cachedScheduleDetail = readSzdataScheduleDetailCache(
    taskId,
    cacheRoot,
  );
  if (
    options.runScheduleDetail === undefined &&
    options.runHoraeDetail !== undefined &&
    cachedScheduleDetail.status !== "HIT"
  ) {
    const cachedHorae = readHoraeTaskTypeCache(taskId, cacheRoot);
    const loadedHorae =
      cachedHorae.status === "HIT"
        ? {
            evidence: buildSparkIndexTaskEvidenceInternal(
              taskId,
              cachedHorae.detail,
              HORAE_EVIDENCE_PROVIDER,
              false,
            ),
            cacheStatus: "HIT" as const,
            cacheReadStatus: "HIT" as const,
          }
        : loadHoraeDetailEvidence(taskId, options, cachedHorae.status);
    return {
      evidence: loadedHorae.evidence,
      cacheStatus: loadedHorae.cacheStatus,
      scheduleDetailCacheStatus: "DISABLED",
      horaeCacheStatus: loadedHorae.cacheReadStatus,
    };
  }

  const schedule = loadScheduleDetailEvidence(taskId, options);
  const cachedHorae = readHoraeTaskTypeCache(taskId, cacheRoot);
  let evidence = schedule.evidence;
  let horaeCacheStatus: CacheReadStatus | "DISABLED" = cachedHorae.status;
  if (cachedHorae.status === "HIT") {
    const horaeEvidence = buildSparkIndexTaskEvidenceInternal(
      taskId,
      cachedHorae.detail,
      HORAE_EVIDENCE_PROVIDER,
      false,
    );
    evidence = mergeSparkIndexEvidence(evidence, horaeEvidence);
  }

  if (!evidence.sql || Object.keys(evidence.sql).length === 0) {
    const loadedHorae =
      cachedHorae.status === "HIT"
        ? undefined
        : loadHoraeDetailEvidence(taskId, options, cachedHorae.status);
    if (loadedHorae !== undefined) {
      horaeCacheStatus = loadedHorae.cacheReadStatus;
      evidence = mergeSparkIndexEvidence(evidence, loadedHorae.evidence);
    }
  }
  return {
    evidence,
    cacheStatus: schedule.cacheStatus,
    scheduleDetailCacheStatus: schedule.cacheReadStatus,
    horaeCacheStatus,
  };
}

export function collectOneSparkIndexTask(
  dataRoot: string,
  taskId: string,
  options: CollectSparkIndexOptions = {},
): SparkIndexCollectionSummary {
  const normalizedTaskId = taskId.trim();
  if (normalizedTaskId === "") throw new Error("TASK_ID_REQUIRED");
  const collected = collectSparkIndexEvidence(normalizedTaskId, options);
  const evidence = collected.evidence;
  const isManualOrFrozen =
    isManualScheduleCycle(evidence.scheduleCycle) ||
    isFrozenScheduleStatus(evidence.scheduleStatus);
  if (isManualOrFrozen) {
    const archiveRoot = manualArchiveRoot(dataRoot, options.manualDataRoot);
    const moved = relocateTaskPacks(dataRoot, archiveRoot, normalizedTaskId);
    return {
      taskId: normalizedTaskId,
      taskCategory: "sparkIndex",
      changed: moved.length > 0,
      directory: moved[0] ?? archiveRoot,
      contentHash: "",
      sqlSlots: SQL_SLOTS.filter(
        (slot) => evidence.sql?.[slot] !== undefined,
      ),
      evidenceProvider: evidence.evidenceProvider ?? HORAE_EVIDENCE_PROVIDER,
      cacheStatus: collected.cacheStatus,
      scheduleDetailCacheStatus: collected.scheduleDetailCacheStatus,
      horaeCacheStatus: collected.horaeCacheStatus,
      collectionStatus: "EXCLUDED",
      exclusionReason: "MANUAL_OR_FROZEN",
      tableCandidates: [],
      tablesWritten: 0,
      tablesUnavailable: [],
      tableResolutionReasons: [],
    };
  }
  const materialized = materializeSparkIndexTaskAndTables(dataRoot, evidence, {
    metadataSnapshotPath: options.metadataSnapshotPath,
    runTableGuid: options.runTableGuid,
    runTableDdl: options.runTableDdl,
    tableMcpGate: options.tableMcpGate,
    tableMcpMinIntervalMs: options.tableMcpMinIntervalMs,
    now: options.now,
  });
  const result = materialized.materialized.task;
  const tableWrites = materialized.materialized.tables;
  return {
    taskId: normalizedTaskId,
    taskCategory: "sparkIndex",
    changed: result.changed,
    directory: result.directory,
    contentHash: result.contentHash,
    sqlSlots: SQL_SLOTS.filter(
      (slot) => materialized.taskEvidence.sql?.[slot] !== undefined,
    ),
    evidenceProvider:
      materialized.taskEvidence.evidenceProvider ?? HORAE_EVIDENCE_PROVIDER,
    cacheStatus: collected.cacheStatus,
    scheduleDetailCacheStatus: collected.scheduleDetailCacheStatus,
    horaeCacheStatus: collected.horaeCacheStatus,
    collectionStatus: materialized.collectionStatus,
    tableCandidates: materialized.resolution.candidates.map(
      (candidate) => candidate.qualifiedName,
    ),
    tablesWritten: tableWrites.length,
    tablesUnavailable: materialized.resolution.unavailable.map(
      (item) => item.candidate.qualifiedName,
    ),
    tableResolutionReasons: materialized.resolution.unavailable.map(
      (item) => `${item.candidate.qualifiedName}:${item.reason}`,
    ),
  };
}

function readCliOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--"))
    throw new Error(`OPTION_REQUIRED:${name}`);
  return value;
}

function optionalCliOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--"))
    throw new Error(`OPTION_REQUIRED:${name}`);
  return value;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry?.endsWith("collect-one-task-input-pack-sparkindex.ts") ?? false;
}

if (isDirectExecution()) {
  try {
    const summary = collectOneSparkIndexTask(
      readCliOption("--data-root"),
      readCliOption("--task-id"),
      {
        cacheRoot: optionalCliOption("--cache-root"),
        manualDataRoot: optionalCliOption("--manual-data-root"),
        metadataSnapshotPath: optionalCliOption("--metadata-snapshot"),
      },
    );
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
