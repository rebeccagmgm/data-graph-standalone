import type { CandidateBranch } from "../target-field-causal-slice/candidate-universe.ts";
import type { FieldValueEvidenceProvider } from "./field-value-provider.ts";
import type { ImpactChannel, LocalTransferKind, TaskRelationSummary } from "./task-relation-summary.ts";
import {
  isOutOfScopePhysicalRead,
  isReferenceConfigTable,
  isSameTaskScratchProducerBridge,
  isSameTaskScratchTable,
} from "../../shared/lineage-scope.ts";
import {
  canonicalAssessment,
  type ChannelAssessment,
  type PrunedReason,
  type PrunedReasonCode,
  type RelationStatus,
  type ShrinkReport,
  type ShrinkReportEntry,
  type TargetTableAssessment,
} from "./artifact-contract.ts";

export const CAUSAL_IMPACT_CHANNELS: readonly ImpactChannel[] = [
  "FIELD_VALUE",
  "EXPRESSION_CONTROL",
  "ROW_MEMBERSHIP",
  "MULTIPLICITY",
  "GROUPING",
  "SET_MEMBERSHIP",
  "ORDER_SELECTION",
  "WINDOW_EFFECT",
  "RELATION_EXISTENCE",
];

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function canonicalOccurrence(value: string): string {
  return value.trim().toLowerCase();
}

function occurrenceTail(value: string): string {
  const normalized = canonicalOccurrence(value);
  const relation = normalized.match(/:relation:(.+)$/);
  if (relation?.[1]) return relation[1];
  const slotted = normalized.match(/^(?:create|query)#\d+:(.+)$/);
  if (slotted?.[1]) return slotted[1];
  return normalized;
}

function sameOccurrence(left: string, right: string): boolean {
  const a = canonicalOccurrence(left);
  const b = canonicalOccurrence(right);
  if (a === b) return true;
  const leftTail = occurrenceTail(a);
  const rightTail = occurrenceTail(b);
  return leftTail.length > 0 && leftTail === rightTail;
}

function certainProducerRole(role: string | null | undefined): boolean {
  const normalized = (role ?? "PRIMARY").trim().toUpperCase();
  return normalized === "PRIMARY" || normalized === "ADDITIONAL";
}

function emptyChannel(
  channel: ImpactChannel,
  status: ChannelAssessment["status"],
  gapRefs: readonly string[] = [],
): ChannelAssessment {
  return { channel, status, proofRefs: [], witnessRefs: [], gapRefs: unique(gapRefs) };
}

function statementLevelGaps(summary: TaskRelationSummary): readonly string[] {
  return summary.gaps.filter((gap) =>
    /relation-summary-gap:[^:]+:(?:PARSE_|SQL_SOURCE_ID_UNRESOLVED|ROOT_RELATION_NOT_FOUND)/i.test(gap),
  );
}

function semantic(
  branch: CandidateBranch,
  summary: TaskRelationSummary | undefined,
  channel: ImpactChannel,
): ChannelAssessment {
  if (!summary || !branch.readOccurrence) {
    return emptyChannel(channel, "UNKNOWN", [`summary-gap:${branch.consumerTaskId ?? "unknown"}`]);
  }
  const ids = [branch.readOccurrence.occurrenceId, branch.readOccurrence.readRelationId];
  const matches = summary.readImpacts.filter((impact) => ids.some((id) => sameOccurrence(id, impact.readOccurrenceId)));
  const parseGaps = statementLevelGaps(summary);
  if (matches.length === 0) {
    return summary.complete && parseGaps.length === 0
      ? emptyChannel(channel, "NOT_APPLICABLE")
      : emptyChannel(channel, "UNKNOWN", parseGaps.length > 0 ? parseGaps : summary.gaps);
  }
  const relevant = matches.filter((impact) => impact.impactChannels.includes(channel));
  if (relevant.length === 0) {
    return parseGaps.length > 0
      ? emptyChannel(channel, "UNKNOWN", parseGaps)
      : emptyChannel(channel, "NOT_APPLICABLE");
  }
  const refs = unique(relevant.flatMap((impact) => impact.evidenceRefs));
  const gaps = unique([
    ...relevant.flatMap((impact) => impact.gaps),
    ...parseGaps,
  ]);
  const demandedFieldNames = unique(relevant.flatMap((impact) => impact.demandedFieldNames ?? []));
  const localTransferKinds = unique(relevant.flatMap((impact) => impact.localTransferKinds ?? [])) as LocalTransferKind[];
  return {
    channel,
    status: gaps.length > 0 ? "UNKNOWN" : "CONFIRMED",
    proofRefs: refs,
    witnessRefs: refs,
    gapRefs: gaps,
    ...(localTransferKinds.length > 0 ? { localTransferKinds } : {}),
    ...(demandedFieldNames.length > 0 ? { demandedFieldNames } : {}),
  };
}

/**
 * Compute only the local transfer offered by one consumer read occurrence.
 * This is not a candidate assessment: causal-closure.ts composes these
 * transfers with downstream propagation states.
 */
export function localChannelAssessments(input: {
  readonly branch: CandidateBranch;
  readonly summary?: TaskRelationSummary;
  readonly fieldValueProvider: FieldValueEvidenceProvider;
}): readonly ChannelAssessment[] {
  const branchGaps = unique(input.branch.gapRefs);
  if (input.branch.branchKind === "ROOT_WRITE") return [];
  if (input.branch.branchKind !== "PHYSICAL_PRODUCER") {
    const boundaryChannels: readonly ImpactChannel[] = ["FIELD_VALUE", "ROW_MEMBERSHIP", "MULTIPLICITY", "RELATION_EXISTENCE"];
    return boundaryChannels.map((channel) =>
      emptyChannel(channel, "UNKNOWN", [...branchGaps, `candidate-boundary:${input.branch.candidateBranchId}:${input.branch.branchKind}`]),
    );
  }
  const fieldValue = input.fieldValueProvider.lookup(input.branch);
  const values: ChannelAssessment[] = [{
    channel: "FIELD_VALUE",
    status: fieldValue.status === "PROVEN_ABSENT" ? "NOT_APPLICABLE" : fieldValue.status,
    proofRefs: fieldValue.evidenceRefs,
    witnessRefs: fieldValue.evidenceRefs,
    gapRefs: [...branchGaps, ...fieldValue.gapRefs],
    outputFieldBindingIds: fieldValue.outputFieldBindingIds,
    affectedTargetFields: fieldValue.affectedTargetFields,
    localTransferKinds: ["VALUE_FLOW"],
    demandedFieldNames: fieldValue.affectedTargetFields,
  }];
  for (const channel of CAUSAL_IMPACT_CHANNELS) {
    if (channel === "FIELD_VALUE") continue;
    values.push(semantic(input.branch, input.summary, channel));
  }
  return values.map((value) => value.gapRefs.length === 0 || value.status === "NOT_APPLICABLE"
    ? value
    : { ...value, gapRefs: unique([...value.gapRefs, ...branchGaps]) });
}

/** Backward-compatible local view; the CLI uses fixed-point propagation instead. */
export function assessBranch(input: {
  readonly targetWriteId: string;
  readonly branch: CandidateBranch;
  readonly universeComplete: boolean;
  readonly summary?: TaskRelationSummary;
  readonly fieldValueProvider: FieldValueEvidenceProvider;
}): TargetTableAssessment {
  if (input.branch.branchKind === "ROOT_WRITE") {
    return canonicalAssessment({
      targetWriteId: input.targetWriteId,
      candidateBranchId: input.branch.candidateBranchId,
      relationStatus: "CONFIRMED_RELATED",
      channelAssessments: [],
      evidenceRefs: input.branch.evidenceRefs.map((ref) => ref.evidenceRefId),
      gapRefs: [],
      negativeProofs: [],
    });
  }
  const channels = localChannelAssessments(input);
  const positive = channels.some((channel) => channel.status === "CONFIRMED");
  const conditional = channels.some((channel) => channel.status === "CONDITIONAL");
  const gapRefs = unique([...input.branch.gapRefs, ...channels.flatMap((channel) => channel.gapRefs)]);
  const producerWriteUnresolved = input.branch.branchKind === "PHYSICAL_PRODUCER" && (
    input.branch.writeObservationId === null ||
    input.branch.gapRefs.some((gap) => /PRODUCER_WRITE|WRITE_OBSERVATION/i.test(gap))
  );
  const relationStatus: RelationStatus = producerWriteUnresolved
    ? "UNKNOWN"
    : positive
    ? "CONFIRMED_RELATED"
    : conditional
      ? "CONDITIONAL_RELATED"
      : "UNKNOWN";
  return canonicalAssessment({
    targetWriteId: input.targetWriteId,
    candidateBranchId: input.branch.candidateBranchId,
    relationStatus,
    channelAssessments: channels,
    evidenceRefs: unique(channels.flatMap((channel) => [...channel.proofRefs, ...channel.witnessRefs])),
    gapRefs: gapRefs.length > 0 ? gapRefs : [`causal-gap:${input.branch.candidateBranchId}:NO_CLOSED_PATH`],
    negativeProofs: [],
  });
}

export function rollupAssessments(input: {
  readonly branches: readonly CandidateBranch[];
  readonly assessments: readonly TargetTableAssessment[];
}): {
  readonly taskRollup: readonly {
    readonly producerTaskId: string;
    readonly branchIds: readonly string[];
    readonly relationStatus: RelationStatus;
    readonly impactChannels: readonly ImpactChannel[];
    readonly evidenceRefs: readonly string[];
    readonly gapRefs: readonly string[];
  }[];
  readonly minimumCertainTaskIds: readonly string[];
  readonly conservativeSafetyTaskIds: readonly string[];
} {
  const rootBranch = input.branches.find((branch) => branch.branchKind === "ROOT_WRITE");
  const rootTaskId = rootBranch?.producerTaskId ?? null;
  const rootAssessment = rootBranch
    ? input.assessments.find((assessment) => assessment.candidateBranchId === rootBranch.candidateBranchId)
    : undefined;
  const rootEvidenceIds = unique([
    ...(rootBranch?.evidenceRefs ?? []).map((ref) => ref.evidenceRefId),
    ...(rootAssessment?.evidenceRefs ?? []),
  ]);
  const rootGapIds = unique([
    ...(rootBranch?.gapRefs ?? []),
    ...(rootAssessment?.gapRefs ?? []),
  ]);
  const byTask = new Map<string, TargetTableAssessment[]>();
  const certainIds = new Set<string>();
  for (const assessment of input.assessments) {
    const branch = input.branches.find((candidate) => candidate.candidateBranchId === assessment.candidateBranchId);
    if (!branch?.producerTaskId || branch.branchKind === "ROOT_WRITE") continue;
    const list = byTask.get(branch.producerTaskId) ?? [];
    list.push(assessment);
    byTask.set(branch.producerTaskId, list);
    if (
      assessment.relationStatus === "CONFIRMED_RELATED" &&
      (branch.branchKind !== "PHYSICAL_PRODUCER" || certainProducerRole(branch.producerRole))
    ) {
      certainIds.add(branch.producerTaskId);
    }
  }
  // Target root write is always part of the operational certain/safety sets:
  // rerunning upstream without the sink itself is incomplete.
  if (rootTaskId) certainIds.add(rootTaskId);
  const upstreamRollup = [...byTask.entries()].map(([producerTaskId, values]) => {
    const rank = (status: RelationStatus): number => status === "CONFIRMED_RELATED" ? 3 : status === "CONDITIONAL_RELATED" ? 2 : status === "UNKNOWN" ? 1 : 0;
    const best = values.reduce((left, right) => rank(right.relationStatus) > rank(left.relationStatus) ? right : left);
    return {
      producerTaskId,
      branchIds: unique(values.map((value) => value.candidateBranchId)),
      relationStatus: best.relationStatus,
      impactChannels: [...new Set(values.flatMap((value) => value.channelAssessments.filter((channel) => channel.status === "CONFIRMED" || channel.status === "CONDITIONAL").map((channel) => channel.channel)))].sort() as ImpactChannel[],
      evidenceRefs: unique(values.flatMap((value) => value.evidenceRefs)),
      gapRefs: unique(values.flatMap((value) => value.gapRefs)),
    };
  });
  const rootRollup = rootTaskId && rootBranch
    ? [{
        producerTaskId: rootTaskId,
        branchIds: [rootBranch.candidateBranchId],
        relationStatus: "CONFIRMED_RELATED" as const,
        impactChannels: ["FIELD_VALUE"] as ImpactChannel[],
        evidenceRefs: rootEvidenceIds,
        gapRefs: rootGapIds,
      }]
    : [];
  const taskRollup = [...rootRollup, ...upstreamRollup]
    .sort((left, right) => left.producerTaskId.localeCompare(right.producerTaskId));
  return {
    taskRollup,
    minimumCertainTaskIds: [...certainIds].sort((left, right) => left.localeCompare(right)),
    conservativeSafetyTaskIds: taskRollup.map((value) => value.producerTaskId),
  };
}

function confirmed(assessment: TargetTableAssessment, channel: ImpactChannel): ChannelAssessment | undefined {
  return assessment.channelAssessments.find((item) => item.channel === channel && item.status === "CONFIRMED");
}

export function buildShrinkReport(input: {
  readonly branches: readonly CandidateBranch[];
  readonly assessments: readonly TargetTableAssessment[];
  /** Union-v2 combined proof: L1 continuation plus current Facts local closure. */
  readonly unionV2ValueCertainBranchIds?: ReadonlySet<string>;
}): ShrinkReport {
  const branchById = new Map(input.branches.map((branch) => [branch.candidateBranchId, branch]));
  const entry = (assessment: TargetTableAssessment, channel: ImpactChannel): ShrinkReportEntry | null => {
    const branch = branchById.get(assessment.candidateBranchId);
    if (!branch?.producerTaskId || branch.branchKind === "ROOT_WRITE") return null;
    if (branch.branchKind === "PHYSICAL_PRODUCER" && !certainProducerRole(branch.producerRole)) return null;
    const hit = confirmed(assessment, channel)
      ?? (channel === "FIELD_VALUE" && input.unionV2ValueCertainBranchIds?.has(assessment.candidateBranchId)
        ? assessment.channelAssessments.find((item) => item.channel === channel && item.status === "CONDITIONAL")
        : undefined);
    if (!hit) return null;
    const joinNode = channel === "MULTIPLICITY" ? joinNodeOf(branch) : undefined;
    return {
      taskId: branch.producerTaskId,
      table: branch.table?.qualifiedName ?? null,
      channel,
      viaFields: unique(hit.demandedFieldNames ?? hit.affectedTargetFields ?? []),
      witness: unique([...hit.witnessRefs, ...hit.proofRefs]),
      ...(joinNode ? { joinNode } : {}),
    };
  };
  const upstreamValueCertain = input.assessments
    .map((assessment) => entry(assessment, "FIELD_VALUE"))
    .filter((value): value is ShrinkReportEntry => value !== null);
  const rootBranch = input.branches.find((branch) => branch.branchKind === "ROOT_WRITE");
  const rootValueCertain: ShrinkReportEntry | null =
    rootBranch?.producerTaskId
      ? {
          taskId: rootBranch.producerTaskId,
          table: rootBranch.table?.qualifiedName ?? null,
          channel: "FIELD_VALUE",
          // Root is the sink write itself; viaFields stay empty so upstream
          // VALUE_FLOW columns remain the only column-level carriers.
          viaFields: [],
          witness: unique((rootBranch.evidenceRefs ?? []).map((ref) => ref.evidenceRefId)),
        }
      : null;
  const valueCertain = mergeShrinkEntries(
    rootValueCertain ? [rootValueCertain, ...upstreamValueCertain] : upstreamValueCertain,
  );
  const valueIds = new Set(valueCertain.map((item) => item.taskId));
  const rowDetermining = input.assessments
    .map((assessment) => entry(assessment, "ROW_MEMBERSHIP"))
    .filter((value): value is ShrinkReportEntry => value !== null && !valueIds.has(value.taskId));
  const rowIds = new Set(rowDetermining.map((item) => item.taskId));
  const multiplicityRisk = input.assessments
    .map((assessment) => entry(assessment, "MULTIPLICITY"))
    .filter((value): value is ShrinkReportEntry => value !== null && !valueIds.has(value.taskId) && !rowIds.has(value.taskId));
  const listed = new Set([...valueIds, ...rowIds, ...multiplicityRisk.map((item) => item.taskId)]);
  const pruned = input.assessments.filter((assessment) => {
    const branch = branchById.get(assessment.candidateBranchId);
    if (!branch || branch.branchKind === "ROOT_WRITE") return false;
    return !branch.producerTaskId || !listed.has(branch.producerTaskId);
  });
  return {
    valueCertain,
    rowDetermining: mergeShrinkEntries(rowDetermining),
    multiplicityRisk: mergeShrinkEntries(multiplicityRisk, "join"),
    prunedCount: pruned.length,
    prunedReasons: collectPrunedReasons(pruned, branchById),
  };
}

const PRUNED_SAMPLE_LIMIT = 3;

function joinNodeOf(branch: CandidateBranch): string | undefined {
  const path = branch.readOccurrence?.relationPath ?? [];
  return [...path].reverse().find((id) => /:relation:join(?:\.|$|:)/i.test(id) || /(?:^|[./:])join(?:[./:]|$)/i.test(id));
}

export function classifyPrunedReason(branch: CandidateBranch, assessment: TargetTableAssessment): PrunedReasonCode {
  const tableName = branch.table?.qualifiedName ?? null;
  if (
    isSameTaskScratchProducerBridge(branch.consumerTaskId, branch.producerTaskId, tableName)
    || (branch.branchKind === "UNBOUND_READ" && isSameTaskScratchTable(tableName))
  ) {
    return "TASK_LOCAL_MATERIALIZATION";
  }
  if (branch.branchKind === "UNBOUND_READ") {
    if (isOutOfScopePhysicalRead(branch.table) || isReferenceConfigTable(tableName)) {
      return "COVERAGE_BOUNDARY";
    }
    return "UNBOUND_READ";
  }
  if (branch.branchKind === "SCHEDULE_ONLY") return "SCHEDULE_ONLY";
  if (branch.branchKind === "BLOCKED_READ") return "BLOCKED_READ";
  if (branch.branchKind === "COVERAGE_BOUNDARY") return "COVERAGE_BOUNDARY";
  const gaps = [...branch.gapRefs, ...assessment.gapRefs];
  if (gaps.some((gap) => /UNSUPPORTED_OPERATOR/i.test(gap))) return "UNSUPPORTED_OPERATOR";
  if (gaps.some((gap) => /OCCURRENCE_EVIDENCE_NOT_FOUND/i.test(gap))) {
    return "FIELD_LINEAGE_OCC_MISMATCH";
  }
  if (gaps.some((gap) => /NOT_REACHED_FROM_ROOT/i.test(gap))) {
    const fieldValue = assessment.channelAssessments.find((channel) => channel.channel === "FIELD_VALUE");
    if (fieldValue?.status === "NOT_APPLICABLE") return "LEFT_DIM";
    return "NOT_REACHED_FROM_ROOT";
  }
  if (gaps.some((gap) => /NO_CLOSED_PATH/i.test(gap))) {
    const fieldValue = assessment.channelAssessments.find((channel) => channel.channel === "FIELD_VALUE");
    if (fieldValue?.status === "NOT_APPLICABLE") return "LEFT_DIM";
    return "NO_CLOSED_PATH";
  }
  if (gaps.some((gap) =>
    /relation-summary-gap:|RELATION_SUMMARY|PARSE_|ROOT_RELATION_NOT_FOUND|RELATION_IDENTITY_UNRESOLVED/i.test(gap),
  )) {
    const fieldValue = assessment.channelAssessments.find((channel) => channel.channel === "FIELD_VALUE");
    if (fieldValue?.status === "NOT_APPLICABLE") return "LEFT_DIM";
    return "RELATION_SUMMARY_INCOMPLETE";
  }
  if (
    !branch.producerTaskId
    || branch.writeObservationId == null
    || !branch.writeScope
    || gaps.some((gap) => /PRODUCER_WRITE|WRITE_OBSERVATION/i.test(gap))
  ) {
    return "NO_PRODUCER_BRIDGE";
  }
  return "UNCLASSIFIED";
}

/** Assessment-level UNKNOWN reasons aligned with 档四 pruned taxonomy. */
export function unknownReasonCodesForAssessment(
  branch: CandidateBranch | undefined,
  assessment: TargetTableAssessment,
): readonly string[] {
  const gaps = [...new Set([...(branch?.gapRefs ?? []), ...assessment.gapRefs])];
  const reasons = new Set<string>();
  const fieldValue = assessment.channelAssessments.find((channel) => channel.channel === "FIELD_VALUE");

  for (const gap of gaps) {
    if (/PROPAGATION_BUDGET/i.test(gap)) {
      reasons.add(gap.split(":").at(-1) ?? "PROPAGATION_BUDGET");
      continue;
    }
    if (/OCCURRENCE_EVIDENCE_NOT_FOUND/i.test(gap)) {
      reasons.add("FIELD_LINEAGE_OCC_MISMATCH");
      continue;
    }
    if (/NOT_REACHED_FROM_ROOT/i.test(gap)) {
      reasons.add(fieldValue?.status === "NOT_APPLICABLE" ? "LEFT_DIM" : "NOT_REACHED_FROM_ROOT");
      continue;
    }
    if (/NO_CLOSED_PATH/i.test(gap)) {
      reasons.add(fieldValue?.status === "NOT_APPLICABLE" ? "LEFT_DIM" : "NO_CLOSED_PATH");
      continue;
    }
    if (/UNSUPPORTED_OPERATOR/i.test(gap)) {
      reasons.add("UNSUPPORTED_OPERATOR");
      continue;
    }
    if (/relation-summary-gap:|RELATION_SUMMARY|PARSE_|ROOT_RELATION_NOT_FOUND|RELATION_IDENTITY_UNRESOLVED/i.test(gap)) {
      reasons.add(fieldValue?.status === "NOT_APPLICABLE" ? "LEFT_DIM" : "RELATION_SUMMARY_INCOMPLETE");
      continue;
    }
    if (/PRODUCER_WRITE|WRITE_OBSERVATION/i.test(gap)) {
      reasons.add("NO_PRODUCER_BRIDGE");
      continue;
    }
    if (/TERMINAL|BOUNDARY|UNBOUND|BLOCKED|COVERAGE/i.test(gap)) {
      reasons.add("COVERAGE_BOUNDARY");
      continue;
    }
  }

  if (reasons.size === 0 && branch) {
    reasons.add(classifyPrunedReason(branch, assessment));
  }
  if (reasons.size === 0) reasons.add("UNCLASSIFIED");
  return [...reasons].sort((left, right) => left.localeCompare(right));
}

function collectPrunedReasons(
  pruned: readonly TargetTableAssessment[],
  branchById: ReadonlyMap<string, CandidateBranch>,
): readonly PrunedReason[] {
  const grouped = new Map<PrunedReasonCode, { count: number; samples: { taskId: string | null; table: string | null }[]; seen: Set<string> }>();
  for (const assessment of pruned) {
    const branch = branchById.get(assessment.candidateBranchId);
    if (!branch) continue;
    const reasonCode = classifyPrunedReason(branch, assessment);
    const current = grouped.get(reasonCode) ?? { count: 0, samples: [], seen: new Set<string>() };
    current.count += 1;
    const sample = { taskId: branch.producerTaskId, table: branch.table?.qualifiedName ?? null };
    const sampleKey = `${sample.taskId ?? ""}\0${sample.table ?? ""}`;
    if (!current.seen.has(sampleKey) && current.samples.length < PRUNED_SAMPLE_LIMIT) {
      current.seen.add(sampleKey);
      current.samples.push(sample);
    }
    grouped.set(reasonCode, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reasonCode, value]) => ({
      reasonCode,
      count: value.count,
      samples: [...value.samples].sort((left, right) =>
        (left.taskId ?? "").localeCompare(right.taskId ?? "") || (left.table ?? "").localeCompare(right.table ?? ""),
      ),
    }));
}

function mergeShrinkEntries(
  entries: readonly ShrinkReportEntry[],
  grain: "table" | "join" = "table",
): readonly ShrinkReportEntry[] {
  const merged = new Map<string, ShrinkReportEntry>();
  for (const entry of entries) {
    const key = grain === "join"
      ? `${entry.taskId}\0${entry.table ?? ""}\0${entry.joinNode ?? ""}`
      : `${entry.taskId}\0${entry.table ?? ""}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, entry);
      continue;
    }
    merged.set(key, {
      ...current,
      viaFields: unique([...current.viaFields, ...entry.viaFields]),
      witness: unique([...current.witness, ...entry.witness]),
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.taskId.localeCompare(right.taskId)
    || (left.table ?? "").localeCompare(right.table ?? "")
    || (left.joinNode ?? "").localeCompare(right.joinNode ?? ""),
  );
}
