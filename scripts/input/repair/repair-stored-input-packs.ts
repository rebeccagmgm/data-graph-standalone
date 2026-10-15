import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  canonicalHash,
  sha256Text,
  type JsonValue,
  SQL_SLOTS,
  type SqlSlot,
  type TaskDocument,
} from "../shared/input-pack.ts";
import { normalizeCollectedSqlSlot } from "../mainline/collect-one-task-input-pack.ts";

const MIGRATION_PROVENANCE = "migration:input-pack-sql-normalizer-v1";

export interface StoredPackRepairOptions {
  readonly dataRoot: string;
  readonly apply: boolean;
  readonly backupRoot?: string;
  readonly taskIds?: readonly string[];
}

export interface StoredPackRepairChange {
  readonly taskId: string;
  readonly taskCategory: string;
  readonly taskDirectory: string;
  readonly slots: readonly {
    slot: SqlSlot;
    bytesBefore: number;
    bytesAfter: number;
    warnings: readonly string[];
  }[];
}

export interface StoredPackRepairSummary {
  readonly mode: "dry-run" | "apply";
  readonly dataRoot: string;
  readonly backupRoot?: string;
  readonly taskPacksScanned: number;
  readonly sqlFilesScanned: number;
  readonly changedTaskPacks: number;
  readonly changedSqlFiles: number;
  readonly warnings: number;
  readonly skipped: readonly { path: string; reason: string }[];
  readonly changes: readonly StoredPackRepairChange[];
}

type MutableJsonObject = Record<string, any>;

interface SqlRepairUpdate {
  readonly slot: SqlSlot;
  readonly path: string;
  readonly content: string;
  readonly evidenceProvider: string;
  readonly warnings: readonly string[];
  readonly bytesBefore: number;
}

interface TaskRepairPlan {
  readonly task: TaskDocument;
  readonly directory: string;
  readonly updates: readonly SqlRepairUpdate[];
}

function validateStoredTaskDocument(value: unknown): asserts value is TaskDocument {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("task.json must be an object");
  const task = value as MutableJsonObject;
  if (task.schemaVersion !== "1.0.0")
    throw new Error(`unsupported task schemaVersion: ${String(task.schemaVersion)}`);
  if (typeof task.taskId !== "string" || task.taskId.trim() === "")
    throw new Error("task.json taskId is missing");
  if (typeof task.taskCategory !== "string" || task.taskCategory.trim() === "")
    throw new Error("task.json taskCategory is missing");
  if (!Array.isArray(task.sqlFiles))
    throw new Error("task.json sqlFiles must be an array");
  const slots = new Set<string>();
  for (const item of task.sqlFiles) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("task.json sqlFiles contains an invalid entry");
    const sql = item as MutableJsonObject;
    if (
      typeof sql.slot !== "string" ||
      !(SQL_SLOTS as readonly string[]).includes(sql.slot) ||
      slots.has(sql.slot)
    )
      throw new Error("task.json sqlFiles contains an invalid or duplicate slot");
    if (sql.path !== `sql/${sql.slot}.sql`)
      throw new Error(`task.json SQL path is invalid for ${String(sql.slot)}`);
    if (typeof sql.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sql.sha256))
      throw new Error(`task.json SQL hash is invalid for ${String(sql.slot)}`);
    if (typeof sql.evidenceProvider !== "string" || sql.evidenceProvider.trim() === "")
      throw new Error(`task.json SQL evidenceProvider is missing for ${String(sql.slot)}`);
    slots.add(sql.slot);
  }
  if (typeof task.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(task.contentHash))
    throw new Error("task.json contentHash is invalid");
  if (canonicalHash(task as JsonValue, ["collectedAt", "contentHash"]) !== task.contentHash)
    throw new Error("task.json contentHash does not match document");
}

function appendProvenance(current: unknown, token: string): string {
  const values = typeof current === "string" ? current.split(",") : [];
  if (!values.includes(token)) values.push(token);
  return values.filter((value) => value.trim() !== "").join(",") || token;
}

function discoverTaskJsonFiles(tasksRoot: string): string[] {
  if (!existsSync(tasksRoot)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "task.json") files.push(path);
    }
  };
  visit(tasksRoot);
  return files.sort();
}

function safeSqlPath(taskDirectory: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error("SQL path must be relative");
  const taskRoot = resolve(taskDirectory);
  const path = resolve(taskDirectory, relativePath);
  if (path !== taskRoot && !path.startsWith(`${taskRoot}\\`))
    throw new Error(`SQL path escapes task directory: ${relativePath}`);
  return path;
}

function taskIdMatches(task: TaskDocument, taskIds: readonly string[] | undefined) {
  return !taskIds || taskIds.length === 0 || taskIds.includes(task.taskId);
}

function readRepairPlan(
  taskJsonPath: string,
  taskIds: readonly string[] | undefined,
): TaskRepairPlan {
  const parsed: unknown = JSON.parse(readFileSync(taskJsonPath, "utf8"));
  validateStoredTaskDocument(parsed);
  const task = parsed;
  const directory = dirname(taskJsonPath);
  if (!taskIdMatches(task, taskIds))
    return { task, directory, updates: [] };
  const updates: SqlRepairUpdate[] = [];
  for (const item of task.sqlFiles) {
    const sqlFile = item as MutableJsonObject;
    const slot = sqlFile.slot as SqlSlot;
    const path = safeSqlPath(directory, String(sqlFile.path));
    if (!existsSync(path)) throw new Error(`Missing SQL file: ${path}`);
    const content = readFileSync(path, "utf8");
    if (sha256Text(content) !== sqlFile.sha256)
      throw new Error(`SQL hash mismatch before migration: ${path}`);
    const normalized = normalizeCollectedSqlSlot(
      content,
      slot,
      String(sqlFile.evidenceProvider ?? task.evidenceProvider ?? "stored-pack"),
    );
    // normalizeCollectedSqlSlot also canonicalizes line endings and appends a
    // trailing newline. Those formatting-only differences are not evidence
    // repairs and must not rewrite an otherwise valid stored source file.
    if (normalized.content !== content && normalized.warnings.length > 0)
      updates.push({
        slot,
        path,
        content: normalized.content,
        evidenceProvider: normalized.evidenceProvider,
        warnings: normalized.warnings,
        bytesBefore: Buffer.byteLength(content),
      });
  }
  return { task, directory, updates };
}

function updatedTaskDocument(
  task: TaskDocument,
  updates: readonly Pick<SqlRepairUpdate, "slot" | "content" | "evidenceProvider">[],
): MutableJsonObject {
  const next = JSON.parse(JSON.stringify(task)) as MutableJsonObject;
  const bySlot = new Map(updates.map((update) => [update.slot, update]));
  next.sqlFiles = (next.sqlFiles as MutableJsonObject[]).map((item) => {
    const update = bySlot.get(item.slot as SqlSlot);
    if (update === undefined) return item;
    return {
      ...item,
      sha256: sha256Text(update.content),
      evidenceProvider: update.evidenceProvider,
    };
  });
  next.evidenceProvider = appendProvenance(
    next.evidenceProvider,
    MIGRATION_PROVENANCE,
  );
  next.contentHash = canonicalHash(
    next as JsonValue,
    ["collectedAt", "contentHash"],
  );
  validateStoredTaskDocument(next);
  return next;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
    else throw new Error(`Unsupported filesystem entry in Task Pack: ${sourcePath}`);
  }
}

function recoverIncompleteRepairTransactions(dataRoot: string): void {
  const backupParent = join(dataRoot, ".input-pack-repair-backups");
  if (!existsSync(backupParent)) return;
  for (const entry of readdirSync(backupParent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const backupRoot = join(backupParent, entry.name);
    const markerPath = join(backupRoot, "transaction.json");
    if (!existsSync(markerPath)) continue;
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as MutableJsonObject;
    if (marker.state !== "applying" || !Array.isArray(marker.tasks)) continue;
    for (const task of marker.tasks) {
      if (typeof task !== "string") continue;
      const backupTask = join(backupRoot, "tasks", task);
      const targetTask = join(dataRoot, "tasks", task);
      if (existsSync(backupTask)) copyDirectory(backupTask, targetTask);
    }
    writeJson(markerPath, { ...marker, state: "recovered" });
  }
}

interface PreparedTaskRepair {
  readonly plan: TaskRepairPlan;
  readonly stagingRoot: string;
  readonly stagingDirectory: string;
  readonly backupDirectory: string;
}

function prepareTaskRepair(
  plan: TaskRepairPlan,
  tasksRoot: string,
  backupStagingRoot: string,
): PreparedTaskRepair {
  const backupDirectory = join(
    backupStagingRoot,
    "tasks",
    relative(tasksRoot, plan.directory),
  );
  const stagingRoot = mkdtempSync(join(dirname(plan.directory), ".input-pack-repair-"));
  const stagingDirectory = join(stagingRoot, basename(plan.directory));
  copyDirectory(plan.directory, stagingDirectory);
  for (const update of plan.updates) {
    const stagedPath = join(stagingDirectory, relative(plan.directory, update.path));
    writeFileSync(stagedPath, update.content, "utf8");
  }
  writeJson(
    join(stagingDirectory, "task.json"),
    updatedTaskDocument(plan.task, plan.updates),
  );
  return { plan, stagingRoot, stagingDirectory, backupDirectory };
}

function applyPreparedRepairs(
  prepared: readonly PreparedTaskRepair[],
  backupRoot: string,
  backupStagingRoot: string,
): void {
  if (existsSync(backupRoot))
    throw new Error(`Backup root already exists: ${backupRoot}`);
  let sourceChangesStarted = false;
  try {
    for (const item of prepared) {
      if (existsSync(item.backupDirectory))
        throw new Error(`Backup already exists: ${item.backupDirectory}`);
      copyDirectory(item.plan.directory, item.backupDirectory);
    }
    renameSync(backupStagingRoot, backupRoot);
    writeJson(join(backupRoot, "transaction.json"), {
      state: "applying",
      tasks: prepared.map((item) => relative(backupStagingRoot, item.backupDirectory)),
    });
    sourceChangesStarted = true;
    for (const item of prepared) {
      for (const update of item.plan.updates) {
        const stagedPath = join(
          item.stagingDirectory,
          relative(item.plan.directory, update.path),
        );
        copyFileSync(stagedPath, update.path);
      }
      copyFileSync(
        join(item.stagingDirectory, "task.json"),
        join(item.plan.directory, "task.json"),
      );
    }
    writeJson(join(backupRoot, "transaction.json"), {
      state: "applied",
      tasks: prepared.map((item) => relative(backupStagingRoot, item.backupDirectory)),
    });
  } catch (error) {
    if (!sourceChangesStarted) throw error;
    for (const item of [...prepared].reverse()) {
      const backupDirectory = join(
        backupRoot,
        "tasks",
        relative(backupStagingRoot, item.backupDirectory),
      );
      if (!existsSync(backupDirectory)) continue;
      for (const entry of readdirSync(backupDirectory, { withFileTypes: true })) {
        const target = join(item.plan.directory, entry.name);
        const backup = join(backupDirectory, entry.name);
        if (entry.isFile()) copyFileSync(backup, target);
        else if (entry.isDirectory()) copyDirectory(backup, target);
      }
    }
    writeJson(join(backupRoot, "transaction.json"), {
      state: "rolled-back",
      tasks: prepared.map((item) => relative(backupStagingRoot, item.backupDirectory)),
    });
    throw error;
  } finally {
    for (const item of prepared) {
      if (existsSync(item.stagingRoot))
        rmSync(item.stagingRoot, { recursive: true, force: true });
    }
    if (existsSync(backupStagingRoot))
      rmSync(backupStagingRoot, { recursive: true, force: true });
  }
}

export function repairStoredInputPacks(
  options: StoredPackRepairOptions,
): StoredPackRepairSummary {
  const dataRoot = resolve(options.dataRoot);
  const tasksRoot = join(dataRoot, "tasks");
  recoverIncompleteRepairTransactions(dataRoot);
  const mode = options.apply ? "apply" : "dry-run";
  const backupRoot = options.apply
    ? resolve(
        options.backupRoot ??
          join(dataRoot, ".input-pack-repair-backups", new Date().toISOString().replace(/[:.]/g, "-")),
      )
    : undefined;
  const resolvedTasksRoot = resolve(tasksRoot);
  if (
    backupRoot &&
    (resolve(backupRoot) === resolvedTasksRoot ||
      resolve(backupRoot).startsWith(`${resolvedTasksRoot}\\`))
  )
    throw new Error("Backup root must not be inside tasks/");
  if (backupRoot) mkdirSync(dirname(backupRoot), { recursive: true });
  const skipped: { path: string; reason: string }[] = [];
  const changes: StoredPackRepairChange[] = [];
  const plans: TaskRepairPlan[] = [];
  const taskJsonPaths = discoverTaskJsonFiles(tasksRoot);
  let sqlFilesScanned = 0;
  for (const taskJsonPath of taskJsonPaths) {
    let plan: TaskRepairPlan;
    try {
      plan = readRepairPlan(taskJsonPath, options.taskIds);
    } catch (error) {
      skipped.push({ path: taskJsonPath, reason: String(error) });
      continue;
    }
    sqlFilesScanned += plan.task.sqlFiles.length;
    if (plan.updates.length === 0) continue;
    plans.push(plan);
    changes.push({
      taskId: plan.task.taskId,
      taskCategory: plan.task.taskCategory,
      taskDirectory: plan.directory,
      slots: plan.updates.map((update) => ({
        slot: update.slot,
        bytesBefore: update.bytesBefore,
        bytesAfter: Buffer.byteLength(update.content),
        warnings: update.warnings,
      })),
    });
  }
  if (options.apply && backupRoot && plans.length > 0) {
    const backupStagingRoot = mkdtempSync(
      join(dirname(backupRoot), ".input-pack-backup-"),
    );
    const prepared: PreparedTaskRepair[] = [];
    try {
      for (const plan of plans)
        prepared.push(
          prepareTaskRepair(plan, tasksRoot, backupStagingRoot),
        );
      applyPreparedRepairs(prepared, backupRoot, backupStagingRoot);
    } catch (error) {
      for (const item of prepared) {
        if (existsSync(item.stagingRoot))
          rmSync(item.stagingRoot, { recursive: true, force: true });
      }
      if (existsSync(backupStagingRoot))
        rmSync(backupStagingRoot, { recursive: true, force: true });
      throw error;
    }
  }
  const summary: StoredPackRepairSummary = {
    mode,
    dataRoot,
    ...(backupRoot ? { backupRoot } : {}),
    taskPacksScanned: taskJsonPaths.length,
    sqlFilesScanned,
    changedTaskPacks: changes.length,
    changedSqlFiles: changes.reduce((count, change) => count + change.slots.length, 0),
    warnings: changes.reduce(
      (count, change) => count + change.slots.reduce((inner, slot) => inner + slot.warnings.length, 0),
      0,
    ),
    skipped,
    changes,
  };
  if (backupRoot) {
    writeJson(join(backupRoot, "manifest.json"), summary);
    const transactionPath = join(backupRoot, "transaction.json");
    if (existsSync(transactionPath)) rmSync(transactionPath, { force: true });
  }
  return summary;
}

function parseArgs(argv: readonly string[]): StoredPackRepairOptions {
  let dataRoot: string | undefined;
  let backupRoot: string | undefined;
  let apply = false;
  const taskIds: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--data-root") dataRoot = argv[++index];
    else if (argument === "--backup-root") backupRoot = argv[++index];
    else if (argument === "--task-id") taskIds.push(argv[++index]!);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!dataRoot) throw new Error("Usage: --data-root <path> [--apply] [--backup-root <path>] [--task-id <id>]");
  return { dataRoot, apply, backupRoot, taskIds };
}

if (process.argv[1]?.endsWith("repair-stored-input-packs.ts")) {
  try {
    const summary = repairStoredInputPacks(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
