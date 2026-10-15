import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT } from "../../evidence/schedule-evidence-cache.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_FILE = "manual-task-ids.txt";
const DEFAULT_META_SUFFIX = ".meta.json";

type JsonRecord = Record<string, unknown>;

export interface HoraeManualTaskSearchPage {
  readonly rows: readonly JsonRecord[];
  readonly total?: number;
}

export interface CollectHoraeManualTaskIdsOptions {
  readonly pageSize?: number;
  readonly intervalMs?: number;
  readonly maxPages?: number;
  readonly initialPage?: number;
  readonly initialRowsSeen?: number;
  readonly initialReportedTotal?: number;
  readonly initialTaskIds?: readonly string[];
  readonly onPage?: (result: CollectHoraeManualTaskIdsResult) => void;
  readonly searchPage: (
    page: number,
    pageSize: number,
  ) => HoraeManualTaskSearchPage;
}

export interface CollectHoraeManualTaskIdsResult {
  readonly pages: number;
  readonly rowsSeen: number;
  readonly manualTaskIds: readonly string[];
  readonly reportedTotal?: number;
}

function isManualScheduleCycle(value: unknown): boolean {
  return (
    typeof value === "string" &&
    ["手工", "手动", "manual"].includes(value.trim().toLowerCase())
  );
}

function taskIdFromRecord(record: JsonRecord): string | undefined {
  const value = record.id ?? record.task_id ?? record.taskId;
  if (typeof value !== "string") return undefined;
  const taskId = value.trim();
  return SAFE_TASK_ID.test(taskId) ? taskId : undefined;
}

function numberFrom(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function rowsFromHoraeSearchPayload(
  payload: unknown,
): HoraeManualTaskSearchPage {
  if (Array.isArray(payload)) {
    const rows = payload.filter(
      (value): value is JsonRecord =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
    return { rows, total: numberFrom(rows[0]?.total) };
  }
  if (typeof payload !== "object" || payload === null)
    throw new Error("HORAE_MANUAL_SEARCH_INVALID_JSON");

  const record = payload as JsonRecord;
  const candidate = record.rows ?? record.data ?? record.items ?? record.list;
  if (!Array.isArray(candidate))
    throw new Error("HORAE_MANUAL_SEARCH_ROWS_MISSING");
  const rows = candidate.filter(
    (value): value is JsonRecord =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return {
    rows,
    total: numberFrom(record.total ?? record.count ?? rows[0]?.total),
  };
}

function sleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function currentResult(
  pages: number,
  rowsSeen: number,
  manualTaskIds: ReadonlySet<string>,
  reportedTotal: number | undefined,
): CollectHoraeManualTaskIdsResult {
  return {
    pages,
    rowsSeen,
    manualTaskIds: [...manualTaskIds].sort((left, right) =>
      left.localeCompare(right, "en-US", { numeric: true }),
    ),
    ...(reportedTotal !== undefined ? { reportedTotal } : {}),
  };
}

export function collectHoraeManualTaskIds(
  options: CollectHoraeManualTaskIdsOptions,
): CollectHoraeManualTaskIdsResult {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    throw new Error("PAGE_SIZE_INVALID");
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0)
    throw new Error("INTERVAL_MS_INVALID");
  const maxPages = options.maxPages ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1)
    throw new Error("MAX_PAGES_INVALID");

  const initialPage = options.initialPage ?? 0;
  if (!Number.isSafeInteger(initialPage) || initialPage < 0)
    throw new Error("INITIAL_PAGE_INVALID");
  const initialRowsSeen = options.initialRowsSeen ?? 0;
  if (!Number.isSafeInteger(initialRowsSeen) || initialRowsSeen < 0)
    throw new Error("INITIAL_ROWS_SEEN_INVALID");
  const manualTaskIds = new Set(options.initialTaskIds ?? []);
  let pages = initialPage;
  let rowsSeen = initialRowsSeen;
  let reportedTotal = options.initialReportedTotal;
  while (pages < maxPages) {
    if (pages > initialPage) sleep(intervalMs);
    const page = options.searchPage(pages + 1, pageSize);
    pages += 1;
    rowsSeen += page.rows.length;
    if (page.total !== undefined) reportedTotal = page.total;
    for (const row of page.rows) {
      if (isManualScheduleCycle(row.cycle)) {
        const taskId = taskIdFromRecord(row);
        if (taskId !== undefined) manualTaskIds.add(taskId);
      }
    }
    options.onPage?.(
      currentResult(pages, rowsSeen, manualTaskIds, reportedTotal),
    );
    if (page.rows.length === 0) break;
    if (
      (reportedTotal !== undefined && pages * pageSize >= reportedTotal) ||
      page.rows.length < pageSize
    )
      break;
  }

  return currentResult(pages, rowsSeen, manualTaskIds, reportedTotal);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function integerOption(
  name: string,
  fallback: number,
  minimum: number,
): number {
  const value = option(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error(
      `${name.slice(2).toUpperCase().replaceAll("-", "_")}_INVALID`,
    );
  return parsed;
}

function runHoraeSearchPage(
  page: number,
  pageSize: number,
  status: string,
  timeoutMs: number,
): HoraeManualTaskSearchPage {
  const args = [
    "horae",
    "search",
    "",
    "--type",
    "K",
    "--status",
    status,
    "--cycle",
    "手工",
    "--page",
    String(page),
    "--size",
    String(pageSize),
    "-f",
    "json",
  ];
  const executable =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.OPENCLI_EXECUTABLE ?? "opencli");
  const executableArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "opencli.cmd", ...args]
      : args;
  const output = execFileSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return rowsFromHoraeSearchPayload(JSON.parse(output));
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, path);
}

function writeManualTaskSnapshot(
  outputPath: string,
  metaPath: string,
  result: CollectHoraeManualTaskIdsResult,
  status: "RUNNING" | "COMPLETED",
  pageSize: number,
  statusFilter: string,
): void {
  writeAtomic(
    outputPath,
    result.manualTaskIds.length > 0
      ? `${result.manualTaskIds.join("\n")}\n`
      : "",
  );
  writeAtomic(
    metaPath,
    `${JSON.stringify(
      {
        schemaVersion: "1.0.0",
        status,
        source: "opencli:horae.search",
        query: { type: "K", status: statusFilter, cycle: "手工" },
        pageSize,
        pages: result.pages,
        rowsSeen: result.rowsSeen,
        reportedTotal: result.reportedTotal ?? null,
        manualTaskCount: result.manualTaskIds.length,
        output: outputPath,
        observedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

function readResumeState(
  outputPath: string,
  metaPath: string,
): {
  readonly initialPage: number;
  readonly initialRowsSeen: number;
  readonly initialReportedTotal?: number;
  readonly initialTaskIds: readonly string[];
} {
  if (!existsSync(outputPath) || !existsSync(metaPath))
    throw new Error("RESUME_CHECKPOINT_MISSING");
  const initialTaskIds = readFileSync(outputPath, "utf8")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (initialTaskIds.some((taskId) => !SAFE_TASK_ID.test(taskId)))
    throw new Error("RESUME_CHECKPOINT_INVALID_IDS");
  const metadata = JSON.parse(readFileSync(metaPath, "utf8")) as JsonRecord;
  if (metadata.status !== "RUNNING")
    throw new Error("RESUME_CHECKPOINT_NOT_RUNNING");
  const initialPage = numberFrom(metadata.pages);
  const initialRowsSeen = numberFrom(metadata.rowsSeen);
  if (initialPage === undefined || initialRowsSeen === undefined)
    throw new Error("RESUME_CHECKPOINT_INVALID_META");
  const initialReportedTotal = numberFrom(metadata.reportedTotal);
  return {
    initialPage,
    initialRowsSeen,
    ...(initialReportedTotal !== undefined ? { initialReportedTotal } : {}),
    initialTaskIds,
  };
}

async function main(): Promise<void> {
  const cacheRoot = resolve(
    option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  );
  const evidenceRoot = join(cacheRoot, "schedule-evidence");
  const outputPath = resolve(
    option("--output") ?? join(evidenceRoot, DEFAULT_OUTPUT_FILE),
  );
  const metaPath = resolve(
    option("--meta-output") ?? `${outputPath}${DEFAULT_META_SUFFIX}`,
  );
  const pageSize = integerOption("--page-size", DEFAULT_PAGE_SIZE, 1);
  const intervalMs = integerOption("--interval-ms", DEFAULT_INTERVAL_MS, 0);
  const maxPages = integerOption("--max-pages", Number.MAX_SAFE_INTEGER, 1);
  const timeoutMs = integerOption("--timeout-ms", DEFAULT_TIMEOUT_MS, 1);
  const status = option("--status") ?? "";
  const resume = process.argv.includes("--resume");
  const resumeState = resume
    ? readResumeState(outputPath, metaPath)
    : {
        initialPage: 0,
        initialRowsSeen: 0,
        initialTaskIds: [],
      };

  const result = collectHoraeManualTaskIds({
    pageSize,
    intervalMs,
    maxPages,
    initialPage: resumeState.initialPage,
    initialRowsSeen: resumeState.initialRowsSeen,
    initialReportedTotal: resumeState.initialReportedTotal,
    initialTaskIds: resumeState.initialTaskIds,
    searchPage: (page, size) =>
      runHoraeSearchPage(page, size, status, timeoutMs),
    onPage: (progress) => {
      writeManualTaskSnapshot(
        outputPath,
        metaPath,
        progress,
        "RUNNING",
        pageSize,
        status,
      );
      console.error(
        `[horae-manual-task-ids] progress ${JSON.stringify({
          pages: progress.pages,
          rowsSeen: progress.rowsSeen,
          manualTaskCount: progress.manualTaskIds.length,
          reportedTotal: progress.reportedTotal ?? null,
        })}`,
      );
    },
  });
  writeManualTaskSnapshot(
    outputPath,
    metaPath,
    result,
    "COMPLETED",
    pageSize,
    status,
  );
  console.log(
    JSON.stringify({
      output: outputPath,
      meta: metaPath,
      pages: result.pages,
      rowsSeen: result.rowsSeen,
      reportedTotal: result.reportedTotal ?? null,
      manualTaskCount: result.manualTaskIds.length,
    }),
  );
}

if (process.argv[1]?.endsWith("collect-horae-manual-task-ids.ts")) void main();
