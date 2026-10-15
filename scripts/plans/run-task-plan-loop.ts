import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type JsonObject = Record<string, unknown>;

type TaskRef = {
  taskId: string;
  category: string;
  taskDir: string;
};

type RunResult = {
  task_id: string;
  category: string;
  slot: string;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  summary_path: string;
  physical_input_count?: number;
  unknown_count?: number;
  schema_missing_count?: number;
  schema_issue_count?: number;
  coverage?: Record<string, number>;
  error?: string;
};

function isNonBlockingTestSchemaName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return (
    /^gfstest\./i.test(normalized) ||
    /(?:^|[._-])(?:test|uat)(?:[._-]|$)/i.test(normalized)
  );
}

function isNonBlockingTestSchemaContext(
  value: unknown,
  taskName: unknown,
): boolean {
  return (
    isNonBlockingTestSchemaName(value) || isNonBlockingTestSchemaName(taskName)
  );
}

const repoRoot = resolve(import.meta.dirname, "../..");
const defaultDataRoot = resolve(repoRoot, "../sql-static-lineage-data");
const inspector = join(repoRoot, "tmp", "inspect-plan-adapter-task.ts");
const collector = join(
  repoRoot,
  "scripts",
  "input",
  "collect-task-input-pack.ts",
);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argsAfter(name: string): string[] {
  const index = process.argv.indexOf(name);
  if (index < 0) return [];

  const values: string[] = [];
  for (let cursor = index + 1; cursor < process.argv.length; cursor += 1) {
    const value = process.argv[cursor];
    if (value.startsWith("--")) break;
    values.push(value);
  }
  return values;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseTaskIds(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function taskHasSlot(task: JsonObject, slot: string): boolean {
  const sqlFiles = task.sqlFiles;
  return (
    Array.isArray(sqlFiles) &&
    sqlFiles.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as JsonObject).slot === slot,
    )
  );
}

function discoverLocalTasks(
  dataRoot: string,
  slot: string,
  categoryFilter?: string,
): TaskRef[] {
  const tasksRoot = join(dataRoot, "tasks");
  if (!existsSync(tasksRoot)) return [];

  const refs: TaskRef[] = [];
  for (const categoryEntry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!categoryEntry.isDirectory()) continue;
    if (categoryFilter && categoryEntry.name !== categoryFilter) continue;

    const categoryDir = join(tasksRoot, categoryEntry.name);
    for (const taskEntry of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!taskEntry.isDirectory()) continue;
      const taskDir = join(categoryDir, taskEntry.name);
      const taskJsonPath = join(taskDir, "task.json");
      if (!existsSync(taskJsonPath)) continue;

      try {
        const task = readJson(taskJsonPath);
        const taskId = String(task.taskId ?? taskEntry.name);
        if (taskHasSlot(task, slot)) {
          refs.push({ taskId, category: categoryEntry.name, taskDir });
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            progress: "task_discovery_skipped",
            task_dir: taskDir,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }

  return refs.sort((left, right) => {
    const categoryOrder = left.category.localeCompare(right.category);
    return categoryOrder || Number(left.taskId) - Number(right.taskId);
  });
}

function runCommand(
  command: string,
  args: string[],
): {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
} {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function tsxCli(): string {
  return join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
}

function runTsx(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
} {
  return runCommand(process.execPath, [tsxCli(), ...args]);
}

function collectMissingTasks(
  dataRoot: string,
  taskIds: string[],
  force: boolean,
): void {
  if (taskIds.length === 0) return;

  const args = [
    collector,
    "--data-root",
    dataRoot,
    "--task-ids",
    taskIds.join(","),
  ];
  if (force) args.push("--force");

  console.error(
    JSON.stringify({
      progress: "task_input_collection_started",
      task_ids: taskIds,
    }),
  );
  const result = runTsx(args);
  if (result.stdout.trim()) process.stdout.write(result.stdout);
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(
      `task input collection failed with exit code ${result.exitCode}${result.error ? `: ${result.error}` : ""}`,
    );
  }
}

function numberAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function summarizeInspection(
  ref: TaskRef,
  slot: string,
  summary: JsonObject,
): RunResult {
  const files = Array.isArray(summary.files) ? summary.files : [];
  let syntaxErrorCount = 0;
  let unknownCount = 0;
  let schemaMissingCount = 0;
  let schemaIssueCount = 0;
  let ignoredTestSchemaMissingCount = 0;
  let ignoredTestSchemaIssueCount = 0;
  let physicalInputCount = 0;
  const coverage: Record<string, number> = {};

  const topLevelPhysicalInputs = summary.physical_inputs;
  if (Array.isArray(topLevelPhysicalInputs)) {
    physicalInputCount = topLevelPhysicalInputs.length;
  }

  const schemaLoad =
    summary.schema_load && typeof summary.schema_load === "object"
      ? (summary.schema_load as JsonObject)
      : undefined;
  const missingTables = Array.isArray(schemaLoad?.missing)
    ? schemaLoad.missing.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const schemaIssues = Array.isArray(schemaLoad?.issues)
    ? schemaLoad.issues.filter(
        (value): value is JsonObject =>
          typeof value === "object" && value !== null,
      )
    : [];
  const taskName =
    summary.task && typeof summary.task === "object"
      ? (summary.task as JsonObject).name
      : undefined;
  schemaMissingCount = missingTables.length;
  schemaIssueCount = schemaIssues.length;
  ignoredTestSchemaMissingCount = missingTables.filter(
    (value) => isNonBlockingTestSchemaContext(value, taskName),
  ).length;
  ignoredTestSchemaIssueCount = schemaIssues.filter((issue) =>
    isNonBlockingTestSchemaContext(issue.qualified_name, taskName),
  ).length;

  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const fileObject = file as JsonObject;
    const statements = Array.isArray(fileObject.statements)
      ? fileObject.statements
      : [];
    for (const statement of statements) {
      if (!statement || typeof statement !== "object") continue;
      const statementObject = statement as JsonObject;
      syntaxErrorCount += numberAt(statementObject.syntax_errors);
      unknownCount += numberAt(statementObject.unknown_count);

      if (
        physicalInputCount === 0 &&
        Array.isArray(statementObject.physical_inputs)
      ) {
        physicalInputCount += statementObject.physical_inputs.length;
      }

      const valueLineage = statementObject.value_lineage;
      const statementCoverage =
        valueLineage && typeof valueLineage === "object"
          ? (valueLineage as JsonObject).coverage_counts
          : statementObject.coverage;
      if (statementCoverage && typeof statementCoverage === "object") {
        for (const [key, value] of Object.entries(statementCoverage)) {
          coverage[key] = (coverage[key] ?? 0) + numberAt(value);
        }
      }
    }
  }

  const status =
    syntaxErrorCount > 0 ||
    unknownCount > 0 ||
    schemaMissingCount - ignoredTestSchemaMissingCount > 0 ||
    schemaIssueCount - ignoredTestSchemaIssueCount > 0
      ? "PARTIAL"
      : "SUCCESS";

  return {
    task_id: ref.taskId,
    category: ref.category,
    slot,
    status,
    summary_path: join(
      repoRoot,
      "tmp",
      "inspect-results",
      ref.category,
      ref.taskId,
      `${slot}.summary.json`,
    ),
    physical_input_count: physicalInputCount,
    unknown_count: unknownCount,
    schema_missing_count: schemaMissingCount,
    schema_issue_count: schemaIssueCount,
    ...(ignoredTestSchemaMissingCount > 0
      ? { ignored_test_schema_missing_count: ignoredTestSchemaMissingCount }
      : {}),
    ...(ignoredTestSchemaIssueCount > 0
      ? { ignored_test_schema_issue_count: ignoredTestSchemaIssueCount }
      : {}),
    coverage,
    ...(syntaxErrorCount > 0
      ? { error: `syntax_errors=${syntaxErrorCount}` }
      : {}),
  };
}

function inspectOne(
  ref: TaskRef,
  dataRoot: string,
  slot: string,
  fetchSzdata: boolean,
): RunResult {
  const args = [
    inspector,
    "--task-id",
    ref.taskId,
    "--category",
    ref.category,
    "--slot",
    slot,
    "--data-root",
    dataRoot,
    "--tables-root",
    join(dataRoot, "tables"),
  ];
  if (fetchSzdata) args.push("--fetch-szdata");

  const result = runTsx(args);
  if (result.stderr.trim()) process.stderr.write(result.stderr);

  if (result.exitCode !== 0) {
    return {
      task_id: ref.taskId,
      category: ref.category,
      slot,
      status: "FAILED",
      summary_path: join(
        repoRoot,
        "tmp",
        "inspect-results",
        ref.category,
        ref.taskId,
        `${slot}.summary.json`,
      ),
      error:
        result.error ??
        `inspector exited with code ${result.exitCode}: ${result.stderr.trim()}`,
    };
  }

  try {
    const summary = JSON.parse(result.stdout) as JsonObject;
    return summarizeInspection(ref, slot, summary);
  } catch (error) {
    return {
      task_id: ref.taskId,
      category: ref.category,
      slot,
      status: "FAILED",
      summary_path: join(
        repoRoot,
        "tmp",
        "inspect-results",
        ref.category,
        ref.taskId,
        `${slot}.summary.json`,
      ),
      error: `cannot parse inspector JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function main(): void {
  const dataRoot = resolve(arg("--data-root") ?? defaultDataRoot);
  const slot = arg("--slot") ?? "query";
  const category = arg("--category");
  const requestedTaskIds = parseTaskIds(argsAfter("--task-ids"));
  const limitValue = arg("--limit");
  const limit = limitValue ? Number(limitValue) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }

  if (!existsSync(inspector)) {
    throw new Error(`inspector not found: ${inspector}`);
  }

  let refs = discoverLocalTasks(dataRoot, slot, category);
  if (requestedTaskIds.length > 0) {
    const requestedSet = new Set(requestedTaskIds);
    const localSelected = refs.filter((ref) => requestedSet.has(ref.taskId));
    const localIds = new Set(localSelected.map((ref) => ref.taskId));
    const missingIds = requestedTaskIds.filter(
      (taskId) => !localIds.has(taskId),
    );

    if (missingIds.length > 0 && hasFlag("--collect-task-input")) {
      collectMissingTasks(dataRoot, missingIds, hasFlag("--force"));
      refs = discoverLocalTasks(dataRoot, slot, category);
    }

    const refreshed = new Set(refs.map((ref) => ref.taskId));
    const stillMissing = requestedTaskIds.filter(
      (taskId) => !refreshed.has(taskId),
    );
    if (stillMissing.length > 0) {
      throw new Error(
        `task input not found locally: ${stillMissing.join(",")}; use --collect-task-input to collect it first`,
      );
    }
    refs = refs.filter((ref) => requestedSet.has(ref.taskId));
  }

  if (limit !== undefined) refs = refs.slice(0, limit);
  if (refs.length === 0) {
    throw new Error("no local task with the requested slot was found");
  }

  const fetchSzdata = !hasFlag("--no-fetch-szdata");
  const startedAt = new Date().toISOString();
  const results: RunResult[] = [];
  for (const [index, ref] of refs.entries()) {
    console.error(
      JSON.stringify({
        progress: "task_started",
        index: index + 1,
        total: refs.length,
        task_id: ref.taskId,
        category: ref.category,
        slot,
      }),
    );
    const taskResult = inspectOne(ref, dataRoot, slot, fetchSzdata);
    results.push(taskResult);
    console.error(JSON.stringify({ progress: "task_finished", ...taskResult }));
  }

  const outputPath = resolve(
    arg("--output") ??
      join(
        repoRoot,
        "tmp",
        "inspect-results",
        "batch",
        `${slot}-${Date.now()}.summary.json`,
      ),
  );
  const batchSummary = {
    pipeline: "task-source -> physical-table-schema -> plan-adapter",
    temporary: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data_root: dataRoot,
    slot,
    fetch_szdata: fetchSzdata,
    requested_task_ids: requestedTaskIds,
    selected_count: refs.length,
    counts: {
      success: results.filter((item) => item.status === "SUCCESS").length,
      partial: results.filter((item) => item.status === "PARTIAL").length,
      failed: results.filter((item) => item.status === "FAILED").length,
    },
    results,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    `${JSON.stringify(batchSummary, null, 2)}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify({ progress: "batch_summary_written", path: outputPath }),
  );
}

main();
