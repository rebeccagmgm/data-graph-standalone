import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  createTableDocument,
  sha256File,
  writeTableInput,
  type TableEvidence,
  type TaskEvidence,
} from "../shared/input-pack.ts";
import {
  assembleCacheTaskEvidence,
} from "../shared/cache-task-evidence.ts";
import {
  extractOfflineTableCandidates,
  loadOfflineTableCatalog,
  openOfflineTablePackStore,
  parsePhysicalTableName,
  platformFromDataSource,
  resolveOfflineTables,
  serviceSuffixFromAtlasDataSource,
  type OfflineTableCatalog,
} from "../shared/offline-table-resolver.ts";
import {
  isDatabaseSourceToHiveTask,
} from "../shared/task-partition-evidence.ts";
import {
  extractSqlWriteTableNames,
  type SqlTargetSlot,
} from "../shared/sql-target-evidence.ts";
import {
  loadPersistedTableCache,
  tableFromDirectEvidence,
  type TableEvidenceLookupOptions,
} from "./collect-one-task-input-pack.ts";
import {
  fillHiveDdlFromLogCache,
  HIVE_DDL_FROM_LOG_TASK_TYPES,
} from "./fill-hive-ddl-from-log-cache.ts";
import {
  fillHiveTaskSqlCache,
} from "./fill-hive-task-sql-cache.ts";
import {
  fillRunScriptSqlCache,
} from "./fill-run-script-sql-cache.ts";
import {
  parseHiveDdlFromLogCache,
} from "./hive-ddl-from-log-cache.ts";
import { readHiveTaskSqlCache } from "./hive-task-sql-cache.ts";
import { parseRunScriptSqlCache } from "./run-script-sql-cache.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SQL_TASK_TYPES = new Set([
  "hiveTask",
  "hiveTask-2.0",
  "runScript",
  "runScript-2.0",
  "sparkScript",
]);

export type RepairManifestRow = {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "INPUT_PACK_PARTIAL_REPAIR_EVIDENCE";
  readonly taskId: string;
  readonly evidenceKind: "TASK_SQL" | "HIVE_DDL" | "TABLE";
  readonly qualifiedName?: string;
  readonly route: "LOCAL" | "ONLINE";
  readonly provider?: string;
  readonly observedAt: string;
  readonly sha256?: string;
  readonly changed?: boolean;
  readonly failureClass?: string;
}

export interface PartialRepairInventoryRow {
  readonly taskId: string;
  readonly taskCategory?: string;
}

export interface PartialRepairInventory {
  readonly artifactType: "INPUT_PACK_PARTIAL_INVENTORY";
  readonly rows: readonly PartialRepairInventoryRow[];
}

export interface RepairInputPackPartialsOptions {
  readonly dataRoot: string;
  readonly cacheRoot: string;
  readonly inventoryPath: string;
  readonly taskIds?: readonly string[];
  readonly manifestPath?: string;
  readonly allowOnlineBackup?: boolean;
  /** Restrict this pass to table evidence; skip unrelated log backfills. */
  readonly tableOnly?: boolean;
  readonly dataDate?: string;
  readonly maxErrors?: number;
  readonly now?: () => Date;
  readonly catalog?: OfflineTableCatalog;
  readonly tableLookup?: (
    qualifiedName: string,
    expectedDataSource?: string,
    options?: TableEvidenceLookupOptions,
  ) => TableEvidence | undefined;
}

export interface RepairInputPackPartialsSummary {
  readonly taskCount: number;
  readonly sqlTaskCount: number;
  readonly hiveDdlTaskCount: number;
  readonly tableResolvedLocal: number;
  readonly tableRepairedOnline: number;
  readonly tableFailures: number;
  readonly manifestPath: string;
}

type TableLookupMemoEntry =
  | { readonly kind: "RESULT"; readonly table: TableEvidence }
  | { readonly kind: "ERROR"; readonly error: unknown };

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readInventory(path: string): PartialRepairInventory {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PartialRepairInventory;
  if (parsed.artifactType !== "INPUT_PACK_PARTIAL_INVENTORY")
    throw new Error("INVENTORY_ARTIFACT_TYPE_INVALID");
  if (!Array.isArray(parsed.rows)) throw new Error("INVENTORY_ROWS_INVALID");
  return parsed;
}

function readTaskIds(path: string): string[] {
  const ids = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const taskId of ids)
    if (!SAFE_TASK_ID.test(taskId)) throw new Error(`TASK_ID_INVALID:${taskId}`);
  return [...new Set(ids)];
}

function selectedRows(
  inventory: PartialRepairInventory,
  taskIds: readonly string[] | undefined,
): PartialRepairInventoryRow[] {
  const requested = taskIds === undefined ? undefined : new Set(taskIds);
  const rows = inventory.rows.filter((row) => {
    if (!SAFE_TASK_ID.test(row.taskId)) return false;
    return requested === undefined || requested.has(row.taskId);
  });
  if (rows.length === 0) throw new Error("REPAIR_WORKSET_EMPTY");
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.taskId)) return false;
    seen.add(row.taskId);
    return true;
  });
}

function manifestRow(
  row: Omit<RepairManifestRow, "schemaVersion" | "artifactType" | "observedAt">,
  now: () => Date,
): RepairManifestRow {
  return {
    schemaVersion: "1.0.0",
    artifactType: "INPUT_PACK_PARTIAL_REPAIR_EVIDENCE",
    observedAt: now().toISOString(),
    ...row,
  };
}

function appendManifest(path: string, row: RepairManifestRow): void {
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

function classifyFailure(error: unknown): string {
  const message = errorMessage(error);
  if (/\b403\b|forbidden|无权限|拒绝访问/i.test(message)) return "UPSTREAM_403";
  if (/\b429\b|too many requests|rate limit|频率/i.test(message))
    return "UPSTREAM_429";
  if (/timeout|timed out|ETIMEDOUT|超时/i.test(message))
    return "UPSTREAM_TIMEOUT";
  if (/ONLINE_BACKUP_DISABLED/.test(message)) return "ONLINE_BACKUP_DISABLED";
  return "UPSTREAM_ERROR";
}

function cacheHash(path: string | undefined): string | undefined {
  return path !== undefined && existsSync(path) ? sha256File(path) : undefined;
}

function recordSqlCacheEvidence(
  taskId: string,
  cacheRoot: string,
  manifestPath: string,
  now: () => Date,
  failed: boolean,
  kind: "TASK_SQL" | "HIVE_DDL",
): void {
  if (kind === "TASK_SQL") {
    const hive = readHiveTaskSqlCache(taskId, cacheRoot);
    if (hive.status === "HIT") {
      appendManifest(
        manifestPath,
        manifestRow(
          {
            taskId,
            evidenceKind: kind,
            route: hive.source === "LOCAL_CODE" ? "LOCAL" : "ONLINE",
            provider:
              hive.source === "LOCAL_CODE"
                ? "local:BigData-code"
                : "opencli:szdata.task-sql",
            sha256: cacheHash(hive.path),
            ...(hive.sqlStatus === "UNAVAILABLE"
              ? { failureClass: "SQL_UNAVAILABLE" }
              : {}),
          },
          now,
        ),
      );
      return;
    }
    appendManifest(
      manifestPath,
      manifestRow(
        {
          taskId,
          evidenceKind: kind,
          route: "LOCAL",
          failureClass: failed ? "SQL_CACHE_REPAIR_FAILED" : "SQL_CACHE_MISS",
        },
        now,
      ),
    );
    return;
  }

  const ddl = parseHiveDdlFromLogCache(taskId, cacheRoot);
  if (ddl.status === "HIT") {
    appendManifest(
      manifestPath,
      manifestRow(
        {
          taskId,
          evidenceKind: kind,
          qualifiedName: ddl.evidence.qualifiedName ?? undefined,
          route: "LOCAL",
          provider: "local:horae-log",
          sha256: cacheHash(ddl.path),
          ...(ddl.evidence.ddlStatus === "UNAVAILABLE"
            ? { failureClass: "HIVE_DDL_UNAVAILABLE" }
            : {}),
        },
        now,
      ),
    );
    return;
  }
  appendManifest(
    manifestPath,
    manifestRow(
      {
        taskId,
        evidenceKind: kind,
        route: "LOCAL",
        failureClass: failed ? "HIVE_DDL_CACHE_REPAIR_FAILED" : "HIVE_DDL_CACHE_MISS",
      },
      now,
    ),
  );
}

function expectedTableIdentity(
  evidence: TaskEvidence,
  qualifiedName: string,
): { readonly dataSource?: string; readonly platform?: string } {
  const candidate = qualifiedName.toLowerCase();
  const target = parsePhysicalTableName(evidence.target)?.qualifiedName.toLowerCase();
  const source = parsePhysicalTableName(evidence.source)?.qualifiedName.toLowerCase();
  const sql = Object.fromEntries(
    Object.entries(evidence.sql ?? {})
      .map(([slot, raw]) => [
        slot,
        typeof raw === "string" ? raw : raw?.content,
      ])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  ) as Partial<Record<SqlTargetSlot, string>>;
  const isHive2WriteTarget =
    evidence.taskCategory?.startsWith("hive2") === true &&
    extractSqlWriteTableNames(sql, evidence.taskName ?? undefined, {
      allowSchemaOnlyQualification: true,
    }).some((name) => name.toLowerCase() === candidate);
  if (
    isHive2WriteTarget &&
    evidence.endpointDataSourceHints?.target !== undefined
  )
    return {
      dataSource: evidence.endpointDataSourceHints.target,
      platform: platformFromDataSource(evidence.endpointDataSourceHints.target),
    };
  if (target === candidate && evidence.endpointDataSourceHints?.target !== undefined)
    return {
      dataSource: evidence.endpointDataSourceHints.target,
      platform: platformFromDataSource(evidence.endpointDataSourceHints.target),
    };
  if (
    target === candidate &&
    isDatabaseSourceToHiveTask(evidence.taskCategory)
  )
    return { dataSource: "gfhive", platform: "hive" };
  if (source === candidate && evidence.taskCategory?.startsWith("hive2"))
    return { dataSource: "gfhive", platform: "hive" };
  if (
    isDatabaseSourceToHiveTask(evidence.taskCategory) &&
    evidence.endpointDataSourceHints?.source !== undefined
  )
    return {
      dataSource: evidence.endpointDataSourceHints.source,
      platform: platformFromDataSource(evidence.endpointDataSourceHints.source),
    };
  return {
    dataSource: parsePhysicalTableName(qualifiedName)?.dataSource,
    platform: parsePhysicalTableName(qualifiedName)?.dataSource
      ? platformFromDataSource(parsePhysicalTableName(qualifiedName)!.dataSource!)
      : undefined,
  };
}

function concreteOnlineDataSource(
  qualifiedName: string,
  dataSource: string | undefined,
  catalog: OfflineTableCatalog,
): string | undefined {
  if (dataSource === undefined || catalog.rdbmsQnServiceIndex === undefined)
    return dataSource;
  const service = serviceSuffixFromAtlasDataSource(dataSource);
  if (service === undefined) return dataSource;
  const concrete = catalog.rdbmsQnServiceIndex.get(
    `${qualifiedName.toLowerCase()}#${service}`,
  );
  if (typeof concrete !== "string") return dataSource;
  const at = concrete.lastIndexOf("@");
  return at > 0 ? concrete.slice(at + 1) : dataSource;
}

function writeTableEvidenceSafely(
  dataRoot: string,
  evidence: TableEvidence,
): { readonly changed: boolean; readonly contentHash: string } {
  const document = createTableDocument(evidence);
  const directory = join(dataRoot, "tables", document.platform, document.stableTableId);
  const tablePath = join(directory, "table.json");
  if (existsSync(tablePath)) {
    const existing = JSON.parse(readFileSync(tablePath, "utf8")) as Record<string, unknown>;
    const sameIdentity =
      existing.stableTableId === document.stableTableId &&
      String(existing.platform).toLowerCase() === document.platform.toLowerCase() &&
      String(existing.dataSource).toLowerCase() === document.dataSource.toLowerCase() &&
      String(existing.qualifiedName).toLowerCase() === document.qualifiedName.toLowerCase();
    if (!sameIdentity || existing.contentHash !== document.contentHash)
      throw new Error(`TABLE_PACK_IDENTITY_CONFLICT:${document.stableTableId}`);
    return { changed: false, contentHash: document.contentHash };
  }
  const written = writeTableInput(dataRoot, evidence);
  return { changed: written.changed, contentHash: written.contentHash };
}

function repairTablesForTask(
  options: RepairInputPackPartialsOptions,
  row: PartialRepairInventoryRow,
  manifestPath: string,
  catalog: ReturnType<typeof loadOfflineTableCatalog>,
  packStore: ReturnType<typeof openOfflineTablePackStore>,
  tableLookupMemo: Map<string, TableLookupMemoEntry>,
  now: () => Date,
): { readonly local: number; readonly online: number; readonly failures: number } {
  const assembled = assembleCacheTaskEvidence(row.taskId, options.cacheRoot);
  if (assembled.kind !== "EVIDENCE") {
    appendManifest(
      manifestPath,
      manifestRow(
        {
          taskId: row.taskId,
          evidenceKind: "TABLE",
          route: "LOCAL",
          failureClass: `TASK_EVIDENCE_${assembled.kind}`,
        },
        now,
      ),
    );
    return { local: 0, online: 0, failures: 1 };
  }
  const evidence = assembled.evidence;
  const resolution = resolveOfflineTables(
    options.dataRoot,
    evidence,
    catalog,
    now,
    packStore,
  );
  const resolvedByName = new Map(
    resolution.resolved.map((item) => [item.qualifiedName.toLowerCase(), item]),
  );
  const unavailableByName = new Map(
    resolution.unavailable.map((item) => [item.qualifiedName.toLowerCase(), item.reason]),
  );
  const candidates = extractOfflineTableCandidates(evidence, catalog.horaeDatasource);
  const lookup =
    options.tableLookup ??
    ((qualifiedName: string, expectedDataSource: string | undefined, lookupOptions: TableEvidenceLookupOptions) =>
      tableFromDirectEvidence(
        qualifiedName,
        undefined,
        expectedDataSource,
        lookupOptions,
      ));
  let local = 0;
  let online = 0;
  let failures = 0;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.qualifiedName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const localEvidence = resolvedByName.get(key);
    if (localEvidence !== undefined) {
      const written = writeTableEvidenceSafely(options.dataRoot, localEvidence);
      appendManifest(
        manifestPath,
        manifestRow(
          {
            taskId: row.taskId,
            evidenceKind: "TABLE",
            qualifiedName: localEvidence.qualifiedName,
            route: "LOCAL",
            provider: localEvidence.evidenceProvider,
            sha256: written.contentHash,
            changed: written.changed,
          },
          now,
        ),
      );
      local += 1;
      continue;
    }
    const reason = unavailableByName.get(key);
    if (reason?.includes("CONFLICT"))
      throw new Error(`TABLE_LOCAL_CONFLICT:${row.taskId}:${candidate.qualifiedName}:${reason}`);
    const identity = expectedTableIdentity(evidence, candidate.qualifiedName);
    const onlineDataSource = concreteOnlineDataSource(
      candidate.qualifiedName,
      identity.dataSource,
      catalog,
    );
    if (!options.allowOnlineBackup) {
      failures += 1;
      appendManifest(
        manifestPath,
        manifestRow(
          {
            taskId: row.taskId,
            evidenceKind: "TABLE",
            qualifiedName: candidate.qualifiedName,
            route: "LOCAL",
            failureClass: "ONLINE_BACKUP_DISABLED",
          },
          now,
        ),
      );
      continue;
    }
    try {
      const lookupKey = [
        candidate.qualifiedName.toLowerCase(),
        onlineDataSource?.toLowerCase() ?? "",
        identity.platform?.toLowerCase() ?? "",
      ].join("|");
      const memoized = tableLookupMemo.get(lookupKey);
      let table: TableEvidence;
      if (memoized?.kind === "ERROR") throw memoized.error;
      if (memoized?.kind === "RESULT") table = memoized.table;
      else {
        try {
          const lookedUp = lookup(candidate.qualifiedName, onlineDataSource, {
            preferDirectLookup: true,
            directOnly: true,
            skipDescriptionRefresh: true,
            expectedPlatform: identity.platform,
            throwOnLookupError: true,
          });
          if (lookedUp === undefined) throw new Error("NO_EXACT_TABLE_EVIDENCE");
          if (
            lookedUp.qualifiedName.toLowerCase() !== key ||
            lookedUp.ddl.trim() === "" ||
            lookedUp.dataSource.trim() === "" ||
            lookedUp.dataSource.toLowerCase() === "default" ||
            (onlineDataSource !== undefined &&
              lookedUp.dataSource.toLowerCase() !== onlineDataSource.toLowerCase()) ||
            (identity.platform !== undefined &&
              lookedUp.platform.toLowerCase() !== identity.platform.toLowerCase())
          )
            throw new Error("NO_EXACT_TABLE_EVIDENCE");
          tableLookupMemo.set(lookupKey, { kind: "RESULT", table: lookedUp });
          table = lookedUp;
        } catch (error) {
          tableLookupMemo.set(lookupKey, { kind: "ERROR", error });
          throw error;
        }
      }
      const written = writeTableEvidenceSafely(options.dataRoot, table);
      appendManifest(
        manifestPath,
        manifestRow(
          {
            taskId: row.taskId,
            evidenceKind: "TABLE",
            qualifiedName: table.qualifiedName,
            route: "ONLINE",
            provider: table.evidenceProvider,
            sha256: written.contentHash,
            changed: written.changed,
          },
          now,
        ),
      );
      online += 1;
    } catch (error) {
      failures += 1;
      appendManifest(
        manifestPath,
        manifestRow(
          {
            taskId: row.taskId,
            evidenceKind: "TABLE",
            qualifiedName: candidate.qualifiedName,
            route: options.allowOnlineBackup ? "ONLINE" : "LOCAL",
            failureClass: classifyFailure(error),
          },
          now,
        ),
      );
    }
  }
  return { local, online, failures };
}

export async function repairInputPackPartials(
  options: RepairInputPackPartialsOptions,
): Promise<RepairInputPackPartialsSummary> {
  const dataRoot = resolve(options.dataRoot);
  const cacheRoot = resolve(options.cacheRoot);
  const inventory = readInventory(resolve(options.inventoryPath));
  const rows = selectedRows(inventory, options.taskIds);
  const manifestPath = resolve(
    options.manifestPath ?? join(dataRoot, "repair-manifests", "partial-repair.jsonl"),
  );
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, "", "utf8");
  const now = options.now ?? (() => new Date());
  const onlineDisabled = (): never => {
    throw new Error("ONLINE_BACKUP_DISABLED");
  };
  const sqlRows = rows.filter((row) => SQL_TASK_TYPES.has(row.taskCategory ?? ""));
  const hiveRows = rows.filter((row) =>
    row.taskCategory !== undefined && HIVE_DDL_FROM_LOG_TASK_TYPES.has(row.taskCategory),
  );
  if (!options.tableOnly && sqlRows.length > 0) {
    const taskIds = sqlRows
      .filter((row) => row.taskCategory !== undefined && row.taskCategory.startsWith("hiveTask"))
      .map((row) => row.taskId);
    if (taskIds.length > 0)
      await fillHiveTaskSqlCache({
        cacheRoot,
        taskIds,
        force: true,
        maxErrors: options.maxErrors,
        minIntervalMs: 0,
        mcpRunner: options.allowOnlineBackup ? undefined : onlineDisabled,
        now,
      });
    const runScriptIds = sqlRows
      .filter((row) => row.taskCategory !== undefined && row.taskCategory.startsWith("runScript"))
      .map((row) => row.taskId);
    const sparkScriptIds = sqlRows
      .filter((row) => row.taskCategory === "sparkScript")
      .map((row) => row.taskId);
    const logIds = [...new Set([...runScriptIds, ...sparkScriptIds])];
    if (logIds.length > 0)
      await fillRunScriptSqlCache({
        cacheRoot,
        taskIds: logIds,
        force: true,
        maxErrors: options.maxErrors,
        minIntervalMs: 0,
        logRunner: options.allowOnlineBackup ? undefined : onlineDisabled,
        now,
      });
    for (const row of sqlRows)
      recordSqlCacheEvidence(
        row.taskId,
        cacheRoot,
        manifestPath,
        now,
        !options.allowOnlineBackup,
        "TASK_SQL",
      );
  }
  if (!options.tableOnly && hiveRows.length > 0) {
    await fillHiveDdlFromLogCache({
      cacheRoot,
      taskIds: hiveRows.map((row) => row.taskId),
      dataDate: options.dataDate,
      force: false,
      maxErrors: options.maxErrors,
      minIntervalMs: 0,
      logRunner: options.allowOnlineBackup ? undefined : onlineDisabled,
      now,
    });
    for (const row of hiveRows)
      recordSqlCacheEvidence(
        row.taskId,
        cacheRoot,
        manifestPath,
        now,
        !options.allowOnlineBackup,
        "HIVE_DDL",
      );
  }

  loadPersistedTableCache(dataRoot);
  const packStore = openOfflineTablePackStore(dataRoot);
  const catalog =
    options.catalog ??
    loadOfflineTableCatalog({
      scheduleEvidenceCacheRoot: cacheRoot,
      indexDir: join(cacheRoot, "schedule-evidence", "jsonl-indexes"),
    });
  let tableResolvedLocal = 0;
  let tableRepairedOnline = 0;
  let tableFailures = 0;
  const tableLookupMemo = new Map<string, TableLookupMemoEntry>();
  for (const row of rows) {
    const result = repairTablesForTask(
      { ...options, dataRoot, cacheRoot },
      row,
      manifestPath,
      catalog,
      packStore,
      tableLookupMemo,
      now,
    );
    tableResolvedLocal += result.local;
    tableRepairedOnline += result.online;
    tableFailures += result.failures;
  }
  return {
    taskCount: rows.length,
    sqlTaskCount: sqlRows.length,
    hiveDdlTaskCount: hiveRows.length,
    tableResolvedLocal,
    tableRepairedOnline,
    tableFailures,
    manifestPath,
  };
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dataRoot = optionValue(argv, "--data-root");
  const cacheRoot = optionValue(argv, "--cache-root");
  const inventoryPath = optionValue(argv, "--inventory");
  if (dataRoot === undefined || cacheRoot === undefined || inventoryPath === undefined)
    throw new Error("REPAIR_REQUIRES_DATA_ROOT_CACHE_ROOT_INVENTORY");
  const taskIdsPath = optionValue(argv, "--task-ids-file");
  const rawMaxErrors = optionValue(argv, "--max-errors");
  const maxErrors =
    rawMaxErrors === undefined ? undefined : Number.parseInt(rawMaxErrors, 10);
  if (maxErrors !== undefined && (!Number.isSafeInteger(maxErrors) || maxErrors < 0))
    throw new Error("MAX_ERRORS_INVALID");
  const summary = await repairInputPackPartials({
    dataRoot,
    cacheRoot,
    inventoryPath,
    taskIds: taskIdsPath === undefined ? undefined : readTaskIds(taskIdsPath),
    manifestPath: optionValue(argv, "--manifest"),
    allowOnlineBackup: argv.includes("--allow-online-backup"),
    tableOnly: argv.includes("--table-only"),
    dataDate: optionValue(argv, "--data-date"),
    maxErrors,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if ((process.argv[1] ?? "").endsWith("repair-input-pack-partials.ts")) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
