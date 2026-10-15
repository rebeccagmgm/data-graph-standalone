import {
  fillSzdataScheduleDetailCache,
  taskIdsFromScheduleEvidenceCache,
} from "./fill-szdata-schedule-detail-cache.ts";
import {
  parseTaskIdOrder,
  type TaskIdOrder,
} from "./fill-horae-relation-cache.ts";
import { DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT } from "./szdata-schedule-detail-cache.ts";
import { readHoraeTaskTypeCache } from "../../evidence/schedule-evidence-cache.ts";

const SPARK_INDEX_TASK_TYPE = "sparkIndex";
const DEFAULT_MIN_INTERVAL_MS = 2_000;

/**
 * Select only tasks whose validated Horae task-type cache identifies them as
 * SparkIndex tasks. Missing or invalid task-type evidence is not guessed.
 */
export function sparkIndexTaskIdsFromHoraeTypeCache(
  cacheRoot: string,
): string[] {
  return taskIdsFromScheduleEvidenceCache(cacheRoot).filter((taskId) => {
    const cached = readHoraeTaskTypeCache(taskId, cacheRoot);
    return cached.status === "HIT" && cached.detail.taskType === SPARK_INDEX_TASK_TYPE;
  });
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function parseIntegerOption(
  name: string,
  fallback: number | undefined,
  allowZero: boolean,
): number | undefined {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1))
    throw new Error(`${name.slice(2).toUpperCase().replaceAll("-", "_")}_INVALID`);
  return value;
}

async function main(): Promise<void> {
  const cacheRoot = option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const order: TaskIdOrder = parseTaskIdOrder(option("--order"));
  const taskIds = sparkIndexTaskIdsFromHoraeTypeCache(cacheRoot);
  process.stderr.write(
    `[sparkindex-schedule-detail-cache] start ${JSON.stringify({
      total: taskIds.length,
      cacheRoot,
      taskType: SPARK_INDEX_TASK_TYPE,
      order,
      minIntervalMs: parseIntegerOption(
        "--interval-ms",
        DEFAULT_MIN_INTERVAL_MS,
        true,
      ),
    })}\n`,
  );
  const summary = await fillSzdataScheduleDetailCache({
    cacheRoot,
    taskIds,
    order,
    limit: parseIntegerOption("--limit", undefined, false),
    maxErrors: parseIntegerOption("--max-errors", undefined, false),
    minIntervalMs: parseIntegerOption(
      "--interval-ms",
      DEFAULT_MIN_INTERVAL_MS,
      true,
    ),
  });
  process.stdout.write(
    `${JSON.stringify({
      scope: "sparkIndex",
      taskTypeEvidence: "horae-task-type.json",
      taskType: SPARK_INDEX_TASK_TYPE,
      ...summary,
    })}\n`,
  );
  if (summary.errors > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("fill-sparkindex-schedule-detail-cache.ts")) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
