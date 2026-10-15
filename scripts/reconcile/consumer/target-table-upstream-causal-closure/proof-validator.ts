import type { CandidateUniverse } from "../target-field-causal-slice/candidate-universe.ts";
import { createNegativeProof, type NegativeProof, type TargetTableAssessment } from "./artifact-contract.ts";

export interface CausalClosureValidation { readonly valid: boolean; readonly errors: readonly string[]; }

function sorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function validNegativeProof(
  proof: NegativeProof,
  assessment: TargetTableAssessment,
  universe: CandidateUniverse,
): boolean {
  const branch = universe.branches.find((candidate) => candidate.candidateBranchId === assessment.candidateBranchId);
  if (!branch || proof.targetWriteId !== assessment.targetWriteId || proof.candidateBranchId !== branch.candidateBranchId || proof.universeStatus !== "COMPLETE_OBSERVED_EVIDENCE") return false;
  const expected = createNegativeProof({
    kind: proof.kind,
    targetWriteId: proof.targetWriteId,
    candidateBranchId: proof.candidateBranchId,
    universeStatus: proof.universeStatus,
    closedChannels: proof.closedChannels,
    premiseRefs: proof.premiseRefs,
    cut: proof.cut,
  });
  if (proof.proofId !== expected.proofId || proof.kind !== "COMPLETE_UNIVERSE_NO_CAUSAL_PATH") return false;
  const applicable = assessment.channelAssessments.filter((channel) => channel.status === "PROVEN_ABSENT" || channel.status === "NOT_APPLICABLE");
  if (assessment.channelAssessments.some((channel) => !["PROVEN_ABSENT", "NOT_APPLICABLE"].includes(channel.status))) return false;
  if (proof.closedChannels.length !== applicable.length || proof.closedChannels.some((channel) => !applicable.some((candidate) => candidate.channel === channel.channel && candidate.status === channel.status && sameValues(candidate.proofRefs, channel.proofRefs)))) return false;
  const allowedPremises = [
    ...branch.evidenceRefs.map((ref) => ref.evidenceRefId),
    ...assessment.channelAssessments.flatMap((channel) => [...channel.proofRefs, ...channel.witnessRefs]),
  ];
  if (proof.premiseRefs.length === 0 || proof.premiseRefs.some((ref) => !allowedPremises.includes(ref))) return false;
  return proof.cut.kind === "CANDIDATE_BRANCH_NO_REACHABLE_CAUSAL_EDGE" &&
    proof.cut.rootTaskId === branch.rootTaskId &&
    proof.cut.consumerTaskId === branch.consumerTaskId &&
    proof.cut.producerTaskId === branch.producerTaskId &&
    proof.cut.readOccurrenceId === (branch.readOccurrence?.readRelationId ?? branch.readOccurrence?.occurrenceId ?? null);
}

export function validateCausalClosure(input: { readonly targetWriteId: string; readonly universe: CandidateUniverse; readonly assessments: readonly TargetTableAssessment[] }): CausalClosureValidation {
  const errors: string[] = [];
  const expected = new Set(input.universe.branches.map((branch) => `${input.targetWriteId}|${branch.candidateBranchId}`));
  const seen = new Set<string>();
  for (const assessment of input.assessments) {
    const key = `${assessment.targetWriteId}|${assessment.candidateBranchId}`;
    if (seen.has(key)) errors.push(`DUPLICATE_ASSESSMENT:${key}`);
    seen.add(key);
    if (!expected.has(key)) errors.push(`UNEXPECTED_ASSESSMENT:${key}`);
    // Negative closure is deliberately disabled for this propagation phase.
    // A complete observed universe without an explicit, future-approved cut
    // is still UNKNOWN; do not let legacy artifacts turn absence into proof.
    if (assessment.relationStatus === "PROVEN_UNRELATED") errors.push(`PROVEN_UNRELATED_DISABLED:${assessment.candidateBranchId}`);
    if (assessment.negativeProofs.length > 0) errors.push(`NEGATIVE_PROOF_DISABLED:${assessment.candidateBranchId}`);
    if (assessment.relationStatus === "UNKNOWN" && assessment.gapRefs.length === 0) errors.push(`UNKNOWN_WITHOUT_GAP:${assessment.candidateBranchId}`);
  }
  for (const key of expected) if (!seen.has(key)) errors.push(`MISSING_ASSESSMENT:${key}`);
  return { valid: errors.length === 0, errors: errors.sort() };
}
