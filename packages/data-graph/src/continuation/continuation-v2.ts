import { compareText, sortedUnique } from "../contracts/ordering.ts";
import { matchesReadPartitionRange } from "../../../../scripts/project-graph/task-local/partition-range.ts";
import { isDayPartitionValue } from "../../../../scripts/project-graph/task-local/partition-day-grain.ts";
import { expandPartitionAlternatives } from "../../../../scripts/project-graph/task-local/partition-alternatives.ts";
import {
  isUnionContinuationV2ProjectionSchema,
  type TaskLocalProjectionClosure,
} from "./task-local-projection.ts";
import type { ProducerIndexWriter } from "./producer-writer.ts";
import {
  normalizeName,
  type TaskLocalUnionMergeResult,
  type TaskLocalUnionTaskEvidence,
} from "./continuation-input.ts";
import {
  canonicalPartitionValue,
  isTemporalPartitionColumn,
  partitionCanonicalValuesOverlap,
  writePartitionRawValues,
} from "../../../../scripts/project-graph/task-local/partition-canonical.ts";

export type PartitionMatchStatus =
  "CONFIRMED" | "ASSUMED" | "UNKNOWN" | "DISJOINT";

export const CONTINUATION_MATCH_POLICY_VERSION = "business-partitions-first-v3";

export type UnionContinuationEvidenceLayer = "L1" | "L2";

export type UnionContinuationGapCode =
  | "READ_OCCURRENCE_NOT_FOUND"
  | "READ_IDENTITY_NOT_CONFIRMED"
  | "NO_KNOWN_WRITE_OBSERVATION"
  | "WRITER_NOT_IN_UNION"
  | "WRITE_OBSERVATION_ALIGNMENT_AMBIGUOUS"
  | "PARTITION_NON_LITERAL"
  | "WRITER_PARTITION_UNKNOWN"
  | "PARTITION_NO_MATCH"
  | "SOURCE_ENDPOINT_BOUNDARY";

export interface UnionContinuationReadOccurrence {
  readonly readOccurrenceId: string;
  readonly readOccurrenceNodeId: string;
  readonly datasetNodeId: string;
  readonly qualifiedName: string;
  readonly identityStatus: string;
  readonly partitionPredicateStatus: "NONE" | "LITERAL" | "NON_LITERAL_PRESENT";
  readonly partitionPredicates: readonly PartitionPredicate[];
  readonly partitionRange?: unknown;
}

export interface PartitionPredicate {
  readonly column: string;
  readonly values: readonly string[];
}

export interface UnionContinuationWriteObservation {
  readonly taskId: string;
  readonly writeObservationId: string;
  readonly targetWriteNodeId: string | null;
  readonly datasetNodeId: string | null;
  readonly qualifiedName: string;
  readonly source:
    "IN_UNION_FINAL_WRITE" | "PRODUCER_INDEX_ONLY" | "SCHEDULE_RELATION_TABLE";
  readonly outputQualification?: TaskLocalProjectionClosure["finalWrites"][number]["outputQualification"];
  readonly partition: readonly ProducerPartition[];
  readonly partitionStatus: string | null;
}

export interface ProducerPartition {
  readonly mayBeNull?: boolean;
  readonly alternatives?: readonly import("../../../../scripts/project-graph/task-local/partition-alternatives.ts").PartitionAlternative[];
  readonly column: string;
  readonly values: readonly string[];
  readonly partitionStatus?: string;
  readonly valueStatus?: string;
  readonly observedValue?: string | null;
  readonly expression?: string;
}

export interface UnionContinuationCandidate {
  readonly writeObservation: UnionContinuationWriteObservation;
  readonly partitionMatchStatus: PartitionMatchStatus;
  /** A write observation is L1 only when it is in-union and exactly matched. */
  readonly evidenceLayer: UnionContinuationEvidenceLayer;
  readonly l1Eligible: boolean;
}

export interface UnionContinuationGap {
  readonly gapId: string;
  readonly reasonCode: UnionContinuationGapCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface TraceUnionContinuationV2Options {
  readonly merge: TaskLocalUnionMergeResult;
  readonly readOccurrenceId: string;
  readonly consumerTaskId?: string;
  /** Confirmed producer-index write observations. Schedule data is not accepted. */
  readonly producerIndexWriters?: readonly ProducerIndexWriter[];
}

export interface TraceUnionContinuationV2Result {
  readonly readOccurrence: UnionContinuationReadOccurrence;
  readonly tiers: {
    /** Same physical table, before partition pruning. */
    readonly table: {
      readonly evidenceLayer: UnionContinuationEvidenceLayer;
      readonly candidateWriteObservationIds: readonly string[];
      readonly candidates: readonly UnionContinuationCandidate[];
    };
    /** Per-write partition decisions. DISJOINT candidates are pruned here. */
    readonly partition: {
      readonly candidateWriteObservationIds: readonly string[];
      readonly prunedWriteObservationIds: readonly string[];
      readonly candidates: readonly UnionContinuationCandidate[];
      readonly pruned: boolean;
    };
    /** Never collapses multiple matching writes back to taskId. */
    readonly writeObservation: {
      readonly candidateWriteObservationIds: readonly string[];
      readonly candidates: readonly UnionContinuationCandidate[];
      readonly uniqueWriteObservationId: string | null;
    };
  };
  readonly gaps: readonly UnionContinuationGap[];
}

export interface TraceUnionTaskContinuationV2Options {
  readonly merge: TaskLocalUnionMergeResult;
  readonly consumerTaskId: string;
  readonly producerIndexWriters?: readonly ProducerIndexWriter[];
}

export interface TraceUnionTaskContinuationV2Result {
  readonly consumerTaskId: string;
  readonly readOccurrences: readonly TraceUnionContinuationV2Result[];
}

/**
 * WP-8: table -> partition -> write-observation continuation.
 *
 * Cross-task matching first uses WP-7 finalWrites/externalReads. When that
 * physical identity does not match, an exact upstream table carried by Horae
 * can select that upstream task's real final write.
 */
export function traceUnionContinuationV2(
  options: TraceUnionContinuationV2Options,
): TraceUnionContinuationV2Result {
  assertV2ProjectionEvidence(options);
  const read = findReadOccurrence(options);
  if (!read) {
    throw new Error(
      `UNION_CONTINUATION_READ_OCCURRENCE_NOT_FOUND:${options.readOccurrenceId}`,
    );
  }

  const gaps: UnionContinuationGap[] = [];
  if (read.identityStatus !== "CONFIRMED") {
    gaps.push({
      gapId: `read-identity-not-confirmed:${read.readOccurrenceId}`,
      reasonCode: "READ_IDENTITY_NOT_CONFIRMED",
      message: "Read occurrence physical identity is not confirmed",
      details: {
        readOccurrenceId: read.readOccurrenceId,
        identityStatus: read.identityStatus,
      },
    });
  }

  const collected = collectWriteObservations(
    options.merge,
    read,
    options.producerIndexWriters ?? [],
  );
  const tableCandidates = collected.candidates;
  gaps.push(...collected.alignmentGaps);
  if (tableCandidates.length === 0) {
    gaps.push({
      gapId: `no-known-write-observation:${read.datasetNodeId}`,
      reasonCode: "NO_KNOWN_WRITE_OBSERVATION",
      message: `No known write observation for ${read.qualifiedName}`,
      details: {
        datasetNodeId: read.datasetNodeId,
        qualifiedName: read.qualifiedName,
      },
    });
  }

  for (const candidate of tableCandidates) {
    if (candidate.writeObservation.source === "PRODUCER_INDEX_ONLY") {
      gaps.push({
        gapId: `writer-not-in-union:${read.datasetNodeId}:${candidate.writeObservation.writeObservationId}`,
        reasonCode: "WRITER_NOT_IN_UNION",
        message: `Write observation ${candidate.writeObservation.writeObservationId} is outside the union`,
        details: {
          datasetNodeId: read.datasetNodeId,
          taskId: candidate.writeObservation.taskId,
          writeObservationId: candidate.writeObservation.writeObservationId,
        },
      });
    }
  }

  const businessPredicates = read.partitionPredicates.filter(
    (p) => !isBusinessDate(p.column),
  );
  const businessRead: UnionContinuationReadOccurrence = {
    ...read,
    partitionPredicates: businessPredicates,
    // A read constrained only by the deferred date reads all business scopes.
    // Keep genuinely unresolved (empty NON_LITERAL_PRESENT) predicates unknown.
    partitionPredicateStatus:
      businessPredicates.length === 0 && read.partitionPredicates.length > 0
        ? "NONE"
        : read.partitionPredicateStatus,
  };
  const businessMatches = tableCandidates.map((candidate) => {
    const write = withoutBusinessDate(candidate.writeObservation);
    // No date was deferred: preserve the existing matching rules verbatim.
    if (write === candidate.writeObservation)
      return {
        status: partitionMatchStatus(read, write),
        key: businessPartitionKey(write),
      };
    const predicates = businessPredicates.filter((predicate) =>
      write.partition.some(
        (part) => normalizeName(part.column) === normalizeName(predicate.column),
      ),
    );
    const status = partitionMatchStatus(
      {
        ...businessRead,
        partitionPredicates: predicates,
        partitionPredicateStatus:
          predicates.length === 0 && read.partitionPredicates.length > 0
            ? "NONE"
            : businessRead.partitionPredicateStatus,
      },
      write,
    );
    return {
      // Ordinary row filters do not constrain partition identity. Preserve an
      // existing successful match for unconstrained dynamic business scopes;
      // do not require new metadata merely because busi_date was deferred.
      status:
        status === "UNKNOWN" &&
        predicates.length === 0 &&
        partitionMatchStatus(read, candidate.writeObservation) === "CONFIRMED"
          ? ("CONFIRMED" as const)
          : status,
      key: businessPartitionKey(write),
    };
  });
  const matchingGroups = new Map<string, number>();
  for (const match of businessMatches) {
    if (match.status === "CONFIRMED")
      matchingGroups.set(match.key, (matchingGroups.get(match.key) ?? 0) + 1);
  }
  const partitionCandidates = tableCandidates.map((candidate, index) => {
    const match = businessMatches[index]!;
    // Only equally matched business scopes compete on busi_date. Different
    // business scopes can legitimately contribute to the same broad read.
    const status =
      match.status === "CONFIRMED" && (matchingGroups.get(match.key) ?? 0) > 1
        ? partitionMatchStatus(read, candidate.writeObservation)
        : match.status;
    return {
      ...candidate,
      partitionMatchStatus: status,
      evidenceLayer: evidenceLayerFor(read, candidate.writeObservation, status),
      l1Eligible: isL1Eligible(read, candidate.writeObservation, status),
    } satisfies UnionContinuationCandidate;
  });

  if (read.partitionPredicateStatus === "NON_LITERAL_PRESENT") {
    const hasUnresolved = partitionCandidates.some(
      (candidate) => candidate.partitionMatchStatus === "UNKNOWN",
    );
    if (hasUnresolved) {
      gaps.push({
        gapId: `partition-non-literal:${read.readOccurrenceId}`,
        reasonCode: "PARTITION_NON_LITERAL",
        message:
          "Read occurrence has at least one non-literal partition predicate",
        details: { readOccurrenceId: read.readOccurrenceId },
      });
    }
  }
  for (const candidate of partitionCandidates) {
    if (candidate.partitionMatchStatus === "UNKNOWN") {
      gaps.push({
        gapId: `writer-partition-unknown:${read.readOccurrenceId}:${candidate.writeObservation.writeObservationId}`,
        reasonCode: "WRITER_PARTITION_UNKNOWN",
        message: `Partition match is unknown for ${candidate.writeObservation.writeObservationId}`,
        details: {
          readOccurrenceId: read.readOccurrenceId,
          writeObservationId: candidate.writeObservation.writeObservationId,
        },
      });
    }
  }

  const retained = partitionCandidates.filter(
    (candidate) => candidate.partitionMatchStatus !== "DISJOINT",
  );
  const pruned = partitionCandidates.filter(
    (candidate) => candidate.partitionMatchStatus === "DISJOINT",
  );
  if (tableCandidates.length > 0 && retained.length === 0) {
    gaps.push({
      gapId: `partition-no-match:${read.readOccurrenceId}`,
      reasonCode: "PARTITION_NO_MATCH",
      message: "All table-level write observations are disjoint by partition",
      details: { readOccurrenceId: read.readOccurrenceId },
    });
  }

  const sortedTable = sortCandidates(tableCandidates);
  const sortedPartition = sortCandidates(partitionCandidates);
  const sortedRetained = sortCandidates(retained);
  return {
    readOccurrence: read,
    tiers: {
      table: {
        evidenceLayer: read.identityStatus === "CONFIRMED" ? "L1" : "L2",
        candidateWriteObservationIds: sortedTable.map(
          (candidate) => candidate.writeObservation.writeObservationId,
        ),
        candidates: sortedTable,
      },
      partition: {
        candidateWriteObservationIds: sortedRetained.map(
          (candidate) => candidate.writeObservation.writeObservationId,
        ),
        prunedWriteObservationIds: sortCandidates(pruned).map(
          (candidate) => candidate.writeObservation.writeObservationId,
        ),
        candidates: sortedPartition,
        pruned: pruned.length > 0,
      },
      writeObservation: {
        candidateWriteObservationIds: sortedRetained.map(
          (candidate) => candidate.writeObservation.writeObservationId,
        ),
        candidates: sortedRetained,
        uniqueWriteObservationId:
          sortedRetained.length === 1
            ? sortedRetained[0]!.writeObservation.writeObservationId
            : null,
      },
    },
    gaps: dedupeGaps(gaps),
  };
}

/** Alias named after the existing v1 kernel for callers migrating incrementally. */
export const traceUnionUpstreamV2 = traceUnionContinuationV2;

export function traceUnionTaskContinuationV2(
  options: TraceUnionTaskContinuationV2Options,
): TraceUnionTaskContinuationV2Result {
  const evidence = lookup(options.merge).tasks.get(options.consumerTaskId);
  if (
    !evidence ||
    !isUnionContinuationV2ProjectionSchema(evidence.projectionSchemaVersion)
  ) {
    throw new Error(
      `UNION_CONTINUATION_PROJECTION_SCHEMA_UNSUPPORTED:${options.consumerTaskId}`,
    );
  }
  const readIds = sortedUnique(
    evidence?.localClosure?.externalReads.map(
      (read) => read.readOccurrenceId,
    ) ?? [],
  );
  return {
    consumerTaskId: options.consumerTaskId,
    readOccurrences: readIds.map((readOccurrenceId) =>
      traceUnionContinuationV2({
        merge: options.merge,
        consumerTaskId: options.consumerTaskId,
        readOccurrenceId,
        producerIndexWriters: options.producerIndexWriters,
      }),
    ),
  };
}

// The union is immutable for a publication; build lookup tables once per instance.
const lookupCache = new WeakMap<
  TaskLocalUnionMergeResult,
  ReturnType<typeof buildLookup>
>();
function buildLookup(merge: TaskLocalUnionMergeResult) {
  const tasks = new Map(merge.taskEvidence.map((t) => [t.taskId, t]));
  const nodes = new Map(merge.nodes.map((n) => [n.nodeId, n]));
  const reads = new Map<
    string,
    {
      evidence: TaskLocalUnionTaskEvidence;
      read: TaskLocalProjectionClosure["externalReads"][number];
    }
  >();
  const writes = new Map<
    string,
    Array<{
      evidence: TaskLocalUnionTaskEvidence;
      write: TaskLocalProjectionClosure["finalWrites"][number];
    }>
  >();
  const scheduleTables = new Map<
    string,
    readonly { taskId: string; qualifiedName: string }[]
  >();
  for (const evidence of merge.taskEvidence) {
    const taskNode = nodes.get(`task:${evidence.taskId}`);
    scheduleTables.set(
      evidence.taskId,
      readScheduleTableReferences(taskNode?.properties.scheduleReference),
    );
    for (const read of evidence.localClosure?.externalReads ?? [])
      reads.set(read.readOccurrenceId, { evidence, read });
    if (evidence.coverageStatus !== "PROJECTED") continue;
    for (const write of evidence.localClosure?.finalWrites ?? []) {
      for (const key of new Set([
        write.datasetNodeId,
        normalizeName(write.qualifiedName),
      ])) {
        const list = writes.get(key) ?? [];
        list.push({ evidence, write });
        writes.set(key, list);
      }
    }
  }
  return {
    tasks,
    nodes,
    reads,
    writes,
    scheduleTables,
    legacy: merge.taskEvidence.find(
      (e) =>
        e.coverageStatus === "PROJECTED" &&
        !isUnionContinuationV2ProjectionSchema(e.projectionSchemaVersion),
    ),
  };
}
function lookup(merge: TaskLocalUnionMergeResult) {
  let value = lookupCache.get(merge);
  if (!value) {
    value = buildLookup(merge);
    lookupCache.set(merge, value);
  }
  return value;
}

function findReadOccurrence(
  options: TraceUnionContinuationV2Options,
): UnionContinuationReadOccurrence | null {
  const item = lookup(options.merge).reads.get(options.readOccurrenceId);
  const summary = item?.read;
  if (
    !summary ||
    (options.consumerTaskId && item?.evidence.taskId !== options.consumerTaskId)
  )
    return null;
  const node = lookup(options.merge).nodes.get(summary.readOccurrenceNodeId);
  if (!node || node.nodeType !== "READ_OCCURRENCE") return null;
  const properties = node?.properties ?? {};
  const datasetNodeId =
    summary?.datasetNodeId ?? text(properties.datasetNodeId) ?? "";
  const qualifiedName =
    summary?.qualifiedName ?? text(properties.physicalDataset) ?? "";
  if (!datasetNodeId || !qualifiedName) return null;
  if (
    (text(properties.datasetNodeId) !== null &&
      text(properties.datasetNodeId) !== datasetNodeId) ||
    (text(properties.physicalDataset) !== null &&
      normalizeName(text(properties.physicalDataset)!) !==
        normalizeName(qualifiedName))
  ) {
    return null;
  }
  const partitionPredicateStatus = readPartitionStatus(
    properties.partitionPredicateStatus,
  );
  return {
    readOccurrenceId: options.readOccurrenceId,
    readOccurrenceNodeId: summary.readOccurrenceNodeId,
    datasetNodeId,
    qualifiedName,
    identityStatus: summary.identityStatus,
    partitionPredicateStatus,
    partitionPredicates: readPartitionPredicates(
      properties.partitionPredicates,
    ),
    partitionRange: properties.partitionRange,
  };
}

function collectWriteObservations(
  merge: TaskLocalUnionMergeResult,
  read: UnionContinuationReadOccurrence,
  producerIndexWriters: readonly ProducerIndexWriter[],
): {
  readonly candidates: readonly UnionContinuationCandidate[];
  readonly alignmentGaps: readonly UnionContinuationGap[];
} {
  const indexed = lookup(merge).writes;
  const finalWrites = [
    ...new Set([
      ...(indexed.get(read.datasetNodeId) ?? []),
      ...(indexed.get(normalizeName(read.qualifiedName)) ?? []),
    ]),
  ].filter((item) =>
    sameDataset(item.write.datasetNodeId, item.write.qualifiedName, read),
  );

  const candidates: UnionContinuationCandidate[] = [];
  const alignmentGaps: UnionContinuationGap[] = [];
  const usedProducerKeys = new Set<string>();
  const ambiguousProducerKeys = new Set<string>();
  const nonProjectedTaskIds = new Set(
    merge.taskEvidence
      .filter((evidence) => evidence.coverageStatus !== "PROJECTED")
      .map((evidence) => evidence.taskId),
  );
  for (const item of finalWrites) {
    const matches = producerIndexWriters.filter(
      (writer) =>
        writer.taskId === item.evidence.taskId &&
        sameWriterDataset(
          writer,
          item.write.datasetNodeId,
          item.write.qualifiedName,
          read,
        ),
    );
    const exact = matches.find(
      (writer) => writer.writeObservationId === item.write.writeObservationId,
    );
    const scopeFinalWrites = finalWrites.filter(
      (candidate) =>
        writeScopeKey(
          candidate.evidence.taskId,
          candidate.write.datasetNodeId,
          candidate.write.qualifiedName,
        ) ===
        writeScopeKey(
          item.evidence.taskId,
          item.write.datasetNodeId,
          item.write.qualifiedName,
        ),
    );
    const producer =
      exact ??
      (scopeFinalWrites.length === 1 && matches.length === 1
        ? matches[0]
        : undefined);
    if (!exact && scopeFinalWrites.length > 1 && matches.length > 0) {
      for (const writer of matches) {
        ambiguousProducerKeys.add(producerKey(writer, producerIndexWriters));
      }
      alignmentGaps.push({
        gapId: `write-observation-alignment-ambiguous:${item.evidence.taskId}:${item.write.datasetNodeId}`,
        reasonCode: "WRITE_OBSERVATION_ALIGNMENT_AMBIGUOUS",
        message:
          "Producer-index partition evidence cannot be aligned to multiple final write observations without an exact writeObservationId",
        details: {
          taskId: item.evidence.taskId,
          datasetNodeId: item.write.datasetNodeId,
          qualifiedName: item.write.qualifiedName,
          finalWriteObservationIds: scopeFinalWrites.map(
            (candidate) => candidate.write.writeObservationId,
          ),
          producerIndexWriteObservationIds: matches.map(
            (writer) => writer.writeObservationId ?? null,
          ),
        },
      });
    }
    if (producer)
      usedProducerKeys.add(producerKey(producer, producerIndexWriters));
    const writeObservation: UnionContinuationWriteObservation = {
      taskId: item.evidence.taskId,
      writeObservationId: item.write.writeObservationId,
      targetWriteNodeId: item.write.targetWriteNodeId,
      datasetNodeId: item.write.datasetNodeId,
      qualifiedName: item.write.qualifiedName,
      source: "IN_UNION_FINAL_WRITE",
      ...outputQualificationProperties(
        item.write.outputQualification,
        producer?.outputQualification,
      ),
      partition: producer?.partition ?? [],
      partitionStatus: producer ? partitionStatusOf(producer) : "UNKNOWN",
    };
    candidates.push({
      writeObservation,
      partitionMatchStatus: "UNKNOWN",
      evidenceLayer: "L2",
      l1Eligible: false,
    });
  }

  if (candidates.length === 0) {
    const consumerTaskId = lookup(merge).reads.get(read.readOccurrenceId)
      ?.evidence.taskId;
    for (const reference of consumerTaskId
      ? (lookup(merge).scheduleTables.get(consumerTaskId) ?? [])
      : []) {
      if (
        normalizeName(reference.qualifiedName) !==
        normalizeName(read.qualifiedName)
      )
        continue;
      const evidence = lookup(merge).tasks.get(reference.taskId);
      if (!evidence || evidence.coverageStatus !== "PROJECTED") continue;
      for (const write of evidence.localClosure?.finalWrites ?? []) {
        if (
          normalizeName(write.qualifiedName) !==
          normalizeName(read.qualifiedName)
        )
          continue;
        const producer = producerIndexWriters.find(
          (writer) =>
            writer.taskId === reference.taskId &&
            writer.writeObservationId === write.writeObservationId &&
            normalizeName(writer.qualifiedName ?? "") ===
              normalizeName(read.qualifiedName),
        );
        candidates.push({
          writeObservation: {
            taskId: reference.taskId,
            writeObservationId: write.writeObservationId,
            targetWriteNodeId: write.targetWriteNodeId,
            datasetNodeId: write.datasetNodeId,
            qualifiedName: write.qualifiedName,
            source: "SCHEDULE_RELATION_TABLE",
            ...outputQualificationProperties(
              write.outputQualification,
              producer?.outputQualification,
            ),
            partition: producer?.partition ?? [],
            partitionStatus: producer ? partitionStatusOf(producer) : "UNKNOWN",
          },
          partitionMatchStatus: "UNKNOWN",
          evidenceLayer: "L2",
          l1Eligible: false,
        });
      }
    }
  }

  producerIndexWriters.forEach((writer, index) => {
    if (nonProjectedTaskIds.has(writer.taskId)) return;
    if (
      !sameWriterDataset(writer, read.datasetNodeId, read.qualifiedName, read)
    )
      return;
    const key = producerKey(writer, producerIndexWriters, index);
    if (usedProducerKeys.has(key) || ambiguousProducerKeys.has(key)) return;
    const writeObservationId =
      writer.writeObservationId ??
      `write-observation:${writer.taskId}:producer-index:${index}`;
    candidates.push({
      writeObservation: {
        taskId: writer.taskId,
        writeObservationId,
        targetWriteNodeId: null,
        datasetNodeId: writer.datasetNodeId ?? null,
        qualifiedName: writer.qualifiedName ?? read.qualifiedName,
        source: "PRODUCER_INDEX_ONLY",
        ...outputQualificationProperties(writer.outputQualification),
        partition: writer.partition ?? [],
        partitionStatus: partitionStatusOf(writer),
      },
      partitionMatchStatus: "UNKNOWN",
      evidenceLayer: "L2",
      l1Eligible: false,
    });
  });

  const byObservation = new Map<string, UnionContinuationCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.writeObservation.taskId}\u0000${candidate.writeObservation.writeObservationId}`;
    const existing = byObservation.get(key);
    if (
      !existing ||
      existing.writeObservation.source === "PRODUCER_INDEX_ONLY"
    ) {
      byObservation.set(key, candidate);
    }
  }
  return {
    candidates: [...byObservation.values()],
    alignmentGaps,
  };
}

function writeScopeKey(
  taskId: string,
  datasetNodeId: string,
  qualifiedName: string,
): string {
  return `${taskId}\u0000${datasetNodeId}\u0000${normalizeName(qualifiedName)}`;
}

function shouldCompareWritePartitionColumn(
  read: UnionContinuationReadOccurrence,
  column: string,
): boolean {
  if (read.partitionPredicateStatus === "NONE") {
    return isTemporalPartitionColumn(column);
  }
  return read.partitionPredicates.some(
    (predicate) => normalizeName(predicate.column) === normalizeName(column),
  );
}

function isBusinessDate(column: string): boolean {
  return normalizeName(column) === "busi_date";
}

function withoutBusinessDate(
  write: UnionContinuationWriteObservation,
): UnionContinuationWriteObservation {
  if (!write.partition.some((part) => isBusinessDate(part.column)))
    return write;
  const partition = write.partition.filter(
    (part) => !isBusinessDate(part.column),
  );
  return {
    ...write,
    partition,
    // The overall status is derived from the first partition in the producer
    // index. Recompute it so a deferred date cannot poison business matching.
    partitionStatus:
      partition.find((part) => part.partitionStatus)?.partitionStatus ?? null,
  };
}

function businessPartitionKey(
  write: UnionContinuationWriteObservation,
): string {
  const ranges = expandPartitionAlternatives(write.partition);
  // Malformed alternatives never receive CONFIRMED and cannot form a tie.
  if (!ranges) return "UNKNOWN";
  return JSON.stringify(
    sortedUnique(
      ranges.map((parts) =>
        JSON.stringify(
          parts
            .map((part) => ({
              column: normalizeName(part.column),
              values: sortedUnique(
                writePartitionRawValues(part).map((value) =>
                  canonicalPartitionValue(part.column, value),
                ),
              ),
              mayBeNull: part.mayBeNull ?? false,
            }))
            .sort((a, b) => compareText(a.column, b.column)),
        ),
      ),
    ),
  );
}

/** Unassigned dates remain unconstrained even when comparing tied writers. */
function isUnassignedBusinessDate(part: ProducerPartition): boolean {
  if (normalizeName(part.column) !== "busi_date") return false;
  if (part.partitionStatus === "CONFLICT") return false;
  if (part.values.length === 0) return true;
  // Compatibility with the old extractor's dynamic-partition sentinel.
  return part.valueStatus === "RUNTIME_EXPRESSION" && part.observedValue == null &&
    part.expression === "UNKNOWN" && part.values.every(value => value === "UNKNOWN");
}

export function partitionMatchStatus(
  read: UnionContinuationReadOccurrence,
  write: UnionContinuationWriteObservation,
): PartitionMatchStatus {
  if (write.partition.some(part => part.alternatives !== undefined)) {
    const ranges = expandPartitionAlternatives(write.partition);
    if (!ranges) return "UNKNOWN";
    const statuses = ranges.map(partition => partitionMatchStatus(read, { ...write, partition }));
    if (statuses.includes("CONFIRMED")) return "CONFIRMED";
    if (statuses.every(status => status === "DISJOINT")) return "DISJOINT";
    return statuses.includes("UNKNOWN") ? "UNKNOWN" : "ASSUMED";
  }
  // An unrestricted read includes every known write partition. There is no
  // predicate to compare, which is different from an unresolved predicate.
  if (
    read.partitionPredicateStatus === "NONE" &&
    read.partitionPredicates.length === 0 &&
    !isUnknownPartition(write) &&
    write.partitionStatus?.toUpperCase() !== "CONFLICT" &&
    write.partition.every((part) =>
      part.partitionStatus?.toUpperCase() !== "CONFLICT" &&
      (partitionValueKind(part, write.partitionStatus) === "LITERAL" ||
        (isTemporalPartitionColumn(part.column) && part.values.length > 0 && part.values.every(isDayPartitionValue))),
    )
  ) return "CONFIRMED";

  if (!isUnknownPartition(write) && write.partitionStatus !== "CONFLICT" &&
    typeof read.partitionRange === "object" && read.partitionRange !== null &&
    normalizeName(String((read.partitionRange as Record<string, unknown>).table ?? "")) === normalizeName(read.qualifiedName) &&
    matchesReadPartitionRange(read.partitionRange, write.partition) === true) return "CONFIRMED";

  const predicates = new Map(
    read.partitionPredicates.map((predicate) => [
      normalizeName(predicate.column),
      predicate,
    ]),
  );
  const parts = write.partition.filter((part) =>
    isUnassignedBusinessDate(part) || shouldCompareWritePartitionColumn(read, part.column),
  );
  if (parts.length === 0) {
    return write.partition.length === 0 && !isUnknownPartition(write)
      ? "CONFIRMED"
      : "UNKNOWN";
  }
  if (isUnknownPartition(write) && !parts.some(isUnassignedBusinessDate)) return "UNKNOWN";

  let assumed = false;
  let unknown = false;
  let compared = false;
  for (const part of parts) {
    if (isUnassignedBusinessDate(part)) {
      compared = true;
      continue;
    }
    const predicate = predicates.get(normalizeName(part.column));
    if (!predicate || predicate.values.length === 0) {
      unknown = true;
      continue;
    }
    compared = true;
    const writeValues = writePartitionRawValues(part).map((value) =>
      canonicalPartitionValue(part.column, value),
    );
    const readValues = canonicalPartitionValues(part.column, predicate.values);
    const kind = partitionValueKind(part, write.partitionStatus);
    if (kind === "UNKNOWN") {
      if (
        partitionCanonicalValuesOverlap(
          part.column,
          predicate.values,
          writePartitionRawValues(part),
        )
      ) {
        continue;
      }
      unknown = true;
      continue;
    }
      if (partitionCanonicalValuesOverlap(part.column, readValues, writeValues)) {
        continue;
      }
      // Flattened predicates cannot prove that an OR/NULL/other-column branch
      // excludes SQL NULL (or other values). A nullable domain is not disjoint
      // unless the reader is a literal domain for this column alone.
      if (part.mayBeNull && (read.partitionPredicateStatus !== "LITERAL" || read.partitionPredicates.length !== 1)) {
        unknown = true;
        continue;
      }
    if (kind === "ASSUMED") {
      assumed = true;
      continue;
    }
    return "DISJOINT";
  }
  if (!compared) unknown = true;
  if (unknown) return "UNKNOWN";
  if (assumed) return "ASSUMED";
  return "CONFIRMED";
}

function readScheduleTableReferences(value: unknown): readonly {
  taskId: string;
  qualifiedName: string;
}[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [];
  const rows = (value as Record<string, unknown>).upstreamTableReferences;
  if (!Array.isArray(rows)) return [];
  const result = new Map<string, { taskId: string; qualifiedName: string }>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const taskId = text(record.taskId);
    const qualifiedName = text(record.qualifiedName);
    if (!taskId || !qualifiedName) continue;
    result.set(`${taskId}\u0000${normalizeName(qualifiedName)}`, {
      taskId,
      qualifiedName,
    });
  }
  return [...result.values()].sort((left, right) =>
    compareText(
      `${left.taskId}\u0000${left.qualifiedName}`,
      `${right.taskId}\u0000${right.qualifiedName}`,
    ),
  );
}

function canonicalPartitionValues(
  column: string,
  values: readonly string[],
): readonly string[] {
  return values.map((value) => canonicalPartitionValue(column, value));
}

function partitionValueKind(
  part: ProducerPartition,
  overallStatus: string | null,
): "LITERAL" | "ASSUMED" | "UNKNOWN" {
  const valueStatus = (part.valueStatus ?? "").toUpperCase();
  const partitionStatus = (
    part.partitionStatus ??
    overallStatus ??
    ""
  ).toUpperCase();
  if (valueStatus.includes("DYNAMIC") || valueStatus.includes("UNKNOWN"))
    return "UNKNOWN";
  if (partitionStatus === "DYNAMIC" || partitionStatus === "LEGACY_UNKNOWN")
    return "UNKNOWN";
  if (
    valueStatus.includes("RUNTIME") ||
    valueStatus.includes("TEMPLATE") ||
    valueStatus.includes("DEFAULT") ||
    partitionStatus.includes("DATE_PARTITION_DEFAULTED") ||
    partitionStatus.includes("POSSIBLE_OVERLAP") ||
    /\$\{|current_(date|timestamp)|sysdate/i.test(part.expression ?? "")
  ) {
    return "ASSUMED";
  }
  if (part.values.length === 0) return "UNKNOWN";
  return "LITERAL";
}

function isUnknownPartition(write: UnionContinuationWriteObservation): boolean {
  const status = (write.partitionStatus ?? "").toUpperCase();
  return (
    status === "DYNAMIC" || status === "LEGACY_UNKNOWN" || status === "UNKNOWN"
  );
}

function evidenceLayerFor(
  read: UnionContinuationReadOccurrence,
  write: UnionContinuationWriteObservation,
  status: PartitionMatchStatus,
): UnionContinuationEvidenceLayer {
  return isL1Eligible(read, write, status) ? "L1" : "L2";
}

function isL1Eligible(
  read: UnionContinuationReadOccurrence,
  write: UnionContinuationWriteObservation,
  status: PartitionMatchStatus,
): boolean {
  return (
    write.outputQualification !== "SQL_UNCONSUMED" &&
    read.identityStatus === "CONFIRMED" &&
    (write.source === "IN_UNION_FINAL_WRITE" ||
      write.source === "SCHEDULE_RELATION_TABLE") &&
    status === "CONFIRMED"
  );
}

function outputQualificationProperties(
  ...qualifications: readonly UnionContinuationWriteObservation["outputQualification"][]
): Pick<UnionContinuationWriteObservation, "outputQualification"> {
  // Preserve the candidate boundary even when another matching source is legacy.
  const outputQualification = qualifications.includes("SQL_UNCONSUMED")
    ? "SQL_UNCONSUMED"
    : qualifications.find((qualification) => qualification !== undefined);
  return outputQualification === undefined ? {} : { outputQualification };
}

function sameDataset(
  datasetNodeId: string,
  qualifiedName: string,
  read: UnionContinuationReadOccurrence,
): boolean {
  return (
    datasetNodeId === read.datasetNodeId &&
    normalizeName(qualifiedName) === normalizeName(read.qualifiedName)
  );
}

function sameWriterDataset(
  writer: ProducerIndexWriter,
  datasetNodeId: string,
  qualifiedName: string,
  read: UnionContinuationReadOccurrence,
): boolean {
  if (writer.datasetNodeId) {
    return (
      writer.datasetNodeId === datasetNodeId &&
      writer.datasetNodeId === read.datasetNodeId &&
      normalizeName(writer.qualifiedName ?? qualifiedName) ===
        normalizeName(read.qualifiedName)
    );
  }
  return (
    writer.qualifiedName !== undefined &&
    normalizeName(writer.qualifiedName) === normalizeName(read.qualifiedName)
  );
}

function sortCandidates(
  candidates: readonly UnionContinuationCandidate[],
): UnionContinuationCandidate[] {
  return [...candidates].sort((left, right) =>
    compareText(
      `${left.writeObservation.taskId}\u0000${left.writeObservation.writeObservationId}`,
      `${right.writeObservation.taskId}\u0000${right.writeObservation.writeObservationId}`,
    ),
  );
}

function dedupeGaps(
  gaps: readonly UnionContinuationGap[],
): UnionContinuationGap[] {
  const byId = new Map<string, UnionContinuationGap>();
  for (const gap of gaps) byId.set(gap.gapId, gap);
  return [...byId.values()].sort((left, right) =>
    compareText(left.gapId, right.gapId),
  );
}

function producerKey(
  writer: ProducerIndexWriter,
  all: readonly ProducerIndexWriter[],
  index?: number,
): string {
  if (writer.writeObservationId)
    return `${writer.taskId}\u0000${writer.writeObservationId}`;
  const occurrence = index ?? all.indexOf(writer);
  return `${writer.taskId}\u0000producer-index:${occurrence}`;
}

function partitionStatusOf(
  writer: ProducerIndexWriter | undefined,
): string | null {
  const value = writer?.partition?.find(
    (part) => part.partitionStatus,
  )?.partitionStatus;
  return value ?? null;
}

function readPartitionStatus(
  value: unknown,
): "NONE" | "LITERAL" | "NON_LITERAL_PRESENT" {
  return value === "LITERAL" || value === "NON_LITERAL_PRESENT"
    ? value
    : "NONE";
}

function readPartitionPredicates(value: unknown): PartitionPredicate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return [];
    const record = item as Record<string, unknown>;
    const column = text(record.column);
    const values = Array.isArray(record.values)
      ? record.values
          .map(text)
          .filter((value): value is string => value !== null)
      : [];
    return column && values.length > 0 ? [{ column, values }] : [];
  });
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertV2ProjectionEvidence(
  options: TraceUnionContinuationV2Options,
): void {
  const legacyProjectedTask = lookup(options.merge).legacy;
  if (legacyProjectedTask) {
    throw new Error(
      `UNION_CONTINUATION_PROJECTION_SCHEMA_UNSUPPORTED:${legacyProjectedTask.taskId}`,
    );
  }
  const owner = lookup(options.merge).reads.get(
    options.readOccurrenceId,
  )?.evidence;
  if (
    !owner ||
    !isUnionContinuationV2ProjectionSchema(owner.projectionSchemaVersion)
  ) {
    throw new Error(
      `UNION_CONTINUATION_PROJECTION_SCHEMA_UNSUPPORTED:${options.readOccurrenceId}`,
    );
  }
}
