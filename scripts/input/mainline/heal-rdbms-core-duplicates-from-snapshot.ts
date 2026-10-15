import {
  appendFileSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  assembleCacheTaskEvidence,
} from "../shared/cache-task-evidence.ts";
import {
  extractOfflineTableCandidates,
  loadOfflineTableCatalog,
  parsePhysicalTableName,
  rdbmsFromCore,
  serviceSuffixFromAtlasDataSource,
  type OfflineTableCatalog,
} from "../shared/offline-table-resolver.ts";
import {
  writeTableInput,
  type TableEvidence,
} from "../shared/input-pack.ts";
import { lookupJsonlByKey } from "../shared/jsonl-offset-index.ts";

const CATEGORIES = new Set([
  "oracle2hive",
  "mysql2hive",
  "postgre2hive",
]);
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

type JsonRecord = Record<string, unknown>;

type InventoryRow = {
  readonly taskId: string;
  readonly taskCategory?: string;
  readonly status?: string;
  readonly warnings?: readonly unknown[];
};

type Inventory = {
  readonly artifactType: "INPUT_PACK_PARTIAL_INVENTORY";
  readonly rows: readonly InventoryRow[];
};

type Target = {
  readonly qualifiedName: string;
  readonly taskIds: readonly string[];
};

type ManifestRow = {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "INPUT_PACK_PARTIAL_REPAIR_EVIDENCE";
  readonly taskId: string;
  readonly evidenceKind: "TABLE";
  readonly qualifiedName: string;
  readonly route: "LOCAL";
  readonly provider?: string;
  readonly observedAt: string;
  readonly sha256?: string;
  readonly changed?: boolean;
  readonly failureClass?: string;
};

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
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

function readInventory(path: string): Inventory {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Inventory;
  if (parsed.artifactType !== "INPUT_PACK_PARTIAL_INVENTORY")
    throw new Error("INVENTORY_ARTIFACT_TYPE_INVALID");
  if (!Array.isArray(parsed.rows)) throw new Error("INVENTORY_ROWS_INVALID");
  return parsed;
}

function physicalKey(record: JsonRecord): string | undefined {
  const parsed = parsePhysicalTableName(record.qualifiedname);
  if (parsed?.dataSource === undefined) return undefined;
  return `${parsed.qualifiedName.toLowerCase()}@${parsed.dataSource.toLowerCase()}`;
}

function coreSignature(record: JsonRecord): string {
  return JSON.stringify({
    qualifiedname: nonEmptyString(record.qualifiedname)?.toLowerCase(),
    name: nonEmptyString(record.name)?.toLowerCase(),
    type: nonEmptyString(record.type),
    type_name: nonEmptyString(record.type_name),
    instanceid: nonEmptyString(record.instanceid),
    ispartitioned: nonEmptyString(record.ispartitioned),
    columncount: nonEmptyString(record.columncount),
    primarykeys: nonEmptyString(record.primarykeys),
    numrows: nonEmptyString(record.numrows),
    totalsize: nonEmptyString(record.totalsize),
    comment: record.comment ?? null,
  });
}

function normalizeDdl(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trim();
}

async function collectRecords(
  path: string,
  keys: ReadonlySet<string>,
): Promise<Map<string, JsonRecord[]>> {
  const result = new Map<string, JsonRecord[]>();
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record === undefined) continue;
    const key = physicalKey(record);
    if (key === undefined || !keys.has(key)) continue;
    const records = result.get(key) ?? [];
    records.push(record);
    result.set(key, records);
  }
  return result;
}

function appendManifest(path: string, row: ManifestRow): void {
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

function manifestBase(
  taskId: string,
  qualifiedName: string,
  observedAt: string,
): Pick<ManifestRow, "taskId" | "evidenceKind" | "qualifiedName" | "route" | "observedAt"> {
  return {
    taskId,
    evidenceKind: "TABLE",
    qualifiedName,
    route: "LOCAL",
    observedAt,
  };
}

function targetWorkset(
  inventory: Inventory,
  cacheRoot: string,
  catalog: OfflineTableCatalog,
): Map<string, Target> {
  const targets = new Map<string, { qualifiedName: string; taskIds: Set<string> }>();
  for (const row of inventory.rows) {
    if (
      row.status !== "PARTIAL" ||
      row.taskCategory === undefined ||
      !CATEGORIES.has(row.taskCategory) ||
      !row.warnings?.some(
        (warning) =>
          typeof warning === "string" && warning.endsWith(":RDBMS_CORE_AMBIGUOUS"),
      ) ||
      !SAFE_TASK_ID.test(row.taskId)
    )
      continue;
    const assembled = assembleCacheTaskEvidence(row.taskId, cacheRoot);
    if (
      assembled.kind !== "EVIDENCE" ||
      assembled.evidence.endpointDataSourceHints?.source === undefined
    )
      continue;
    const source = extractOfflineTableCandidates(
      assembled.evidence,
      catalog.horaeDatasource,
    ).find((candidate) => candidate.dataSource === undefined);
    if (source === undefined) continue;
    const service = serviceSuffixFromAtlasDataSource(
      assembled.evidence.endpointDataSourceHints.source,
    );
    const concrete =
      service === undefined
        ? undefined
        : catalog.rdbmsQnServiceIndex?.get(
            `${source.qualifiedName.toLowerCase()}#${service}`,
          );
    if (typeof concrete !== "string") continue;
    if (catalog.rdbmsCore === undefined) continue;
    if (lookupJsonlByKey(catalog.rdbmsCore, concrete).status !== "AMBIGUOUS")
      continue;
    const existing = targets.get(concrete);
    if (existing === undefined)
      targets.set(concrete, {
        qualifiedName: source.qualifiedName,
        taskIds: new Set([row.taskId]),
      });
    else existing.taskIds.add(row.taskId);
  }
  return new Map(
    [...targets.entries()].map(([key, target]) => [key, {
      qualifiedName: target.qualifiedName,
      taskIds: [...target.taskIds],
    }]),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dataRoot = optionValue(argv, "--data-root");
  const cacheRoot = optionValue(argv, "--cache-root");
  const inventoryPath = optionValue(argv, "--inventory");
  if (dataRoot === undefined || cacheRoot === undefined || inventoryPath === undefined)
    throw new Error("HEAL_REQUIRES_DATA_ROOT_CACHE_ROOT_INVENTORY");
  const manifestPath = resolve(
    optionValue(argv, "--manifest") ??
      `${dataRoot}/repair-manifests/rdbms-duplicate-core.jsonl`,
  );
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, "", "utf8");
  const observedAt = new Date().toISOString();
  const catalog = loadOfflineTableCatalog({
    scheduleEvidenceCacheRoot: cacheRoot,
    indexDir: `${cacheRoot}/schedule-evidence/jsonl-indexes`,
  });
  if (catalog.rdbmsCore === undefined || catalog.rdbmsDdl === undefined)
    throw new Error("RDBMS_SNAPSHOT_CATALOG_MISSING");
  const targets = targetWorkset(readInventory(resolve(inventoryPath)), cacheRoot, catalog);
  const keys = new Set(targets.keys());
  const coreRecords = await collectRecords(catalog.rdbmsCore.sourcePath, keys);
  const ddlRecords = await collectRecords(catalog.rdbmsDdl.sourcePath, keys);
  let equivalentKeys = 0;
  let conflictKeys = 0;
  let missingCoreKeys = 0;
  let missingDdlKeys = 0;
  let changedPacks = 0;
  let affectedTasks = 0;
  for (const [key, target] of targets) {
    const core = coreRecords.get(key) ?? [];
    const ddl = ddlRecords.get(key) ?? [];
    const coreSignatures = new Set(core.map(coreSignature));
    const ddlTexts = new Set(
      ddl
        .map((record) => nonEmptyString(record.ddl))
        .filter((value): value is string => value !== undefined)
        .map(normalizeDdl),
    );
    let evidence: TableEvidence | undefined;
    let failureClass: string | undefined;
    if (core.length < 2) {
      missingCoreKeys += 1;
      failureClass = "LOCAL_RDBMS_CORE_SNAPSHOT_MISS";
    } else if (coreSignatures.size !== 1) {
      conflictKeys += 1;
      failureClass = "LOCAL_RDBMS_CORE_NOT_EQUIVALENT";
    } else if (ddlTexts.size === 0) {
      missingDdlKeys += 1;
      failureClass = "LOCAL_RDBMS_DDL_SNAPSHOT_MISS";
    } else if (ddlTexts.size !== 1) {
      conflictKeys += 1;
      failureClass = "LOCAL_RDBMS_DDL_NOT_EQUIVALENT";
    } else {
      evidence = rdbmsFromCore(
        core[0]!,
        [...ddlTexts][0]!,
        "local:rdbms-core-jsonl-duplicate-equivalent,local:rdbms-ddl-jsonl,local:horae-datasource",
        observedAt,
      );
      if (evidence === undefined) failureClass = "LOCAL_RDBMS_PLATFORM_UNMAPPED";
    }
    if (evidence === undefined) {
      for (const taskId of target.taskIds)
        appendManifest(
          manifestPath,
          {
            ...manifestBase(taskId, target.qualifiedName, observedAt),
            failureClass,
          },
        );
      continue;
    }
    const written = writeTableInput(dataRoot, evidence);
    equivalentKeys += 1;
    if (written.changed) changedPacks += 1;
    affectedTasks += target.taskIds.length;
    for (const taskId of target.taskIds)
      appendManifest(
        manifestPath,
        {
          ...manifestBase(taskId, evidence.qualifiedName, observedAt),
          provider: evidence.evidenceProvider,
          sha256: written.contentHash,
          changed: written.changed,
        },
      );
  }
  console.log(
    JSON.stringify({
      targetKeys: targets.size,
      equivalentKeys,
      conflictKeys,
      missingCoreKeys,
      missingDdlKeys,
      affectedTasks,
      changedPacks,
      manifestPath,
    }),
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
