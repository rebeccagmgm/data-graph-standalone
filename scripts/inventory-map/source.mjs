import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function defaultSourcePath() {
  const configPath = join(REPOSITORY_ROOT, "config/workspace-paths.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof config.evidenceRoot !== "string")
    throw new Error("WORKSPACE_EVIDENCE_ROOT_MISSING");
  return join(
    resolve(dirname(configPath), config.evidenceRoot),
    "schedule-evidence/tasks-sqlite/schedule-evidence.sqlite",
  );
}

/** Keep a read transaction open while iterating all inputs, including a WAL-backed source. */
export function openSource(sourcePath) {
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    database.exec(
      "PRAGMA query_only = ON; PRAGMA busy_timeout = 30000; BEGIN;",
    );
    const sourceCounts = database
      .prepare(
        `SELECT
      (SELECT count(*) FROM task_inventory) AS inventoryTasks,
      count(*) AS evidenceRecords, min(nullif(observed_at, '')) AS observedMin,
      max(nullif(observed_at, '')) AS observedMax FROM evidence`,
      )
      .get();
    return { database, sourceCounts };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function inventoryRows(database) {
  return database
    .prepare("SELECT task_id FROM task_inventory ORDER BY task_id")
    .iterate();
}

/** Metadata only: SQL bodies, data-source settings and server addresses never enter the projection. */
export function evidenceRows(database) {
  return database
    .prepare(
      `SELECT task_id, evidence_type, direction, depth, format,
    content_sha256, observed_at FROM evidence ORDER BY task_id, evidence_type, direction, depth`,
    )
    .iterate();
}

export function detailRows(database) {
  const fields = [
    ["taskId", "reported_id"],
    ["taskName", "name"],
    ["topicName", "topic"],
    ["database", "schema_name"],
    ["status", "status"],
    ["cycle", "cycle"],
    ["cycleUnit", "cycle_unit"],
    ["taskType", "type"],
  ];
  const columns = fields.map(
    ([field, alias]) =>
      `CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.detail.${field}') END AS ${alias}`,
  );
  return database
    .prepare(
      `SELECT task_id, observed_at, json_valid(payload_json) AS valid_json,
    CASE WHEN json_valid(payload_json) THEN json_type(payload_json, '$.detail') END AS detail_type,
    ${columns.join(",\n")}
    FROM evidence WHERE evidence_type = 'szdata-schedule-detail'
    ORDER BY task_id, direction, depth`,
    )
    .iterate();
}

export function relationRows(database) {
  return database
    .prepare(
      `SELECT task_id, evidence_type, direction, depth, observed_at, payload_json
    FROM evidence WHERE evidence_type IN ('horae-relation-up-depth-1', 'horae-relation-down-depth-1')
    ORDER BY task_id, evidence_type, direction, depth`,
    )
    .iterate();
}
