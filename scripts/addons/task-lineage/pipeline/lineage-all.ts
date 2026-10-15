import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, relative, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  runInputPackMachineFacts,
  type InputPackMachineFactsRunResult,
} from "../../../machine-facts/input-pack-machine-facts.ts";
import {
  runInputPackClosure,
  type InputPackClosureOptions,
  type InputPackClosureResult,
} from "./input-pack-closure.ts";
import {
  DEFAULT_FIELD_LINEAGE_MAX_PATHS,
  DEFAULT_FIELD_LINEAGE_MAX_STATES,
  reconcileFieldLineage,
  type ReconcileFieldLineageOptions,
} from "../reconcile/consumer/field-lineage/field-lineage.ts";
import type {
  FactsPolicy,
  FieldLineageArtifact,
} from "../reconcile/consumer/field-lineage/field-lineage-contract.ts";
import { visualizeFieldLineage } from "../visualize/field-lineage-visualize.ts";
import { visualizeMultiHop } from "../visualize/multi-hop-visualize.ts";
import type { OneHopReconciliationResult } from "../reconcile/consumer/one-hop/reconcile-one-hop.ts";
import {
  reconcileOneHopBatch,
  defaultOpenCliRunner,
  type ReconcileOneHopOptions,
} from "../reconcile/consumer/one-hop/reconcile-one-hop.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeRelationCache,
  readHoraeTaskTypeCache,
  scheduleEvidenceCachePath,
  writeHoraeRelationCache,
  writeHoraeTaskTypeCache,
  type HoraeRelationDirection,
  type ScheduleEvidenceCacheStatus,
} from "../../../evidence/schedule-evidence-cache.ts";
import { runCollector } from "../reconcile/consumer/one-hop/reconcile-one-hop-autofill.ts";
import { reconcileMultiHop } from "../reconcile/consumer/multi-hop/reconcile-multi-hop.ts";
import {
  DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  loadTerminalTableConfig,
  matchingTerminalRole,
} from "../../../reconcile/shared/terminal-table-config.ts";
import { queryProducerTaskIds } from "../reconcile/consumer/multi-hop/reconcile-multi-hop-autofill.ts";
import {
  fingerprintTableProducerInputs,
} from "../../../reconcile/producer/producer-index.ts";
import {
  openWriterCatalog,
  resolveWriterCatalogPath,
  type WriterCatalogHandle,
} from "../../../query/writer-catalog.ts";
import {
  validateTaskDocument,
  type TaskDocument,
} from "../../../input/shared/input-pack.ts";
import { isCheckdbflagTask } from "../../../reconcile/shared/lineage-scope.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_MAX_DEPTH = 25;
const DEFAULT_MAX_ROUNDS = DEFAULT_MAX_DEPTH + 3;
const DEFAULT_MAX_TASKS = 1000;
const DEFAULT_MAX_EDGES = 10000;
const DEFAULT_MAX_DISCOVERED_TASKS = 5000;
const DEFAULT_HORAE_PREFETCH_CONCURRENCY = 4;
const DEFAULT_HORAE_MIN_INTERVAL_MS = 2_000;
const DEFAULT_HORAE_PREFETCH_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_FIELD_PRODUCER_DISCOVERY_ATTEMPTS = 3;
const execFileAsync = promisify(execFile);

export interface PrefetchedScheduleEvidence {
  readonly rows: readonly Record<string, unknown>[];
  readonly provider: "opencli:horae.relation";
  readonly locator: string;
  readonly observedAt: string;
  readonly cacheStatus?: Exclude<ScheduleEvidenceCacheStatus, "DISABLED">;
  readonly cachePath?: string;
}

export interface InputPackClosureArtifact {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "INPUT_PACK_CLOSURE";
  readonly generatedAt: string;
  readonly rootTaskId: string;
  readonly requestedFields: readonly string[];
  readonly initialTaskIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly discoveredTaskIds: readonly string[];
  readonly collectedTaskIds: readonly string[];
  readonly fieldDrivenProducerTables: readonly string[];
  readonly fieldDrivenProducerTaskIds: readonly string[];
  readonly fieldDrivenCollectedTaskIds: readonly string[];
  readonly rounds: {
    readonly inputPack: number;
    readonly fieldAutofill: number;
    readonly total: number;
  };
  readonly status: "COMPLETE" | "PARTIAL";
  readonly issues: readonly string[];
  readonly writerCatalogSnapshot: {
    readonly catalogPath: string;
    readonly inputFingerprint: string;
  };
  readonly boundaries: {
    readonly directIndirectClassification: "IN_MULTI_HOP_ARTIFACT";
    readonly fieldAutofillRerunsRootClosure: false;
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en-US", { numeric: true }),
  );
}

function defaultSleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function defaultAsyncSleep(milliseconds: number): Promise<void> {
  return milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class HoraeSerialGate {
  private tail: Promise<void> = Promise.resolve();

  private lastStartedAt: number | undefined;

  public constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (
      milliseconds: number,
    ) => Promise<void> = defaultAsyncSleep,
  ) {
    if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0)
      throw new Error("HORAE_MIN_INTERVAL_INVALID");
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const previousStart = this.lastStartedAt;
      if (previousStart !== undefined) {
        const remaining = this.minIntervalMs - (this.now() - previousStart);
        if (remaining > 0) await this.sleep(remaining);
      }
      this.lastStartedAt = this.now();
      return await operation();
    } finally {
      release();
    }
  }
}

function defaultFieldProducerDiscovery(
  qualifiedName: string,
): readonly string[] {
  return queryProducerTaskIds(
    qualifiedName,
    defaultOpenCliRunner,
    DEFAULT_FIELD_PRODUCER_DISCOVERY_ATTEMPTS,
    defaultSleep,
  );
}

function fieldSourceTablesMissingProducerBridge(
  fieldArtifact: FieldLineageArtifact,
  tableLineage: ReturnType<typeof reconcileMultiHop>,
): readonly string[] {
  const bridgedTables = new Set(
    (Array.isArray(tableLineage.producerBridges)
      ? tableLineage.producerBridges
      : []
    ).map((bridge) => {
      const table =
        bridge.table?.qualifiedName?.trim().toLocaleLowerCase("en-US") ?? "";
      return `${bridge.consumerTaskId}\u0000${table}`;
    }),
  );
  return [
    ...new Set(
      (Array.isArray(fieldArtifact.nodes) ? fieldArtifact.nodes : [])
        .filter(
          (node) =>
            node.bindingId === null &&
            node.expressionId === null &&
            node.field.identityStatus === "SCHEMA_BACKED" &&
            node.field.platform.toLocaleLowerCase("en-US") === "hive" &&
            !bridgedTables.has(
              `${node.taskId}\u0000${node.field.qualifiedName.toLocaleLowerCase("en-US")}`,
            ),
        )
        .map((node) => node.field.qualifiedName),
    ),
  ].sort((left, right) => left.localeCompare(right, "en-US"));
}

export interface HoraePrefetchOptions {
  readonly concurrency?: number;
  readonly run?: (args: readonly string[]) => Promise<unknown>;
  readonly now?: () => string;
  readonly maxRowsPerTask?: number;
  readonly maxTotalRows?: number;
  readonly maxTotalBytes?: number;
  /** Null disables the cache; omitted uses the fixed root for the default runner. */
  readonly cacheRoot?: string | null;
  /** Cache the complete normalized `horae detail` row beside relation evidence. */
  readonly cacheTaskDetails?: boolean;
  /** Minimum start-to-start interval for all Horae calls in this prefetch. */
  readonly horaeMinIntervalMs?: number;
  /** Relation direction. Existing lineage consumers default to upstream. */
  readonly direction?: HoraeRelationDirection;
}

function rowsOfHorae(
  value: unknown,
  taskId: string,
): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.map((row) => {
      if (typeof row !== "object" || row === null || Array.isArray(row))
        throw new Error(`HORAE_RELATION_PREFETCH_INVALID_ROWS:${taskId}`);
      const record = row as Record<string, unknown>;
      const rowTask = record.task_id ?? record.taskId;
      if (typeof rowTask !== "string" || !SAFE_TASK_ID.test(rowTask))
        throw new Error(`HORAE_RELATION_PREFETCH_INVALID_ROWS:${taskId}`);
      return record;
    });
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`HORAE_RELATION_PREFETCH_INVALID_ENVELOPE:${taskId}`);
  const record = value as Record<string, unknown>;
  if (
    record.error !== undefined ||
    record.success === false ||
    ["fail", "failed", "failure", "error"].includes(
      String(record.status ?? "").toLowerCase(),
    )
  )
    throw new Error(`HORAE_RELATION_PREFETCH_INVALID_ENVELOPE:${taskId}`);
  for (const field of ["records", "rows", "data", "results"]) {
    if (Array.isArray(record[field])) return rowsOfHorae(record[field], taskId);
  }
  throw new Error(`HORAE_RELATION_PREFETCH_INVALID_ENVELOPE:${taskId}`);
}

function detailOfHorae(
  value: unknown,
  taskId: string,
): Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new Error(`HORAE_TASK_DETAIL_INVALID:${taskId}`);
  return row as Record<string, unknown>;
}

function horaeDetailArguments(taskId: string): readonly string[] {
  return ["horae", "detail", taskId, "-f", "json"];
}

export async function defaultHoraeRunner(
  args: readonly string[],
): Promise<unknown> {
  const appData = process.env.APPDATA;
  const packageRoot = appData
    ? resolve(appData, "npm", "node_modules", "@jackwener", "opencli")
    : "";
  const entry = packageRoot
    ? resolve(packageRoot, "dist", "src", "main.js")
    : "";
  if (
    process.platform === "win32" &&
    (!appData ||
      !isAbsolute(entry) ||
      !entry.startsWith(`${packageRoot}${sep}`) ||
      !existsSync(entry))
  )
    throw new Error("LAUNCHER_UNAVAILABLE");
  const executable =
    process.platform === "win32"
      ? process.execPath
      : (process.env.OPENCLI_EXECUTABLE ?? "opencli");
  const executableArgs =
    process.platform === "win32" ? [entry, ...args] : [...args];
  try {
    const { stdout } = await execFileAsync(executable, executableArgs, {
      cwd: process.cwd(),
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    try {
      return JSON.parse(stdout.trim()) as unknown;
    } catch {
      throw new Error("INVALID_JSON");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      ["INVALID_JSON", "LAUNCHER_UNAVAILABLE"].includes(error.message)
    )
      throw error;
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code === "ETIMEDOUT") throw new Error("TIMEOUT");
    if (code.includes("MAXBUFFER")) throw new Error("OUTPUT_LIMIT");
    throw new Error("RUNNER_FAILED");
  }
}

export async function prefetchHoraeRelations(
  taskIds: readonly string[],
  options: HoraePrefetchOptions = {},
): Promise<ReadonlyMap<string, PrefetchedScheduleEvidence>> {
  const concurrency = options.concurrency ?? DEFAULT_HORAE_PREFETCH_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error("HORAE_PREFETCH_CONCURRENCY_INVALID");
  const run = options.run ?? defaultHoraeRunner;
  const direction = options.direction ?? "up";
  const cacheRoot =
    options.cacheRoot === undefined
      ? options.run === undefined
        ? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT
        : null
      : options.cacheRoot;
  const now = options.now ?? (() => new Date().toISOString());
  const maxRowsPerTask = options.maxRowsPerTask ?? 10_000;
  const maxTotalRows = options.maxTotalRows ?? 100_000;
  const maxTotalBytes =
    options.maxTotalBytes ?? DEFAULT_HORAE_PREFETCH_MAX_TOTAL_BYTES;
  if (
    ![maxRowsPerTask, maxTotalRows, maxTotalBytes].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("HORAE_PREFETCH_BUDGET_INVALID");
  const result = new Map<string, PrefetchedScheduleEvidence>();
  const cacheTaskDetails =
    options.cacheTaskDetails ??
    (options.run === undefined && cacheRoot !== null);
  const horaeGate = new HoraeSerialGate(
    options.horaeMinIntervalMs ??
      (options.run === undefined ? DEFAULT_HORAE_MIN_INTERVAL_MS : 0),
  );
  const detailPromises = new Map<string, Promise<void>>();
  const runHorae = (args: readonly string[]): Promise<unknown> =>
    horaeGate.run(() => run(args));
  const cacheTaskDetail = (taskId: string): Promise<void> => {
    if (!cacheTaskDetails || cacheRoot === null) return Promise.resolve();
    const cached = readHoraeTaskTypeCache(taskId, cacheRoot);
    if (cached.status === "HIT") return Promise.resolve();
    const existing = detailPromises.get(taskId);
    if (existing !== undefined) return existing;
    const promise = runHorae(horaeDetailArguments(taskId))
      .then((response) => detailOfHorae(response, taskId))
      .then((detail) => {
        try {
          writeHoraeTaskTypeCache(taskId, now(), detail, cacheRoot);
        } catch {
          // Detail enrichment is optional; relation evidence remains usable.
        }
      })
      .catch(() => {
        // Detail enrichment is optional; relation evidence remains usable.
      })
      .finally(() => {
        detailPromises.delete(taskId);
      });
    detailPromises.set(taskId, promise);
    return promise;
  };
  let cursor = 0;
  let stopped = false;
  let totalRows = 0;
  let totalBytes = 0;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = cursor++;
      if (index >= taskIds.length) return;
      const taskId = taskIds[index]!;
      if (!SAFE_TASK_ID.test(taskId)) {
        stopped = true;
        throw new Error(`HORAE_RELATION_PREFETCH_INVALID_TASK:${taskId}`);
      }
      const args = [
        "horae",
        "relation",
        taskId,
        "--direction",
        direction,
        "--depth",
        "1",
        "-f",
        "json",
      ];
      try {
        const cached =
          cacheRoot === null
            ? null
            : readHoraeRelationCache(taskId, cacheRoot, direction);
        let rows: Record<string, unknown>[];
        let observedAt: string;
        let cacheStatus:
          Exclude<ScheduleEvidenceCacheStatus, "DISABLED"> | undefined;
        let cachePath: string | undefined;
        if (cached?.status === "HIT") {
          rows = [...cached.rows];
          observedAt = cached.observedAt;
          cacheStatus = "HIT";
          cachePath = cached.path;
        } else {
          const started = now();
          const parsed = await runHorae(args);
          rows = rowsOfHorae(parsed, taskId);
          observedAt = started;
          if (cacheRoot !== null) {
            cacheStatus = cached?.status ?? "MISS";
            cachePath =
              cached?.path ??
              scheduleEvidenceCachePath(taskId, cacheRoot, direction);
          }
        }
        if (rows.length > maxRowsPerTask)
          throw new Error(`OUTPUT_LIMIT:${taskId}`);
        totalRows += rows.length;
        if (totalRows > maxTotalRows) throw new Error(`OUTPUT_LIMIT:${taskId}`);
        totalBytes += new TextEncoder().encode(JSON.stringify(rows)).byteLength;
        if (totalBytes > maxTotalBytes)
          throw new Error(`OUTPUT_LIMIT:${taskId}`);
        if (cacheRoot !== null && cacheStatus !== "HIT") {
          try {
            cachePath = writeHoraeRelationCache(
              taskId,
              observedAt,
              rows,
              cacheRoot,
              direction,
            );
          } catch {
            // Scheduler evidence remains usable when the optional cache is not writable.
          }
        }
        if (cacheTaskDetails) {
          const detailTaskIds = [
            taskId,
            ...rows.map((row) => row.task_id ?? row.taskId),
          ]
            .filter((value): value is string => typeof value === "string")
            .filter((value, index, values) => values.indexOf(value) === index);
          await Promise.all(detailTaskIds.map(cacheTaskDetail));
        }
        result.set(taskId, {
          rows,
          provider: "opencli:horae.relation",
          locator: `opencli ${args.join(" ")}`,
          observedAt,
          ...(cacheStatus === undefined ? {} : { cacheStatus }),
          ...(cachePath === undefined ? {} : { cachePath }),
        });
      } catch (error) {
        stopped = true;
        const reason =
          error instanceof Error &&
          /(?:^|_)(TIMEOUT|LAUNCHER_UNAVAILABLE|INVALID_JSON|INVALID_ENVELOPE|INVALID_ROWS|OUTPUT_LIMIT|RUNNER_FAILED)(?::|$)/.test(
            error.message,
          )
            ? error.message.match(
                /(TIMEOUT|LAUNCHER_UNAVAILABLE|INVALID_JSON|INVALID_ENVELOPE|INVALID_ROWS|OUTPUT_LIMIT|RUNNER_FAILED)/,
              )![1]!
            : "RUNNER_FAILED";
        throw new Error(`HORAE_RELATION_PREFETCH_${reason}:${taskId}`);
      }
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, taskIds.length) }, () =>
      worker(),
    ),
  );
  const failed = settled.find(
    (item): item is PromiseRejectedResult => item.status === "rejected",
  );
  if (failed) throw failed.reason;
  return result;
}

export interface LineageAllOptions {
  readonly dataRoot: string;
  readonly taskIds: readonly string[];
  readonly artifactRoot?: string;
  /** Durable Machine Facts cache. Defaults to <dataRoot>/field-facts. */
  readonly factsRoot?: string;
  readonly withFields?: boolean;
  readonly fields?: readonly string[];
  readonly factsPolicy?: FactsPolicy;
  readonly terminalTableConfigPath?: string;
  readonly maxDepth?: number;
  readonly maxTasks?: number;
  readonly maxEdges?: number;
  readonly maxRounds?: number;
  readonly writerCatalogPath?: string;
  readonly force?: boolean;
  readonly dependencies?: Partial<LineageAllDependencies>;
}

export interface LineageAllDependencies {
  readonly autofill: (
    options: InputPackClosureOptions,
  ) => InputPackClosureResult;
  readonly machineFacts: (
    options: Parameters<typeof runInputPackMachineFacts>[0],
  ) => InputPackMachineFactsRunResult;
  readonly fieldLineage: (
    options: ReconcileFieldLineageOptions,
  ) => FieldLineageArtifact;
  readonly oneHopBatch: (
    taskIds: readonly string[],
    options: ReconcileOneHopOptions,
  ) => readonly OneHopReconciliationResult[];
  readonly multiHop: typeof reconcileMultiHop;
  readonly openWriterCatalog: (path: string) => WriterCatalogHandle;
  readonly collectTaskPacks: (
    dataRoot: string,
    taskIds: readonly string[],
    force: boolean,
  ) => void;
  readonly fieldProducerDiscovery: (qualifiedName: string) => readonly string[];
  readonly schedulePrefetch: (
    taskIds: readonly string[],
  ) => Promise<ReadonlyMap<string, PrefetchedScheduleEvidence>>;
  readonly visualizeMultiHop: typeof visualizeMultiHop;
  readonly visualizeFieldLineage: typeof visualizeFieldLineage;
}

export interface LineageAllTaskResult {
  readonly taskId: string;
  readonly status: "SUCCESS" | "FAILED";
  readonly artifactDir: string;
  readonly files: readonly string[];
  readonly error?: string;
}

export interface LineageAllResult {
  readonly dataRoot: string;
  readonly artifactRoot: string;
  readonly taskIds: readonly string[];
  readonly tasks: readonly LineageAllTaskResult[];
  readonly status: "SUCCESS" | "PARTIAL_FAILURE";
}

export interface ParsedLineageAllArgs extends LineageAllOptions {}

function dependencies(
  overrides: Partial<LineageAllDependencies> | undefined,
): LineageAllDependencies {
  return {
    autofill: runInputPackClosure,
    machineFacts: runInputPackMachineFacts,
    fieldLineage: reconcileFieldLineage,
    oneHopBatch: reconcileOneHopBatch,
    multiHop: reconcileMultiHop,
    openWriterCatalog,
    collectTaskPacks: runCollector,
    fieldProducerDiscovery: defaultFieldProducerDiscovery,
    // Dependency-injected test pipelines must not reach OpenCLI implicitly;
    // production (no overrides) uses the bounded live prefetch.
    schedulePrefetch: prefetchHoraeRelations,
    visualizeMultiHop,
    visualizeFieldLineage,
    ...overrides,
  };
}

function value(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const result = index >= 0 ? args[index + 1] : undefined;
  return result && !result.startsWith("--") ? result : undefined;
}

function integer(
  args: readonly string[],
  name: string,
  fallback: number,
): number {
  const raw = value(args, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(
      `${name.slice(2).toUpperCase().replaceAll("-", "_")}_INVALID`,
    );
  return parsed;
}

export function parseLineageAllArgs(
  args: readonly string[],
): ParsedLineageAllArgs {
  const dataRoot = value(args, "--data-root");
  const rawIds = [
    ...(value(args, "--task-ids") ?? "").split(","),
    ...args.flatMap((item, index) =>
      item === "--task-id" && args[index + 1]
        ? args[index + 1]!.split(",")
        : [],
    ),
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  const taskIds = [...new Set(rawIds)];
  if (!dataRoot || taskIds.length === 0)
    throw new Error(
      "usage: npm run addon:task-lineage:all -- --data-root <input-pack-root> --task-ids <id[,id...]> [--artifact-root <path>] [--with-fields]",
    );
  const unknown = args.filter(
    (item, index) =>
      item.startsWith("--") &&
      ![
        "--data-root",
        "--task-ids",
        "--task-id",
        "--artifact-root",
        "--facts-root",
        "--with-fields",
        "--fields",
        "--facts-policy",
        "--terminal-table-config",
        "--max-depth",
        "--max-tasks",
        "--max-edges",
        "--max-rounds",
        "--force",
        "--writer-catalog",
      ].includes(item) &&
      !(index > 0 && args[index - 1] === "--task-ids"),
  );
  if (unknown.length > 0) throw new Error(`UNKNOWN_ARGUMENT:${unknown[0]}`);
  const factsPolicy = (value(args, "--facts-policy") ??
    "current-only") as FactsPolicy;
  if (factsPolicy !== "current-only" && factsPolicy !== "allow-legacy-partial")
    throw new Error("FACTS_POLICY_INVALID");
  return {
    dataRoot,
    taskIds,
    artifactRoot: value(args, "--artifact-root"),
    factsRoot: value(args, "--facts-root"),
    withFields: args.includes("--with-fields"),
    fields: (value(args, "--fields") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    factsPolicy,
    terminalTableConfigPath: value(args, "--terminal-table-config"),
    maxDepth: integer(args, "--max-depth", DEFAULT_MAX_DEPTH),
    maxTasks: integer(args, "--max-tasks", DEFAULT_MAX_TASKS),
    maxEdges: integer(args, "--max-edges", DEFAULT_MAX_EDGES),
    maxRounds: integer(args, "--max-rounds", DEFAULT_MAX_ROUNDS),
    force: args.includes("--force"),
    writerCatalogPath: value(args, "--writer-catalog"),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function taskPackExists(dataRoot: string, taskId: string): boolean {
  const tasksRoot = join(resolve(dataRoot), "tasks");
  if (!existsSync(tasksRoot)) return false;
  const visit = (directory: string): boolean => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (
        entry.isDirectory() &&
        (entry.name === taskId
          ? existsSync(join(path, "task.json"))
          : visit(path))
      )
        return true;
    }
    return false;
  };
  return visit(tasksRoot);
}

export function formalArtifactPaths(
  artifactRootInput: string,
  taskId: string,
): {
  readonly directory: string;
  readonly oneHop: string;
  readonly multiHop: string;
  readonly fieldLineage: string;
  readonly inputPackClosure: string;
  readonly views: string;
  readonly tableHtml: string;
  readonly fieldHtml: string;
} {
  if (!SAFE_TASK_ID.test(taskId)) throw new Error("INVALID_TASK_ID");
  const directory = join(resolve(artifactRootInput), "tasks", taskId);
  return {
    directory,
    oneHop: join(directory, "one-hop.json"),
    multiHop: join(directory, "multi-hop.json"),
    fieldLineage: join(directory, "field-lineage.json"),
    inputPackClosure: join(directory, "input-pack-closure.json"),
    views: join(directory, "views"),
    tableHtml: join(directory, "views", "table-lineage.html"),
    fieldHtml: join(directory, "views", "field-lineage.html"),
  };
}

function writeJson(path: string, valueToWrite: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(valueToWrite, null, 2)}\n`, "utf8");
}

function progress(event: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(
    `[lineage-all] ${JSON.stringify({ event, ...details })}\n`,
  );
}

function taskTarget(dataRoot: string, taskId: string): string {
  const tasksRoot = join(resolve(dataRoot), "tasks");
  const candidates: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        entry.name === "task.json" &&
        path.includes(`${sep}${taskId}${sep}`)
      )
        candidates.push(path);
    }
  };
  if (existsSync(tasksRoot)) visit(tasksRoot);
  if (candidates.length !== 1)
    throw new Error(
      candidates.length === 0
        ? `TASK_INPUT_PACK_MISSING:${taskId}`
        : `TASK_INPUT_PACK_AMBIGUOUS:${taskId}`,
    );
  const parsed: unknown = JSON.parse(readFileSync(candidates[0]!, "utf8"));
  validateTaskDocument(parsed);
  const target = (parsed as TaskDocument).target;
  const qualifiedName =
    typeof target === "object" && target !== null && !Array.isArray(target)
      ? (target as Record<string, unknown>).qualifiedName
      : undefined;
  if (typeof qualifiedName !== "string" || !qualifiedName.trim())
    throw new Error(`TASK_TARGET_UNRESOLVED:${taskId}`);
  return qualifiedName.trim();
}

function taskCategoryIndex(dataRoot: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const tasksRoot = join(resolve(dataRoot), "tasks");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || entry.name !== "task.json") continue;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
          string,
          unknown
        >;
        const taskId =
          typeof parsed.taskId === "string" ? parsed.taskId : undefined;
        const category =
          typeof parsed.taskCategory === "string"
            ? parsed.taskCategory
            : undefined;
        if (taskId && category) result.set(taskId, category);
      } catch {
        // Invalid packs are handled by the normal Input Pack validation path.
      }
    }
  };
  if (existsSync(tasksRoot)) visit(tasksRoot);
  return result;
}

export function checkDbFlagTaskIds(
  dataRoot: string,
  snapshots: readonly OneHopReconciliationResult[],
): ReadonlySet<string> {
  const categories = taskCategoryIndex(dataRoot);
  const result = new Set<string>();
  for (const snapshot of snapshots) {
    for (const parent of snapshot.schedule?.parents ?? []) {
      if (
        isCheckdbflagTask({
          taskCategory: categories.get(parent.taskId),
          taskName: parent.taskName,
        })
      )
        result.add(parent.taskId);
    }
  }
  return result;
}

export function withoutCheckDbFlagParents(
  snapshot: OneHopReconciliationResult,
  checkDbFlagIds: ReadonlySet<string>,
): OneHopReconciliationResult {
  if (checkDbFlagIds.size === 0) return snapshot;
  const keep = (taskId: string): boolean => !checkDbFlagIds.has(taskId);
  return {
    ...snapshot,
    schedule: {
      ...snapshot.schedule,
      parents: snapshot.schedule.parents.filter((parent) =>
        keep(parent.taskId),
      ),
    },
    finalUpstreamTaskIds: {
      ...snapshot.finalUpstreamTaskIds,
      primary: snapshot.finalUpstreamTaskIds.primary.filter(keep),
      additional: snapshot.finalUpstreamTaskIds.additional.filter(keep),
      unknown: snapshot.finalUpstreamTaskIds.unknown.filter(keep),
    },
    dataPath: {
      ...snapshot.dataPath,
      confirmedProducers: snapshot.dataPath.confirmedProducers.filter(
        (producer) => keep(producer.taskId),
      ),
      readOccurrenceDecisions: snapshot.dataPath.readOccurrenceDecisions.map(
        (decision) => ({
          ...decision,
          candidates: decision.candidates.filter((candidate) =>
            keep(candidate.taskId),
          ),
          primary: decision.primary.filter(keep),
          additional: decision.additional.filter(keep),
          unknown: decision.unknown.filter(keep),
        }),
      ),
    },
  };
}

function acquireLock(artifactRoot: string, taskId: string): string {
  const lockRoot = join(resolve(artifactRoot), ".locks");
  mkdirSync(lockRoot, { recursive: true });
  const path = join(lockRoot, `${taskId}.lock`);
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx");
    writeFileSync(fd, `${process.pid}\n`, "utf8");
    closeSync(fd);
    return path;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw new Error(
      `TASK_LOCK_UNAVAILABLE:${taskId}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function publishStagedTask(
  stagedDir: string,
  finalDir: string,
  artifactRoot: string,
): void {
  if (!isWithin(artifactRoot, stagedDir) || !isWithin(artifactRoot, finalDir))
    throw new Error("ARTIFACT_PATH_OUTSIDE_ROOT");
  mkdirSync(dirname(finalDir), { recursive: true });
  const backup = `${finalDir}.previous-${randomUUID()}`;
  const hadFinal = existsSync(finalDir);
  if (hadFinal) {
    try {
      renameSync(finalDir, backup);
    } catch (error) {
      if (!isWindowsRenameBlocked(error)) throw error;
      publishStagedTaskInPlace(stagedDir, finalDir);
      return;
    }
  }
  try {
    renameSync(stagedDir, finalDir);
    if (hadFinal) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(finalDir))
      rmSync(finalDir, { recursive: true, force: true });
    if (hadFinal && existsSync(backup)) renameSync(backup, finalDir);
    throw error;
  }
}

function isWindowsRenameBlocked(error: unknown): boolean {
  if (
    process.platform !== "win32" ||
    typeof error !== "object" ||
    error === null
  )
    return false;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code === "EACCES" || code === "EBUSY" || code === "EPERM";
}

function relativeEntries(root: string, prefix = ""): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    entries.push(relativePath);
    if (entry.isDirectory())
      entries.push(...relativeEntries(join(root, entry.name), relativePath));
  }
  return entries;
}

function publishStagedTaskInPlace(stagedDir: string, finalDir: string): void {
  const stagedPaths = relativeEntries(stagedDir);
  const stagedSet = new Set(stagedPaths);
  mkdirSync(finalDir, { recursive: true });

  for (const relativePath of stagedPaths.filter((path) =>
    lstatSync(join(stagedDir, path)).isDirectory(),
  )) {
    const target = join(finalDir, relativePath);
    if (existsSync(target) && !lstatSync(target).isDirectory())
      rmSync(target, { force: true });
    mkdirSync(target, { recursive: true });
  }
  for (const relativePath of stagedPaths.filter(
    (path) => !lstatSync(join(stagedDir, path)).isDirectory(),
  )) {
    const source = join(stagedDir, relativePath);
    const target = join(finalDir, relativePath);
    if (existsSync(target) && lstatSync(target).isDirectory())
      rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }

  const stalePaths = relativeEntries(finalDir)
    .filter((path) => !stagedSet.has(path))
    .sort((left, right) => right.split(sep).length - left.split(sep).length);
  for (const relativePath of stalePaths)
    rmSync(join(finalDir, relativePath), { recursive: true, force: true });
  rmSync(stagedDir, { recursive: true, force: true });
}

async function runTask(
  options: LineageAllOptions,
  taskId: string,
  artifactRoot: string,
  deps: LineageAllDependencies,
): Promise<LineageAllTaskResult> {
  const paths = formalArtifactPaths(artifactRoot, taskId);
  const lock = acquireLock(artifactRoot, taskId);
  const stagingRoot = join(resolve(artifactRoot), ".staging");
  mkdirSync(stagingRoot, { recursive: true });
  const stagedDir = mkdtempSync(join(stagingRoot, `${taskId}-`));
  progress("task_start", {
    taskId,
    stagedDir,
    withFields: options.withFields === true,
  });
  try {
    const factsRoot = resolve(
      options.factsRoot ?? join(options.dataRoot, "field-facts"),
    );
    const terminalTableConfig = loadTerminalTableConfig(
      resolve(
        options.terminalTableConfigPath ?? DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
      ),
    );
    const queriedFieldTables = new Set<string>();
    const fieldDrivenProducerTables = new Set<string>();
    const fieldDrivenProducerTaskIds = new Set<string>();
    const fieldDrivenCollectedTaskIds = new Set<string>();
    let initialClosure: InputPackClosureResult | null = null;
    let fieldAutofillRounds = 0;
    let finalRawRootOneHop: OneHopReconciliationResult | null = null;
    let finalFormalMultiHop: ReturnType<typeof reconcileMultiHop> | null = null;
    let finalFieldArtifact: FieldLineageArtifact | null = null;
    let finalTrustedInputFingerprint: string | null = null;
    let finalWriterCatalogPath: string | null = null;
    let taskNodeIds: string[] | null = null;
    const factsPreparedTaskIds = new Set<string>();
    const multiHopPath = join(stagedDir, "multi-hop.json");
    const oneHopPath = join(stagedDir, "one-hop.json");
    const tableHtml = join(stagedDir, "views", "table-lineage.html");
    let tableHtmlRendered = false;

    while (true) {
      const catalogPath = resolveWriterCatalogPath(resolve(options.dataRoot), {
        writerCatalogPath: options.writerCatalogPath,
      });
      const writerCatalog = deps.openWriterCatalog(catalogPath);
      finalWriterCatalogPath = catalogPath;
      let trustedInputFingerprint: string;
      if (taskNodeIds === null) {
        const autofill = deps.autofill({
          taskId,
          dataRoot: resolve(options.dataRoot),
          writerCatalogPath: catalogPath,
          maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
          maxTasks: options.maxTasks ?? DEFAULT_MAX_TASKS,
          maxRounds: options.maxRounds ?? DEFAULT_MAX_ROUNDS,
          maxDiscoveryTables: 1000,
          maxDiscoveredTasks: DEFAULT_MAX_DISCOVERED_TASKS,
          force: options.force,
          terminalTableConfig,
        });
        if (autofill.status !== "COMPLETE")
          throw new Error(
            `INPUT_PACK_CLOSURE_PARTIAL:${autofill.issues.join(";")}`,
          );
        initialClosure = autofill;
        progress("closure_complete", {
          taskId,
          taskCount: autofill.taskIds.length,
          discovered: autofill.discoveredTaskIds.length,
          collected: autofill.collectedTaskIds.length,
          rounds: autofill.rounds,
        });
        trustedInputFingerprint = fingerprintTableProducerInputs(
          resolve(options.dataRoot),
        );
        finalTrustedInputFingerprint = trustedInputFingerprint;
        taskNodeIds = [...new Set(autofill.taskIds)];
      } else {
        trustedInputFingerprint =
          finalTrustedInputFingerprint ??
          fingerprintTableProducerInputs(resolve(options.dataRoot));
      }
      const factsTaskIds = taskNodeIds.filter(
        (candidate) => !factsPreparedTaskIds.has(candidate),
      );
      if (factsTaskIds.length > 0) {
        const facts = deps.machineFacts({
          dataRoot: resolve(options.dataRoot),
          taskIds: factsTaskIds,
          outputRoot: factsRoot,
          indexMode: "auto",
        });
        progress("machine_facts_complete", {
          taskId,
          taskCount: factsTaskIds.length,
        });
        const failedFacts = facts.tasks.filter(
          (fact) => fact.status === "FAILED" || fact.state === "FAILED",
        );
        if (failedFacts.length > 0)
          throw new Error(
            `MACHINE_FACTS_FAILED:${failedFacts.map((fact) => fact.task_id).join(",")}`,
          );
        for (const fact of facts.tasks) {
          if (fact.state === "SUCCESS") factsPreparedTaskIds.add(fact.task_id);
        }
      }
      const rawOneHopSnapshots = new Map<string, OneHopReconciliationResult>();
      progress("schedule_prefetch_start", {
        taskId,
        taskCount: taskNodeIds.length,
      });
      const scheduleEvidenceByTaskId = await deps.schedulePrefetch(taskNodeIds);
      progress("schedule_prefetch_complete", {
        taskId,
        taskCount: scheduleEvidenceByTaskId.size,
      });
      for (const nodeId of taskNodeIds)
        if (!scheduleEvidenceByTaskId.has(nodeId))
          throw new Error(`SCHEDULE_PREFETCH_MISSING:${nodeId}`);
      const oneHopResults = deps.oneHopBatch(taskNodeIds, {
        dataRoot: resolve(options.dataRoot),
        writerCatalog,
        verifyInputFingerprint: false,
        trustedInputFingerprint,
        scheduleEvidenceByTaskId,
        terminalTableConfig,
      });
      progress("one_hop_complete", { taskId, taskCount: oneHopResults.length });
      const checkDbFlagIds = checkDbFlagTaskIds(
        resolve(options.dataRoot),
        oneHopResults,
      );
      for (const result of oneHopResults)
        rawOneHopSnapshots.set(result.taskId, result);
      const oneHopSnapshots = new Map<string, OneHopReconciliationResult>();
      for (const result of oneHopResults)
        oneHopSnapshots.set(
          result.taskId,
          withoutCheckDbFlagParents(result, checkDbFlagIds),
        );
      const rawRootOneHop = rawOneHopSnapshots.get(taskId);
      const rootOneHop = oneHopSnapshots.get(taskId);
      if (!rawRootOneHop || !rootOneHop)
        throw new Error(`ROOT_ONE_HOP_SNAPSHOT_MISSING:${taskId}`);
      const formalMultiHop = deps.multiHop(taskId, {
        dataRoot: resolve(options.dataRoot),
        writerCatalog,
        maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
        maxTasks: options.maxTasks ?? DEFAULT_MAX_TASKS,
        maxEdges: options.maxEdges ?? DEFAULT_MAX_EDGES,
        rootOneHop,
        oneHopSnapshots,
        trustedInputFingerprint,
        terminalTableConfig,
      });
      progress("multi_hop_complete", {
        taskId,
        taskCount: formalMultiHop.taskNodes.length,
      });
      if (!tableHtmlRendered) {
        writeJson(oneHopPath, rawRootOneHop);
        writeJson(multiHopPath, formalMultiHop);
        deps.visualizeMultiHop({
          taskId,
          artifactPath: multiHopPath,
          outputPath: tableHtml,
          vizModelPath: join(stagedDir, "viz-model.json"),
        });
        if (existsSync(join(stagedDir, "viz-model.json")))
          rmSync(join(stagedDir, "viz-model.json"), { force: true });
        tableHtmlRendered = true;
      }
      let fieldArtifact: FieldLineageArtifact | null = null;
      if (options.withFields) {
        progress("field_lineage_start", {
          taskId,
          taskCount: taskNodeIds.length,
          round: fieldAutofillRounds + 1,
        });
        fieldArtifact = deps.fieldLineage({
          dataRoot: resolve(options.dataRoot),
          factsRoot,
          tableLineage: formalMultiHop,
          rootTaskId: taskId,
          rootTable: taskTarget(options.dataRoot, taskId),
          rootFields: options.fields ?? [],
          factsPolicy: options.factsPolicy ?? "current-only",
          maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
          maxStates: DEFAULT_FIELD_LINEAGE_MAX_STATES,
          maxPaths: DEFAULT_FIELD_LINEAGE_MAX_PATHS,
        });
        const fieldTables = fieldSourceTablesMissingProducerBridge(
          fieldArtifact,
          formalMultiHop,
        );
        progress("field_lineage_complete", {
          taskId,
          missingProducerTables: fieldTables.length,
        });
        const producerTaskIds = new Set<string>();
        for (const qualifiedName of fieldTables) {
          if (matchingTerminalRole(terminalTableConfig, qualifiedName))
            continue;
          fieldDrivenProducerTables.add(qualifiedName);
          if (queriedFieldTables.has(qualifiedName)) continue;
          queriedFieldTables.add(qualifiedName);
          for (const producerTaskId of deps.fieldProducerDiscovery(
            qualifiedName,
          )) {
            if (!SAFE_TASK_ID.test(producerTaskId)) continue;
            fieldDrivenProducerTaskIds.add(producerTaskId);
            producerTaskIds.add(producerTaskId);
          }
        }
        const knownTaskIds: Set<string> = new Set(taskNodeIds ?? []);
        const collectIds: string[] = [...producerTaskIds]
          .filter((producerTaskId) => !knownTaskIds.has(producerTaskId))
          .sort((left, right) =>
            left.localeCompare(right, "zh-Hans", { numeric: true }),
          );
        if (collectIds.length > 0) {
          progress("field_input_pack_collect_start", {
            taskId,
            round: fieldAutofillRounds + 1,
            batchSize: collectIds.length,
            taskIds: collectIds,
          });
          if (fieldAutofillRounds >= (options.maxRounds ?? DEFAULT_MAX_ROUNDS))
            throw new Error("MAX_FIELD_AUTOFILL_ROUNDS_REACHED");
          deps.collectTaskPacks(
            resolve(options.dataRoot),
            collectIds,
            options.force === true,
          );
          const collectedIds = collectIds.filter((candidate) =>
            taskPackExists(options.dataRoot, candidate),
          );
          for (const collectedId of collectedIds)
            fieldDrivenCollectedTaskIds.add(collectedId);
          taskNodeIds = [...new Set([...taskNodeIds, ...collectedIds])];
          fieldAutofillRounds += 1;
          progress("field_input_pack_collect_done", {
            taskId,
            round: fieldAutofillRounds,
            collected: collectedIds.length,
          });
          continue;
        }
      }
      finalRawRootOneHop = rawRootOneHop;
      finalFormalMultiHop = formalMultiHop;
      finalFieldArtifact = fieldArtifact;
      finalTrustedInputFingerprint = trustedInputFingerprint;
      break;
    }
    if (!finalRawRootOneHop || !finalFormalMultiHop)
      throw new Error(`FINAL_LINEAGE_SNAPSHOT_MISSING:${taskId}`);
    writeJson(oneHopPath, finalRawRootOneHop);
    writeJson(multiHopPath, finalFormalMultiHop);
    const closurePath = join(stagedDir, "input-pack-closure.json");
    const finalTaskNodeIds = taskNodeIds ?? [];
    const closureArtifact: InputPackClosureArtifact = {
      schemaVersion: "1.0.0",
      artifactType: "INPUT_PACK_CLOSURE",
      generatedAt: new Date().toISOString(),
      rootTaskId: taskId,
      requestedFields: options.fields ?? [],
      initialTaskIds: initialClosure?.taskIds ?? [],
      taskIds: finalTaskNodeIds,
      discoveredTaskIds: sortedUnique([
        ...(initialClosure?.discoveredTaskIds ?? []),
        ...fieldDrivenProducerTaskIds,
      ]),
      collectedTaskIds: sortedUnique([
        ...(initialClosure?.collectedTaskIds ?? []),
        ...fieldDrivenCollectedTaskIds,
      ]),
      fieldDrivenProducerTables: sortedUnique([...fieldDrivenProducerTables]),
      fieldDrivenProducerTaskIds: sortedUnique([...fieldDrivenProducerTaskIds]),
      fieldDrivenCollectedTaskIds: sortedUnique([
        ...fieldDrivenCollectedTaskIds,
      ]),
      rounds: {
        inputPack: initialClosure?.rounds ?? 0,
        fieldAutofill: fieldAutofillRounds,
        total: (initialClosure?.rounds ?? 0) + fieldAutofillRounds,
      },
      status: initialClosure?.status ?? "COMPLETE",
      issues: initialClosure?.issues ?? [],
      writerCatalogSnapshot: {
        catalogPath: finalWriterCatalogPath ?? "",
        inputFingerprint: finalTrustedInputFingerprint ?? "",
      },
      boundaries: {
        directIndirectClassification: "IN_MULTI_HOP_ARTIFACT",
        fieldAutofillRerunsRootClosure: false,
      },
    };
    writeJson(closurePath, closureArtifact);
    const files = ["input-pack-closure.json", "one-hop.json", "multi-hop.json"];
    if (fieldAutofillRounds > 0) {
      deps.visualizeMultiHop({
        taskId,
        artifactPath: multiHopPath,
        outputPath: tableHtml,
        vizModelPath: join(stagedDir, "viz-model.json"),
      });
      if (existsSync(join(stagedDir, "viz-model.json")))
        rmSync(join(stagedDir, "viz-model.json"), { force: true });
    }
    files.push("views/table-lineage.html");
    if (finalFieldArtifact) {
      const fieldPath = join(stagedDir, "field-lineage.json");
      writeJson(fieldPath, finalFieldArtifact);
      const fieldHtml = join(stagedDir, "views", "field-lineage.html");
      deps.visualizeFieldLineage({
        artifactPath: fieldPath,
        outputPath: fieldHtml,
        factsRoot,
      });
      files.push("field-lineage.json", "views/field-lineage.html");
    }
    publishStagedTask(stagedDir, paths.directory, artifactRoot);
    progress("task_complete", {
      taskId,
      status: "SUCCESS",
      artifactDir: paths.directory,
    });
    return { taskId, status: "SUCCESS", artifactDir: paths.directory, files };
  } catch (error) {
    progress("task_failed", {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (existsSync(stagedDir))
      rmSync(stagedDir, { recursive: true, force: true });
    return {
      taskId,
      status: "FAILED",
      artifactDir: paths.directory,
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (existsSync(lock)) rmSync(lock, { force: true });
  }
}

export async function runLineageAll(
  options: LineageAllOptions,
): Promise<LineageAllResult> {
  const dataRoot = resolve(options.dataRoot);
  const artifactRoot = resolve(
    options.artifactRoot ?? join(dataRoot, "artifacts"),
  );
  if (
    !existsSync(join(dataRoot, "tasks")) ||
    !existsSync(join(dataRoot, "tables"))
  )
    throw new Error("INPUT_PACK_ROOT_INCOMPLETE");
  const deps = dependencies(options.dependencies);
  const taskIds = [
    ...new Set(options.taskIds.map((item) => item.trim()).filter(Boolean)),
  ].sort();
  for (const taskId of taskIds)
    if (!SAFE_TASK_ID.test(taskId))
      throw new Error(`INVALID_TASK_ID:${taskId}`);
  const tasks: LineageAllTaskResult[] = [];
  for (const taskId of taskIds)
    tasks.push(
      await runTask({ ...options, dataRoot }, taskId, artifactRoot, deps),
    );
  for (const internalDir of [
    join(artifactRoot, ".staging"),
    join(artifactRoot, ".locks"),
  ]) {
    if (existsSync(internalDir) && readdirSync(internalDir).length === 0)
      rmSync(internalDir, { recursive: true, force: true });
  }
  return {
    dataRoot,
    artifactRoot,
    taskIds,
    tasks,
    status: tasks.every((task) => task.status === "SUCCESS")
      ? "SUCCESS"
      : "PARTIAL_FAILURE",
  };
}

async function main(): Promise<void> {
  try {
    const result = await runLineageAll(
      parseLineageAllArgs(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "SUCCESS") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  void main();
