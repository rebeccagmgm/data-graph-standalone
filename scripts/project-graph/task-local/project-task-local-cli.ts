import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveWorkspacePaths } from "../../config/workspace-paths.ts";

import { canonicalJson } from "../../machine-facts/machine-facts-contract.ts";
import { selectTaskLocalBatchTaskIds } from "./batch-selection.ts";
import { projectTaskLocalBatch } from "./project-task-local-batch.ts";
import { taskLocalProjectionVersionPath } from "./projection-cache.ts";
import type {
  TaskLocalUpstreamExpander,
  TaskLocalUpstreamExpansionResult,
} from "./upstream-expansion-port.ts";

export interface ProjectTaskLocalCliOptions {
  readonly dataRoot: string;
  readonly factsRoot: string;
  readonly scheduleCacheRoot: string;
  readonly outputRoot: string;
  /** Shared cache root. Omitted only by legacy programmatic callers. */
  readonly projectionRoot?: string;
  readonly topic?: string;
  readonly taskIds: readonly string[];
  readonly expandUpstream: boolean;
  readonly writerCatalogPath?: string;
  /** @deprecated use writerCatalogPath */
  readonly producerIndexRoot?: string;
  readonly maxUpstreamDepth?: number;
  readonly alsoTaskIds: readonly string[];
  readonly prepareFacts: boolean;
  readonly generatedAt?: string;
}

export interface ProjectTaskLocalCliDependencies {
  readonly expandAnchorUpstreamTaskIds?: TaskLocalUpstreamExpander;
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

function taskIdsFileOption(args: readonly string[]): string[] {
  const path = option(args, "--task-ids-file");
  if (!path) return [];
  return readFileSync(resolve(path), "utf8")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseProjectTaskLocalCli(
  args: readonly string[],
): ProjectTaskLocalCliOptions {
  const paths = resolveWorkspacePaths({
    configPath: option(args, "--config"),
    profile: option(args, "--profile"),
    overrides: {
      inputPackRoot: option(args, "--data-root") ?? option(args, "--input-pack-root"),
      factsRoot: option(args, "--facts-root"),
      projectionRoot: option(args, "--projection-root"),
      writerCatalogPath: option(args, "--writer-catalog"),
      evidenceRoot: option(args, "--schedule-cache")
        ?? option(args, "--schedule-cache-root")
        ?? option(args, "--schedule-evidence-cache-root"),
    },
  });
  const dataRoot = paths.inputPackRoot;
  const factsRoot = paths.factsRoot;
  const scheduleCacheRoot = paths.evidenceRoot;
  const outputRoot = option(args, "--output-root") ?? paths.graphOutputRoot;
  const topic = option(args, "--topic");
  const taskIds = [...new Set([
    ...csvOption(args, "--task-ids"),
    ...taskIdsFileOption(args),
  ])];
  const alsoTaskIds = csvOption(args, "--also-task-ids");
  const expandUpstream = args.includes("--expand-upstream");
  const writerCatalogPath = paths.writerCatalogPath;
  const producerIndexRoot = option(args, "--producer-index-root");
  const maxUpstreamDepthRaw = option(args, "--max-upstream-depth");
  const maxUpstreamDepth = maxUpstreamDepthRaw
    ? Number(maxUpstreamDepthRaw)
    : undefined;
  if (
    maxUpstreamDepth !== undefined
    && (!Number.isSafeInteger(maxUpstreamDepth) || maxUpstreamDepth < 1)
  ) {
    throw new Error("MAX_UPSTREAM_DEPTH_INVALID");
  }
  if (taskIds.length === 0 && !topic && alsoTaskIds.length === 0) {
    throw new Error(
      "TASK_LOCAL_BATCH_SELECTOR_REQUIRED: pass --task-ids and/or --task-ids-file and/or --topic and/or --also-task-ids",
    );
  }
  if (expandUpstream && taskIds.length === 0) {
    throw new Error("EXPAND_UPSTREAM_REQUIRES_TASK_IDS");
  }
  if (args.includes("--prepare-facts")) {
    throw new Error("PREPARE_FACTS_UNSUPPORTED: TL-5 defaults to --no-prepare-facts; omit --prepare-facts");
  }
  return {
    dataRoot: resolve(dataRoot),
    factsRoot: resolve(factsRoot),
    scheduleCacheRoot: resolve(scheduleCacheRoot),
    outputRoot: resolve(outputRoot),
    projectionRoot: paths.projectionRoot,
    topic,
    taskIds,
    expandUpstream,
    writerCatalogPath: writerCatalogPath ? resolve(writerCatalogPath) : undefined,
    producerIndexRoot,
    maxUpstreamDepth,
    alsoTaskIds,
    prepareFacts: false,
    generatedAt: option(args, "--generated-at"),
  };
}

export function runProjectTaskLocalCli(
  options: ProjectTaskLocalCliOptions,
  dependencies: ProjectTaskLocalCliDependencies = {},
): {
  readonly batchManifestPath: string;
  readonly taskIds: readonly string[];
  readonly cache: { readonly hits: number; readonly misses: number };
} {
  const selection = selectTaskLocalBatchTaskIds({
    scheduleCacheRoot: options.scheduleCacheRoot,
    topic: options.topic,
    taskIds: options.taskIds,
    alsoTaskIds: options.alsoTaskIds,
  });
  let upstreamExpansion: TaskLocalUpstreamExpansionResult | null = null;
  const batchTaskIds = options.expandUpstream
    ? (() => {
        if (!dependencies.expandAnchorUpstreamTaskIds) {
          throw new Error(
            "TASK_LINEAGE_ADDON_REQUIRED: use npm run addon:task-lineage:project-task-local",
          );
        }
        upstreamExpansion = dependencies.expandAnchorUpstreamTaskIds({
          dataRoot: options.dataRoot,
          anchorTaskIds: selection.anchorTaskIds,
          writerCatalogPath: options.writerCatalogPath,
          producerIndexRoot: options.producerIndexRoot,
          maxDepth: options.maxUpstreamDepth,
        });
        return [...new Set([
          ...upstreamExpansion.taskIds,
          ...selection.alsoTaskIds,
        ])].sort((left, right) => left.localeCompare(right, "en-US", { numeric: true }));
      })()
    : selection.taskIds;
  if (batchTaskIds.length === 0) {
    throw new Error("TASK_LOCAL_BATCH_EMPTY: no tasks matched batch selectors");
  }

  mkdirSync(options.outputRoot, { recursive: true });
  const projectionRoot = options.projectionRoot ?? options.outputRoot;
  const batch = projectTaskLocalBatch({
    dataRoot: options.dataRoot,
    factsRoot: options.factsRoot,
    scheduleCacheRoot: options.scheduleCacheRoot,
    taskIds: batchTaskIds,
    outputRoot: projectionRoot,
    generatedAt: options.generatedAt,
  });

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const manifest = {
    schemaVersion: "1.0.0",
    artifactType: "TASK_LOCAL_BATCH_MANIFEST",
    generatedAt,
    topic: options.topic ?? null,
    anchorTaskIds: selection.anchorTaskIds,
    expandUpstream: options.expandUpstream,
    upstreamExpansion: upstreamExpansion
      ? {
          status: upstreamExpansion.status,
          anchorTaskIds: upstreamExpansion.anchorTaskIds,
          discoveredTaskIds: upstreamExpansion.discoveredTaskIds,
          taskIds: upstreamExpansion.taskIds,
          issues: upstreamExpansion.issues,
          counters: upstreamExpansion.counters,
        }
      : null,
    alsoTaskIds: selection.alsoTaskIds,
    topicTaskIds: selection.topicTaskIds,
    taskIds: batchTaskIds,
    summary: batch.summary,
    cache: batch.cache,
    tasks: batch.results.map((result) => ({
      taskId: result.taskId,
      coverageStatus: result.projection.coverageStatus,
      failureReasonCode: result.projection.failureReasonCode,
      contentHash: result.projection.contentHash,
      cacheHit: result.cacheHit,
      cacheKey: result.cacheKey,
      path: taskLocalProjectionVersionPath(projectionRoot, result.taskId, result.cacheKey),
    })),
  };
  const batchManifestPath = join(options.outputRoot, "batch-manifest.json");
  writeFileSync(batchManifestPath, `${canonicalJson(manifest)}\n`, "utf8");
  return {
    batchManifestPath,
    taskIds: batchTaskIds,
    cache: batch.cache,
  };
}

function main(argv: readonly string[]): void {
  const options = parseProjectTaskLocalCli(argv.slice(2));
  const result = runProjectTaskLocalCli(options);
  process.stdout.write(`${canonicalJson({
    ok: true,
    batchManifestPath: result.batchManifestPath,
    taskCount: result.taskIds.length,
    cache: result.cache,
  })}\n`);
}

if (process.argv[1] && /project-task-local(?:-cli)?\.(?:ts|js|mjs|cjs)$/.test(process.argv[1].replaceAll("\\", "/"))) {
  main(process.argv);
}
