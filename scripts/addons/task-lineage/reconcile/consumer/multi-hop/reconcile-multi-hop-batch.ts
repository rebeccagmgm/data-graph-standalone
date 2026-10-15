import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  reconcileMultiHopBatch as reconcileMultiHopRoots,
  type MultiHopBatchRoot,
  type MultiHopReconciliationResult,
} from "./reconcile-multi-hop.ts";
import {
  DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  loadTerminalTableConfig,
} from "../../../../../reconcile/shared/terminal-table-config.ts";
import type { OneHopReconciliationResult } from "../one-hop/reconcile-one-hop.ts";

interface CliOptions {
  readonly taskIds: readonly string[];
  readonly dataRoot: string;
  readonly producerIndexPath: string;
  readonly outputDir: string;
  readonly rootOneHopDir: string | null;
  readonly maxDepth: number;
  readonly maxTasks: number;
  readonly maxEdges: number;
  readonly terminalTableConfigPath: string;
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface ReconcileMultiHopBatchOptions {
  readonly taskIds: readonly string[];
  readonly dataRoot: string;
  readonly producerIndex?: TableProducerIndex;
  readonly writerCatalog?: WriterCatalogHandle;
  readonly outputDir?: string;
  readonly rootOneHopDir?: string | null;
  readonly maxDepth: number;
  readonly maxTasks: number;
  readonly maxEdges: number;
  readonly terminalTableConfigPath: string;
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
  const allowed = new Set([
    "--task-ids",
    "--data-root",
    "--producer-index",
    "--writer-catalog",
    "--output-dir",
    "--root-one-hop-dir",
    "--max-depth",
    "--max-tasks",
    "--max-edges",
    "--terminal-table-config",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
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
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value)
      throw new Error(
        `${flag.slice(2).toUpperCase().replaceAll("-", "_")}_REQUIRED`,
      );
    return value;
  };
  const integer = (flag: string, fallback: number): number => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value))
      throw new Error(`${flag.slice(2).toUpperCase()}_INVALID`);
    return value;
  };
  return {
    taskIds: parseTaskIds(required("--task-ids")),
    dataRoot: required("--data-root"),
    producerIndexPath:
      values.get("--writer-catalog") ?? required("--producer-index"),
    outputDir: required("--output-dir"),
    rootOneHopDir: values.get("--root-one-hop-dir") ?? null,
    maxDepth: integer("--max-depth", 3),
    maxTasks: integer("--max-tasks", 100),
    maxEdges: integer("--max-edges", 500),
    terminalTableConfigPath:
      values.get("--terminal-table-config") ??
      DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  };
}

function readRootOneHop(
  rootOneHopDir: string | null,
  taskId: string,
): OneHopReconciliationResult | undefined {
  if (rootOneHopDir === null) return undefined;
  const candidates = [
    join(rootOneHopDir, `reconcile-${taskId}.json`),
    join(rootOneHopDir, `${taskId}.json`),
  ];
  const path = candidates.find((candidate) => {
    try {
      readFileSync(candidate, "utf8");
      return true;
    } catch {
      return false;
    }
  });
  if (path === undefined) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as OneHopReconciliationResult;
}

function outputPath(outputDir: string, taskId: string): string {
  return join(outputDir, `reconcile-multi-${taskId}.json`);
}

export function reconcileMultiHopBatch(
  options: ReconcileMultiHopBatchOptions,
): readonly MultiHopReconciliationResult[] {
  const terminalTableConfig = loadTerminalTableConfig(
    resolve(options.terminalTableConfigPath),
  );
  const roots: MultiHopBatchRoot[] = options.taskIds.map((taskId) => {
    const rootOneHop = readRootOneHop(options.rootOneHopDir ?? null, taskId);
    return rootOneHop ? { taskId, rootOneHop } : { taskId };
  });
  return reconcileMultiHopRoots(roots, {
    dataRoot: options.dataRoot,
    producerIndex: options.producerIndex,
    writerCatalog: options.writerCatalog,
    maxDepth: options.maxDepth,
    maxTasks: options.maxTasks,
    maxEdges: options.maxEdges,
    terminalTableConfig,
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
  const results = reconcileMultiHopBatch({
    ...cli,
    producerIndex,
    writerCatalog,
  });
  mkdirSync(resolve(cli.outputDir), { recursive: true });
  const summary = results.map((result) => {
    const output = outputPath(resolve(cli.outputDir), result.rootTaskId);
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return {
      taskId: result.rootTaskId,
      output,
      counts: result.counts,
      coverage: result.coverage,
      limits: result.limits,
    };
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) main();
