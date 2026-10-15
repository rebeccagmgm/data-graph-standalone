import type { CandidateBranch, CandidateUniverse } from "../target-field-causal-slice/candidate-universe.ts";
import type { CandidateWriteScope } from "../target-field-causal-slice/candidate-universe.ts";
import { canonicalJson } from "../../../machine-facts/machine-facts-contract.ts";
import {
  canonicalAssessment,
  type ChannelAssessment,
  type TargetTableAssessment,
  type UpstreamTaskRollup,
} from "./artifact-contract.ts";
import { buildImpactGraph, type GlobalImpactGraph } from "./impact-graph.ts";
import type { FieldValueEvidenceProvider } from "./field-value-provider.ts";
import {
  CAUSAL_IMPACT_CHANNELS,
  localChannelAssessments,
  rollupAssessments,
} from "./static-assessment.ts";
import {
  canonicalSqlSourceId,
  summaryForOccurrence,
  type LocalTransferKind,
  type ImpactChannel,
  type TaskRelationSummary,
} from "./task-relation-summary.ts";

export type PathCertainty = "CONFIRMED" | "CONDITIONAL" | "UNKNOWN";

/** State carried from one exact producer write to its upstream inputs. */
export interface PropagationState {
  readonly taskId: string;
  readonly writeObservationId: string;
  readonly sqlSourceId: string;
  readonly statementOrdinal: number;
  readonly rootRelationId: string;
  readonly channel: ImpactChannel;
  readonly certainty: PathCertainty;
  readonly evidenceRefs: readonly string[];
  readonly gapRefs: readonly string[];
  readonly witnessPredecessor: string | null;
  readonly witnessDepth: number;
  readonly localTransferKinds: readonly LocalTransferKind[];
  readonly demandedFieldNames: readonly string[];
  readonly outputFieldBindingIds?: readonly string[];
  readonly affectedTargetFields?: readonly string[];
}

export interface PropagationBudget {
  readonly deadlineAt?: number;
  readonly maxStateUpdates?: number;
  readonly maxNodeStates?: number;
  readonly maxWitnessDepth?: number;
}

export interface ImpactGraph extends GlobalImpactGraph {
  readonly reachableTaskIds: readonly string[];
  readonly reachableBranchIds: readonly string[];
  readonly branchEdges: readonly { readonly branchId: string; readonly consumerTaskId: string; readonly producerTaskId: string | null }[];
}

export interface CausalClosureResult {
  readonly graph: ImpactGraph;
  readonly assessments: readonly TargetTableAssessment[];
  readonly taskRollup: readonly UpstreamTaskRollup[];
  readonly minimumCertainTaskIds: readonly string[];
  readonly conservativeSafetyTaskIds: readonly string[];
  readonly gaps: readonly { readonly gapId: string; readonly reasonCode: string; readonly message: string; readonly evidenceRefs: readonly string[] }[];
  /** Post-run invariant: a non-zero value means a propagated branch escaped its write scope. */
  readonly writeScopeLeakCount: number;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function certaintyRank(value: PathCertainty): number {
  return value === "CONFIRMED" ? 3 : value === "CONDITIONAL" ? 2 : 1;
}

/** Compose certainty along one path: an unknown required hop cannot be hidden. */
export function composePath(left: PathCertainty, right: PathCertainty): PathCertainty {
  if (left === "UNKNOWN" || right === "UNKNOWN") return "UNKNOWN";
  if (left === "CONDITIONAL" || right === "CONDITIONAL") return "CONDITIONAL";
  return "CONFIRMED";
}

/** Merge alternatives in one channel: the strongest witness wins, gaps remain visible. */
export function mergeAlternative(left: PathCertainty, right: PathCertainty): PathCertainty {
  return certaintyRank(left) >= certaintyRank(right) ? left : right;
}

function stateKey(state: Pick<PropagationState, "taskId" | "writeObservationId" | "sqlSourceId" | "statementOrdinal" | "rootRelationId" | "channel">): string {
  return canonicalJson({
    taskId: state.taskId,
    writeObservationId: state.writeObservationId,
    sqlSourceId: state.sqlSourceId,
    statementOrdinal: state.statementOrdinal,
    rootRelationId: state.rootRelationId,
    channel: state.channel,
  });
}

function nodeKey(scope: WriteScope): string {
  return canonicalJson(scope);
}

export interface WriteScope extends CandidateWriteScope {
  readonly taskId: string;
  readonly writeObservationId: string;
}

function branchEvidenceRefs(branch: CandidateBranch): readonly string[] {
  return branch.evidenceRefs.map((ref) => ref.evidenceRefId);
}

function mergeState(left: PropagationState, right: PropagationState): PropagationState {
  const certainty = mergeAlternative(left.certainty, right.certainty);
  const preferred = certaintyRank(left.certainty) >= certaintyRank(right.certainty) ? left : right;
  return {
    ...preferred,
    taskId: preferred.taskId,
    certainty,
    evidenceRefs: unique([...left.evidenceRefs, ...right.evidenceRefs]),
    gapRefs: unique([...left.gapRefs, ...right.gapRefs]),
    localTransferKinds: unique([...left.localTransferKinds, ...right.localTransferKinds]) as LocalTransferKind[],
    demandedFieldNames: unique([...left.demandedFieldNames, ...right.demandedFieldNames]),
    outputFieldBindingIds: unique([...(left.outputFieldBindingIds ?? []), ...(right.outputFieldBindingIds ?? [])]),
    affectedTargetFields: unique([...(left.affectedTargetFields ?? []), ...(right.affectedTargetFields ?? [])]),
  };
}

function sameState(left: PropagationState, right: PropagationState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summaryForBranch(
  summaries: ReadonlyMap<string, TaskRelationSummary>,
  branch: CandidateBranch,
): TaskRelationSummary | undefined {
  const occurrence = branch.readOccurrence;
  if (!occurrence || !branch.consumerTaskId) return undefined;
  const rawSource = occurrence.sqlSourceId ?? occurrence.occurrenceId;
  if (!rawSource) return undefined;
  const source = canonicalSqlSourceId(rawSource);
  return summaryForOccurrence(summaries, branch.consumerTaskId, source, occurrence.statementIndex, occurrence.rootRelationId);
}

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined && left.trim().toLowerCase() === right.trim().toLowerCase();
}

const ROW_CONTROL_CHANNELS: ReadonlySet<ImpactChannel> = new Set([
  "ROW_MEMBERSHIP",
  "MULTIPLICITY",
  "EXPRESSION_CONTROL",
  "RELATION_EXISTENCE",
]);

function demandFieldsForChannel(summary: TaskRelationSummary | undefined, channel: ImpactChannel): readonly string[] {
  if (!summary) return [];
  return unique(summary.readImpacts
    .filter((impact) => impact.impactChannels.includes(channel))
    .flatMap((impact) => impact.demandedFieldNames ?? []));
}

function branchBelongsToWriteScope(
  branch: CandidateBranch,
  scope: WriteScope,
  summary: TaskRelationSummary | undefined,
): boolean {
  const occurrence = branch.readOccurrence;
  if (!occurrence || branch.consumerTaskId !== scope.taskId) return false;
  const source = canonicalSqlSourceId(occurrence.sqlSourceId ?? occurrence.occurrenceId);
  if (!sameText(source, scope.sqlSourceId) || occurrence.statementIndex !== scope.statementOrdinal) return false;
  if (occurrence.rootRelationId && !sameText(occurrence.rootRelationId, scope.rootRelationId)) return false;

  // A matching task/source/statement is not enough when a statement has
  // multiple write roots. Prefer an exact relation-subtree proof from the
  // normalized summary, and fall back to an occurrence path that explicitly
  // contains the root relation. Never treat a missing root as a wildcard.
  if (summary?.rootRelationId && sameText(summary.rootRelationId, scope.rootRelationId)) return true;
  return occurrence.relationPath.some((relationId) => sameText(relationId, scope.rootRelationId));
}

function scopeForBranch(branch: CandidateBranch): WriteScope | null {
  if (!branch.producerTaskId || !branch.writeObservationId || !branch.writeScope) return null;
  if (branch.gapRefs.some((gap) => /CONTINUATION_(?:READ_NOT_FOUND|PRODUCER_NOT_FOUND)/i.test(gap))) return null;
  if (!branch.continuation && branch.gapRefs.some((gap) => /PRODUCER_WRITE|WRITE_OBSERVATION|WRITE_SCOPE/i.test(gap))) return null;
  return {
    taskId: branch.producerTaskId,
    writeObservationId: branch.writeObservationId,
    sqlSourceId: branch.writeScope.sqlSourceId,
    statementOrdinal: branch.writeScope.statementOrdinal,
    rootRelationId: branch.writeScope.rootRelationId,
  };
}

function channelMap(values: readonly ChannelAssessment[]): ReadonlyMap<ImpactChannel, ChannelAssessment> {
  return new Map(values.map((value) => [value.channel, value]));
}

function propagatedChannelAssessment(state: PropagationState): ChannelAssessment {
  return {
    channel: state.channel,
    status: state.certainty,
    proofRefs: state.evidenceRefs,
    witnessRefs: state.evidenceRefs,
    gapRefs: state.gapRefs,
    localTransferKinds: state.localTransferKinds,
    demandedFieldNames: state.demandedFieldNames,
    ...(state.outputFieldBindingIds && state.outputFieldBindingIds.length > 0
      ? { outputFieldBindingIds: state.outputFieldBindingIds }
      : {}),
    ...(state.affectedTargetFields && state.affectedTargetFields.length > 0
      ? { affectedTargetFields: state.affectedTargetFields }
      : {}),
  };
}

function continuationCertainty(branch: CandidateBranch): PathCertainty | null {
  const continuation = branch.continuation;
  if (!continuation) return null;
  if (
    continuation.source === "IN_UNION_FINAL_WRITE"
    && continuation.partitionMatchStatus === "CONFIRMED"
    && continuation.evidenceLayer === "L1"
    && continuation.l1Eligible
  ) return "CONFIRMED";
  if (continuation.source === "IN_UNION_FINAL_WRITE" && continuation.partitionMatchStatus === "ASSUMED") return "CONDITIONAL";
  return "UNKNOWN";
}

function finalRelationStatus(channels: readonly ChannelAssessment[]): "CONFIRMED_RELATED" | "CONDITIONAL_RELATED" | "UNKNOWN" {
  if (channels.some((channel) => channel.status === "CONFIRMED")) return "CONFIRMED_RELATED";
  if (channels.some((channel) => channel.status === "CONDITIONAL")) return "CONDITIONAL_RELATED";
  return "UNKNOWN";
}

function finalAssessment(input: {
  readonly targetWriteId: string;
  readonly branch: CandidateBranch;
  readonly local: readonly ChannelAssessment[];
  readonly propagated: ReadonlyMap<ImpactChannel, PropagationState>;
  readonly reached: boolean;
  readonly propagationGaps?: readonly string[];
}): TargetTableAssessment {
  if (input.branch.branchKind === "ROOT_WRITE") {
    return canonicalAssessment({
      targetWriteId: input.targetWriteId,
      candidateBranchId: input.branch.candidateBranchId,
      relationStatus: "CONFIRMED_RELATED",
      channelAssessments: [],
      evidenceRefs: branchEvidenceRefs(input.branch),
      gapRefs: [],
      negativeProofs: [],
    });
  }
  const channels = new Map<ImpactChannel, ChannelAssessment>();
  for (const [channel, state] of input.propagated) channels.set(channel, propagatedChannelAssessment(state));
  const localFieldValue = input.local.find((channel) => channel.channel === "FIELD_VALUE");
  for (const local of input.local) {
    const prior = channels.get(local.channel);
    const leftDimMultiplicity = localFieldValue?.status === "NOT_APPLICABLE"
      && local.channel === "MULTIPLICITY"
      && local.status === "CONFIRMED";
    if (prior && !leftDimMultiplicity) continue;
    if (leftDimMultiplicity) {
      channels.set(local.channel, local);
      continue;
    }
    if (prior) continue;
    if (local.status === "NOT_APPLICABLE" && input.reached) {
      channels.set(local.channel, local);
      continue;
    }
    const gap = `causal-closure-gap:${input.branch.candidateBranchId}:${input.reached ? "NO_CLOSED_PATH" : "NOT_REACHED_FROM_ROOT"}`;
    channels.set(local.channel, {
      ...local,
      status: "UNKNOWN",
      gapRefs: unique([...local.gapRefs, gap, ...(input.propagationGaps ?? [])]),
    });
  }
  if (channels.size === 0 || [...channels.values()].every((channel) => channel.status === "NOT_APPLICABLE")) {
    const gap = `causal-closure-gap:${input.branch.candidateBranchId}:${input.reached ? "NO_CLOSED_CHANNEL" : "NOT_REACHED_FROM_ROOT"}`;
    channels.set("RELATION_EXISTENCE", {
      channel: "RELATION_EXISTENCE",
      status: "UNKNOWN",
      proofRefs: [],
      witnessRefs: [],
      gapRefs: unique([gap, ...(input.propagationGaps ?? [])]),
    });
  }
  const channelAssessments = [...channels.values()];
  const gapRefs = unique([
    ...input.branch.gapRefs,
    ...channelAssessments.flatMap((channel) => channel.gapRefs),
  ]);
  const evidenceRefs = unique([
    ...branchEvidenceRefs(input.branch),
    ...channelAssessments.flatMap((channel) => [...channel.proofRefs, ...channel.witnessRefs]),
  ]);
  return canonicalAssessment({
    targetWriteId: input.targetWriteId,
    candidateBranchId: input.branch.candidateBranchId,
    relationStatus: finalRelationStatus(channelAssessments),
    channelAssessments,
    evidenceRefs,
    gapRefs,
    negativeProofs: [],
  });
}

interface PropagationRun {
  readonly statesByBranch: ReadonlyMap<string, ReadonlyMap<ImpactChannel, PropagationState>>;
  readonly reachableTaskIds: readonly string[];
  readonly reachableBranchIds: readonly string[];
  readonly gaps: readonly string[];
  readonly writeScopeLeakCount: number;
}

function propagate(input: {
  readonly targetWriteId: string;
  readonly rootTaskId: string;
  readonly universe: CandidateUniverse;
  readonly summaries: ReadonlyMap<string, TaskRelationSummary>;
  readonly fieldValueProvider: FieldValueEvidenceProvider;
  readonly rootWriteScope?: WriteScope;
  readonly sameTaskUpstreamWrites?: ReadonlyMap<string, readonly WriteScope[]>;
  readonly budget?: PropagationBudget;
}): PropagationRun {
  const root = input.universe.branches.find((branch) => branch.branchKind === "ROOT_WRITE");
  const rootWriteObservationId = root?.writeObservationId ?? `target-write:${input.targetWriteId}`;
  const rootScope: WriteScope = input.rootWriteScope ?? {
    taskId: input.rootTaskId,
    writeObservationId: rootWriteObservationId,
    sqlSourceId: "unknown",
    statementOrdinal: -1,
    rootRelationId: "unknown",
  };
  const seedCertainty: PathCertainty = root && root.gapRefs.length > 0 ? "UNKNOWN" : "CONFIRMED";
  const seedEvidence = root ? branchEvidenceRefs(root) : [];
  const rootSummary = summaryForOccurrence(
    input.summaries,
    input.rootTaskId,
    rootScope.sqlSourceId,
    rootScope.statementOrdinal,
    rootScope.rootRelationId,
  );
  const nodeStates = new Map<string, Map<ImpactChannel, PropagationState>>();
  const pending: WriteScope[] = [];
  const rootStates = new Map<ImpactChannel, PropagationState>();
  for (const channel of CAUSAL_IMPACT_CHANNELS) {
    rootStates.set(channel, {
      taskId: rootScope.taskId,
      writeObservationId: rootScope.writeObservationId,
      sqlSourceId: rootScope.sqlSourceId,
      statementOrdinal: rootScope.statementOrdinal,
      rootRelationId: rootScope.rootRelationId,
      channel,
      certainty: seedCertainty,
      evidenceRefs: seedEvidence,
      gapRefs: root?.gapRefs ?? [],
      witnessPredecessor: null,
      witnessDepth: 0,
      localTransferKinds: [],
      demandedFieldNames: demandFieldsForChannel(rootSummary, channel),
    });
  }
  const rootNodeKey = nodeKey(rootScope);
  nodeStates.set(rootNodeKey, rootStates);
  pending.push(rootScope);

  const localByBranch = new Map<string, readonly ChannelAssessment[]>();
  for (const branch of input.universe.branches) {
    if (branch.branchKind === "ROOT_WRITE") continue;
    localByBranch.set(branch.candidateBranchId, localChannelAssessments({
      branch,
      summary: summaryForBranch(input.summaries, branch),
      fieldValueProvider: input.fieldValueProvider,
    }));
  }
  const statesByBranch = new Map<string, Map<ImpactChannel, PropagationState>>();
  const branchesByReadScope = new Map<string, CandidateBranch[]>();
  for (const branch of input.universe.branches) {
    if (branch.branchKind === "ROOT_WRITE" || !branch.consumerTaskId) continue;
    if (!branch.readOccurrence) continue;
    const source = canonicalSqlSourceId(branch.readOccurrence.sqlSourceId ?? branch.readOccurrence.occurrenceId);
    const key = `${branch.consumerTaskId}|${source}|${branch.readOccurrence.statementIndex}`;
    const values = branchesByReadScope.get(key) ?? [];
    values.push(branch);
    branchesByReadScope.set(key, values);
  }
  const reachableTasks = new Set<string>([input.rootTaskId]);
  const reachableBranches = new Set<string>(root ? [root.candidateBranchId] : []);
  const propagationGaps = new Set<string>();
  const matchedConsumerScopes = new Map<string, Map<string, WriteScope>>();
  const maxStateUpdates = input.budget?.maxStateUpdates ?? 100_000;
  const maxNodeStates = input.budget?.maxNodeStates ?? 50_000;
  const maxWitnessDepth = input.budget?.maxWitnessDepth ?? 25;
  let stateUpdates = 0;
  let stopped = false;
  const budgetGap = (kind: string): string => {
    const gap = `causal-closure-gap:PROPAGATION_BUDGET:${kind}`;
    propagationGaps.add(gap);
    stopped = true;
    return gap;
  };
  const deadlineReached = (): boolean => input.budget?.deadlineAt !== undefined && performance.now() >= input.budget.deadlineAt;
  const stateUpdateAllowed = (): boolean => {
    if (deadlineReached()) return false;
    if (stateUpdates >= maxStateUpdates) return false;
    stateUpdates += 1;
    return true;
  };
  const mergeBranchState = (branch: CandidateBranch, next: PropagationState): void => {
    const branchStates = statesByBranch.get(branch.candidateBranchId) ?? new Map<ImpactChannel, PropagationState>();
    const prior = branchStates.get(next.channel);
    branchStates.set(next.channel, prior ? mergeState(prior, next) : next);
    statesByBranch.set(branch.candidateBranchId, branchStates);
  };
  while (pending.length > 0 && !stopped) {
    if (deadlineReached()) {
      budgetGap("DEADLINE");
      break;
    }
    const currentScope = pending.shift()!;
    const currentKey = nodeKey(currentScope);
    const currentStates = nodeStates.get(currentKey);
    if (!currentStates) continue;
    for (const upstream of input.sameTaskUpstreamWrites?.get(`${currentScope.taskId}|${currentScope.writeObservationId}`) ?? []) {
      const upKey = nodeKey(upstream);
      if (!nodeStates.has(upKey) && nodeStates.size >= maxNodeStates) {
        budgetGap("MAX_NODE_STATES");
        break;
      }
      const upStates = nodeStates.get(upKey) ?? new Map<ImpactChannel, PropagationState>();
      let changed = false;
      for (const state of currentStates.values()) {
        const scoped: PropagationState = {
          ...state,
          taskId: upstream.taskId,
          writeObservationId: upstream.writeObservationId,
          sqlSourceId: upstream.sqlSourceId,
          statementOrdinal: upstream.statementOrdinal,
          rootRelationId: upstream.rootRelationId,
        };
        const prior = upStates.get(scoped.channel);
        const merged = prior ? mergeState(prior, scoped) : scoped;
        upStates.set(scoped.channel, merged);
        if (!prior || !sameState(prior, merged)) changed = true;
      }
      nodeStates.set(upKey, upStates);
      if (changed) pending.push(upstream);
    }
    const readScopeKey = `${currentScope.taskId}|${canonicalSqlSourceId(currentScope.sqlSourceId)}|${currentScope.statementOrdinal}`;
    for (const branch of branchesByReadScope.get(readScopeKey) ?? []) {
      if (stopped) break;
      const branchSummary = summaryForBranch(input.summaries, branch);
      if (!branchBelongsToWriteScope(branch, currentScope, branchSummary)) continue;
      const matchedScopes = matchedConsumerScopes.get(branch.candidateBranchId) ?? new Map<string, WriteScope>();
      matchedScopes.set(nodeKey(currentScope), currentScope);
      matchedConsumerScopes.set(branch.candidateBranchId, matchedScopes);
      const local = channelMap(localByBranch.get(branch.candidateBranchId) ?? []);
      const emit = (
        targetChannel: ImpactChannel,
        localValue: ChannelAssessment,
        transferKinds: readonly LocalTransferKind[],
        demandedFields: readonly string[],
        downstreamOverride?: PropagationState,
      ): void => {
        const downstream = downstreamOverride ?? currentStates.get(targetChannel);
        if (!downstream || localValue.status === "NOT_APPLICABLE") return;
        const producerScope = scopeForBranch(branch);
        const unresolvedWrite = producerScope === null;
        const nextDepth = downstream.witnessDepth + 1;
        const depthExceeded = nextDepth > maxWitnessDepth;
        const common = {
          taskId: producerScope?.taskId ?? branch.producerTaskId ?? "unknown",
          writeObservationId: producerScope?.writeObservationId ?? `unresolved:${branch.candidateBranchId}`,
          sqlSourceId: producerScope?.sqlSourceId ?? currentScope.sqlSourceId,
          statementOrdinal: producerScope?.statementOrdinal ?? currentScope.statementOrdinal,
          rootRelationId: producerScope?.rootRelationId ?? currentScope.rootRelationId,
          channel: targetChannel,
          evidenceRefs: unique([
            ...downstream.evidenceRefs,
            ...localValue.proofRefs,
            ...localValue.witnessRefs,
            ...branchEvidenceRefs(branch),
          ]),
          witnessPredecessor: stateKey(downstream),
          witnessDepth: nextDepth,
          localTransferKinds: unique([...downstream.localTransferKinds, ...transferKinds]) as LocalTransferKind[],
          demandedFieldNames: unique(demandedFields),
          outputFieldBindingIds: localValue.outputFieldBindingIds,
          affectedTargetFields: localValue.affectedTargetFields,
        };
        const continuationPath = continuationCertainty(branch);
        const localCertainty = continuationPath === null
          ? localValue.status as PathCertainty
          : composePath(localValue.status as PathCertainty, continuationPath);
        const next: PropagationState = {
          ...common,
          certainty: unresolvedWrite || depthExceeded
            ? "UNKNOWN"
            : composePath(downstream.certainty, localCertainty),
          gapRefs: unique([
            ...downstream.gapRefs,
            ...localValue.gapRefs,
            ...branch.gapRefs,
            ...(unresolvedWrite ? [`bridge-gap:${branch.candidateBranchId}:PRODUCER_WRITE_SCOPE_UNRESOLVED`] : []),
            ...(depthExceeded ? [`causal-closure-gap:${branch.candidateBranchId}:WITNESS_DEPTH`] : []),
          ]),
        };
        if (!stateUpdateAllowed()) {
          const gap = budgetGap(deadlineReached() ? "DEADLINE" : "MAX_STATE_UPDATES");
          mergeBranchState(branch, { ...next, certainty: "UNKNOWN", gapRefs: unique([...next.gapRefs, gap]) });
          return;
        }
        if (!branch.producerTaskId || unresolvedWrite || depthExceeded) {
          mergeBranchState(branch, next);
          reachableBranches.add(branch.candidateBranchId);
          return;
        }
        const nextScope = producerScope!;
        const producerKey = nodeKey(nextScope);
        const existingProducerStates = nodeStates.get(producerKey);
        if (!existingProducerStates && nodeStates.size >= maxNodeStates) {
          mergeBranchState(branch, { ...next, certainty: "UNKNOWN", gapRefs: unique([...next.gapRefs, budgetGap("MAX_NODE_STATES")]) });
          return;
        }
        mergeBranchState(branch, next);
        reachableBranches.add(branch.candidateBranchId);
        const producerStates = existingProducerStates ?? new Map<ImpactChannel, PropagationState>();
        const prior = producerStates.get(targetChannel);
        const merged = prior ? mergeState(prior, next) : next;
        producerStates.set(targetChannel, merged);
        nodeStates.set(producerKey, producerStates);
        reachableTasks.add(branch.producerTaskId);
        if (!prior || !sameState(prior, merged)) pending.push(nextScope);
      };
      const valueCarrier = currentStates.get("FIELD_VALUE");
      const recalledAsValue = valueCarrier !== undefined && currentScope.taskId !== input.rootTaskId;
      const localControl = local.get("EXPRESSION_CONTROL");
      const zipperControl = localControl !== undefined && localControl.status !== "NOT_APPLICABLE";
      for (const channel of CAUSAL_IMPACT_CHANNELS) {
        const localValue = local.get(channel);
        if (!localValue || localValue.status === "NOT_APPLICABLE") continue;
        const demanded = localValue.demandedFieldNames ?? currentStates.get(channel)?.demandedFieldNames ?? [];
        const transfer = localValue.localTransferKinds ?? ["RELATION_OPERATOR"];
        if (currentStates.get(channel)) {
          if (channel === "ROW_MEMBERSHIP" && recalledAsValue) {
            if (!zipperControl || !valueCarrier) continue;
            emit(channel, localValue, transfer, demanded, valueCarrier);
            continue;
          }
          emit(channel, localValue, transfer, demanded);
          continue;
        }
        if (valueCarrier && ROW_CONTROL_CHANNELS.has(channel)) {
          if (channel === "MULTIPLICITY" || channel === "RELATION_EXISTENCE") continue;
          if (channel === "ROW_MEMBERSHIP" && !zipperControl) continue;
          emit(channel, localValue, transfer, demanded, valueCarrier);
        }
      }
      const fieldValue = local.get("FIELD_VALUE");
      if (fieldValue && fieldValue.status !== "NOT_APPLICABLE") {
        for (const targetChannel of ["ROW_MEMBERSHIP", "MULTIPLICITY"] as const) {
          const downstream = currentStates.get(targetChannel);
          const demanded = downstream?.demandedFieldNames ?? [];
          const outputs = fieldValue.affectedTargetFields ?? [];
          const matched = outputs.filter((output) => demanded.some((field) => sameText(output, field)));
          if (!downstream || matched.length === 0) continue;
          if (targetChannel === "ROW_MEMBERSHIP" && recalledAsValue && !zipperControl) continue;
          emit(targetChannel, fieldValue, ["VALUE_FLOW"], matched);
        }
      }
    }
  }
  let writeScopeLeakCount = 0;
  for (const [branchId, branchStates] of statesByBranch) {
    const branch = input.universe.branches.find((candidate) => candidate.candidateBranchId === branchId);
    if (!branch) continue;
    const matchedScopes = matchedConsumerScopes.get(branchId);
    if (!matchedScopes || [...matchedScopes.values()].some((scope) => !branchBelongsToWriteScope(branch, scope, summaryForBranch(input.summaries, branch)))) {
      writeScopeLeakCount += 1;
      continue;
    }
    const producerScope = scopeForBranch(branch);
    if (producerScope && [...branchStates.values()].some((state) =>
      state.taskId !== producerScope.taskId ||
      state.writeObservationId !== producerScope.writeObservationId ||
      state.sqlSourceId !== producerScope.sqlSourceId ||
      state.statementOrdinal !== producerScope.statementOrdinal ||
      state.rootRelationId !== producerScope.rootRelationId)) {
      writeScopeLeakCount += 1;
    }
  }
  return {
    statesByBranch,
    reachableTaskIds: unique([...reachableTasks]),
    reachableBranchIds: unique([...reachableBranches]),
    gaps: unique([...propagationGaps]),
    writeScopeLeakCount,
  };
}

/** Build the target-rooted multi-hop closure using monotone channel states. */
export function buildCausalClosure(input: {
  readonly targetWriteId: string;
  readonly rootTaskId: string;
  readonly universe: CandidateUniverse;
  readonly summaries: ReadonlyMap<string, TaskRelationSummary>;
  readonly fieldValueProvider: FieldValueEvidenceProvider;
  readonly baseGraph?: GlobalImpactGraph;
  readonly rootWriteScope?: WriteScope;
  readonly sameTaskUpstreamWrites?: ReadonlyMap<string, readonly WriteScope[]>;
  readonly budget?: PropagationBudget;
}): CausalClosureResult {
  const base = input.baseGraph ?? buildImpactGraph(input.universe.branches, input.summaries);
  const propagated = propagate(input);
  const graph: ImpactGraph = {
    ...base,
    reachableTaskIds: propagated.reachableTaskIds,
    reachableBranchIds: propagated.reachableBranchIds,
    branchEdges: input.universe.branches
      .filter((branch) => branch.branchKind !== "ROOT_WRITE" && propagated.reachableBranchIds.includes(branch.candidateBranchId) && branch.consumerTaskId !== null)
      .map((branch) => ({ branchId: branch.candidateBranchId, consumerTaskId: branch.consumerTaskId!, producerTaskId: branch.producerTaskId }))
      .sort((left, right) => left.branchId.localeCompare(right.branchId)),
  };
  const assessments = input.universe.branches.map((branch) => {
    const local = branch.branchKind === "ROOT_WRITE" ? [] : localChannelAssessments({
      branch,
      summary: summaryForBranch(input.summaries, branch),
      fieldValueProvider: input.fieldValueProvider,
    });
    const states = propagated.statesByBranch.get(branch.candidateBranchId) ?? new Map<ImpactChannel, PropagationState>();
    return finalAssessment({
      targetWriteId: input.targetWriteId,
      branch,
      local,
      propagated: states,
      reached: propagated.reachableBranchIds.includes(branch.candidateBranchId),
      propagationGaps: propagated.gaps,
    });
  });
  const rollup = rollupAssessments({ branches: input.universe.branches, assessments });
  const gaps = unique([...propagated.gaps, ...assessments.flatMap((assessment) => assessment.gapRefs)]).map((gapId) => ({
    gapId,
    reasonCode: gapId.includes("causal-closure-gap") ? "CAUSAL_CLOSURE_BOUNDARY" : "CAUSAL_EVIDENCE_INCOMPLETE",
    message: `causal closure could not close ${gapId}`,
    evidenceRefs: assessments.find((assessment) => assessment.gapRefs.includes(gapId))?.evidenceRefs ?? [],
  }));
  return {
    graph,
    assessments,
    taskRollup: rollup.taskRollup,
    minimumCertainTaskIds: rollup.minimumCertainTaskIds,
    conservativeSafetyTaskIds: rollup.conservativeSafetyTaskIds,
    gaps,
    writeScopeLeakCount: propagated.writeScopeLeakCount,
  };
}
