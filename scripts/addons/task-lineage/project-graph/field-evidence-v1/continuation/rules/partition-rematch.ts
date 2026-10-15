import { stableId } from "../../../../../../project-graph/task-local/ids.ts";
import type { FieldImpactGap } from "../../impact-result-contract.ts";
import type { ContinuationPorts } from "../ports.ts";
import type { ContinuationCandidate } from "../types.ts";

export const PARTITION_REMATCH_RULE_ID = "PARTITION_REMATCH" as const;

export function applyPartitionRematch(input: {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly column: string;
  readonly qualifiedName: string;
  readonly candidates: readonly ContinuationCandidate[];
  readonly ports: ContinuationPorts;
}): {
  readonly candidates: readonly ContinuationCandidate[];
  readonly gaps: readonly FieldImpactGap[];
} {
  const gaps: FieldImpactGap[] = [];
  if (!input.ports.writerCatalog) {
    gaps.push({
      gapId: stableId("gap", {
        reasonCode: "WRITER_CATALOG_UNAVAILABLE",
        consumerTaskId: input.consumerTaskId,
        readOccurrenceId: input.readOccurrenceId,
        column: input.column,
      }),
      reasonCode: "WRITER_CATALOG_UNAVAILABLE",
      details: {
        consumerTaskId: input.consumerTaskId,
        readOccurrenceId: input.readOccurrenceId,
        column: input.column,
      },
    });
    return { candidates: input.candidates, gaps };
  }

  const readScopeResult = input.ports.readScopeFor({
    consumerTaskId: input.consumerTaskId,
    readOccurrenceId: input.readOccurrenceId,
    qualifiedName: input.qualifiedName,
  });
  if (readScopeResult.kind === "UNAVAILABLE") {
    gaps.push({
      gapId: stableId("gap", {
        reasonCode: readScopeResult.reasonCode,
        consumerTaskId: input.consumerTaskId,
        readOccurrenceId: input.readOccurrenceId,
        column: input.column,
      }),
      reasonCode: readScopeResult.reasonCode,
      details: {
        consumerTaskId: input.consumerTaskId,
        readOccurrenceId: input.readOccurrenceId,
        column: input.column,
      },
    });
    return { candidates: input.candidates, gaps };
  }

  // Writer catalog v1 does not carry partition evidence; keep candidates unchanged.
  return { candidates: input.candidates, gaps };
}
