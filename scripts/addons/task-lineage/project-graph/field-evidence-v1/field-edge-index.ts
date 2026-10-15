import { normalizeName } from "../../../../machine-facts/machine-facts-contract.ts";
import type { JsonRecord } from "../../../../query/current-task-bundle.ts";
import type {
  TaskLocalEdge,
  TaskLocalNode,
  TaskLocalProjection,
  TaskLocalProjectionGap,
} from "../../../../project-graph/task-local/contract.ts";
import {
  buildRelationTreeIndex,
  type RelationTreeIndex,
  withIncomingRelations,
} from "../../../../project-graph/task-local/field-evidence/relation-tree.ts";

export interface IndexedFieldEdge {
  readonly edgeId: string;
  readonly edgeType: "FIELD_DIRECT" | "FIELD_CONDITIONAL";
  readonly writeObservationId: string;
  readonly outputColumn: string;
  readonly sourceQualifiedName: string;
  readonly sourceColumn: string;
  readonly sourceReadOccurrenceId: string | null;
  readonly sourceReadOccurrenceStatus: string;
  readonly sourceRelationId: string | null;
  readonly expressionId: string;
  readonly subtype: string;
  readonly subtypeReason?: string;
  readonly bindingId?: string;
}

export interface IndexedControlEdge {
  readonly edgeId: string;
  readonly writeObservationId: string;
  readonly subtype: string;
  readonly joinType: string;
  readonly controlSide: string;
  readonly relationId: string;
  readonly statementId: string;
  readonly grain: string;
  readonly grainReason?: string;
  readonly leftRelationId: string | null;
  readonly rightRelationId: string | null;
  readonly sourceQualifiedName: string;
  readonly sourceColumn: string;
}

export interface FieldEdgeIndex {
  readonly taskId: string;
  readonly projection: TaskLocalProjection;
  readonly relationTree: RelationTreeIndex;
  readonly gaps: readonly TaskLocalProjectionGap[];
  edgesForBinding(
    writeObservationId: string,
    outputColumn: string,
  ): readonly IndexedFieldEdge[];
  controlsForWrite(writeObservationId: string): readonly IndexedControlEdge[];
  targetWriteNodeId(writeObservationId: string): string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nodeById(nodes: readonly TaskLocalNode[]): Map<string, TaskLocalNode> {
  return new Map(nodes.map((node) => [node.nodeId, node]));
}

function writeObservationForTarget(
  nodes: Map<string, TaskLocalNode>,
  targetWriteNodeId: string,
): string | null {
  return text(nodes.get(targetWriteNodeId)?.properties.writeObservationId);
}

function physicalFieldFromNode(node: TaskLocalNode | undefined): {
  readonly qualifiedName: string;
  readonly column: string;
} | null {
  if (!node || node.nodeType !== "PHYSICAL_FIELD") return null;
  const qualifiedName = text(node.properties.qualifiedName);
  const column = text(node.properties.column);
  if (!qualifiedName || !column) return null;
  return { qualifiedName, column };
}

function parseFieldEdge(
  edge: TaskLocalEdge,
  nodes: Map<string, TaskLocalNode>,
): IndexedFieldEdge | null {
  if (edge.edgeType !== "FIELD_DIRECT" && edge.edgeType !== "FIELD_CONDITIONAL") {
    return null;
  }
  const writeObservationId = writeObservationForTarget(nodes, edge.toNodeId);
  const outputColumn = text(edge.properties.outputColumn);
  const expressionId = text(edge.properties.expressionId);
  if (!writeObservationId || !outputColumn || !expressionId) return null;
  const source = physicalFieldFromNode(nodes.get(edge.fromNodeId));
  if (!source) return null;
  return {
    edgeId: edge.edgeId,
    edgeType: edge.edgeType,
    writeObservationId,
    outputColumn: normalizeName(outputColumn),
    sourceQualifiedName: normalizeName(source.qualifiedName),
    sourceColumn: normalizeName(source.column),
    sourceReadOccurrenceId: text(edge.properties.sourceReadOccurrenceId),
    sourceReadOccurrenceStatus: String(
      edge.properties.sourceReadOccurrenceStatus ?? "UNRESOLVED",
    ),
    sourceRelationId: text(edge.properties.sourceRelationId),
    expressionId,
    subtype: String(edge.properties.subtype ?? "UNKNOWN"),
    ...(text(edge.properties.subtypeReason)
      ? { subtypeReason: text(edge.properties.subtypeReason)! }
      : {}),
    ...(text(edge.properties.bindingId)
      ? { bindingId: text(edge.properties.bindingId)! }
      : {}),
  };
}

function parseControlEdge(
  edge: TaskLocalEdge,
  nodes: Map<string, TaskLocalNode>,
): IndexedControlEdge | null {
  if (edge.edgeType !== "DATASET_CONTROL") return null;
  const writeObservationId = text(edge.properties.writeObservationId)
    ?? writeObservationForTarget(nodes, edge.toNodeId);
  const relationId = text(edge.properties.relationId);
  const statementId = text(edge.properties.statementId);
  if (!writeObservationId || !relationId || !statementId) return null;
  const source = physicalFieldFromNode(nodes.get(edge.fromNodeId));
  if (!source) return null;
  return {
    edgeId: edge.edgeId,
    writeObservationId,
    subtype: String(edge.properties.subtype ?? ""),
    joinType: String(edge.properties.joinType ?? "N/A"),
    controlSide: String(edge.properties.controlSide ?? "N/A"),
    relationId,
    statementId,
    grain: String(edge.properties.grain ?? "PRESERVE"),
    ...(text(edge.properties.grainReason)
      ? { grainReason: text(edge.properties.grainReason)! }
      : {}),
    leftRelationId: text(edge.properties.leftRelationId),
    rightRelationId: text(edge.properties.rightRelationId),
    sourceQualifiedName: normalizeName(source.qualifiedName),
    sourceColumn: normalizeName(source.column),
  };
}

export function buildFieldEdgeIndex(input: {
  readonly projection: TaskLocalProjection;
  readonly relationNodes?: readonly JsonRecord[];
  readonly relationEdges?: readonly JsonRecord[];
}): FieldEdgeIndex {
  const nodes = nodeById(input.projection.nodes);
  const relationTree = withIncomingRelations(
    buildRelationTreeIndex(input.relationNodes ?? []),
    input.relationEdges ?? [],
  );

  const byBinding = new Map<string, IndexedFieldEdge[]>();
  const controlsByWrite = new Map<string, IndexedControlEdge[]>();
  const writeNodeByObservation = new Map<string, string>();

  for (const node of input.projection.nodes) {
    if (node.nodeType !== "TARGET_WRITE") continue;
    const writeObservationId = text(node.properties.writeObservationId);
    if (writeObservationId) writeNodeByObservation.set(writeObservationId, node.nodeId);
  }

  for (const edge of input.projection.edges) {
    const field = parseFieldEdge(edge, nodes);
    if (field) {
      const key = `${field.writeObservationId}\u0000${field.outputColumn}`;
      const bucket = byBinding.get(key) ?? [];
      bucket.push(field);
      byBinding.set(key, bucket);
      continue;
    }
    const control = parseControlEdge(edge, nodes);
    if (control) {
      const bucket = controlsByWrite.get(control.writeObservationId) ?? [];
      bucket.push(control);
      controlsByWrite.set(control.writeObservationId, bucket);
    }
  }

  for (const bucket of byBinding.values()) {
    bucket.sort((left, right) =>
      left.expressionId.localeCompare(right.expressionId)
      || (left.sourceRelationId ?? "").localeCompare(right.sourceRelationId ?? ""),
    );
  }
  for (const bucket of controlsByWrite.values()) {
    bucket.sort((left, right) =>
      left.relationId.localeCompare(right.relationId)
      || left.sourceColumn.localeCompare(right.sourceColumn),
    );
  }

  return {
    taskId: input.projection.taskId,
    projection: input.projection,
    relationTree,
    gaps: input.projection.gaps ?? [],
    edgesForBinding(writeObservationId, outputColumn) {
      return byBinding.get(
        `${writeObservationId}\u0000${normalizeName(outputColumn)}`,
      ) ?? [];
    },
    controlsForWrite(writeObservationId) {
      return controlsByWrite.get(writeObservationId) ?? [];
    },
    targetWriteNodeId(writeObservationId) {
      return writeNodeByObservation.get(writeObservationId) ?? null;
    },
  };
}

export function materializationBreakGapForDataset(
  index: FieldEdgeIndex,
  physicalDataset: string,
): TaskLocalProjectionGap | undefined {
  const normalized = normalizeName(physicalDataset);
  return index.gaps.find(
    (gap) =>
      gap.reasonCode === "TASK_LOCAL_MATERIALIZATION_FIELD_BREAK"
      && normalizeName(String(gap.details.physicalDataset ?? "")) === normalized,
  );
}

export function readOccurrenceGapsForFieldEdge(
  index: FieldEdgeIndex,
  edge: IndexedFieldEdge,
): readonly TaskLocalProjectionGap[] {
  if (edge.sourceReadOccurrenceStatus === "RESOLVED") return [];
  const reason =
    edge.sourceReadOccurrenceStatus === "AMBIGUOUS"
      ? "FIELD_SOURCE_READ_OCCURRENCE_AMBIGUOUS"
      : "FIELD_SOURCE_READ_OCCURRENCE_UNRESOLVED";
  return index.gaps.filter((gap) => {
    if (gap.reasonCode !== reason) return false;
    const details = gap.details;
    return (
      text(details.expressionId) === edge.expressionId
      && normalizeName(String(details.sourceTable ?? "")) === edge.sourceQualifiedName
      && normalizeName(String(details.sourceColumn ?? "")) === edge.sourceColumn
    );
  });
}
