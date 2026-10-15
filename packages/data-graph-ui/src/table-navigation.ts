import { parseTaskTableId } from "../../data-graph/src/asset-graph/task-table-context";
import type { api } from "./api";
import { scopeExpansionNodes } from "./analysis-scope/table-display";
import { appendTableBranch } from "./branch-expansion";
import { TRACE_EDGE_LIMIT } from "./graph-limits";
import type { Anchor, Direction, GraphNode, TraceResult } from "./types";

type TableQuery = Parameters<typeof api.trace>[0];
type FetchTrace = (query: TableQuery) => Promise<TraceResult>;
function ensureCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error("本次表查询已取消。");
}

/** Explicit table analysis starts over at the exact physical identity. */
export function physicalTableAnchor(node: GraphNode): Anchor {
  const invalid = () => new Error("此表的物理身份未确认或存在冲突，无法重新开始表分析。");
  if (node.kind !== "PHYSICAL_DATASET" ||
      (node.detail?.identityStatus && node.detail.identityStatus !== "CONFIRMED")) throw invalid();
  let context;
  try { context = parseTaskTableId(node.id); } catch { throw invalid(); }
  const detailContext = node.detail?.taskTableContext as { datasetId?: string } | undefined;
  const identities = [
    node.id.startsWith("dataset:") ? node.id : undefined,
    node.physicalNodeId,
    detailContext?.datasetId,
    context?.datasetId,
  ].filter((id): id is string => typeof id === "string");
  const unique = [...new Set(identities)];
  if (unique.length !== 1 || !/^dataset:[A-Za-z0-9_-]+$/.test(unique[0]!)) throw invalid();
  return { nodeId: unique[0], table: node.table, label: node.table ?? node.label ?? unique[0]! };
}

/** Scoped roots and legacy saved views retain their original task contexts. */
export function tableCardAnchor(node: GraphNode): Anchor {
  const contexts = node.tableContexts?.filter(n => n.detail?.taskTableContext);
  return {
    nodeId: node.id, table: node.table, label: node.label ?? node.table ?? node.id,
    ...(contexts?.length && node.id.startsWith("dataset:") && !node.detail?.taskTableContext
      ? { tableContextIds: [...new Set(contexts.map(n => n.id))] } : {}),
  };
}

function anchorRoots(anchor: Anchor, direction: Direction): string[] | undefined {
  if (anchor.tableContextIds === undefined) return undefined;
  const ids = anchor.tableContextIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > TRACE_EDGE_LIMIT)
    throw new Error("保存的表上下文无效，请从原任务重新展开。");
  const contexts = [...new Set(ids)].map(id => {
    let context;
    try { context = typeof id === "string" ? parseTaskTableId(id) : undefined; }
    catch { /* Fail closed below, never substitute a global table query. */ }
    if (!context || context.datasetId !== anchor.nodeId)
      throw new Error("保存的表上下文与物理身份不符，请从原任务重新展开。");
    return { id, ...context };
  });
  const crossing = contexts.filter(c => c.role === (direction === "up" ? "READ" : "WRITE"));
  return (crossing.length ? crossing : contexts).map(c => c.id);
}

/** Merge query results only after every task context succeeds; keep raw IDs and records. */
export async function traceTableAnchor(query: TableQuery, fetchTrace: FetchTrace, isCurrent: () => boolean): Promise<TraceResult> {
  ensureCurrent(isCurrent);
  const roots = anchorRoots(query, query.direction);
  // An explicit partition selection has its own published evidence traversal.
  if (!roots || query.partitionSelection) return fetchTrace(query);
  let merged: TraceResult | undefined;
  for (const nodeId of roots) {
    ensureCurrent(isCurrent);
    const result = await fetchTrace({ ...query, nodeId, table: undefined, tableContextIds: undefined });
    ensureCurrent(isCurrent);
    if (!result.nodes.some(n => n.id === nodeId))
      throw new Error("原任务的表上下文已不存在，请重新打开起点。");
    if (!merged) { merged = result; continue; }
    if (merged.version !== result.version) throw new Error("图谱版本已变化，请重新展开当前图。");
    const nodes = new Map([...merged.nodes, ...result.nodes].map(n => [n.id, n]));
    const edges = new Map([...merged.edges, ...result.edges].map(e => [e.id ?? e.key ?? JSON.stringify(e), e]));
    if (edges.size > TRACE_EDGE_LIMIT) throw new Error(`合并后超过 ${TRACE_EDGE_LIMIT} 条关系上限，已保留原图；请缩小层数。`);
    const truncated: boolean = merged.truncated || result.truncated;
    const frontierNodeIds: string[] = [...new Set([...merged.frontierNodeIds, ...result.frontierNodeIds])];
    merged = {
      ...merged, nodes: [...nodes.values()], edges: [...edges.values()], consumption: undefined,
      truncated, stoppedBy: truncated ? "EDGE_LIMIT" : frontierNodeIds.length ? "DEPTH_LIMIT" : null,
      frontierNodeIds,
      terminalNodes: [...new Map([...merged.terminalNodes, ...result.terminalNodes].map(n => [n.nodeId, n])).values()],
      scopeWarnings: [...new Set([...(merged.scopeWarnings ?? []), ...(result.scopeWarnings ?? [])])],
      taskLabels: { ...merged.taskLabels, ...result.taskLabels },
      taskClusters: { ...merged.taskClusters, ...result.taskClusters },
      taskTopics: { ...merged.taskTopics, ...result.taskTopics },
      taskTopicDescriptions: { ...merged.taskTopicDescriptions, ...result.taskTopicDescriptions },
      elapsedMs: merged.elapsedMs + result.elapsedMs,
    };
  }
  return merged!;
}

export async function expandTableCard(input: {
  base: TraceResult; nodeId: string; direction: Direction; clusters: string[];
  includeCandidates: boolean; fetchTrace: FetchTrace; isCurrent: () => boolean;
}) {
  const { base, direction, clusters } = input;
  const roots = scopeExpansionNodes(base, input.nodeId, direction);
  if (!roots.length) throw new Error("当前表上下文已不存在，请重新打开起点。");
  let trace = base, omittedTasks = 0;
  for (const node of roots) {
    ensureCurrent(input.isCurrent);
    const branch = await input.fetchTrace({
      ...(node.kind === "TASK" ? { taskId: node.taskId ?? node.id.replace(/^task:/, "") } : { nodeId: node.id }),
      label: node.table ?? node.label ?? node.id,
      layer: "table", direction, depth: 1, includeCandidates: input.includeCandidates, clusters,
      partitionSelection: base.partitionSelection,
      scopeFocus: base.partitionSelection ? node.id : undefined,
      scopeDepth: base.partitionSelection ? base.depthLimit : undefined,
      scopeDirection: base.partitionSelection ? base.direction : undefined,
    });
    ensureCurrent(input.isCurrent);
    const result = appendTableBranch(trace, branch, node, direction, clusters);
    trace = { ...result.trace, scopeWarnings: [...new Set([...(trace.scopeWarnings ?? []), ...(branch.scopeWarnings ?? [])])] };
    omittedTasks += result.omittedTasks;
  }
  return { trace, addedNodes: trace.nodes.length - base.nodes.length, addedEdges: trace.edges.length - base.edges.length, omittedTasks };
}
