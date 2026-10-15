import { isNoSqlTaskCategory } from "../../reconcile/shared/lineage-scope.ts";
import type {
  TaskLocalCoverageStatus,
  TaskLocalFailureReasonCode,
} from "./contract.ts";

/** How this task should be read in graph coverage summaries — not a projection failure by itself. */
export type CoverageDisposition =
  | "DATA_LINEAGE"
  | "EXPECTED_SCHEDULE_REFERENCE"
  | "MATERIAL_GAP";

export function resolveCoverageDisposition(input: {
  readonly taskCategory: string | null | undefined;
  readonly coverageStatus: TaskLocalCoverageStatus;
}): CoverageDisposition {
  if (input.coverageStatus === "PROJECTED") return "DATA_LINEAGE";
  if (isNoSqlTaskCategory(input.taskCategory)) return "EXPECTED_SCHEDULE_REFERENCE";
  return "MATERIAL_GAP";
}

export interface CoverageDispositionSummary {
  readonly dataLineage: number;
  readonly expectedScheduleReference: number;
  readonly materialGap: number;
  readonly scheduleOnlyExpected: number;
  readonly scheduleOnlyGap: number;
  readonly collectionFailedExpected: number;
  readonly collectionFailedGap: number;
}

export function summarizeCoverageDispositions(
  items: readonly {
    coverageStatus: TaskLocalCoverageStatus;
    coverageDisposition: CoverageDisposition;
  }[],
): CoverageDispositionSummary {
  let dataLineage = 0;
  let expectedScheduleReference = 0;
  let materialGap = 0;
  let scheduleOnlyExpected = 0;
  let scheduleOnlyGap = 0;
  let collectionFailedExpected = 0;
  let collectionFailedGap = 0;
  for (const item of items) {
    if (item.coverageDisposition === "DATA_LINEAGE") dataLineage += 1;
    else if (item.coverageDisposition === "EXPECTED_SCHEDULE_REFERENCE")
      expectedScheduleReference += 1;
    else materialGap += 1;

    if (item.coverageStatus === "SCHEDULE_ONLY") {
      if (item.coverageDisposition === "EXPECTED_SCHEDULE_REFERENCE")
        scheduleOnlyExpected += 1;
      else scheduleOnlyGap += 1;
    } else if (item.coverageStatus === "COLLECTION_FAILED") {
      if (item.coverageDisposition === "EXPECTED_SCHEDULE_REFERENCE")
        collectionFailedExpected += 1;
      else collectionFailedGap += 1;
    }
  }
  return {
    dataLineage,
    expectedScheduleReference,
    materialGap,
    scheduleOnlyExpected,
    scheduleOnlyGap,
    collectionFailedExpected,
    collectionFailedGap,
  };
}

export function isActionableCoverageGap(input: {
  readonly coverageDisposition: CoverageDisposition;
  readonly failureReasonCode?: TaskLocalFailureReasonCode | null;
}): boolean {
  return input.coverageDisposition === "MATERIAL_GAP";
}

export const COVERAGE_DISPOSITION_LABELS: Readonly<
  Record<CoverageDisposition, string>
> = {
  DATA_LINEAGE: "Field lineage projected",
  EXPECTED_SCHEDULE_REFERENCE:
    "Schedule reference only by task type (no SQL field lineage expected)",
  MATERIAL_GAP: "Missing pack, facts, or target schema for field lineage",
};
