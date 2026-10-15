import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadTableProducerIndex,
  type TableProducerIndex,
} from "../../../../../reconcile/producer/producer-index.ts";
import {
  isLegacyProducerIndexPath,
} from "../../../../../query/table-writer-lookup.ts";
import {
  openWriterCatalog,
  writerTaskIdsByQualifiedName,
} from "../../../../../query/writer-catalog.ts";
import {
  defaultOpenCliRunner,
  type OpenCliRunner,
} from "../one-hop/reconcile-one-hop.ts";
import { queryProducerTaskIds } from "./reconcile-multi-hop-autofill.ts";
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
import { extractSqlReadTableNames } from "../../../../../input/shared/sql-table-references.ts";
import {
  validateTaskDocument,
  type TaskDocument,
} from "../../../../../input/shared/input-pack.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_MAX_DEPTH = 25;
const DEFAULT_MAX_TASKS = 100_000;
const DEFAULT_MAX_EDGES = 1_000_000;
const DEFAULT_MAX_TABLE_QUERIES = 10_000;

type JsonRecord = Record<string, unknown>;

interface LoadedTask {
  readonly path: string;
  readonly document: TaskDocument;
}

interface TaskLocationIndex {
  readonly byId: ReadonlyMap<string, readonly string[]>;
  readonly roots: readonly string[];
}

export interface MultiHopClosureAuditOptions {
  readonly dataRoot: string;
  readonly taskCategory: string;
  readonly rootTaskIds?: readonly string[];
  readonly rootShardIndex?: number;
  readonly rootShardCount?: number;
  readonly producerIndexPath: string;
  readonly scheduleEvidenceCacheRoot: string;
  readonly outputPath?: string;
  readonly terminalTableConfigPath: string;
  readonly maxDepth: number;
  readonly maxTasks: number;
  readonly maxEdges: number;
  readonly maxTableQueries: number;
  readonly cacheOnly: boolean;
}

interface RootSummary {
  readonly taskId: string;
  readonly closureTaskCount: number;
  readonly existingTaskPackCount: number;
  readonly missingTaskPackCount: number;
  readonly unresolvedTableCount: number;
  readonly maxDepth: number;
  readonly truncated: boolean;
}

export interface MultiHopClosureAuditReport {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "MULTI_HOP_CLOSURE_AUDIT";
  readonly generatedAt: string;
  readonly dataRoot: string;
  readonly taskCategory: string;
  readonly producerIndexPath: string;
  readonly producerIndexInputFingerprint: string;
  readonly scheduleEvidenceCacheRoot: string;
  readonly roots: readonly string[];
  readonly discoveredTaskIds: readonly string[];
  readonly missingTaskIds: readonly string[];
  readonly unresolvedTables: readonly string[];
  readonly summary: {
    readonly closureStatus: "COMPLETE" | "PARTIAL_CACHE" | "PARTIAL";
    readonly missingTaskPackCountIsFinal: boolean;
    readonly missingTaskPackCountLowerBound: number;
    readonly rootCount: number;
    readonly discoveredTaskCount: number;
    readonly existingTaskPackCount: number;
    readonly missingTaskPackCount: number;
    readonly rootsWithMissingPacks: number;
    readonly unresolvedTableCount: number;
    readonly scheduleCacheHits: number;
    readonly scheduleCacheMisses: number;
    readonly scheduleCacheInvalid: number;
    readonly scheduleFetched: number;
    readonly tableProducerCacheHits: number;
    readonly tableProducerQueries: number;
    readonly maxObservedDepth: number;
    readonly edgeCount: number;
  };
  readonly perRoot: readonly RootSummary[];
  readonly issues: readonly string[];
  readonly boundaries: {
    readonly closureSemantics: "SCHEDULE_AND_CONFIRMED_PRODUCER_CANDIDATES";
    readonly scheduleRelations: "CACHE_THEN_HORAE" | "CACHE_ONLY";
    readonly tableProducerDiscovery:
      "PRODUCER_INDEX_THEN_SZDATA" | "PRODUCER_INDEX_ONLY";
    readonly inputPackCollection: "NOT_PERFORMED";
    readonly runtimeExecution: "NOT_EVALUATED";
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-Hans", { numeric: true, sensitivity: "base" }),
  );
}

function progress(event: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(
    `[closure-audit] ${JSON.stringify({ event, ...details })}\n`,
  );
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new Error(`ARGUMENT_INVALID:${arg}`);
    if (arg === "--cache-only") {
      values.set(arg, "true");
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`ARGUMENT_VALUE_MISSING:${arg}`);
    values.set(arg, value);
    index += 1;
  }
  return values;
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)?.trim();
  if (!value)
    throw new Error(
      `${flag.slice(2).toUpperCase().replaceAll("-", "_")}_MISSING`,
    );
  return value;
}

function positive(
  values: Map<string, string>,
  flag: string,
  fallback: number,
): number {
  const raw = values.get(flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(
      `${flag.slice(2).toUpperCase().replaceAll("-", "_")}_INVALID`,
    );
  return value;
}

function indexTaskPacks(
  dataRoot: string,
  taskCategory: string,
  requestedRoots?: readonly string[],
  shardIndex?: number,
  shardCount?: number,
): TaskLocationIndex {
  const tasksRoot = join(resolve(dataRoot), "tasks");
  const byId = new Map<string, string[]>();
  const roots: string[] = [];
  if (!existsSync(tasksRoot)) return { byId, roots };
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "task.json") {
        const taskId = basename(directory);
        const paths = byId.get(taskId) ?? [];
        paths.push(path);
        byId.set(taskId, paths);
      }
    }
  };
  visit(tasksRoot);
  const root = join(tasksRoot, taskCategory);
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_TASK_ID.test(entry.name)) continue;
      if (existsSync(join(root, entry.name, "task.json")))
        roots.push(entry.name);
    }
  }
  let selected =
    requestedRoots && requestedRoots.length > 0
      ? roots.filter((taskId) => requestedRoots.includes(taskId))
      : roots;
  if (shardCount !== undefined) {
    if (
      !Number.isSafeInteger(shardCount) ||
      shardCount < 1 ||
      !Number.isSafeInteger(shardIndex) ||
      shardIndex! < 0 ||
      shardIndex! >= shardCount
    )
      throw new Error("ROOT_SHARD_INVALID");
    selected = selected.filter((_, index) => index % shardCount === shardIndex);
  }
  return { byId, roots: unique(selected) };
}

function loadTask(index: TaskLocationIndex, taskId: string): LoadedTask | null {
  const paths = index.byId.get(taskId) ?? [];
  if (paths.length !== 1) return null;
  const path = paths[0]!;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  validateTaskDocument(parsed);
  return { path, document: parsed as TaskDocument };
}

function taskReads(loaded: LoadedTask): string[] {
  const taskRoot = dirname(loaded.path);
  const names: string[] = [];
  for (const item of loaded.document.sqlFiles) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      continue;
    const relativePath = text((item as JsonRecord).path);
    if (!relativePath) continue;
    const path = resolve(taskRoot, relativePath);
    if (!path.startsWith(`${resolve(taskRoot)}${sep}`) || !existsSync(path))
      continue;
    names.push(...extractSqlReadTableNames(readFileSync(path, "utf8")));
  }
  return unique(names);
}

function producerMapFromIndex(index: TableProducerIndex): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of index.confirmedProducerEdges) {
    const key = edge.table.qualifiedName.toLocaleLowerCase("en-US");
    const taskIds = result.get(key) ?? [];
    taskIds.push(edge.taskId);
    result.set(key, unique(taskIds));
  }
  return result;
}

function producerMapFromPath(path: string): {
  readonly producersByTable: Map<string, string[]>;
  readonly fingerprint: string;
} {
  if (isLegacyProducerIndexPath(path)) {
    const index = loadTableProducerIndex(path);
    return {
      producersByTable: producerMapFromIndex(index),
      fingerprint: index.inputFingerprint,
    };
  }
  const handle = openWriterCatalog(path);
  return {
    producersByTable: writerTaskIdsByQualifiedName(handle),
    fingerprint: handle.path,
  };
}

function relationResponse(value: unknown): {
  readonly valid: boolean;
  readonly rows: JsonRecord[];
} {
  if (Array.isArray(value))
    return {
      valid: value.every(
        (item) =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      ),
      rows: value.filter(
        (item): item is JsonRecord =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      ),
    };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { valid: false, rows: [] };
  const record = value as JsonRecord;
  if (
    record.error !== undefined ||
    record.success === false ||
    ["fail", "failed", "failure", "error"].includes(
      String(record.status ?? "").toLowerCase(),
    )
  )
    return { valid: false, rows: [] };
  for (const key of ["records", "rows", "data", "results"]) {
    if (Array.isArray(record[key])) return relationResponse(record[key]);
  }
  return { valid: false, rows: [] };
}

function relationTaskIds(rows: readonly JsonRecord[]): string[] {
  return unique(
    rows
      .map((row) => text(row.task_id ?? row.taskId))
      .filter((taskId) => SAFE_TASK_ID.test(taskId)),
  );
}

function fetchRelation(
  taskId: string,
  options: MultiHopClosureAuditOptions,
  runner: OpenCliRunner | null,
  stats: { hits: number; misses: number; invalid: number; fetched: number },
  issues: string[],
): string[] {
  const cached = readHoraeRelationCache(
    taskId,
    options.scheduleEvidenceCacheRoot,
  );
  if (cached.status === "HIT") {
    stats.hits += 1;
    return relationTaskIds(cached.rows);
  }
  if (cached.status === "INVALID") stats.invalid += 1;
  else stats.misses += 1;
  if (!runner) return [];
  try {
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
    const parsed = relationResponse(response);
    if (!parsed.valid) {
      issues.push(`HORAE_RELATION_EMPTY_OR_INVALID:${taskId}`);
      return [];
    }
    try {
      writeHoraeRelationCache(
        taskId,
        new Date().toISOString(),
        parsed.rows,
        options.scheduleEvidenceCacheRoot,
      );
    } catch (error) {
      issues.push(
        `SCHEDULE_CACHE_WRITE_FAILED:${taskId}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    stats.fetched += 1;
    return relationTaskIds(parsed.rows);
  } catch (error) {
    issues.push(
      `HORAE_RELATION_FAILED:${taskId}:${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

function audit(
  options: MultiHopClosureAuditOptions,
  runner: OpenCliRunner | null,
): MultiHopClosureAuditReport {
  const index = indexTaskPacks(
    options.dataRoot,
    options.taskCategory,
    options.rootTaskIds,
    options.rootShardIndex,
    options.rootShardCount,
  );
  if (index.roots.length === 0)
    throw new Error(`ROOT_TASKS_NOT_FOUND:${options.taskCategory}`);
  const { producersByTable, fingerprint: producerIndexInputFingerprint } =
    producerMapFromPath(options.producerIndexPath);
  const terminalConfig: TerminalTableConfig = loadTerminalTableConfig(
    resolve(options.terminalTableConfigPath),
  );
  const adjacency = new Map<string, Set<string>>();
  const taskDepth = new Map<string, number>();
  const queueByDepth = Array.from(
    { length: options.maxDepth + 1 },
    () => [] as string[],
  );
  const queueCursor = Array.from({ length: options.maxDepth + 1 }, () => 0);
  const taskReadCache = new Map<string, string[]>();
  const loadedTaskCache = new Map<string, LoadedTask | null>();
  const producerCache = new Map<string, string[]>();
  const unresolvedTables = new Set<string>();
  const issues: string[] = [];
  const relationStats = { hits: 0, misses: 0, invalid: 0, fetched: 0 };
  let tableProducerQueries = 0;
  let tableProducerCacheHits = 0;
  let edgeCount = 0;
  let maxObservedDepth = 0;
  const add = (from: string, to: string): void => {
    if (from === to) return;
    const neighbors = adjacency.get(from) ?? new Set<string>();
    if (neighbors.has(to)) return;
    if (edgeCount >= options.maxEdges) throw new Error("MAX_EDGES_REACHED");
    neighbors.add(to);
    adjacency.set(from, neighbors);
    edgeCount += 1;
  };
  for (const root of index.roots) {
    taskDepth.set(root, 0);
    queueByDepth[0]!.push(root);
  }
  let processed = 0;
  for (let depth = 0; depth <= options.maxDepth; depth += 1) {
    const queue = queueByDepth[depth]!;
    while (queueCursor[depth]! < queue.length) {
      const taskId = queue[queueCursor[depth]!]!;
      queueCursor[depth] = queueCursor[depth]! + 1;
      if (depth !== taskDepth.get(taskId)) continue;
      maxObservedDepth = Math.max(maxObservedDepth, depth);
      if (depth >= options.maxDepth) continue;
      const current = { taskId, depth };
      if (taskDepth.size > options.maxTasks)
        throw new Error("MAX_TASKS_REACHED");
      processed += 1;
      if (processed % 25 === 0)
        progress("task_progress", {
          processed,
          discovered: taskDepth.size,
          edges: edgeCount,
        });

      for (const parentId of fetchRelation(
        current.taskId,
        options,
        runner,
        relationStats,
        issues,
      )) {
        add(current.taskId, parentId);
        const nextDepth = current.depth + 1;
        if (
          nextDepth <= options.maxDepth &&
          (taskDepth.get(parentId) === undefined ||
            nextDepth < taskDepth.get(parentId)!)
        ) {
          taskDepth.set(parentId, nextDepth);
          queueByDepth[nextDepth]!.push(parentId);
        }
      }

      let loaded = loadedTaskCache.get(current.taskId);
      if (loaded === undefined) {
        loaded = loadTask(index, current.taskId);
        loadedTaskCache.set(current.taskId, loaded);
      }
      if (!loaded) continue;
      let reads = taskReadCache.get(current.taskId);
      if (!reads) {
        reads = taskReads(loaded);
        taskReadCache.set(current.taskId, reads);
      }
      for (const qualifiedName of reads) {
        if (matchingTerminalRole(terminalConfig, qualifiedName)) continue;
        let producers = producerCache.get(qualifiedName);
        if (producers) {
          tableProducerCacheHits += 1;
        } else {
          producers =
            producersByTable.get(qualifiedName.toLocaleLowerCase("en-US")) ??
            [];
          if (producers.length === 0 && runner) {
            if (tableProducerQueries >= options.maxTableQueries)
              throw new Error("MAX_TABLE_QUERIES_REACHED");
            tableProducerQueries += 1;
            try {
              producers = queryProducerTaskIds(
                qualifiedName,
                runner,
                2,
                (ms) => {
                  if (ms > 0)
                    Atomics.wait(
                      new Int32Array(new SharedArrayBuffer(4)),
                      0,
                      0,
                      ms,
                    );
                },
              );
            } catch (error) {
              issues.push(
                `TABLE_PRODUCER_QUERY_FAILED:${qualifiedName}:${error instanceof Error ? error.message : String(error)}`,
              );
              producers = [];
            }
          }
          producerCache.set(qualifiedName, producers);
        }
        if (producers.length === 0) {
          unresolvedTables.add(qualifiedName);
          continue;
        }
        for (const producerId of producers) {
          add(current.taskId, producerId);
          const nextDepth = current.depth + 1;
          if (
            nextDepth <= options.maxDepth &&
            (taskDepth.get(producerId) === undefined ||
              nextDepth < taskDepth.get(producerId)!)
          ) {
            taskDepth.set(producerId, nextDepth);
            queueByDepth[nextDepth]!.push(producerId);
          }
        }
      }
    }
  }

  const discoveredTaskIds = unique([...taskDepth.keys()]);
  const hasTaskPack = (taskId: string): boolean => {
    let loaded = loadedTaskCache.get(taskId);
    if (loaded === undefined) {
      loaded = loadTask(index, taskId);
      loadedTaskCache.set(taskId, loaded);
    }
    return loaded !== null;
  };
  const missingTaskIds = discoveredTaskIds.filter(
    (taskId) => !hasTaskPack(taskId),
  );
  const blockingMissingTaskCount = missingTaskIds.filter(
    (taskId) =>
      (taskDepth.get(taskId) ?? Number.POSITIVE_INFINITY) < options.maxDepth,
  ).length;
  const perRoot: RootSummary[] = [];
  let rootsWithMissingPacks = 0;
  for (const root of index.roots) {
    const seen = new Set<string>([root]);
    const pending = [{ taskId: root, depth: 0 }];
    let maxDepth = 0;
    let truncated = false;
    const rootUnresolvedTables = new Set<string>();
    while (pending.length > 0) {
      const current = pending.shift()!;
      maxDepth = Math.max(maxDepth, current.depth);
      if (current.depth >= options.maxDepth) {
        truncated = true;
        continue;
      }
      if (hasTaskPack(current.taskId)) {
        const reads = taskReadCache.get(current.taskId) ?? [];
        for (const name of reads)
          if (unresolvedTables.has(name)) rootUnresolvedTables.add(name);
      }
      for (const next of adjacency.get(current.taskId) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          pending.push({ taskId: next, depth: current.depth + 1 });
        }
      }
    }
    const missingCount = [...seen].filter(
      (taskId) => !hasTaskPack(taskId),
    ).length;
    if (missingCount > 0) rootsWithMissingPacks += 1;
    perRoot.push({
      taskId: root,
      closureTaskCount: seen.size,
      existingTaskPackCount: seen.size - missingCount,
      missingTaskPackCount: missingCount,
      unresolvedTableCount: rootUnresolvedTables.size,
      maxDepth,
      truncated,
    });
  }
  const existingTaskPackCount =
    discoveredTaskIds.length - missingTaskIds.length;
  const closureStatus =
    options.cacheOnly && (relationStats.misses > 0 || relationStats.invalid > 0)
      ? "PARTIAL_CACHE"
      : issues.length > 0 ||
          unresolvedTables.size > 0 ||
          blockingMissingTaskCount > 0 ||
          perRoot.some((root) => root.truncated)
        ? "PARTIAL"
        : "COMPLETE";
  return {
    schemaVersion: "1.0.0",
    artifactType: "MULTI_HOP_CLOSURE_AUDIT",
    generatedAt: new Date().toISOString(),
    dataRoot: resolve(options.dataRoot),
    taskCategory: options.taskCategory,
    producerIndexPath: resolve(options.producerIndexPath),
    producerIndexInputFingerprint,
    scheduleEvidenceCacheRoot: resolve(options.scheduleEvidenceCacheRoot),
    roots: index.roots,
    discoveredTaskIds,
    missingTaskIds,
    unresolvedTables: unique([...unresolvedTables]),
    summary: {
      closureStatus,
      missingTaskPackCountIsFinal: closureStatus === "COMPLETE",
      missingTaskPackCountLowerBound: missingTaskIds.length,
      rootCount: index.roots.length,
      discoveredTaskCount: discoveredTaskIds.length,
      existingTaskPackCount,
      missingTaskPackCount: missingTaskIds.length,
      rootsWithMissingPacks,
      unresolvedTableCount: unresolvedTables.size,
      scheduleCacheHits: relationStats.hits,
      scheduleCacheMisses: relationStats.misses,
      scheduleCacheInvalid: relationStats.invalid,
      scheduleFetched: relationStats.fetched,
      tableProducerCacheHits,
      tableProducerQueries,
      maxObservedDepth,
      edgeCount,
    },
    perRoot,
    issues: unique(issues),
    boundaries: {
      closureSemantics: "SCHEDULE_AND_CONFIRMED_PRODUCER_CANDIDATES",
      scheduleRelations: options.cacheOnly ? "CACHE_ONLY" : "CACHE_THEN_HORAE",
      tableProducerDiscovery: runner
        ? "PRODUCER_INDEX_THEN_SZDATA"
        : "PRODUCER_INDEX_ONLY",
      inputPackCollection: "NOT_PERFORMED",
      runtimeExecution: "NOT_EVALUATED",
    },
  };
}

function writeReport(
  pathInput: string | undefined,
  report: MultiHopClosureAuditReport,
): void {
  if (!pathInput) return;
  const path = resolve(pathInput);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function runMultiHopClosureAudit(
  options: MultiHopClosureAuditOptions,
  runner: OpenCliRunner | null = options.cacheOnly
    ? null
    : (args) => defaultOpenCliRunner(args, 30_000),
): MultiHopClosureAuditReport {
  const report = audit(options, options.cacheOnly ? null : runner);
  writeReport(options.outputPath, report);
  progress("complete", {
    roots: report.summary.rootCount,
    discovered: report.summary.discoveredTaskCount,
    missing: report.summary.missingTaskPackCount,
    output: options.outputPath ? resolve(options.outputPath) : null,
  });
  return report;
}

function main(): void {
  const values = parseArgs(process.argv.slice(2));
  const rootTaskIdsFile = values.get("--root-task-ids-file");
  const rootTaskIds = rootTaskIdsFile
    ? readFileSync(resolve(rootTaskIdsFile), "utf8")
        .split(/[\s,;]+/)
        .map((value) => value.trim())
        .filter((value) => SAFE_TASK_ID.test(value))
    : undefined;
  const rootShardCountRaw = values.get("--root-shard-count");
  const rootShardIndexRaw = values.get("--root-shard-index");
  const rootShardCount =
    rootShardCountRaw === undefined ? undefined : Number(rootShardCountRaw);
  const rootShardIndex =
    rootShardIndexRaw === undefined ? undefined : Number(rootShardIndexRaw);
  const options: MultiHopClosureAuditOptions = {
    dataRoot: resolve(required(values, "--data-root")),
    taskCategory: values.get("--task-category")?.trim() || "sparkIndex",
    rootTaskIds,
    rootShardIndex,
    rootShardCount,
    producerIndexPath: resolve(required(values, "--producer-index")),
    scheduleEvidenceCacheRoot: resolve(
      values.get("--schedule-evidence-cache-root") ||
        DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
    ),
    outputPath: values.get("--output"),
    terminalTableConfigPath:
      values.get("--terminal-table-config") ||
      DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
    maxDepth: positive(values, "--max-depth", DEFAULT_MAX_DEPTH),
    maxTasks: positive(values, "--max-tasks", DEFAULT_MAX_TASKS),
    maxEdges: positive(values, "--max-edges", DEFAULT_MAX_EDGES),
    maxTableQueries: positive(
      values,
      "--max-table-queries",
      DEFAULT_MAX_TABLE_QUERIES,
    ),
    cacheOnly: values.get("--cache-only") === "true",
  };
  const report = runMultiHopClosureAudit(options);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  main();
