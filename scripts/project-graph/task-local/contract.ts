import {
  summarizeCoverageDispositions,
  resolveCoverageDisposition,
} from "./coverage-disposition.ts";
import { canonicalJson, sha256 } from "../../machine-facts/machine-facts-contract.ts";

export const TASK_LOCAL_PROJECTION_SCHEMA_VERSION = "1.3.0" as const;
export const TASK_LOCAL_PROJECTION_FIELD_EVIDENCE_SCHEMA_VERSION = "1.3.0" as const;
export const TASK_LOCAL_PROJECTION_LEGACY_SCHEMA_VERSION = "1.1.0" as const;
export const TASK_LOCAL_PROJECTION_READ_OCCURRENCE_SCHEMA_VERSION = "1.2.0" as const;

const TASK_LOCAL_PROJECTION_SCHEMA_VERSION_ORDER = [
  TASK_LOCAL_PROJECTION_LEGACY_SCHEMA_VERSION,
  TASK_LOCAL_PROJECTION_READ_OCCURRENCE_SCHEMA_VERSION,
  TASK_LOCAL_PROJECTION_FIELD_EVIDENCE_SCHEMA_VERSION,
] as const;

export type TaskLocalProjectionSchemaVersion =
  | typeof TASK_LOCAL_PROJECTION_SCHEMA_VERSION
  | typeof TASK_LOCAL_PROJECTION_READ_OCCURRENCE_SCHEMA_VERSION
  | typeof TASK_LOCAL_PROJECTION_FIELD_EVIDENCE_SCHEMA_VERSION
  | typeof TASK_LOCAL_PROJECTION_LEGACY_SCHEMA_VERSION;

export function taskLocalSchemaVersionAtLeast(
  version: TaskLocalProjectionSchemaVersion,
  minimum: TaskLocalProjectionSchemaVersion,
): boolean {
  return (
    TASK_LOCAL_PROJECTION_SCHEMA_VERSION_ORDER.indexOf(version)
    >= TASK_LOCAL_PROJECTION_SCHEMA_VERSION_ORDER.indexOf(minimum)
  );
}

export const TASK_LOCAL_PROJECTION_ARTIFACT_TYPE = "TASK_LOCAL_PROJECTION" as const;

export type TaskLocalCoverageStatus =
  | "PROJECTED"
  | "SCHEDULE_ONLY"
  | "COLLECTION_FAILED";

export type TaskLocalFailureReasonCode =
  | "FACTS_UNAVAILABLE"
  | "FACTS_STALE"
  | "FACTS_INVALID"
  | "NO_RESOLVED_WRITE"
  | "SCHEMA_UNRESOLVED"
  | "PROJECTION_FAILED";

export type TaskLocalSourceReadOccurrenceStatus =
  | "RESOLVED"
  | "AMBIGUOUS"
  | "UNRESOLVED";

export type TaskLocalSourceReadOccurrenceReason =
  | "SETOP_BRANCH_UNRESOLVED"
  | "SELF_JOIN_NO_QUALIFIER"
  | "CTE_SCOPE_UNRESOLVED"
  | "MATERIALIZATION_LEAF_MISSING";

export type TaskLocalSubtypeReason =
  | "EXPRESSION_TEXT_UNPARSEABLE"
  | "MIXED_ROLE_COLUMN"
  | "WINDOW_CONTEXT_ONLY"
  | "INPUT_DEPENDENCY_NOT_PHYSICAL";

export type TaskLocalJoinType =
  | "SEMI"
  | "ANTI"
  | "INNER"
  | "LEFT"
  | "RIGHT"
  | "FULL"
  | "CROSS"
  | "N/A";

export type TaskLocalControlSide =
  | "LEFT"
  | "RIGHT"
  | "BOTH"
  | "N/A";

export interface TaskLocalProjectionGap {
  readonly gapId: string;
  readonly reasonCode: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface TaskLocalBatchSummary {
  readonly total: number;
  readonly projected: number;
  readonly scheduleOnly: number;
  readonly collectionFailed: number;
  readonly byFailureReason: Readonly<Partial<Record<TaskLocalFailureReasonCode, number>>>;
  readonly coverageDisposition?: import("./coverage-disposition.ts").CoverageDispositionSummary;
}

export type CoverageDisposition =
  import("./coverage-disposition.ts").CoverageDisposition;

export function summarizeTaskLocalBatch(
  projections: readonly TaskLocalProjection[],
): TaskLocalBatchSummary {
  const byFailureReason: Partial<Record<TaskLocalFailureReasonCode, number>> = {};
  let projected = 0;
  let scheduleOnly = 0;
  let collectionFailed = 0;
  for (const projection of projections) {
    if (projection.coverageStatus === "PROJECTED") projected += 1;
    else if (projection.coverageStatus === "SCHEDULE_ONLY") scheduleOnly += 1;
    else {
      collectionFailed += 1;
      const reason = projection.failureReasonCode as TaskLocalFailureReasonCode | null;
      if (reason) byFailureReason[reason] = (byFailureReason[reason] ?? 0) + 1;
    }
  }
  return {
    total: projections.length,
    projected,
    scheduleOnly,
    collectionFailed,
    byFailureReason,
    coverageDisposition: summarizeCoverageDispositions(projections),
  };
}

export type TaskLocalNodeType =
  | "TASK"
  | "PHYSICAL_DATASET"
  | "PHYSICAL_FIELD"
  | "TARGET_WRITE"
  | "READ_OCCURRENCE";

export type TaskLocalEdgeType =
  | "READS"
  | "WRITES"
  | "FIELD_DIRECT"
  | "FIELD_CONDITIONAL"
  | "DATASET_CONTROL";

export type TaskLocalDirectSubtype = "UNKNOWN" | "IDENTITY" | "TRANSFORMATION" | "AGGREGATION";

export type TaskLocalControlSubtype =
  | "JOIN"
  | "FILTER"
  | "GROUP_BY"
  | "SORT"
  | "WINDOW"
  | "CONDITIONAL";

export type TaskLocalGrain = "REDUCE" | "PRESERVE" | "EXPAND_RISK";

export interface TaskLocalNode {
  readonly nodeId: string;
  readonly nodeType: TaskLocalNodeType;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface TaskLocalEdge {
  readonly edgeId: string;
  readonly edgeType: TaskLocalEdgeType;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export type TaskLocalIdentityStatus = "CONFIRMED" | "CANDIDATE_DATASET" | "UNRESOLVED";
export type TaskLocalQualificationStatus =
  | "CONFIRMED(TASK_TARGET)"
  | "ASSUMED(TASK_NAME_ONLY)"
  | "UNRESOLVED";

export interface TaskLocalFinalWriteSummary {
  readonly writeObservationId: string;
  readonly targetWriteNodeId: string;
  readonly datasetNodeId: string;
  readonly qualifiedName: string;
  /** Publication qualification; SQL_UNCONSUMED remains a candidate, not an L1 producer. */
  readonly outputQualification?: "PLATFORM_TARGET" | "SQL_UNCONSUMED";
}

export interface TaskLocalExternalReadSummary {
  readonly readOccurrenceId: string;
  readonly readOccurrenceNodeId: string;
  readonly datasetNodeId: string;
  readonly qualifiedName: string;
  readonly identityStatus: TaskLocalIdentityStatus;
}

export interface TaskLocalFieldPathSummary {
  readonly sourceFieldNodeId: string;
  readonly targetWriteNodeId: string;
  readonly outputColumn: string;
  readonly materializationBridgeIds: readonly string[];
}

export interface TaskLocalClosureSummary {
  readonly finalWrites: readonly TaskLocalFinalWriteSummary[];
  readonly externalReads: readonly TaskLocalExternalReadSummary[];
  readonly localFieldPaths: readonly TaskLocalFieldPathSummary[];
}

export interface TaskLocalProjection {
  readonly schemaVersion: TaskLocalProjectionSchemaVersion;
  readonly artifactType: typeof TASK_LOCAL_PROJECTION_ARTIFACT_TYPE;
  readonly generatedAt: string;
  readonly taskId: string;
  readonly taskCategory: string | null;
  readonly coverageStatus: TaskLocalCoverageStatus;
  readonly coverageDisposition: CoverageDisposition;
  readonly failureReasonCode: string | null;
  readonly contentHash: string;
  readonly nodes: readonly TaskLocalNode[];
  readonly edges: readonly TaskLocalEdge[];
  readonly localClosure?: TaskLocalClosureSummary;
  readonly gaps?: readonly TaskLocalProjectionGap[];
}

const DATA_EDGE_TYPES = new Set<TaskLocalEdgeType>([
  "READS",
  "WRITES",
  "FIELD_DIRECT",
  "FIELD_CONDITIONAL",
  "DATASET_CONTROL",
]);

const FIELD_VALUE_EDGE_TYPES = new Set<TaskLocalEdgeType>([
  "FIELD_DIRECT",
  "FIELD_CONDITIONAL",
]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function taskIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith("task:") ? nodeId.slice("task:".length) : null;
}

function assertNoLegacyControlFields(value: Record<string, unknown>, label: string): void {
  if ("affectedRootFields" in value) {
    throw new Error(`${label}_AFFECTED_ROOT_FIELDS_FORBIDDEN`);
  }
  if ("rowsetControls" in value) {
    throw new Error(`${label}_ROWSET_CONTROLS_FORBIDDEN`);
  }
}

function validateFieldEvidenceFieldEdge(
  edge: TaskLocalEdge,
  nodeById: ReadonlyMap<string, TaskLocalNode>,
): void {
  const properties = edge.properties;
  if (!hasOwn(properties, "sourceReadOccurrenceStatus")) {
    throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SOURCE_READ_STATUS_MISSING");
  }
  if (!hasOwn(properties, "sourceReadOccurrenceId")) {
    throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SOURCE_READ_ID_MISSING");
  }
  if (!hasOwn(properties, "sourceRelationId")) {
    throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SOURCE_RELATION_ID_MISSING");
  }
  if (!text(properties.expressionId)) {
    throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_EXPRESSION_ID_MISSING");
  }

  const status = properties.sourceReadOccurrenceStatus;
  if (
    status !== "RESOLVED"
    && status !== "AMBIGUOUS"
    && status !== "UNRESOLVED"
  ) {
    throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SOURCE_READ_STATUS_INVALID");
  }

  if (status !== "RESOLVED") {
    if (!text(properties.sourceReadOccurrenceReason)) {
      throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SOURCE_READ_REASON_MISSING");
    }
    if (properties.sourceReadOccurrenceId !== null) {
      throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SOURCE_READ_ID_MUST_BE_NULL");
    }
    if (properties.sourceRelationId !== null) {
      throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SOURCE_RELATION_ID_MUST_BE_NULL");
    }
  } else {
    if (!text(properties.sourceReadOccurrenceId)) {
      throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SOURCE_READ_ID_REQUIRED");
    }
    if (!text(properties.sourceRelationId)) {
      throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SOURCE_RELATION_ID_REQUIRED");
    }
  }

  const subtype = properties.subtype;
  if (edge.edgeType === "FIELD_DIRECT") {
    if (
      subtype !== "UNKNOWN"
      && subtype !== "IDENTITY"
      && subtype !== "TRANSFORMATION"
      && subtype !== "AGGREGATION"
    ) {
      throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SUBTYPE_INVALID");
    }
    if (subtype === "UNKNOWN" && !text(properties.subtypeReason)) {
      throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_SUBTYPE_REASON_MISSING");
    }
  } else if (subtype !== "CONDITIONAL") {
    throw new Error("TASK_LOCAL_PROJECTION_FIELD_CONDITIONAL_SUBTYPE_INVALID");
  }

  const toType = nodeById.get(edge.toNodeId)?.nodeType;
  if (toType !== "TARGET_WRITE") {
    throw new Error("TASK_LOCAL_PROJECTION_FIELD_EDGE_TARGET_INVALID");
  }
}

function validateFieldEvidenceControlEdge(edge: TaskLocalEdge): void {
  const properties = edge.properties;
  const subtype = properties.subtype;
  const joinType = properties.joinType;
  const controlSide = properties.controlSide;

  if (subtype === "JOIN") {
    if (joinType === "N/A" || joinType === undefined || joinType === null) {
      throw new Error("TASK_LOCAL_PROJECTION_DATASET_CONTROL_JOIN_TYPE_MISSING");
    }
    if (controlSide === "N/A" || controlSide === undefined || controlSide === null) {
      throw new Error("TASK_LOCAL_PROJECTION_DATASET_CONTROL_SIDE_MISSING");
    }
    if (!text(properties.leftRelationId) || !text(properties.rightRelationId)) {
      throw new Error("TASK_LOCAL_PROJECTION_DATASET_CONTROL_JOIN_RELATIONS_MISSING");
    }
    return;
  }

  if (joinType !== "N/A") {
    throw new Error("TASK_LOCAL_PROJECTION_DATASET_CONTROL_JOIN_TYPE_MUST_BE_NA");
  }
  if (controlSide !== "N/A") {
    throw new Error("TASK_LOCAL_PROJECTION_DATASET_CONTROL_SIDE_MUST_BE_NA");
  }
}

function validateFieldEvidenceGaps(gaps: readonly TaskLocalProjectionGap[] | undefined): void {
  if (!Array.isArray(gaps)) {
    throw new Error("TASK_LOCAL_PROJECTION_GAPS_MISSING");
  }
  const gapIds = new Set<string>();
  for (const gap of gaps) {
    if (!text(gap.gapId)) {
      throw new Error("TASK_LOCAL_PROJECTION_GAP_ID_MISSING");
    }
    if (gapIds.has(gap.gapId)) {
      throw new Error("TASK_LOCAL_PROJECTION_GAP_DUPLICATE");
    }
    gapIds.add(gap.gapId);
    if (!text(gap.reasonCode)) {
      throw new Error("TASK_LOCAL_PROJECTION_GAP_REASON_CODE_MISSING");
    }
    if (
      typeof gap.details !== "object"
      || gap.details === null
      || Array.isArray(gap.details)
    ) {
      throw new Error("TASK_LOCAL_PROJECTION_GAP_DETAILS_INVALID");
    }
  }
}

export function taskLocalProjectionContentHash(
  projection: TaskLocalProjection,
): string {
  const { generatedAt: _generatedAt, contentHash: _contentHash, ...rest } = projection;
  return sha256(canonicalJson(rest));
}

function scheduleReferenceTaskIds(properties: Readonly<Record<string, unknown>>): string[] {
  const reference = properties.scheduleReference;
  if (typeof reference !== "object" || reference === null || Array.isArray(reference)) {
    return [];
  }
  const record = reference as Record<string, unknown>;
  const ids: string[] = [];
  for (const key of ["upstreamTaskIds", "downstreamTaskIds"] as const) {
    const values = record[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === "string" && value.trim()) ids.push(value.trim());
    }
  }
  return ids;
}

export function validateTaskLocalProjection(projection: TaskLocalProjection): void {
  if (
    !TASK_LOCAL_PROJECTION_SCHEMA_VERSION_ORDER.includes(projection.schemaVersion)
    || projection.artifactType !== TASK_LOCAL_PROJECTION_ARTIFACT_TYPE
  ) {
    throw new Error("TASK_LOCAL_PROJECTION_CONTRACT_INVALID");
  }
  if (!text(projection.taskId)) throw new Error("TASK_LOCAL_PROJECTION_TASK_ID_INVALID");

  const isFieldEvidenceSchema = projection.schemaVersion
    === TASK_LOCAL_PROJECTION_FIELD_EVIDENCE_SCHEMA_VERSION;
  const requiresReadOccurrenceShape = taskLocalSchemaVersionAtLeast(
    projection.schemaVersion,
    TASK_LOCAL_PROJECTION_READ_OCCURRENCE_SCHEMA_VERSION,
  );

  if (isFieldEvidenceSchema) {
    validateFieldEvidenceGaps(projection.gaps);
  }

  const nodeIds = new Set<string>();
  let taskNodeCount = 0;
  const scheduleNeighborIds = new Set<string>();
  for (const node of projection.nodes) {
    if (nodeIds.has(node.nodeId)) throw new Error("TASK_LOCAL_PROJECTION_NODE_DUPLICATE");
    nodeIds.add(node.nodeId);
    assertNoLegacyControlFields(node.properties, "TASK_LOCAL_NODE");
    if (node.nodeType === "TASK") {
      taskNodeCount += 1;
      if (taskIdFromNodeId(node.nodeId) !== projection.taskId) {
        throw new Error("TASK_LOCAL_PROJECTION_TASK_NODE_MISMATCH");
      }
      for (const neighborId of scheduleReferenceTaskIds(node.properties)) {
        scheduleNeighborIds.add(neighborId);
      }
    }
  }
  if (taskNodeCount !== 1) throw new Error("TASK_LOCAL_PROJECTION_TASK_NODE_COUNT_INVALID");

  const edgeIds = new Set<string>();
  const nodeById = new Map(projection.nodes.map((node) => [node.nodeId, node]));
  for (const edge of projection.edges) {
    if (edgeIds.has(edge.edgeId)) throw new Error("TASK_LOCAL_PROJECTION_EDGE_DUPLICATE");
    edgeIds.add(edge.edgeId);
    assertNoLegacyControlFields(edge.properties, "TASK_LOCAL_EDGE");
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      throw new Error("TASK_LOCAL_PROJECTION_EDGE_ENDPOINT_MISSING");
    }
    if (!DATA_EDGE_TYPES.has(edge.edgeType)) {
      throw new Error("TASK_LOCAL_PROJECTION_EDGE_TYPE_INVALID");
    }
    for (const endpoint of [edge.fromNodeId, edge.toNodeId]) {
      const foreignTaskId = taskIdFromNodeId(endpoint);
      if (foreignTaskId !== null && foreignTaskId !== projection.taskId) {
        throw new Error("TASK_LOCAL_PROJECTION_CROSS_TASK_DATA_EDGE");
      }
      if (foreignTaskId !== null && scheduleNeighborIds.has(foreignTaskId)) {
        throw new Error("TASK_LOCAL_PROJECTION_SCHEDULE_REFERENCE_ON_DATA_EDGE");
      }
    }
    if (edge.edgeType === "DATASET_CONTROL") {
      const toType = nodeById.get(edge.toNodeId)?.nodeType;
      if (toType !== "TARGET_WRITE") {
        throw new Error("TASK_LOCAL_PROJECTION_DATASET_CONTROL_TARGET_INVALID");
      }
      if (isFieldEvidenceSchema) {
        validateFieldEvidenceControlEdge(edge);
      }
    }
    if (FIELD_VALUE_EDGE_TYPES.has(edge.edgeType) && isFieldEvidenceSchema) {
      validateFieldEvidenceFieldEdge(edge, nodeById);
    }
    if (requiresReadOccurrenceShape && edge.edgeType === "READS") {
      const fromType = nodeById.get(edge.fromNodeId)?.nodeType;
      const toType = nodeById.get(edge.toNodeId)?.nodeType;
      if (
        (fromType === "TASK" && toType !== "READ_OCCURRENCE")
        || (fromType === "READ_OCCURRENCE" && toType !== "PHYSICAL_DATASET")
        || (fromType !== "TASK" && fromType !== "READ_OCCURRENCE")
      ) {
        throw new Error("TASK_LOCAL_PROJECTION_READ_OCCURRENCE_EDGE_INVALID");
      }
      if (!text(edge.properties.readOccurrenceId)) {
        throw new Error("TASK_LOCAL_PROJECTION_READS_READ_OCCURRENCE_ID_MISSING");
      }
    }
  }

  if (projection.coverageStatus === "SCHEDULE_ONLY" && projection.edges.length > 0) {
    throw new Error("TASK_LOCAL_PROJECTION_SCHEDULE_ONLY_HAS_EDGES");
  }
  if (projection.coverageStatus === "COLLECTION_FAILED" && !text(projection.failureReasonCode)) {
    throw new Error("TASK_LOCAL_PROJECTION_FAILURE_REASON_REQUIRED");
  }
  const expectedDisposition = resolveCoverageDisposition({
    taskCategory: projection.taskCategory,
    coverageStatus: projection.coverageStatus,
  });
  if (projection.coverageDisposition !== expectedDisposition) {
    throw new Error("TASK_LOCAL_PROJECTION_COVERAGE_DISPOSITION_INVALID");
  }

  if (projection.localClosure) {
    for (const write of projection.localClosure.finalWrites) {
      if (
        write.outputQualification !== undefined
        && write.outputQualification !== "PLATFORM_TARGET"
        && write.outputQualification !== "SQL_UNCONSUMED"
      ) {
        throw new Error("TASK_LOCAL_PROJECTION_OUTPUT_QUALIFICATION_INVALID");
      }
      if (!nodeIds.has(write.targetWriteNodeId) || !nodeIds.has(write.datasetNodeId)) {
        throw new Error("TASK_LOCAL_PROJECTION_CLOSURE_REFERENCE_MISSING");
      }
    }
    for (const read of projection.localClosure.externalReads) {
      if (!nodeIds.has(read.readOccurrenceNodeId) || !nodeIds.has(read.datasetNodeId)) {
        throw new Error("TASK_LOCAL_PROJECTION_CLOSURE_REFERENCE_MISSING");
      }
    }
    for (const path of projection.localClosure.localFieldPaths) {
      if (!nodeIds.has(path.sourceFieldNodeId) || !nodeIds.has(path.targetWriteNodeId)) {
        throw new Error("TASK_LOCAL_PROJECTION_CLOSURE_REFERENCE_MISSING");
      }
    }
  }

  const expectedHash = taskLocalProjectionContentHash(projection);
  if (expectedHash !== projection.contentHash) {
    throw new Error("TASK_LOCAL_PROJECTION_CONTENT_HASH_INVALID");
  }
}

export function canonicalizeTaskLocalProjection(
  input: Omit<TaskLocalProjection, "contentHash" | "taskCategory" | "coverageDisposition"> & {
    readonly contentHash?: string;
    readonly taskCategory?: string | null;
    readonly coverageDisposition?: CoverageDisposition;
  },
): TaskLocalProjection {
  const body = {
    schemaVersion: input.schemaVersion,
    artifactType: TASK_LOCAL_PROJECTION_ARTIFACT_TYPE,
    generatedAt: input.generatedAt,
    taskId: input.taskId,
    taskCategory: input.taskCategory ?? null,
    coverageStatus: input.coverageStatus,
    coverageDisposition:
      input.coverageDisposition
      ?? resolveCoverageDisposition({
        taskCategory: input.taskCategory ?? null,
        coverageStatus: input.coverageStatus,
      }),
    failureReasonCode: input.failureReasonCode,
    nodes: [...input.nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    edges: [...input.edges].sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
    ...(input.localClosure ? { localClosure: input.localClosure } : {}),
    ...(input.gaps ? { gaps: [...input.gaps].sort((left, right) => left.gapId.localeCompare(right.gapId)) } : {}),
  };
  const contentHash = text(input.contentHash) ?? taskLocalProjectionContentHash({
    ...body,
    contentHash: "",
  });
  const projection = { ...body, contentHash };
  validateTaskLocalProjection(projection);
  return projection;
}
