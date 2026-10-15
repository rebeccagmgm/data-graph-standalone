import type { TraceResult } from "../types";

/** Derive display columns from actual edges; cycles share a column, not a role. */
export function layoutTableTrace(trace: TraceResult): TraceResult {
  const ids = new Set(trace.nodes.map((n) => n.id));
  const next = new Map([...ids].map((id) => [id, [] as string[]]));
  for (const edge of trace.edges)
    if (ids.has(edge.from) && ids.has(edge.to))
      next.get(edge.from)!.push(edge.to);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const component = new Map<string, number>();
  let counter = 0;
  let count = 0;
  const visit = (id: string) => {
    index.set(id, counter);
    low.set(id, counter++);
    stack.push(id);
    active.add(id);
    for (const target of next.get(id)!) {
      if (!index.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id)!, low.get(target)!));
      } else if (active.has(target))
        low.set(id, Math.min(low.get(id)!, index.get(target)!));
    }
    if (low.get(id) === index.get(id)) {
      let current: string;
      do {
        current = stack.pop()!;
        active.delete(current);
        component.set(current, count);
      } while (current !== id);
      count++;
    }
  };
  for (const id of [...ids].sort()) if (!index.has(id)) visit(id);
  const successors = Array.from({ length: count }, () => new Set<number>());
  const indegree = new Array<number>(count).fill(0);
  const rank = new Array<number>(count).fill(0);
  for (const edge of trace.edges) {
    const from = component.get(edge.from),
      to = component.get(edge.to);
    if (
      from === undefined ||
      to === undefined ||
      from === to ||
      successors[from]!.has(to)
    )
      continue;
    successors[from]!.add(to);
    indegree[to]!++;
  }
  const queue = indegree.flatMap((degree, i) => (degree === 0 ? [i] : []));
  for (let i = 0; i < queue.length; i++)
    for (const to of successors[queue[i]!]!) {
      rank[to] = Math.max(rank[to]!, rank[queue[i]!]! + 1);
      if (--indegree[to]! === 0) queue.push(to);
    }
  return {
    ...trace,
    direction: "down",
    nodes: trace.nodes.map((node) => ({
      ...node,
      depth: rank[component.get(node.id)!] ?? 0,
    })),
  };
}
