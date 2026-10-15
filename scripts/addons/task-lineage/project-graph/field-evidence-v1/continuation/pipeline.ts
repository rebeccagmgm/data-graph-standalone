import type { FieldImpactGap } from "../impact-result-contract.ts";
import type { UnionContinuationIndexCandidate } from "../../../../../reconcile/consumer/target-table-upstream-causal-closure/union-continuation-candidate-source.ts";
import type { ContinuationPorts } from "./ports.ts";
import {
  DEFAULT_CONTINUATION_POLICY,
  type ContinuationPolicy,
} from "./policy.ts";
import { applyRegistryRules } from "./registry.ts";
import {
  reduceContinuationCandidates,
  scheduleAmbiguousGapForPipeline,
  directParentTaskIdsForCandidates,
} from "./reduce.ts";
import {
  continuationCandidateFromIndex,
  overlapToIndexPartition,
  type ContinuationCandidate,
  type ContinuationPipelineInput,
  type ContinuationPipelineResult,
} from "./types.ts";

export function applyContinuationRules(input: {
  readonly pipeline: ContinuationPipelineInput;
  readonly qualifiedName: string;
  readonly ports: ContinuationPorts;
  readonly policy?: ContinuationPolicy;
}): ContinuationPipelineResult {
  const policy = input.policy ?? DEFAULT_CONTINUATION_POLICY;
  let candidates: readonly ContinuationCandidate[] = input.pipeline.candidates.map(
    continuationCandidateFromIndex,
  );
  const gaps: FieldImpactGap[] = [];

  for (const stage of ["PRUNE", "REMATCH"] as const) {
    const stageResult = applyRegistryRules({
      stage,
      consumerTaskId: input.pipeline.consumerTaskId,
      readOccurrenceId: input.pipeline.readOccurrenceId,
      column: input.pipeline.column,
      qualifiedName: input.qualifiedName,
      candidates,
      ports: input.ports,
      policy,
    });
    candidates = stageResult.candidates;
    gaps.push(...stageResult.gaps);
  }

  const directParentTaskIds = directParentTaskIdsForCandidates({
    consumerTaskId: input.pipeline.consumerTaskId,
    candidates,
    lookup: input.ports.scheduleLookup,
  });

  const reduced = reduceContinuationCandidates({
    consumerTaskId: input.pipeline.consumerTaskId,
    readOccurrenceId: input.pipeline.readOccurrenceId,
    column: input.pipeline.column,
    candidates,
    policy,
    scheduleLookup: input.ports.scheduleLookup,
  });
  candidates = reduced.candidates;

  if (reduced.scheduleParentAmbiguous) {
    gaps.push(scheduleAmbiguousGapForPipeline({
      consumerTaskId: input.pipeline.consumerTaskId,
      readOccurrenceId: input.pipeline.readOccurrenceId,
      column: input.pipeline.column,
      directParentTaskIds,
    }));
  }

  return {
    candidates,
    gaps,
    scheduleParentAmbiguous: reduced.scheduleParentAmbiguous,
    directParentTaskIds,
  };
}

export function indexCandidateFromContinuation(
  candidate: import("./types.ts").ContinuationCandidate,
): UnionContinuationIndexCandidate {
  return {
    ...candidate.index,
    partitionMatchStatus: overlapToIndexPartition(candidate.partitionOverlap),
    evidenceLayer: candidate.continuationEligible ? "L1" : "L2",
    l1Eligible: candidate.continuationEligible,
  };
}
