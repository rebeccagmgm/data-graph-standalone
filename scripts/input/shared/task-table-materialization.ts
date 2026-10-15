import {
  writeTableInput,
  writeTaskInput,
  type TableEvidence,
  type TaskEvidence,
  type WriteResult,
} from "./input-pack.ts";

export interface TaskTableMaterializationResult {
  readonly task: WriteResult;
  readonly tables: readonly WriteResult[];
}

/**
 * Commit a Task Pack first, then its Table Packs. Keeping this boundary shared
 * makes the post-task write failure contract identical for generic and
 * specialized collectors.
 */
export function materializeTaskAndTablePacks(
  dataRoot: string,
  taskEvidence: TaskEvidence,
  tables: readonly TableEvidence[],
): TaskTableMaterializationResult {
  const task = writeTaskInput(dataRoot, taskEvidence);
  try {
    const tableWrites = tables.map((evidence) =>
      writeTableInput(dataRoot, evidence),
    );
    return { task, tables: tableWrites };
  } catch (error) {
    const failure = new Error("Table write failed after Task commit", {
      cause: error,
    }) as Error & {
      writePhase: string;
      taskDirectory: string;
      taskChanged: boolean;
    };
    failure.writePhase = "TABLE_AFTER_TASK_COMMITTED";
    failure.taskDirectory = task.directory;
    failure.taskChanged = task.changed;
    throw failure;
  }
}
