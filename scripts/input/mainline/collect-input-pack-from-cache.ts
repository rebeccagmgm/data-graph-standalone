import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildTableMetadataCatalog } from "../../../packages/data-graph/src/asset-graph/table-metadata-catalog-build.ts";
import { defaultTableMetadataCatalogRoot } from "../../../packages/data-graph/src/asset-graph/table-metadata-catalog.ts";

import {
  sha256File,
  validateTaskDocument,
  type SqlSlot,
  type TableEvidence,
  type TaskDocument,
  type TaskEvidence,
} from "../shared/input-pack.ts";
import { assembleCacheTaskEvidence, sqlSlotCount } from "../shared/cache-task-evidence.ts";
import {
  loadOfflineTableCatalog,
  openOfflineTablePackStore,
  parsePhysicalTableName,
  resolveOfflineTables,
  type OfflineTableCatalog,
  type OfflineTableCatalogPaths,
} from "../shared/offline-table-resolver.ts";
import { materializeTaskAndTablePacks } from "../shared/task-table-materialization.ts";
import {
  buildCompactTaskPartition,
  isDatabaseSourceToHiveTask,
} from "../shared/task-partition-evidence.ts";
import { readTaskPartitionBindingsCache } from "../../evidence/schedule-evidence-cache.ts";
import { enrichTaskEndpoint, inputCollectionStatus } from "../shared/task-endpoints.ts";
import { findSqlFinalTargetEvidence } from "../shared/sql-target-evidence.ts";
import {
  findStaleLegacyTaskDirectories,
  relocateTaskPacks,
} from "./collect-one-task-input-pack.ts";
import {
  taskIdsFromFile,
  taskIdsFromScheduleEvidenceCache,
} from "./fill-horae-relation-cache.ts";
import { exitCodeForTaskBatch } from "./task-batch.ts";
import {
  assertStatusFileOutsideDataRoot,
  defaultTaskStatusFile,
  loadTaskStatus,
  saveTaskStatus,
  updateTaskStatus,
  type TaskStatusDocument,
} from "./task-status.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  resolveScheduleEvidenceCacheRoot,
} from "../../evidence/schedule-evidence-cache.ts";

const SQL_SLOTS: readonly SqlSlot[] = [
  "create",
  "query",
  "prepare",
  "truncate",
  "finish",
];

export interface CollectInputPackFromCacheOptions {
  readonly dataRoot: string;
  readonly cacheRoot?: string;
  readonly taskIds?: readonly string[];
  readonly force?: boolean;
  readonly dryRun?: boolean;
  /** Include tasks marked manual or frozen by the scheduler. */
  readonly includeManual?: boolean;
  readonly hiveMetadataPath?: string;
  readonly hiveDdlPath?: string;
  readonly rdbmsCorePath?: string;
  readonly rdbmsDdlPath?: string;
  readonly indexDir?: string;
  readonly logDir?: string;
  readonly manualDataRoot?: string;
  readonly notFoundDataRoot?: string;
  readonly statusFile?: string;
  readonly now?: () => Date;
  readonly refreshMetadataCatalog?: boolean;
  readonly metadataCatalogRoot?: string;
}

const STATUS_FLUSH_EVERY = 50;
const PROGRESS_EVERY = 20;

export interface CollectInputPackFromCacheSummary {
  readonly taskId: string;
  readonly collectionStatus:
    | "SUCCESS"
    | "PARTIAL"
    | "SKIPPED"
    | "EXCLUDED"
    | "FAILED"
    | "DRY_RUN";
  readonly reason?: string;
  readonly taskCategory?: string;
  readonly directory?: string;
  readonly changed?: boolean;
  readonly contentHash?: string;
  readonly tablesWritten?: number;
  readonly tablesUnavailable?: readonly string[];
  readonly cacheArtifacts?: readonly string[];
  readonly warnings?: readonly string[];
  readonly staleLegacyTaskDirectories?: readonly string[];
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requiredOption(argv: readonly string[], name: string): string {
  const value = optionValue(argv, name);
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function assertArchiveRootOutsideDataRoot(
  optionName: string,
  archiveRoot: string,
  dataRoot: string,
): void {
  const archiveRelative = relative(dataRoot, archiveRoot);
  if (
    archiveRoot === dataRoot ||
    (archiveRelative !== "" &&
      archiveRelative !== ".." &&
      !archiveRelative.startsWith(`..${sep}`) &&
      !isAbsolute(archiveRelative))
  )
    throw new Error(`${optionName} must be outside --data-root: ${archiveRoot}`);
}

function sqlContent(evidence: TaskEvidence): Partial<Record<SqlSlot, string>> {
  const result: Partial<Record<SqlSlot, string>> = {};
  for (const slot of SQL_SLOTS) {
    const raw = evidence.sql?.[slot];
    const content =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object"
          ? raw.content
          : undefined;
    if (typeof content === "string" && content.trim() !== "")
      result[slot] = content;
  }
  return result;
}

function findExistingValidTaskPack(
  dataRoot: string,
  taskId: string,
):
  | {
      readonly category: string;
      readonly directory: string;
      readonly sqlSlotCount: number;
      readonly contentHash: string;
    }
  | undefined {
  const tasksRoot = join(dataRoot, "tasks");
  if (!existsSync(tasksRoot) || taskId.includes("/") || taskId.includes("\\"))
    return undefined;
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(tasksRoot, entry.name, taskId);
    const taskPath = join(directory, "task.json");
    if (!existsSync(taskPath)) continue;
    try {
      const document = JSON.parse(readFileSync(taskPath, "utf8")) as TaskDocument;
      validateTaskDocument(document);
      if (document.taskId !== taskId) continue;
      for (const sqlFile of document.sqlFiles) {
        const file = sqlFile as { path: string; sha256: string };
        if (sha256File(join(directory, file.path)) !== file.sha256) return undefined;
      }
      return {
        category: document.taskCategory,
        directory,
        sqlSlotCount: document.sqlFiles.length,
        contentHash: document.contentHash,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function persistStatus(
  status: TaskStatusDocument,
  dryRun: boolean,
  record: Parameters<typeof updateTaskStatus>[1],
): void {
  if (dryRun) return;
  updateTaskStatus(status, record);
}

function writeProgress(
  logDir: string | undefined,
  payload: Record<string, unknown>,
): void {
  if (logDir === undefined) return;
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, "progress.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

function tableForEndpoint(
  value: unknown,
  tables: readonly TableEvidence[],
): TableEvidence | undefined {
  const parsed = parsePhysicalTableName(value);
  if (parsed === undefined) return undefined;
  const matches = tables.filter(
    (table) =>
      table.qualifiedName.toLowerCase() === parsed.qualifiedName.toLowerCase(),
  );
  if (parsed.dataSource !== undefined) {
    const byDataSource = matches.filter(
      (table) =>
        table.dataSource.toLowerCase() === parsed.dataSource!.toLowerCase(),
    );
    if (byDataSource.length === 1) return byDataSource[0];
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function sqlWriteTable(
  evidence: TaskEvidence,
  tables: readonly TableEvidence[],
): TableEvidence | undefined {
  const fromTarget = tableForEndpoint(evidence.target, tables);
  if (fromTarget !== undefined) return fromTarget;
  const sqlTarget = findSqlFinalTargetEvidence(
    sqlContent(evidence),
    typeof evidence.taskName === "string" ? evidence.taskName : undefined,
    { allowSchemaOnlyQualification: true },
  );
  return sqlTarget === undefined
    ? undefined
    : tableForEndpoint(sqlTarget.qualifiedName, tables);
}

function enrichEvidence(
  evidence: TaskEvidence,
  tables: readonly TableEvidence[],
  partitionBindingOverrides?: Readonly<Record<string, string>>,
): TaskEvidence {
  const category = evidence.taskCategory ?? "unknown";
  const source = enrichTaskEndpoint(
    evidence.source ?? undefined,
    tableForEndpoint(evidence.source, tables),
  );
  const target = enrichTaskEndpoint(
    evidence.target === null ? undefined : evidence.target,
    sqlWriteTable(evidence, tables),
  );
  return {
    ...evidence,
    taskCategory: category,
    source,
    target,
    partition: buildCompactTaskPartition({
      taskTarget:
        typeof target === "string"
          ? target
          : target &&
              typeof target === "object" &&
              !Array.isArray(target) &&
              typeof target.qualifiedName === "string"
            ? target.qualifiedName
            : undefined,
      tables,
      schedulerEvidence: evidence.schedulerEvidence,
      sql: sqlContent(evidence),
      allowImplicitQueryOutput: !isDatabaseSourceToHiveTask(category),
      allowSourceTemporalPartitionDefault: isDatabaseSourceToHiveTask(category),
      sparkIndexMode: category === "sparkIndex",
      partitionBindingOverrides,
    }),
  };
}

export function collectOneTaskInputPackFromCache(
  dataRoot: string,
  taskId: string,
  options: {
    readonly cacheRoot: string;
    readonly catalog: OfflineTableCatalog;
    readonly force: boolean;
    readonly dryRun: boolean;
    readonly includeManual: boolean;
    readonly manualDataRoot: string;
    readonly notFoundDataRoot: string;
    readonly status: TaskStatusDocument;
    readonly packStore: ReturnType<typeof openOfflineTablePackStore>;
    readonly now?: () => Date;
    readonly onTableWrite?: (table: {
      readonly platform: string;
      readonly stableTableId: string;
    }) => void;
  },
): CollectInputPackFromCacheSummary {
  const assembled = assembleCacheTaskEvidence(taskId, options.cacheRoot, {
    includeManual: options.includeManual,
  });
  const cacheArtifacts = [...assembled.cacheArtifacts];

  if (assembled.kind === "NOT_FOUND") {
    const moved = options.dryRun
      ? []
      : relocateTaskPacks(dataRoot, options.notFoundDataRoot, taskId);
    persistStatus(options.status, options.dryRun, {
      taskId,
      status: "EXCLUDED",
      exclusionReason: "HORAE_TASK_NOT_FOUND",
      changed: moved.length > 0,
      cacheArtifacts,
      warnings: [],
      staleLegacyTaskDirectories: [],
    });
    return {
      taskId,
      collectionStatus: "EXCLUDED",
      reason: "HORAE_TASK_NOT_FOUND",
      cacheArtifacts,
    };
  }

  if (assembled.kind === "MANUAL_OR_FROZEN") {
    const moved = options.dryRun
      ? []
      : relocateTaskPacks(dataRoot, options.manualDataRoot, taskId);
    persistStatus(options.status, options.dryRun, {
      taskId,
      status: "EXCLUDED",
      exclusionReason: "MANUAL_OR_FROZEN",
      changed: moved.length > 0,
      cacheArtifacts,
      warnings: ["ARCHIVED_MANUAL_OR_FROZEN"],
      staleLegacyTaskDirectories: [],
    });
    return {
      taskId,
      collectionStatus: "EXCLUDED",
      reason: "MANUAL_OR_FROZEN",
      cacheArtifacts,
      warnings: ["ARCHIVED_MANUAL_OR_FROZEN"],
    };
  }

  if (assembled.kind === "SKIPPED") {
    return {
      taskId,
      collectionStatus: "SKIPPED",
      reason: assembled.reason,
      taskCategory: assembled.taskCategory,
      cacheArtifacts,
    };
  }

  if (assembled.kind === "FAILED") {
    persistStatus(options.status, options.dryRun, {
      taskId,
      status: "FAILED",
      error: assembled.reason,
      cacheArtifacts,
      warnings: [],
      staleLegacyTaskDirectories: [],
    });
    return {
      taskId,
      collectionStatus: "FAILED",
      reason: assembled.reason,
      cacheArtifacts,
    };
  }

  const existing = findExistingValidTaskPack(dataRoot, taskId);
  const newSlotCount = sqlSlotCount(assembled.evidence);
  if (existing !== undefined && !options.force) {
    return {
      taskId,
      collectionStatus: "SKIPPED",
      reason: "EXISTING_VALID_PACK",
      taskCategory: existing.category,
      directory: existing.directory,
      contentHash: existing.contentHash,
      cacheArtifacts,
    };
  }
  if (
    existing !== undefined &&
    options.force &&
    newSlotCount < existing.sqlSlotCount
  ) {
    return {
      taskId,
      collectionStatus: "SKIPPED",
      reason: "EXISTING_PACK_HAS_MORE_SQL_SLOTS",
      taskCategory: existing.category,
      directory: existing.directory,
      contentHash: existing.contentHash,
      cacheArtifacts,
      warnings: ["OFFLINE_SQL_SLOTS_FEWER_THAN_EXISTING"],
    };
  }

  const category = assembled.evidence.taskCategory ?? "unknown";
  const staleLegacyTaskDirectories = findStaleLegacyTaskDirectories(
    dataRoot,
    taskId,
    category,
  );
  const resolution = resolveOfflineTables(
    dataRoot,
    assembled.evidence,
    options.catalog,
    options.now,
    options.packStore,
  );
  const bindingsCache = readTaskPartitionBindingsCache(taskId, options.cacheRoot);
  if (bindingsCache.status === "HIT")
    cacheArtifacts.push("task-partition-bindings.json");
  const partitionBindingOverrides =
    bindingsCache.status === "HIT"
      ? Object.fromEntries(
          Object.entries(bindingsCache.bindings).map(([field, value]) => [
            field,
            String(value),
          ]),
        )
      : undefined;
  const evidence = enrichEvidence(
    assembled.evidence,
    resolution.resolved,
    partitionBindingOverrides,
  );
  const tablesUnavailable = resolution.unavailable.map((item) => item.qualifiedName);
  const collectionStatus = inputCollectionStatus(
    resolution.resolved.length + resolution.unavailable.length,
    tablesUnavailable.length > 0,
    false,
    assembled.missingQuery,
    false,
  );

  if (options.dryRun) {
    return {
      taskId,
      collectionStatus: "DRY_RUN",
      reason: collectionStatus,
      taskCategory: category,
      tablesWritten: resolution.resolved.length,
      tablesUnavailable,
      cacheArtifacts,
      warnings: resolution.unavailable.map(
        (item) => `${item.qualifiedName}:${item.reason}`,
      ),
      staleLegacyTaskDirectories,
    };
  }

  const materialized = materializeTaskAndTablePacks(
    dataRoot,
    evidence,
    resolution.resolved,
  );
  for (const [index, table] of materialized.tables.entries()) {
    const evidenceForTable = resolution.resolved[index];
    if (evidenceForTable !== undefined)
      options.packStore.remember(evidenceForTable, table.contentHash);
    if (table.changed)
      options.onTableWrite?.({
        platform: basename(dirname(table.directory)),
        stableTableId: basename(table.directory),
      });
  }
  persistStatus(options.status, false, {
    taskId,
    status: collectionStatus,
    taskCategory: category,
    taskType: evidence.taskType,
    directory: resolve(materialized.task.directory),
    changed: materialized.task.changed,
    contentHash: materialized.task.contentHash,
    tablesWritten: materialized.tables.length,
    tableAssets: materialized.tables.map((table) => ({
      directory: resolve(table.directory),
      contentHash: table.contentHash,
    })),
    tablesUnavailable,
    warnings: resolution.unavailable.map(
      (item) => `${item.qualifiedName}:${item.reason}`,
    ),
    staleLegacyTaskDirectories,
    cacheArtifacts,
  });
  return {
    taskId,
    collectionStatus,
    taskCategory: category,
    directory: materialized.task.directory,
    changed: materialized.task.changed,
    contentHash: materialized.task.contentHash,
    tablesWritten: materialized.tables.length,
    tablesUnavailable,
    cacheArtifacts,
    warnings: resolution.unavailable.map(
      (item) => `${item.qualifiedName}:${item.reason}`,
    ),
    staleLegacyTaskDirectories,
  };
}

export function collectInputPackFromCache(
  options: CollectInputPackFromCacheOptions,
): readonly CollectInputPackFromCacheSummary[] {
  const dataRoot = resolve(options.dataRoot);
  const cacheRoot = resolve(
    options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  );
  const manualDataRoot = resolve(
    options.manualDataRoot ?? `${dataRoot}.manual-tasks`,
  );
  const notFoundDataRoot = resolve(
    options.notFoundDataRoot ?? `${dataRoot}.not-found-tasks`,
  );
  assertArchiveRootOutsideDataRoot("--manual-data-root", manualDataRoot, dataRoot);
  assertArchiveRootOutsideDataRoot(
    "--not-found-data-root",
    notFoundDataRoot,
    dataRoot,
  );
  const statusFile = resolve(
    options.statusFile ?? defaultTaskStatusFile(dataRoot),
  );
  assertStatusFileOutsideDataRoot(statusFile, dataRoot);

  const taskIds = [
    ...new Set(
      options.taskIds !== undefined && options.taskIds.length > 0
        ? options.taskIds
        : taskIdsFromScheduleEvidenceCache(cacheRoot),
    ),
  ];
  if (taskIds.length === 0) throw new Error("NO_TASK_IDS");

  const logDir =
    options.logDir === undefined ? undefined : resolve(options.logDir);
  const log = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}`;
    process.stderr.write(`${stamped}\n`);
    if (logDir !== undefined) {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, "run.log"), `${stamped}\n`, "utf8");
    }
  };
  const writeSummary = (summary: CollectInputPackFromCacheSummary): void => {
    const line = `${JSON.stringify(summary)}\n`;
    process.stdout.write(line);
    if (logDir !== undefined) {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, "summaries.jsonl"), line, "utf8");
    }
  };

  log(`start tasks=${taskIds.length} dataRoot=${dataRoot} cacheRoot=${cacheRoot}`);
  const catalogStarted = Date.now();
  log("loading jsonl catalog indexes");
  const catalogPaths: OfflineTableCatalogPaths = {
    hiveMetadataPath: options.hiveMetadataPath,
    hiveDdlPath: options.hiveDdlPath,
    rdbmsCorePath: options.rdbmsCorePath,
    rdbmsDdlPath: options.rdbmsDdlPath,
    indexDir:
      options.indexDir ??
      join(resolveScheduleEvidenceCacheRoot(cacheRoot), "jsonl-indexes"),
  };
  const catalog = loadOfflineTableCatalog(catalogPaths);
  log(`catalog ready ${Date.now() - catalogStarted}ms`);

  const status = loadTaskStatus(statusFile, dataRoot);
  const packStore = openOfflineTablePackStore(dataRoot);
  const dryRun = options.dryRun === true;
  const flushStatus = (): void => {
    if (!dryRun) saveTaskStatus(statusFile, status);
  };
  const counts: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const bump = (map: Record<string, number>, key: string): void => {
    map[key] = (map[key] ?? 0) + 1;
  };
  const summaries: CollectInputPackFromCacheSummary[] = [];
  const changedTables = new Map<
    string,
    { readonly platform: string; readonly stableTableId: string }
  >();
  const started = Date.now();
  for (const [index, taskId] of taskIds.entries()) {
    let summary: CollectInputPackFromCacheSummary;
    try {
      summary = collectOneTaskInputPackFromCache(dataRoot, taskId, {
        cacheRoot,
        catalog,
        force: options.force === true,
        dryRun,
        includeManual: options.includeManual === true,
        manualDataRoot,
        notFoundDataRoot,
        status,
        packStore,
        now: options.now,
        onTableWrite: (table) =>
          changedTables.set(
            `${table.platform.toLowerCase()}\0${table.stableTableId}`,
            table,
          ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      persistStatus(status, dryRun, {
        taskId,
        status: "FAILED",
        error: message,
        warnings: [],
        staleLegacyTaskDirectories: [],
      });
      summary = {
        taskId,
        collectionStatus: "FAILED",
        reason: message,
      };
    }
    summaries.push(summary);
    writeSummary(summary);
    bump(counts, summary.collectionStatus);
    if (summary.reason !== undefined)
      bump(reasons, `${summary.collectionStatus}:${summary.reason}`);
    const processed = index + 1;
    if (processed % STATUS_FLUSH_EVERY === 0 || summary.collectionStatus === "FAILED")
      flushStatus();
    if (processed % PROGRESS_EVERY === 0 || processed === taskIds.length) {
      const elapsedMs = Date.now() - started;
      const payload = {
        processed,
        total: taskIds.length,
        elapsedMs,
        ratePerMin:
          elapsedMs === 0 ? 0 : Math.round((processed * 60000) / elapsedMs),
        counts,
        topReasons: Object.entries(reasons)
          .sort((left, right) => right[1] - left[1])
          .slice(0, 15),
      };
      writeProgress(logDir, payload);
      log(
        `progress ${processed}/${taskIds.length} ${JSON.stringify(counts)} rate=${payload.ratePerMin}/min`,
      );
    }
  }
  flushStatus();
  if (
    !dryRun &&
    options.refreshMetadataCatalog !== false &&
    changedTables.size > 0
  ) {
    const metadataCatalogRoot = resolve(
      options.metadataCatalogRoot ??
        defaultTableMetadataCatalogRoot(cacheRoot),
    );
    const hasCurrent = existsSync(join(metadataCatalogRoot, "current.json"));
    const metadataReport = buildTableMetadataCatalog({
      tablesRoot: join(dataRoot, "tables"),
      catalogRoot: metadataCatalogRoot,
      ...(hasCurrent ? { scope: { tables: [...changedTables.values()] } } : {}),
    });
    log(`metadata catalog ${JSON.stringify(metadataReport)}`);
  }
  log(`done ${JSON.stringify(counts)} elapsedMs=${Date.now() - started}`);
  return summaries;
}

export function parseCollectInputPackFromCacheArgs(
  argv: readonly string[],
): CollectInputPackFromCacheOptions {
  const taskIdsRaw = optionValue(argv, "--task-ids");
  const taskIdsFile = optionValue(argv, "--task-ids-file");
  if (taskIdsRaw !== undefined && taskIdsFile !== undefined)
    throw new Error("Use only one of --task-ids or --task-ids-file");
  return {
    dataRoot: requiredOption(argv, "--data-root"),
    cacheRoot: optionValue(argv, "--cache-root"),
    taskIds:
      taskIdsFile !== undefined
        ? taskIdsFromFile(taskIdsFile)
        : taskIdsRaw === undefined
          ? undefined
          : taskIdsRaw
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
    force: flag(argv, "--force"),
    dryRun: flag(argv, "--dry-run"),
    includeManual: flag(argv, "--include-manual"),
    hiveMetadataPath: optionValue(argv, "--hive-metadata-jsonl"),
    hiveDdlPath: optionValue(argv, "--hive-ddl-jsonl"),
    rdbmsCorePath: optionValue(argv, "--rdbms-core-jsonl"),
    rdbmsDdlPath: optionValue(argv, "--rdbms-ddl-jsonl"),
    indexDir: optionValue(argv, "--index-dir"),
    logDir: optionValue(argv, "--log-dir"),
    refreshMetadataCatalog: !flag(argv, "--skip-metadata-catalog-refresh"),
    metadataCatalogRoot: optionValue(argv, "--metadata-catalog-root"),
  };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry?.endsWith("collect-input-pack-from-cache.ts") ?? false;
}

if (isDirectExecution()) {
  try {
    const summaries = collectInputPackFromCache(
      parseCollectInputPackFromCacheArgs(process.argv),
    );
    const failed = summaries.some((item) => item.collectionStatus === "FAILED");
    process.exitCode = exitCodeForTaskBatch(failed);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
