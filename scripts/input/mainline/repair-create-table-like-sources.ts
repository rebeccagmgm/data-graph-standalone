import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  loadPersistedTableCache,
  tableFromDirectEvidence,
  type TableEvidenceLookupOptions,
} from "./collect-one-task-input-pack.ts";
import {
  createTableDocument,
  writeTableInput,
  type SqlSlot,
  type TableEvidence,
} from "../shared/input-pack.ts";
import {
  collectCreateTableLikeSources,
  isCreateTableLikeOnly,
  normalizeQualifiedName,
  tableHasProvableColumns,
  type CreateTableLikeChainStopReason,
} from "../shared/create-table-like-chain.ts";
import {
  loadOfflineTableCatalog,
  openOfflineTablePackStore,
  parsePhysicalTableName,
  resolveStandaloneOfflineTable,
  type OfflineTableCatalog,
} from "../shared/offline-table-resolver.ts";
import { uniqueTaskSqlCreateStatement } from "../shared/sparkindex-table-evidence.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SQL_SLOTS: readonly SqlSlot[] = [
  "create",
  "query",
  "prepare",
  "truncate",
  "finish",
];
const DEFAULT_TASK_CATEGORIES = ["sparkIndex"] as const;
const HIVE_DATA_SOURCE = "gfhive";

export type LikeSourceRepairManifestRow = {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "CREATE_TABLE_LIKE_SOURCE_REPAIR";
  readonly observedAt: string;
  readonly taskId?: string;
  readonly targetQualifiedName?: string;
  readonly sourceQualifiedName?: string;
  readonly route: "LOCAL" | "ONLINE" | "SKIP";
  readonly outcome:
    | "RESOLVED"
    | "ALREADY_PROVABLE"
    | "FAILED"
    | "TARGET_SCANNED"
    | "CHAIN_STOP";
  readonly failureClass?: string;
  readonly chainStopReason?: CreateTableLikeChainStopReason;
  readonly changed?: boolean;
  readonly sha256?: string;
};

export interface RepairCreateTableLikeSourcesOptions {
  readonly dataRoot: string;
  readonly cacheRoot: string;
  readonly taskCategories?: readonly string[];
  readonly taskIds?: readonly string[];
  readonly manifestPath?: string;
  readonly maxDepth?: number;
  readonly allowOnlineBackup?: boolean;
  readonly dryRun?: boolean;
  readonly now?: () => Date;
  readonly catalog?: OfflineTableCatalog;
  readonly tableLookup?: (
    qualifiedName: string,
    expectedDataSource: string | undefined,
    options?: TableEvidenceLookupOptions,
  ) => ReturnType<typeof tableFromDirectEvidence>;
}

export interface RepairCreateTableLikeSourcesSummary {
  readonly scannedTasks: number;
  readonly likeTargets: number;
  readonly sourcesQueued: number;
  readonly sourcesResolvedLocal: number;
  readonly sourcesResolvedOnline: number;
  readonly sourcesSkippedProvable: number;
  readonly sourcesFailed: number;
  readonly affectedTaskIds: readonly string[];
  readonly manifestPath: string;
}

type TaskPackRef = {
  readonly taskId: string;
  readonly taskCategory: string;
  readonly packPath: string;
};

type LocalTablePackView = {
  readonly qualifiedName: string;
  readonly dataSource: string;
  readonly ddl: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
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

function manifestRow(
  row: Omit<LikeSourceRepairManifestRow, "schemaVersion" | "artifactType" | "observedAt">,
  now: () => Date,
): LikeSourceRepairManifestRow {
  return {
    schemaVersion: "1.0.0",
    artifactType: "CREATE_TABLE_LIKE_SOURCE_REPAIR",
    observedAt: now().toISOString(),
    ...row,
  };
}

function appendManifest(path: string, row: LikeSourceRepairManifestRow): void {
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}

function listTaskPacks(
  dataRoot: string,
  categories: readonly string[],
  requestedTaskIds: ReadonlySet<string> | undefined,
): TaskPackRef[] {
  const tasksRoot = join(dataRoot, "tasks");
  const output: TaskPackRef[] = [];
  for (const taskCategory of categories) {
    const categoryRoot = join(tasksRoot, taskCategory);
    if (!existsSync(categoryRoot)) continue;
    for (const entry of readdirSync(categoryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      if (!SAFE_TASK_ID.test(taskId)) continue;
      if (requestedTaskIds !== undefined && !requestedTaskIds.has(taskId))
        continue;
      const packPath = join(categoryRoot, taskId, "task.json");
      if (!existsSync(packPath)) continue;
      output.push({ taskId, taskCategory, packPath });
    }
  }
  return output.sort((left, right) =>
    left.taskCategory === right.taskCategory
      ? left.taskId.localeCompare(right.taskId)
      : left.taskCategory.localeCompare(right.taskCategory),
  );
}

function readSqlSlots(packPath: string): Partial<Record<SqlSlot, string>> {
  const pack = JSON.parse(readFileSync(packPath, "utf8")) as {
    sqlFiles?: readonly { slot?: string; path?: string; file?: string; locator?: string }[];
  };
  const sql: Partial<Record<SqlSlot, string>> = {};
  const packDir = dirname(packPath);
  for (const raw of pack.sqlFiles ?? []) {
    const slot = raw.slot;
    if (slot === undefined || !SQL_SLOTS.includes(slot as SqlSlot)) continue;
    const locator = raw.path ?? raw.file ?? raw.locator;
    if (typeof locator !== "string") continue;
    const path = resolve(packDir, locator);
    if (!existsSync(path)) continue;
    sql[slot as SqlSlot] = readFileSync(path, "utf8");
  }
  return sql;
}

function targetQualifiedName(packPath: string): string | undefined {
  const pack = JSON.parse(readFileSync(packPath, "utf8")) as {
    target?: unknown;
  };
  return parsePhysicalTableName(pack.target)?.qualifiedName;
}

function lookupLocalTablePack(
  packStore: ReturnType<typeof openOfflineTablePackStore>,
  qualifiedName: string,
): LocalTablePackView | undefined {
  const keys = [
    `${normalizeQualifiedName(qualifiedName)}@${HIVE_DATA_SOURCE}`,
    normalizeQualifiedName(qualifiedName),
  ];
  for (const key of keys) {
    const packs = packStore.get(key);
    if (packs === undefined || packs.length === 0) continue;
    const unique = new Map<string, LocalTablePackView>();
    for (const pack of packs) {
      unique.set(
        `${pack.evidence.dataSource.toLowerCase()}:${pack.evidence.qualifiedName.toLowerCase()}`,
        {
          qualifiedName: pack.evidence.qualifiedName,
          dataSource: pack.evidence.dataSource,
          ddl: pack.evidence.ddl,
        },
      );
    }
    if (unique.size === 1) return [...unique.values()][0];
  }
  return undefined;
}

function ddlForQualifiedName(
  qualifiedName: string,
  packStore: ReturnType<typeof openOfflineTablePackStore>,
  taskSql: Partial<Record<SqlSlot, string>>,
): string | undefined {
  const local = lookupLocalTablePack(packStore, qualifiedName);
  if (local !== undefined) return local.ddl;
  const created = uniqueTaskSqlCreateStatement(taskSql, qualifiedName);
  if (created.ddl !== undefined) return created.ddl;
  return undefined;
}

function writeTableEvidenceSafely(
  dataRoot: string,
  evidence: TableEvidence,
  dryRun: boolean,
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
  if (dryRun) return { changed: true, contentHash: document.contentHash };
  const written = writeTableInput(dataRoot, evidence);
  return { changed: written.changed, contentHash: written.contentHash };
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

export function repairCreateTableLikeSources(
  options: RepairCreateTableLikeSourcesOptions,
): RepairCreateTableLikeSourcesSummary {
  const dataRoot = resolve(options.dataRoot);
  const cacheRoot = resolve(options.cacheRoot);
  const now = options.now ?? (() => new Date());
  const categories = options.taskCategories ?? DEFAULT_TASK_CATEGORIES;
  const requestedTaskIds =
    options.taskIds === undefined
      ? undefined
      : new Set(options.taskIds.map((taskId) => taskId.trim()).filter(Boolean));
  const manifestPath = resolve(
    options.manifestPath ??
      join(dataRoot, "repair-manifests", "create-table-like-sources.jsonl"),
  );
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, "", "utf8");

  const packStore = openOfflineTablePackStore(dataRoot);
  const catalog =
    options.catalog ??
    loadOfflineTableCatalog({
      scheduleEvidenceCacheRoot: cacheRoot,
      indexDir: join(cacheRoot, "schedule-evidence", "jsonl-indexes"),
    });
  if (options.allowOnlineBackup) loadPersistedTableCache(dataRoot);
  const lookup =
    options.tableLookup ??
    ((qualifiedName, expectedDataSource, lookupOptions) =>
      tableFromDirectEvidence(
        qualifiedName,
        undefined,
        expectedDataSource,
        lookupOptions,
      ));

  const taskPacks = listTaskPacks(dataRoot, categories, requestedTaskIds);
  const sourceQueue = new Map<
    string,
    { readonly referencedBy: Set<string>; readonly targetQualifiedName: string }
  >();
  let likeTargets = 0;

  for (const taskPack of taskPacks) {
    const target = targetQualifiedName(taskPack.packPath);
    if (target === undefined) continue;
    const sql = readSqlSlots(taskPack.packPath);
    const targetDdl = ddlForQualifiedName(target, packStore, sql);
    if (targetDdl === undefined || !isCreateTableLikeOnly(targetDdl)) continue;
    likeTargets += 1;
    appendManifest(
      manifestPath,
      manifestRow(
        {
          taskId: taskPack.taskId,
          targetQualifiedName: target,
          route: "SKIP",
          outcome: "TARGET_SCANNED",
        },
        now,
      ),
    );
    const chain = collectCreateTableLikeSources(
      target,
      (qualifiedName) => ddlForQualifiedName(qualifiedName, packStore, sql),
      options.maxDepth,
    );
    if (chain.stoppedReason !== undefined && chain.sources.length === 0) {
      appendManifest(
        manifestPath,
        manifestRow(
          {
            taskId: taskPack.taskId,
            targetQualifiedName: target,
            route: "SKIP",
            outcome: "CHAIN_STOP",
            chainStopReason: chain.stoppedReason,
          },
          now,
        ),
      );
      continue;
    }
    for (const sourceQualifiedName of chain.sources) {
      const key = normalizeQualifiedName(sourceQualifiedName);
      const existing = sourceQueue.get(key);
      if (existing === undefined) {
        sourceQueue.set(key, {
          referencedBy: new Set([taskPack.taskId]),
          targetQualifiedName: target,
        });
      } else {
        existing.referencedBy.add(taskPack.taskId);
      }
    }
  }

  const resolvedThisPass: TableEvidence[] = [];
  const affectedTaskIds = new Set<string>();
  let sourcesResolvedLocal = 0;
  let sourcesResolvedOnline = 0;
  let sourcesSkippedProvable = 0;
  let sourcesFailed = 0;

  const orderedSources = [...sourceQueue.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [normalizedSource, context] of orderedSources) {
    const sourceQualifiedName =
      lookupLocalTablePack(packStore, normalizedSource)?.qualifiedName ??
      normalizedSource;
    const local = lookupLocalTablePack(packStore, sourceQualifiedName);
    if (local !== undefined && tableHasProvableColumns(local.ddl)) {
      sourcesSkippedProvable += 1;
      appendManifest(
        manifestPath,
        manifestRow(
          {
            sourceQualifiedName,
            route: "SKIP",
            outcome: "ALREADY_PROVABLE",
          },
          now,
        ),
      );
      continue;
    }

    const localResult = resolveStandaloneOfflineTable(
      sourceQualifiedName,
      catalog,
      packStore,
      now().toISOString(),
      { dataSource: HIVE_DATA_SOURCE, resolvedThisPass },
    );
    if ("evidence" in localResult) {
      try {
        const written = writeTableEvidenceSafely(
          dataRoot,
          localResult.evidence,
          options.dryRun === true,
        );
        if (!options.dryRun) {
          packStore.remember(localResult.evidence, written.contentHash);
          resolvedThisPass.push(localResult.evidence);
        }
        sourcesResolvedLocal += 1;
        for (const taskId of context.referencedBy) affectedTaskIds.add(taskId);
        appendManifest(
          manifestPath,
          manifestRow(
            {
              sourceQualifiedName,
              route: "LOCAL",
              outcome: "RESOLVED",
              changed: written.changed,
              sha256: written.contentHash,
            },
            now,
          ),
        );
        continue;
      } catch (error) {
        sourcesFailed += 1;
        appendManifest(
          manifestPath,
          manifestRow(
            {
              sourceQualifiedName,
              route: "LOCAL",
              outcome: "FAILED",
              failureClass: errorMessage(error),
            },
            now,
          ),
        );
        continue;
      }
    }

    if (!options.allowOnlineBackup) {
      sourcesFailed += 1;
      appendManifest(
        manifestPath,
        manifestRow(
          {
            sourceQualifiedName,
            route: "LOCAL",
            outcome: "FAILED",
            failureClass: localResult.reason,
          },
          now,
        ),
      );
      continue;
    }

    try {
      const table = lookup(sourceQualifiedName, HIVE_DATA_SOURCE, {
        preferDirectLookup: true,
        directOnly: true,
        skipDescriptionRefresh: true,
        expectedPlatform: "hive",
        throwOnLookupError: true,
      });
      if (
        table === undefined ||
        table.ddl.trim() === "" ||
        table.dataSource.toLowerCase() !== HIVE_DATA_SOURCE ||
        table.platform.toLowerCase() !== "hive" ||
        table.qualifiedName.toLowerCase() !==
          normalizeQualifiedName(sourceQualifiedName)
      )
        throw new Error("NO_EXACT_TABLE_EVIDENCE");
      const written = writeTableEvidenceSafely(
        dataRoot,
        table,
        options.dryRun === true,
      );
      if (!options.dryRun) {
        packStore.remember(table, written.contentHash);
        resolvedThisPass.push(table);
      }
      sourcesResolvedOnline += 1;
      for (const taskId of context.referencedBy) affectedTaskIds.add(taskId);
      appendManifest(
        manifestPath,
        manifestRow(
          {
            sourceQualifiedName,
            route: "ONLINE",
            outcome: "RESOLVED",
            changed: written.changed,
            sha256: written.contentHash,
          },
          now,
        ),
      );
    } catch (error) {
      sourcesFailed += 1;
      appendManifest(
        manifestPath,
        manifestRow(
          {
            sourceQualifiedName,
            route: "ONLINE",
            outcome: "FAILED",
            failureClass: classifyFailure(error),
          },
          now,
        ),
      );
    }
  }

  const affectedIdsPath = join(dirname(manifestPath), "affected-task-ids.txt");
  writeFileSync(
    affectedIdsPath,
    `${[...affectedTaskIds].sort((left, right) => left.localeCompare(right)).join("\n")}\n`,
    "utf8",
  );

  return {
    scannedTasks: taskPacks.length,
    likeTargets,
    sourcesQueued: sourceQueue.size,
    sourcesResolvedLocal,
    sourcesResolvedOnline,
    sourcesSkippedProvable,
    sourcesFailed,
    affectedTaskIds: [...affectedTaskIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    manifestPath,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const dataRoot = optionValue(argv, "--data-root");
  const cacheRoot = optionValue(argv, "--cache-root");
  if (dataRoot === undefined || cacheRoot === undefined)
    throw new Error("REPAIR_REQUIRES_DATA_ROOT_CACHE_ROOT");
  const taskIdsFile = optionValue(argv, "--task-ids-file");
  const categories = optionValue(argv, "--task-categories")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const summary = repairCreateTableLikeSources({
    dataRoot,
    cacheRoot,
    taskCategories: categories,
    taskIds: taskIdsFile === undefined ? undefined : readTaskIds(taskIdsFile),
    manifestPath: optionValue(argv, "--manifest"),
    maxDepth: optionValue(argv, "--max-depth") === undefined
      ? undefined
      : Number.parseInt(optionValue(argv, "--max-depth")!, 10),
    allowOnlineBackup: argv.includes("--allow-online-backup"),
    dryRun: argv.includes("--dry-run"),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if ((process.argv[1] ?? "").endsWith("repair-create-table-like-sources.ts")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
