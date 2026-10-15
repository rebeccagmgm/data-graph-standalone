import { canonicalJson, sha256 } from "../../contracts/runtime.ts";
import {
  compareText,
  projectKeySegment,
  sortedUnique,
  stableId,
} from "../contracts/project-topology-contract.ts";
import type {
  ChannelStatus,
  RelationStatus,
} from "../../contracts/canonical-artifacts.ts";
import type { ImpactChannel } from "../../contracts/canonical-artifacts.ts";

export const TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION = "1.0.0" as const;
export const TARGET_CAUSAL_OVERLAY_PROJECTION_VERSION = "1.0.1" as const;
export const TARGET_CAUSAL_OVERLAY_SNAPSHOT_TYPE =
  "TARGET_CAUSAL_OVERLAY_SNAPSHOT" as const;
export const TARGET_CAUSAL_OVERLAY_MANIFEST_TYPE =
  "TARGET_CAUSAL_OVERLAY_PROJECTION_MANIFEST" as const;

export type TargetCausalOverlayCoverageStatus = "COMPLETE" | "PARTIAL";
export type TargetCausalOverlayQueryStatus =
  "ok" | "partial" | "not_found" | "ambiguous" | "error";

export type TargetCausalOverlayNodeType =
  | "PROJECT_SNAPSHOT_REF"
  | "FIELD_EVIDENCE_SNAPSHOT_REF"
  | "TARGET_WRITE"
  | "TASK_REF"
  | "CANDIDATE_BRANCH"
  | "CAUSAL_ASSESSMENT"
  | "CHANNEL_ASSESSMENT"
  | "GAP";

export type TargetCausalOverlayEdgeType =
  | "PROJECT_HAS_TARGET_CAUSAL_OVERLAY"
  | "FIELD_EVIDENCE_SUPPORTS_TARGET_WRITE"
  | "TARGET_WRITE_OWNED_BY_TASK"
  | "TARGET_WRITE_HAS_ASSESSMENT"
  | "ASSESSES_BRANCH"
  | "HAS_CHANNEL_ASSESSMENT"
  | "BRANCH_PRODUCED_BY_TASK"
  | "BRANCH_CONSUMED_BY_TASK"
  | "ASSESSMENT_HAS_GAP"
  | "CHANNEL_HAS_GAP"
  | "BRANCH_HAS_GAP";

export type TargetCausalOverlayRelationLayer =
  "OVERLAY" | "ASSESSMENT" | "CHANNEL" | "TASK_SCOPE" | "BOUNDARY";

export interface TargetCausalOverlaySourceFileRef {
  readonly fileName: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly recordCount: number | null;
}

export interface TargetCausalOverlayProjectSourceRef {
  readonly projectKey: string;
  readonly snapshotId: string;
  readonly manifestContentHash: string;
  readonly manifestSha256: string;
  readonly snapshotSha256: string;
  readonly nodesSha256: string;
  readonly edgesSha256: string;
  readonly logicalLocator: string;
}

export interface TargetCausalOverlayFieldSourceRef {
  readonly snapshotId: string;
  readonly manifestContentHash: string;
  readonly manifestSha256: string;
  readonly snapshotSha256: string;
  readonly nodesSha256: string;
  readonly edgesSha256: string;
  readonly fieldArtifactContentSha256: string;
  readonly logicalLocator: string;
}

export interface TargetCausalOverlayArtifactSourceRef {
  readonly schemaVersion: string;
  readonly artifactType: "TARGET_TABLE_UPSTREAM_CAUSAL_CLOSURE";
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly declaredContentHash: string;
  readonly generatedAt: string;
  readonly logicalLocator: string;
}

export interface TargetCausalOverlaySummary {
  readonly candidateUniverseStatus: "COMPLETE_OBSERVED_EVIDENCE" | "INCOMPLETE";
  readonly coverageStatus: TargetCausalOverlayCoverageStatus;
  readonly candidateBranches: number;
  readonly assessments: number;
  readonly relationStatusCounts: Readonly<Record<RelationStatus, number>>;
  readonly channelStatusCounts: Readonly<Record<ChannelStatus, number>>;
  readonly upstreamTasks: number;
  readonly minimumCertainTasks: number;
  readonly conservativeSafetyTasks: number;
  readonly gaps: number;
  readonly negativeProofs: number;
}

export interface TargetCausalOverlaySnapshotV1 {
  readonly schemaVersion: typeof TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION;
  readonly artifactType: typeof TARGET_CAUSAL_OVERLAY_SNAPSHOT_TYPE;
  readonly projectionVersion: typeof TARGET_CAUSAL_OVERLAY_PROJECTION_VERSION;
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly projectSource: TargetCausalOverlayProjectSourceRef;
  readonly fieldEvidenceSource: TargetCausalOverlayFieldSourceRef;
  readonly causalSource: TargetCausalOverlayArtifactSourceRef;
  readonly targetWrite: {
    readonly targetWriteId: string;
    readonly taskId: string;
    readonly targetTableKey: string;
    readonly writeObservationId: string;
  };
  readonly runtimeRerunDecision: "NOT_EVALUATED";
  readonly sourceValidation: {
    readonly topologyAndFieldHashes: "MATCHED";
    readonly causalArtifactHash: "MATCHED";
    readonly historicalProducerIndexReplay: "NOT_ATTEMPTED";
  };
  readonly summary: TargetCausalOverlaySummary;
  readonly contentHash: string;
}

export interface TargetCausalOverlayNodeRecord {
  readonly schemaVersion: typeof TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION;
  readonly recordType: "NODE";
  readonly nodeId: string;
  readonly nodeType: TargetCausalOverlayNodeType;
  readonly sourceArtifactRefIds: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface TargetCausalOverlayEdgeRecord {
  readonly schemaVersion: typeof TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION;
  readonly recordType: "EDGE";
  readonly edgeId: string;
  readonly edgeType: TargetCausalOverlayEdgeType;
  readonly relationLayer: TargetCausalOverlayRelationLayer;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly sourceArtifactRefIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface TargetCausalOverlayProjectionV1 {
  readonly snapshot: TargetCausalOverlaySnapshotV1;
  readonly nodes: readonly TargetCausalOverlayNodeRecord[];
  readonly edges: readonly TargetCausalOverlayEdgeRecord[];
}

export interface TargetCausalOverlayProjectionManifestV1 {
  readonly schemaVersion: typeof TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION;
  readonly artifactType: typeof TARGET_CAUSAL_OVERLAY_MANIFEST_TYPE;
  readonly projectionVersion: typeof TARGET_CAUSAL_OVERLAY_PROJECTION_VERSION;
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly snapshotContentHash: string;
  readonly coverageStatus: TargetCausalOverlayCoverageStatus;
  readonly targetWriteId: string;
  readonly runtimeRerunDecision: "NOT_EVALUATED";
  readonly counts: {
    readonly nodes: number;
    readonly edges: number;
    readonly boundaries: number;
  };
  readonly files: {
    readonly snapshot: TargetCausalOverlaySourceFileRef;
    readonly nodes: TargetCausalOverlaySourceFileRef;
    readonly edges: TargetCausalOverlaySourceFileRef;
  };
  readonly contentHash: string;
}

export interface TargetCausalOverlayQueryEnvelope<T> {
  readonly schemaVersion: typeof TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION;
  readonly query:
    | "get_target_causal_overlay"
    | "get_target_causal_task_rollup"
    | "explain_target_causal_assessment";
  readonly status: TargetCausalOverlayQueryStatus;
  readonly snapshotId: string;
  readonly result: T;
  readonly warnings: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export function targetCausalArtifactRefId(
  source: TargetCausalOverlayArtifactSourceRef,
): string {
  return stableId("target-causal-artifact", {
    contentSha256: source.contentSha256,
    declaredContentHash: source.declaredContentHash,
  });
}

export function targetCausalOverlayNodeId(
  kind:
    | "project-ref"
    | "field-ref"
    | "target-write"
    | "task-ref"
    | "candidate-branch"
    | "causal-assessment"
    | "channel-assessment"
    | "gap",
  identity: unknown,
): string {
  return stableId(kind, identity);
}

export function targetCausalOverlayEdgeId(input: {
  readonly edgeType: TargetCausalOverlayEdgeType;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly semanticKey?: unknown;
}): string {
  return stableId("target-causal-edge", input);
}

export function targetCausalOverlaySnapshotId(input: {
  readonly projectKey: string;
  readonly projectSource: TargetCausalOverlayProjectSourceRef;
  readonly fieldEvidenceSource: TargetCausalOverlayFieldSourceRef;
  readonly causalSource: TargetCausalOverlayArtifactSourceRef;
  readonly targetWriteId: string;
}): string {
  projectKeySegment(input.projectKey);
  return `target-causal-overlay-${sha256(
    canonicalJson({
      projectionVersion: TARGET_CAUSAL_OVERLAY_PROJECTION_VERSION,
      projectKey: input.projectKey,
      projectSnapshotId: input.projectSource.snapshotId,
      projectManifestSha256: input.projectSource.manifestSha256,
      fieldSnapshotId: input.fieldEvidenceSource.snapshotId,
      fieldManifestSha256: input.fieldEvidenceSource.manifestSha256,
      causalContentSha256: input.causalSource.contentSha256,
      causalDeclaredContentHash: input.causalSource.declaredContentHash,
      targetWriteId: input.targetWriteId,
    }),
  )}`;
}

export function targetCausalOverlaySnapshotContentHash(
  snapshot: Omit<TargetCausalOverlaySnapshotV1, "contentHash">,
): string {
  return sha256(canonicalJson(snapshot));
}

export function targetCausalOverlayManifestContentHash(
  manifest: Omit<TargetCausalOverlayProjectionManifestV1, "contentHash">,
): string {
  return sha256(canonicalJson(manifest));
}

export function validateTargetCausalOverlayProjection(
  projection: TargetCausalOverlayProjectionV1,
): void {
  const { snapshot, nodes, edges } = projection;
  if (
    snapshot.schemaVersion !== TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION ||
    snapshot.artifactType !== TARGET_CAUSAL_OVERLAY_SNAPSHOT_TYPE ||
    snapshot.projectionVersion !== TARGET_CAUSAL_OVERLAY_PROJECTION_VERSION ||
    snapshot.runtimeRerunDecision !== "NOT_EVALUATED"
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_SNAPSHOT_CONTRACT_INVALID");
  projectKeySegment(snapshot.projectKey);
  if (snapshot.projectSource.projectKey !== snapshot.projectKey)
    throw new Error("TARGET_CAUSAL_OVERLAY_PROJECT_KEY_MISMATCH");
  const expectedSnapshotId = targetCausalOverlaySnapshotId({
    projectKey: snapshot.projectKey,
    projectSource: snapshot.projectSource,
    fieldEvidenceSource: snapshot.fieldEvidenceSource,
    causalSource: snapshot.causalSource,
    targetWriteId: snapshot.targetWrite.targetWriteId,
  });
  if (snapshot.snapshotId !== expectedSnapshotId)
    throw new Error("TARGET_CAUSAL_OVERLAY_SNAPSHOT_ID_INVALID");
  const { contentHash: _contentHash, ...snapshotBody } = snapshot;
  if (
    targetCausalOverlaySnapshotContentHash(snapshotBody) !==
    snapshot.contentHash
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_SNAPSHOT_HASH_INVALID");
  assertSortedUniqueRecords(nodes, "nodeId", "NODES");
  assertSortedUniqueRecords(edges, "edgeId", "EDGES");
  const nodeIds = new Set(nodes.map(({ nodeId }) => nodeId));
  for (const node of nodes) {
    if (
      node.schemaVersion !== TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION ||
      node.recordType !== "NODE"
    )
      throw new Error("TARGET_CAUSAL_OVERLAY_NODE_CONTRACT_INVALID");
    assertSorted(node.sourceArtifactRefIds, "NODE_SOURCE_ARTIFACT_REFS");
  }
  for (const edge of edges) {
    if (
      edge.schemaVersion !== TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION ||
      edge.recordType !== "EDGE"
    )
      throw new Error("TARGET_CAUSAL_OVERLAY_EDGE_CONTRACT_INVALID");
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))
      throw new Error(
        `TARGET_CAUSAL_OVERLAY_EDGE_ENDPOINT_MISSING:${edge.edgeId}`,
      );
    assertSorted(edge.sourceArtifactRefIds, "EDGE_SOURCE_ARTIFACT_REFS");
    assertSorted(edge.evidenceRefs, "EDGE_EVIDENCE_REFS");
  }
  if (nodes.filter(({ nodeType }) => nodeType === "TARGET_WRITE").length !== 1)
    throw new Error("TARGET_CAUSAL_OVERLAY_TARGET_WRITE_CARDINALITY_INVALID");
  if (
    nodes.filter(({ nodeType }) => nodeType === "CAUSAL_ASSESSMENT").length !==
      snapshot.summary.assessments ||
    nodes.filter(({ nodeType }) => nodeType === "CANDIDATE_BRANCH").length !==
      snapshot.summary.candidateBranches ||
    nodes.filter(({ nodeType }) => nodeType === "GAP").length !==
      snapshot.summary.gaps
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_SUMMARY_COUNT_MISMATCH");
}

function assertSorted(values: readonly string[], label: string): void {
  if (canonicalJson(values) !== canonicalJson(sortedUnique(values)))
    throw new Error(`TARGET_CAUSAL_OVERLAY_${label}_INVALID`);
}

function assertSortedUniqueRecords<
  T extends Record<K, string>,
  K extends keyof T,
>(values: readonly T[], key: K, label: string): void {
  const actual = values.map((value) => value[key]);
  if (canonicalJson(actual) !== canonicalJson(sortedUnique(actual)))
    throw new Error(`TARGET_CAUSAL_OVERLAY_${label}_ORDER_INVALID`);
}

export { compareText, sortedUnique, stableId };
export type { ImpactChannel };
