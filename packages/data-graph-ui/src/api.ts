import { TRACE_EDGE_LIMIT } from "./graph-limits";
import { createOverviewRequest } from "./overview-request";
import { recordPerformance } from "./performance-log";
import type {
  Anchor,
  Direction,
  GraphLayer,
  GraphNode,
  TaskDetail,
  TraceResult,
  OverviewResult,
  RegionResult,
  TaskFieldExplanation,
} from "./types";
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function get<T>(
  path: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== "") q.set(k, String(v));
  const url = `/api/${path}?${q}`;
  const started = performance.now();
  let response: Response;
  try { response = signal ? await fetch(url, {signal}) : await fetch(url); }
  catch (error) { recordPerformance({kind:"api", name:path, durationMs:performance.now() - started, status:0}); throw error; }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError("服务返回了无法读取的响应", response.status);
  } finally {
    const graph = body && typeof body === "object" ? body as {nodes?:unknown[]; edges?:unknown[]} : undefined;
    const timing = response.headers?.get("Server-Timing")?.match(/graph;dur=([\d.]+)/)?.[1];
    recordPerformance({kind:"api", name:path, durationMs:performance.now() - started,
      status:response.status, serverMs:timing ? Number(timing) : undefined,
      requestId:response.headers?.get("X-Graph-Request-Id") ?? undefined,
      nodes:Array.isArray(graph?.nodes) ? graph.nodes.length : undefined, edges:Array.isArray(graph?.edges) ? graph.edges.length : undefined});
  }
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? String(body.error)
        : "查询失败";
    const partitionErrors: Record<string, string> = {
      TASK_TABLE_CONTEXT_INVALID: "任务链路的表标识无效，请从原任务重新展开。",
      TASK_TABLE_CONTEXT_MISSING: "这张表与原任务的读写关系已不存在，请从原任务重新展开。",
      TASK_TABLE_ANCHOR_MISSING: "当前发布图未收录这个任务或表。",
      TASK_SCHEDULE_NEIGHBOR_LIMIT: "该任务的调度邻居超过查询上限，未返回不完整的链路。",
      PARTITION_VERSION_CHANGED: "图谱已换版，请重新打开此表并选择分区。",
      PARTITION_SELECTION_INVALID: "保存的分区范围已失效，请重新选择分区。",
      PARTITION_FOCUS_OUTSIDE_SCOPE: "当前节点不在已选分区的查询范围内，请先从原起点继续展开。",
      FIELD_OUTSIDE_PARTITION_SELECTION: "所选字段不属于当前分区范围，请重新选择字段。",
      PARTITION_WRITER_LIMIT: "该表写入范围超过查询上限，未返回不完整的分区选项。",
    };
    throw new ApiError(partitionErrors[message] ?? message, response.status);
  }
  return body as T;
}
export const api = {
  partitions: (nodeId: string) => get<import("../../data-graph/src/asset-graph/partition-selection").PartitionCatalog & {taskClusters: Record<string, string>}>("partitions", {nodeId}),
  explain: (taskId: string, input: { writeId: string; column: string; publicationVersion: string }) =>
    get<TaskFieldExplanation>("explain", {
      taskId,
      ...input,
      maxDepth: 32,
      maxNodes: 500,
      maxEdges: 1000,
    }),
  status: () => get<Record<string, unknown>>("status"),
  overview: createOverviewRequest((hiddenTables: string[] = [], clusters: string[] = [], signal: AbortSignal) => get<OverviewResult>("overview", { hiddenTables: JSON.stringify(hiddenTables), clusters: JSON.stringify(clusters) }, signal)),
  region: (schema: string, offset = 0, limit = 50, hiddenTables: string[] = [], clusters: string[] = []) =>
    get<RegionResult>("regions", { schema, offset, limit, hiddenTables: JSON.stringify(hiddenTables), clusters: JSON.stringify(clusters) }),
  search: (q: string, offset = 0, limit = 31, clusters: string[] = [], signal?: AbortSignal) =>
    get<GraphNode[]>("search", { q, offset, limit, clusters: JSON.stringify(clusters) }, signal),
  fields: (a: Anchor, offset = 0, limit = 101) =>
    get<GraphNode[]>(
      "fields",
      a.nodeId
        ? { nodeId: a.nodeId, offset, limit }
        : a.taskId
          ? { taskId: a.taskId, offset, limit }
          : { table: a.table, offset, limit },
    ),
  trace: (
    i: Anchor & {
      layer: GraphLayer;
      direction: Direction;
      depth: number;
      includeCandidates: boolean;
      clusters?: string[];
      scopeFocus?: string;
      scopeDepth?: number;
      scopeDirection?: Direction;
    },
    signal?: AbortSignal,
  ) =>
    get<TraceResult>("trace", {
      taskId: i.taskId,
      table: i.table,
      nodeId: i.nodeId,
      column: i.column,
      writeId: i.writeId,
      partitionSelection: i.partitionSelection ? JSON.stringify(i.partitionSelection) : undefined,
      clusters: JSON.stringify(i.clusters ?? []),
      scopeFocus: i.scopeFocus,
      scopeDepth: i.scopeDepth,
      scopeDirection: i.scopeDirection,
      layer: i.layer,
      direction: i.direction,
      depth: i.depth,
      depthUnit: "table-hop",
      limit: TRACE_EDGE_LIMIT,
      candidates: i.includeCandidates ? 1 : 0,
    }, signal),
  task: (
    taskId: string,
    i: { column?: string; writeId?: string; sql?: boolean; ddl?: boolean } = {},
  ) =>
    get<TaskDetail>("task", {
      taskId,
      column: i.column,
      writeId: i.writeId,
      sql: i.sql ? 1 : undefined,
      ddl: i.ddl ? 1 : undefined,
    }),
};
