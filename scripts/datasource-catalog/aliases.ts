import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DatasourceAliasRow {
  identifier: string;
  dbType: string;
  alias: string;
  sourceLine: number;
  rawJson: string;
}

export function parseDatasourceAliases(text: string): DatasourceAliasRow[] {
  const result: DatasourceAliasRow[] = [];
  const identifiers = new Set<string>();
  const totals = new Set<number>();
  let headerSeen = false;
  for (const [index, line] of text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .entries()) {
    const total = line.match(/共([\d,]+)项/);
    if (total) totals.add(Number(total[1]!.replaceAll(",", "")));
    if (!line.trim() || !line.includes("\t")) continue;
    const cells = line.split("\t").map((cell) => cell.trim());
    if (
      cells.length === 11 &&
      cells[0] === "" &&
      cells[1] === "数据源标识" &&
      cells[2] === "数据源类型" &&
      cells[3] === "数据源别名"
    ) {
      headerSeen = true;
      continue;
    }
    if (!headerSeen || cells.length !== 10 || !cells[0] || !cells[1]) {
      throw new Error(`INVALID_DATASOURCE_ALIAS_ROW:${index + 1}`);
    }
    const identifier = cells[0];
    if (identifiers.has(identifier))
      throw new Error(`DUPLICATE_DATASOURCE_ALIAS_ROW:${index + 1}`);
    identifiers.add(identifier);
    result.push({
      identifier,
      dbType: cells[1],
      alias: cells[2] ?? "",
      sourceLine: index + 1,
      rawJson: JSON.stringify(
        Object.fromEntries(
          [
            "identifier",
            "dbType",
            "alias",
            "host",
            "port",
            "service",
            "user",
            "dba",
            "requester",
            "cmdb",
          ].map((key, i) => [key, cells[i]]),
        ),
      ),
    });
  }
  if (!headerSeen || !result.length)
    throw new Error("EMPTY_DATASOURCE_ALIASES");
  if (totals.size !== 1 || !totals.has(result.length))
    throw new Error("DATASOURCE_ALIAS_ROW_COUNT_MISMATCH");
  return result;
}

export function hasDatasourceAliases(database: DatabaseSync): boolean {
  return Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='datasource_alias'",
      )
      .get(),
  );
}

function createAliasTable(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS datasource_alias (
    source_system TEXT NOT NULL CHECK(source_system='HORAE'),
    identifier TEXT NOT NULL,
    db_type TEXT NOT NULL,
    alias TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY(source_system, identifier)
  )`);
}

export function importDatasourceAliases(
  sourcePath: string,
  databasePath: string,
) {
  const source = readFileSync(sourcePath);
  const rows = parseDatasourceAliases(source.toString("utf8"));
  if (!existsSync(databasePath)) throw new Error("DATASOURCE_CATALOG_MISSING");
  const hash = createHash("sha256").update(source).digest("hex");
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare("SELECT 1 FROM datasource_record LIMIT 1").get();
    database.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    try {
      createAliasTable(database);
      const insert = database.prepare(`INSERT INTO datasource_alias
        (source_system,identifier,db_type,alias,source_line,raw_json,source_path,source_sha256,imported_at)
        VALUES ('HORAE',?,?,?,?,?,?,?,?)
        ON CONFLICT(source_system,identifier) DO UPDATE SET
          db_type=excluded.db_type, alias=excluded.alias, source_line=excluded.source_line,
          raw_json=excluded.raw_json, source_path=excluded.source_path,
          source_sha256=excluded.source_sha256, imported_at=excluded.imported_at
        WHERE source_sha256 <> excluded.source_sha256 OR source_path <> excluded.source_path`);
      const now = new Date().toISOString();
      let changed = 0;
      for (const row of rows) {
        changed += Number(
          insert.run(
            row.identifier,
            row.dbType,
            row.alias,
            row.sourceLine,
            row.rawJson,
            resolve(sourcePath),
            hash,
            now,
          ).changes,
        );
      }
      const coverage = database
        .prepare(
          `SELECT count(*) totalRecords,
        sum(alias <> '') withAlias,
        sum(EXISTS(SELECT 1 FROM datasource_record d
          WHERE d.source_system=a.source_system AND d.identifier=a.identifier)) matchedRecords
        FROM datasource_alias a`,
        )
        .get();
      database.exec("COMMIT");
      return {
        importedRows: rows.length,
        changed,
        sourceSha256: hash,
        coverage,
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

/** The file supplement is independent of the rebuilt platform snapshots. */
export function preserveDatasourceAliases(
  previousPath: string,
  target: DatabaseSync,
): void {
  if (!existsSync(previousPath)) return;
  const previous = new DatabaseSync(previousPath, { readOnly: true });
  try {
    if (!hasDatasourceAliases(previous)) return;
    createAliasTable(target);
    const insert = target.prepare(
      "INSERT INTO datasource_alias VALUES (?,?,?,?,?,?,?,?,?)",
    );
    target.exec("BEGIN");
    try {
      for (const row of previous
        .prepare(
          "SELECT source_system,identifier,db_type,alias,source_line,raw_json,source_path,source_sha256,imported_at FROM datasource_alias",
        )
        .iterate()) {
        insert.run(
          row.source_system!,
          row.identifier!,
          row.db_type!,
          row.alias!,
          row.source_line!,
          row.raw_json!,
          row.source_path!,
          row.source_sha256!,
          row.imported_at!,
        );
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
  } finally {
    previous.close();
  }
}
