import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTableProducerIndex,
  updateTableProducerIndex,
} from "../../../../../reconcile/producer/producer-index.ts";
import { isLegacyProducerIndexPath } from "../../../../../query/table-writer-lookup.ts";
import { openWriterCatalog } from "../../../../../query/writer-catalog.ts";
import { INPUT_PACK_BATCH_SIZE_HARD_LIMIT } from "../../../../../input/mainline/task-batch.ts";
import {
  reconcileOneHop,
  summarizeOneHop,
  summaryPathFromOutput,
  type OneHopReconciliationResult,
} from "./reconcile-one-hop.ts";
import {
  DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  loadTerminalTableConfig,
} from "../../../../../reconcile/shared/terminal-table-config.ts";

interface CliOptions {
  readonly taskId: string;
  readonly dataRoot: string;
  readonly producerIndexPath: string;
  readonly output?: string;
  readonly summaryOutput?: string;
  readonly force: boolean;
  readonly terminalTableConfigPath: string;
}

const repoRoot = resolve(import.meta.dirname, "../../../../../..");
const collector = join(
  repoRoot,
  "scripts",
  "input",
  "mainline",
  "collect-task-input-pack.ts",
);
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name.slice(2).toUpperCase()}_REQUIRED`);
  return value;
}

function parseCli(args: readonly string[]): CliOptions {
  const allowedWithValues = new Set([
    "--task-id",
    "--data-root",
    "--producer-index",
    "--writer-catalog",
    "--output",
    "--summary-output",
    "--terminal-table-config",
  ]);
  const allowedFlags = new Set(["--force"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (allowedFlags.has(argument)) continue;
    if (!argument?.startsWith("--") || !allowedWithValues.has(argument))
      throw new Error(`UNKNOWN_ARGUMENT:${argument ?? "MISSING"}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`VALUE_REQUIRED:${argument}`);
    index += 1;
  }
  return {
    taskId: requiredOption(args, "--task-id"),
    dataRoot: requiredOption(args, "--data-root"),
    producerIndexPath:
      option(args, "--writer-catalog") ??
      requiredOption(args, "--producer-index"),
    output: option(args, "--output"),
    summaryOutput: option(args, "--summary-output"),
    force: args.includes("--force"),
    terminalTableConfigPath:
      option(args, "--terminal-table-config") ??
      DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  };
}

export function runCollector(
  dataRoot: string,
  taskIds: readonly string[],
  force: boolean,
): void {
  if (taskIds.length === 0) return;
  for (const [batchIndex, batch] of inputPackTaskBatches(taskIds).entries()) {
    const batchStart = batchIndex * INPUT_PACK_BATCH_SIZE_HARD_LIMIT;
    const args = [collector, "--data-root", dataRoot, "--task-ids", batch.join(",")];
    if (force) args.push("--force");
    process.stderr.write(
      `${JSON.stringify({
        autofill: "INPUT_PACK_COLLECTION_STARTED",
        taskIds: batch,
        batchStart,
        batchSize: batch.length,
      })}\n`,
    );
    const result = spawnSync(process.execPath, [tsxCli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0)
      throw new Error(
        `INPUT_PACK_COLLECTION_FAILED:${result.error?.message ?? result.status ?? "unknown"}`,
      );
  }
}

export function inputPackTaskBatches(
  taskIds: readonly string[],
): readonly (readonly string[])[] {
  const batches: string[][] = [];
  for (let start = 0; start < taskIds.length; start += INPUT_PACK_BATCH_SIZE_HARD_LIMIT)
    batches.push([...taskIds.slice(start, start + INPUT_PACK_BATCH_SIZE_HARD_LIMIT)]);
  return batches;
}

function writeResult(
  result: OneHopReconciliationResult,
  outputInput: string | undefined,
  summaryOutputInput: string | undefined,
): void {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const summary = `${JSON.stringify(summarizeOneHop(result), null, 2)}\n`;
  if (outputInput) {
    const output = isAbsolute(outputInput) ? outputInput : resolve(outputInput);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized, "utf8");
  } else {
    process.stdout.write(serialized);
  }
  if (summaryOutputInput || outputInput) {
    const summaryOutput = summaryOutputInput
      ? isAbsolute(summaryOutputInput)
        ? summaryOutputInput
        : resolve(summaryOutputInput)
      : summaryPathFromOutput(
          isAbsolute(outputInput!) ? outputInput! : resolve(outputInput!),
        );
    mkdirSync(dirname(summaryOutput), { recursive: true });
    writeFileSync(summaryOutput, summary, "utf8");
  }
}

export function missingTaskInputPackIds(
  result: OneHopReconciliationResult,
): readonly string[] {
  return result.issueDetails
    .filter(
      (detail) =>
        detail.code === "TASK_INPUT_PACK_MISSING" && detail.taskId !== undefined,
    )
    .map((detail) => detail.taskId!)
    .filter((taskId, index, all) => all.indexOf(taskId) === index)
    .sort();
}

export function runOneHopAutofill(options: CliOptions): OneHopReconciliationResult {
  const dataRoot = resolve(options.dataRoot);
  const producerIndexPath = resolve(options.producerIndexPath);
  const terminalTableConfig = loadTerminalTableConfig(
    resolve(options.terminalTableConfigPath),
  );
  if (!isLegacyProducerIndexPath(producerIndexPath)) {
    const writerCatalog = openWriterCatalog(producerIndexPath);
    const firstPass = reconcileOneHop(options.taskId, {
      dataRoot,
      writerCatalog,
      terminalTableConfig,
    });
    const missingIds = missingTaskInputPackIds(firstPass);
    runCollector(dataRoot, missingIds, options.force);
    const finalResult = reconcileOneHop(options.taskId, {
      dataRoot,
      writerCatalog,
      terminalTableConfig,
    });
    writeResult(finalResult, options.output, options.summaryOutput);
    return finalResult;
  }
  const initialIndex = existsSync(producerIndexPath)
    ? loadTableProducerIndex(producerIndexPath)
    : updateTableProducerIndex(
        dataRoot,
        producerIndexPath,
        `${producerIndexPath}.manifest.json`,
      ).index;

  const firstPass = reconcileOneHop(options.taskId, {
    dataRoot,
    producerIndex: initialIndex,
    terminalTableConfig,
  });
  const missingIds = missingTaskInputPackIds(firstPass);
  runCollector(dataRoot, missingIds, options.force);

  const updated = updateTableProducerIndex(
    dataRoot,
    producerIndexPath,
    `${producerIndexPath}.manifest.json`,
  );
  const finalResult = reconcileOneHop(options.taskId, {
    dataRoot,
    producerIndex: updated.index,
    verifyInputFingerprint: true,
    terminalTableConfig,
  });
  writeResult(finalResult, options.output, options.summaryOutput);
  return finalResult;
}

function main(): void {
  runOneHopAutofill(parseCli(process.argv.slice(2)));
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) main();
