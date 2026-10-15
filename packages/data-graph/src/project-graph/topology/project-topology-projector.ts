import { canonicalJson, sha256 } from "../../contracts/runtime.ts";
import type { MultiHopReconciliationResult } from "../../contracts/canonical-artifacts.ts";
import {
  PROJECT_TOPOLOGY_PROJECTION_VERSION,
  PROJECT_TOPOLOGY_SCHEMA_VERSION,
  PROJECT_TOPOLOGY_SNAPSHOT_TYPE,
  compareText,
  physicalDatasetIdentity,
  physicalDatasetNodeId,
  projectKeySegment,
  projectSnapshotId,
  projectedEdgeId,
  snapshotContentHash,
  sortedUnique,
  stableId,
  taskNodeId,
  validateProjectTopologyProjection,
  type ProjectTopologyEdgeRecord,
  type ProjectTopologyEdgeType,
  type ProjectTopologyEvidenceRef,
  type ProjectTopologyNodeRecord,
  type ProjectTopologyNodeType,
  type ProjectTopologyProjectionV1,
  type ProjectTopologyRelationLayer,
  type ProjectTopologyRootSource,
} from "../contracts/project-topology-contract.ts";
import type { LoadedProjectTopologyRoot } from "./project-topology-source.ts";

export interface BuildProjectTopologyOptions {
  readonly projectKey: string;
  readonly roots: readonly LoadedProjectTopologyRoot[];
  readonly maxNodes?: number;
  readonly maxEdges?: number;
}

interface MutableNode {
  nodeId: string;
  nodeType: ProjectTopologyNodeType;
  sourceRootTaskIds: Set<string>;
  sourceArtifactRefIds: Set<string>;
  properties: Record<string, unknown>;
}

interface MutableEdge {
  edgeId: string;
  edgeType: ProjectTopologyEdgeType;
  relationLayer: ProjectTopologyRelationLayer;
  fromNodeId: string;
  toNodeId: string;
  sourceRootTaskIds: Set<string>;
  sourceArtifactRefIds: Set<string>;
  evidenceRefs: Map<string, ProjectTopologyEvidenceRef>;
  properties: Record<string, unknown>;
}

export function buildProjectTopology(
  options: BuildProjectTopologyOptions,
): ProjectTopologyProjectionV1 {
  const projectKey = projectKeySegment(options.projectKey);
  const maxNodes = positiveLimit(options.maxNodes ?? 100_000, "MAX_NODES");
  const maxEdges = positiveLimit(options.maxEdges ?? 250_000, "MAX_EDGES");
  if (options.roots.length === 0)
    throw new Error("PROJECT_TOPOLOGY_ROOTS_REQUIRED");
  const sources = options.roots
    .map((root) => root.source)
    .sort((left, right) => compareText(left.rootTaskId, right.rootTaskId));
  const rootTaskIds = sortedUnique(sources.map((source) => source.rootTaskId));
  if (rootTaskIds.length !== options.roots.length)
    throw new Error("PROJECT_TOPOLOGY_ROOT_DUPLICATE");
  const snapshotId = projectSnapshotId({ projectKey, rootTaskIds, sources });
  const coverageStatus = sources.some(
    (source) =>
      source.coverage.status !== "COMPLETE_OBSERVED_EVIDENCE" ||
      source.limits.truncated === true ||
      source.producerIndex.status === "VALID_PARTIAL",
  )
    ? "PARTIAL"
    : "COMPLETE";

  const nodes = new Map<string, MutableNode>();
  const edges = new Map<string, MutableEdge>();
  const allArtifactRefs = sortedUnique(
    sources.flatMap((source) => [source.oneHop.refId, source.multiHop.refId]),
  );
  putNode(
    nodes,
    {
      nodeId: snapshotId,
      nodeType: "PROJECT_SNAPSHOT",
      sourceRootTaskIds: rootTaskIds,
      sourceArtifactRefIds: allArtifactRefs,
      properties: { projectKey, rootTaskIds, coverageStatus },
    },
    maxNodes,
  );

  for (const root of [...options.roots].sort((left, right) =>
    compareText(left.source.rootTaskId, right.source.rootTaskId),
  )) {
    projectRoot({ root, snapshotId, nodes, edges, maxNodes, maxEdges });
  }

  const snapshotBody = {
    schemaVersion: PROJECT_TOPOLOGY_SCHEMA_VERSION,
    artifactType: PROJECT_TOPOLOGY_SNAPSHOT_TYPE,
    projectionVersion: PROJECT_TOPOLOGY_PROJECTION_VERSION,
    snapshotId,
    projectKey,
    rootTaskIds,
    sources,
    coverageStatus,
  } as const;
  const projection: ProjectTopologyProjectionV1 = {
    snapshot: {
      ...snapshotBody,
      contentHash: snapshotContentHash(snapshotBody),
    },
    nodes: [...nodes.values()]
      .map(freezeNode)
      .sort((left, right) => compareText(left.nodeId, right.nodeId)),
    edges: [...edges.values()]
      .map(freezeEdge)
      .sort((left, right) => compareText(left.edgeId, right.edgeId)),
  };
  validateProjectTopologyProjection(projection);
  return projection;
}

function projectRoot(input: {
  readonly root: LoadedProjectTopologyRoot;
  readonly snapshotId: string;
  readonly nodes: Map<string, MutableNode>;
  readonly edges: Map<string, MutableEdge>;
  readonly maxNodes: number;
  readonly maxEdges: number;
}): void {
  const { root, snapshotId, nodes, edges, maxNodes, maxEdges } = input;
  const artifact = root.multiHop;
  const rootTaskId = root.source.rootTaskId;
  const artifactRefId = root.source.multiHop.refId;
  const rootNodeId = taskNodeId(rootTaskId);

  putTaskNode(nodes, rootTaskId, rootTaskId, artifactRefId, maxNodes);
  putEdge(
    edges,
    observedEdge({
      edgeType: "HAS_ENTRY_TASK",
      relationLayer: "PROJECT",
      fromNodeId: snapshotId,
      toNodeId: rootNodeId,
      semanticKey: { snapshotId, rootTaskId },
      rootTaskId,
      artifactRefId,
      observation: { rootTaskId },
    }),
    maxEdges,
  );

  for (const task of artifact.taskNodes) {
    putTaskNode(nodes, task.taskId, rootTaskId, artifactRefId, maxNodes);
    const evidenceRefs = evidenceRefsOf(task.evidence);
    putEdge(
      edges,
      observedEdge({
        edgeType: "ROOT_REACHES_TASK",
        relationLayer: "PROJECTION_SCOPE",
        fromNodeId: rootNodeId,
        toNodeId: taskNodeId(task.taskId),
        semanticKey: { snapshotId, rootTaskId, taskId: task.taskId },
        rootTaskId,
        artifactRefId,
        evidenceRefs,
        observation: {
          rootTaskId,
          taskId: task.taskId,
          minDepth: task.minDepth,
          expansionStatus: task.expansionStatus,
          taskInputPackStatus: task.taskInputPackStatus,
          taskContentHash: task.taskContentHash,
          upstreamDecision: task.upstreamDecision,
        },
      }),
      maxEdges,
    );
  }

  for (const table of artifact.tableNodes)
    putDatasetNode(nodes, table, rootTaskId, artifactRefId, maxNodes);

  for (const edge of artifact.readEdges) {
    const datasetId = physicalDatasetNodeId(edge.table);
    putTaskNode(
      nodes,
      edge.consumerTaskId,
      rootTaskId,
      artifactRefId,
      maxNodes,
    );
    putDatasetNode(nodes, edge.table, rootTaskId, artifactRefId, maxNodes);
    putEdge(
      edges,
      observedEdge({
        edgeType: "READS",
        relationLayer: "DATA_PRODUCTION",
        fromNodeId: taskNodeId(edge.consumerTaskId),
        toNodeId: datasetId,
        semanticKey: null,
        rootTaskId,
        artifactRefId,
        evidenceRefs: evidenceRefsOf(edge.evidence),
        observation: {
          rootTaskId,
          statementIndexes: [...edge.statementIndexes],
          eligibleStatementIndexes: [...edge.eligibleStatementIndexes],
          blockedStatementIndexes: [...edge.blockedStatementIndexes],
          recursionStatus: edge.recursionStatus,
          blockReasons: [...edge.blockReasons],
        },
      }),
      maxEdges,
    );
  }

  for (const edge of artifact.writeEdges) {
    const datasetId = physicalDatasetNodeId(edge.table);
    putTaskNode(
      nodes,
      edge.producerTaskId,
      rootTaskId,
      artifactRefId,
      maxNodes,
    );
    putDatasetNode(
      nodes,
      { ...edge.table, identityStatus: "RESOLVED" },
      rootTaskId,
      artifactRefId,
      maxNodes,
    );
    const writeObservationRefs = edge.writes.map((write, ordinal) => ({
      ordinal,
      sourceHash: sha256(canonicalJson(write)),
      observationKind: write.observationKind,
      sqlWriteKind: write.sqlWriteKind,
      operationClass: write.operationClass ?? null,
      dataPathRole: write.dataPathRole ?? null,
      evidenceRefs: evidenceRefsOf(write.evidence),
    }));
    putEdge(
      edges,
      observedEdge({
        edgeType: "WRITES",
        relationLayer: "DATA_PRODUCTION",
        fromNodeId: taskNodeId(edge.producerTaskId),
        toNodeId: datasetId,
        semanticKey: null,
        rootTaskId,
        artifactRefId,
        evidenceRefs: edge.writes.flatMap((write) =>
          evidenceRefsOf(write.evidence),
        ),
        observation: {
          rootTaskId,
          producerIndexContentHash: edge.producerIndexContentHash,
          writeObservationRefs,
        },
      }),
      maxEdges,
    );
  }

  for (const bridge of artifact.producerBridges) {
    const datasetId = physicalDatasetNodeId(bridge.table);
    putTaskNode(
      nodes,
      bridge.consumerTaskId,
      rootTaskId,
      artifactRefId,
      maxNodes,
    );
    putTaskNode(
      nodes,
      bridge.producerTaskId,
      rootTaskId,
      artifactRefId,
      maxNodes,
    );
    putDatasetNode(
      nodes,
      { ...bridge.table, identityStatus: "RESOLVED" },
      rootTaskId,
      artifactRefId,
      maxNodes,
    );
    putEdge(
      edges,
      observedEdge({
        edgeType: "PRODUCER_BRIDGE",
        relationLayer: "DATA_PRODUCTION",
        fromNodeId: taskNodeId(bridge.consumerTaskId),
        toNodeId: taskNodeId(bridge.producerTaskId),
        semanticKey: {
          datasetId,
          occurrenceId: bridge.readOccurrence?.occurrenceId ?? null,
        },
        rootTaskId,
        artifactRefId,
        observation: {
          rootTaskId,
          physicalDatasetNodeId: datasetId,
          producerDepth: bridge.producerDepth,
          producerRole: bridge.producerRole,
          readOccurrenceRef: bridge.readOccurrence,
          exactWriteObservationRef: null,
        },
      }),
      maxEdges,
    );
  }

  for (const edge of artifact.scheduleEdges) {
    putTaskNode(
      nodes,
      edge.consumerTaskId,
      rootTaskId,
      artifactRefId,
      maxNodes,
    );
    putTaskNode(
      nodes,
      edge.producerTaskId,
      rootTaskId,
      artifactRefId,
      maxNodes,
    );
    putEdge(
      edges,
      observedEdge({
        edgeType: "SCHEDULE_DEPENDS_ON",
        relationLayer: "SCHEDULE",
        fromNodeId: taskNodeId(edge.consumerTaskId),
        toNodeId: taskNodeId(edge.producerTaskId),
        semanticKey: null,
        rootTaskId,
        artifactRefId,
        evidenceRefs: evidenceRefsOf(edge.evidence),
        observation: {
          rootTaskId,
          producerDepth: edge.producerDepth,
        },
      }),
      maxEdges,
    );
  }

  artifact.terminals.forEach((terminal, terminalIndex) => {
    putTaskNode(nodes, terminal.taskId, rootTaskId, artifactRefId, maxNodes);
    const datasetId = terminal.table
      ? physicalDatasetNodeId(terminal.table)
      : null;
    if (terminal.table)
      putDatasetNode(
        nodes,
        "identityStatus" in terminal.table
          ? terminal.table
          : { ...terminal.table, identityStatus: "RESOLVED" },
        rootTaskId,
        artifactRefId,
        maxNodes,
      );
    const boundaryId = stableId("boundary", {
      snapshotId,
      rootTaskId,
      terminalIndex,
      terminal,
    });
    putNode(
      nodes,
      {
        nodeId: boundaryId,
        nodeType: "BOUNDARY",
        sourceRootTaskIds: [rootTaskId],
        sourceArtifactRefIds: [artifactRefId],
        properties: {
          rootTaskId,
          taskId: terminal.taskId,
          depth: terminal.depth,
          reason: terminal.reason,
          physicalDatasetNodeId: datasetId,
          detail: terminal.detail ?? null,
        },
      },
      maxNodes,
    );
    putEdge(
      edges,
      observedEdge({
        edgeType: "HAS_BOUNDARY",
        relationLayer: "BOUNDARY",
        fromNodeId: taskNodeId(terminal.taskId),
        toNodeId: boundaryId,
        semanticKey: { snapshotId, rootTaskId, terminalIndex },
        rootTaskId,
        artifactRefId,
        observation: { rootTaskId, reason: terminal.reason },
      }),
      maxEdges,
    );
  });
}

function putTaskNode(
  nodes: Map<string, MutableNode>,
  taskId: string,
  rootTaskId: string,
  artifactRefId: string,
  maxNodes: number,
): void {
  putNode(
    nodes,
    {
      nodeId: taskNodeId(taskId),
      nodeType: "TASK",
      sourceRootTaskIds: [rootTaskId],
      sourceArtifactRefIds: [artifactRefId],
      properties: { taskId },
    },
    maxNodes,
  );
}

function putDatasetNode(
  nodes: Map<string, MutableNode>,
  table: {
    readonly platform: string | null;
    readonly dataSource: string | null;
    readonly qualifiedName: string;
    readonly identityStatus: string;
  },
  rootTaskId: string,
  artifactRefId: string,
  maxNodes: number,
): void {
  const nodeId = physicalDatasetNodeId(table);
  const identity = physicalDatasetIdentity(table);
  const observation = {
    rootTaskId,
    identityStatus: table.identityStatus,
    observedPlatform: table.platform,
    observedDataSource: table.dataSource,
    observedQualifiedName: table.qualifiedName,
    sourceArtifactRefId: artifactRefId,
  };
  const existing = nodes.get(nodeId);
  if (existing) {
    if (existing.nodeType !== "PHYSICAL_DATASET")
      throw new Error(`PROJECT_TOPOLOGY_NODE_TYPE_CONFLICT:${nodeId}`);
    existing.sourceRootTaskIds.add(rootTaskId);
    existing.sourceArtifactRefIds.add(artifactRefId);
    existing.properties.identityObservations = mergeObservations(
      existing.properties.identityObservations,
      observation,
    );
    return;
  }
  putNode(
    nodes,
    {
      nodeId,
      nodeType: "PHYSICAL_DATASET",
      sourceRootTaskIds: [rootTaskId],
      sourceArtifactRefIds: [artifactRefId],
      properties: {
        ...identity,
        identityObservations: [observation],
      },
    },
    maxNodes,
  );
}

function observedEdge(input: {
  readonly edgeType: ProjectTopologyEdgeType;
  readonly relationLayer: ProjectTopologyRelationLayer;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly semanticKey: unknown;
  readonly rootTaskId: string;
  readonly artifactRefId: string;
  readonly evidenceRefs?: readonly ProjectTopologyEvidenceRef[];
  readonly observation: unknown;
}): MutableEdge {
  return {
    edgeId: projectedEdgeId({
      edgeType: input.edgeType,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      semanticKey: input.semanticKey,
    }),
    edgeType: input.edgeType,
    relationLayer: input.relationLayer,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    sourceRootTaskIds: new Set([input.rootTaskId]),
    sourceArtifactRefIds: new Set([input.artifactRefId]),
    evidenceRefs: new Map(
      (input.evidenceRefs ?? []).map((evidence) => [
        sha256(canonicalJson(evidence)),
        evidence,
      ]),
    ),
    properties: { observations: [input.observation] },
  };
}

function putNode(
  nodes: Map<string, MutableNode>,
  input: Omit<MutableNode, "sourceRootTaskIds" | "sourceArtifactRefIds"> & {
    readonly sourceRootTaskIds: readonly string[];
    readonly sourceArtifactRefIds: readonly string[];
  },
  maxNodes: number,
): void {
  const existing = nodes.get(input.nodeId);
  if (existing) {
    if (
      existing.nodeType !== input.nodeType ||
      canonicalJson(existing.properties) !== canonicalJson(input.properties)
    )
      throw new Error(`PROJECT_TOPOLOGY_NODE_CONFLICT:${input.nodeId}`);
    input.sourceRootTaskIds.forEach((root) =>
      existing.sourceRootTaskIds.add(root),
    );
    input.sourceArtifactRefIds.forEach((ref) =>
      existing.sourceArtifactRefIds.add(ref),
    );
    return;
  }
  if (nodes.size >= maxNodes)
    throw new Error("PROJECT_TOPOLOGY_MAX_NODES_REACHED");
  nodes.set(input.nodeId, {
    ...input,
    sourceRootTaskIds: new Set(input.sourceRootTaskIds),
    sourceArtifactRefIds: new Set(input.sourceArtifactRefIds),
    properties: { ...input.properties },
  });
}

function putEdge(
  edges: Map<string, MutableEdge>,
  input: MutableEdge,
  maxEdges: number,
): void {
  const existing = edges.get(input.edgeId);
  if (existing) {
    if (
      existing.edgeType !== input.edgeType ||
      existing.relationLayer !== input.relationLayer ||
      existing.fromNodeId !== input.fromNodeId ||
      existing.toNodeId !== input.toNodeId
    )
      throw new Error(`PROJECT_TOPOLOGY_EDGE_CONFLICT:${input.edgeId}`);
    input.sourceRootTaskIds.forEach((root) =>
      existing.sourceRootTaskIds.add(root),
    );
    input.sourceArtifactRefIds.forEach((ref) =>
      existing.sourceArtifactRefIds.add(ref),
    );
    input.evidenceRefs.forEach((value, key) =>
      existing.evidenceRefs.set(key, value),
    );
    const observations = Array.isArray(input.properties.observations)
      ? input.properties.observations
      : [];
    for (const observation of observations)
      existing.properties.observations = mergeObservations(
        existing.properties.observations,
        observation,
      );
    return;
  }
  if (edges.size >= maxEdges)
    throw new Error("PROJECT_TOPOLOGY_MAX_EDGES_REACHED");
  edges.set(input.edgeId, input);
}

function freezeNode(node: MutableNode): ProjectTopologyNodeRecord {
  return {
    schemaVersion: PROJECT_TOPOLOGY_SCHEMA_VERSION,
    recordType: "NODE",
    nodeId: node.nodeId,
    nodeType: node.nodeType,
    sourceRootTaskIds: sortedUnique([...node.sourceRootTaskIds]),
    sourceArtifactRefIds: sortedUnique([...node.sourceArtifactRefIds]),
    properties: canonicalProperties(node.properties),
  };
}

function freezeEdge(edge: MutableEdge): ProjectTopologyEdgeRecord {
  return {
    schemaVersion: PROJECT_TOPOLOGY_SCHEMA_VERSION,
    recordType: "EDGE",
    edgeId: edge.edgeId,
    edgeType: edge.edgeType,
    relationLayer: edge.relationLayer,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    sourceRootTaskIds: sortedUnique([...edge.sourceRootTaskIds]),
    sourceArtifactRefIds: sortedUnique([...edge.sourceArtifactRefIds]),
    evidenceRefs: [...edge.evidenceRefs.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, value]) => value),
    properties: canonicalProperties(edge.properties),
  };
}

function evidenceRefsOf(
  values: readonly unknown[],
): ProjectTopologyEvidenceRef[] {
  const refs = new Map<string, ProjectTopologyEvidenceRef>();
  for (const value of values) {
    const record = asRecord(value);
    if (!record) continue;
    const source = text(record.source);
    const provider = text(record.provider);
    const locator = text(record.locator);
    if (!source || !provider || !locator) continue;
    const ref: ProjectTopologyEvidenceRef = {
      source,
      provider,
      locator,
      observedAt:
        record.observedAt === null || typeof record.observedAt === "string"
          ? record.observedAt
          : null,
      contentHash: text(record.contentHash),
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    };
    refs.set(sha256(canonicalJson(ref)), ref);
  }
  return [...refs.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, ref]) => ref);
}

function mergeObservations(current: unknown, next: unknown): unknown[] {
  const values = Array.isArray(current) ? [...current] : [];
  const byHash = new Map<string, unknown>();
  for (const value of [...values, next])
    byHash.set(sha256(canonicalJson(value)), value);
  return [...byHash.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, value]) => value);
}

function canonicalProperties(
  properties: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return JSON.parse(canonicalJson(properties)) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label}_INVALID`);
  return value;
}

export function sourceMultiHopArtifacts(
  projection: ProjectTopologyProjectionV1,
): readonly ProjectTopologyRootSource[] {
  return projection.snapshot.sources;
}

export function projectTopologySourceCounts(
  artifacts: readonly MultiHopReconciliationResult[],
): Readonly<Record<string, number>> {
  return {
    roots: artifacts.length,
    taskNodes: artifacts.reduce(
      (sum, artifact) => sum + artifact.taskNodes.length,
      0,
    ),
    tableNodes: artifacts.reduce(
      (sum, artifact) => sum + artifact.tableNodes.length,
      0,
    ),
    readEdges: artifacts.reduce(
      (sum, artifact) => sum + artifact.readEdges.length,
      0,
    ),
    writeEdges: artifacts.reduce(
      (sum, artifact) => sum + artifact.writeEdges.length,
      0,
    ),
    producerBridges: artifacts.reduce(
      (sum, artifact) => sum + artifact.producerBridges.length,
      0,
    ),
    scheduleEdges: artifacts.reduce(
      (sum, artifact) => sum + artifact.scheduleEdges.length,
      0,
    ),
    terminals: artifacts.reduce(
      (sum, artifact) => sum + artifact.terminals.length,
      0,
    ),
  };
}
