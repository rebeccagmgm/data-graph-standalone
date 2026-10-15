import {
  compareText,
  sortedUnique,
} from "../../contracts/project-topology-contract.ts";
import type {
  LoadedTaskLocalUnionSources,
  LoadedTaskLocalUnionTask,
} from "./task-local-union-source.ts";
import {
  normalizeName,
  type TaskLocalUnionEdge,
  type TaskLocalUnionGap,
  type TaskLocalUnionMergeReport,
  type TaskLocalUnionMergeResult,
  type TaskLocalUnionNode,
  type TaskLocalUnionTaskEvidence,
} from "../../../continuation/continuation-input.ts";

export {
  normalizeName,
  type TaskLocalUnionEdge,
  type TaskLocalUnionGap,
  type TaskLocalUnionGapCode,
  type TaskLocalUnionMergeReport,
  type TaskLocalUnionMergeResult,
  type TaskLocalUnionNode,
  type TaskLocalUnionTaskEvidence,
} from "../../../continuation/continuation-input.ts";

export function mergeTaskLocalUnion(
  loaded: LoadedTaskLocalUnionSources,
): TaskLocalUnionMergeResult {
  const nodeMap = new Map<string, TaskLocalUnionNode>();
  const edgeMap = new Map<string, TaskLocalUnionEdge>();
  const gaps: TaskLocalUnionGap[] = [];
  const taskEvidence: TaskLocalUnionTaskEvidence[] = [];
  /** normalized qualifiedName → distinct physical dataset nodeIds + observations */
  const datasetIdentity = new Map<
    string,
    {
      nodeIds: Set<string>;
      observations: Array<{
        taskId: string;
        nodeId: string;
        platform: unknown;
        dataSource: unknown;
        qualifiedName: string;
      }>;
    }
  >();

  let inputNodes = 0;
  let inputEdges = 0;
  let projectedCount = 0;
  let boundaryOnlyCount = 0;

  for (const task of loaded.tasks) {
    taskEvidence.push({
      taskId: task.taskSource.taskId,
      contentHash: task.taskSource.contentHash,
      packContentHash: task.taskSource.packContentHash,
      factsManifestSha256: task.taskSource.factsManifestSha256,
      projectionSchemaVersion: task.projection.schemaVersion,
      coverageStatus: task.taskSource.coverageStatus,
      localClosure: task.projection.localClosure ?? null,
    });
    if (task.boundaryOnly) boundaryOnlyCount += 1;
    else projectedCount += 1;

    const nodes = task.projection.nodes as readonly Record<string, unknown>[];
    const edges = task.boundaryOnly
      ? []
      : (task.projection.edges as readonly Record<string, unknown>[]);

    for (const raw of nodes) {
      inputNodes += 1;
      const node = asUnionNode(raw, task.taskSource.taskId);
      if (task.boundaryOnly && node.nodeType !== "TASK") {
        // Boundary tasks may only contribute the TASK node.
        continue;
      }
      mergeNode(nodeMap, node);
      if (node.nodeType === "PHYSICAL_DATASET") {
        recordDatasetIdentity(datasetIdentity, node, task.taskSource.taskId);
      }
    }

    for (const raw of edges) {
      inputEdges += 1;
      const edge = asUnionEdge(raw, task.taskSource.taskId);
      mergeEdge(edgeMap, edge, gaps);
    }
  }

  for (const [qualifiedName, bucket] of datasetIdentity) {
    if (bucket.nodeIds.size <= 1) continue;
    gaps.push({
      gapId: `dataset-identity-divergent:${qualifiedName}`,
      reasonCode: "DATASET_IDENTITY_DIVERGENT",
      message: `Physical dataset identity diverged for ${qualifiedName}`,
      details: {
        qualifiedName,
        nodeIds: [...bucket.nodeIds].sort(compareText),
        observations: bucket.observations,
      },
    });
  }

  const nodes = [...nodeMap.values()].sort((left, right) =>
    compareText(left.nodeId, right.nodeId),
  );
  const edges = [...edgeMap.values()].sort((left, right) =>
    compareText(left.edgeId, right.edgeId),
  );
  gaps.sort((left, right) => compareText(left.gapId, right.gapId));

  return {
    sourceMode: "TASK_LOCAL_UNION",
    nodes,
    edges,
    producerIndex: loaded.producerIndex,
    batchManifestRef: loaded.batchManifestRef,
    taskEvidence: taskEvidence.sort((left, right) =>
      compareText(left.taskId, right.taskId),
    ),
    report: {
      taskCount: loaded.tasks.length,
      projectedCount,
      boundaryOnlyCount,
      nodeCounts: {
        input: inputNodes,
        output: nodes.length,
        deduped: Math.max(0, inputNodes - nodes.length),
      },
      edgeCounts: {
        input: inputEdges,
        output: edges.length,
        deduped: Math.max(0, inputEdges - edges.length),
      },
      gaps,
    },
  };
}

function asUnionNode(
  raw: Record<string, unknown>,
  taskId: string,
): TaskLocalUnionNode {
  const nodeId = text(raw.nodeId);
  const nodeType = text(raw.nodeType);
  const properties =
    typeof raw.properties === "object" &&
    raw.properties !== null &&
    !Array.isArray(raw.properties)
      ? (raw.properties as Record<string, unknown>)
      : {};
  if (!nodeId || !nodeType) {
    throw new Error(`TASK_LOCAL_UNION_NODE_INVALID:${taskId}`);
  }
  return {
    nodeId,
    nodeType,
    properties,
    sourceTaskIds: [taskId],
  };
}

function asUnionEdge(
  raw: Record<string, unknown>,
  taskId: string,
): TaskLocalUnionEdge {
  const edgeId = text(raw.edgeId);
  const edgeType = text(raw.edgeType);
  const fromNodeId = text(raw.fromNodeId);
  const toNodeId = text(raw.toNodeId);
  const properties =
    typeof raw.properties === "object" &&
    raw.properties !== null &&
    !Array.isArray(raw.properties)
      ? (raw.properties as Record<string, unknown>)
      : {};
  if (!edgeId || !edgeType || !fromNodeId || !toNodeId) {
    throw new Error(`TASK_LOCAL_UNION_EDGE_INVALID:${taskId}`);
  }
  return {
    edgeId,
    edgeType,
    fromNodeId,
    toNodeId,
    properties,
    sourceTaskIds: [taskId],
    derived: false,
  };
}

function mergeNode(
  nodeMap: Map<string, TaskLocalUnionNode>,
  node: TaskLocalUnionNode,
): void {
  const existing = nodeMap.get(node.nodeId);
  if (!existing) {
    nodeMap.set(node.nodeId, node);
    return;
  }
  nodeMap.set(node.nodeId, {
    ...existing,
    sourceTaskIds: sortedUnique([
      ...existing.sourceTaskIds,
      ...node.sourceTaskIds,
    ]),
    // First-writer properties win; identity divergence is tracked separately.
    properties: existing.properties,
  });
}

function mergeEdge(
  edgeMap: Map<string, TaskLocalUnionEdge>,
  edge: TaskLocalUnionEdge,
  gaps: TaskLocalUnionGap[],
): void {
  const existing = edgeMap.get(edge.edgeId);
  if (!existing) {
    edgeMap.set(edge.edgeId, edge);
    return;
  }
  if (
    existing.edgeType !== edge.edgeType ||
    existing.fromNodeId !== edge.fromNodeId ||
    existing.toNodeId !== edge.toNodeId ||
    JSON.stringify(existing.properties) !== JSON.stringify(edge.properties)
  ) {
    gaps.push({
      gapId: `union-edge-conflict:${edge.edgeId}`,
      reasonCode: "UNION_EDGE_CONFLICT",
      message: `Union edge conflict for ${edge.edgeId}`,
      details: {
        edgeId: edge.edgeId,
        left: {
          edgeType: existing.edgeType,
          fromNodeId: existing.fromNodeId,
          toNodeId: existing.toNodeId,
          properties: existing.properties,
          sourceTaskIds: existing.sourceTaskIds,
        },
        right: {
          edgeType: edge.edgeType,
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          properties: edge.properties,
          sourceTaskIds: edge.sourceTaskIds,
        },
      },
    });
    // Keep first occurrence; do not silently overwrite.
    edgeMap.set(edge.edgeId, {
      ...existing,
      sourceTaskIds: sortedUnique([
        ...existing.sourceTaskIds,
        ...edge.sourceTaskIds,
      ]),
    });
    return;
  }
  edgeMap.set(edge.edgeId, {
    ...existing,
    sourceTaskIds: sortedUnique([
      ...existing.sourceTaskIds,
      ...edge.sourceTaskIds,
    ]),
  });
}

function recordDatasetIdentity(
  datasetIdentity: Map<
    string,
    {
      nodeIds: Set<string>;
      observations: Array<{
        taskId: string;
        nodeId: string;
        platform: unknown;
        dataSource: unknown;
        qualifiedName: string;
      }>;
    }
  >,
  node: TaskLocalUnionNode,
  taskId: string,
): void {
  const qualifiedName = text(node.properties.qualifiedName);
  if (!qualifiedName) return;
  const key = normalizeName(qualifiedName);
  const bucket = datasetIdentity.get(key) ?? {
    nodeIds: new Set<string>(),
    observations: [],
  };
  bucket.nodeIds.add(node.nodeId);
  bucket.observations.push({
    taskId,
    nodeId: node.nodeId,
    platform: node.properties.platform ?? null,
    dataSource: node.properties.dataSource ?? null,
    qualifiedName,
  });
  datasetIdentity.set(key, bucket);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Test helper: merge a synthetic list of loaded tasks without disk I/O. */
export function mergeLoadedTasksForTest(
  tasks: readonly LoadedTaskLocalUnionTask[],
): TaskLocalUnionMergeResult {
  return mergeTaskLocalUnion({
    sourceMode: "TASK_LOCAL_UNION",
    batchManifest: {
      schemaVersion: "1.0.0",
      artifactType: "TASK_LOCAL_BATCH_MANIFEST",
      taskIds: tasks.map((task) => task.taskSource.taskId),
      tasks: [],
    },
    batchManifestRef: {
      path: "fixture",
      contentHash: "c".repeat(64),
    },
    producerIndex: {
      contentHash: "d".repeat(64),
      inputFingerprint: "fixture",
    },
    tasks,
  });
}
