import { canonicalJson, sha256 } from "../../../machine-facts/machine-facts-contract.ts";
import type { AnalysisSnapshotRef, TargetWriteRef } from "./target-write-contract.ts";
import type { CandidateBranch, CandidateUniverse } from "../target-field-causal-slice/candidate-universe.ts";
import type { ImpactChannel, LocalTransferKind } from "./task-relation-summary.ts";

export const TARGET_TABLE_CAUSAL_CLOSURE_ARTIFACT_TYPE = "TARGET_TABLE_UPSTREAM_CAUSAL_CLOSURE" as const;
export const TARGET_TABLE_CAUSAL_CLOSURE_SCHEMA_VERSION = "1.2.0" as const;

export type ChannelStatus = "CONFIRMED" | "CONDITIONAL" | "PROVEN_ABSENT" | "UNKNOWN" | "NOT_APPLICABLE";
export type RelationStatus = "CONFIRMED_RELATED" | "CONDITIONAL_RELATED" | "PROVEN_UNRELATED" | "UNKNOWN";

export interface ChannelAssessment {
  readonly channel: ImpactChannel;
  readonly status: ChannelStatus;
  readonly proofRefs: readonly string[];
  readonly witnessRefs: readonly string[];
  readonly gapRefs: readonly string[];
  /** Local operator/field transfer that established this target effect. */
  readonly localTransferKinds?: readonly LocalTransferKind[];
  /** Exact fields demanded by a downstream control or multiplicity operator. */
  readonly demandedFieldNames?: readonly string[];
  /** Present for FIELD_VALUE transfer explanations; never an assessment key. */
  readonly outputFieldBindingIds?: readonly string[];
  readonly affectedTargetFields?: readonly string[];
}

export interface NegativeProof {
  readonly proofId: string;
  readonly kind: "COMPLETE_UNIVERSE_NO_CAUSAL_PATH";
  readonly targetWriteId: string;
  readonly candidateBranchId: string;
  readonly universeStatus: "COMPLETE_OBSERVED_EVIDENCE";
  readonly closedChannels: readonly { readonly channel: ImpactChannel; readonly status: "PROVEN_ABSENT" | "NOT_APPLICABLE"; readonly proofRefs: readonly string[] }[];
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

export interface TargetTableCausalMetrics {
  readonly candidateBranchCount: number;
  readonly assessmentCount: number;
  readonly upstreamTaskCount: number;
  readonly fieldValueEvidenceScanCount: number;
  readonly evidenceClosureRate: number | "NOT_APPLICABLE";
  readonly decisionCoverage: { readonly numerator: number; readonly denominator: number; readonly rate: number };
  readonly bridgeStats: { readonly resolved: number; readonly ambiguous: number; readonly missing: number };
  /** Union-v2-only counters; absent in legacy artifacts for hash compatibility. */
  readonly continuationStats?: ContinuationStats;
  readonly peakMemoryBytes: number;
  /** Gate-B diagnostics; optional so older 1.1.0 artifacts remain readable. */
  readonly confirmedAssessmentCount?: number;
  readonly writeScopedConfirmedCount?: number;
  readonly crossChannelConfirmedBranchCount?: number;
  readonly crossWriteScopeLeakCount?: number;
  readonly unknownReasonCounts?: Readonly<Record<string, number>>;
}

export interface ContinuationStats {
  readonly l1: number;
  readonly l2Assumed: number;
  readonly l2Unknown: number;
  readonly piOnly: number;
  readonly disjointPruned: number;
  readonly ambiguousReads: number;
  readonly unmatchedReads: number;
  /** Same-task local reads that are not part of INDEX.externalReads. */
  readonly selfReadBoundaries?: number;
}

export interface CausalStageMetric {
  readonly stage: string;
  readonly elapsedMs: number;
  readonly calls: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly nodes: number;
  readonly edges: number;
  readonly peakMemoryBytes: number;
}

export const PRUNED_REASON_CODES = [
  "NO_PRODUCER_BRIDGE",
  "COVERAGE_BOUNDARY",
  "SCHEDULE_ONLY",
  "UNBOUND_READ",
  "BLOCKED_READ",
  "UNSUPPORTED_OPERATOR",
  "NO_CLOSED_PATH",
  "LEFT_DIM",
  "NOT_REACHED_FROM_ROOT",
  "RELATION_SUMMARY_INCOMPLETE",
  "FIELD_LINEAGE_OCC_MISMATCH",
  "TASK_LOCAL_MATERIALIZATION",
  "UNCLASSIFIED",
] as const;
export type PrunedReasonCode = (typeof PRUNED_REASON_CODES)[number];

export interface ShrinkReportEntry {
  readonly taskId: string;
  readonly table: string | null;
  readonly channel: ImpactChannel;
  readonly viaFields: readonly string[];
  readonly witness: readonly string[];
  /** JOIN relation identity for 档三; omitted on 档一/档二. */
  readonly joinNode?: string;
}

export interface PrunedReason {
  readonly reasonCode: PrunedReasonCode | string;
  readonly count: number;
  readonly samples?: readonly { readonly taskId: string | null; readonly table: string | null }[];
}

export interface ShrinkReport {
  readonly valueCertain: readonly ShrinkReportEntry[];
  readonly rowDetermining: readonly ShrinkReportEntry[];
  readonly multiplicityRisk: readonly ShrinkReportEntry[];
  readonly prunedCount: number;
  readonly prunedReasons: readonly PrunedReason[];
}

export interface TargetTableCausalClosureArtifact {
  readonly schemaVersion: typeof TARGET_TABLE_CAUSAL_CLOSURE_SCHEMA_VERSION;
  readonly artifactType: typeof TARGET_TABLE_CAUSAL_CLOSURE_ARTIFACT_TYPE;
  readonly generatedAt: string;
  readonly targetWrite: TargetWriteRef;
  readonly candidateUniverse: CandidateUniverse;
  readonly assessments: readonly TargetTableAssessment[];
  readonly shrinkReport?: ShrinkReport;
  readonly taskRollup: readonly UpstreamTaskRollup[];
  readonly minimumCertainTaskIds: readonly string[];
  readonly conservativeSafetyTaskIds: readonly string[];
  readonly runtimeRerunDecision: "NOT_EVALUATED";
  readonly relationSummaries: readonly { readonly taskId: string; readonly sqlSourceId: string; readonly statementIndex: number; readonly rootRelationId: string | null; readonly digest: string; readonly complete: boolean; readonly gapCount: number }[];
  readonly metrics: TargetTableCausalMetrics;
  readonly stages: readonly CausalStageMetric[];
  readonly gaps: readonly { readonly gapId: string; readonly reasonCode: string; readonly message: string; readonly evidenceRefs: readonly string[] }[];
  readonly contentHash: string;
}

export function relationRank(status: RelationStatus): number {
  return status === "CONFIRMED_RELATED" ? 3 : status === "CONDITIONAL_RELATED" ? 2 : status === "UNKNOWN" ? 1 : 0;
}

export function channelRank(status: ChannelStatus): number {
  return status === "CONFIRMED" ? 4 : status === "CONDITIONAL" ? 3 : status === "UNKNOWN" ? 2 : status === "PROVEN_ABSENT" ? 1 : 0;
}

function sorted(values: readonly string[]): readonly string[] { return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right)); }

function sortShrinkEntries(entries: readonly ShrinkReportEntry[]): readonly ShrinkReportEntry[] {
  return [...entries].sort((left, right) =>
    left.taskId.localeCompare(right.taskId)
    || (left.table ?? "").localeCompare(right.table ?? "")
    || (left.joinNode ?? "").localeCompare(right.joinNode ?? ""),
  );
}
function assessmentId(targetWriteId: string, branchId: string): string { return `target-table-assessment:${sha256(canonicalJson({ targetWriteId, branchId }))}`; }

function sortedNegativeProofs(values: readonly NegativeProof[]): readonly NegativeProof[] {
  return [...values].sort((left, right) => left.proofId.localeCompare(right.proofId)).map((proof) => ({
    ...proof,
    closedChannels: [...proof.closedChannels].sort((left, right) => left.channel.localeCompare(right.channel)).map((channel) => ({ ...channel, proofRefs: sorted(channel.proofRefs) })),
    premiseRefs: sorted(proof.premiseRefs),
  }));
}

export function createNegativeProof(input: Omit<NegativeProof, "proofId">): NegativeProof {
  const normalized = {
    ...input,
    closedChannels: [...input.closedChannels].sort((left, right) => left.channel.localeCompare(right.channel)).map((channel) => ({ ...channel, proofRefs: sorted(channel.proofRefs) })),
    premiseRefs: sorted(input.premiseRefs),
  };
  return { ...normalized, proofId: `negative-proof:${sha256(canonicalJson(normalized))}` };
}

export function canonicalAssessment(input: Omit<TargetTableAssessment, "assessmentId">): TargetTableAssessment {
  return {
    ...input,
    assessmentId: assessmentId(input.targetWriteId, input.candidateBranchId),
    channelAssessments: [...input.channelAssessments].sort((left, right) => left.channel.localeCompare(right.channel)).map((channel) => ({
      ...channel,
      proofRefs: sorted(channel.proofRefs),
      witnessRefs: sorted(channel.witnessRefs),
      gapRefs: sorted(channel.gapRefs),
      ...(channel.localTransferKinds ? { localTransferKinds: [...new Set(channel.localTransferKinds)].sort() } : {}),
      ...(channel.demandedFieldNames ? { demandedFieldNames: sorted(channel.demandedFieldNames) } : {}),
      ...(channel.outputFieldBindingIds ? { outputFieldBindingIds: sorted(channel.outputFieldBindingIds) } : {}),
      ...(channel.affectedTargetFields ? { affectedTargetFields: sorted(channel.affectedTargetFields) } : {}),
    })),
    evidenceRefs: sorted(input.evidenceRefs),
    gapRefs: sorted(input.gapRefs),
    negativeProofs: sortedNegativeProofs(input.negativeProofs),
  };
}

export function canonicalizeTargetTableArtifact(
  input: Omit<TargetTableCausalClosureArtifact, "contentHash">,
): TargetTableCausalClosureArtifact {
  const assessments = [...input.assessments].sort((left, right) => left.assessmentId.localeCompare(right.assessmentId));
  const stable = {
    ...input,
    assessments,
    taskRollup: [...input.taskRollup].sort((left, right) => left.producerTaskId.localeCompare(right.producerTaskId)),
    minimumCertainTaskIds: sorted(input.minimumCertainTaskIds),
    conservativeSafetyTaskIds: sorted(input.conservativeSafetyTaskIds),
    ...(input.shrinkReport
      ? {
          shrinkReport: {
            valueCertain: sortShrinkEntries(input.shrinkReport.valueCertain),
            rowDetermining: sortShrinkEntries(input.shrinkReport.rowDetermining),
            multiplicityRisk: sortShrinkEntries(input.shrinkReport.multiplicityRisk),
            prunedCount: input.shrinkReport.prunedCount,
            prunedReasons: [...input.shrinkReport.prunedReasons].sort((left, right) => left.reasonCode.localeCompare(right.reasonCode)).map((reason) => ({
              reasonCode: reason.reasonCode,
              count: reason.count,
              ...(reason.samples
                ? {
                    samples: [...reason.samples].sort((left, right) =>
                      (left.taskId ?? "").localeCompare(right.taskId ?? "") || (left.table ?? "").localeCompare(right.table ?? ""),
                    ),
                  }
                : {}),
            })),
          },
        }
      : {}),
    relationSummaries: [...input.relationSummaries].sort((left, right) => left.taskId.localeCompare(right.taskId) || left.sqlSourceId.localeCompare(right.sqlSourceId) || left.statementIndex - right.statementIndex),
    stages: [...input.stages].sort((left, right) => left.stage.localeCompare(right.stage)),
    gaps: [...input.gaps].sort((left, right) => left.gapId.localeCompare(right.gapId)),
  };
  return { ...stable, contentHash: sha256(canonicalJson(stable)) };
}

export function candidateBranchFor(
  universe: CandidateUniverse,
  branchId: string,
): CandidateBranch | undefined { return universe.branches.find((branch) => branch.candidateBranchId === branchId); }
