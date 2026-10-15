import type { CandidateBranch } from "../target-field-causal-slice/candidate-universe.ts";
import type { TaskRelationSummary } from "./task-relation-summary.ts";

export interface GlobalImpactGraph {
  readonly taskIds: readonly string[];
  readonly branchIds: readonly string[];
  readonly localEdges: readonly { readonly taskId: string; readonly sqlSourceId: string; readonly statementIndex: number; readonly readOccurrenceId: string; readonly channels: readonly string[] }[];
  readonly bridgeEdges: readonly { readonly candidateBranchId: string; readonly consumerTaskId: string; readonly producerTaskId: string | null; readonly readOccurrenceId: string | null }[];
}
export function buildImpactGraph(
  branches: readonly CandidateBranch[],
  summaries: ReadonlyMap<string, TaskRelationSummary>,
): GlobalImpactGraph {
  const localEdges = [...summaries.values()].flatMap((summary) => summary.readImpacts.map((impact) => ({
    taskId: summary.taskId,
    sqlSourceId: summary.sqlSourceId,
    statementIndex: summary.statementIndex,
    readOccurrenceId: impact.readOccurrenceId,
    channels: impact.impactChannels,
  }))).filter((edge, index, values) => values.findIndex((candidate) => `${candidate.taskId}|${candidate.sqlSourceId}|${candidate.statementIndex}|${candidate.readOccurrenceId}` === `${edge.taskId}|${edge.sqlSourceId}|${edge.statementIndex}|${edge.readOccurrenceId}`) === index).sort((a, b) => `${a.taskId}|${a.sqlSourceId}|${a.statementIndex}|${a.readOccurrenceId}`.localeCompare(`${b.taskId}|${b.sqlSourceId}|${b.statementIndex}|${b.readOccurrenceId}`));
  const bridgeEdges = branches.filter((branch) => branch.branchKind !== "ROOT_WRITE").map((branch) => ({
    candidateBranchId: branch.candidateBranchId,
    consumerTaskId: branch.consumerTaskId ?? "",
    producerTaskId: branch.producerTaskId,
    readOccurrenceId: branch.readOccurrence?.readRelationId ?? branch.readOccurrence?.occurrenceId ?? null,
  })).sort((a, b) => a.candidateBranchId.localeCompare(b.candidateBranchId));
  return {
    taskIds: [...new Set([[...summaries.values()].map((summary) => summary.taskId), ...branches.flatMap((branch) => [branch.consumerTaskId, branch.producerTaskId].filter((value): value is string => value !== null))].flat())].sort(),
    branchIds: bridgeEdges.map((edge) => edge.candidateBranchId),
    localEdges,
    bridgeEdges,
  };
}
