import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  sha256File,
  validateTaskDocument,
  type TaskDocument,
} from "../shared/input-pack.ts";

type PackCandidate = {
  readonly path: string;
  readonly taskCategory: string;
  readonly valid: boolean;
};

export type FillMissingOptions = {
  readonly dataRoot: string;
  readonly taskIds: readonly string[];
  readonly statusFile?: string;
  readonly dryRun?: boolean;
  readonly skipSchedulingDetail?: boolean;
  readonly skipSchedulingClassification?: boolean;
};

export type FillMissingPlan = {
  readonly requested: readonly string[];
  readonly existing: readonly string[];
  readonly missing: readonly string[];
  readonly ambiguous: readonly string[];
  readonly invalid: readonly { taskId: string; path: string; reason: string }[];
};

function parseTaskIds(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function validTaskId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

function taskPackCandidates(dataRoot: string, requested: ReadonlySet<string>): PackCandidate[] {
  const tasksRoot = join(resolve(dataRoot), "tasks");
  if (!existsSync(tasksRoot)) return [];
  const candidates: PackCandidate[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== "task.json") continue;
      const taskId = basename(dirname(entryPath));
      if (!requested.has(taskId)) continue;
      const taskCategory = basename(dirname(dirname(entryPath)));
      try {
        const task = JSON.parse(readFileSync(entryPath, "utf8")) as TaskDocument;
        validateTaskDocument(task);
        if (task.taskId !== taskId) throw new Error("TASK_ID_DIRECTORY_MISMATCH");
        for (const sqlFile of task.sqlFiles) {
          const taskDirectory = resolve(dirname(entryPath));
          const sqlPath = resolve(taskDirectory, sqlFile.path);
          const relativeSqlPath = relative(taskDirectory, sqlPath);
          if (isAbsolute(relativeSqlPath) || relativeSqlPath === ".." || relativeSqlPath.startsWith(`..${pathSep()}`))
            throw new Error(`TASK_SQL_PATH_UNSAFE:${sqlFile.path}`);
          if (!existsSync(sqlPath) || sha256File(sqlPath) !== sqlFile.sha256)
            throw new Error(`TASK_SQL_HASH_INVALID:${sqlFile.path}`);
        }
        candidates.push({ path: entryPath, taskCategory, valid: true });
      } catch (error) {
        candidates.push({ path: entryPath, taskCategory, valid: false });
      }
    }
  };
  visit(tasksRoot);
  return candidates;
}

export function planFillMissingTaskInputPacks(options: FillMissingOptions): FillMissingPlan {
  const requested = [...new Set(options.taskIds.map((taskId) => taskId.trim()).filter(Boolean))].sort();
  for (const taskId of requested)
    if (!validTaskId(taskId)) throw new Error(`TASK_ID_INVALID:${taskId}`);
  const requestedSet = new Set(requested);
  const candidates = taskPackCandidates(options.dataRoot, requestedSet);
  const byId = new Map<string, PackCandidate[]>();
  for (const candidate of candidates) {
    const id = basename(dirname(candidate.path));
    const items = byId.get(id) ?? [];
    items.push(candidate);
    byId.set(id, items);
  }
  const existing: string[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  const invalid: { taskId: string; path: string; reason: string }[] = [];
  for (const taskId of requested) {
    const items = byId.get(taskId) ?? [];
    const valid = items.filter((item) => item.valid);
    if (items.length > 1) ambiguous.push(taskId);
    else if (valid.length === 1) existing.push(taskId);
    else {
      missing.push(taskId);
      for (const item of items)
        if (!item.valid) invalid.push({ taskId, path: item.path, reason: "STORED_PACK_INVALID" });
    }
  }
  return { requested, existing, missing, ambiguous, invalid };
}

function pathSep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export function fillMissingTaskInputPacks(options: FillMissingOptions): FillMissingPlan {
  const plan = planFillMissingTaskInputPacks(options);
  if (plan.ambiguous.length > 0)
    throw new Error(`TASK_INPUT_PACK_AMBIGUOUS:${plan.ambiguous.join(",")}`);
  if (options.dryRun || plan.missing.length === 0) return plan;
  const collector = resolve("scripts/input/mainline/collect-task-input-pack.ts");
  const tsx = resolve("node_modules/tsx/dist/cli.mjs");
  const args = [tsx, collector, "--data-root", resolve(options.dataRoot), "--task-ids", plan.missing.join(",")];
  if (options.statusFile !== undefined) args.push("--status-file", resolve(options.statusFile));
  if (options.skipSchedulingDetail === true) args.push("--skip-scheduling-detail");
  if (options.skipSchedulingClassification === true)
    args.push("--skip-scheduling-classification");
  execFileSync(process.execPath, args, { stdio: "inherit", windowsHide: true });
  return plan;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1]?.endsWith("fill-missing-task-input-packs.ts")) {
  const dataRoot = option("--data-root");
  const taskIds = option("--task-ids");
  if (!dataRoot || !taskIds) throw new Error("usage: --data-root <path> --task-ids <id[,id...]> [--status-file <path>] [--dry-run]");
  const plan = fillMissingTaskInputPacks({
    dataRoot,
    taskIds: parseTaskIds(taskIds),
    statusFile: option("--status-file"),
    dryRun: process.argv.includes("--dry-run"),
    skipSchedulingDetail: process.argv.includes("--skip-scheduling-detail"),
    skipSchedulingClassification: process.argv.includes(
      "--skip-scheduling-classification",
    ),
  });
  process.stdout.write(`${JSON.stringify({ ...plan, collection: process.argv.includes("--dry-run") ? "NOT_RUN" : plan.missing.length === 0 ? "NOT_NEEDED" : "STARTED" }, null, 2)}\n`);
}
