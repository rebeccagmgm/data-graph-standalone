import {
  compareText,
  projectedEdgeId,
  sortedUnique,
  taskNodeId,
} from "../../contracts/project-topology-contract.ts";
import type { TaskLocalUnionDerivedEdge } from "./task-local-union-edges.ts";
import type {
  TaskLocalUnionMergeResult,
  TaskLocalUnionNode,
} from "./task-local-union-merge.ts";

export interface ExportScheduleDependsOnOptions {
  readonly merge: TaskLocalUnionMergeResult;
  /**
   * When true (default), create stub TASK nodes for schedule neighbors that are
   * not already in the union so display edges have endpoints.
   */
  readonly materializeMissingNeighbors?: boolean;
}

export interface ExportScheduleDependsOnResult {
  readonly derivedEdges: readonly TaskLocalUnionDerivedEdge[];
  /** Stub TASK nodes for neighbors not present in the union (display only). */
  readonly neighborNodes: readonly TaskLocalUnionNode[];
}

/**
 * TU-5: optional schedule display edges from TASK.scheduleReference.
 * Never participates in table/field continuation (§5 / TU-4).
 *
 * Direction matches legacy topology: consumer TASK → producer TASK
 * (`SCHEDULE_DEPENDS_ON`).
 */
export function exportScheduleDependsOnEdges(
  options: ExportScheduleDependsOnOptions,
): ExportScheduleDependsOnResult {
  const materialize = options.materializeMissingNeighbors !== false;
  const existingTaskIds = new Set(
    options.merge.nodes
      .filter((node) => node.nodeType === "TASK")
      .map((node) => taskIdFromNodeId(node.nodeId))
      .filter((taskId): taskId is string => taskId !== null),
  );

  const edgeMap = new Map<string, TaskLocalUnionDerivedEdge>();
  const neighborMap = new Map<string, TaskLocalUnionNode>();

  for (const node of options.merge.nodes) {
    if (node.nodeType !== "TASK") continue;
    const consumerTaskId = taskIdFromNodeId(node.nodeId);
    if (!consumerTaskId) continue;
    const reference = readScheduleReference(node.properties.scheduleReference);
    if (!reference) continue;

    for (const producerTaskId of reference.upstreamTaskIds) {
      ensureNeighbor(producerTaskId, existingTaskIds, neighborMap, materialize);
      if (!materialize && !existingTaskIds.has(producerTaskId)) continue;
      putScheduleEdge(edgeMap, {
        fromTaskId: consumerTaskId,
        toTaskId: producerTaskId,
        direction: "UPSTREAM",
      });
    }

    for (const downstreamTaskId of reference.downstreamTaskIds) {
      // Downstream depends on this task → edge downstream → consumer.
      ensureNeighbor(
        downstreamTaskId,
        existingTaskIds,
        neighborMap,
        materialize,
      );
      if (!materialize && !existingTaskIds.has(downstreamTaskId)) continue;
      putScheduleEdge(edgeMap, {
        fromTaskId: downstreamTaskId,
        toTaskId: consumerTaskId,
        direction: "DOWNSTREAM",
      });
    }
  }

  return {
    derivedEdges: [...edgeMap.values()].sort((left, right) =>
      compareText(left.edgeId, right.edgeId),
    ),
    neighborNodes: [...neighborMap.values()].sort((left, right) =>
      compareText(left.nodeId, right.nodeId),
    ),
  };
}

function putScheduleEdge(
  edgeMap: Map<string, TaskLocalUnionDerivedEdge>,
  input: {
    readonly fromTaskId: string;
    readonly toTaskId: string;
    readonly direction: "UPSTREAM" | "DOWNSTREAM";
  },
): void {
  if (input.fromTaskId === input.toTaskId) return;
  const fromNodeId = taskNodeId(input.fromTaskId);
  const toNodeId = taskNodeId(input.toTaskId);
  const edgeId = projectedEdgeId({
    edgeType: "SCHEDULE_DEPENDS_ON",
    fromNodeId,
    toNodeId,
    semanticKey: { provenance: "SCHEDULE_REFERENCE" },
  });
  const existing = edgeMap.get(edgeId);
  if (existing) return;
  edgeMap.set(edgeId, {
    edgeId,
    edgeType: "SCHEDULE_DEPENDS_ON",
    fromNodeId,
    toNodeId,
    properties: {
      provenance: "SCHEDULE_REFERENCE",
      scheduleDirection: input.direction,
    },
    derived: true,
    provenance: "SCHEDULE_REFERENCE",
    evidenceStatus: "CANDIDATE",
  });
}

function ensureNeighbor(
  taskId: string,
  existingTaskIds: Set<string>,
  neighborMap: Map<string, TaskLocalUnionNode>,
  materialize: boolean,
): void {
  if (!materialize || existingTaskIds.has(taskId) || neighborMap.has(taskId)) {
    return;
  }
  neighborMap.set(taskId, {
    nodeId: taskNodeId(taskId),
    nodeType: "TASK",
    properties: {
      coverageStatus: "SCHEDULE_NEIGHBOR",
      scheduleNeighborOnly: true,
    },
    sourceTaskIds: sortedUnique([taskId]),
  });
}

function readScheduleReference(value: unknown): {
  readonly upstreamTaskIds: readonly string[];
  readonly downstreamTaskIds: readonly string[];
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const role = text(record.role);
  if (role !== null && role !== "SCHEDULE_REFERENCE_ONLY") {
    return null;
  }
  return {
    upstreamTaskIds: readTaskIdList(record.upstreamTaskIds),
    downstreamTaskIds: readTaskIdList(record.downstreamTaskIds),
  };
}

function readTaskIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    const taskId = text(item);
    if (taskId) ids.push(taskId);
  }
  return sortedUnique(ids);
}

function taskIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith("task:") ? nodeId.slice("task:".length) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
