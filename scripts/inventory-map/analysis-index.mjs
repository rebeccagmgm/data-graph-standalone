import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_ROOT = dirname(MODULE_PATH);
const REPOSITORY_ROOT = resolve(MODULE_ROOT, "../..");
export const ANALYSIS_SCHEMA_VERSION = "1.0.0";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value);

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`INVALID_${name}`);
  return value;
}

/** Names support lookup only. Physical identity is always the source node ID. */
export function qualifiedNameParts(value) {
  const original = requiredString(value, "QUALIFIED_NAME");
  const at = original.indexOf("@");
  const name = (at === -1 ? original : original.slice(0, at)).toLowerCase();
  return {
    originalQualifiedName: original,
    qualifiedName: name,
    schemaName: name.includes(".") ? name.slice(0, name.indexOf(".")) : "",
    instanceQualifier: at === -1 ? "" : original.slice(at + 1),
  };
}

export function loadAnalysisConfig(options = {}) {
  const configPath = resolve(
    options.configPath ?? join(MODULE_ROOT, "analysis-config.json"),
  );
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.schemaVersion !== ANALYSIS_SCHEMA_VERSION)
    throw new Error("ANALYSIS_CONFIG_VERSION_UNSUPPORTED");
  const base = dirname(configPath);
  const metadataRoot = resolve(base, config.metadataRoot ?? ".");
  const workspacePath = join(REPOSITORY_ROOT, "config/workspace-paths.json");
  const workspace = JSON.parse(readFileSync(workspacePath, "utf8"));
  const dataRoot = resolve(
    dirname(workspacePath),
    requiredString(workspace.dataRoot, "DATA_ROOT"),
  );
  return {
    projectionRoot: resolve(
      options.projectionRoot ??
        (config.projectionRoot
          ? resolve(base, config.projectionRoot)
          : join(
              dataRoot,
              workspace.projectionRoot ?? "task-projections",
              "tasks",
            )),
    ),
    hiveCorePath: resolve(
      options.hiveCorePath ??
        resolve(
          metadataRoot,
          requiredString(config.hiveCorePath, "HIVE_CORE_PATH"),
        ),
    ),
    hiveDefinitionPath: resolve(
      options.hiveDefinitionPath ??
        resolve(
          metadataRoot,
          requiredString(config.hiveDefinitionPath, "HIVE_DEFINITION_PATH"),
        ),
    ),
    outputRoot: resolve(
      options.outputRoot ??
        resolve(
          base,
          config.outputRoot ?? "../../artifacts/inventory-map/analysis",
        ),
    ),
  };
}

function fingerprint(path) {
  const value = statSync(path);
  return `${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

async function fileHash(path) {
  const before = fingerprint(path);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  if (before !== fingerprint(path)) throw new Error(`INPUT_CHANGED:${path}`);
  return digest.digest("hex");
}

async function readJsonLines(path, consume) {
  const before = fingerprint(path);
  const stream = createReadStream(path);
  const digest = createHash("sha256");
  stream.on("data", (chunk) => digest.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let count = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw new Error(`INVALID_JSON_LINE:${path}:${lineNumber}`);
      }
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error(`INVALID_ROW:${path}:${lineNumber}`);
      try {
        consume(row, lineNumber);
      } catch (error) {
        throw new Error(
          `SOURCE_ROW_FAILED:${path}:${lineNumber}:${error.message}`,
          { cause: error },
        );
      }
      count += 1;
    }
    if (before !== fingerprint(path)) throw new Error(`INPUT_CHANGED:${path}`);
    return { sha256: digest.digest("hex"), rows: count };
  } finally {
    lines.close();
    stream.destroy();
  }
}

function initialize(db) {
  db.exec(`
    PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE;
    PRAGMA cache_size=-32768; PRAGMA foreign_keys=ON;
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE objects(
      id TEXT PRIMARY KEY,kind TEXT NOT NULL,schema_name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,label TEXT NOT NULL,description TEXT NOT NULL,
      object_type TEXT NOT NULL,properties_json TEXT NOT NULL
    );
    CREATE TABLE relations(
      id TEXT PRIMARY KEY,source TEXT NOT NULL REFERENCES objects(id),
      target TEXT NOT NULL REFERENCES objects(id),kind TEXT NOT NULL,
      task_id TEXT NOT NULL,properties_json TEXT NOT NULL
    );
    CREATE TABLE task_artifacts(
      task_id TEXT PRIMARY KEY,cache_key TEXT NOT NULL,projection_path TEXT NOT NULL,
      projection_hash TEXT NOT NULL,evidence_path TEXT NOT NULL,evidence_hash TEXT NOT NULL,
      coverage_status TEXT NOT NULL,generated_at TEXT NOT NULL
    );
    CREATE TABLE definitions(
      id TEXT PRIMARY KEY,object_id TEXT NOT NULL REFERENCES objects(id),
      qualified_name TEXT NOT NULL,source_key TEXT NOT NULL,sql TEXT NOT NULL,
      source_hash TEXT NOT NULL,properties_json TEXT NOT NULL
    );
    BEGIN;
  `);
}

function statements(db) {
  return {
    object: db.prepare(
      "INSERT INTO objects VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    ),
    existingObject: db.prepare(
      "SELECT kind,qualified_name,properties_json FROM objects WHERE id=?",
    ),
    relation: db.prepare("INSERT INTO relations VALUES(?,?,?,?,?,?)"),
    artifact: db.prepare("INSERT INTO task_artifacts VALUES(?,?,?,?,?,?,?,?)"),
    definition: db.prepare("INSERT INTO definitions VALUES(?,?,?,?,?,?,?)"),
  };
}

function insertDataset(sql, node) {
  if (!node || node.nodeType !== "PHYSICAL_DATASET")
    throw new Error("CLOSURE_DATASET_NOT_PHYSICAL");
  const id = requiredString(node.nodeId, "DATASET_ID");
  const props = node.properties ?? {};
  const name = qualifiedNameParts(props.qualifiedName);
  const stored = {
    ...props,
    originalQualifiedName: name.originalQualifiedName,
  };
  const prior = sql.existingObject.get(id);
  if (prior) {
    const other = JSON.parse(prior.properties_json);
    if (
      prior.kind !== "table" ||
      prior.qualified_name !== name.qualifiedName ||
      other.platform !== props.platform ||
      other.dataSource !== props.dataSource
    )
      throw new Error(`DATASET_IDENTITY_CONFLICT:${id}`);
    return id;
  }
  sql.object.run(
    id,
    "table",
    name.schemaName,
    name.qualifiedName,
    name.qualifiedName,
    String(props.description ?? ""),
    "PHYSICAL_DATASET",
    json(stored),
  );
  return id;
}

async function insertProjection(sql, taskDirectory, taskId) {
  const projectionPath = join(taskDirectory, "task-local-projection.json");
  const before = fingerprint(projectionPath);
  const bytes = readFileSync(projectionPath);
  if (before !== fingerprint(projectionPath))
    throw new Error(`INPUT_CHANGED:${projectionPath}`);
  const envelope = JSON.parse(bytes.toString("utf8"));
  const projection = envelope.projection;
  if (
    !projection ||
    String(projection.taskId) !== taskId ||
    !Array.isArray(projection.nodes) ||
    !Array.isArray(projection.edges)
  )
    throw new Error(`INVALID_PROJECTION:${taskId}`);
  const cacheKey = requiredString(envelope.cacheKey, "CACHE_KEY");
  if (!/^[a-f0-9]{64}$/.test(cacheKey))
    throw new Error(`INVALID_CACHE_KEY:${taskId}`);
  const projectionHash = hash(bytes);
  const evidencePath = join(
    taskDirectory,
    "versions",
    `${cacheKey}.evidence-v3.json`,
  );
  const evidenceExists = existsSync(evidencePath);
  const evidenceHash = evidenceExists ? await fileHash(evidencePath) : "";
  const nodes = new Map(projection.nodes.map((node) => [node.nodeId, node]));
  const taskNode = nodes.get(`task:${taskId}`);
  const taskProps = taskNode?.properties ?? {};
  const props = {
    taskId,
    taskName: taskProps.taskName ?? "",
    topicName: taskProps.topicName ?? "",
    coverageStatus: projection.coverageStatus ?? "UNKNOWN",
    coverageDisposition: projection.coverageDisposition ?? "UNKNOWN",
    failureReasonCode: projection.failureReasonCode ?? null,
    gaps: projection.gaps ?? [],
    generatedAt: projection.generatedAt ?? "",
    evidenceStatus: evidenceExists ? "AVAILABLE" : "MISSING",
  };
  sql.object.run(
    `task:${taskId}`,
    "task",
    "",
    "",
    String(taskProps.taskName || taskId),
    "",
    String(projection.taskCategory ?? "TASK"),
    json(props),
  );
  sql.artifact.run(
    taskId,
    cacheKey,
    projectionPath,
    projectionHash,
    evidenceExists ? evidencePath : "",
    evidenceHash,
    String(props.coverageStatus),
    String(props.generatedAt),
  );
  const closure = projection.localClosure;
  if (!closure)
    return {
      taskId,
      projectionHash,
      evidenceHash,
      missingEvidence: !evidenceExists,
    };
  if (
    !Array.isArray(closure.externalReads) ||
    !Array.isArray(closure.finalWrites)
  )
    throw new Error(`INVALID_LOCAL_CLOSURE:${taskId}`);
  const edgeMap = new Map();
  for (const edge of projection.edges) {
    if (edge.edgeType !== "READS" && edge.edgeType !== "WRITES") continue;
    const key = `${edge.edgeType}:${edge.fromNodeId}:${edge.toNodeId}`;
    const values = edgeMap.get(key) ?? [];
    values.push({ edgeId: edge.edgeId, ...edge.properties });
    edgeMap.set(key, values);
  }
  for (const [kind, entries] of [
    ["READS", closure.externalReads],
    ["WRITES", closure.finalWrites],
  ]) {
    for (const occurrence of entries) {
      const datasetId = insertDataset(sql, nodes.get(occurrence.datasetNodeId));
      const occurrenceId = requiredString(
        kind === "READS"
          ? occurrence.readOccurrenceId
          : occurrence.writeObservationId,
        "OCCURRENCE_ID",
      );
      const occurrenceNodeId =
        kind === "READS"
          ? occurrence.readOccurrenceNodeId
          : occurrence.targetWriteNodeId;
      const originalEdges =
        edgeMap.get(`${kind}:${occurrenceNodeId}:${datasetId}`) ?? [];
      const source = kind === "READS" ? datasetId : `task:${taskId}`;
      const target = kind === "READS" ? `task:${taskId}` : datasetId;
      const properties = {
        ...occurrence,
        identityStatus:
          occurrence.identityStatus ??
          nodes.get(datasetId)?.properties?.identityStatus ??
          "UNKNOWN",
        occurrenceProperties: nodes.get(occurrenceNodeId)?.properties ?? {},
        originalEdges,
        evidenceRole:
          kind === "READS"
            ? "LOCAL_CLOSURE_EXTERNAL_READ"
            : "LOCAL_CLOSURE_FINAL_WRITE",
        ...(kind === "WRITES"
          ? {
              writeEvidenceKind: occurrenceId.includes(":platform-target:")
                ? "PLATFORM_TARGET_DECLARATION"
                : "WRITE_OBSERVATION",
            }
          : {}),
      };
      const id = `relation:${hash(json([taskId, kind, datasetId, occurrenceId]))}`;
      sql.relation.run(id, source, target, kind, taskId, json(properties));
    }
  }
  return {
    taskId,
    projectionHash,
    evidenceHash,
    missingEvidence: !evidenceExists,
  };
}

function insertCatalog(sql, row, sourceKey, lineNumber) {
  const name = qualifiedNameParts(row.qualifiedname ?? row.qualifiedName);
  const guid = String(row.guid ?? "");
  // Source-specific identities prevent a name-only match from creating lineage.
  const id = `catalog:${sourceKey}:${hash(json([guid, name.originalQualifiedName, lineNumber]))}`;
  const querytext = row.querytext;
  const objectType =
    querytext === undefined
      ? String(row.type_name ?? "hive_table")
      : /\bcreate\s+(?:or\s+replace\s+)?view\b/i.test(querytext)
        ? "hive_view_definition"
        : "hive_table_definition";
  const { querytext: omitted, ...metadata } = row;
  const properties = {
    ...metadata,
    ...name,
    sourceKey,
    lineNumber,
    identityRole: "CATALOG_CANDIDATE",
  };
  sql.object.run(
    id,
    "catalog",
    name.schemaName,
    name.qualifiedName,
    String(row.name ?? name.qualifiedName),
    String(row.description ?? row.comment ?? ""),
    objectType,
    json(properties),
  );
  if (querytext !== undefined) {
    if (typeof querytext !== "string") throw new Error("INVALID_QUERYTEXT");
    const definitionId = `definition:${hash(json([sourceKey, lineNumber, guid, name.originalQualifiedName]))}`;
    sql.definition.run(
      definitionId,
      id,
      name.qualifiedName,
      sourceKey,
      querytext,
      hash(querytext),
      json(properties),
    );
  }
}

/** Build from already-published artifacts only; it never invokes a producer. */
export async function buildAnalysisIndex(options = {}) {
  const started = performance.now();
  const config = loadAnalysisConfig(options);
  const snapshots = join(config.outputRoot, "snapshots");
  mkdirSync(snapshots, { recursive: true });
  const temporary = join(snapshots, `.building-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(temporary);
  const progress = options.progress ?? (() => {});
  let closed = false;
  try {
    initialize(db);
    const sql = statements(db);
    const sourceDigest = createHash("sha256");
    sourceDigest.update(
      json({
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        projectionRoot: config.projectionRoot,
        hiveCorePath: config.hiveCorePath,
        hiveDefinitionPath: config.hiveDefinitionPath,
      }),
    );
    const taskDirectories = readdirSync(config.projectionRoot, {
      withFileTypes: true,
    })
      .filter((item) => item.isDirectory() && /^\d+$/.test(item.name))
      .map((item) => item.name)
      .sort((a, b) => Number(a) - Number(b));
    let taskCount = 0;
    let missingEvidence = 0;
    for (const taskId of taskDirectories) {
      const directory = join(config.projectionRoot, taskId);
      if (!existsSync(join(directory, "task-local-projection.json")))
        throw new Error(`CURRENT_PROJECTION_MISSING:${taskId}`);
      const result = await insertProjection(sql, directory, taskId);
      sourceDigest.update(json(result));
      taskCount += 1;
      missingEvidence += Number(result.missingEvidence);
      if (taskCount % 250 === 0)
        progress({
          phase: "projections",
          tasks: taskCount,
          total: taskDirectories.length,
        });
    }
    progress({ phase: "hive-core" });
    const core = await readJsonLines(config.hiveCorePath, (row, line) =>
      insertCatalog(sql, row, "hive-core", line),
    );
    sourceDigest.update(json({ source: "hive-core", ...core }));
    progress({ phase: "hive-definitions" });
    const definitions = await readJsonLines(
      config.hiveDefinitionPath,
      (row, line) => {
        if (typeof row.querytext !== "string")
          throw new Error("DEFINITION_QUERYTEXT_MISSING");
        insertCatalog(sql, row, "hive-definitions", line);
      },
    );
    sourceDigest.update(json({ source: "hive-definitions", ...definitions }));
    progress({ phase: "indexes" });
    db.exec(`
      CREATE INDEX objects_kind_schema_name ON objects(kind,schema_name,qualified_name);
      CREATE INDEX objects_name ON objects(qualified_name,kind);
      CREATE INDEX relations_source ON relations(source,kind,target);
      CREATE INDEX relations_target ON relations(target,kind,source);
      CREATE INDEX relations_task ON relations(task_id,kind);
      CREATE INDEX definitions_name ON definitions(qualified_name);
      CREATE INDEX definitions_object ON definitions(object_id);
    `);
    const sourceHash = sourceDigest.digest("hex");
    const builderHash = hash(readFileSync(MODULE_PATH));
    const version = hash(
      json({ schemaVersion: ANALYSIS_SCHEMA_VERSION, sourceHash, builderHash }),
    );
    const counts = {
      tasks: taskCount,
      missingEvidence,
      tables: db
        .prepare("SELECT count(*) AS n FROM objects WHERE kind='table'")
        .get().n,
      catalogObjects: db
        .prepare("SELECT count(*) AS n FROM objects WHERE kind='catalog'")
        .get().n,
      catalogCoreRows: core.rows,
      definitions: definitions.rows,
      reads: db
        .prepare("SELECT count(*) AS n FROM relations WHERE kind='READS'")
        .get().n,
      writes: db
        .prepare("SELECT count(*) AS n FROM relations WHERE kind='WRITES'")
        .get().n,
    };
    const summary = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      version,
      sourceHash,
      builderHash,
      counts,
      sources: {
        projectionRoot: config.projectionRoot,
        hiveCorePath: config.hiveCorePath,
        hiveDefinitionPath: config.hiveDefinitionPath,
        coreHash: core.sha256,
        definitionsHash: definitions.sha256,
      },
      coverage: "PUBLISHED_PROJECTIONS_AND_HIVE_CATALOG",
      semantics:
        "Catalog name matches are candidates; write observations retain declaration provenance and are not runtime proof.",
    };
    db.prepare("INSERT INTO meta VALUES(?,?)").run("summary", json(summary));
    db.prepare("INSERT INTO meta VALUES(?,?)").run("version", version);
    db.exec("COMMIT; PRAGMA optimize;");
    db.close();
    closed = true;
    const databaseName = `snapshots/${version}.sqlite`;
    const summaryName = `snapshots/${version}.summary.json`;
    const finalDatabase = join(config.outputRoot, databaseName);
    if (existsSync(finalDatabase)) rmSync(temporary);
    else renameSync(temporary, finalDatabase);
    if (!existsSync(join(config.outputRoot, summaryName)))
      writeFileSync(
        join(config.outputRoot, summaryName),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
    const pointer = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      version,
      database: databaseName,
      summary: summaryName,
    };
    const pointerTemp = join(
      config.outputRoot,
      `.CURRENT-${randomUUID()}.json`,
    );
    writeFileSync(pointerTemp, `${JSON.stringify(pointer, null, 2)}\n`);
    renameSync(pointerTemp, join(config.outputRoot, "CURRENT.json"));
    return {
      ...summary,
      outputRoot: config.outputRoot,
      databasePath: finalDatabase,
      elapsedMs: Math.round(performance.now() - started),
      peakRssMiB:
        Math.round((process.resourceUsage().maxRSS / 1024) * 100) / 100,
    };
  } catch (error) {
    if (!closed) {
      try {
        db.close();
      } catch {}
    }
    for (const suffix of ["", "-journal", "-wal", "-shm"])
      if (existsSync(`${temporary}${suffix}`)) rmSync(`${temporary}${suffix}`);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) {
  const flags = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    if (key === "--help") {
      console.log(
        "node scripts/inventory-map/analysis-index.mjs [--config PATH] [--projection-root PATH] [--hive-core PATH] [--hive-definitions PATH] [--output PATH]",
      );
      process.exit(0);
    }
    if (
      ![
        "--config",
        "--projection-root",
        "--hive-core",
        "--hive-definitions",
        "--output",
      ].includes(key) ||
      !process.argv[index + 1]
    )
      throw new Error(`INVALID_ARGUMENT:${key}`);
    flags.set(key, process.argv[index + 1]);
  }
  const result = await buildAnalysisIndex({
    configPath: flags.get("--config"),
    projectionRoot: flags.get("--projection-root"),
    hiveCorePath: flags.get("--hive-core"),
    hiveDefinitionPath: flags.get("--hive-definitions"),
    outputRoot: flags.get("--output"),
    progress: (event) => process.stderr.write(`${json(event)}\n`),
  });
  console.log(JSON.stringify(result, null, 2));
}
