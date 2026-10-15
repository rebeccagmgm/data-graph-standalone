import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { sha256 } from "../../contracts/runtime.ts";
import {
  canonicalAssessment,
  canonicalizeTargetTableArtifact,
  TARGET_TABLE_CAUSAL_CLOSURE_ARTIFACT_TYPE,
  TARGET_TABLE_CAUSAL_CLOSURE_SCHEMA_VERSION,
  validateCausalClosure,
  type TargetTableCausalClosureArtifact,
} from "../../contracts/canonical-artifacts.ts";
import {
  FIELD_EVIDENCE_MANIFEST_FILE,
  loadFieldEvidenceDirectory,
  type LoadedFieldEvidenceDirectory,
} from "../field-evidence/field-evidence-publication.ts";
import {
  PROJECT_TOPOLOGY_MANIFEST_FILE,
  loadProjectTopologyDirectory,
  type LoadedProjectTopologyDirectory,
} from "../topology/project-topology-publication.ts";
import { taskNodeId } from "../contracts/project-topology-contract.ts";
import {
  type TargetCausalOverlayArtifactSourceRef,
  type TargetCausalOverlayFieldSourceRef,
  type TargetCausalOverlayProjectSourceRef,
} from "./target-causal-overlay-contract.ts";

export const TARGET_CAUSAL_OVERLAY_SOURCE_CONTRACT = Object.freeze({
  externalCalls: 0,
  topologyMutation: false,
  fieldEvidenceMutation: false,
  causalArtifactMutation: false,
  runtimeInference: "DISABLED",
  negativeProofs: "DISABLED",
  historicalProducerIndexReplay: "NOT_ATTEMPTED",
} as const);

export interface LoadTargetCausalOverlaySourceInput {
  readonly projectTopologyDirectory: string;
  readonly fieldEvidenceDirectory: string;
  readonly causalArtifactPath: string;
  readonly limits?: {
    readonly maxFileBytes?: number;
  };
}

export interface LoadedTargetCausalOverlaySource {
  readonly project: LoadedProjectTopologyDirectory;
  readonly fieldEvidence: LoadedFieldEvidenceDirectory;
  readonly artifact: TargetTableCausalClosureArtifact;
  readonly projectSource: TargetCausalOverlayProjectSourceRef;
  readonly fieldEvidenceSource: TargetCausalOverlayFieldSourceRef;
  readonly causalSource: TargetCausalOverlayArtifactSourceRef;
}

export function loadTargetCausalOverlaySource(
  input: LoadTargetCausalOverlaySourceInput,
): LoadedTargetCausalOverlaySource {
  const maxFileBytes = positiveLimit(
    input.limits?.maxFileBytes ?? 512 * 1024 * 1024,
  );
  const project = loadProjectTopologyDirectory(input.projectTopologyDirectory, {
    maxFileBytes,
  });
  const fieldEvidence = loadFieldEvidenceDirectory(
    input.fieldEvidenceDirectory,
    { maxFileBytes },
  );
  const causalPath = resolve(input.causalArtifactPath);
  const causalBytes = readBounded(causalPath, maxFileBytes);
  const artifact = parseCausalArtifact(causalBytes);
  validateTargetTableCausalArtifact(artifact);
  const projectSource = projectSourceRef(project);
  const fieldEvidenceSource = fieldSourceRef(fieldEvidence);
  const causalSource: TargetCausalOverlayArtifactSourceRef = {
    schemaVersion: artifact.schemaVersion,
    artifactType: artifact.artifactType,
    contentSha256: sha256(causalBytes),
    byteLength: causalBytes.byteLength,
    declaredContentHash: artifact.contentHash,
    generatedAt: artifact.generatedAt,
    logicalLocator: basename(causalPath),
  };
  assertSourcesAlign({
    project,
    fieldEvidence,
    artifact,
    projectSource,
    fieldEvidenceSource,
  });
  return {
    project,
    fieldEvidence,
    artifact,
    projectSource,
    fieldEvidenceSource,
    causalSource,
  };
}

export function validateTargetTableCausalArtifact(
  artifact: TargetTableCausalClosureArtifact,
): void {
  if (
    artifact.schemaVersion !== TARGET_TABLE_CAUSAL_CLOSURE_SCHEMA_VERSION ||
    artifact.artifactType !== TARGET_TABLE_CAUSAL_CLOSURE_ARTIFACT_TYPE ||
    artifact.runtimeRerunDecision !== "NOT_EVALUATED"
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_CAUSAL_CONTRACT_INVALID");
  const { contentHash: _contentHash, ...body } = artifact;
  if (
    canonicalizeTargetTableArtifact(body).contentHash !== artifact.contentHash
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_CAUSAL_HASH_INVALID");
  const targetWriteId = artifact.targetWrite.identity.targetWriteId;
  if (
    artifact.targetWrite.identity.taskId !==
    artifact.candidateUniverse.rootTaskId
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_CAUSAL_ROOT_TASK_MISMATCH");
  const validation = validateCausalClosure({
    targetWriteId,
    universe: artifact.candidateUniverse,
    assessments: artifact.assessments,
  });
  if (!validation.valid)
    throw new Error(
      `TARGET_CAUSAL_OVERLAY_CAUSAL_VALIDATION_FAILED:${validation.errors[0]}`,
    );
  const branchIds = new Set(
    artifact.candidateUniverse.branches.map(
      ({ candidateBranchId }) => candidateBranchId,
    ),
  );
  if (
    branchIds.size !== artifact.candidateUniverse.branches.length ||
    artifact.assessments.length !== branchIds.size ||
    artifact.metrics.candidateBranchCount !== branchIds.size ||
    artifact.metrics.assessmentCount !== artifact.assessments.length
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_CAUSAL_COUNT_MISMATCH");
  for (const assessment of artifact.assessments) {
    const { assessmentId: _assessmentId, ...assessmentBody } = assessment;
    if (
      canonicalAssessment(assessmentBody).assessmentId !==
      assessment.assessmentId
    )
      throw new Error(
        `TARGET_CAUSAL_OVERLAY_ASSESSMENT_ID_INVALID:${assessment.assessmentId}`,
      );
    if (
      assessment.relationStatus === "PROVEN_UNRELATED" ||
      assessment.negativeProofs.length > 0
    )
      throw new Error("TARGET_CAUSAL_OVERLAY_NEGATIVE_PROOF_DISABLED");
    if (
      assessment.relationStatus === "CONFIRMED_RELATED" &&
      assessment.evidenceRefs.length === 0
    )
      throw new Error(
        `TARGET_CAUSAL_OVERLAY_CONFIRMED_WITHOUT_EVIDENCE:${assessment.assessmentId}`,
      );
  }
  const gapIds = new Set(artifact.gaps.map(({ gapId }) => gapId));
  if (gapIds.size !== artifact.gaps.length)
    throw new Error("TARGET_CAUSAL_OVERLAY_CAUSAL_GAP_DUPLICATE");
  const referencedGaps = [
    ...artifact.candidateUniverse.boundaryGapRefs,
    ...artifact.candidateUniverse.branches.flatMap(({ gapRefs }) => gapRefs),
    ...artifact.assessments.flatMap((assessment) => [
      ...assessment.gapRefs,
      ...assessment.channelAssessments.flatMap(({ gapRefs }) => gapRefs),
    ]),
    ...artifact.taskRollup.flatMap(({ gapRefs }) => gapRefs),
  ];
  const missingGap = referencedGaps.find((gapId) => !gapIds.has(gapId));
  if (missingGap)
    throw new Error(
      `TARGET_CAUSAL_OVERLAY_REFERENCED_GAP_MISSING:${missingGap}`,
    );
  const rollupTaskIds = new Set(
    artifact.taskRollup.map(({ producerTaskId }) => producerTaskId),
  );
  if (
    rollupTaskIds.size !== artifact.taskRollup.length ||
    artifact.metrics.upstreamTaskCount !== artifact.taskRollup.length
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_TASK_ROLLUP_COUNT_MISMATCH");
  for (const taskId of [
    ...artifact.minimumCertainTaskIds,
    ...artifact.conservativeSafetyTaskIds,
  ])
    if (!rollupTaskIds.has(taskId))
      throw new Error(
        `TARGET_CAUSAL_OVERLAY_TASK_SET_MEMBER_MISSING:${taskId}`,
      );
}

function assertSourcesAlign(input: {
  readonly project: LoadedProjectTopologyDirectory;
  readonly fieldEvidence: LoadedFieldEvidenceDirectory;
  readonly artifact: TargetTableCausalClosureArtifact;
  readonly projectSource: TargetCausalOverlayProjectSourceRef;
  readonly fieldEvidenceSource: TargetCausalOverlayFieldSourceRef;
}): void {
  const { project, fieldEvidence, artifact } = input;
  const identity = artifact.targetWrite.identity;
  const projectSnapshot = project.projection.snapshot;
  const fieldSnapshot = fieldEvidence.projection.snapshot;
  if (
    projectSnapshot.projectKey !== fieldSnapshot.projectKey ||
    fieldSnapshot.projectSource.projectKey !== projectSnapshot.projectKey ||
    fieldSnapshot.projectSource.snapshotId !== projectSnapshot.snapshotId ||
    fieldSnapshot.projectSource.manifestContentHash !==
      project.manifest.contentHash ||
    fieldSnapshot.projectSource.manifestSha256 !==
      input.projectSource.manifestSha256 ||
    fieldSnapshot.projectSource.snapshotSha256 !==
      input.projectSource.snapshotSha256 ||
    fieldSnapshot.projectSource.nodesSha256 !==
      input.projectSource.nodesSha256 ||
    fieldSnapshot.projectSource.edgesSha256 !== input.projectSource.edgesSha256
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_FIELD_TOPOLOGY_MISMATCH");
  if (
    fieldSnapshot.selection.rootTaskId !== identity.taskId ||
    fieldSnapshot.selection.writeObservationId !==
      identity.writeObservationId ||
    normalize(fieldSnapshot.selection.target.qualifiedName) !==
      normalize(identity.targetTableKey)
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_TARGET_WRITE_MISMATCH");
  if (
    !projectSnapshot.rootTaskIds.includes(identity.taskId) ||
    !project.projection.nodes.some(
      ({ nodeId }) => nodeId === taskNodeId(identity.taskId),
    )
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_TARGET_TASK_MISSING");
  const rootSource = projectSnapshot.sources.find(
    ({ rootTaskId }) => rootTaskId === identity.taskId,
  );
  if (
    rootSource === undefined ||
    rootSource.multiHop.contentSha256 !==
      artifact.targetWrite.snapshot.tableMultiHopHash
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_MULTI_HOP_HASH_MISMATCH");
  if (
    artifact.targetWrite.snapshot.fieldLineageHash === undefined ||
    fieldSnapshot.fieldSource.contentSha256 !==
      artifact.targetWrite.snapshot.fieldLineageHash ||
    input.fieldEvidenceSource.fieldArtifactContentSha256 !==
      artifact.targetWrite.snapshot.fieldLineageHash
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_FIELD_HASH_MISMATCH");
}

function projectSourceRef(
  source: LoadedProjectTopologyDirectory,
): TargetCausalOverlayProjectSourceRef {
  return {
    projectKey: source.manifest.projectKey,
    snapshotId: source.manifest.snapshotId,
    manifestContentHash: source.manifest.contentHash,
    manifestSha256: fileSha(
      join(source.directory, PROJECT_TOPOLOGY_MANIFEST_FILE),
    ),
    snapshotSha256: source.manifest.files.snapshot.sha256,
    nodesSha256: source.manifest.files.nodes.sha256,
    edgesSha256: source.manifest.files.edges.sha256,
    logicalLocator: source.manifest.snapshotId,
  };
}

function fieldSourceRef(
  source: LoadedFieldEvidenceDirectory,
): TargetCausalOverlayFieldSourceRef {
  return {
    snapshotId: source.manifest.snapshotId,
    manifestContentHash: source.manifest.contentHash,
    manifestSha256: fileSha(
      join(source.directory, FIELD_EVIDENCE_MANIFEST_FILE),
    ),
    snapshotSha256: source.manifest.files.snapshot.sha256,
    nodesSha256: source.manifest.files.nodes.sha256,
    edgesSha256: source.manifest.files.edges.sha256,
    fieldArtifactContentSha256:
      source.projection.snapshot.fieldSource.contentSha256,
    logicalLocator: source.manifest.snapshotId,
  };
}

function parseCausalArtifact(bytes: Buffer): TargetTableCausalClosureArtifact {
  try {
    return JSON.parse(
      bytes.toString("utf8"),
    ) as TargetTableCausalClosureArtifact;
  } catch {
    throw new Error("TARGET_CAUSAL_OVERLAY_CAUSAL_JSON_INVALID");
  }
}

function readBounded(path: string, maxFileBytes: number): Buffer {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error("TARGET_CAUSAL_OVERLAY_CAUSAL_FILE_MISSING");
  }
  if (size > maxFileBytes)
    throw new Error("TARGET_CAUSAL_OVERLAY_SOURCE_FILE_LIMIT");
  return readFileSync(path);
}

function fileSha(path: string): string {
  return sha256(readFileSync(path));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("TARGET_CAUSAL_OVERLAY_MAX_FILE_BYTES_INVALID");
  return value;
}
