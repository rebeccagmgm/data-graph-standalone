import { TRACE_EDGE_LIMIT } from "./graph-limits";
import type { Anchor, GraphEdge, GraphNode, TraceResult } from "./types";

export interface TableTraceRoot {
  id: string;
  label: string;
  anchor: Anchor;
}

function ensureCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error("本次多起点查询已取消。");
}

function stableEdgeId(edge: GraphEdge): string {
  const id = edge.id ?? edge.key;
  if (!id) throw new Error("查询结果包含缺少稳定 ID 的关系，无法安全合并。");
  return id;
}

/** Add the selected task's direct write context to an upstream trace. */
export function mergeTableTraceContext(
  primary: TraceResult,
  context: TraceResult,
  edgeLimit = TRACE_EDGE_LIMIT,
): TraceResult {
  if (primary.version !== context.version)
    throw new Error("多起点查询期间图谱版本已变化，请重新查询。");
  const nodes = new Map([...primary.nodes, ...context.nodes].map((node) => [node.id, node]));
  const edges = new Map<string, GraphEdge>();
  for (const edge of [...primary.edges, ...context.edges]) edges.set(stableEdgeId(edge), edge);
  if (edges.size > edgeLimit)
    throw new Error(`补齐起点写入后超过 ${edgeLimit} 条关系上限，请缩小层数。`);
  const truncated = primary.truncated || context.truncated;
  const frontierNodeIds = [...new Set([...primary.frontierNodeIds, ...context.frontierNodeIds])];
  return {
    ...primary,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    terminalNodes: [...new Map([...primary.terminalNodes, ...context.terminalNodes]
      .map((node) => [node.nodeId, node])).values()],
    frontierNodeIds,
    taskLabels: { ...primary.taskLabels, ...context.taskLabels },
    taskClusters: { ...primary.taskClusters, ...context.taskClusters },
    taskTopics: { ...primary.taskTopics, ...context.taskTopics },
    taskTopicDescriptions: { ...primary.taskTopicDescriptions, ...context.taskTopicDescriptions },
    scopeWarnings: [...new Set([...(primary.scopeWarnings ?? []), ...(context.scopeWarnings ?? [])])],
    scheduleReferences: [...(primary.scheduleReferences ?? []), ...(context.scheduleReferences ?? [])],
    consumption: undefined,
    elapsedMs: primary.elapsedMs + context.elapsedMs,
    truncated,
    stoppedBy: primary.stoppedBy === "EDGE_LIMIT" || context.stoppedBy === "EDGE_LIMIT"
      ? "EDGE_LIMIT"
      : primary.stoppedBy,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "查询失败";
}

function isFatal(cause: unknown): boolean {
  const message = errorMessage(cause);
  return (
    cause instanceof DOMException && cause.name === "AbortError"
  ) || message.includes("取消") || message.includes("图谱版本");
}

/**
 * Combine independent table traces without reinterpreting graph semantics.
 * Nodes and edges are merged only by their published stable IDs.
 */
export async function collectMultiTableTrace(input: {
  roots: TableTraceRoot[];
  fetchTrace: (root: TableTraceRoot) => Promise<TraceResult>;
  isCurrent: () => boolean;
  edgeLimit?: number;
}): Promise<TraceResult> {
  if (!input.roots.length) throw new Error("请至少选择一个调度或表。");
  const edgeLimit = input.edgeLimit ?? TRACE_EDGE_LIMIT;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const terminalNodes = new Map<string, TraceResult["terminalNodes"][number]>();
  const frontierNodeIds = new Set<string>();
  const taskLabels: Record<string, string> = {};
  const taskClusters: Record<string, string> = {};
  const taskTopics: Record<string, string> = {};
  const taskTopicDescriptions: Record<string, string> = {};
  const scopeWarnings = new Set<string>();
  const scheduleReferences = new Map<string, NonNullable<TraceResult["scheduleReferences"]>[number]>();
  const failed: NonNullable<TraceResult["multiRootSummary"]>["failed"] = [];
  const truncatedRootIds: string[] = [];
  const unqueriedRootNodeIds: string[] = [];
  let template: TraceResult | undefined;
  let version: string | undefined;
  let completed = 0;
  let elapsedMs = 0;
  let combinedLimitReached = false;
  let depthBoundaryReached = false;

  for (let rootIndex = 0; rootIndex < input.roots.length; rootIndex += 1) {
    const root = input.roots[rootIndex]!;
    ensureCurrent(input.isCurrent);
    if (edges.size >= edgeLimit) {
      combinedLimitReached = true;
      unqueriedRootNodeIds.push(...input.roots.slice(rootIndex).map((item) => item.id));
      break;
    }
    try {
      const result = await input.fetchTrace(root);
      ensureCurrent(input.isCurrent);
      if (result.layer !== "table")
        throw new Error("多起点合图只接受表血缘查询结果。");
      if (version !== undefined && result.version !== version)
        throw new Error("多起点查询期间图谱版本已变化，请重新查询。");
      version = result.version;
      template ??= result;
      completed += 1;
      elapsedMs += result.elapsedMs;
      Object.assign(taskLabels, result.taskLabels ?? {});
      Object.assign(taskClusters, result.taskClusters ?? {});
      Object.assign(taskTopics, result.taskTopics ?? {});
      Object.assign(taskTopicDescriptions, result.taskTopicDescriptions ?? {});
      for (const warning of result.scopeWarnings ?? []) scopeWarnings.add(warning);
      for (const reference of result.scheduleReferences ?? []) {
        const key = `${reference.taskId}|${reference.direction}`;
        const previous = scheduleReferences.get(key);
        scheduleReferences.set(key, {
          ...reference,
          neighborTaskIds: [...new Set([...(previous?.neighborTaskIds ?? []), ...reference.neighborTaskIds])],
        });
      }

      const includedNodeIds = new Set<string>([root.id]);
      for (const edge of result.edges) {
        const id = stableEdgeId(edge);
        if (!edges.has(id) && edges.size >= edgeLimit) {
          combinedLimitReached = true;
          truncatedRootIds.push(root.id);
          break;
        }
        edges.set(id, edge);
        includedNodeIds.add(edge.from);
        includedNodeIds.add(edge.to);
      }
      for (const node of result.nodes) {
        if (!includedNodeIds.has(node.id)) continue;
        const previous = nodes.get(node.id);
        if (!previous) nodes.set(node.id, node);
        else {
          const depth = Math.min(
            Number(previous.depth ?? Number.MAX_SAFE_INTEGER),
            Number(node.depth ?? Number.MAX_SAFE_INTEGER),
          );
          nodes.set(node.id, {
            ...previous,
            ...node,
            ...(Number.isSafeInteger(depth) ? { depth } : {}),
          });
        }
      }
      for (const terminal of result.terminalNodes)
        if (includedNodeIds.has(terminal.nodeId)) terminalNodes.set(terminal.nodeId, terminal);
      for (const id of result.frontierNodeIds)
        if (includedNodeIds.has(id)) frontierNodeIds.add(id);
      if (result.truncated && !truncatedRootIds.includes(root.id)) truncatedRootIds.push(root.id);
      depthBoundaryReached ||= result.stoppedBy === "DEPTH_LIMIT";
      combinedLimitReached ||= result.stoppedBy === "EDGE_LIMIT";
    } catch (cause) {
      if (isFatal(cause)) throw cause;
      failed.push({ rootId: root.id, label: root.label, message: errorMessage(cause) });
    }
  }

  ensureCurrent(input.isCurrent);
  if (!template || !version) {
    const reason = failed.map((item) => `${item.label}：${item.message}`).join("；");
    throw new Error(`所有起点均查询失败${reason ? `：${reason}` : ""}`);
  }
  if (failed.length)
    scopeWarnings.add(`多起点查询仅完成 ${completed}/${input.roots.length} 个起点；当前画布不是完整结果。`);
  if (truncatedRootIds.length || unqueriedRootNodeIds.length)
    scopeWarnings.add("部分起点达到图规模或单次查询限制；当前画布不是完整结果。");

  const truncated = Boolean(
    failed.length || truncatedRootIds.length || unqueriedRootNodeIds.length,
  );
  return {
    ...template,
    version,
    edgeLimit,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    terminalNodes: [...terminalNodes.values()],
    frontierNodeIds: [...frontierNodeIds],
    taskLabels,
    taskClusters,
    taskTopics,
    taskTopicDescriptions,
    scopeWarnings: [...scopeWarnings],
    scheduleReferences: [...scheduleReferences.values()],
    consumption: undefined,
    elapsedMs,
    truncated,
    stoppedBy: combinedLimitReached
      ? "EDGE_LIMIT"
      : depthBoundaryReached
        ? "DEPTH_LIMIT"
        : null,
    unqueriedRootNodeIds,
    multiRootSummary: {
      requested: input.roots.length,
      completed,
      failed,
      truncatedRootIds,
    },
  };
}
