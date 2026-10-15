import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  assertExistingTableLayout,
  quarantineMalformedTableDirectories,
} from "../shared/input-pack.ts";
import {
  collectOneTask,
  findExcludedTaskIds,
  hasPhysicalTableEvidenceGap,
  partitionTaskIdsForCollection,
  relocateTaskPacks,
  taskCategory,
  type TaskCollectionSummary,
} from "./collect-one-task-input-pack.ts";
import {
  assertInputPackBatchSize,
  exitCodeForTaskBatch,
  INPUT_PACK_BATCH_SIZE_WARNING_THRESHOLD,
  runTaskBatch,
  StopTaskBatch,
} from "./task-batch.ts";
import {
  assertStatusFileOutsideDataRoot,
  canSkipSuccessfulTask,
  defaultTaskStatusFile,
  loadTaskStatus,
  saveTaskStatus,
  updateTaskStatus,
} from "./task-status.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

const STATUS_SIZE_WARNING_BYTES = 2 * 1024 * 1024;
const STATUS_SIZE_HARD_LIMIT_BYTES = 8 * 1024 * 1024;

function inspectStatusFile(path: string): {
  bytes: number | null;
  error?: string;
} {
  if (!existsSync(path)) return { bytes: null };
  try {
    return { bytes: statSync(path).size };
  } catch (error) {
    return {
      bytes: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isReusableSuccess(
  record: ReturnType<typeof loadTaskStatus>["tasks"][string] | undefined,
  dataRoot: string,
): boolean {
  if (!canSkipSuccessfulTask(record, dataRoot)) return false;
  if (record?.taskType === undefined || record.taskCategory === undefined)
    return true;
  return taskCategory(record.taskType, undefined) === record.taskCategory;
}

const dataRoot = requiredOption("--data-root");
const dataRootAbsolute = resolve(dataRoot);
const manualDataRoot = resolve(
  option("--manual-data-root") ?? `${resolve(dataRoot)}.manual-tasks`,
);
const notFoundDataRoot = resolve(
  option("--not-found-data-root") ?? `${resolve(dataRoot)}.not-found-tasks`,
);
function assertArchiveRootOutsideDataRoot(
  optionName: string,
  archiveRoot: string,
): void {
  const archiveRelative = relative(dataRootAbsolute, archiveRoot);
  if (
    archiveRoot === dataRootAbsolute ||
    (archiveRelative !== "" &&
      archiveRelative !== ".." &&
      !archiveRelative.startsWith(`..${sep}`) &&
      !isAbsolute(archiveRelative))
  )
    throw new Error(`${optionName} must be outside --data-root: ${archiveRoot}`);
}
assertArchiveRootOutsideDataRoot("--manual-data-root", manualDataRoot);
assertArchiveRootOutsideDataRoot("--not-found-data-root", notFoundDataRoot);
const force = process.argv.includes("--force");
const skipSchedulingDetail = process.argv.includes("--skip-scheduling-detail");
const skipSchedulingClassification = process.argv.includes(
  "--skip-scheduling-classification",
);
if (skipSchedulingClassification)
  console.error(
    JSON.stringify({
      collectionStatus: "SCHEDULING_CLASSIFICATION_SKIPPED",
      warning:
        "Manual/frozen tasks are not preclassified; use only for an explicit local missing-pack backfill",
    }),
  );
const statusFile = resolve(
  option("--status-file") ?? defaultTaskStatusFile(dataRoot),
);
assertStatusFileOutsideDataRoot(statusFile, dataRoot);
const taskIds = [
  ...new Set(
    requiredOption("--task-ids")
      .split(",")
      .map((taskId) => taskId.trim())
      .filter(Boolean),
  ),
];
if (taskIds.length === 0)
  throw new Error("--task-ids must contain at least one task id");
assertInputPackBatchSize(taskIds.length);
const batchSizeWarning =
  taskIds.length > INPUT_PACK_BATCH_SIZE_WARNING_THRESHOLD;
const initialStatusFile = inspectStatusFile(statusFile);
if (initialStatusFile.error)
  throw new Error(
    `Cannot stat Input Pack status file ${statusFile}: ${initialStatusFile.error}`,
  );
const initialStatusFileBytes = initialStatusFile.bytes;
const statusSizeWarning =
  initialStatusFileBytes !== null &&
  initialStatusFileBytes > STATUS_SIZE_WARNING_BYTES;
if (
  statusSizeWarning &&
  initialStatusFileBytes !== null &&
  initialStatusFileBytes > STATUS_SIZE_HARD_LIMIT_BYTES
)
  throw new Error(
    `Input Pack status file is too large (${initialStatusFileBytes} bytes); split the batch or compact the status file before collecting more tasks`,
  );
if (batchSizeWarning || statusSizeWarning)
  console.error(
    JSON.stringify({
      collectionStatus: "BATCH_SIZE_WARNING",
      taskCount: taskIds.length,
      threshold: INPUT_PACK_BATCH_SIZE_WARNING_THRESHOLD,
      statusFileBytes: initialStatusFileBytes,
      statusSizeWarning,
      message:
        "Large task batches or status files rewrite the operational checkpoint once per task; split the task IDs if this is unexpected",
    }),
  );
const status = loadTaskStatus(statusFile, dataRoot);
const knownExcludedTaskIds = new Set(
  force || skipSchedulingClassification
    ? []
    : taskIds.filter(
        (taskId) =>
          status.tasks[taskId]?.status === "EXCLUDED" &&
          status.tasks[taskId]?.exclusionReason !== undefined,
      ),
);
const excludedTaskInfo = skipSchedulingClassification
  ? new Map()
  : findExcludedTaskIds(
      taskIds.filter((taskId) => !knownExcludedTaskIds.has(taskId)),
      { skipDetail: skipSchedulingDetail },
    );
for (const taskId of knownExcludedTaskIds)
  excludedTaskInfo.set(taskId, {
    exclusionReason: status.tasks[taskId]!.exclusionReason!,
  });
const taskPartition = partitionTaskIdsForCollection(
  taskIds,
  excludedTaskInfo,
);
const excludedTaskIds = new Set([
  ...taskPartition.manualFrozenTaskIds,
  ...taskPartition.notFoundTaskIds,
]);
const notFoundTaskIds = new Set(taskPartition.notFoundTaskIds);
const manualFrozenTaskIds = new Set(taskPartition.manualFrozenTaskIds);
if (excludedTaskIds.size > 0)
  console.error(
    JSON.stringify({
      collectionStatus: "TASKS_EXCLUDED_FROM_INPUT_PACK",
      taskIds: [...excludedTaskIds].sort(),
      count: excludedTaskIds.size,
      notFoundTaskIds: [...notFoundTaskIds].sort(),
      manualFrozenTaskIds: [...manualFrozenTaskIds].sort(),
      source: "opencli:horae.search",
    }),
  );
const manualFrozenMoves = new Map<string, readonly string[]>();
for (const taskId of manualFrozenTaskIds) {
  const moved = relocateTaskPacks(dataRoot, manualDataRoot, taskId);
  manualFrozenMoves.set(taskId, moved);
  if (moved.length > 0)
    console.error(
      JSON.stringify({
        collectionStatus: "MANUAL_TASK_PACKS_RELOCATED",
        taskId,
        fromDataRoot: dataRootAbsolute,
        toDataRoot: manualDataRoot,
        moved,
      }),
    );
}
for (const taskId of notFoundTaskIds) {
  for (const fromDataRoot of [dataRoot, manualDataRoot]) {
    const moved = relocateTaskPacks(fromDataRoot, notFoundDataRoot, taskId);
    if (moved.length > 0)
      console.error(
        JSON.stringify({
          collectionStatus: "NOT_FOUND_TASK_PACKS_RELOCATED",
          taskId,
          fromDataRoot: resolve(fromDataRoot),
          toDataRoot: notFoundDataRoot,
          moved,
        }),
      );
  }
}
if (process.argv.includes("--repair-malformed-tables")) {
  const repair = quarantineMalformedTableDirectories(dataRoot);
  if (repair)
    console.error(
      JSON.stringify({
        malformedTablesQuarantined: repair.moved.length,
        quarantineRoot: repair.quarantineRoot,
        moved: repair.moved,
      }),
    );
}
assertExistingTableLayout(dataRoot);
assertExistingTableLayout(manualDataRoot);
assertExistingTableLayout(notFoundDataRoot);
let statusPersistenceError: string | undefined;
let statusSizeExceeded = false;
function persistStatus(record: Parameters<typeof updateTaskStatus>[1]): void {
  updateTaskStatus(status, record);
  let saved = false;
  try {
    saveTaskStatus(statusFile, status);
    saved = true;
  } catch (error) {
    statusPersistenceError ??=
      error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        collectionStatus: "STATUS_PERSISTENCE_FAILED",
        statusFile,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  if (saved) {
    const checkpoint = inspectStatusFile(statusFile);
    if (checkpoint.error || checkpoint.bytes === null) {
      statusPersistenceError ??=
        checkpoint.error ?? "status file disappeared after checkpoint";
      console.error(
        JSON.stringify({
          collectionStatus: "STATUS_PERSISTENCE_FAILED",
          statusFile,
          error: statusPersistenceError,
        }),
      );
      return;
    }
    if (checkpoint.bytes > STATUS_SIZE_HARD_LIMIT_BYTES) {
      statusSizeExceeded = true;
      throw new StopTaskBatch(
        `Input Pack status file exceeded ${STATUS_SIZE_HARD_LIMIT_BYTES} bytes after task ${record.taskId}; split the remaining task IDs`,
      );
    }
  }
}
for (const taskId of notFoundTaskIds) {
  const previous = status.tasks[taskId];
  const exclusionReason =
    excludedTaskInfo.get(taskId)?.exclusionReason ===
    "PHYSICAL_TABLE_NOT_FOUND"
      ? "PHYSICAL_TABLE_NOT_FOUND"
      : "HORAE_TASK_NOT_FOUND";
  if (
    previous?.status === "EXCLUDED" &&
    previous.exclusionReason === exclusionReason &&
    !force
  )
    continue;
  persistStatus({
    taskId,
    status: "EXCLUDED",
    exclusionReason,
    changed: false,
    warnings: [],
    staleLegacyTaskDirectories: [],
  });
  console.log(
    JSON.stringify({
      taskId,
      collectionStatus: "EXCLUDED",
      reason: exclusionReason,
      archiveRoot: notFoundDataRoot,
    }),
  );
}
for (const taskId of manualFrozenTaskIds) {
  const previous = status.tasks[taskId];
  const moved = manualFrozenMoves.get(taskId) ?? [];
  if (
    previous?.status === "EXCLUDED" &&
    previous.exclusionReason === "MANUAL_OR_FROZEN" &&
    moved.length === 0 &&
    !force
  )
    continue;
  persistStatus({
    taskId,
    status: "EXCLUDED",
    exclusionReason: "MANUAL_OR_FROZEN",
    changed: moved.length > 0,
    directory: moved[0] === undefined ? undefined : resolve(moved[0]),
    tablesWritten: 0,
    tableAssets: [],
    warnings: [],
    staleLegacyTaskDirectories: [],
  });
  console.log(
    JSON.stringify({
      taskId,
      collectionStatus: "EXCLUDED",
      reason: "MANUAL_OR_FROZEN",
      archiveRoot: manualDataRoot,
      moved,
    }),
  );
}
const skippedTaskIds: string[] = [];
const runnableTaskIds = taskPartition.runnableTaskIds.filter((taskId) => {
  const taskDataRoot = manualFrozenTaskIds.has(taskId)
    ? manualDataRoot
    : dataRoot;
  const reusable =
    !force &&
    isReusableSuccess(status.tasks[taskId], taskDataRoot);
  if (reusable) {
    skippedTaskIds.push(taskId);
    console.log(
      JSON.stringify({
        taskId,
        collectionStatus: "SKIPPED",
        reason: "PREVIOUS_SUCCESS",
        directory: status.tasks[taskId]!.directory,
      }),
    );
  }
  return !reusable;
});

const hadFailure = runTaskBatch(
  dataRoot,
  runnableTaskIds,
  (root, taskId) => {
    const taskDataRoot = manualFrozenTaskIds.has(taskId)
      ? manualDataRoot
      : root;
    const summary = collectOneTask(taskDataRoot, taskId, {
      ...(excludedTaskInfo.get(taskId) ?? {}),
    });
    const persisted: TaskCollectionSummary = summary;
    const physicalTableNotFound = hasPhysicalTableEvidenceGap(persisted);
    if (physicalTableNotFound) {
      const moved = relocateTaskPacks(
        taskDataRoot,
        notFoundDataRoot,
        taskId,
      );
      excludedTaskIds.add(taskId);
      notFoundTaskIds.add(taskId);
      persistStatus({
        taskId,
        status: "EXCLUDED",
        exclusionReason: "PHYSICAL_TABLE_NOT_FOUND",
        directory:
          moved.length > 0
            ? resolve(moved[0]!)
            : resolve(persisted.directory),
        changed: persisted.changed,
        contentHash: persisted.contentHash,
        tablesWritten: 0,
        tableAssets: [],
        tablesUnavailable: persisted.tablesUnavailable,
        tableReferencesUnavailable: persisted.tableReferencesUnavailable,
        warnings: persisted.warnings,
        staleLegacyTaskDirectories: persisted.staleLegacyTaskDirectories,
      });
      console.error(
        JSON.stringify({
          taskId,
          collectionStatus: "TASK_EXCLUDED_PHYSICAL_TABLE_NOT_FOUND",
          fromDataRoot: taskDataRoot,
          toDataRoot: notFoundDataRoot,
          moved,
          tablesUnavailable: persisted.tablesUnavailable,
          tableReferencesUnavailable: persisted.tableReferencesUnavailable,
        }),
      );
      return summary;
    }
    persistStatus({
      taskId,
      status: persisted.collectionStatus,
      taskCategory: persisted.taskCategory,
      taskType: persisted.taskType,
      directory: resolve(persisted.directory),
      changed: persisted.changed,
      contentHash: persisted.contentHash,
      tablesWritten: persisted.tablesWritten,
      tableAssets: persisted.tableAssets,
      tablesUnavailable: persisted.tablesUnavailable,
      tableReferencesUnavailable: persisted.tableReferencesUnavailable,
      warnings: persisted.warnings,
      staleLegacyTaskDirectories: persisted.staleLegacyTaskDirectories,
    });
    return summary;
  },
  (taskId, error) => {
    const details =
      error && typeof error === "object"
        ? (error as {
            writePhase?: string;
            taskDirectory?: string;
            taskChanged?: boolean;
          })
        : {};
    persistStatus({
      taskId,
      status: "FAILED",
      directory:
        details.taskDirectory === undefined
          ? undefined
          : resolve(details.taskDirectory),
      changed: details.taskChanged,
      warnings: [],
      staleLegacyTaskDirectories: [],
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(
      JSON.stringify({
        taskId,
        collectionStatus: "FAILED",
        error: error instanceof Error ? error.message : String(error),
        writePhase: details.writePhase,
        taskCommitted: details.writePhase === "TABLE_AFTER_TASK_COMMITTED",
        taskDirectory: details.taskDirectory,
        taskChanged: details.taskChanged,
      }),
    );
  },
);

const currentRecords = taskIds.map((taskId) => status.tasks[taskId]);
const finalStatusFile = inspectStatusFile(statusFile);
if (finalStatusFile.error) statusPersistenceError ??= finalStatusFile.error;
const finalStatusFileBytes = finalStatusFile.bytes;
const statusSummary = {
  statusFile,
  manualDataRoot,
  notFoundDataRoot,
  excludedTaskIds: [...excludedTaskIds].sort(),
  notFoundTaskIds: [...notFoundTaskIds].sort(),
  total: taskIds.length,
  batchSizeWarning,
  statusSizeWarning,
  initialStatusFileBytes,
  finalStatusFileBytes,
  statusFileBytes: finalStatusFileBytes,
  finalStatusFileError: finalStatusFile.error,
  statusSizeExceeded,
  success: taskIds.filter(
    (taskId) => status.tasks[taskId]?.status === "SUCCESS",
  ),
  partial: taskIds.filter(
    (taskId) => status.tasks[taskId]?.status === "PARTIAL",
  ),
  cleanSuccess: taskIds.filter((taskId) => {
    const record = status.tasks[taskId];
    const taskDataRoot = manualFrozenTaskIds.has(taskId)
      ? manualDataRoot
      : dataRoot;
    return (
      record?.status === "SUCCESS" && isReusableSuccess(record, taskDataRoot)
    );
  }),
  successWithWarnings: taskIds.filter((taskId) => {
    const record = status.tasks[taskId];
    return (
      record?.status === "SUCCESS" &&
      ((record.warnings?.length ?? 0) > 0 ||
        (record.staleLegacyTaskDirectories?.length ?? 0) > 0)
    );
  }),
  successNeedingRefresh: taskIds.filter((taskId) => {
    const record = status.tasks[taskId];
    return (
      record?.status === "SUCCESS" &&
      (record.warnings?.length ?? 0) === 0 &&
      (record.staleLegacyTaskDirectories?.length ?? 0) === 0 &&
      !isReusableSuccess(
        record,
        manualFrozenTaskIds.has(taskId) ? manualDataRoot : dataRoot,
      )
    );
  }),
  failed: taskIds.filter((taskId) => status.tasks[taskId]?.status === "FAILED"),
  excluded: taskIds.filter(
    (taskId) => status.tasks[taskId]?.status === "EXCLUDED",
  ),
  skipped: skippedTaskIds,
  statusPersistenceFailed: statusPersistenceError !== undefined,
  statusPersistenceError,
  statusRecords: currentRecords.filter(
    (record): record is NonNullable<typeof record> => record !== undefined,
  ).length,
};
console.log(JSON.stringify({ collectionStatusSummary: statusSummary }));

const exitCode = exitCodeForTaskBatch(
  hadFailure || statusPersistenceError !== undefined || statusSizeExceeded,
);
if (exitCode !== 0) process.exitCode = exitCode;
