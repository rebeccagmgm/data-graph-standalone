import { resolve } from "node:path";

import {
  DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  loadTerminalTableConfig,
} from "../../../../reconcile/shared/terminal-table-config.ts";
import { defaultWriterCatalogPath } from "../../../../query/writer-catalog.ts";
import { runProjectInputPackClosure } from "../../pipeline/input-pack-closure.ts";
import type {
  TaskLocalUpstreamExpansionRequest,
  TaskLocalUpstreamExpansionResult,
} from "../../../../project-graph/task-local/upstream-expansion-port.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type AnchorUpstreamExpansionOptions = TaskLocalUpstreamExpansionRequest;
export type AnchorUpstreamExpansionResult = TaskLocalUpstreamExpansionResult;

function normalizeAnchorTaskIds(anchorTaskIds: readonly string[]): string[] {
  const normalized = [...new Set(
    anchorTaskIds
      .map((value) => value.trim())
      .filter((value) => SAFE_TASK_ID.test(value)),
  )].sort((left, right) => left.localeCompare(right, "en-US", { numeric: true }));
  if (normalized.length === 0) throw new Error("ANCHOR_TASK_IDS_EMPTY");
  if (normalized.length !== anchorTaskIds.length) throw new Error("ANCHOR_TASK_IDS_INVALID");
  return normalized;
}

/**
 * From anchor task ids, walk SQL READ tables through confirmed writer-catalog
 * edges until terminal tables or depth/union limits. Does not collect Input
 * Packs or call live discovery APIs — only tasks with packs already in dataRoot
 * are returned.
 */
export function expandAnchorUpstreamTaskIds(
  options: AnchorUpstreamExpansionOptions,
): AnchorUpstreamExpansionResult {
  const anchorTaskIds = normalizeAnchorTaskIds(options.anchorTaskIds);
  const dataRoot = resolve(options.dataRoot);
  const writerCatalogPath = resolve(
    options.writerCatalogPath
    ?? (options.producerIndexRoot ? defaultWriterCatalogPath(dataRoot) : defaultWriterCatalogPath(dataRoot)),
  );
  const terminalTableConfigPath = resolve(
    options.terminalTableConfigPath ?? DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  );
  const closure = runProjectInputPackClosure({
    rootTaskIds: anchorTaskIds,
    dataRoot,
    writerCatalogPath,
    producerIndexRoot: options.producerIndexRoot,
    terminalTableConfig: loadTerminalTableConfig(terminalTableConfigPath),
    maxDepth: options.maxDepth ?? 25,
    maxTasksPerRoot: options.maxTasksPerRoot ?? 500,
    maxUnionTasks: options.maxUnionTasks ?? 2000,
    maxRounds: options.maxRounds ?? 30,
    collectTaskPacks: () => {},
  });
  return {
    anchorTaskIds,
    taskIds: closure.taskIds,
    discoveredTaskIds: closure.discoveredTaskIds,
    status: closure.status,
    issues: closure.issues,
    counters: {
      uniqueTasks: closure.counters.uniqueTasks,
      taskReadsEvaluated: closure.counters.taskReadsEvaluated,
      writerCatalogRefreshes: closure.counters.writerCatalogRefreshes,
      discoveryQueries: closure.counters.discoveryQueries,
      collectionBatches: closure.counters.collectionBatches,
    },
  };
}
