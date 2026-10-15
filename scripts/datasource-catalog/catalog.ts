import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasDatasourceAliases, preserveDatasourceAliases } from "./aliases.ts";

export type DatasourceSourceSystem = "HORAE" | "SZDATA";
export type DatasourceMatchStatus = "CONFIRMED" | "CANDIDATE";
export type DatasourceMatchMethod =
  "EXACT_IDENTIFIER" | "HOST_PORT_TYPE_SERVICE" | "SYSTEM_SERVICE_TYPE";

export interface BuildDatasourceCatalogOptions {
  readonly horaeDir: string;
  readonly szdataDir: string;
  readonly databasePath: string;
  readonly annotationsPath?: string;
}

export interface DatasourceCatalogBuildResult {
  readonly databasePath: string;
  readonly records: Readonly<Record<"horae" | "szdata", number>>;
  readonly matches: Readonly<{
    confirmed: number;
    candidates: number;
    total: number;
  }>;
  readonly schemas: number;
  readonly accessPoints: number;
  readonly annotations: number;
  readonly unresolved: Readonly<Record<"horae" | "szdata", number>>;
}

export interface DatasourceQueryOptions {
  readonly q?: string;
  readonly identifier?: string;
  readonly dbType?: string;
  readonly matchStatus?: "CONFIRMED" | "CANDIDATE" | "UNRESOLVED";
  readonly schema?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SchemaQueryOptions {
  readonly q?: string;
  readonly name?: string;
  readonly identifier?: string;
  readonly matchStatus?: "CONFIRMED" | "CANDIDATE" | "UNRESOLVED";
  readonly limit?: number;
  readonly offset?: number;
}

type JsonRecord = Record<string, unknown>;

interface NormalizedDatasourceRecord {
  readonly recordKey: string;
  readonly sourceSystem: DatasourceSourceSystem;
  readonly sourceRecordId: string;
  readonly sourcePosition: number;
  readonly identifier: string;
  readonly identifierNorm: string;
  readonly cmdbSystemName: string;
  readonly cmdbSystemNameNorm: string;
  readonly dbType: string;
  readonly dbTypeNorm: string;
  readonly serviceName: string;
  readonly serviceNameNorm: string;
  readonly host: string;
  readonly port: number | null;
  readonly connectable: boolean | null;
  readonly userName: string;
  readonly attributesJson: string | null;
  readonly rowSha256: string;
  readonly source: JsonRecord;
}

interface SnapshotInput {
  readonly sourceSystem: DatasourceSourceSystem;
  readonly artifactType: string;
  readonly schemaVersion: string;
  readonly observedAt: string;
  readonly declaredTotal: number;
  readonly fetchedRowCount: number;
  readonly rowCount: number;
  readonly coverageGap: number;
  readonly failureCount: number;
  readonly duplicateGroupCount: number;
  readonly complete: boolean;
  readonly sourcePath: string;
  readonly rowsPath: string;
  readonly rowsSha256: string;
  readonly declaredContentSha256: string;
}

interface MatchInput {
  readonly horae: NormalizedDatasourceRecord;
  readonly szdata: NormalizedDatasourceRecord;
  readonly method: DatasourceMatchMethod;
  readonly status: DatasourceMatchStatus;
  readonly matchKeyHash: string;
}

interface SchemaAnnotationInput {
  readonly platform: string;
  readonly platformNorm: string;
  readonly dataSource: string;
  readonly dataSourceNorm: string;
  readonly schemaName: string;
  readonly schemaNameNorm: string;
  readonly displayName: string;
  readonly description: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asRecord(value: unknown, code: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as JsonRecord;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(value: unknown, code: string): string {
  const result = stringValue(value);
  if (result === "") throw new Error(code);
  return result;
}

function integerValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : fallback;
}

function nullablePort(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeDatasourceText(value: unknown): string {
  const text = stringValue(value);
  return text === "" || text === "-" ? "" : text.toLowerCase();
}

export function normalizeDatasourceType(value: unknown): string {
  const normalized = normalizeDatasourceText(value);
  if (["postgre", "postgres", "postgresql"].includes(normalized)) {
    return "postgresql";
  }
  return normalized;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return null;
}

function parseJsonFile(path: string, code: string): JsonRecord {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")), code);
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code);
  }
}

function readJsonl(
  path: string,
  sourceSystem: DatasourceSourceSystem,
): {
  readonly raw: string;
  readonly rows: readonly JsonRecord[];
} {
  const raw = readFileSync(path, "utf8");
  const rows: JsonRecord[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    try {
      rows.push(
        asRecord(
          JSON.parse(line),
          `INVALID_JSONL_ROW:${sourceSystem}:${index + 1}`,
        ),
      );
    } catch {
      throw new Error(`INVALID_JSONL_ROW:${sourceSystem}:${index + 1}`);
    }
  }
  return { raw, rows };
}

function nestedArray(
  value: unknown,
  field: string,
  recordKey: string,
): readonly JsonRecord[] {
  if (value === undefined || value === null || value === "") return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error("not-array");
    return parsed.map((entry) =>
      asRecord(entry, `INVALID_NESTED_JSON:${field}:${recordKey}`),
    );
  } catch {
    throw new Error(`INVALID_NESTED_JSON:${field}:${recordKey}`);
  }
}

function nestedObject(
  value: unknown,
  field: string,
  recordKey: string,
): JsonRecord | null {
  if (value === undefined || value === null || value === "") return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return asRecord(parsed, `INVALID_NESTED_JSON:${field}:${recordKey}`);
  } catch {
    throw new Error(`INVALID_NESTED_JSON:${field}:${recordKey}`);
  }
}

function normalizeHoraeRow(
  row: JsonRecord,
  position: number,
): NormalizedDatasourceRecord {
  const sourceRecordId = requiredString(
    row.keyword,
    `MISSING_SOURCE_RECORD_ID:HORAE:${position}`,
  );
  const identifier = requiredString(
    row.server_tag,
    `MISSING_IDENTIFIER:HORAE:${sourceRecordId}`,
  );
  const dbType = stringValue(row.server_type);
  const serviceName = stringValue(row.service);
  const cmdbSystemName = stringValue(row.cmdb_name);
  return {
    recordKey: `horae:${sourceRecordId}`,
    sourceSystem: "HORAE",
    sourceRecordId,
    sourcePosition: position,
    identifier,
    identifierNorm: normalizeDatasourceText(identifier),
    cmdbSystemName,
    cmdbSystemNameNorm: normalizeDatasourceText(cmdbSystemName),
    dbType,
    dbTypeNorm: normalizeDatasourceType(dbType),
    serviceName,
    serviceNameNorm: normalizeDatasourceText(serviceName),
    host: stringValue(row.host),
    port: nullablePort(row.port),
    connectable: booleanValue(row.connectable),
    userName: stringValue(row.user_name),
    attributesJson: null,
    rowSha256: sha256(JSON.stringify(row)),
    source: row,
  };
}

function normalizeSzdataRow(
  row: JsonRecord,
  position: number,
): NormalizedDatasourceRecord {
  const sourceRecordId = requiredString(
    row.id,
    `MISSING_SOURCE_RECORD_ID:SZDATA:${position}`,
  );
  const identifier = requiredString(
    row.sourceIdentifier,
    `MISSING_IDENTIFIER:SZDATA:${sourceRecordId}`,
  );
  const attributes = nestedObject(
    row.attributesJson,
    "attributesJson",
    `szdata:${sourceRecordId}`,
  );
  const status =
    attributes === null
      ? null
      : typeof attributes.status === "object" && attributes.status !== null
        ? (attributes.status as JsonRecord)
        : null;
  const dbType = stringValue(row.dbType);
  const serviceName = stringValue(row.dbServiceName);
  const cmdbSystemName = stringValue(row.cmdbSystemName);
  return {
    recordKey: `szdata:${sourceRecordId}`,
    sourceSystem: "SZDATA",
    sourceRecordId,
    sourcePosition: position,
    identifier,
    identifierNorm: normalizeDatasourceText(identifier),
    cmdbSystemName,
    cmdbSystemNameNorm: normalizeDatasourceText(cmdbSystemName),
    dbType,
    dbTypeNorm: normalizeDatasourceType(dbType),
    serviceName,
    serviceNameNorm: normalizeDatasourceText(serviceName),
    host: stringValue(row.host),
    port: nullablePort(row.port),
    connectable: booleanValue(status?.connectable),
    userName: stringValue(row.userName),
    attributesJson: attributes === null ? null : JSON.stringify(attributes),
    rowSha256: sha256(JSON.stringify(row)),
    source: row,
  };
}

function validateUniqueRecordKeys(
  rows: readonly NormalizedDatasourceRecord[],
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.recordKey.toLowerCase();
    if (seen.has(key))
      throw new Error(`DUPLICATE_SOURCE_RECORD_ID:${row.recordKey}`);
    seen.add(key);
  }
}

function loadInputs(options: BuildDatasourceCatalogOptions): {
  readonly horaeRows: readonly NormalizedDatasourceRecord[];
  readonly szdataRows: readonly NormalizedDatasourceRecord[];
  readonly snapshots: readonly SnapshotInput[];
  readonly annotations: readonly SchemaAnnotationInput[];
} {
  const horaeDir = resolve(options.horaeDir);
  const szdataDir = resolve(options.szdataDir);
  const horaeRowsPath = join(horaeDir, "rows.jsonl");
  const horaeSnapshotPath = join(horaeDir, "snapshot.json");
  const szdataRowsPath = join(szdataDir, "rows.jsonl");
  const szdataManifestPath = join(szdataDir, "manifest.json");
  for (const path of [
    horaeRowsPath,
    horaeSnapshotPath,
    szdataRowsPath,
    szdataManifestPath,
  ]) {
    if (!existsSync(path)) throw new Error(`SOURCE_FILE_MISSING:${path}`);
  }

  const horaeInput = readJsonl(horaeRowsPath, "HORAE");
  const szdataInput = readJsonl(szdataRowsPath, "SZDATA");
  const horaeSnapshot = parseJsonFile(
    horaeSnapshotPath,
    "INVALID_HORAE_SNAPSHOT",
  );
  const szdataManifest = parseJsonFile(
    szdataManifestPath,
    "INVALID_SZDATA_MANIFEST",
  );
  if (horaeSnapshot.artifact_type !== "HORAE_DATASOURCE_EVIDENCE") {
    throw new Error("UNEXPECTED_ARTIFACT_TYPE:HORAE");
  }
  if (szdataManifest.artifactType !== "SZDATA_DATASOURCE_EVIDENCE") {
    throw new Error("UNEXPECTED_ARTIFACT_TYPE:SZDATA");
  }
  const horaeRowCount = integerValue(horaeSnapshot.row_count, -1);
  const szdataRowCount = integerValue(szdataManifest.rowCount, -1);
  if (horaeRowCount !== horaeInput.rows.length) {
    throw new Error(
      `ROW_COUNT_MISMATCH:HORAE:declared=${horaeRowCount}:actual=${horaeInput.rows.length}`,
    );
  }
  if (szdataRowCount !== szdataInput.rows.length) {
    throw new Error(
      `ROW_COUNT_MISMATCH:SZDATA:declared=${szdataRowCount}:actual=${szdataInput.rows.length}`,
    );
  }
  if (
    !Array.isArray(horaeSnapshot.rows) ||
    JSON.stringify(horaeSnapshot.rows) !== JSON.stringify(horaeInput.rows)
  ) {
    throw new Error("SNAPSHOT_ROWS_MISMATCH:HORAE");
  }
  const szdataRowsHash = sha256(szdataInput.raw);
  const hashes =
    typeof szdataManifest.hashes === "object" && szdataManifest.hashes !== null
      ? (szdataManifest.hashes as JsonRecord)
      : {};
  const declaredRowsHash = stringValue(hashes.rowsSha256);
  if (declaredRowsHash !== "" && declaredRowsHash !== szdataRowsHash) {
    throw new Error("ROWS_HASH_MISMATCH:SZDATA");
  }

  const horaeRows = horaeInput.rows.map(normalizeHoraeRow);
  const szdataRows = szdataInput.rows.map(normalizeSzdataRow);
  validateUniqueRecordKeys(horaeRows);
  validateUniqueRecordKeys(szdataRows);
  const horaeTotal = integerValue(horaeSnapshot.total, horaeRows.length);
  const szdataTotal = integerValue(szdataManifest.total, szdataRows.length);
  const szdataCoverageGap = integerValue(
    szdataManifest.coverageGap,
    Math.max(0, szdataTotal - szdataRows.length),
  );
  const szdataFailureCount = integerValue(szdataManifest.failureCount);
  const annotations = loadSchemaAnnotations(options.annotationsPath);
  return {
    horaeRows,
    szdataRows,
    annotations,
    snapshots: [
      {
        sourceSystem: "HORAE",
        artifactType: stringValue(horaeSnapshot.artifact_type),
        schemaVersion: stringValue(horaeSnapshot.schema_version),
        observedAt: stringValue(horaeSnapshot.observed_at),
        declaredTotal: horaeTotal,
        fetchedRowCount: horaeRows.length,
        rowCount: horaeRows.length,
        coverageGap: Math.max(0, horaeTotal - horaeRows.length),
        failureCount: 0,
        duplicateGroupCount: 0,
        complete: horaeTotal === horaeRows.length,
        sourcePath: horaeSnapshotPath,
        rowsPath: horaeRowsPath,
        rowsSha256: sha256(horaeInput.raw),
        declaredContentSha256: stringValue(horaeSnapshot.content_sha256),
      },
      {
        sourceSystem: "SZDATA",
        artifactType: stringValue(szdataManifest.artifactType),
        schemaVersion: stringValue(szdataManifest.schemaVersion),
        observedAt: stringValue(szdataManifest.observedAt),
        declaredTotal: szdataTotal,
        fetchedRowCount: integerValue(
          szdataManifest.fetchedRowCount,
          szdataRows.length,
        ),
        rowCount: szdataRows.length,
        coverageGap: szdataCoverageGap,
        failureCount: szdataFailureCount,
        duplicateGroupCount: integerValue(szdataManifest.duplicateGroupCount),
        complete:
          szdataManifest.complete === true &&
          szdataCoverageGap === 0 &&
          szdataFailureCount === 0 &&
          szdataTotal === szdataRows.length,
        sourcePath: szdataManifestPath,
        rowsPath: szdataRowsPath,
        rowsSha256: szdataRowsHash,
        declaredContentSha256: declaredRowsHash,
      },
    ],
  };
}

function loadSchemaAnnotations(
  annotationsPath: string | undefined,
): readonly SchemaAnnotationInput[] {
  if (annotationsPath === undefined) return [];
  const path = resolve(annotationsPath);
  if (!existsSync(path)) throw new Error(`ANNOTATIONS_FILE_MISSING:${path}`);
  const document = parseJsonFile(path, "INVALID_SCHEMA_ANNOTATIONS");
  if (
    document.schemaVersion !== "1.0.0" ||
    !Array.isArray(document.annotations)
  ) {
    throw new Error("INVALID_SCHEMA_ANNOTATIONS");
  }
  const seen = new Set<string>();
  return document.annotations.map((value, index) => {
    const annotation = asRecord(value, `INVALID_SCHEMA_ANNOTATION:${index}`);
    const platform = requiredString(
      annotation.platform,
      `MISSING_ANNOTATION_IDENTITY:${index}:platform`,
    );
    const dataSource = requiredString(
      annotation.dataSource,
      `MISSING_ANNOTATION_IDENTITY:${index}:dataSource`,
    );
    const schemaName = requiredString(
      annotation.schemaName,
      `MISSING_ANNOTATION_IDENTITY:${index}:schemaName`,
    );
    const displayName = stringValue(annotation.displayName);
    const description = stringValue(annotation.description);
    if (displayName === "" && description === "") {
      throw new Error(`EMPTY_SCHEMA_ANNOTATION:${index}`);
    }
    const platformNorm = normalizeDatasourceText(platform);
    const dataSourceNorm = normalizeDatasourceText(dataSource);
    const schemaNameNorm = normalizeDatasourceText(schemaName);
    const key = `${platformNorm}\0${dataSourceNorm}\0${schemaNameNorm}`;
    if (seen.has(key)) throw new Error(`DUPLICATE_SCHEMA_ANNOTATION:${index}`);
    seen.add(key);
    return {
      platform,
      platformNorm,
      dataSource,
      dataSourceNorm,
      schemaName,
      schemaNameNorm,
      displayName,
      description,
    };
  });
}

function hostPortKey(row: NormalizedDatasourceRecord): string {
  const host = normalizeDatasourceText(row.host);
  return host !== "" && row.port !== null ? `${host}|${row.port}` : "";
}

function matchKey(
  row: NormalizedDatasourceRecord,
  method: DatasourceMatchMethod,
): string {
  if (method === "EXACT_IDENTIFIER") return row.identifierNorm;
  if (method === "HOST_PORT_TYPE_SERVICE") {
    const endpoint = hostPortKey(row);
    return endpoint !== "" &&
      row.dbTypeNorm !== "" &&
      row.serviceNameNorm !== ""
      ? `${endpoint}|${row.dbTypeNorm}|${row.serviceNameNorm}`
      : "";
  }
  return row.cmdbSystemNameNorm !== "" &&
    row.serviceNameNorm !== "" &&
    row.dbTypeNorm !== ""
    ? `${row.cmdbSystemNameNorm}|${row.serviceNameNorm}|${row.dbTypeNorm}`
    : "";
}

function indexByMatchKey(
  rows: readonly NormalizedDatasourceRecord[],
  method: DatasourceMatchMethod,
  used: ReadonlySet<string>,
): ReadonlyMap<string, readonly NormalizedDatasourceRecord[]> {
  const index = new Map<string, NormalizedDatasourceRecord[]>();
  for (const row of rows) {
    if (used.has(row.recordKey)) continue;
    const key = matchKey(row, method);
    if (key === "") continue;
    const current = index.get(key) ?? [];
    current.push(row);
    index.set(key, current);
  }
  return index;
}

export function matchDatasourceRecords(
  horaeRows: readonly NormalizedDatasourceRecord[],
  szdataRows: readonly NormalizedDatasourceRecord[],
): readonly MatchInput[] {
  const usedHorae = new Set<string>();
  const usedSzdata = new Set<string>();
  const matches: MatchInput[] = [];
  const stages: readonly {
    readonly method: DatasourceMatchMethod;
    readonly status: DatasourceMatchStatus;
  }[] = [
    { method: "EXACT_IDENTIFIER", status: "CONFIRMED" },
    { method: "HOST_PORT_TYPE_SERVICE", status: "CANDIDATE" },
    { method: "SYSTEM_SERVICE_TYPE", status: "CANDIDATE" },
  ];
  for (const stage of stages) {
    const horaeIndex = indexByMatchKey(horaeRows, stage.method, usedHorae);
    const szdataIndex = indexByMatchKey(szdataRows, stage.method, usedSzdata);
    for (const key of [...horaeIndex.keys()].sort()) {
      const horae = horaeIndex.get(key) ?? [];
      const szdata = szdataIndex.get(key) ?? [];
      if (horae.length !== 1 || szdata.length !== 1) continue;
      const horaeRow = horae[0]!;
      const szdataRow = szdata[0]!;
      usedHorae.add(horaeRow.recordKey);
      usedSzdata.add(szdataRow.recordKey);
      matches.push({
        horae: horaeRow,
        szdata: szdataRow,
        method: stage.method,
        status: stage.status,
        matchKeyHash: sha256(key),
      });
    }
  }
  return matches;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;

    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE import_snapshot (
      source_system TEXT PRIMARY KEY CHECK (source_system IN ('HORAE', 'SZDATA')),
      artifact_type TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      declared_total INTEGER NOT NULL,
      fetched_row_count INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      coverage_gap INTEGER NOT NULL,
      failure_count INTEGER NOT NULL,
      duplicate_group_count INTEGER NOT NULL,
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      source_path TEXT NOT NULL,
      rows_path TEXT NOT NULL,
      rows_sha256 TEXT NOT NULL,
      declared_content_sha256 TEXT NOT NULL
    );

    CREATE TABLE datasource_record (
      record_key TEXT PRIMARY KEY,
      source_system TEXT NOT NULL CHECK (source_system IN ('HORAE', 'SZDATA')),
      source_record_id TEXT NOT NULL,
      source_position INTEGER NOT NULL,
      identifier TEXT NOT NULL,
      identifier_norm TEXT NOT NULL,
      cmdb_system_name TEXT NOT NULL,
      cmdb_system_name_norm TEXT NOT NULL,
      db_type TEXT NOT NULL,
      db_type_norm TEXT NOT NULL,
      service_name TEXT NOT NULL,
      service_name_norm TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER,
      connectable INTEGER CHECK (connectable IS NULL OR connectable IN (0, 1)),
      user_name TEXT NOT NULL,
      attributes_json TEXT,
      row_sha256 TEXT NOT NULL,
      UNIQUE (source_system, source_record_id)
    );

    CREATE TABLE datasource_match (
      horae_record_key TEXT NOT NULL UNIQUE,
      szdata_record_key TEXT NOT NULL UNIQUE,
      match_method TEXT NOT NULL CHECK (match_method IN (
        'EXACT_IDENTIFIER', 'HOST_PORT_TYPE_SERVICE', 'SYSTEM_SERVICE_TYPE'
      )),
      match_status TEXT NOT NULL CHECK (match_status IN ('CONFIRMED', 'CANDIDATE')),
      match_rank INTEGER NOT NULL UNIQUE,
      match_key_sha256 TEXT NOT NULL,
      agreement_identifier INTEGER NOT NULL CHECK (agreement_identifier IN (0, 1)),
      agreement_type INTEGER NOT NULL CHECK (agreement_type IN (0, 1)),
      agreement_service INTEGER NOT NULL CHECK (agreement_service IN (0, 1)),
      agreement_cmdb INTEGER NOT NULL CHECK (agreement_cmdb IN (0, 1)),
      agreement_host_port INTEGER NOT NULL CHECK (agreement_host_port IN (0, 1)),
      conflict_count INTEGER NOT NULL,
      PRIMARY KEY (horae_record_key, szdata_record_key),
      FOREIGN KEY (horae_record_key) REFERENCES datasource_record(record_key),
      FOREIGN KEY (szdata_record_key) REFERENCES datasource_record(record_key)
    );

    CREATE TABLE datasource_schema (
      szdata_record_key TEXT NOT NULL,
      schema_ordinal INTEGER NOT NULL,
      schema_id TEXT NOT NULL,
      schema_name TEXT NOT NULL,
      schema_name_norm TEXT NOT NULL,
      short_name TEXT NOT NULL,
      remark TEXT,
      PRIMARY KEY (szdata_record_key, schema_ordinal),
      FOREIGN KEY (szdata_record_key) REFERENCES datasource_record(record_key)
    );

    CREATE TABLE datasource_access_point (
      szdata_record_key TEXT NOT NULL,
      access_ordinal INTEGER NOT NULL,
      access_point_id TEXT NOT NULL,
      access_tag TEXT NOT NULL,
      identifier TEXT NOT NULL,
      nickname TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER,
      PRIMARY KEY (szdata_record_key, access_ordinal),
      FOREIGN KEY (szdata_record_key) REFERENCES datasource_record(record_key)
    );

    CREATE TABLE schema_annotation (
      platform TEXT NOT NULL,
      platform_norm TEXT NOT NULL,
      data_source TEXT NOT NULL,
      data_source_norm TEXT NOT NULL,
      schema_name TEXT NOT NULL,
      schema_name_norm TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      PRIMARY KEY (platform_norm, data_source_norm, schema_name_norm)
    );

    CREATE INDEX idx_datasource_identifier
      ON datasource_record(identifier_norm, source_system);
    CREATE INDEX idx_datasource_type
      ON datasource_record(db_type_norm, source_system);
    CREATE INDEX idx_datasource_service
      ON datasource_record(service_name_norm, source_system);
    CREATE INDEX idx_datasource_schema_name
      ON datasource_schema(schema_name_norm, szdata_record_key);
  `);
}

function agreement(left: string, right: string): number {
  return left !== "" && right !== "" && left === right ? 1 : 0;
}

function conflict(left: string, right: string): number {
  return left !== "" && right !== "" && left !== right ? 1 : 0;
}

function insertCatalog(
  database: DatabaseSync,
  inputs: ReturnType<typeof loadInputs>,
  matches: readonly MatchInput[],
): {
  readonly schemas: number;
  readonly accessPoints: number;
  readonly annotations: number;
} {
  const insertMeta = database.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?)",
  );
  const insertSnapshot = database.prepare(`
    INSERT INTO import_snapshot(
      source_system, artifact_type, schema_version, observed_at, declared_total,
      fetched_row_count, row_count, coverage_gap, failure_count,
      duplicate_group_count, complete, source_path, rows_path, rows_sha256,
      declared_content_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRecord = database.prepare(`
    INSERT INTO datasource_record(
      record_key, source_system, source_record_id, source_position, identifier,
      identifier_norm, cmdb_system_name, cmdb_system_name_norm, db_type,
      db_type_norm, service_name, service_name_norm, host, port, connectable,
      user_name, attributes_json, row_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMatch = database.prepare(`
    INSERT INTO datasource_match(
      horae_record_key, szdata_record_key, match_method, match_status, match_rank,
      match_key_sha256, agreement_identifier, agreement_type, agreement_service,
      agreement_cmdb, agreement_host_port, conflict_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSchema = database.prepare(`
    INSERT INTO datasource_schema(
      szdata_record_key, schema_ordinal, schema_id, schema_name,
      schema_name_norm, short_name, remark
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAccessPoint = database.prepare(`
    INSERT INTO datasource_access_point(
      szdata_record_key, access_ordinal, access_point_id, access_tag,
      identifier, nickname, host, port
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAnnotation = database.prepare(`
    INSERT INTO schema_annotation(
      platform, platform_norm, data_source, data_source_norm, schema_name,
      schema_name_norm, display_name, description
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  database.exec("BEGIN IMMEDIATE");
  let schemaCount = 0;
  let accessPointCount = 0;
  try {
    insertMeta.run("schema_version", "1.0.0");
    insertMeta.run("artifact_type", "DATASOURCE_CATALOG");
    insertMeta.run("built_at", new Date().toISOString());
    for (const snapshot of inputs.snapshots) {
      insertSnapshot.run(
        snapshot.sourceSystem,
        snapshot.artifactType,
        snapshot.schemaVersion,
        snapshot.observedAt,
        snapshot.declaredTotal,
        snapshot.fetchedRowCount,
        snapshot.rowCount,
        snapshot.coverageGap,
        snapshot.failureCount,
        snapshot.duplicateGroupCount,
        snapshot.complete ? 1 : 0,
        snapshot.sourcePath,
        snapshot.rowsPath,
        snapshot.rowsSha256,
        snapshot.declaredContentSha256,
      );
    }
    for (const row of [...inputs.horaeRows, ...inputs.szdataRows]) {
      insertRecord.run(
        row.recordKey,
        row.sourceSystem,
        row.sourceRecordId,
        row.sourcePosition,
        row.identifier,
        row.identifierNorm,
        row.cmdbSystemName,
        row.cmdbSystemNameNorm,
        row.dbType,
        row.dbTypeNorm,
        row.serviceName,
        row.serviceNameNorm,
        row.host,
        row.port,
        row.connectable === null ? null : row.connectable ? 1 : 0,
        row.userName,
        row.attributesJson,
        row.rowSha256,
      );
      if (row.sourceSystem !== "SZDATA") continue;
      const schemas = nestedArray(
        row.source.schemasJson,
        "schemasJson",
        row.recordKey,
      );
      for (const [ordinal, schema] of schemas.entries()) {
        const schemaId = requiredString(
          schema.id,
          `MISSING_SCHEMA_ID:${row.recordKey}:${ordinal}`,
        );
        const schemaName = requiredString(
          schema.name,
          `MISSING_SCHEMA_NAME:${row.recordKey}:${ordinal}`,
        );
        insertSchema.run(
          row.recordKey,
          ordinal,
          schemaId,
          schemaName,
          normalizeDatasourceText(schemaName),
          stringValue(schema.shortName),
          schema.remark === null || schema.remark === undefined
            ? null
            : stringValue(schema.remark),
        );
        schemaCount += 1;
      }
      const accessPoints = nestedArray(
        row.source.accessPointsJson,
        "accessPointsJson",
        row.recordKey,
      );
      for (const [ordinal, accessPoint] of accessPoints.entries()) {
        insertAccessPoint.run(
          row.recordKey,
          ordinal,
          requiredString(
            accessPoint.id,
            `MISSING_ACCESS_POINT_ID:${row.recordKey}:${ordinal}`,
          ),
          stringValue(accessPoint.accessTag),
          requiredString(
            accessPoint.identifier,
            `MISSING_ACCESS_POINT_IDENTIFIER:${row.recordKey}:${ordinal}`,
          ),
          stringValue(accessPoint.nickname),
          stringValue(accessPoint.host),
          nullablePort(accessPoint.port),
        );
        accessPointCount += 1;
      }
    }
    for (const [index, match] of matches.entries()) {
      const identifierAgreement = agreement(
        match.horae.identifierNorm,
        match.szdata.identifierNorm,
      );
      const typeAgreement = agreement(
        match.horae.dbTypeNorm,
        match.szdata.dbTypeNorm,
      );
      const serviceAgreement = agreement(
        match.horae.serviceNameNorm,
        match.szdata.serviceNameNorm,
      );
      const cmdbAgreement = agreement(
        match.horae.cmdbSystemNameNorm,
        match.szdata.cmdbSystemNameNorm,
      );
      const hostPortAgreement = agreement(
        hostPortKey(match.horae),
        hostPortKey(match.szdata),
      );
      const conflictCount =
        conflict(match.horae.identifierNorm, match.szdata.identifierNorm) +
        conflict(match.horae.dbTypeNorm, match.szdata.dbTypeNorm) +
        conflict(match.horae.serviceNameNorm, match.szdata.serviceNameNorm) +
        conflict(
          match.horae.cmdbSystemNameNorm,
          match.szdata.cmdbSystemNameNorm,
        ) +
        conflict(hostPortKey(match.horae), hostPortKey(match.szdata));
      insertMatch.run(
        match.horae.recordKey,
        match.szdata.recordKey,
        match.method,
        match.status,
        index + 1,
        match.matchKeyHash,
        identifierAgreement,
        typeAgreement,
        serviceAgreement,
        cmdbAgreement,
        hostPortAgreement,
        conflictCount,
      );
    }
    for (const annotation of inputs.annotations) {
      insertAnnotation.run(
        annotation.platform,
        annotation.platformNorm,
        annotation.dataSource,
        annotation.dataSourceNorm,
        annotation.schemaName,
        annotation.schemaNameNorm,
        annotation.displayName,
        annotation.description,
      );
    }
    insertMeta.run(
      "summary",
      JSON.stringify({
        records: {
          horae: inputs.horaeRows.length,
          szdata: inputs.szdataRows.length,
        },
        matches: {
          confirmed: matches.filter((match) => match.status === "CONFIRMED")
            .length,
          candidates: matches.filter((match) => match.status === "CANDIDATE")
            .length,
          total: matches.length,
        },
        schemas: schemaCount,
        accessPoints: accessPointCount,
        annotations: inputs.annotations.length,
      }),
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    schemas: schemaCount,
    accessPoints: accessPointCount,
    annotations: inputs.annotations.length,
  };
}

function replaceDatabase(tempPath: string, databasePath: string): void {
  if (!existsSync(databasePath)) {
    renameSync(tempPath, databasePath);
    return;
  }
  const previousPath = `${databasePath}.previous-${process.pid}`;
  rmSync(previousPath, { force: true });
  renameSync(databasePath, previousPath);
  try {
    renameSync(tempPath, databasePath);
    rmSync(previousPath, { force: true });
  } catch (error) {
    if (!existsSync(databasePath) && existsSync(previousPath)) {
      renameSync(previousPath, databasePath);
    }
    throw error;
  }
}

export function buildDatasourceCatalog(
  options: BuildDatasourceCatalogOptions,
): DatasourceCatalogBuildResult {
  const inputs = loadInputs(options);
  const matches = matchDatasourceRecords(inputs.horaeRows, inputs.szdataRows);
  const databasePath = resolve(options.databasePath);
  mkdirSync(dirname(databasePath), { recursive: true });
  const tempPath = `${databasePath}.tmp-${process.pid}-${Date.now()}`;
  rmSync(tempPath, { force: true });
  const database = new DatabaseSync(tempPath);
  let counts: {
    readonly schemas: number;
    readonly accessPoints: number;
    readonly annotations: number;
  };
  try {
    createSchema(database);
    counts = insertCatalog(database, inputs, matches);
    preserveDatasourceAliases(databasePath, database);
  } catch (error) {
    database.close();
    rmSync(tempPath, { force: true });
    throw error;
  }
  database.close();
  replaceDatabase(tempPath, databasePath);
  const confirmed = matches.filter(
    (match) => match.status === "CONFIRMED",
  ).length;
  const candidates = matches.length - confirmed;
  return {
    databasePath,
    records: {
      horae: inputs.horaeRows.length,
      szdata: inputs.szdataRows.length,
    },
    matches: { confirmed, candidates, total: matches.length },
    schemas: counts.schemas,
    accessPoints: counts.accessPoints,
    annotations: counts.annotations,
    unresolved: {
      horae: inputs.horaeRows.length - matches.length,
      szdata: inputs.szdataRows.length - matches.length,
    },
  };
}

function paging(
  limit: number | undefined,
  offset: number | undefined,
): {
  readonly limit: number;
  readonly offset: number;
} {
  const resolvedLimit = limit ?? 30;
  const resolvedOffset = offset ?? 0;
  if (
    !Number.isSafeInteger(resolvedLimit) ||
    resolvedLimit < 1 ||
    resolvedLimit > 100
  ) {
    throw new Error("INVALID_LIMIT:expected=1..100");
  }
  if (
    !Number.isSafeInteger(resolvedOffset) ||
    resolvedOffset < 0 ||
    resolvedOffset > 10_000_000
  ) {
    throw new Error("INVALID_OFFSET:expected=0..10000000");
  }
  return { limit: resolvedLimit, offset: resolvedOffset };
}

function queryText(value: string | undefined, name: string): string {
  const text = value?.trim() ?? "";
  if (text.length > 200 || /[\x00-\x1f]/u.test(text)) {
    throw new Error(`INVALID_TEXT:${name}`);
  }
  return text;
}

function paginated<T>(
  items: readonly T[],
  total: number,
  page: { readonly limit: number; readonly offset: number },
): {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly nextOffset: number | null;
} {
  return {
    items,
    total,
    ...page,
    nextOffset:
      page.offset + items.length < total ? page.offset + items.length : null,
  };
}

function numberField(row: unknown, name: string): number {
  const value = (row as JsonRecord)[name];
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function catalogStatus(database: DatabaseSync): unknown {
  const snapshots = database
    .prepare(
      `SELECT source_system AS sourceSystem, observed_at AS observedAt,
        declared_total AS declaredTotal, fetched_row_count AS fetchedRowCount,
        row_count AS rowCount, coverage_gap AS coverageGap,
        failure_count AS failureCount, duplicate_group_count AS duplicateGroupCount,
        complete
       FROM import_snapshot ORDER BY source_system`,
    )
    .all() as readonly JsonRecord[];
  const summaryRow = database
    .prepare("SELECT value FROM meta WHERE key = 'summary'")
    .get() as JsonRecord | undefined;
  const summary = JSON.parse(stringValue(summaryRow?.value)) as JsonRecord;
  const bySource = Object.fromEntries(
    snapshots.map((row) => [
      String(row.sourceSystem).toLowerCase(),
      {
        observedAt: row.observedAt,
        declaredTotal: row.declaredTotal,
        fetchedRowCount: row.fetchedRowCount,
        rowCount: row.rowCount,
        coverageGap: row.coverageGap,
        failureCount: row.failureCount,
        duplicateGroupCount: row.duplicateGroupCount,
        complete: row.complete === 1,
      },
    ]),
  );
  return { ready: true, snapshots: bySource, ...summary };
}

function matchJoin(): string {
  return `
    LEFT JOIN datasource_match mh ON mh.horae_record_key = d.record_key
    LEFT JOIN datasource_match ms ON ms.szdata_record_key = d.record_key
    LEFT JOIN datasource_record counterpart ON counterpart.record_key =
      CASE WHEN d.source_system = 'HORAE' THEN mh.szdata_record_key ELSE ms.horae_record_key END
  `;
}

export function queryDatasourceRecords(
  database: DatabaseSync,
  options: DatasourceQueryOptions = {},
): ReturnType<typeof paginated> {
  const page = paging(options.limit, options.offset);
  const aliasAvailable = hasDatasourceAliases(database);
  const aliasExpression = aliasAvailable ? "a.alias" : "NULL";
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  const q = queryText(options.q, "q");
  if (q !== "") {
    const like = `%${q.replace(/[\\%_]/gu, "\\$&")}%`;
    clauses.push(`(
      d.identifier LIKE ? ESCAPE '\\' COLLATE NOCASE OR
      d.cmdb_system_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
      d.service_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
      ${aliasExpression} LIKE ? ESCAPE '\\' COLLATE NOCASE
    )`);
    values.push(like, like, like, like);
  }
  const identifier = queryText(options.identifier, "identifier");
  if (identifier !== "") {
    clauses.push("d.identifier_norm = ?");
    values.push(normalizeDatasourceText(identifier));
  }
  const dbType = queryText(options.dbType, "dbType");
  if (dbType !== "") {
    clauses.push("d.db_type_norm = ?");
    values.push(normalizeDatasourceType(dbType));
  }
  if (options.matchStatus !== undefined) {
    if (
      !["CONFIRMED", "CANDIDATE", "UNRESOLVED"].includes(options.matchStatus)
    ) {
      throw new Error("INVALID_MATCH_STATUS");
    }
    clauses.push(
      "COALESCE(mh.match_status, ms.match_status, 'UNRESOLVED') = ?",
    );
    values.push(options.matchStatus);
  }
  const schema = queryText(options.schema, "schema");
  if (schema !== "") {
    clauses.push(`EXISTS (
      SELECT 1 FROM datasource_schema ds
      WHERE ds.szdata_record_key = CASE
        WHEN d.source_system = 'SZDATA' THEN d.record_key
        ELSE mh.szdata_record_key
      END AND ds.schema_name_norm = ?
    )`);
    values.push(normalizeDatasourceText(schema));
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const aliasJoin = aliasAvailable
    ? "LEFT JOIN datasource_alias a ON d.source_system=a.source_system AND d.identifier=a.identifier"
    : "";
  const from = `FROM datasource_record d ${matchJoin()} ${aliasJoin} ${where}`;
  const totalRow = database
    .prepare(`SELECT COUNT(*) AS total ${from}`)
    .get(...values) as JsonRecord;
  const rows = database
    .prepare(
      `SELECT d.record_key AS recordKey, d.source_system AS sourceSystem,
        d.source_record_id AS sourceRecordId, d.identifier,
        d.cmdb_system_name AS systemName, d.db_type AS dbType,
        ${aliasExpression} AS alias,
        d.service_name AS serviceName, d.host, d.port, d.connectable,
        COALESCE(mh.match_status, ms.match_status, 'UNRESOLVED') AS matchStatus,
        COALESCE(mh.match_method, ms.match_method) AS matchMethod,
        counterpart.identifier AS counterpartIdentifier,
        (SELECT COUNT(*) FROM datasource_schema ds WHERE ds.szdata_record_key =
          CASE WHEN d.source_system = 'SZDATA' THEN d.record_key ELSE mh.szdata_record_key END
        ) AS schemaCount
       ${from}
       ORDER BY d.source_system, d.identifier_norm, d.source_record_id
       LIMIT ? OFFSET ?`,
    )
    .all(...values, page.limit, page.offset) as readonly JsonRecord[];
  const items = rows.map((row) => ({
    ...row,
    connectable: row.connectable === null ? null : row.connectable === 1,
  }));
  return paginated(items, numberField(totalRow, "total"), page);
}

function schemaQuery(
  database: DatabaseSync,
  options: SchemaQueryOptions,
  exactNameRequired: boolean,
): ReturnType<typeof paginated> {
  const page = paging(options.limit, options.offset);
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  const name = queryText(options.name, "name");
  if (exactNameRequired && name === "") throw new Error("SCHEMA_NAME_REQUIRED");
  if (name !== "") {
    clauses.push("s.schema_name_norm = ?");
    values.push(normalizeDatasourceText(name));
  }
  const q = queryText(options.q, "q");
  if (q !== "") {
    const like = `%${q.replace(/[\\%_]/gu, "\\$&")}%`;
    clauses.push(
      "(s.schema_name LIKE ? ESCAPE '\\' OR d.identifier LIKE ? ESCAPE '\\')",
    );
    values.push(like, like);
  }
  const identifier = queryText(options.identifier, "identifier");
  if (identifier !== "") {
    clauses.push("d.identifier_norm = ?");
    values.push(normalizeDatasourceText(identifier));
  }
  if (options.matchStatus !== undefined) {
    if (
      !["CONFIRMED", "CANDIDATE", "UNRESOLVED"].includes(options.matchStatus)
    ) {
      throw new Error("INVALID_MATCH_STATUS");
    }
    clauses.push("COALESCE(m.match_status, 'UNRESOLVED') = ?");
    values.push(options.matchStatus);
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const from = `
    FROM datasource_schema s
    JOIN datasource_record d ON d.record_key = s.szdata_record_key
    LEFT JOIN datasource_match m ON m.szdata_record_key = d.record_key
    LEFT JOIN datasource_record h ON h.record_key = m.horae_record_key
    ${where}
  `;
  const totalRow = database
    .prepare(`SELECT COUNT(*) AS total ${from}`)
    .get(...values) as JsonRecord;
  const rows = database
    .prepare(
      `SELECT s.schema_id AS schemaId, s.schema_name AS schemaName,
        s.short_name AS shortName, s.remark,
        d.source_record_id AS szdataId, d.identifier AS sourceIdentifier,
        d.db_type AS dbType, d.service_name AS serviceName,
        COALESCE(m.match_status, 'UNRESOLVED') AS matchStatus,
        m.match_method AS matchMethod, h.identifier AS horaeIdentifier
       ${from}
       ORDER BY s.schema_name_norm, d.identifier_norm, s.schema_ordinal
       LIMIT ? OFFSET ?`,
    )
    .all(...values, page.limit, page.offset) as readonly JsonRecord[];
  const items = rows.map((row) => ({
    ...row,
    szdataIdentifier: row.sourceIdentifier,
  }));
  return paginated(items, numberField(totalRow, "total"), page);
}

export function querySchemas(
  database: DatabaseSync,
  options: SchemaQueryOptions = {},
): ReturnType<typeof paginated> {
  return schemaQuery(database, options, false);
}

export function querySchemaMatches(
  database: DatabaseSync,
  options: SchemaQueryOptions,
): ReturnType<typeof paginated> {
  return schemaQuery(database, options, true);
}

/** File-provided aliases, including identifiers absent from platform snapshots. */
export function queryDatasourceAliases(
  database: DatabaseSync,
  options: DatasourceQueryOptions = {},
): ReturnType<typeof paginated> {
  const page = paging(options.limit, options.offset);
  if (options.schema || options.matchStatus) throw new Error("UNSUPPORTED_ALIAS_FILTER");
  if (!hasDatasourceAliases(database)) return paginated([], 0, page);
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  const q = queryText(options.q, "q");
  if (q) {
    const like = `%${q.replace(/[\\%_]/gu, "\\$&")}%`;
    clauses.push("(a.identifier LIKE ? ESCAPE '\\' OR a.alias LIKE ? ESCAPE '\\')");
    values.push(like, like);
  }
  const identifier = queryText(options.identifier, "identifier");
  if (identifier) {clauses.push("a.identifier = ?");values.push(identifier);}
  const dbType = queryText(options.dbType, "dbType");
  if (dbType) {clauses.push("a.db_type = ?");values.push(dbType);}
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = database.prepare(`SELECT count(*) total FROM datasource_alias a ${where}`).get(...values);
  const items = database.prepare(`SELECT a.source_system AS sourceSystem,
    a.identifier, a.db_type AS dbType, a.alias, 'FILE_SUPPLEMENT' AS recordSource,
    a.source_sha256 AS sourceSha256, a.imported_at AS importedAt,
    CASE WHEN EXISTS(SELECT 1 FROM datasource_record d
      WHERE d.source_system=a.source_system AND d.identifier=a.identifier)
      THEN 'IN_CATALOG' ELSE 'NOT_IN_CATALOG' END AS catalogStatus
    FROM datasource_alias a ${where} ORDER BY a.identifier LIMIT ? OFFSET ?`)
    .all(...values, page.limit, page.offset);
  return paginated(items, numberField(total, "total"), page);
}
