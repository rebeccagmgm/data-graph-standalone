import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  sha256File,
  sha256Text,
  validateTableDocument,
  type SqlSlot,
  type TableDocument,
  type TableEvidence,
  type TaskEvidence,
} from "./input-pack.ts";
import {
  assertJsonlCatalogPath,
  loadJsonlOffsetIndex,
  lookupJsonlByKey,
  type JsonlKeyLookup,
  type JsonlOffsetIndex,
} from "./jsonl-offset-index.ts";
import { uniqueTaskSqlCreateStatement } from "./sparkindex-table-evidence.ts";
import { inferTaskDefaultSchema, type TaskDefaultSchema } from "../../reconcile/shared/task-default-schema.ts";
import { extractSqlWriteTableNames } from "./sql-target-evidence.ts";
import {
  columnNamesFromCreateTable,
  extractSqlReadTableNames,
  isSoleStarSelectQuery,
  queryOutputColumnNames,
  queryProjectionColumnNames,
  uniqueQueryFromQualifiedName,
} from "./sql-table-references.ts";
import {
  isDatabaseSourceToHiveTask,
  partitionFieldsFromDdl,
} from "./task-partition-evidence.ts";
import {
  loadHoraeDatasourceIndex,
  isKnownHoraeDatasourceLabel,
  preferredRdbmsDataSourceFromTaskSource,
  type HoraeDatasourceIndex,
} from "./horae-datasource-cache.ts";
import { DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT } from "../../evidence/schedule-evidence-cache.ts";

export const DEFAULT_HIVE_METADATA_JSONL_PATH =
  "E:\\02_area\\股衍数据-数据cookbook\\数综基础信息\\原信息\\hive元信息-20260831快照\\hive_table_restored.jsonl";
export const DEFAULT_HIVE_DDL_JSONL_PATH =
  "E:\\02_area\\股衍数据-数据cookbook\\数综基础信息\\原信息\\20260830211426ddl\\hive_table_ddl_restored.jsonl";
export const DEFAULT_RDBMS_CORE_JSONL_PATH =
  "E:\\02_area\\股衍数据-数据cookbook\\数综基础信息\\原信息\\RDBMS核心信息\\gf_rdbms_table_core_restored.jsonl";
export const DEFAULT_RDBMS_DDL_JSONL_PATH =
  "E:\\02_area\\股衍数据-数据cookbook\\数综基础信息\\原信息\\关系ddl-实际\\gf_rdbms_table_ddl_restored.jsonl";

const SQL_SLOTS: readonly SqlSlot[] = [
  "create",
  "query",
  "prepare",
  "truncate",
  "finish",
];
const HIVE_DATA_SOURCE = "gfhive";
export const SPLICED_FROM_QUERY_PROJECTION =
  "input-pack:spliced-from-query-projection";
export const SPLICED_FROM_TASK_SQL = "input-pack:spliced-from-task-sql";
export const SPLICED_FROM_HIVE_TARGET_CREATE =
  "input-pack:spliced-from-hive-target-create";
export const SPLICED_FROM_SOURCE_DDL = "input-pack:spliced-from-source-ddl";

export function isSplicedTableEvidenceProvider(
  provider: string | undefined,
): boolean {
  return provider?.startsWith("input-pack:spliced-") === true;
}

type JsonRecord = Record<string, unknown>;

export interface OfflineTableCatalogPaths {
  readonly hiveMetadataPath?: string;
  readonly hiveDdlPath?: string;
  readonly rdbmsCorePath?: string;
  readonly rdbmsDdlPath?: string;
  readonly indexDir?: string;
  /** schedule-evidence cache root; used to load horae-datasource map */
  readonly scheduleEvidenceCacheRoot?: string;
  /** skip loading horae-datasource (tests) */
  readonly horaeDatasource?: HoraeDatasourceIndex | null;
}

export interface OfflineTableCatalog {
  readonly hiveMetadata?: JsonlOffsetIndex;
  readonly hiveDdl?: JsonlOffsetIndex;
  readonly rdbmsCore?: JsonlOffsetIndex;
  readonly rdbmsDdl?: JsonlOffsetIndex;
  readonly horaeDatasource?: HoraeDatasourceIndex;
  /**
   * Secondary index: `${schema.table}#${service}` → concrete
   * `schema.table@gforacle_…#service` key (or AMBIGUOUS if several).
   */
  readonly rdbmsQnServiceIndex?: ReadonlyMap<string, string | "AMBIGUOUS">;
  /**
   * All concrete `schema.table@dataSource` keys per bare qualified name.
   * Used to uniquely pick no-`#` MySQL / StarRocks / GoldenDB atlas rows.
   */
  readonly rdbmsQnAtlasKeys?: ReadonlyMap<string, readonly string[]>;
}

export interface OfflineTableCandidate {
  readonly qualifiedName: string;
  readonly dataSource?: string;
}

export interface OfflineTableResolution {
  readonly candidates: readonly OfflineTableCandidate[];
  readonly resolved: readonly TableEvidence[];
  readonly unavailable: readonly {
    readonly qualifiedName: string;
    readonly reason: string;
  }[];
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

export function parsePhysicalTableName(
  value: unknown,
): OfflineTableCandidate | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "-") return undefined;
    const separator = trimmed.lastIndexOf("@");
    const base = separator > 0 ? trimmed.slice(0, separator) : trimmed;
    const rawDataSource =
      separator > 0 ? nonEmptyString(trimmed.slice(separator + 1)) : undefined;
    const dataSource = rawDataSource?.replace(/:\d+$/, "");
    const parts = base.split(/\s*\.\s*/).map(normalizeIdentifierPart);
    if (
      parts.length !== 2 ||
      parts.some(
        (part) =>
          part === undefined ||
          part === "" ||
          /\s/.test(part) ||
          !/^[A-Za-z0-9_$#-]+$/.test(part),
      )
    )
      return undefined;
    return {
      qualifiedName: `${parts[0]}.${parts[1]}`,
      dataSource,
    };
  }
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const nested =
    parsePhysicalTableName(
      record.qualifiedName ??
        record.qualifiedname ??
        record.qualified_name ??
        record.targetTable ??
        record.target_table ??
        record.tableName ??
        record.table_name,
    ) ??
    parsePhysicalTableName(record.table) ??
    parsePhysicalTableName(record.target) ??
    parsePhysicalTableName(record.physicalTable);
  if (nested === undefined) return undefined;
  const dataSource =
    nested.dataSource ??
    nonEmptyString(
      record.dataSource ??
        record.datasource ??
        record.data_source ??
        record.dataSourceId,
    );
  return { qualifiedName: nested.qualifiedName, dataSource };
}

export function platformFromDataSource(
  dataSource: string,
): string | undefined {
  const ds = dataSource.trim().toLowerCase();
  if (ds === HIVE_DATA_SOURCE || ds.startsWith("gfhive")) return "hive";
  if (ds.startsWith("gforacle_")) return "oracle";
  if (ds.startsWith("gfmysql_")) return "mysql";
  if (ds.startsWith("gfpostgre_") || ds.startsWith("gfpg_")) return "postgre";
  if (ds.startsWith("gfstarrocks_")) return "starrocks";
  if (ds.includes("oceanbase")) return "oceanbase";
  if (ds.includes("tidb")) return "tidb";
  if (ds.startsWith("gfgoldendb_")) return "goldendb";
  if (ds.startsWith("gfsqlserver_")) return "sqlserver";
  return undefined;
}

function hiveMetadataKeys(record: JsonRecord): string | undefined {
  if (nonEmptyString(record.status)?.toUpperCase() !== "ACTIVE")
    return undefined;
  const parsed = parsePhysicalTableName(
    nonEmptyString(record.qualifiedname_clean) ??
      nonEmptyString(record.qualifiedname),
  );
  return parsed?.qualifiedName.toLowerCase();
}

function isHivePhysicalDdl(sql: string | undefined): boolean {
  return (
    sql !== undefined &&
    /^\s*CREATE\s+(?:EXTERNAL\s+)?(?:TABLE|VIEW)\b/iu.test(sql)
  );
}

function skipBalancedParens(sql: string, start: number): number {
  if (sql[start] !== "(") return start;
  let depth = 0;
  for (let index = start; index < sql.length; index += 1) {
    const current = sql[index];
    if (current === "(") depth += 1;
    else if (current === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return sql.length;
}

function skipQualifiedName(sql: string, start: number): number {
  let index = start;
  while (index < sql.length && /\s/u.test(sql[index]!)) index += 1;
  while (index < sql.length) {
    const current = sql[index]!;
    if (current === "`" || current === '"') {
      const quote = current;
      index += 1;
      while (index < sql.length && sql[index] !== quote) index += 1;
      if (index < sql.length) index += 1;
    } else if (/[A-Za-z0-9_$#]/u.test(current)) {
      while (index < sql.length && /[A-Za-z0-9_$#]/u.test(sql[index]!))
        index += 1;
    } else break;
    while (index < sql.length && /\s/u.test(sql[index]!)) index += 1;
    if (sql[index] === ".") {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function unquoteSqlString(value: string): string {
  const quote = value[0];
  if ((quote === "'" || quote === '"') && value.endsWith(quote))
    return value.slice(1, -1).replaceAll(`\\${quote}`, quote).replaceAll(
      `${quote}${quote}`,
      quote,
    );
  return value;
}

export function tableCommentFromDdl(sql: string | undefined): string | undefined {
  if (sql === undefined) return undefined;
  const header = sql.match(
    /\bCREATE\s+(?:EXTERNAL\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?/iu,
  );
  if (header?.index === undefined) return undefined;
  let index = skipQualifiedName(sql, header.index + header[0].length);
  while (index < sql.length && /\s/u.test(sql[index]!)) index += 1;
  if (sql[index] === "(") index = skipBalancedParens(sql, index);
  const comment = sql
    .slice(index)
    .match(/^\s*COMMENT\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/iu);
  return comment?.[1] === undefined ? undefined : unquoteSqlString(comment[1]);
}

function tableDescription(
  record: JsonRecord | undefined,
  ddl: string | undefined,
): string | undefined {
  return (
    nonEmptyString(record?.description) ??
    nonEmptyString(record?.comment) ??
    nonEmptyString(tableCommentFromDdl(ddl))
  );
}

function hiveDdlKeys(record: JsonRecord): readonly string[] | undefined {
  if (!isHivePhysicalDdl(nonEmptyString(record.querytext))) return undefined;
  const parsed = parsePhysicalTableName(record.qualifiedname);
  if (parsed === undefined) return undefined;
  const qn = parsed.qualifiedName.toLowerCase();
  const dataSource = (parsed.dataSource ?? HIVE_DATA_SOURCE).toLowerCase();
  return [`${qn}@${dataSource}`, qn];
}

function rdbmsKeys(record: JsonRecord): readonly string[] | undefined {
  const parsed = parsePhysicalTableName(record.qualifiedname);
  if (parsed === undefined) return undefined;
  const qn = parsed.qualifiedName.toLowerCase();
  if (parsed.dataSource === undefined) return [qn];
  return [`${qn}@${parsed.dataSource.toLowerCase()}`, qn];
}

function sameRdbmsPhysicalInstance(
  left: JsonRecord,
  right: JsonRecord,
): boolean {
  const leftParsed = parsePhysicalTableName(left.qualifiedname);
  const rightParsed = parsePhysicalTableName(right.qualifiedname);
  if (
    leftParsed === undefined ||
    rightParsed === undefined ||
    leftParsed.qualifiedName.toLowerCase() !==
      rightParsed.qualifiedName.toLowerCase()
  )
    return false;
  const leftInstance = nonEmptyString(left.instanceid)?.toLowerCase();
  const rightInstance = nonEmptyString(right.instanceid)?.toLowerCase();
  return leftInstance !== undefined && leftInstance === rightInstance;
}

function optionalIndex(
  path: string | undefined,
  keyOf: (record: JsonRecord) => string | readonly string[] | undefined,
  indexDir?: string,
  sameRecord?: (left: JsonRecord, right: JsonRecord) => boolean,
): JsonlOffsetIndex | undefined {
  if (path === undefined || !existsSync(path)) return undefined;
  assertJsonlCatalogPath(path);
  return loadJsonlOffsetIndex(path, {
    keyOf,
    sameRecord,
    persistPath:
      indexDir === undefined
        ? undefined
        : join(indexDir, `${basenameSafe(path)}.offset-index.json`),
  });
}

function basenameSafe(path: string): string {
  return path.replace(/^.*[\\/]/, "");
}

export function loadOfflineTableCatalog(
  options: OfflineTableCatalogPaths = {},
): OfflineTableCatalog {
  const hiveMetadataPath =
    options.hiveMetadataPath ?? DEFAULT_HIVE_METADATA_JSONL_PATH;
  const hiveDdlPath = options.hiveDdlPath ?? DEFAULT_HIVE_DDL_JSONL_PATH;
  const rdbmsCorePath = options.rdbmsCorePath ?? DEFAULT_RDBMS_CORE_JSONL_PATH;
  const rdbmsDdlPath = options.rdbmsDdlPath ?? DEFAULT_RDBMS_DDL_JSONL_PATH;
  const horaeDatasource =
    options.horaeDatasource === null
      ? undefined
      : (options.horaeDatasource ??
        loadHoraeDatasourceIndex(
          options.scheduleEvidenceCacheRoot ??
            DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
        ));
  const rdbmsCore = optionalIndex(
    rdbmsCorePath,
    rdbmsKeys,
    options.indexDir,
    sameRdbmsPhysicalInstance,
  );
  return {
    hiveMetadata: optionalIndex(
      hiveMetadataPath,
      hiveMetadataKeys,
      options.indexDir,
    ),
    hiveDdl: optionalIndex(hiveDdlPath, hiveDdlKeys, options.indexDir),
    rdbmsCore,
    rdbmsDdl: optionalIndex(
      rdbmsDdlPath,
      rdbmsKeys,
      options.indexDir,
      sameRdbmsPhysicalInstance,
    ),
    horaeDatasource,
    rdbmsQnServiceIndex:
      rdbmsCore === undefined
        ? undefined
        : buildRdbmsQnServiceIndex(rdbmsCore.keyOffsets),
    rdbmsQnAtlasKeys:
      rdbmsCore === undefined
        ? undefined
        : buildRdbmsQnAtlasKeysIndex(rdbmsCore.keyOffsets),
  };
}

/** Build `${qn}#${service}` → concrete `qn@…#service` (or AMBIGUOUS). */
export function buildRdbmsQnServiceIndex(
  keyOffsets: ReadonlyMap<string, number | "AMBIGUOUS">,
): ReadonlyMap<string, string | "AMBIGUOUS"> {
  const map = new Map<string, string | "AMBIGUOUS">();
  for (const key of keyOffsets.keys()) {
    const at = key.lastIndexOf("@");
    const hash = key.lastIndexOf("#");
    if (at <= 0 || hash <= at) continue;
    const qn = key.slice(0, at);
    const service = key.slice(hash + 1).trim().toLowerCase();
    if (qn === "" || service === "") continue;
    const secondary = `${qn}#${service}`;
    const existing = map.get(secondary);
    if (existing === undefined) map.set(secondary, key);
    else if (existing !== key) map.set(secondary, "AMBIGUOUS");
  }
  return map;
}

/** Group concrete `qn@dataSource` keys by bare qualified name. */
export function buildRdbmsQnAtlasKeysIndex(
  keyOffsets: ReadonlyMap<string, number | "AMBIGUOUS">,
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const key of keyOffsets.keys()) {
    const at = key.lastIndexOf("@");
    if (at <= 0) continue;
    const qn = key.slice(0, at);
    if (qn === "") continue;
    const list = map.get(qn);
    if (list === undefined) map.set(qn, [key]);
    else list.push(key);
  }
  return map;
}

const NO_HASH_ATLAS_PREFIXES = [
  "gfmysql_",
  "gfstarrocks_",
  "gfgoldendb_",
] as const;

/**
 * When preferred is `gfmysql_${service}` (no `#`), pick the unique concrete
 * `qn@gfmysql_…` key: exact → unique service prefix → sole family row.
 */
export function resolveUniqueNoHashAtlasKey(
  qualifiedName: string,
  preferredDataSource: string,
  atlasKeysByQn: ReadonlyMap<string, readonly string[]> | undefined,
): string | undefined {
  if (atlasKeysByQn === undefined) return undefined;
  const preferred = preferredDataSource.trim().toLowerCase();
  const prefix = NO_HASH_ATLAS_PREFIXES.find((item) =>
    preferred.startsWith(item),
  );
  if (prefix === undefined) return undefined;
  const service = preferred.slice(prefix.length);
  if (service === "") return undefined;
  const familyKeys = (atlasKeysByQn.get(qualifiedName.toLowerCase()) ?? []).filter(
    (key) => {
      const at = key.lastIndexOf("@");
      if (at < 0) return false;
      const dataSource = key.slice(at + 1).toLowerCase();
      return dataSource.startsWith(prefix) && !dataSource.includes("#");
    },
  );
  const exact = familyKeys.filter((key) => {
    const at = key.lastIndexOf("@");
    return key.slice(at + 1).toLowerCase() === preferred;
  });
  if (exact.length === 1) return exact[0];
  const prefixed = familyKeys.filter((key) => {
    const at = key.lastIndexOf("@");
    const atlasId = key.slice(at + 1).toLowerCase().slice(prefix.length);
    return atlasId === service || atlasId.startsWith(service);
  });
  if (prefixed.length === 1) return prefixed[0];
  if (familyKeys.length === 1) return familyKeys[0];
  return undefined;
}

export function serviceSuffixFromAtlasDataSource(
  dataSource: string,
): string | undefined {
  const hash = dataSource.lastIndexOf("#");
  if (hash < 0) return undefined;
  const service = dataSource.slice(hash + 1).trim().toLowerCase();
  return service === "" ? undefined : service;
}

function sqlInputs(
  taskEvidence: TaskEvidence,
): Partial<Record<SqlSlot, string>> {
  const result: Partial<Record<SqlSlot, string>> = {};
  for (const slot of SQL_SLOTS) {
    const raw = taskEvidence.sql?.[slot];
    const content =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object"
          ? raw.content
          : undefined;
    if (typeof content === "string" && nonEmptyString(content) !== undefined)
      result[slot] = content;
  }
  return result;
}

export function extractOfflineTableCandidates(
  taskEvidence: TaskEvidence,
  horaeDatasource?: HoraeDatasourceIndex,
): readonly OfflineTableCandidate[] {
  const byKey = new Map<string, OfflineTableCandidate>();
  const add = (value: unknown): void => {
    const parsed = parsePhysicalTableName(value);
    if (parsed === undefined) return;
    const key = `${parsed.qualifiedName.toLowerCase()}@${(parsed.dataSource ?? "").toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, parsed);
    else if (existing.dataSource === undefined && parsed.dataSource !== undefined)
      byKey.set(key, parsed);
  };
  add(taskEvidence.target);
  // *2hive: source is a platform datasource label (e.g. oracle_rbjygl_85.236),
  // not a physical table. Adding it creates TABLE_JSONL_MISS noise and can keep
  // the whole task PARTIAL even when real tables resolve.
  const sourceCandidate = parsePhysicalTableName(taskEvidence.source);
  if (
    !isDatabaseSourceToHiveTask(taskEvidence.taskCategory) ||
    (!isKnownHoraeDatasourceLabel(taskEvidence.source, horaeDatasource) &&
      sourceCandidate?.dataSource !== undefined)
  )
    add(sourceCandidate);
  const sql = sqlInputs(taskEvidence);
  for (const name of Object.values(sql).flatMap((content) =>
    extractSqlReadTableNames(content ?? ""),
  ))
    add(name);
  for (const name of extractSqlWriteTableNames(
    sql,
    typeof taskEvidence.taskName === "string" ? taskEvidence.taskName : undefined,
    { allowSchemaOnlyQualification: true },
  ))
    add(name);
  return [...byKey.values()].sort((left, right) =>
    left.qualifiedName.localeCompare(right.qualifiedName),
  );
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
    guid: nonEmptyString(value("guid")),
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

function rememberLocalPack(
  index: Map<string, LocalTablePack[]>,
  pack: LocalTablePack,
): void {
  const keys = [
    `${pack.evidence.qualifiedName.toLowerCase()}@${pack.evidence.dataSource.toLowerCase()}`,
    pack.evidence.qualifiedName.toLowerCase(),
  ];
  for (const key of keys) {
    const entries = index.get(key) ?? [];
    entries.push(pack);
    index.set(key, entries);
  }
}

export interface OfflineTablePackStore {
  readonly remember: (evidence: TableEvidence, contentHash: string) => void;
}

interface OfflineTablePackLookup extends OfflineTablePackStore {
  readonly get: (key: string) => readonly LocalTablePack[] | undefined;
}

export function openOfflineTablePackStore(
  dataRoot: string,
): OfflineTablePackLookup {
  const index = loadExistingTablePacks(dataRoot);
  return {
    get: (key) => index.get(key),
    remember: (evidence, contentHash) => {
      rememberLocalPack(index, { evidence, contentHash });
    },
  };
}

function loadExistingTablePacks(
  dataRoot: string,
): Map<string, LocalTablePack[]> {
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
        const ddlPath = join(tableRoot, "ddl.sql");
        const ddl = readFileSync(ddlPath, "utf8");
        const ddlHash = (document.ddlFile as JsonRecord).sha256;
        if (typeof ddlHash !== "string" || sha256File(ddlPath) !== ddlHash)
          continue;
        rememberLocalPack(result, {
          evidence: localTableEvidence(document, ddl),
          contentHash: document.contentHash,
        });
      } catch {
        // Invalid packs are cache misses.
      }
    }
  }
  return result;
}

function uniqueLocalPack(
  packs: readonly LocalTablePack[] | undefined,
): LocalTablePack | undefined {
  if (packs === undefined || packs.length === 0) return undefined;
  const unique = new Map<string, LocalTablePack>();
  for (const pack of packs) {
    unique.set(`${pack.contentHash}:${sha256Text(pack.evidence.ddl)}`, pack);
  }
  return unique.size === 1 ? [...unique.values()][0] : undefined;
}

function splitLocalPacks(packs: readonly LocalTablePack[] | undefined): {
  readonly authoritative: readonly LocalTablePack[];
  readonly spliced: readonly LocalTablePack[];
} {
  const authoritative: LocalTablePack[] = [];
  const spliced: LocalTablePack[] = [];
  for (const pack of packs ?? []) {
    if (isSplicedTableEvidenceProvider(pack.evidence.evidenceProvider))
      spliced.push(pack);
    else authoritative.push(pack);
  }
  return { authoritative, spliced };
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value)) {
    const values = value
      .map(nonEmptyString)
      .filter((item): item is string => item !== undefined);
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

function hivePartitionFields(
  record: JsonRecord | undefined,
  ddl: string,
): readonly string[] {
  const fromMetadata =
    stringArray(record?.partitionFields) ??
    stringArray(record?.partition) ??
    stringArray(record?.partitionkeys);
  if (fromMetadata !== undefined)
    return fromMetadata.map((field) => field.toLowerCase());
  return partitionFieldsFromDdl(ddl);
}

function isTruthyFlag(value: unknown): boolean {
  if (value === true) return true;
  const text = nonEmptyString(value)?.toLowerCase();
  return text === "true" || text === "1" || text === "y" || text === "yes";
}

function rdbmsPartitionColumnName(part: string): string | undefined {
  const trimmed = part.trim();
  if (trimmed === "" || /^null$/iu.test(trimmed)) return undefined;
  const quoted = normalizeIdentifierPart(trimmed);
  if (quoted === undefined || quoted === "" || /^null$/iu.test(quoted))
    return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/u.test(quoted)) return undefined;
  return quoted;
}

function rdbmsPartitionFieldsFromDdl(ddl: string): {
  readonly partitioned: boolean;
  readonly fields: readonly string[];
} {
  const header = ddl.match(
    /\bPARTITION\s+BY\s+(?:(?:RANGE|LIST|HASH|REFERENCE|SYSTEM)\s*)?\(/iu,
  );
  if (header?.index === undefined)
    return { partitioned: false, fields: [] };
  const open = header.index + header[0].length - 1;
  const close = skipBalancedParens(ddl, open);
  const inner = close > open + 1 ? ddl.slice(open + 1, close - 1) : "";
  const fields = inner
    .split(",")
    .map(rdbmsPartitionColumnName)
    .filter((field): field is string => field !== undefined);
  return { partitioned: true, fields };
}

function rdbmsPartitionFields(
  record: JsonRecord,
  ddl: string,
): readonly string[] | undefined {
  const fromDdl = rdbmsPartitionFieldsFromDdl(ddl);
  if (fromDdl.fields.length > 0) return fromDdl.fields;
  const fromCore =
    stringArray(record.partitionFields) ??
    stringArray(record.partition) ??
    stringArray(record.partitionkeys);
  if (fromCore !== undefined) return fromCore;
  if (
    fromDdl.partitioned ||
    isTruthyFlag(
      record.ispartitioned ?? record.isPartitioned ?? record.is_partitioned,
    )
  )
    return undefined;
  return [];
}

function hiveFromMetadata(
  record: JsonRecord,
  ddl: string,
  evidenceProvider: string,
  collectedAt: string,
): TableEvidence | undefined {
  const parsed = parsePhysicalTableName(
    nonEmptyString(record.qualifiedname_clean) ??
      nonEmptyString(record.qualifiedname),
  );
  const dataSource = (
    parsed?.dataSource ??
    nonEmptyString(record.datasource) ??
    HIVE_DATA_SOURCE
  ).toLowerCase();
  if (parsed === undefined) return undefined;
  const platform = platformFromDataSource(dataSource);
  if (platform === undefined) return undefined;
  const parts = parsed.qualifiedName.split(".");
  return {
    platform,
    dataSource,
    qualifiedName: parsed.qualifiedName,
    schema: parts[0],
    name: parts[1],
    objectType: nonEmptyString(record.type_name) ?? "hive_table",
    status: nonEmptyString(record.status),
    description: tableDescription(record, ddl),
    partitionFields: hivePartitionFields(record, ddl),
    ddl,
    evidenceProvider,
    collectedAt,
  };
}

function candidateLooksRelational(candidate: OfflineTableCandidate): boolean {
  if (candidate.dataSource === undefined) return false;
  const platform = platformFromDataSource(candidate.dataSource);
  return platform !== undefined && platform !== "hive";
}

function hiveFromTaskCreate(
  candidate: OfflineTableCandidate,
  ddl: string,
  collectedAt: string,
): TableEvidence | undefined {
  const dataSource = (candidate.dataSource ?? HIVE_DATA_SOURCE).toLowerCase();
  const platform = platformFromDataSource(dataSource);
  if (platform === undefined) return undefined;
  const parts = candidate.qualifiedName.split(".");
  const qualifiedName = candidate.qualifiedName.toLowerCase();
  return {
    platform,
    dataSource,
    qualifiedName,
    schema: parts[0]?.toLowerCase(),
    name: parts[1]?.toLowerCase(),
    objectType: "hive_table",
    description: tableDescription(undefined, ddl),
    partitionFields: hivePartitionFields(undefined, ddl),
    ddl,
    evidenceProvider: "input-pack:task-sql-create",
    collectedAt,
  };
}

function hiveFromUniqueTaskCreateForTarget(
  candidate: OfflineTableCandidate,
  sql: Partial<Record<SqlSlot, string>>,
  taskTarget: unknown,
  collectedAt: string,
  defaultSchema: TaskDefaultSchema | null,
): TableEvidence | undefined {
  const target = parsePhysicalTableName(taskTarget);
  if (
    target === undefined ||
    !sameQualifiedName(target.qualifiedName, candidate.qualifiedName) ||
    candidateLooksRelational(candidate)
  )
    return undefined;
  const created = uniqueTaskSqlCreateStatement(sql, candidate.qualifiedName, defaultSchema);
  if (created.conflict || created.ddl === undefined) return undefined;
  return hiveFromTaskCreate(candidate, created.ddl, collectedAt);
}

function hiveFromDdl(
  record: JsonRecord,
  collectedAt: string,
): TableEvidence | undefined {
  const parsed = parsePhysicalTableName(record.qualifiedname);
  const querytext = nonEmptyString(record.querytext);
  if (parsed === undefined || querytext === undefined) return undefined;
  const dataSource = (parsed.dataSource ?? HIVE_DATA_SOURCE).toLowerCase();
  const platform = platformFromDataSource(dataSource);
  if (platform === undefined) return undefined;
  const parts = parsed.qualifiedName.split(".");
  return {
    platform,
    dataSource,
    qualifiedName: parsed.qualifiedName,
    schema: parts[0],
    name: parts[1],
    objectType: "hive_table",
    description: tableDescription(undefined, querytext),
    partitionFields: hivePartitionFields(record, querytext),
    ddl: querytext,
    evidenceProvider: "local:hive-ddl-jsonl",
    collectedAt,
  };
}

export function rdbmsFromCore(
  record: JsonRecord,
  ddl: string,
  evidenceProvider: string,
  collectedAt: string,
): TableEvidence | undefined {
  const parsed = parsePhysicalTableName(record.qualifiedname);
  if (parsed?.dataSource === undefined) return undefined;
  const platform = platformFromDataSource(parsed.dataSource);
  if (platform === undefined) return undefined;
  const parts = parsed.qualifiedName.split(".");
  return {
    platform,
    dataSource: parsed.dataSource,
    qualifiedName: parsed.qualifiedName,
    schema: parts.length > 1 ? parts.slice(0, -1).join(".") : undefined,
    name: parts.at(-1),
    description: tableDescription(record, ddl),
    objectType: nonEmptyString(record.type_name) ?? "gf_rdbms_table",
    status: undefined,
    partitionFields: rdbmsPartitionFields(record, ddl),
    ddl,
    evidenceProvider,
    collectedAt,
  };
}

function candidateKeys(candidate: OfflineTableCandidate): readonly string[] {
  const qn = candidate.qualifiedName.toLowerCase();
  if (candidate.dataSource !== undefined)
    return [`${qn}@${candidate.dataSource.toLowerCase()}`, qn];
  return [`${qn}@${HIVE_DATA_SOURCE}`, qn];
}

/** Prefer concrete `@…#service` before bare schema.table (often AMBIGUOUS). */
export function rdbmsLookupKeys(
  candidate: OfflineTableCandidate,
  preferredRdbmsDataSource?: string,
  qnServiceIndex?: ReadonlyMap<string, string | "AMBIGUOUS">,
  qnAtlasKeys?: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const qn = candidate.qualifiedName.toLowerCase();
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  if (candidate.dataSource !== undefined)
    push(`${qn}@${candidate.dataSource.toLowerCase()}`);
  if (preferredRdbmsDataSource !== undefined) {
    const preferred = preferredRdbmsDataSource.toLowerCase();
    push(`${qn}@${preferred}`);
    const service = serviceSuffixFromAtlasDataSource(preferred);
    if (service !== undefined && qnServiceIndex !== undefined) {
      const byService = qnServiceIndex.get(`${qn}#${service}`);
      if (typeof byService === "string") push(byService);
    }
    const noHash = resolveUniqueNoHashAtlasKey(qn, preferred, qnAtlasKeys);
    if (noHash !== undefined) push(noHash);
  }
  push(qn);
  return keys;
}

function lookupFirst(
  index: JsonlOffsetIndex | undefined,
  keys: readonly string[],
): JsonlKeyLookup {
  if (index === undefined) return { status: "MISS" };
  let ambiguous = false;
  for (const key of keys) {
    const hit = lookupJsonlByKey(index, key);
    if (hit.status === "HIT") return hit;
    if (hit.status === "AMBIGUOUS") ambiguous = true;
  }
  return ambiguous ? { status: "AMBIGUOUS" } : { status: "MISS" };
}

function synthesizeHiveDdl(
  qualifiedName: string,
  columns: readonly string[],
): string {
  const body = columns.map((column) => `  ${column} STRING`).join(",\n");
  return `CREATE TABLE ${qualifiedName.toLowerCase()} (\n${body}\n)`;
}

function synthesizeRdbmsDdl(
  qualifiedName: string,
  columns: readonly string[],
  platform: string,
): string {
  const type = platform === "oracle" ? "VARCHAR2(4000)" : "VARCHAR(4000)";
  const body = columns.map((column) => `  ${column} ${type}`).join(",\n");
  return `CREATE TABLE ${qualifiedName} (\n${body}\n)`;
}

function hiveFromQueryProjection(
  candidate: OfflineTableCandidate,
  columns: readonly string[],
  collectedAt: string,
): TableEvidence | undefined {
  if (columns.length === 0) return undefined;
  const evidence = hiveFromTaskCreate(
    candidate,
    synthesizeHiveDdl(candidate.qualifiedName, columns),
    collectedAt,
  );
  if (evidence === undefined) return undefined;
  return {
    ...evidence,
    evidenceProvider: SPLICED_FROM_QUERY_PROJECTION,
  };
}

function rdbmsFromTaskSql(
  candidate: OfflineTableCandidate,
  dataSource: string,
  columns: readonly string[],
  evidenceProvider: string,
  collectedAt: string,
): TableEvidence | undefined {
  const platform = platformFromDataSource(dataSource);
  if (platform === undefined || platform === "hive" || columns.length === 0)
    return undefined;
  const parts = candidate.qualifiedName.split(".");
  return {
    platform,
    dataSource,
    qualifiedName: candidate.qualifiedName,
    schema: parts.length > 1 ? parts.slice(0, -1).join(".") : undefined,
    name: parts.at(-1),
    objectType: "gf_rdbms_table",
    partitionFields: [],
    ddl: synthesizeRdbmsDdl(candidate.qualifiedName, columns, platform),
    evidenceProvider,
    collectedAt,
  };
}

function sameQualifiedName(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function splicedRdbmsDdlForCandidate(
  candidate: OfflineTableCandidate,
  sql: Partial<Record<SqlSlot, string>>,
  taskTarget: unknown,
  dataSourceHint?: string,
  defaultSchema: TaskDefaultSchema | null = null,
): { readonly ddl: string; readonly evidenceProvider: string } | undefined {
  let columns = queryProjectionColumnNames(
    sql.query ?? "",
    candidate.qualifiedName,
  );
  let provider = SPLICED_FROM_TASK_SQL;
  if (columns.length === 0) {
    const soleSource = uniqueQueryFromQualifiedName(sql.query ?? "");
    const target = parsePhysicalTableName(taskTarget);
    if (
      target !== undefined &&
      soleSource !== undefined &&
      sameQualifiedName(soleSource, candidate.qualifiedName)
    ) {
      const created = uniqueTaskSqlCreateStatement(sql, target.qualifiedName, defaultSchema);
      if (!created.conflict && created.ddl !== undefined) {
        columns = [...columnNamesFromCreateTable(created.ddl)];
        provider = SPLICED_FROM_HIVE_TARGET_CREATE;
      }
    }
  }
  if (columns.length === 0) return undefined;
  const platform = platformFromDataSource(
    candidate.dataSource ?? dataSourceHint ?? "",
  );
  if (platform === undefined || platform === "hive") return undefined;
  return {
    ddl: synthesizeRdbmsDdl(candidate.qualifiedName, columns, platform),
    evidenceProvider: provider,
  };
}

function usableSourceDdlColumns(
  evidence: TableEvidence | undefined,
): readonly string[] | undefined {
  if (evidence === undefined) return undefined;
  if (evidence.platform === "hive") return undefined;
  if (isSplicedTableEvidenceProvider(evidence.evidenceProvider))
    return undefined;
  const columns = columnNamesFromCreateTable(evidence.ddl);
  return columns.length > 0 ? columns : undefined;
}

function sourceDdlColumns(
  sourceQualifiedName: string,
  catalog: OfflineTableCatalog,
  localPacks: OfflineTablePackLookup,
  resolvedThisPass: readonly TableEvidence[],
  preferredRdbmsDataSource?: string,
): readonly string[] | undefined {
  const qn = sourceQualifiedName.toLowerCase();
  const fromResolved = resolvedThisPass.find(
    (item) => item.qualifiedName.toLowerCase() === qn,
  );
  const resolvedColumns = usableSourceDdlColumns(fromResolved);
  if (resolvedColumns !== undefined) return resolvedColumns;

  const localKeys = rdbmsLookupKeys(
    { qualifiedName: sourceQualifiedName },
    preferredRdbmsDataSource,
    catalog.rdbmsQnServiceIndex,
    catalog.rdbmsQnAtlasKeys,
  );
  for (const key of localKeys) {
    const { authoritative } = splitLocalPacks(localPacks.get(key));
    const columns = usableSourceDdlColumns(uniqueLocalPack(authoritative)?.evidence);
    if (columns !== undefined) return columns;
  }

  if (catalog.rdbmsCore === undefined) return undefined;
  const coreLookup = lookupFirst(catalog.rdbmsCore, localKeys);
  if (coreLookup.status !== "HIT") return undefined;
  const ddlLookup = lookupFirst(catalog.rdbmsDdl, localKeys);
  if (ddlLookup.status !== "HIT") return undefined;
  const ddl = nonEmptyString(ddlLookup.record.ddl);
  if (ddl === undefined) return undefined;
  const columns = columnNamesFromCreateTable(ddl);
  return columns.length > 0 ? columns : undefined;
}

function hiveFromSourceDdl(
  candidate: OfflineTableCandidate,
  sql: Partial<Record<SqlSlot, string>>,
  catalog: OfflineTableCatalog,
  localPacks: OfflineTablePackLookup,
  resolvedThisPass: readonly TableEvidence[],
  preferredRdbmsDataSource: string | undefined,
  taskCategory: string | null | undefined,
  taskTarget: unknown,
  collectedAt: string,
  hiveMetadataRecord?: JsonRecord,
): TableEvidence | undefined {
  if (!isDatabaseSourceToHiveTask(taskCategory)) return undefined;
  const target = parsePhysicalTableName(taskTarget);
  if (!sameQualifiedName(target?.qualifiedName, candidate.qualifiedName))
    return undefined;
  if (candidateLooksRelational(candidate)) return undefined;
  const query = sql.query ?? "";
  if (!isSoleStarSelectQuery(query)) return undefined;
  const soleSource = uniqueQueryFromQualifiedName(query);
  if (soleSource === undefined) return undefined;
  const columns = sourceDdlColumns(
    soleSource,
    catalog,
    localPacks,
    resolvedThisPass,
    preferredRdbmsDataSource,
  );
  if (columns === undefined) return undefined;
  const ddl = synthesizeHiveDdl(candidate.qualifiedName, columns);
  if (hiveMetadataRecord !== undefined) {
    return hiveFromMetadata(
      hiveMetadataRecord,
      ddl,
      SPLICED_FROM_SOURCE_DDL,
      collectedAt,
    );
  }
  const evidence = hiveFromTaskCreate(candidate, ddl, collectedAt);
  if (evidence === undefined) return undefined;
  return {
    ...evidence,
    evidenceProvider: SPLICED_FROM_SOURCE_DDL,
  };
}

function spliceFromTaskEvidence(
  candidate: OfflineTableCandidate,
  sql: Partial<Record<SqlSlot, string>>,
  collectedAt: string,
  preferredRdbmsDataSource: string | undefined,
  taskCategory: string | null | undefined,
  taskTarget: unknown,
  defaultSchema: TaskDefaultSchema | null,
): TableEvidence | undefined {
  if (!isDatabaseSourceToHiveTask(taskCategory)) return undefined;
  const target = parsePhysicalTableName(taskTarget);
  const isHiveTarget = sameQualifiedName(
    target?.qualifiedName,
    candidate.qualifiedName,
  );
  if (isHiveTarget && !candidateLooksRelational(candidate)) {
    const columns = queryOutputColumnNames(sql.query ?? "");
    return hiveFromQueryProjection(candidate, columns, collectedAt);
  }
  if (isHiveTarget || preferredRdbmsDataSource === undefined) return undefined;
  const splicedDdl = splicedRdbmsDdlForCandidate(
    candidate,
    sql,
    taskTarget,
    preferredRdbmsDataSource,
    defaultSchema,
  );
  if (splicedDdl === undefined) return undefined;
  const columns = columnNamesFromCreateTable(splicedDdl.ddl);
  return rdbmsFromTaskSql(
    candidate,
    preferredRdbmsDataSource,
    columns,
    splicedDdl.evidenceProvider,
    collectedAt,
  );
}

function resolveOne(
  candidate: OfflineTableCandidate,
  localPacks: OfflineTablePackLookup,
  catalog: OfflineTableCatalog,
  sql: Partial<Record<SqlSlot, string>>,
  collectedAt: string,
  preferredRdbmsDataSource?: string,
  taskCategory?: string | null,
  taskTarget?: unknown,
  resolvedThisPass: readonly TableEvidence[] = [],
  defaultSchema: TaskDefaultSchema | null = null,
):
  | { readonly evidence: TableEvidence }
  | { readonly reason: string } {
  let splicedLocal: LocalTablePack | undefined;
  for (const key of candidateKeys(candidate)) {
    const { authoritative, spliced } = splitLocalPacks(localPacks.get(key));
    const pack = uniqueLocalPack(authoritative);
    if (pack !== undefined) return { evidence: pack.evidence };
    if (authoritative.length > 1) return { reason: "LOCAL_TABLE_PACK_CONFLICT" };
    splicedLocal ??= uniqueLocalPack(spliced);
  }

  const hiveDdl = lookupFirst(catalog.hiveDdl, candidateKeys(candidate));
  if (hiveDdl.status === "AMBIGUOUS") {
    const taskCreate = hiveFromUniqueTaskCreateForTarget(
      candidate,
      sql,
      taskTarget,
      collectedAt,
      defaultSchema,
    );
    if (taskCreate !== undefined) return { evidence: taskCreate };
    return { reason: "HIVE_DDL_AMBIGUOUS" };
  }
  const hiveIdentity =
    catalog.hiveMetadata === undefined
      ? { status: "MISS" as const }
      : lookupJsonlByKey(
          catalog.hiveMetadata,
          candidate.qualifiedName.toLowerCase(),
        );
  if (hiveIdentity.status === "AMBIGUOUS" && hiveDdl.status !== "HIT")
    return { reason: "HIVE_METADATA_AMBIGUOUS_ACTIVE" };
  if (hiveDdl.status === "HIT") {
    const querytext = nonEmptyString(hiveDdl.record.querytext);
    if (querytext !== undefined && isHivePhysicalDdl(querytext)) {
      if (hiveIdentity.status === "HIT") {
        const evidence = hiveFromMetadata(
          hiveIdentity.record,
          querytext,
          "local:hive-metadata-snapshot,local:hive-ddl-jsonl",
          collectedAt,
        );
        if (evidence === undefined) return { reason: "HIVE_PLATFORM_UNMAPPED" };
        return { evidence };
      }
      const evidence = hiveFromDdl(hiveDdl.record, collectedAt);
      if (evidence === undefined) return { reason: "HIVE_PLATFORM_UNMAPPED" };
      return { evidence };
    }
  }
  if (hiveIdentity.status === "HIT") {
    const created = uniqueTaskSqlCreateStatement(sql, candidate.qualifiedName, defaultSchema);
    if (created.conflict) return { reason: "SQL_CREATE_CONFLICT" };
    if (created.ddl !== undefined) {
      const evidence = hiveFromMetadata(
        hiveIdentity.record,
        created.ddl,
        "input-pack:task-sql-create",
        collectedAt,
      );
      if (evidence === undefined) return { reason: "HIVE_PLATFORM_UNMAPPED" };
      return { evidence };
    }
    // Query output describes the task target, never an unrelated source table.
    const splicedColumns = sameQualifiedName(parsePhysicalTableName(taskTarget)?.qualifiedName, candidate.qualifiedName)
      ? queryOutputColumnNames(sql.query ?? "")
      : [];
    if (splicedColumns.length > 0) {
      const evidence = hiveFromMetadata(
        hiveIdentity.record,
        synthesizeHiveDdl(candidate.qualifiedName, splicedColumns),
        SPLICED_FROM_QUERY_PROJECTION,
        collectedAt,
      );
      if (evidence === undefined) return { reason: "HIVE_PLATFORM_UNMAPPED" };
      return { evidence };
    }
    const fromSource = hiveFromSourceDdl(
      candidate,
      sql,
      catalog,
      localPacks,
      resolvedThisPass,
      preferredRdbmsDataSource,
      taskCategory,
      taskTarget,
      collectedAt,
      hiveIdentity.record,
    );
    if (fromSource !== undefined) return { evidence: fromSource };
    return { reason: "HIVE_DDL_MISS" };
  }

  if (!candidateLooksRelational(candidate)) {
    const created = uniqueTaskSqlCreateStatement(sql, candidate.qualifiedName, defaultSchema);
    if (created.conflict) return { reason: "SQL_CREATE_CONFLICT" };
    if (created.ddl !== undefined) {
      const evidence = hiveFromTaskCreate(candidate, created.ddl, collectedAt);
      if (evidence === undefined) return { reason: "HIVE_PLATFORM_UNMAPPED" };
      return { evidence };
    }
  }

  if (catalog.rdbmsCore !== undefined) {
    const keys = rdbmsLookupKeys(
      candidate,
      preferredRdbmsDataSource,
      catalog.rdbmsQnServiceIndex,
      catalog.rdbmsQnAtlasKeys,
    );
    const coreLookup = lookupFirst(catalog.rdbmsCore, keys);
    if (coreLookup.status === "AMBIGUOUS")
      return { reason: "RDBMS_CORE_AMBIGUOUS" };
    if (coreLookup.status === "HIT") {
      const ddlLookup = lookupFirst(catalog.rdbmsDdl, keys);
      if (ddlLookup.status === "AMBIGUOUS")
        return { reason: "RDBMS_DDL_AMBIGUOUS" };
      if (ddlLookup.status === "MISS") {
        const splicedDdl = splicedRdbmsDdlForCandidate(
          candidate,
          sql,
          taskTarget,
          parsePhysicalTableName(coreLookup.record.qualifiedname)?.dataSource ??
            preferredRdbmsDataSource,
          defaultSchema,
        );
        if (splicedDdl !== undefined) {
          const evidence = rdbmsFromCore(
            coreLookup.record,
            splicedDdl.ddl,
            splicedDdl.evidenceProvider,
            collectedAt,
          );
          if (evidence === undefined)
            return { reason: "RDBMS_PLATFORM_UNMAPPED" };
          return { evidence };
        }
        return { reason: "RDBMS_DDL_MISS" };
      }
      const ddl = nonEmptyString(ddlLookup.record.ddl);
      if (ddl === undefined) return { reason: "RDBMS_DDL_MISSING" };
      const evidence = rdbmsFromCore(
        coreLookup.record,
        ddl,
        preferredRdbmsDataSource !== undefined
          ? "local:rdbms-core-jsonl,local:rdbms-ddl-jsonl,local:horae-datasource"
          : "local:rdbms-core-jsonl,local:rdbms-ddl-jsonl",
        collectedAt,
      );
      if (evidence === undefined) return { reason: "RDBMS_PLATFORM_UNMAPPED" };
      return { evidence };
    }
  }

  const spliced = spliceFromTaskEvidence(
    candidate,
    sql,
    collectedAt,
    preferredRdbmsDataSource,
    taskCategory,
    taskTarget,
    defaultSchema,
  );
  if (spliced !== undefined) return { evidence: spliced };
  const fromSource = hiveFromSourceDdl(
    candidate,
    sql,
    catalog,
    localPacks,
    resolvedThisPass,
    preferredRdbmsDataSource,
    taskCategory,
    taskTarget,
    collectedAt,
  );
  if (fromSource !== undefined) return { evidence: fromSource };
  if (splicedLocal !== undefined) return { evidence: splicedLocal.evidence };
  return { reason: "TABLE_JSONL_MISS" };
}

export function resolveStandaloneOfflineTable(
  qualifiedName: string,
  catalog: OfflineTableCatalog,
  packStore: OfflineTablePackLookup,
  collectedAt: string,
  options: {
    readonly dataSource?: string;
    readonly resolvedThisPass?: readonly TableEvidence[];
  } = {},
): { readonly evidence: TableEvidence } | { readonly reason: string } {
  const parsed = parsePhysicalTableName(qualifiedName);
  if (parsed === undefined) return { reason: "QUALIFIED_NAME_INVALID" };
  const resolvedCandidate: OfflineTableCandidate =
    options.dataSource !== undefined && parsed.dataSource === undefined
      ? { qualifiedName: parsed.qualifiedName, dataSource: options.dataSource }
      : parsed;
  return resolveOne(
    resolvedCandidate,
    packStore,
    catalog,
    {},
    collectedAt,
    undefined,
    undefined,
    undefined,
    options.resolvedThisPass ?? [],
  );
}

export function resolveOfflineTables(
  dataRoot: string,
  taskEvidence: TaskEvidence,
  catalog: OfflineTableCatalog,
  now: () => Date = () => new Date(),
  packStore?: ReturnType<typeof openOfflineTablePackStore>,
): OfflineTableResolution {
  const candidates = extractOfflineTableCandidates(
    taskEvidence,
    catalog.horaeDatasource,
  );
  const localPacks = packStore ?? openOfflineTablePackStore(dataRoot);
  const sql = sqlInputs(taskEvidence);
  const collectedAt = now().toISOString();
  const preferredRdbmsDataSource = isDatabaseSourceToHiveTask(
    taskEvidence.taskCategory,
  )
    ? (taskEvidence.endpointDataSourceHints?.source ??
      preferredRdbmsDataSourceFromTaskSource(
        taskEvidence.source,
        catalog.horaeDatasource,
      ))
    : taskEvidence.endpointDataSourceHints?.target;
  const resolved: TableEvidence[] = [];
  const unavailable: { qualifiedName: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const dedupe = candidate.qualifiedName.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const result = resolveOne(
      candidate,
      localPacks,
      catalog,
      sql,
      collectedAt,
      preferredRdbmsDataSource,
      taskEvidence.taskCategory,
      taskEvidence.target,
      resolved,
      inferTaskDefaultSchema(taskEvidence),
    );
    if ("evidence" in result) resolved.push(result.evidence);
    else
      unavailable.push({
        qualifiedName: candidate.qualifiedName,
        reason: result.reason,
      });
  }
  return { candidates, resolved, unavailable };
}
