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
const SAFE_KEYWORD = /^[A-Za-z0-9_.-]{1,128}$/;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;

type JsonRecord = Record<string, unknown>;

export interface HoraeKeywordSearchPage {
  readonly rows: readonly JsonRecord[];
  readonly total?: number;
}

export interface CollectHoraeKeywordTaskIdsOptions {
  readonly pageSize?: number;
  readonly intervalMs?: number;
  readonly maxPages?: number;
  readonly initialPage?: number;
  readonly initialRowsSeen?: number;
  readonly initialReportedTotal?: number;
  readonly initialTaskIds?: readonly string[];
  readonly searchPage: (
    page: number,
    pageSize: number,
  ) => HoraeKeywordSearchPage;
  readonly onPage?: (result: CollectHoraeKeywordTaskIdsResult) => void;
}

export interface CollectHoraeKeywordTaskIdsResult {
  readonly pages: number;
  readonly rowsSeen: number;
  readonly taskIds: readonly string[];
  readonly reportedTotal?: number;
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

export function collectHoraeKeywordTaskIds(
  options: CollectHoraeKeywordTaskIdsOptions,
): CollectHoraeKeywordTaskIdsResult {
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
  const initialRowsSeen = options.initialRowsSeen ?? 0;
  if (!Number.isSafeInteger(initialPage) || initialPage < 0)
    throw new Error("INITIAL_PAGE_INVALID");
  if (!Number.isSafeInteger(initialRowsSeen) || initialRowsSeen < 0)
    throw new Error("INITIAL_ROWS_SEEN_INVALID");

  const taskIds = new Set(options.initialTaskIds ?? []);
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
      const taskId = taskIdFromRecord(row);
      if (taskId !== undefined) taskIds.add(taskId);
    }
    options.onPage?.(currentResult(pages, rowsSeen, taskIds, reportedTotal));
    if (page.rows.length === 0) break;
    if (
      (reportedTotal !== undefined && pages * pageSize >= reportedTotal) ||
      page.rows.length < pageSize
    )
      break;
  }
  return currentResult(pages, rowsSeen, taskIds, reportedTotal);
}

function currentResult(
  pages: number,
  rowsSeen: number,
  taskIds: ReadonlySet<string>,
  reportedTotal: number | undefined,
): CollectHoraeKeywordTaskIdsResult {
  return {
    pages,
    rowsSeen,
    taskIds: [...taskIds].sort((left, right) =>
      left.localeCompare(right, "en-US", { numeric: true }),
    ),
    ...(reportedTotal !== undefined ? { reportedTotal } : {}),
  };
}

function sleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function rowsFromHoraeSearchPayload(
  payload: unknown,
): HoraeKeywordSearchPage {
  if (Array.isArray(payload)) {
    const rows = payload.filter(
      (value): value is JsonRecord =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
    return { rows, total: numberFrom(rows[0]?.total) };
  }
  if (typeof payload !== "object" || payload === null)
    throw new Error("HORAE_KEYWORD_SEARCH_INVALID_JSON");
  const record = payload as JsonRecord;
  const candidate = record.rows ?? record.data ?? record.items ?? record.list;
  if (!Array.isArray(candidate))
    throw new Error("HORAE_KEYWORD_SEARCH_ROWS_MISSING");
  const rows = candidate.filter(
    (value): value is JsonRecord =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return {
    rows,
    total: numberFrom(record.total ?? record.count ?? rows[0]?.total),
  };
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

function runHoraeKeywordSearchPage(
  keyword: string,
  page: number,
  pageSize: number,
  status: string,
  timeoutMs: number,
): HoraeKeywordSearchPage {
  const args = [
    "horae",
    "search",
    keyword,
    "--type",
    "K",
    "--status",
    status,
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

function writeSnapshot(
  outputPath: string,
  metaPath: string,
  result: CollectHoraeKeywordTaskIdsResult,
  status: "RUNNING" | "COMPLETED",
  keyword: string,
  pageSize: number,
  statusFilter: string,
): void {
  writeAtomic(
    outputPath,
    result.taskIds.length > 0 ? `${result.taskIds.join("\n")}\n` : "",
  );
  writeAtomic(
    metaPath,
    `${JSON.stringify(
      {
        schemaVersion: "1.0.0",
        status,
        source: "opencli:horae.search",
        query: { type: "K", status: statusFilter, keyword },
        pageSize,
        pages: result.pages,
        rowsSeen: result.rowsSeen,
        reportedTotal: result.reportedTotal ?? null,
        taskCount: result.taskIds.length,
        output: outputPath,
        observedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const keyword = option("--keyword")?.trim();
  if (!keyword || !SAFE_KEYWORD.test(keyword))
    throw new Error("KEYWORD_INVALID");
  const cacheRoot = resolve(
    option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  );
  const keywordDir = join(cacheRoot, "schedule-evidence", "keywords");
  const outputPath = resolve(
    option("--output") ?? join(keywordDir, `${keyword}-task-ids.txt`),
  );
  const metaPath = resolve(
    option("--meta-output") ?? `${outputPath}.meta.json`,
  );
  const pageSize = integerOption("--page-size", DEFAULT_PAGE_SIZE, 1);
  const intervalMs = integerOption("--interval-ms", DEFAULT_INTERVAL_MS, 0);
  const maxPages = integerOption("--max-pages", Number.MAX_SAFE_INTEGER, 1);
  const timeoutMs = integerOption("--timeout-ms", DEFAULT_TIMEOUT_MS, 1);
  const status = option("--status") ?? "";
  const resume = process.argv.includes("--resume");
  const resumeState = resume
    ? readResumeState(outputPath, metaPath)
    : { initialPage: 0, initialRowsSeen: 0, initialTaskIds: [] };

  const result = collectHoraeKeywordTaskIds({
    pageSize,
    intervalMs,
    maxPages,
    initialPage: resumeState.initialPage,
    initialRowsSeen: resumeState.initialRowsSeen,
    initialReportedTotal: resumeState.initialReportedTotal,
    initialTaskIds: resumeState.initialTaskIds,
    searchPage: (page, size) =>
      runHoraeKeywordSearchPage(keyword, page, size, status, timeoutMs),
    onPage: (progress) => {
      writeSnapshot(
        outputPath,
        metaPath,
        progress,
        "RUNNING",
        keyword,
        pageSize,
        status,
      );
      console.error(
        `[horae-keyword-task-ids] progress ${JSON.stringify({
          keyword,
          pages: progress.pages,
          rowsSeen: progress.rowsSeen,
          taskCount: progress.taskIds.length,
          reportedTotal: progress.reportedTotal ?? null,
        })}`,
      );
    },
  });
  writeSnapshot(
    outputPath,
    metaPath,
    result,
    "COMPLETED",
    keyword,
    pageSize,
    status,
  );
  console.log(
    JSON.stringify({
      output: outputPath,
      meta: metaPath,
      keyword,
      pages: result.pages,
      rowsSeen: result.rowsSeen,
      reportedTotal: result.reportedTotal ?? null,
      taskCount: result.taskIds.length,
    }),
  );
}

if (process.argv[1]?.endsWith("collect-horae-topic-task-ids.ts")) void main();
