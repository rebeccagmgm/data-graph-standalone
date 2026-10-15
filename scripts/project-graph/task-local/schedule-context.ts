import {
  readHoraeRelationCache,
  readHoraeTaskTypeCache,
} from "../../evidence/schedule-evidence-cache.ts";
import taskTypeCodeMap from "../../input/shared/task-type-map.json" with { type: "json" };

const TASK_TYPE_CODE_MAP: Readonly<Record<string, string>> = taskTypeCodeMap;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function detailField(detail: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const direct = text(detail[key]);
    if (direct) return direct;
    const nested = key.split(".").reduce<unknown>(
      (current, segment) => record(current)?.[segment],
      detail,
    );
    const nestedText = text(nested);
    if (nestedText) return nestedText;
  }
  return null;
}

function neighborTaskIds(
  rows: readonly Record<string, unknown>[],
  selfTaskId: string,
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const neighborId = text(row.task_id ?? row.taskId);
    if (neighborId && neighborId !== selfTaskId) ids.add(neighborId);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

export const SCHEDULE_REFERENCE_ROLE = "SCHEDULE_REFERENCE_ONLY" as const;

export interface ScheduleTableReference {
  readonly taskId: string;
  readonly qualifiedName: string;
}

export interface ScheduleReference {
  readonly role: typeof SCHEDULE_REFERENCE_ROLE;
  readonly topicName: string | null;
  readonly taskName: string | null;
  readonly upstreamTaskIds: readonly string[];
  /** Exact table names carried on individual upstream Horae relation rows. */
  readonly upstreamTableReferences: readonly ScheduleTableReference[];
  readonly downstreamTaskIds: readonly string[];
  readonly source: "schedule-evidence-cache";
  readonly observedAt: string | null;
}

export interface TaskScheduleContext {
  readonly inSchedule: boolean;
  readonly taskName: string | null;
  readonly topicName: string | null;
  readonly scheduleUpstreamTaskIds: readonly string[];
  readonly upstreamTableReferences: readonly ScheduleTableReference[];
  readonly scheduleDownstreamTaskIds: readonly string[];
  readonly observedAt: string | null;
  readonly scheduleReference: ScheduleReference;
}

export function buildScheduleReference(input: {
  readonly topicName: string | null;
  readonly taskName: string | null;
  readonly upstreamTaskIds: readonly string[];
  readonly upstreamTableReferences: readonly ScheduleTableReference[];
  readonly downstreamTaskIds: readonly string[];
  readonly observedAt: string | null;
}): ScheduleReference {
  return {
    role: SCHEDULE_REFERENCE_ROLE,
    topicName: input.topicName,
    taskName: input.taskName,
    upstreamTaskIds: [...input.upstreamTaskIds],
    upstreamTableReferences: [...input.upstreamTableReferences],
    downstreamTaskIds: [...input.downstreamTaskIds],
    source: "schedule-evidence-cache",
    observedAt: input.observedAt,
  };
}

function scheduleTableReferences(
  rows: readonly Record<string, unknown>[],
  selfTaskId: string,
): ScheduleTableReference[] {
  const result = new Map<string, ScheduleTableReference>();
  for (const row of rows) {
    const taskId = text(row.task_id ?? row.taskId);
    if (!taskId || taskId === selfTaskId) continue;
    const qualifiedName = detailField(row, [
      "targetTable",
      "target_table",
      "qualifiedName",
      "qualified_name",
      "tableName",
      "table_name",
      "task_name",
      "taskName",
    ]);
    if (!qualifiedName || !/^[A-Za-z0-9_$`"\[\]-]+(?:\.[A-Za-z0-9_$`"\[\]-]+)+$/u.test(qualifiedName))
      continue;
    result.set(`${taskId}\u0000${qualifiedName.toLowerCase()}`, { taskId, qualifiedName });
  }
  return [...result.values()].sort((left, right) =>
    `${left.taskId}\u0000${left.qualifiedName}`.localeCompare(
      `${right.taskId}\u0000${right.qualifiedName}`,
    ),
  );
}

export function readTaskCategoryFromScheduleCache(
  taskId: string,
  scheduleCacheRoot: string | undefined,
): string | null {
  if (!scheduleCacheRoot) return null;
  const taskType = readHoraeTaskTypeCache(taskId, scheduleCacheRoot);
  if (taskType.status !== "HIT") return null;
  const raw =
    detailField(taskType.detail, ["taskType", "task_type", "taskCategory"])
    ?? null;
  if (!raw) return null;
  return TASK_TYPE_CODE_MAP[raw] ?? raw;
}

export function readTaskScheduleContext(
  taskId: string,
  scheduleCacheRoot: string | undefined,
): TaskScheduleContext | null {
  if (!scheduleCacheRoot) return null;
  const taskType = readHoraeTaskTypeCache(taskId, scheduleCacheRoot);
  const up = readHoraeRelationCache(taskId, scheduleCacheRoot, "up");
  const down = readHoraeRelationCache(taskId, scheduleCacheRoot, "down");
  const inSchedule =
    taskType.status === "HIT" || up.status === "HIT" || down.status === "HIT";
  if (!inSchedule) return null;

  const detail = taskType.status === "HIT" ? taskType.detail : {};
  const upstreamTaskIds = up.status === "HIT" ? neighborTaskIds(up.rows, taskId) : [];
  const upstreamTableReferences = up.status === "HIT"
    ? scheduleTableReferences(up.rows, taskId)
    : [];
  const downstreamTaskIds = down.status === "HIT" ? neighborTaskIds(down.rows, taskId) : [];
  const observedCandidates = [
    taskType.status === "HIT" ? taskType.observedAt : null,
    up.status === "HIT" ? up.observedAt : null,
    down.status === "HIT" ? down.observedAt : null,
  ].filter((value): value is string => value !== null);
  const observedAt = observedCandidates.sort().at(-1) ?? null;
  const topicName = detailField(detail, ["topicName", "topic_name", "topic"]);
  // Legacy task-type evidence stores taskDesc in `name`; it is not a task name.
  const taskName = detailField(detail, ["taskName", "task_name"]);

  return {
    inSchedule: true,
    taskName,
    topicName,
    scheduleUpstreamTaskIds: upstreamTaskIds,
    upstreamTableReferences,
    scheduleDownstreamTaskIds: downstreamTaskIds,
    observedAt,
    scheduleReference: buildScheduleReference({
      topicName,
      taskName,
      upstreamTaskIds,
      upstreamTableReferences,
      downstreamTaskIds,
      observedAt,
    }),
  };
}
