import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  validateTableDocument,
  type TableDocument,
} from "../../../../scripts/input/shared/input-pack.ts";
// This is the repository's single DDL definition parser. The catalog persists
// its output; request-time readers never run the parser.
// @ts-expect-error JavaScript module has no declaration file in this package.
import { parseDefinition } from "../../../../scripts/inventory-map/analysis-evidence.mjs";
import { TABLE_METADATA_CATALOG_SCHEMA_VERSION } from "./table-metadata-catalog.ts";

export interface CatalogBuildScope {
  readonly platforms?: readonly string[];
  readonly tables?: readonly {
    readonly platform: string;
    readonly stableTableId: string;
  }[];
}

export interface CatalogBuildOptions {
  readonly tablesRoot: string;
  readonly catalogRoot: string;
  readonly scope?: CatalogBuildScope;
  readonly now?: () => string;
  /** Test seam immediately before the atomic manifest switch. */
  readonly beforeActivate?: () => void;
}

export interface CatalogBuildReport {
  readonly changed: boolean;
  readonly version: string;
  readonly file: string;
  readonly builtAt: string;
  readonly parserVersion: string;
  readonly scope: "FULL" | "SCOPED";
  readonly counts: {
    readonly discovered: number;
    readonly parsed: number;
    readonly unsupported: number;
    readonly failed: number;
    readonly deleted: number;
  };
  readonly catalogCounts: {
    readonly tables: number;
    readonly fields: number;
    readonly issues: number;
  };
  readonly elapsedMs: number;
}

interface DefinitionField {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly comment?: unknown;
  readonly ordinal?: unknown;
  readonly partition?: unknown;
}

interface Definition {
  readonly parseStatus?: "PARSED" | "UNSUPPORTED" | "INVALID";
  readonly description?: unknown;
  readonly fields?: readonly DefinitionField[];
}

interface CurrentManifest {
  readonly schemaVersion: string;
  readonly version: string;
  readonly file: string;
  readonly builtAt: string;
  readonly parserVersion: string;
  readonly catalogHash: string;
}

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const WINDOWS_REPLACE_COMMAND =
  "$ErrorActionPreference = 'Stop'; [System.IO.File]::Replace($env:SQL_STATIC_LINEAGE_METADATA_SOURCE, $env:SQL_STATIC_LINEAGE_METADATA_DESTINATION, [NullString]::Value)";

function replaceCatalogManifest(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (renameError) {
    if (
      platform() !== "win32" ||
      (renameError as NodeJS.ErrnoException | null)?.code !== "EPERM" ||
      !existsSync(destination)
    )
      throw renameError;
    try {
      execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_REPLACE_COMMAND,
        ],
        {
          windowsHide: true,
          stdio: "pipe",
          env: {
            ...process.env,
            SQL_STATIC_LINEAGE_METADATA_SOURCE: source,
            SQL_STATIC_LINEAGE_METADATA_DESTINATION: destination,
          },
        },
      );
    } catch (nativeError) {
      throw new AggregateError(
        [renameError, nativeError],
        "TABLE_METADATA_CATALOG_ACTIVATION_FAILED",
      );
    }
  }
}

const PARSER_PATH = resolve(
  MODULE_ROOT,
  "../../../../scripts/inventory-map/analysis-evidence.mjs",
);
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const normalized = (value: unknown) => text(value).toLowerCase();
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const slash = (value: string) => value.split(sep).join("/");

function fileSignature(path: string): string {
  const value = statSync(path);
  return `${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

function stableRead(path: string): {
  readonly content: Buffer;
  readonly hash: string;
  readonly signature: string;
} {
  const before = statSync(path);
  const content = readFileSync(path);
  const after = statSync(path);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error("SOURCE_CHANGED_DURING_IMPORT");
  return {
    content,
    hash: sha256(content),
    signature: `${before.size}:${before.mtimeMs}:${before.ctimeMs}`,
  };
}

function initialize(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    PRAGMA temp_store=FILE;
    PRAGMA foreign_keys=ON;
    CREATE TABLE catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE tables(
      id INTEGER PRIMARY KEY,
      stable_table_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      data_source TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      table_name TEXT NOT NULL,
      description TEXT NOT NULL,
      description_normalized TEXT NOT NULL,
      object_type TEXT NOT NULL,
      source TEXT NOT NULL,
      source_path TEXT NOT NULL UNIQUE,
      source_hash TEXT NOT NULL,
      ddl_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      parse_status TEXT NOT NULL CHECK(parse_status IN ('PARSED','UNSUPPORTED','INVALID'))
    );
    CREATE INDEX tables_identity ON tables(platform,data_source,qualified_name,stable_table_id);
    CREATE INDEX tables_description ON tables(description_normalized);
    CREATE TABLE fields(
      table_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
      normalized_name TEXT NOT NULL,
      name TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      raw_type TEXT NOT NULL,
      comment TEXT NOT NULL,
      is_partition INTEGER NOT NULL CHECK(is_partition IN (0,1)),
      PRIMARY KEY(table_id,ordinal)
    ) WITHOUT ROWID;
    CREATE INDEX fields_name ON fields(table_id,normalized_name);
    CREATE TABLE import_issues(
      source_path TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      stable_table_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
}

function currentManifest(catalogRoot: string): CurrentManifest | undefined {
  const path = join(catalogRoot, "current.json");
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as CurrentManifest;
  if (
    value.schemaVersion !== TABLE_METADATA_CATALOG_SCHEMA_VERSION ||
    !text(value.file) ||
    !text(value.version) ||
    !text(value.catalogHash)
  )
    throw new Error("METADATA_CATALOG_VERSION_UNSUPPORTED");
  return value;
}

function selectedDirectories(
  tablesRoot: string,
  scope?: CatalogBuildScope,
): readonly {
  readonly platform: string;
  readonly stableTableId: string;
  readonly path: string;
}[] {
  if (scope?.tables?.length) {
    return [
      ...new Map(
        scope.tables.map((item) => {
          const platform = normalized(item.platform);
          const stableTableId = text(item.stableTableId);
          if (!platform || !stableTableId)
            throw new Error("INVALID_METADATA_CATALOG_SCOPE");
          return [
            `${platform}\0${stableTableId}`,
            {
              platform,
              stableTableId,
              path: join(tablesRoot, platform, stableTableId),
            },
          ];
        }),
      ).values(),
    ];
  }
  const selectedPlatforms = scope?.platforms?.length
    ? new Set(scope.platforms.map(normalized).filter(Boolean))
    : undefined;
  if (!existsSync(tablesRoot))
    throw new Error("TABLE_INPUT_PACK_ROOT_UNREADABLE");
  const directories: Array<{
    platform: string;
    stableTableId: string;
    path: string;
  }> = [];
  for (const platformEntry of readdirSync(tablesRoot, {
    withFileTypes: true,
  })) {
    if (!platformEntry.isDirectory()) continue;
    const platform = normalized(platformEntry.name);
    if (selectedPlatforms && !selectedPlatforms.has(platform)) continue;
    const platformRoot = join(tablesRoot, platformEntry.name);
    for (const tableEntry of readdirSync(platformRoot, {
      withFileTypes: true,
    })) {
      if (!tableEntry.isDirectory()) continue;
      directories.push({
        platform,
        stableTableId: tableEntry.name,
        path: join(platformRoot, tableEntry.name),
      });
    }
  }
  return directories.sort((left, right) =>
    `${left.platform}\0${left.stableTableId}`.localeCompare(
      `${right.platform}\0${right.stableTableId}`,
    ),
  );
}

function deleteScope(database: DatabaseSync, scope: CatalogBuildScope): number {
  let deleted = 0;
  for (const platform of scope.platforms ?? []) {
    const key = normalized(platform);
    const result = database
      .prepare("DELETE FROM tables WHERE platform=?")
      .run(key);
    deleted += Number(result.changes);
    database.prepare("DELETE FROM import_issues WHERE platform=?").run(key);
  }
  for (const table of scope.tables ?? []) {
    const platform = normalized(table.platform);
    const stableTableId = text(table.stableTableId);
    const result = database
      .prepare("DELETE FROM tables WHERE platform=? AND stable_table_id=?")
      .run(platform, stableTableId);
    deleted += Number(result.changes);
    database
      .prepare(
        "DELETE FROM import_issues WHERE platform=? AND stable_table_id=?",
      )
      .run(platform, stableTableId);
  }
  return deleted;
}

function importIssue(
  database: DatabaseSync,
  input: {
    readonly sourcePath: string;
    readonly platform: string;
    readonly stableTableId: string;
    readonly reason: string;
    readonly sourceHash?: string;
    readonly updatedAt: string;
  },
): void {
  database
    .prepare("INSERT OR REPLACE INTO import_issues VALUES(?,?,?,?,?,?)")
    .run(
      input.sourcePath,
      input.platform,
      input.stableTableId,
      input.reason,
      input.sourceHash ?? "",
      input.updatedAt,
    );
}

function importPack(
  database: DatabaseSync,
  tablesRoot: string,
  directory: {
    readonly platform: string;
    readonly stableTableId: string;
    readonly path: string;
  },
  builtAt: string,
): "PARSED" | "UNSUPPORTED" | "FAILED" | "DELETED" {
  if (!existsSync(directory.path)) return "DELETED";
  const sourcePath = slash(relative(tablesRoot, directory.path));
  const tablePath = join(directory.path, "table.json");
  let tableSourceHash = "";
  try {
    const tableSource = stableRead(tablePath);
    tableSourceHash = tableSource.hash;
    const document = JSON.parse(
      tableSource.content.toString("utf8"),
    ) as TableDocument;
    validateTableDocument(document);
    if (
      normalized(document.platform) !== directory.platform ||
      text(document.stableTableId) !== directory.stableTableId
    )
      throw new Error("TABLE_PACK_DIRECTORY_IDENTITY_MISMATCH");
    const ddlPath = join(directory.path, "ddl.sql");
    const ddlSource = stableRead(ddlPath);
    if (fileSignature(tablePath) !== tableSource.signature)
      throw new Error("SOURCE_CHANGED_DURING_IMPORT");
    const expectedDdlHash = text(document.ddlFile.sha256);
    if (ddlSource.hash !== expectedDdlHash)
      throw new Error("TABLE_DDL_HASH_MISMATCH");
    const definition = parseDefinition(
      ddlSource.content.toString("utf8"),
    ) as Definition;
    const parseStatus = definition.parseStatus ?? "INVALID";
    const description =
      text(document.description) ||
      (parseStatus === "PARSED" ? text(definition.description) : "");
    const result = database
      .prepare(
        `INSERT INTO tables(
          stable_table_id,platform,data_source,qualified_name,table_name,
          description,description_normalized,object_type,source,source_path,
          source_hash,ddl_hash,content_hash,collected_at,updated_at,parse_status
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        text(document.stableTableId),
        normalized(document.platform),
        normalized(document.dataSource),
        normalized(document.qualifiedName),
        text(document.name) ||
          text(document.qualifiedName).split(".").at(-1) ||
          "",
        description,
        normalized(description),
        text(document.objectType),
        text(document.evidenceProvider) ||
          text(document.ddlFile.evidenceProvider) ||
          "Table Input Pack",
        sourcePath,
        tableSource.hash,
        ddlSource.hash,
        text(document.contentHash),
        text(document.collectedAt),
        builtAt,
        parseStatus,
      );
    const tableId = Number(result.lastInsertRowid);
    if (parseStatus === "PARSED") {
      const insert = database.prepare(
        "INSERT INTO fields VALUES(?,?,?,?,?,?,?)",
      );
      for (const [index, field] of (definition.fields ?? []).entries()) {
        const name = text(field.name);
        const ordinal = Number.isInteger(field.ordinal)
          ? Number(field.ordinal)
          : index;
        if (!name || !Number.isSafeInteger(ordinal) || ordinal < 0)
          throw new Error("TABLE_DDL_FIELD_INVALID");
        insert.run(
          tableId,
          normalized(name),
          name,
          ordinal,
          text(field.type),
          text(field.comment),
          field.partition === true ? 1 : 0,
        );
      }
      return "PARSED";
    }
    return parseStatus === "UNSUPPORTED" ? "UNSUPPORTED" : "FAILED";
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message.includes("contentHash does not match")
          ? "TABLE_PACK_CONTENT_HASH_MISMATCH"
          : error.message
        : "TABLE_PACK_IMPORT_FAILED";
    database.prepare("DELETE FROM tables WHERE source_path=?").run(sourcePath);
    importIssue(database, {
      sourcePath,
      platform: directory.platform,
      stableTableId: directory.stableTableId,
      reason,
      sourceHash: tableSourceHash,
      updatedAt: builtAt,
    });
    return "FAILED";
  }
}

function catalogHash(database: DatabaseSync, parserVersion: string): string {
  const hash = createHash("sha256").update(
    `${TABLE_METADATA_CATALOG_SCHEMA_VERSION}\n${parserVersion}\n`,
  );
  for (const [kind, sql] of [
    [
      "table",
      `SELECT stable_table_id,platform,data_source,qualified_name,table_name,
       description,object_type,source,source_path,source_hash,ddl_hash,
       content_hash,collected_at,parse_status FROM tables ORDER BY source_path`,
    ],
    [
      "field",
      `SELECT t.source_path,f.normalized_name,f.name,f.ordinal,f.raw_type,
       f.comment,f.is_partition FROM fields f JOIN tables t ON t.id=f.table_id
       ORDER BY t.source_path,f.ordinal`,
    ],
    [
      "issue",
      `SELECT source_path,platform,stable_table_id,reason,source_hash
       FROM import_issues ORDER BY source_path`,
    ],
  ] as const)
    for (const row of database.prepare(sql).iterate())
      hash.update(`${kind}\n${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

function count(database: DatabaseSync, table: string): number {
  const row = database
    .prepare(`SELECT count(*) AS count FROM ${table}`)
    .get() as {
    count: number | bigint;
  };
  return Number(row.count);
}

export function buildTableMetadataCatalog(
  options: CatalogBuildOptions,
): CatalogBuildReport {
  const started = Date.now();
  const tablesRoot = resolve(options.tablesRoot);
  const catalogRoot = resolve(options.catalogRoot);
  const builtAt = options.now?.() ?? new Date().toISOString();
  const parserVersion = sha256(readFileSync(PARSER_PATH));
  const scopeKind = options.scope ? "SCOPED" : "FULL";
  mkdirSync(catalogRoot, { recursive: true });
  const current = currentManifest(catalogRoot);
  if (options.scope && !current)
    throw new Error("SCOPED_METADATA_CATALOG_UPDATE_REQUIRES_CURRENT");
  const staging = join(catalogRoot, `.staging-${randomUUID()}.sqlite`);
  let database: DatabaseSync | undefined;
  let finalDatabase: string | undefined;
  let manifestStaging: string | undefined;
  let activated = false;
  try {
    if (options.scope && current)
      copyFileSync(resolve(catalogRoot, current.file), staging);
    database = new DatabaseSync(staging);
    if (options.scope) {
      const schema = database
        .prepare("SELECT value FROM catalog_meta WHERE key='schema_version'")
        .get() as { value?: unknown } | undefined;
      if (schema?.value !== TABLE_METADATA_CATALOG_SCHEMA_VERSION)
        throw new Error("METADATA_CATALOG_VERSION_UNSUPPORTED");
    } else initialize(database);
    database.exec("BEGIN IMMEDIATE");
    const deleted = options.scope ? deleteScope(database, options.scope) : 0;
    const directories = selectedDirectories(tablesRoot, options.scope);
    const counts = {
      discovered: directories.length,
      parsed: 0,
      unsupported: 0,
      failed: 0,
      deleted,
    };
    for (const directory of directories) {
      const status = importPack(database, tablesRoot, directory, builtAt);
      if (status === "PARSED") counts.parsed += 1;
      else if (status === "UNSUPPORTED") counts.unsupported += 1;
      else if (status === "FAILED") counts.failed += 1;
    }
    database
      .prepare("INSERT OR REPLACE INTO catalog_meta VALUES('schema_version',?)")
      .run(TABLE_METADATA_CATALOG_SCHEMA_VERSION);
    database
      .prepare("INSERT OR REPLACE INTO catalog_meta VALUES('parser_version',?)")
      .run(parserVersion);
    database.exec("COMMIT");
    const hash = catalogHash(database, parserVersion);
    const catalogCounts = {
      tables: count(database, "tables"),
      fields: count(database, "fields"),
      issues: count(database, "import_issues"),
    };
    database
      .prepare("INSERT OR REPLACE INTO catalog_meta VALUES('catalog_hash',?)")
      .run(hash);
    database
      .prepare("INSERT OR REPLACE INTO catalog_meta VALUES('built_at',?)")
      .run(builtAt);
    database.close();
    database = undefined;
    if (current?.catalogHash === hash) {
      rmSync(staging, { force: true });
      return {
        changed: false,
        version: current.version,
        file: current.file,
        builtAt: current.builtAt,
        parserVersion: current.parserVersion,
        scope: scopeKind,
        counts,
        catalogCounts,
        elapsedMs: Date.now() - started,
      };
    }
    const version = hash;
    const file = `table-metadata-${hash.slice(0, 16)}-${randomUUID()}.sqlite`;
    finalDatabase = join(catalogRoot, file);
    renameSync(staging, finalDatabase);
    const manifest: CurrentManifest = {
      schemaVersion: TABLE_METADATA_CATALOG_SCHEMA_VERSION,
      version,
      file,
      builtAt,
      parserVersion,
      catalogHash: hash,
    };
    manifestStaging = join(catalogRoot, `.current-${randomUUID()}.json`);
    writeFileSync(
      manifestStaging,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    options.beforeActivate?.();
    replaceCatalogManifest(manifestStaging, join(catalogRoot, "current.json"));
    activated = true;
    return {
      changed: true,
      version,
      file,
      builtAt,
      parserVersion,
      scope: scopeKind,
      counts,
      catalogCounts,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    try {
      database?.exec("ROLLBACK");
    } catch {
      // Preserve the original import failure.
    }
    database?.close();
    rmSync(staging, { force: true });
    if (!activated && finalDatabase) rmSync(finalDatabase, { force: true });
    if (!activated && manifestStaging) rmSync(manifestStaging, { force: true });
    throw error;
  }
}
