import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type {
  UnionContinuationIndex,
  UnionContinuationIndexCandidate,
  UnionContinuationIndexEntry,
} from "../reconcile/consumer/target-table-upstream-causal-closure/union-continuation-candidate-source.ts";

const DEFAULT_ANCHORS = ["181058", "176827", "209119", "155015"] as const;

export interface GoldCaseGapLine {
  readonly gapId: string;
  readonly anchorTaskId: string;
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly qualifiedName: string;
  readonly reasonCode: string;
  readonly layer: "L1" | "L2" | "L3";
  readonly proposedWp: string;
  readonly note: string;
}

export interface AnchorTraceSummary {
  readonly anchorTaskId: string;
  readonly l0: {
    readonly batchProjected: number;
    readonly batchTotal: number;
    readonly anchorCoverageStatus: string;
    readonly externalReadCount: number;
    readonly indexEntryCount: number;
  };
  readonly l1: {
    readonly readsWithL1Eligible: number;
    readonly readsWithoutL1Eligible: number;
    readonly l1EligibleCandidateCount: number;
  };
  readonly l2: {
    readonly readsWithAssumedOnly: number;
    readonly readsWithProducerIndexOnly: number;
    readonly readsWithMultiL1Eligible: number;
  };
  readonly l3: {
    readonly readsWithEntryGaps: number;
    readonly readsWithNoCandidates: number;
    readonly readsNonLiteralPartition: number;
    readonly readsIdentityNotConfirmed: number;
  };
  readonly gapIds: readonly string[];
}

export interface GoldCaseTraceReport {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "GOLD_CASE_TRACE_REPORT";
  readonly generatedAt: string;
  readonly anchors: readonly string[];
  readonly batchManifestPath: string;
  readonly continuationIndexPath: string;
  readonly indexSummary: {
    readonly projectedTaskCount: number;
    readonly readOccurrenceEntryCount: number;
    readonly gapLineCount: number;
  };
  readonly anchorSummaries: readonly AnchorTraceSummary[];
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function csvOption(args: readonly string[], name: string): string[] {
  return (option(args, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function l1EligibleCandidates(
  candidates: readonly UnionContinuationIndexCandidate[],
): UnionContinuationIndexCandidate[] {
  return candidates.filter((candidate) => candidate.l1Eligible);
}

function classifyEntry(entry: UnionContinuationIndexEntry): {
  readonly layer: GoldCaseGapLine["layer"];
  readonly reasonCode: string;
  readonly proposedWp: string;
  readonly note: string;
} | null {
  if (entry.gaps.length > 0) {
    const gap = entry.gaps[0]!;
    return {
      layer: "L3",
      reasonCode: gap.reasonCode,
      proposedWp: "WP-8",
      note: gap.message,
    };
  }
  if (entry.candidates.length === 0) {
    return {
      layer: "L3",
      reasonCode: "NO_CONTINUATION_CANDIDATES",
      proposedWp: "WP-8",
      note: "INDEX entry has zero writer candidates",
    };
  }
  const l1 = l1EligibleCandidates(entry.candidates);
  if (l1.length > 1) {
    return {
      layer: "L2",
      reasonCode: "MULTIPLE_L1_ELIGIBLE_WRITERS",
      proposedWp: "WP-8",
      note: `${l1.length} l1Eligible writers; partition pruning incomplete`,
    };
  }
  if (l1.length === 1) {
    return null;
  }
  if (entry.partitionPredicateStatus === "NON_LITERAL_PRESENT") {
    return {
      layer: "L3",
      reasonCode: "NON_LITERAL_PARTITION_PREDICATE",
      proposedWp: "WP-7",
      note: "Read partition predicate is not fully literal",
    };
  }
  if (entry.identityStatus !== "CONFIRMED") {
    return {
      layer: "L3",
      reasonCode: "READ_IDENTITY_NOT_CONFIRMED",
      proposedWp: "WP-7",
      note: `identityStatus=${entry.identityStatus}`,
    };
  }
  const allProducerOnly = entry.candidates.every(
    (candidate) => candidate.source === "PRODUCER_INDEX_ONLY",
  );
  if (allProducerOnly) {
    return {
      layer: "L2",
      reasonCode: "WRITER_NOT_IN_UNION",
      proposedWp: "WP-8",
      note: "Candidates only from producer-index; no in-union WRITES edge",
    };
  }
  const hasAssumed = entry.candidates.some(
    (candidate) => candidate.partitionMatchStatus === "ASSUMED",
  );
  if (hasAssumed) {
    return {
      layer: "L2",
      reasonCode: "PARTITION_ASSUMED",
      proposedWp: "WP-8",
      note: "ASSUMED partition match; not L1-eligible",
    };
  }
  const statuses = [...new Set(entry.candidates.map((c) => c.partitionMatchStatus))];
  return {
    layer: "L3",
    reasonCode: "NO_L1_ELIGIBLE_CANDIDATE",
    proposedWp: "WP-8",
    note: `partitionMatchStatus=${statuses.join("|")}`,
  };
}


export function buildGoldCaseGaps(
  index: UnionContinuationIndex,
  anchors: readonly string[],
): GoldCaseGapLine[] {
  const gaps: GoldCaseGapLine[] = [];
  let seq = 0;
  for (const entry of index.entries) {
    if (!anchors.includes(entry.consumerTaskId)) continue;
    const classified = classifyEntry(entry);
    if (!classified) continue;
    seq += 1;
    gaps.push({
      gapId: `GC-GAP-${String(seq).padStart(4, "0")}`,
      anchorTaskId: entry.consumerTaskId,
      consumerTaskId: entry.consumerTaskId,
      readOccurrenceId: entry.readOccurrenceId,
      qualifiedName: entry.qualifiedName,
      reasonCode: classified.reasonCode,
      layer: classified.layer,
      proposedWp: classified.proposedWp,
      note: classified.note,
    });
  }
  return gaps;
}

export function buildAnchorSummaries(
  index: UnionContinuationIndex,
  anchors: readonly string[],
  batchSummary: { projected: number; total: number },
  coverageByTask: ReadonlyMap<string, string>,
): AnchorTraceSummary[] {
  return anchors.map((anchorTaskId) => {
    const entries = index.entries.filter(
      (entry) => entry.consumerTaskId === anchorTaskId,
    );
    const gapIds: string[] = [];
    let readsWithL1 = 0;
    let readsWithoutL1 = 0;
    let l1CandidateCount = 0;
    let assumedOnly = 0;
    let producerOnly = 0;
    let multiL1 = 0;
    let entryGaps = 0;
    let noCandidates = 0;
    let nonLiteral = 0;
    let identityNotConfirmed = 0;

    for (const entry of entries) {
      const l1 = l1EligibleCandidates(entry.candidates);
      l1CandidateCount += l1.length;
      if (l1.length > 0) readsWithL1 += 1;
      else readsWithoutL1 += 1;
      if (l1.length > 1) multiL1 += 1;
      if (entry.gaps.length > 0) entryGaps += 1;
      if (entry.candidates.length === 0) noCandidates += 1;
      if (entry.partitionPredicateStatus === "NON_LITERAL_PRESENT") nonLiteral += 1;
      if (entry.identityStatus !== "CONFIRMED") identityNotConfirmed += 1;
      if (
        entry.candidates.length > 0
        && entry.candidates.every((c) => c.source === "PRODUCER_INDEX_ONLY")
      ) {
        producerOnly += 1;
      }
      if (
        l1.length === 0
        && entry.candidates.some((c) => c.partitionMatchStatus === "ASSUMED")
      ) {
        assumedOnly += 1;
      }
      const classified = classifyEntry(entry);
      if (classified) {
        gapIds.push(`${anchorTaskId}:${entry.readOccurrenceId}`);
      }
    }

    return {
      anchorTaskId,
      l0: {
        batchProjected: batchSummary.projected,
        batchTotal: batchSummary.total,
        anchorCoverageStatus: coverageByTask.get(anchorTaskId) ?? "MISSING",
        externalReadCount: entries.length,
        indexEntryCount: entries.length,
      },
      l1: {
        readsWithL1Eligible: readsWithL1,
        readsWithoutL1Eligible: readsWithoutL1,
        l1EligibleCandidateCount: l1CandidateCount,
      },
      l2: {
        readsWithAssumedOnly: assumedOnly,
        readsWithProducerIndexOnly: producerOnly,
        readsWithMultiL1Eligible: multiL1,
      },
      l3: {
        readsWithEntryGaps: entryGaps,
        readsWithNoCandidates: noCandidates,
        readsNonLiteralPartition: nonLiteral,
        readsIdentityNotConfirmed: identityNotConfirmed,
      },
      gapIds,
    };
  });
}

export function emitGoldCaseTraceReport(input: {
  readonly batchManifestPath: string;
  readonly continuationIndexPath: string;
  readonly outputDir: string;
  readonly anchors?: readonly string[];
  readonly generatedAt?: string;
}): {
  readonly gapsPath: string;
  readonly reportPath: string;
  readonly gapCount: number;
} {
  const anchors = input.anchors?.length
    ? [...input.anchors]
    : [...DEFAULT_ANCHORS];
  const batchManifest = JSON.parse(
    readFileSync(resolve(input.batchManifestPath), "utf8"),
  ) as {
    summary: { projected: number; total: number };
    tasks: Array<{ taskId: string; coverageStatus: string }>;
  };
  const index = JSON.parse(
    readFileSync(resolve(input.continuationIndexPath), "utf8"),
  ) as UnionContinuationIndex;
  const coverageByTask = new Map(
    batchManifest.tasks.map((task) => [task.taskId, task.coverageStatus]),
  );
  const gaps = buildGoldCaseGaps(index, anchors);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const report: GoldCaseTraceReport = {
    schemaVersion: "1.0.0",
    artifactType: "GOLD_CASE_TRACE_REPORT",
    generatedAt,
    anchors,
    batchManifestPath: resolve(input.batchManifestPath),
    continuationIndexPath: resolve(input.continuationIndexPath),
    indexSummary: {
      projectedTaskCount: batchManifest.summary.projected,
      readOccurrenceEntryCount: index.entries.length,
      gapLineCount: gaps.length,
    },
    anchorSummaries: buildAnchorSummaries(
      index,
      anchors,
      batchManifest.summary,
      coverageByTask,
    ),
  };

  mkdirSync(resolve(input.outputDir), { recursive: true });
  const gapsPath = join(resolve(input.outputDir), "gold-case-gaps.jsonl");
  writeFileSync(
    gapsPath,
    gaps.length === 0 ? "" : `${gaps.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
  const reportPath = join(resolve(input.outputDir), "gold-case-trace-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { gapsPath, reportPath, gapCount: gaps.length };
}

function main(argv: readonly string[]): void {
  const args = argv.slice(2);
  const batchManifestPath = option(args, "--batch-manifest");
  const continuationIndexPath = option(args, "--continuation-index");
  const outputDir = option(args, "--output-dir");
  if (!batchManifestPath || !continuationIndexPath || !outputDir) {
    throw new Error(
      "usage: emit-gold-case-trace-report --batch-manifest <path> --continuation-index <path> --output-dir <path> [--anchors 181058,176827]",
    );
  }
  const result = emitGoldCaseTraceReport({
    batchManifestPath,
    continuationIndexPath,
    outputDir,
    anchors: csvOption(args, "--anchors"),
    generatedAt: option(args, "--generated-at"),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && /emit-gold-case-trace-report/.test(process.argv[1])) {
  main(process.argv);
}
