import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveScheduleEvidenceCacheRoot } from "../../evidence/schedule-evidence-cache.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const MANUAL_TASK_IDS_FILE_NAME = "manual-task-ids.txt";

export function defaultManualTaskIdsFile(cacheRoot: string): string {
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    MANUAL_TASK_IDS_FILE_NAME,
  );
}

/** Read the completed Horae batch classification; a missing file is allowed. */
export function readManualTaskIds(
  cacheRoot: string,
  filePath = defaultManualTaskIdsFile(cacheRoot),
): Set<string> {
  if (!existsSync(filePath)) return new Set();
  const metaPath = `${filePath}.meta.json`;
  if (!existsSync(metaPath)) return new Set();
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (error) {
    throw new Error(
      `MANUAL_TASK_IDS_META_INVALID:${metaPath}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    (metadata as Record<string, unknown>).status !== "COMPLETED"
  )
    return new Set();
  const ids = new Set<string>();
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const taskId = rawLine.trim();
    if (!taskId || taskId.startsWith("#")) continue;
    if (!SAFE_TASK_ID.test(taskId))
      throw new Error(`MANUAL_TASK_IDS_FILE_INVALID:${taskId}`);
    ids.add(taskId);
  }
  return ids;
}

export function excludeManualTaskIds(
  taskIds: readonly string[],
  manualTaskIds: ReadonlySet<string>,
): string[] {
  return taskIds.filter((taskId) => !manualTaskIds.has(taskId));
}
