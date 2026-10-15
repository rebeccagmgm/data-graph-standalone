import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

export interface TopicRow {
  topic: string;
  description: string;
  taskCountSnapshot: number;
}

export function parseTopicCatalog(content: string): TopicRow[] {
  const rows = new Map<string, TopicRow>();
  let headerSeen = false;
  for (const [index, line] of content.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const cells = line.split("\t").map((cell) => cell.trim());
    if (cells.join("\t") === "主题\t主题描述\t任务数量\t操作") {
      headerSeen = true;
      continue;
    }
    const [topic, description, count] = cells;
    if (!headerSeen || cells.length < 3 || cells.length > 4 || cells[3] ||
        !topic || !description || !/^\d+$/.test(count ?? "") ||
        !Number.isSafeInteger(Number(count))) {
      throw new Error(`INVALID_TOPIC_ROW:${index + 1}`);
    }
    if (rows.has(topic)) throw new Error(`DUPLICATE_TOPIC_ROW:${index + 1}`);
    rows.set(topic, { topic, description, taskCountSnapshot: Number(count) });
  }
  if (!headerSeen || !rows.size) throw new Error("EMPTY_TOPIC_CATALOG");
  return [...rows.values()];
}

export function importTopicCatalog(sourcePath: string, databasePath: string) {
  const source = readFileSync(sourcePath);
  const rows = parseTopicCatalog(source.toString("utf8"));
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  if (!existsSync(databasePath)) throw new Error("SCHEDULE_DATABASE_MISSING");
  const database = new DatabaseSync(databasePath);
  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='horae_task_catalog'").get()) {
      throw new Error("TASK_CATALOG_MISSING");
    }
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    try {
      database.exec(`CREATE TABLE IF NOT EXISTS horae_topic_catalog (
        topic TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        task_count_snapshot INTEGER NOT NULL CHECK(task_count_snapshot >= 0),
        source_path TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        imported_at TEXT NOT NULL
      )`);
      const upsert = database.prepare(`INSERT INTO horae_topic_catalog
        (topic, description, task_count_snapshot, source_path, source_sha256, imported_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(topic) DO UPDATE SET
          description=excluded.description,
          task_count_snapshot=excluded.task_count_snapshot,
          source_path=excluded.source_path,
          source_sha256=excluded.source_sha256,
          imported_at=excluded.imported_at
        WHERE description <> excluded.description
          OR task_count_snapshot <> excluded.task_count_snapshot
          OR source_path <> excluded.source_path
          OR source_sha256 <> excluded.source_sha256`);
      const importedAt = new Date().toISOString();
      let changed = 0;
      for (const row of rows) {
        changed += Number(upsert.run(row.topic, row.description, row.taskCountSnapshot,
          resolve(sourcePath), sourceSha256, importedAt).changes);
      }
      const coverage = database.prepare(`SELECT count(*) AS totalTasks,
        count(d.topic) AS matchedTasks, count(DISTINCT t.topic) AS totalTopics,
        count(DISTINCT d.topic) AS matchedTopics
        FROM horae_task_catalog t LEFT JOIN horae_topic_catalog d ON t.topic=d.topic`).get();
      database.exec("COMMIT");
      return { sourceRows: rows.length, changed, sourceSha256, coverage };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { source: { type: "string" }, database: { type: "string" } } });
  if (!values.source || !values.database) throw new Error("REQUIRED:--source --database");
  console.log(JSON.stringify(importTopicCatalog(values.source, values.database)));
}

