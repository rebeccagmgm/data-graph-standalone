import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { runCollector } from "../reconcile/consumer/one-hop/reconcile-one-hop-autofill.ts";
import {
	openWriterCatalog,
	resolveWriterCatalogPath,
	writersForQualifiedName,
	type WriterCatalogHandle,
} from "../../../query/writer-catalog.ts";
import { extractSqlReadTableNames } from "../../../input/shared/sql-table-references.ts";
import { validateTaskDocument, type TaskDocument } from "../../../input/shared/input-pack.ts";
import {
  matchingTerminalRole,
  type TerminalTableConfig,
} from "../../../reconcile/shared/terminal-table-config.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_MAX_DISCOVERED_TASKS = 5000;
const DEFAULT_MAX_DISCOVERY_TABLES = 1000;

export interface InputPackClosureOptions {
  readonly taskId: string;
  readonly dataRoot: string;
  /**
   * Writer catalog sqlite path (default: `<data-root>.writer-catalog/writer-catalog.sqlite`).
   */
  readonly writerCatalogPath?: string;
  /** @deprecated use writerCatalogPath */
  readonly producerIndexRoot?: string;
  readonly maxDepth: number;
  readonly maxTasks: number;
  readonly maxRounds: number;
  readonly maxDiscoveryTables?: number;
  readonly maxDiscoveredTasks?: number;
  readonly discoveryAttempts?: number;
  readonly discoveryMinIntervalMs?: number;
  /** Shared terminal-table rules prevent producer expansion for reference tables. */
  readonly terminalTableConfig?: TerminalTableConfig;
  /** Override table-level producer discovery in tests or offline runs. */
  readonly discoverTableProducerTaskIds?: (qualifiedName: string) => readonly string[];
  readonly force?: boolean;
  readonly collectTaskPacks?: (dataRoot: string, taskIds: readonly string[], force: boolean) => void;
}

export interface InputPackClosureResult {
  readonly taskIds: readonly string[];
  readonly discoveredTaskIds: readonly string[];
  readonly collectedTaskIds: readonly string[];
  readonly rounds: number;
  readonly status: "COMPLETE" | "PARTIAL";
  readonly issues: readonly string[];
  /** Writer catalog used for table-writer lookups. */
  readonly writerCatalogSnapshot?: {
    readonly catalogPath: string;
  };
}

export interface ProjectInputPackClosureOptions
  extends Omit<InputPackClosureOptions, "taskId" | "maxTasks"> {
  readonly rootTaskIds: readonly string[];
  readonly maxTasksPerRoot: number;
  readonly maxUnionTasks: number;
}

export interface ProjectInputPackClosureRoot {
  readonly rootTaskId: string;
  readonly taskIds: readonly string[];
  readonly discoveredTaskIds: readonly string[];
}

export interface ProjectInputPackClosureResult {
  readonly roots: readonly ProjectInputPackClosureRoot[];
  readonly taskIds: readonly string[];
  readonly discoveredTaskIds: readonly string[];
  readonly collectedTaskIds: readonly string[];
  readonly rounds: number;
  readonly status: "COMPLETE" | "PARTIAL";
  readonly issues: readonly string[];
  readonly counters: {
    readonly rootTaskOccurrences: number;
    readonly uniqueTasks: number;
    readonly taskReadsEvaluated: number;
    readonly writerCatalogRefreshes: number;
    readonly discoveryQueries: number;
    readonly collectionBatches: number;
  };
  readonly writerCatalogSnapshot: NonNullable<
    InputPackClosureResult["writerCatalogSnapshot"]
  >;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-Hans", { numeric: true }));
}

function indexTaskPackPaths(dataRoot: string): Map<string, string[]> {
  const root = join(resolve(dataRoot), "tasks");
  const index = new Map<string, string[]>();
  if (!existsSync(root)) return index;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "task.json") {
        const taskId = basename(directory);
        const matches = index.get(taskId) ?? [];
        matches.push(path);
        index.set(taskId, matches);
      }
    }
  };
  visit(root);
  return index;
}

function loadTask(dataRoot: string, taskId: string, index: ReadonlyMap<string, readonly string[]>): { path: string; document: TaskDocument } | null {
  const paths = index.get(taskId) ?? [];
  const path = paths.length === 1 ? paths[0]! : null;
  if (!path) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  validateTaskDocument(parsed);
  return { path, document: parsed as TaskDocument };
}

function taskReads(dataRoot: string, loaded: { path: string; document: TaskDocument }): string[] {
  const taskRoot = dirname(loaded.path);
  const names: string[] = [];
  for (const item of loaded.document.sqlFiles) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const relativePath = text(record.path);
    if (!relativePath) continue;
    const path = resolve(taskRoot, relativePath);
    if (!path.startsWith(`${resolve(taskRoot)}${sep}`)) continue;
    if (existsSync(path)) names.push(...extractSqlReadTableNames(readFileSync(path, "utf8")));
  }
  return unique(names);
}

function catalogWriterTaskIds(
  catalog: WriterCatalogHandle,
  qualifiedName: string,
): string[] {
  return unique(
    writersForQualifiedName(catalog, qualifiedName).map((hit) => hit.taskId),
  );
}

function requireLimits(options: InputPackClosureOptions): void {
  for (const [name, value] of [["maxDepth", options.maxDepth], ["maxTasks", options.maxTasks], ["maxRounds", options.maxRounds]] as const)
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name.toUpperCase()}_INVALID`);
  const maxDiscoveryTables = options.maxDiscoveryTables ?? DEFAULT_MAX_DISCOVERY_TABLES;
  if (!Number.isSafeInteger(maxDiscoveryTables) || maxDiscoveryTables < 1) throw new Error("MAX_DISCOVERY_TABLES_INVALID");
}

export function runInputPackClosure(options: InputPackClosureOptions): InputPackClosureResult {
  requireLimits(options);
  if (!SAFE_TASK_ID.test(options.taskId)) throw new Error("INVALID_TASK_ID");
  const dataRoot = resolve(options.dataRoot);
  if (!loadTask(dataRoot, options.taskId, indexTaskPackPaths(dataRoot))) throw new Error(`CURRENT_TASK_INPUT_PACK_MISSING:${options.taskId}`);
  const collect = options.collectTaskPacks ?? runCollector;
  const maxDiscoveredTasks = options.maxDiscoveredTasks ?? DEFAULT_MAX_DISCOVERED_TASKS;
  const maxDiscoveryTables = options.maxDiscoveryTables ?? DEFAULT_MAX_DISCOVERY_TABLES;
  const discover = options.discoverTableProducerTaskIds;
  const discovered = new Set<string>([options.taskId]);
  const discoveredDepth = new Map<string, number>([[options.taskId, 0]]);
  const collected = new Set<string>();
  const visited = new Set<string>();
  const issues: string[] = [];
  const producerCache = new Map<string, string[]>();
  const queriedTables = new Set<string>();
  let rounds = 0;
  let stabilized = false;
  const catalogPath = resolveWriterCatalogPath(dataRoot, options);
  const catalog = openWriterCatalog(catalogPath);

  while (rounds < options.maxRounds) {
    rounds += 1;
    const taskPathIndex = indexTaskPackPaths(dataRoot);
    const queue: Array<{ taskId: string; depth: number }> = [...discoveredDepth.entries()]
      .filter(([taskId]) => !visited.has(taskId))
      .map(([taskId, depth]) => ({ taskId, depth }));
    const pending = new Set<string>();
    while (queue.length > 0) {
      queue.sort((left, right) => left.depth - right.depth || left.taskId.localeCompare(right.taskId, "zh-Hans", { numeric: true }));
      const current = queue.shift()!;
      if (visited.has(current.taskId) || current.depth >= options.maxDepth) continue;
      const loaded = loadTask(dataRoot, current.taskId, taskPathIndex);
      if (!loaded) {
        pending.add(current.taskId);
        continue;
      }
      visited.add(current.taskId);
      if (visited.size > options.maxTasks) throw new Error("MAX_TASKS_REACHED");

      for (const qualifiedName of taskReads(dataRoot, loaded)) {
        if (
          options.terminalTableConfig &&
          matchingTerminalRole(options.terminalTableConfig, qualifiedName)
        )
          continue;
        let producerIds = producerCache.get(qualifiedName);
        if (!producerIds) {
          producerIds = catalogWriterTaskIds(catalog, qualifiedName);
          if (discover && producerIds.length === 0 && !queriedTables.has(qualifiedName)) {
            if (queriedTables.size >= maxDiscoveryTables) throw new Error("MAX_DISCOVERY_TABLES_REACHED");
            queriedTables.add(qualifiedName);
            try {
              producerIds = [...discover(qualifiedName)];
            } catch (error) {
              issues.push(`TABLE_PRODUCER_DISCOVERY_FAILED:${qualifiedName}:${error instanceof Error ? error.message : String(error)}`);
              producerIds = [];
            }
          }
          producerCache.set(qualifiedName, producerIds);
        }
        for (const producerId of producerIds) {
          discovered.add(producerId);
          const producerDepth = current.depth + 1;
          if (!discoveredDepth.has(producerId) || producerDepth < discoveredDepth.get(producerId)!) discoveredDepth.set(producerId, producerDepth);
          if (!loadTask(dataRoot, producerId, taskPathIndex)) pending.add(producerId);
          else if (producerDepth < options.maxDepth) queue.push({ taskId: producerId, depth: producerDepth });
        }
      }
    }

    const collectIds = unique([...pending]);
    if (collectIds.length === 0) {
      stabilized = true;
      break;
    }
    if (new Set([...discovered, ...collectIds]).size > maxDiscoveredTasks) throw new Error("MAX_DISCOVERED_TASKS_REACHED");
    try {
      collect(dataRoot, collectIds, options.force === true);
    } catch (error) {
      issues.push(`INPUT_PACK_COLLECTION_FAILED:${error instanceof Error ? error.message : String(error)}`);
    }
    const refreshedTaskPathIndex = indexTaskPackPaths(dataRoot);
    let collectedThisRound = false;
    for (const taskId of collectIds) {
      if (loadTask(dataRoot, taskId, refreshedTaskPathIndex)) {
        collected.add(taskId);
        collectedThisRound = true;
      }
    }
    if (collectedThisRound) {
      producerCache.clear();
    }
  }
  if (!stabilized && rounds >= options.maxRounds) issues.push("MAX_AUTOFILL_ROUNDS_REACHED");
  const finalTaskPathIndex = indexTaskPackPaths(dataRoot);
  const taskIds = unique([...visited, options.taskId].filter((taskId) => loadTask(dataRoot, taskId, finalTaskPathIndex) !== null));
  return {
    taskIds,
    discoveredTaskIds: unique([...discovered]),
    collectedTaskIds: unique([...collected]),
    rounds,
    status: issues.length === 0 ? "COMPLETE" : "PARTIAL",
    issues: unique(issues),
    writerCatalogSnapshot: {
      catalogPath,
    },
  };
}

/**
 * Builds all root closures against one writer catalog snapshot.
 * Task SQL reads and table discovery are cached across roots; root membership
 * and depth remain independent.
 */
export function runProjectInputPackClosure(
  options: ProjectInputPackClosureOptions,
): ProjectInputPackClosureResult {
  requireProjectLimits(options);
  const rootTaskIds = unique(
    options.rootTaskIds.map((taskId) => {
      if (!SAFE_TASK_ID.test(taskId)) throw new Error("INVALID_TASK_ID");
      return taskId;
    }),
  );
  if (rootTaskIds.length === 0 || rootTaskIds.length !== options.rootTaskIds.length)
    throw new Error("PROJECT_ROOT_TASK_IDS_INVALID");
  const dataRoot = resolve(options.dataRoot);
  const initialIndex = indexTaskPackPaths(dataRoot);
  for (const rootTaskId of rootTaskIds)
    if (!loadTask(dataRoot, rootTaskId, initialIndex))
      throw new Error(`CURRENT_TASK_INPUT_PACK_MISSING:${rootTaskId}`);

  const collect = options.collectTaskPacks ?? runCollector;
  const maxDiscoveryTables = options.maxDiscoveryTables ?? DEFAULT_MAX_DISCOVERY_TABLES;
  const discover = options.discoverTableProducerTaskIds;
  const discoveredDepthByRoot = new Map(
    rootTaskIds.map((rootTaskId) => [
      rootTaskId,
      new Map<string, number>([[rootTaskId, 0]]),
    ]),
  );
  const visitedByRoot = new Map(
    rootTaskIds.map((rootTaskId) => [rootTaskId, new Set<string>()]),
  );
  const collected = new Set<string>();
  const issues: string[] = [];
  const producerCache = new Map<string, string[]>();
  const queriedTables = new Set<string>();
  const taskReadCache = new Map<string, string[]>();
  let rounds = 0;
  let stabilized = false;
  const catalogPath = resolveWriterCatalogPath(dataRoot, options);
  const catalog = openWriterCatalog(catalogPath);
  let writerCatalogRefreshes = 1;
  let collectionBatches = 0;

  while (rounds < options.maxRounds) {
    rounds += 1;
    const taskPathIndex = indexTaskPackPaths(dataRoot);
    const pending = new Set<string>();

    for (const rootTaskId of rootTaskIds) {
      const discoveredDepth = discoveredDepthByRoot.get(rootTaskId)!;
      const visited = visitedByRoot.get(rootTaskId)!;
      const queue = [...discoveredDepth.entries()]
        .filter(([taskId]) => !visited.has(taskId))
        .map(([taskId, depth]) => ({ taskId, depth }));
      while (queue.length > 0) {
        queue.sort(
          (left, right) =>
            left.depth - right.depth ||
            left.taskId.localeCompare(right.taskId, "zh-Hans", {
              numeric: true,
            }),
        );
        const current = queue.shift()!;
        if (visited.has(current.taskId) || current.depth >= options.maxDepth)
          continue;
        const loaded = loadTask(dataRoot, current.taskId, taskPathIndex);
        if (!loaded) {
          pending.add(current.taskId);
          continue;
        }
        visited.add(current.taskId);
        if (visited.size > options.maxTasksPerRoot)
          throw new Error(`MAX_TASKS_REACHED:${rootTaskId}`);
        let reads = taskReadCache.get(current.taskId);
        if (!reads) {
          reads = taskReads(dataRoot, loaded);
          taskReadCache.set(current.taskId, reads);
        }
        for (const qualifiedName of reads) {
          if (
            options.terminalTableConfig &&
            matchingTerminalRole(options.terminalTableConfig, qualifiedName)
          )
            continue;
          let producerIds = producerCache.get(qualifiedName);
          if (!producerIds) {
            producerIds = catalogWriterTaskIds(catalog, qualifiedName);
            if (
              discover &&
              producerIds.length === 0 &&
              !queriedTables.has(qualifiedName)
            ) {
              if (queriedTables.size >= maxDiscoveryTables)
                throw new Error("MAX_DISCOVERY_TABLES_REACHED");
              queriedTables.add(qualifiedName);
              try {
                producerIds = [...discover(qualifiedName)];
              } catch (error) {
                issues.push(
                  `TABLE_PRODUCER_DISCOVERY_FAILED:${qualifiedName}:${error instanceof Error ? error.message : String(error)}`,
                );
                producerIds = [];
              }
            }
            producerIds = unique(producerIds);
            producerCache.set(qualifiedName, producerIds);
          }
          for (const producerId of producerIds) {
            const producerDepth = current.depth + 1;
            if (
              !discoveredDepth.has(producerId) ||
              producerDepth < discoveredDepth.get(producerId)!
            )
              discoveredDepth.set(producerId, producerDepth);
            if (!loadTask(dataRoot, producerId, taskPathIndex))
              pending.add(producerId);
            else if (producerDepth < options.maxDepth)
              queue.push({ taskId: producerId, depth: producerDepth });
          }
        }
      }
    }

    const discoveredUnion = new Set(
      [...discoveredDepthByRoot.values()].flatMap((depths) => [
        ...depths.keys(),
      ]),
    );
    if (discoveredUnion.size > options.maxUnionTasks)
      throw new Error("MAX_UNION_TASKS_REACHED");
    const collectIds = unique([...pending]);
    if (collectIds.length === 0) {
      stabilized = true;
      break;
    }
    try {
      collectionBatches += 1;
      collect(dataRoot, collectIds, options.force === true);
    } catch (error) {
      issues.push(
        `INPUT_PACK_COLLECTION_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const refreshedIndex = indexTaskPackPaths(dataRoot);
    let collectedThisRound = false;
    for (const taskId of collectIds) {
      if (loadTask(dataRoot, taskId, refreshedIndex)) {
        collected.add(taskId);
        collectedThisRound = true;
      }
    }
    if (collectedThisRound) {
      writerCatalogRefreshes += 1;
      producerCache.clear();
    }
  }

  if (!stabilized && rounds >= options.maxRounds)
    issues.push("MAX_AUTOFILL_ROUNDS_REACHED");
  const finalTaskPathIndex = indexTaskPackPaths(dataRoot);
  const roots = rootTaskIds.map((rootTaskId) => {
    const depths = discoveredDepthByRoot.get(rootTaskId)!;
    const visited = visitedByRoot.get(rootTaskId)!;
    return {
      rootTaskId,
      taskIds: unique(
        [...visited, rootTaskId].filter(
          (taskId) => loadTask(dataRoot, taskId, finalTaskPathIndex) !== null,
        ),
      ),
      discoveredTaskIds: unique([...depths.keys()]),
    };
  });
  const taskIds = unique(roots.flatMap((root) => root.taskIds));
  if (taskIds.length > options.maxUnionTasks)
    throw new Error("MAX_UNION_TASKS_REACHED");
  return {
    roots,
    taskIds,
    discoveredTaskIds: unique(
      roots.flatMap((root) => root.discoveredTaskIds),
    ),
    collectedTaskIds: unique([...collected]),
    rounds,
    status: issues.length === 0 ? "COMPLETE" : "PARTIAL",
    issues: unique(issues),
    counters: {
      rootTaskOccurrences: roots.reduce(
        (sum, root) => sum + root.taskIds.length,
        0,
      ),
      uniqueTasks: taskIds.length,
      taskReadsEvaluated: taskReadCache.size,
      writerCatalogRefreshes,
      discoveryQueries: queriedTables.size,
      collectionBatches,
    },
    writerCatalogSnapshot: {
      catalogPath,
    },
  };
}

function requireProjectLimits(options: ProjectInputPackClosureOptions): void {
  for (const [name, value] of [
    ["maxDepth", options.maxDepth],
    ["maxTasksPerRoot", options.maxTasksPerRoot],
    ["maxUnionTasks", options.maxUnionTasks],
    ["maxRounds", options.maxRounds],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${name.toUpperCase()}_INVALID`);
  const maxDiscoveryTables =
    options.maxDiscoveryTables ?? DEFAULT_MAX_DISCOVERY_TABLES;
  if (!Number.isSafeInteger(maxDiscoveryTables) || maxDiscoveryTables < 1)
    throw new Error("MAX_DISCOVERY_TABLES_INVALID");
}
