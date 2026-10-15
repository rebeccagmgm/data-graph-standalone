import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  readHoraeTaskTypeCache,
  resolveScheduleEvidenceCacheRoot,
} from "../../evidence/schedule-evidence-cache.ts";
import { readTaskScheduleContext } from "./schedule-context.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTopic(value: string): string {
  return value.trim().toLowerCase();
}

export function listScheduleCacheTaskIds(scheduleCacheRoot: string): string[] {
  const tasksRoot = join(resolveScheduleEvidenceCacheRoot(scheduleCacheRoot), "tasks");
  if (!existsSync(tasksRoot)) return [];
  return readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_TASK_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en-US", { numeric: true }));
}

export function topicNameForCachedTask(
  taskId: string,
  scheduleCacheRoot: string,
): string | null {
  const taskType = readHoraeTaskTypeCache(taskId, scheduleCacheRoot);
  if (taskType.status !== "HIT") {
    return readTaskScheduleContext(taskId, scheduleCacheRoot)?.topicName ?? null;
  }
  const detail = taskType.detail;
  for (const key of ["topicName", "topic_name", "topic"]) {
    const direct = text(detail[key]);
    if (direct) return direct;
  }
  return null;
}

export function selectTaskLocalBatchTaskIds(input: {
  readonly scheduleCacheRoot: string;
  readonly topic?: string;
  readonly taskIds?: readonly string[];
  readonly alsoTaskIds?: readonly string[];
}): {
  readonly anchorTaskIds: readonly string[];
  readonly topicTaskIds: readonly string[];
  readonly alsoTaskIds: readonly string[];
  readonly taskIds: readonly string[];
} {
  const anchorTaskIds = [...new Set(
    (input.taskIds ?? [])
      .map((value) => value.trim())
      .filter((value) => SAFE_TASK_ID.test(value)),
  )].sort((left, right) => left.localeCompare(right, "en-US", { numeric: true }));

  const allCached = listScheduleCacheTaskIds(input.scheduleCacheRoot);
  const topic = input.topic ? normalizeTopic(input.topic) : null;
  const topicTaskIds = topic
    ? allCached.filter((taskId) => {
        const topicName = topicNameForCachedTask(taskId, input.scheduleCacheRoot);
        return topicName !== null && normalizeTopic(topicName) === topic;
      })
    : anchorTaskIds.length > 0
      ? []
      : [...allCached];

  const alsoTaskIds = [...new Set(
    (input.alsoTaskIds ?? [])
      .map((value) => value.trim())
      .filter((value) => SAFE_TASK_ID.test(value)),
  )].sort((left, right) => left.localeCompare(right, "en-US", { numeric: true }));

  const taskIds = [...new Set([...anchorTaskIds, ...topicTaskIds, ...alsoTaskIds])]
    .sort((left, right) => left.localeCompare(right, "en-US", { numeric: true }));

  return { anchorTaskIds, topicTaskIds, alsoTaskIds, taskIds };
}
