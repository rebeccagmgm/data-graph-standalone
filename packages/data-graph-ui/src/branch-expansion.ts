import type { Direction, GraphNode, TraceResult } from "./types";
import { restrictTraceClusters } from "./trace-clusters";
import { TRACE_EDGE_LIMIT } from "./graph-limits";

const edgeKey = (edge: TraceResult["edges"][number]) => edge.id ?? edge.key ?? JSON.stringify([edge.from, edge.to, edge.kind, edge.status]);

/** Append one returned table hop without changing existing node identities/depths. */
export function appendTableBranch(base: TraceResult, branch: TraceResult, focus: GraphNode, direction: Direction, clusters: string[]) {
  if (base.version !== branch.version) throw new Error("图谱版本已变化，请重新展开当前图。");
  if (base.layer !== "table" || branch.layer !== "table") throw new Error("分支展开仅适用于表血缘。");
  const filtered = restrictTraceClusters(branch, clusters);
  // Task-centered API results may contain both inputs and outputs. Follow only
  // the requested side, and never traverse through a filtered cluster task.
  const reached = new Set([focus.id]);
  const pending = [focus.id];
  while (pending.length) {
    const id = pending.pop()!;
    for (const edge of filtered.trace.edges) {
      if ((direction === "up" ? edge.to : edge.from) !== id) continue;
      const next = direction === "up" ? edge.from : edge.to;
      if (!reached.has(next)) { reached.add(next); pending.push(next); }
    }
  }
  const branchNodes = filtered.trace.nodes.filter(node => reached.has(node.id));
  const branchEdges = filtered.trace.edges.filter(edge => reached.has(edge.from) && reached.has(edge.to));
  const nodes = new Map(base.nodes.map(node => [node.id, node]));
  const sign = base.direction === direction ? 1 : -1;
  for (const node of branchNodes) if (!nodes.has(node.id)) nodes.set(node.id, {
    ...node, depth: Number(focus.depth ?? 0) + sign * Number(node.depth ?? 0),
  });
  const edges = new Map(base.edges.map(edge => [edgeKey(edge), edge]));
  for (const edge of branchEdges) edges.set(edgeKey(edge), edge);
  if (edges.size > TRACE_EDGE_LIMIT) throw new Error(`展开后超过 ${TRACE_EDGE_LIMIT} 条关系上限，已保留原图；请缩小范围。`);
  const frontier = new Set(base.frontierNodeIds);
  if (direction === base.direction) frontier.delete(focus.id);
  for (const id of filtered.trace.frontierNodeIds) if (reached.has(id)) frontier.add(id);
  const truncated = base.truncated || branch.truncated;
  const merged: TraceResult = {
    ...base, nodes: [...nodes.values()], edges: [...edges.values()], consumption: undefined,
    frontierNodeIds: [...frontier], truncated,
    stoppedBy: truncated ? "EDGE_LIMIT" : frontier.size ? "DEPTH_LIMIT" : null,
    depthLimit: Math.max(base.depthLimit, ...[...nodes.values()].map(node => Math.abs(Number(node.depth ?? 0)))),
    terminalNodes: [...new Map([...base.terminalNodes, ...filtered.trace.terminalNodes.filter(node => reached.has(node.nodeId))].map(node => [node.nodeId, node])).values()],
    taskLabels: {...base.taskLabels, ...branch.taskLabels},
    taskClusters: {...base.taskClusters, ...branch.taskClusters},
    taskTopics: {...base.taskTopics, ...branch.taskTopics},
    taskTopicDescriptions: {...base.taskTopicDescriptions, ...branch.taskTopicDescriptions},
    elapsedMs: branch.elapsedMs,
  };
  return {trace: merged, addedNodes: nodes.size - base.nodes.length, addedEdges: edges.size - base.edges.length, omittedTasks: filtered.omittedTaskIds.length};
}
