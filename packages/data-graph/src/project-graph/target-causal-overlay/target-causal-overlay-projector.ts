import type { CandidateBranch } from "../../contracts/canonical-artifacts.ts";
import type {
  ChannelAssessment,
  RelationStatus,
  TargetTableAssessment,
} from "../../contracts/canonical-artifacts.ts";
import type { ImpactChannel } from "../../contracts/canonical-artifacts.ts";
import {
  TARGET_CAUSAL_OVERLAY_PROJECTION_VERSION,
  TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
  TARGET_CAUSAL_OVERLAY_SNAPSHOT_TYPE,
  compareText,
  sortedUnique,
  targetCausalArtifactRefId,
  targetCausalOverlayEdgeId,
  targetCausalOverlayNodeId,
  targetCausalOverlaySnapshotContentHash,
  targetCausalOverlaySnapshotId,
  validateTargetCausalOverlayProjection,
  type TargetCausalOverlayEdgeRecord,
  type TargetCausalOverlayEdgeType,
  type TargetCausalOverlayNodeRecord,
  type TargetCausalOverlayNodeType,
  type TargetCausalOverlayProjectionV1,
  type TargetCausalOverlayRelationLayer,
  type TargetCausalOverlaySnapshotV1,
  type TargetCausalOverlaySummary,
} from "./target-causal-overlay-contract.ts";
import type { LoadedTargetCausalOverlaySource } from "./target-causal-overlay-source.ts";

export function buildTargetCausalOverlayProjection(
  source: LoadedTargetCausalOverlaySource,
): TargetCausalOverlayProjectionV1 {
  const nodes = new Map<string, TargetCausalOverlayNodeRecord>();
  const edges = new Map<string, TargetCausalOverlayEdgeRecord>();
  const artifact = source.artifact;
  const causalRefId = targetCausalArtifactRefId(source.causalSource);
  const projectRefId = targetCausalOverlayNodeId("project-ref", {
    snapshotId: source.projectSource.snapshotId,
    manifestSha256: source.projectSource.manifestSha256,
  });
  const fieldRefId = targetCausalOverlayNodeId("field-ref", {
    snapshotId: source.fieldEvidenceSource.snapshotId,
    manifestSha256: source.fieldEvidenceSource.manifestSha256,
  });
  const targetWriteId = targetCausalOverlayNodeId("target-write", {
    targetWriteId: artifact.targetWrite.identity.targetWriteId,
  });
  const allSourceRefs = sortedUnique([
    causalRefId,
    `project-snapshot:${source.projectSource.snapshotId}`,
    `field-evidence-snapshot:${source.fieldEvidenceSource.snapshotId}`,
  ]);
  addNode(nodes, {
    nodeId: projectRefId,
    nodeType: "PROJECT_SNAPSHOT_REF",
    sourceArtifactRefIds: allSourceRefs,
    properties: { ...source.projectSource },
  });
  addNode(nodes, {
    nodeId: fieldRefId,
    nodeType: "FIELD_EVIDENCE_SNAPSHOT_REF",
    sourceArtifactRefIds: allSourceRefs,
    properties: { ...source.fieldEvidenceSource },
  });
  addNode(nodes, {
    nodeId: targetWriteId,
    nodeType: "TARGET_WRITE",
    sourceArtifactRefIds: allSourceRefs,
    properties: {
      ...artifact.targetWrite.identity,
      snapshot: artifact.targetWrite.snapshot,
      runtimeRerunDecision: artifact.runtimeRerunDecision,
    },
  });
  addEdge(edges, {
    edgeType: "PROJECT_HAS_TARGET_CAUSAL_OVERLAY",
    relationLayer: "OVERLAY",
    fromNodeId: projectRefId,
    toNodeId: targetWriteId,
    sourceArtifactRefIds: allSourceRefs,
    evidenceRefs: [],
    properties: {},
  });
  addEdge(edges, {
    edgeType: "FIELD_EVIDENCE_SUPPORTS_TARGET_WRITE",
    relationLayer: "OVERLAY",
    fromNodeId: fieldRefId,
    toNodeId: targetWriteId,
    sourceArtifactRefIds: allSourceRefs,
    evidenceRefs: [],
    properties: {
      fieldLineageHash: artifact.targetWrite.snapshot.fieldLineageHash,
    },
  });

  const rollupByTask = new Map(
    artifact.taskRollup.map((rollup) => [rollup.producerTaskId, rollup]),
  );
  const taskIds = sortedUnique([
    artifact.targetWrite.identity.taskId,
    ...artifact.taskRollup.map(({ producerTaskId }) => producerTaskId),
    ...artifact.candidateUniverse.branches.flatMap((branch) =>
      [branch.consumerTaskId, branch.producerTaskId].filter(
        (value): value is string => value !== null,
      ),
    ),
  ]);
  const taskNodeIds = new Map<string, string>();
  for (const taskId of taskIds) {
    const rollup = rollupByTask.get(taskId);
    const nodeId = targetCausalOverlayNodeId("task-ref", { taskId });
    taskNodeIds.set(taskId, nodeId);
    addNode(nodes, {
      nodeId,
      nodeType: "TASK_REF",
      sourceArtifactRefIds: [causalRefId],
      properties: {
        taskId,
        isTargetTask: taskId === artifact.targetWrite.identity.taskId,
        inMinimumCertainSet: artifact.minimumCertainTaskIds.includes(taskId),
        inConservativeSafetySet:
          artifact.conservativeSafetyTaskIds.includes(taskId),
        ...(rollup
          ? {
              relationStatus: rollup.relationStatus,
              branchIds: rollup.branchIds,
              impactChannels: rollup.impactChannels,
              evidenceRefs: rollup.evidenceRefs,
              gapRefs: rollup.gapRefs,
            }
          : {}),
      },
    });
  }
  addEdge(edges, {
    edgeType: "TARGET_WRITE_OWNED_BY_TASK",
    relationLayer: "TASK_SCOPE",
    fromNodeId: targetWriteId,
    toNodeId: taskNodeIds.get(artifact.targetWrite.identity.taskId)!,
    sourceArtifactRefIds: [causalRefId],
    evidenceRefs: [],
    properties: {},
  });

  const gapNodeIds = new Map<string, string>();
  for (const gap of artifact.gaps) {
    const nodeId = targetCausalOverlayNodeId("gap", {
      causalArtifactHash: source.causalSource.declaredContentHash,
      gapId: gap.gapId,
    });
    gapNodeIds.set(gap.gapId, nodeId);
    addNode(nodes, {
      nodeId,
      nodeType: "GAP",
      sourceArtifactRefIds: [causalRefId],
      properties: gap,
    });
  }

  const branchNodeIds = new Map<string, string>();
  for (const branch of artifact.candidateUniverse.branches) {
    const nodeId = branchNodeId(source, branch);
    branchNodeIds.set(branch.candidateBranchId, nodeId);
    addNode(nodes, {
      nodeId,
      nodeType: "CANDIDATE_BRANCH",
      sourceArtifactRefIds: [causalRefId],
      properties: { ...branch },
    });
    if (branch.producerTaskId)
      addEdge(edges, {
        edgeType: "BRANCH_PRODUCED_BY_TASK",
        relationLayer: "TASK_SCOPE",
        fromNodeId: nodeId,
        toNodeId: taskNodeIds.get(branch.producerTaskId)!,
        sourceArtifactRefIds: [causalRefId],
        evidenceRefs: [],
        properties: { producerRole: branch.producerRole },
      });
    if (branch.consumerTaskId)
      addEdge(edges, {
        edgeType: "BRANCH_CONSUMED_BY_TASK",
        relationLayer: "TASK_SCOPE",
        fromNodeId: nodeId,
        toNodeId: taskNodeIds.get(branch.consumerTaskId)!,
        sourceArtifactRefIds: [causalRefId],
        evidenceRefs: [],
        properties: {},
      });
    for (const gapRef of branch.gapRefs)
      addGapEdge(
        edges,
        "BRANCH_HAS_GAP",
        nodeId,
        gapRef,
        gapNodeIds,
        causalRefId,
      );
  }

  for (const assessment of artifact.assessments) {
    const assessmentNodeId = targetCausalOverlayNodeId("causal-assessment", {
      assessmentId: assessment.assessmentId,
    });
    addNode(nodes, {
      nodeId: assessmentNodeId,
      nodeType: "CAUSAL_ASSESSMENT",
      sourceArtifactRefIds: [causalRefId],
      properties: {
        assessmentId: assessment.assessmentId,
        targetWriteId: assessment.targetWriteId,
        candidateBranchId: assessment.candidateBranchId,
        relationStatus: assessment.relationStatus,
        evidenceRefs: assessment.evidenceRefs,
        gapRefs: assessment.gapRefs,
        negativeProofCount: assessment.negativeProofs.length,
      },
    });
    addEdge(edges, {
      edgeType: "TARGET_WRITE_HAS_ASSESSMENT",
      relationLayer: "ASSESSMENT",
      fromNodeId: targetWriteId,
      toNodeId: assessmentNodeId,
      sourceArtifactRefIds: [causalRefId],
      evidenceRefs: [],
      properties: { relationStatus: assessment.relationStatus },
    });
    addEdge(edges, {
      edgeType: "ASSESSES_BRANCH",
      relationLayer: "ASSESSMENT",
      fromNodeId: assessmentNodeId,
      toNodeId: branchNodeIds.get(assessment.candidateBranchId)!,
      sourceArtifactRefIds: [causalRefId],
      evidenceRefs: [],
      properties: { relationStatus: assessment.relationStatus },
    });
    for (const gapRef of assessment.gapRefs)
      addGapEdge(
        edges,
        "ASSESSMENT_HAS_GAP",
        assessmentNodeId,
        gapRef,
        gapNodeIds,
        causalRefId,
      );
    for (const channel of assessment.channelAssessments)
      addChannel({
        nodes,
        edges,
        assessment,
        assessmentNodeId,
        channel,
        causalRefId,
        gapNodeIds,
      });
  }

  const summary = causalSummary(source);
  const snapshotId = targetCausalOverlaySnapshotId({
    projectKey: source.project.projection.snapshot.projectKey,
    projectSource: source.projectSource,
    fieldEvidenceSource: source.fieldEvidenceSource,
    causalSource: source.causalSource,
    targetWriteId: artifact.targetWrite.identity.targetWriteId,
  });
  const snapshotBody = {
    schemaVersion: TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
    artifactType: TARGET_CAUSAL_OVERLAY_SNAPSHOT_TYPE,
    projectionVersion: TARGET_CAUSAL_OVERLAY_PROJECTION_VERSION,
    snapshotId,
    projectKey: source.project.projection.snapshot.projectKey,
    projectSource: source.projectSource,
    fieldEvidenceSource: source.fieldEvidenceSource,
    causalSource: source.causalSource,
    targetWrite: {
      targetWriteId: artifact.targetWrite.identity.targetWriteId,
      taskId: artifact.targetWrite.identity.taskId,
      targetTableKey: artifact.targetWrite.identity.targetTableKey,
      writeObservationId: artifact.targetWrite.identity.writeObservationId,
    },
    runtimeRerunDecision: "NOT_EVALUATED",
    sourceValidation: {
      topologyAndFieldHashes: "MATCHED",
      causalArtifactHash: "MATCHED",
      historicalProducerIndexReplay: "NOT_ATTEMPTED",
    },
    summary,
  } as const;
  const snapshot: TargetCausalOverlaySnapshotV1 = {
    ...snapshotBody,
    contentHash: targetCausalOverlaySnapshotContentHash(snapshotBody),
  };
  const projection: TargetCausalOverlayProjectionV1 = {
    snapshot,
    nodes: [...nodes.values()].sort((left, right) =>
      compareText(left.nodeId, right.nodeId),
    ),
    edges: [...edges.values()].sort((left, right) =>
      compareText(left.edgeId, right.edgeId),
    ),
  };
  validateTargetCausalOverlayProjection(projection);
  return projection;
}

function addChannel(input: {
  readonly nodes: Map<string, TargetCausalOverlayNodeRecord>;
  readonly edges: Map<string, TargetCausalOverlayEdgeRecord>;
  readonly assessment: TargetTableAssessment;
  readonly assessmentNodeId: string;
  readonly channel: ChannelAssessment;
  readonly causalRefId: string;
  readonly gapNodeIds: ReadonlyMap<string, string>;
}): void {
  const nodeId = targetCausalOverlayNodeId("channel-assessment", {
    assessmentId: input.assessment.assessmentId,
    channel: input.channel.channel,
  });
  addNode(input.nodes, {
    nodeId,
    nodeType: "CHANNEL_ASSESSMENT",
    sourceArtifactRefIds: [input.causalRefId],
    properties: {
      assessmentId: input.assessment.assessmentId,
      candidateBranchId: input.assessment.candidateBranchId,
      ...input.channel,
    },
  });
  addEdge(input.edges, {
    edgeType: "HAS_CHANNEL_ASSESSMENT",
    relationLayer: "CHANNEL",
    fromNodeId: input.assessmentNodeId,
    toNodeId: nodeId,
    sourceArtifactRefIds: [input.causalRefId],
    evidenceRefs: [],
    properties: {
      channel: input.channel.channel,
      status: input.channel.status,
    },
  });
  for (const gapRef of input.channel.gapRefs)
    addGapEdge(
      input.edges,
      "CHANNEL_HAS_GAP",
      nodeId,
      gapRef,
      input.gapNodeIds,
      input.causalRefId,
    );
}

function branchNodeId(
  source: LoadedTargetCausalOverlaySource,
  branch: CandidateBranch,
): string {
  return targetCausalOverlayNodeId("candidate-branch", {
    causalArtifactHash: source.causalSource.declaredContentHash,
    candidateBranchId: branch.candidateBranchId,
  });
}

function addGapEdge(
  edges: Map<string, TargetCausalOverlayEdgeRecord>,
  edgeType: "ASSESSMENT_HAS_GAP" | "CHANNEL_HAS_GAP" | "BRANCH_HAS_GAP",
  fromNodeId: string,
  gapRef: string,
  gapNodeIds: ReadonlyMap<string, string>,
  causalRefId: string,
): void {
  const gapNodeId = gapNodeIds.get(gapRef);
  if (!gapNodeId)
    throw new Error(`TARGET_CAUSAL_OVERLAY_GAP_NODE_MISSING:${gapRef}`);
  addEdge(edges, {
    edgeType,
    relationLayer: "BOUNDARY",
    fromNodeId,
    toNodeId: gapNodeId,
    sourceArtifactRefIds: [causalRefId],
    evidenceRefs: [],
    properties: { gapRef },
  });
}

function addNode(
  nodes: Map<string, TargetCausalOverlayNodeRecord>,
  input: Omit<TargetCausalOverlayNodeRecord, "schemaVersion" | "recordType">,
): void {
  const record: TargetCausalOverlayNodeRecord = {
    schemaVersion: TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
    recordType: "NODE",
    ...input,
    sourceArtifactRefIds: sortedUnique(input.sourceArtifactRefIds),
  };
  const previous = nodes.get(record.nodeId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(record))
    throw new Error(`TARGET_CAUSAL_OVERLAY_NODE_CONFLICT:${record.nodeId}`);
  nodes.set(record.nodeId, record);
}

function addEdge(
  edges: Map<string, TargetCausalOverlayEdgeRecord>,
  input: Omit<
    TargetCausalOverlayEdgeRecord,
    "schemaVersion" | "recordType" | "edgeId"
  > & { readonly edgeType: TargetCausalOverlayEdgeType },
): void {
  const edgeId = targetCausalOverlayEdgeId({
    edgeType: input.edgeType,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    semanticKey: input.properties,
  });
  const record: TargetCausalOverlayEdgeRecord = {
    schemaVersion: TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
    recordType: "EDGE",
    edgeId,
    ...input,
    sourceArtifactRefIds: sortedUnique(input.sourceArtifactRefIds),
    evidenceRefs: sortedUnique(input.evidenceRefs),
  };
  const previous = edges.get(record.edgeId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(record))
    throw new Error(`TARGET_CAUSAL_OVERLAY_EDGE_CONFLICT:${record.edgeId}`);
  edges.set(record.edgeId, record);
}

function causalSummary(
  source: LoadedTargetCausalOverlaySource,
): TargetCausalOverlaySummary {
  const artifact = source.artifact;
  const relationStatusCounts: Record<RelationStatus, number> = {
    CONFIRMED_RELATED: 0,
    CONDITIONAL_RELATED: 0,
    PROVEN_UNRELATED: 0,
    UNKNOWN: 0,
  };
  const channelStatusCounts = {
    CONFIRMED: 0,
    CONDITIONAL: 0,
    PROVEN_ABSENT: 0,
    UNKNOWN: 0,
    NOT_APPLICABLE: 0,
  };
  for (const assessment of artifact.assessments) {
    relationStatusCounts[assessment.relationStatus] += 1;
    for (const channel of assessment.channelAssessments)
      channelStatusCounts[channel.status] += 1;
  }
  const negativeProofs = artifact.assessments.reduce(
    (count, assessment) => count + assessment.negativeProofs.length,
    0,
  );
  const complete =
    artifact.candidateUniverse.status === "COMPLETE_OBSERVED_EVIDENCE" &&
    relationStatusCounts.UNKNOWN === 0 &&
    relationStatusCounts.CONDITIONAL_RELATED === 0 &&
    artifact.gaps.length === 0;
  return {
    candidateUniverseStatus: artifact.candidateUniverse.status,
    coverageStatus: complete ? "COMPLETE" : "PARTIAL",
    candidateBranches: artifact.candidateUniverse.branches.length,
    assessments: artifact.assessments.length,
    relationStatusCounts,
    channelStatusCounts,
    upstreamTasks: artifact.taskRollup.length,
    minimumCertainTasks: artifact.minimumCertainTaskIds.length,
    conservativeSafetyTasks: artifact.conservativeSafetyTaskIds.length,
    gaps: artifact.gaps.length,
    negativeProofs,
  };
}

export type {
  TargetCausalOverlayNodeType,
  TargetCausalOverlayRelationLayer,
  ImpactChannel,
};
