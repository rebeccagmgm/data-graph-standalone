export interface TaskLocalUpstreamExpansionRequest {
  readonly dataRoot: string;
  readonly anchorTaskIds: readonly string[];
  readonly writerCatalogPath?: string;
  /** @deprecated use writerCatalogPath */
  readonly producerIndexRoot?: string;
  readonly terminalTableConfigPath?: string;
  readonly maxDepth?: number;
  readonly maxTasksPerRoot?: number;
  readonly maxUnionTasks?: number;
  readonly maxRounds?: number;
}

export interface TaskLocalUpstreamExpansionResult {
  readonly anchorTaskIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly discoveredTaskIds: readonly string[];
  readonly status: "COMPLETE" | "PARTIAL";
  readonly issues: readonly string[];
  readonly counters: {
    readonly uniqueTasks: number;
    readonly taskReadsEvaluated: number;
    readonly writerCatalogRefreshes: number;
    readonly discoveryQueries: number;
    readonly collectionBatches: number;
  };
}

export type TaskLocalUpstreamExpander = (
  options: TaskLocalUpstreamExpansionRequest,
) => TaskLocalUpstreamExpansionResult;
