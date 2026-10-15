import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkspacePaths } from "../../config/workspace-paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const logPath = join(repoRoot, "tmp/src-table-rebuild.log");
const BATCH_SIZE = 25;

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseRunSrcTableTemplateRebuildArgs(argv) {
  const taskIdsFile = option(argv, "--task-ids-file");
  if (!taskIdsFile?.trim())
    throw new Error("TASK_IDS_FILE_REQUIRED: pass --task-ids-file <path>");
  if (argv.includes("--allow-platform-fill") || argv.includes("--wait-for-fill"))
    throw new Error("PLATFORM_FILL_FORBIDDEN: this runner uses local cache only");
  return { taskIdsFile };
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line, "utf8");
}

function runNpm(args) {
  log(`npm ${args.join(" ")}`);
  execFileSync("npm", args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
  });
}

function taskIds(taskIdsFile) {
  if (!existsSync(taskIdsFile))
    throw new Error(`TASK_IDS_FILE_MISSING: ${taskIdsFile}`);
  const ids = readFileSync(taskIdsFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error(`TASK_IDS_FILE_EMPTY: ${taskIdsFile}`);
  return [...new Set(ids)];
}

export function runSrcTableTemplateRebuild(argv = process.argv.slice(2)) {
  const parsed = parseRunSrcTableTemplateRebuildArgs(argv);
  const taskIdsFile = isAbsolute(parsed.taskIdsFile)
    ? parsed.taskIdsFile
    : resolve(repoRoot, parsed.taskIdsFile);
  const ids = taskIds(taskIdsFile);
  const paths = resolveWorkspacePaths({ cwd: repoRoot });

  log(`local-only rebuild tasks=${ids.length} taskIdsFile=${taskIdsFile}`);
  log("input-pack:from-cache");
  runNpm([
    "run",
    "input-pack:from-cache",
    "--",
    "--data-root",
    paths.dataRoot,
    "--cache-root",
    paths.evidenceRoot,
    "--task-ids-file",
    taskIdsFile,
    "--force",
  ]);

  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    const chunk = ids.slice(index, index + BATCH_SIZE);
    log(`input-pack:machine-facts batch ${Math.floor(index / BATCH_SIZE) + 1}`);
    runNpm([
      "run",
      "input-pack:machine-facts",
      "--",
      "--data-root",
      paths.dataRoot,
      "--output",
      paths.factsRoot,
      "--task-id",
      chunk.join(","),
    ]);
  }

  log("project-task-local");
  runNpm([
    "run",
    "project-task-local",
    "--",
    "--data-root",
    paths.dataRoot,
    "--facts-root",
    paths.factsRoot,
    "--schedule-cache-root",
    paths.evidenceRoot,
    "--projection-root",
    paths.projectionRoot,
    "--task-ids-file",
    taskIdsFile,
  ]);

  log("done");
}

if (process.argv[1] && process.argv[1].endsWith("run-src-table-template-rebuild.mjs"))
  runSrcTableTemplateRebuild();
