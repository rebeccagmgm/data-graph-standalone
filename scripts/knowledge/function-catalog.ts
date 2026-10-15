import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolveWorkspacePaths } from "../config/workspace-paths.ts";

export interface FunctionKnowledgeEntry {
  kind: "SIGNATURE" | "FUNCTION" | "VARIABLE" | "COMPATIBILITY" | "POLICY";
  name: string;
  engine: string;
  namespace?: string;
  status: "DOCUMENTED" | "UNVERIFIED" | "USER_POLICY";
  summary: string;
  details?: unknown;
}
export interface FunctionKnowledgeSource {
  title: string;
  locator: string;
  documentDate?: string;
  receivedAt: string;
  rawText: string;
  entries: FunctionKnowledgeEntry[];
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const kinds = new Set(["SIGNATURE", "FUNCTION", "VARIABLE", "COMPATIBILITY", "POLICY"]);

function validate(sources: FunctionKnowledgeSource[]): void {
  if (!Array.isArray(sources) || !sources.length) throw new Error("CATALOG_SOURCES_REQUIRED");
  for (const source of sources) {
    if (!source || [source.title, source.locator, source.rawText, source.receivedAt].some(v => typeof v !== "string" || !v.trim()) || !Array.isArray(source.entries))
      throw new Error("CATALOG_SOURCE_INVALID");
    for (const e of source.entries) {
      if (!e || !kinds.has(e.kind) || !["DOCUMENTED", "UNVERIFIED", "USER_POLICY"].includes(e.status) ||
        [e.name, e.engine, e.summary].some(v => typeof v !== "string" || !v.trim()) ||
        (e.namespace !== undefined && typeof e.namespace !== "string")) throw new Error("CATALOG_ENTRY_INVALID");
    }
  }
}

/** Append source versions and assertions. Conflicting sources remain separate;
 * this catalog is never an automatic executable parser-rule registry. */
export function importFunctionKnowledge(databasePath: string, sources: FunctionKnowledgeSource[]) {
  validate(sources);
  mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    db.exec(`CREATE TABLE IF NOT EXISTS sources (
      source_id TEXT PRIMARY KEY, title TEXT NOT NULL, locator TEXT NOT NULL,
      document_date TEXT, received_at TEXT NOT NULL, content_sha256 TEXT NOT NULL,
      raw_text TEXT NOT NULL, UNIQUE(locator, content_sha256));
      CREATE TABLE IF NOT EXISTS knowledge_entries (
      entry_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id),
      kind TEXT NOT NULL, name TEXT NOT NULL, engine TEXT NOT NULL, namespace TEXT NOT NULL,
      status TEXT NOT NULL, summary TEXT NOT NULL, details_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_entries_name ON knowledge_entries(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS knowledge_entries_source ON knowledge_entries(source_id);`);
    const sourceInsert = db.prepare("INSERT OR IGNORE INTO sources VALUES (?,?,?,?,?,?,?)");
    const entryInsert = db.prepare("INSERT OR IGNORE INTO knowledge_entries VALUES (?,?,?,?,?,?,?,?,?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const s of sources) {
        const contentHash = hash(s.rawText), sourceId = hash(`${s.locator}\0${contentHash}`);
        sourceInsert.run(sourceId, s.title, s.locator, s.documentDate ?? null, s.receivedAt, contentHash, s.rawText);
        for (const e of s.entries) {
          const values = [sourceId, e.kind, e.name, e.engine, e.namespace ?? "", e.status, e.summary, JSON.stringify(e.details ?? {})];
          entryInsert.run(hash(JSON.stringify(values)), ...values);
        }
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { sources: db.prepare("SELECT count(*) AS count FROM sources").get()!.count,
      entries: db.prepare("SELECT count(*) AS count FROM knowledge_entries").get()!.count };
  } finally { db.close(); }
}

export function queryFunctionKnowledge(databasePath: string, query?: string, limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("CATALOG_LIMIT_INVALID");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (query === undefined) return {
      sources: db.prepare("SELECT count(*) AS count FROM sources").get()!.count,
      entries: db.prepare("SELECT kind,status,count(*) AS count FROM knowledge_entries GROUP BY kind,status ORDER BY kind,status").all(),
    };
    return db.prepare(`SELECT e.kind,e.name,e.engine,e.namespace,e.status,e.summary,e.details_json,
      s.source_id,s.title,s.locator,s.document_date,s.content_sha256
      FROM knowledge_entries e JOIN sources s USING(source_id)
      WHERE instr(lower(e.name),lower(?))>0 ORDER BY e.name,e.engine,e.source_id,e.entry_id LIMIT ?`).all(query, limit);
  } finally { db.close(); }
}

export function readFunctionKnowledgeSource(databasePath: string, sourceId: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM sources WHERE source_id=?").get(sourceId);
    if (!row) throw new Error("CATALOG_SOURCE_NOT_FOUND");
    return row;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), option = (name: string) => {
    const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1];
  };
  const db = option("--db") ?? resolve(resolveWorkspacePaths({}).dataRoot, "knowledge/function-catalog.sqlite");
  const command = args[0];
  if (command === "import") {
    const input = option("--input");
    if (!input) throw new Error("Pass --input sources.json");
    console.log(JSON.stringify(importFunctionKnowledge(db, JSON.parse(readFileSync(input, "utf8").replace(/^\uFEFF/, "")))));
  } else if (command === "source") {
    const id = option("--id");
    if (!id) throw new Error("Pass --id source_id from find");
    console.log(JSON.stringify(readFunctionKnowledgeSource(db, id)));
  } else if (command === "stats" || command === "find") {
    const name = option("--name");
    if (command === "find" && !name) throw new Error("Pass --name function-or-variable");
    console.log(JSON.stringify(queryFunctionKnowledge(db, name, Number(option("--limit") ?? 50))));
  } else throw new Error("Use import --input, stats, source --id, or find --name [--limit 1..200]");
}
