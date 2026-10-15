import type { CurrentBundleLoad } from "../../query/current-task-bundle.ts";
import type { CoverageDisposition } from "./coverage-disposition.ts";
import { resolveCoverageDisposition } from "./coverage-disposition.ts";
import {
  canonicalizeTaskLocalProjection,
  TASK_LOCAL_PROJECTION_SCHEMA_VERSION,
  type TaskLocalFailureReasonCode,
  type TaskLocalProjection,
} from "./contract.ts";
import { taskNodeId } from "./ids.ts";
import type { TaskScheduleContext } from "./schedule-context.ts";

export function failureReasonFromLoad(load: CurrentBundleLoad): TaskLocalFailureReasonCode {
  if (load.issues.some((issue) => issue.startsWith("TASK_NOT_INDEXED"))) return "FACTS_UNAVAILABLE";
  if (load.issues.some((issue) => issue.startsWith("CURRENT_INDEX_MISSING"))) return "FACTS_UNAVAILABLE";
  if (load.issues.some((issue) => issue.startsWith("STATUS_OR_MANIFEST"))) return "FACTS_STALE";
  if (load.state === "INVALID") return "FACTS_INVALID";
  if (load.state === "STALE") return "FACTS_STALE";
  return "FACTS_UNAVAILABLE";
}

export function factsEvidenceStatus(
  load: CurrentBundleLoad,
): "CONFIRMED" | "PROVISIONAL_LEGACY" | null {
  if (load.state === "CURRENT_L1") return "CONFIRMED";
  if (load.state === "LEGACY_NOT_L1") return "PROVISIONAL_LEGACY";
  return null;
}

export function taskNodeProperties(input: {
  readonly packTaskName?: string | null;
  readonly schedule?: TaskScheduleContext | null;
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const taskName = input.schedule?.taskName ?? input.packTaskName ?? null;
  if (taskName) properties.taskName = taskName;
  if (input.schedule?.topicName) properties.topicName = input.schedule.topicName;
  if (input.schedule) properties.scheduleReference = input.schedule.scheduleReference;
  return properties;
}

export function buildScheduleOnlyProjection(input: {
  readonly taskId: string;
  readonly generatedAt: string;
  readonly schedule: TaskScheduleContext;
  readonly taskCategory?: string | null;
}): TaskLocalProjection {
  const taskCategory = input.taskCategory ?? null;
  return canonicalizeTaskLocalProjection({
    schemaVersion: TASK_LOCAL_PROJECTION_SCHEMA_VERSION,
    artifactType: "TASK_LOCAL_PROJECTION",
    generatedAt: input.generatedAt,
    taskId: input.taskId,
    taskCategory,
    coverageStatus: "SCHEDULE_ONLY",
    coverageDisposition: resolveCoverageDisposition({
      taskCategory,
      coverageStatus: "SCHEDULE_ONLY",
    }),
    failureReasonCode: null,
    nodes: [{
      nodeId: taskNodeId(input.taskId),
      nodeType: "TASK",
      properties: {
        ...taskNodeProperties({ schedule: input.schedule }),
        ...(taskCategory ? { taskCategory } : {}),
        coverageDisposition: resolveCoverageDisposition({
          taskCategory,
          coverageStatus: "SCHEDULE_ONLY",
        }),
        coverageExpectation:
          resolveCoverageDisposition({
            taskCategory,
            coverageStatus: "SCHEDULE_ONLY",
          }) === "EXPECTED_SCHEDULE_REFERENCE"
            ? "SCHEDULE_REFERENCE_ONLY"
            : "MATERIAL_GAP",
      },
    }],
    edges: [],
    gaps: [],
  });
}

export function buildCollectionFailedProjection(input: {
  readonly taskId: string;
  readonly generatedAt: string;
  readonly failureReasonCode: TaskLocalFailureReasonCode;
  readonly taskCategory?: string | null;
  readonly taskProperties?: Readonly<Record<string, unknown>>;
  readonly failureMessage?: string;
}): TaskLocalProjection {
  const taskCategory = input.taskCategory ?? null;
  const coverageDisposition = resolveCoverageDisposition({
    taskCategory,
    coverageStatus: "COLLECTION_FAILED",
  });
  return canonicalizeTaskLocalProjection({
    schemaVersion: TASK_LOCAL_PROJECTION_SCHEMA_VERSION,
    artifactType: "TASK_LOCAL_PROJECTION",
    generatedAt: input.generatedAt,
    taskId: input.taskId,
    taskCategory,
    coverageStatus: "COLLECTION_FAILED",
    coverageDisposition,
    failureReasonCode: input.failureReasonCode,
    nodes: [{
      nodeId: taskNodeId(input.taskId),
      nodeType: "TASK",
      properties: {
        ...(input.taskProperties ?? {}),
        ...(taskCategory ? { taskCategory } : {}),
        coverageDisposition,
        coverageExpectation:
          coverageDisposition === "EXPECTED_SCHEDULE_REFERENCE"
            ? "SCHEDULE_REFERENCE_ONLY"
            : "MATERIAL_GAP",
      },
    }],
    edges: [],
    gaps: input.failureMessage
      ? [{
          gapId: `projection-failed:${input.taskId}`,
          reasonCode: input.failureReasonCode,
          details: { message: input.failureMessage },
        }]
      : [],
  });
}
