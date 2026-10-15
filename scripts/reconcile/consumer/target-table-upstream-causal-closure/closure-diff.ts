import {
  canonicalJson,
  sha256,
} from "../../../machine-facts/machine-facts-contract.ts";
import { canonicalRelationIdentity } from "../../../machine-facts/relation-identity.ts";
import type { CandidateBranch } from "../target-field-causal-slice/candidate-universe.ts";
import type {
  TargetTableAssessment,
  TargetTableCausalClosureArtifact,
} from "./artifact-contract.ts";

export const TARGET_TABLE_CAUSAL_CLOSURE_DIFF_ARTIFACT_TYPE =
  "TARGET_TABLE_CAUSAL_CLOSURE_DIFF_V0" as const;
export const TARGET_TABLE_CAUSAL_CLOSURE_DIFF_SCHEMA_VERSION = "0.1.0" as const;

export type ClosureDiffChange = "ADDED" | "REMOVED" | "CHANGED";

export interface ClosureDiffKey {
  readonly taskId: string | null;
  readonly writeObservationId: string | null;
  readonly readOccurrenceId: string | null;
  readonly branchKind: string;
}

interface ClosureDiffSide {
  readonly candidateBranchId: string;
  readonly branchKind: string;
  readonly table: string | null;
  readonly relationStatus: string | null;
  readonly channelStatuses: Readonly<Record<string, string>>;
  readonly valueCertain: boolean;
  readonly continuation?: Readonly<{
    readonly source: string;
    readonly partitionMatchStatus: string;
    readonly evidenceLayer: string;
    readonly l1Eligible: boolean;
  }>;
  readonly gapCodes: readonly string[];
}

export interface ClosureDiffEntry {
  readonly key: ClosureDiffKey;
  readonly change: ClosureDiffChange;
  readonly reasons: readonly string[];
  readonly legacy: ClosureDiffSide | null;
  readonly unionV2: ClosureDiffSide | null;
}

export interface TargetTableCausalClosureDiffV0 {
  readonly schemaVersion: typeof TARGET_TABLE_CAUSAL_CLOSURE_DIFF_SCHEMA_VERSION;
  readonly artifactType: typeof TARGET_TABLE_CAUSAL_CLOSURE_DIFF_ARTIFACT_TYPE;
  readonly generatedAt: string;
  readonly taskId: string;
  readonly targetWriteId: string;
  readonly comparison: Readonly<{
    readonly legacyContentHash: string;
    readonly unionV2ContentHash: string;
  }>;
  readonly baselineAnchor: Readonly<{
    readonly legacyValueCertainTaskCount: number;
    readonly expectedTierOneTaskCount: 27;
    readonly uniqueValueCertainTaskIds: readonly string[];
    readonly status: "MATCHES_27_UNIQUE_TASKS" | "DIFFERS_FROM_27_UNIQUE_TASKS";
  }>;
  readonly summary: Readonly<{
    readonly legacyBranchCount: number;
    readonly unionV2BranchCount: number;
    readonly legacyPhysicalProducerCount: number;
    readonly unionV2PhysicalProducerCount: number;
    readonly legacyValueCertainTaskCount: number;
    readonly unionV2ValueCertainTaskCount: number;
    readonly addedCount: number;
    readonly removedCount: number;
    readonly changedCount: number;
    readonly reasonCounts: Readonly<Record<string, number>>;
    readonly unionContinuationStats:
      TargetTableCausalClosureArtifact["metrics"]["continuationStats"] | null;
  }>;
  readonly entries: readonly ClosureDiffEntry[];
  readonly contentHash: string;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function branchTaskId(branch: CandidateBranch): string | null {
  return (
    branch.producerTaskId ??
    branch.consumerTaskId ??
    (branch.branchKind === "ROOT_WRITE" ? branch.rootTaskId : null)
  );
}

function keyOf(branch: CandidateBranch): ClosureDiffKey {
  return {
    taskId: branchTaskId(branch),
    writeObservationId: branch.writeObservationId ?? null,
    // Multi-hop may expose a query# placeholder while INDEX/Facts carries the
    // task-global occurrence id. Diff alignment uses the proven relation
    // identity; the original spelling remains available in each side's
    // candidateBranchId and evidence refs.
    readOccurrenceId: branch.readOccurrence
      ? canonicalRelationIdentity(branch.readOccurrence.occurrenceId)
      : null,
    branchKind: branch.branchKind,
  };
}

function keyString(key: ClosureDiffKey): string {
  return [
    key.taskId,
    key.writeObservationId,
    key.readOccurrenceId,
    key.branchKind,
  ]
    .map((value) => value ?? "")
    .join("\u0000");
}

function assessmentByBranch(
  artifact: TargetTableCausalClosureArtifact,
): ReadonlyMap<string, TargetTableAssessment> {
  return new Map(
    artifact.assessments.map((assessment) => [
      assessment.candidateBranchId,
      assessment,
    ]),
  );
}

function valueCertainKeys(
  artifact: TargetTableCausalClosureArtifact,
): ReadonlySet<string> {
  const values = artifact.shrinkReport?.valueCertain ?? [];
  return new Set(
    values.map(
      (value) => `${value.taskId}\u0000${value.table?.toLowerCase() ?? ""}`,
    ),
  );
}

function gapCodes(gaps: readonly string[]): readonly string[] {
  const known = new Set<string>();
  for (const gap of gaps) {
    const match = gap.match(/(?:^|:)([A-Z][A-Z0-9_]+)$/);
    if (match?.[1]) known.add(match[1]);
    for (const code of [
      "CONTINUATION_READ_NOT_FOUND",
      "CONTINUATION_PRODUCER_NOT_FOUND",
      "WRITE_OBSERVATION_ALIGNMENT_AMBIGUOUS",
      "PRODUCER_WRITE_SCOPE_UNRESOLVED",
      "OCCURRENCE_EVIDENCE_NOT_FOUND",
    ]) {
      if (gap.includes(code)) known.add(code);
    }
  }
  return [...known].sort((left, right) => left.localeCompare(right));
}

function sideOf(
  artifact: TargetTableCausalClosureArtifact,
  branch: CandidateBranch,
  assessments: ReadonlyMap<string, TargetTableAssessment>,
): ClosureDiffSide {
  const assessment = assessments.get(branch.candidateBranchId);
  const valueKey = `${branchTaskId(branch)}\u0000${branch.table?.qualifiedName?.toLowerCase() ?? ""}`;
  return {
    candidateBranchId: branch.candidateBranchId,
    branchKind: branch.branchKind,
    table: branch.table?.qualifiedName ?? null,
    relationStatus: assessment?.relationStatus ?? null,
    channelStatuses: Object.fromEntries(
      (assessment?.channelAssessments ?? []).map((channel) => [
        channel.channel,
        channel.status,
      ]),
    ),
    valueCertain: valueCertainKeys(artifact).has(valueKey),
    ...(branch.continuation
      ? {
          continuation: {
            source: branch.continuation.source,
            partitionMatchStatus: branch.continuation.partitionMatchStatus,
            evidenceLayer: branch.continuation.evidenceLayer,
            l1Eligible: branch.continuation.l1Eligible,
          },
        }
      : {}),
    gapCodes: gapCodes([...branch.gapRefs, ...(assessment?.gapRefs ?? [])]),
  };
}

function sameSide(left: ClosureDiffSide, right: ClosureDiffSide): boolean {
  return (
    canonicalJson({
      branchKind: left.branchKind,
      table: left.table,
      relationStatus: left.relationStatus,
      channelStatuses: left.channelStatuses,
      valueCertain: left.valueCertain,
      continuation: left.continuation,
      gapCodes: left.gapCodes,
    }) ===
    canonicalJson({
      branchKind: right.branchKind,
      table: right.table,
      relationStatus: right.relationStatus,
      channelStatuses: right.channelStatuses,
      valueCertain: right.valueCertain,
      continuation: right.continuation,
      gapCodes: right.gapCodes,
    })
  );
}

function unionBoundaryFor(
  union: TargetTableCausalClosureArtifact,
  legacyBranch: CandidateBranch,
): CandidateBranch | undefined {
  if (!legacyBranch.consumerTaskId || !legacyBranch.readOccurrence)
    return undefined;
  const consumerTaskId = legacyBranch.consumerTaskId;
  const readOccurrenceId = canonicalRelationIdentity(
    legacyBranch.readOccurrence.occurrenceId,
  );
  if (!readOccurrenceId) return undefined;
  return union.candidateUniverse.branches.find(
    (branch) =>
      (branch.branchKind === "UNBOUND_READ" ||
        branch.branchKind === "BLOCKED_READ") &&
      branch.consumerTaskId === consumerTaskId &&
      canonicalRelationIdentity(branch.readOccurrence?.occurrenceId) ===
        readOccurrenceId,
  );
}

function reasonsFor(
  legacy: ClosureDiffSide | null,
  union: ClosureDiffSide | null,
  legacyBranch: CandidateBranch | undefined,
  unionBoundary: CandidateBranch | undefined,
): readonly string[] {
  const reasons = new Set<string>();
  if (!legacy) {
    if (union?.branchKind === "PHYSICAL_PRODUCER")
      reasons.add("UNION_INDEX_CANDIDATE_ADDED");
    else if (union?.branchKind === "UNBOUND_READ") reasons.add("UNBOUND_READ");
    else if (union?.branchKind === "BLOCKED_READ") reasons.add("BLOCKED_READ");
    else if (union?.branchKind === "COVERAGE_BOUNDARY")
      reasons.add("COVERAGE_BOUNDARY");
  }
  if (!union) {
    if (
      unionBoundary?.gapRefs.some((gap) =>
        gap.includes("CONTINUATION_READ_NOT_FOUND"),
      )
    ) {
      reasons.add("CONTINUATION_READ_NOT_FOUND");
    }
    if (legacy?.branchKind === "PHYSICAL_PRODUCER")
      reasons.add("UNION_INDEX_CANDIDATE_NOT_FOUND");
    if (legacy?.branchKind === "SCHEDULE_ONLY") reasons.add("SCHEDULE_ONLY");
    if (legacy?.branchKind === "UNBOUND_READ") reasons.add("UNBOUND_READ");
    if (legacy?.branchKind === "BLOCKED_READ") reasons.add("BLOCKED_READ");
    if (legacy?.branchKind === "COVERAGE_BOUNDARY")
      reasons.add("COVERAGE_BOUNDARY");
  }
  if (legacy?.valueCertain && !union?.valueCertain)
    reasons.add("VALUE_CERTAINTY_CAP");
  for (const side of [
    union,
    unionBoundary
      ? {
          gapCodes: gapCodes(unionBoundary.gapRefs),
          continuation: undefined,
        }
      : null,
  ]) {
    if (!side) continue;
    if (side.continuation?.source === "PRODUCER_INDEX_ONLY")
      reasons.add("PI_ONLY");
    if (side.continuation?.partitionMatchStatus === "ASSUMED")
      reasons.add("L2_ASSUMED");
    if (side.continuation?.partitionMatchStatus === "UNKNOWN")
      reasons.add("L2_UNKNOWN");
    for (const code of side.gapCodes) reasons.add(code);
  }
  if (union && legacy && !sameSide(legacy, union))
    reasons.add("CLOSURE_SIDE_CHANGED");
  if (reasons.size === 0 && legacyBranch?.branchKind === "PHYSICAL_PRODUCER")
    reasons.add("UNION_INDEX_CANDIDATE_NOT_FOUND");
  return [...reasons].sort((left, right) => left.localeCompare(right));
}

function physicalCount(artifact: TargetTableCausalClosureArtifact): number {
  return artifact.candidateUniverse.branches.filter(
    (branch) => branch.branchKind === "PHYSICAL_PRODUCER",
  ).length;
}

function uniqueValueCertainTasks(
  artifact: TargetTableCausalClosureArtifact,
): readonly string[] {
  return unique(
    (artifact.shrinkReport?.valueCertain ?? []).map((entry) => entry.taskId),
  );
}

function reasonCounts(
  entries: readonly ClosureDiffEntry[],
  continuationStats: TargetTableCausalClosureArtifact["metrics"]["continuationStats"],
): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const reason of entry.reasons)
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  if (continuationStats?.disjointPruned)
    counts.set("DISJOINT_PRUNED", continuationStats.disjointPruned);
  if (continuationStats?.unmatchedReads)
    counts.set("CONTINUATION_READ_NOT_FOUND", continuationStats.unmatchedReads);
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function buildTargetTableCausalClosureDiffV0(input: {
  readonly legacy: TargetTableCausalClosureArtifact;
  readonly unionV2: TargetTableCausalClosureArtifact;
  readonly generatedAt?: string;
}): TargetTableCausalClosureDiffV0 {
  if (
    input.legacy.targetWrite.identity.taskId !==
    input.unionV2.targetWrite.identity.taskId
  ) {
    throw new Error("CLOSURE_DIFF_TASK_MISMATCH");
  }
  if (
    input.legacy.targetWrite.identity.targetWriteId !==
    input.unionV2.targetWrite.identity.targetWriteId
  ) {
    throw new Error("CLOSURE_DIFF_TARGET_WRITE_MISMATCH");
  }
  const legacyAssessments = assessmentByBranch(input.legacy);
  const unionAssessments = assessmentByBranch(input.unionV2);
  const legacyBranches = new Map(
    input.legacy.candidateUniverse.branches.map((branch) => [
      keyString(keyOf(branch)),
      branch,
    ]),
  );
  const unionBranches = new Map(
    input.unionV2.candidateUniverse.branches.map((branch) => [
      keyString(keyOf(branch)),
      branch,
    ]),
  );
  const keys = [
    ...new Set([...legacyBranches.keys(), ...unionBranches.keys()]),
  ].sort((left, right) => left.localeCompare(right));
  const entries: ClosureDiffEntry[] = [];
  for (const key of keys) {
    const legacyBranch = legacyBranches.get(key);
    const unionBranch = unionBranches.get(key);
    const legacySide = legacyBranch
      ? sideOf(input.legacy, legacyBranch, legacyAssessments)
      : null;
    const unionSide = unionBranch
      ? sideOf(input.unionV2, unionBranch, unionAssessments)
      : null;
    if (legacySide && unionSide && sameSide(legacySide, unionSide)) continue;
    const change: ClosureDiffChange = !legacySide
      ? "ADDED"
      : !unionSide
        ? "REMOVED"
        : "CHANGED";
    const unionBoundary =
      legacyBranch && !unionSide
        ? unionBoundaryFor(input.unionV2, legacyBranch)
        : undefined;
    const reasons = reasonsFor(
      legacySide,
      unionSide,
      legacyBranch,
      unionBoundary,
    );
    entries.push({
      key: legacyBranch ? keyOf(legacyBranch) : keyOf(unionBranch!),
      change,
      reasons,
      legacy: legacySide,
      unionV2: unionSide,
    });
  }
  const legacyTasks = uniqueValueCertainTasks(input.legacy);
  const unionTasks = uniqueValueCertainTasks(input.unionV2);
  const continuationStats = input.unionV2.metrics.continuationStats ?? null;
  const body = {
    schemaVersion: TARGET_TABLE_CAUSAL_CLOSURE_DIFF_SCHEMA_VERSION,
    artifactType: TARGET_TABLE_CAUSAL_CLOSURE_DIFF_ARTIFACT_TYPE,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    taskId: input.legacy.targetWrite.identity.taskId,
    targetWriteId: input.legacy.targetWrite.identity.targetWriteId,
    comparison: {
      legacyContentHash: input.legacy.contentHash,
      unionV2ContentHash: input.unionV2.contentHash,
    },
    baselineAnchor: {
      legacyValueCertainTaskCount: legacyTasks.length,
      expectedTierOneTaskCount: 27 as const,
      uniqueValueCertainTaskIds: legacyTasks,
      status:
        legacyTasks.length === 27
          ? ("MATCHES_27_UNIQUE_TASKS" as const)
          : ("DIFFERS_FROM_27_UNIQUE_TASKS" as const),
    },
    summary: {
      legacyBranchCount: input.legacy.candidateUniverse.branches.length,
      unionV2BranchCount: input.unionV2.candidateUniverse.branches.length,
      legacyPhysicalProducerCount: physicalCount(input.legacy),
      unionV2PhysicalProducerCount: physicalCount(input.unionV2),
      legacyValueCertainTaskCount: legacyTasks.length,
      unionV2ValueCertainTaskCount: unionTasks.length,
      addedCount: entries.filter((entry) => entry.change === "ADDED").length,
      removedCount: entries.filter((entry) => entry.change === "REMOVED")
        .length,
      changedCount: entries.filter((entry) => entry.change === "CHANGED")
        .length,
      reasonCounts: reasonCounts(entries, continuationStats ?? undefined),
      unionContinuationStats: continuationStats,
    },
    entries,
  };
  return {
    ...body,
    contentHash: sha256(canonicalJson(body)),
  };
}

export function validateTargetTableCausalClosureDiffV0(
  diff: TargetTableCausalClosureDiffV0,
): void {
  if (
    diff.schemaVersion !== TARGET_TABLE_CAUSAL_CLOSURE_DIFF_SCHEMA_VERSION ||
    diff.artifactType !== TARGET_TABLE_CAUSAL_CLOSURE_DIFF_ARTIFACT_TYPE
  )
    throw new Error("CLOSURE_DIFF_CONTRACT_INVALID");
  const { contentHash: _contentHash, ...body } = diff;
  if (sha256(canonicalJson(body)) !== diff.contentHash)
    throw new Error("CLOSURE_DIFF_CONTENT_HASH_INVALID");
  if (
    diff.summary.addedCount +
      diff.summary.removedCount +
      diff.summary.changedCount !==
    diff.entries.length
  ) {
    throw new Error("CLOSURE_DIFF_SUMMARY_COUNT_INVALID");
  }
  for (const entry of diff.entries) {
    if (entry.reasons.length === 0)
      throw new Error("CLOSURE_DIFF_REASON_MISSING");
  }
}
