import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTableProducerIndex,
  type TableProducerIndex,
} from "../../../../../reconcile/producer/producer-index.ts";
import { isLegacyProducerIndexPath } from "../../../../../query/table-writer-lookup.ts";
import {
  openWriterCatalog,
  type WriterCatalogHandle,
} from "../../../../../query/writer-catalog.ts";
import {
  reconcileOneHopBatch as reconcileOneHopRoots,
  type OneHopReconciliationResult,
} from "./reconcile-one-hop.ts";
import {
  DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  loadTerminalTableConfig,
  type TerminalTableConfig,
} from "../../../../../reconcile/shared/terminal-table-config.ts";

interface CliOptions {
  readonly taskIds: readonly string[];
  readonly dataRoot: string;
  readonly producerIndexPath: string;
  readonly outputDir: string;
  readonly verifyInputFingerprint: boolean;
  readonly terminalTableConfigPath: string;
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface ReconcileOneHopBatchOptions {
  readonly taskIds: readonly string[];
  readonly dataRoot: string;
  readonly producerIndex?: TableProducerIndex;
  readonly writerCatalog?: WriterCatalogHandle;
  readonly verifyInputFingerprint?: boolean;
  readonly terminalTableConfig?: TerminalTableConfig;
}

function parseTaskIds(value: string): readonly string[] {
  const taskIds = [...new Set(value.split(",").map((item) => item.trim()))];
  if (
    taskIds.length === 0 ||
    taskIds.some((taskId) => !SAFE_TASK_ID.test(taskId))
  )
    throw new Error("TASK_IDS_INVALID");
  return taskIds;
}

function parseCli(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const verifyFlag = "--verify-input-fingerprint";
  const allowed = new Set([
    "--task-ids",
    "--data-root",
    "--producer-index",
    "--writer-catalog",
    "--output-dir",
    "--terminal-table-config",
    verifyFlag,
  ]);
  let verifyInputFingerprint = false;
  for (let index = 0; index < argv.length; ) {
    const flag = argv[index];
    if (flag === verifyFlag) {
      if (verifyInputFingerprint) throw new Error(`DUPLICATE_ARGUMENT:${flag}`);
      verifyInputFingerprint = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Error(`INVALID_ARGUMENT:${flag ?? "MISSING"}`);
    if (!allowed.has(flag)) throw new Error(`UNKNOWN_ARGUMENT:${flag}`);
    if (values.has(flag)) throw new Error(`DUPLICATE_ARGUMENT:${flag}`);
    values.set(flag, value);
    index += 2;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value)
      throw new Error(
        `${flag.slice(2).toUpperCase().replaceAll("-", "_")}_REQUIRED`,
      );
    return value;
  };
  return {
    taskIds: parseTaskIds(required("--task-ids")),
    dataRoot: required("--data-root"),
    producerIndexPath:
      values.get("--writer-catalog") ?? required("--producer-index"),
    outputDir: required("--output-dir"),
    verifyInputFingerprint,
    terminalTableConfigPath:
      values.get("--terminal-table-config") ??
      DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  };
}

export function reconcileOneHopBatch(
  options: ReconcileOneHopBatchOptions,
): readonly OneHopReconciliationResult[] {
  return reconcileOneHopRoots(options.taskIds, {
    dataRoot: options.dataRoot,
    producerIndex: options.producerIndex,
    writerCatalog: options.writerCatalog,
    verifyInputFingerprint: options.verifyInputFingerprint,
    terminalTableConfig: options.terminalTableConfig,
  });
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const lookupPath = resolve(cli.producerIndexPath);
  const producerIndex = isLegacyProducerIndexPath(lookupPath)
    ? loadTableProducerIndex(lookupPath)
    : undefined;
  const writerCatalog = isLegacyProducerIndexPath(lookupPath)
    ? undefined
    : openWriterCatalog(lookupPath);
  const results = reconcileOneHopBatch({
    ...cli,
    producerIndex,
    writerCatalog,
    terminalTableConfig: loadTerminalTableConfig(
      resolve(cli.terminalTableConfigPath),
    ),
  });
  const outputDir = resolve(cli.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const summary = results.map((result) => {
    const output = join(outputDir, `reconcile-${result.taskId}.json`);
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return { taskId: result.taskId, output, counts: result.counts };
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) main();
