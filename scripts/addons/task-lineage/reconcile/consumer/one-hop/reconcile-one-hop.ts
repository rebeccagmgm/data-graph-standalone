import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  Schema,
  SqlSession,
  type Dialect,
  type SchemaMapping,
} from "sqllens";
import {
  sha256File,
  validateTableDocument,
  validateTaskDocument,
  type JsonValue,
  type TaskDocument,
  type TableDocument,
} from "../../../../../input/shared/input-pack.ts";
import { buildPlanFacts } from "../../../../../plans/plan-adapter.ts";
import {
  loadSchemaFromTablesRoot,
  parseDdlSchema,
} from "../../../../../plans/ddl-schema.ts";
import type { PredicateTree } from "../../../../../plans/plan-contract.ts";
import {
  resolveReadOccurrences,
  type ReadOccurrencePredicateEvidence,
} from "../../../../../plans/read-occurrence-resolver.ts";
import { taskSqlDialect } from "../../../../../plans/task-sql-dialect.ts";
import {
  fingerprintTableProducerInputs,
  classifyProducerWriteObservation,
  loadTableProducerIndex,
  validateTableProducerIndex,
  type ProducerDataPathRole,
  type NonConfirmedRelation,
  type ProducerTableIdentity,
  type ProducerWriteObservation,
  type TableProducerIndex,
} from "../../../../../reconcile/producer/producer-index.ts";
import {
  type ProducerPartitionMatch,
  type ProducerPartitionMatchStatus,
} from "../../../../../query/producer-index-query.ts";
import {
  isLegacyProducerIndexPath,
  lookupConfirmedProducersFor,
  lookupNonConfirmedRelationsFor,
  lookupProducerWritesByTaskFor,
  matchProducersByReadScopeFor,
  resolveWriterLookup,
  writerLookupMeta,
  type WriterLookup,
} from "../../../../../query/table-writer-lookup.ts";
import type { WriterCatalogHandle } from "../../../../../query/writer-catalog.ts";
import {
  resolveReadPartitionScope,
  type ReadPartitionScope,
} from "../../../../../evidence/sql-read-scope.ts";
import {
  extractSqlWrites,
  partitionValueStatus,
  partitionAssignments,
  type PartitionAssignment,
  type SqlWrite,
} from "../../../../../evidence/sql-write-evidence.ts";
import {
  inferTaskDefaultSchema,
  qualifyBareTableName,
} from "../../../../../reconcile/shared/task-default-schema.ts";
import { normalizeRepeatedSqlForAnalysis } from "../../../../../input/shared/sql-analysis-normalization.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeRelationCache,
  scheduleEvidenceCachePath,
  writeHoraeRelationCache,
  type ScheduleEvidenceCacheStatus,
} from "../../../../../evidence/schedule-evidence-cache.ts";
import {
  DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  loadTerminalTableConfig,
  matchingTerminalRole,
  type TerminalTableConfig,
} from "../../../../../reconcile/shared/terminal-table-config.ts";

export {
  extractSqlWrites,
  type PartitionAssignment,
  type SqlWrite,
} from "../../../../../evidence/sql-write-evidence.ts";

type JsonRecord = Record<string, unknown>;

export type ReconciliationStatus =
  "MATCHED" | "SQL_ONLY" | "SCHEDULE_ONLY" | "UNRESOLVED";

export interface EvidenceObservation {
  readonly source:
    | "HORAE_RELATION"
    | "INPUT_PACK_TASK"
    | "INPUT_PACK_SQL"
    | "TABLE_PACK"
    | "SQL_PARSE"
    | "SZDATA_TASK_SOURCE";
  readonly provider: string;
  readonly locator: string;
  readonly observedAt: string | null;
  readonly sha256?: string;
  readonly contentHash?: string;
  readonly detail?: JsonRecord;
}

export interface PhysicalTableRef {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string | null;
  readonly identityStatus:
    "RESOLVED" | "QUALIFIED_NAME_ONLY" | "AMBIGUOUS" | "UNKNOWN";
}

export interface SqlDirectRead {
  readonly qualifiedName: string;
  readonly statementIndexes: readonly number[];
  readonly syntaxDiagnosticCount: number;
  readonly parserUnknownCount: number;
}

interface SqlDirectReadOccurrence {
  readonly qualifiedName: string;
  readonly statementIndex: number;
  readonly occurrenceId: string;
  readonly readRelationId: string;
  readonly predicateTree: PredicateTree | null;
  readonly predicateEvidence: readonly ReadOccurrencePredicateEvidence[];
  readonly bindingStatus: "UNCONSTRAINED" | "CONSTRAINED" | "UNKNOWN";
  readonly reasonCodes: readonly string[];
  readonly relationPath: readonly string[];
  readonly syntaxDiagnosticCount: number;
  readonly parserUnknownCount: number;
}

interface TaskSqlFile {
  readonly slot: string;
  readonly path: string;
  readonly absolutePath: string;
  readonly sha256: string;
  readonly evidenceProvider: string;
  readonly content: string;
}

interface LoadedTaskPack {
  readonly status: "AVAILABLE" | "MISSING" | "AMBIGUOUS" | "INVALID";
  readonly taskId: string;
  readonly taskPath: string | null;
  readonly document: (TaskDocument & JsonRecord) | null;
  readonly sqlFiles: readonly TaskSqlFile[];
  readonly issues: readonly string[];
}

interface TableCatalogEntry {
  readonly table: PhysicalTableRef;
  readonly evidence: EvidenceObservation;
  readonly partitionFields: readonly string[] | null;
  readonly partitionReasonCodes: readonly string[];
  readonly ddlPath: string | null;
  readonly ddlSha256: string | null;
}

interface TableCatalog {
  readonly byQualifiedName: Map<string, readonly TableCatalogEntry[]>;
  readonly issues: string[];
  readonly lazyDdl: boolean;
  readonly ddlCache: Map<string, TableDdlDetails>;
  readonly lazyTablePathsByQualifiedName: ReadonlyMap<
    string,
    readonly string[]
  >;
  readonly loadedTableKeys: Set<string>;
}

interface TableDdlDetails {
  readonly columns: readonly string[];
  readonly partitionFields: readonly string[] | null;
  readonly warnings: readonly string[];
}

interface OneHopPreparedContext {
  readonly dataRoot: string;
  readonly inputFingerprint: string | null;
  readonly tableCatalog: TableCatalog;
  readonly schema: unknown;
  readonly validatedProducerIndexes: WeakSet<TableProducerIndex>;
}

export interface DirectReadPartitionScopeObservation {
  readonly occurrenceId: string;
  readonly readRelationId: string;
  readonly statementIndex: number;
  readonly relationPath: readonly string[];
  readonly predicateTree: PredicateTree | null;
  readonly predicateEvidence: readonly ReadOccurrencePredicateEvidence[];
  readonly scope: ReadPartitionScope;
}

export interface DirectReadObservation {
  readonly table: PhysicalTableRef;
  readonly sql: SqlDirectRead;
  readonly evidence: readonly EvidenceObservation[];
  readonly readPartitionScopes: readonly DirectReadPartitionScopeObservation[];
}

export interface ConfirmedWriteObservation {
  readonly table: PhysicalTableRef;
  readonly writeKind: string | null;
  readonly partition: readonly PartitionAssignment[];
  readonly evidence: readonly EvidenceObservation[];
}

export interface UnconfirmedTargetObservation {
  readonly qualifiedName: string | null;
  readonly reason: string;
  readonly evidence: readonly EvidenceObservation[];
}

export interface ParentObservation {
  readonly taskId: string;
  readonly taskName: string | null;
  readonly scheduleEvidence: readonly EvidenceObservation[];
  readonly inputPackStatus: LoadedTaskPack["status"];
  readonly resolutionStatus: "RESOLVED" | "UNRESOLVED";
  readonly confirmedWrites: readonly ConfirmedWriteObservation[];
  readonly unconfirmedTargets: readonly UnconfirmedTargetObservation[];
  readonly issues: readonly string[];
}

export interface OneHopIssueDetail {
  readonly code: string;
  readonly scope: "TABLE_CATALOG" | "SCHEDULE_PARENT";
  readonly taskId: string | null;
  readonly taskName: string | null;
}

export interface ReconciliationItem {
  readonly status: ReconciliationStatus;
  readonly taskId: string | null;
  readonly table: PhysicalTableRef;
  readonly read: DirectReadObservation | null;
  readonly write: ConfirmedWriteObservation | null;
  readonly evidence: readonly EvidenceObservation[];
  readonly reason: string | null;
}

export type ProducerIndexConsumptionStatus =
  "NOT_REQUESTED" | "VALID_SUCCESS" | "VALID_PARTIAL";

export interface DataPathConfirmedProducer {
  readonly table: PhysicalTableRef;
  readonly taskId: string;
  readonly scheduleRelation: "DIRECT_PARENT" | "NOT_DIRECT_PARENT";
  readonly partitionMatch: {
    readonly status: ProducerPartitionMatchStatus;
    readonly reasonCodes: readonly string[];
    readonly writes: readonly ProducerWriteObservation[];
  };
  readonly writes: readonly (
    ProducerWriteObservation | ConfirmedWriteObservation
  )[];
}

export interface ReadOccurrenceProducerDecision {
  readonly table: PhysicalTableRef;
  readonly occurrenceId: string;
  readonly readRelationId: string;
  readonly statementIndex: number;
  readonly relationPath: readonly string[];
  readonly candidates: readonly {
    readonly taskId: string;
    readonly scheduleRelation: "DIRECT_PARENT" | "NOT_DIRECT_PARENT";
    readonly partitionMatchStatus: ProducerPartitionMatchStatus;
  }[];
  readonly primary: readonly string[];
  readonly additional: readonly string[];
  readonly unknown: readonly string[];
  readonly decision:
    | "SCHEDULE_DATA_INTERSECTION"
    | "DATA_FALLBACK"
    | "NO_MATCH"
    | "MULTIPLE_OVERLAPPING_PRODUCERS";
}

export interface OneHopCoverage {
  readonly semantics: "OBSERVED_EVIDENCE_ONLY";
  readonly directReadTables: {
    readonly total: number;
    readonly identityResolved: number;
    readonly identityUnresolved: number;
    readonly withConfirmedProducer: number;
    readonly withNonConfirmedOnly: number;
    readonly withNoProducerObservation: number;
  };
  readonly scheduleParents: {
    readonly total: number;
    readonly taskPackAvailable: number;
    readonly taskPackMissing: number;
    readonly taskPackAmbiguous: number;
    readonly taskPackInvalid: number;
    readonly withConfirmedWrite: number;
    readonly withNonConfirmedOnly: number;
    readonly withNoWriteObservation: number;
  };
  readonly producerEvidenceObservations: {
    readonly confirmedProducerEdges: number;
    readonly confirmedWriteObservations: number;
    readonly nonConfirmedRelationObservations: number;
    readonly directionConfirmed: number;
    readonly directionUnknown: number;
    readonly identityResolved: number;
    readonly identityUnresolved: number;
  };
  readonly retrieval: {
    readonly producerIndex: ProducerIndexConsumptionStatus;
    readonly liveTaskSourceAttempts: number;
    readonly liveTaskSourceSuccesses: number;
    readonly liveTaskSourceFailures: number;
  };
  readonly overlaps: {
    readonly sqlOnlyAndUnresolvedTables: number;
    readonly confirmedAndNonConfirmedTables: number;
  };
  readonly partitionScopes: {
    readonly readOccurrences: number;
    readonly statusCounts: Readonly<Record<ReadPartitionScope["status"], number>>;
    readonly producerMatchCounts: Readonly<
      Record<ProducerPartitionMatchStatus, number>
    >;
    readonly provenTaskIds: number;
    readonly possibleTaskIds: number;
    readonly unknownTaskIds: number;
    readonly multiProducerTables: number;
  };
}

export interface OneHopReconciliationResult {
  readonly schemaVersion: "1.1.0";
  readonly taskId: string;
  readonly generatedAt: string;
  readonly currentTask: {
    readonly inputPackPath: string;
    readonly inputPackContentHash: string;
    readonly directReads: readonly DirectReadObservation[];
  };
  readonly schedule: {
    readonly direction: "UPSTREAM";
    readonly depth: 1;
    readonly parents: readonly {
      readonly taskId: string;
      readonly taskName: string | null;
      readonly evidence: readonly EvidenceObservation[];
    }[];
    readonly evidence: readonly EvidenceObservation[];
  };
  readonly parents: readonly ParentObservation[];
  readonly reconciliation: readonly ReconciliationItem[];
  readonly counts: {
    readonly sqlDirectReads: number;
    readonly scheduleParents: number;
    readonly matched: number;
    readonly sqlOnly: number;
    readonly scheduleOnly: number;
    readonly unresolved: number;
  };
  readonly countSemantics: {
    readonly reconciliationStatusUnit: "RECONCILIATION_ITEM";
    readonly sqlDirectReadsUnit: "NORMALIZED_DIRECT_READ_REFERENCE";
    readonly scheduleParentsUnit: "DISTINCT_TASK";
    readonly statusesExclusivePerItem: true;
    readonly statusesExclusivePerPhysicalTable: false;
  };
  readonly producerIndex: {
    readonly status: ProducerIndexConsumptionStatus;
    readonly contentHash: string | null;
    readonly inputFingerprint: string | null;
  };
  readonly dataPath: {
    readonly source: "PRODUCER_INDEX" | "LEGACY_SCHEDULE_RECONCILIATION";
    readonly confirmedProducers: readonly DataPathConfirmedProducer[];
    readonly readOccurrenceDecisions: readonly ReadOccurrenceProducerDecision[];
    readonly nonConfirmedRelations: readonly NonConfirmedRelation[];
  };
  readonly coverage: OneHopCoverage;
  readonly nextScheduleTaskIds: readonly string[];
  readonly nextDataTaskIds: readonly string[];
  readonly partitionAwareNextDataTaskIds: {
    /** All producer candidates not proven disjoint by partition evidence. */
    readonly candidates: readonly string[];
    readonly proven: readonly string[];
    readonly possible: readonly string[];
    readonly unknown: readonly string[];
  };
  readonly finalUpstreamTaskIds: {
    readonly primary: readonly string[];
    readonly additional: readonly string[];
    readonly unknown: readonly string[];
    readonly decision:
      | "SCHEDULE_DATA_INTERSECTION"
      | "DATA_FALLBACK"
      | "SCHEDULE_FALLBACK"
      | "MULTIPLE_OVERLAPPING_PRODUCERS";
  };
  readonly issues: readonly string[];
  readonly issueDetails: readonly OneHopIssueDetail[];
  readonly boundaries: {
    readonly staticSqlOnly: true;
    readonly readPartitionScope: "STATIC_SQL_PREDICATE";
    readonly schedulerExecution: "NOT_EVALUATED";
    readonly runtimeDelivery: "NOT_EVALUATED";
    readonly businessCorrectness: "NOT_EVALUATED";
    readonly producerCandidatesAreWrites: false;
    readonly partitionScope: "TASK_TO_TABLE_WRITE";
  };
}

export interface OneHopSummary {
  readonly schemaVersion: "1.1.0";
  readonly artifactType: "ONE_HOP_RECONCILIATION_SUMMARY";
  readonly taskId: string;
  readonly generatedAt: string;
  readonly directReadTables: readonly (string | null)[];
  readonly scheduleParentTaskIds: readonly string[];
  readonly confirmedProducers: readonly {
    readonly taskId: string;
    readonly table: string | null;
    readonly scheduleRelation: "DIRECT_PARENT" | "NOT_DIRECT_PARENT";
    readonly partitionMatch: {
      readonly status: ProducerPartitionMatchStatus;
      readonly reasonCodes: readonly string[];
      readonly partitions: readonly (readonly PartitionAssignment[])[];
    };
  }[];
  readonly excludedProducers: readonly {
    readonly taskId: string;
    readonly table: string | null;
    readonly scheduleRelation: "DIRECT_PARENT" | "NOT_DIRECT_PARENT";
    readonly partitionMatch: {
      readonly status: ProducerPartitionMatchStatus;
      readonly reasonCodes: readonly string[];
      readonly partitions: readonly (readonly PartitionAssignment[])[];
    };
  }[];
  readonly counts: OneHopReconciliationResult["counts"];
  readonly producerIndex: {
    readonly status: ProducerIndexConsumptionStatus;
  };
  readonly dataPath: {
    readonly source: OneHopReconciliationResult["dataPath"]["source"];
    readonly confirmedProducerCount: number;
    readonly excludedProducerCount: number;
    readonly nonConfirmedRelationCount: number;
  };
  readonly nextScheduleTaskIds: readonly string[];
  readonly nextDataTaskIds: readonly string[];
  readonly partitionAwareNextDataTaskIds: OneHopReconciliationResult["partitionAwareNextDataTaskIds"];
  readonly finalUpstreamTaskIds: OneHopReconciliationResult["finalUpstreamTaskIds"];
  readonly partitionScopes: OneHopCoverage["partitionScopes"];
  readonly issues: readonly string[];
  readonly issueDetails: readonly OneHopIssueDetail[];
  readonly missingTaskInputPackTaskIds: readonly string[];
}

export type OpenCliRunner = (args: readonly string[]) => unknown;

export interface ReconcileOneHopOptions {
  readonly dataRoot: string;
  readonly producerIndex?: TableProducerIndex;
  readonly writerCatalog?: WriterCatalogHandle;
  readonly verifyInputFingerprint?: boolean;
  /**
   * Offline Horae relation rows supplied by a caller which already owns the
   * scheduler evidence.  When present, no OpenCLI runner is invoked.
   */
  readonly scheduleRows?: readonly Record<string, unknown>[];
  /** Task-keyed scheduler evidence, supplied by a bounded live prefetch. */
  readonly scheduleRowsByTaskId?: ReadonlyMap<string, readonly Record<string, unknown>[]> | Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /** Optional evidence metadata for task-keyed rows. */
  readonly scheduleEvidenceByTaskId?: ReadonlyMap<string, {
    readonly rows: readonly Record<string, unknown>[];
    readonly provider?: string;
    readonly locator?: string;
    readonly observedAt?: string | null;
    readonly cacheStatus?: Exclude<ScheduleEvidenceCacheStatus, "DISABLED">;
    readonly cachePath?: string;
  }>;
  /** Null disables the cache; omitted uses the fixed root for the default runner. */
  readonly scheduleEvidenceCacheRoot?: string | null;
  /** Shared terminal-table rules retain direct reads but suppress producer expansion. */
  readonly terminalTableConfig?: TerminalTableConfig;
  readonly trustedInputFingerprint?: string;
  readonly openCliRunner?: OpenCliRunner;
  readonly now?: () => string;
  readonly taskSourceTimeoutSeconds?: number;
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const OPENCLI_PROCESS_TIMEOUT_MS = 90_000;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? null : trimmed;
}

function normalizeTable(value: string): string {
  return value.replaceAll("`", "").replaceAll('"', "").trim().toLowerCase();
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function tableIdentityKey(table: PhysicalTableRef): string | null {
  if (
    table.identityStatus !== "RESOLVED" ||
    !table.platform ||
    !table.dataSource ||
    table.dataSource.toLowerCase() === "default" ||
    !table.qualifiedName
  )
    return null;
  return `${table.platform.toLowerCase()}|${table.dataSource.toLowerCase()}|${normalizeTable(table.qualifiedName)}`;
}

function producerIdentity(
  table: PhysicalTableRef,
): ProducerTableIdentity | null {
  if (
    table.identityStatus !== "RESOLVED" ||
    !table.platform ||
    !table.dataSource ||
    !table.qualifiedName ||
    table.dataSource.toLowerCase() === "default"
  )
    return null;
  return {
    platform: table.platform,
    dataSource: table.dataSource,
    qualifiedName: table.qualifiedName,
  };
}

function intersectionSize(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function compareText(left: string | null, right: string | null): number {
  return (left ?? "").localeCompare(right ?? "");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function issueDetailsForOneHop(
  catalog: TableCatalog,
  parents: readonly ParentObservation[],
): readonly OneHopIssueDetail[] {
  const details: OneHopIssueDetail[] = [
    ...catalog.issues.map((code) => ({
      code,
      scope: "TABLE_CATALOG" as const,
      taskId: null,
      taskName: null,
    })),
    ...parents.flatMap((parent) =>
      parent.issues.map((code) => ({
        code,
        scope: "SCHEDULE_PARENT" as const,
        taskId: parent.taskId,
        taskName: parent.taskName,
      })),
    ),
  ];
  const seen = new Set<string>();
  return details
    .filter((detail) => {
      const key = `${detail.scope}\u0000${detail.taskId ?? ""}\u0000${detail.code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      compareText(
        `${left.scope}\u0000${left.taskId ?? ""}\u0000${left.code}`,
        `${right.scope}\u0000${right.taskId ?? ""}\u0000${right.code}`,
      ),
    );
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function firstResult(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function rowsOf(value: unknown): JsonRecord[] {
  if (Array.isArray(value))
    return value
      .map(asRecord)
      .filter((item): item is JsonRecord => item !== null);
  const record = asRecord(value);
  if (!record) return [];
  for (const field of ["records", "rows", "data", "results"]) {
    const rows = record[field];
    if (Array.isArray(rows))
      return rows
        .map(asRecord)
        .filter((item): item is JsonRecord => item !== null);
  }
  return [];
}

function isCacheableHoraeRelationResponse(
  value: unknown,
  rows: readonly JsonRecord[],
): boolean {
  if (Array.isArray(value)) return value.length === rows.length;
  const record = asRecord(value);
  if (!record) return false;
  if (
    record.error !== undefined ||
    record.success === false ||
    ["fail", "failed", "failure", "error"].includes(
      String(record.status ?? "").toLowerCase(),
    )
  )
    return false;
  const envelope = ["records", "rows", "data", "results"].find((field) =>
    Array.isArray(record[field]),
  );
  return envelope !== undefined &&
    (record[envelope] as unknown[]).length === rows.length;
}

export function defaultOpenCliRunner(
  args: readonly string[],
  timeoutMs = OPENCLI_PROCESS_TIMEOUT_MS,
): unknown {
  const windowsLauncher = join(process.env.APPDATA ?? "", "npm", "opencli.ps1");
  const executable =
    process.platform === "win32" ? "powershell.exe" : "opencli";
  const commandArgs =
    process.platform === "win32"
      ? [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          windowsLauncher,
          ...args,
        ]
      : [...args];
  if (process.platform === "win32" && !existsSync(windowsLauncher))
    throw new Error("OPENCLI_LAUNCHER_MISSING");
  const result = spawnSync(executable, commandArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `OPENCLI_COMMAND_FAILED:${args.slice(0, 3).join(" ")}:${safeMessage(result.error ?? result.stderr)}`,
    );
  const stdout = result.stdout.trim();
  if (!stdout)
    throw new Error(`OPENCLI_EMPTY_OUTPUT:${args.slice(0, 3).join(" ")}`);
  return JSON.parse(stdout) as unknown;
}

export function extractSqlDirectReads(
  sql: string,
  dialect: Dialect,
): SqlDirectRead[] {
  return aggregateSqlDirectReads(
    extractSqlDirectReadOccurrences(sql, dialect),
  );
}

function extractSqlDirectReadOccurrences(
  sql: string,
  dialect: Dialect,
  schema?: unknown,
): SqlDirectReadOccurrence[] {
  const analysisSql = normalizeRepeatedSqlForAnalysis(sql);
  const session = SqlSession.create(analysisSql, dialect);
  const occurrences: SqlDirectReadOccurrence[] = [];
  for (const [statementIndex, cell] of session.doc.statements.entries()) {
    const plan = buildPlanFacts(cell, analysisSql, {
      statement_index: statementIndex,
      dialect,
      ...(schema !== undefined
        ? { schema, include_expression_dependencies: true }
        : {}),
    });
    for (const occurrence of resolveReadOccurrences(plan)) {
      occurrences.push({
        qualifiedName: normalizeTable(occurrence.table),
        statementIndex,
        occurrenceId: `${statementIndex}:${occurrence.occurrenceId}`,
        readRelationId: occurrence.readRelationId,
        predicateTree: occurrence.predicateTree,
        predicateEvidence: occurrence.predicateEvidence,
        bindingStatus: occurrence.bindingStatus,
        reasonCodes: occurrence.reasonCodes,
        relationPath: occurrence.relationPath,
        syntaxDiagnosticCount: cell.diagnostics.length,
        parserUnknownCount: plan.unknowns.length,
      });
    }
  }
  return occurrences;
}

function aggregateSqlDirectReads(
  occurrences: readonly SqlDirectReadOccurrence[],
): SqlDirectRead[] {
  const byTable = new Map<
    string,
    {
      display: string;
      statementIndexes: Set<number>;
      syntaxDiagnosticCount: number;
      parserUnknownCount: number;
    }
  >();
  for (const occurrence of occurrences) {
    const key = normalizeTable(occurrence.qualifiedName);
    const current = byTable.get(key) ?? {
      display: key,
      statementIndexes: new Set<number>(),
      syntaxDiagnosticCount: 0,
      parserUnknownCount: 0,
    };
    current.statementIndexes.add(occurrence.statementIndex);
    current.syntaxDiagnosticCount += occurrence.syntaxDiagnosticCount;
    current.parserUnknownCount += occurrence.parserUnknownCount;
    byTable.set(key, current);
  }
  return [...byTable.values()]
    .map((item) => ({
      qualifiedName: item.display,
      statementIndexes: [...item.statementIndexes].sort(
        (left, right) => left - right,
      ),
      syntaxDiagnosticCount: item.syntaxDiagnosticCount,
      parserUnknownCount: item.parserUnknownCount,
    }))
    .sort((left, right) =>
      compareText(left.qualifiedName, right.qualifiedName),
    );
}

function loadTaskPack(dataRoot: string, taskId: string): LoadedTaskPack {
  const tasksRoot = join(dataRoot, "tasks");
  if (!existsSync(tasksRoot))
    return {
      status: "MISSING",
      taskId,
      taskPath: null,
      document: null,
      sqlFiles: [],
      issues: ["TASKS_ROOT_MISSING"],
    };
  const candidates = readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(tasksRoot, entry.name, taskId, "task.json"))
    .filter(existsSync);
  if (candidates.length === 0)
    return {
      status: "MISSING",
      taskId,
      taskPath: null,
      document: null,
      sqlFiles: [],
      issues: ["TASK_INPUT_PACK_MISSING"],
    };
  if (candidates.length > 1)
    return {
      status: "AMBIGUOUS",
      taskId,
      taskPath: null,
      document: null,
      sqlFiles: [],
      issues: candidates.map((path) => `TASK_INPUT_PACK_AMBIGUOUS:${path}`),
    };
  const taskPath = candidates[0]!;
  try {
    const raw = JSON.parse(readFileSync(taskPath, "utf8")) as unknown;
    validateTaskDocument(raw);
    const document = raw as TaskDocument & JsonRecord;
    if (document.taskId !== taskId) throw new Error("TASK_ID_MISMATCH");
    const sqlFiles: TaskSqlFile[] = [];
    for (const rawFile of document.sqlFiles) {
      const file = asRecord(rawFile);
      if (!file) continue;
      const slot = String(file.slot);
      const relativePath = String(file.path);
      const absolutePath = join(dirname(taskPath), relativePath);
      if (!existsSync(absolutePath))
        throw new Error(`SQL_FILE_MISSING:${slot}`);
      const expectedHash = String(file.sha256);
      if (sha256File(absolutePath) !== expectedHash)
        throw new Error(`SQL_FILE_HASH_MISMATCH:${slot}`);
      sqlFiles.push({
        slot,
        path: relativePath,
        absolutePath,
        sha256: expectedHash,
        evidenceProvider: String(file.evidenceProvider),
        content: readFileSync(absolutePath, "utf8"),
      });
    }
    return {
      status: "AVAILABLE",
      taskId,
      taskPath,
      document,
      sqlFiles,
      issues: [],
    };
  } catch (error) {
    return {
      status: "INVALID",
      taskId,
      taskPath,
      document: null,
      sqlFiles: [],
      issues: [`TASK_INPUT_PACK_INVALID:${safeMessage(error)}`],
    };
  }
}

function loadTableCatalog(
  dataRoot: string,
  options: { readonly lazyDdl?: boolean } = {},
): TableCatalog {
  const tablesRoot = join(dataRoot, "tables");
  const byQualifiedName = new Map<string, TableCatalogEntry[]>();
  const issues: string[] = [];
  const lazyTablePathsByQualifiedName = new Map<string, string[]>();
  const loadedTableKeys = new Set<string>();
  if (!existsSync(tablesRoot))
    return {
      byQualifiedName,
      issues: ["TABLES_ROOT_MISSING"],
      lazyDdl: options.lazyDdl === true,
      ddlCache: new Map(),
      lazyTablePathsByQualifiedName,
      loadedTableKeys,
    };
  for (const platform of readdirSync(tablesRoot, {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory())) {
    const platformRoot = join(tablesRoot, platform.name);
    for (const tableDirectory of readdirSync(platformRoot, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory())) {
      const tablePath = join(platformRoot, tableDirectory.name, "table.json");
      if (!existsSync(tablePath)) continue;
      if (options.lazyDdl === true) {
        const separator = tableDirectory.name.lastIndexOf("__");
        if (separator <= 0) {
          issues.push(`TABLE_DIRECTORY_ID_INVALID:${dirname(tablePath)}`);
          continue;
        }
        const key = normalizeTable(tableDirectory.name.slice(0, separator));
        lazyTablePathsByQualifiedName.set(key, [
          ...(lazyTablePathsByQualifiedName.get(key) ?? []),
          tablePath,
        ]);
        continue;
      }
      try {
        const raw = JSON.parse(readFileSync(tablePath, "utf8")) as unknown;
        validateTableDocument(raw);
        const document = raw as TableDocument & JsonRecord;
        const qualifiedName = String(document.qualifiedName);
        const key = normalizeTable(qualifiedName);
        const explicitPartitionFields = Array.isArray(
          document.partitionFields,
        )
          ? uniqueSorted(
              document.partitionFields
                .map(String)
                .filter((field) => field.trim() !== ""),
            )
          : null;
        const ddlFile = asRecord(document.ddlFile);
        const ddlRelativePath = stringValue(ddlFile?.path);
        const ddlPath = ddlRelativePath
          ? resolve(dirname(tablePath), ddlRelativePath)
          : null;
        if (ddlPath && !isWithin(dirname(tablePath), ddlPath))
          throw new Error("DDL_FILE_PATH_ESCAPE");
        const ddlSha256 = stringValue(ddlFile?.sha256);
        let ddlPartitionFields: readonly string[] | null = null;
        if (ddlPath) {
          if (
            existsSync(ddlPath) &&
            (!ddlSha256 || sha256File(ddlPath) === ddlSha256)
          ) {
            const parsed = parseDdlSchema(readFileSync(ddlPath, "utf8"));
            if (parsed.warnings.length === 0)
              ddlPartitionFields = uniqueSorted(parsed.partition_columns);
          }
        }
        const partitionFields =
          explicitPartitionFields ?? ddlPartitionFields;
        const partitionReasonCodes =
          explicitPartitionFields !== null &&
          ddlPartitionFields !== null &&
          !sameStringSet(explicitPartitionFields, ddlPartitionFields)
            ? ["PARTITION_FIELD_CONFLICT"]
            : explicitPartitionFields !== null
              ? [
                  explicitPartitionFields.length === 0
                    ? "TABLE_PACK_NON_PARTITIONED"
                    : "TABLE_PACK_PARTITION_FIELDS",
                ]
              : ddlPartitionFields !== null
                ? ["DDL_PARTITION_FIELDS_FALLBACK"]
                : ["PARTITION_FIELDS_UNAVAILABLE"];
        const entry: TableCatalogEntry = {
          table: {
            platform: String(document.platform),
            dataSource: String(document.dataSource),
            qualifiedName: key,
            identityStatus: "RESOLVED",
          },
          evidence: {
            source: "TABLE_PACK",
            provider: String(document.evidenceProvider ?? "input-pack:table"),
            locator: tablePath,
            observedAt: String(document.collectedAt),
            contentHash: String(document.contentHash),
          },
          partitionFields:
            partitionReasonCodes.includes("PARTITION_FIELD_CONFLICT")
              ? null
              : partitionFields,
          partitionReasonCodes,
          ddlPath,
          ddlSha256,
        };
        byQualifiedName.set(key, [...(byQualifiedName.get(key) ?? []), entry]);
      } catch (error) {
        issues.push(
          `TABLE_INPUT_PACK_INVALID:${tablePath}:${safeMessage(error)}`,
        );
      }
    }
  }
  return {
    byQualifiedName,
    issues,
    lazyDdl: options.lazyDdl === true,
    ddlCache: new Map(),
    lazyTablePathsByQualifiedName,
    loadedTableKeys,
  };
}

function loadLazyTableCatalogKey(catalog: TableCatalog, key: string): void {
  if (!catalog.lazyDdl || catalog.loadedTableKeys.has(key)) return;
  catalog.loadedTableKeys.add(key);
  for (const tablePath of catalog.lazyTablePathsByQualifiedName.get(key) ?? []) {
    try {
      const raw = JSON.parse(readFileSync(tablePath, "utf8")) as unknown;
      validateTableDocument(raw);
      const document = raw as TableDocument & JsonRecord;
      const documentKey = normalizeTable(String(document.qualifiedName));
      if (documentKey !== key) throw new Error("TABLE_DIRECTORY_ID_MISMATCH");
      const explicitPartitionFields = Array.isArray(document.partitionFields)
        ? uniqueSorted(
            document.partitionFields
              .map(String)
              .filter((field) => field.trim() !== ""),
          )
        : null;
      const ddlFile = asRecord(document.ddlFile);
      const ddlRelativePath = stringValue(ddlFile?.path);
      const ddlPath = ddlRelativePath
        ? resolve(dirname(tablePath), ddlRelativePath)
        : null;
      if (ddlPath && !isWithin(dirname(tablePath), ddlPath))
        throw new Error("DDL_FILE_PATH_ESCAPE");
      const entry: TableCatalogEntry = {
        table: {
          platform: String(document.platform),
          dataSource: String(document.dataSource),
          qualifiedName: documentKey,
          identityStatus: "RESOLVED",
        },
        evidence: {
          source: "TABLE_PACK",
          provider: String(document.evidenceProvider ?? "input-pack:table"),
          locator: tablePath,
          observedAt: String(document.collectedAt),
          contentHash: String(document.contentHash),
        },
        partitionFields: explicitPartitionFields,
        partitionReasonCodes:
          explicitPartitionFields === null
            ? ["PARTITION_FIELDS_UNAVAILABLE"]
            : [
                explicitPartitionFields.length === 0
                  ? "TABLE_PACK_NON_PARTITIONED"
                  : "TABLE_PACK_PARTITION_FIELDS",
              ],
        ddlPath,
        ddlSha256: stringValue(ddlFile?.sha256),
      };
      catalog.byQualifiedName.set(key, [
        ...(catalog.byQualifiedName.get(key) ?? []),
        entry,
      ]);
    } catch (error) {
      catalog.issues.push(
        `TABLE_INPUT_PACK_INVALID:${tablePath}:${safeMessage(error)}`,
      );
    }
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (values: readonly string[]) =>
    [...new Set(values.map((value) => normalizeTable(value)))].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function loadTableDdlDetails(
  catalog: TableCatalog,
  entry: TableCatalogEntry,
): TableDdlDetails {
  if (!entry.ddlPath)
    return { columns: [], partitionFields: null, warnings: ["DDL_MISSING"] };
  const cached = catalog.ddlCache.get(entry.ddlPath);
  if (cached) return cached;
  let details: TableDdlDetails;
  if (
    !existsSync(entry.ddlPath) ||
    (entry.ddlSha256 && sha256File(entry.ddlPath) !== entry.ddlSha256)
  )
    details = {
      columns: [],
      partitionFields: null,
      warnings: ["DDL_UNAVAILABLE_OR_HASH_MISMATCH"],
    };
  else {
    const parsed = parseDdlSchema(readFileSync(entry.ddlPath, "utf8"));
    details = {
      columns: uniqueSorted(parsed.columns.map((column) => column.name)),
      partitionFields:
        parsed.warnings.length === 0
          ? uniqueSorted(parsed.partition_columns)
          : null,
      warnings: parsed.warnings,
    };
  }
  catalog.ddlCache.set(entry.ddlPath, details);
  return details;
}

function hydrateTableCatalogEntry(
  catalog: TableCatalog,
  entry: TableCatalogEntry,
): TableCatalogEntry {
  if (!catalog.lazyDdl || entry.partitionFields !== null) return entry;
  const ddl = loadTableDdlDetails(catalog, entry);
  if (ddl.partitionFields === null) return entry;
  return {
    ...entry,
    partitionFields: ddl.partitionFields,
    partitionReasonCodes: ["DDL_PARTITION_FIELDS_FALLBACK"],
  };
}

function resolveCatalogTable(
  catalog: TableCatalog,
  qualifiedName: string | null,
): TableCatalogEntry {
  if (!qualifiedName)
    return {
      table: {
        platform: null,
        dataSource: null,
        qualifiedName: null,
        identityStatus: "UNKNOWN",
      },
      evidence: {
        source: "TABLE_PACK",
        provider: "input-pack:table",
        locator: "UNAVAILABLE",
        observedAt: null,
        detail: { reason: "QUALIFIED_NAME_MISSING" },
      },
      partitionFields: null,
      partitionReasonCodes: ["PARTITION_FIELDS_UNAVAILABLE"],
      ddlPath: null,
      ddlSha256: null,
    };
  const key = normalizeTable(qualifiedName);
  loadLazyTableCatalogKey(catalog, key);
  const candidates = catalog.byQualifiedName.get(key) ?? [];
  const identities = new Map<string, TableCatalogEntry>();
  for (const candidate of candidates) {
    const identity = tableIdentityKey(candidate.table);
    if (identity) identities.set(identity, candidate);
  }
  if (identities.size === 1)
    return hydrateTableCatalogEntry(catalog, [...identities.values()][0]!);
  return {
    table: {
      platform: null,
      dataSource: null,
      qualifiedName: key,
      identityStatus:
        candidates.length > 1 ? "AMBIGUOUS" : "QUALIFIED_NAME_ONLY",
    },
    evidence: {
      source: "TABLE_PACK",
      provider: "input-pack:table",
      locator: "UNRESOLVED",
      observedAt: null,
      detail: { candidateCount: candidates.length },
    },
    partitionFields: null,
    partitionReasonCodes:
      candidates.length > 1
        ? ["TABLE_IDENTITY_AMBIGUOUS"]
        : ["PARTITION_FIELDS_UNAVAILABLE"],
    ddlPath: null,
    ddlSha256: null,
  };
}

function targetQualifiedName(target: unknown): string | null {
  if (typeof target === "string") return stringValue(target);
  return stringValue(asRecord(target)?.qualifiedName);
}

function targetTable(
  target: unknown,
  catalog: TableCatalog,
): TableCatalogEntry {
  const record = asRecord(target);
  const qualifiedName = targetQualifiedName(target);
  if (record) {
    const platform = stringValue(record.platform);
    const dataSource = stringValue(record.dataSource);
    if (platform && dataSource && qualifiedName)
      return (() => {
        const catalogEntry = resolveCatalogTable(catalog, qualifiedName);
        return {
          ...catalogEntry,
          table: {
            platform,
            dataSource,
            qualifiedName: normalizeTable(qualifiedName),
            identityStatus: "RESOLVED" as const,
          },
        };
      })();
  }
  return resolveCatalogTable(catalog, qualifiedName);
}

function inputPackTaskEvidence(pack: LoadedTaskPack): EvidenceObservation {
  return {
    source: "INPUT_PACK_TASK",
    provider: String(pack.document?.evidenceProvider ?? "input-pack:task"),
    locator: pack.taskPath ?? "UNAVAILABLE",
    observedAt: stringValue(pack.document?.collectedAt),
    contentHash: stringValue(pack.document?.contentHash) ?? undefined,
  };
}

function inputPackSqlEvidence(file: TaskSqlFile): EvidenceObservation {
  return {
    source: "INPUT_PACK_SQL",
    provider: file.evidenceProvider,
    locator: file.absolutePath,
    observedAt: null,
    sha256: file.sha256,
    detail: { slot: file.slot, relativePath: file.path },
  };
}

export function prepareOneHopContext(
  dataRootInput: string,
  options: {
    readonly includeFingerprint?: boolean;
    readonly trustedInputFingerprint?: string;
    readonly schemaLoading?: "EAGER" | "TASK_SCOPED";
  } = {},
): OneHopPreparedContext {
  const dataRoot = resolve(dataRootInput);
  const taskScopedSchema = options.schemaLoading === "TASK_SCOPED";
  return {
    dataRoot,
    inputFingerprint:
      options.trustedInputFingerprint ??
      (options.includeFingerprint === false
        ? null
        : fingerprintTableProducerInputs(dataRoot)),
    tableCatalog: loadTableCatalog(dataRoot, { lazyDdl: taskScopedSchema }),
    schema: !taskScopedSchema && existsSync(join(dataRoot, "tables"))
      ? loadSchemaFromTablesRoot(join(dataRoot, "tables")).schema
      : null,
    validatedProducerIndexes: new WeakSet<TableProducerIndex>(),
  };
}

function partitionFromDocument(
  value: unknown,
  target?: string | null,
  sqlSlot: string | null = null,
  statementOrdinal: number | null = null,
): PartitionAssignment[] {
  const record = asRecord(value);
  if (!record) return [];
  if (Array.isArray(record.targets)) {
    const targetKey =
      target === null || target === undefined
        ? undefined
        : normalizeTable(target);
    const targetEvidence = record.targets.find((item) => {
      const candidate = asRecord(item);
      return (
        candidate !== null &&
        (targetKey === undefined ||
          normalizeTable(String(candidate.target)) === targetKey)
      );
    });
    const writes = asRecord(targetEvidence)?.writes;
    const matchedWrite = Array.isArray(writes)
      ? writes.find((item) => {
          const write = asRecord(item);
          return (
            write !== null &&
            (sqlSlot === null
              ? write.sqlSlot === null
              : write.sqlSlot === sqlSlot) &&
            (statementOrdinal === null ||
              write.statementOrdinal === statementOrdinal)
          );
        })
      : undefined;
    const write = asRecord(matchedWrite);
    if (!write || !Array.isArray(write.assignments)) return [];
    return write.assignments.flatMap((item): PartitionAssignment[] => {
      const assignment = asRecord(item);
      if (!assignment) return [];
      const status = String(assignment.status);
      return [
        {
          field: String(assignment.field).toLowerCase(),
          expression:
            assignment.expression === null
              ? "UNKNOWN"
              : String(assignment.expression),
          valueStatus: partitionValueStatus(status),
          observedValue:
            status === "CONFIRMED" && assignment.value !== null
              ? String(assignment.value)
              : null,
        },
      ];
    });
  }
  return Object.entries(record)
    .sort(([left], [right]) => compareText(left, right))
    .map(([field, rawValue]) => {
      const expression = String(rawValue);
      const runtime = /\$\{|\{\{|\{%|<%/u.test(expression);
      return {
        field: field.toLowerCase(),
        expression,
        valueStatus: runtime
          ? ("RUNTIME_EXPRESSION" as const)
          : ("OBSERVED_RENDERED_VALUE" as const),
        observedValue: runtime ? null : expression,
      };
    });
}

function mergeWrites(
  writes: readonly ConfirmedWriteObservation[],
): ConfirmedWriteObservation[] {
  const merged = new Map<string, ConfirmedWriteObservation>();
  for (const write of writes) {
    const key = tableIdentityKey(write.table);
    if (!key) continue;
    const current = merged.get(key);
    merged.set(
      key,
      current
        ? {
            ...current,
            writeKind: current.writeKind ?? write.writeKind,
            partition:
              current.partition.length > 0
                ? current.partition
                : write.partition,
            evidence: [...current.evidence, ...write.evidence],
          }
        : write,
    );
  }
  return [...merged.values()].sort((left, right) =>
    compareText(left.table.qualifiedName, right.table.qualifiedName),
  );
}

function dataPathRoleOfWrite(
  write: ProducerWriteObservation | ConfirmedWriteObservation,
): ProducerDataPathRole {
  if ("dataPathRole" in write && write.dataPathRole !== undefined)
    return write.dataPathRole;
  if ("observationKind" in write)
    return classifyProducerWriteObservation(write).dataPathRole;
  const mode = (write.writeKind ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
  if (mode === "delete" || mode === "truncate") return "MUTATION_ONLY";
  if (
    mode === "" ||
    mode === "append" ||
    mode === "overwrite" ||
    ["INSERT_OVERWRITE", "INSERT_INTO", "MERGE_INTO", "CTAS"].includes(
      mode.toUpperCase(),
    )
  )
    return "PRODUCER";
  return "UNKNOWN";
}

function isDataPathMutationOnly(
  write: ProducerWriteObservation | ConfirmedWriteObservation,
): boolean {
  return dataPathRoleOfWrite(write) === "MUTATION_ONLY";
}

function writesFromPack(
  pack: LoadedTaskPack,
  catalog: TableCatalog,
): {
  confirmedWrites: ConfirmedWriteObservation[];
  unconfirmedTargets: UnconfirmedTargetObservation[];
} {
  if (!pack.document) return { confirmedWrites: [], unconfirmedTargets: [] };
  const confirmedWrites: ConfirmedWriteObservation[] = [];
  const unconfirmedTargets: UnconfirmedTargetObservation[] = [];
  const packEvidence = inputPackTaskEvidence(pack);
  const target = targetTable(pack.document.target, catalog);
  const evidenceKind = stringValue(pack.document.targetEvidenceKind);
  if (
    evidenceKind === "DIRECT_PLATFORM_TARGET" ||
    evidenceKind === "SQL_EXACT_TABLE_TARGET"
  ) {
    if (tableIdentityKey(target.table))
      confirmedWrites.push({
        table: target.table,
        writeKind: stringValue(pack.document.writeMode),
        partition: partitionFromDocument(
          pack.document.partition,
          target.table.qualifiedName,
        ),
        evidence: [packEvidence, target.evidence],
      });
    else
      unconfirmedTargets.push({
        qualifiedName: target.table.qualifiedName,
        reason: "TARGET_IDENTITY_UNRESOLVED",
        evidence: [packEvidence, target.evidence],
      });
  } else if (target.table.qualifiedName) {
    unconfirmedTargets.push({
      qualifiedName: target.table.qualifiedName,
      reason: evidenceKind ?? "TARGET_DIRECTION_UNAVAILABLE",
      evidence: [packEvidence, target.evidence],
    });
  }
  for (const file of pack.sqlFiles) {
    for (const sqlWrite of extractSqlWrites(file.content)) {
      if (!sqlWrite.qualifiedName.includes(".")) continue;
      const resolved = resolveCatalogTable(catalog, sqlWrite.qualifiedName);
      if (!tableIdentityKey(resolved.table)) continue;
      confirmedWrites.push({
        table: resolved.table,
        writeKind: sqlWrite.writeKind,
        partition: partitionFromDocument(
          pack.document.partition,
          resolved.table.qualifiedName,
          file.slot,
          sqlWrite.statementOrdinal,
        ),
        evidence: [
          inputPackSqlEvidence(file),
          {
            source: "SQL_PARSE",
            provider: "sql-static-lineage:write-extractor",
            locator: `${file.absolutePath}#char=${sqlWrite.statementSpan.start}-${sqlWrite.statementSpan.end}`,
            observedAt: null,
            detail: { writeKind: sqlWrite.writeKind },
          },
          resolved.evidence,
        ],
      });
    }
  }
  return { confirmedWrites: mergeWrites(confirmedWrites), unconfirmedTargets };
}

function writesFromLookup(
  taskId: string,
  lookup: WriterLookup,
): {
  confirmedWrites: ConfirmedWriteObservation[];
  unconfirmedTargets: UnconfirmedTargetObservation[];
} {
  const indexedWrites = lookupProducerWritesByTaskFor(lookup, taskId);
  const confirmedWrites = indexedWrites.confirmedWrites
    .map((edge) => {
      const representative = edge.writes.find(
        (write) =>
          write.sqlWriteKind !== null || write.declaredWriteMode !== null,
      );
      const partitioned = edge.writes.find(
        (write) => write.partition.length > 0,
      );
      return {
        table: edge.table,
        writeKind:
          representative?.sqlWriteKind ??
          representative?.declaredWriteMode ??
          null,
        partition: partitioned?.partition ?? [],
        evidence: edge.writes.flatMap((write) => write.evidence),
      };
    });
  const unconfirmedTargets = indexedWrites.nonConfirmedRelations
    .map((relation) => ({
      qualifiedName: relation.tableRef.qualifiedName,
      reason: relation.reasonCodes.join("|"),
      evidence: relation.evidence,
    }));
  return { confirmedWrites, unconfirmedTargets };
}

function liveParent(
  taskId: string,
  runner: OpenCliRunner,
  catalog: TableCatalog,
  now: () => string,
  timeoutSeconds: number,
): { confirmedWrites: ConfirmedWriteObservation[]; issues: string[] } {
  const args = [
    "szdata",
    "task-source",
    "--task-id",
    taskId,
    "-f",
    "json",
    "--timeout",
    String(timeoutSeconds),
  ];
  try {
    const response = asRecord(firstResult(runner(args)));
    if (!response)
      return { confirmedWrites: [], issues: ["TASK_SOURCE_INVALID_RESPONSE"] };
    const status = stringValue(response.status);
    const target = stringValue(response.target);
    const evidence: EvidenceObservation = {
      source: "SZDATA_TASK_SOURCE",
      provider:
        stringValue(response.evidenceLevel) ?? "opencli:szdata.task-source",
      locator: `opencli ${args.join(" ")}`,
      observedAt: now(),
      detail: {
        status,
        sqlStatus: stringValue(response.sqlStatus),
        limitations: (response.limitations ?? null) as JsonValue,
      },
    };
    if (status !== "SUCCEEDED" || !target)
      return {
        confirmedWrites: [],
        issues: [`TASK_SOURCE_TARGET_UNAVAILABLE:${status ?? "UNKNOWN"}`],
      };
    const resolved = resolveCatalogTable(catalog, target);
    if (!tableIdentityKey(resolved.table))
      return {
        confirmedWrites: [],
        issues: [`TASK_SOURCE_TARGET_IDENTITY_UNRESOLVED:${target}`],
      };
    return {
      confirmedWrites: [
        {
          table: resolved.table,
          writeKind: stringValue(response.loadMode),
          partition: partitionAssignments(stringValue(response.hivePartition)),
          evidence: [evidence, resolved.evidence],
        },
      ],
      issues: [],
    };
  } catch (error) {
    return {
      confirmedWrites: [],
      issues: [`TASK_SOURCE_FAILED:${safeMessage(error)}`],
    };
  }
}

function addSchemaMapping(
  mapping: SchemaMapping,
  qualifiedName: string,
  columns: readonly string[],
): void {
  const parts = qualifiedName.split(".").filter(Boolean);
  if (parts.length === 0 || columns.length === 0) return;
  let namespace = mapping;
  for (const part of parts.slice(0, -1)) {
    const existing = namespace[part];
    if (
      typeof existing !== "object" ||
      existing === null ||
      "nullable" in existing
    )
      namespace[part] = {};
    namespace = namespace[part] as SchemaMapping;
  }
  namespace[parts.at(-1)!] = Object.fromEntries(
    columns.map((column) => [column, "unknown"]),
  );
}

function taskScopedSchema(
  pack: LoadedTaskPack,
  catalog: TableCatalog,
): unknown {
  if (!pack.document) return undefined;
  const dialect = taskSqlDialect(String(pack.document.taskCategory));
  const defaultSchema = inferTaskDefaultSchema(pack.document);
  const tableNames = new Set<string>();
  for (const file of pack.sqlFiles)
    for (const occurrence of extractSqlDirectReadOccurrences(
      file.content,
      dialect,
    ))
      tableNames.add(
        qualifyBareTableName(occurrence.qualifiedName, defaultSchema),
      );

  const mapping: SchemaMapping = {};
  for (const tableName of tableNames) {
    const entry = resolveCatalogTable(catalog, tableName);
    if (!entry.table.qualifiedName) continue;
    const ddl = loadTableDdlDetails(catalog, entry);
    addSchemaMapping(mapping, entry.table.qualifiedName, ddl.columns);
  }
  const schema = new Schema(mapping);
  return {
    world: "open" as const,
    version: schema.version,
    columnsFor: schema.columnsFor.bind(schema),
    tableCandidates: schema.tableCandidates.bind(schema),
    childrenOf: schema.childrenOf.bind(schema),
    tables: schema.tables.bind(schema),
  };
}

function currentDirectReads(
  pack: LoadedTaskPack,
  catalog: TableCatalog,
  schema: unknown,
): DirectReadObservation[] {
  if (!pack.document || !pack.taskPath)
    throw new Error("CURRENT_TASK_INPUT_PACK_UNAVAILABLE");
  const dialect = taskSqlDialect(String(pack.document.taskCategory));
  const defaultSchema = inferTaskDefaultSchema(pack.document);
  const effectiveSchema = catalog.lazyDdl
    ? taskScopedSchema(pack, catalog)
    : schema;
  const byTable = new Map<string, DirectReadObservation>();
  for (const file of pack.sqlFiles) {
    for (const occurrence of extractSqlDirectReadOccurrences(
      file.content,
      dialect,
      effectiveSchema,
    )) {
      const qualifiedName = qualifyBareTableName(
        occurrence.qualifiedName,
        defaultSchema,
      );
      const resolved = resolveCatalogTable(catalog, qualifiedName);
      const key = normalizeTable(qualifiedName);
      const scopeEvidence = [
        {
          source: "SQL_PARSE" as const,
          provider: "sql-static-lineage:plan-adapter",
          locator: `${file.absolutePath}#statement=${occurrence.statementIndex}`,
          observedAt: null,
          detail: {
            dialect,
            statementIndex: occurrence.statementIndex,
          },
        },
        {
          source: "TABLE_PACK" as const,
          provider: resolved.evidence.provider,
          locator: resolved.evidence.locator,
          observedAt: resolved.evidence.observedAt,
        },
      ];
      const resolvedScope = resolveReadPartitionScope({
        predicate: occurrence.predicateTree,
        tableQualifiedName: resolved.table.qualifiedName ?? qualifiedName,
        partitionFields: resolved.partitionFields,
        partitionReasonCodes: resolved.partitionReasonCodes,
        evidence: scopeEvidence,
      });
      const scope = {
        ...resolvedScope,
        status:
          resolvedScope.status === "UNPARTITIONED" ||
          resolvedScope.predicate !== null
            ? resolvedScope.status
            : occurrence.bindingStatus === "UNKNOWN"
              ? ("UNKNOWN" as const)
              : resolvedScope.status,
        reasonCodes: [
          ...new Set([
            ...resolvedScope.reasonCodes,
            ...occurrence.reasonCodes,
            ...(occurrence.bindingStatus === "UNKNOWN"
              ? ["READ_OCCURRENCE_PREDICATE_BINDING_UNKNOWN"]
              : []),
          ]),
        ].sort(),
      };
      const read: SqlDirectRead = {
        qualifiedName,
        statementIndexes: [occurrence.statementIndex],
        syntaxDiagnosticCount: occurrence.syntaxDiagnosticCount,
        parserUnknownCount: occurrence.parserUnknownCount,
      };
      const observation: DirectReadObservation = {
        table: resolved.table,
        sql: read,
        readPartitionScopes: [
          {
            occurrenceId: `${file.slot}#${occurrence.occurrenceId}`,
            readRelationId: occurrence.readRelationId,
            statementIndex: occurrence.statementIndex,
            relationPath: occurrence.relationPath,
            predicateTree: occurrence.predicateTree,
            predicateEvidence: occurrence.predicateEvidence,
            scope,
          },
        ],
        evidence: [
          inputPackSqlEvidence(file),
          {
            source: "SQL_PARSE",
            provider: "sql-static-lineage:plan-adapter",
            locator: `${file.absolutePath}#statement=${occurrence.statementIndex}`,
            observedAt: null,
            detail: {
              dialect,
              syntaxDiagnosticCount: occurrence.syntaxDiagnosticCount,
              parserUnknownCount: occurrence.parserUnknownCount,
              readPartitionScopeStatus: scope.status,
              readPartitionScopeReasonCodes: scope.reasonCodes,
              readOccurrenceId: `${file.slot}#${occurrence.occurrenceId}`,
              readRelationId: occurrence.readRelationId,
              readRelationPath: occurrence.relationPath,
              readPredicateBindingStatus: occurrence.bindingStatus,
              readPredicateEvidence: occurrence.predicateEvidence,
              ...(defaultSchema &&
              qualifiedName !== normalizeTable(occurrence.qualifiedName)
                ? {
                    parsedQualifiedName: normalizeTable(occurrence.qualifiedName),
                    taskDefaultSchema: defaultSchema.schema,
                    taskDefaultSchemaEvidence: defaultSchema.evidenceSources,
                  }
                : {}),
            },
          },
          resolved.evidence,
        ],
      };
      const current = byTable.get(key);
      byTable.set(
        key,
        current
          ? {
              ...current,
              sql: {
                ...current.sql,
                statementIndexes: uniqueSorted([
                  ...current.sql.statementIndexes.map(String),
                  ...read.statementIndexes.map(String),
                ]).map(Number),
                syntaxDiagnosticCount:
                  current.sql.syntaxDiagnosticCount +
                  read.syntaxDiagnosticCount,
                parserUnknownCount:
                  current.sql.parserUnknownCount + read.parserUnknownCount,
              },
              readPartitionScopes: [
                ...current.readPartitionScopes,
                ...observation.readPartitionScopes,
              ],
              evidence: [...current.evidence, ...observation.evidence],
            }
          : observation,
      );
    }
  }
  return [...byTable.values()].sort((left, right) =>
    compareText(left.table.qualifiedName, right.table.qualifiedName),
  );
}

function partitionMatchRank(status: ProducerPartitionMatchStatus): number {
  return status === "PROVEN_OVERLAP"
    ? 4
    : status === "POSSIBLE_OVERLAP"
      ? 3
      : status === "UNKNOWN"
        ? 2
        : 1;
}

function mergePartitionMatch(
  left: ProducerPartitionMatch | undefined,
  right: ProducerPartitionMatch,
): ProducerPartitionMatch {
  if (!left) return right;
  const leftRank = partitionMatchRank(left.status);
  const rightRank = partitionMatchRank(right.status);
  if (leftRank > rightRank) return left;
  if (rightRank > leftRank) return right;
  const writes = new Map(
    [...left.writes, ...right.writes].map((write) => [
      JSON.stringify(write),
      write,
    ]),
  );
  return {
    ...left,
    reasonCodes: uniqueSorted([
      ...left.reasonCodes,
      ...right.reasonCodes,
    ]),
    writes: [...writes.values()],
  };
}

interface ReadOccurrenceMatchGroup {
  readonly table: PhysicalTableRef;
  readonly occurrence: DirectReadPartitionScopeObservation;
  readonly matches: readonly ProducerPartitionMatch[];
}

function decideReadOccurrenceProducers(
  group: ReadOccurrenceMatchGroup,
  scheduleTaskIds: ReadonlySet<string>,
): ReadOccurrenceProducerDecision {
  const candidates = group.matches
    .filter((match) => match.status !== "PROVEN_DISJOINT")
    .map((match) => ({
      match,
      scheduleRelation: scheduleTaskIds.has(match.taskId)
        ? ("DIRECT_PARENT" as const)
        : ("NOT_DIRECT_PARENT" as const),
    }));
  const usable = candidates.filter(
    ({ match }) => match.status !== "UNKNOWN",
  );
  const overwrites = usable.filter(({ match }) =>
    match.writes.some(isInsertOverwrite),
  );
  const hasOverlap = overwrites.some((left, leftIndex) =>
    overwrites.slice(leftIndex + 1).some((right) =>
      left.match.writes.some(
        (leftWrite) =>
          isInsertOverwrite(leftWrite) &&
          right.match.writes.some(
            (rightWrite) =>
              isInsertOverwrite(rightWrite) &&
              partitionScopesMayOverlap(
                leftWrite.partition,
                rightWrite.partition,
              ),
          ),
      ),
    ),
  );
  const scheduledOverwrites = overwrites.filter(
    ({ scheduleRelation }) => scheduleRelation === "DIRECT_PARENT",
  );
  const overlappingUnknown =
    hasOverlap && scheduledOverwrites.length !== 1
      ? new Set(overwrites.map(({ match }) => match.taskId))
      : new Set<string>();
  const unknown = new Set(
    candidates
      .filter(({ match }) => match.status === "UNKNOWN")
      .map(({ match }) => match.taskId),
  );
  for (const taskId of overlappingUnknown) unknown.add(taskId);
  const scheduledUsable = usable
    .filter(
      ({ match, scheduleRelation }) =>
        scheduleRelation === "DIRECT_PARENT" && !unknown.has(match.taskId),
    )
    .map(({ match }) => match.taskId);
  const primary =
    scheduledUsable.length > 0
      ? scheduledUsable
      : usable
          .filter(({ match }) => !unknown.has(match.taskId))
          .map(({ match }) => match.taskId);
  const additional =
    scheduledUsable.length > 0
      ? []
      : usable
          .filter(
            ({ match }) =>
              !unknown.has(match.taskId) && !primary.includes(match.taskId),
          )
          .map(({ match }) => match.taskId);
  return {
    table: group.table,
    occurrenceId: group.occurrence.occurrenceId,
    readRelationId: group.occurrence.readRelationId,
    statementIndex: group.occurrence.statementIndex,
    relationPath: group.occurrence.relationPath,
    candidates: candidates
      .map(({ match, scheduleRelation }) => ({
        taskId: match.taskId,
        scheduleRelation,
        partitionMatchStatus: match.status,
      }))
      .sort((left, right) => compareText(left.taskId, right.taskId)),
    primary: uniqueSorted(primary),
    additional: uniqueSorted(additional),
    unknown: uniqueSorted([...unknown]),
    decision:
      overlappingUnknown.size > 0
        ? "MULTIPLE_OVERLAPPING_PRODUCERS"
        : scheduledUsable.length > 0
          ? "SCHEDULE_DATA_INTERSECTION"
          : primary.length > 0
            ? "DATA_FALLBACK"
            : "NO_MATCH",
  };
}

function isInsertOverwrite(
  write: ProducerWriteObservation | ConfirmedWriteObservation,
): boolean {
  const kind =
    "sqlWriteKind" in write ? write.sqlWriteKind : write.writeKind;
  return kind?.toUpperCase() === "INSERT_OVERWRITE";
}

function partitionScopesMayOverlap(
  left: readonly PartitionAssignment[],
  right: readonly PartitionAssignment[],
): boolean {
  // An unpartitioned write or a runtime/partial partition scope can cover the
  // same rows. Only a known differing value proves disjointness.
  if (left.length === 0 || right.length === 0) return true;
  const rightByField = new Map(right.map((item) => [item.field, item]));
  for (const leftAssignment of left) {
    const rightAssignment = rightByField.get(leftAssignment.field);
    if (!rightAssignment) continue;
    if (
      leftAssignment.valueStatus === "OBSERVED_RENDERED_VALUE" &&
      rightAssignment.valueStatus === "OBSERVED_RENDERED_VALUE" &&
      leftAssignment.observedValue !== null &&
      rightAssignment.observedValue !== null &&
      leftAssignment.observedValue !== rightAssignment.observedValue
    )
      return false;
  }
  return true;
}

function overlappingOverwriteTaskIds(
  producers: readonly DataPathConfirmedProducer[],
  scheduleTaskIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const byTable = new Map<string, DataPathConfirmedProducer[]>();
  for (const producer of producers) {
    const key = tableIdentityKey(producer.table);
    if (!key) continue;
    const values = byTable.get(key) ?? [];
    values.push(producer);
    byTable.set(key, values);
  }
  const ambiguous = new Set<string>();
  for (const group of byTable.values()) {
    const overwrites = group.filter(
      (producer) =>
        producer.partitionMatch.status !== "PROVEN_DISJOINT" &&
        producer.writes.some(isInsertOverwrite),
    );
    const hasOverlap = overwrites.some((left, leftIndex) =>
      overwrites.slice(leftIndex + 1).some((right) =>
        left.writes.some((leftWrite) =>
          isInsertOverwrite(leftWrite) &&
          right.writes.some(
            (rightWrite) =>
              isInsertOverwrite(rightWrite) &&
              partitionScopesMayOverlap(leftWrite.partition, rightWrite.partition),
          ),
        ),
      ),
    );
    if (!hasOverlap) continue;
    const scheduled = group.filter((producer) =>
      scheduleTaskIds.has(producer.taskId),
    );
    // A single scheduler parent can disambiguate static writer candidates.
    // Zero or multiple parents cannot establish which overwrite owns the
    // consumed table/partition, so fail closed for the whole overlap group.
    if (scheduled.length !== 1)
      for (const producer of overwrites) ambiguous.add(producer.taskId);
  }
  return ambiguous;
}

function reconcileOneHopInternal(
  taskId: string,
  options: ReconcileOneHopOptions,
  preparedContext: OneHopPreparedContext,
): OneHopReconciliationResult {
  if (!SAFE_TASK_ID.test(taskId)) throw new Error("INVALID_TASK_ID");
  const dataRoot = resolve(options.dataRoot);
  const runner = options.openCliRunner ?? defaultOpenCliRunner;
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutSeconds = options.taskSourceTimeoutSeconds ?? 20;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)
    throw new Error("INVALID_TASK_SOURCE_TIMEOUT");

  const lookup = resolveWriterLookup({
    writerCatalog: options.writerCatalog,
    producerIndex: options.producerIndex,
  });
  if (options.trustedInputFingerprint !== undefined) {
    if (options.verifyInputFingerprint !== true || !/^[a-f0-9]{64}$/i.test(options.trustedInputFingerprint)) throw new Error("TRUSTED_INPUT_FINGERPRINT_INVALID");
    if (lookup?.kind === "legacyIndex" && lookup.index.inputFingerprint !== options.trustedInputFingerprint) throw new Error("TRUSTED_INPUT_FINGERPRINT_MISMATCH");
  }
  let producerIndexStatus: ProducerIndexConsumptionStatus = "NOT_REQUESTED";
  let lookupMeta = lookup ? writerLookupMeta(lookup) : null;
  if (lookup?.kind === "legacyIndex") {
    if (!preparedContext.validatedProducerIndexes.has(lookup.index)) {
      try {
        validateTableProducerIndex(lookup.index);
      } catch (error) {
        throw new Error(`PRODUCER_INDEX_INVALID:${safeMessage(error)}`);
      }
      preparedContext.validatedProducerIndexes.add(lookup.index);
    }
    if (
      options.verifyInputFingerprint === true &&
      (preparedContext.inputFingerprint === null ||
        preparedContext.inputFingerprint !== lookup.index.inputFingerprint)
    )
      throw new Error(
        "PRODUCER_INDEX_INPUT_FINGERPRINT_MISMATCH: producer index does not match dataRoot",
      );
    producerIndexStatus = lookupMeta!.status;
  } else if (lookup?.kind === "catalog") {
    producerIndexStatus = lookupMeta!.status;
  }

  const currentPack = loadTaskPack(dataRoot, taskId);
  if (
    currentPack.status !== "AVAILABLE" ||
    !currentPack.document ||
    !currentPack.taskPath
  )
    throw new Error(
      `CURRENT_TASK_INPUT_PACK_${currentPack.status}:${taskId}:` +
        currentPack.issues.join(";"),
    );
  const catalog = preparedContext.tableCatalog;
  const directReads = currentDirectReads(
    currentPack,
    catalog,
    preparedContext.schema,
  );
  const terminalRoleOf = (
    qualifiedName: string | null | undefined,
  ): string | null =>
    options.terminalTableConfig && qualifiedName
      ? matchingTerminalRole(options.terminalTableConfig, qualifiedName)
      : null;

  const horaeArgs = [
    "horae",
    "relation",
    taskId,
    "--direction",
    "up",
    "--depth",
    "1",
    "-f",
    "json",
  ];
  const keyedRows = options.scheduleRowsByTaskId instanceof Map
    ? options.scheduleRowsByTaskId.get(taskId)
    : options.scheduleRowsByTaskId
      ? (options.scheduleRowsByTaskId as Readonly<Record<string, readonly Record<string, unknown>[]>>)[taskId]
      : undefined;
  const keyedEvidence = options.scheduleEvidenceByTaskId?.get(taskId);
  if (options.scheduleEvidenceByTaskId && !keyedEvidence) throw new Error(`SCHEDULE_EVIDENCE_MISSING:${taskId}`);
  if (options.scheduleRowsByTaskId && keyedRows === undefined) throw new Error(`SCHEDULE_ROWS_MISSING:${taskId}`);
  const suppliedRows = keyedEvidence?.rows ?? keyedRows ?? options.scheduleRows;
  const offlineScheduleRows = suppliedRows !== undefined;
  const cacheRoot = options.scheduleEvidenceCacheRoot === undefined
    ? (options.openCliRunner === undefined ? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT : null)
    : options.scheduleEvidenceCacheRoot;
  const cacheRead = !offlineScheduleRows && cacheRoot !== null
    ? readHoraeRelationCache(taskId, cacheRoot)
    : null;
  let scheduleRows: JsonRecord[];
  let scheduleObservedAt: string | null;
  let scheduleCacheStatus: Exclude<ScheduleEvidenceCacheStatus, "DISABLED"> | undefined;
  let scheduleCachePath: string | undefined;
  if (suppliedRows !== undefined) {
    scheduleRows = [...suppliedRows];
    scheduleObservedAt = keyedEvidence?.observedAt ?? null;
    scheduleCacheStatus = keyedEvidence?.cacheStatus;
    scheduleCachePath = keyedEvidence?.cachePath;
  } else if (cacheRead?.status === "HIT") {
    scheduleRows = [...cacheRead.rows];
    scheduleObservedAt = cacheRead.observedAt;
    scheduleCacheStatus = "HIT";
    scheduleCachePath = cacheRead.path;
  } else {
    const response = runner(horaeArgs);
    scheduleRows = rowsOf(response);
    scheduleObservedAt = now();
    if (cacheRoot !== null) {
      scheduleCacheStatus = cacheRead?.status ?? "MISS";
      scheduleCachePath = cacheRead?.path ?? scheduleEvidenceCachePath(taskId, cacheRoot);
      if (isCacheableHoraeRelationResponse(response, scheduleRows)) {
        try {
          scheduleCachePath = writeHoraeRelationCache(
            taskId,
            scheduleObservedAt,
            scheduleRows,
            cacheRoot,
          );
        } catch {
          // Scheduler evidence remains usable when the optional cache is not writable.
        }
      }
    }
  }
  const scheduleEvidence: EvidenceObservation = {
    source: "HORAE_RELATION",
    provider: keyedEvidence?.provider ?? (offlineScheduleRows ? "offline:horae.relation" : "opencli:horae.relation"),
    locator: keyedEvidence?.locator ?? (offlineScheduleRows ? "offline schedule evidence input" : `opencli ${horaeArgs.join(" ")}`),
    observedAt: scheduleObservedAt,
    detail: {
      direction: "up",
      depth: 1,
      ...(offlineScheduleRows
        ? { rowsProvided: suppliedRows!.length }
        : {}),
      ...(scheduleCacheStatus === undefined
        ? {}
        : { cacheStatus: scheduleCacheStatus }),
      ...(scheduleCachePath === undefined
        ? {}
        : { cachePath: scheduleCachePath }),
    },
  };
  const scheduleParents = new Map<
    string,
    { taskId: string; taskName: string | null; evidence: EvidenceObservation[] }
  >();
  for (const row of scheduleRows) {
    const parentTaskId = stringValue(row.task_id ?? row.taskId);
    if (!parentTaskId || !SAFE_TASK_ID.test(parentTaskId)) continue;
    scheduleParents.set(parentTaskId, {
      taskId: parentTaskId,
      taskName: stringValue(row.task_name ?? row.taskName),
      evidence: [
        {
          ...scheduleEvidence,
          detail: {
            direction: "up",
            depth: 1,
            relationDirection: stringValue(row.direction),
          },
        },
      ],
    });
  }

  const orderedScheduleParents = [...scheduleParents.values()].sort(
    (left, right) => compareText(left.taskId, right.taskId),
  );
  const parents: ParentObservation[] = [];
  let liveTaskSourceAttempts = 0;
  let liveTaskSourceSuccesses = 0;
  let liveTaskSourceFailures = 0;
  for (const scheduleParent of orderedScheduleParents) {
    const pack = loadTaskPack(dataRoot, scheduleParent.taskId);
    const fromPack = lookup
      ? writesFromLookup(scheduleParent.taskId, lookup)
      : writesFromPack(pack, catalog);
    const shouldUseLive = pack.status !== "AVAILABLE" && !lookup;
    if (shouldUseLive) liveTaskSourceAttempts += 1;
    const live = !shouldUseLive
      ? {
          confirmedWrites: [] as ConfirmedWriteObservation[],
          issues: [] as string[],
        }
      : liveParent(scheduleParent.taskId, runner, catalog, now, timeoutSeconds);
    if (shouldUseLive) {
      if (live.confirmedWrites.length > 0) liveTaskSourceSuccesses += 1;
      else liveTaskSourceFailures += 1;
    }
    const confirmedWrites = mergeWrites([
      ...fromPack.confirmedWrites,
      ...live.confirmedWrites,
    ]);
    parents.push({
      taskId: scheduleParent.taskId,
      taskName: scheduleParent.taskName,
      scheduleEvidence: scheduleParent.evidence,
      inputPackStatus: pack.status,
      resolutionStatus: confirmedWrites.length > 0 ? "RESOLVED" : "UNRESOLVED",
      confirmedWrites,
      unconfirmedTargets: fromPack.unconfirmedTargets,
      issues: [...pack.issues, ...live.issues],
    });
  }

  const readsByIdentity = new Map<string, DirectReadObservation>();
  for (const read of directReads) {
    const identity = tableIdentityKey(read.table);
    if (identity) readsByIdentity.set(identity, read);
  }
  const matchedReadIdentities = new Set<string>();
  const reconciliation: ReconciliationItem[] = [];
  for (const parent of parents) {
    if (parent.confirmedWrites.length === 0) {
      const unconfirmed = parent.unconfirmedTargets[0];
      if (terminalRoleOf(unconfirmed?.qualifiedName)) continue;
      const table = resolveCatalogTable(
        catalog,
        unconfirmed?.qualifiedName ?? null,
      ).table;
      reconciliation.push({
        status: "UNRESOLVED",
        taskId: parent.taskId,
        table,
        read: tableIdentityKey(table)
          ? (readsByIdentity.get(tableIdentityKey(table)!) ?? null)
          : null,
        write: null,
        evidence: [
          ...parent.scheduleEvidence,
          ...(unconfirmed?.evidence ?? []),
        ],
        reason:
          unconfirmed?.reason ?? parent.issues[0] ?? "PARENT_WRITE_UNRESOLVED",
      });
      continue;
    }
    for (const write of parent.confirmedWrites) {
      if (terminalRoleOf(write.table.qualifiedName)) continue;
      const identity = tableIdentityKey(write.table)!;
      const read = readsByIdentity.get(identity) ?? null;
      if (read) matchedReadIdentities.add(identity);
      reconciliation.push({
        status: read ? "MATCHED" : "SCHEDULE_ONLY",
        taskId: parent.taskId,
        table: write.table,
        read,
        write,
        evidence: [
          ...parent.scheduleEvidence,
          ...write.evidence,
          ...(read?.evidence ?? []),
        ],
        reason: read ? null : "CONFIRMED_PARENT_WRITE_NOT_READ_BY_CURRENT_SQL",
      });
    }
  }
  for (const read of directReads) {
    const identity = tableIdentityKey(read.table);
    if (identity && matchedReadIdentities.has(identity)) continue;
    reconciliation.push({
      status: "SQL_ONLY",
      taskId: null,
      table: read.table,
      read,
      write: null,
      evidence: read.evidence,
      reason: terminalRoleOf(read.table.qualifiedName)
        ? "REFERENCE_CONFIG"
        : identity
          ? "NO_CONFIRMED_HORAE_PARENT_WRITE"
          : "READ_TABLE_IDENTITY_UNRESOLVED",
    });
  }

  const confirmedProducers: DataPathConfirmedProducer[] = [];
  const relatedNonConfirmedRelations: NonConfirmedRelation[] = [];
  const partitionMatchesByEdge = new Map<string, ProducerPartitionMatch>();
  const readOccurrenceMatchGroups: ReadOccurrenceMatchGroup[] = [];
  if (lookup) {
    const seenEdges = new Set<string>();
    const seenRelations = new Set<string>();
    for (const read of directReads) {
      if (terminalRoleOf(read.table.qualifiedName)) continue;
      const identity = producerIdentity(read.table);
      if (!identity) continue;
      for (const occurrence of read.readPartitionScopes) {
        const occurrenceMatches = matchProducersByReadScopeFor(
          lookup,
          identity,
          occurrence.scope,
        );
        readOccurrenceMatchGroups.push({
          table: read.table,
          occurrence,
          matches: occurrenceMatches,
        });
        for (const match of occurrenceMatches) {
          const key = `${match.table.platform.toLowerCase()}|${match.table.dataSource.toLowerCase()}|${normalizeTable(match.table.qualifiedName)}\u0000${match.taskId}`;
          partitionMatchesByEdge.set(
            key,
            mergePartitionMatch(partitionMatchesByEdge.get(key), match),
          );
        }
      }
      for (const edge of lookupConfirmedProducersFor(lookup, identity)) {
        const key = `${tableIdentityKey(edge.table)}\u0000${edge.taskId}`;
        if (seenEdges.has(key)) continue;
        const producerWrites = edge.writes.filter(
          (write) => !isDataPathMutationOnly(write),
        );
        if (producerWrites.length === 0) continue;
        seenEdges.add(key);
        const partitionMatch = partitionMatchesByEdge.get(key);
        confirmedProducers.push({
          table: edge.table,
          taskId: edge.taskId,
          scheduleRelation: scheduleParents.has(edge.taskId)
            ? "DIRECT_PARENT"
            : "NOT_DIRECT_PARENT",
          partitionMatch: {
            status: partitionMatch?.status ?? "UNKNOWN",
            reasonCodes: partitionMatch?.reasonCodes ?? [
              "READ_PARTITION_SCOPE_UNAVAILABLE",
            ],
            writes: partitionMatch?.writes ?? [],
          },
          writes: producerWrites,
        });
      }
      for (const relation of lookupNonConfirmedRelationsFor(
        lookup,
        identity,
      )) {
        const key = JSON.stringify(relation);
        if (seenRelations.has(key)) continue;
        seenRelations.add(key);
        relatedNonConfirmedRelations.push(relation);
      }
    }
  } else {
    const byEdge = new Map<string, DataPathConfirmedProducer>();
    for (const item of reconciliation) {
      if (
        item.status !== "MATCHED" ||
        !item.taskId ||
        !item.write ||
        isDataPathMutationOnly(item.write)
      )
        continue;
      const identity = tableIdentityKey(item.table);
      if (!identity) continue;
      const key = `${identity}\u0000${item.taskId}`;
      const current = byEdge.get(key);
      byEdge.set(
        key,
        current
          ? { ...current, writes: [...current.writes, item.write] }
          : {
              table: item.table,
              taskId: item.taskId,
              scheduleRelation: "DIRECT_PARENT",
              partitionMatch: {
                status: "UNKNOWN",
                reasonCodes: ["LEGACY_SCHEDULE_RECONCILIATION"],
                writes: [],
              },
              writes: [item.write],
            },
      );
    }
    confirmedProducers.push(...byEdge.values());
  }
  confirmedProducers.sort((left, right) =>
    compareText(
      `${tableIdentityKey(left.table) ?? ""}\u0000${left.taskId}`,
      `${tableIdentityKey(right.table) ?? ""}\u0000${right.taskId}`,
    ),
  );

  const partitionAwareTaskStatuses = new Map<
    string,
    Exclude<ProducerPartitionMatchStatus, "PROVEN_DISJOINT">
  >();
  const partitionMatchCounts: Record<ProducerPartitionMatchStatus, number> = {
    PROVEN_OVERLAP: 0,
    POSSIBLE_OVERLAP: 0,
    PROVEN_DISJOINT: 0,
    UNKNOWN: 0,
  };
  const producersByTable = new Map<string, number>();
  for (const producer of confirmedProducers) {
    partitionMatchCounts[producer.partitionMatch.status] += 1;
    if (producer.partitionMatch.status !== "PROVEN_DISJOINT") {
      const current = partitionAwareTaskStatuses.get(producer.taskId);
      const next = producer.partitionMatch.status;
      if (!current || partitionMatchRank(next) > partitionMatchRank(current))
        partitionAwareTaskStatuses.set(
          producer.taskId,
          next as Exclude<ProducerPartitionMatchStatus, "PROVEN_DISJOINT">,
        );
    }
    const tableKey = tableIdentityKey(producer.table);
    if (tableKey)
      producersByTable.set(tableKey, (producersByTable.get(tableKey) ?? 0) + 1);
  }
  const readScopeStatusCounts: Record<ReadPartitionScope["status"], number> = {
    UNPARTITIONED: 0,
    ALL_PARTITIONS: 0,
    CONSTRAINED: 0,
    PARTIAL: 0,
    UNKNOWN: 0,
  };
  const readPartitionOccurrenceCount = directReads.reduce(
    (sum, read) =>
      sum +
      read.readPartitionScopes.reduce((inner, occurrence) => {
        readScopeStatusCounts[occurrence.scope.status] += 1;
        return inner + 1;
      }, 0),
    0,
  );
  const scheduleTaskIds = new Set(scheduleParents.keys());
  const readOccurrenceDecisions = readOccurrenceMatchGroups
    .map((group) => decideReadOccurrenceProducers(group, scheduleTaskIds))
    .sort((left, right) => compareText(left.occurrenceId, right.occurrenceId));
  const useOccurrenceDecisions = readOccurrenceDecisions.length > 0;
  const usableDataOnlyTaskIds = new Set(
    [...partitionAwareTaskStatuses]
      .filter(([, status]) => status !== "UNKNOWN")
      .map(([taskId]) => taskId),
  );
  const scheduledTableKeys = new Set(
    parents
      .flatMap((parent) =>
        parent.confirmedWrites.map((write) => tableIdentityKey(write.table)),
      )
      .filter((key): key is string => key !== null),
  );
  for (const parent of parents) {
    if (!parent.taskName) continue;
    const separator = parent.taskName.indexOf(".");
    if (separator <= 0 || separator === parent.taskName.length - 1) continue;
    const schema = parent.taskName.slice(0, separator).trim();
    const tableName = parent.taskName
      .slice(separator + 1)
      .trim()
      .replace(/_TIT\d+(?:_H\d+)?$/i, "");
    if (!schema || !tableName) continue;
    const taskNameTable = resolveCatalogTable(
      catalog,
      `${schema}.${tableName}`,
    ).table;
    const tableKey = tableIdentityKey(taskNameTable);
    if (tableKey) scheduledTableKeys.add(tableKey);
  }
  const dataTaskTableKeys = new Map<string, Set<string>>();
  for (const producer of confirmedProducers) {
    const tableKey = tableIdentityKey(producer.table);
    if (!tableKey) continue;
    const taskTables =
      dataTaskTableKeys.get(producer.taskId) ?? new Set<string>();
    taskTables.add(tableKey);
    dataTaskTableKeys.set(producer.taskId, taskTables);
  }
  const primaryIntersection = [...usableDataOnlyTaskIds].filter((taskId) =>
    scheduleTaskIds.has(taskId),
  );
  const overlappingUnknownTaskIds = useOccurrenceDecisions
    ? new Set(
        readOccurrenceDecisions
          .filter(
            (decision) =>
              decision.decision === "MULTIPLE_OVERLAPPING_PRODUCERS",
          )
          .flatMap((decision) => decision.unknown),
      )
    : overlappingOverwriteTaskIds(confirmedProducers, scheduleTaskIds);
  const unknownTaskIds = new Set(
    useOccurrenceDecisions
      ? readOccurrenceDecisions.flatMap((decision) => decision.unknown)
      : [...partitionAwareTaskStatuses]
          .filter(([, status]) => status === "UNKNOWN")
          .map(([taskId]) => taskId),
  );
  for (const taskId of overlappingUnknownTaskIds) unknownTaskIds.add(taskId);
  const occurrenceScheduledPrimary = uniqueSorted(
    readOccurrenceDecisions
      .filter(
        (decision) => decision.decision === "SCHEDULE_DATA_INTERSECTION",
      )
      .flatMap((decision) => decision.primary),
  );
  const occurrenceDataFallback = uniqueSorted(
    readOccurrenceDecisions
      .filter((decision) => decision.decision === "DATA_FALLBACK")
      .flatMap((decision) => decision.primary),
  );
  const primaryTaskIds = (useOccurrenceDecisions
    ? occurrenceScheduledPrimary.length > 0
      ? occurrenceScheduledPrimary
      : occurrenceDataFallback
    : primaryIntersection
  ).filter((taskId) => !unknownTaskIds.has(taskId));
  const additionalDataTaskIds = useOccurrenceDecisions
    ? occurrenceScheduledPrimary.length > 0
      ? occurrenceDataFallback.filter(
          (taskId) =>
            !unknownTaskIds.has(taskId) && !primaryTaskIds.includes(taskId),
        )
      : []
    : [...usableDataOnlyTaskIds].filter((taskId) => {
        if (unknownTaskIds.has(taskId) || primaryTaskIds.includes(taskId))
          return false;
        const taskTables = dataTaskTableKeys.get(taskId);
        if (!taskTables || taskTables.size === 0) return true;
        return ![...taskTables].some((tableKey) =>
          scheduledTableKeys.has(tableKey),
        );
      });
  for (const taskId of [...primaryTaskIds, ...additionalDataTaskIds])
    unknownTaskIds.delete(taskId);
  const scheduleFallbackTaskIds = [...scheduleTaskIds].filter(
    (taskId) => !unknownTaskIds.has(taskId),
  );
  const hasOverlappingUnknown = overlappingUnknownTaskIds.size > 0;
  const finalUpstreamTaskIds =
    primaryTaskIds.length > 0
      ? {
          primary: uniqueSorted(primaryTaskIds),
          additional: uniqueSorted(additionalDataTaskIds),
          unknown: uniqueSorted([...unknownTaskIds]),
          decision: hasOverlappingUnknown
            ? ("MULTIPLE_OVERLAPPING_PRODUCERS" as const)
            : useOccurrenceDecisions && occurrenceScheduledPrimary.length === 0
              ? ("DATA_FALLBACK" as const)
              : ("SCHEDULE_DATA_INTERSECTION" as const),
        }
      : usableDataOnlyTaskIds.size > 0
        ? {
            primary: uniqueSorted(
              [...usableDataOnlyTaskIds].filter(
                (taskId) => !unknownTaskIds.has(taskId),
              ),
            ),
            additional: [],
            unknown: uniqueSorted([...unknownTaskIds]),
            decision: hasOverlappingUnknown
              ? ("MULTIPLE_OVERLAPPING_PRODUCERS" as const)
              : ("DATA_FALLBACK" as const),
          }
        : {
            primary: uniqueSorted(scheduleFallbackTaskIds),
            additional: [],
            unknown: uniqueSorted([...unknownTaskIds]),
            decision: hasOverlappingUnknown
              ? ("MULTIPLE_OVERLAPPING_PRODUCERS" as const)
              : ("SCHEDULE_FALLBACK" as const),
          };

  const confirmedTableKeys = new Set(
    confirmedProducers
      .map((item) => tableIdentityKey(item.table))
      .filter((key): key is string => key !== null),
  );
  const nonConfirmedTableKeys = new Set(
    (lookup
      ? relatedNonConfirmedRelations.map((item) =>
          tableIdentityKey(item.tableRef),
        )
      : reconciliation
          .filter((item) => item.status === "UNRESOLVED")
          .map((item) => tableIdentityKey(item.table))
    ).filter((key): key is string => key !== null),
  );
  const resolvedDirectReadKeys = directReads
    .map((item) => tableIdentityKey(item.table))
    .filter((key): key is string => key !== null);
  const directReadsWithConfirmed = resolvedDirectReadKeys.filter((key) =>
    confirmedTableKeys.has(key),
  ).length;
  const directReadsWithNonConfirmedOnly = resolvedDirectReadKeys.filter(
    (key) => !confirmedTableKeys.has(key) && nonConfirmedTableKeys.has(key),
  ).length;

  const sqlOnlyTableKeys = new Set(
    reconciliation
      .filter((item) => item.status === "SQL_ONLY")
      .map((item) => tableIdentityKey(item.table))
      .filter((key): key is string => key !== null),
  );
  const unresolvedTableKeys = new Set(
    reconciliation
      .filter((item) => item.status === "UNRESOLVED")
      .map((item) => tableIdentityKey(item.table))
      .filter((key): key is string => key !== null),
  );

  const producerWriteObservationCount = lookup
    ? confirmedProducers.reduce((sum, item) => sum + item.writes.length, 0)
    : parents.reduce((sum, parent) => sum + parent.confirmedWrites.length, 0);
  const producerEdgeObservationCount = lookup
    ? confirmedProducers.length
    : parents.reduce((sum, parent) => sum + parent.confirmedWrites.length, 0);
  const nonConfirmedObservationCount = lookup
    ? relatedNonConfirmedRelations.length
    : reconciliation.filter((item) => item.status === "UNRESOLVED").length;
  const directionConfirmedCount = lookup
    ? producerWriteObservationCount +
      relatedNonConfirmedRelations.filter(
        (item) => item.directionStatus === "WRITE_CONFIRMED",
      ).length
    : producerWriteObservationCount;
  const directionUnknownCount = lookup
    ? relatedNonConfirmedRelations.filter(
        (item) => item.directionStatus === "UNKNOWN",
      ).length
    : nonConfirmedObservationCount;
  const identityResolvedCount = lookup
    ? producerWriteObservationCount +
      relatedNonConfirmedRelations.filter(
        (item) => tableIdentityKey(item.tableRef) !== null,
      ).length
    : parents.reduce(
        (sum, parent) =>
          sum +
          parent.confirmedWrites.filter(
            (write) => tableIdentityKey(write.table) !== null,
          ).length,
        0,
      ) +
      reconciliation.filter(
        (item) =>
          item.status === "UNRESOLVED" && tableIdentityKey(item.table) !== null,
      ).length;
  const identityUnresolvedCount =
    producerWriteObservationCount +
    nonConfirmedObservationCount -
    identityResolvedCount;

  const coverage: OneHopCoverage = {
    semantics: "OBSERVED_EVIDENCE_ONLY",
    directReadTables: {
      total: directReads.length,
      identityResolved: resolvedDirectReadKeys.length,
      identityUnresolved: directReads.length - resolvedDirectReadKeys.length,
      withConfirmedProducer: directReadsWithConfirmed,
      withNonConfirmedOnly: directReadsWithNonConfirmedOnly,
      withNoProducerObservation:
        resolvedDirectReadKeys.length -
        directReadsWithConfirmed -
        directReadsWithNonConfirmedOnly,
    },
    scheduleParents: {
      total: parents.length,
      taskPackAvailable: parents.filter(
        (item) => item.inputPackStatus === "AVAILABLE",
      ).length,
      taskPackMissing: parents.filter(
        (item) => item.inputPackStatus === "MISSING",
      ).length,
      taskPackAmbiguous: parents.filter(
        (item) => item.inputPackStatus === "AMBIGUOUS",
      ).length,
      taskPackInvalid: parents.filter(
        (item) => item.inputPackStatus === "INVALID",
      ).length,
      withConfirmedWrite: parents.filter(
        (item) => item.confirmedWrites.length > 0,
      ).length,
      withNonConfirmedOnly: parents.filter(
        (item) =>
          item.confirmedWrites.length === 0 &&
          item.unconfirmedTargets.length > 0,
      ).length,
      withNoWriteObservation: parents.filter(
        (item) =>
          item.confirmedWrites.length === 0 &&
          item.unconfirmedTargets.length === 0,
      ).length,
    },
    producerEvidenceObservations: {
      confirmedProducerEdges: producerEdgeObservationCount,
      confirmedWriteObservations: producerWriteObservationCount,
      nonConfirmedRelationObservations: nonConfirmedObservationCount,
      directionConfirmed: directionConfirmedCount,
      directionUnknown: directionUnknownCount,
      identityResolved: identityResolvedCount,
      identityUnresolved: identityUnresolvedCount,
    },
    retrieval: {
      producerIndex: producerIndexStatus,
      liveTaskSourceAttempts,
      liveTaskSourceSuccesses,
      liveTaskSourceFailures,
    },
    overlaps: {
      sqlOnlyAndUnresolvedTables: intersectionSize(
        sqlOnlyTableKeys,
        unresolvedTableKeys,
      ),
      confirmedAndNonConfirmedTables: intersectionSize(
        confirmedTableKeys,
        nonConfirmedTableKeys,
      ),
    },
    partitionScopes: {
      readOccurrences: readPartitionOccurrenceCount,
      statusCounts: readScopeStatusCounts,
      producerMatchCounts: partitionMatchCounts,
      provenTaskIds: [...partitionAwareTaskStatuses.values()].filter(
        (status) => status === "PROVEN_OVERLAP",
      ).length,
      possibleTaskIds: [...partitionAwareTaskStatuses.values()].filter(
        (status) => status === "POSSIBLE_OVERLAP",
      ).length,
      unknownTaskIds: [...partitionAwareTaskStatuses.values()].filter(
        (status) => status === "UNKNOWN",
      ).length,
      multiProducerTables: [...producersByTable.values()].filter(
        (count) => count > 1,
      ).length,
    },
  };

  const count = (status: ReconciliationStatus): number =>
    reconciliation.filter((item) => item.status === status).length;
  const issues = [
    ...catalog.issues,
    ...parents.flatMap((parent) => parent.issues),
  ].sort(compareText);
  const issueDetails = issueDetailsForOneHop(catalog, parents);

  return {
    schemaVersion: "1.1.0",
    taskId,
    generatedAt: now(),
    currentTask: {
      inputPackPath: currentPack.taskPath,
      inputPackContentHash: String(currentPack.document.contentHash),
      directReads,
    },
    schedule: {
      direction: "UPSTREAM",
      depth: 1,
      parents: orderedScheduleParents,
      evidence: [scheduleEvidence],
    },
    parents,
    reconciliation,
    counts: {
      sqlDirectReads: directReads.length,
      scheduleParents: scheduleParents.size,
      matched: count("MATCHED"),
      sqlOnly: count("SQL_ONLY"),
      scheduleOnly: count("SCHEDULE_ONLY"),
      unresolved: count("UNRESOLVED"),
    },
    countSemantics: {
      reconciliationStatusUnit: "RECONCILIATION_ITEM",
      sqlDirectReadsUnit: "NORMALIZED_DIRECT_READ_REFERENCE",
      scheduleParentsUnit: "DISTINCT_TASK",
      statusesExclusivePerItem: true,
      statusesExclusivePerPhysicalTable: false,
    },
    producerIndex: {
      status: producerIndexStatus,
      contentHash: lookupMeta?.contentHash ?? null,
      inputFingerprint:
        lookup?.kind === "legacyIndex"
          ? lookup.index.inputFingerprint
          : (options.trustedInputFingerprint ??
            preparedContext.inputFingerprint ??
            lookupMeta?.contentHash ??
            null),
    },
    dataPath: {
      source: lookup
        ? "PRODUCER_INDEX"
        : "LEGACY_SCHEDULE_RECONCILIATION",
      confirmedProducers,
      readOccurrenceDecisions,
      nonConfirmedRelations: relatedNonConfirmedRelations,
    },
    coverage,
    nextScheduleTaskIds: uniqueSorted([...scheduleParents.keys()]),
    nextDataTaskIds: lookup
      ? uniqueSorted(confirmedProducers.map((item) => item.taskId))
      : uniqueSorted(
          reconciliation
            .filter((item) => item.status === "MATCHED" && item.taskId)
            .map((item) => item.taskId!),
        ),
    partitionAwareNextDataTaskIds: {
      candidates: uniqueSorted([...partitionAwareTaskStatuses.keys()]),
      proven: uniqueSorted(
        [...partitionAwareTaskStatuses]
          .filter(([, status]) => status === "PROVEN_OVERLAP")
          .map(([taskId]) => taskId),
      ),
      possible: uniqueSorted(
        [...partitionAwareTaskStatuses]
          .filter(([, status]) => status === "POSSIBLE_OVERLAP")
          .map(([taskId]) => taskId),
      ),
      unknown: uniqueSorted(
        [...partitionAwareTaskStatuses]
          .filter(([, status]) => status === "UNKNOWN")
          .map(([taskId]) => taskId),
      ),
    },
    finalUpstreamTaskIds,
    issues,
    issueDetails,
    boundaries: {
      staticSqlOnly: true,
      readPartitionScope: "STATIC_SQL_PREDICATE",
      schedulerExecution: "NOT_EVALUATED",
      runtimeDelivery: "NOT_EVALUATED",
      businessCorrectness: "NOT_EVALUATED",
      producerCandidatesAreWrites: false,
      partitionScope: "TASK_TO_TABLE_WRITE",
    },
  };
}

export function reconcileOneHop(
  taskId: string,
  options: ReconcileOneHopOptions,
): OneHopReconciliationResult {
  const preparedContext = prepareOneHopContext(options.dataRoot, {
    trustedInputFingerprint: options.trustedInputFingerprint,
    includeFingerprint:
      options.producerIndex !== undefined &&
      options.writerCatalog === undefined &&
      options.verifyInputFingerprint === true &&
      options.trustedInputFingerprint === undefined,
  });
  return reconcileOneHopInternal(taskId, options, preparedContext);
}

/** Reuse a catalog/fingerprint prepared for a bounded batch caller. */
export function reconcileOneHopWithPreparedContext(
  taskId: string,
  options: ReconcileOneHopOptions,
  preparedContext: ReturnType<typeof prepareOneHopContext>,
): OneHopReconciliationResult {
  return reconcileOneHopInternal(taskId, options, preparedContext);
}

export function summarizeOneHop(
  result: OneHopReconciliationResult,
): OneHopSummary {
  const toSummaryProducer = (producer: DataPathConfirmedProducer) => {
    const partitions = new Map<string, readonly PartitionAssignment[]>();
    for (const write of producer.partitionMatch.writes) {
      const partition = [...write.partition].sort((left, right) =>
        compareText(
          `${left.field}|${left.expression}|${left.observedValue ?? ""}|${left.valueStatus}`,
          `${right.field}|${right.expression}|${right.observedValue ?? ""}|${right.valueStatus}`,
        ),
      );
      partitions.set(JSON.stringify(partition), partition);
    }
    return {
      taskId: producer.taskId,
      table: producer.table.qualifiedName,
      scheduleRelation: producer.scheduleRelation,
      partitionMatch: {
        status: producer.partitionMatch.status,
        reasonCodes: producer.partitionMatch.reasonCodes,
        partitions: [...partitions.entries()]
          .sort(([left], [right]) => compareText(left, right))
          .map(([, partition]) => partition),
      },
    };
  };
  const excludedProducers = result.dataPath.confirmedProducers.filter(
    (producer) => producer.partitionMatch.status === "PROVEN_DISJOINT",
  );
  const confirmedProducers = result.dataPath.confirmedProducers.filter(
    (producer) => producer.partitionMatch.status !== "PROVEN_DISJOINT",
  );
  return {
    schemaVersion: "1.1.0",
    artifactType: "ONE_HOP_RECONCILIATION_SUMMARY",
    taskId: result.taskId,
    generatedAt: result.generatedAt,
    directReadTables: [
      ...new Set(
        result.currentTask.directReads.map((read) => read.table.qualifiedName),
      ),
    ].sort((left, right) => compareText(left ?? "", right ?? "")),
    scheduleParentTaskIds: result.schedule.parents.map(
      (parent) => parent.taskId,
    ),
    confirmedProducers: confirmedProducers.map(toSummaryProducer),
    excludedProducers: excludedProducers.map(toSummaryProducer),
    counts: result.counts,
    producerIndex: { status: result.producerIndex.status },
    dataPath: {
      source: result.dataPath.source,
      confirmedProducerCount: confirmedProducers.length,
      excludedProducerCount: excludedProducers.length,
      nonConfirmedRelationCount: result.dataPath.nonConfirmedRelations.length,
    },
    nextScheduleTaskIds: result.nextScheduleTaskIds,
    nextDataTaskIds: result.nextDataTaskIds,
    partitionAwareNextDataTaskIds: result.partitionAwareNextDataTaskIds,
    finalUpstreamTaskIds: result.finalUpstreamTaskIds,
    partitionScopes: result.coverage.partitionScopes,
    issues: result.issues,
    issueDetails: result.issueDetails,
    missingTaskInputPackTaskIds: uniqueSorted(
      result.issueDetails
        .filter(
          (detail) =>
            detail.code === "TASK_INPUT_PACK_MISSING" && detail.taskId,
        )
        .map((detail) => detail.taskId!),
    ),
  };
}

export function summaryPathFromOutput(outputPath: string): string {
  const extension = extname(outputPath);
  return extension
    ? `${outputPath.slice(0, -extension.length)}.summary${extension}`
    : `${outputPath}.summary.json`;
}

export function reconcileOneHopBatch(
  taskIds: readonly string[],
  options: ReconcileOneHopOptions,
): readonly OneHopReconciliationResult[] {
  const preparedContext = prepareOneHopContext(options.dataRoot, {
    trustedInputFingerprint: options.trustedInputFingerprint,
    includeFingerprint:
      options.producerIndex !== undefined &&
      options.writerCatalog === undefined &&
      options.verifyInputFingerprint === true &&
      options.trustedInputFingerprint === undefined,
  });
  const results = taskIds.map((taskId) =>
    reconcileOneHopInternal(taskId, options, preparedContext),
  );
  if (
    options.trustedInputFingerprint === undefined &&
    preparedContext.inputFingerprint !== null &&
    fingerprintTableProducerInputs(options.dataRoot) !==
      preparedContext.inputFingerprint
  )
    throw new Error("INPUT_CHANGED_DURING_ONE_HOP_BATCH");
  return results;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export function producerIndexPathFromArgs(
  args: readonly string[],
): string | undefined {
  if (!args.includes("--producer-index")) return undefined;
  const path = option(args, "--producer-index");
  if (!path) throw new Error("PRODUCER_INDEX_PATH_REQUIRED");
  return path;
}

function main(): void {
  const args = process.argv.slice(2);
  const taskId =
    option(args, "--task-id") ??
    (args[0] && !args[0].startsWith("--") ? args[0] : undefined);
  const dataRoot =
    option(args, "--data-root") ?? process.env.SQL_LINEAGE_DATA_ROOT;
  const output = option(args, "--output");
  const summaryOutput = option(args, "--summary-output");
  const terminalTableConfigPath =
    option(args, "--terminal-table-config") ??
    DEFAULT_TERMINAL_TABLE_CONFIG_PATH;
  const producerIndexPath = producerIndexPathFromArgs(args);
  const writerCatalogPath = option(args, "--writer-catalog");
  const verifyInputFingerprint = args.includes("--verify-input-fingerprint");
  if (!taskId || !dataRoot)
    throw new Error(
      "usage: npm run addon:task-lineage:one-hop -- --task-id <id> --data-root <input-pack-root> [--writer-catalog <catalog.sqlite>] [--producer-index <index.json>] [--terminal-table-config <path>] [--verify-input-fingerprint] [--output <json>] [--summary-output <summary.json>]",
    );
  const catalogApi = createRequire(import.meta.url)(
    "../../../../../query/writer-catalog.ts",
  ) as typeof import("../../../../../query/writer-catalog.ts");
  const catalogPath =
    writerCatalogPath ??
    (producerIndexPath && !isLegacyProducerIndexPath(producerIndexPath)
      ? producerIndexPath
      : undefined) ??
    (existsSync(catalogApi.defaultWriterCatalogPath(dataRoot))
      ? catalogApi.defaultWriterCatalogPath(dataRoot)
      : undefined);
  const producerIndex =
    producerIndexPath && isLegacyProducerIndexPath(producerIndexPath)
      ? loadTableProducerIndex(producerIndexPath)
      : undefined;
  const writerCatalog = catalogPath
    ? catalogApi.openWriterCatalog(catalogPath)
    : undefined;
  const result = reconcileOneHop(taskId, {
    dataRoot,
    producerIndex,
    writerCatalog,
    verifyInputFingerprint,
    terminalTableConfig: loadTerminalTableConfig(
      resolve(terminalTableConfigPath),
    ),
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const summary = `${JSON.stringify(summarizeOneHop(result), null, 2)}\n`;
  let outputPath: string | null = null;
  let summaryPath: string | null = null;
  if (output) {
    outputPath = isAbsolute(output) ? output : resolve(output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized, "utf8");
  }
  if (summaryOutput || outputPath) {
    summaryPath = summaryOutput
      ? isAbsolute(summaryOutput)
        ? summaryOutput
        : resolve(summaryOutput)
      : summaryPathFromOutput(outputPath!);
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, summary, "utf8");
  }
  if (outputPath || summaryPath)
    process.stdout.write(
      `${JSON.stringify({ output: outputPath, summaryOutput: summaryPath, taskId, counts: result.counts, nextScheduleTaskIds: result.nextScheduleTaskIds, nextDataTaskIds: result.nextDataTaskIds, partitionAwareNextDataTaskIds: result.partitionAwareNextDataTaskIds, finalUpstreamTaskIds: result.finalUpstreamTaskIds })}\n`,
    );
  else process.stdout.write(serialized);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  main();
