import type {Direction, GraphEdge, GraphNode} from "./types";

/** Display identity belongs to the physical table, never to a task or query depth. */
export function physicalTableKey(node: GraphNode): string | undefined {
  const identity = node.metadata?.identity;
  if (!identity?.platform || !identity.dataSource || !identity.qualifiedName ||
    node.detail?.identityStatus === "UNKNOWN") return undefined;
  if (node.table && identity.qualifiedName.toLowerCase() !== node.table.toLowerCase()) return undefined;
  return JSON.stringify([identity.platform.toLowerCase(), identity.dataSource.toLowerCase(), identity.qualifiedName.toLowerCase()]);
}

export function selectedFieldCount(fields: GraphNode[]): number {
  return new Set(fields.map(field => {
    const table = physicalTableKey(field);
    return table ? JSON.stringify([table, field.column?.toLowerCase() ?? field.id]) : field.id;
  })).size;
}

/** A read/write alias pair is one selected field, not two navigation roots. */
export function continuationRoots(members: GraphNode[], direction: Direction, edges: GraphEdge[]): GraphNode[] {
  const unique = [...new Map(members.map(member => [member.id, member])).values()];
  const ids = new Set(unique.map(member => member.id));
  const redundant = new Set(edges.filter(edge => edge.kind === "CONTINUES" &&
    edge.status === "CONFIRMED" && ids.has(edge.from) && ids.has(edge.to))
    .map(edge => direction === "up" ? edge.to : edge.from));
  return unique.filter(member => !redundant.has(member.id));
}
