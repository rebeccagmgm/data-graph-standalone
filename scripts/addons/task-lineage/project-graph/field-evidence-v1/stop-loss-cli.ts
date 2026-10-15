import {
  createFieldEvidenceQueryContext,
  fieldEvidenceGoldenRequired,
  fieldEvidenceQueryRoots,
  primaryFinalWrite,
} from "./impact-query-harness.ts";
import type { FieldImpactResult } from "./impact-result-contract.ts";

const GREEK_COLUMNS = [
  "gamma",
  "delta",
  "vega",
  "theta",
  "gamma_base",
  "gamma_pct",
  "npv_base",
  "net_now_val",
  "now_vall",
  "vola",
] as const;

const PHASE1_GAP_CODES = new Set([
  "FIELD_SOURCE_READ_OCCURRENCE_AMBIGUOUS",
  "FIELD_SOURCE_READ_OCCURRENCE_UNRESOLVED",
  "FIELD_SUBTYPE_UNKNOWN",
  "CONTROL_SIDE_UNRESOLVED",
  "TASK_LOCAL_MATERIALIZATION_FIELD_BREAK",
]);

const WP8_GAP_CODES = new Set([
  "WRITER_PARTITION_UNKNOWN",
  "MULTI_WRITER_CANDIDATE_FRONTIER",
]);

type StopLossDecision =
  | "GO_PHASE3"
  | "WAIT_WP8"
  | "BACKFILL_FACTS"
  | "FIX_PHASE1";

function dominantGap(result: FieldImpactResult): string | null {
  const counts = new Map<string, number>();
  for (const frontier of result.frontier) {
    counts.set(
      frontier.reasonCode,
      (counts.get(frontier.reasonCode) ?? 0) + 1,
    );
    for (const candidate of frontier.candidates) {
      if (candidate.reasonCode) {
        counts.set(
          candidate.reasonCode,
          (counts.get(candidate.reasonCode) ?? 0) + 1,
        );
      }
    }
  }
  for (const gap of result.gaps) {
    counts.set(gap.reasonCode, (counts.get(gap.reasonCode) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [code, count] of counts) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

function decideStopLoss(input: {
  readonly confirmedTwoHopRatio: number;
  readonly dominantGap: string | null;
}): StopLossDecision {
  if (input.confirmedTwoHopRatio >= 0.5) return "GO_PHASE3";
  const gap = input.dominantGap;
  if (gap && WP8_GAP_CODES.has(gap)) return "WAIT_WP8";
  if (gap === "PRODUCER_NOT_PROJECTED") return "BACKFILL_FACTS";
  if (gap && PHASE1_GAP_CODES.has(gap)) return "FIX_PHASE1";
  return "WAIT_WP8";
}

export function runFieldEvidenceStopLoss(taskId: string): {
  readonly taskId: string;
  readonly confirmedTwoHopRatio: number;
  readonly dominantGap: string | null;
  readonly decision: StopLossDecision;
  readonly columns: readonly {
    readonly outputColumn: string;
    readonly hasConfirmedDepthOne: boolean;
    readonly dominantGap: string | null;
  }[];
} {
  // This acceptance command evaluates the fixed Greek column set.
  const roots = fieldEvidenceQueryRoots({ profile: "greek-legacy" });
  if (!roots) {
    if (fieldEvidenceGoldenRequired()) {
      throw new Error("FIELD_EVIDENCE_GOLDEN_DATA_MISSING");
    }
    throw new Error("FIELD_EVIDENCE_STOP_LOSS_DATA_MISSING");
  }

  const context = createFieldEvidenceQueryContext(roots);
  const projection = context.projectionForTask(taskId);
  const write = primaryFinalWrite(projection);
  if (!write) throw new Error("FIELD_EVIDENCE_STOP_LOSS_ANCHOR_WRITE_MISSING");

  const columns: {
    readonly outputColumn: string;
    readonly hasConfirmedDepthOne: boolean;
    readonly dominantGap: string | null;
  }[] = [];
  const gapTotals = new Map<string, number>();
  let confirmedCount = 0;

  for (const outputColumn of GREEK_COLUMNS) {
    const result = context.runImpactQuery({
      taskId: projection.taskId,
      writeObservationId: write.writeObservationId,
      outputColumn,
    }, { maxDepth: 3 });
    const hasConfirmedDepthOne = result.value.some(
      (entry) => entry.depth === 1 && entry.evidenceStatus === "CONFIRMED",
    );
    if (hasConfirmedDepthOne) confirmedCount += 1;
    const columnDominant = dominantGap(result);
    if (columnDominant) {
      gapTotals.set(columnDominant, (gapTotals.get(columnDominant) ?? 0) + 1);
    }
    columns.push({
      outputColumn,
      hasConfirmedDepthOne,
      dominantGap: columnDominant,
    });
  }

  let overallDominant: string | null = null;
  let overallCount = 0;
  for (const [code, count] of gapTotals) {
    if (count > overallCount) {
      overallDominant = code;
      overallCount = count;
    }
  }

  const confirmedTwoHopRatio = confirmedCount / GREEK_COLUMNS.length;
  return {
    taskId: projection.taskId,
    confirmedTwoHopRatio,
    dominantGap: overallDominant,
    decision: decideStopLoss({
      confirmedTwoHopRatio,
      dominantGap: overallDominant,
    }),
    columns,
  };
}

export function main(argv = process.argv.slice(2)): void {
  const taskId = argv.find((arg, index) => argv[index - 1] === "--task-id")
    ?? process.env.FIELD_EVIDENCE_STOP_LOSS_TASK_ID?.trim();
  if (!taskId) {
    throw new Error("FIELD_EVIDENCE_STOP_LOSS_TASK_ID_REQUIRED");
  }
  const report = runFieldEvidenceStopLoss(taskId);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("stop-loss-cli.ts")) {
  main();
}
