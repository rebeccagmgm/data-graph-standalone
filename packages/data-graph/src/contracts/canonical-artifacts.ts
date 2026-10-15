import { canonicalJson, sha256 } from "./runtime.ts";

export const TARGET_TABLE_CAUSAL_CLOSURE_ARTIFACT_TYPE =
  "TARGET_TABLE_UPSTREAM_CAUSAL_CLOSURE" as const;
export const TARGET_TABLE_CAUSAL_CLOSURE_SCHEMA_VERSION = "1.1.0" as const;

/**
 * This file is the consumer-side declaration of the published artifact
 * boundary.  It intentionally contains no producer, parser, scheduler, or
 * causal-engine implementation.  The graph product accepts these versioned
 * JSON shapes and never imports the producer repository.
 */

export type InputDependencyStatus =
  | "PHYSICAL"
  | "DERIVED_OUTPUT"
  | "SQL_CANDIDATE"
  | "PARTIAL"
  | "UNRESOLVED"
  | "NO_PHYSICAL_INPUT";

type ArtifactRecord = Readonly<Record<string, unknown>>;

export type ReconciliationStatus =
  "MATCHED" | "SQL_ONLY" | "SCHEDULE_ONLY" | "UNRESOLVED";

export interface OneHopReconciliationResult {
  readonly schemaVersion: "1.1.0";
  readonly taskId: string;
  readonly generatedAt: string;
  readonly currentTask: {
    readonly inputPackPath: string;
    readonly inputPackContentHash: string;
    readonly directReads: readonly ArtifactRecord[];
  };
  readonly schedule: {
    readonly direction: "UPSTREAM";
    readonly depth: 1;
    readonly parents: readonly ArtifactRecord[];
    readonly evidence: readonly ArtifactRecord[];
  };
  readonly parents: readonly ArtifactRecord[];
  readonly reconciliation: readonly ArtifactRecord[];
  readonly counts: Readonly<Record<string, number>>;
  readonly countSemantics: Readonly<Record<string, unknown>>;
  readonly producerIndex: {
    readonly status: "NOT_REQUESTED" | "VALID_SUCCESS" | "VALID_PARTIAL";
    readonly contentHash: string | null;
    readonly inputFingerprint: string | null;
  };
  readonly dataPath: ArtifactRecord;
  readonly coverage: ArtifactRecord;
  readonly nextScheduleTaskIds: readonly string[];
  readonly nextDataTaskIds: readonly string[];
  readonly partitionAwareNextDataTaskIds: ArtifactRecord;
  readonly finalUpstreamTaskIds: {
    readonly primary: readonly string[];
    readonly additional: readonly string[];
    readonly unknown: readonly string[];
    readonly decision:
      | "SCHEDULE_DATA_INTERSECTION"
      | "DATA_FALLBACK"
      | "SCHEDULE_FALLBACK"
      | "MULTIPLE_OVERLAPPING_PRODUCERS";
  };
  readonly issues: readonly string[];
  readonly issueDetails: readonly ArtifactRecord[];
  readonly boundaries: ArtifactRecord;
}

export type MultiHopTerminalReason = string;
export type TaskInputPackStatus =
  | "TASK_INPUT_PACK_MISSING"
  | "TASK_INPUT_PACK_INVALID"
  | "TASK_INPUT_PACK_AMBIGUOUS"
  | "TASK_INPUT_PACK_AVAILABLE";
export type TaskReadBlockReason =
  "SQL_PARSE_FAILED" | "PARSER_TOPOLOGY_UNKNOWN" | "TABLE_IDENTITY_UNRESOLVED";

export interface MultiHopUpstreamDecision {
  readonly source: "ONE_HOP_FINAL_UPSTREAM";
  readonly primary: readonly string[];
  readonly additional: readonly string[];
  readonly unknown: readonly string[];
  readonly decision: OneHopReconciliationResult["finalUpstreamTaskIds"]["decision"];
  readonly evidence: readonly unknown[];
}

export interface MultiHopTaskNode {
  readonly taskId: string;
  readonly minDepth: number;
  readonly expansionStatus: "EXPANDED" | "TERMINAL" | "TRUNCATED";
  readonly taskInputPackStatus: TaskInputPackStatus | null;
  readonly taskContentHash: string | null;
  readonly evidence: readonly ArtifactRecord[];
  readonly upstreamDecision: MultiHopUpstreamDecision | null;
}

export interface MultiHopTableRef {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string;
  readonly identityStatus:
    "RESOLVED" | "QUALIFIED_NAME_ONLY" | "AMBIGUOUS" | "UNKNOWN";
}

export interface MultiHopProducerTableIdentity {
  readonly platform: string;
  readonly dataSource: string;
  readonly qualifiedName: string;
}

export interface MultiHopReadEdge {
  readonly consumerTaskId: string;
  readonly table: MultiHopTableRef;
  readonly statementIndexes: readonly number[];
  readonly eligibleStatementIndexes: readonly number[];
  readonly blockedStatementIndexes: readonly number[];
  readonly recursionStatus: "ELIGIBLE" | "BLOCKED";
  readonly blockReasons: readonly TaskReadBlockReason[];
  readonly evidence: readonly ArtifactRecord[];
}

export interface MultiHopWriteObservation extends ArtifactRecord {
  readonly observationKind: "DIRECT_TARGET" | "SQL_EXPLICIT_WRITE";
  readonly declaredWriteMode: string | null;
  readonly sqlWriteKind: string | null;
  readonly partition: readonly ArtifactRecord[];
  readonly evidence: readonly ArtifactRecord[];
  readonly operationClass?: string;
  readonly dataPathRole?: string;
  readonly writeDirection?: string;
  readonly targetEvidenceKind?: string;
}

export interface MultiHopWriteEdge {
  readonly producerTaskId: string;
  readonly table: MultiHopProducerTableIdentity;
  readonly writes: readonly MultiHopWriteObservation[];
  readonly producerIndexContentHash: string;
}

export interface MultiHopProducerBridge {
  readonly consumerTaskId: string;
  readonly table: MultiHopProducerTableIdentity;
  readonly producerTaskId: string;
  readonly producerDepth: number;
  readonly producerRole: "PRIMARY" | "ADDITIONAL" | "UNKNOWN" | "CANDIDATE";
  readonly readOccurrence: {
    readonly occurrenceId: string;
    readonly readRelationId: string;
    readonly statementIndex: number;
    readonly relationPath: readonly string[];
  } | null;
}

export interface MultiHopScheduleEdge {
  readonly consumerTaskId: string;
  readonly producerTaskId: string;
  readonly producerDepth: number;
  readonly evidence: readonly unknown[];
}

export interface MultiHopTerminal {
  readonly taskId: string;
  readonly depth: number;
  readonly reason: MultiHopTerminalReason;
  readonly table?: MultiHopTableRef | MultiHopProducerTableIdentity;
  readonly detail?: ArtifactRecord;
}

export interface MultiHopReconciliationResult {
  readonly schemaVersion: "1.1.0";
  readonly artifactType: "TABLE_MULTI_HOP_RECONCILIATION";
  readonly rootTaskId: string;
  readonly generatedAt: string;
  readonly producerIndex: {
    readonly contentHash: string;
    readonly inputFingerprint: string;
    readonly status: "VALID_SUCCESS" | "VALID_PARTIAL";
  };
  readonly terminalTableConfig: {
    readonly version: string;
    readonly stopRoles: readonly string[];
  };
  readonly taskNodes: readonly MultiHopTaskNode[];
  readonly tableNodes: readonly MultiHopTableRef[];
  readonly readEdges: readonly MultiHopReadEdge[];
  readonly writeEdges: readonly MultiHopWriteEdge[];
  readonly producerBridges: readonly MultiHopProducerBridge[];
  readonly scheduleEdges: readonly MultiHopScheduleEdge[];
  readonly terminals: readonly MultiHopTerminal[];
  readonly scheduleSkeleton: {
    readonly boundary: "ROOT_DEPTH_1_ONLY";
    readonly parents: readonly ArtifactRecord[];
  };
  readonly coverage: {
    readonly semantics: "OBSERVED_EVIDENCE_ONLY";
    readonly status: "COMPLETE_OBSERVED_EVIDENCE" | "PARTIAL_EVIDENCE";
    readonly producerIndexStatus: "VALID_SUCCESS" | "VALID_PARTIAL";
    readonly [key: string]: unknown;
  };
  readonly limits: {
    readonly maxDepth: number;
    readonly maxTasks: number;
    readonly maxEdges: number;
    readonly truncated: boolean;
    readonly truncationReason: string | null;
    readonly remainingFrontierTasks: number;
  };
  readonly counts: {
    readonly taskNodes: number;
    readonly tableNodes: number;
    readonly readEdges: number;
    readonly writeEdges: number;
    readonly producerBridges: number;
    readonly scheduleEdges: number;
    readonly terminals: number;
  };
  readonly countSemantics: "NODE_AND_UNIQUE_EDGE_COUNTS";
  readonly issues: readonly string[];
  readonly boundaries: ArtifactRecord;
  readonly contentHash: string;
}

function canonicalHash(
  value: unknown,
  excludedFields: readonly string[],
): string {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("MULTI_HOP_ARTIFACT_OBJECT_REQUIRED");
  const excluded = new Set(excludedFields);
  const body = Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.has(key)),
  );
  return sha256(canonicalJson(body));
}

/** Validate only the published multi-hop boundary; traversal remains producer-owned. */
export function validateMultiHopReconciliation(
  value: unknown,
): asserts value is MultiHopReconciliationResult {
  const artifact = value as Partial<MultiHopReconciliationResult> | null;
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    artifact.schemaVersion !== "1.1.0" ||
    artifact.artifactType !== "TABLE_MULTI_HOP_RECONCILIATION" ||
    artifact.countSemantics !== "NODE_AND_UNIQUE_EDGE_COUNTS" ||
    typeof artifact.rootTaskId !== "string" ||
    !artifact.producerIndex ||
    !Array.isArray(artifact.taskNodes) ||
    !Array.isArray(artifact.tableNodes) ||
    !Array.isArray(artifact.readEdges) ||
    !Array.isArray(artifact.writeEdges) ||
    !Array.isArray(artifact.producerBridges) ||
    !Array.isArray(artifact.scheduleEdges) ||
    !Array.isArray(artifact.terminals) ||
    typeof artifact.contentHash !== "string"
  )
    throw new Error("MULTI_HOP_CONTRACT_INVALID");
  const counts = artifact.counts;
  if (
    !counts ||
    counts.taskNodes !== artifact.taskNodes.length ||
    counts.tableNodes !== artifact.tableNodes.length ||
    counts.readEdges !== artifact.readEdges.length ||
    counts.writeEdges !== artifact.writeEdges.length ||
    counts.producerBridges !== artifact.producerBridges.length ||
    counts.scheduleEdges !== artifact.scheduleEdges.length ||
    counts.terminals !== artifact.terminals.length
  )
    throw new Error("MULTI_HOP_COUNTS_INVALID");
  if (
    artifact.contentHash !==
    canonicalHash(artifact, ["generatedAt", "contentHash"])
  )
    throw new Error("MULTI_HOP_CONTENT_HASH_INVALID");
}

export interface PhysicalFieldIdentity {
  readonly platform: string;
  readonly dataSource: string;
  readonly stableTableId: string;
  readonly qualifiedName: string;
  readonly column: string;
  readonly identityStatus: "SCHEMA_BACKED" | "TASK_LOCAL_SCHEMA_BACKED";
}

export interface FieldLineageRequest {
  readonly rootTaskId: string;
  readonly rootTable: string;
  readonly rootWriteObservationIds: readonly string[];
  readonly rootFields: readonly string[];
  readonly rootFieldSelection?: "EXPLICIT" | "ALL_TARGET_COLUMNS";
  readonly factsPolicy: "current-only" | "allow-legacy-partial";
}

export interface FieldLineageNode {
  readonly nodeId: string;
  readonly taskId: string;
  readonly taskName: string | null;
  readonly depth: number;
  readonly field: PhysicalFieldIdentity;
  readonly bindingId: string | null;
  readonly expressionId: string | null;
  readonly expressionText: string | null;
  readonly inputDependencyStatus?: InputDependencyStatus;
  readonly evidenceStatus: "CONFIRMED" | "PROVISIONAL_LEGACY" | "UNRESOLVED";
}

export interface FieldLineageEdge {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly consumerTaskId: string;
  readonly producerTaskId: string | null;
  readonly kind: "VALUE_FLOW";
  readonly mapping: string;
  readonly evidenceStatus: "CONFIRMED" | "PROVISIONAL_LEGACY" | "UNRESOLVED";
  readonly evidenceRefs: readonly string[];
}

export interface RowsetControlAnnotation {
  readonly controlId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly statementId: string;
  readonly relationId: string | null;
  readonly controlType:
    "filter" | "join" | "aggregate" | "setop" | "window" | "distinct";
  readonly fields: readonly PhysicalFieldIdentity[];
  readonly sourceText: string | null;
  readonly evidenceStatus: "CONFIRMED" | "PROVISIONAL_LEGACY" | "UNRESOLVED";
  readonly reasonCode: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface FieldProducerCandidate {
  readonly candidateId: string;
  readonly consumerTaskId: string;
  readonly producerTaskId: string;
  readonly field: PhysicalFieldIdentity | null;
  readonly evidenceStatus: "CANDIDATE";
  readonly reasonCode: string;
}

export interface FieldLineageGap {
  readonly gapId: string;
  readonly taskId: string;
  readonly nodeId: string | null;
  readonly field: PhysicalFieldIdentity | null;
  readonly reasonCode: string;
  readonly message: string;
  readonly evidenceStatus: "UNRESOLVED";
  readonly evidenceRefs: readonly string[];
}

export interface FieldLineageArtifact {
  readonly schemaVersion: "1.1.0";
  readonly artifactType: "FIELD_MULTI_HOP_RECONCILIATION";
  readonly generatedAt: string;
  readonly request: FieldLineageRequest;
  readonly overallStatus: "COMPLETE" | "PARTIAL" | "BLOCKED";
  readonly rootNodeIds: readonly string[];
  readonly nodes: readonly FieldLineageNode[];
  readonly edges: readonly FieldLineageEdge[];
  readonly rowsetControls: readonly RowsetControlAnnotation[];
  readonly candidates: readonly FieldProducerCandidate[];
  readonly gaps: readonly FieldLineageGap[];
  readonly tableEdges: readonly {
    readonly consumerTaskId: string;
    readonly producerTaskId: string;
    readonly classification: "PRIMARY" | "ADDITIONAL" | "UNKNOWN";
  }[];
  readonly limits: {
    readonly maxDepth: number;
    readonly maxStates: number;
    readonly maxPaths: number;
    readonly truncated: boolean;
    readonly reasons: readonly string[];
  };
  readonly counts: {
    readonly nodes: number;
    readonly edges: number;
    readonly rowsetControls: number;
    readonly candidates: number;
    readonly gaps: number;
  };
  readonly boundaries: {
    readonly staticSqlOnly: true;
    readonly runtimeExecution: "NOT_EVALUATED";
    readonly dataCorrectness: "NOT_EVALUATED";
    readonly businessAcceptance: "NOT_EVALUATED";
  };
  readonly contentHash: string;
}

export function physicalFieldKey(field: PhysicalFieldIdentity): string {
  return [
    field.platform,
    field.dataSource,
    field.stableTableId,
    field.qualifiedName,
    field.column,
  ]
    .map((value) => value.trim().toLowerCase())
    .join("|");
}

function sortedUnique<T>(items: readonly T[], key: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(key(item), item);
  return [...byKey.values()].sort((left, right) =>
    key(left).localeCompare(key(right)),
  );
}

export function canonicalizeFieldLineageArtifact(
  input: Omit<FieldLineageArtifact, "counts" | "contentHash">,
): FieldLineageArtifact {
  const rootFields = [
    ...new Set(
      input.request.rootFields.map((field) => field.trim().toLowerCase()),
    ),
  ].sort();
  const rootNodeIds = [...new Set(input.rootNodeIds)].sort();
  const nodes = sortedUnique(input.nodes, (item) => item.nodeId);
  const edges = sortedUnique(input.edges, (item) => item.edgeId).map(
    (item) => ({
      ...item,
      evidenceRefs: [...new Set(item.evidenceRefs)].sort(),
    }),
  );
  const rowsetControls = sortedUnique(
    input.rowsetControls,
    (item) => item.controlId,
  ).map((item) => ({
    ...item,
    fields: sortedUnique(item.fields, physicalFieldKey),
    evidenceRefs: [...new Set(item.evidenceRefs)].sort(),
  }));
  const candidates = sortedUnique(input.candidates, (item) => item.candidateId);
  const gaps = sortedUnique(input.gaps, (item) => item.gapId).map((item) => ({
    ...item,
    evidenceRefs: [...new Set(item.evidenceRefs)].sort(),
  }));
  const tableEdges = sortedUnique(
    input.tableEdges,
    (item) =>
      `${item.consumerTaskId}|${item.classification}|${item.producerTaskId}`,
  );
  const limits = {
    ...input.limits,
    reasons: [...new Set(input.limits.reasons)].sort(),
  };
  const withoutHash: Omit<FieldLineageArtifact, "contentHash"> = {
    ...input,
    request: { ...input.request, rootFields },
    rootNodeIds,
    nodes,
    edges,
    rowsetControls,
    candidates,
    gaps,
    tableEdges,
    limits,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      rowsetControls: rowsetControls.length,
      candidates: candidates.length,
      gaps: gaps.length,
    },
  };
  return {
    ...withoutHash,
    contentHash: (() => {
      const { generatedAt: _generatedAt, ...stable } = withoutHash;
      return sha256(canonicalJson(stable));
    })(),
  };
}

function ordered(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! <= value,
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Validate the field artifact without executing or re-deriving field lineage. */
export function validateFieldLineageArtifact(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return ["artifact must be an object"];
  const artifact = value as FieldLineageArtifact;
  if (artifact.schemaVersion !== "1.1.0")
    errors.push("schemaVersion is unsupported");
  if (artifact.artifactType !== "FIELD_MULTI_HOP_RECONCILIATION")
    errors.push("artifactType is invalid");
  if (!nonEmpty(artifact.generatedAt)) errors.push("generatedAt is required");
  if (
    !artifact.request ||
    !nonEmpty(artifact.request.rootTaskId) ||
    !nonEmpty(artifact.request.rootTable)
  )
    errors.push("request root identity is incomplete");
  if (
    !Array.isArray(artifact.request?.rootWriteObservationIds) ||
    artifact.request.rootWriteObservationIds.length === 0
  )
    errors.push("request root Write Observations are incomplete");
  if (
    !Array.isArray(artifact.request?.rootFields) ||
    artifact.request.rootFields.length === 0
  )
    errors.push("at least one explicit root field is required");
  if (
    !["current-only", "allow-legacy-partial"].includes(
      artifact.request?.factsPolicy,
    )
  )
    errors.push("factsPolicy is invalid");
  if (!["COMPLETE", "PARTIAL", "BLOCKED"].includes(artifact.overallStatus))
    errors.push("overallStatus is invalid");
  const nodes = Array.isArray(artifact.nodes) ? artifact.nodes : [];
  const edges = Array.isArray(artifact.edges) ? artifact.edges : [];
  const nodeIds = nodes.map((node) => node.nodeId);
  const edgeIds = edges.map((edge) => edge.edgeId);
  if (new Set(nodeIds).size !== nodeIds.length || !ordered(nodeIds))
    errors.push("nodes must be unique and sorted");
  if (new Set(edgeIds).size !== edgeIds.length || !ordered(edgeIds))
    errors.push("edges must be unique and sorted");
  const nodeSet = new Set(nodeIds);
  for (const edge of edges) {
    if (edge.kind !== "VALUE_FLOW")
      errors.push(`edge ${edge.edgeId} is not VALUE_FLOW`);
    if (!nodeSet.has(edge.fromNodeId) || !nodeSet.has(edge.toNodeId))
      errors.push(`edge ${edge.edgeId} has a missing endpoint`);
  }
  for (const rootId of artifact.rootNodeIds ?? [])
    if (!nodeSet.has(rootId)) errors.push(`root node ${rootId} is missing`);
  if (!ordered(artifact.rootNodeIds ?? []))
    errors.push("rootNodeIds must be sorted");
  if (
    !artifact.counts ||
    artifact.counts.nodes !== nodes.length ||
    artifact.counts.edges !== edges.length ||
    artifact.counts.rowsetControls !== (artifact.rowsetControls?.length ?? 0) ||
    artifact.counts.candidates !== (artifact.candidates?.length ?? 0) ||
    artifact.counts.gaps !== (artifact.gaps?.length ?? 0)
  )
    errors.push("counts do not match");
  if (!artifact.boundaries?.staticSqlOnly)
    errors.push("staticSqlOnly boundary is required");
  if (nonEmpty(artifact.contentHash)) {
    const {
      generatedAt: _generatedAt,
      contentHash: _contentHash,
      ...stable
    } = artifact;
    if (sha256(canonicalJson(stable)) !== artifact.contentHash)
      errors.push("contentHash does not match canonical artifact");
  } else errors.push("contentHash is required");
  return errors;
}

export type ImpactChannel =
  | "FIELD_VALUE"
  | "EXPRESSION_CONTROL"
  | "ROW_MEMBERSHIP"
  | "MULTIPLICITY"
  | "GROUPING"
  | "SET_MEMBERSHIP"
  | "ORDER_SELECTION"
  | "WINDOW_EFFECT"
  | "RELATION_EXISTENCE";
export type LocalTransferKind =
  | "DIRECT_FIELD_VALUE"
  | "EXPRESSION_INPUT"
  | "FILTER_PREDICATE"
  | "JOIN_MATCH"
  | "AGGREGATE_INPUT"
  | "SET_OPERAND"
  | "WINDOW_INPUT"
  | "ORDER_KEY"
  | "UNKNOWN";
export type ChannelStatus =
  "CONFIRMED" | "CONDITIONAL" | "PROVEN_ABSENT" | "UNKNOWN" | "NOT_APPLICABLE";
export type RelationStatus =
  "CONFIRMED_RELATED" | "CONDITIONAL_RELATED" | "PROVEN_UNRELATED" | "UNKNOWN";

export interface CandidateReadOccurrence {
  readonly occurrenceId: string;
  readonly readRelationId: string;
  readonly sqlSourceId?: string | null;
  readonly statementIndex: number;
  readonly rootRelationId?: string | null;
  readonly relationPath: readonly string[];
}

export interface CandidateWriteScope {
  readonly sqlSourceId: string;
  readonly statementOrdinal: number;
  readonly rootRelationId: string;
}

export interface CandidatePhysicalTable {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string | null;
  readonly stableTableId: string | null;
  readonly identityStatus: string | null;
}

export interface CandidateEvidenceRef {
  readonly evidenceRefId: string;
  readonly source: string | null;
  readonly locator: string | null;
}

export type CandidateBranchKind =
  | "ROOT_WRITE"
  | "PHYSICAL_PRODUCER"
  | "SCHEDULE_ONLY"
  | "UNBOUND_READ"
  | "BLOCKED_READ"
  | "COVERAGE_BOUNDARY";

export interface CandidateBranch {
  readonly candidateBranchId: string;
  readonly branchKind: CandidateBranchKind;
  readonly rootTaskId: string;
  readonly consumerTaskId: string | null;
  readonly producerTaskId: string | null;
  readonly table: CandidatePhysicalTable | null;
  readonly readOccurrence: CandidateReadOccurrence | null;
  readonly writeObservationId?: string | null;
  readonly producerRole: string | null;
  readonly writeScope?: CandidateWriteScope | null;
  readonly evidenceRefs: readonly CandidateEvidenceRef[];
  readonly gapRefs: readonly string[];
  readonly boundaryReason: string | null;
}

export interface CandidateUniverse {
  readonly rootTaskId: string;
  readonly status: "COMPLETE_OBSERVED_EVIDENCE" | "INCOMPLETE";
  readonly branches: readonly CandidateBranch[];
  readonly boundaryGapRefs: readonly string[];
  readonly coverage: Readonly<{
    readonly sourceArtifactType: string;
    readonly sourceCoverageStatus: string | null;
    readonly sourceCoverageSemantics: string | null;
    readonly sourceLimitsTruncated: boolean;
  }>;
}

export interface ChannelAssessment {
  readonly channel: ImpactChannel;
  readonly status: ChannelStatus;
  readonly proofRefs: readonly string[];
  readonly witnessRefs: readonly string[];
  readonly gapRefs: readonly string[];
  readonly localTransferKinds?: readonly LocalTransferKind[];
  readonly demandedFieldNames?: readonly string[];
  readonly outputFieldBindingIds?: readonly string[];
  readonly affectedTargetFields?: readonly string[];
}

export interface NegativeProof {
  readonly proofId: string;
  readonly kind: "COMPLETE_UNIVERSE_NO_CAUSAL_PATH";
  readonly targetWriteId: string;
  readonly candidateBranchId: string;
  readonly universeStatus: "COMPLETE_OBSERVED_EVIDENCE";
  readonly closedChannels: readonly {
    readonly channel: ImpactChannel;
    readonly status: "PROVEN_ABSENT" | "NOT_APPLICABLE";
    readonly proofRefs: readonly string[];
  }[];
  readonly premiseRefs: readonly string[];
  readonly cut: {
    readonly kind: "CANDIDATE_BRANCH_NO_REACHABLE_CAUSAL_EDGE";
    readonly rootTaskId: string;
    readonly consumerTaskId: string | null;
    readonly producerTaskId: string | null;
    readonly readOccurrenceId: string | null;
  };
}

export interface TargetTableAssessment {
  readonly assessmentId: string;
  readonly targetWriteId: string;
  readonly candidateBranchId: string;
  readonly relationStatus: RelationStatus;
  readonly channelAssessments: readonly ChannelAssessment[];
  readonly evidenceRefs: readonly string[];
  readonly gapRefs: readonly string[];
  readonly negativeProofs: readonly NegativeProof[];
}

export interface UpstreamTaskRollup {
  readonly producerTaskId: string;
  readonly branchIds: readonly string[];
  readonly relationStatus: RelationStatus;
  readonly impactChannels: readonly ImpactChannel[];
  readonly evidenceRefs: readonly string[];
  readonly gapRefs: readonly string[];
}

export interface TargetWriteIdentity {
  readonly targetWriteId: string;
  readonly taskId: string;
  readonly targetTableKey: string;
  readonly sqlSourceId: string;
  readonly statementOrdinal: number;
  readonly taskWriteOrdinal: number;
  readonly rootRelationId: string;
  readonly writeObservationId: string;
  readonly evidenceRefs: readonly string[];
}

export interface AnalysisSnapshotRef {
  readonly inputPackFingerprint: string;
  readonly machineFactsHash: string;
  readonly producerIndexHash: string;
  readonly tableMultiHopHash: string;
  readonly fieldLineageHash?: string;
  readonly semanticRuleVersion: string;
}

export interface TargetWriteRef {
  readonly identity: TargetWriteIdentity;
  readonly snapshot: AnalysisSnapshotRef;
}

export interface TargetTableCausalClosureArtifact {
  readonly schemaVersion: "1.1.0";
  readonly artifactType: "TARGET_TABLE_UPSTREAM_CAUSAL_CLOSURE";
  readonly generatedAt: string;
  readonly targetWrite: TargetWriteRef;
  readonly candidateUniverse: CandidateUniverse;
  readonly assessments: readonly TargetTableAssessment[];
  readonly taskRollup: readonly UpstreamTaskRollup[];
  readonly minimumCertainTaskIds: readonly string[];
  readonly conservativeSafetyTaskIds: readonly string[];
  readonly runtimeRerunDecision: "NOT_EVALUATED";
  readonly relationSummaries: readonly ArtifactRecord[];
  readonly metrics: {
    readonly candidateBranchCount: number;
    readonly assessmentCount: number;
    readonly upstreamTaskCount: number;
    readonly fieldValueEvidenceScanCount: number;
    readonly evidenceClosureRate: number | "NOT_APPLICABLE";
    readonly decisionCoverage: {
      readonly numerator: number;
      readonly denominator: number;
      readonly rate: number;
    };
    readonly bridgeStats: {
      readonly resolved: number;
      readonly ambiguous: number;
      readonly missing: number;
    };
    readonly peakMemoryBytes: number;
    readonly [key: string]: unknown;
  };
  readonly stages: readonly ArtifactRecord[];
  readonly gaps: readonly {
    readonly gapId: string;
    readonly reasonCode: string;
    readonly message: string;
    readonly evidenceRefs: readonly string[];
  }[];
  readonly contentHash: string;
}

function sorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function assessmentId(targetWriteId: string, branchId: string): string {
  return `target-table-assessment:${sha256(canonicalJson({ targetWriteId, branchId }))}`;
}

function sortedNegativeProofs(
  values: readonly NegativeProof[],
): readonly NegativeProof[] {
  return [...values]
    .sort((left, right) => left.proofId.localeCompare(right.proofId))
    .map((proof) => ({
      ...proof,
      closedChannels: [...proof.closedChannels]
        .sort((left, right) => left.channel.localeCompare(right.channel))
        .map((channel) => ({
          ...channel,
          proofRefs: sorted(channel.proofRefs),
        })),
      premiseRefs: sorted(proof.premiseRefs),
    }));
}

export function canonicalAssessment(
  input: Omit<TargetTableAssessment, "assessmentId">,
): TargetTableAssessment {
  return {
    ...input,
    assessmentId: assessmentId(input.targetWriteId, input.candidateBranchId),
    channelAssessments: [...input.channelAssessments]
      .sort((left, right) => left.channel.localeCompare(right.channel))
      .map((channel) => ({
        ...channel,
        proofRefs: sorted(channel.proofRefs),
        witnessRefs: sorted(channel.witnessRefs),
        gapRefs: sorted(channel.gapRefs),
        ...(channel.localTransferKinds
          ? {
              localTransferKinds: [
                ...new Set(channel.localTransferKinds),
              ].sort(),
            }
          : {}),
        ...(channel.demandedFieldNames
          ? { demandedFieldNames: sorted(channel.demandedFieldNames) }
          : {}),
        ...(channel.outputFieldBindingIds
          ? { outputFieldBindingIds: sorted(channel.outputFieldBindingIds) }
          : {}),
        ...(channel.affectedTargetFields
          ? { affectedTargetFields: sorted(channel.affectedTargetFields) }
          : {}),
      })),
    evidenceRefs: sorted(input.evidenceRefs),
    gapRefs: sorted(input.gapRefs),
    negativeProofs: sortedNegativeProofs(input.negativeProofs),
  };
}

export function canonicalizeTargetTableArtifact(
  input: Omit<TargetTableCausalClosureArtifact, "contentHash">,
): TargetTableCausalClosureArtifact {
  const stable = {
    ...input,
    assessments: [...input.assessments].sort((left, right) =>
      left.assessmentId.localeCompare(right.assessmentId),
    ),
    taskRollup: [...input.taskRollup].sort((left, right) =>
      left.producerTaskId.localeCompare(right.producerTaskId),
    ),
    minimumCertainTaskIds: sorted(input.minimumCertainTaskIds),
    conservativeSafetyTaskIds: sorted(input.conservativeSafetyTaskIds),
    relationSummaries: [...input.relationSummaries].sort(
      (left, right) =>
        String(left.taskId).localeCompare(String(right.taskId)) ||
        String(left.sqlSourceId).localeCompare(String(right.sqlSourceId)) ||
        Number(left.statementIndex) - Number(right.statementIndex),
    ),
    stages: [...input.stages].sort((left, right) =>
      String(left.stage).localeCompare(String(right.stage)),
    ),
    gaps: [...input.gaps].sort((left, right) =>
      left.gapId.localeCompare(right.gapId),
    ),
  };
  return { ...stable, contentHash: sha256(canonicalJson(stable)) };
}

/**
 * The graph boundary checks identity and one-assessment-per-branch. Detailed
 * causal derivation and any negative-proof policy remain producer-owned.
 */
export function validateCausalClosure(input: {
  readonly targetWriteId: string;
  readonly universe: CandidateUniverse;
  readonly assessments: readonly TargetTableAssessment[];
}): { readonly valid: boolean; readonly errors: readonly string[] } {
  const errors: string[] = [];
  const branches = new Set(
    input.universe.branches.map((branch) => branch.candidateBranchId),
  );
  if (branches.size !== input.universe.branches.length)
    errors.push("candidate branch IDs are duplicated");
  const seen = new Set<string>();
  for (const assessment of input.assessments) {
    if (assessment.targetWriteId !== input.targetWriteId)
      errors.push(
        `assessment target write mismatch:${assessment.assessmentId}`,
      );
    if (!branches.has(assessment.candidateBranchId))
      errors.push(`assessment branch missing:${assessment.candidateBranchId}`);
    if (seen.has(assessment.candidateBranchId))
      errors.push(
        `assessment branch duplicated:${assessment.candidateBranchId}`,
      );
    seen.add(assessment.candidateBranchId);
  }
  if (seen.size !== branches.size)
    errors.push("every candidate branch must have one assessment");
  return { valid: errors.length === 0, errors };
}

const VOLATILE_IDENTITY_FIELDS = new Set([
  "generatedAt",
  "observedAt",
  "cacheStatus",
  "cachePath",
  "inputPackPath",
]);

function stableIdentityValue(value: unknown, topLevel: boolean): unknown {
  if (Array.isArray(value))
    return value.map((item) => stableIdentityValue(item, false));
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      VOLATILE_IDENTITY_FIELDS.has(key) ||
      (topLevel && key === "contentHash")
    )
      continue;
    output[key] = stableIdentityValue(item, false);
  }
  return output;
}

/** Stable identity helper for legacy direct source descriptors. */
export function stableProjectEvidenceHash(value: unknown): string {
  return sha256(canonicalJson(stableIdentityValue(value, true)));
}
