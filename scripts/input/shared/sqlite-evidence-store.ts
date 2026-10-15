import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SqliteJsonEvidenceInput {
  readonly taskId: string;
  readonly evidenceType: string;
  readonly direction: string;
  readonly depth: number;
  readonly observedAt: string;
  readonly contentSha256: string;
  readonly payloadJson: string;
  readonly sourcePath: string;
}

export type SqliteUpsertResult = "inserted" | "updated" | "unchanged";

export function openScheduleEvidenceDatabase(
  databasePath: string,
): DatabaseSync {
  mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 30000;

    CREATE TABLE IF NOT EXISTS task_inventory (
      task_id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS evidence (
      task_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT '',
      depth INTEGER NOT NULL DEFAULT 0,
      format TEXT NOT NULL CHECK (format IN ('json', 'sql')),
      observed_at TEXT NOT NULL DEFAULT '',
      content_sha256 TEXT NOT NULL,
      payload_json TEXT,
      payload_text TEXT,
      source_path TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (task_id, evidence_type, direction, depth),
      FOREIGN KEY (task_id) REFERENCES task_inventory(task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_type
      ON evidence(evidence_type);
    CREATE INDEX IF NOT EXISTS idx_evidence_task
      ON evidence(task_id);
  `);
  return database;
}

export function upsertSqliteJsonEvidence(
  database: DatabaseSync,
  input: SqliteJsonEvidenceInput,
): SqliteUpsertResult {
  database
    .prepare(
      "INSERT INTO task_inventory(task_id) VALUES (?) ON CONFLICT(task_id) DO NOTHING",
    )
    .run(input.taskId);

  const existing = database
    .prepare(
      `SELECT content_sha256 AS contentSha256 FROM evidence
       WHERE task_id = ? AND evidence_type = ? AND direction = ? AND depth = ?`,
    )
    .get(input.taskId, input.evidenceType, input.direction, input.depth) as
    { readonly contentSha256?: unknown } | undefined;
  if (existing?.contentSha256 === input.contentSha256) return "unchanged";

  database
    .prepare(
      `INSERT INTO evidence(
        task_id, evidence_type, direction, depth, format, observed_at,
        content_sha256, payload_json, payload_text, source_path, imported_at
      ) VALUES (?, ?, ?, ?, 'json', ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(task_id, evidence_type, direction, depth) DO UPDATE SET
        format = excluded.format,
        observed_at = excluded.observed_at,
        content_sha256 = excluded.content_sha256,
        payload_json = excluded.payload_json,
        payload_text = excluded.payload_text,
        source_path = excluded.source_path,
        imported_at = excluded.imported_at`,
    )
    .run(
      input.taskId,
      input.evidenceType,
      input.direction,
      input.depth,
      input.observedAt,
      input.contentSha256,
      input.payloadJson,
      input.sourcePath,
      new Date().toISOString(),
    );
  return existing === undefined ? "inserted" : "updated";
}
