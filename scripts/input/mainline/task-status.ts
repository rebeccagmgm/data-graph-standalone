import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  sha256File,
  validateTableDocument,
  validateTaskDocument,
} from "../shared/input-pack.ts";

export type PersistedTaskStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "FAILED"
  | "EXCLUDED";
export type TaskExclusionReason =
  | "MANUAL_OR_FROZEN"
  | "HORAE_TASK_NOT_FOUND"
  | "PHYSICAL_TABLE_NOT_FOUND";

export type TaskAssetStatus = {
  directory: string;
  contentHash: string;
};

export type TaskStatusRecord = {
  taskId: string;
  status: PersistedTaskStatus;
  taskCategory?: string;
  taskType?: string | null;
  exclusionReason?: TaskExclusionReason;
  directory?: string;
  changed?: boolean;
  contentHash?: string;
  tablesWritten?: number;
  tableAssets?: TaskAssetStatus[];
  tablesUnavailable?: string[];
  tableReferencesUnavailable?: string[];
  warnings?: string[];
  staleLegacyTaskDirectories?: string[];
  cacheArtifacts?: string[];
  error?: string;
  updatedAt: string;
};

export type TaskStatusDocument = {
  schemaVersion: "1.0.0";
  dataRoot: string;
  tasks: Record<string, TaskStatusRecord>;
};

export function defaultTaskStatusFile(dataRoot: string): string {
  return `${resolve(dataRoot)}.input-pack-status.json`;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function assertStatusFileOutsideDataRoot(
  statusFile: string,
  dataRoot: string,
): void {
  if (isWithinRoot(dataRoot, statusFile))
    throw new Error(
      `Input Pack status file must be outside data root: ${statusFile}`,
    );
}

function validateSha256(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(`Invalid ${field} in Input Pack status file`);
}

function validateRecord(
  taskId: string,
  record: unknown,
): asserts record is TaskStatusRecord {
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error(`Invalid task status record: ${taskId}`);
  const candidate = record as Partial<TaskStatusRecord>;
  if (
    candidate.taskId !== taskId ||
    !["SUCCESS", "PARTIAL", "FAILED", "EXCLUDED"].includes(
      candidate.status ?? "",
    ) ||
    typeof candidate.updatedAt !== "string"
  )
    throw new Error(`Invalid task status record: ${taskId}`);
  if (
    candidate.exclusionReason !== undefined &&
    candidate.exclusionReason !== "MANUAL_OR_FROZEN" &&
    candidate.exclusionReason !== "HORAE_TASK_NOT_FOUND" &&
    candidate.exclusionReason !== "PHYSICAL_TABLE_NOT_FOUND"
  )
    throw new Error(
      `Invalid ${taskId}.exclusionReason in Input Pack status file`,
    );
  if (
    candidate.status === "EXCLUDED" &&
    candidate.exclusionReason === undefined
  )
    throw new Error(`Excluded task status requires a reason: ${taskId}`);
  if (candidate.contentHash !== undefined)
    validateSha256(candidate.contentHash, `${taskId}.contentHash`);
  if (
    candidate.directory !== undefined &&
    typeof candidate.directory !== "string"
  )
    throw new Error(`Invalid ${taskId}.directory in Input Pack status file`);
  if (
    candidate.tablesWritten !== undefined &&
    (!Number.isInteger(candidate.tablesWritten) || candidate.tablesWritten < 0)
  )
    throw new Error(
      `Invalid ${taskId}.tablesWritten in Input Pack status file`,
    );
  for (const [field, value] of [
    ["tablesUnavailable", candidate.tablesUnavailable],
    ["tableReferencesUnavailable", candidate.tableReferencesUnavailable],
    ["warnings", candidate.warnings],
    ["staleLegacyTaskDirectories", candidate.staleLegacyTaskDirectories],
    ["cacheArtifacts", candidate.cacheArtifacts],
  ] as const) {
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    )
      throw new Error(`Invalid ${taskId}.${field} in Input Pack status file`);
  }
  if (candidate.tableAssets !== undefined) {
    if (!Array.isArray(candidate.tableAssets))
      throw new Error(
        `Invalid ${taskId}.tableAssets in Input Pack status file`,
      );
    for (const asset of candidate.tableAssets) {
      if (
        !asset ||
        typeof asset !== "object" ||
        typeof asset.directory !== "string"
      )
        throw new Error(
          `Invalid ${taskId}.tableAssets in Input Pack status file`,
        );
      validateSha256(asset.contentHash, `${taskId}.tableAssets.contentHash`);
    }
  }
}

function parseStatusDocument(
  statusFile: string,
  dataRoot: string,
): TaskStatusDocument {
  const expectedRoot = resolve(dataRoot);
  const parsed: unknown = JSON.parse(readFileSync(statusFile, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Invalid Input Pack status file: ${statusFile}`);
  const document = parsed as Partial<TaskStatusDocument>;
  if (
    document.schemaVersion !== "1.0.0" ||
    document.dataRoot !== expectedRoot ||
    !document.tasks ||
    typeof document.tasks !== "object" ||
    Array.isArray(document.tasks)
  )
    throw new Error(
      `Input Pack status file does not match data root or schema: ${statusFile}`,
    );
  for (const [taskId, record] of Object.entries(document.tasks))
    validateRecord(taskId, record);
  return document as TaskStatusDocument;
}

function orphanStatusCandidates(statusFile: string): string[] {
  const parent = dirname(statusFile);
  const prefix = `${statusFile.split(/[\\/]/).pop()}.`;
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        (name.endsWith(".bak") || name.endsWith(".tmp")),
    )
    .map((name) => resolve(parent, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

function recoverOrphanStatus(
  statusFile: string,
  dataRoot: string,
): TaskStatusDocument | undefined {
  for (const candidate of orphanStatusCandidates(statusFile)) {
    try {
      const recovered = parseStatusDocument(candidate, dataRoot);
      try {
        renameSync(candidate, statusFile);
      } catch {
        // The recovered document is still usable for this run; a later run
        // can retry the rename without losing the parsed progress.
      }
      return recovered;
    } catch {
      // Ignore incomplete temp/backup files and continue to the next candidate.
    }
  }
  return undefined;
}

export function loadTaskStatus(
  statusFile: string,
  dataRoot: string,
): TaskStatusDocument {
  const expectedRoot = resolve(dataRoot);
  assertStatusFileOutsideDataRoot(statusFile, dataRoot);
  if (existsSync(statusFile)) {
    try {
      return parseStatusDocument(statusFile, dataRoot);
    } catch (error) {
      const corruptFile = `${statusFile}.corrupt-${process.pid}-${Date.now()}`;
      let movedCorruptFile = false;
      try {
        renameSync(statusFile, corruptFile);
        movedCorruptFile = true;
      } catch {
        // Leave the original error as the primary signal if it cannot move.
      }
      const recovered = recoverOrphanStatus(statusFile, dataRoot);
      if (recovered !== undefined) return recovered;
      if (movedCorruptFile && existsSync(corruptFile))
        renameSync(corruptFile, statusFile);
      throw error;
    }
  }
  const recovered = recoverOrphanStatus(statusFile, dataRoot);
  if (recovered !== undefined) return recovered;
  return { schemaVersion: "1.0.0", dataRoot: expectedRoot, tasks: {} };
}

export function saveTaskStatus(
  statusFile: string,
  document: TaskStatusDocument,
): void {
  mkdirSync(dirname(statusFile), { recursive: true });
  const temporaryFile = `${statusFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(
    temporaryFile,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
  const backupFile = `${statusFile}.${process.pid}.bak`;
  if (existsSync(backupFile)) rmSync(backupFile, { force: true });
  if (existsSync(statusFile)) renameSync(statusFile, backupFile);
  try {
    renameSync(temporaryFile, statusFile);
    if (existsSync(backupFile)) rmSync(backupFile, { force: true });
  } catch (error) {
    if (!existsSync(statusFile) && existsSync(backupFile))
      renameSync(backupFile, statusFile);
    if (existsSync(temporaryFile)) rmSync(temporaryFile, { force: true });
    throw error;
  }
}

export function updateTaskStatus(
  document: TaskStatusDocument,
  record: Omit<TaskStatusRecord, "updatedAt">,
): void {
  document.tasks[record.taskId] = {
    ...record,
    updatedAt: new Date().toISOString(),
  };
}

export function canSkipSuccessfulTask(
  record: TaskStatusRecord | undefined,
  dataRoot: string,
): boolean {
  if (
    record?.status !== "SUCCESS" ||
    record.warnings?.length !== 0 ||
    record.staleLegacyTaskDirectories?.length !== 0 ||
    record.directory === undefined ||
    record.contentHash === undefined ||
    record.tableAssets === undefined ||
    record.taskCategory === undefined ||
    (record.tablesWritten ?? record.tableAssets.length) !==
      record.tableAssets.length ||
    !samePath(
      record.directory,
      join(dataRoot, "tasks", record.taskCategory, record.taskId),
    )
  )
    return false;
  try {
    const taskPath = resolve(record.directory, "task.json");
    if (!existsSync(taskPath)) return false;
    const task = JSON.parse(readFileSync(taskPath, "utf8")) as Record<
      string,
      unknown
    >;
    validateTaskDocument(task);
    if (
      task.taskId !== record.taskId ||
      task.taskCategory !== record.taskCategory ||
      task.contentHash !== record.contentHash ||
      !Array.isArray(task.sqlFiles)
    )
      return false;
    for (const sqlFile of task.sqlFiles) {
      const sqlFileObject =
        sqlFile && typeof sqlFile === "object" && !Array.isArray(sqlFile)
          ? (sqlFile as { path?: unknown; sha256?: unknown })
          : undefined;
      if (
        sqlFileObject === undefined ||
        typeof sqlFileObject.path !== "string" ||
        typeof sqlFileObject.sha256 !== "string" ||
        !isWithinRoot(
          record.directory,
          resolve(record.directory, sqlFileObject.path),
        ) ||
        sha256File(resolve(record.directory, sqlFileObject.path)) !==
          sqlFileObject.sha256
      )
        return false;
    }
    return record.tableAssets.every((asset) => {
      const tableJsonPath = resolve(asset.directory, "table.json");
      const ddlPath = resolve(asset.directory, "ddl.sql");
      if (!existsSync(tableJsonPath) || !existsSync(ddlPath)) return false;
      const table = JSON.parse(readFileSync(tableJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
      validateTableDocument(table);
      return (
        samePath(
          asset.directory,
          join(
            dataRoot,
            "tables",
            String(table.platform),
            String(table.stableTableId),
          ),
        ) &&
        table.contentHash === asset.contentHash &&
        sha256File(ddlPath) === (table.ddlFile as { sha256?: unknown }).sha256
      );
    });
  } catch {
    return false;
  }
}
