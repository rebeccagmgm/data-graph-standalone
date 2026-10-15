import type { GraphEdge, GraphNode, TraceResult } from "../types";

/** Display identity only. Raw task-table instances remain the navigation/evidence anchors. */
export function tableDisplayId(node: GraphNode): string {
  if (node.kind !== "PHYSICAL_DATASET") return node.id;
  if (node.detail?.identityStatus && node.detail.identityStatus !== "CONFIRMED")
    return node.id;
  const context = node.detail?.taskTableContext as
    { datasetId?: string } | undefined;
  const physical = node.physicalNodeId ?? context?.datasetId;
  return physical?.startsWith("dataset:") ? physical : node.id;
}

function plainComment(value: string | undefined): string | undefined {
  return value
    ?.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(?:br|p|div)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function projectTableDisplay(raw: TraceResult): TraceResult {
  if (raw.layer !== "table") return raw;
  const aliases = new Map(
    raw.nodes.map((node) => [node.id, tableDisplayId(node)]),
  );
  const nodes = new Map<string, GraphNode>();
  for (const node of raw.nodes) {
    const id = aliases.get(node.id)!;
    if (node.kind !== "PHYSICAL_DATASET") {
      nodes.set(id, node);
      continue;
    }
    const previous = nodes.get(id);
    const preferred =
      previous &&
      (previous.metadata?.table.status === "AVAILABLE" ||
        node.metadata?.table.status !== "AVAILABLE")
        ? previous
        : node;
    // A physical card does not belong to one arbitrary task. Keep all members.
    const { taskTableContext: _context, ...detail } = preferred.detail ?? {};
    nodes.set(id, {
      ...preferred,
      id,
      detail,
      tableContexts: [...(previous?.tableContexts ?? []), node],
      metadata: preferred.metadata
        ? {
            ...preferred.metadata,
            table: {
              ...preferred.metadata.table,
              description: plainComment(preferred.metadata.table.description),
              comment: plainComment(preferred.metadata.table.comment),
            },
          }
        : undefined,
    });
  }
  const edges = new Map<string, GraphEdge>();
  for (const edge of raw.edges) {
    // Schedule references are navigation scope, never a supply edge.
    if (!["READS_TABLE", "WRITES_TABLE"].includes(edge.kind)) continue;
    const from = aliases.get(edge.from),
      to = aliases.get(edge.to);
    if (!from || !to) continue;
    const key = JSON.stringify([from, to, edge.kind, edge.status ?? ""]);
    const previous = edges.get(key);
    edges.set(
      key,
      previous
        ? {
            ...previous,
            // Never let the first write/read's detail stand for all merged records.
            detail: undefined,
            tableRelations: [...previous.tableRelations!, edge],
          }
        : { ...edge, from, to, tableRelations: [edge] },
    );
  }
  return {
    ...raw,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    consumption: undefined,
    frontierNodeIds: [
      ...new Set(raw.frontierNodeIds.map((id) => aliases.get(id) ?? id)),
    ],
    terminalNodes: raw.terminalNodes.map((node) => ({
      ...node,
      nodeId: aliases.get(node.nodeId) ?? node.nodeId,
    })),
  };
}

/** Resolve a merged card back to its task contexts, never query its global table adjacency. */
export function scopeExpansionNodes(
  trace: TraceResult,
  nodeId: string,
  direction: "up" | "down",
): GraphNode[] {
  const direct = trace.nodes.find((node) => node.id === nodeId);
  // Explicit task/context IDs (including old saved steps) keep their meaning.
  if (
    direct &&
    (direct.kind !== "PHYSICAL_DATASET" || direct.detail?.taskTableContext)
  )
    return [direct];
  const contexts = trace.nodes.filter(
    (node) =>
      node.kind === "PHYSICAL_DATASET" &&
      tableDisplayId(node) === nodeId &&
      Boolean(node.detail?.taskTableContext),
  );
  const crossing = contexts.filter((node) => {
    const context = node.detail?.taskTableContext as
      { role?: string } | undefined;
    return context?.role === (direction === "up" ? "READ" : "WRITE");
  });
  // Mixing a physical seed into a scoped graph must not switch to global IO.
  return crossing.length
    ? crossing
    : contexts.length
      ? contexts
      : direct
        ? [direct]
        : [];
}
