import type { ContinuationCandidate } from "../types.ts";
import { withContinuationCandidate } from "../types.ts";

export const PRUNE_DISJOINT_RULE_ID = "PRUNE_DISJOINT" as const;

export function applyPruneDisjoint(
  candidates: readonly ContinuationCandidate[],
): readonly ContinuationCandidate[] {
  return candidates
    .filter((candidate) =>
      candidate.index.partitionMatchStatus !== "DISJOINT"
      && candidate.partitionOverlap !== "PROVEN_DISJOINT",
    )
    .map((candidate) => withContinuationCandidate(candidate, {
      ruleId: PRUNE_DISJOINT_RULE_ID,
    }));
}
