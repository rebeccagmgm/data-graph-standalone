import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
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
import { fileURLToPath } from "node:url";
import {
  canonicalHash,
  canonicalJson,
  sha256File,
  sha256Text,
  isFrozenScheduleStatus,
  isManualScheduleCycle,
  validateTableDocument,
  validateTaskDocument,
  validateTaskCodeEvidence,
  type TaskCodeEvidence,
  type TaskPartitionStatus,
  type JsonValue,
  type TableDocument,
  type TaskDocument,
} from "../../input/shared/input-pack.ts";
import {
  extractSqlWrites,
  partitionValueStatus,
  type PartitionAssignment,
  type SqlWrite,
} from "../../evidence/sql-write-evidence.ts";
import {
  datePartitionValuesCompatible,
  isDatePartitionField,
} from "../../evidence/partition-value-normalizer.ts";
import { findSqlTargetEvidence } from "../../input/shared/sql-target-evidence.ts";

type JsonRecord = Record<string, unknown>;

export interface ProducerTableRef {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string | null;
  readonly identityStatus:
    "RESOLVED" | "QUALIFIED_NAME_ONLY" | "AMBIGUOUS" | "UNKNOWN";
}

export interface ProducerTableIdentity {
  readonly platform: string;
  readonly dataSource: string;
  readonly qualifiedName: string;
}

export interface ProducerEvidence {
  readonly source:
    "INPUT_PACK_TASK" | "INPUT_PACK_SQL" | "TABLE_PACK" | "SQL_PARSE";
  readonly provider: string;
  readonly locator: string;
  readonly observedAt: string | null;
  readonly sha256?: string;
  readonly contentHash?: string;
  readonly detail?: JsonRecord;
}

export type ProducerWriteDirection = "WRITE_CONFIRMED";

export type ProducerOperationClass =
  | "INSERT_OVERWRITE"
  | "INSERT_INTO"
  | "MERGE_INTO"
  | "CTAS"
  | "PLATFORM_TRANSFER"
  | "DELETE"
  | "TRUNCATE"
  | "UNKNOWN";

export type ProducerDataPathRole = "PRODUCER" | "MUTATION_ONLY" | "UNKNOWN";

export interface ProducerWriteSemantics {
  readonly writeDirection: ProducerWriteDirection;
  readonly operationClass: ProducerOperationClass;
  readonly dataPathRole: ProducerDataPathRole;
}

export interface ProducerWriteObservation {
  readonly observationKind: "DIRECT_TARGET" | "SQL_EXPLICIT_WRITE";
  readonly declaredWriteMode: string | null;
  readonly sqlWriteKind: SqlWrite["writeKind"] | null;
  readonly partition: readonly PartitionAssignment[];
  /** Status copied from the collection-time Task Pack partition contract. */
  readonly partitionStatus?: TaskPartitionStatus | "LEGACY_UNKNOWN";
  readonly partitionReasonCodes?: readonly string[];
  /** Scheduler/code configuration evidence; never substituted for partition. */
  readonly scriptEvidence?: TaskCodeEvidence;
  readonly evidence: readonly ProducerEvidence[];
  /** Optional target evidence discriminator for newly built observations. */
  readonly targetEvidenceKind?:
    "DIRECT_PLATFORM_TARGET" | "SQL_EXACT_TABLE_TARGET";
  /** Optional on legacy V1 artifacts; newly built observations include it. */
  readonly writeDirection?: ProducerWriteDirection;
  /** Optional on legacy V1 artifacts; newly built observations include it. */
  readonly operationClass?: ProducerOperationClass;
  /** Optional on legacy V1 artifacts; newly built observations include it. */
  readonly dataPathRole?: ProducerDataPathRole;
}

function normalizedWriteMode(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replaceAll("-", "_");
}

/**
 * Normalizes heterogeneous Task evidence without using task-category names as
 * business rules. A direct platform target is a confirmed write direction,
 * even when the SQL slot is a SELECT; DELETE/TRUNCATE are table mutations but
 * are not data-producing paths.
 */
export function classifyProducerWriteObservation(
  write: Pick<
    ProducerWriteObservation,
    | "observationKind"
    | "declaredWriteMode"
    | "sqlWriteKind"
    | "targetEvidenceKind"
  >,
  context: Readonly<{
    readonly sqlTargetStatementKind?:
      "CREATE_TABLE" | "INSERT_TABLE" | "TRUNCATE_TABLE" | "DELETE_TABLE";
    /** A truncate/replace task can still be a data producer when a query slot supplies rows. */
    readonly hasFieldProducingSql?: boolean;
  }> = {},
): ProducerWriteSemantics {
  if (write.sqlWriteKind !== null)
    return {
      writeDirection: "WRITE_CONFIRMED",
      operationClass: write.sqlWriteKind,
      dataPathRole: "PRODUCER",
    };
  const mode = normalizedWriteMode(write.declaredWriteMode);
  const mutationClass: Readonly<Record<string, "DELETE" | "TRUNCATE">> = {
    delete: "DELETE",
    truncate: "TRUNCATE",
  };
  const mutation = mutationClass[mode];
  if (mutation === "TRUNCATE" && context.hasFieldProducingSql === true)
    return {
      writeDirection: "WRITE_CONFIRMED",
      operationClass: "PLATFORM_TRANSFER",
      dataPathRole: "PRODUCER",
    };
  if (
    mutation === "TRUNCATE" ||
    context.sqlTargetStatementKind === "TRUNCATE_TABLE"
  )
    return {
      writeDirection: "WRITE_CONFIRMED",
      operationClass: "TRUNCATE",
      dataPathRole: "MUTATION_ONLY",
    };
  if (
    mutation === "DELETE" ||
    context.sqlTargetStatementKind === "DELETE_TABLE"
  )
    return {
      writeDirection: "WRITE_CONFIRMED",
      operationClass: "DELETE",
      dataPathRole: "MUTATION_ONLY",
    };
  if (write.targetEvidenceKind === "SQL_EXACT_TABLE_TARGET") {
    if (context.sqlTargetStatementKind === "INSERT_TABLE")
      return {
        writeDirection: "WRITE_CONFIRMED",
        operationClass: "UNKNOWN",
        dataPathRole: "PRODUCER",
      };
    return {
      writeDirection: "WRITE_CONFIRMED",
      operationClass: "UNKNOWN",
      dataPathRole: "UNKNOWN",
    };
  }
  if (write.observationKind === "DIRECT_TARGET")
    if (mode === "" || mode === "append" || mode === "overwrite")
      return {
        writeDirection: "WRITE_CONFIRMED",
        operationClass: "PLATFORM_TRANSFER",
        dataPathRole: "PRODUCER",
      };
  return {
    writeDirection: "WRITE_CONFIRMED",
    operationClass: "UNKNOWN",
    dataPathRole: "UNKNOWN",
  };
}

export interface ConfirmedProducerEdge {
  readonly taskId: string;
  readonly taskCategory: string;
  readonly taskContentHash: string;
  readonly table: ProducerTableIdentity & {
    readonly identityStatus: "RESOLVED";
  };
  readonly writes: readonly ProducerWriteObservation[];
}

export interface NonConfirmedRelation {
  readonly taskId: string;
  readonly taskCategory: string | null;
  readonly taskContentHash: string | null;
  readonly tableRef: ProducerTableRef;
  readonly directionStatus: "WRITE_CONFIRMED" | "UNKNOWN";
  readonly reasonCodes: readonly string[];
  readonly evidence: readonly ProducerEvidence[];
}

export interface TableProducerIndex {
  readonly schemaVersion: "1.1.0" | "1.0.0";
  readonly artifactType: "TABLE_PRODUCER_INDEX";
  readonly generatedAt: string;
  readonly buildStatus: "SUCCESS" | "PARTIAL";
  readonly coverageSemantics: "OBSERVED_EVIDENCE_ONLY";
  readonly inputFingerprint: string;
  readonly confirmedProducerEdges: readonly ConfirmedProducerEdge[];
  readonly nonConfirmedRelations: readonly NonConfirmedRelation[];
  /** Intermediate SQL materializations are retained for audit, not as unresolved producer relations. */
  readonly intermediateMaterializations: readonly NonConfirmedRelation[];
  readonly counts: {
    readonly taskPacksDiscovered: number;
    readonly taskPacksIndexed: number;
    readonly tablePacksDiscovered: number;
    readonly tablePacksIndexed: number;
    readonly confirmedTables: number;
    readonly confirmedProducerEdges: number;
    readonly confirmedWriteObservations: number;
    readonly candidateObservations: number;
    readonly intermediateMaterializations: number;
    readonly invalidTaskPacks: number;
    readonly invalidTablePacks: number;
  };
  readonly issues: readonly string[];
  readonly boundaries: {
    readonly openCli: "NOT_USED";
    readonly partitionScope: "TASK_TO_TABLE_WRITE";
    readonly schedulerExecution: "NOT_EVALUATED";
    readonly runtimeDelivery: "NOT_EVALUATED";
    readonly businessCorrectness: "NOT_EVALUATED";
  };
  readonly contentHash: string;
}

export interface BuildTableProducerIndexOptions {
  readonly now?: () => string;
  /** Test-only escape hatch for append-only concurrent input roots. */
  readonly allowInputChanges?: boolean;
}

/**
 * A sidecar snapshot of the inputs used to build a producer index.  It is
 * deliberately separate from TableProducerIndex so existing consumers keep
 * the V1 artifact contract unchanged.
 */
export interface TableProducerInputManifestPack {
  readonly packType: "TASK" | "TABLE";
  readonly path: string;
  readonly contentHash?: string;
  readonly invalidReason?: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

export interface TableProducerInputManifest {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "TABLE_PRODUCER_INPUT_MANIFEST";
  readonly generatedAt: string;
  readonly generation: number;
  readonly inputFingerprint: string;
  readonly packs: readonly TableProducerInputManifestPack[];
  readonly contentHash: string;
}

export interface TableProducerInputChanges {
  readonly status: "INITIAL" | "UNCHANGED" | "CHANGED";
  readonly changedPacks: readonly string[];
}

export interface UpdateTableProducerIndexOptions {
  readonly now?: () => string;
  readonly allowInputChanges?: boolean;
}

export interface UpdateTableProducerIndexResult {
  readonly index: TableProducerIndex;
  readonly manifest: TableProducerInputManifest;
  readonly changes: TableProducerInputChanges;
  readonly reused: boolean;
}

export interface PinTableProducerIndexOptions {
  readonly now?: () => string;
  readonly allowInputChanges?: boolean;
}

export interface PinTableProducerIndexResult {
  readonly index: TableProducerIndex;
  readonly manifest: TableProducerInputManifest;
  readonly inputFingerprint: string;
  readonly indexPath: string;
  readonly manifestPath: string;
  readonly reused: boolean;
}

export interface LoadOrRebuildTableProducerIndexOptions {
  readonly forceRebuild?: boolean;
  readonly now?: () => string;
  readonly allowInputChanges?: boolean;
}

export interface LoadOrRebuildTableProducerIndexResult {
  readonly index: TableProducerIndex;
  readonly inputFingerprint: string;
  readonly indexPath: string;
  readonly manifestPath: string;
  /** False when an existing fixed-path index was loaded without scanning the Input Pack. */
  readonly rebuilt: boolean;
}

/** Fixed mutable Producer Index directory beside a data root (`<data-root>.producer-index`). */
export function defaultMutableProducerIndexRoot(dataRootInput: string): string {
  return `${resolve(dataRootInput)}.producer-index`;
}

export function mutableProducerIndexPaths(indexRootInput: string): {
  readonly indexPath: string;
  readonly manifestPath: string;
} {
  const indexRoot = resolve(indexRootInput);
  return {
    indexPath: join(indexRoot, "producer-index.json"),
    manifestPath: join(indexRoot, "producer-index.manifest.json"),
  };
}

/**
 * Hot-path Producer Index for expanding Input Packs: load a fixed-path index
 * without fingerprinting the whole tree. Rebuild only when missing/invalid or
 * when the caller forces it after collecting packs. Does not use the
 * fingerprint-keyed pin cache.
 */
export function loadOrRebuildTableProducerIndex(
  dataRootInput: string,
  indexRootInput: string,
  options: LoadOrRebuildTableProducerIndexOptions = {},
): LoadOrRebuildTableProducerIndexResult {
  const dataRoot = resolve(dataRootInput);
  const indexRoot = resolve(indexRootInput);
  assertOutputOutsideDataRoot(dataRoot, indexRoot);
  const { indexPath, manifestPath } = mutableProducerIndexPaths(indexRoot);
  if (!options.forceRebuild && existsSync(indexPath)) {
    try {
      const index = loadTableProducerIndex(indexPath);
      return {
        index,
        inputFingerprint: index.inputFingerprint,
        indexPath,
        manifestPath,
        rebuilt: false,
      };
    } catch {
      // Rebuild below when the on-disk index is unreadable or invalid.
    }
  }
  const index = buildTableProducerIndex(dataRoot, {
    now: options.now,
    allowInputChanges: options.allowInputChanges,
  });
  writeTableProducerIndex(indexPath, index);
  return {
    index,
    inputFingerprint: index.inputFingerprint,
    indexPath,
    manifestPath,
    rebuilt: true,
  };
}

interface LoadedTaskPack {
  readonly status: "AVAILABLE" | "INVALID";
  readonly taskId: string;
  readonly taskCategory: string | null;
  readonly taskPath: string;
  readonly document: (TaskDocument & JsonRecord) | null;
  readonly sqlFiles: readonly LoadedSqlFile[];
  readonly issue: string | null;
}

interface LoadedSqlFile {
  readonly slot: string;
  readonly path: string;
  readonly locator: string;
  readonly absolutePath: string;
  readonly sha256: string;
  readonly evidenceProvider: string;
  readonly content: string;
}

interface LoadedTablePack {
  readonly status: "AVAILABLE" | "INVALID";
  readonly tablePath: string;
  readonly document: (TableDocument & JsonRecord) | null;
  readonly table: ProducerTableIdentity | null;
  readonly evidence: ProducerEvidence;
  readonly issue: string | null;
}

interface TableCatalog {
  readonly validPacks: readonly LoadedTablePack[];
  readonly byIdentity: ReadonlyMap<string, readonly LoadedTablePack[]>;
  readonly byQualifiedName: ReadonlyMap<string, readonly LoadedTablePack[]>;
}

interface DeclaredPartition {
  readonly assignments: readonly PartitionAssignment[];
  readonly status: TaskPartitionStatus | "LEGACY_UNKNOWN";
  readonly reasonCodes: readonly string[];
}

function sqlTargetStatementKindForPack(
  pack: LoadedTaskPack,
):
  | "CREATE_TABLE"
  | "INSERT_TABLE"
  | "TRUNCATE_TABLE"
  | "DELETE_TABLE"
  | undefined {
  const sql = Object.fromEntries(
    pack.sqlFiles.map((file) => [file.slot, file.content]),
  ) as Partial<
    Record<"create" | "query" | "prepare" | "truncate" | "finish", string>
  >;
  return findSqlTargetEvidence(
    sql,
    stringValue(pack.document?.taskName) ?? undefined,
  )?.statementKind;
}

function hasFieldProducingSql(pack: LoadedTaskPack): boolean {
  return pack.sqlFiles.some((file) => {
    const sql = file.content
      .replace(/--[^\r\n]*/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
    return (
      /\b(?:SELECT|WITH)\b/i.test(sql) ||
      /\bINSERT\s+(?:OVERWRITE|INTO)\b[\s\S]*\bSELECT\b/i.test(sql) ||
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?TABLE\b[\s\S]*\bAS\s+(?:SELECT|WITH)\b/i.test(
        sql,
      )
    );
  });
}

interface ResolvedTable {
  readonly table: ProducerTableRef;
  readonly evidence: readonly ProducerEvidence[];
  readonly confirmable: boolean;
  readonly reason: string | null;
}

const ARTIFACT_SCHEMA_VERSION = "1.1.0" as const;
const LEGACY_ARTIFACT_SCHEMA_VERSION = "1.0.0" as const;

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

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeQualifiedName(value: string): string {
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

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identityKey(table: ProducerTableIdentity): string {
  return [table.platform, table.dataSource, table.qualifiedName].join("\u0000");
}

function edgeKey(table: ProducerTableIdentity, taskId: string): string {
  return `${identityKey(table)}\u0000${taskId}`;
}

function unknownTable(
  qualifiedName: string | null = null,
  identityStatus: ProducerTableRef["identityStatus"] = "UNKNOWN",
): ProducerTableRef {
  return {
    platform: null,
    dataSource: null,
    qualifiedName,
    identityStatus,
  };
}

function discoverFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => compareText(left.name, right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function namedPackFiles(root: string, name: string): string[] {
  return discoverFiles(root)
    .filter((path) => basename(path) === name)
    .sort((left, right) => compareText(left, right));
}

function rawPackFiles(dataRoot: string, packPath: string): JsonValue[] {
  return discoverFiles(dirname(packPath))
    .map((path) => ({
      path: relativeLocator(dataRoot, path),
      sha256: sha256File(path),
    }))
    .sort((left, right) =>
      compareText(String(left.path), String(right.path)),
    ) as JsonValue[];
}

function buildInputManifestPacks(
  dataRoot: string,
  taskPacks: readonly LoadedTaskPack[],
  tablePacks: readonly LoadedTablePack[],
): TableProducerInputManifestPack[] {
  const inputs: TableProducerInputManifestPack[] = [];
  for (const pack of taskPacks) {
    if (pack.status === "AVAILABLE" && pack.document) {
      inputs.push({
        packType: "TASK",
        path: relativeLocator(dataRoot, pack.taskPath),
        contentHash: String(pack.document.contentHash),
        files: pack.sqlFiles.map((file) => ({
          path: file.locator,
          sha256: file.sha256,
        })),
      });
    } else {
      inputs.push({
        packType: "TASK",
        path: relativeLocator(dataRoot, pack.taskPath),
        invalidReason: pack.issue ?? "UNKNOWN",
        files: rawPackFiles(
          dataRoot,
          pack.taskPath,
        ) as unknown as TableProducerInputManifestPack["files"],
      });
    }
  }
  for (const pack of tablePacks) {
    if (pack.status === "AVAILABLE" && pack.document) {
      const ddlFile = asRecord(pack.document.ddlFile)!;
      inputs.push({
        packType: "TABLE",
        path: relativeLocator(dataRoot, pack.tablePath),
        contentHash: String(pack.document.contentHash),
        files: [
          {
            path: relativeLocator(
              dataRoot,
              resolve(dirname(pack.tablePath), String(ddlFile.path)),
            ),
            sha256: String(ddlFile.sha256),
          },
        ],
      });
    } else {
      inputs.push({
        packType: "TABLE",
        path: relativeLocator(dataRoot, pack.tablePath),
        invalidReason: pack.issue ?? "UNKNOWN",
        files: rawPackFiles(
          dataRoot,
          pack.tablePath,
        ) as unknown as TableProducerInputManifestPack["files"],
      });
    }
  }
  inputs.sort((left, right) => {
    const leftRecord = asRecord(left)!;
    const rightRecord = asRecord(right)!;
    return compareText(
      `${String(leftRecord.packType)}\u0000${String(leftRecord.path)}`,
      `${String(rightRecord.packType)}\u0000${String(rightRecord.path)}`,
    );
  });
  return inputs;
}

function buildInputFingerprint(
  dataRoot: string,
  taskPacks: readonly LoadedTaskPack[],
  tablePacks: readonly LoadedTablePack[],
): string {
  return sha256Text(
    canonicalJson(
      buildInputManifestPacks(
        dataRoot,
        taskPacks,
        tablePacks,
      ) as unknown as JsonValue,
    ),
  );
}

function rawTreeFingerprint(dataRoot: string): string {
  const files = [
    ...discoverFiles(join(dataRoot, "tasks")),
    ...discoverFiles(join(dataRoot, "tables")),
  ]
    .map((path) => ({
      path: relativeLocator(dataRoot, path),
      sha256: sha256File(path),
    }))
    .sort((left, right) => compareText(left.path, right.path));
  return sha256Text(canonicalJson(files as JsonValue));
}

function packEvidence(
  dataRoot: string,
  path: string,
  source: ProducerEvidence["source"],
  provider: string,
  observedAt: string | null,
  contentHash?: string,
): ProducerEvidence {
  return {
    source,
    provider,
    locator: relativeLocator(dataRoot, path),
    observedAt,
    ...(contentHash ? { contentHash } : {}),
  };
}

function loadTaskPack(dataRoot: string, taskPath: string): LoadedTaskPack {
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
      const path = String(file.path);
      const absolutePath = resolve(dirname(taskPath), path);
      if (!isWithin(dirname(taskPath), absolutePath))
        throw new Error("SQL_FILE_PATH_ESCAPE");
      if (!existsSync(absolutePath))
        throw new Error(`SQL_FILE_MISSING:${slot}`);
      if (
        lstatSync(absolutePath).isSymbolicLink() ||
        !isWithin(realpathSync(dirname(taskPath)), realpathSync(absolutePath))
      )
        throw new Error("SQL_FILE_PATH_ESCAPE");
      const expectedHash = String(file.sha256);
      if (sha256File(absolutePath) !== expectedHash)
        throw new Error(`SQL_FILE_HASH_MISMATCH:${slot}`);
      sqlFiles.push({
        slot,
        path,
        locator: relativeLocator(dataRoot, absolutePath),
        absolutePath,
        sha256: expectedHash,
        evidenceProvider: String(file.evidenceProvider),
        content: readFileSync(absolutePath, "utf8"),
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
    };
  }
}

function loadTablePack(dataRoot: string, tablePath: string): LoadedTablePack {
  let parsed: JsonRecord | null = null;
  try {
    const segments = relativeLocator(dataRoot, tablePath).split("/");
    if (segments.length !== 4 || segments[0] !== "tables")
      throw new Error("TABLE_PACK_PATH_INVALID");
    const raw = JSON.parse(readFileSync(tablePath, "utf8")) as unknown;
    parsed = asRecord(raw);
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
    if (!existsSync(ddlPath)) throw new Error("DDL_FILE_MISSING");
    if (
      lstatSync(ddlPath).isSymbolicLink() ||
      !isWithin(realpathSync(dirname(tablePath)), realpathSync(ddlPath))
    )
      throw new Error("DDL_FILE_PATH_ESCAPE");
    if (sha256File(ddlPath) !== String(ddlFile.sha256))
      throw new Error("DDL_FILE_HASH_MISMATCH");
    const table: ProducerTableIdentity = {
      platform: normalizeToken(String(document.platform)),
      dataSource: normalizeToken(String(document.dataSource)),
      qualifiedName: normalizeQualifiedName(String(document.qualifiedName)),
    };
    const evidence = packEvidence(
      dataRoot,
      tablePath,
      "TABLE_PACK",
      String(document.evidenceProvider ?? ddlFile.evidenceProvider),
      null,
      String(document.contentHash),
    );
    return {
      status: "AVAILABLE",
      tablePath,
      document,
      table,
      evidence,
      issue: null,
    };
  } catch (error) {
    return {
      status: "INVALID",
      tablePath,
      document: null,
      table: null,
      evidence: packEvidence(
        dataRoot,
        tablePath,
        "TABLE_PACK",
        stringValue(parsed?.evidenceProvider) ?? "input-pack:table",
        stringValue(parsed?.collectedAt),
      ),
      issue: safeMessage(error),
    };
  }
}

function buildCatalog(tablePacks: readonly LoadedTablePack[]): TableCatalog {
  const validPacks = tablePacks.filter(
    (pack): pack is LoadedTablePack & { table: ProducerTableIdentity } =>
      pack.status === "AVAILABLE" && pack.table !== null,
  );
  const byIdentity = new Map<string, LoadedTablePack[]>();
  const byQualifiedName = new Map<string, LoadedTablePack[]>();
  for (const pack of validPacks) {
    const table = pack.table;
    byIdentity.set(identityKey(table), [
      ...(byIdentity.get(identityKey(table)) ?? []),
      pack,
    ]);
    byQualifiedName.set(table.qualifiedName, [
      ...(byQualifiedName.get(table.qualifiedName) ?? []),
      pack,
    ]);
  }
  return { validPacks, byIdentity, byQualifiedName };
}

function partitionFieldsForTable(
  catalog: TableCatalog,
  table: ProducerTableIdentity | undefined,
): readonly string[] | null {
  if (!table) return null;
  const packs = catalog.byIdentity.get(identityKey(table)) ?? [];
  const fields = packs[0]?.document?.partitionFields;
  if (!Array.isArray(fields)) return null;
  return fields.map(String).filter((field) => field.trim().length > 0);
}

function resolvedRef(table: ProducerTableIdentity): ProducerTableRef {
  return { ...table, identityStatus: "RESOLVED" };
}

function resolveExplicitTarget(
  catalog: TableCatalog,
  target: unknown,
): ResolvedTable {
  const record = asRecord(target);
  const qualifiedName =
    typeof target === "string"
      ? stringValue(target)
      : stringValue(record?.qualifiedName);
  const platform = stringValue(record?.platform);
  const dataSource = stringValue(record?.dataSource);
  if (typeof target === "string" && qualifiedName) {
    const normalized = normalizeQualifiedName(qualifiedName);
    const candidates = catalog.byQualifiedName.get(normalized) ?? [];
    if (candidates.length === 1) {
      const pack = candidates[0]!;
      const table = pack.table!;
      if (table.dataSource === "default")
        return {
          table: { ...table, identityStatus: "QUALIFIED_NAME_ONLY" },
          evidence: [pack.evidence],
          confirmable: false,
          reason: "DEFAULT_DATA_SOURCE_NOT_CONFIRMABLE",
        };
      return {
        table: resolvedRef(table),
        evidence: [pack.evidence],
        confirmable: true,
        reason: null,
      };
    }
    return {
      table: unknownTable(
        normalized,
        candidates.length > 1 ? "AMBIGUOUS" : "QUALIFIED_NAME_ONLY",
      ),
      evidence: candidates.map((pack) => pack.evidence),
      confirmable: false,
      reason: "TARGET_TABLE_IDENTITY_UNRESOLVED",
    };
  }
  if (!qualifiedName || !platform || !dataSource)
    return {
      table: unknownTable(
        qualifiedName ? normalizeQualifiedName(qualifiedName) : null,
        qualifiedName ? "QUALIFIED_NAME_ONLY" : "UNKNOWN",
      ),
      evidence: [],
      confirmable: false,
      reason: "TARGET_TABLE_IDENTITY_UNRESOLVED",
    };
  const identity: ProducerTableIdentity = {
    platform: normalizeToken(platform),
    dataSource: normalizeToken(dataSource),
    qualifiedName: normalizeQualifiedName(qualifiedName),
  };
  const exact = catalog.byIdentity.get(identityKey(identity)) ?? [];
  if (exact.length === 1) {
    const pack = exact[0]!;
    if (identity.dataSource === "default")
      return {
        table: { ...identity, identityStatus: "QUALIFIED_NAME_ONLY" },
        evidence: [pack.evidence],
        confirmable: false,
        reason: "DEFAULT_DATA_SOURCE_NOT_CONFIRMABLE",
      };
    return {
      table: resolvedRef(identity),
      evidence: [pack.evidence],
      confirmable: true,
      reason: null,
    };
  }
  const sameName = catalog.byQualifiedName.get(identity.qualifiedName) ?? [];
  return {
    table: {
      ...identity,
      identityStatus:
        exact.length > 1 || sameName.length > 1
          ? "AMBIGUOUS"
          : "QUALIFIED_NAME_ONLY",
    },
    evidence: (exact.length > 0 ? exact : sameName).map(
      (pack) => pack.evidence,
    ),
    confirmable: false,
    reason: "TARGET_TABLE_IDENTITY_UNRESOLVED",
  };
}

function resolveSqlTarget(
  catalog: TableCatalog,
  qualifiedName: string,
): ResolvedTable {
  const normalized = normalizeQualifiedName(qualifiedName);
  if (!normalized.includes("."))
    return {
      table: unknownTable(normalized, "QUALIFIED_NAME_ONLY"),
      evidence: [],
      confirmable: false,
      reason: "SQL_WRITE_TABLE_IDENTITY_UNRESOLVED",
    };
  const candidates = catalog.byQualifiedName.get(normalized) ?? [];
  if (candidates.length === 1) {
    const pack = candidates[0]!;
    const table = pack.table!;
    if (table.dataSource === "default")
      return {
        table: { ...table, identityStatus: "QUALIFIED_NAME_ONLY" },
        evidence: [pack.evidence],
        confirmable: false,
        reason: "DEFAULT_DATA_SOURCE_NOT_CONFIRMABLE",
      };
    return {
      table: resolvedRef(table),
      evidence: [pack.evidence],
      confirmable: true,
      reason: null,
    };
  }
  return {
    table: unknownTable(
      normalized,
      candidates.length > 1 ? "AMBIGUOUS" : "QUALIFIED_NAME_ONLY",
    ),
    evidence: candidates.map((pack) => pack.evidence),
    confirmable: false,
    reason: "SQL_WRITE_TABLE_IDENTITY_UNRESOLVED",
  };
}

function resolveSqlTargetForTask(
  catalog: TableCatalog,
  qualifiedName: string,
  taskTarget: unknown,
  taskName?: unknown,
  useTaskSchemaFallback = false,
): ResolvedTable {
  const normalized = normalizeQualifiedName(qualifiedName);
  if (normalized.includes(".")) return resolveSqlTarget(catalog, normalized);

  const target = asRecord(taskTarget);
  const targetQualifiedName = stringValue(target?.qualifiedName);
  if (!targetQualifiedName || !targetQualifiedName.includes(".")) {
    if (useTaskSchemaFallback) {
      const taskNameValue = stringValue(taskName);
      const separator = taskNameValue?.indexOf(".") ?? -1;
      if (separator > 0) {
        const taskSchema = normalizeQualifiedName(
          taskNameValue!.slice(0, separator),
        );
        return resolveSqlTarget(catalog, `${taskSchema}.${normalized}`);
      }
    }
    return resolveSqlTarget(catalog, normalized);
  }

  const targetParts = targetQualifiedName.split(".");
  const targetName = targetParts[targetParts.length - 1]!;
  if (normalizeToken(targetName) !== normalizeToken(normalized))
    return resolveSqlTarget(catalog, normalized);

  const resolved = resolveExplicitTarget(catalog, taskTarget);
  if (resolved.confirmable) return resolved;
  return {
    ...resolved,
    reason: "SQL_WRITE_TABLE_IDENTITY_UNRESOLVED",
  };
}

function producerTableKey(table: ProducerTableRef): string | null {
  if (
    !table.platform ||
    !table.dataSource ||
    !table.qualifiedName ||
    table.identityStatus !== "RESOLVED"
  )
    return null;
  return identityKey(table as ProducerTableIdentity);
}

function hasTaskSchema(taskName: unknown): boolean {
  const value = stringValue(taskName);
  return (value?.indexOf(".") ?? -1) > 0;
}

function taskEvidence(
  dataRoot: string,
  pack: LoadedTaskPack,
): ProducerEvidence {
  return packEvidence(
    dataRoot,
    pack.taskPath,
    "INPUT_PACK_TASK",
    stringValue(pack.document?.evidenceProvider) ?? "input-pack:task",
    null,
    stringValue(pack.document?.contentHash) ?? undefined,
  );
}

function sqlEvidence(file: LoadedSqlFile): ProducerEvidence {
  return {
    source: "INPUT_PACK_SQL",
    provider: file.evidenceProvider,
    locator: file.locator,
    observedAt: null,
    sha256: file.sha256,
    detail: { slot: file.slot, relativePath: file.path },
  };
}

function maskSqlForTableReference(sql: string): string {
  const output = [...sql];
  let state: "NORMAL" | "SINGLE_QUOTE" | "LINE_COMMENT" | "BLOCK_COMMENT" =
    "NORMAL";
  for (let index = 0; index < output.length; index += 1) {
    const current = sql[index]!;
    const next = sql[index + 1];
    if (state === "NORMAL") {
      if (current === "'") {
        output[index] = " ";
        state = "SINGLE_QUOTE";
      } else if (current === "-" && next === "-") {
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
        state = "LINE_COMMENT";
      } else if (current === "/" && next === "*") {
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
        state = "BLOCK_COMMENT";
      }
      continue;
    }
    if (state === "SINGLE_QUOTE") {
      if (current === "\n" || current === "\r") continue;
      output[index] = " ";
      if (current === "\\" && index + 1 < output.length) {
        output[index + 1] = " ";
        index += 1;
      } else if (current === "'" && next === "'") {
        output[index + 1] = " ";
        index += 1;
      } else if (current === "'") state = "NORMAL";
      continue;
    }
    if (state === "LINE_COMMENT") {
      if (current === "\n" || current === "\r") state = "NORMAL";
      else output[index] = " ";
      continue;
    }
    if (current === "*" && next === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 1;
      state = "NORMAL";
    } else if (current !== "\n" && current !== "\r") output[index] = " ";
  }
  return output.join("");
}

function tableReferencePattern(name: string): RegExp {
  const parts = name.split(".").map((part) => {
    const escaped = part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    return `(?:[\`\"]?${escaped}[\`\"]?)`;
  });
  return new RegExp(
    `(^|[^A-Za-z0-9_$#-])(${parts.join("\\s*\\.\\s*")})(?=$|[^A-Za-z0-9_$#-])`,
    "i",
  );
}

function maskSqlWriteTargets(sql: string): string {
  const masked = maskSqlForTableReference(sql);
  const output = [...masked];
  for (const write of extractSqlWrites(sql)) {
    const statement = masked.slice(
      write.statementSpan.start,
      write.statementSpan.end,
    );
    const match = tableReferencePattern(write.qualifiedName).exec(statement);
    const target = match?.[2];
    if (match?.index === undefined || !target) continue;
    const targetStart =
      write.statementSpan.start + match.index + match[0].lastIndexOf(target);
    output.fill(" ", targetStart, targetStart + target.length);
  }
  return output.join("");
}

function containsTableReadReference(
  sql: string,
  qualifiedName: string,
): boolean {
  const names = qualifiedName.includes(".")
    ? [qualifiedName, qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1)]
    : [qualifiedName];
  const masked = maskSqlWriteTargets(sql);
  return names.some((name) => tableReferencePattern(name).test(masked));
}

function isIntraTaskIntermediateMaterialization(
  pack: LoadedTaskPack,
  file: LoadedSqlFile,
  write: SqlWrite,
): boolean {
  const fileIndex = pack.sqlFiles.indexOf(file);
  if (fileIndex < 0) return false;
  if (
    containsTableReadReference(
      file.content.slice(write.statementSpan.end),
      write.qualifiedName,
    )
  )
    return true;
  return pack.sqlFiles
    .slice(fileIndex + 1)
    .some((laterFile) =>
      containsTableReadReference(laterFile.content, write.qualifiedName),
    );
}

function declaredPartitions(
  value: unknown,
  target: string | undefined,
  sqlSlot: string | null,
  statementOrdinal: number | null,
  tablePartitionFields: readonly string[] | null,
): readonly DeclaredPartition[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      declaredPartitions(
        item,
        target,
        sqlSlot,
        statementOrdinal,
        tablePartitionFields,
      ),
    );
  }
  const record = asRecord(value);
  if (!record) {
    return [
      {
        assignments: [],
        status:
          tablePartitionFields !== null && tablePartitionFields.length === 0
            ? "NOT_PARTITIONED"
            : "LEGACY_UNKNOWN",
        reasonCodes:
          tablePartitionFields !== null && tablePartitionFields.length === 0
            ? ["TABLE_NOT_PARTITIONED"]
            : ["TASK_PARTITION_CONTRACT_UNAVAILABLE"],
      },
    ];
  }
  if (Array.isArray(record.targets)) {
    const targetKey =
      target === undefined ? undefined : normalizeQualifiedName(target);
    const targets = record.targets.filter(
      (item): item is Record<string, unknown> =>
        asRecord(item) !== null &&
        (targetKey === undefined ||
          normalizeQualifiedName(String(asRecord(item)!.target)) === targetKey),
    );
    const targetEvidence = targets[0];
    const writes = asRecord(targetEvidence)?.writes;
    const matched = Array.isArray(writes)
      ? (writes.find((item) => {
          const write = asRecord(item);
          if (write === null) return false;
          return (
            (sqlSlot === null
              ? write.sqlSlot === null
              : write.sqlSlot === sqlSlot) &&
            (statementOrdinal === null ||
              write.statementOrdinal === statementOrdinal)
          );
        }) ??
        (sqlSlot === null && statementOrdinal === null && writes.length === 1
          ? writes[0]
          : undefined))
      : undefined;
    const write = asRecord(matched);
    const assignments = Array.isArray(write?.assignments)
      ? write.assignments.flatMap((item): PartitionAssignment[] => {
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
        })
      : [];
    return [
      {
        assignments,
        status:
          write !== null
            ? (String(write.status) as TaskPartitionStatus)
            : "UNKNOWN",
        reasonCodes: Array.isArray(write?.reasonCodes)
          ? write.reasonCodes.map(String)
          : ["TASK_PARTITION_WRITE_NOT_FOUND"],
      },
    ];
  }
  // Explicit compatibility for pre-contract Task Packs. This branch is not
  // used for new collection output and never reads SQL or script parameters.
  const assignments = Object.entries(record)
    .sort(([left], [right]) => compareText(left, right))
    .map(([field, raw]) => {
      const expression = String(raw);
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
  return [
    {
      assignments,
      status: assignments.length > 0 ? "COMPLETE" : "LEGACY_UNKNOWN",
      reasonCodes:
        assignments.length > 0
          ? ["PARTITION_EVIDENCE_COMPLETE"]
          : ["LEGACY_PARTITION_MAP"],
    },
  ];
}

function matchDeclaredPartitionsToSqlWrite(
  partitions: readonly DeclaredPartition[],
  sqlPartition: readonly PartitionAssignment[],
): readonly DeclaredPartition[] {
  const observed = sqlPartition.filter(
    (assignment) =>
      assignment.valueStatus === "OBSERVED_RENDERED_VALUE" &&
      assignment.observedValue !== null,
  );
  if (observed.length === 0) return partitions;
  return partitions.filter((partition) =>
    observed.every((sqlAssignment) => {
      const declared = partition.assignments.find(
        (assignment) => assignment.field === sqlAssignment.field,
      );
      if (!declared) return false;
      const observedValue = sqlAssignment.observedValue;
      if (observedValue === null) return false;
      if (
        isDatePartitionField(declared.field) &&
        datePartitionValuesCompatible(declared.expression, observedValue)
      )
        return true;
      if (declared.expression === "*") return true;
      const declaredValue =
        declared.observedValue ??
        declared.expression.replace(/^['"]|['"]$/gu, "");
      return declaredValue === observedValue;
    }),
  );
}

function normalizeLegacySqlPartition(
  assignments: readonly PartitionAssignment[],
): readonly PartitionAssignment[] {
  return assignments.map((assignment) => {
    const field = assignment.field.toLowerCase();
    const rawValue = assignment.observedValue ?? assignment.expression;
    const unquotedValue = rawValue.replace(/^['"]|['"]$/gu, "");
    if (
      field === "busi_date" &&
      (/^\d{4}-\d{2}-\d{2}$/u.test(unquotedValue) ||
        assignment.expression === "UNKNOWN")
    )
      return {
        ...assignment,
        expression: "${YYYY-MM-DD}",
        valueStatus: "RUNTIME_EXPRESSION" as const,
        observedValue: null,
      };
    if (assignment.expression === "UNKNOWN")
      return {
        ...assignment,
        expression: "*",
        valueStatus: "UNKNOWN" as const,
        observedValue: null,
      };
    return assignment;
  });
}

function nonConfirmed(
  pack: Pick<LoadedTaskPack, "taskId" | "taskCategory" | "document">,
  table: ProducerTableRef,
  reason: string,
  evidence: readonly ProducerEvidence[],
  directionStatus: NonConfirmedRelation["directionStatus"] = "UNKNOWN",
): NonConfirmedRelation {
  return {
    taskId: pack.taskId,
    taskCategory: pack.taskCategory,
    taskContentHash: stringValue(pack.document?.contentHash),
    tableRef: table,
    directionStatus,
    reasonCodes: [reason],
    evidence,
  };
}

function relationSortKey(relation: NonConfirmedRelation): string {
  return [
    relation.tableRef.qualifiedName ?? "",
    relation.tableRef.platform ?? "",
    relation.tableRef.dataSource ?? "",
    relation.taskId ?? "",
    relation.reasonCodes.join(","),
    relation.evidence[0]?.locator ?? "",
  ].join("\u0000");
}

function writeSortKey(write: ProducerWriteObservation): string {
  const parseEvidence = write.evidence.find(
    (item) => item.source === "SQL_PARSE",
  );
  return [
    write.evidence[0]?.locator ?? "",
    String(parseEvidence?.detail?.statementStart ?? ""),
    write.sqlWriteKind ?? "",
    write.declaredWriteMode ?? "",
  ].join("\u0000");
}

export function fingerprintTableProducerInputs(dataRootInput: string): string {
  const dataRoot = resolve(dataRootInput);
  const initialRawFingerprint = rawTreeFingerprint(dataRoot);
  const taskPacks = namedPackFiles(join(dataRoot, "tasks"), "task.json").map(
    (path) => loadTaskPack(dataRoot, path),
  );
  const tablePacks = namedPackFiles(join(dataRoot, "tables"), "table.json").map(
    (path) => loadTablePack(dataRoot, path),
  );
  const fingerprint = buildInputFingerprint(dataRoot, taskPacks, tablePacks);
  if (rawTreeFingerprint(dataRoot) !== initialRawFingerprint)
    throw new Error("INPUT_CHANGED_DURING_FINGERPRINT");
  return fingerprint;
}

function manifestHash(
  manifest: Omit<TableProducerInputManifest, "contentHash">,
): string {
  return canonicalHash(manifest as unknown as JsonValue, [
    "generatedAt",
    "contentHash",
  ]);
}

export function buildTableProducerInputManifest(
  dataRootInput: string,
  options: {
    readonly generation?: number;
    readonly now?: () => string;
    readonly allowInputChanges?: boolean;
  } = {},
): TableProducerInputManifest {
  const dataRoot = resolve(dataRootInput);
  const initialRawFingerprint = rawTreeFingerprint(dataRoot);
  const taskPacks = namedPackFiles(join(dataRoot, "tasks"), "task.json").map(
    (path) => loadTaskPack(dataRoot, path),
  );
  const tablePacks = namedPackFiles(join(dataRoot, "tables"), "table.json").map(
    (path) => loadTablePack(dataRoot, path),
  );
  const packs = buildInputManifestPacks(dataRoot, taskPacks, tablePacks);
  const inputFingerprint = sha256Text(
    canonicalJson(packs as unknown as JsonValue),
  );
  if (
    !options.allowInputChanges &&
    rawTreeFingerprint(dataRoot) !== initialRawFingerprint
  )
    throw new Error("INPUT_CHANGED_DURING_MANIFEST");
  const withoutHash: Omit<TableProducerInputManifest, "contentHash"> = {
    schemaVersion: "1.0.0",
    artifactType: "TABLE_PRODUCER_INPUT_MANIFEST",
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    generation: options.generation ?? 1,
    inputFingerprint,
    packs,
  };
  if (!Number.isInteger(withoutHash.generation) || withoutHash.generation < 1)
    throw new Error("MANIFEST_GENERATION_INVALID");
  return { ...withoutHash, contentHash: manifestHash(withoutHash) };
}

export function buildTableProducerIndex(
  dataRootInput: string,
  options: BuildTableProducerIndexOptions = {},
): TableProducerIndex {
  const dataRoot = resolve(dataRootInput);
  const now = options.now ?? (() => new Date().toISOString());
  const initialRawFingerprint = rawTreeFingerprint(dataRoot);
  const taskPaths = namedPackFiles(join(dataRoot, "tasks"), "task.json");
  const tablePaths = namedPackFiles(join(dataRoot, "tables"), "table.json");
  const taskPacks = taskPaths.map((path) => loadTaskPack(dataRoot, path));
  const tablePacks = tablePaths.map((path) => loadTablePack(dataRoot, path));
  const taskIdCounts = new Map<string, number>();
  for (const pack of taskPacks)
    taskIdCounts.set(pack.taskId, (taskIdCounts.get(pack.taskId) ?? 0) + 1);
  const ambiguousTaskIds = new Set(
    [...taskIdCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([taskId]) => taskId),
  );
  const catalog = buildCatalog(tablePacks);
  const edges = new Map<
    string,
    { edge: ConfirmedProducerEdge; writes: ProducerWriteObservation[] }
  >();
  const nonConfirmedRelations: NonConfirmedRelation[] = [];
  const intermediateMaterializations: NonConfirmedRelation[] = [];
  const issues: string[] = [];

  const addWrite = (
    pack: LoadedTaskPack,
    table: ProducerTableIdentity,
    write: ProducerWriteObservation,
  ): void => {
    const key = edgeKey(table, pack.taskId);
    const current = edges.get(key);
    if (current) current.writes.push(write);
    else {
      const writes = [write];
      edges.set(key, {
        edge: {
          taskId: pack.taskId,
          taskCategory: pack.taskCategory!,
          taskContentHash: String(pack.document!.contentHash),
          table: { ...table, identityStatus: "RESOLVED" },
          writes,
        },
        writes,
      });
    }
  };

  for (const tablePack of tablePacks)
    if (tablePack.status === "INVALID")
      issues.push(
        `TABLE_PACK_INVALID:${relativeLocator(dataRoot, tablePack.tablePath)}:${tablePack.issue ?? "UNKNOWN"}`,
      );

  for (const pack of taskPacks) {
    if (ambiguousTaskIds.has(pack.taskId)) {
      const reason = "TASK_PACK_AMBIGUOUS";
      nonConfirmedRelations.push(
        nonConfirmed(pack, unknownTable(), reason, [
          taskEvidence(dataRoot, pack),
        ]),
      );
      issues.push(
        `${reason}:${pack.taskId}:${relativeLocator(dataRoot, pack.taskPath)}`,
      );
      continue;
    }
    if (pack.status === "INVALID" || !pack.document) {
      const reason = "TASK_PACK_INVALID";
      nonConfirmedRelations.push(
        nonConfirmed(pack, unknownTable(), reason, [
          taskEvidence(dataRoot, pack),
        ]),
      );
      issues.push(
        `${reason}:${relativeLocator(dataRoot, pack.taskPath)}:${pack.issue ?? "UNKNOWN"}`,
      );
      continue;
    }
    const document = pack.document;
    const scriptEvidence = asRecord(document.codeEvidence)
      ? (document.codeEvidence as unknown as TaskCodeEvidence)
      : undefined;
    if (
      isManualScheduleCycle(document.scheduleCycle) ||
      isFrozenScheduleStatus(document.scheduleStatus)
    )
      continue;
    const packObservation = taskEvidence(dataRoot, pack);
    const evidenceKind = stringValue(document.targetEvidenceKind);
    let unresolvedTargetRelation: NonConfirmedRelation | null = null;
    const confirmedSqlTargetKeys = new Set<string>();
    if (
      evidenceKind === "DIRECT_PLATFORM_TARGET" ||
      evidenceKind === "SQL_EXACT_TABLE_TARGET"
    ) {
      const resolvedTarget = resolveExplicitTarget(catalog, document.target);
      if (resolvedTarget.confirmable) {
        const table = resolvedTarget.table as ProducerTableIdentity;
        const declaredWriteMode = stringValue(document.writeMode);
        const partitions = declaredPartitions(
          document.partition,
          table.qualifiedName,
          null,
          null,
          partitionFieldsForTable(catalog, table),
        );
        for (const partition of partitions) {
          const write = {
            observationKind: "DIRECT_TARGET",
            declaredWriteMode,
            sqlWriteKind: null,
            partition: partition.assignments,
            partitionStatus: partition.status,
            partitionReasonCodes: partition.reasonCodes,
            ...(scriptEvidence === undefined ? {} : { scriptEvidence }),
            evidence: [packObservation, ...resolvedTarget.evidence],
            targetEvidenceKind: evidenceKind as
              "DIRECT_PLATFORM_TARGET" | "SQL_EXACT_TABLE_TARGET",
          } as const;
          addWrite(pack, table, {
            ...write,
            ...classifyProducerWriteObservation(write, {
              sqlTargetStatementKind: sqlTargetStatementKindForPack(pack),
              hasFieldProducingSql: hasFieldProducingSql(pack),
            }),
          });
        }
      } else {
        const reason =
          resolvedTarget.reason ?? "TARGET_TABLE_IDENTITY_UNRESOLVED";
        nonConfirmedRelations.push(
          nonConfirmed(
            pack,
            resolvedTarget.table,
            reason,
            [packObservation, ...resolvedTarget.evidence],
            "WRITE_CONFIRMED",
          ),
        );
      }
    } else if (document.target !== undefined && document.target !== null) {
      const resolvedTarget = resolveExplicitTarget(catalog, document.target);
      const reason =
        evidenceKind === "TABLE_TASK_RELATION_DIRECTION_UNKNOWN"
          ? "TABLE_TASK_RELATION_DIRECTION_UNKNOWN"
          : "TARGET_DIRECTION_UNCONFIRMED";
      unresolvedTargetRelation = nonConfirmed(
        pack,
        resolvedTarget.table,
        reason,
        [packObservation, ...resolvedTarget.evidence],
      );
    }

    for (const file of pack.sqlFiles) {
      for (const write of extractSqlWrites(file.content)) {
        const isIntermediate = isIntraTaskIntermediateMaterialization(
          pack,
          file,
          write,
        );
        const resolvedTarget = resolveSqlTargetForTask(
          catalog,
          write.qualifiedName,
          document.target,
          document.taskName,
          !isIntermediate,
        );
        const sqlObservation = sqlEvidence(file);
        const parseObservation: ProducerEvidence = {
          source: "SQL_PARSE",
          provider: "sql-static-lineage:write-extractor",
          locator: `${file.locator}#char=${write.statementSpan.start}-${write.statementSpan.end}`,
          observedAt: null,
          detail: {
            statementStart: write.statementSpan.start,
            statementEnd: write.statementSpan.end,
            sqlWriteKind: write.writeKind,
          },
        };
        const unresolvedReason = isIntermediate
          ? "SQL_INTRA_TASK_INTERMEDIATE_IDENTITY_UNRESOLVED"
          : !write.qualifiedName.includes(".") &&
              hasTaskSchema(document.taskName)
            ? "SQL_FINAL_TARGET_PHYSICAL_IDENTITY_UNRESOLVED"
            : (resolvedTarget.reason ?? "SQL_WRITE_TABLE_IDENTITY_UNRESOLVED");
        const relationEvidence = [
          packObservation,
          sqlObservation,
          parseObservation,
          ...resolvedTarget.evidence,
        ];
        if (isIntermediate) {
          intermediateMaterializations.push(
            nonConfirmed(
              pack,
              resolvedTarget.table,
              unresolvedReason,
              relationEvidence,
              "WRITE_CONFIRMED",
            ),
          );
        } else if (resolvedTarget.confirmable) {
          const partitions = declaredPartitions(
            document.partition,
            resolvedTarget.table?.qualifiedName ?? undefined,
            file.slot,
            write.statementOrdinal,
            partitionFieldsForTable(
              catalog,
              resolvedTarget.table?.identityStatus === "RESOLVED"
                ? (resolvedTarget.table as ProducerTableIdentity)
                : undefined,
            ),
          );
          const matchedPartitions = matchDeclaredPartitionsToSqlWrite(
            partitions,
            write.partition,
          );
          const effectivePartitions = matchedPartitions.every(
            (partition) => partition.status === "LEGACY_UNKNOWN",
          )
            ? [
                {
                  assignments: normalizeLegacySqlPartition(write.partition),
                  status: "LEGACY_UNKNOWN" as const,
                  reasonCodes: ["SQL_WRITE_PARTITION_FALLBACK"],
                },
              ]
            : matchedPartitions;
          for (const effectivePartition of effectivePartitions) {
            const observation = {
              observationKind: "SQL_EXPLICIT_WRITE",
              declaredWriteMode: null,
              sqlWriteKind: write.writeKind,
              partition: effectivePartition.assignments,
              partitionStatus: effectivePartition.status,
              partitionReasonCodes: effectivePartition.reasonCodes,
              ...(scriptEvidence === undefined ? {} : { scriptEvidence }),
              evidence: relationEvidence,
            } as const;
            addWrite(pack, resolvedTarget.table as ProducerTableIdentity, {
              ...observation,
              ...classifyProducerWriteObservation(observation, {
                sqlTargetStatementKind: sqlTargetStatementKindForPack(pack),
              }),
            });
          }
          const tableKey = producerTableKey(resolvedTarget.table);
          if (tableKey) confirmedSqlTargetKeys.add(tableKey);
        } else {
          const relation = nonConfirmed(
            pack,
            resolvedTarget.table,
            unresolvedReason,
            relationEvidence,
            "WRITE_CONFIRMED",
          );
          nonConfirmedRelations.push(relation);
        }
      }
    }
    const unresolvedTableKey = unresolvedTargetRelation
      ? producerTableKey(unresolvedTargetRelation.tableRef)
      : null;
    if (
      unresolvedTargetRelation &&
      (unresolvedTableKey === null ||
        !confirmedSqlTargetKeys.has(unresolvedTableKey))
    )
      nonConfirmedRelations.push(unresolvedTargetRelation);
    // A task name or a read-only SQL file is not a producer relation, even as
    // a low-confidence candidate. Only an observed target/write contributes.
  }

  const confirmedProducerEdges = [...edges.values()]
    .map(({ edge, writes }) => ({
      ...edge,
      writes: [...writes].sort((left, right) =>
        compareText(writeSortKey(left), writeSortKey(right)),
      ),
    }))
    .sort((left, right) =>
      compareText(
        edgeKey(left.table, left.taskId),
        edgeKey(right.table, right.taskId),
      ),
    );
  nonConfirmedRelations.sort((left, right) =>
    compareText(relationSortKey(left), relationSortKey(right)),
  );
  intermediateMaterializations.sort((left, right) =>
    compareText(relationSortKey(left), relationSortKey(right)),
  );
  issues.sort(compareText);
  const invalidTaskPacks = taskPacks.filter(
    (pack) => pack.status === "INVALID" || ambiguousTaskIds.has(pack.taskId),
  ).length;
  const invalidTablePacks = tablePacks.filter(
    (pack) => pack.status === "INVALID",
  ).length;
  const withoutHash = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactType: "TABLE_PRODUCER_INDEX" as const,
    generatedAt: now(),
    buildStatus:
      invalidTaskPacks > 0 || invalidTablePacks > 0
        ? ("PARTIAL" as const)
        : ("SUCCESS" as const),
    coverageSemantics: "OBSERVED_EVIDENCE_ONLY" as const,
    inputFingerprint: buildInputFingerprint(dataRoot, taskPacks, tablePacks),
    confirmedProducerEdges,
    nonConfirmedRelations,
    intermediateMaterializations,
    counts: {
      taskPacksDiscovered: taskPacks.length,
      taskPacksIndexed: taskPacks.length - invalidTaskPacks,
      tablePacksDiscovered: tablePacks.length,
      tablePacksIndexed: tablePacks.length - invalidTablePacks,
      confirmedTables: new Set(
        confirmedProducerEdges.map((edge) => identityKey(edge.table)),
      ).size,
      confirmedProducerEdges: confirmedProducerEdges.length,
      confirmedWriteObservations: confirmedProducerEdges.reduce(
        (sum, edge) => sum + edge.writes.length,
        0,
      ),
      candidateObservations: nonConfirmedRelations.length,
      intermediateMaterializations: intermediateMaterializations.length,
      invalidTaskPacks,
      invalidTablePacks,
    },
    issues,
    boundaries: {
      openCli: "NOT_USED" as const,
      partitionScope: "TASK_TO_TABLE_WRITE" as const,
      schedulerExecution: "NOT_EVALUATED" as const,
      runtimeDelivery: "NOT_EVALUATED" as const,
      businessCorrectness: "NOT_EVALUATED" as const,
    },
  };
  if (
    !options.allowInputChanges &&
    rawTreeFingerprint(dataRoot) !== initialRawFingerprint
  )
    throw new Error("INPUT_CHANGED_DURING_BUILD");
  return {
    ...withoutHash,
    contentHash: canonicalHash(withoutHash as unknown as JsonValue, [
      "generatedAt",
      "contentHash",
    ]),
  };
}

const SHA256 = /^[a-f0-9]{64}$/;

function requireRecord(value: unknown, field: string): JsonRecord {
  const record = asRecord(value);
  if (!record) throw new Error(`${field} must be an object`);
  return record;
}

function requireExactKeys(
  record: JsonRecord,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0)
    throw new Error(
      `${field} has unexpected field ${unexpected.sort(compareText)[0]}`,
    );
  for (const key of allowed)
    if (!(key in record)) throw new Error(`${field}.${key} is required`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requireSha256(value: unknown, field: string): string {
  const hash = requireString(value, field);
  if (!SHA256.test(hash))
    throw new Error(`${field} must be a lowercase SHA-256`);
  return hash;
}

function validateEvidence(value: unknown, field: string): void {
  const evidence = requireRecord(value, field);
  const source = requireString(evidence.source, `${field}.source`);
  if (
    !["INPUT_PACK_TASK", "INPUT_PACK_SQL", "TABLE_PACK", "SQL_PARSE"].includes(
      source,
    )
  )
    throw new Error(`${field}.source is invalid`);
  requireString(evidence.provider, `${field}.provider`);
  const locator = requireString(evidence.locator, `${field}.locator`);
  const locatorPath = locator.split("#", 1)[0]!;
  if (
    locator.includes("\\") ||
    isAbsolute(locatorPath) ||
    locatorPath === ".." ||
    locatorPath.startsWith("../")
  )
    throw new Error(`${field}.locator must be relative to dataRoot`);
  if (evidence.observedAt !== null && typeof evidence.observedAt !== "string")
    throw new Error(`${field}.observedAt must be a string or null`);
  if (evidence.sha256 !== undefined)
    requireSha256(evidence.sha256, `${field}.sha256`);
  if (evidence.contentHash !== undefined)
    requireSha256(evidence.contentHash, `${field}.contentHash`);
  if (evidence.detail !== undefined)
    requireRecord(evidence.detail, `${field}.detail`);
}

function validateTableRef(value: unknown, field: string): ProducerTableRef {
  const table = requireRecord(value, field);
  requireExactKeys(
    table,
    ["platform", "dataSource", "qualifiedName", "identityStatus"],
    field,
  );
  for (const key of ["platform", "dataSource", "qualifiedName"])
    if (table[key] !== null) requireString(table[key], `${field}.${key}`);
  if (
    !["RESOLVED", "QUALIFIED_NAME_ONLY", "AMBIGUOUS", "UNKNOWN"].includes(
      String(table.identityStatus),
    )
  )
    throw new Error(`${field}.identityStatus is invalid`);
  if (
    table.identityStatus === "RESOLVED" &&
    [table.platform, table.dataSource, table.qualifiedName].some(
      (item) => typeof item !== "string" || item === "",
    )
  )
    throw new Error(`${field} resolved identity is incomplete`);
  if (
    table.identityStatus === "RESOLVED" &&
    normalizeToken(String(table.dataSource)) === "default"
  )
    throw new Error(`${field} default dataSource cannot be RESOLVED`);
  return table as unknown as ProducerTableRef;
}

function validatePartition(value: unknown, field: string): void {
  const partition = requireRecord(value, field);
  requireExactKeys(
    partition,
    ["field", "expression", "valueStatus", "observedValue"],
    field,
  );
  requireString(partition.field, `${field}.field`);
  requireString(partition.expression, `${field}.expression`);
  if (
    partition.valueStatus !== "OBSERVED_RENDERED_VALUE" &&
    partition.valueStatus !== "RUNTIME_EXPRESSION" &&
    partition.valueStatus !== "UNKNOWN"
  )
    throw new Error(`${field}.valueStatus is invalid`);
  if (
    partition.observedValue !== null &&
    typeof partition.observedValue !== "string"
  )
    throw new Error(`${field}.observedValue must be a string or null`);
}

function validateWrite(value: unknown, field: string): void {
  const write = requireRecord(value, field);
  const requiredKeys = [
    "observationKind",
    "declaredWriteMode",
    "sqlWriteKind",
    "partition",
    "evidence",
  ] as const;
  const allowedKeys = [
    ...requiredKeys,
    "scriptEvidence",
    "partitionStatus",
    "partitionReasonCodes",
    "targetEvidenceKind",
    "writeDirection",
    "operationClass",
    "dataPathRole",
  ];
  const unexpected = Object.keys(write).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpected.length > 0)
    throw new Error(
      `${field} has unexpected field ${unexpected.sort(compareText)[0]}`,
    );
  for (const key of requiredKeys)
    if (!(key in write)) throw new Error(`${field}.${key} is required`);
  if (
    write.observationKind !== "DIRECT_TARGET" &&
    write.observationKind !== "SQL_EXPLICIT_WRITE"
  )
    throw new Error(`${field}.observationKind is invalid`);
  if (write.declaredWriteMode !== null)
    requireString(write.declaredWriteMode, `${field}.declaredWriteMode`);
  const sqlKinds = ["INSERT_OVERWRITE", "INSERT_INTO", "MERGE_INTO", "CTAS"];
  if (
    write.sqlWriteKind !== null &&
    !sqlKinds.includes(String(write.sqlWriteKind))
  )
    throw new Error(`${field}.sqlWriteKind is invalid`);
  if (write.observationKind === "DIRECT_TARGET" && write.sqlWriteKind !== null)
    throw new Error(`${field} mixes declared and SQL write evidence`);
  if (
    write.observationKind === "SQL_EXPLICIT_WRITE" &&
    (write.declaredWriteMode !== null || write.sqlWriteKind === null)
  )
    throw new Error(`${field} mixes SQL and declared write evidence`);
  if (
    write.targetEvidenceKind !== undefined &&
    write.targetEvidenceKind !== "DIRECT_PLATFORM_TARGET" &&
    write.targetEvidenceKind !== "SQL_EXACT_TABLE_TARGET"
  )
    throw new Error(`${field}.targetEvidenceKind is invalid`);
  if (write.scriptEvidence !== undefined)
    validateTaskCodeEvidence(write.scriptEvidence, `${field}.scriptEvidence`);
  if (
    write.partitionStatus !== undefined &&
    ![
      "NOT_PARTITIONED",
      "COMPLETE",
      "INCOMPLETE",
      "UNKNOWN",
      "CONFLICT",
      "LEGACY_UNKNOWN",
    ].includes(String(write.partitionStatus))
  )
    throw new Error(`${field}.partitionStatus is invalid`);
  if (write.partitionReasonCodes !== undefined) {
    if (
      !Array.isArray(write.partitionReasonCodes) ||
      write.partitionReasonCodes.length === 0
    )
      throw new Error(
        `${field}.partitionReasonCodes must be a non-empty array`,
      );
    write.partitionReasonCodes.forEach((reason, index) =>
      requireString(reason, `${field}.partitionReasonCodes[${index}]`),
    );
  }
  if (
    write.observationKind === "SQL_EXPLICIT_WRITE" &&
    write.targetEvidenceKind !== undefined
  )
    throw new Error(`${field} mixes target and SQL parse evidence`);
  if (
    write.writeDirection !== undefined &&
    write.writeDirection !== "WRITE_CONFIRMED"
  )
    throw new Error(`${field}.writeDirection is invalid`);
  const operationClasses: readonly ProducerOperationClass[] = [
    "INSERT_OVERWRITE",
    "INSERT_INTO",
    "MERGE_INTO",
    "CTAS",
    "PLATFORM_TRANSFER",
    "DELETE",
    "TRUNCATE",
    "UNKNOWN",
  ];
  if (
    write.operationClass !== undefined &&
    !operationClasses.includes(
      String(write.operationClass) as ProducerOperationClass,
    )
  )
    throw new Error(`${field}.operationClass is invalid`);
  const dataPathRoles: readonly ProducerDataPathRole[] = [
    "PRODUCER",
    "MUTATION_ONLY",
    "UNKNOWN",
  ];
  if (
    write.dataPathRole !== undefined &&
    !dataPathRoles.includes(String(write.dataPathRole) as ProducerDataPathRole)
  )
    throw new Error(`${field}.dataPathRole is invalid`);
  if (
    write.operationClass !== undefined &&
    write.dataPathRole !== undefined &&
    (["DELETE", "TRUNCATE"] as readonly string[]).includes(
      String(write.operationClass),
    ) !==
      (write.dataPathRole === "MUTATION_ONLY")
  )
    throw new Error(`${field} operationClass/dataPathRole mismatch`);
  if (!Array.isArray(write.partition))
    throw new Error(`${field}.partition must be an array`);
  write.partition.forEach((item, index) =>
    validatePartition(item, `${field}.partition[${index}]`),
  );
  if (!Array.isArray(write.evidence) || write.evidence.length === 0)
    throw new Error(`${field}.evidence must be a non-empty array`);
  write.evidence.forEach((item, index) =>
    validateEvidence(item, `${field}.evidence[${index}]`),
  );
}

function validateNonConfirmedRelation(
  rawRelation: unknown,
  field: string,
): void {
  const relation = requireRecord(rawRelation, field);
  requireExactKeys(
    relation,
    [
      "taskId",
      "taskCategory",
      "taskContentHash",
      "tableRef",
      "directionStatus",
      "reasonCodes",
      "evidence",
    ],
    field,
  );
  requireString(relation.taskId, `${field}.taskId`);
  if (relation.taskCategory !== null)
    requireString(relation.taskCategory, `${field}.taskCategory`);
  if (relation.taskContentHash !== null)
    requireSha256(relation.taskContentHash, `${field}.taskContentHash`);
  validateTableRef(relation.tableRef, `${field}.tableRef`);
  if (
    relation.directionStatus !== "WRITE_CONFIRMED" &&
    relation.directionStatus !== "UNKNOWN"
  )
    throw new Error(`${field}.directionStatus is invalid`);
  if (!Array.isArray(relation.reasonCodes) || relation.reasonCodes.length === 0)
    throw new Error(`${field}.reasonCodes must be a non-empty array`);
  const reasons = relation.reasonCodes.map((reason, reasonIndex) =>
    requireString(reason, `${field}.reasonCodes[${reasonIndex}]`),
  );
  if (new Set(reasons).size !== reasons.length)
    throw new Error(`${field}.reasonCodes must be unique`);
  if (!Array.isArray(relation.evidence))
    throw new Error(`${field}.evidence must be an array`);
  relation.evidence.forEach((item, evidenceIndex) =>
    validateEvidence(item, `${field}.evidence[${evidenceIndex}]`),
  );
}

export function validateTableProducerIndex(
  value: unknown,
): asserts value is TableProducerIndex {
  const artifact = asRecord(value);
  if (!artifact) throw new Error("Producer index must be a JSON object");
  const legacyArtifact =
    artifact.schemaVersion === LEGACY_ARTIFACT_SCHEMA_VERSION &&
    !("intermediateMaterializations" in artifact);
  requireExactKeys(
    artifact,
    legacyArtifact
      ? [
          "schemaVersion",
          "artifactType",
          "generatedAt",
          "buildStatus",
          "coverageSemantics",
          "inputFingerprint",
          "confirmedProducerEdges",
          "nonConfirmedRelations",
          "counts",
          "issues",
          "boundaries",
          "contentHash",
        ]
      : [
          "schemaVersion",
          "artifactType",
          "generatedAt",
          "buildStatus",
          "coverageSemantics",
          "inputFingerprint",
          "confirmedProducerEdges",
          "nonConfirmedRelations",
          "intermediateMaterializations",
          "counts",
          "issues",
          "boundaries",
          "contentHash",
        ],
    "producerIndex",
  );
  if (artifact.schemaVersion !== ARTIFACT_SCHEMA_VERSION && !legacyArtifact)
    throw new Error("Unsupported producer index schemaVersion");
  if (artifact.artifactType !== "TABLE_PRODUCER_INDEX")
    throw new Error("Invalid producer index artifactType");
  if (artifact.buildStatus !== "SUCCESS" && artifact.buildStatus !== "PARTIAL")
    throw new Error("Invalid producer index buildStatus");
  requireString(artifact.generatedAt, "generatedAt");
  if (artifact.coverageSemantics !== "OBSERVED_EVIDENCE_ONLY")
    throw new Error("Invalid producer index coverageSemantics");
  requireSha256(artifact.inputFingerprint, "inputFingerprint");
  if (!Array.isArray(artifact.confirmedProducerEdges))
    throw new Error("confirmedProducerEdges must be an array");
  for (const [index, rawEdge] of artifact.confirmedProducerEdges.entries()) {
    const field = `confirmedProducerEdges[${index}]`;
    const edge = requireRecord(rawEdge, field);
    requireExactKeys(
      edge,
      ["taskId", "taskCategory", "taskContentHash", "table", "writes"],
      field,
    );
    requireString(edge.taskId, `${field}.taskId`);
    requireString(edge.taskCategory, `${field}.taskCategory`);
    requireSha256(edge.taskContentHash, `${field}.taskContentHash`);
    const table = validateTableRef(edge.table, `${field}.table`);
    if (table.identityStatus !== "RESOLVED" || table.dataSource === "default")
      throw new Error(`${field}.table is not a confirmable identity`);
    if (!Array.isArray(edge.writes) || edge.writes.length === 0)
      throw new Error(`${field}.writes must be a non-empty array`);
    edge.writes.forEach((write, writeIndex) =>
      validateWrite(write, `${field}.writes[${writeIndex}]`),
    );
    for (const [writeIndex, rawWrite] of edge.writes.entries()) {
      const write = rawWrite as JsonRecord;
      const evidence = write.evidence as JsonRecord[];
      const hasTaskPack = evidence.some(
        (item) =>
          item.source === "INPUT_PACK_TASK" &&
          item.contentHash === edge.taskContentHash,
      );
      const hasTablePack = evidence.some(
        (item) =>
          item.source === "TABLE_PACK" && typeof item.contentHash === "string",
      );
      if (!hasTaskPack || !hasTablePack)
        throw new Error(
          `${field}.writes[${writeIndex}] lacks verified Task/Table Pack evidence`,
        );
      if (write.observationKind === "SQL_EXPLICIT_WRITE") {
        const hasSqlFile = evidence.some(
          (item) =>
            item.source === "INPUT_PACK_SQL" && typeof item.sha256 === "string",
        );
        const hasSqlParse = evidence.some(
          (item) => item.source === "SQL_PARSE",
        );
        if (!hasSqlFile || !hasSqlParse)
          throw new Error(
            `${field}.writes[${writeIndex}] lacks verified SQL write evidence`,
          );
      }
    }
  }
  if (!Array.isArray(artifact.nonConfirmedRelations))
    throw new Error("nonConfirmedRelations must be an array");
  for (const [index, rawRelation] of artifact.nonConfirmedRelations.entries()) {
    validateNonConfirmedRelation(
      rawRelation,
      `nonConfirmedRelations[${index}]`,
    );
  }
  if (!legacyArtifact) {
    if (!Array.isArray(artifact.intermediateMaterializations))
      throw new Error("intermediateMaterializations must be an array");
    for (const [
      index,
      rawRelation,
    ] of artifact.intermediateMaterializations.entries())
      validateNonConfirmedRelation(
        rawRelation,
        `intermediateMaterializations[${index}]`,
      );
  }
  const counts = requireRecord(artifact.counts, "counts");
  const countFields = [
    "taskPacksDiscovered",
    "taskPacksIndexed",
    "invalidTaskPacks",
    "tablePacksDiscovered",
    "tablePacksIndexed",
    "invalidTablePacks",
    "confirmedTables",
    "confirmedProducerEdges",
    "confirmedWriteObservations",
    "candidateObservations",
    ...(legacyArtifact ? [] : ["intermediateMaterializations"]),
  ] as const;
  requireExactKeys(counts, countFields, "counts");
  for (const field of countFields)
    if (!Number.isInteger(counts[field]) || Number(counts[field]) < 0)
      throw new Error(`counts.${field} must be a non-negative integer`);
  if (
    Number(counts.taskPacksIndexed) + Number(counts.invalidTaskPacks) !==
    Number(counts.taskPacksDiscovered)
  )
    throw new Error("Task Pack counts are inconsistent");
  if (
    Number(counts.tablePacksIndexed) + Number(counts.invalidTablePacks) !==
    Number(counts.tablePacksDiscovered)
  )
    throw new Error("Table Pack counts are inconsistent");
  const confirmedEdges = artifact.confirmedProducerEdges as JsonRecord[];
  const edgeKeys = confirmedEdges.map((edge) => {
    const table = edge.table as JsonRecord;
    return edgeKey(
      {
        platform: String(table.platform),
        dataSource: String(table.dataSource),
        qualifiedName: String(table.qualifiedName),
      },
      String(edge.taskId),
    );
  });
  if (new Set(edgeKeys).size !== edgeKeys.length)
    throw new Error("confirmedProducerEdges contains duplicate edge keys");
  const expectedConfirmedTables = new Set(
    confirmedEdges.map((edge) => {
      const table = edge.table as JsonRecord;
      return identityKey({
        platform: String(table.platform),
        dataSource: String(table.dataSource),
        qualifiedName: String(table.qualifiedName),
      });
    }),
  ).size;
  const expectedConfirmedTasks = new Set(
    confirmedEdges.map((edge) => String(edge.taskId)),
  ).size;
  if (expectedConfirmedTables > Number(counts.tablePacksIndexed))
    throw new Error("confirmed tables exceed indexed Table Packs");
  if (expectedConfirmedTasks > Number(counts.taskPacksIndexed))
    throw new Error("confirmed tasks exceed indexed Task Packs");
  const expectedWriteObservations = confirmedEdges.reduce(
    (sum, edge) => sum + (edge.writes as unknown[]).length,
    0,
  );
  const derivedCounts: Readonly<Record<string, number>> = {
    confirmedTables: expectedConfirmedTables,
    confirmedProducerEdges: confirmedEdges.length,
    confirmedWriteObservations: expectedWriteObservations,
    candidateObservations: artifact.nonConfirmedRelations.length,
    ...(legacyArtifact
      ? {}
      : {
          intermediateMaterializations: (
            artifact.intermediateMaterializations as unknown[]
          ).length,
        }),
  };
  for (const [field, expected] of Object.entries(derivedCounts))
    if (Number(counts[field]) !== expected)
      throw new Error(`counts.${field} does not match artifact contents`);
  const expectedBuildStatus =
    Number(counts.invalidTaskPacks) > 0 || Number(counts.invalidTablePacks) > 0
      ? "PARTIAL"
      : "SUCCESS";
  if (artifact.buildStatus !== expectedBuildStatus)
    throw new Error("buildStatus does not match invalid Input Pack counts");
  const issues = artifact.issues;
  if (!Array.isArray(issues)) throw new Error("issues must be an array");
  issues.forEach((issue, index) => requireString(issue, `issues[${index}]`));
  const boundaries = requireRecord(artifact.boundaries, "boundaries");
  requireExactKeys(
    boundaries,
    [
      "openCli",
      "partitionScope",
      "schedulerExecution",
      "runtimeDelivery",
      "businessCorrectness",
    ],
    "boundaries",
  );
  if (boundaries.openCli !== "NOT_USED")
    throw new Error("boundaries.openCli must be NOT_USED");
  if (boundaries.partitionScope !== "TASK_TO_TABLE_WRITE")
    throw new Error("boundaries.partitionScope is invalid");
  for (const field of [
    "schedulerExecution",
    "runtimeDelivery",
    "businessCorrectness",
  ])
    if (boundaries[field] !== "NOT_EVALUATED")
      throw new Error(`boundaries.${field} must be NOT_EVALUATED`);
  requireSha256(artifact.contentHash, "contentHash");
  const expectedHash = canonicalHash(artifact as JsonValue, [
    "generatedAt",
    "contentHash",
  ]);
  if (artifact.contentHash !== expectedHash)
    throw new Error("Producer index contentHash does not match artifact");
}

export function validateTableProducerInputManifest(
  value: unknown,
): asserts value is TableProducerInputManifest {
  const manifest = asRecord(value);
  if (!manifest) throw new Error("Producer input manifest must be an object");
  requireExactKeys(
    manifest,
    [
      "schemaVersion",
      "artifactType",
      "generatedAt",
      "generation",
      "inputFingerprint",
      "packs",
      "contentHash",
    ],
    "producerInputManifest",
  );
  if (manifest.schemaVersion !== "1.0.0")
    throw new Error("Unsupported producer input manifest schemaVersion");
  if (manifest.artifactType !== "TABLE_PRODUCER_INPUT_MANIFEST")
    throw new Error("Invalid producer input manifest artifactType");
  requireString(manifest.generatedAt, "generatedAt");
  if (!Number.isInteger(manifest.generation) || Number(manifest.generation) < 1)
    throw new Error("generation must be a positive integer");
  requireSha256(manifest.inputFingerprint, "inputFingerprint");
  if (!Array.isArray(manifest.packs)) throw new Error("packs must be an array");
  for (const [index, rawPack] of manifest.packs.entries()) {
    const field = `packs[${index}]`;
    const pack = requireRecord(rawPack, field);
    const packKeys = Object.keys(pack);
    if (
      packKeys.some(
        (key) =>
          ![
            "packType",
            "path",
            "contentHash",
            "invalidReason",
            "files",
          ].includes(key),
      )
    )
      throw new Error(`${field} has an unexpected field`);
    for (const required of ["packType", "path", "files"])
      if (!(required in pack))
        throw new Error(`${field}.${required} is required`);
    if (pack.packType !== "TASK" && pack.packType !== "TABLE")
      throw new Error(`${field}.packType is invalid`);
    requireString(pack.path, `${field}.path`);
    if (pack.contentHash !== undefined)
      requireSha256(pack.contentHash, `${field}.contentHash`);
    if (pack.invalidReason !== undefined)
      requireString(pack.invalidReason, `${field}.invalidReason`);
    if (pack.contentHash === undefined && pack.invalidReason === undefined)
      throw new Error(`${field} must have contentHash or invalidReason`);
    if (!Array.isArray(pack.files))
      throw new Error(`${field}.files must be an array`);
    for (const [fileIndex, rawFile] of pack.files.entries()) {
      const fileField = `${field}.files[${fileIndex}]`;
      const file = requireRecord(rawFile, fileField);
      requireExactKeys(file, ["path", "sha256"], fileField);
      requireString(file.path, `${fileField}.path`);
      requireSha256(file.sha256, `${fileField}.sha256`);
    }
  }
  requireSha256(manifest.contentHash, "contentHash");
  const expectedHash = manifestHash(
    manifest as unknown as Omit<TableProducerInputManifest, "contentHash">,
  );
  if (manifest.contentHash !== expectedHash)
    throw new Error(
      "Producer input manifest contentHash does not match artifact",
    );
  const expectedFingerprint = sha256Text(
    canonicalJson(manifest.packs as unknown as JsonValue),
  );
  if (manifest.inputFingerprint !== expectedFingerprint)
    throw new Error(
      "Producer input manifest inputFingerprint does not match packs",
    );
}

function readTableProducerInputManifest(
  path: string,
): TableProducerInputManifest {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  validateTableProducerInputManifest(value);
  return value;
}

export function loadTableProducerInputManifest(
  pathInput: string,
): TableProducerInputManifest {
  return readTableProducerInputManifest(resolve(pathInput));
}

function manifestPackKey(pack: TableProducerInputManifestPack): string {
  return `${pack.packType}:${pack.path}`;
}

export function compareTableProducerInputManifests(
  previous: TableProducerInputManifest | null,
  current: TableProducerInputManifest,
): TableProducerInputChanges {
  if (!previous) {
    return {
      status: "INITIAL",
      changedPacks: current.packs.map(manifestPackKey).sort(compareText),
    };
  }
  const previousByKey = new Map(
    previous.packs.map((pack) => [
      manifestPackKey(pack),
      canonicalJson(pack as unknown as JsonValue),
    ]),
  );
  const currentByKey = new Map(
    current.packs.map((pack) => [
      manifestPackKey(pack),
      canonicalJson(pack as unknown as JsonValue),
    ]),
  );
  const keys = new Set([...previousByKey.keys(), ...currentByKey.keys()]);
  const changedPacks = [...keys]
    .filter((key) => previousByKey.get(key) !== currentByKey.get(key))
    .sort(compareText);
  return {
    status: changedPacks.length === 0 ? "UNCHANGED" : "CHANGED",
    changedPacks,
  };
}

function readTableProducerIndex(path: string): TableProducerIndex {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  validateTableProducerIndex(value);
  return value;
}

export function loadTableProducerIndex(pathInput: string): TableProducerIndex {
  const path = resolve(pathInput);
  const previous = `${path}.previous`;
  if (!existsSync(path)) {
    if (existsSync(previous)) {
      const artifact = readTableProducerIndex(previous);
      renameSync(previous, path);
      return artifact;
    }
  }
  const artifact = readTableProducerIndex(path);
  if (existsSync(previous)) rmSync(previous, { force: true });
  return artifact;
}

export function writeTableProducerIndex(
  pathInput: string,
  index: TableProducerIndex,
): {
  readonly changed: boolean;
  readonly path: string;
  readonly contentHash: string;
} {
  validateTableProducerIndex(index);
  const path = resolve(pathInput);
  if (existsSync(path)) {
    try {
      const current = loadTableProducerIndex(path);
      if (current.contentHash === index.contentHash)
        return { changed: false, path, contentHash: index.contentHash };
    } catch {
      // Replace invalid or stale output atomically below.
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const staged = `${path}.staged-${randomUUID()}`;
  const backup = `${path}.previous`;
  const hadTarget = existsSync(path);
  writeFileSync(staged, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  try {
    loadTableProducerIndex(staged);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  if (hadTarget) {
    if (existsSync(backup)) rmSync(backup, { force: true });
    renameSync(path, backup);
  }
  try {
    renameSync(staged, path);
  } catch (error) {
    if (existsSync(staged)) rmSync(staged, { force: true });
    if (hadTarget && existsSync(backup)) renameSync(backup, path);
    throw error;
  }
  if (hadTarget) rmSync(backup, { force: true });
  return { changed: true, path, contentHash: index.contentHash };
}

export function writeTableProducerInputManifest(
  pathInput: string,
  manifest: TableProducerInputManifest,
): {
  readonly changed: boolean;
  readonly path: string;
  readonly contentHash: string;
} {
  validateTableProducerInputManifest(manifest);
  const path = resolve(pathInput);
  if (existsSync(path)) {
    try {
      const current = loadTableProducerInputManifest(path);
      if (current.contentHash === manifest.contentHash)
        return { changed: false, path, contentHash: manifest.contentHash };
    } catch {
      // Replace invalid output atomically below.
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const staged = `${path}.staged-${randomUUID()}`;
  const backup = `${path}.previous`;
  const hadTarget = existsSync(path);
  writeFileSync(staged, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  try {
    loadTableProducerInputManifest(staged);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  if (hadTarget) {
    if (existsSync(backup)) rmSync(backup, { force: true });
    renameSync(path, backup);
  }
  try {
    renameSync(staged, path);
  } catch (error) {
    if (existsSync(staged)) rmSync(staged, { force: true });
    if (hadTarget && existsSync(backup)) renameSync(backup, path);
    throw error;
  }
  if (hadTarget) rmSync(backup, { force: true });
  return { changed: true, path, contentHash: manifest.contentHash };
}

export function updateTableProducerIndex(
  dataRootInput: string,
  indexPathInput: string,
  manifestPathInput: string,
  options: UpdateTableProducerIndexOptions = {},
): UpdateTableProducerIndexResult {
  const now = options.now ?? (() => new Date().toISOString());
  const indexPath = resolve(indexPathInput);
  const manifestPath = resolve(manifestPathInput);
  let previousIndex: TableProducerIndex | null = null;
  let previousManifest: TableProducerInputManifest | null = null;
  if (existsSync(indexPath)) {
    try {
      previousIndex = loadTableProducerIndex(indexPath);
    } catch {
      previousIndex = null;
    }
  }
  if (existsSync(manifestPath)) {
    try {
      previousManifest = loadTableProducerInputManifest(manifestPath);
    } catch {
      previousManifest = null;
    }
  }
  const baseManifest = buildTableProducerInputManifest(dataRootInput, {
    generation: 1,
    now,
    allowInputChanges: options.allowInputChanges,
  });
  const generation = previousManifest
    ? baseManifest.inputFingerprint === previousManifest.inputFingerprint
      ? previousManifest.generation
      : previousManifest.generation + 1
    : 1;
  const manifest: TableProducerInputManifest = {
    ...baseManifest,
    generation,
    contentHash: manifestHash({ ...baseManifest, generation }),
  };
  const changes = compareTableProducerInputManifests(
    previousManifest,
    manifest,
  );
  const reused =
    previousIndex !== null &&
    previousIndex.inputFingerprint === manifest.inputFingerprint &&
    changes.status !== "CHANGED";
  const index = reused
    ? previousIndex!
    : buildTableProducerIndex(dataRootInput, {
        now,
        allowInputChanges: options.allowInputChanges,
      });
  if (
    options.allowInputChanges &&
    index.inputFingerprint !== manifest.inputFingerprint
  )
    return { index, manifest, changes, reused: false };
  writeTableProducerIndex(indexPath, index);
  writeTableProducerInputManifest(manifestPath, manifest);
  return { index, manifest, changes, reused };
}

/**
 * Resolves an immutable Producer Index cache entry for the current Input Pack.
 * Cache entries are keyed by the exact input fingerprint, so a later Input
 * Pack change creates a new entry instead of invalidating or overwriting the
 * index used by an earlier run.
 */
export function pinTableProducerIndex(
  dataRootInput: string,
  cacheRootInput: string,
  options: PinTableProducerIndexOptions = {},
): PinTableProducerIndexResult {
  const dataRoot = resolve(dataRootInput);
  const cacheRoot = resolve(cacheRootInput);
  assertOutputOutsideDataRoot(dataRoot, cacheRoot);
  const manifest = buildTableProducerInputManifest(dataRoot, {
    generation: 1,
    now: options.now,
    allowInputChanges: options.allowInputChanges,
  });
  const snapshotRoot = join(cacheRoot, manifest.inputFingerprint);
  const indexPath = join(snapshotRoot, "producer-index.json");
  const manifestPath = join(snapshotRoot, "producer-index.manifest.json");
  if (existsSync(indexPath) && existsSync(manifestPath)) {
    try {
      const index = loadTableProducerIndex(indexPath);
      const cachedManifest = loadTableProducerInputManifest(manifestPath);
      if (
        index.inputFingerprint === manifest.inputFingerprint &&
        cachedManifest.inputFingerprint === manifest.inputFingerprint
      )
        return {
          index,
          manifest: cachedManifest,
          inputFingerprint: manifest.inputFingerprint,
          indexPath,
          manifestPath,
          reused: true,
        };
    } catch {
      // Rebuild the current fingerprint entry below when either cache file is invalid.
    }
  }
  const index = buildTableProducerIndex(dataRoot, {
    now: options.now,
    allowInputChanges: options.allowInputChanges,
  });
  if (index.inputFingerprint !== manifest.inputFingerprint) {
    if (options.allowInputChanges)
      return {
        index,
        manifest,
        inputFingerprint: index.inputFingerprint,
        indexPath,
        manifestPath,
        reused: false,
      };
    throw new Error("INPUT_CHANGED_DURING_PINNED_INDEX_BUILD");
  }
  writeTableProducerIndex(indexPath, index);
  writeTableProducerInputManifest(manifestPath, manifest);
  return {
    index,
    manifest,
    inputFingerprint: manifest.inputFingerprint,
    indexPath,
    manifestPath,
    reused: false,
  };
}

export function assertOutputOutsideDataRoot(
  dataRootInput: string,
  outputInput: string,
): void {
  const dataRoot = resolve(dataRootInput);
  const output = resolve(outputInput);
  if (output === dataRoot || isWithin(dataRoot, output))
    throw new Error("OUTPUT_MUST_BE_OUTSIDE_INPUT_PACK_ROOT");
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const validatePath = option(args, "--validate");
  if (validatePath) {
    const artifact = loadTableProducerIndex(
      isAbsolute(validatePath) ? validatePath : resolve(validatePath),
    );
    process.stdout.write(
      `${JSON.stringify({ valid: true, contentHash: artifact.contentHash })}\n`,
    );
    return;
  }
  const dataRoot =
    option(args, "--data-root") ?? process.env.SQL_LINEAGE_DATA_ROOT;
  const output = option(args, "--output");
  if (!dataRoot)
    throw new Error(
      "usage: npm run producer-index -- --data-root <input-pack-root> [--output <json>]",
    );
  if (args.includes("--pin")) {
    const cacheRoot = option(args, "--cache-root");
    if (!cacheRoot)
      throw new Error(
        "usage: npm run producer-index:pin -- --data-root <input-pack-root> --cache-root <cache-root>",
      );
    const result = pinTableProducerIndex(dataRoot, cacheRoot);
    process.stdout.write(
      `${JSON.stringify({ reused: result.reused, inputFingerprint: result.inputFingerprint, indexPath: result.indexPath, manifestPath: result.manifestPath, counts: result.index.counts, buildStatus: result.index.buildStatus })}\n`,
    );
    return;
  }
  if (args.includes("--update")) {
    if (!output)
      throw new Error(
        "usage: npm run producer-index:update -- --data-root <input-pack-root> --output <producer-index.json> [--manifest <manifest.json>]",
      );
    const resolvedOutput = resolve(output);
    const manifest = resolve(
      option(args, "--manifest") ?? `${resolvedOutput}.manifest.json`,
    );
    assertOutputOutsideDataRoot(dataRoot, resolvedOutput);
    assertOutputOutsideDataRoot(dataRoot, manifest);
    const result = updateTableProducerIndex(dataRoot, resolvedOutput, manifest);
    process.stdout.write(
      `${JSON.stringify({
        reused: result.reused,
        changes: result.changes,
        indexPath: resolvedOutput,
        manifestPath: manifest,
        generation: result.manifest.generation,
        counts: result.index.counts,
        buildStatus: result.index.buildStatus,
      })}\n`,
    );
    return;
  }
  const artifact = buildTableProducerIndex(dataRoot);
  if (output) {
    const resolvedOutput = resolve(output);
    assertOutputOutsideDataRoot(dataRoot, resolvedOutput);
    const result = writeTableProducerIndex(resolvedOutput, artifact);
    process.stdout.write(
      `${JSON.stringify({ ...result, counts: artifact.counts, buildStatus: artifact.buildStatus })}\n`,
    );
  } else process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  main();
