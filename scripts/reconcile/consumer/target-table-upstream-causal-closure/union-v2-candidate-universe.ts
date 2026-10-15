import {
  canonicalJson,
  sha256,
} from "../../../machine-facts/machine-facts-contract.ts";
import {
  isOutOfScopePhysicalRead,
  isSameTaskScratchProducerBridge,
  isSameTaskScratchTable,
} from "../../shared/lineage-scope.ts";
import {
  canonicalCandidateBranchId,
  type CandidateBranch,
  type CandidatePhysicalTable,
  type CandidateReadOccurrence,
  type CandidateUniverse,
} from "../target-field-causal-slice/candidate-universe.ts";
import {
  continuationIndexEntryReference,
  type UnionContinuationCandidateSource,
  type UnionContinuationIndexCandidate,
  type UnionContinuationIndexEntry,
} from "./union-continuation-candidate-source.ts";

export interface UnionV2CandidateUniverseResult {
  readonly universe: CandidateUniverse;
  readonly disjointPruned: number;
  readonly unmatchedReads: number;
  readonly selfReadBoundaries: number;
}

export type UnionV2ScheduleRelationStatus = "AVAILABLE" | "UNKNOWN";

export interface UnionV2ScheduleRelationLookup {
  readonly status: UnionV2ScheduleRelationStatus;
  readonly has: (consumerTaskId: string, producerTaskId: string) => boolean;
}

export type UnionV2CandidateSelectionReason =
  | "SELECTED"
  | "READ_NOT_FOUND"
  | "NO_CANDIDATES"
  | "NO_ELIGIBLE_CANDIDATES"
  | "DISJOINT"
  | "PRODUCER_NOT_FOUND"
  | "SCHEDULE_RELATION_UNRESOLVED"
  | "SCHEDULE_RELATION_NO_MATCH";

export interface UnionV2CandidateSelection {
  readonly entry: UnionContinuationIndexEntry | undefined;
  readonly candidates: readonly UnionContinuationIndexCandidate[];
  readonly reason: UnionV2CandidateSelectionReason;
  readonly disjointPruned: number;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function statementIndexOf(readOccurrenceId: string): number {
  const statement = readOccurrenceId.match(/(?:^|:)statement:(\d+)(?::|$)/i);
  if (statement) return Number(statement[1]);
  const slot = readOccurrenceId.match(/^(?:query|create|finish)#(\d+)(?::|$)/i);
  return slot ? Number(slot[1]) : 0;
}

function sqlSourceIdOf(
  consumerTaskId: string,
  readOccurrenceId: string,
): string {
  const slot = readOccurrenceId
    .match(/^(query|create|finish)#\d+(?::|$)/i)?.[1]
    ?.toLowerCase();
  return `task:${consumerTaskId}:slot:${slot ?? "query"}`;
}

function readRelationIdOf(readOccurrenceId: string): string {
  const marker = ":relation:";
  const markerIndex = readOccurrenceId.indexOf(marker);
  if (markerIndex >= 0)
    return readOccurrenceId.slice(markerIndex + marker.length);
  const slot = readOccurrenceId.match(/^(?:query|create|finish)#\d+:(.+)$/i);
  return slot?.[1] ?? readOccurrenceId;
}

/**
 * INDEX 1.0.0 deliberately carries the canonical read-occurrence key rather
 * than copying the whole Facts occurrence DTO. Facts normalization later
 * replaces this minimal occurrence with the proven path when it is available.
 */
export function candidateReadOccurrenceFromIndex(
  entry: Pick<
    UnionContinuationIndexEntry,
    "consumerTaskId" | "readOccurrenceId"
  >,
): CandidateReadOccurrence {
  const statementIndex = statementIndexOf(entry.readOccurrenceId);
  const readRelationId = readRelationIdOf(entry.readOccurrenceId);
  return {
    occurrenceId: entry.readOccurrenceId,
    readRelationId,
    sqlSourceId: sqlSourceIdOf(entry.consumerTaskId, entry.readOccurrenceId),
    statementIndex,
    rootRelationId: `task:${entry.consumerTaskId}:statement:${statementIndex}:relation:root`,
    relationPath: [readRelationId],
  };
}

function tableFromIndex(
  entry: UnionContinuationIndexEntry,
  candidate: UnionContinuationIndexCandidate,
  resolvePhysicalTable?: (
    table: CandidatePhysicalTable,
  ) => CandidatePhysicalTable | null,
): CandidatePhysicalTable {
  const source: CandidatePhysicalTable = {
    platform: null,
    dataSource: null,
    qualifiedName: candidate.qualifiedName || entry.qualifiedName,
    stableTableId: candidate.datasetNodeId ?? entry.datasetNodeId,
    identityStatus: entry.identityStatus,
  };
  return resolvePhysicalTable?.(source) ?? source;
}

/**
 * Read the raw multi-hop schedule edges without projecting them into the
 * legacy Candidate Universe.  In particular, an edge that also has a
 * physical bridge must remain visible here: the legacy projector deliberately
 * hides that SCHEDULE_ONLY pair.
 */
export function createUnionV2ScheduleRelationLookup(
  tableArtifact: unknown,
): UnionV2ScheduleRelationLookup {
  const artifact = record(tableArtifact);
  const rawEdges = artifact?.scheduleEdges;
  if (!Array.isArray(rawEdges)) {
    return {
      status: "UNKNOWN",
      has: () => false,
    };
  }
  const producersByConsumer = new Map<string, Set<string>>();
  for (const rawEdge of rawEdges) {
    const edge = record(rawEdge);
    const consumerTaskId = text(edge?.consumerTaskId);
    const producerTaskId = text(edge?.producerTaskId);
    if (consumerTaskId === null || producerTaskId === null) {
      return {
        status: "UNKNOWN",
        has: () => false,
      };
    }
    const producerTaskIds =
      producersByConsumer.get(consumerTaskId) ?? new Set<string>();
    producerTaskIds.add(producerTaskId);
    producersByConsumer.set(consumerTaskId, producerTaskIds);
  }
  return {
    status: "AVAILABLE",
    has: (consumerTaskId, producerTaskId) =>
      producersByConsumer.get(consumerTaskId)?.has(producerTaskId) ?? false,
  };
}

function sameQualifiedName(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return Boolean(
    left && right && left.trim().toLowerCase() === right.trim().toLowerCase(),
  );
}

/**
 * Select continuation candidates once for both C2 projection and enrichment.
 * Schedule edges are only a consumer-side whitelist: they never create a
 * producer candidate and never provide producer evidence by themselves.
 */
export function selectUnionV2Candidates(input: {
  readonly source: UnionContinuationCandidateSource;
  readonly scheduleRelation: UnionV2ScheduleRelationLookup;
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly producerTaskId?: string | null;
  readonly qualifiedName?: string | null;
  readonly exactWriteObservationId?: string | null;
  readonly resolvePhysicalTable?: (
    table: CandidatePhysicalTable,
  ) => CandidatePhysicalTable | null;
}): UnionV2CandidateSelection {
  const entry = input.source.entryForRead(
    input.consumerTaskId,
    input.readOccurrenceId,
  );
  if (!entry) {
    return {
      entry: undefined,
      candidates: [],
      reason: "READ_NOT_FOUND",
      disjointPruned: 0,
    };
  }
  if (entry.candidates.length === 0) {
    return {
      entry,
      candidates: [],
      reason: "NO_CANDIDATES",
      disjointPruned: 0,
    };
  }

  const scopedCandidates = entry.candidates.filter((candidate) => {
    if (
      input.exactWriteObservationId !== undefined &&
      input.exactWriteObservationId !== null &&
      candidate.writeObservationId !== input.exactWriteObservationId
    )
      return false;
    if (
      input.producerTaskId !== undefined &&
      input.producerTaskId !== null &&
      candidate.taskId !== input.producerTaskId
    )
      return false;
    if (
      input.qualifiedName !== undefined &&
      input.qualifiedName !== null &&
      !sameQualifiedName(candidate.qualifiedName, input.qualifiedName)
    )
      return false;
    const table = tableFromIndex(entry, candidate, input.resolvePhysicalTable);
    return (
      !isOutOfScopePhysicalRead(table) &&
      !isSameTaskScratchProducerBridge(
        entry.consumerTaskId,
        candidate.taskId,
        table.qualifiedName,
      )
    );
  });

  let disjointPruned = 0;
  let scheduleRelationUnknown = false;
  let scheduleRelationMismatch = false;
  const selected: UnionContinuationIndexCandidate[] = [];
  for (const candidate of scopedCandidates) {
    if (candidate.partitionMatchStatus === "DISJOINT") {
      disjointPruned += 1;
      continue;
    }
    const isCrossTask = candidate.taskId !== entry.consumerTaskId;
    if (isCrossTask && input.scheduleRelation.status === "UNKNOWN") {
      scheduleRelationUnknown = true;
      continue;
    }
    if (
      isCrossTask &&
      !input.scheduleRelation.has(entry.consumerTaskId, candidate.taskId)
    ) {
      scheduleRelationMismatch = true;
      continue;
    }
    selected.push(candidate);
  }

  if (selected.length > 0) {
    return {
      entry,
      candidates: selected,
      reason: "SELECTED",
      disjointPruned,
    };
  }
  if (scheduleRelationUnknown) {
    return {
      entry,
      candidates: [],
      reason: "SCHEDULE_RELATION_UNRESOLVED",
      disjointPruned,
    };
  }
  if (scheduleRelationMismatch) {
    return {
      entry,
      candidates: [],
      reason: "SCHEDULE_RELATION_NO_MATCH",
      disjointPruned,
    };
  }
  if (disjointPruned > 0 && disjointPruned === scopedCandidates.length) {
    return {
      entry,
      candidates: [],
      reason: "DISJOINT",
      disjointPruned,
    };
  }
  return {
    entry,
    candidates: [],
    reason:
      input.producerTaskId !== undefined ||
      input.exactWriteObservationId !== undefined
        ? "PRODUCER_NOT_FOUND"
        : "NO_ELIGIBLE_CANDIDATES",
    disjointPruned,
  };
}

function continuationGapRefs(
  branchId: string,
  entry: UnionContinuationIndexEntry,
  candidate: UnionContinuationIndexCandidate,
): readonly string[] {
  return unique(
    [
      ...entry.gaps.map((gap) => gap.reasonCode),
      candidate.alignmentGapCode,
      candidate.reasonCode,
    ].filter((value): value is string => Boolean(value)),
  ).map((code) => `continuation-gap:${branchId}:${code}`);
}

function candidateEvidenceRef(
  entry: UnionContinuationIndexEntry,
  candidate: UnionContinuationIndexCandidate,
): string {
  return `union-continuation-candidate:${sha256(
    canonicalJson({
      consumerTaskId: entry.consumerTaskId,
      readOccurrenceId: entry.readOccurrenceId,
      taskId: candidate.taskId,
      writeObservationId: candidate.writeObservationId,
    }),
  )}`;
}

function branchForCandidate(
  rootTaskId: string,
  entry: UnionContinuationIndexEntry,
  candidate: UnionContinuationIndexCandidate,
  table: CandidatePhysicalTable,
  indexEntryRef: string,
): CandidateBranch {
  const readOccurrence = candidateReadOccurrenceFromIndex(entry);
  const branch = {
    branchKind: "PHYSICAL_PRODUCER" as const,
    rootTaskId,
    consumerTaskId: entry.consumerTaskId,
    producerTaskId: candidate.taskId,
    table,
    readOccurrence,
    writeObservationId: candidate.writeObservationId,
    producerRole:
      candidate.source === "IN_UNION_FINAL_WRITE"
        ? "PRIMARY"
        : "PRODUCER_INDEX_ONLY",
    evidenceRefs: [
      {
        evidenceRefId: indexEntryRef,
        source: "UNION_CONTINUATION_INDEX",
        locator: indexEntryRef,
      },
      {
        evidenceRefId: candidateEvidenceRef(entry, candidate),
        source: "UNION_CONTINUATION_INDEX_CANDIDATE",
        locator: `union-continuation-index:${entry.consumerTaskId}:${entry.readOccurrenceId}:${candidate.taskId}:${candidate.writeObservationId}`,
      },
    ],
    gapRefs: continuationGapRefs(
      `candidate-branch:${entry.consumerTaskId}:${entry.readOccurrenceId}:${candidate.writeObservationId}`,
      entry,
      candidate,
    ),
    boundaryReason: null,
    continuation: {
      source: candidate.source,
      partitionMatchStatus: candidate.partitionMatchStatus,
      evidenceLayer: candidate.evidenceLayer,
      l1Eligible: candidate.l1Eligible,
      indexEntryRef,
    },
  } satisfies Omit<CandidateBranch, "candidateBranchId">;
  return {
    ...branch,
    candidateBranchId: canonicalCandidateBranchId(branch),
  };
}

function boundaryForRead(
  branch: CandidateBranch,
  kind: "UNBOUND_READ" | "BLOCKED_READ",
  reason: string,
): CandidateBranch {
  const readOccurrence = branch.readOccurrence;
  const base = {
    ...branch,
    branchKind: kind,
    producerTaskId: null,
    producerRole: null,
    writeObservationId: null,
    writeScope: undefined,
    continuation: undefined,
    boundaryReason: reason,
    gapRefs: unique([
      ...branch.gapRefs,
      `continuation-gap:${branch.candidateBranchId}:${
        reason === "SELF_READ_NOT_EXTERNAL"
          ? "SELF_READ_NOT_EXTERNAL"
          : "CONTINUATION_READ_NOT_FOUND"
      }`,
    ]),
  } satisfies Omit<CandidateBranch, "candidateBranchId">;
  return {
    ...base,
    candidateBranchId: canonicalCandidateBranchId(base),
    ...(readOccurrence ? { readOccurrence } : {}),
  };
}

function addBranch(
  branches: Map<string, CandidateBranch>,
  branch: CandidateBranch,
): void {
  const prior = branches.get(branch.candidateBranchId);
  if (!prior) {
    branches.set(branch.candidateBranchId, branch);
    return;
  }
  branches.set(branch.candidateBranchId, {
    ...prior,
    evidenceRefs: [
      ...new Map(
        [...prior.evidenceRefs, ...branch.evidenceRefs].map((ref) => [
          ref.evidenceRefId,
          ref,
        ]),
      ).values(),
    ].sort((left, right) =>
      left.evidenceRefId.localeCompare(right.evidenceRefId),
    ),
    gapRefs: unique([...prior.gapRefs, ...branch.gapRefs]),
  });
}

function readKey(consumerTaskId: string, readOccurrenceId: string): string {
  return `${consumerTaskId}\u0000${readOccurrenceId}`;
}

function deleteReadBoundaries(
  branches: Map<string, CandidateBranch>,
  consumerTaskId: string,
  readOccurrenceId: string,
): void {
  const key = readKey(consumerTaskId, readOccurrenceId);
  for (const [branchId, branch] of branches) {
    if (
      (branch.branchKind !== "UNBOUND_READ" &&
        branch.branchKind !== "BLOCKED_READ") ||
      !branch.consumerTaskId ||
      !branch.readOccurrence ||
      readKey(branch.consumerTaskId, branch.readOccurrence.occurrenceId) !== key
    )
      continue;
    branches.delete(branchId);
  }
}

/**
 * Build the union-v2 universe. Multi-hop contributes only root/boundary
 * branches and missing-read boundaries; every PHYSICAL_PRODUCER branch comes
 * from an INDEX candidate, including producer-index-only candidates.
 */
export function projectUnionV2CandidateUniverse(input: {
  readonly rootTaskId: string;
  readonly baseUniverse: CandidateUniverse;
  readonly source: UnionContinuationCandidateSource;
  readonly scheduleRelation: UnionV2ScheduleRelationLookup;
  /**
   * Same-task reads are local closure boundaries, not INDEX external reads.
   * The callback is deliberately supplied by the Facts-aware caller so this
   * adapter never infers a producer from a table name on its own.
   */
  readonly isSameTaskSelfRead?: (
    consumerTaskId: string,
    qualifiedName: string,
  ) => boolean;
  readonly resolvePhysicalTable?: (
    table: CandidatePhysicalTable,
  ) => CandidatePhysicalTable | null;
}): UnionV2CandidateUniverseResult {
  const branches = new Map<string, CandidateBranch>();
  const baseReadKeys = new Set(
    input.baseUniverse.branches
      .filter((branch) => branch.consumerTaskId && branch.readOccurrence)
      .map((branch) =>
        readKey(branch.consumerTaskId!, branch.readOccurrence!.occurrenceId),
      ),
  );
  for (const branch of input.baseUniverse.branches) {
    if (
      branch.branchKind === "PHYSICAL_PRODUCER" ||
      branch.branchKind === "SCHEDULE_ONLY"
    )
      continue;
    addBranch(branches, branch);
  }

  let disjointPruned = 0;
  let selfReadBoundaries = 0;
  const indexedReadKeys = new Set<string>();
  for (const entry of input.source.index.entries) {
    const entryTable: CandidatePhysicalTable = {
      platform: null,
      dataSource: null,
      qualifiedName: entry.qualifiedName,
      stableTableId: entry.datasetNodeId,
      identityStatus: entry.identityStatus,
    };
    if (isOutOfScopePhysicalRead(entryTable)) continue;
    if (
      entry.consumerTaskId === input.rootTaskId &&
      isSameTaskScratchTable(entry.qualifiedName)
    )
      continue;
    const key = readKey(entry.consumerTaskId, entry.readOccurrenceId);
    // The INDEX is the producer universe for reads already in this target
    // slice. It must not inject an unrelated task/read just because a shared
    // batch INDEX happens to contain it.
    if (!baseReadKeys.has(key)) continue;
    indexedReadKeys.add(key);
    const indexEntryRef = continuationIndexEntryReference(
      input.source,
      entry.consumerTaskId,
      entry.readOccurrenceId,
    );
    const selection = selectUnionV2Candidates({
      source: input.source,
      scheduleRelation: input.scheduleRelation,
      consumerTaskId: entry.consumerTaskId,
      readOccurrenceId: entry.readOccurrenceId,
      qualifiedName: entry.qualifiedName,
      resolvePhysicalTable: input.resolvePhysicalTable,
    });
    disjointPruned += selection.disjointPruned;
    if (selection.candidates.length === 0) {
      if (selection.reason === "NO_CANDIDATES") {
        const boundary = {
          rootTaskId: input.rootTaskId,
          branchKind: "UNBOUND_READ" as const,
          consumerTaskId: entry.consumerTaskId,
          producerTaskId: null,
          table: entryTable,
          readOccurrence: candidateReadOccurrenceFromIndex(entry),
          producerRole: null,
          evidenceRefs: [
            {
              evidenceRefId: indexEntryRef,
              source: "UNION_CONTINUATION_INDEX",
              locator: indexEntryRef,
            },
          ],
          gapRefs: unique([
            ...entry.gaps.map(
              (gap) => `continuation-gap:${indexEntryRef}:${gap.reasonCode}`,
            ),
            `continuation-gap:${indexEntryRef}:CONTINUATION_PRODUCER_NOT_FOUND`,
          ]),
          boundaryReason: "CONTINUATION_PRODUCER_NOT_FOUND",
        } satisfies Omit<CandidateBranch, "candidateBranchId">;
        addBranch(branches, {
          ...boundary,
          candidateBranchId: canonicalCandidateBranchId(boundary),
        });
      } else if (
        selection.reason === "SCHEDULE_RELATION_UNRESOLVED" ||
        selection.reason === "SCHEDULE_RELATION_NO_MATCH"
      ) {
        const boundaryReason = selection.reason;
        const boundary = {
          rootTaskId: input.rootTaskId,
          branchKind: "UNBOUND_READ" as const,
          consumerTaskId: entry.consumerTaskId,
          producerTaskId: null,
          table: entryTable,
          readOccurrence: candidateReadOccurrenceFromIndex(entry),
          producerRole: null,
          writeObservationId: null,
          writeScope: undefined,
          evidenceRefs: [
            {
              evidenceRefId: indexEntryRef,
              source: "UNION_CONTINUATION_INDEX",
              locator: indexEntryRef,
            },
          ],
          gapRefs: unique([
            ...entry.gaps.map(
              (gap) => `continuation-gap:${indexEntryRef}:${gap.reasonCode}`,
            ),
            `continuation-gap:${indexEntryRef}:${boundaryReason}`,
          ]),
          boundaryReason,
        } satisfies Omit<CandidateBranch, "candidateBranchId">;
        addBranch(branches, {
          ...boundary,
          candidateBranchId: canonicalCandidateBranchId(boundary),
        });
      }
      continue;
    }
    for (const candidate of selection.candidates) {
      const table = tableFromIndex(
        entry,
        candidate,
        input.resolvePhysicalTable,
      );
      const branch = branchForCandidate(
        input.rootTaskId,
        entry,
        candidate,
        table,
        indexEntryRef,
      );
      deleteReadBoundaries(
        branches,
        entry.consumerTaskId,
        entry.readOccurrenceId,
      );
      addBranch(branches, branch);
    }
  }

  let unmatchedReads = 0;
  const unmatchedKeys = new Set<string>();
  for (const branch of input.baseUniverse.branches) {
    if (
      branch.branchKind !== "PHYSICAL_PRODUCER" ||
      !branch.consumerTaskId ||
      !branch.readOccurrence
    )
      continue;
    const key = readKey(
      branch.consumerTaskId,
      branch.readOccurrence.occurrenceId,
    );
    if (indexedReadKeys.has(key) || unmatchedKeys.has(key)) continue;
    unmatchedKeys.add(key);
    if (
      input.isSameTaskSelfRead?.(
        branch.consumerTaskId,
        branch.table?.qualifiedName ?? "",
      )
    ) {
      selfReadBoundaries += 1;
      addBranch(
        branches,
        boundaryForRead(branch, "UNBOUND_READ", "SELF_READ_NOT_EXTERNAL"),
      );
      continue;
    }
    unmatchedReads += 1;
    addBranch(
      branches,
      boundaryForRead(branch, "UNBOUND_READ", "CONTINUATION_READ_NOT_FOUND"),
    );
  }

  const boundaryGapRefs = unique([
    ...input.baseUniverse.boundaryGapRefs,
    ...[...branches.values()]
      .filter(
        (branch) =>
          branch.branchKind === "UNBOUND_READ" ||
          branch.branchKind === "BLOCKED_READ",
      )
      .flatMap((branch) => branch.gapRefs),
  ]);
  if (
    boundaryGapRefs.length > 0 &&
    ![...branches.values()].some(
      (branch) =>
        branch.branchKind === "COVERAGE_BOUNDARY" &&
        branch.boundaryReason === "CANDIDATE_UNIVERSE_BOUNDARY",
    )
  ) {
    const boundary = {
      rootTaskId: input.rootTaskId,
      branchKind: "COVERAGE_BOUNDARY" as const,
      consumerTaskId: null,
      producerTaskId: null,
      table: null,
      readOccurrence: null,
      producerRole: null,
      evidenceRefs: [],
      gapRefs: boundaryGapRefs,
      boundaryReason: "CANDIDATE_UNIVERSE_BOUNDARY",
    } satisfies Omit<CandidateBranch, "candidateBranchId">;
    addBranch(branches, {
      ...boundary,
      candidateBranchId: canonicalCandidateBranchId(boundary),
    });
  }

  return {
    universe: {
      ...input.baseUniverse,
      branches: [...branches.values()].sort((left, right) =>
        left.candidateBranchId.localeCompare(right.candidateBranchId),
      ),
      boundaryGapRefs,
      status:
        boundaryGapRefs.length === 0
          ? "COMPLETE_OBSERVED_EVIDENCE"
          : "INCOMPLETE",
    },
    disjointPruned,
    unmatchedReads,
    selfReadBoundaries,
  };
}
