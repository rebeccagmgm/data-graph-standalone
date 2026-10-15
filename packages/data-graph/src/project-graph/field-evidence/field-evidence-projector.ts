import { canonicalJson } from "../../contracts/runtime.ts";
import {
  physicalFieldKey,
  type FieldLineageEdge,
  type FieldLineageGap,
  type FieldLineageNode,
  type PhysicalFieldIdentity,
} from "../../contracts/canonical-artifacts.ts";
import {
  compareText,
  sortedUnique,
  taskNodeId,
} from "../contracts/project-topology-contract.ts";
import {
  FIELD_EVIDENCE_PROJECTION_VERSION,
  FIELD_EVIDENCE_SCHEMA_VERSION,
  FIELD_EVIDENCE_SNAPSHOT_TYPE,
  bindingStateNodeId,
  boundaryNodeId,
  candidateNodeId,
  controlNodeId,
  expressionNodeId,
  fieldEvidenceArtifactRefId,
  fieldEvidenceDatasetNodeId,
  fieldEvidenceEdgeId,
  fieldEvidencePhysicalFieldNodeId,
  fieldEvidenceSnapshotContentHash,
  fieldEvidenceSnapshotId,
  gapNodeId,
  normalizedPhysicalField,
  projectSnapshotRefNodeId,
  readOccurrenceNodeId,
  targetWriteNodeId,
  validateFieldEvidenceProjection,
  writeObservationNodeId,
  type FieldEvidenceCoverageStatus,
  type FieldEvidenceEdgeRecord,
  type FieldEvidenceEdgeType,
  type FieldEvidenceNodeRecord,
  type FieldEvidenceNodeType,
  type FieldEvidencePrecisionStatus,
  type FieldEvidenceProjectionV1,
  type FieldEvidenceRelationLayer,
  type FieldEvidenceSnapshotV1,
  type FieldEvidenceTopologyPresence,
} from "./field-evidence-contract.ts";
import {
  physicalFieldMatches,
  type FieldEvidencePrimaryBridge,
  type LoadedFieldEvidenceSource,
} from "./field-evidence-source.ts";

interface PrecisionMatch {
  readonly status: FieldEvidencePrecisionStatus;
  readonly bridge: FieldEvidencePrimaryBridge | null;
  readonly writeObservationId: string | null;
  readonly reason: string | null;
}

export function buildFieldEvidenceProjection(
  source: LoadedFieldEvidenceSource,
): FieldEvidenceProjectionV1 {
  const fieldArtifactRefId = fieldEvidenceArtifactRefId(source.fieldSource);
  const projectArtifactRefId = source.projectSource.snapshotId;
  const sourceRefs = sortedUnique([fieldArtifactRefId, projectArtifactRefId]);
  const selectionForId = {
    rootTaskId: source.rootTaskId,
    writeObservationId: source.writeObservationId,
    target: source.target,
    rootFields: source.rootFields,
  } as const;
  const snapshotId = fieldEvidenceSnapshotId({
    projectKey: source.projectSource.projectKey,
    projectSource: source.projectSource,
    fieldSource: source.fieldSource,
    selection: selectionForId,
    limits: source.limits,
  });
  const nodes = new Map<string, FieldEvidenceNodeRecord>();
  const edges = new Map<string, FieldEvidenceEdgeRecord>();
  const topologyNodeIds = new Set(
    source.project.projection.nodes.map((node) => node.nodeId),
  );
  const fieldNodeById = new Map(
    source.artifact.nodes.map((node) => [node.nodeId, node]),
  );
  const stateIdBySource = new Map(
    source.slice.nodes.map((node) => [
      node.nodeId,
      bindingStateNodeId({
        fieldArtifactContentHash: source.fieldSource.declaredContentHash,
        sourceNodeId: node.nodeId,
      }),
    ]),
  );
  const precisionBoundaryEdgeIds = new Set<string>();
  let exactPrecisionEdges = 0;

  putNode(nodes, {
    nodeId: projectSnapshotRefNodeId(source.projectSource.snapshotId),
    nodeType: "PROJECT_SNAPSHOT_REF",
    sourceArtifactRefIds: [projectArtifactRefId],
    properties: {
      snapshotId: source.projectSource.snapshotId,
      projectKey: source.projectSource.projectKey,
      manifestContentHash: source.projectSource.manifestContentHash,
      logicalLocator: source.projectSource.logicalLocator,
    },
  });

  for (const taskId of source.slice.reachableTaskIds)
    putTaskRef(nodes, taskId, sourceRefs);
  putTaskRef(nodes, source.rootTaskId, sourceRefs);

  const targetDatasetId = putDatasetAndFields(
    nodes,
    edges,
    source.target,
    topologyNodeIds,
    sourceRefs,
    fieldArtifactRefId,
    [],
  );
  const targetWriteId = targetWriteNodeId({
    taskId: source.rootTaskId,
    datasetNodeId: targetDatasetId,
    writeObservationId: source.writeObservationId,
  });
  putNode(nodes, {
    nodeId: targetWriteId,
    nodeType: "TARGET_WRITE",
    sourceArtifactRefIds: [fieldArtifactRefId],
    properties: {
      taskId: source.rootTaskId,
      datasetNodeId: targetDatasetId,
      writeObservationId: source.writeObservationId,
      topologyPresence: topologyPresence(targetDatasetId, topologyNodeIds),
    },
  });
  putSimpleEdge(edges, {
    edgeType: "PROJECT_HAS_FIELD_EVIDENCE",
    relationLayer: "OVERLAY",
    fromNodeId: projectSnapshotRefNodeId(source.projectSource.snapshotId),
    toNodeId: targetWriteId,
    sourceArtifactRefIds: sourceRefs,
  });
  putSimpleEdge(edges, {
    edgeType: "TASK_HAS_TARGET_WRITE",
    relationLayer: "OVERLAY",
    fromNodeId: taskNodeId(source.rootTaskId),
    toNodeId: targetWriteId,
    sourceArtifactRefIds: [fieldArtifactRefId],
  });
  putSimpleEdge(edges, {
    edgeType: "WRITE_TARGETS_DATASET",
    relationLayer: "OVERLAY",
    fromNodeId: targetWriteId,
    toNodeId: targetDatasetId,
    sourceArtifactRefIds: [fieldArtifactRefId],
  });

  for (const node of source.slice.nodes) {
    projectBindingState({
      source,
      node,
      nodes,
      edges,
      stateIdBySource,
      topologyNodeIds,
      sourceRefs,
      fieldArtifactRefId,
    });
  }

  const rootStateIds: Record<string, string> = {};
  for (const rootField of source.rootFields) {
    const rootNode = source.slice.selectedRootNodes[rootField]!;
    const stateId = stateIdBySource.get(rootNode.nodeId)!;
    rootStateIds[rootField] = stateId;
    putSimpleEdge(edges, {
      edgeType: "TARGET_WRITE_HAS_OUTPUT",
      relationLayer: "OVERLAY",
      fromNodeId: targetWriteId,
      toNodeId: stateId,
      sourceArtifactRefIds: [fieldArtifactRefId],
      semanticKey: rootField,
      properties: { rootField },
    });
  }

  for (const edge of source.slice.edges) {
    const fromNode = fieldNodeById.get(edge.fromNodeId)!;
    const toNode = fieldNodeById.get(edge.toNodeId)!;
    const fromStateId = stateIdBySource.get(edge.fromNodeId)!;
    const toStateId = stateIdBySource.get(edge.toNodeId)!;
    const precision = matchPrecision(source, edge, fromNode, toNode);
    const projectedValueEdge = putSimpleEdge(edges, {
      edgeType: "VALUE_FLOW",
      relationLayer: "VALUE_FLOW",
      fromNodeId: fromStateId,
      toNodeId: toStateId,
      sourceArtifactRefIds: [fieldArtifactRefId],
      evidenceRefs: edge.evidenceRefs,
      semanticKey: edge.edgeId,
      properties: {
        sourceEdgeId: edge.edgeId,
        consumerTaskId: edge.consumerTaskId,
        producerTaskId: edge.producerTaskId,
        mapping: edge.mapping,
        evidenceStatus: edge.evidenceStatus,
        precisionStatus: precision.status,
        precisionReason: precision.reason,
      },
    });
    if (precision.status === "EXACT") {
      exactPrecisionEdges += 1;
      projectExactPrecision({
        source,
        precision,
        valueEdgeId: projectedValueEdge.edgeId,
        fromStateId,
        toStateId,
        nodes,
        edges,
        sourceRefs,
      });
    } else if (precision.status === "EVIDENCE_PRECISION_UNAVAILABLE") {
      precisionBoundaryEdgeIds.add(projectedValueEdge.edgeId);
      addBoundary({
        nodes,
        edges,
        snapshotSeed: snapshotId,
        reason: "EVIDENCE_PRECISION_UNAVAILABLE",
        subjectId: toStateId,
        sourceArtifactRefIds: sourceRefs,
        properties: {
          sourceEdgeId: edge.edgeId,
          projectedValueEdgeId: projectedValueEdge.edgeId,
          detail: precision.reason,
          opaqueEvidenceRefs: edge.evidenceRefs,
        },
      });
    }
  }

  const annotationCounts = projectAnnotations({
    source,
    nodes,
    edges,
    stateIdBySource,
    topologyNodeIds,
    sourceRefs,
    fieldArtifactRefId,
    snapshotId,
  });
  for (const reason of source.slice.limitReasons) {
    addBoundary({
      nodes,
      edges,
      snapshotSeed: snapshotId,
      reason,
      subjectId: targetWriteId,
      sourceArtifactRefIds: sourceRefs,
      properties: { limit: reason },
    });
  }

  const evidenceNotConfirmed =
    source.slice.nodes.some((node) => node.evidenceStatus !== "CONFIRMED") ||
    source.slice.edges.some((edge) => edge.evidenceStatus !== "CONFIRMED") ||
    annotationCounts.unconfirmedControls > 0;
  const coverageStatus = conservativeCoverage(
    source.artifact.overallStatus,
    source.slice.truncated ||
      annotationCounts.truncated ||
      annotationCounts.gaps > 0 ||
      precisionBoundaryEdgeIds.size > 0 ||
      evidenceNotConfirmed,
  );
  const snapshotBody: Omit<FieldEvidenceSnapshotV1, "contentHash"> = {
    schemaVersion: FIELD_EVIDENCE_SCHEMA_VERSION,
    artifactType: FIELD_EVIDENCE_SNAPSHOT_TYPE,
    projectionVersion: FIELD_EVIDENCE_PROJECTION_VERSION,
    snapshotId,
    projectKey: source.projectSource.projectKey,
    projectSource: source.projectSource,
    fieldSource: source.fieldSource,
    selection: {
      ...selectionForId,
      rootStateIds: canonicalRecord(rootStateIds) as Readonly<
        Record<string, string>
      >,
    },
    limits: source.limits,
    sourceDiagnostics: {
      overallStatus: source.artifact.overallStatus,
      limits: { ...source.artifact.limits },
      counts: { ...source.artifact.counts },
      boundaries: { ...source.artifact.boundaries },
    },
    slice: {
      sourceOverallStatus: source.artifact.overallStatus,
      sourceTruncated: source.artifact.limits.truncated,
      coverageStatus,
      reachableSourceNodes: source.slice.nodes.length,
      reachableValueEdges: source.slice.edges.length,
      reachableTasks: source.slice.reachableTaskIds.length,
      exactPrecisionEdges,
      precisionBoundaryEdges: precisionBoundaryEdgeIds.size,
      controls: annotationCounts.controls,
      candidates: annotationCounts.candidates,
      gaps: annotationCounts.gaps,
      truncated: source.slice.truncated || annotationCounts.truncated,
      limitReasons: sortedUnique([
        ...source.slice.limitReasons,
        ...annotationCounts.limitReasons,
      ]),
    },
  };
  const projection: FieldEvidenceProjectionV1 = {
    snapshot: {
      ...snapshotBody,
      contentHash: fieldEvidenceSnapshotContentHash(snapshotBody),
    },
    nodes: [...nodes.values()].sort((left, right) =>
      compareText(left.nodeId, right.nodeId),
    ),
    edges: [...edges.values()].sort((left, right) =>
      compareText(left.edgeId, right.edgeId),
    ),
  };
  validateFieldEvidenceProjection(projection);
  return projection;
}

function projectBindingState(input: {
  readonly source: LoadedFieldEvidenceSource;
  readonly node: FieldLineageNode;
  readonly nodes: Map<string, FieldEvidenceNodeRecord>;
  readonly edges: Map<string, FieldEvidenceEdgeRecord>;
  readonly stateIdBySource: ReadonlyMap<string, string>;
  readonly topologyNodeIds: ReadonlySet<string>;
  readonly sourceRefs: readonly string[];
  readonly fieldArtifactRefId: string;
}): void {
  const { node } = input;
  const datasetId = putDatasetAndFields(
    input.nodes,
    input.edges,
    node.field,
    input.topologyNodeIds,
    input.sourceRefs,
    input.fieldArtifactRefId,
    [node.field],
  );
  const fieldId = fieldEvidencePhysicalFieldNodeId(node.field);
  const stateId = input.stateIdBySource.get(node.nodeId)!;
  putNode(input.nodes, {
    nodeId: stateId,
    nodeType: "FIELD_BINDING_STATE",
    sourceArtifactRefIds: [input.fieldArtifactRefId],
    properties: {
      sourceNodeId: node.nodeId,
      taskId: node.taskId,
      taskName: node.taskName,
      depth: node.depth,
      field: normalizedPhysicalField(node.field),
      identityStatus: node.field.identityStatus,
      bindingId: node.bindingId,
      expressionId: node.expressionId,
      expressionText: node.expressionText,
      inputDependencyStatus: node.inputDependencyStatus ?? null,
      evidenceStatus: node.evidenceStatus,
    },
  });
  putSimpleEdge(input.edges, {
    edgeType: "TASK_HAS_STATE",
    relationLayer: "FIELD_IDENTITY",
    fromNodeId: taskNodeId(node.taskId),
    toNodeId: stateId,
    sourceArtifactRefIds: [input.fieldArtifactRefId],
    semanticKey: node.nodeId,
  });
  putSimpleEdge(input.edges, {
    edgeType: "STATE_IDENTIFIES_FIELD",
    relationLayer: "FIELD_IDENTITY",
    fromNodeId: stateId,
    toNodeId: fieldId,
    sourceArtifactRefIds: [input.fieldArtifactRefId],
  });
  if (node.expressionId) {
    const expressionId = expressionNodeId({
      taskId: node.taskId,
      expressionId: node.expressionId,
    });
    putNode(input.nodes, {
      nodeId: expressionId,
      nodeType: "EXPRESSION",
      sourceArtifactRefIds: [input.fieldArtifactRefId],
      properties: {
        taskId: node.taskId,
        expressionId: node.expressionId,
        expressionText: node.expressionText,
      },
    });
    putSimpleEdge(input.edges, {
      edgeType: "STATE_COMPUTED_BY",
      relationLayer: "FIELD_IDENTITY",
      fromNodeId: stateId,
      toNodeId: expressionId,
      sourceArtifactRefIds: [input.fieldArtifactRefId],
    });
  }
  if (datasetId === "") throw new Error("FIELD_EVIDENCE_DATASET_INVALID");
}

function putDatasetAndFields(
  nodes: Map<string, FieldEvidenceNodeRecord>,
  edges: Map<string, FieldEvidenceEdgeRecord>,
  table: {
    readonly platform: string;
    readonly dataSource: string;
    readonly stableTableId: string;
    readonly qualifiedName: string;
  },
  topologyNodeIds: ReadonlySet<string>,
  sourceRefs: readonly string[],
  fieldArtifactRefId: string,
  fields: readonly PhysicalFieldIdentity[],
): string {
  const datasetId = fieldEvidenceDatasetNodeId(table);
  const presence = topologyPresence(datasetId, topologyNodeIds);
  putNode(nodes, {
    nodeId: datasetId,
    nodeType: "PHYSICAL_DATASET",
    sourceArtifactRefIds:
      presence === "PRESENT" ? sourceRefs : [fieldArtifactRefId],
    properties: {
      platform: table.platform.trim().toLowerCase(),
      dataSource: table.dataSource.trim().toLowerCase(),
      qualifiedName: table.qualifiedName.trim().toLowerCase(),
      topologyPresence: presence,
    },
  });
  for (const field of fields) {
    const fieldId = fieldEvidencePhysicalFieldNodeId(field);
    putNode(nodes, {
      nodeId: fieldId,
      nodeType: "PHYSICAL_FIELD",
      sourceArtifactRefIds: [fieldArtifactRefId],
      properties: {
        ...normalizedPhysicalField(field),
        identityStatus: field.identityStatus,
        datasetNodeId: datasetId,
        topologyPresence: presence,
      },
    });
    putSimpleEdge(edges, {
      edgeType: "DATASET_HAS_FIELD",
      relationLayer: "FIELD_IDENTITY",
      fromNodeId: datasetId,
      toNodeId: fieldId,
      sourceArtifactRefIds: [fieldArtifactRefId],
    });
  }
  return datasetId;
}

function matchPrecision(
  source: LoadedFieldEvidenceSource,
  edge: FieldLineageEdge,
  fromNode: FieldLineageNode,
  toNode: FieldLineageNode,
): PrecisionMatch {
  if (
    edge.evidenceStatus !== "CONFIRMED" ||
    !edge.producerTaskId ||
    fromNode.taskId === toNode.taskId
  )
    return {
      status: "NOT_APPLICABLE",
      bridge: null,
      writeObservationId: null,
      reason: null,
    };
  const datasetId = fieldEvidenceDatasetNodeId(toNode.field);
  const bridges = source.primaryBridges.filter(
    (bridge) =>
      bridge.consumerTaskId === edge.consumerTaskId &&
      bridge.producerTaskId === edge.producerTaskId &&
      bridge.datasetNodeId === datasetId &&
      edge.evidenceRefs.includes(bridge.canonicalConsumerReadRef),
  );
  const writeIds = matchProducerWriteIds(
    edge.evidenceRefs,
    edge.producerTaskId,
    fromNode.bindingId,
  );
  if (bridges.length !== 1 || writeIds.length !== 1) {
    return {
      status: "EVIDENCE_PRECISION_UNAVAILABLE",
      bridge: null,
      writeObservationId: null,
      reason: `readMatches=${bridges.length};writeMatches=${writeIds.length}`,
    };
  }
  return {
    status: "EXACT",
    bridge: bridges[0]!,
    writeObservationId: writeIds[0]!,
    reason: null,
  };
}

function matchProducerWriteIds(
  evidenceRefs: readonly string[],
  producerTaskId: string,
  bindingId: string | null,
): string[] {
  if (!bindingId) return [];
  const prefix = `field-lineage:producer-write:${producerTaskId}:`;
  const suffix = `:${bindingId}`;
  const matches = evidenceRefs
    .filter(
      (ref) =>
        ref.startsWith(prefix) &&
        ref.endsWith(suffix) &&
        ref.length > prefix.length + suffix.length,
    )
    .map((ref) => ref.slice(prefix.length, ref.length - suffix.length))
    .filter((writeId) => writeId.trim() !== "");
  return sortedUnique(matches);
}

function projectExactPrecision(input: {
  readonly source: LoadedFieldEvidenceSource;
  readonly precision: PrecisionMatch;
  readonly valueEdgeId: string;
  readonly fromStateId: string;
  readonly toStateId: string;
  readonly nodes: Map<string, FieldEvidenceNodeRecord>;
  readonly edges: Map<string, FieldEvidenceEdgeRecord>;
  readonly sourceRefs: readonly string[];
}): void {
  const bridge = input.precision.bridge!;
  const writeObservationId = input.precision.writeObservationId!;
  const readId = readOccurrenceNodeId({
    consumerTaskId: bridge.consumerTaskId,
    occurrenceId: bridge.occurrenceId,
    readRelationId: bridge.readRelationId,
  });
  const writeId = writeObservationNodeId({
    producerTaskId: bridge.producerTaskId,
    writeObservationId,
  });
  putNode(input.nodes, {
    nodeId: readId,
    nodeType: "READ_OCCURRENCE",
    sourceArtifactRefIds: input.sourceRefs,
    properties: {
      consumerTaskId: bridge.consumerTaskId,
      occurrenceId: bridge.occurrenceId,
      readRelationId: bridge.readRelationId,
      statementIndex: bridge.statementIndex,
      relationPath: bridge.relationPath,
      topologyEdgeId: bridge.topologyEdgeId,
      canonicalEvidenceRef: bridge.canonicalConsumerReadRef,
    },
  });
  putNode(input.nodes, {
    nodeId: writeId,
    nodeType: "WRITE_OBSERVATION",
    sourceArtifactRefIds: [
      fieldEvidenceArtifactRefId(input.source.fieldSource),
    ],
    properties: {
      producerTaskId: bridge.producerTaskId,
      writeObservationId,
    },
  });
  putSimpleEdge(input.edges, {
    edgeType: "VALUE_FLOW_READS_AT",
    relationLayer: "EVIDENCE_PRECISION",
    fromNodeId: input.toStateId,
    toNodeId: readId,
    sourceArtifactRefIds: input.sourceRefs,
    semanticKey: input.valueEdgeId,
    properties: { valueEdgeId: input.valueEdgeId, precisionStatus: "EXACT" },
  });
  putSimpleEdge(input.edges, {
    edgeType: "VALUE_FLOW_WRITTEN_BY",
    relationLayer: "EVIDENCE_PRECISION",
    fromNodeId: input.fromStateId,
    toNodeId: writeId,
    sourceArtifactRefIds: [
      fieldEvidenceArtifactRefId(input.source.fieldSource),
    ],
    semanticKey: input.valueEdgeId,
    properties: { valueEdgeId: input.valueEdgeId, precisionStatus: "EXACT" },
  });
}

function projectAnnotations(input: {
  readonly source: LoadedFieldEvidenceSource;
  readonly nodes: Map<string, FieldEvidenceNodeRecord>;
  readonly edges: Map<string, FieldEvidenceEdgeRecord>;
  readonly stateIdBySource: ReadonlyMap<string, string>;
  readonly topologyNodeIds: ReadonlySet<string>;
  readonly sourceRefs: readonly string[];
  readonly fieldArtifactRefId: string;
  readonly snapshotId: string;
}): {
  readonly controls: number;
  readonly candidates: number;
  readonly gaps: number;
  readonly unconfirmedControls: number;
  readonly truncated: boolean;
  readonly limitReasons: readonly string[];
} {
  const reachableNodeIds = new Set(
    input.source.slice.nodes.map((n) => n.nodeId),
  );
  const reachableTaskIds = new Set(input.source.slice.reachableTaskIds);
  const reachableFields = new Map(
    input.source.slice.nodes.map((node) => [
      physicalFieldKey(node.field),
      node.field,
    ]),
  );
  const controls = input.source.artifact.rowsetControls.filter((control) =>
    reachableNodeIds.has(control.nodeId),
  );
  const gaps = input.source.artifact.gaps.filter(
    (gap) =>
      (gap.nodeId !== null && reachableNodeIds.has(gap.nodeId)) ||
      (gap.nodeId === null && reachableTaskIds.has(gap.taskId)),
  );
  const candidates = input.source.artifact.candidates.filter(
    (candidate) =>
      reachableTaskIds.has(candidate.consumerTaskId) &&
      (candidate.field === null ||
        reachableFields.has(physicalFieldKey(candidate.field))),
  );
  const selectedControls = controls.slice(0, input.source.limits.maxControls);
  const selectedGaps = gaps.slice(0, input.source.limits.maxGaps);
  const selectedCandidates = candidates.slice(
    0,
    input.source.limits.maxCandidates,
  );
  const limitReasons: string[] = [];
  if (selectedControls.length < controls.length)
    limitReasons.push("MAX_CONTROLS_REACHED");
  if (selectedCandidates.length < candidates.length)
    limitReasons.push("MAX_CANDIDATES_REACHED");
  if (selectedGaps.length < gaps.length) limitReasons.push("MAX_GAPS_REACHED");

  for (const control of selectedControls) {
    const nodeId = controlNodeId({
      fieldArtifactContentHash: input.source.fieldSource.declaredContentHash,
      sourceControlId: control.controlId,
    });
    putNode(input.nodes, {
      nodeId,
      nodeType: "ROWSET_CONTROL",
      sourceArtifactRefIds: [input.fieldArtifactRefId],
      properties: {
        sourceControlId: control.controlId,
        taskId: control.taskId,
        sourceNodeId: control.nodeId,
        statementId: control.statementId,
        relationId: control.relationId,
        controlType: control.controlType,
        fields: control.fields.map((field) => ({
          ...normalizedPhysicalField(field),
          identityStatus: field.identityStatus,
        })),
        sourceText: control.sourceText,
        evidenceStatus: control.evidenceStatus,
        reasonCode: control.reasonCode,
        evidenceRefs: control.evidenceRefs,
      },
    });
    putSimpleEdge(input.edges, {
      edgeType: "CONTROL_ANNOTATES_STATE",
      relationLayer: "ANNOTATION",
      fromNodeId: nodeId,
      toNodeId: input.stateIdBySource.get(control.nodeId)!,
      sourceArtifactRefIds: [input.fieldArtifactRefId],
      evidenceRefs: control.evidenceRefs,
    });
  }

  for (const gap of selectedGaps) projectGap(input, gap);

  for (const candidate of selectedCandidates) {
    const nodeId = candidateNodeId({
      fieldArtifactContentHash: input.source.fieldSource.declaredContentHash,
      sourceCandidateId: candidate.candidateId,
    });
    putNode(input.nodes, {
      nodeId,
      nodeType: "CANDIDATE",
      sourceArtifactRefIds: [input.fieldArtifactRefId],
      properties: {
        sourceCandidateId: candidate.candidateId,
        consumerTaskId: candidate.consumerTaskId,
        producerTaskId: candidate.producerTaskId,
        field:
          candidate.field === null
            ? null
            : {
                ...normalizedPhysicalField(candidate.field),
                identityStatus: candidate.field.identityStatus,
              },
        evidenceStatus: candidate.evidenceStatus,
        reasonCode: candidate.reasonCode,
      },
    });
    const fieldId = candidate.field
      ? fieldEvidencePhysicalFieldNodeId(candidate.field)
      : null;
    putSimpleEdge(input.edges, {
      edgeType: fieldId
        ? "EVIDENCE_SCOPED_TO_FIELD"
        : "EVIDENCE_SCOPED_TO_TASK",
      relationLayer: "ANNOTATION",
      fromNodeId: nodeId,
      toNodeId: fieldId ?? taskNodeId(candidate.consumerTaskId),
      sourceArtifactRefIds: [input.fieldArtifactRefId],
    });
  }

  for (const reason of limitReasons) {
    addBoundary({
      nodes: input.nodes,
      edges: input.edges,
      snapshotSeed: input.snapshotId,
      reason,
      subjectId: taskNodeId(input.source.rootTaskId),
      sourceArtifactRefIds: input.sourceRefs,
      properties: { limit: reason },
    });
  }
  return {
    controls: selectedControls.length,
    candidates: selectedCandidates.length,
    gaps: selectedGaps.length,
    unconfirmedControls: selectedControls.filter(
      (control) => control.evidenceStatus !== "CONFIRMED",
    ).length,
    truncated: limitReasons.length > 0,
    limitReasons,
  };
}

function projectGap(
  input: {
    readonly source: LoadedFieldEvidenceSource;
    readonly nodes: Map<string, FieldEvidenceNodeRecord>;
    readonly edges: Map<string, FieldEvidenceEdgeRecord>;
    readonly stateIdBySource: ReadonlyMap<string, string>;
    readonly topologyNodeIds: ReadonlySet<string>;
    readonly sourceRefs: readonly string[];
    readonly fieldArtifactRefId: string;
  },
  gap: FieldLineageGap,
): void {
  const nodeId = gapNodeId({
    fieldArtifactContentHash: input.source.fieldSource.declaredContentHash,
    sourceGapId: gap.gapId,
  });
  putNode(input.nodes, {
    nodeId,
    nodeType: "GAP",
    sourceArtifactRefIds: [input.fieldArtifactRefId],
    properties: {
      sourceGapId: gap.gapId,
      taskId: gap.taskId,
      sourceNodeId: gap.nodeId,
      field:
        gap.field === null
          ? null
          : {
              ...normalizedPhysicalField(gap.field),
              identityStatus: gap.field.identityStatus,
            },
      reasonCode: gap.reasonCode,
      message: gap.message,
      evidenceStatus: gap.evidenceStatus,
      evidenceRefs: gap.evidenceRefs,
    },
  });
  let edgeType: FieldEvidenceEdgeType = "EVIDENCE_SCOPED_TO_TASK";
  let targetId = taskNodeId(gap.taskId);
  if (gap.nodeId && input.stateIdBySource.has(gap.nodeId)) {
    edgeType = "EVIDENCE_SCOPED_TO_STATE";
    targetId = input.stateIdBySource.get(gap.nodeId)!;
  }
  putSimpleEdge(input.edges, {
    edgeType,
    relationLayer: "ANNOTATION",
    fromNodeId: nodeId,
    toNodeId: targetId,
    sourceArtifactRefIds: [input.fieldArtifactRefId],
    evidenceRefs: gap.evidenceRefs,
  });
}

function addBoundary(input: {
  readonly nodes: Map<string, FieldEvidenceNodeRecord>;
  readonly edges: Map<string, FieldEvidenceEdgeRecord>;
  readonly snapshotSeed: string;
  readonly reason: string;
  readonly subjectId: string;
  readonly sourceArtifactRefIds: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}): void {
  const nodeId = boundaryNodeId({
    snapshotSeed: input.snapshotSeed,
    reason: input.reason,
    subject: `${input.subjectId}:${canonicalJson(input.properties)}`,
  });
  putNode(input.nodes, {
    nodeId,
    nodeType: "BOUNDARY",
    sourceArtifactRefIds: input.sourceArtifactRefIds,
    properties: { reason: input.reason, ...input.properties },
  });
  putSimpleEdge(input.edges, {
    edgeType: "HAS_BOUNDARY",
    relationLayer: "BOUNDARY",
    fromNodeId: input.subjectId,
    toNodeId: nodeId,
    sourceArtifactRefIds: input.sourceArtifactRefIds,
    semanticKey: input.properties,
  });
}

function putTaskRef(
  nodes: Map<string, FieldEvidenceNodeRecord>,
  taskId: string,
  sourceArtifactRefIds: readonly string[],
): void {
  putNode(nodes, {
    nodeId: taskNodeId(taskId),
    nodeType: "TASK_REF",
    sourceArtifactRefIds,
    properties: { taskId },
  });
}

function putNode(
  nodes: Map<string, FieldEvidenceNodeRecord>,
  input: Omit<FieldEvidenceNodeRecord, "schemaVersion" | "recordType">,
): FieldEvidenceNodeRecord {
  const record: FieldEvidenceNodeRecord = {
    schemaVersion: FIELD_EVIDENCE_SCHEMA_VERSION,
    recordType: "NODE",
    ...input,
    sourceArtifactRefIds: sortedUnique(input.sourceArtifactRefIds),
    properties: canonicalRecord(input.properties),
  };
  const existing = nodes.get(record.nodeId);
  if (existing && canonicalJson(existing) !== canonicalJson(record))
    throw new Error(`FIELD_EVIDENCE_NODE_CONFLICT:${record.nodeId}`);
  nodes.set(record.nodeId, existing ?? record);
  return existing ?? record;
}

function putSimpleEdge(
  edges: Map<string, FieldEvidenceEdgeRecord>,
  input: {
    readonly edgeType: FieldEvidenceEdgeType;
    readonly relationLayer: FieldEvidenceRelationLayer;
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly sourceArtifactRefIds: readonly string[];
    readonly evidenceRefs?: readonly string[];
    readonly semanticKey?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
  },
): FieldEvidenceEdgeRecord {
  const record: FieldEvidenceEdgeRecord = {
    schemaVersion: FIELD_EVIDENCE_SCHEMA_VERSION,
    recordType: "EDGE",
    edgeId: fieldEvidenceEdgeId({
      edgeType: input.edgeType,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      semanticKey: input.semanticKey,
    }),
    edgeType: input.edgeType,
    relationLayer: input.relationLayer,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    sourceArtifactRefIds: sortedUnique(input.sourceArtifactRefIds),
    evidenceRefs: sortedUnique(input.evidenceRefs ?? []),
    properties: canonicalRecord(input.properties ?? {}),
  };
  const existing = edges.get(record.edgeId);
  if (existing && canonicalJson(existing) !== canonicalJson(record))
    throw new Error(`FIELD_EVIDENCE_EDGE_CONFLICT:${record.edgeId}`);
  edges.set(record.edgeId, existing ?? record);
  return existing ?? record;
}

function topologyPresence(
  datasetNodeId: string,
  topologyNodeIds: ReadonlySet<string>,
): FieldEvidenceTopologyPresence {
  return topologyNodeIds.has(datasetNodeId)
    ? "PRESENT"
    : "NOT_IN_PROJECT_TOPOLOGY";
}

function conservativeCoverage(
  sourceStatus: FieldEvidenceCoverageStatus,
  slicePartial: boolean,
): FieldEvidenceCoverageStatus {
  if (sourceStatus === "BLOCKED") return "BLOCKED";
  if (sourceStatus === "PARTIAL" || slicePartial) return "PARTIAL";
  return "COMPLETE";
}

function canonicalRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

export function fieldEvidenceNodeTypeCounts(
  projection: FieldEvidenceProjectionV1,
): Readonly<Record<FieldEvidenceNodeType, number>> {
  const counts = {} as Record<FieldEvidenceNodeType, number>;
  for (const node of projection.nodes)
    counts[node.nodeType] = (counts[node.nodeType] ?? 0) + 1;
  return counts;
}

export { matchProducerWriteIds, physicalFieldMatches };
