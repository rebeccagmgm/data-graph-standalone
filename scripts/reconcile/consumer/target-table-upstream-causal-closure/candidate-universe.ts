import { canonicalJson, sha256 } from "../../../machine-facts/machine-facts-contract.ts";
import {
  projectCandidateUniverse as projectLegacyCandidateUniverse,
  type CandidatePhysicalTable,
  type CandidateUniverse,
} from "../target-field-causal-slice/candidate-universe.ts";
import type { TargetWriteRef } from "./target-write-contract.ts";

export type {
  CandidateBranch,
  CandidateBranchKind,
  CandidateContinuation,
  CandidatePhysicalTable,
  CandidateUniverse,
  CandidateUniverseStatus,
  CandidateWriteScope,
} from "../target-field-causal-slice/candidate-universe.ts";

function targetBranchId(targetWrite: TargetWriteRef, table: CandidatePhysicalTable): string {
  return `target-table-root-write:${sha256(canonicalJson({
    targetWriteId: targetWrite.identity.targetWriteId,
    branchKind: "ROOT_WRITE",
    table: { platform: table.platform, dataSource: table.dataSource, qualifiedName: table.qualifiedName, stableTableId: table.stableTableId },
  }))}`;
}

/** Project the existing table artifact once; this consumer never builds a field matrix. */
export function projectTargetTableCandidateUniverse(input: {
  readonly targetWrite: TargetWriteRef;
  readonly tableArtifact: unknown;
  readonly targetTable: CandidatePhysicalTable;
  readonly resolvePhysicalTable?: (table: CandidatePhysicalTable) => CandidatePhysicalTable | null;
}): CandidateUniverse {
  const projected = projectLegacyCandidateUniverse({
    rootTargetFields: [],
    tableArtifact: input.tableArtifact,
    rootWriteObservationIds: [input.targetWrite.identity.writeObservationId],
    resolvePhysicalTable: input.resolvePhysicalTable,
  });
  const branches = projected.branches.map((branch) => branch.branchKind === "ROOT_WRITE"
    ? {
        ...branch,
        candidateBranchId: targetBranchId(input.targetWrite, input.targetTable),
        table: input.targetTable,
        writeObservationId: input.targetWrite.identity.writeObservationId,
        evidenceRefs: input.targetWrite.identity.evidenceRefs.map((ref) => ({
          evidenceRefId: `target-write-evidence:${sha256(ref)}`,
          source: "TARGET_WRITE",
          locator: ref,
        })),
      }
    : branch.branchKind === "PHYSICAL_PRODUCER" && branch.readOccurrence
      ? {
          ...branch,
          evidenceRefs: [
            ...branch.evidenceRefs,
            {
              evidenceRefId: `candidate-bridge-evidence:${sha256(canonicalJson({
                consumerTaskId: branch.consumerTaskId,
                producerTaskId: branch.producerTaskId,
                occurrence: branch.readOccurrence,
              }))}`,
              source: "TABLE_MULTI_HOP_PRODUCER_BRIDGE",
              locator: `producer-bridge:${branch.consumerTaskId ?? "unknown"}:${branch.producerTaskId ?? "unknown"}:${branch.readOccurrence.occurrenceId}`,
            },
          ],
        }
      : branch);
  return {
    ...projected,
    branches: [...new Map(branches.map((branch) => [branch.candidateBranchId, branch])).values()].sort((left, right) => left.candidateBranchId.localeCompare(right.candidateBranchId)),
  };
}
