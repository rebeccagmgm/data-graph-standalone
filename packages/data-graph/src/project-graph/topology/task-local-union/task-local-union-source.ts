import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { canonicalJson, sha256 } from "../../../contracts/runtime.ts";
import {
  unpackTaskLocalProjectionEnvelope,
  type TaskLocalProjectionBody,
  type TaskLocalProjectionEnvelope,
  type TaskLocalUnionBatchManifestRef,
  type TaskLocalUnionCoverageStatus,
  type TaskLocalUnionProducerIndexRef,
  type TaskLocalUnionTaskSource,
  type UnpackedTaskLocalProjection,
} from "../../../continuation/task-local-projection.ts";

const SHA256 = /^[a-f0-9]{64}$/i;

export interface TaskLocalBatchManifestTask {
  readonly taskId: string;
  readonly coverageStatus: TaskLocalUnionCoverageStatus;
  readonly failureReasonCode: string | null;
  readonly contentHash: string;
  readonly cacheHit: boolean;
  readonly cacheKey: string;
  readonly path: string;
}

export interface TaskLocalBatchManifest {
  readonly schemaVersion: string;
  readonly artifactType: "TASK_LOCAL_BATCH_MANIFEST";
  readonly generatedAt?: string;
  readonly taskIds: readonly string[];
  readonly tasks: readonly TaskLocalBatchManifestTask[];
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly cache?: Readonly<Record<string, unknown>>;
}

export interface LoadTaskLocalUnionSourcesOptions {
  readonly manifestPath: string;
  readonly projectGraphRoot: string;
  readonly producerIndexPath: string;
}

export interface LoadedTaskLocalUnionTask {
  readonly taskSource: TaskLocalUnionTaskSource;
  readonly envelope: TaskLocalProjectionEnvelope;
  readonly projection: TaskLocalProjectionBody;
  /** Non-PROJECTED tasks contribute only the TASK node (no data edges). */
  readonly boundaryOnly: boolean;
}

export interface LoadedTaskLocalUnionSources {
  readonly sourceMode: "TASK_LOCAL_UNION";
  readonly batchManifest: TaskLocalBatchManifest;
  readonly batchManifestRef: TaskLocalUnionBatchManifestRef;
  readonly producerIndex: TaskLocalUnionProducerIndexRef;
  readonly tasks: readonly LoadedTaskLocalUnionTask[];
}

export function loadTaskLocalUnionSources(
  options: LoadTaskLocalUnionSourcesOptions,
): LoadedTaskLocalUnionSources {
  const projectGraphRoot = resolve(options.projectGraphRoot);
  const manifestPath = resolve(options.manifestPath);
  const producerIndexPath = resolve(options.producerIndexPath);

  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseBatchManifest(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const batchManifestContentHash = batchManifestContentHashOf(manifest);
  const producerIndex = readProducerIndexIdentity(producerIndexPath);

  if (manifest.tasks.length === 0) {
    throw new Error("TASK_LOCAL_UNION_MANIFEST_TASKS_EMPTY");
  }

  const tasks: LoadedTaskLocalUnionTask[] = [];
  for (const entry of manifest.tasks) {
    const envelopePath = resolveEnvelopePath(
      projectGraphRoot,
      entry.path,
      entry.taskId,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(envelopePath, "utf8"));
    } catch (error) {
      throw new Error(
        `TASK_LOCAL_UNION_ENVELOPE_READ_FAILED:${entry.taskId}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const unpacked = unpackTaskLocalProjectionEnvelope({
      envelope: parsed,
      manifestTaskContentHash: entry.contentHash,
    });
    assertManifestTaskAligned(entry, unpacked);
    const boundaryOnly = unpacked.projection.coverageStatus !== "PROJECTED";
    if (boundaryOnly && unpacked.projection.edges.length > 0) {
      throw new Error(
        `TASK_LOCAL_UNION_NON_PROJECTED_DATA_EDGES:${entry.taskId}`,
      );
    }
    tasks.push({
      taskSource: unpacked.taskSource,
      envelope: unpacked.envelope,
      projection: unpacked.projection,
      boundaryOnly,
    });
  }

  tasks.sort((left, right) =>
    left.taskSource.taskId < right.taskSource.taskId
      ? -1
      : left.taskSource.taskId > right.taskSource.taskId
        ? 1
        : 0,
  );

  return {
    sourceMode: "TASK_LOCAL_UNION",
    batchManifest: manifest,
    batchManifestRef: {
      path: manifestPath,
      contentHash: batchManifestContentHash,
    },
    producerIndex,
    tasks,
  };
}

export function batchManifestContentHashOf(
  manifest: TaskLocalBatchManifest,
): string {
  const { generatedAt: _generatedAt, ...rest } = manifest;
  return sha256(canonicalJson(rest));
}

function parseBatchManifest(value: unknown): TaskLocalBatchManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TASK_LOCAL_BATCH_MANIFEST_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    text(record.schemaVersion) !== "1.0.0" ||
    text(record.artifactType) !== "TASK_LOCAL_BATCH_MANIFEST"
  ) {
    throw new Error("TASK_LOCAL_BATCH_MANIFEST_CONTRACT_INVALID");
  }
  if (!Array.isArray(record.taskIds) || !Array.isArray(record.tasks)) {
    throw new Error("TASK_LOCAL_BATCH_MANIFEST_INVALID");
  }
  const tasks: TaskLocalBatchManifestTask[] = record.tasks.map(
    (item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`TASK_LOCAL_BATCH_MANIFEST_TASK_INVALID:${index}`);
      }
      const task = item as Record<string, unknown>;
      const taskId = text(task.taskId);
      const coverageStatus = text(
        task.coverageStatus,
      ) as TaskLocalUnionCoverageStatus | null;
      const contentHash = text(task.contentHash);
      const cacheKey = text(task.cacheKey);
      const path = text(task.path);
      if (
        !taskId ||
        !coverageStatus ||
        !contentHash ||
        !SHA256.test(contentHash) ||
        !cacheKey ||
        !path
      ) {
        throw new Error(`TASK_LOCAL_BATCH_MANIFEST_TASK_INVALID:${index}`);
      }
      const failureReasonCode =
        task.failureReasonCode === null || task.failureReasonCode === undefined
          ? null
          : text(task.failureReasonCode);
      return {
        taskId,
        coverageStatus,
        failureReasonCode,
        contentHash,
        cacheHit: Boolean(task.cacheHit),
        cacheKey,
        path,
      };
    },
  );
  return {
    schemaVersion: "1.0.0",
    artifactType: "TASK_LOCAL_BATCH_MANIFEST",
    ...(typeof record.generatedAt === "string"
      ? { generatedAt: record.generatedAt }
      : {}),
    taskIds: record.taskIds.map((id, index) => {
      const taskId = text(id);
      if (!taskId)
        throw new Error(`TASK_LOCAL_BATCH_MANIFEST_TASK_ID_INVALID:${index}`);
      return taskId;
    }),
    tasks,
    ...(record.summary && typeof record.summary === "object"
      ? { summary: record.summary as Record<string, unknown> }
      : {}),
    ...(record.cache && typeof record.cache === "object"
      ? { cache: record.cache as Record<string, unknown> }
      : {}),
  };
}

function readProducerIndexIdentity(
  path: string,
): TaskLocalUnionProducerIndexRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `TASK_LOCAL_UNION_PRODUCER_INDEX_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("TASK_LOCAL_UNION_PRODUCER_INDEX_INVALID");
  }
  const record = parsed as Record<string, unknown>;
  // Accept either top-level identity or nested producerIndex / identity block.
  const nested =
    typeof record.producerIndex === "object" &&
    record.producerIndex !== null &&
    !Array.isArray(record.producerIndex)
      ? (record.producerIndex as Record<string, unknown>)
      : record;
  const contentHash = text(nested.contentHash);
  const inputFingerprint = text(nested.inputFingerprint);
  if (!contentHash || !SHA256.test(contentHash) || !inputFingerprint) {
    throw new Error("TASK_LOCAL_UNION_PRODUCER_INDEX_INVALID");
  }
  return { contentHash, inputFingerprint };
}

function resolveEnvelopePath(
  projectGraphRoot: string,
  declaredPath: string,
  taskId: string,
): string {
  if (isAbsolute(declaredPath)) return declaredPath;
  const fromRoot = join(projectGraphRoot, declaredPath);
  if (existsSync(fromRoot)) return fromRoot;
  return join(projectGraphRoot, "tasks", taskId, "task-local-projection.json");
}

function assertManifestTaskAligned(
  entry: TaskLocalBatchManifestTask,
  unpacked: UnpackedTaskLocalProjection,
): void {
  if (entry.taskId !== unpacked.projection.taskId) {
    throw new Error(`TASK_LOCAL_UNION_MANIFEST_TASK_MISMATCH:${entry.taskId}`);
  }
  if (entry.coverageStatus !== unpacked.projection.coverageStatus) {
    throw new Error(
      `TASK_LOCAL_UNION_MANIFEST_COVERAGE_MISMATCH:${entry.taskId}`,
    );
  }
  if (entry.contentHash !== unpacked.projection.contentHash) {
    throw new Error(`TASK_LOCAL_UNION_MANIFEST_HASH_MISMATCH:${entry.taskId}`);
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
