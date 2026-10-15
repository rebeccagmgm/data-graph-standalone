import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  isFrozenScheduleStatus,
  isManualScheduleCycle,
  type JsonValue,
  type SqlSlot,
  type TableEvidence,
  type TaskEvidence,
} from "../shared/input-pack.ts";
import { materializeTaskAndTablePacks } from "../shared/task-table-materialization.ts";
import {
  buildCompactTaskPartition,
  isDatabaseSourceToHiveTask,
} from "../shared/task-partition-evidence.ts";
import {
  controlledTaskEndpointDataSource,
  controlledTaskEndpointPlatform,
  enrichTaskEndpoint,
  inputCollectionStatus,
  shouldUseTaskRelationFallback,
  targetEvidenceKindFor,
} from "../shared/task-endpoints.ts";
import { findSqlFinalTargetEvidence } from "../shared/sql-target-evidence.ts";
import { normalizeRepeatedSqlForAnalysis } from "../shared/sql-analysis-normalization.ts";
import { extractSqlReadTableNames } from "../shared/sql-table-references.ts";
import taskTypeCodeMap from "../shared/task-type-map.json" with { type: "json" };

const SQL_SLOTS: readonly SqlSlot[] = [
  "create",
  "query",
  "prepare",
  "truncate",
  "finish",
];
const TASK_TYPE_CODE_MAP: Readonly<Record<string, string>> = taskTypeCodeMap;
const DATA_SOURCE_ID_OVERRIDES: Readonly<Record<string, string>> = {
  场外衍生品投资管理系统: "gforacle_gftzdb#gftzdb",
};
const KNOWN_DATA_SOURCE_IDS = new Set(["gfhive", "gforacle_gftzdb#gftzdb"]);
const DEFAULT_DATA_SOURCE_ID = "default";

type CachedTableEvidence = TableEvidence;
let persistedTableCacheRoot: string | undefined;
let persistedTableCache = new Map<string, CachedTableEvidence[]>();
const directEvidenceCache = new Map<string, TableEvidence | undefined>();

function cachedTableKey(qualifiedName: string): string {
  return qualifiedName.trim().toLowerCase();
}

export function loadPersistedTableCache(dataRoot: string): void {
  if (persistedTableCacheRoot === dataRoot) return;
  persistedTableCacheRoot = dataRoot;
  persistedTableCache = new Map();
  const tablesRoot = join(dataRoot, "tables");
  if (!existsSync(tablesRoot)) return;
  for (const platformEntry of readdirSync(tablesRoot, {
    withFileTypes: true,
  })) {
    if (!platformEntry.isDirectory()) continue;
    const platformRoot = join(tablesRoot, platformEntry.name);
    for (const tableEntry of readdirSync(platformRoot, {
      withFileTypes: true,
    })) {
      if (!tableEntry.isDirectory()) continue;
      const tableRoot = join(platformRoot, tableEntry.name);
      try {
        const document = JSON.parse(
          readFileSync(join(tableRoot, "table.json"), "utf8"),
        ) as Record<string, unknown>;
        const ddl = readFileSync(join(tableRoot, "ddl.sql"), "utf8");
        if (
          typeof document.qualifiedName !== "string" ||
          typeof document.dataSource !== "string" ||
          typeof document.platform !== "string" ||
          typeof document.objectType !== "string" ||
          ddl.trim() === ""
        )
          continue;
        const evidence: CachedTableEvidence = {
          guid: typeof document.guid === "string" ? document.guid : undefined,
          platform: document.platform,
          dataSource: document.dataSource,
          qualifiedName: document.qualifiedName,
          schema:
            typeof document.schema === "string" ? document.schema : undefined,
          name: typeof document.name === "string" ? document.name : undefined,
          description:
            typeof document.description === "string"
              ? document.description
              : undefined,
          objectType: document.objectType,
          status:
            typeof document.status === "string" ? document.status : undefined,
          primaryKey: Array.isArray(document.primaryKey)
            ? document.primaryKey.map(String)
            : undefined,
          partitionFields: Array.isArray(document.partitionFields)
            ? document.partitionFields.map(String)
            : undefined,
          ddl,
          evidenceProvider:
            typeof document.evidenceProvider === "string"
              ? `${document.evidenceProvider},local:tables-cache`
              : "local:tables-cache",
          collectedAt:
            typeof document.collectedAt === "string"
              ? document.collectedAt
              : undefined,
        };
        const key = cachedTableKey(evidence.qualifiedName);
        const entries = persistedTableCache.get(key) ?? [];
        entries.push(evidence);
        persistedTableCache.set(key, entries);
      } catch {
        // A malformed or incomplete cache entry must fall back to SZData.
      }
    }
  }
}

export function environmentMilliseconds(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer in milliseconds`);
  return value;
}

const OPENCLI_MIN_INTERVAL_MS = environmentMilliseconds(
  "INPUT_PACK_OPENCLI_MIN_INTERVAL_MS",
  1000,
);
const OPENCLI_DEFAULT_TIMEOUT_MS = environmentMilliseconds(
  "INPUT_PACK_OPENCLI_TIMEOUT_MS",
  30000,
);
const HORAE_FALLBACK_TIMEOUT_MS = environmentMilliseconds(
  "INPUT_PACK_HORAE_TIMEOUT_MS",
  5000,
);
const HORAE_SEARCH_TIMEOUT_MS = environmentMilliseconds(
  "INPUT_PACK_HORAE_SEARCH_TIMEOUT_MS",
  30000,
);
let lastOpenCliCallAt = 0;

export type TaskCollectionSummary = {
  taskId: string;
  taskCategory: string;
  taskType?: string | null;
  collectionStatus: "SUCCESS" | "PARTIAL";
  directory: string;
  changed: boolean;
  contentHash: string;
  tablesWritten: number;
  tableAssets: Array<{ directory: string; contentHash: string }>;
  tablesUnavailable: string[];
  tableReferencesUnavailable: string[];
  warnings: string[];
  staleLegacyTaskDirectories: string[];
};

/**
 * A non-physical endpoint label is an evidence gap, not proof that a
 * physical Table Pack is missing. Only an unavailable table lookup may move
 * a task to the physical-table not-found archive.
 */
export function hasPhysicalTableEvidenceGap(
  summary: Pick<TaskCollectionSummary, "tablesUnavailable">,
): boolean {
  return summary.tablesUnavailable.length > 0;
}

export type CollectOneTaskOptions = {
  /** Direct Horae cycle evidence supplied by the batch inventory lookup. */
  scheduleCycle?: string | null;
  /** Direct Horae status evidence supplied by the batch inventory lookup. */
  scheduleStatus?: string | null;
};

function directValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    typeof value === "string" &&
    (value.trim() === "" || value.trim() === "-")
  )
    return undefined;
  return value as JsonValue;
}

function directString(value: unknown): string | undefined {
  const direct = directValue(value);
  return direct === undefined || direct === null ? undefined : String(direct);
}

function directOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return directString(value);
}

function directStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result = value.map((item) => directString(item));
  return result.every((item): item is string => item !== undefined)
    ? result
    : undefined;
}

function tableTaskIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .map((item) =>
      typeof item === "string"
        ? directString(item)
        : item && typeof item === "object" && !Array.isArray(item)
          ? directString((item as Record<string, unknown>).taskId)
          : undefined,
    )
    .filter((item): item is string => item !== undefined);
  return ids.length > 0 ? ids : undefined;
}

function compactIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function longestSharedIdentity(value: string, candidate: string): number {
  let longest = 0;
  for (let start = 0; start < value.length; start += 1) {
    for (let end = start + 1; end <= value.length; end += 1) {
      if (end - start <= longest) continue;
      if (candidate.includes(value.slice(start, end))) longest = end - start;
    }
  }
  return longest;
}

function sourceAffinityScore(
  sourceHint: string,
  candidate: Record<string, unknown> | TableEvidence,
): number {
  const candidateRecord = candidate as Record<string, unknown>;
  const rawQualifiedName =
    typeof candidateRecord.qualifiedName === "string"
      ? candidateRecord.qualifiedName
      : undefined;
  if (rawQualifiedName === undefined) return 0;
  const physicalSource = dataSourceIdentifier(
    candidateRecord,
    rawQualifiedName,
  );
  if (physicalSource === undefined) return 0;
  const sharedIdentity = longestSharedIdentity(
    compactIdentity(sourceHint),
    compactIdentity(physicalSource),
  );
  return sharedIdentity >= 4 ? sharedIdentity : 0;
}

export function selectTableCandidate(
  candidates: readonly Record<string, unknown>[],
  qualifiedName: string,
  expectedDataSource?: string,
  sourceHint?: string,
): Record<string, unknown> | undefined {
  const sourceCandidates =
    expectedDataSource === undefined
      ? candidates
      : candidates.filter((item) => {
          const rawQualifiedName =
            typeof item.qualifiedName === "string"
              ? item.qualifiedName
              : undefined;
          return (
            rawQualifiedName !== undefined &&
            dataSourceIdentifier(item, rawQualifiedName) === expectedDataSource
          );
        });
  const exactCase = sourceCandidates.filter(
    (item) =>
      typeof item.qualifiedName === "string" &&
      baseQualifiedName(item.qualifiedName) === qualifiedName,
  );
  const caseInsensitive = sourceCandidates.filter(
    (item) =>
      typeof item.qualifiedName === "string" &&
      baseQualifiedName(item.qualifiedName).toLowerCase() ===
        qualifiedName.toLowerCase(),
  );
  // A source hint is allowed to resolve case variants as well. Ingest SQL
  // often uppercases the source schema while metadata keeps the physical
  // MySQL name lowercase; restricting the hint to exact-case candidates
  // would discard the useful physical candidate before ranking it.
  const matchingCandidates =
    sourceHint !== undefined
      ? caseInsensitive
      : exactCase.length > 0
        ? exactCase
        : caseInsensitive;
  if (sourceHint !== undefined && matchingCandidates.length > 1) {
    const scored = matchingCandidates.map((candidate) => ({
      candidate,
      score: sourceAffinityScore(sourceHint, candidate),
    }));
    const maxScore = Math.max(...scored.map((item) => item.score));
    const best = scored.filter((item) => item.score === maxScore);
    if (maxScore > 0 && best.length === 1) return best[0]!.candidate;
  }
  if (exactCase.length === 1) return exactCase[0];
  return caseInsensitive.length === 1 ? caseInsensitive[0] : undefined;
}

export function taskCategory(value: unknown, explicit: unknown): string {
  const code = directString(value);
  const mapped = code === undefined ? undefined : TASK_TYPE_CODE_MAP[code];
  if (mapped !== undefined) return mapped;
  const direct = directString(explicit);
  if (direct !== undefined && isSafeTaskCategory(direct)) return direct;
  return code === undefined ? "unknown" : `taskType-${code}`;
}

function isSafeTaskCategory(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) &&
    !/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i.test(value)
  );
}

export function findStaleLegacyTaskDirectories(
  dataRoot: string,
  taskId: string,
  currentCategory: string,
): string[] {
  const tasksRoot = join(dataRoot, "tasks");
  if (!existsSync(tasksRoot) || taskId.includes("\\") || taskId.includes("/"))
    return [];
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== currentCategory &&
        existsSync(join(tasksRoot, entry.name, taskId, "task.json")),
    )
    .map((entry) => join("tasks", entry.name, taskId));
}

/**
 * Moves existing Task Pack directories for a task to a separate archive root.
 * The move is intentionally non-overwriting: an archive conflict must stop
 * the batch rather than risk losing or replacing evidence.
 */
export function relocateTaskPacks(
  dataRoot: string,
  archiveRoot: string,
  taskId: string,
): string[] {
  if (taskId.includes("\\") || taskId.includes("/")) return [];
  const sourceTasksRoot = join(dataRoot, "tasks");
  if (!existsSync(sourceTasksRoot)) return [];
  const moved: string[] = [];
  for (const entry of readdirSync(sourceTasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(sourceTasksRoot, entry.name, taskId);
    if (!existsSync(join(source, "task.json"))) continue;
    const destination = join(archiveRoot, "tasks", entry.name, taskId);
    if (existsSync(destination))
      throw new Error(`MANUAL_TASK_ARCHIVE_CONFLICT:${source}:${destination}`);
    mkdirSync(join(archiveRoot, "tasks", entry.name), { recursive: true });
    renameSync(source, destination);
    moved.push(destination);
  }
  return moved;
}

function throttleOpenCli(): void {
  const remaining = OPENCLI_MIN_INTERVAL_MS - (Date.now() - lastOpenCliCallAt);
  if (remaining > 0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
  lastOpenCliCallAt = Date.now();
}

function runOpenCli(
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
  timeoutMs = OPENCLI_DEFAULT_TIMEOUT_MS,
): string {
  const executable =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : "opencli";
  const executableArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "opencli.cmd", ...args]
      : [...args];
  return execFileSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env:
      environment === undefined
        ? undefined
        : { ...process.env, ...environment },
    timeout: timeoutMs,
  });
}

export function taskSourceCommandArguments(taskId: string): readonly string[] {
  const windowMode =
    process.env.OPENCLI_WINDOW === "background" ||
    process.env.OPENCLI_WINDOW === "foreground"
      ? process.env.OPENCLI_WINDOW
      : "foreground";
  return [
    "szdata",
    "task-source",
    "--task-id",
    taskId,
    "--full",
    "true",
    "--window",
    windowMode,
    "-f",
    "json",
  ];
}

function openCliTaskSource(taskId: string): Record<string, unknown> {
  throttleOpenCli();
  const output = runOpenCli(taskSourceCommandArguments(taskId));
  const parsed: unknown = JSON.parse(output);
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new Error(`OpenCLI returned no task evidence for ${taskId}`);
  return row as Record<string, unknown>;
}

function openCliHoraeDetail(taskId: string): Record<string, unknown> {
  throttleOpenCli();
  const output = runOpenCli(
    ["horae", "detail", taskId, "-f", "json"],
    {
      OPENCLI_BROWSER_COMMAND_TIMEOUT: String(
        Math.ceil(HORAE_FALLBACK_TIMEOUT_MS / 1000),
      ),
    },
    HORAE_FALLBACK_TIMEOUT_MS,
  );
  const parsed: unknown = JSON.parse(output);
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  return row as Record<string, unknown>;
}

function openCliHoraeSearch(
  taskIds: readonly string[],
  status?: string,
  cycle?: string,
): unknown {
  throttleOpenCli();
  const query = ["horae", "search", taskIds.join(","), "--type", "I"];
  if (status !== undefined) query.push("--status", status);
  if (cycle !== undefined) query.push("--cycle", cycle);
  query.push("--page", "1", "--size", String(taskIds.length), "-f", "json");
  const output = runOpenCli(query, undefined, HORAE_SEARCH_TIMEOUT_MS);
  return JSON.parse(output);
}

/**
 * Returns the exact task IDs that Horae labels as manual or frozen in a
 * bounded batch. The query is restricted to the requested IDs instead of
 * scanning the full Horae task catalog.
 */
export type TaskSchedulingClassification = {
  exclusionReason:
    "MANUAL_OR_FROZEN" | "HORAE_TASK_NOT_FOUND" | "PHYSICAL_TABLE_NOT_FOUND";
  scheduleCycle?: string;
  scheduleStatus?: string;
};

export type TaskCollectionPartition = {
  readonly runnableTaskIds: readonly string[];
  readonly manualFrozenTaskIds: readonly string[];
  readonly notFoundTaskIds: readonly string[];
};

export function partitionTaskIdsForCollection(
  taskIds: readonly string[],
  exclusions: ReadonlyMap<string, TaskSchedulingClassification>,
): TaskCollectionPartition {
  const manualFrozen = new Set(
    [...exclusions]
      .filter(([, classification]) =>
        classification.exclusionReason === "MANUAL_OR_FROZEN",
      )
      .map(([taskId]) => taskId),
  );
  const notFound = new Set(
    [...exclusions]
      .filter(([, classification]) =>
        classification.exclusionReason === "HORAE_TASK_NOT_FOUND" ||
        classification.exclusionReason === "PHYSICAL_TABLE_NOT_FOUND",
      )
      .map(([taskId]) => taskId),
  );
  return {
    runnableTaskIds: taskIds.filter(
      (taskId) => !manualFrozen.has(taskId) && !notFound.has(taskId),
    ),
    manualFrozenTaskIds: taskIds.filter((taskId) => manualFrozen.has(taskId)),
    notFoundTaskIds: taskIds.filter((taskId) => notFound.has(taskId)),
  };
}

export function isExcludedHoraeSearchRecord(
  record: Record<string, unknown>,
  query: { readonly status: string; readonly cycle?: string },
): boolean {
  const cycle = directString(record.cycle);
  if (query.cycle !== undefined && !isManualScheduleCycle(cycle)) return false;
  const status =
    directString(record.status) ?? directString(record.taskStatus);
  if (query.status !== "F") return false;
  return status === undefined || isFrozenScheduleStatus(status);
}

export function findExcludedTaskIds(
  taskIds: readonly string[],
  options: { readonly skipDetail?: boolean } = {},
): Map<string, TaskSchedulingClassification> {
  const requested = new Set(taskIds);
  const excluded = new Map<string, TaskSchedulingClassification>();
  const chunkSize = 100;
  for (let offset = 0; offset < taskIds.length; offset += chunkSize) {
    const chunk = taskIds.slice(offset, offset + chunkSize);
    const foundTaskIds = new Set<string>();
    for (const status of ["Y", "F", "C"] as const) {
      const allRows = openCliHoraeSearch(chunk, status);
      const allRecords = Array.isArray(allRows) ? allRows : [allRows];
      for (const value of allRecords) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          continue;
        const taskId = directString((value as Record<string, unknown>).id);
        if (taskId !== undefined && requested.has(taskId))
          foundTaskIds.add(taskId);
      }
    }
    for (const taskId of chunk) {
      if (!foundTaskIds.has(taskId))
        excluded.set(taskId, { exclusionReason: "HORAE_TASK_NOT_FOUND" });
    }
    for (const query of [{ status: "Y", cycle: "手工" }, { status: "F" }]) {
      const rows = openCliHoraeSearch(chunk, query.status, query.cycle);
      const records = Array.isArray(rows) ? rows : [rows];
      for (const value of records) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          continue;
        const record = value as Record<string, unknown>;
        const taskId = directString(record.id);
        if (taskId === undefined || !requested.has(taskId)) continue;
        if (excluded.get(taskId)?.exclusionReason === "HORAE_TASK_NOT_FOUND")
          continue;
        if (!isExcludedHoraeSearchRecord(record, query)) continue;
        const cycle = directString(record.cycle);
        const status =
          directString(record.status) ?? directString(record.taskStatus);
        excluded.set(taskId, {
          exclusionReason: "MANUAL_OR_FROZEN",
          ...(cycle ? { scheduleCycle: cycle } : {}),
          ...(query.status === "F" &&
          isFrozenScheduleStatus(status ?? query.status)
            ? { scheduleStatus: status ?? query.status }
            : {}),
        });
      }
    }
  }
  if (options.skipDetail === true) return excluded;
  for (const taskId of taskIds) {
    if (excluded.has(taskId)) continue;
    let detail: Record<string, unknown>;
    try {
      detail = openCliHoraeDetail(taskId);
    } catch (error) {
      throw new Error(`TASK_SCHEDULING_DETAIL_LOOKUP_FAILED:${taskId}`, {
        cause: error,
      });
    }
    if (Object.keys(detail).length === 0) {
      excluded.set(taskId, { exclusionReason: "HORAE_TASK_NOT_FOUND" });
    } else if (isManualScheduleCycle(detail.cycle))
      excluded.set(taskId, {
        exclusionReason: "MANUAL_OR_FROZEN",
        scheduleCycle: directString(detail.cycle),
      });
  }
  return excluded;
}

const HORAE_SQL_FIELDS: Readonly<Record<SqlSlot, readonly string[]>> = {
  create: ["createSql"],
  query: ["querySql"],
  prepare: ["prepareSql"],
  truncate: ["truncateSql"],
  finish: ["finishSql"],
};

function mergeHoraeSqlEvidence(
  row: Record<string, unknown>,
  horae: Record<string, unknown>,
): Record<string, unknown> {
  const sourceSlots =
    row.sqlSlots &&
    typeof row.sqlSlots === "object" &&
    !Array.isArray(row.sqlSlots)
      ? (row.sqlSlots as Record<string, unknown>)
      : {};
  const sqlSlots: Record<string, unknown> = { ...sourceSlots };
  for (const slot of SQL_SLOTS) {
    const current = sqlSlots[slot];
    const currentAvailable =
      current && typeof current === "object" && !Array.isArray(current)
        ? (current as Record<string, unknown>).available === true
        : false;
    if (currentAvailable) continue;
    const content = HORAE_SQL_FIELDS[slot]
      .map((field) => horae[field])
      .find(
        (value): value is string =>
          typeof value === "string" && value.trim() !== "",
      );
    if (content === undefined) continue;
    sqlSlots[slot] = {
      available: true,
      sql: content,
      source: "opencli:horae.detail",
      sources: ["opencli:horae.detail"],
    };
  }
  return { ...row, sqlSlots };
}

function needsHoraeSqlFallback(row: Record<string, unknown>): boolean {
  const status = directString(row.sqlStatus)?.toUpperCase();
  return status === "SQL_UNAVAILABLE" || status === "UNAVAILABLE";
}

function openCliJson(args: readonly string[]): unknown {
  throttleOpenCli();
  const output = runOpenCli([...args, "-f", "json"]);
  return JSON.parse(output);
}

function isMissingTableGuidError(error: unknown): boolean {
  return /guid\s*(?:不存在|不存在于|does not exist|not found)/i.test(
    String(error),
  );
}

function baseQualifiedName(value: string): string {
  return value.replace(/@[^@]+$/, "");
}

function dataSourceIdentifier(
  table: Record<string, unknown>,
  rawQualifiedName: string,
): string | undefined {
  const direct =
    directString(table.dataSourceId) ?? directString(table.dataSourceCode);
  if (direct !== undefined) return direct;
  const suffix = rawQualifiedName.match(/@([^@]+)$/)?.[1];
  if (suffix !== undefined && suffix !== "-") return suffix;
  const display = directString(table.dataSource);
  if (display === undefined) return DEFAULT_DATA_SOURCE_ID;
  if (KNOWN_DATA_SOURCE_IDS.has(display)) return display;
  if (DATA_SOURCE_ID_OVERRIDES[display] !== undefined)
    return DATA_SOURCE_ID_OVERRIDES[display];
  return display.includes("#") ? display : DEFAULT_DATA_SOURCE_ID;
}

function directTableName(value: unknown): string | undefined {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && !Array.isArray(value)
        ? directString((value as Record<string, unknown>).qualifiedName)
        : undefined;
  if (raw === undefined || raw.trim() === "" || raw === "-") return undefined;
  const qualifiedName = baseQualifiedName(raw.trim());
  return qualifiedName.includes(".") ? qualifiedName : undefined;
}

function isAmbiguousPhysicalTableError(error: unknown): boolean {
  return /Ambiguous physical table/i.test(String(error));
}

function exactTableSearchByDataSource(
  qualifiedName: string,
  expectedDataSource: string,
): Record<string, unknown> | undefined {
  const searched = openCliJson([
    "szdata",
    "table-search",
    "--keyword",
    qualifiedName,
    "--type",
    "003000",
    "--size",
    "10",
  ]);
  const candidates = (Array.isArray(searched) ? searched : [searched]).filter(
    (item): item is Record<string, unknown> => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      const candidateName = directString(item.qualifiedName);
      if (candidateName === undefined) return false;
      return baseQualifiedName(candidateName).toLowerCase() === qualifiedName.toLowerCase();
    },
  );
  const expected = expectedDataSource.toLowerCase();
  const matches = candidates.filter((item) => {
    const candidateName = directString(item.qualifiedName);
    if (candidateName === undefined) return false;
    const at = candidateName.lastIndexOf("@");
    return at > 0 && candidateName.slice(at + 1).toLowerCase() === expected;
  });
  const uniquePhysicalNames = new Map<string, Record<string, unknown>>();
  for (const match of matches) {
    const candidateName = directString(match.qualifiedName);
    if (candidateName !== undefined)
      uniquePhysicalNames.set(candidateName.toLowerCase(), match);
  }
  return uniquePhysicalNames.size === 1
    ? [...uniquePhysicalNames.values()][0]
    : undefined;
}

/**
 * Returns only direct endpoint values that are expected to be physical table
 * references but cannot be resolved. A bare source value is a task data-source
 * label in heterogeneous extract tasks; its physical identity comes from SQL
 * READ evidence and Table Pack resolution.
 */
export function unresolvedPhysicalEndpointReference(
  side: "source" | "target",
  value: unknown,
  taskCategory: string | null | undefined,
): string | undefined {
  if (side === "source" || typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed === "-" ||
    directTableName(trimmed) !== undefined ||
    controlledTaskEndpointDataSource(taskCategory, side) !== undefined
  )
    return undefined;
  return trimmed;
}

function tablePlatform(
  typeName: unknown,
  ddlType: unknown,
): string | undefined {
  const directDdlType = directString(ddlType);
  if (directDdlType !== undefined)
    return directDdlType.split("/", 1)[0]!.trim().toLowerCase();
  if (
    typeof typeName !== "string" ||
    typeName.trim() === "" ||
    typeName === "-"
  )
    return undefined;
  const platform = typeName
    .split("/", 1)[0]!
    .trim()
    .replace(/_table$/i, "");
  const normalized = platform.toLowerCase();
  return normalized === "gf_rdbms" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)
    ? undefined
    : normalized;
}

function tableSummaryByName(
  qualifiedName: string,
): Record<string, unknown> | undefined {
  const separator = qualifiedName.indexOf(".");
  if (separator <= 0 || separator === qualifiedName.length - 1)
    return undefined;
  const db = qualifiedName.slice(0, separator);
  const tableName = qualifiedName.slice(separator + 1);
  const result = openCliJson([
    "szdata",
    "table",
    "--db",
    db,
    "--table",
    tableName,
    "--view",
    "full",
  ]);
  const row =
    result && typeof result === "object" && !Array.isArray(result)
      ? result
      : Array.isArray(result)
        ? result[0]
        : undefined;
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const table = row.table;
  if (!table || typeof table !== "object" || Array.isArray(table))
    return undefined;
  const structure = row.structure;
  return {
    ...(table as Record<string, unknown>),
    taskIds: tableTaskIds((row as Record<string, unknown>).tasks),
    partitionFields:
      structure && typeof structure === "object" && !Array.isArray(structure)
        ? (structure as Record<string, unknown>).partitionFields
        : undefined,
  };
}

export type TableEvidenceLookupOptions = {
  /** Prefer the exact db/table lookup before the broader search endpoint. */
  preferDirectLookup?: boolean;
  /** Use only the exact db/table endpoint; useful for bounded repair scans. */
  directOnly?: boolean;
  /** Do not make a second metadata call only to refresh a missing description. */
  skipDescriptionRefresh?: boolean;
  /** A connector/source label used only to rank otherwise ambiguous candidates. */
  sourceHint?: string;
  /** The physical platform expected from the controlled task category. */
  expectedPlatform?: string;
  /** Preserve upstream 403/429/timeout errors for bounded repair manifests. */
  throwOnLookupError?: boolean;
};

function tableFromDirectEvidenceUncached(
  qualifiedName: string,
  requiredTaskId?: string,
  expectedDataSource?: string,
  options: TableEvidenceLookupOptions = {},
): TableEvidence | undefined {
  let table: Record<string, unknown> | undefined;
  let tableDiscovery = "table-search";
  if (options.preferDirectLookup) {
    if (options.directOnly && expectedDataSource !== undefined) {
      table = exactTableSearchByDataSource(qualifiedName, expectedDataSource);
      if (table !== undefined) tableDiscovery = "table-search-exact";
    } else {
      try {
        table = tableSummaryByName(qualifiedName);
        if (table !== undefined) tableDiscovery = "table";
      } catch (error) {
        if (
          expectedDataSource !== undefined &&
          isAmbiguousPhysicalTableError(error)
        ) {
          table = exactTableSearchByDataSource(qualifiedName, expectedDataSource);
          if (table !== undefined) tableDiscovery = "table-search-exact";
          else if (options.throwOnLookupError) throw error;
        } else {
          if (options.throwOnLookupError) throw error;
          table = undefined;
        }
      }
    }
  }
  if (requiredTaskId === undefined && !options.directOnly) {
    if (table === undefined) {
      try {
        const searched = openCliJson([
          "szdata",
          "table-search",
          "--keyword",
          qualifiedName,
          "--type",
          "003000",
          "--size",
          "10",
        ]);
        const candidates = (
          Array.isArray(searched) ? searched : [searched]
        ).filter((item): item is Record<string, unknown> => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            return false;
          return (
            typeof item.qualifiedName === "string" &&
            baseQualifiedName(item.qualifiedName).toLowerCase() ===
              qualifiedName.toLowerCase()
          );
        });
        table = selectTableCandidate(
          candidates,
          qualifiedName,
          expectedDataSource,
          options.sourceHint,
        );
        } catch (error) {
          if (options.throwOnLookupError) throw error;
          table = undefined;
        }
    }
  }
  if (
    table === undefined &&
    !options.preferDirectLookup &&
    !options.directOnly
  ) {
    try {
      table = tableSummaryByName(qualifiedName);
      if (table !== undefined)
        tableDiscovery =
          requiredTaskId === undefined ? "table" : "table-task-relation";
    } catch (error) {
      if (options.throwOnLookupError) throw error;
      table = undefined;
    }
  }
  if (table === undefined) return undefined;
  const searchDescription =
    directOptionalString(table.description) ??
    directOptionalString(table.comment);
  if (searchDescription !== undefined)
    table = { ...table, description: searchDescription };
  if (
    !options.skipDescriptionRefresh &&
    directOptionalString(table.description) === undefined
  ) {
    try {
      const summary = tableSummaryByName(qualifiedName);
      const description =
        summary === undefined
          ? undefined
          : directOptionalString(summary.description);
      if (description !== undefined) table = { ...table, description };
    } catch (error) {
      if (options.throwOnLookupError) throw error;
      // The Table search result remains valid even when display metadata is unavailable.
    }
  }
  if (
    requiredTaskId !== undefined &&
    !tableTaskIds(table.taskIds)?.includes(requiredTaskId)
  )
    return undefined;
  if (
    typeof table.guid !== "string" ||
    table.guid.trim() === "" ||
    table.guid === "-"
  )
    return undefined;
  let ddlResult: unknown;
  try {
    ddlResult = openCliJson(["szdata", "table-ddl", "--guid", table.guid]);
  } catch (error) {
    if (isMissingTableGuidError(error)) return undefined;
    throw error;
  }
  const ddlRow = (Array.isArray(ddlResult) ? ddlResult : [ddlResult])[0];
  if (
    !ddlRow ||
    typeof ddlRow !== "object" ||
    Array.isArray(ddlRow) ||
    typeof ddlRow.ddl !== "string" ||
    ddlRow.ddl.trim() === ""
  )
    return undefined;
  const partition =
    typeof ddlRow.partition === "string" &&
    ddlRow.partition.trim() !== "" &&
    ddlRow.partition !== "-"
      ? ddlRow.partition
          .split(",")
          .map((field: string) => field.trim())
          .filter(Boolean)
      : (directStringArray(table.partitionFields) ?? []);
  const platform = tablePlatform(table.typeName, ddlRow.type ?? table.dbType);
  const dataSource = dataSourceIdentifier(
    table,
    typeof ddlRow.qualifiedName === "string"
      ? ddlRow.qualifiedName
      : typeof table.qualifiedName === "string"
        ? table.qualifiedName
        : qualifiedName,
  );
  if (platform === undefined || dataSource === undefined) return undefined;
  if (
    expectedDataSource !== undefined &&
    dataSource.toLowerCase() !== expectedDataSource.toLowerCase()
  )
    return undefined;
  if (
    options.expectedPlatform !== undefined &&
    platform !== options.expectedPlatform.toLowerCase()
  )
    return undefined;
  const canonicalQualifiedName = baseQualifiedName(
    typeof ddlRow.qualifiedName === "string"
      ? ddlRow.qualifiedName
      : typeof table.qualifiedName === "string"
        ? table.qualifiedName
        : qualifiedName,
  );
  const canonicalParts = canonicalQualifiedName.split(".");
  return {
    guid: table.guid,
    platform,
    dataSource,
    qualifiedName: canonicalQualifiedName,
    schema:
      canonicalParts.length > 1 ? canonicalParts.slice(0, -1).join(".") : null,
    name: canonicalParts.at(-1) ?? null,
    description: directOptionalString(table.description),
    objectType:
      typeof table.typeName === "string" && table.typeName !== "-"
        ? table.typeName
        : "UNKNOWN",
    status: directOptionalString(table.status),
    primaryKey: directStringArray(ddlRow.primaryKey ?? table.primaryKey),
    partitionFields: partition,
    ddl: ddlRow.ddl,
    evidenceProvider: `opencli:szdata ${tableDiscovery}+table-ddl`,
  };
}

export function tableFromDirectEvidence(
  qualifiedName: string,
  requiredTaskId?: string,
  expectedDataSource?: string,
  options: TableEvidenceLookupOptions = {},
): TableEvidence | undefined {
  const cacheKey = `${cachedTableKey(qualifiedName)}@@${
    expectedDataSource?.toLowerCase() ?? "*"
  }@@${requiredTaskId ?? "*"}@@${
    options.sourceHint?.toLowerCase() ?? "*"
  }@@${options.expectedPlatform?.toLowerCase() ?? "*"}`;
  if (directEvidenceCache.has(cacheKey))
    return directEvidenceCache.get(cacheKey);

  const persisted =
    persistedTableCache.get(cachedTableKey(qualifiedName)) ?? [];
  const persistedMatches = persisted.filter(
    (item) =>
      (expectedDataSource === undefined ||
        item.dataSource.toLowerCase() === expectedDataSource.toLowerCase()) &&
      (requiredTaskId === undefined ||
        // A persisted Table is reusable only for direct evidence. A task
        // relation lookup still needs the live relation check below.
        item.evidenceProvider.includes("table-task-relation") === false),
  );
  if (
    requiredTaskId === undefined &&
    persistedMatches.length === 1 &&
    (options.sourceHint === undefined ||
      sourceAffinityScore(options.sourceHint, persistedMatches[0]!) > 0) &&
    (options.expectedPlatform === undefined ||
      persistedMatches[0]!.platform === options.expectedPlatform.toLowerCase())
  ) {
    const evidence = persistedMatches[0];
    directEvidenceCache.set(cacheKey, evidence);
    return evidence;
  }

  const evidence = tableFromDirectEvidenceUncached(
    qualifiedName,
    requiredTaskId,
    expectedDataSource,
    options,
  );
  if (evidence !== undefined) directEvidenceCache.set(cacheKey, evidence);
  return evidence;
}

function taskNameTableCandidate(taskName: unknown): string | undefined {
  const value = directString(taskName);
  if (value === undefined) return undefined;
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const schema = value.slice(0, separator);
  const tableName = value
    .slice(separator + 1)
    .replace(/_TIT\d+(?:_h\d+)?$/i, "");
  return tableName === "" ? undefined : `${schema}.${tableName}`;
}

function tableFromTaskRelation(
  taskId: string,
  taskName: unknown,
  expectedDataSource?: string,
): TableEvidence | undefined {
  const candidate = taskNameTableCandidate(taskName);
  return candidate === undefined
    ? undefined
    : tableFromDirectEvidence(candidate, taskId, expectedDataSource);
}

function availableSqlSlots(row: Record<string, unknown>): SqlSlot[] {
  const slots = row.sqlSlots;
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) return [];
  return SQL_SLOTS.filter((slot) => {
    const entry = (slots as Record<string, unknown>)[slot];
    return (
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).available === true &&
      typeof (entry as Record<string, unknown>).sql === "string" &&
      ((entry as Record<string, unknown>).sql as string).length > 0
    );
  });
}

function sqlEvidenceProvider(
  evidence: TaskEvidence,
  slot: SqlSlot,
): string | undefined {
  const slotEvidence = evidence.sql?.[slot];
  if (
    !slotEvidence ||
    typeof slotEvidence === "string" ||
    typeof slotEvidence !== "object"
  )
    return undefined;
  return directString(slotEvidence.evidenceProvider);
}

export function normalizeRepeatedSqlContent(content: string): {
  content: string;
  duplicateBlocksRemoved: boolean;
} {
  const normalized = normalizeRepeatedSqlForAnalysis(content);
  return {
    content: normalized,
    duplicateBlocksRemoved: false,
  };
}

function looksLikeOrphanedCommentContinuation(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^CONCAT\s*\(/i.test(trimmed) ||
    /^ELSE\s+.+\s+END\s*$/i.test(trimmed) ||
    /^<br>/i.test(trimmed) ||
    /^\d+\s+[\u3400-\u9fff]/.test(trimmed) ||
    /^[A-Z]\s+[\u3400-\u9fff]/.test(trimmed) ||
    /^[A-Za-z_][A-Za-z0-9_]*:[^\s]+/.test(trimmed) ||
    /^[\u3400-\u9fff]/.test(trimmed)
  );
}

/**
 * Restores line-comment markers lost when multi-line task-source comments were
 * flattened. Only annotation-shaped lines immediately following a comment
 * ending in a semicolon, or a commented CASE fragment, are changed.
 */
export function repairOrphanedSqlCommentContinuations(content: string): {
  content: string;
  continuationLinesRepaired: number;
} {
  const lines = content.split("\n");
  let continuationLinesRepaired = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*--/.test(line) || !looksLikeOrphanedCommentContinuation(line))
      continue;
    let previousIndex = index - 1;
    while (previousIndex >= 0 && /^\s*$/.test(lines[previousIndex] ?? ""))
      previousIndex -= 1;
    if (previousIndex < 0) continue;
    const previous = lines[previousIndex] ?? "";
    const commentIndex = previous.indexOf("--");
    if (commentIndex < 0) continue;
    const comment = previous.slice(commentIndex + 2);
    if (!/[;；]\s*$/.test(comment) && !/\bCASE\b/i.test(comment))
      continue;
    const indentation = /^\s*/.exec(line)?.[0] ?? "";
    lines[index] = `${indentation}-- ${line.slice(indentation.length)}`;
    continuationLinesRepaired += 1;
  }
  return { content: lines.join("\n"), continuationLinesRepaired };
}

const CONCATENATED_SQL_STATEMENT_STARTERS = new Set([
  "ALTER",
  "BEGIN",
  "CALL",
  "CREATE",
  "DELETE",
  "DESCRIBE",
  "DROP",
  "EXPLAIN",
  "GRANT",
  "INSERT",
  "MERGE",
  "SELECT",
  "SET",
  "SHOW",
  "TRUNCATE",
  "UPDATE",
  "USE",
  "WITH",
]);

const CONCATENATED_SQL_CONTINUATION_WORDS = new Set([
  "ALL",
  "AND",
  "AS",
  "DISTINCT",
  "ELSE",
  "EXCEPT",
  "FROM",
  "IN",
  "INTERSECT",
  "JOIN",
  "ON",
  "OR",
  "THEN",
  "UNION",
  "WHEN",
  "WHERE",
]);

export type InlineSqlCommentBoundaryKind =
  | "COMMA_SELECT_ITEM"
  | "COMMA_COLUMN_DEFINITION"
  | "FROM_SUBQUERY"
  | "UNION_SELECT"
  | "CASE_WHEN"
  | "CASE_ELSE"
  | "TYPED_JOIN"
  | "JOIN_ON";

type InlineSqlCommentBoundary = {
  index: number;
  kind: InlineSqlCommentBoundaryKind;
};

const SQL_IDENTIFIER_PATTERN = String.raw`(?:[A-Za-z_][A-Za-z0-9_$]*|\x60[^\x60]+\x60|"[^"]+")`;
const SQL_QUALIFIED_IDENTIFIER_PATTERN = String.raw`${SQL_IDENTIFIER_PATTERN}(?:\s*\.\s*${SQL_IDENTIFIER_PATTERN})+`;
const SQL_SIMPLE_VALUE_PATTERN = String.raw`(?:N?'(?:''|[^'])*'|[-+]?\d+(?:\.\d+)?|NULL|${SQL_QUALIFIED_IDENTIFIER_PATTERN}|${SQL_IDENTIFIER_PATTERN})`;

function inlineCommentBoundaryCandidates(
  comment: string,
  followingContent: string,
): InlineSqlCommentBoundary[] {
  const candidates: InlineSqlCommentBoundary[] = [];
  const followingColumnDefinition =
    /^\s*[A-Za-z_][A-Za-z0-9_$]*\s+(?:STRING|CHAR|VARCHAR|DECIMAL|NUMERIC|TINYINT|SMALLINT|INT|INTEGER|BIGINT|FLOAT|DOUBLE|BOOLEAN|DATE|TIMESTAMP|BINARY|ARRAY|MAP|STRUCT)\b/i.test(
      followingContent,
    );
  if (/,\s*$/.test(comment) && followingColumnDefinition) {
    candidates.push({
      index: comment.lastIndexOf(","),
      kind: "COMMA_COLUMN_DEFINITION",
    });
  }
  const patterns: ReadonlyArray<{
    kind: InlineSqlCommentBoundaryKind;
    pattern: RegExp;
  }> = [
    {
      kind: "COMMA_SELECT_ITEM",
      pattern: new RegExp(
        String.raw`,\s*${SQL_SIMPLE_VALUE_PATTERN}\s+AS\s+${SQL_IDENTIFIER_PATTERN}\b`,
        "gi",
      ),
    },
    {
      kind: "UNION_SELECT",
      pattern: /\bUNION\s+(?:ALL\s+)?SELECT\b/gi,
    },
    {
      kind: "CASE_WHEN",
      pattern: new RegExp(
        String.raw`\bWHEN\s+${SQL_QUALIFIED_IDENTIFIER_PATTERN}\s+IS\s+(?:NOT\s+)?NULL\b`,
        "gi",
      ),
    },
    {
      kind: "CASE_ELSE",
      pattern: new RegExp(
        String.raw`\bELSE\s+${SQL_SIMPLE_VALUE_PATTERN}\s+END\b`,
        "gi",
      ),
    },
    {
      kind: "TYPED_JOIN",
      pattern: new RegExp(
        String.raw`\b(?:FULL\s+OUTER|LEFT\s+OUTER|RIGHT\s+OUTER|INNER|CROSS)\s+JOIN\s+(?:\(|${SQL_QUALIFIED_IDENTIFIER_PATTERN})`,
        "gi",
      ),
    },
    {
      kind: "JOIN_ON",
      pattern: new RegExp(
        String.raw`\bON\s+${SQL_QUALIFIED_IDENTIFIER_PATTERN}\s*(?:=|<>|!=|<=|>=|<|>)\s*${SQL_QUALIFIED_IDENTIFIER_PATTERN}\b`,
        "gi",
      ),
    },
  ];

  for (const { kind, pattern } of patterns) {
    for (const match of comment.matchAll(pattern)) {
      if (match.index === undefined) continue;
      candidates.push({ index: match.index, kind });
    }
  }

  const fromSubquery = /\bFROM\s*\(/gi;
  for (const match of comment.matchAll(fromSubquery)) {
    if (match.index === undefined) continue;
    const afterOpeningParenthesis = comment
      .slice(match.index + match[0].length)
      .trimStart();
    const continuesInline = /^(?:SELECT|WITH)\b/i.test(afterOpeningParenthesis);
    const continuesOnNextLine =
      afterOpeningParenthesis === "" &&
      /^(?:SELECT|WITH)\b/i.test(followingContent);
    if (continuesInline || continuesOnNextLine)
      candidates.push({ index: match.index, kind: "FROM_SUBQUERY" });
  }

  return candidates
    .filter(({ index }) => {
      const precedingComment = comment.slice(0, index);
      const nestedComment = precedingComment.lastIndexOf("--");
      return precedingComment.slice(nestedComment + 2).trim() !== "";
    })
    .sort((left, right) => left.index - right.index);
}

/**
 * Repairs only strongly structured SQL continuations that a flattened inline
 * `--` comment would otherwise swallow. String literals, quoted identifiers,
 * block comments, line-only comments, and ordinary prose remain byte-for-byte
 * unchanged.
 */
export function repairInlineSqlCommentBoundaries(content: string): {
  content: string;
  boundariesInserted: number;
  boundaryKinds: readonly InlineSqlCommentBoundaryKind[];
} {
  const insertions = new Map<number, InlineSqlCommentBoundaryKind>();
  let blockComment = false;
  let quote: "'" | '"' | "`" | undefined;
  let lineHasSqlCode = false;

  for (let index = 0; index < content.length;) {
    const character = content[index];
    const nextCharacter = content[index + 1];

    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 2;
        continue;
      }
      if (character === "\n") lineHasSqlCode = false;
      index += 1;
      continue;
    }

    if (quote !== undefined) {
      if (character === quote) {
        if (content[index + 1] === quote) {
          index += 2;
          continue;
        }
        quote = undefined;
      }
      if (character === "\n") lineHasSqlCode = false;
      index += 1;
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      lineHasSqlCode = true;
      index += 1;
      continue;
    }
    if (character === "-" && nextCharacter === "-") {
      const lineEnd = content.indexOf("\n", index + 2);
      const commentEnd = lineEnd === -1 ? content.length : lineEnd;
      if (lineHasSqlCode) {
        const comment = content.slice(index + 2, commentEnd);
        const followingContent =
          lineEnd === -1
            ? ""
            : (content
                .slice(lineEnd + 1)
                .match(/^(?:[ \t]*\n)*[ \t]*(.*)/)?.[1] ?? "");
        for (const candidate of inlineCommentBoundaryCandidates(
          comment,
          followingContent,
        )) {
          const absoluteIndex = index + 2 + candidate.index;
          if (!insertions.has(absoluteIndex))
            insertions.set(absoluteIndex, candidate.kind);
        }
      }
      index = commentEnd;
      continue;
    }
    if (character === "\n") {
      lineHasSqlCode = false;
      index += 1;
      continue;
    }
    if (!/\s/.test(character)) lineHasSqlCode = true;
    index += 1;
  }

  const orderedInsertions = [...insertions.entries()].sort(
    ([left], [right]) => left - right,
  );
  let normalized = content;
  for (let index = orderedInsertions.length - 1; index >= 0; index -= 1) {
    const position = orderedInsertions[index][0];
    normalized = `${normalized.slice(0, position)}\n${normalized.slice(position)}`;
  }
  return {
    content: normalized,
    boundariesInserted: orderedInsertions.length,
    boundaryKinds: orderedInsertions.map(([, kind]) => kind),
  };
}

function isSqlIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

function isSqlIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function nextSqlWord(content: string, start: number): string | undefined {
  let index = start;
  while (index < content.length && /\s/.test(content[index])) index += 1;
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(content.slice(index));
  return match?.[0].toUpperCase();
}

/**
 * Removes separator artifacts written by the pre-v1 collector. A semicolon
 * inside an open subquery, or a duplicate semicolon after an already closed
 * statement, is not a valid statement boundary. Semicolons in literals and
 * comments are left untouched.
 */
export function repairLegacyStatementSeparators(content: string): {
  content: string;
  separatorsRemoved: number;
} {
  const removals = new Set<number>();
  let blockComment = false;
  let lineComment = false;
  let quote: "'" | '"' | "`" | undefined;
  let parenthesisDepth = 0;
  let lastSignificantWasSemicolon = false;
  const continuationWords = new Set([
    "SELECT",
    "WITH",
    "UNION",
    "FROM",
    "JOIN",
    "CASE",
    "WHEN",
    "ELSE",
  ]);

  for (let index = 0; index < content.length;) {
    const character = content[index];
    const nextCharacter = content[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      index += 1;
      continue;
    }
    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 2;
      } else index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        if (nextCharacter === quote) index += 2;
        else {
          quote = undefined;
          index += 1;
        }
      } else index += 1;
      continue;
    }
    if (character === "-" && nextCharacter === "-") {
      lineComment = true;
      index += 2;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      lastSignificantWasSemicolon = false;
      index += 1;
      continue;
    }
    if (character === ";") {
      const nextWord = nextSqlWord(content, index + 1);
      if (
        lastSignificantWasSemicolon ||
        (parenthesisDepth > 0 &&
          nextWord !== undefined &&
          continuationWords.has(nextWord))
      )
        removals.add(index);
      else lastSignificantWasSemicolon = true;
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "(") parenthesisDepth += 1;
    else if (character === ")" && parenthesisDepth > 0) parenthesisDepth -= 1;
    lastSignificantWasSemicolon = false;
    index += 1;
  }

  if (removals.size === 0) return { content, separatorsRemoved: 0 };
  return {
    content: [...content].filter((_, index) => !removals.has(index)).join(""),
    separatorsRemoved: removals.size,
  };
}

/**
 * Repairs a known task-source boundary artifact without dropping either SQL
 * fragment. The source service can concatenate independently returned SQL
 * bodies; when the next top-level statement starts on a new line, the parser
 * needs an explicit separator.
 */
export function normalizeConcatenatedSqlStatements(content: string): {
  content: string;
  separatorsInserted: number;
  inlineCommentBoundariesInserted: number;
  inlineCommentBoundaryKinds: readonly InlineSqlCommentBoundaryKind[];
} {
  const repaired = repairInlineSqlCommentBoundaries(content);
  content = repaired.content;
  const insertionPositions: number[] = [];
  let blockComment = false;
  let lineComment = false;
  let quote: "'" | '"' | "`" | undefined;
  let parenthesisDepth = 0;
  let lineOnlyWhitespace = true;
  let lineStart = 0;
  let statementKeyword: string | undefined;
  let topLevelSelectSeen = false;
  let topLevelFromSeen = false;
  let topLevelValuesSeen = false;
  let lastTopLevelWord: string | undefined;
  let lastSignificantCharacter: string | undefined;

  const resetStatement = (): void => {
    statementKeyword = undefined;
    topLevelSelectSeen = false;
    topLevelFromSeen = false;
    topLevelValuesSeen = false;
    lastTopLevelWord = undefined;
  };

  for (let index = 0; index < content.length;) {
    const character = content[index];
    const nextCharacter = content[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        lineOnlyWhitespace = true;
        lineStart = index + 1;
      }
      index += 1;
      continue;
    }

    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 2;
        continue;
      }
      if (character === "\n") {
        lineOnlyWhitespace = true;
        lineStart = index + 1;
      }
      index += 1;
      continue;
    }

    if (quote !== undefined) {
      if (character === quote) {
        if (content[index + 1] === quote) {
          index += 2;
          continue;
        }
        quote = undefined;
      }
      index += 1;
      continue;
    }

    if (character === "-" && nextCharacter === "-") {
      lineComment = true;
      index += 2;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      lineOnlyWhitespace = false;
      lastSignificantCharacter = character;
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      if (character === "\n") {
        lineOnlyWhitespace = true;
        lineStart = index + 1;
      }
      index += 1;
      continue;
    }

    if (character === "(") {
      parenthesisDepth += 1;
      lineOnlyWhitespace = false;
      lastSignificantCharacter = character;
      index += 1;
      continue;
    }
    if (character === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      lineOnlyWhitespace = false;
      lastSignificantCharacter = character;
      index += 1;
      continue;
    }
    if (character === ";" && parenthesisDepth === 0) {
      resetStatement();
      lineOnlyWhitespace = false;
      lastSignificantCharacter = character;
      index += 1;
      continue;
    }

    if (parenthesisDepth === 0 && isSqlIdentifierStart(character)) {
      let end = index + 1;
      while (isSqlIdentifierPart(content[end])) end += 1;
      const word = content.slice(index, end).toUpperCase();
      const isStatementStarter = CONCATENATED_SQL_STATEMENT_STARTERS.has(word);
      const canStartNewStatement =
        lineOnlyWhitespace &&
        isStatementStarter &&
        statementKeyword !== undefined &&
        lastSignificantCharacter !== ";" &&
        !CONCATENATED_SQL_CONTINUATION_WORDS.has(lastTopLevelWord ?? "") &&
        (word !== "SELECT" ||
          statementKeyword === "SELECT" ||
          topLevelSelectSeen ||
          topLevelFromSeen ||
          topLevelValuesSeen);

      if (canStartNewStatement) {
        insertionPositions.push(lineStart);
        resetStatement();
      }

      if (isStatementStarter && statementKeyword === undefined)
        statementKeyword = word;
      if (word === "SELECT") topLevelSelectSeen = true;
      if (word === "FROM") topLevelFromSeen = true;
      if (word === "VALUES") topLevelValuesSeen = true;
      lastTopLevelWord = word;
      lineOnlyWhitespace = false;
      lastSignificantCharacter = character;
      index = end;
      continue;
    }

    lineOnlyWhitespace = false;
    lastSignificantCharacter = character;
    index += 1;
  }

  let normalized = content;
  for (let index = insertionPositions.length - 1; index >= 0; index -= 1) {
    const position = insertionPositions[index];
    normalized = `${normalized.slice(0, position)};\n${normalized.slice(position)}`;
  }
  return {
    content: normalized,
    separatorsInserted: insertionPositions.length,
    inlineCommentBoundariesInserted: repaired.boundariesInserted,
    inlineCommentBoundaryKinds: repaired.boundaryKinds,
  };
}

export function normalizeCollectedSqlSlot(
  content: string,
  slot: SqlSlot,
  evidenceProvider: string,
): {
  content: string;
  evidenceProvider: string;
  warnings: string[];
} {
  const repeated = normalizeRepeatedSqlContent(content);
  const orphaned = repairOrphanedSqlCommentContinuations(repeated.content);
  const inlineRepaired = repairInlineSqlCommentBoundaries(orphaned.content);
  const legacy = repairLegacyStatementSeparators(inlineRepaired.content);
  const separated = normalizeConcatenatedSqlStatements(legacy.content);
  const warnings: string[] = [];
  if (repeated.duplicateBlocksRemoved)
    warnings.push(`SQL_DUPLICATE_BLOCK_REMOVED:${slot}`);
  if (orphaned.continuationLinesRepaired > 0) {
    warnings.push(
      `SQL_ORPHANED_COMMENT_CONTINUATION_REPAIRED:${slot}:${orphaned.continuationLinesRepaired}`,
    );
    evidenceProvider = `${evidenceProvider},collector:orphaned-comment-continuation-repair-v1`;
  }
  if (legacy.separatorsRemoved > 0) {
    warnings.push(
      `SQL_LEGACY_SEPARATOR_REPAIRED:${slot}:${legacy.separatorsRemoved}`,
    );
    evidenceProvider = `${evidenceProvider},collector:legacy-separator-repair-v1`;
  }
  const inlineCommentBoundariesInserted =
    inlineRepaired.boundariesInserted +
    separated.inlineCommentBoundariesInserted;
  const inlineCommentBoundaryKinds = [
    ...inlineRepaired.boundaryKinds,
    ...separated.inlineCommentBoundaryKinds,
  ];
  if (inlineCommentBoundariesInserted > 0) {
    const counts = new Map<InlineSqlCommentBoundaryKind, number>();
    for (const kind of inlineCommentBoundaryKinds)
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const evidence = [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `${kind}=${count}`)
      .join(",");
    warnings.push(
      `SQL_INLINE_COMMENT_BOUNDARY_REPAIRED:${slot}:${inlineCommentBoundariesInserted}:${evidence}`,
    );
    evidenceProvider = `${evidenceProvider},collector:inline-comment-boundary-repair-v1`;
  }
  if (separated.separatorsInserted > 0)
    warnings.push(
      `SQL_STATEMENT_SEPARATOR_INSERTED:${slot}:${separated.separatorsInserted}`,
    );
  return {
    content: separated.content,
    evidenceProvider,
    warnings,
  };
}

/**
 * Convert the platform task-source row into Task Evidence without rewriting
 * SQL. The SQL body is canonical source evidence; parser repairs, when ever
 * needed, belong to a derived analysis view and must not replace this value.
 */
export function toTaskEvidence(
  taskId: string,
  row: Record<string, unknown>,
): { evidence: TaskEvidence; warnings: string[] } {
  const slots = row.sqlSlots;
  const sql: Partial<
    Record<SqlSlot, { content: string; evidenceProvider: string }>
  > = {};
  const warnings: string[] = [];
  if (slots && typeof slots === "object" && !Array.isArray(slots)) {
    for (const slot of SQL_SLOTS) {
      const entry = (slots as Record<string, unknown>)[slot];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (
        record.available !== true ||
        typeof record.sql !== "string" ||
        record.sql.length === 0
      )
        continue;
      const sources = Array.isArray(record.sources)
        ? record.sources.filter(
            (source): source is string =>
              typeof source === "string" &&
              source.trim() !== "" &&
              source !== "-",
          )
        : [];
      const provider =
        sources.length > 0
          ? sources.join(",")
          : typeof record.source === "string" && record.source !== "-"
            ? record.source
            : "opencli:szdata.task-source";
      // Keep the exact platform-returned SQL in the canonical Input Pack.
      // Do not run comment/separator repair here: those transforms are
      // derived analysis concerns and must never overwrite source evidence.
      sql[slot] = {
        content: record.sql,
        evidenceProvider: provider,
      };
    }
  }
  return {
    evidence: {
      taskId,
      taskCategory: taskCategory(row.taskType, row.taskTypeName),
      taskType: directString(row.taskType),
      taskName: directOptionalString(row.taskName),
      topicName: directOptionalString(row.topicName),
      scheduleCycle: directOptionalString(row.scheduleCycle ?? row.cycle),
      scheduleStatus: directOptionalString(row.scheduleStatus),
      source: directValue(row.source),
      target: directValue(row.target),
      writeMode: directString(row.loadMode),
      schedulerEvidence:
        directString(row.hivePartition) === undefined
          ? undefined
          : {
              hivePartition: directString(row.hivePartition),
              evidenceProvider: "opencli:szdata.task-source",
            },
      sql,
      evidenceProvider: "opencli:szdata.task-source",
    },
    warnings,
  };
}

function tableEvidenceFor(
  tableResults: readonly {
    qualifiedName: string;
    evidence: TableEvidence | undefined;
  }[],
  qualifiedName: string | undefined,
): TableEvidence | undefined {
  if (qualifiedName === undefined) return undefined;
  return tableResults.find(
    (item) =>
      item.evidence !== undefined &&
      item.qualifiedName.toLowerCase() === qualifiedName.toLowerCase(),
  )?.evidence;
}

function directEndpointDataSource(
  row: Record<string, unknown>,
  side: "source" | "target",
): string | undefined {
  const endpoint = row[side];
  const fromObject =
    endpoint && typeof endpoint === "object" && !Array.isArray(endpoint)
      ? directString((endpoint as Record<string, unknown>).dataSource)
      : undefined;
  return (
    fromObject ??
    directString(row[`${side}DataSource`]) ??
    directString(row[`${side}Datasource`])
  );
}

function endpointSourceHint(value: unknown): string | undefined {
  if (typeof value === "string") return directString(value);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const endpoint = value as Record<string, unknown>;
  return (
    directString(endpoint.dataSource) ??
    directString(endpoint.dataSourceId) ??
    directString(endpoint.dataSourceCode)
  );
}

function endpointResolution(
  taskCategory: string | null | undefined,
  side: "source" | "target",
  row: Record<string, unknown>,
  tableResults: readonly {
    qualifiedName: string;
    evidence: TableEvidence | undefined;
  }[],
): {
  table: TableEvidence | undefined;
  expectedDataSource?: string;
  conflict: boolean;
} {
  const expectedDataSource =
    directEndpointDataSource(row, side) ??
    controlledTaskEndpointDataSource(taskCategory, side);
  const table = tableEvidenceFor(tableResults, directTableName(row[side]));
  return {
    table,
    expectedDataSource,
    conflict:
      table !== undefined &&
      expectedDataSource !== undefined &&
      table.dataSource !== expectedDataSource,
  };
}

export function collectOneTask(
  dataRoot: string,
  taskId: string,
  options: CollectOneTaskOptions = {},
): TaskCollectionSummary {
  loadPersistedTableCache(dataRoot);
  const szdataRow: Record<string, unknown> = {
    ...openCliTaskSource(taskId),
    ...(options.scheduleCycle === undefined
      ? {}
      : { scheduleCycle: options.scheduleCycle }),
    ...(options.scheduleStatus === undefined
      ? {}
      : { scheduleStatus: options.scheduleStatus }),
  };
  let horaeFallback: Record<string, unknown> | undefined;
  let horaeFallbackStatus:
    "NOT_NEEDED" | "RECOVERED" | "PARTIAL" | "NO_SQL" | "TIMEOUT" | "FAILED" =
    "NOT_NEEDED";
  if (needsHoraeSqlFallback(szdataRow)) {
    try {
      horaeFallback = openCliHoraeDetail(taskId);
      const unavailableSlots = SQL_SLOTS.filter((slot) => {
        const slots =
          szdataRow.sqlSlots &&
          typeof szdataRow.sqlSlots === "object" &&
          !Array.isArray(szdataRow.sqlSlots)
            ? (szdataRow.sqlSlots as Record<string, unknown>)
            : {};
        const entry = slots[slot];
        return (
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).available !== true
        );
      });
      const recoveredSlots = unavailableSlots.filter((slot) =>
        HORAE_SQL_FIELDS[slot].some(
          (field) =>
            typeof horaeFallback?.[field] === "string" &&
            horaeFallback[field]!.trim() !== "",
        ),
      );
      horaeFallbackStatus =
        recoveredSlots.length === 0
          ? "NO_SQL"
          : recoveredSlots.length === unavailableSlots.length
            ? "RECOVERED"
            : "PARTIAL";
    } catch (error) {
      horaeFallback = undefined;
      horaeFallbackStatus =
        String(error).includes("TIMEOUT") || String(error).includes("ETIMEDOUT")
          ? "TIMEOUT"
          : "FAILED";
    }
  }
  const row =
    horaeFallback === undefined
      ? szdataRow
      : mergeHoraeSqlEvidence(szdataRow, horaeFallback);
  const taskEvidenceResult = toTaskEvidence(taskId, row);
  const taskEvidence = taskEvidenceResult.evidence;
  const staleLegacyTaskDirectories = findStaleLegacyTaskDirectories(
    dataRoot,
    taskId,
    taskEvidence.taskCategory ?? "unknown",
  );
  const sqlSlots = availableSqlSlots(row);
  const directTableRequests = (["source", "target"] as const)
    .map((side) => ({ side, qualifiedName: directTableName(row[side]) }))
    .filter(
      (item): item is { side: "source" | "target"; qualifiedName: string } =>
        item.qualifiedName !== undefined,
    );
  const sqlReadTableNames = Object.values(taskEvidence.sql ?? {})
    .flatMap((evidence) =>
      extractSqlReadTableNames(
        typeof evidence === "string" ? evidence : evidence?.content ?? "",
      ),
    );
  const tableRequests = [
    ...directTableRequests,
    ...sqlReadTableNames.map((qualifiedName) => ({
      side: "sql-read" as const,
      qualifiedName,
    })),
  ].filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.qualifiedName.toLowerCase() ===
            item.qualifiedName.toLowerCase() &&
          candidate.side === item.side,
      ) === index,
  );
  const tableReferencesUnavailable = (["source", "target"] as const)
    .map((side) =>
      unresolvedPhysicalEndpointReference(
        side,
        row[side],
        taskEvidence.taskCategory,
      ),
    )
    .filter((value): value is string => value !== undefined);
  const tableResults = tableRequests.map(({ side, qualifiedName }) => ({
    side,
    qualifiedName,
    evidence: tableFromDirectEvidence(
      qualifiedName,
      undefined,
      side === "sql-read"
        ? controlledTaskEndpointDataSource(taskEvidence.taskCategory, "source")
        : directEndpointDataSource(row, side) ??
            controlledTaskEndpointDataSource(taskEvidence.taskCategory, side),
      side === "sql-read"
        ? {
            sourceHint: endpointSourceHint(row.source),
            expectedPlatform: controlledTaskEndpointPlatform(
              taskEvidence.taskCategory,
              "source",
            ),
          }
        : {
            expectedPlatform: controlledTaskEndpointPlatform(
              taskEvidence.taskCategory,
              side,
            ),
          },
    ),
  }));
  const sqlTargetInputs = Object.fromEntries(
    Object.entries(taskEvidence.sql ?? {})
      .map(([slot, evidence]) => [
        slot,
        typeof evidence === "string" ? evidence : evidence?.content,
      ])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  ) as Partial<Record<SqlSlot, string>>;
  const directTargetResult = tableResults.find(
    (item) => item.side === "target",
  );
  const sqlTarget = findSqlFinalTargetEvidence(
    sqlTargetInputs,
    directString(taskEvidence.taskName),
  );
  const sqlRelationTarget =
    sqlTarget ??
    findSqlFinalTargetEvidence(
      sqlTargetInputs,
      directString(taskEvidence.taskName),
      { allowSchemaOnlyQualification: true },
    );
  const effectiveSqlTarget = sqlTarget ?? sqlRelationTarget;
  const directTargetQualifiedName =
    directTargetResult?.qualifiedName ?? directTableName(row.target);
  const sqlTargetNeedsCollection =
    effectiveSqlTarget !== undefined &&
    (directTargetResult?.evidence === undefined ||
      directTargetQualifiedName?.toLowerCase() !==
        effectiveSqlTarget.qualifiedName.toLowerCase());
  const hasSameTaskRelationTarget = tableResults.some(
    (item) =>
      item.side === "target" &&
      item.evidence?.evidenceProvider.includes("table-task-relation") &&
      effectiveSqlTarget !== undefined &&
      item.qualifiedName.toLowerCase() ===
        effectiveSqlTarget.qualifiedName.toLowerCase(),
  );
  const sqlTargetProvider =
    effectiveSqlTarget === undefined
      ? undefined
      : sqlEvidenceProvider(taskEvidence, effectiveSqlTarget.slot);
  const sqlTargetHasSqlMcpEvidence =
    sqlTargetProvider
      ?.split(",")
      .some((provider) => provider.trim() === "sql-mcp") ?? false;
  if (shouldUseTaskRelationFallback(row.source, row.target)) {
    const taskTable =
      sqlRelationTarget === undefined
        ? tableFromTaskRelation(
            taskId,
            row.taskName,
            controlledTaskEndpointDataSource(
              taskEvidence.taskCategory,
              "target",
            ),
          )
        : tableFromDirectEvidence(
            sqlRelationTarget.qualifiedName,
            taskId,
            controlledTaskEndpointDataSource(
              taskEvidence.taskCategory,
              "target",
            ),
          );
    if (taskTable !== undefined)
      tableResults.push({
        side: "target",
        qualifiedName: taskTable.qualifiedName,
        evidence: taskTable,
      });
  }
  let sqlTargetTable: TableEvidence | undefined;
  if (
    sqlTargetNeedsCollection &&
    !hasSameTaskRelationTarget &&
    sqlTargetHasSqlMcpEvidence
  ) {
    if (effectiveSqlTarget !== undefined) {
      for (let index = tableResults.length - 1; index >= 0; index -= 1) {
        if (
          tableResults[index]?.side === "target" &&
          tableResults[index]?.evidence === undefined
        )
          tableResults.splice(index, 1);
      }
      sqlTargetTable = tableFromDirectEvidence(
        effectiveSqlTarget.qualifiedName,
        undefined,
        controlledTaskEndpointDataSource(taskEvidence.taskCategory, "target"),
      );
      tableResults.push({
        side: "target",
        qualifiedName: effectiveSqlTarget.qualifiedName,
        evidence: sqlTargetTable,
      });
    }
  }
  const sourceResolution = endpointResolution(
    taskEvidence.taskCategory,
    "source",
    row,
    tableResults,
  );
  const targetResolution = endpointResolution(
    taskEvidence.taskCategory,
    "target",
    row,
    tableResults,
  );
  const taskRelationTarget = tableResults.find(
    (item) =>
      item.side === "target" &&
      item.evidence?.evidenceProvider.includes("table-task-relation"),
  )?.evidence;
  const fallbackTarget = taskRelationTarget ?? sqlTargetTable;
  const targetValueForEvidence =
    (sqlTargetTable !== undefined &&
      directTargetResult?.evidence === undefined) ||
    (taskEvidence.target === null && fallbackTarget !== undefined)
      ? undefined
      : taskEvidence.target;
  const taskEvidenceProvider =
    taskRelationTarget !== undefined
      ? `${taskEvidence.evidenceProvider ?? "opencli:szdata.task-source"},opencli:szdata.table-task-relation`
      : sqlTargetTable !== undefined && sqlTargetProvider !== undefined
        ? `${taskEvidence.evidenceProvider ?? "opencli:szdata.task-source"},${sqlTargetProvider},sql-mcp:explicit-table-target,opencli:szdata.table`
        : taskEvidence.evidenceProvider;
  const enrichedTarget = enrichTaskEndpoint(
    targetValueForEvidence,
    targetResolution.conflict
      ? undefined
      : (targetResolution.table ?? fallbackTarget),
  );
  const enrichedTaskEvidence: TaskEvidence = {
    ...taskEvidence,
    source: enrichTaskEndpoint(
      taskEvidence.source,
      sourceResolution.conflict ? undefined : sourceResolution.table,
    ),
    target: enrichedTarget,
    targetEvidenceKind: targetEvidenceKindFor(
      targetValueForEvidence,
      taskRelationTarget,
      sqlTargetTable,
    ),
    partition: buildCompactTaskPartition({
      taskTarget:
        directTableName(enrichedTarget) ??
        taskRelationTarget?.qualifiedName ??
        sqlTargetTable?.qualifiedName,
      tables: tableResults
        .map((item) => item.evidence)
        .filter((item): item is TableEvidence => item !== undefined),
      schedulerEvidence: taskEvidence.schedulerEvidence,
      sql: Object.fromEntries(
        Object.entries(taskEvidence.sql ?? {}).map(([slot, evidence]) => [
          slot,
          typeof evidence === "string" ? evidence : evidence?.content,
        ]),
      ) as Partial<Record<SqlSlot, string>>,
      allowImplicitQueryOutput: !isDatabaseSourceToHiveTask(
        taskEvidence.taskCategory,
      ),
      allowSourceTemporalPartitionDefault: isDatabaseSourceToHiveTask(
        taskEvidence.taskCategory,
      ),
      sparkIndexMode: taskEvidence.taskCategory === "sparkIndex",
    }),
    evidenceProvider: taskEvidenceProvider,
  };
  const materialized = materializeTaskAndTablePacks(
    dataRoot,
    enrichedTaskEvidence,
    tableResults
      .filter(
        (
          item,
        ): item is {
          side: "source" | "target";
          qualifiedName: string;
          evidence: TableEvidence;
        } => item.evidence !== undefined,
      )
      .map((item) => item.evidence),
  );
  const result = materialized.task;
  const tableWrites = materialized.tables;
  const summary = {
    taskId,
    taskCategory: taskEvidence.taskCategory ?? "unknown",
    taskType: taskEvidence.taskType,
    platformStatus: row.status,
    sqlCollectionStatus:
      horaeFallbackStatus === "NOT_NEEDED" ||
      horaeFallbackStatus === "RECOVERED"
        ? "SUCCESS"
        : "PARTIAL",
    collectionStatus: inputCollectionStatus(
      tableResults.length,
      tableResults.some((item) => item.evidence === undefined),
      sourceResolution.conflict || targetResolution.conflict,
      horaeFallbackStatus !== "NOT_NEEDED" &&
        horaeFallbackStatus !== "RECOVERED",
      tableReferencesUnavailable.length > 0,
    ),
    taskName: directOptionalString(row.taskName),
    topicName: directOptionalString(row.topicName),
    changed: result.changed,
    directory: result.directory,
    contentHash: result.contentHash,
    sqlSlots,
    sqlFallbackByHorae:
      horaeFallback === undefined
        ? []
        : SQL_SLOTS.filter((slot) => {
            const slots =
              row.sqlSlots &&
              typeof row.sqlSlots === "object" &&
              !Array.isArray(row.sqlSlots)
                ? (row.sqlSlots as Record<string, unknown>)
                : {};
            const entry = slots[slot];
            return (
              entry &&
              typeof entry === "object" &&
              !Array.isArray(entry) &&
              (entry as Record<string, unknown>).source ===
                "opencli:horae.detail"
            );
          }),
    horaeFallbackStatus,
    warning:
      horaeFallbackStatus === "TIMEOUT"
        ? "Horae fallback timed out after 5 seconds; unavailable SQL slots were preserved"
        : horaeFallbackStatus === "NO_SQL"
          ? "Horae fallback returned no SQL; unavailable SQL slots were preserved"
          : horaeFallbackStatus === "PARTIAL"
            ? "Horae fallback recovered only some SQL slots; remaining unavailable slots were preserved"
            : horaeFallbackStatus === "FAILED"
              ? "Horae fallback failed; unavailable SQL slots were preserved"
              : undefined,
    tablesWritten: tableWrites.length,
    tableAssets: tableWrites.map((write) => ({
      directory: write.directory,
      contentHash: write.contentHash,
    })),
    tablesFallbackByTaskRelation: tableResults
      .filter((item) =>
        item.evidence?.evidenceProvider.includes("table-task-relation"),
      )
      .map((item) => item.qualifiedName),
    tablesDeleted: tableResults
      .filter((item) => item.evidence?.status === "DELETED")
      .map((item) => item.qualifiedName),
    tablesUnavailable: tableResults
      .filter((item) => item.evidence === undefined)
      .map((item) => item.qualifiedName),
    staleLegacyTaskDirectories,
    warnings: [
      ...taskEvidenceResult.warnings,
      tableReferencesUnavailable.length > 0
        ? "TABLE_REFERENCE_UNAVAILABLE"
        : undefined,
      staleLegacyTaskDirectories.length > 0
        ? "STALE_LEGACY_TASK_DIRECTORY"
        : undefined,
      horaeFallbackStatus === "TIMEOUT"
        ? "HORAE_SQL_FALLBACK_TIMEOUT"
        : undefined,
    ].filter((value): value is string => value !== undefined),
    endpointDataSourceConflicts: [
      sourceResolution.conflict ? directTableName(row.source) : undefined,
      targetResolution.conflict ? directTableName(row.target) : undefined,
    ].filter((value): value is string => value !== undefined),
    tableReferencesUnavailable,
    tableEvidenceGap:
      tableResults.length === 0
        ? shouldUseTaskRelationFallback(row.source, row.target)
          ? "NO_DIRECT_SOURCE_OR_TARGET_OR_TASK_TABLE_RELATION"
          : "NO_TABLE_EVIDENCE_FOR_DIRECT_ENDPOINTS"
        : undefined,
  } satisfies TaskCollectionSummary & Record<string, unknown>;
  console.log(JSON.stringify(summary));
  return summary;
}
