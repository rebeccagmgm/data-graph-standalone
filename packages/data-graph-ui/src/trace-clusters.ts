import type { TraceResult } from "./types";
import { restrictTableClusters } from "./analysis-scope/clusters";
import { mergeTraceConsumptions } from "./trace-consumption";

/** Filter the display while retaining the original trace as evidence. */
export function restrictTraceClusters(raw: TraceResult, clusters: string[]) {
  if (!clusters.length) return { trace: raw, omittedTaskIds: [] as string[] };
  if (raw.layer === "table") return restrictTableClusters(raw, clusters,
    raw.nodes.filter(node => node.kind === "PHYSICAL_DATASET" && Number(node.depth ?? 0) === 0).map(node => node.id));
  const omitted = new Set<string>();
  const nodes = raw.nodes.filter(node => {
    const taskId = node.taskId || (node.kind === "TASK" ? node.id.replace(/^task:/, "") : undefined);
    if (!taskId) return false;
    if (clusters.includes(raw.taskClusters?.[taskId] ?? "")) return true;
    omitted.add(taskId);
    return false;
  });
  const ids = new Set(nodes.map(node => node.id));
  const edges = raw.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  return { omittedTaskIds: [...omitted], trace: {
    ...raw, nodes, edges,
    terminalNodes: raw.terminalNodes.filter(node => ids.has(node.nodeId)),
    frontierNodeIds: raw.frontierNodeIds.filter(id => ids.has(id)),
    consumption: raw.consumption ? mergeTraceConsumptions({
      consumptions: [raw.consumption], allowedNodeIds: ids,
      allowedEdgeIds: new Set(edges.flatMap(edge => edge.id ? [edge.id] : edge.key ? [edge.key] : [])),
      allRootNodeIds: nodes.filter(node => Number(node.depth ?? 0) === 0).map(node => node.id),
    }) : undefined,
  }};
}

export function readGlobalClusters(storage: Pick<Storage, "getItem">): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem("data-graph:clusters") ?? "[]");
    return Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === "string") ? value : [];
  } catch { return []; }
}
