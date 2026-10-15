import type { UnionContinuationIndexCandidate } from "../../../../../reconcile/consumer/target-table-upstream-causal-closure/union-continuation-candidate-source.ts";
import type { FieldImpactGap } from "../impact-result-contract.ts";

export const CONTINUATION_POLICY_SCHEMA_VERSION = "1.0.0" as const;

export type ContinuationStage = "PRUNE" | "REMATCH" | "DECIDE";

export type ContinuationCapability =
  | "PRUNE_ONLY"
  | "ANNOTATE"
  | "MAY_MARK_ELIGIBLE";

export type PartitionOverlapStatus =
  | "PROVEN_OVERLAP"
  | "POSSIBLE_OVERLAP"
  | "PROVEN_DISJOINT"
  | "UNKNOWN";

export interface ContinuationCandidate {
  readonly index: UnionContinuationIndexCandidate;
  readonly partitionOverlap: PartitionOverlapStatus;
  readonly continuationEligible: boolean;
  readonly appliedRuleIds: readonly string[];
}

export interface ContinuationPipelineInput {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly column: string;
  readonly candidates: readonly UnionContinuationIndexCandidate[];
}

export interface ContinuationPipelineResult {
  readonly candidates: readonly ContinuationCandidate[];
  readonly gaps: readonly FieldImpactGap[];
  readonly scheduleParentAmbiguous: boolean;
  readonly directParentTaskIds: readonly string[];
}

export function indexPartitionToOverlap(
  status: UnionContinuationIndexCandidate["partitionMatchStatus"],
): PartitionOverlapStatus {
  switch (status) {
    case "CONFIRMED":
      return "PROVEN_OVERLAP";
    case "ASSUMED":
      return "POSSIBLE_OVERLAP";
    case "DISJOINT":
      return "PROVEN_DISJOINT";
    default:
      return "UNKNOWN";
  }
}

export function overlapToIndexPartition(
  overlap: PartitionOverlapStatus,
): UnionContinuationIndexCandidate["partitionMatchStatus"] {
  switch (overlap) {
    case "PROVEN_OVERLAP":
      return "CONFIRMED";
    case "POSSIBLE_OVERLAP":
      return "ASSUMED";
    case "PROVEN_DISJOINT":
      return "DISJOINT";
    default:
      return "UNKNOWN";
  }
}

export function continuationCandidateFromIndex(
  candidate: UnionContinuationIndexCandidate,
): ContinuationCandidate {
  return {
    index: candidate,
    partitionOverlap: indexPartitionToOverlap(candidate.partitionMatchStatus),
    continuationEligible: candidate.l1Eligible === true,
    appliedRuleIds: [],
  };
}

export function withContinuationCandidate(
  candidate: ContinuationCandidate,
  patch: Partial<Pick<ContinuationCandidate, "partitionOverlap" | "continuationEligible">>
    & { readonly ruleId?: string },
): ContinuationCandidate {
  return {
    index: candidate.index,
    partitionOverlap: patch.partitionOverlap ?? candidate.partitionOverlap,
    continuationEligible: patch.continuationEligible ?? candidate.continuationEligible,
    appliedRuleIds: patch.ruleId
      ? [...candidate.appliedRuleIds, patch.ruleId]
      : candidate.appliedRuleIds,
  };
}
