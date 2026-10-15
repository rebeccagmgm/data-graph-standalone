import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { HoraeSerialGate } from "./collect-one-task-input-pack-sparkindex.ts";
import { fillHoraeTaskDetailCache } from "./fill-horae-task-detail-cache.ts";
import {
  taskIdsFromFile,
  taskIdsFromScheduleEvidenceCache,
} from "./fill-horae-relation-cache.ts";
import {
  readHoraeRelationCache,
  readHoraeTaskTypeCache,
  resolveScheduleEvidenceCacheRoot,
} from "../../evidence/schedule-evidence-cache.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_MAX_ERRORS = 10;
const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_ROUND_INTERVAL_MS = 60_000;
const DEFAULT_EXCLUDE_FILE = "fill-remaining/missing-horae-task-type.txt";

type HoraeRecord = Record<string, unknown>;

export interface UpstreamTaskTypeDiscovery {
  readonly relationCacheFiles: number;
  readonly relationCacheHits: number;
  readonly invalidRelationCaches: number;
  readonly upstreamTaskIds: readonly string[];
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  code: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
  code: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function taskIdFromRow(row: HoraeRecord): string | undefined {
  const value = row.task_id ?? row.taskId;
  if (typeof value !== "string") return undefined;
  const taskId = value.trim();
  return SAFE_TASK_ID.test(taskId) ? taskId : undefined;
}

/** Discover upstream task ids from already cached up-relation evidence only. */
export function discoverUpstreamTaskIds(
  cacheRoot: string,
): UpstreamTaskTypeDiscovery {
  const sourceTaskIds = taskIdsFromScheduleEvidenceCache(cacheRoot);
  const upstreamTaskIds = new Set<string>();
  let relationCacheFiles = 0;
  let relationCacheHits = 0;
  let invalidRelationCaches = 0;

  for (const sourceTaskId of sourceTaskIds) {
    const path = join(
      resolveScheduleEvidenceCacheRoot(cacheRoot),
      "tasks",
      sourceTaskId,
      "horae-relation-up-depth-1.json",
    );
    if (!existsSync(path)) continue;
    relationCacheFiles += 1;
    const relation = readHoraeRelationCache(sourceTaskId, cacheRoot, "up");
    if (relation.status !== "HIT") {
      invalidRelationCaches += 1;
      continue;
    }
    relationCacheHits += 1;
    for (const row of relation.rows) {
      const taskId = taskIdFromRow(row);
      if (taskId !== undefined) upstreamTaskIds.add(taskId);
    }
  }

  return {
    relationCacheFiles,
    relationCacheHits,
    invalidRelationCaches,
    upstreamTaskIds: [...upstreamTaskIds].sort((left, right) =>
      left.localeCompare(right, "en-US", { numeric: true }),
    ),
  };
}

export function missingUpstreamTaskIds(
  cacheRoot: string,
  upstreamTaskIds: readonly string[],
  excludedTaskIds: ReadonlySet<string>,
): string[] {
  return upstreamTaskIds.filter(
    (taskId) =>
      !excludedTaskIds.has(taskId) &&
      readHoraeTaskTypeCache(taskId, cacheRoot).status !== "HIT",
  );
}

function logLine(logPath: string, event: string, payload: unknown): void {
  appendFileSync(
    logPath,
    `${new Date().toISOString()} ${event} ${JSON.stringify(payload)}\n`,
    "utf8",
  );
}

function acquireLock(lockPath: string): () => void {
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      "utf8",
    );
    closeSync(fd);
    return () => {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = "unknown";
    try {
      owner = readFileSync(lockPath, "utf8");
    } catch {
      // Preserve the lock error below when the owner file cannot be read.
    }
    throw new Error(`UPSTREAM_TASK_TYPE_LOOP_ALREADY_RUNNING:${owner}`);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const cacheRoot = option("--cache-root");
  if (cacheRoot === undefined) throw new Error("CACHE_ROOT_REQUIRED");
  const evidenceRoot = resolveScheduleEvidenceCacheRoot(cacheRoot);
  const maxErrors = positiveInteger(
    option("--max-errors"),
    DEFAULT_MAX_ERRORS,
    "MAX_ERRORS_INVALID",
  );
  const minIntervalMs = nonNegativeInteger(
    option("--interval-ms"),
    DEFAULT_MIN_INTERVAL_MS,
    "HORAE_DETAIL_MIN_INTERVAL_INVALID",
  );
  const roundIntervalMs = nonNegativeInteger(
    option("--round-interval-ms"),
    DEFAULT_ROUND_INTERVAL_MS,
    "ROUND_INTERVAL_INVALID",
  );
  const excludePath =
    option("--exclude-task-ids-file") ??
    join(evidenceRoot, DEFAULT_EXCLUDE_FILE);
  const logPath =
    option("--log-file") ??
    join(evidenceRoot, "upstream-task-type-evidence-loop.log");
  const lockPath =
    option("--lock-file") ??
    join(evidenceRoot, "upstream-task-type-evidence-loop.lock");
  const once = process.argv.includes("--once");

  const releaseLock = acquireLock(lockPath);
  const gate = new HoraeSerialGate({ minIntervalMs });
  let cumulativeErrors = 0;
  let round = 0;
  try {
    logLine(logPath, "START", {
      cacheRoot,
      excludePath,
      maxErrors,
      minIntervalMs,
      roundIntervalMs,
      once,
    });
    while (true) {
      round += 1;
      const excludedTaskIds = new Set(
        existsSync(excludePath) ? taskIdsFromFile(excludePath) : [],
      );
      const discovery = discoverUpstreamTaskIds(cacheRoot);
      const candidates = missingUpstreamTaskIds(
        cacheRoot,
        discovery.upstreamTaskIds,
        excludedTaskIds,
      );
      logLine(logPath, "ROUND", {
        round,
        relationCacheFiles: discovery.relationCacheFiles,
        relationCacheHits: discovery.relationCacheHits,
        invalidRelationCaches: discovery.invalidRelationCaches,
        upstreamTaskIds: discovery.upstreamTaskIds.length,
        excluded: excludedTaskIds.size,
        candidates: candidates.length,
        cumulativeErrors,
      });

      if (cumulativeErrors >= maxErrors) break;
      if (candidates.length > 0) {
        const summary = await fillHoraeTaskDetailCache({
          cacheRoot,
          taskIds: candidates,
          maxErrors: maxErrors - cumulativeErrors,
          minIntervalMs,
          gate,
        });
        cumulativeErrors += summary.errors;
        logLine(logPath, "FILL", {
          round,
          total: summary.total,
          skipped: summary.skipped,
          cached: summary.cached,
          errors: summary.errors,
          cumulativeErrors,
          stopped: summary.stopped,
          failedTaskIds: summary.failedTaskIds,
        });
        if (summary.stopped || cumulativeErrors >= maxErrors) break;
      }

      if (once) break;
      await sleep(roundIntervalMs);
    }
    const stopped = cumulativeErrors >= maxErrors;
    logLine(logPath, stopped ? "STOPPED" : "EXIT", {
      cumulativeErrors,
      maxErrors,
      reason: stopped ? "MAX_ERRORS_REACHED" : once ? "ONCE" : "UNKNOWN",
    });
    if (stopped) process.exitCode = 1;
  } finally {
    releaseLock();
  }
}

if (process.argv[1]?.endsWith("fill-upstream-task-type-evidence-loop.ts")) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
