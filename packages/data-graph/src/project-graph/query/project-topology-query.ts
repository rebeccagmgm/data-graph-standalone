import {
  PROJECT_TOPOLOGY_SCHEMA_VERSION,
  compareText,
  sortedUnique,
  type ProjectTopologyEdgeRecord,
  type ProjectTopologyEdgeType,
  type ProjectTopologyNodeRecord,
  type ProjectTopologyNodeType,
  type ProjectTopologyQueryEnvelope,
  type ProjectTopologyRelationLayer,
} from "../contracts/project-topology-contract.ts";
import {
  loadProjectTopologyDirectory,
  type LoadedProjectTopologyDirectory,
} from "../topology/project-topology-publication.ts";

export interface GetProjectTopologyOptions {
  readonly nodeTypes?: readonly ProjectTopologyNodeType[];
  readonly edgeTypes?: readonly ProjectTopologyEdgeType[];
  readonly offset?: number;
  readonly limit?: number;
}

export interface TraceProjectUpstreamOptions {
  readonly startNodeId: string;
  readonly relationLayers?: readonly ProjectTopologyRelationLayer[];
  readonly maxHops?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxPaths?: number;
}

export type ProjectTopologyQuerySource = Pick<
  LoadedProjectTopologyDirectory,
  "projection"
>;

export function getProjectTopology(
  directory: string,
  options: GetProjectTopologyOptions = {},
): ReturnType<typeof getProjectTopologyFromProjection> {
  return getProjectTopologyFromProjection(
    loadProjectTopologyDirectory(directory),
    options,
  );
}

export function getProjectTopologyFromProjection(
  loaded: ProjectTopologyQuerySource,
  options: GetProjectTopologyOptions = {},
): ProjectTopologyQueryEnvelope<{
  readonly nodes: readonly ProjectTopologyNodeRecord[];
  readonly edges: readonly ProjectTopologyEdgeRecord[];
  readonly totalNodes: number;
  readonly totalEdges: number;
  readonly coverageStatus: "COMPLETE" | "PARTIAL";
  readonly boundaries: readonly ProjectTopologyNodeRecord[];
}> {
  const offset = nonNegative(options.offset ?? 0, "OFFSET");
  const limit = bounded(options.limit ?? 500, 1, 5_000, "LIMIT");
  const nodeTypes = new Set(options.nodeTypes ?? []);
  const edgeTypes = new Set(options.edgeTypes ?? []);
  const allNodes = loaded.projection.nodes.filter(
    (node) => nodeTypes.size === 0 || nodeTypes.has(node.nodeType),
  );
  const allEdges = loaded.projection.edges.filter(
    (edge) => edgeTypes.size === 0 || edgeTypes.has(edge.edgeType),
  );
  const nodes = allNodes.slice(offset, offset + limit);
  const edges = allEdges.slice(offset, offset + limit);
  const truncated =
    nodes.length < allNodes.length - Math.min(offset, allNodes.length) ||
    edges.length < allEdges.length - Math.min(offset, allEdges.length);
  return envelope(
    loaded,
    "get_project_topology",
    truncated,
    {
      nodes,
      edges,
      totalNodes: allNodes.length,
      totalEdges: allEdges.length,
      coverageStatus: loaded.projection.snapshot.coverageStatus,
      boundaries: loaded.projection.nodes.filter(
        (node) => node.nodeType === "BOUNDARY",
      ),
    },
    { offset, limit },
  );
}

export function traceProjectUpstream(
  directory: string,
  options: TraceProjectUpstreamOptions,
): ReturnType<typeof traceProjectUpstreamFromProjection> {
  return traceProjectUpstreamFromProjection(
    loadProjectTopologyDirectory(directory),
    options,
  );
}

export function traceProjectUpstreamFromProjection(
  loaded: ProjectTopologyQuerySource,
  options: TraceProjectUpstreamOptions,
): ProjectTopologyQueryEnvelope<{
  readonly startNodeId: string;
  readonly nodes: readonly ProjectTopologyNodeRecord[];
  readonly edges: readonly ProjectTopologyEdgeRecord[];
  readonly reachedDepth: number;
  readonly exploredPaths: number;
  readonly truncated: boolean;
  readonly relationLayers: readonly ProjectTopologyRelationLayer[];
}> {
  const nodeById = new Map(
    loaded.projection.nodes.map((node) => [node.nodeId, node]),
  );
  const maxHops = bounded(options.maxHops ?? 20, 0, 100, "MAX_HOPS");
  const maxNodes = bounded(options.maxNodes ?? 2_000, 1, 100_000, "MAX_NODES");
  const maxEdges = bounded(options.maxEdges ?? 5_000, 1, 250_000, "MAX_EDGES");
  const maxPaths = bounded(
    options.maxPaths ?? 10_000,
    1,
    1_000_000,
    "MAX_PATHS",
  );
  const relationLayers = sortedUnique(
    options.relationLayers ?? ["DATA_PRODUCTION"],
  ) as ProjectTopologyRelationLayer[];
  if (!nodeById.has(options.startNodeId))
    return {
      schemaVersion: PROJECT_TOPOLOGY_SCHEMA_VERSION,
      query: "trace_project_upstream",
      status: "not_found",
      snapshotId: loaded.projection.snapshot.snapshotId,
      result: {
        startNodeId: options.startNodeId,
        nodes: [],
        edges: [],
        reachedDepth: 0,
        exploredPaths: 0,
        truncated: false,
        relationLayers,
      },
      warnings: [],
      limits: { maxHops, maxNodes, maxEdges, maxPaths },
    };

  const allowedLayers = new Set<ProjectTopologyRelationLayer>(relationLayers);
  const outgoing = new Map<string, ProjectTopologyEdgeRecord[]>();
  const incoming = new Map<string, ProjectTopologyEdgeRecord[]>();
  for (const edge of loaded.projection.edges) {
    if (!allowedLayers.has(edge.relationLayer)) continue;
    addToIndex(outgoing, edge.fromNodeId, edge);
    addToIndex(incoming, edge.toNodeId, edge);
  }
  const seenNodes = new Set([options.startNodeId]);
  const seenEdges = new Map<string, ProjectTopologyEdgeRecord>();
  const pending: Array<{ readonly nodeId: string; readonly depth: number }> = [
    { nodeId: options.startNodeId, depth: 0 },
  ];
  let reachedDepth = 0;
  let exploredPaths = 0;
  let truncated = false;
  while (pending.length > 0) {
    if (exploredPaths >= maxPaths) {
      truncated = true;
      break;
    }
    const current = pending.shift()!;
    exploredPaths += 1;
    reachedDepth = Math.max(reachedDepth, current.depth);
    if (current.depth >= maxHops) {
      if (neighbors(current.nodeId, outgoing, incoming).length > 0)
        truncated = true;
      continue;
    }
    for (const { edge, nextNodeId } of neighbors(
      current.nodeId,
      outgoing,
      incoming,
    )) {
      if (seenEdges.size >= maxEdges) {
        truncated = true;
        break;
      }
      seenEdges.set(edge.edgeId, edge);
      if (!seenNodes.has(nextNodeId)) {
        if (seenNodes.size >= maxNodes) {
          truncated = true;
          break;
        }
        seenNodes.add(nextNodeId);
        pending.push({ nodeId: nextNodeId, depth: current.depth + 1 });
      }
    }
    if (truncated && (seenEdges.size >= maxEdges || seenNodes.size >= maxNodes))
      break;
  }
  const nodes = [...seenNodes]
    .sort(compareText)
    .map((id) => nodeById.get(id)!)
    .filter(Boolean);
  const edges = [...seenEdges.values()].sort((left, right) =>
    compareText(left.edgeId, right.edgeId),
  );
  return envelope(
    loaded,
    "trace_project_upstream",
    truncated,
    {
      startNodeId: options.startNodeId,
      nodes,
      edges,
      reachedDepth,
      exploredPaths,
      truncated,
      relationLayers,
    },
    { maxHops, maxNodes, maxEdges, maxPaths },
  );
}

export function explainTopologyEdge(
  directory: string,
  edgeId: string,
): ReturnType<typeof explainTopologyEdgeFromProjection> {
  return explainTopologyEdgeFromProjection(
    loadProjectTopologyDirectory(directory),
    edgeId,
  );
}

export function explainTopologyEdgeFromProjection(
  loaded: ProjectTopologyQuerySource,
  edgeId: string,
): ProjectTopologyQueryEnvelope<{
  readonly edge: ProjectTopologyEdgeRecord | null;
  readonly endpoints: readonly ProjectTopologyNodeRecord[];
  readonly sourceArtifacts: readonly unknown[];
  readonly attachedBoundaries: readonly ProjectTopologyNodeRecord[];
}> {
  const edge =
    loaded.projection.edges.find((candidate) => candidate.edgeId === edgeId) ??
    null;
  if (!edge)
    return {
      schemaVersion: PROJECT_TOPOLOGY_SCHEMA_VERSION,
      query: "explain_topology_edge",
      status: "not_found",
      snapshotId: loaded.projection.snapshot.snapshotId,
      result: {
        edge: null,
        endpoints: [],
        sourceArtifacts: [],
        attachedBoundaries: [],
      },
      warnings: [],
      limits: {},
    };
  const nodeById = new Map(
    loaded.projection.nodes.map((node) => [node.nodeId, node]),
  );
  const artifactRefs = loaded.projection.snapshot.sources.flatMap((source) => [
    source.oneHop,
    source.multiHop,
  ]);
  const requestedRefs = new Set(edge.sourceArtifactRefIds);
  const boundaryIds = new Set(
    loaded.projection.edges
      .filter(
        (candidate) =>
          candidate.edgeType === "HAS_BOUNDARY" &&
          (candidate.fromNodeId === edge.fromNodeId ||
            candidate.fromNodeId === edge.toNodeId),
      )
      .map((candidate) => candidate.toNodeId),
  );
  return envelope(
    loaded,
    "explain_topology_edge",
    false,
    {
      edge,
      endpoints: [
        nodeById.get(edge.fromNodeId),
        nodeById.get(edge.toNodeId),
      ].filter((node): node is ProjectTopologyNodeRecord => node !== undefined),
      sourceArtifacts: artifactRefs
        .filter((ref) => requestedRefs.has(ref.refId))
        .sort((left, right) => compareText(left.refId, right.refId)),
      attachedBoundaries: [...boundaryIds]
        .sort(compareText)
        .map((id) => nodeById.get(id))
        .filter(
          (node): node is ProjectTopologyNodeRecord => node !== undefined,
        ),
    },
    {},
  );
}

function neighbors(
  nodeId: string,
  outgoing: ReadonlyMap<string, readonly ProjectTopologyEdgeRecord[]>,
  incoming: ReadonlyMap<string, readonly ProjectTopologyEdgeRecord[]>,
): Array<{
  readonly edge: ProjectTopologyEdgeRecord;
  readonly nextNodeId: string;
}> {
  const result: Array<{
    readonly edge: ProjectTopologyEdgeRecord;
    readonly nextNodeId: string;
  }> = [];
  for (const edge of outgoing.get(nodeId) ?? []) {
    if (
      edge.edgeType === "PRODUCER_BRIDGE" ||
      edge.edgeType === "SCHEDULE_DEPENDS_ON" ||
      edge.edgeType === "READS" ||
      edge.edgeType === "ROOT_REACHES_TASK" ||
      edge.edgeType === "HAS_ENTRY_TASK"
    )
      result.push({ edge, nextNodeId: edge.toNodeId });
  }
  for (const edge of incoming.get(nodeId) ?? [])
    if (edge.edgeType === "WRITES")
      result.push({ edge, nextNodeId: edge.fromNodeId });
  return result.sort((left, right) =>
    compareText(left.edge.edgeId, right.edge.edgeId),
  );
}

function addToIndex(
  index: Map<string, ProjectTopologyEdgeRecord[]>,
  key: string,
  edge: ProjectTopologyEdgeRecord,
): void {
  const values = index.get(key) ?? [];
  values.push(edge);
  index.set(key, values);
}

function envelope<T>(
  loaded: ProjectTopologyQuerySource,
  query: ProjectTopologyQueryEnvelope<T>["query"],
  truncated: boolean,
  result: T,
  limits: Readonly<Record<string, number>>,
): ProjectTopologyQueryEnvelope<T> {
  const partial =
    loaded.projection.snapshot.coverageStatus === "PARTIAL" || truncated;
  const warnings = [
    ...(loaded.projection.snapshot.coverageStatus === "PARTIAL"
      ? ["SOURCE_EVIDENCE_PARTIAL"]
      : []),
    ...(truncated ? ["QUERY_LIMIT_REACHED"] : []),
  ];
  return {
    schemaVersion: PROJECT_TOPOLOGY_SCHEMA_VERSION,
    query,
    status: partial ? "partial" : "ok",
    snapshotId: loaded.projection.snapshot.snapshotId,
    result,
    warnings,
    limits,
  };
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${label}_INVALID`);
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label}_INVALID`);
  return value;
}
