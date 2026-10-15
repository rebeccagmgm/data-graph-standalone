export type TaskCollector = (dataRoot: string, taskId: string) => unknown;

export type TaskFailureReporter = (taskId: string, error: unknown) => void;

export const INPUT_PACK_BATCH_SIZE_WARNING_THRESHOLD = 100;
export const INPUT_PACK_BATCH_SIZE_HARD_LIMIT = 1000;

export function assertInputPackBatchSize(taskCount: number): void {
  if (taskCount > INPUT_PACK_BATCH_SIZE_HARD_LIMIT)
    throw new Error(
      `Too many task IDs (${taskCount}); split the batch into at most ${INPUT_PACK_BATCH_SIZE_HARD_LIMIT} task IDs`,
    );
}

export class StopTaskBatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopTaskBatch";
  }
}

export function exitCodeForTaskBatch(hadFailure: boolean): number {
  return hadFailure ? 1 : 0;
}

/**
 * Runs task IDs independently. The caller owns the rate limiter used by the
 * collector; this function deliberately remains sequential and only controls
 * failure isolation and the aggregate exit signal.
 */
export function runTaskBatch(
  dataRoot: string,
  taskIds: readonly string[],
  collectTask: TaskCollector,
  reportFailure: TaskFailureReporter,
): boolean {
  let hadFailure = false;
  for (const taskId of taskIds) {
    try {
      collectTask(dataRoot, taskId);
    } catch (error) {
      if (error instanceof StopTaskBatch) break;
      hadFailure = true;
      try {
        reportFailure(taskId, error);
      } catch (reportError) {
        if (reportError instanceof StopTaskBatch) break;
        throw reportError;
      }
    }
  }
  return hadFailure;
}
