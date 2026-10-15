import {
  summarizeTaskLocalBatch,
  type TaskLocalBatchSummary,
  type TaskLocalProjection,
} from "./contract.ts";
import { projectTaskLocal, type ProjectTaskLocalOptions } from "./project-task-local.ts";
import { createCurrentTaskBundleReader, type CurrentTaskBundleReader } from "../../query/current-task-bundle.ts";
import {
  storeTaskLocalProjectionCache,
  tryReadCachedTaskLocalProjection,
  type TaskLocalCacheKeyParts,
  ensureTaskLocalProjectionVersion,
} from "./projection-cache.ts";

export interface ProjectTaskLocalBatchOptions {
  readonly bundleReader?: CurrentTaskBundleReader;
  readonly factsRoot: string;
  readonly dataRoot: string;
  readonly taskIds: readonly string[];
  readonly scheduleCacheRoot?: string;
  readonly generatedAt?: string;
  /** When set, enable content-hash cache under this shared projection root. */
  readonly outputRoot?: string;
}

export interface TaskLocalBatchTaskResult {
  readonly taskId: string;
  readonly cacheHit: boolean;
  readonly cacheKey: string;
  readonly cacheKeyParts: TaskLocalCacheKeyParts;
  readonly projection: TaskLocalProjection;
}

export interface ProjectTaskLocalBatchResult {
  readonly projections: readonly TaskLocalProjection[];
  readonly results: readonly TaskLocalBatchTaskResult[];
  readonly summary: TaskLocalBatchSummary;
  readonly cache: {
    readonly hits: number;
    readonly misses: number;
  };
}

export function projectTaskLocalBatch(
  options: ProjectTaskLocalBatchOptions,
): ProjectTaskLocalBatchResult {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const results: TaskLocalBatchTaskResult[] = [];
  let hits = 0;
  let misses = 0;
  const reader = options.bundleReader ?? createCurrentTaskBundleReader(options.factsRoot, { cacheLoads: false });

  for (const taskId of options.taskIds) {
    const currentBundle = reader.load(taskId);
    if (options.outputRoot) {
      const cached = tryReadCachedTaskLocalProjection({
        currentBundle,
        outputRoot: options.outputRoot,
        taskId,
        dataRoot: options.dataRoot,
        factsRoot: options.factsRoot,
        scheduleCacheRoot: options.scheduleCacheRoot,
      });
      if (cached.hit && cached.envelope) {
        ensureTaskLocalProjectionVersion(options.outputRoot, cached.envelope);
        hits += 1;
        results.push({
          taskId,
          cacheHit: true,
          cacheKey: cached.cacheKey,
          cacheKeyParts: cached.cacheKeyParts,
          projection: cached.envelope.projection,
        });
        continue;
      }
      const projection = projectTaskLocal({
        currentBundle,
        factsRoot: options.factsRoot,
        dataRoot: options.dataRoot,
        taskId,
        scheduleCacheRoot: options.scheduleCacheRoot,
        generatedAt,
      } satisfies ProjectTaskLocalOptions);
      storeTaskLocalProjectionCache({
        outputRoot: options.outputRoot,
        cacheKeyParts: cached.cacheKeyParts,
        projection,
      });
      misses += 1;
      results.push({
        taskId,
        cacheHit: false,
        cacheKey: cached.cacheKey,
        cacheKeyParts: cached.cacheKeyParts,
        projection,
      });
      continue;
    }

    const projection = projectTaskLocal({
      currentBundle,
      factsRoot: options.factsRoot,
      dataRoot: options.dataRoot,
      taskId,
      scheduleCacheRoot: options.scheduleCacheRoot,
      generatedAt,
    } satisfies ProjectTaskLocalOptions);
    misses += 1;
    const cacheKeyParts = {
      taskId,
      packContentHash: "UNTRACKED",
      factsManifestSha256: "UNTRACKED",
      schemaVersion: projection.schemaVersion,
    } as const;
    results.push({
      taskId,
      cacheHit: false,
      cacheKey: "UNTRACKED",
      cacheKeyParts,
      projection,
    });
  }

  const projections = results.map((result) => result.projection);
  return {
    projections,
    results,
    summary: summarizeTaskLocalBatch(projections),
    cache: { hits, misses },
  };
}
