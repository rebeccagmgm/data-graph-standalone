import type { GraphEdge, GraphNode, TraceResult } from "./types";
import { mergeTraceConsumptions } from "./trace-consumption";
import { TRACE_EDGE_LIMIT } from "./graph-limits";

export const COMBINED_EDGE_LIMIT = TRACE_EDGE_LIMIT;

export function shouldFallbackToDepthOne(
  result: TraceResult,
  requestedDepth: number,
) {
  return (
    requestedDepth > 1 && result.truncated && result.stoppedBy === "EDGE_LIMIT"
  );
}

export async function loadAllFieldPages(input: {
  fetchPage: (offset: number, limit: number) => Promise<GraphNode[]>;
  readVersion: () => Promise<string>;
  isCurrent: () => boolean;
  pageSize?: number;
}): Promise<GraphNode[]> {
  const version = await input.readVersion();
  if (!version) throw new Error("图谱版本不可用，请稍后重试。");
  const pageSize = input.pageSize ?? 300;
  const fields: GraphNode[] = [];
  let offset = 0;
  while (true) {
    const page = await input.fetchPage(offset, pageSize + 1);
    if (!input.isCurrent()) throw new Error("STALE_FIELD_LIST_QUERY");
    fields.push(...page.slice(0, pageSize));
    if (page.length <= pageSize) {
      const finalVersion = await input.readVersion();
      if (!input.isCurrent()) throw new Error("STALE_FIELD_LIST_QUERY");
      if (version !== finalVersion)
        throw new Error("字段加载期间图谱已换版，请重新加载字段。");
      return fields;
    }
    offset += pageSize;
  }
}

function edgeIdentity(edge: GraphEdge, index: number): string {
  return (
    edge.id ??
    edge.key ??
    `${edge.from}|${edge.to}|${edge.kind}|${edge.status ?? ""}|${index}`
  );
}

function reachableEdges(rootId: string, result: TraceResult): GraphEdge[] {
  const visited = new Set([rootId]);
  const pending = result.edges.map((edge, index) => ({ edge, index }));
  const ordered: GraphEdge[] = [];
  while (pending.length) {
    let progressed = false;
    for (let index = 0; index < pending.length;) {
      const candidate = pending[index]!;
      const touches =
        result.direction === "up"
          ? visited.has(candidate.edge.to)
          : visited.has(candidate.edge.from);
      if (!touches) {
        index += 1;
        continue;
      }
      ordered.push(candidate.edge);
      visited.add(
        result.direction === "up" ? candidate.edge.from : candidate.edge.to,
      );
      pending.splice(index, 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  return ordered;
}

export async function collectMultiFieldTrace(input: {
  roots: GraphNode[];
  fetchTrace: (root: GraphNode) => Promise<TraceResult>;
  isCurrent: () => boolean;
  edgeLimit?: number;
}): Promise<TraceResult> {
  const roots = input.roots;
  if (!roots.length) throw new Error("NO_FIELDS_SELECTED");
  const edgeLimit = input.edgeLimit ?? COMBINED_EDGE_LIMIT;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const terminalNodes = new Map<string, TraceResult["terminalNodes"][number]>();
  const frontier = new Set<string>();
  const taskLabels: Record<string, string> = {};
  const taskClusters: Record<string, string> = {};
  const taskTopics: Record<string, string> = {};
  const taskTopicDescriptions: Record<string, string> = {};
  const stoppedBy = new Set<NonNullable<TraceResult["stoppedBy"]>>();
  let version: string | undefined;
  let template: TraceResult | undefined;
  let elapsedMs = 0;
  let truncated = false;
  let queried = 0;
  let combinedEdgeLimitReached = false;
  const consumptions: NonNullable<TraceResult["consumption"]>[] = [];

  for (const root of roots) {
    if (!input.isCurrent()) throw new Error("STALE_MULTI_FIELD_QUERY");
    if (edges.size >= edgeLimit) {
      truncated = true;
      combinedEdgeLimitReached = true;
      break;
    }
    const result = await input.fetchTrace(root);
    if (!input.isCurrent()) throw new Error("STALE_MULTI_FIELD_QUERY");
    queried += 1;
    nodes.set(root.id, { ...nodes.get(root.id), ...root, depth: 0 });
    template ??= result;
    elapsedMs += result.elapsedMs;
    if (version !== undefined && result.version !== version)
      throw new Error("ASSET_GRAPH_CHANGED_DURING_MULTI_FIELD_QUERY");
    version = result.version;
    Object.assign(taskLabels, result.taskLabels ?? {});
    Object.assign(taskClusters, result.taskClusters ?? {});
    Object.assign(taskTopics, result.taskTopics ?? {});
    Object.assign(taskTopicDescriptions, result.taskTopicDescriptions ?? {});
    if (result.stoppedBy) stoppedBy.add(result.stoppedBy);
    const acceptedEdgeIds = new Set<string>();
    const acceptedEdges = reachableEdges(root.id, result);
    for (const edge of acceptedEdges) {
      const identity = edgeIdentity(edge, edges.size);
      if (edges.has(identity)) {
        acceptedEdgeIds.add(identity);
        continue;
      }
      if (edges.size >= edgeLimit) {
        truncated = true;
        combinedEdgeLimitReached = true;
        break;
      }
      edges.set(identity, edge);
      acceptedEdgeIds.add(identity);
    }
    const connectedIds = new Set<string>([root.id]);
    for (const [identity, edge] of edges)
      if (acceptedEdgeIds.has(identity)) {
      connectedIds.add(edge.from);
      connectedIds.add(edge.to);
      }
    for (const node of result.nodes) {
      if (!connectedIds.has(node.id)) continue;
      const existing = nodes.get(node.id);
      if (!existing) nodes.set(node.id, node);
      else {
        const depth = Math.min(
          Number(existing.depth ?? Number.MAX_SAFE_INTEGER),
          Number(node.depth ?? Number.MAX_SAFE_INTEGER),
        );
        nodes.set(node.id, {
          ...existing,
          ...node,
          ...(Number.isSafeInteger(depth) ? { depth } : {}),
        });
      }
    }
    for (const terminal of result.terminalNodes)
      if (connectedIds.has(terminal.nodeId))
        terminalNodes.set(terminal.nodeId, terminal);
    for (const id of result.frontierNodeIds)
      if (connectedIds.has(id)) frontier.add(id);
    if (result.consumption)
      consumptions.push({
        ...result.consumption,
        groups: result.consumption.groups.map((group) => ({
          ...group,
          rootNodeIds: group.rawNodeIds.some((id) => connectedIds.has(id))
            ? [root.id]
            : [],
        })),
        branches: result.consumption.branches.map((branch) => ({
          ...branch,
          rootNodeIds: branch.rawEdgeIds.some((id) =>
            acceptedEdgeIds.has(id),
          )
            ? [root.id]
            : [],
        })),
        rootPaths: result.consumption.rootPaths
          .filter((path) => path.rootNodeId === root.id)
          .map((path) => ({
            ...path,
            rawNodeIds: path.rawNodeIds.filter((id) => connectedIds.has(id)),
            rawEdgeIds: path.rawEdgeIds.filter((id) =>
              acceptedEdgeIds.has(id),
            ),
          })),
      });
    truncated ||= result.truncated;
  }
  if (!template || !version) throw new Error("MULTI_FIELD_QUERY_DID_NOT_START");
  truncated ||= queried < roots.length;
  const allowedNodeIds = new Set(nodes.keys());
  const allowedEdgeIds = new Set(edges.keys());
  return {
    ...template,
    version,
    edgeLimit,
    unqueriedRootNodeIds: roots.slice(queried).map(root => root.id),
    truncated,
    stoppedBy:
      combinedEdgeLimitReached || stoppedBy.has("EDGE_LIMIT")
        ? "EDGE_LIMIT"
        : stoppedBy.has("DEPTH_LIMIT")
          ? "DEPTH_LIMIT"
          : null,
    frontierNodeIds: [...frontier],
    terminalNodes: [...terminalNodes.values()],
    taskLabels,
    taskClusters,
    taskTopics,
    taskTopicDescriptions,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    consumption: mergeTraceConsumptions({
      consumptions,
      allowedNodeIds,
      allowedEdgeIds,
      allRootNodeIds: roots.map(({ id }) => id),
    }),
    elapsedMs,
  };
}
