import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  loadRules,
  parseRelation,
  regionId,
  SCHEMA_VERSION,
  sha256,
  taskId,
  textValue,
  UNKNOWN_TOPIC,
} from "./model.mjs";
import {
  defaultSourcePath,
  detailRows,
  evidenceRows,
  inventoryRows,
  openSource,
  relationRows,
  REPOSITORY_ROOT,
} from "./source.mjs";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const BUILDER_FILES = ["build.mjs", "model.mjs", "source.mjs"];

function initialize(database) {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -32768;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, topic TEXT NOT NULL,
      schema_name TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '', cycle TEXT NOT NULL DEFAULT '',
      region_id TEXT NOT NULL, stage_id TEXT NOT NULL,
      metadata_source TEXT NOT NULL DEFAULT '', metadata_observed_at TEXT NOT NULL DEFAULT '',
      has_detail INTEGER NOT NULL DEFAULT 0, has_up INTEGER NOT NULL DEFAULT 0,
      has_down INTEGER NOT NULL DEFAULT 0, has_sql INTEGER NOT NULL DEFAULT 0,
      in_inventory INTEGER NOT NULL DEFAULT 0,
      in_degree INTEGER NOT NULL DEFAULT 0, out_degree INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE edges (
      source TEXT NOT NULL, target TEXT NOT NULL, seen_up INTEGER NOT NULL,
      seen_down INTEGER NOT NULL, observed_min TEXT NOT NULL, observed_max TEXT NOT NULL,
      PRIMARY KEY (source, target)
    ) WITHOUT ROWID;
    CREATE TABLE evidence_refs (
      task_id TEXT NOT NULL, evidence_type TEXT NOT NULL, direction TEXT NOT NULL,
      depth INTEGER NOT NULL, content_sha256 TEXT NOT NULL, observed_at TEXT NOT NULL,
      PRIMARY KEY (task_id, evidence_type, direction, depth)
    ) WITHOUT ROWID;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    BEGIN;
  `);
}

function sourceStatements(database, rules) {
  const insert = database.prepare(`INSERT INTO tasks
    (id, name, topic, region_id, stage_id, in_inventory) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET in_inventory = max(tasks.in_inventory, excluded.in_inventory)`);
  const unknownStage = rules.classify("");
  return {
    ensureTask(id, inInventory = false) {
      insert.run(
        id,
        id,
        UNKNOWN_TOPIC,
        regionId(""),
        unknownStage,
        Number(inInventory),
      );
    },
    evidence: database.prepare(
      "INSERT INTO evidence_refs VALUES (?, ?, ?, ?, ?, ?)",
    ),
    detail:
      database.prepare(`UPDATE tasks SET name = ?, topic = ?, schema_name = ?,
      type = ?, status = ?, cycle = ?, region_id = ?, stage_id = ?,
      metadata_source = 'szdata-schedule-detail', metadata_observed_at = ?, has_detail = 1 WHERE id = ?`),
    neighbor:
      database.prepare(`UPDATE tasks SET name = ?, topic = ?, region_id = ?, stage_id = ?,
      metadata_source = 'relation-neighbor', metadata_observed_at = ?
      WHERE id = ? AND has_detail = 0 AND metadata_source = ''`),
    up: database.prepare("UPDATE tasks SET has_up = 1 WHERE id = ?"),
    down: database.prepare("UPDATE tasks SET has_down = 1 WHERE id = ?"),
    sql: database.prepare("UPDATE tasks SET has_sql = 1 WHERE id = ?"),
    edge: database.prepare(`INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, target) DO UPDATE SET
        seen_up = max(edges.seen_up, excluded.seen_up),
        seen_down = max(edges.seen_down, excluded.seen_down),
        observed_min = CASE WHEN edges.observed_min = '' THEN excluded.observed_min
          WHEN excluded.observed_min = '' THEN edges.observed_min
          ELSE min(edges.observed_min, excluded.observed_min) END,
        observed_max = max(edges.observed_max, excluded.observed_max)`),
  };
}

function createQualityTracker() {
  const reasons = new Map();
  return {
    invalidRows: 0,
    invalidRecords: 0,
    add(reason, record = false) {
      if (record) this.invalidRecords += 1;
      else this.invalidRows += 1;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    },
    result() {
      return {
        status:
          this.invalidRecords + this.invalidRows > 0 ? "PARTIAL" : "COMPLETE",
        invalidRows: this.invalidRows,
        invalidRecords: this.invalidRecords,
        reasons: [...reasons]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([reason, count]) => ({ reason, count })),
      };
    },
  };
}

function copyInputs(source, target, rules, progress) {
  const statements = sourceStatements(target, rules);
  const inputHash = createHash("sha256");
  const consume = (kind, value) =>
    inputHash.update(`${kind}\n${canonicalJson(value)}\n`);
  const quality = createQualityTracker();
  let rows = 0;
  for (const row of inventoryRows(source)) {
    consume("inventory", row);
    const id = taskId(row.task_id);
    if (id) statements.ensureTask(id, true);
    else quality.add("INVALID_INVENTORY_ID");
    rows += 1;
    if (rows % 25000 === 0) progress({ phase: "inventory", rows });
  }
  progress({ phase: "inventory", rows });
  rows = 0;
  for (const row of evidenceRows(source)) {
    consume("evidence", row);
    const id = taskId(row.task_id);
    if (!id) {
      quality.add("INVALID_EVIDENCE_TASK_ID", true);
      continue;
    }
    statements.ensureTask(id);
    statements.evidence.run(
      id,
      row.evidence_type,
      row.direction,
      row.depth,
      row.content_sha256,
      row.observed_at,
    );
    if (
      row.format === "sql" &&
      ["hive-task", "run-script"].includes(row.evidence_type)
    )
      statements.sql.run(id);
    rows += 1;
    if (rows % 50000 === 0) progress({ phase: "evidence", rows });
  }
  progress({ phase: "evidence", rows });
  rows = 0;
  for (const row of detailRows(source)) {
    consume("detail", row);
    const id = taskId(row.task_id);
    if (
      !id ||
      row.valid_json !== 1 ||
      row.detail_type !== "object" ||
      (row.reported_id !== null && taskId(row.reported_id) !== id)
    ) {
      quality.add("INVALID_DETAIL_CONTRACT", true);
      continue;
    }
    const topic = textValue(row.topic);
    statements.detail.run(
      textValue(row.name) || id,
      topic || UNKNOWN_TOPIC,
      textValue(row.schema_name),
      textValue(row.type),
      textValue(row.status),
      [textValue(row.cycle), textValue(row.cycle_unit)]
        .filter(Boolean)
        .join(" "),
      regionId(topic),
      rules.classify(topic),
      row.observed_at,
      id,
    );
    rows += 1;
    if (rows % 25000 === 0) progress({ phase: "details", rows });
  }
  progress({ phase: "details", rows });
  rows = 0;
  let neighborRows = 0;
  for (const row of relationRows(source)) {
    consume("relation", row);
    const relation = parseRelation(row);
    if (!relation) {
      quality.add("INVALID_RELATION_CONTRACT", true);
      continue;
    }
    statements[relation.direction].run(relation.currentId);
    for (const neighbor of relation.rows) {
      if (
        !neighbor ||
        typeof neighbor !== "object" ||
        Array.isArray(neighbor)
      ) {
        quality.add("INVALID_NEIGHBOR_ROW");
        continue;
      }
      const id = taskId(neighbor.task_id ?? neighbor.taskId);
      if (!id) {
        quality.add("INVALID_NEIGHBOR_ID");
        continue;
      }
      statements.ensureTask(id);
      const neighborName = textValue(neighbor.task_name ?? neighbor.taskName);
      const neighborTopic = textValue(
        neighbor.topic_name ?? neighbor.topicName,
      );
      if (neighborName || neighborTopic) {
        statements.neighbor.run(
          neighborName || id,
          neighborTopic || UNKNOWN_TOPIC,
          regionId(neighborTopic),
          rules.classify(neighborTopic),
          row.observed_at,
          id,
        );
      }
      const sourceId = relation.direction === "up" ? id : relation.currentId;
      const targetId = relation.direction === "up" ? relation.currentId : id;
      statements.edge.run(
        sourceId,
        targetId,
        Number(relation.direction === "up"),
        Number(relation.direction === "down"),
        row.observed_at,
        row.observed_at,
      );
      neighborRows += 1;
    }
    rows += 1;
    if (rows % 25000 === 0)
      progress({ phase: "relations", rows, neighborRows });
  }
  progress({ phase: "relations", rows, neighborRows });
  return { sourceHash: inputHash.digest("hex"), quality: quality.result() };
}

function createIndexes(database) {
  database.exec(`
    CREATE INDEX edges_source ON edges(source);
    CREATE INDEX edges_target ON edges(target);
    CREATE INDEX tasks_region ON tasks(region_id, id);
    CREATE INDEX tasks_stage ON tasks(stage_id, id);
    CREATE INDEX tasks_topic ON tasks(topic, id);
    CREATE INDEX tasks_name ON tasks(name, id);
    CREATE INDEX tasks_schema ON tasks(schema_name, id);
    UPDATE tasks SET
      in_degree = (SELECT count(*) FROM edges WHERE edges.target = tasks.id),
      out_degree = (SELECT count(*) FROM edges WHERE edges.source = tasks.id);
    CREATE INDEX tasks_degree ON tasks(in_degree DESC, out_degree DESC);
  `);
}

function summarize(database, rules, metadata) {
  const taskCounts = database
    .prepare(
      `SELECT count(*) AS tasks,
    coalesce(sum(in_inventory),0) AS inventoryTasks,
    coalesce(sum(1-in_inventory),0) AS externalTasks,
    coalesce(sum(has_detail),0) AS detailTasks, coalesce(sum(has_up),0) AS upTasks,
    coalesce(sum(has_down),0) AS downTasks, coalesce(sum(has_sql),0) AS sqlTasks FROM tasks`,
    )
    .get();
  const edgeCounts = database
    .prepare(
      `SELECT count(*) AS edges,
    coalesce(sum(seen_up = 1 AND seen_down = 1),0) AS bothDirectionEdges,
    coalesce(sum(seen_up != seen_down),0) AS singleDirectionEdges,
    coalesce(sum(source = target),0) AS selfEdges FROM edges`,
    )
    .get();
  const stagesById = new Map(
    database
      .prepare(
        `SELECT stage_id,
    sum(in_inventory) AS taskCount, sum(1-in_inventory) AS externalTaskCount,
    count(*) AS totalTaskCount FROM tasks GROUP BY stage_id`,
      )
      .all()
      .map((row) => [row.stage_id, row]),
  );
  const regions = database
    .prepare(
      `SELECT region_id AS id, topic AS label, stage_id AS stageId,
    sum(in_inventory) AS taskCount, sum(1-in_inventory) AS externalTaskCount,
    count(*) AS totalTaskCount FROM tasks GROUP BY region_id ORDER BY taskCount DESC, region_id`,
    )
    .all()
    .map((row) => ({
      ...row,
      label: row.label === UNKNOWN_TOPIC ? "未取得主题" : row.label,
      inEdges: 0,
      outEdges: 0,
      internalEdges: 0,
    }));
  const byRegion = new Map(regions.map((region) => [region.id, region]));
  for (const flow of database
    .prepare(
      `SELECT s.region_id AS source, t.region_id AS target, count(*) AS edgeCount
    FROM edges e JOIN tasks s ON s.id = e.source JOIN tasks t ON t.id = e.target
    GROUP BY s.region_id, t.region_id`,
    )
    .iterate()) {
    if (flow.source === flow.target)
      byRegion.get(flow.source).internalEdges += flow.edgeCount;
    else {
      byRegion.get(flow.source).outEdges += flow.edgeCount;
      byRegion.get(flow.target).inEdges += flow.edgeCount;
    }
  }
  const stageFlows = database
    .prepare(
      `SELECT s.stage_id AS source, t.stage_id AS target, count(*) AS edgeCount
    FROM edges e JOIN tasks s ON s.id = e.source JOIN tasks t ON t.id = e.target
    GROUP BY s.stage_id, t.stage_id ORDER BY source, target`,
    )
    .all();
  const hubs = database
    .prepare(
      `SELECT id, name, topic, stage_id AS stageId,
    in_degree AS inDegree, out_degree AS outDegree FROM tasks
    ORDER BY in_degree + out_degree DESC, id LIMIT 20`,
    )
    .all();
  if (
    stagesById.size > rules.stages.length ||
    stageFlows.reduce((sum, row) => sum + row.edgeCount, 0) !==
      edgeCounts.edges ||
    regions.reduce((sum, row) => sum + row.taskCount, 0) !==
      taskCounts.inventoryTasks ||
    regions.reduce((sum, row) => sum + row.totalTaskCount, 0) !==
      taskCounts.tasks
  ) {
    throw new Error("MAP_AGGREGATE_MEMBERSHIP_MISMATCH");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    ...metadata,
    counts: {
      ...taskCounts,
      ...edgeCounts,
      invalidRows:
        metadata.quality.invalidRows + metadata.quality.invalidRecords,
    },
    stages: rules.stages.map((stage) => ({
      ...stage,
      taskCount: stagesById.get(stage.id)?.taskCount ?? 0,
      externalTaskCount: stagesById.get(stage.id)?.externalTaskCount ?? 0,
      totalTaskCount: stagesById.get(stage.id)?.totalTaskCount ?? 0,
    })),
    regions,
    stageFlows,
    highlights: { hubs },
    limits: rules.limits,
    interpretation: {
      edges: "调度依赖缓存中的直接邻居；不等同于 SQL 数据血缘。",
      stages:
        "阅读阶段由 topic 标签规则生成；不是任务执行顺序或 SQL 加工事实。",
      coverage: "空上下游证据与缺失证据分别统计；证据快照不证明运行成功。",
      sql: "SQL 覆盖仅指存在 hive / run-script SQL 证据索引；未解析或执行 SQL。",
    },
  };
}

function atomicJson(path, value) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath);
  }
}

/** Build one independent, immutable map snapshot. No source writes or network requests. */
export function buildInventoryMap(options = {}) {
  const sourcePath = resolve(options.sourcePath ?? defaultSourcePath());
  const outputRoot = resolve(
    options.outputRoot ?? join(REPOSITORY_ROOT, "artifacts/inventory-map"),
  );
  const rulesPath = resolve(
    options.rulesPath ?? join(SCRIPT_ROOT, "rules.json"),
  );
  const rules = loadRules(rulesPath);
  const progress =
    typeof options.progress === "function" ? options.progress : () => {};
  const builderHash = sha256(
    BUILDER_FILES.map(
      (name) => `${name}\n${readFileSync(join(SCRIPT_ROOT, name), "utf8")}\n`,
    ).join(""),
  );
  mkdirSync(join(outputRoot, "snapshots"), { recursive: true });
  const stagingPath = join(outputRoot, `.staging-${randomUUID()}.sqlite`);
  let source;
  let target;
  try {
    const opened = openSource(sourcePath);
    source = opened.database;
    target = new DatabaseSync(stagingPath);
    initialize(target);
    const { sourceHash, quality } = copyInputs(source, target, rules, progress);
    source.exec("COMMIT");
    source.close();
    source = undefined;
    progress({ phase: "indexes" });
    createIndexes(target);
    const version = sha256(
      canonicalJson({
        schemaVersion: SCHEMA_VERSION,
        builderHash,
        sourceHash,
        rulesHash: rules.hash,
      }),
    );
    const builtAt = new Date().toISOString();
    let summary = summarize(target, rules, {
      version,
      builtAt,
      source: opened.sourceCounts,
      sourceHash,
      rulesHash: rules.hash,
      builderHash,
      quality,
    });
    const insertMeta = target.prepare("INSERT INTO meta VALUES (?, ?)");
    insertMeta.run("summary", JSON.stringify(summary));
    insertMeta.run("sourcePath", JSON.stringify(sourcePath));
    insertMeta.run("rules", JSON.stringify(rules.document));
    target.exec("COMMIT; ANALYZE;");
    const integrity = target.prepare("PRAGMA quick_check").get();
    if (Object.values(integrity)[0] !== "ok")
      throw new Error("MAP_SQLITE_INTEGRITY_FAILED");
    target.close();
    target = undefined;
    const relativeDatabase = `snapshots/${version}.sqlite`;
    const databasePath = join(outputRoot, relativeDatabase);
    if (existsSync(databasePath)) {
      const existing = new DatabaseSync(databasePath, { readOnly: true });
      try {
        summary = JSON.parse(
          existing.prepare("SELECT value FROM meta WHERE key = 'summary'").get()
            .value,
        );
      } finally {
        existing.close();
      }
      rmSync(stagingPath);
    } else renameSync(stagingPath, databasePath);
    const relativeSummary = `snapshots/${version}.summary.json`;
    const relativeManifest = `snapshots/${version}.manifest.json`;
    const summaryPath = join(outputRoot, relativeSummary);
    const manifestPath = join(outputRoot, relativeManifest);
    const currentPath = join(outputRoot, "CURRENT.json");
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      version,
      builtAt: summary.builtAt,
      source: {
        databasePath: sourcePath,
        ...opened.sourceCounts,
        hash: sourceHash,
      },
      rules: { hash: rules.hash, document: rules.document },
      builderHash,
      database: relativeDatabase,
      summary: relativeSummary,
      provenance:
        "Source opened read-only inside one SQLite read transaction; SQL bodies excluded.",
    };
    if (!existsSync(summaryPath)) atomicJson(summaryPath, summary);
    if (!existsSync(manifestPath)) atomicJson(manifestPath, manifest);
    atomicJson(join(outputRoot, "summary.json"), summary);
    atomicJson(join(outputRoot, "manifest.json"), manifest);
    atomicJson(currentPath, {
      schemaVersion: SCHEMA_VERSION,
      version,
      database: relativeDatabase,
      summary: relativeSummary,
      manifest: relativeManifest,
    });
    progress({ phase: "published", version, counts: summary.counts });
    return {
      version,
      databasePath,
      summaryPath,
      manifestPath,
      currentPath,
      summary,
    };
  } finally {
    source?.close();
    target?.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      if (existsSync(stagingPath + suffix)) rmSync(stagingPath + suffix);
    }
  }
}

function main() {
  const options = {};
  const names = {
    "--source": "sourcePath",
    "--output": "outputRoot",
    "--rules": "rulesPath",
  };
  for (let i = 2; i < process.argv.length; i += 2) {
    const option = names[process.argv[i]];
    const value = process.argv[i + 1];
    if (!option || !value || value.startsWith("--"))
      throw new Error(
        "Usage: node build.mjs [--source SQLITE] [--output DIRECTORY] [--rules JSON]",
      );
    options[option] = value;
  }
  const result = buildInventoryMap({
    ...options,
    progress: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
  });
  process.stdout.write(
    `${JSON.stringify({ version: result.version, databasePath: result.databasePath, counts: result.summary.counts })}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
