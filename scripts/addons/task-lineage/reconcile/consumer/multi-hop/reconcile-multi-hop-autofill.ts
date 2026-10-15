import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultMutableProducerIndexRoot,
  loadOrRebuildTableProducerIndex,
  loadTableProducerIndex,
  loadTableProducerInputManifest,
  updateTableProducerIndex,
  type TableProducerIndex,
} from "../../../../../reconcile/producer/producer-index.ts";
import {
  catalogHasWriterForTableKey,
  isLegacyProducerIndexPath,
  resolveWriterLookup,
  writerLookupMeta,
} from "../../../../../query/table-writer-lookup.ts";
import {
  openWriterCatalog,
  resolveWriterCatalogPath,
} from "../../../../../query/writer-catalog.ts";
import {
  defaultOpenCliRunner,
  prepareOneHopContext,
  reconcileOneHopWithPreparedContext,
  type OneHopReconciliationResult,
  type OpenCliRunner,
} from "../one-hop/reconcile-one-hop.ts";
import { runCollector } from "../one-hop/reconcile-one-hop-autofill.ts";
import {
  reconcileMultiHop,
  type MultiHopReconciliationResult,
} from "./reconcile-multi-hop.ts";
import {
  DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  loadTerminalTableConfig,
  matchingTerminalRole,
  type TerminalTableConfig,
} from "../../../../../reconcile/shared/terminal-table-config.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeRelationCache,
  writeHoraeRelationCache,
} from "../../../../../evidence/schedule-evidence-cache.ts";
import { isNonHiveProducerBoundary } from "../../../../../reconcile/shared/lineage-scope.ts";

type JsonRecord = Record<string, unknown>;

const DEFAULT_MAX_TASKS = 1000;
const DEFAULT_MAX_EDGES = 10000;
const DEFAULT_MAX_DISCOVERY_TABLES = 1000;
const DEFAULT_MAX_DISCOVERED_TASKS = 5000;

export interface MultiHopAutofillOptions {
  readonly taskId: string;
  readonly dataRoot: string;
  readonly producerIndexPath?: string;
  /** @deprecated Prefer producerIndexRoot; kept for CLI compatibility. */
  readonly producerIndexCacheRoot?: string;
  /** Fixed mutable Producer Index directory (default: `<data-root>.producer-index`). */
  readonly producerIndexRoot?: string;
  readonly writerCatalogPath?: string;
  /** Read-through cache for every Horae relation fetched during closure. */
  readonly scheduleEvidenceCacheRoot?: string;
  readonly outputPath?: string;
  readonly reportPath?: string;
  readonly terminalTableConfigPath: string;
  readonly maxDepth: number;
  readonly maxTasks: number;
  readonly maxEdges: number;
  readonly maxRounds?: number;
  readonly maxDiscoveryTables?: number;
  readonly maxDiscoveredTasks?: number;
  readonly discoveryMinIntervalMs?: number;
  readonly discoveryAttempts?: number;
  readonly force?: boolean;
  /** Test-only mode for append-only concurrent Input Pack roots. */
  readonly allowInputChanges?: boolean;
  readonly trustExistingIndex?: boolean;
  readonly now?: () => string;
  readonly openCliRunner?: OpenCliRunner;
  readonly collectTaskPacks?: (
    dataRoot: string,
    taskIds: readonly string[],
    force: boolean,
  ) => void;
  readonly sleep?: (milliseconds: number) => void;
}

export interface MultiHopAutofillReport {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "MULTI_HOP_AUTOFILL_REPORT";
  readonly rootTaskId: string;
  readonly generatedAt: string;
  readonly status: "COMPLETE" | "PARTIAL";
  readonly rounds: number;
  readonly queriedTables: readonly string[];
  readonly discoveredTaskIds: readonly string[];
  readonly collectedTaskIds: readonly string[];
  readonly nonHiveSourceBoundaries: readonly string[];
  readonly issues: readonly string[];
  readonly producerIndexContentHash: string;
  readonly producerIndexInputFingerprint: string;
  readonly initialIndexMode:
    | "PINNED_FINGERPRINT_CACHE"
    | "STRICT_UPDATE"
    | "TRUSTED_EXISTING_FROZEN_INPUT";
}

export interface MultiHopAutofillResult {
  readonly artifact: MultiHopReconciliationResult;
  readonly report: MultiHopAutofillReport;
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function rowsOf(value: unknown): JsonRecord[] {
  if (Array.isArray(value))
    return value
      .map(asRecord)
      .filter((item): item is JsonRecord => item !== null);
  const root = asRecord(value);
  if (!root) return [];
  for (const key of ["results", "rows", "data", "items"]) {
    const rows = root[key];
    if (Array.isArray(rows))
      return rows
        .map(asRecord)
        .filter((item): item is JsonRecord => item !== null);
  }
  return [root];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "zh-Hans", {
    numeric: true,
    sensitivity: "base",
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort(compareText);
}

function tableKey(table: {
  readonly platform?: string | null;
  readonly dataSource?: string | null;
  readonly qualifiedName: string;
}): string {
  return [table.platform ?? "", table.dataSource ?? "", table.qualifiedName]
    .map((item) => item.toLocaleLowerCase("en-US"))
    .join("|");
}

function tableParts(
  qualifiedName: string,
): { db: string; table: string } | null {
  const separator = qualifiedName.indexOf(".");
  if (separator <= 0 || separator === qualifiedName.length - 1) return null;
  return {
    db: qualifiedName.slice(0, separator),
    table: qualifiedName.slice(separator + 1),
  };
}

function taskPackExists(dataRoot: string, taskId: string): boolean {
  const tasksRoot = join(dataRoot, "tasks");
  if (!existsSync(tasksRoot)) return false;
  return readdirSync(tasksRoot, { withFileTypes: true }).some(
    (entry) =>
      entry.isDirectory() &&
      existsSync(join(tasksRoot, entry.name, taskId, "task.json")),
  );
}

function confirmedProducerTableKeys(index: TableProducerIndex): Set<string> {
  return new Set(
    index.confirmedProducerEdges.map((edge) => tableKey(edge.table)),
  );
}

export function producerTaskIdsFromTableResponse(value: unknown): string[] {
  return unique(
    rowsOf(value).flatMap((row) => {
      const tasks = Array.isArray(row.tasks) ? row.tasks : [];
      return tasks
        .map((item) => asRecord(item))
        .map((item) => text(item?.taskId ?? item?.task_id))
        .filter((taskId) => SAFE_TASK_ID.test(taskId));
    }),
  );
}

function defaultSleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function retryableDiscoveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /限流|429|timeout|timed out|mcp_tool_error/i.test(message);
}

function writeJson(pathInput: string | undefined, value: unknown): void {
  if (!pathInput) return;
  const path = isAbsolute(pathInput) ? pathInput : resolve(pathInput);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function progress(event: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(
    `[multi-hop-autofill] ${JSON.stringify({ event, ...details })}\n`,
  );
}

function requirePositiveInteger(
  value: number,
  field: string,
  allowZero = false,
): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    throw new Error(`${field.toUpperCase()}_INVALID`);
}

function scheduleRows(
  taskId: string,
  runner: OpenCliRunner,
  cacheRoot: string | null,
  now: () => string,
): readonly JsonRecord[] {
  const cached =
    cacheRoot === null ? null : readHoraeRelationCache(taskId, cacheRoot);
  if (cached?.status === "HIT") {
    progress("schedule_cache_hit", {
      taskId,
      rows: cached.rows.length,
      path: cached.path,
    });
    return cached.rows;
  }
  progress("schedule_cache_miss", {
    taskId,
    status: cached?.status ?? "DISABLED",
    path: cached?.path ?? null,
  });
  const response = runner([
    "horae",
    "relation",
    taskId,
    "--direction",
    "up",
    "--depth",
    "1",
    "--window",
    "background",
    "-f",
    "json",
  ]);
  const rows = horaeRelationRows(response);
  if (!isCacheableHoraeRelationResponse(response, rows))
    throw new Error(`HORAE_RELATION_INVALID:${taskId}`);
  if (cacheRoot !== null) {
    try {
      const path = writeHoraeRelationCache(taskId, now(), rows, cacheRoot);
      progress("schedule_cache_write", { taskId, rows: rows.length, path });
    } catch {
      // The live evidence remains usable when the optional cache is not writable.
      progress("schedule_cache_write_failed", { taskId });
    }
  }
  progress("schedule_fetched", { taskId, rows: rows.length });
  return rows;
}

export function queryProducerTaskIds(
  qualifiedName: string,
  runner: OpenCliRunner,
  attempts: number,
  sleep: (milliseconds: number) => void,
): string[] {
  const parts = tableParts(qualifiedName);
  if (!parts) throw new Error(`TABLE_QUALIFIED_NAME_INVALID:${qualifiedName}`);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return producerTaskIdsFromTableResponse(
        runner([
          "szdata",
          "table",
          "--db",
          parts.db,
          "--table",
          parts.table,
          "--view",
          "full",
          "-f",
          "json",
        ]),
      );
    } catch (error) {
      lastError = error;
      if (!retryableDiscoveryError(error) || attempt === attempts) break;
      sleep(attempt * 2_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function missingScheduleTaskIds(result: OneHopReconciliationResult): string[] {
  return unique(
    result.issueDetails
      .filter((issue) => issue.code === "TASK_INPUT_PACK_MISSING")
      .map((issue) => issue.taskId ?? ""),
  );
}

function nextPrimaryTaskIds(result: OneHopReconciliationResult): string[] {
  const unknown = new Set(result.partitionAwareNextDataTaskIds.unknown);
  return result.finalUpstreamTaskIds.primary.filter(
    (taskId) => !unknown.has(taskId),
  );
}

export function runMultiHopAutofill(
  options: MultiHopAutofillOptions,
): MultiHopAutofillResult {
  if (!SAFE_TASK_ID.test(options.taskId)) throw new Error("INVALID_TASK_ID");
  requirePositiveInteger(options.maxDepth, "maxDepth");
  requirePositiveInteger(options.maxTasks, "maxTasks");
  requirePositiveInteger(options.maxEdges, "maxEdges");
  const maxRounds = options.maxRounds ?? options.maxDepth + 3;
  const maxDiscoveryTables = options.maxDiscoveryTables ?? 200;
  const maxDiscoveredTasks = options.maxDiscoveredTasks ?? 500;
  const discoveryMinIntervalMs = options.discoveryMinIntervalMs ?? 1_000;
  const discoveryAttempts = options.discoveryAttempts ?? 3;
  requirePositiveInteger(maxRounds, "maxRounds");
  requirePositiveInteger(maxDiscoveryTables, "maxDiscoveryTables");
  requirePositiveInteger(maxDiscoveredTasks, "maxDiscoveredTasks");
  requirePositiveInteger(
    discoveryMinIntervalMs,
    "discoveryMinIntervalMs",
    true,
  );
  requirePositiveInteger(discoveryAttempts, "discoveryAttempts");

  const dataRoot = resolve(options.dataRoot);
  const scheduleEvidenceCacheRoot =
    options.scheduleEvidenceCacheRoot === undefined
      ? options.openCliRunner === undefined
        ? resolve(DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT)
        : null
      : resolve(options.scheduleEvidenceCacheRoot);
  const producerIndexPath = options.producerIndexPath
    ? resolve(options.producerIndexPath)
    : null;
  const producerIndexRoot = resolve(
    options.producerIndexRoot ??
      options.producerIndexCacheRoot ??
      defaultMutableProducerIndexRoot(dataRoot),
  );
  const manifestPath = producerIndexPath
    ? `${producerIndexPath}.manifest.json`
    : null;
  const terminalConfig: TerminalTableConfig = loadTerminalTableConfig(
    resolve(options.terminalTableConfigPath),
  );
  const runner =
    options.openCliRunner ?? ((args) => defaultOpenCliRunner(args, 30_000));
  const collect = options.collectTaskPacks ?? runCollector;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date().toISOString());
  const queriedTables = new Set<string>();
  const queriedTableNames = new Set<string>();
  const discoveredTaskIds = new Set<string>();
  const collectedTaskIds = new Set<string>();
  const nonHiveSourceBoundaries = new Set<string>();
  const attemptedTaskIds = new Set<string>();
  const unavailableTaskIds = new Set<string>();
  const issues: string[] = [];
  const scheduleCache = new Map<string, readonly JsonRecord[]>();
  let lastTableQueryAt = 0;
  let rounds = 0;
  let stabilized = false;
  let finalSnapshots = new Map<string, OneHopReconciliationResult>();

  progress("start", {
    taskId: options.taskId,
    maxDepth: options.maxDepth,
    maxTasks: options.maxTasks,
    maxRounds,
    scheduleEvidenceCacheRoot,
    allowInputChanges: options.allowInputChanges === true,
  });

  const useLegacyIndex =
    options.trustExistingIndex === true ||
    (producerIndexPath !== null && isLegacyProducerIndexPath(producerIndexPath)) ||
    (producerIndexPath === null &&
      options.writerCatalogPath === undefined &&
      (options.producerIndexRoot !== undefined ||
        options.producerIndexCacheRoot !== undefined));

  let producerIndex: TableProducerIndex | undefined;
  if (useLegacyIndex) {
    if (options.trustExistingIndex === true) {
      if (
        producerIndexPath === null ||
        manifestPath === null ||
        !existsSync(producerIndexPath) ||
        !existsSync(manifestPath)
      )
        throw new Error("TRUSTED_EXISTING_INDEX_OR_MANIFEST_MISSING");
      producerIndex = loadTableProducerIndex(producerIndexPath);
      const manifest = loadTableProducerInputManifest(manifestPath);
      if (manifest.inputFingerprint !== producerIndex.inputFingerprint)
        throw new Error("TRUSTED_EXISTING_INDEX_MANIFEST_MISMATCH");
    } else {
      producerIndex = producerIndexPath
        ? updateTableProducerIndex(dataRoot, producerIndexPath, manifestPath!, {
            now,
            allowInputChanges: options.allowInputChanges,
          }).index
        : loadOrRebuildTableProducerIndex(dataRoot, producerIndexRoot, {
            now,
            allowInputChanges: options.allowInputChanges,
          }).index;
    }
  }
  const writerCatalog = useLegacyIndex
    ? undefined
    : openWriterCatalog(
        resolveWriterCatalogPath(dataRoot, {
          writerCatalogPath: options.writerCatalogPath,
        }),
      );
  const lookup = resolveWriterLookup({ writerCatalog, producerIndex });
  if (!lookup) throw new Error("WRITER_LOOKUP_REQUIRED");

  while (rounds < maxRounds) {
    rounds += 1;
    const context = prepareOneHopContext(dataRoot, {
      includeFingerprint: false,
      trustedInputFingerprint: producerIndex?.inputFingerprint,
      schemaLoading: "TASK_SCOPED",
    });
    const producerTables = producerIndex
      ? confirmedProducerTableKeys(producerIndex)
      : new Set<string>();
    const snapshots = new Map<string, OneHopReconciliationResult>();
    const pendingTaskIds = new Set<string>();
    const enqueueMissingTaskPack = (taskId: string): void => {
      discoveredTaskIds.add(taskId);
      if (
        !taskPackExists(dataRoot, taskId) &&
        !attemptedTaskIds.has(taskId) &&
        !unavailableTaskIds.has(taskId)
      )
        pendingTaskIds.add(taskId);
    };
    const frontier: Array<{ taskId: string; depth: number }> = [
      { taskId: options.taskId, depth: 0 },
    ];
    const visited = new Set<string>();
    progress("round_start", {
      round: rounds,
      maxRounds,
      frontier: frontier.length,
      visited: visited.size,
      pending: pendingTaskIds.size,
    });

    while (frontier.length > 0) {
      frontier.sort(
        (left, right) =>
          left.depth - right.depth || compareText(left.taskId, right.taskId),
      );
      const current = frontier.shift()!;
      if (visited.has(current.taskId) || current.depth >= options.maxDepth)
        continue;
      if (visited.size >= options.maxTasks)
        throw new Error("MAX_TASKS_REACHED");
      if (!taskPackExists(dataRoot, current.taskId)) {
        if (current.taskId === options.taskId)
          throw new Error(`CURRENT_TASK_INPUT_PACK_MISSING:${current.taskId}`);
        unavailableTaskIds.add(current.taskId);
        issues.push(`DISCOVERED_TASK_PACK_UNAVAILABLE:${current.taskId}`);
        continue;
      }
      visited.add(current.taskId);
      const frozenSchedule =
        scheduleCache.get(current.taskId) ??
        scheduleRows(current.taskId, runner, scheduleEvidenceCacheRoot, now);
      scheduleCache.set(current.taskId, frozenSchedule);
      const oneHop = reconcileOneHopWithPreparedContext(
        current.taskId,
        {
          dataRoot,
          producerIndex,
          writerCatalog,
          verifyInputFingerprint: producerIndex !== undefined,
          scheduleRows: frozenSchedule,
          now,
          terminalTableConfig: terminalConfig,
        },
        context,
      );
      snapshots.set(current.taskId, oneHop);

      progress("task_reconciled", {
        round: rounds,
        taskId: current.taskId,
        depth: current.depth,
        scheduleParents: frozenSchedule.length,
        primaryUpstream: oneHop.finalUpstreamTaskIds.primary.length,
        missingSchedulePacks: missingScheduleTaskIds(oneHop).length,
      });

      for (const taskId of missingScheduleTaskIds(oneHop)) {
        enqueueMissingTaskPack(taskId);
      }

      for (const read of oneHop.currentTask.directReads) {
        const qualifiedName = read.table.qualifiedName;
        if (
          read.table.identityStatus !== "RESOLVED" ||
          !read.table.platform ||
          !read.table.dataSource ||
          !qualifiedName ||
          matchingTerminalRole(terminalConfig, qualifiedName)
        )
          continue;
        const key = tableKey({ ...read.table, qualifiedName });
        const known =
          producerIndex !== undefined
            ? producerTables.has(key)
            : catalogHasWriterForTableKey(lookup, {
                platform: String(read.table.platform),
                dataSource: String(read.table.dataSource),
                qualifiedName,
              });
        if (known || queriedTables.has(key)) continue;
        if (queriedTables.size >= maxDiscoveryTables)
          throw new Error("MAX_DISCOVERY_TABLES_REACHED");
        const remaining =
          discoveryMinIntervalMs - (Date.now() - lastTableQueryAt);
        if (remaining > 0) sleep(remaining);
        lastTableQueryAt = Date.now();
        queriedTables.add(key);
        queriedTableNames.add(qualifiedName);
        try {
          const taskIds = queryProducerTaskIds(
            qualifiedName,
            runner,
            discoveryAttempts,
            sleep,
          );
          if (taskIds.length === 0)
            if (isNonHiveProducerBoundary(read.table.platform))
              nonHiveSourceBoundaries.add(qualifiedName);
            else
              issues.push(`TABLE_PRODUCER_TASK_NOT_OBSERVED:${qualifiedName}`);
          for (const taskId of taskIds) {
            enqueueMissingTaskPack(taskId);
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          issues.push(
            `TABLE_PRODUCER_DISCOVERY_FAILED:${qualifiedName}:${message}`,
          );
        }
      }

      for (const nextTaskId of nextPrimaryTaskIds(oneHop)) {
        if (!taskPackExists(dataRoot, nextTaskId)) {
          enqueueMissingTaskPack(nextTaskId);
          continue;
        }
        frontier.push({ taskId: nextTaskId, depth: current.depth + 1 });
      }
    }

    finalSnapshots = snapshots;
    const collectIds = unique([...pendingTaskIds]);
    if (collectIds.length === 0) {
      stabilized = true;
      progress("round_stable", {
        round: rounds,
        visited: visited.size,
        discovered: discoveredTaskIds.size,
      });
      break;
    }
    if (
      new Set([...discoveredTaskIds, ...collectIds]).size > maxDiscoveredTasks
    )
      throw new Error("MAX_DISCOVERED_TASKS_REACHED");
    try {
      progress("input_pack_collect_start", {
        round: rounds,
        batchSize: collectIds.length,
        taskIds: collectIds,
      });
      collect(dataRoot, collectIds, options.force === true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`INPUT_PACK_COLLECTION_FAILED:${message}`);
    }
    progress("input_pack_collect_done", {
      round: rounds,
      batchSize: collectIds.length,
      collected: collectIds.filter((taskId) => taskPackExists(dataRoot, taskId))
        .length,
    });
    for (const taskId of collectIds) {
      attemptedTaskIds.add(taskId);
      if (taskPackExists(dataRoot, taskId)) collectedTaskIds.add(taskId);
      else {
        unavailableTaskIds.add(taskId);
        issues.push(`DISCOVERED_TASK_PACK_UNAVAILABLE:${taskId}`);
      }
    }
    if (useLegacyIndex) {
      producerIndex = producerIndexPath
        ? updateTableProducerIndex(dataRoot, producerIndexPath, manifestPath!, {
            now,
            allowInputChanges: options.allowInputChanges,
          }).index
        : loadOrRebuildTableProducerIndex(dataRoot, producerIndexRoot, {
            forceRebuild: true,
            now,
            allowInputChanges: options.allowInputChanges,
          }).index;
    }
  }

  if (!stabilized) throw new Error("MAX_AUTOFILL_ROUNDS_REACHED");
  const rootOneHop = finalSnapshots.get(options.taskId);
  if (!rootOneHop) throw new Error("ROOT_ONE_HOP_SNAPSHOT_MISSING");
  const artifact = reconcileMultiHop(options.taskId, {
    dataRoot,
    producerIndex,
    writerCatalog,
    maxDepth: options.maxDepth,
    maxTasks: options.maxTasks,
    maxEdges: options.maxEdges,
    now,
    rootOneHop,
    oneHopSnapshots: finalSnapshots,
    terminalTableConfig: terminalConfig,
  });
  const report: MultiHopAutofillReport = {
    schemaVersion: "1.0.0",
    artifactType: "MULTI_HOP_AUTOFILL_REPORT",
    rootTaskId: options.taskId,
    generatedAt: now(),
    status: issues.length === 0 ? "COMPLETE" : "PARTIAL",
    rounds,
    queriedTables: unique([...queriedTableNames]),
    discoveredTaskIds: unique([...discoveredTaskIds]),
    collectedTaskIds: unique([...collectedTaskIds]),
    nonHiveSourceBoundaries: unique([...nonHiveSourceBoundaries]),
    issues: unique(issues),
    producerIndexContentHash:
      producerIndex?.contentHash ?? writerLookupMeta(lookup).contentHash,
    producerIndexInputFingerprint:
      producerIndex?.inputFingerprint ?? writerLookupMeta(lookup).contentHash,
    initialIndexMode:
      options.trustExistingIndex === true
        ? "TRUSTED_EXISTING_FROZEN_INPUT"
        : producerIndexPath
          ? "STRICT_UPDATE"
          : "PINNED_FINGERPRINT_CACHE",
  };
  writeJson(options.outputPath, artifact);
  writeJson(options.reportPath, report);
  progress("complete", {
    taskId: options.taskId,
    status: report.status,
    rounds: report.rounds,
    discovered: report.discoveredTaskIds.length,
    collected: report.collectedTaskIds.length,
    output: options.outputPath ? resolve(options.outputPath) : null,
    report: options.reportPath ? resolve(options.reportPath) : null,
  });
  return { artifact, report };
}

function horaeRelationRows(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return rowsOf(value);
  const record = asRecord(value);
  if (!record) return [];
  for (const field of ["records", "rows", "data", "results"]) {
    const rows = record[field];
    if (Array.isArray(rows)) return rowsOf(rows);
  }
  return [];
}

function isCacheableHoraeRelationResponse(
  value: unknown,
  rows: readonly JsonRecord[],
): boolean {
  if (Array.isArray(value)) return value.length === rows.length;
  const record = asRecord(value);
  if (!record) return false;
  if (
    record.error !== undefined ||
    record.success === false ||
    ["fail", "failed", "failure", "error"].includes(
      String(record.status ?? "").toLowerCase(),
    )
  )
    return false;
  const envelope = ["records", "rows", "data", "results"].find((field) =>
    Array.isArray(record[field]),
  );
  return (
    envelope !== undefined &&
    (record[envelope] as unknown[]).length === rows.length
  );
}

interface CliOptions {
  readonly taskId: string;
  readonly dataRoot: string;
  readonly producerIndexPath?: string;
  readonly producerIndexCacheRoot?: string;
  readonly writerCatalogPath?: string;
  readonly scheduleEvidenceCacheRoot?: string;
  readonly outputPath?: string;
  readonly reportPath?: string;
  readonly terminalTableConfigPath: string;
  readonly maxDepth: number;
  readonly maxTasks: number;
  readonly maxEdges: number;
  readonly maxRounds: number;
  readonly maxDiscoveryTables: number;
  readonly maxDiscoveredTasks: number;
  readonly force: boolean;
  readonly allowInputChanges: boolean;
  readonly trustExistingIndex: boolean;
}

function parseCli(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueNames = new Set([
    "--task-id",
    "--data-root",
    "--producer-index",
    "--producer-index-cache-root",
    "--writer-catalog",
    "--schedule-evidence-cache-root",
    "--output",
    "--report",
    "--terminal-table-config",
    "--max-depth",
    "--max-tasks",
    "--max-edges",
    "--max-rounds",
    "--max-discovery-tables",
    "--max-discovered-tasks",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (
      argument === "--force" ||
      argument === "--allow-input-changes" ||
      argument === "--trust-existing-index"
    ) {
      flags.add(argument);
      continue;
    }
    if (!valueNames.has(argument))
      throw new Error(`UNKNOWN_ARGUMENT:${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`VALUE_REQUIRED:${argument}`);
    values.set(argument, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name.slice(2).toUpperCase()}_REQUIRED`);
    return value;
  };
  const integer = (name: string, fallback: number): number => {
    const value = values.get(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed))
      throw new Error(`${name.slice(2).toUpperCase()}_INVALID`);
    return parsed;
  };
  return {
    taskId: required("--task-id"),
    dataRoot: required("--data-root"),
    producerIndexPath: values.get("--producer-index"),
    producerIndexCacheRoot: values.get("--producer-index-cache-root"),
    writerCatalogPath: values.get("--writer-catalog"),
    scheduleEvidenceCacheRoot: values.get("--schedule-evidence-cache-root"),
    outputPath: values.get("--output"),
    reportPath: values.get("--report"),
    terminalTableConfigPath:
      values.get("--terminal-table-config") ??
      DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
    maxDepth: integer("--max-depth", 3),
    maxTasks: integer("--max-tasks", DEFAULT_MAX_TASKS),
    maxEdges: integer("--max-edges", DEFAULT_MAX_EDGES),
    maxRounds: integer("--max-rounds", 6),
    maxDiscoveryTables: integer(
      "--max-discovery-tables",
      DEFAULT_MAX_DISCOVERY_TABLES,
    ),
    maxDiscoveredTasks: integer(
      "--max-discovered-tasks",
      DEFAULT_MAX_DISCOVERED_TASKS,
    ),
    force: flags.has("--force"),
    allowInputChanges: flags.has("--allow-input-changes"),
    trustExistingIndex: flags.has("--trust-existing-index"),
  };
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const result = runMultiHopAutofill(cli);
  process.stdout.write(
    `${JSON.stringify({
      taskId: cli.taskId,
      output: cli.outputPath ? resolve(cli.outputPath) : null,
      report: cli.reportPath ? resolve(cli.reportPath) : null,
      status: result.report.status,
      rounds: result.report.rounds,
      queriedTables: result.report.queriedTables.length,
      discoveredTaskIds: result.report.discoveredTaskIds.length,
      collectedTaskIds: result.report.collectedTaskIds.length,
      counts: result.artifact.counts,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  main();
