import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  materializeTaskAndTablePacks,
  type TaskTableMaterializationResult,
} from "./task-table-materialization.ts";
import {
  sha256File,
  sha256Text,
  validateTableDocument,
  type SqlSlot,
  type TableEvidence,
  type TableDocument,
  type TaskEvidence,
} from "./input-pack.ts";
import { extractSqlWriteTableNames } from "./sql-target-evidence.ts";
import { extractSqlReadTableNames } from "./sql-table-references.ts";
import {
  inferTaskDefaultSchema,
  qualifyBareTableName,
  type TaskDefaultSchema,
} from "../../reconcile/shared/task-default-schema.ts";

export const DEFAULT_HIVE_METADATA_SNAPSHOT_PATH =
  "E:\\02_area\\股衍数据-数据cookbook\\数综基础信息\\原信息\\hive元信息-20260831快照\\hive_table_restored.jsonl";
export const SPARKINDEX_TABLE_DATA_SOURCE = "gfhive" as const;
export const DEFAULT_SPARKINDEX_TABLE_MCP_MIN_INTERVAL_MS = 2_000;

const SQL_SLOTS: readonly SqlSlot[] = [
  "create",
  "query",
  "prepare",
  "truncate",
  "finish",
];
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TRUNCATION_MARKERS = [
  /\.\.\.\s*<\s*(?:truncated\s+)?\d+\s+chars?\s*>/i,
  /<\s*truncated\b/i,
  /<\s*omitted\b/i,
  /\[\s*truncated\b/i,
];

type JsonRecord = Record<string, unknown>;

export type SparkIndexTableGuidRunner = (
  database: string,
  table: string,
) => unknown;
export type SparkIndexTableDdlRunner = (guid: string) => unknown;

export interface SparkIndexTableMcpGateOptions {
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => void;
}

/**
 * Serializes the two metadata MCP calls and applies a start-to-start delay.
 * A single gate can be shared by several SparkIndex task collections.
 */
export class SparkIndexTableMcpGate {
  private lastCallAt: number | undefined;

  private readonly minIntervalMs: number;

  private readonly now: () => number;

  private readonly sleep: (milliseconds: number) => void;

  public constructor(options: SparkIndexTableMcpGateOptions = {}) {
    this.minIntervalMs =
      options.minIntervalMs ?? DEFAULT_SPARKINDEX_TABLE_MCP_MIN_INTERVAL_MS;
    if (!Number.isFinite(this.minIntervalMs) || this.minIntervalMs < 0)
      throw new Error("SPARKINDEX_TABLE_MCP_MIN_INTERVAL_MUST_BE_NON_NEGATIVE");
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

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? undefined : trimmed;
}

function optionalString(record: JsonRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeIdentifierPart(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "`" && last === "`") || (first === '"' && last === '"'))
      return trimmed.slice(1, -1).trim();
  }
  if (trimmed.includes("`") || trimmed.includes('"')) return undefined;
  return trimmed;
}

/** Normalize a physical two-part name without adding schema/task-name guesses. */
export function normalizeSparkIndexQualifiedName(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const rawParts = value.trim().split(/\s*\.\s*/);
  if (rawParts.length !== 2) return undefined;
  const parts = rawParts.map(normalizeIdentifierPart);
  if (
    parts.some(
      (part) =>
        part === undefined ||
        part === "" ||
        part.includes("@") ||
        /\s/.test(part) ||
        !/^[A-Za-z0-9_$#-]+$/.test(part),
    )
  )
    return undefined;
  return `${parts[0]}.${parts[1]}`;
}

function normalizeDataSource(value: unknown): string | undefined {
  const normalized = nonEmptyString(value)?.toLowerCase();
  return normalized !== undefined && /^[a-z0-9_.#-]+$/.test(normalized)
    ? normalized
    : undefined;
}

export function sparkIndexStableTableKey(
  qualifiedName: string,
  dataSource: string = SPARKINDEX_TABLE_DATA_SOURCE,
): string {
  const normalizedName = normalizeSparkIndexQualifiedName(qualifiedName);
  const normalizedDataSource = normalizeDataSource(dataSource);
  if (normalizedName === undefined || normalizedDataSource === undefined)
    throw new Error("SPARKINDEX_TABLE_STABLE_KEY_INVALID");
  return `${normalizedName.toLowerCase()}@${normalizedDataSource}`;
}

function splitStableTableKey(stableKey: string): {
  readonly qualifiedName: string;
  readonly dataSource: string;
} {
  const separator = stableKey.lastIndexOf("@");
  if (separator <= 0 || separator === stableKey.length - 1)
    throw new Error("SPARKINDEX_TABLE_STABLE_KEY_INVALID");
  const qualifiedName = normalizeSparkIndexQualifiedName(
    stableKey.slice(0, separator),
  );
  const dataSource = normalizeDataSource(stableKey.slice(separator + 1));
  if (qualifiedName === undefined || dataSource === undefined)
    throw new Error("SPARKINDEX_TABLE_STABLE_KEY_INVALID");
  return { qualifiedName, dataSource };
}

function directQualifiedName(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeSparkIndexQualifiedName(value);
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const direct = normalizeSparkIndexQualifiedName(
    record.qualifiedName ??
      record.qualifiedname ??
      record.qualified_name ??
      record.targetTable ??
      record.target_table ??
      record.tableName ??
      record.table_name ??
      record.name,
  );
  if (direct !== undefined) return direct;
  for (const key of ["table", "target", "physicalTable", "physical_table"]) {
    const nested = directQualifiedName(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function directDataSource(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const direct = normalizeDataSource(
        record.dataSource ??
          record.datasource ??
          record.data_source ??
          record.dataSourceId ??
          record.data_source_id,
      );
  if (direct !== undefined) return direct;
  for (const key of ["table", "target", "physicalTable", "physical_table"]) {
    const nested = directDataSource(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function sqlContent(value: unknown): string | undefined {
  if (typeof value === "string")
    return nonEmptyString(value) === undefined ? undefined : value;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const content = record.content;
  return typeof content === "string" && nonEmptyString(content) !== undefined
    ? content
    : undefined;
}

function sqlInputs(
  taskEvidence: TaskEvidence,
): Partial<Record<SqlSlot, string>> {
  const result: Partial<Record<SqlSlot, string>> = {};
  for (const slot of SQL_SLOTS) {
    const content = sqlContent(taskEvidence.sql?.[slot]);
    if (content !== undefined) result[slot] = content;
  }
  return result;
}

export interface SparkIndexTableCandidate {
  readonly qualifiedName: string;
  readonly stableTableKey: string;
  readonly dataSourceConflict: boolean;
}

export function extractSparkIndexTableCandidates(
  taskEvidence: TaskEvidence,
): readonly SparkIndexTableCandidate[] {
  const candidates = new Map<
    string,
    { readonly qualifiedName: string; dataSourceConflict: boolean }
  >();
  const add = (value: unknown, dataSourceHint?: unknown): void => {
    const qualifiedName = directQualifiedName(value);
    if (qualifiedName === undefined) return;
    const dataSource = normalizeDataSource(dataSourceHint);
    const dataSourceConflict =
      dataSourceHint !== undefined &&
      nonEmptyString(dataSourceHint) !== undefined &&
      dataSource !== SPARKINDEX_TABLE_DATA_SOURCE;
    const key = qualifiedName.toLowerCase();
    const existing = candidates.get(key);
    if (existing === undefined)
      candidates.set(key, { qualifiedName, dataSourceConflict });
    else if (dataSourceConflict && !existing.dataSourceConflict)
      candidates.set(key, { ...existing, dataSourceConflict: true });
  };

  add(taskEvidence.target, directDataSource(taskEvidence.target));
  const sql = sqlInputs(taskEvidence);
  for (const qualifiedName of Object.values(sql).flatMap((content) =>
    extractSqlReadTableNames(content ?? ""),
  ))
    add(qualifiedName);
  for (const qualifiedName of extractSqlWriteTableNames(sql)) add(qualifiedName);

  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      stableTableKey: sparkIndexStableTableKey(candidate.qualifiedName),
    }))
    .sort((left, right) =>
      left.stableTableKey.localeCompare(right.stableTableKey),
    );
}

interface SnapshotTableMetadata {
  readonly qualifiedName: string;
  readonly dataSource: string;
  readonly platform: string;
  readonly objectType: string;
  readonly status: string;
  readonly schema: string;
  readonly name: string;
}

interface SnapshotCatalog {
  readonly records: ReadonlyMap<string, readonly SnapshotTableMetadata[]>;
}

interface SnapshotCacheEntry {
  readonly statSignature: string;
  readonly catalog: SnapshotCatalog | undefined;
}

const snapshotCache = new Map<string, SnapshotCacheEntry>();

function metadataFromSnapshotRecord(
  record: JsonRecord,
): SnapshotTableMetadata | undefined {
  const qualifiedName = normalizeSparkIndexQualifiedName(
    record.qualifiedname_clean,
  );
  const dataSource = normalizeDataSource(record.datasource);
  const status = nonEmptyString(record.status)?.toUpperCase();
  if (
    qualifiedName === undefined ||
    dataSource === undefined ||
    status === undefined
  )
    return undefined;
  const parts = qualifiedName.split(".");
  return {
    qualifiedName,
    dataSource,
    platform: "hive",
    objectType: nonEmptyString(record.type_name) ?? "hive_table",
    status,
    schema: parts[0]!,
    name: parts[1]!,
  };
}

function loadSnapshot(path: string): SnapshotCatalog | undefined {
  const absolutePath = resolve(path);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      snapshotCache.set(absolutePath, {
        statSignature: "MISSING",
        catalog: undefined,
      });
      return undefined;
    }
    throw new Error(`SPARKINDEX_METADATA_SNAPSHOT_READ_FAILED:${absolutePath}`, {
      cause: error,
    });
  }
  if (!stat.isFile())
    throw new Error(`SPARKINDEX_METADATA_SNAPSHOT_NOT_A_FILE:${absolutePath}`);
  const statSignature = [stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  const cached = snapshotCache.get(absolutePath);
  if (cached?.statSignature === statSignature) return cached.catalog;
  let content: string;
  try {
    content = readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`SPARKINDEX_METADATA_SNAPSHOT_READ_FAILED:${absolutePath}`, {
      cause: error,
    });
  }
  const records = new Map<string, SnapshotTableMetadata[]>();
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const metadata = metadataFromSnapshotRecord(asRecord(parsed) ?? {});
    if (metadata === undefined) continue;
    const key = sparkIndexStableTableKey(
      metadata.qualifiedName,
      metadata.dataSource,
    );
    const existing = records.get(key) ?? [];
    existing.push(metadata);
    records.set(key, existing);
  }
  const catalog = { records };
  snapshotCache.set(absolutePath, { statSignature, catalog });
  return catalog;
}

function snapshotMetadata(
  catalog: SnapshotCatalog | undefined,
  candidate: SparkIndexTableCandidate,
): SnapshotTableMetadata | undefined {
  if (catalog === undefined) return undefined;
  const entries = [...catalog.records.values()]
    .flat()
    .filter(
      (entry) =>
        entry.qualifiedName.toLowerCase() === candidate.qualifiedName.toLowerCase(),
    );
  const active = entries.filter(
    (entry) =>
      entry.status === "ACTIVE" &&
      entry.dataSource === SPARKINDEX_TABLE_DATA_SOURCE,
  );
  return active.length === 1 ? active[0] : undefined;
}

function snapshotUnavailableReason(
  catalog: SnapshotCatalog | undefined,
  candidate: SparkIndexTableCandidate,
): string | undefined {
  if (catalog === undefined) return "SNAPSHOT_UNAVAILABLE";
  const entries = [...catalog.records.values()]
    .flat()
    .filter(
      (entry) =>
        entry.qualifiedName.toLowerCase() ===
          candidate.qualifiedName.toLowerCase(),
    );
  const activeGfHive = entries.filter(
    (entry) =>
      entry.status === "ACTIVE" &&
      entry.dataSource === SPARKINDEX_TABLE_DATA_SOURCE,
  );
  if (activeGfHive.length > 1) return "SNAPSHOT_AMBIGUOUS_ACTIVE";
  if (activeGfHive.length === 1) return undefined;
  if (entries.some((entry) => entry.status === "ACTIVE"))
    return "SNAPSHOT_DATASOURCE_NOT_GFHIVE";
  return "SNAPSHOT_NO_UNIQUE_ACTIVE";
}

interface LocalTablePack {
  readonly evidence: TableEvidence;
  readonly contentHash: string;
}

function localTableEvidence(
  document: TableDocument,
  ddl: string,
): TableEvidence {
  const ddlFile = document.ddlFile as JsonRecord;
  const value = (key: string): unknown => document[key];
  const arrayValue = (key: string): readonly string[] | undefined => {
    const raw = value(key);
    return Array.isArray(raw) ? raw.map(String) : undefined;
  };
  return {
    platform: document.platform,
    dataSource: document.dataSource,
    qualifiedName: document.qualifiedName,
    schema: nonEmptyString(value("schema")),
    name: nonEmptyString(value("name")),
    description: nonEmptyString(value("description")),
    objectType: document.objectType,
    status: nonEmptyString(value("status")),
    primaryKey: arrayValue("primaryKey"),
    partitionFields: arrayValue("partitionFields"),
    ddl,
    evidenceProvider:
      nonEmptyString(value("evidenceProvider")) ??
      nonEmptyString(ddlFile.evidenceProvider) ??
      "local:table-pack",
    collectedAt: nonEmptyString(value("collectedAt")),
  };
}

function loadLocalTablePacks(
  dataRoot: string,
): ReadonlyMap<string, readonly LocalTablePack[]> {
  const result = new Map<string, LocalTablePack[]>();
  const tablesRoot = join(resolve(dataRoot), "tables");
  if (!existsSync(tablesRoot)) return result;
  for (const platformEntry of readdirSync(tablesRoot, { withFileTypes: true })) {
    if (!platformEntry.isDirectory()) continue;
    const platformRoot = join(tablesRoot, platformEntry.name);
    for (const tableEntry of readdirSync(platformRoot, { withFileTypes: true })) {
      if (!tableEntry.isDirectory()) continue;
      const tableRoot = join(platformRoot, tableEntry.name);
      try {
        const documentValue: unknown = JSON.parse(
          readFileSync(join(tableRoot, "table.json"), "utf8"),
        );
        validateTableDocument(documentValue);
        const document = documentValue as TableDocument;
        const ddlPath = join(
          tableRoot,
          String((document.ddlFile as JsonRecord).path),
        );
        const ddl = readFileSync(ddlPath, "utf8");
        const ddlHash = (document.ddlFile as JsonRecord).sha256;
        if (typeof ddlHash !== "string" || sha256File(ddlPath) !== ddlHash)
          continue;
        const qualifiedName = normalizeSparkIndexQualifiedName(
          document.qualifiedName,
        );
        const dataSource = normalizeDataSource(document.dataSource);
        if (qualifiedName === undefined || dataSource === undefined) continue;
        const evidence = localTableEvidence(document, ddl);
        const key = sparkIndexStableTableKey(qualifiedName, dataSource);
        const entries = result.get(key) ?? [];
        entries.push({ evidence, contentHash: document.contentHash });
        result.set(key, entries);
      } catch {
        // Invalid/incomplete Table Packs are cache misses and may be refreshed.
      }
    }
  }
  return result;
}

function uniqueLocalTablePack(
  packs: readonly LocalTablePack[] | undefined,
): LocalTablePack | undefined {
  if (packs === undefined || packs.length === 0) return undefined;
  const unique = new Map<string, LocalTablePack>();
  for (const pack of packs) {
    const key = `${pack.contentHash}:${sha256Text(pack.evidence.ddl)}`;
    unique.set(key, pack);
  }
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function tableEvidenceFromMetadata(
  metadata: SnapshotTableMetadata,
  ddl: string,
  evidenceProvider: string,
  collectedAt?: string,
  details: Readonly<{
    readonly partitionFields?: readonly string[];
    readonly primaryKey?: readonly string[];
  }> = {},
): TableEvidence {
  return {
    platform: metadata.platform,
    dataSource: metadata.dataSource,
    qualifiedName: metadata.qualifiedName,
    schema: metadata.schema,
    name: metadata.name,
    objectType: metadata.objectType,
    status: metadata.status,
    partitionFields: details.partitionFields,
    primaryKey: details.primaryKey,
    ddl,
    evidenceProvider,
    collectedAt,
  };
}

function maskSql(sql: string): string {
  const output = [...sql];
  let state: "normal" | "singleQuote" | "lineComment" | "blockComment" =
    "normal";
  for (let index = 0; index < output.length; index += 1) {
    const current = sql[index]!;
    const next = sql[index + 1];
    if (state === "normal") {
      if (current === "'") {
        output[index] = " ";
        state = "singleQuote";
      } else if (current === "-" && next === "-") {
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
        state = "lineComment";
      } else if (current === "/" && next === "*") {
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
        state = "blockComment";
      }
      continue;
    }
    if (state === "singleQuote") {
      if (current === "\n" || current === "\r") continue;
      output[index] = " ";
      if (current === "\\" && index + 1 < output.length) {
        output[index + 1] = " ";
        index += 1;
      } else if (current === "'" && next === "'") {
        output[index + 1] = " ";
        index += 1;
      } else if (current === "'") state = "normal";
      continue;
    }
    if (state === "lineComment") {
      if (current === "\n" || current === "\r") state = "normal";
      else output[index] = " ";
      continue;
    }
    if (current === "*" && next === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 1;
      state = "normal";
    } else if (current !== "\n" && current !== "\r") output[index] = " ";
  }
  return output.join("");
}

const CREATE_PATTERN =
  /\bcreate\s+(?:(?:or\s+replace)\s+)?(?:(?:temporary|external)\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$#-]+)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z0-9_$#-]+))?)/gi;

function sqlStatementEnd(sql: string, start: number): number {
  let state: "normal" | "singleQuote" | "lineComment" | "blockComment" =
    "normal";
  for (let index = start; index < sql.length; index += 1) {
    const current = sql[index]!;
    const next = sql[index + 1];
    if (state === "normal") {
      if (current === "'") state = "singleQuote";
      else if (current === "-" && next === "-") {
        state = "lineComment";
        index += 1;
      } else if (current === "/" && next === "*") {
        state = "blockComment";
        index += 1;
      } else if (current === ";") return index + 1;
      continue;
    }
    if (state === "singleQuote") {
      if (current === "\\") index += 1;
      else if (current === "'" && next === "'") index += 1;
      else if (current === "'") state = "normal";
      continue;
    }
    if (state === "lineComment") {
      if (current === "\n" || current === "\r") state = "normal";
      continue;
    }
    if (current === "*" && next === "/") {
      state = "normal";
      index += 1;
    }
  }
  return sql.length;
}

function balancedParentheses(masked: string): boolean {
  let depth = 0;
  for (const character of masked) {
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function isCompleteCreateSql(sql: string, targetEnd: number): boolean {
  if (TRUNCATION_MARKERS.some((marker) => marker.test(sql))) return false;
  const masked = maskSql(sql);
  if (!balancedParentheses(masked)) return false;
  const body = masked.slice(targetEnd).trim();
  return (
    body !== "" &&
    /(?:\(|\bas\b|\blike\b|\bstored\s+as\b|\blocation\b|\btblproperties\b)/i.test(
      body,
    )
  );
}

function createStatementTargetMatches(
  rawTarget: string | undefined,
  qualifiedName: string,
  defaultSchema: TaskDefaultSchema | null,
): boolean {
  if (rawTarget === undefined) return false;
  const parsed = normalizeSparkIndexQualifiedName(rawTarget);
  if (parsed !== undefined)
    return parsed.toLowerCase() === qualifiedName.toLowerCase();
  const tableOnly = normalizeIdentifierPart(rawTarget.trim());
  if (tableOnly === undefined || tableOnly.includes(".")) return false;
  if (defaultSchema === null) return false;
  return qualifyBareTableName(tableOnly, defaultSchema) === qualifiedName.toLowerCase();
}

function exactCreateStatements(
  sql: string,
  qualifiedName: string,
  defaultSchema: TaskDefaultSchema | null,
): readonly string[] {
  const masked = maskSql(sql);
  const statements: string[] = [];
  CREATE_PATTERN.lastIndex = 0;
  for (const match of masked.matchAll(CREATE_PATTERN)) {
    const rawTarget = match[1];
    if (!createStatementTargetMatches(rawTarget, qualifiedName, defaultSchema)) continue;
    const start = match.index ?? 0;
    const targetEnd = start + match[0].indexOf(rawTarget ?? "") + (rawTarget?.length ?? 0);
    const end = sqlStatementEnd(sql, start);
    const statement = sql.slice(start, end).trim();
    if (isCompleteCreateSql(statement, targetEnd - start)) statements.push(statement);
  }
  return statements;
}

function uniqueCreateStatement(
  statements: readonly string[],
): { readonly ddl?: string; readonly conflict: boolean } {
  const unique = new Map<string, string>();
  for (const statement of statements) unique.set(statement.trim(), statement);
  if (unique.size > 1) return { conflict: true };
  return { ddl: [...unique.values()][0], conflict: false };
}

export function uniqueTaskSqlCreateStatement(
  sql: Partial<Record<SqlSlot, string>>,
  qualifiedName: string,
  defaultSchema: TaskDefaultSchema | null = null,
): { readonly ddl?: string; readonly conflict: boolean } {
  return uniqueCreateStatement(
    Object.values(sql).flatMap((content) =>
      exactCreateStatements(content ?? "", qualifiedName, defaultSchema),
    ),
  );
}

function resultRows(value: unknown): readonly JsonRecord[] {
  if (Array.isArray(value))
    return value.filter((item): item is JsonRecord => asRecord(item) !== undefined);
  const record = asRecord(value);
  if (record === undefined) return [];
  for (const key of ["records", "rows", "items", "results", "data"]) {
    const nested = record[key];
    if (nested !== undefined && nested !== value) {
      const rows = resultRows(nested);
      if (rows.length > 0 || Array.isArray(nested)) return rows;
    }
  }
  return [record];
}

function nestedClusterDataSource(record: JsonRecord): unknown {
  const cluster = asRecord(record.cluster);
  return cluster?.clusterName ?? cluster?.name;
}

function rowDataSource(record: JsonRecord): string | undefined {
  return normalizeDataSource(
    record.dataSource ??
      record.datasource ??
      record.data_source ??
      record.dataSourceId ??
      record.data_source_id ??
      nestedClusterDataSource(record),
  );
}

function rawRowQualifiedName(record: JsonRecord): unknown {
  return (
    record.qualifiedName ??
    record.qualifiedname ??
    record.qualified_name ??
    record.qname
  );
}

interface ExternalRowIdentity {
  readonly qualifiedName?: string;
  readonly dataSource?: string;
  readonly reason?: "MISSING" | "MISMATCH";
}

/**
 * The external metadata contract may decorate qname as db.table@datasource.
 * Strip that decoration only at this response boundary; Task SQL names keep
 * the stricter two-part parser above.
 */
function externalRowIdentity(record: JsonRecord): ExternalRowIdentity {
  const raw = rawRowQualifiedName(record);
  if (typeof raw !== "string") return { reason: "MISSING" };
  const trimmed = raw.trim();
  const separator = trimmed.lastIndexOf("@");
  const baseName = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const suffix = separator < 0 ? undefined : trimmed.slice(separator + 1);
  const qualifiedName = normalizeSparkIndexQualifiedName(baseName);
  const suffixDataSource =
    suffix === undefined ? undefined : normalizeDataSource(suffix);
  if (
    qualifiedName === undefined ||
    (suffix !== undefined && suffixDataSource === undefined)
  )
    return { reason: "MISMATCH" };
  const returnedDataSource = rowDataSource(record);
  if (
    suffixDataSource !== undefined &&
    returnedDataSource !== undefined &&
    suffixDataSource !== returnedDataSource
  )
    return { reason: "MISMATCH" };
  return {
    qualifiedName,
    dataSource: returnedDataSource ?? suffixDataSource,
  };
}

interface TableLocator {
  readonly guid: string;
  readonly qualifiedName: string;
  readonly dataSource: string;
}

function parseTableLocator(
  value: unknown,
  candidate: SparkIndexTableCandidate,
): { readonly locator?: TableLocator; readonly reason?: string } {
  const rows = resultRows(value);
  if (rows.length !== 1) return { reason: "MCP_TABLE_GUID_NOT_UNIQUE" };
  const row = rows[0]!;
  const guid = optionalString(row, ["guid"]);
  const identity = externalRowIdentity(row);
  if (identity.reason === "MISMATCH")
    return { reason: "MCP_TABLE_GUID_IDENTITY_MISMATCH" };
  const qualifiedName = identity.qualifiedName;
  const dataSource = identity.dataSource;
  if (guid === undefined || qualifiedName === undefined || dataSource === undefined)
    return { reason: "MCP_TABLE_GUID_IDENTITY_MISSING" };
  if (
    sparkIndexStableTableKey(qualifiedName, dataSource) !==
    candidate.stableTableKey
  )
    return { reason: "MCP_TABLE_GUID_IDENTITY_MISMATCH" };
  return { locator: { guid, qualifiedName, dataSource } };
}

function partitionFields(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value)) {
    const values = value.map(nonEmptyString).filter(
      (item): item is string => item !== undefined,
    );
    return values.length === 0 ? undefined : values;
  }
  const text = nonEmptyString(value);
  if (text === undefined) return undefined;
  const values = text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "" && item !== "-");
  return values.length === 0 ? undefined : values;
}

function primaryKeyFields(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(nonEmptyString).filter(
    (item): item is string => item !== undefined,
  );
  return values.length === 0 ? undefined : values;
}

function tableEvidenceFromDdlResponse(
  value: unknown,
  candidate: SparkIndexTableCandidate,
  locator: TableLocator,
  metadata: SnapshotTableMetadata,
  collectedAt: string,
): { readonly evidence?: TableEvidence; readonly reason?: string } {
  const rows = resultRows(value);
  if (rows.length !== 1) return { reason: "MCP_TABLE_DDL_NOT_UNIQUE" };
  const row = rows[0]!;
  const identity = externalRowIdentity(row);
  if (identity.reason === "MISMATCH")
    return { reason: "MCP_TABLE_DDL_IDENTITY_MISMATCH" };
  const qualifiedName = identity.qualifiedName;
  const returnedDataSource = identity.dataSource;
  if (qualifiedName === undefined)
    return { reason: "MCP_TABLE_DDL_QNAME_MISSING" };
  if (
    qualifiedName.toLowerCase() !== candidate.qualifiedName.toLowerCase() ||
    (returnedDataSource !== undefined &&
      returnedDataSource !== locator.dataSource)
  )
    return { reason: "MCP_TABLE_DDL_IDENTITY_MISMATCH" };
  const ddl = row.ddl;
  if (
    typeof ddl !== "string" ||
    nonEmptyString(ddl) === undefined ||
    TRUNCATION_MARKERS.some((marker) => marker.test(ddl))
  )
    return { reason: "MCP_TABLE_DDL_INVALID" };
  const rowType = nonEmptyString(row.type);
  const rowMetadata = rowType ? { ...metadata, objectType: rowType } : metadata;
  return {
    evidence: tableEvidenceFromMetadata(
      { ...rowMetadata, qualifiedName: candidate.qualifiedName },
      ddl,
      "opencli:szdata.table-guid+table-ddl",
      collectedAt,
      {
        partitionFields: partitionFields(row.partition),
        primaryKey: primaryKeyFields(row.primaryKey),
      },
    ),
  };
}

function configuredMcpInterval(): number {
  const raw =
    process.env.INPUT_PACK_SPARKINDEX_TABLE_MCP_MIN_INTERVAL_MS ??
    process.env.INPUT_PACK_OPENCLI_MIN_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_SPARKINDEX_TABLE_MCP_MIN_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0)
    throw new Error(
      "INPUT_PACK_SPARKINDEX_TABLE_MCP_MIN_INTERVAL_MS must be non-negative",
    );
  return value;
}

let sharedDefaultTableMcpGate: SparkIndexTableMcpGate | undefined;

function defaultTableMcpGate(): SparkIndexTableMcpGate {
  if (sharedDefaultTableMcpGate === undefined)
    sharedDefaultTableMcpGate = new SparkIndexTableMcpGate({
      minIntervalMs: configuredMcpInterval(),
    });
  return sharedDefaultTableMcpGate;
}

function mcpFailureReason(step: string, error: unknown): string {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  const normalized = detail.replace(/\s+/g, " ").trim();
  return `${step}:${(normalized === "" ? "UNKNOWN" : normalized).slice(0, 512)}`;
}

function snapshotFailureReason(error: unknown): string {
  return mcpFailureReason("SNAPSHOT_UNAVAILABLE", error);
}

function openCliJson(args: readonly string[]): unknown {
  const timeoutRaw = process.env.INPUT_PACK_OPENCLI_TIMEOUT_MS;
  const timeoutMs =
    timeoutRaw === undefined || timeoutRaw.trim() === ""
      ? 30_000
      : Number(timeoutRaw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("INPUT_PACK_OPENCLI_TIMEOUT_MS must be positive");
  const appData = process.env.APPDATA;
  const installedEntry = appData
    ? join(
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
  const executableArgs = useInstalledEntry
    ? [installedEntry!, ...args]
    : process.platform === "win32"
      ? ["/d", "/s", "/c", "opencli.cmd", ...args]
      : [...args];
  const output = execFileSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error("SZDATA_TABLE_MCP_JSON_INVALID", { cause: error });
  }
}

export function sparkIndexTableGuidCommandArguments(
  database: string,
  table: string,
): readonly string[] {
  return [
    "szdata",
    "table-guid",
    "--db",
    database,
    "--table",
    table,
    "-f",
    "json",
  ];
}

export function sparkIndexTableDdlCommandArguments(
  guid: string,
): readonly string[] {
  return ["szdata", "table-ddl", "--guid", guid, "-f", "json"];
}

function runTableGuid(database: string, table: string): unknown {
  return openCliJson(sparkIndexTableGuidCommandArguments(database, table));
}

function runTableDdl(guid: string): unknown {
  return openCliJson(sparkIndexTableDdlCommandArguments(guid));
}

export interface SparkIndexTableMaterializationOptions {
  /** null explicitly disables snapshot gating for isolated tests only. */
  readonly metadataSnapshotPath?: string | null;
  readonly runTableGuid?: SparkIndexTableGuidRunner;
  readonly runTableDdl?: SparkIndexTableDdlRunner;
  readonly tableMcpGate?: SparkIndexTableMcpGate;
  readonly tableMcpMinIntervalMs?: number;
  readonly now?: () => Date;
}

export interface SparkIndexTableResolution {
  readonly candidates: readonly SparkIndexTableCandidate[];
  readonly resolved: readonly {
    readonly candidate: SparkIndexTableCandidate;
    readonly evidence: TableEvidence;
    readonly source: string;
  }[];
  readonly unavailable: readonly {
    readonly candidate: SparkIndexTableCandidate;
    readonly reason: string;
  }[];
}

function resolvedFromLocalPack(
  candidate: SparkIndexTableCandidate,
  pack: LocalTablePack,
): { readonly candidate: SparkIndexTableCandidate; readonly evidence: TableEvidence; readonly source: string } {
  return {
    candidate,
    evidence: {
      ...pack.evidence,
      qualifiedName: candidate.qualifiedName,
      dataSource: SPARKINDEX_TABLE_DATA_SOURCE,
      guid: undefined,
    },
    source: "local:table-pack",
  };
}

export function resolveSparkIndexTables(
  dataRoot: string,
  taskEvidence: TaskEvidence,
  options: SparkIndexTableMaterializationOptions = {},
): SparkIndexTableResolution {
  const candidates = extractSparkIndexTableCandidates(taskEvidence);
  const snapshotPath =
    options.metadataSnapshotPath === null
      ? undefined
      : options.metadataSnapshotPath ?? DEFAULT_HIVE_METADATA_SNAPSHOT_PATH;
  let snapshot: SnapshotCatalog | undefined;
  let snapshotLoadError: string | undefined;
  if (snapshotPath !== undefined) {
    try {
      snapshot = loadSnapshot(snapshotPath);
    } catch (error) {
      snapshotLoadError = snapshotFailureReason(error);
    }
  }
  const localPacks = loadLocalTablePacks(dataRoot);
  const sql = sqlInputs(taskEvidence);
  const resolved: Array<{
    readonly candidate: SparkIndexTableCandidate;
    readonly evidence: TableEvidence;
    readonly source: string;
  }> = [];
  const unavailable: Array<{
    readonly candidate: SparkIndexTableCandidate;
    readonly reason: string;
  }> = [];
  const mcpResults = new Map<
    string,
    | { readonly evidence: TableEvidence; readonly source: string }
    | { readonly reason: string }
  >();
  let mcpAbortedReason: string | undefined;
  const gate =
    options.tableMcpGate ??
    (options.tableMcpMinIntervalMs === undefined
      ? defaultTableMcpGate()
      : new SparkIndexTableMcpGate({
          minIntervalMs: options.tableMcpMinIntervalMs,
        }));
  const tableGuid = options.runTableGuid ?? runTableGuid;
  const tableDdl = options.runTableDdl ?? runTableDdl;
  const collectedAt = (options.now ?? (() => new Date()))().toISOString();

  for (const candidate of candidates) {
    if (candidate.dataSourceConflict) {
      unavailable.push({
        candidate,
        reason: "TARGET_DATASOURCE_CONFLICT",
      });
      continue;
    }
    const localPack = uniqueLocalTablePack(
      localPacks.get(candidate.stableTableKey),
    );
    if (localPack !== undefined) {
      resolved.push(resolvedFromLocalPack(candidate, localPack));
      continue;
    }
    if ((localPacks.get(candidate.stableTableKey)?.length ?? 0) > 1) {
      unavailable.push({ candidate, reason: "LOCAL_TABLE_PACK_CONFLICT" });
      continue;
    }

    const snapshotReason =
      snapshotLoadError ?? snapshotUnavailableReason(snapshot, candidate);
    if (snapshotReason !== undefined) {
      unavailable.push({ candidate, reason: snapshotReason });
      continue;
    }
    const metadata = snapshotMetadata(snapshot, candidate);
    if (metadata === undefined) {
      unavailable.push({ candidate, reason: "SNAPSHOT_UNAVAILABLE" });
      continue;
    }

    const creates = uniqueTaskSqlCreateStatement(
      sql, candidate.qualifiedName, inferTaskDefaultSchema(taskEvidence),
    );
    if (creates.conflict) {
      unavailable.push({ candidate, reason: "SQL_CREATE_CONFLICT" });
      continue;
    }
    if (creates.ddl !== undefined) {
      resolved.push({
        candidate,
        evidence: tableEvidenceFromMetadata(
          metadata,
          creates.ddl,
          "input-pack:task-sql-create",
          collectedAt,
        ),
        source: "input-pack:task-sql-create",
      });
      continue;
    }

    const previousMcp = mcpResults.get(candidate.stableTableKey);
    if (previousMcp !== undefined) {
      if ("evidence" in previousMcp)
        resolved.push({ candidate, ...previousMcp });
      else unavailable.push({ candidate, reason: previousMcp.reason });
      continue;
    }

    if (mcpAbortedReason !== undefined) {
      const reason = `MCP_ABORTED_AFTER_ERROR:${mcpAbortedReason}`;
      mcpResults.set(candidate.stableTableKey, { reason });
      unavailable.push({ candidate, reason });
      continue;
    }

    const { qualifiedName } = splitStableTableKey(candidate.stableTableKey);
    const parts = qualifiedName.split(".");
    let locatorResponse: unknown;
    try {
      gate.beforeCall();
      locatorResponse = tableGuid(parts[0]!, parts[1]!);
    } catch (error) {
      const reason = mcpFailureReason("MCP_TABLE_GUID_FAILED", error);
      mcpAbortedReason = reason;
      mcpResults.set(candidate.stableTableKey, { reason });
      unavailable.push({ candidate, reason });
      continue;
    }
    const locatorResult = parseTableLocator(locatorResponse, candidate);
    if (locatorResult.locator === undefined) {
      mcpResults.set(candidate.stableTableKey, {
        reason: locatorResult.reason ?? "MCP_TABLE_GUID_INVALID",
      });
      unavailable.push({
        candidate,
        reason: locatorResult.reason ?? "MCP_TABLE_GUID_INVALID",
      });
      continue;
    }
    let ddlResponse: unknown;
    try {
      gate.beforeCall();
      ddlResponse = tableDdl(locatorResult.locator.guid);
    } catch (error) {
      const reason = mcpFailureReason("MCP_TABLE_DDL_FAILED", error);
      mcpAbortedReason = reason;
      mcpResults.set(candidate.stableTableKey, { reason });
      unavailable.push({ candidate, reason });
      continue;
    }
    const ddlResult = tableEvidenceFromDdlResponse(
      ddlResponse,
      candidate,
      locatorResult.locator,
      metadata,
      collectedAt,
    );
    if (ddlResult.evidence === undefined) {
      mcpResults.set(candidate.stableTableKey, {
        reason: ddlResult.reason ?? "MCP_TABLE_DDL_INVALID",
      });
      unavailable.push({
        candidate,
        reason: ddlResult.reason ?? "MCP_TABLE_DDL_INVALID",
      });
      continue;
    }
    const mcpEvidence = ddlResult.evidence;
    const mcpResult = {
      evidence: mcpEvidence,
      source: "opencli:szdata.table-guid+table-ddl",
    } as const;
    mcpResults.set(candidate.stableTableKey, mcpResult);
    resolved.push({ candidate, ...mcpResult });
  }

  return { candidates, resolved, unavailable };
}

export interface SparkIndexMaterializationResult {
  readonly taskEvidence: TaskEvidence;
  readonly resolution: SparkIndexTableResolution;
  readonly materialized: TaskTableMaterializationResult;
  readonly collectionStatus: "SUCCESS" | "PARTIAL";
}

export function materializeSparkIndexTaskAndTables(
  dataRoot: string,
  taskEvidence: TaskEvidence,
  options: SparkIndexTableMaterializationOptions = {},
): SparkIndexMaterializationResult {
  const resolution = resolveSparkIndexTables(dataRoot, taskEvidence, options);
  const directTarget = directQualifiedName(taskEvidence.target);
  const resolvedTarget = resolution.resolved.find(
    (item) =>
      directTarget !== undefined &&
      item.candidate.qualifiedName.toLowerCase() === directTarget.toLowerCase(),
  );
  const enrichedTaskEvidence: TaskEvidence =
    resolvedTarget === undefined
      ? taskEvidence
      : {
          ...taskEvidence,
          target: {
            platform: resolvedTarget.evidence.platform,
            qualifiedName: resolvedTarget.evidence.qualifiedName,
            dataSource: resolvedTarget.evidence.dataSource,
          },
          targetEvidenceKind: "DIRECT_PLATFORM_TARGET",
        };
  const materialized = materializeTaskAndTablePacks(
    dataRoot,
    enrichedTaskEvidence,
    resolution.resolved.map((item) => item.evidence),
  );
  const collectionStatus =
    Object.keys(enrichedTaskEvidence.sql ?? {}).length > 0 &&
    resolution.candidates.length > 0 &&
    resolution.unavailable.length === 0
      ? "SUCCESS"
      : "PARTIAL";
  return {
    taskEvidence: enrichedTaskEvidence,
    resolution,
    materialized,
    collectionStatus,
  };
}

export function isSafeSparkIndexTaskId(taskId: string): boolean {
  return SAFE_TASK_ID.test(taskId);
}
