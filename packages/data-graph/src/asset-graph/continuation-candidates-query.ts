import type { UnionContinuationIndexEntry } from "../continuation/continuation-index.ts";
import { loadPublishedContinuationIndex } from "./continuation-metrics-query.ts";

/** Read candidates already frozen in the current published INDEX. */
export function readPublishedContinuationCandidates(input: {
  graphOutputRoot: string;
  readOccurrenceId: string;
  consumerTaskId?: string;
  publicationVersion?: string;
  offset?: number;
  limit?: number;
}) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 25;
  if (!input.readOccurrenceId.trim())
    throw new Error("INVALID_ARGUMENT:--read-occurrence-id");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
    throw new Error("INVALID_ARGUMENT:--offset");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("INVALID_ARGUMENT:--limit");
  const { publication, index, pinnedIndexHash } =
    loadPublishedContinuationIndex({
      graphOutputRoot: input.graphOutputRoot,
      publicationVersion: input.publicationVersion,
    });
  const matches = index.entries.filter(
    (entry) =>
      entry.readOccurrenceId === input.readOccurrenceId &&
      (input.consumerTaskId === undefined ||
        entry.consumerTaskId === input.consumerTaskId),
  );
  if (matches.length === 0)
    throw new Error("READ_OCCURRENCE_NOT_IN_PUBLISHED_INDEX");
  if (matches.length > 1)
    throw new Error("READ_OCCURRENCE_AMBIGUOUS:--consumer-task-id");
  const entry = matches[0]!;
  const items = entry.candidates
    .map((candidate) => ({
      writerTaskId: candidate.taskId,
      writeObservationId: candidate.writeObservationId,
      matching: {
        partitionMatchStatus: candidate.partitionMatchStatus,
        evidenceLayer: candidate.evidenceLayer,
        l1Eligible: candidate.l1Eligible,
        source: candidate.source,
        outputQualification: candidate.outputQualification ?? null,
        alignmentGapCode: candidate.alignmentGapCode ?? null,
        reasonCode: candidate.reasonCode ?? null,
      },
      writePartitionEvidence: candidate.partition.map((partition) => ({
        column: partition.column,
        values: partition.values,
        partitionStatus: partition.partitionStatus ?? null,
        valueStatus: partition.valueStatus ?? null,
        observedValue: partition.observedValue ?? null,
        expression: partition.expression ?? null,
      })),
    }))
    .sort(
      (left, right) =>
        left.writerTaskId.localeCompare(right.writerTaskId) ||
        left.writeObservationId.localeCompare(right.writeObservationId),
    );
  return {
    snapshotKind: "PUBLISHED_INDEX" as const,
    publicationVersion: publication.version as string,
    compilerVersion: publication.compilerVersion as string,
    indexContentHash: index.contentHash,
    indexBinding:
      pinnedIndexHash === undefined
        ? ("LEGACY_PUBLICATION_DIRECTORY" as const)
        : ("PUBLICATION_CONTENT_HASH" as const),
    read: readEvidence(entry),
    items: items.slice(offset, offset + limit),
    pagination: {
      offset,
      limit,
      total: items.length,
      nextOffset: offset + limit < items.length ? offset + limit : null,
    },
  };
}

function readEvidence(entry: UnionContinuationIndexEntry) {
  return {
    consumerTaskId: entry.consumerTaskId,
    readOccurrenceId: entry.readOccurrenceId,
    qualifiedName: entry.qualifiedName,
    identityStatus: entry.identityStatus,
    partitionPredicateStatus: entry.partitionPredicateStatus,
    evidenceRefs: evidenceRefs(entry),
  };
}

function evidenceRefs(entry: UnionContinuationIndexEntry): readonly string[] {
  return [
    ...new Set(
      entry.gaps.flatMap((gap) => {
        if (typeof gap.details["writeObservationId"] === "string") return [];
        const refs = gap.details["evidenceRefs"];
        return Array.isArray(refs)
          ? refs.filter((ref): ref is string => typeof ref === "string")
          : [];
      }),
    ),
  ].sort();
}
