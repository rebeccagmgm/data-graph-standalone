import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { expandAnchorUpstreamTaskIds } from "../task-local/anchor-upstream-expansion.ts";
import { projectTaskLocalBatch } from "../../../../project-graph/task-local/project-task-local-batch.ts";
import type { TaskLocalProjection } from "../../../../project-graph/task-local/contract.ts";

const DEFAULT_ANCHORS = ["181058", "176827", "209119", "155015"] as const;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function listFactsTaskIds(factsRoot: string): string[] {
  const tasksRoot = join(factsRoot, "registry", "tasks");
  if (!existsSync(tasksRoot)) return [];
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en-US", { numeric: true }));
}

function countByKey(values: readonly string[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) {
    output[value] = (output[value] ?? 0) + 1;
  }
  return output;
}

function resolvedDirectRatioForProjection(projection: TaskLocalProjection): number {
  const directEdges = projection.edges.filter((edge) => edge.edgeType === "FIELD_DIRECT");
  if (directEdges.length === 0) return 0;
  const resolved = directEdges.filter(
    (edge) => edge.properties.sourceReadOccurrenceStatus === "RESOLVED",
  ).length;
  return resolved / directEdges.length;
}

function metricsForProjections(projections: readonly TaskLocalProjection[]) {
  const directEdges = projections.flatMap((projection) =>
    projection.edges.filter((edge) => edge.edgeType === "FIELD_DIRECT"),
  );
  const conditionalEdges = projections.flatMap((projection) =>
    projection.edges.filter((edge) => edge.edgeType === "FIELD_CONDITIONAL"),
  );
  const resolvedDirect = directEdges.filter(
    (edge) => edge.properties.sourceReadOccurrenceStatus === "RESOLVED",
  ).length;
  const resolvedConditional = conditionalEdges.filter(
    (edge) => edge.properties.sourceReadOccurrenceStatus === "RESOLVED",
  ).length;
  const subtypeDistribution = countByKey(
    directEdges.map((edge) => String(edge.properties.subtype ?? "UNKNOWN")),
  );
  const ambiguousReasonCodes = countByKey(
    directEdges
      .filter((edge) => edge.properties.sourceReadOccurrenceStatus === "AMBIGUOUS")
      .map((edge) => String(edge.properties.sourceReadOccurrenceReason ?? "UNKNOWN")),
  );
  const unresolvedReasonCodes = countByKey(
    directEdges
      .filter((edge) => edge.properties.sourceReadOccurrenceStatus === "UNRESOLVED")
      .map((edge) => String(edge.properties.sourceReadOccurrenceReason ?? "UNKNOWN")),
  );
  const joinSideDistribution = countByKey(
    projections.flatMap((projection) =>
      projection.edges
        .filter((edge) => edge.edgeType === "DATASET_CONTROL" && edge.properties.subtype === "JOIN")
        .map((edge) => String(edge.properties.controlSide ?? "UNKNOWN")),
    ),
  );
  const materializationBreakCount = projections.reduce(
    (sum, projection) =>
      sum
      + (projection.gaps?.filter(
        (gap) => gap.reasonCode === "TASK_LOCAL_MATERIALIZATION_FIELD_BREAK",
      ).length ?? 0),
    0,
  );
  return {
    taskCount: projections.length,
    fieldDirectCount: directEdges.length,
    resolvedDirectRatio: directEdges.length === 0 ? 0 : resolvedDirect / directEdges.length,
    resolvedConditionalRatio:
      conditionalEdges.length === 0 ? 0 : resolvedConditional / conditionalEdges.length,
    subtypeDistribution,
    ambiguousReasonCodes,
    unresolvedReasonCodes,
    joinSideDistribution,
    materializationBreakCount,
  };
}

function main(argv: readonly string[]): void {
  const args = argv.slice(2);
  const dataRoot = option(args, "--data-root");
  const factsRoot = option(args, "--facts-root");
  const outputPath = option(args, "--output")
    ?? join(resolve("artifacts/field-evidence-v1"), "phase1-baseline.json");
  const scheduleCacheRoot = option(args, "--schedule-cache-root");
  const projectionOutputRoot = option(args, "--projection-output-root");
  if (!dataRoot || !factsRoot) {
    throw new Error(
      "usage: phase1-baseline-cli --data-root <path> --facts-root <path> [--projection-output-root <path>] [--schedule-cache-root <path>] [--output <path>]",
    );
  }
  const resolvedDataRoot = resolve(dataRoot);
  const resolvedFactsRoot = resolve(factsRoot);
  const allTaskIds = listFactsTaskIds(resolvedFactsRoot);
  const anchorExpansion = expandAnchorUpstreamTaskIds({
    dataRoot: resolvedDataRoot,
    anchorTaskIds: [...DEFAULT_ANCHORS],
    writerCatalogPath: option(args, "--writer-catalog")
      ? resolve(option(args, "--writer-catalog")!)
      : undefined,
    producerIndexRoot: option(args, "--producer-index-root")
      ? resolve(option(args, "--producer-index-root")!)
      : undefined,
  });
  const anchorTaskIds = new Set(anchorExpansion.taskIds);
  const shadowTaskIds = allTaskIds.filter((taskId) => !anchorTaskIds.has(taskId));
  const batch = projectTaskLocalBatch({
    dataRoot: resolvedDataRoot,
    factsRoot: resolvedFactsRoot,
    taskIds: allTaskIds,
    scheduleCacheRoot: scheduleCacheRoot ? resolve(scheduleCacheRoot) : undefined,
    outputRoot: projectionOutputRoot ? resolve(projectionOutputRoot) : undefined,
  });
  const projectionByTaskId = new Map(
    batch.results.map((result) => [result.taskId, result.projection]),
  );
  const cohort = (taskIds: readonly string[]) =>
    metricsForProjections(
      taskIds
        .map((taskId) => projectionByTaskId.get(taskId))
        .filter((projection): projection is TaskLocalProjection => projection !== undefined),
    );
  const baseline = {
    schemaVersion: "1.0.0",
    artifactType: "FIELD_EVIDENCE_PHASE1_BASELINE",
    generatedAt: new Date().toISOString(),
    cohorts: {
      anchorExpansionBatch: cohort(anchorExpansion.taskIds),
      shadowEvaluationSlice: cohort(shadowTaskIds),
      all: cohort(allTaskIds),
    },
    anchorTaskRatios: Object.fromEntries(
      DEFAULT_ANCHORS.map((taskId) => {
        const projection = projectionByTaskId.get(taskId);
        return [
          taskId,
          projection
            ? {
              coverageStatus: projection.coverageStatus,
              resolvedDirectRatio: resolvedDirectRatioForProjection(projection),
              fieldDirectCount: projection.edges.filter(
                (edge) => edge.edgeType === "FIELD_DIRECT",
              ).length,
            }
            : { coverageStatus: "MISSING", resolvedDirectRatio: 0, fieldDirectCount: 0 },
        ];
      }),
    ),
    referenceLines: {
      naiveSubtreeResolvedDirectRatio: 0.6329,
      anchorTaskRatiosPreFieldEvidence: {
        "155015": 1,
        "176827": 0.5778,
        "181058": 0.1156,
        "209119": 0.9213,
      },
      criterion1Note:
        "Pre-1.3.0 anchorExpansionBatch/shadowEvaluationSlice cohort ratios were not persisted; "
        + "strict §5.5 criterion-1 before/after requires reprojecting 1.2.0 artifacts. "
        + "Current cohorts are 1.3.0-only.",
    },
    taskSets: {
      anchorExpansionBatch: anchorExpansion.taskIds,
      shadowEvaluationSlice: shadowTaskIds,
      all: allTaskIds,
    },
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n`);
}

main(process.argv);
