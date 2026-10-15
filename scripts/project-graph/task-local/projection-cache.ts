import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { indexTaskInputPacks } from "../../machine-facts/input-pack-machine-facts.ts";
import { canonicalJson, sha256 } from "../../machine-facts/machine-facts-contract.ts";
import {
  loadCurrentTaskBundle,
  type CurrentBundleLoad,
} from "../../query/current-task-bundle.ts";
import {
  TASK_LOCAL_PROJECTION_SCHEMA_VERSION,
  canonicalizeTaskLocalProjection,
  type TaskLocalProjectionSchemaVersion,
  type TaskLocalProjection,
} from "./contract.ts";
import { readTaskScheduleContext } from "./schedule-context.ts";

export interface TaskLocalCacheKeyParts {
  readonly taskId: string;
  readonly packContentHash: string;
  readonly factsManifestSha256: string;
  readonly schemaVersion: TaskLocalProjectionSchemaVersion;
  readonly scheduleContentHash?: string;
  readonly generatorVersion?: string;
}

export interface TaskLocalCacheEnvelope {
  readonly cacheKey: string;
  readonly cacheKeyParts: TaskLocalCacheKeyParts;
  readonly projectionContentHash: string;
  readonly projection: TaskLocalProjection;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function taskLocalCacheKey(parts: TaskLocalCacheKeyParts): string {
  return sha256(canonicalJson({
    taskId: parts.taskId,
    ...(parts.generatorVersion ? {generatorVersion:parts.generatorVersion} : {}),
    packContentHash: parts.packContentHash,
    factsManifestSha256: parts.factsManifestSha256,
    schemaVersion: parts.schemaVersion,
    ...(parts.scheduleContentHash === undefined ? {} : { scheduleContentHash: parts.scheduleContentHash }),
  }));
}

export function packContentHashForTask(dataRoot: string, taskId: string): string {
  const paths = indexTaskInputPacks(dataRoot).get(taskId) ?? [];
  if (paths.length !== 1) return "NO_PACK";
  try {
    const document = JSON.parse(readFileSync(paths[0]!, "utf8")) as Record<string, unknown>;
    return text(document.contentHash) ?? sha256(readFileSync(paths[0]!));
  } catch {
    return "NO_PACK";
  }
}

export function factsManifestFingerprint(load: CurrentBundleLoad): string {
  return text(load.manifestSha256)
    ?? text(load.indexRow?.manifest_sha256)
    ?? "NO_FACTS";
}

export function resolveTaskLocalCacheKeyParts(input: {
  readonly currentBundle?: CurrentBundleLoad;
  readonly packContentHash?: string;
  readonly taskId: string;
  readonly dataRoot: string;
  readonly factsRoot: string;
  readonly scheduleCacheRoot?: string;
}): TaskLocalCacheKeyParts {
  const load = input.currentBundle ?? loadCurrentTaskBundle(input.factsRoot, input.taskId);
  const schedule = input.scheduleCacheRoot
    ? readTaskScheduleContext(input.taskId, input.scheduleCacheRoot)
    : null;
  return {
    taskId: input.taskId,
    packContentHash: input.packContentHash ?? packContentHashForTask(input.dataRoot, input.taskId),
    factsManifestSha256: factsManifestFingerprint(load),
    schemaVersion: TASK_LOCAL_PROJECTION_SCHEMA_VERSION,
    generatorVersion: "1.3.17",
    ...(input.scheduleCacheRoot === undefined ? {} : {
      scheduleContentHash: sha256(canonicalJson(schedule ? {
        taskName: schedule.taskName,
        topicName: schedule.topicName,
        upstreamTaskIds: schedule.scheduleUpstreamTaskIds,
        upstreamTableReferences: schedule.upstreamTableReferences,
        downstreamTaskIds: schedule.scheduleDownstreamTaskIds,
      } : null)),
    }),
  };
}

export function taskLocalProjectionPath(outputRoot: string, taskId: string): string {
  return join(resolve(outputRoot), "tasks", taskId, "task-local-projection.json");
}

export function taskLocalProjectionVersionPath(outputRoot: string, taskId: string, cacheKey: string): string {
  return join(resolve(outputRoot), "tasks", taskId, "versions", `${cacheKey}.json`);
}

export function readTaskLocalCacheEnvelope(
  outputRoot: string,
  taskId: string,
): TaskLocalCacheEnvelope | null {
  const path = taskLocalProjectionPath(outputRoot, taskId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TaskLocalCacheEnvelope>;
    if (!parsed.cacheKey || !parsed.cacheKeyParts || !parsed.projection || !parsed.projectionContentHash) {
      return null;
    }
    canonicalizeTaskLocalProjection(parsed.projection);
    return parsed as TaskLocalCacheEnvelope;
  } catch {
    return null;
  }
}

export function writeTaskLocalCacheEnvelope(
  outputRoot: string,
  envelope: TaskLocalCacheEnvelope,
): string {
  const path = taskLocalProjectionPath(outputRoot, envelope.cacheKeyParts.taskId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${canonicalJson(envelope)}\n`, "utf8");
  ensureTaskLocalProjectionVersion(outputRoot,envelope);
  return path;
}

export function ensureTaskLocalProjectionVersion(outputRoot:string,envelope:TaskLocalCacheEnvelope):void {
  const version = taskLocalProjectionVersionPath(outputRoot, envelope.cacheKeyParts.taskId, envelope.cacheKey);
  mkdirSync(dirname(version), { recursive: true });
  if (!existsSync(version)) writeFileSync(version, `${canonicalJson(envelope)}\n`, { encoding: "utf8", flag: "wx" });
}

export function projectionBytesEqualIgnoringGeneratedAt(
  left: TaskLocalProjection,
  right: TaskLocalProjection,
): boolean {
  const normalize = (projection: TaskLocalProjection) => {
    const { generatedAt: _generatedAt, ...rest } = projection;
    return canonicalJson(rest);
  };
  return normalize(left) === normalize(right);
}

export function tryReadCachedTaskLocalProjection(input: {
  readonly currentBundle?: CurrentBundleLoad;
  readonly packContentHash?: string;
  readonly outputRoot: string;
  readonly taskId: string;
  readonly dataRoot: string;
  readonly factsRoot: string;
  readonly scheduleCacheRoot?: string;
}): {
  readonly hit: boolean;
  readonly cacheKey: string;
  readonly cacheKeyParts: TaskLocalCacheKeyParts;
  readonly envelope: TaskLocalCacheEnvelope | null;
} {
  const cacheKeyParts = resolveTaskLocalCacheKeyParts({
    currentBundle: input.currentBundle,
    packContentHash: input.packContentHash,
    taskId: input.taskId,
    dataRoot: input.dataRoot,
    factsRoot: input.factsRoot,
    scheduleCacheRoot: input.scheduleCacheRoot,
  });
  const cacheKey = taskLocalCacheKey(cacheKeyParts);
  const envelope = readTaskLocalCacheEnvelope(input.outputRoot, input.taskId);
  if (!envelope || envelope.cacheKey !== cacheKey) {
    return { hit: false, cacheKey, cacheKeyParts, envelope: null };
  }
  if (envelope.projectionContentHash !== envelope.projection.contentHash) {
    return { hit: false, cacheKey, cacheKeyParts, envelope: null };
  }
  return { hit: true, cacheKey, cacheKeyParts, envelope };
}

export function storeTaskLocalProjectionCache(input: {
  readonly outputRoot: string;
  readonly cacheKeyParts: TaskLocalCacheKeyParts;
  readonly projection: TaskLocalProjection;
}): TaskLocalCacheEnvelope {
  const envelope: TaskLocalCacheEnvelope = {
    cacheKey: taskLocalCacheKey(input.cacheKeyParts),
    cacheKeyParts: input.cacheKeyParts,
    projectionContentHash: input.projection.contentHash,
    projection: input.projection,
  };
  writeTaskLocalCacheEnvelope(input.outputRoot, envelope);
  return envelope;
}
