import {
  scheduleParentAmbiguousGap,
  type HoraeScheduleRelationLookup,
} from "../schedule-preference.ts";
import type { ContinuationPolicy } from "./policy.ts";
import type { ContinuationCandidate } from "./types.ts";
import { withContinuationCandidate } from "./types.ts";

export function directParentTaskIdsForCandidates(input: {
  readonly consumerTaskId: string;
  readonly candidates: readonly ContinuationCandidate[];
  readonly lookup: HoraeScheduleRelationLookup | null;
}): readonly string[] {
  if (!input.lookup) return [];
  if (input.lookup.statusFor(input.consumerTaskId) !== "AVAILABLE") return [];
  return input.candidates
    .filter((candidate) =>
      candidate.index.taskId !== input.consumerTaskId
      && input.lookup!.isDirectParent(input.consumerTaskId, candidate.index.taskId),
    )
    .map((candidate) => candidate.index.taskId)
    .sort((left, right) => left.localeCompare(right));
}

export function reduceContinuationCandidates(input: {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly column: string;
  readonly candidates: readonly ContinuationCandidate[];
  readonly policy: ContinuationPolicy;
  readonly scheduleLookup: HoraeScheduleRelationLookup | null;
}): {
  readonly candidates: readonly ContinuationCandidate[];
  readonly scheduleParentAmbiguous: boolean;
} {
  const pruned = input.candidates.filter(
    (candidate) => !input.policy.pruneOn.includes(candidate.partitionOverlap),
  );

  const directParents = directParentTaskIdsForCandidates({
    consumerTaskId: input.consumerTaskId,
    candidates: pruned,
    lookup: input.scheduleLookup,
  });
  const scheduleParentAmbiguous = directParents.length > 1;

  const candidates = pruned.map((candidate) => {
    const overlapEligible = input.policy.confirmOn.includes(
      candidate.partitionOverlap,
    );
    // Field evidence may narrow INDEX eligibility, never grant it again from
    // overlap alone. Schedule ambiguity is reported separately from evidence.
    const eligible = overlapEligible
      && candidate.partitionOverlap === "PROVEN_OVERLAP"
      && candidate.index.partitionMatchStatus === "CONFIRMED"
      && candidate.index.l1Eligible === true
      && candidate.index.evidenceLayer === "L1"
      && candidate.index.source === "IN_UNION_FINAL_WRITE"
      && candidate.index.targetWriteNodeId !== null;
    return withContinuationCandidate(candidate, {
      continuationEligible: eligible,
      ruleId: "CONTINUATION_REDUCE",
    });
  });

  return { candidates, scheduleParentAmbiguous };
}

export function scheduleAmbiguousGapForPipeline(input: {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly column: string;
  readonly directParentTaskIds: readonly string[];
}) {
  return scheduleParentAmbiguousGap(input);
}
