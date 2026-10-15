import type { TraceResult } from "../types";

/** Cluster belongs to a scheduler task, not to a table name. */
export function restrictTableClusters(
  raw: TraceResult,
  clusters: string[],
  pinnedTableIds: string[] = [],
) {
  if (!clusters.length) return { trace: raw, omittedTaskIds: [] as string[] };
  const tasks = raw.nodes.filter((n) => n.kind === "TASK");
  const taskId = (node: (typeof tasks)[number]) =>
    node.taskId || node.id.replace(/^task:/, "");
  const allowed = new Set(
    tasks
      .filter((n) => clusters.includes(raw.taskClusters?.[taskId(n)] ?? ""))
      .map((n) => n.id),
  );
  const tables = new Set(
    raw.nodes.filter((n) => n.kind === "PHYSICAL_DATASET").map((n) => n.id),
  );
  const visible = new Set([
    ...allowed,
    ...pinnedTableIds.filter((id) => tables.has(id)),
  ]);
  // Keep tables actually read/written by retained tasks. A shared table does not
  // authorize other-cluster writers or readers to re-enter the view.
  for (const edge of raw.edges) {
    if (allowed.has(edge.from) && tables.has(edge.to)) visible.add(edge.to);
    if (allowed.has(edge.to) && tables.has(edge.from)) visible.add(edge.from);
  }
  return {
    trace: {
      ...raw,
      nodes: raw.nodes.filter((n) => visible.has(n.id)),
      edges: raw.edges.filter((e) => visible.has(e.from) && visible.has(e.to)),
      terminalNodes: raw.terminalNodes.filter((n) => visible.has(n.nodeId)),
      frontierNodeIds: raw.frontierNodeIds.filter((id) => visible.has(id)),
    },
    omittedTaskIds: tasks.filter((n) => !allowed.has(n.id)).map(taskId),
  };
}

export function clusterBoundaryWarning(taskIds: string[]) {
  return taskIds.length
    ? [
        `集群边界：本次查询的 ${taskIds.length} 个其他集群或未收录调度未展开；跨集群关系在此停止。`,
      ]
    : [];
}
