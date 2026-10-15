import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeRelationCache,
} from "../../../../evidence/schedule-evidence-cache.ts";
import { stableId } from "../../../../project-graph/task-local/ids.ts";
import type {
  FieldImpactFrontierCandidate,
  FieldImpactGap,
} from "./impact-result-contract.ts";

export type FieldImpactScheduleRelation =
  | "DIRECT_PARENT"
  | "NOT_IN_HORAE_UPSTREAM"
  | "HORAE_UNAVAILABLE";

export type HoraeScheduleLookupStatus = "AVAILABLE" | "UNAVAILABLE";

export interface HoraeScheduleRelationLookup {
  readonly statusFor: (consumerTaskId: string) => HoraeScheduleLookupStatus;
  readonly isDirectParent: (
    consumerTaskId: string,
    producerTaskId: string,
  ) => boolean;
  readonly directParentTaskIds: (consumerTaskId: string) => readonly string[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function upstreamTaskIdsFromRows(
  rows: readonly Record<string, unknown>[],
  consumerTaskId: string,
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const neighborId = text(row.task_id ?? row.taskId);
    if (neighborId && neighborId !== consumerTaskId) ids.add(neighborId);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

export function createHoraeScheduleRelationLookupFromScheduleEdges(
  scheduleEdges: unknown,
): HoraeScheduleRelationLookup {
  if (!Array.isArray(scheduleEdges)) {
    return unavailableHoraeScheduleRelationLookup();
  }

  const producersByConsumer = new Map<string, Set<string>>();
  for (const rawEdge of scheduleEdges) {
    const edge = record(rawEdge);
    const consumerTaskId = text(edge?.consumerTaskId ?? edge?.consumer_task_id);
    const producerTaskId = text(edge?.producerTaskId ?? edge?.producer_task_id);
    if (!consumerTaskId || !producerTaskId) {
      return unavailableHoraeScheduleRelationLookup();
    }
    const producerTaskIds =
      producersByConsumer.get(consumerTaskId) ?? new Set<string>();
    producerTaskIds.add(producerTaskId);
    producersByConsumer.set(consumerTaskId, producerTaskIds);
  }

  const parentsByConsumer = new Map<string, readonly string[]>();
  for (const [consumerTaskId, producerTaskIds] of producersByConsumer) {
    parentsByConsumer.set(
      consumerTaskId,
      [...producerTaskIds].sort((left, right) => left.localeCompare(right)),
    );
  }

  return {
    statusFor: () => "AVAILABLE",
    directParentTaskIds: (consumerTaskId) => parentsByConsumer.get(consumerTaskId) ?? [],
    isDirectParent: (consumerTaskId, producerTaskId) =>
      producersByConsumer.get(consumerTaskId)?.has(producerTaskId) ?? false,
  };
}

function unavailableHoraeScheduleRelationLookup(): HoraeScheduleRelationLookup {
  return {
    statusFor: () => "UNAVAILABLE",
    directParentTaskIds: () => [],
    isDirectParent: () => false,
  };
}

export function createHoraeScheduleRelationLookupFromCache(
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): HoraeScheduleRelationLookup {
  const cache = new Map<
    string,
    { readonly status: HoraeScheduleLookupStatus; readonly parents: readonly string[] }
  >();

  function load(consumerTaskId: string) {
    let entry = cache.get(consumerTaskId);
    if (entry) return entry;

    const read = readHoraeRelationCache(consumerTaskId, cacheRoot, "up");
    entry = read.status === "HIT"
      ? {
        status: "AVAILABLE",
        parents: upstreamTaskIdsFromRows(read.rows, consumerTaskId),
      }
      : { status: "UNAVAILABLE", parents: [] };
    cache.set(consumerTaskId, entry);
    return entry;
  }

  return {
    statusFor: (consumerTaskId) => load(consumerTaskId).status,
    directParentTaskIds: (consumerTaskId) => load(consumerTaskId).parents,
    isDirectParent: (consumerTaskId, producerTaskId) => {
      const entry = load(consumerTaskId);
      return entry.status === "AVAILABLE" && entry.parents.includes(producerTaskId);
    },
  };
}

export function scheduleRelationForCandidate(input: {
  readonly lookup: HoraeScheduleRelationLookup | null | undefined;
  readonly consumerTaskId: string;
  readonly producerTaskId: string;
}): FieldImpactScheduleRelation {
  if (!input.lookup) return "HORAE_UNAVAILABLE";
  if (input.lookup.statusFor(input.consumerTaskId) === "UNAVAILABLE") {
    return "HORAE_UNAVAILABLE";
  }
  return input.lookup.isDirectParent(input.consumerTaskId, input.producerTaskId)
    ? "DIRECT_PARENT"
    : "NOT_IN_HORAE_UPSTREAM";
}

export function scheduleParentAmbiguousGap(input: {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly column: string;
  readonly directParentTaskIds: readonly string[];
}): FieldImpactGap {
  return {
    gapId: stableId("gap", {
      reasonCode: "SCHEDULE_PARENT_AMBIGUOUS",
      consumerTaskId: input.consumerTaskId,
      readOccurrenceId: input.readOccurrenceId,
      column: input.column,
    }),
    reasonCode: "SCHEDULE_PARENT_AMBIGUOUS",
    details: {
      consumerTaskId: input.consumerTaskId,
      readOccurrenceId: input.readOccurrenceId,
      column: input.column,
      directParentTaskIds: [...input.directParentTaskIds],
    },
  };
}

export function enrichFrontierCandidates(input: {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly column: string;
  readonly candidates: readonly FieldImpactFrontierCandidate[];
  readonly lookup: HoraeScheduleRelationLookup | null | undefined;
}): {
  readonly candidates: readonly FieldImpactFrontierCandidate[];
  readonly gaps: readonly FieldImpactGap[];
} {
  const indexed = input.candidates.map((candidate, index) => ({ candidate, index }));
  const withRelation = indexed.map(({ candidate, index }) => ({
    index,
    candidate,
    scheduleRelation: scheduleRelationForCandidate({
      lookup: input.lookup,
      consumerTaskId: input.consumerTaskId,
      producerTaskId: candidate.taskId,
    }),
  }));

  const directParents = withRelation.filter(
    (entry) => entry.scheduleRelation === "DIRECT_PARENT",
  );
  const gaps: FieldImpactGap[] = [];
  let preferredTaskId: string | null = null;
  if (directParents.length === 1) {
    preferredTaskId = directParents[0]!.candidate.taskId;
  } else if (directParents.length > 1) {
    gaps.push(scheduleParentAmbiguousGap({
      consumerTaskId: input.consumerTaskId,
      readOccurrenceId: input.readOccurrenceId,
      column: input.column,
      directParentTaskIds: directParents.map((entry) => entry.candidate.taskId),
    }));
  }

  const enriched = withRelation.map((entry) => ({
    index: entry.index,
    candidate: {
      ...entry.candidate,
      scheduleRelation: entry.scheduleRelation,
      schedulePreferred:
        preferredTaskId !== null && entry.candidate.taskId === preferredTaskId,
    },
  }));

  enriched.sort((left, right) => {
    if (left.candidate.schedulePreferred !== right.candidate.schedulePreferred) {
      return left.candidate.schedulePreferred ? -1 : 1;
    }
    return left.index - right.index;
  });

  return { candidates: enriched.map((entry) => entry.candidate), gaps };
}
