import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { SqlSession, type Dialect } from "sqllens";
import {
  sha256Bytes,
  sha256File,
  validateTableDocument,
  validateTaskDocument,
  type TableDocument,
  type TaskDocument,
} from "../../../../../input/shared/input-pack.ts";
import { buildPlanFacts } from "../../../../../plans/plan-adapter.ts";
import { taskSqlDialect } from "../../../../../plans/task-sql-dialect.ts";
import {
  inferTaskDefaultSchema,
  qualifyBareTableName,
} from "../../../../../reconcile/shared/task-default-schema.ts";

type JsonRecord = Record<string, unknown>;

export type TaskInputPackStatus =
  | "TASK_INPUT_PACK_MISSING"
  | "TASK_INPUT_PACK_INVALID"
  | "TASK_INPUT_PACK_AMBIGUOUS"
  | "TASK_INPUT_PACK_AVAILABLE";

export type TaskReadBlockReason =
  "SQL_PARSE_FAILED" | "PARSER_TOPOLOGY_UNKNOWN" | "TABLE_IDENTITY_UNRESOLVED";

export interface TaskReadTableRef {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string;
  readonly identityStatus: "RESOLVED" | "QUALIFIED_NAME_ONLY" | "AMBIGUOUS";
}

export interface TaskReadEvidence {
  readonly source:
    "INPUT_PACK_TASK" | "INPUT_PACK_SQL" | "TABLE_PACK" | "SQL_PARSE";
  readonly provider: string;
  readonly locator: string;
  readonly observedAt: null;
  readonly sha256?: string;
  readonly contentHash?: string;
  readonly detail?: JsonRecord;
}

export interface TaskReadStatementRef {
  readonly slot: string;
  readonly statementIndex: number;
  readonly recursionStatus: "ELIGIBLE" | "BLOCKED";
  readonly blockReason: TaskReadBlockReason | null;
  readonly evidence: readonly TaskReadEvidence[];
}

export interface TaskReadStatementCoordinate {
  readonly slot: string;
  readonly statementIndex: number;
}

export interface TaskDirectReadObservation {
  readonly tableRef: TaskReadTableRef;
  readonly resolutionStatus: "RESOLVED" | "NON_RESOLVED";
  readonly recursionStatus: "ELIGIBLE" | "BLOCKED";
  readonly blockReason: TaskReadBlockReason | null;
  readonly blockReasons: readonly TaskReadBlockReason[];
  readonly statementIndexes: readonly number[];
  readonly eligibleStatementIndexes: readonly number[];
  readonly blockedStatementIndexes: readonly number[];
  readonly eligibleStatementRefs: readonly TaskReadStatementCoordinate[];
  readonly blockedStatementRefs: readonly TaskReadStatementCoordinate[];
  readonly statements: readonly TaskReadStatementRef[];
  readonly evidence: readonly TaskReadEvidence[];
}

export interface TaskReadStatementIssue {
  readonly code: "SQL_PARSE_FAILED" | "PARSER_TOPOLOGY_UNKNOWN";
  readonly slot: string;
  readonly statementIndex: number;
  readonly locator: string;
  readonly detail: JsonRecord;
}

export interface TaskReadResult {
  readonly taskId: string;
  readonly status: TaskInputPackStatus;
  readonly taskCategory: string | null;
  readonly taskContentHash: string | null;
  readonly directReads: readonly TaskDirectReadObservation[];
  readonly resolvedDirectReads: readonly TaskDirectReadObservation[];
  readonly nonResolvedDirectReads: readonly TaskDirectReadObservation[];
  readonly statementIssues: readonly TaskReadStatementIssue[];
  readonly evidence: readonly TaskReadEvidence[];
  readonly issues: readonly string[];
}

export interface TaskReadEvidenceRepository {
  readonly dataRoot: string;
  readonly treeFingerprint: string;
  readonly taskIds: readonly string[];
  readonly counts: {
    readonly taskPacksDiscovered: number;
    readonly validTaskPacks: number;
    readonly invalidTaskPacks: number;
    readonly ambiguousTaskIds: number;
    readonly tablePacksDiscovered: number;
    readonly validTablePacks: number;
    readonly invalidTablePacks: number;
  };
  readonly issues: readonly string[];
  readonly getTaskReads: (taskId: string) => TaskReadResult;
  readonly diagnostics: () => {
    readonly taskPacksLoaded: number;
    readonly sqlFilesLoaded: number;
    readonly cachedTaskReadResults: number;
  };
}

export interface BuildTaskReadEvidenceRepositoryOptions {
  /**
   * LAZY validates Task Pack metadata during discovery, but defers SQL file I/O
   * and validation until getTaskReads visits that Task. The default EAGER mode
   * preserves the standalone repository's full-catalog validation contract.
   */
  readonly taskLoading?: "EAGER" | "LAZY";
  /** Defer DDL file hashing when a verified producer-index snapshot covers it. */
  readonly tableLoading?: "EAGER" | "METADATA_ONLY";
  /** A fingerprint already verified by the caller against the same snapshot. */
  readonly trustedTreeFingerprint?: string;
}

interface LoadedSqlFile {
  readonly slot: string;
  readonly relativePath: string;
  readonly locator: string;
  readonly sha256: string;
  readonly evidenceProvider: string;
  readonly content: string;
}

interface LoadedTaskPack {
  readonly status: "AVAILABLE" | "INVALID";
  readonly taskId: string;
  readonly taskCategory: string | null;
  readonly taskPath: string;
  readonly document: (TaskDocument & JsonRecord) | null;
  readonly sqlFiles: readonly LoadedSqlFile[];
  readonly issue: string | null;
  readonly evidence: TaskReadEvidence;
}

interface LoadedTablePack {
  readonly status: "AVAILABLE" | "INVALID";
  readonly tablePath: string;
  readonly table: TaskReadTableRef | null;
  readonly evidence: TaskReadEvidence;
  readonly issue: string | null;
}

interface TableCatalog {
  readonly byQualifiedName: ReadonlyMap<string, readonly LoadedTablePack[]>;
}

interface ResolvedReadTable {
  readonly tableRef: TaskReadTableRef;
  readonly evidence: readonly TaskReadEvidence[];
}

interface ReadBuilder {
  readonly tableRef: TaskReadTableRef;
  readonly tableEvidence: readonly TaskReadEvidence[];
  readonly statements: TaskReadStatementRef[];
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTable(value: string): string {
  return value.replaceAll("`", "").replaceAll('"', "").trim().toLowerCase();
}

function relativeLocator(dataRoot: string, path: string): string {
  return relative(dataRoot, path).replaceAll("\\", "/");
}

function isWithin(root: string, path: string): boolean {
  const relation = relative(resolve(root), resolve(path));
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function discoverNamedFiles(root: string, name: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => compareText(left.name, right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === name) result.push(path);
    }
  };
  visit(root);
  return result.sort((left, right) => compareText(left, right));
}

function fingerprintInputTree(dataRoot: string): string {
  const files: { path: string; sha256: string }[] = [];
  const visit = (root: string): void => {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true }).sort(
      (left, right) => compareText(left.name, right.name),
    )) {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files.push({
          path: relativeLocator(dataRoot, path),
          sha256: sha256File(path),
        });
    }
  };
  visit(join(dataRoot, "tasks"));
  visit(join(dataRoot, "tables"));
  files.sort((left, right) => compareText(left.path, right.path));
  return sha256Bytes(Buffer.from(JSON.stringify(files), "utf8"));
}

function taskPackEvidence(
  dataRoot: string,
  taskPath: string,
  document: (TaskDocument & JsonRecord) | null,
): TaskReadEvidence {
  return {
    source: "INPUT_PACK_TASK",
    provider: stringValue(document?.evidenceProvider) ?? "input-pack:task",
    locator: relativeLocator(dataRoot, taskPath),
    observedAt: null,
    ...(document ? { contentHash: String(document.contentHash) } : {}),
    ...(!document && existsSync(taskPath)
      ? { sha256: sha256File(taskPath) }
      : {}),
  };
}

function loadTaskPack(
  dataRoot: string,
  taskPath: string,
  loadSqlContent = true,
): LoadedTaskPack {
  const directoryTaskId = basename(dirname(taskPath));
  const directoryCategory = basename(dirname(dirname(taskPath)));
  try {
    const segments = relativeLocator(dataRoot, taskPath).split("/");
    if (
      segments.length !== 4 ||
      segments[0] !== "tasks" ||
      segments[1] !== directoryCategory ||
      segments[2] !== directoryTaskId
    )
      throw new Error("TASK_PACK_PATH_INVALID");
    const raw = JSON.parse(readFileSync(taskPath, "utf8")) as unknown;
    validateTaskDocument(raw);
    const document = raw as TaskDocument & JsonRecord;
    if (document.taskId !== directoryTaskId)
      throw new Error("TASK_ID_MISMATCH");
    if (document.taskCategory !== directoryCategory)
      throw new Error("TASK_CATEGORY_MISMATCH");
    const sqlFiles: LoadedSqlFile[] = [];
    for (const rawFile of document.sqlFiles) {
      const file = asRecord(rawFile);
      if (!file) throw new Error("SQL_FILE_ENTRY_INVALID");
      const slot = String(file.slot);
      const relativePath = String(file.path);
      const absolutePath = resolve(dirname(taskPath), relativePath);
      if (!isWithin(dirname(taskPath), absolutePath))
        throw new Error("SQL_FILE_PATH_ESCAPE");
      if (!loadSqlContent) continue;
      if (!existsSync(absolutePath))
        throw new Error(`SQL_FILE_MISSING:${slot}`);
      if (
        lstatSync(absolutePath).isSymbolicLink() ||
        !isWithin(realpathSync(dirname(taskPath)), realpathSync(absolutePath))
      )
        throw new Error("SQL_FILE_PATH_ESCAPE");
      const expectedHash = String(file.sha256);
      const sqlBytes = readFileSync(absolutePath);
      if (sha256Bytes(sqlBytes) !== expectedHash)
        throw new Error(`SQL_FILE_HASH_MISMATCH:${slot}`);
      sqlFiles.push({
        slot,
        relativePath,
        locator: relativeLocator(dataRoot, absolutePath),
        sha256: expectedHash,
        evidenceProvider: String(file.evidenceProvider),
        content: sqlBytes.toString("utf8"),
      });
    }
    return {
      status: "AVAILABLE",
      taskId: String(document.taskId),
      taskCategory: String(document.taskCategory),
      taskPath,
      document,
      sqlFiles: sqlFiles.sort((left, right) =>
        compareText(left.slot, right.slot),
      ),
      issue: null,
      evidence: taskPackEvidence(dataRoot, taskPath, document),
    };
  } catch (error) {
    return {
      status: "INVALID",
      taskId: directoryTaskId,
      taskCategory: directoryCategory || null,
      taskPath,
      document: null,
      sqlFiles: [],
      issue: safeMessage(error),
      evidence: taskPackEvidence(dataRoot, taskPath, null),
    };
  }
}

function deferTaskPack(dataRoot: string, taskPath: string): LoadedTaskPack {
  const taskId = basename(dirname(taskPath));
  const taskCategory = basename(dirname(dirname(taskPath)));
  return {
    status: "AVAILABLE",
    taskId,
    taskCategory: taskCategory || null,
    taskPath,
    document: null,
    sqlFiles: [],
    issue: null,
    evidence: {
      source: "INPUT_PACK_TASK",
      provider: "input-pack:task",
      locator: relativeLocator(dataRoot, taskPath),
      observedAt: null,
    },
  };
}

function tablePackEvidence(
  dataRoot: string,
  tablePath: string,
  document: (TableDocument & JsonRecord) | null,
): TaskReadEvidence {
  return {
    source: "TABLE_PACK",
    provider: stringValue(document?.evidenceProvider) ?? "input-pack:table",
    locator: relativeLocator(dataRoot, tablePath),
    observedAt: null,
    ...(document ? { contentHash: String(document.contentHash) } : {}),
    ...(!document && existsSync(tablePath)
      ? { sha256: sha256File(tablePath) }
      : {}),
  };
}

function loadTablePack(
  dataRoot: string,
  tablePath: string,
  validateDdl = true,
): LoadedTablePack {
  try {
    const segments = relativeLocator(dataRoot, tablePath).split("/");
    if (segments.length !== 4 || segments[0] !== "tables")
      throw new Error("TABLE_PACK_PATH_INVALID");
    const raw = JSON.parse(readFileSync(tablePath, "utf8")) as unknown;
    validateTableDocument(raw);
    const document = raw as TableDocument & JsonRecord;
    const directoryStableId = basename(dirname(tablePath));
    const directoryPlatform = basename(dirname(dirname(tablePath)));
    if (document.stableTableId !== directoryStableId)
      throw new Error("TABLE_STABLE_ID_MISMATCH");
    if (document.platform !== directoryPlatform)
      throw new Error("TABLE_PLATFORM_MISMATCH");
    const ddlFile = asRecord(document.ddlFile);
    if (!ddlFile) throw new Error("DDL_FILE_ENTRY_INVALID");
    const ddlPath = resolve(dirname(tablePath), String(ddlFile.path));
    if (!isWithin(dirname(tablePath), ddlPath))
      throw new Error("DDL_FILE_PATH_ESCAPE");
    if (validateDdl) {
      if (!existsSync(ddlPath)) throw new Error("DDL_FILE_MISSING");
      if (
        lstatSync(ddlPath).isSymbolicLink() ||
        !isWithin(realpathSync(dirname(tablePath)), realpathSync(ddlPath))
      )
        throw new Error("DDL_FILE_PATH_ESCAPE");
      const ddlBytes = readFileSync(ddlPath);
      if (sha256Bytes(ddlBytes) !== String(ddlFile.sha256))
        throw new Error("DDL_FILE_HASH_MISMATCH");
    }
    const dataSource = normalizeToken(String(document.dataSource));
    const table: TaskReadTableRef = {
      platform: normalizeToken(String(document.platform)),
      dataSource,
      qualifiedName: normalizeTable(String(document.qualifiedName)),
      identityStatus:
        dataSource === "default" ? "QUALIFIED_NAME_ONLY" : "RESOLVED",
    };
    return {
      status: "AVAILABLE",
      tablePath,
      table,
      evidence: tablePackEvidence(dataRoot, tablePath, document),
      issue: null,
    };
  } catch (error) {
    return {
      status: "INVALID",
      tablePath,
      table: null,
      evidence: tablePackEvidence(dataRoot, tablePath, null),
      issue: safeMessage(error),
    };
  }
}

function buildTableCatalog(packs: readonly LoadedTablePack[]): TableCatalog {
  const byQualifiedName = new Map<string, LoadedTablePack[]>();
  for (const pack of packs) {
    if (pack.status !== "AVAILABLE" || !pack.table) continue;
    const key = pack.table.qualifiedName;
    byQualifiedName.set(key, [...(byQualifiedName.get(key) ?? []), pack]);
  }
  return { byQualifiedName };
}

function resolveReadTable(
  catalog: TableCatalog,
  qualifiedNameInput: string,
): ResolvedReadTable {
  const qualifiedName = normalizeTable(qualifiedNameInput);
  const candidates = catalog.byQualifiedName.get(qualifiedName) ?? [];
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    const table = candidate.table!;
    return { tableRef: table, evidence: [candidate.evidence] };
  }
  return {
    tableRef: {
      platform: null,
      dataSource: null,
      qualifiedName,
      identityStatus:
        candidates.length > 1 ? "AMBIGUOUS" : "QUALIFIED_NAME_ONLY",
    },
    evidence: candidates.map((candidate) => candidate.evidence),
  };
}

function sqlEvidence(file: LoadedSqlFile): TaskReadEvidence {
  return {
    source: "INPUT_PACK_SQL",
    provider: file.evidenceProvider,
    locator: file.locator,
    observedAt: null,
    sha256: file.sha256,
    detail: { slot: file.slot, relativePath: file.relativePath },
  };
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function evidenceKey(evidence: TaskReadEvidence): string {
  return `${evidence.source}\u0000${evidence.locator}\u0000${evidence.sha256 ?? ""}\u0000${evidence.contentHash ?? ""}`;
}

function uniqueEvidence(
  values: readonly TaskReadEvidence[],
): TaskReadEvidence[] {
  const byKey = new Map<string, TaskReadEvidence>();
  for (const evidence of values)
    if (!byKey.has(evidenceKey(evidence)))
      byKey.set(evidenceKey(evidence), evidence);
  return [...byKey.values()].sort((left, right) =>
    compareText(evidenceKey(left), evidenceKey(right)),
  );
}

function blockReasonPriority(reason: TaskReadBlockReason): number {
  if (reason === "SQL_PARSE_FAILED") return 0;
  if (reason === "PARSER_TOPOLOGY_UNKNOWN") return 1;
  return 2;
}

function finalizeRead(builder: ReadBuilder): TaskDirectReadObservation {
  const statements = [...builder.statements].sort((left, right) => {
    const leftLocator = left.evidence[0]?.locator ?? "";
    const rightLocator = right.evidence[0]?.locator ?? "";
    return (
      compareText(left.slot, right.slot) ||
      left.statementIndex - right.statementIndex ||
      compareText(leftLocator, rightLocator)
    );
  });
  const eligible = statements.filter(
    (statement) => statement.recursionStatus === "ELIGIBLE",
  );
  const blocked = statements.filter(
    (statement) => statement.recursionStatus === "BLOCKED",
  );
  const blockReasons = [
    ...new Set(
      blocked
        .map((statement) => statement.blockReason)
        .filter((reason): reason is TaskReadBlockReason => reason !== null),
    ),
  ].sort(
    (left, right) =>
      blockReasonPriority(left) - blockReasonPriority(right) ||
      compareText(left, right),
  );
  const recursionStatus = eligible.length > 0 ? "ELIGIBLE" : "BLOCKED";
  return {
    tableRef: builder.tableRef,
    resolutionStatus:
      builder.tableRef.identityStatus === "RESOLVED"
        ? "RESOLVED"
        : "NON_RESOLVED",
    recursionStatus,
    blockReason:
      recursionStatus === "ELIGIBLE" ? null : (blockReasons[0] ?? null),
    blockReasons,
    statementIndexes: uniqueNumbers(
      statements.map((statement) => statement.statementIndex),
    ),
    eligibleStatementIndexes: uniqueNumbers(
      eligible.map((statement) => statement.statementIndex),
    ),
    blockedStatementIndexes: uniqueNumbers(
      blocked.map((statement) => statement.statementIndex),
    ),
    eligibleStatementRefs: eligible.map((statement) => ({
      slot: statement.slot,
      statementIndex: statement.statementIndex,
    })),
    blockedStatementRefs: blocked.map((statement) => ({
      slot: statement.slot,
      statementIndex: statement.statementIndex,
    })),
    statements,
    evidence: uniqueEvidence([
      ...builder.tableEvidence,
      ...statements.flatMap((statement) => statement.evidence),
    ]),
  };
}

function parseTaskReads(
  pack: LoadedTaskPack & { document: TaskDocument & JsonRecord },
  catalog: TableCatalog,
): TaskReadResult {
  const taskEvidence = pack.evidence;
  const reads = new Map<string, ReadBuilder>();
  const statementIssues: TaskReadStatementIssue[] = [];
  const issues: string[] = [];
  const dialect = taskSqlDialect(String(pack.document.taskCategory)) as Dialect;
  const defaultSchema = inferTaskDefaultSchema(pack.document);

  for (const file of pack.sqlFiles) {
    const inputEvidence = sqlEvidence(file);
    let session: SqlSession;
    try {
      session = SqlSession.create(file.content, dialect);
    } catch (error) {
      const message = safeMessage(error);
      issues.push(`SQL_PARSE_FAILED:${file.locator}:${message}`);
      statementIssues.push({
        code: "SQL_PARSE_FAILED",
        slot: file.slot,
        statementIndex: 0,
        locator: `${file.locator}#statement=0`,
        detail: { sessionCreateFailed: true, message },
      });
      continue;
    }
    for (const [statementIndex, cell] of session.doc.statements.entries()) {
      let physicalInputs: readonly string[] = [];
      let topologyUnknownFields: string[] = [];
      let planFailed = false;
      try {
        const plan = buildPlanFacts(cell, file.content, {
          statement_index: statementIndex,
          dialect,
        });
        physicalInputs = plan.physical_inputs;
        topologyUnknownFields = [
          ...new Set(
            plan.unknowns
              .filter(
                (unknown) =>
                  unknown.field === "body" || unknown.field === "branches",
              )
              .map((unknown) => unknown.field),
          ),
        ].sort(compareText);
      } catch (error) {
        planFailed = true;
        issues.push(
          `SQL_PARSE_FAILED:${file.locator}#statement=${statementIndex}:${safeMessage(error)}`,
        );
      }
      const syntaxFailed = cell.diagnostics.length > 0 || planFailed;
      const statementReason: TaskReadBlockReason | null = syntaxFailed
        ? "SQL_PARSE_FAILED"
        : topologyUnknownFields.length > 0
          ? "PARSER_TOPOLOGY_UNKNOWN"
          : null;
      if (statementReason) {
        const locator = `${file.locator}#statement=${statementIndex}`;
        const detail: JsonRecord =
          statementReason === "SQL_PARSE_FAILED"
            ? { diagnosticCount: cell.diagnostics.length, planFailed }
            : { unknownFields: topologyUnknownFields };
        statementIssues.push({
          code: statementReason,
          slot: file.slot,
          statementIndex,
          locator,
          detail,
        });
      }
      for (const physicalInput of physicalInputs) {
        const qualifiedInput = qualifyBareTableName(
          physicalInput,
          defaultSchema,
        );
        const resolved = resolveReadTable(catalog, qualifiedInput);
        const identityResolved =
          resolved.tableRef.identityStatus === "RESOLVED";
        const blockReason =
          statementReason ??
          (identityResolved ? null : "TABLE_IDENTITY_UNRESOLVED");
        const parseEvidence: TaskReadEvidence = {
          source: "SQL_PARSE",
          provider: "sql-static-lineage:plan-adapter",
          locator: `${file.locator}#statement=${statementIndex}`,
          observedAt: null,
          detail: {
            dialect,
            statementIndex,
            diagnosticCount: cell.diagnostics.length,
            topologyUnknownFields,
            ...(defaultSchema &&
            qualifiedInput !== normalizeTable(physicalInput)
              ? {
                  parsedQualifiedName: normalizeTable(physicalInput),
                  taskDefaultSchema: defaultSchema.schema,
                  taskDefaultSchemaEvidence: defaultSchema.evidenceSources,
                }
              : {}),
          },
        };
        const key = resolved.tableRef.qualifiedName;
        const builder = reads.get(key) ?? {
          tableRef: resolved.tableRef,
          tableEvidence: [taskEvidence, ...resolved.evidence],
          statements: [],
        };
        builder.statements.push({
          slot: file.slot,
          statementIndex,
          recursionStatus: blockReason === null ? "ELIGIBLE" : "BLOCKED",
          blockReason,
          evidence: [inputEvidence, parseEvidence],
        });
        reads.set(key, builder);
      }
    }
  }

  const directReads = [...reads.values()]
    .map(finalizeRead)
    .sort((left, right) =>
      compareText(left.tableRef.qualifiedName, right.tableRef.qualifiedName),
    );
  const resolvedDirectReads = directReads.filter(
    (read) => read.resolutionStatus === "RESOLVED",
  );
  const nonResolvedDirectReads = directReads.filter(
    (read) => read.resolutionStatus === "NON_RESOLVED",
  );
  statementIssues.sort((left, right) =>
    compareText(left.locator, right.locator),
  );
  issues.sort(compareText);
  return {
    taskId: pack.taskId,
    status: "TASK_INPUT_PACK_AVAILABLE",
    taskCategory: pack.taskCategory,
    taskContentHash: String(pack.document.contentHash),
    directReads,
    resolvedDirectReads,
    nonResolvedDirectReads,
    statementIssues,
    evidence: [taskEvidence],
    issues,
  };
}

function unavailableResult(
  taskId: string,
  status: Exclude<TaskInputPackStatus, "TASK_INPUT_PACK_AVAILABLE">,
  packs: readonly LoadedTaskPack[],
  issues: readonly string[],
): TaskReadResult {
  const pack = packs[0];
  return {
    taskId,
    status,
    taskCategory: pack?.taskCategory ?? null,
    taskContentHash:
      packs.length === 1 && pack?.document
        ? String(pack.document.contentHash)
        : null,
    directReads: [],
    resolvedDirectReads: [],
    nonResolvedDirectReads: [],
    statementIssues: [],
    evidence: packs.map((item) => item.evidence),
    issues: [...issues].sort(compareText),
  };
}

export function buildTaskReadEvidenceRepository(
  dataRootInput: string,
  options: BuildTaskReadEvidenceRepositoryOptions = {},
): TaskReadEvidenceRepository {
  const dataRoot = resolve(dataRootInput);
  const taskLoading = options.taskLoading ?? "EAGER";
  const tableLoading = options.tableLoading ?? "EAGER";
  const initialTreeFingerprint =
    options.trustedTreeFingerprint ?? fingerprintInputTree(dataRoot);
  const taskPaths = discoverNamedFiles(join(dataRoot, "tasks"), "task.json");
  const tablePaths = discoverNamedFiles(join(dataRoot, "tables"), "table.json");
  const taskPacks = taskPaths.map((path) =>
    taskLoading === "LAZY" && options.trustedTreeFingerprint
      ? deferTaskPack(dataRoot, path)
      : loadTaskPack(dataRoot, path, taskLoading === "EAGER"),
  );
  const tablePacks = tablePaths.map((path) =>
    loadTablePack(dataRoot, path, tableLoading === "EAGER"),
  );
  const tableCatalog = buildTableCatalog(tablePacks);
  const byTaskId = new Map<string, LoadedTaskPack[]>();
  for (const pack of taskPacks)
    byTaskId.set(pack.taskId, [...(byTaskId.get(pack.taskId) ?? []), pack]);
  const taskIds = [...byTaskId.keys()].sort(compareText);
  const ambiguousTaskIds = taskIds.filter(
    (taskId) => (byTaskId.get(taskId)?.length ?? 0) > 1,
  );
  const issues = [
    ...taskPacks
      .filter((pack) => pack.status === "INVALID")
      .map(
        (pack) =>
          `TASK_PACK_INVALID:${relativeLocator(dataRoot, pack.taskPath)}:${pack.issue ?? "UNKNOWN"}`,
      ),
    ...ambiguousTaskIds.flatMap((taskId) =>
      (byTaskId.get(taskId) ?? []).map(
        (pack) =>
          `TASK_PACK_AMBIGUOUS:${taskId}:${relativeLocator(dataRoot, pack.taskPath)}`,
      ),
    ),
    ...tablePacks
      .filter((pack) => pack.status === "INVALID")
      .map(
        (pack) =>
          `TABLE_PACK_INVALID:${relativeLocator(dataRoot, pack.tablePath)}:${pack.issue ?? "UNKNOWN"}`,
      ),
  ].sort(compareText);
  const cache = new Map<string, TaskReadResult>();
  const diagnostics = {
    taskPacksLoaded: taskLoading === "EAGER" ? taskPacks.length : 0,
    sqlFilesLoaded:
      taskLoading === "EAGER"
        ? taskPacks.reduce((count, pack) => count + pack.sqlFiles.length, 0)
        : 0,
  };
  const finalTreeFingerprint = options.trustedTreeFingerprint
    ? initialTreeFingerprint
    : fingerprintInputTree(dataRoot);
  if (
    options.trustedTreeFingerprint === undefined &&
    finalTreeFingerprint !== initialTreeFingerprint
  )
    throw new Error("INPUT_CHANGED_DURING_TASK_READ_REPOSITORY_BUILD");

  const getTaskReads = (taskId: string): TaskReadResult => {
    if (!SAFE_TASK_ID.test(taskId))
      return unavailableResult(
        taskId,
        "TASK_INPUT_PACK_MISSING",
        [],
        ["INVALID_TASK_ID"],
      );
    const cached = cache.get(taskId);
    if (cached) return cached;
    const discoveredPacks = byTaskId.get(taskId) ?? [];
    const packs =
      taskLoading === "LAZY" && discoveredPacks.length > 0
        ? (() => {
            const loaded = discoveredPacks.map((pack) =>
              loadTaskPack(dataRoot, pack.taskPath, true),
            );
            diagnostics.taskPacksLoaded += loaded.length;
            diagnostics.sqlFilesLoaded += loaded.reduce(
              (count, pack) => count + pack.sqlFiles.length,
              0,
            );
            return loaded;
          })()
        : discoveredPacks;
    let result: TaskReadResult;
    if (packs.length === 0)
      result = unavailableResult(
        taskId,
        "TASK_INPUT_PACK_MISSING",
        [],
        ["TASK_INPUT_PACK_MISSING"],
      );
    else if (packs.length > 1)
      result = unavailableResult(
        taskId,
        "TASK_INPUT_PACK_AMBIGUOUS",
        packs,
        packs.map(
          (pack) => `TASK_INPUT_PACK_AMBIGUOUS:${pack.evidence.locator}`,
        ),
      );
    else if (packs[0]!.status === "INVALID" || !packs[0]!.document)
      result = unavailableResult(taskId, "TASK_INPUT_PACK_INVALID", packs, [
        packs[0]!.issue ?? "TASK_INPUT_PACK_INVALID",
      ]);
    else
      result = parseTaskReads(
        packs[0] as LoadedTaskPack & {
          document: TaskDocument & JsonRecord;
        },
        tableCatalog,
      );
    cache.set(taskId, result);
    return result;
  };

  return {
    dataRoot,
    treeFingerprint: finalTreeFingerprint,
    taskIds,
    counts: {
      taskPacksDiscovered: taskPacks.length,
      validTaskPacks: taskPacks.filter((pack) => pack.status === "AVAILABLE")
        .length,
      invalidTaskPacks: taskPacks.filter((pack) => pack.status === "INVALID")
        .length,
      ambiguousTaskIds: ambiguousTaskIds.length,
      tablePacksDiscovered: tablePacks.length,
      validTablePacks: tablePacks.filter((pack) => pack.status === "AVAILABLE")
        .length,
      invalidTablePacks: tablePacks.filter((pack) => pack.status === "INVALID")
        .length,
    },
    issues,
    getTaskReads,
    diagnostics: () => ({
      ...diagnostics,
      cachedTaskReadResults: cache.size,
    }),
  };
}
