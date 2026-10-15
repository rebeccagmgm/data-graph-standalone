import { normalizeName } from "../../../../../../machine-facts/machine-facts-contract.ts";
import type { ContinuationPorts } from "../ports.ts";
import type { ContinuationPolicy } from "../policy.ts";
import type { ContinuationCandidate, PartitionOverlapStatus } from "../types.ts";
import { withContinuationCandidate } from "../types.ts";

/** PRUNE_ONLY — never sets continuationEligible. */
export const SCHEDULE_TIEBREAK_RULE_ID = "SCHEDULE_TIEBREAK" as const;

const OVERLAP_FOR_TIEBREAK = new Set<PartitionOverlapStatus>([
  "PROVEN_OVERLAP",
  "POSSIBLE_OVERLAP",
]);

function tableKey(candidate: ContinuationCandidate): string {
  return normalizeName(candidate.index.qualifiedName);
}

function mayOverlap(candidate: ContinuationCandidate): boolean {
  return OVERLAP_FOR_TIEBREAK.has(candidate.partitionOverlap);
}

function uniqueDirectParentTaskIds(input: {
  readonly consumerTaskId: string;
  readonly candidates: readonly ContinuationCandidate[];
  readonly ports: ContinuationPorts;
}): readonly string[] {
  const lookup = input.ports.scheduleLookup;
  if (!lookup || lookup.statusFor(input.consumerTaskId) !== "AVAILABLE") {
    return [];
  }
  return [...new Set(
    input.candidates
      .filter((candidate) =>
        candidate.index.taskId !== input.consumerTaskId
        && lookup.isDirectParent(input.consumerTaskId, candidate.index.taskId),
      )
      .map((candidate) => candidate.index.taskId),
  )];
}

function dropKeysForGroup(input: {
  readonly consumerTaskId: string;
  readonly group: readonly ContinuationCandidate[];
  readonly ports: ContinuationPorts;
}): ReadonlySet<string> {
  const overlapping = input.group.filter(mayOverlap);
  if (overlapping.length < 2) return new Set();

  const parents = uniqueDirectParentTaskIds({
    consumerTaskId: input.consumerTaskId,
    candidates: overlapping,
    ports: input.ports,
  });
  if (parents.length !== 1) return new Set();

  const keepTaskId = parents[0]!;
  const drop = new Set<string>();
  for (const candidate of overlapping) {
    if (candidate.index.taskId === keepTaskId) continue;
    drop.add(`${tableKey(candidate)}\u0000${candidate.index.taskId}`);
  }
  return drop;
}

export function applyScheduleTiebreak(input: {
  readonly consumerTaskId: string;
  readonly candidates: readonly ContinuationCandidate[];
  readonly ports: ContinuationPorts;
  readonly policy: ContinuationPolicy;
}): readonly ContinuationCandidate[] {
  void input.policy;
  if (input.candidates.length <= 1) {
    return input.candidates;
  }
  if (input.ports.scheduleLookup?.statusFor(input.consumerTaskId) !== "AVAILABLE") {
    return input.candidates;
  }

  const groups = new Map<string, ContinuationCandidate[]>();
  for (const candidate of input.candidates) {
    const key = tableKey(candidate);
    const bucket = groups.get(key) ?? [];
    bucket.push(candidate);
    groups.set(key, bucket);
  }

  const dropKeys = new Set<string>();
  for (const group of groups.values()) {
    for (const key of dropKeysForGroup({
      consumerTaskId: input.consumerTaskId,
      group,
      ports: input.ports,
    })) {
      dropKeys.add(key);
    }
  }

  if (dropKeys.size === 0) {
    return input.candidates;
  }

  return input.candidates
    .filter((candidate) =>
      !dropKeys.has(`${tableKey(candidate)}\u0000${candidate.index.taskId}`),
    )
    .map((candidate) => withContinuationCandidate(candidate, {
      ruleId: SCHEDULE_TIEBREAK_RULE_ID,
    }));
}
