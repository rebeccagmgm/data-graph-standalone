import { canonicalJson, sha256 } from "../../contracts/runtime.ts";
import {
  compareText,
  physicalDatasetNodeId,
  projectKeySegment,
  sortedUnique,
  stableId,
  taskNodeId,
} from "../contracts/project-topology-contract.ts";

export const FIELD_EVIDENCE_SCHEMA_VERSION = "1.0.0" as const;
export const FIELD_EVIDENCE_PROJECTION_VERSION = "1.0.0" as const;
export const FIELD_EVIDENCE_SNAPSHOT_TYPE = "FIELD_EVIDENCE_SNAPSHOT" as const;
export const FIELD_EVIDENCE_MANIFEST_TYPE =
  "FIELD_EVIDENCE_PROJECTION_MANIFEST" as const;

export type FieldEvidenceCoverageStatus = "COMPLETE" | "PARTIAL" | "BLOCKED";
export type FieldEvidenceTopologyPresence =
  "PRESENT" | "NOT_IN_PROJECT_TOPOLOGY";
export type FieldEvidencePrecisionStatus =
  "EXACT" | "NOT_APPLICABLE" | "EVIDENCE_PRECISION_UNAVAILABLE";
export type FieldEvidenceQueryStatus =
  "ok" | "partial" | "not_found" | "ambiguous" | "error";

export type FieldEvidenceNodeType =
  | "PROJECT_SNAPSHOT_REF"
  | "TASK_REF"
  | "PHYSICAL_DATASET"
  | "PHYSICAL_FIELD"
  | "TARGET_WRITE"
  | "FIELD_BINDING_STATE"
  | "EXPRESSION"
  | "READ_OCCURRENCE"
  | "WRITE_OBSERVATION"
  | "ROWSET_CONTROL"
  | "CANDIDATE"
  | "GAP"
  | "BOUNDARY";

export type FieldEvidenceEdgeType =
  | "PROJECT_HAS_FIELD_EVIDENCE"
  | "TASK_HAS_TARGET_WRITE"
  | "WRITE_TARGETS_DATASET"
  | "TARGET_WRITE_HAS_OUTPUT"
  | "TASK_HAS_STATE"
  | "STATE_IDENTIFIES_FIELD"
  | "DATASET_HAS_FIELD"
  | "STATE_COMPUTED_BY"
  | "VALUE_FLOW"
  | "VALUE_FLOW_READS_AT"
  | "VALUE_FLOW_WRITTEN_BY"
  | "CONTROL_ANNOTATES_STATE"
  | "EVIDENCE_SCOPED_TO_TASK"
  | "EVIDENCE_SCOPED_TO_FIELD"
  | "EVIDENCE_SCOPED_TO_STATE"
  | "HAS_BOUNDARY";

export type FieldEvidenceRelationLayer =
  | "OVERLAY"
  | "FIELD_IDENTITY"
  | "VALUE_FLOW"
  | "EVIDENCE_PRECISION"
  | "ANNOTATION"
  | "BOUNDARY";

export interface FieldEvidenceProjectionLimits {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxPaths: number;
  readonly maxControls: number;
  readonly maxCandidates: number;
  readonly maxGaps: number;
}

export interface FieldEvidenceProjectSourceRef {
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly manifestContentHash: string;
  readonly manifestSha256: string;
  readonly snapshotSha256: string;
  readonly nodesSha256: string;
  readonly edgesSha256: string;
  readonly logicalLocator: string;
}

export interface FieldEvidenceArtifactSourceRef {
  readonly schemaVersion: string;
  readonly artifactType: "FIELD_MULTI_HOP_RECONCILIATION";
  readonly rootTaskId: string;
  readonly contentSha256: string;
  readonly declaredContentHash: string;
  readonly logicalLocator: string;
}

export interface FieldEvidenceTargetIdentity {
  readonly platform: string;
  readonly dataSource: string;
  readonly stableTableId: string;
  readonly qualifiedName: string;
}

export interface FieldEvidenceSelection {
  readonly rootTaskId: string;
  readonly writeObservationId: string;
  readonly target: FieldEvidenceTargetIdentity;
  readonly rootFields: readonly string[];
  readonly rootStateIds: Readonly<Record<string, string>>;
}

export interface FieldEvidenceSliceSummary {
  readonly sourceOverallStatus: FieldEvidenceCoverageStatus;
  readonly sourceTruncated: boolean;
  readonly coverageStatus: FieldEvidenceCoverageStatus;
  readonly reachableSourceNodes: number;
  readonly reachableValueEdges: number;
  readonly reachableTasks: number;
  readonly exactPrecisionEdges: number;
  readonly precisionBoundaryEdges: number;
  readonly controls: number;
  readonly candidates: number;
  readonly gaps: number;
  readonly truncated: boolean;
  readonly limitReasons: readonly string[];
}

export interface FieldEvidenceSnapshotV1 {
  readonly schemaVersion: typeof FIELD_EVIDENCE_SCHEMA_VERSION;
  readonly artifactType: typeof FIELD_EVIDENCE_SNAPSHOT_TYPE;
  readonly projectionVersion: typeof FIELD_EVIDENCE_PROJECTION_VERSION;
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly projectSource: FieldEvidenceProjectSourceRef;
  readonly fieldSource: FieldEvidenceArtifactSourceRef;
  readonly selection: FieldEvidenceSelection;
  readonly limits: FieldEvidenceProjectionLimits;
  readonly sourceDiagnostics: {
    readonly overallStatus: FieldEvidenceCoverageStatus;
    readonly limits: Readonly<Record<string, unknown>>;
    readonly counts: Readonly<Record<string, number>>;
    readonly boundaries: Readonly<Record<string, unknown>>;
  };
  readonly slice: FieldEvidenceSliceSummary;
  readonly contentHash: string;
}

export interface FieldEvidenceNodeRecord {
  readonly schemaVersion: typeof FIELD_EVIDENCE_SCHEMA_VERSION;
  readonly recordType: "NODE";
  readonly nodeId: string;
  readonly nodeType: FieldEvidenceNodeType;
  readonly sourceArtifactRefIds: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface FieldEvidenceEdgeRecord {
  readonly schemaVersion: typeof FIELD_EVIDENCE_SCHEMA_VERSION;
  readonly recordType: "EDGE";
  readonly edgeId: string;
  readonly edgeType: FieldEvidenceEdgeType;
  readonly relationLayer: FieldEvidenceRelationLayer;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly sourceArtifactRefIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface FieldEvidenceProjectionV1 {
  readonly snapshot: FieldEvidenceSnapshotV1;
  readonly nodes: readonly FieldEvidenceNodeRecord[];
  readonly edges: readonly FieldEvidenceEdgeRecord[];
}

export interface FieldEvidencePublishedFile {
  readonly fileName: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly recordCount: number | null;
}

export interface FieldEvidenceProjectionManifestV1 {
  readonly schemaVersion: typeof FIELD_EVIDENCE_SCHEMA_VERSION;
  readonly artifactType: typeof FIELD_EVIDENCE_MANIFEST_TYPE;
  readonly projectionVersion: typeof FIELD_EVIDENCE_PROJECTION_VERSION;
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly snapshotContentHash: string;
  readonly coverageStatus: FieldEvidenceCoverageStatus;
  readonly selection: FieldEvidenceSelection;
  readonly limits: FieldEvidenceProjectionLimits;
  readonly counts: {
    readonly nodes: number;
    readonly edges: number;
    readonly boundaries: number;
  };
  readonly files: {
    readonly snapshot: FieldEvidencePublishedFile;
    readonly nodes: FieldEvidencePublishedFile;
    readonly edges: FieldEvidencePublishedFile;
  };
  readonly contentHash: string;
}

export interface FieldEvidenceQueryEnvelope<T> {
  readonly schemaVersion: typeof FIELD_EVIDENCE_SCHEMA_VERSION;
  readonly query:
    | "get_field_evidence"
    | "trace_field_value_path"
    | "explain_field_evidence_record";
  readonly status: FieldEvidenceQueryStatus;
  readonly snapshotId: string;
  readonly result: T;
  readonly warnings: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export function fieldEvidenceArtifactRefId(
  source: FieldEvidenceArtifactSourceRef,
): string {
  return stableId("field-artifact", {
    contentSha256: source.contentSha256,
    declaredContentHash: source.declaredContentHash,
  });
}

export function projectSnapshotRefNodeId(snapshotId: string): string {
  return `project-ref:${snapshotId}`;
}

export function fieldEvidenceDatasetNodeId(input: {
  readonly platform: string;
  readonly dataSource: string;
  readonly qualifiedName: string;
}): string {
  return physicalDatasetNodeId(input);
}

export function fieldEvidencePhysicalFieldNodeId(input: {
  readonly platform: string;
  readonly dataSource: string;
  readonly stableTableId: string;
  readonly qualifiedName: string;
  readonly column: string;
}): string {
  return stableId("physical-field", normalizedPhysicalField(input));
}

export function targetWriteNodeId(input: {
  readonly taskId: string;
  readonly datasetNodeId: string;
  readonly writeObservationId: string;
}): string {
  return stableId("target-write", input);
}

export function bindingStateNodeId(input: {
  readonly fieldArtifactContentHash: string;
  readonly sourceNodeId: string;
}): string {
  return stableId("binding-state", input);
}

export function expressionNodeId(input: {
  readonly taskId: string;
  readonly expressionId: string;
}): string {
  return stableId("expression", input);
}

export function readOccurrenceNodeId(input: {
  readonly consumerTaskId: string;
  readonly occurrenceId: string;
  readonly readRelationId: string;
}): string {
  return stableId("read-occurrence", input);
}

export function writeObservationNodeId(input: {
  readonly producerTaskId: string;
  readonly writeObservationId: string;
}): string {
  return stableId("write-observation", input);
}

export function controlNodeId(input: {
  readonly fieldArtifactContentHash: string;
  readonly sourceControlId: string;
}): string {
  return stableId("rowset-control", input);
}

export function candidateNodeId(input: {
  readonly fieldArtifactContentHash: string;
  readonly sourceCandidateId: string;
}): string {
  return stableId("candidate", input);
}

export function gapNodeId(input: {
  readonly fieldArtifactContentHash: string;
  readonly sourceGapId: string;
}): string {
  return stableId("gap", input);
}

export function boundaryNodeId(input: {
  readonly snapshotSeed: string;
  readonly reason: string;
  readonly subject: string;
}): string {
  return stableId("field-boundary", input);
}

export function fieldEvidenceEdgeId(input: {
  readonly edgeType: FieldEvidenceEdgeType;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly semanticKey?: unknown;
}): string {
  return stableId("field-edge", input);
}

export function fieldEvidenceSnapshotId(input: {
  readonly projectKey: string;
  readonly projectSource: FieldEvidenceProjectSourceRef;
  readonly fieldSource: FieldEvidenceArtifactSourceRef;
  readonly selection: Omit<FieldEvidenceSelection, "rootStateIds">;
  readonly limits: FieldEvidenceProjectionLimits;
}): string {
  projectKeySegment(input.projectKey);
  return `field-evidence-${sha256(
    canonicalJson({
      projectionVersion: FIELD_EVIDENCE_PROJECTION_VERSION,
      projectKey: input.projectKey,
      projectSnapshotId: input.projectSource.snapshotId,
      projectManifestSha256: input.projectSource.manifestSha256,
      fieldContentSha256: input.fieldSource.contentSha256,
      fieldDeclaredContentHash: input.fieldSource.declaredContentHash,
      selection: {
        ...input.selection,
        rootFields: sortedUnique(input.selection.rootFields),
      },
      limits: input.limits,
    }),
  )}`;
}

export function fieldEvidenceSnapshotContentHash(
  snapshot: Omit<FieldEvidenceSnapshotV1, "contentHash">,
): string {
  return sha256(canonicalJson(snapshot));
}

export function fieldEvidenceManifestContentHash(
  manifest: Omit<FieldEvidenceProjectionManifestV1, "contentHash">,
): string {
  return sha256(canonicalJson(manifest));
}

export function normalizedPhysicalField(input: {
  readonly platform: string;
  readonly dataSource: string;
  readonly stableTableId: string;
  readonly qualifiedName: string;
  readonly column: string;
}): Readonly<Record<string, string>> {
  return {
    platform: input.platform.trim().toLowerCase(),
    dataSource: input.dataSource.trim().toLowerCase(),
    stableTableId: input.stableTableId.trim().toLowerCase(),
    qualifiedName: input.qualifiedName.trim().toLowerCase(),
    column: input.column.trim().toLowerCase(),
  };
}

export function validateFieldEvidenceProjection(
  projection: FieldEvidenceProjectionV1,
): void {
  const { snapshot, nodes, edges } = projection;
  if (
    snapshot.schemaVersion !== FIELD_EVIDENCE_SCHEMA_VERSION ||
    snapshot.artifactType !== FIELD_EVIDENCE_SNAPSHOT_TYPE ||
    snapshot.projectionVersion !== FIELD_EVIDENCE_PROJECTION_VERSION
  )
    throw new Error("FIELD_EVIDENCE_SNAPSHOT_CONTRACT_INVALID");
  projectKeySegment(snapshot.projectKey);
  if (snapshot.projectSource.projectKey !== snapshot.projectKey)
    throw new Error("FIELD_EVIDENCE_PROJECT_KEY_MISMATCH");
  if (
    snapshot.selection.rootFields.length === 0 ||
    JSON.stringify(snapshot.selection.rootFields) !==
      JSON.stringify(sortedUnique(snapshot.selection.rootFields))
  )
    throw new Error("FIELD_EVIDENCE_ROOT_FIELDS_INVALID");
  if (
    Object.keys(snapshot.selection.rootStateIds).sort(compareText).join("|") !==
    snapshot.selection.rootFields.join("|")
  )
    throw new Error("FIELD_EVIDENCE_ROOT_STATE_MEMBERSHIP_INVALID");
  const expectedSnapshotId = fieldEvidenceSnapshotId({
    projectKey: snapshot.projectKey,
    projectSource: snapshot.projectSource,
    fieldSource: snapshot.fieldSource,
    selection: {
      rootTaskId: snapshot.selection.rootTaskId,
      writeObservationId: snapshot.selection.writeObservationId,
      target: snapshot.selection.target,
      rootFields: snapshot.selection.rootFields,
    },
    limits: snapshot.limits,
  });
  if (snapshot.snapshotId !== expectedSnapshotId)
    throw new Error("FIELD_EVIDENCE_SNAPSHOT_ID_INVALID");
  const { contentHash: _contentHash, ...snapshotBody } = snapshot;
  if (fieldEvidenceSnapshotContentHash(snapshotBody) !== snapshot.contentHash)
    throw new Error("FIELD_EVIDENCE_SNAPSHOT_HASH_INVALID");

  assertSortedUniqueRecords(nodes, "nodeId", "FIELD_EVIDENCE_NODES");
  assertSortedUniqueRecords(edges, "edgeId", "FIELD_EVIDENCE_EDGES");
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  for (const rootStateId of Object.values(snapshot.selection.rootStateIds)) {
    if (!nodeIds.has(rootStateId))
      throw new Error(`FIELD_EVIDENCE_ROOT_STATE_MISSING:${rootStateId}`);
  }
  if (!nodeIds.has(projectSnapshotRefNodeId(snapshot.projectSource.snapshotId)))
    throw new Error("FIELD_EVIDENCE_PROJECT_REF_MISSING");
  if (!nodeIds.has(taskNodeId(snapshot.selection.rootTaskId)))
    throw new Error("FIELD_EVIDENCE_ROOT_TASK_MISSING");
  for (const node of nodes) {
    if (
      node.schemaVersion !== FIELD_EVIDENCE_SCHEMA_VERSION ||
      node.recordType !== "NODE"
    )
      throw new Error("FIELD_EVIDENCE_NODE_CONTRACT_INVALID");
    assertSortedUnique(node.sourceArtifactRefIds, "NODE_SOURCE_ARTIFACTS");
  }
  for (const edge of edges) {
    if (
      edge.schemaVersion !== FIELD_EVIDENCE_SCHEMA_VERSION ||
      edge.recordType !== "EDGE"
    )
      throw new Error("FIELD_EVIDENCE_EDGE_CONTRACT_INVALID");
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))
      throw new Error(`FIELD_EVIDENCE_EDGE_ENDPOINT_MISSING:${edge.edgeId}`);
    assertSortedUnique(edge.sourceArtifactRefIds, "EDGE_SOURCE_ARTIFACTS");
    assertSortedUnique(edge.evidenceRefs, "EDGE_EVIDENCE_REFS");
  }
}

function assertSortedUnique(values: readonly string[], label: string): void {
  if (JSON.stringify(values) !== JSON.stringify(sortedUnique(values)))
    throw new Error(`${label}_INVALID`);
}

function assertSortedUniqueRecords<
  T extends Record<K, string>,
  K extends keyof T,
>(values: readonly T[], key: K, label: string): void {
  const actual = values.map((value) => value[key]);
  if (JSON.stringify(actual) !== JSON.stringify(sortedUnique(actual)))
    throw new Error(`${label}_ORDER_OR_DUPLICATE_INVALID`);
}

export {
  compareText,
  physicalDatasetNodeId,
  sortedUnique,
  stableId,
  taskNodeId,
};
