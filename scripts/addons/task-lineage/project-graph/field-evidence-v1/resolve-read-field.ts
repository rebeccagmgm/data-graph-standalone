import type {
  UnionContinuationCandidateSource,
  UnionContinuationIndexCandidate,
} from "../../../../reconcile/consumer/target-table-upstream-causal-closure/union-continuation-candidate-source.ts";
import {
  applyContinuationRules,
  indexCandidateFromContinuation,
} from "./continuation/pipeline.ts";
import type { ContinuationPorts } from "./continuation/ports.ts";
import type { FieldEdgeIndex, IndexedFieldEdge } from "./field-edge-index.ts";
import type { FieldImpactGap } from "./impact-result-contract.ts";

export type ResolveReadFieldConfirmed = {
  readonly kind: "CONFIRMED";
  readonly candidate: UnionContinuationIndexCandidate;
  readonly producerEdges: readonly IndexedFieldEdge[];
};

export type ResolveReadFieldFrontier = {
  readonly kind: "FRONTIER";
  readonly readOccurrenceId: string;
  readonly column: string;
  readonly candidates: readonly UnionContinuationIndexCandidate[];
  readonly reasonCode: "MULTI_WRITER_CANDIDATE_FRONTIER";
  readonly gaps: readonly FieldImpactGap[];
};

export type ResolveReadFieldNoIndexEntry = {
  readonly kind: "NO_INDEX_ENTRY";
  readonly readOccurrenceId: string;
  readonly column: string;
};

export type ResolveReadFieldNoBinding = {
  readonly kind: "NO_BINDING";
  readonly candidate: UnionContinuationIndexCandidate;
  readonly readOccurrenceId: string;
  readonly column: string;
};

export type ResolveReadFieldResult =
  | ResolveReadFieldConfirmed
  | ResolveReadFieldFrontier
  | ResolveReadFieldNoIndexEntry
  | ResolveReadFieldNoBinding;

function normalizeColumn(column: string): string {
  return column.trim().toLowerCase();
}

export function resolveReadField(input: {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly column: string;
  readonly index: UnionContinuationCandidateSource;
  readonly producerIndexForTask: (taskId: string) => FieldEdgeIndex | null;
  readonly continuationPorts: ContinuationPorts;
}): ResolveReadFieldResult {
  const column = normalizeColumn(input.column);
  const entry = input.index.entryForRead(
    input.consumerTaskId,
    input.readOccurrenceId,
  );
  if (!entry) {
    return {
      kind: "NO_INDEX_ENTRY",
      readOccurrenceId: input.readOccurrenceId,
      column,
    };
  }

  const pipelineResult = applyContinuationRules({
    pipeline: {
      consumerTaskId: input.consumerTaskId,
      readOccurrenceId: input.readOccurrenceId,
      column,
      candidates: entry.candidates,
    },
    qualifiedName: entry.qualifiedName,
    ports: input.continuationPorts,
  });

  const candidates = pipelineResult.candidates.map(indexCandidateFromContinuation);
  if (candidates.length !== 1 || candidates[0]!.l1Eligible !== true) {
    return {
      kind: "FRONTIER",
      readOccurrenceId: input.readOccurrenceId,
      column,
      candidates,
      reasonCode: "MULTI_WRITER_CANDIDATE_FRONTIER",
      gaps: pipelineResult.gaps,
    };
  }

  const candidate = candidates[0]!;
  const producerIndex = input.producerIndexForTask(candidate.taskId);
  if (!producerIndex) {
    return {
      kind: "NO_BINDING",
      candidate,
      readOccurrenceId: input.readOccurrenceId,
      column,
    };
  }
  const producerEdges = producerIndex.edgesForBinding(
    candidate.writeObservationId,
    column,
  );
  if (producerEdges.length === 0) {
    return {
      kind: "NO_BINDING",
      candidate,
      readOccurrenceId: input.readOccurrenceId,
      column,
    };
  }

  return {
    kind: "CONFIRMED",
    candidate,
    producerEdges,
  };
}
