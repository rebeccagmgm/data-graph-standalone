import type {
  UnionContinuationIndex,
  UnionContinuationIndexEntry,
} from "../continuation/continuation-index.ts";
import type { PolicyTerminalRead } from "./terminal-policy.ts";
import type { SourceEndpointBoundaryRead } from "./source-endpoint-boundary.ts";

export type ContinuationReadClassification =
  "SOURCE_ENDPOINT_BOUNDARY" | "NO_KNOWN_WRITER" | "NO_KNOWN_WRITE_OBSERVATION";

/** Independent evidence supplied by a catalog/contract owner.
 * Absence from a catalog is deliberately not evidence of either boundary. */
export interface ContinuationBoundaryEvidence {
  readonly sourceEndpointBoundaryReadOccurrenceIds?: readonly string[];
  readonly expectedWriterMissingReadOccurrenceIds?: readonly string[];
}

export interface ContinuationEdgeMetrics {
  readonly totalContinuationEdges: number;
  readonly confirmedContinuationEdges: number;
}

export interface ContinuationGapGroup {
  readonly gapCount: number;
  readonly readOccurrenceCount: number;
  readonly reasonCodeCounts: Readonly<Record<string, number>>;
}

export interface ContinuationMetrics {
  readonly totalReadOccurrences: number;
  readonly policyTerminalReadOccurrences: number;
  readonly confirmedSourceBoundaryReadOccurrences: number;
  /** Non-boundary reads retained in the confirmation denominator. */
  readonly withinUnionReadOccurrences: number;
  readonly anyL1ReadOccurrences: number;
  readonly fullyL1ReadOccurrences: number;
  readonly withinUnionConfirmationRate: number | null;
  readonly noKnownWriterReadOccurrences: number;
  readonly unclassifiedNoWriterReadOccurrences: number;
  readonly gapGroups: Readonly<{
    readonly boundary: ContinuationGapGroup;
    readonly actionable: ContinuationGapGroup;
    readonly material: ContinuationGapGroup;
    readonly unclassified: ContinuationGapGroup;
  }>;
  /** Kept separate so edge counts cannot be mistaken for read counts. */
  readonly continuationEdgeMetrics: ContinuationEdgeMetrics | null;
}

export interface ContinuationMetricsOptions {
  readonly index: UnionContinuationIndex;
  readonly boundaryEvidence?: ContinuationBoundaryEvidence;
  readonly boundaryReads?: readonly SourceEndpointBoundaryRead[];
  readonly continuationEdgeMetrics?: ContinuationEdgeMetrics | null;
  readonly policyTerminals?: readonly PolicyTerminalRead[];
}

export function calculateContinuationMetrics(
  options: ContinuationMetricsOptions,
): ContinuationMetrics {
  const sourceBoundary = new Set(
    options.boundaryEvidence?.sourceEndpointBoundaryReadOccurrenceIds ?? [],
  );
  const expectedMissing = new Set(
    options.boundaryEvidence?.expectedWriterMissingReadOccurrenceIds ?? [],
  );
  let confirmedSourceBoundaryReadOccurrences = 0;
  let withinUnionReadOccurrences = 0;
  let anyL1ReadOccurrences = 0;
  let fullyL1ReadOccurrences = 0;
  let noKnownWriterReadOccurrences = 0;
  let unclassifiedNoWriterReadOccurrences = 0;
  let policyTerminalReadOccurrences = 0;
  const policyKeys = new Set(
    (options.policyTerminals ?? []).map(policyTerminalKey),
  );
  const boundaryReads = options.boundaryReads ?? [];

  const groups = {
    boundary: new Map<string, string[]>(),
    actionable: new Map<string, string[]>(),
    material: new Map<string, string[]>(),
    unclassified: new Map<string, string[]>(),
  };

  for (const entry of options.index.entries) {
    const readKey = readKeyOf(entry);
    const evidence = {
      sourceEndpointBoundaryReadOccurrenceIds: [...sourceBoundary],
      expectedWriterMissingReadOccurrenceIds: [...expectedMissing],
    };
    const isPolicyTerminal =
      entry.identityStatus === "CONFIRMED" && policyKeys.has(readKeyOf(entry));
    const isBoundaryRead = isSourceEndpointBoundaryRead(entry, boundaryReads);
    if (isPolicyTerminal) {
      policyTerminalReadOccurrences += 1;
      const policyGaps = classifyContinuationGaps(
        withoutPolicyContinuationGaps(entry),
        evidence,
      );
      for (const gap of policyGaps)
        addGap(groups[gap.group], gap.reasonCode, readKey);
      continue;
    }
    if (isBoundaryRead) {
      confirmedSourceBoundaryReadOccurrences += 1;
      const boundaryGaps = classifyContinuationGaps(
        withoutBoundaryContinuationGaps(entry),
        evidence,
      );
      for (const gap of boundaryGaps)
        addGap(groups[gap.group], gap.reasonCode, readKey);
      continue;
    }
    const retained = entry.candidates.filter(
      (candidate) => candidate.partitionMatchStatus !== "DISJOINT",
    );
    const hasCandidate = entry.candidates.length > 0;
    const classification = classifyContinuationRead(entry, evidence);
    if (!hasCandidate) {
      if (classification === "SOURCE_ENDPOINT_BOUNDARY") {
        confirmedSourceBoundaryReadOccurrences += 1;
      } else if (classification === "NO_KNOWN_WRITER") {
        noKnownWriterReadOccurrences += 1;
      } else {
        unclassifiedNoWriterReadOccurrences += 1;
      }
    }

    for (const gap of classifyContinuationGaps(entry, evidence)) {
      addGap(groups[gap.group], gap.reasonCode, readKey);
    }

    if (classificationIsBoundary(classification)) continue;
    withinUnionReadOccurrences += 1;
    const validL1 = retained.filter(
      (candidate) =>
        entry.identityStatus === "CONFIRMED" &&
        (candidate.source === "IN_UNION_FINAL_WRITE" ||
          candidate.source === "SCHEDULE_RELATION_TABLE") &&
        candidate.partitionMatchStatus === "CONFIRMED" &&
        candidate.evidenceLayer === "L1" &&
        candidate.l1Eligible &&
        hasTargetWriteNodeId(candidate.targetWriteNodeId),
    );
    if (validL1.length > 0) anyL1ReadOccurrences += 1;
    if (retained.length > 0 && validL1.length === retained.length)
      fullyL1ReadOccurrences += 1;
  }

  return {
    totalReadOccurrences: options.index.entries.length,
    policyTerminalReadOccurrences,
    confirmedSourceBoundaryReadOccurrences,
    withinUnionReadOccurrences,
    anyL1ReadOccurrences,
    fullyL1ReadOccurrences,
    withinUnionConfirmationRate:
      withinUnionReadOccurrences === 0
        ? null
        : fullyL1ReadOccurrences / withinUnionReadOccurrences,
    noKnownWriterReadOccurrences,
    unclassifiedNoWriterReadOccurrences,
    gapGroups: {
      boundary: materializeGapGroup(groups.boundary),
      actionable: materializeGapGroup(groups.actionable),
      material: materializeGapGroup(groups.material),
      unclassified: materializeGapGroup(groups.unclassified),
    },
    continuationEdgeMetrics: options.continuationEdgeMetrics ?? null,
  };
}

export function policyTerminalKey(terminal: PolicyTerminalRead): string {
  return `${terminal.consumerTaskId}\u0000${terminal.readOccurrenceId}`;
}

export function isPolicyTerminalRead(
  entry: UnionContinuationIndexEntry,
  policyTerminals: readonly PolicyTerminalRead[],
): boolean {
  return (
    entry.identityStatus === "CONFIRMED" &&
    policyTerminals.some(
      (terminal) => policyTerminalKey(terminal) === readKeyOf(entry),
    )
  );
}

/** Remove partition/writer noise while keeping no-writer gaps for boundary remap. */
export function withoutBoundaryContinuationGaps(
  entry: UnionContinuationIndexEntry,
): UnionContinuationIndexEntry {
  return {
    ...entry,
    gaps: entry.gaps.filter((gap) => {
      const code = String(gap.reasonCode);
      return !(code.startsWith("PARTITION_") || code.startsWith("WRITER_"));
    }),
  };
}

/** Remove gaps that are noise once traversal legitimately stops. */
export function withoutTraversalStopContinuationGaps(
  entry: UnionContinuationIndexEntry,
): UnionContinuationIndexEntry {
  return {
    ...entry,
    gaps: entry.gaps.filter((gap) => {
      const code = String(gap.reasonCode);
      return !(
        code.startsWith("PARTITION_") ||
        code.startsWith("NO_KNOWN_WRITE") ||
        code.startsWith("WRITER_")
      );
    }),
  };
}

/** Remove only gaps explained by the configured terminal traversal policy. */
export function withoutPolicyContinuationGaps(
  entry: UnionContinuationIndexEntry,
): UnionContinuationIndexEntry {
  return withoutTraversalStopContinuationGaps(entry);
}

export function isSourceEndpointBoundaryRead(
  entry: UnionContinuationIndexEntry,
  boundaryReads: readonly SourceEndpointBoundaryRead[],
): boolean {
  const key = readKeyOf(entry);
  return boundaryReads.some(
    (read) => `${read.consumerTaskId}\u0000${read.readOccurrenceId}` === key,
  );
}

/** Classify one read. Boundary labels are valid only for candidate-free reads. */
export function classifyContinuationRead(
  entry: UnionContinuationIndexEntry,
  evidence: ContinuationBoundaryEvidence = {},
): ContinuationReadClassification | null {
  if (entry.candidates.length > 0 || entry.identityStatus !== "CONFIRMED")
    return null;
  const sourceBoundary = new Set(
    evidence.sourceEndpointBoundaryReadOccurrenceIds ?? [],
  );
  const expectedMissing = new Set(
    evidence.expectedWriterMissingReadOccurrenceIds ?? [],
  );
  // A catalog/evidence-map assertion is the primary route. Existing explicit
  // gap labels are accepted only when they carry evidence references.
  const explicitCodes = entry.gaps.filter((gap) => {
    const code = String(gap.reasonCode);
    const refs = gap.details["evidenceRefs"];
    return (
      (code === "SOURCE_ENDPOINT_BOUNDARY" || code === "NO_KNOWN_WRITER") &&
      Array.isArray(refs) &&
      refs.length > 0
    );
  });
  const hasSource =
    sourceBoundary.has(entry.readOccurrenceId) ||
    explicitCodes.some(
      (gap) => String(gap.reasonCode) === "SOURCE_ENDPOINT_BOUNDARY",
    );
  const hasMissing =
    expectedMissing.has(entry.readOccurrenceId) ||
    explicitCodes.some((gap) => String(gap.reasonCode) === "NO_KNOWN_WRITER");
  if (hasMaterialGap(entry) || (hasSource && hasMissing)) return null;
  if (hasSource) return "SOURCE_ENDPOINT_BOUNDARY";
  if (
    expectedMissing.has(entry.readOccurrenceId) ||
    explicitCodes.some((gap) => String(gap.reasonCode) === "NO_KNOWN_WRITER")
  )
    return "NO_KNOWN_WRITER";
  return "NO_KNOWN_WRITE_OBSERVATION";
}

function readKeyOf(entry: UnionContinuationIndexEntry): string {
  return `${entry.consumerTaskId}\u0000${entry.readOccurrenceId}`;
}

function addGap(
  target: Map<string, string[]>,
  reasonCode: string,
  readKey: string,
): void {
  const ids = target.get(reasonCode) ?? [];
  ids.push(readKey);
  target.set(reasonCode, ids);
}

function materializeGapGroup(
  group: Map<string, string[]>,
): ContinuationGapGroup {
  const readOccurrenceIds = new Set<string>();
  const reasonCodeCounts: Record<string, number> = {};
  for (const [reasonCode, ids] of group) {
    reasonCodeCounts[reasonCode] = ids.length;
    for (const id of ids) readOccurrenceIds.add(id);
  }
  return {
    gapCount: [...group.values()].reduce((sum, ids) => sum + ids.length, 0),
    readOccurrenceCount: readOccurrenceIds.size,
    reasonCodeCounts,
  };
}

export type ContinuationGapGroupName =
  "boundary" | "actionable" | "material" | "unclassified";

export interface ClassifiedContinuationGap {
  readonly reasonCode: string;
  readonly group: ContinuationGapGroupName;
}

/** Classify real entry gaps for bounded, paginated consumers. */
export function classifyContinuationGaps(
  entry: UnionContinuationIndexEntry,
  evidence: ContinuationBoundaryEvidence = {},
): readonly ClassifiedContinuationGap[] {
  const classification = classifyContinuationRead(entry, evidence);
  return entry.gaps.map((gap) => {
    const code = String(gap.reasonCode);
    if (
      code === "NO_KNOWN_WRITE_OBSERVATION" &&
      classification === "SOURCE_ENDPOINT_BOUNDARY"
    )
      return {
        reasonCode: "SOURCE_ENDPOINT_BOUNDARY",
        group: "boundary" as const,
      };
    if (
      code === "NO_KNOWN_WRITE_OBSERVATION" &&
      classification === "NO_KNOWN_WRITER"
    )
      return { reasonCode: "NO_KNOWN_WRITER", group: "actionable" as const };
    if (code === "SOURCE_ENDPOINT_BOUNDARY") {
      return classification === "SOURCE_ENDPOINT_BOUNDARY"
        ? { reasonCode: code, group: "boundary" as const }
        : { reasonCode: code, group: "unclassified" as const };
    }
    if (code === "NO_KNOWN_WRITER") {
      return classification === "NO_KNOWN_WRITER"
        ? { reasonCode: code, group: "actionable" as const }
        : { reasonCode: code, group: "unclassified" as const };
    }
    return { reasonCode: code, group: gapGroupFor(code) };
  });
}

function hasMaterialGap(entry: UnionContinuationIndexEntry): boolean {
  return entry.gaps.some(
    (gap) => gapGroupFor(String(gap.reasonCode)) === "material",
  );
}

function hasTargetWriteNodeId(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function classificationIsBoundary(
  classification: ContinuationReadClassification | null,
): boolean {
  return classification === "SOURCE_ENDPOINT_BOUNDARY";
}

function gapGroupFor(
  reasonCode: string,
): "boundary" | "actionable" | "material" | "unclassified" {
  if (reasonCode === "PARTITION_NO_MATCH") return "actionable";
  if (reasonCode === "SOURCE_ENDPOINT_BOUNDARY") return "boundary";
  if (
    reasonCode === "WRITER_NOT_IN_UNION" ||
    reasonCode === "NO_KNOWN_WRITER" ||
    reasonCode === "PARTITION_NON_LITERAL" ||
    reasonCode === "WRITER_PARTITION_UNKNOWN"
  )
    return "actionable";
  if (
    reasonCode === "READ_IDENTITY_NOT_CONFIRMED" ||
    reasonCode === "WRITE_OBSERVATION_ALIGNMENT_AMBIGUOUS"
  )
    return "material";
  return "unclassified";
}
