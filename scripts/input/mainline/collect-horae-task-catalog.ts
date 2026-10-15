import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT } from "../../evidence/schedule-evidence-cache.ts";
import {
  defaultManualTaskIdsFile,
  readManualTaskIds,
} from "../shared/manual-task-exclusion.ts";

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 120_000;

type JsonRecord = Record<string, unknown>;

export interface HoraeTaskCatalogSearchPage {
  readonly rows: readonly JsonRecord[];
  readonly total?: number;
}

export interface CollectHoraeTaskCatalogOptions {
  readonly databasePath: string;
  readonly keyword?: string;
  readonly status?: string;
  readonly pageSize?: number;
  readonly intervalMs?: number;
  readonly maxPages?: number;
  readonly manualTaskIds?: ReadonlySet<string>;
  readonly resumeRunId?: string;
  readonly searchPage: (
    page: number,
    pageSize: number,
  ) => HoraeTaskCatalogSearchPage;
  readonly now?: () => string;
  readonly runId?: string;
}

export interface CollectHoraeTaskCatalogResult {
  readonly runId: string;
  readonly status: "COMPLETED";
  readonly pages: number;
  readonly rowsSeen: number;
  readonly taskCount: number;
  readonly reportedTotal?: number;
}

interface CatalogRun {
  readonly runId: string;
  readonly keyword: string;
  readonly status: string;
  readonly pageSize: number;
  readonly lastPage: number;
  readonly rowsSeen: number;
  readonly taskCount: number;
  readonly reportedTotal?: number;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function taskIdFromRow(row: JsonRecord): string | undefined {
  const value = row.id ?? row.task_id ?? row.taskId;
  const taskId = nonEmpty(value);
  return taskId !== null && SAFE_TASK_ID.test(taskId) ? taskId : undefined;
}

function numberFrom(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function rowsFromHoraeTaskCatalogPayload(
  payload: unknown,
): HoraeTaskCatalogSearchPage {
  if (Array.isArray(payload)) {
    const rows = payload.filter(
      (value): value is JsonRecord =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    );
    return { rows, total: numberFrom(rows[0]?.total) };
  }
  if (typeof payload !== "object" || payload === null)
    throw new Error("HORAE_TASK_CATALOG_INVALID_JSON");
  const record = payload as JsonRecord;
  const candidate = record.rows ?? record.data ?? record.items ?? record.list;
  if (!Array.isArray(candidate))
    throw new Error("HORAE_TASK_CATALOG_ROWS_MISSING");
  const rows = candidate.filter(
    (value): value is JsonRecord =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return {
    rows,
    total: numberFrom(record.total ?? record.count ?? rows[0]?.total),
  };
}

function stringField(row: JsonRecord, ...names: string[]): string | null {
  for (const name of names) {
    const value = nonEmpty(row[name]);
    if (value !== null) return value;
  }
  return null;
}

function contentHash(row: JsonRecord): string {
  return createHash("sha256").update(JSON.stringify(row), "utf8").digest("hex");
}

function initializeDatabase(databasePath: string): DatabaseSync {
  mkdirSync(resolve(databasePath, ".."), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 30000;

    CREATE TABLE IF NOT EXISTS horae_catalog_runs (
      run_id TEXT PRIMARY KEY,
      keyword TEXT NOT NULL DEFAULT '',
      type_filter TEXT NOT NULL DEFAULT 'K',
      status_filter TEXT NOT NULL DEFAULT '',
      page_size INTEGER NOT NULL,
      last_page INTEGER NOT NULL DEFAULT 0,
      rows_seen INTEGER NOT NULL DEFAULT 0,
      task_count INTEGER NOT NULL DEFAULT 0,
      reported_total INTEGER,
      status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS horae_task_catalog (
      task_id TEXT PRIMARY KEY,
      task_name TEXT,
      topic TEXT,
      cycle TEXT,
      task_type TEXT,
      owner TEXT,
      cluster TEXT,
      status TEXT,
      is_manual INTEGER NOT NULL DEFAULT 0 CHECK (is_manual IN (0, 1)),
      raw_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      source_run_id TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_horae_task_catalog_manual
      ON horae_task_catalog(is_manual);
    CREATE INDEX IF NOT EXISTS idx_horae_task_catalog_type
      ON horae_task_catalog(task_type);
    CREATE INDEX IF NOT EXISTS idx_horae_catalog_runs_status
      ON horae_catalog_runs(status, updated_at);
  `);
  return database;
}

function sleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatePositive(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}

function readRun(database: DatabaseSync, runId: string): CatalogRun {
  const row = database
    .prepare(
      `SELECT run_id AS runId, keyword, status, page_size AS pageSize,
              last_page AS lastPage, rows_seen AS rowsSeen,
              task_count AS taskCount, reported_total AS reportedTotal
       FROM horae_catalog_runs WHERE run_id = ?`,
    )
    .get(runId) as
    | {
        readonly runId?: unknown;
        readonly keyword?: unknown;
        readonly status?: unknown;
        readonly pageSize?: unknown;
        readonly lastPage?: unknown;
        readonly rowsSeen?: unknown;
        readonly taskCount?: unknown;
        readonly reportedTotal?: unknown;
      }
    | undefined;
  if (!row || row.status !== "RUNNING")
    throw new Error(`HORAE_CATALOG_RESUME_INVALID:${runId}`);
  const run: CatalogRun = {
    runId: String(row.runId),
    keyword: String(row.keyword ?? ""),
    status: String(row.status),
    pageSize: Number(row.pageSize),
    lastPage: Number(row.lastPage),
    rowsSeen: Number(row.rowsSeen),
    taskCount: Number(row.taskCount),
    ...(row.reportedTotal === null || row.reportedTotal === undefined
      ? {}
      : { reportedTotal: Number(row.reportedTotal) }),
  };
  return run;
}

function requireManualClassification(
  cacheRoot: string,
  manualTaskIdsFile: string | undefined,
): Set<string> {
  const path = resolve(
    manualTaskIdsFile ?? defaultManualTaskIdsFile(cacheRoot),
  );
  if (!existsSync(path) || !existsSync(`${path}.meta.json`))
    throw new Error(`MANUAL_TASK_IDS_NOT_COMPLETED:${path}`);
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(`${path}.meta.json`, "utf8"));
  } catch (error) {
    throw new Error(
      `MANUAL_TASK_IDS_META_INVALID:${path}:${errorMessage(error)}`,
    );
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    (metadata as JsonRecord).status !== "COMPLETED"
  )
    throw new Error(`MANUAL_TASK_IDS_NOT_COMPLETED:${path}`);
  return readManualTaskIds(cacheRoot, path);
}

export function collectHoraeTaskCatalog(
  options: CollectHoraeTaskCatalogOptions,
): CollectHoraeTaskCatalogResult {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxPages = options.maxPages ?? Number.MAX_SAFE_INTEGER;
  validatePositive(pageSize, "PAGE_SIZE_INVALID");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0)
    throw new Error("INTERVAL_MS_INVALID");
  validatePositive(maxPages, "MAX_PAGES_INVALID");
  const keyword = options.keyword ?? "";
  const statusFilter = options.status ?? "";
  const now = options.now ?? (() => new Date().toISOString());
  const manualTaskIds = options.manualTaskIds ?? new Set<string>();
  const database = initializeDatabase(options.databasePath);
  const runId = options.resumeRunId ?? options.runId ?? randomUUID();
  let run: CatalogRun;
  if (options.resumeRunId !== undefined) {
    run = readRun(database, options.resumeRunId);
    if (run.keyword !== keyword || run.pageSize !== pageSize)
      throw new Error(`HORAE_CATALOG_RESUME_QUERY_MISMATCH:${run.runId}`);
  } else {
    const active = database
      .prepare(
        `SELECT run_id AS runId FROM horae_catalog_runs
          WHERE status = 'RUNNING' AND keyword = ? AND page_size = ?
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(keyword, pageSize) as { readonly runId?: unknown } | undefined;
    if (active?.runId !== undefined)
      throw new Error(`HORAE_CATALOG_ALREADY_RUNNING:${String(active.runId)}`);
    const timestamp = now();
    database
      .prepare(
        `INSERT INTO horae_catalog_runs(
           run_id, keyword, type_filter, status_filter, page_size,
           status, started_at, updated_at
         ) VALUES (?, ?, 'K', ?, ?, 'RUNNING', ?, ?)`,
      )
      .run(runId, keyword, statusFilter, pageSize, timestamp, timestamp);
    run = {
      runId,
      keyword,
      status: "RUNNING",
      pageSize,
      lastPage: 0,
      rowsSeen: 0,
      taskCount: 0,
    };
  }

  console.error(
    `[horae-task-catalog] start ${JSON.stringify({
      runId: run.runId,
      keyword,
      pageSize,
      intervalMs,
      resume: options.resumeRunId !== undefined,
    })}`,
  );

  const upsert = database.prepare(`
    INSERT INTO horae_task_catalog(
      task_id, task_name, topic, cycle, task_type, owner, cluster, status,
      is_manual, raw_json, content_sha256, first_seen_at, last_seen_at,
      source_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      task_name = excluded.task_name,
      topic = excluded.topic,
      cycle = excluded.cycle,
      task_type = excluded.task_type,
      owner = excluded.owner,
      cluster = excluded.cluster,
      status = excluded.status,
      is_manual = MAX(horae_task_catalog.is_manual, excluded.is_manual),
      raw_json = excluded.raw_json,
      content_sha256 = excluded.content_sha256,
      last_seen_at = excluded.last_seen_at,
      source_run_id = excluded.source_run_id
  `);
  const updateRun = database.prepare(`
    UPDATE horae_catalog_runs
       SET last_page = ?, rows_seen = ?, task_count = ?,
           reported_total = ?, updated_at = ?
     WHERE run_id = ?
  `);

  try {
    let reportedTotal = run.reportedTotal;
    let pages = run.lastPage;
    let rowsSeen = run.rowsSeen;
    while (pages < maxPages) {
      if (pages > run.lastPage) sleep(intervalMs);
      const page = options.searchPage(pages + 1, pageSize);
      pages += 1;
      rowsSeen += page.rows.length;
      if (page.total !== undefined) reportedTotal = page.total;
      const timestamp = now();
      database.exec("BEGIN");
      try {
        for (const row of page.rows) {
          const taskId = taskIdFromRow(row);
          if (taskId === undefined) continue;
          const cycle = stringField(row, "cycle", "scheduleCycle");
          const isManual =
            manualTaskIds.has(taskId) ||
            ["手工", "手动", "manual"].includes((cycle ?? "").toLowerCase())
              ? 1
              : 0;
          const rawJson = JSON.stringify(row);
          upsert.run(
            taskId,
            stringField(row, "name", "task_name", "taskName"),
            stringField(row, "topic"),
            cycle,
            stringField(row, "taskType", "task_type"),
            stringField(row, "owner", "inCharge", "in_charge"),
            stringField(row, "cluster"),
            stringField(row, "status"),
            isManual,
            rawJson,
            contentHash(row),
            timestamp,
            timestamp,
            runId,
          );
        }
        const taskCount = Number(
          (
            database
              .prepare("SELECT COUNT(*) AS n FROM horae_task_catalog")
              .get() as { readonly n: number }
          ).n,
        );
        updateRun.run(
          pages,
          rowsSeen,
          taskCount,
          reportedTotal ?? null,
          timestamp,
          runId,
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      console.error(
        `[horae-task-catalog] progress ${JSON.stringify({
          runId,
          pages,
          rowsSeen,
          taskCount: (
            database
              .prepare("SELECT COUNT(*) AS n FROM horae_task_catalog")
              .get() as { readonly n: number }
          ).n,
          reportedTotal: reportedTotal ?? null,
        })}`,
      );
      if (page.rows.length === 0) break;
      if (
        (reportedTotal !== undefined && pages * pageSize >= reportedTotal) ||
        page.rows.length < pageSize
      )
        break;
    }
    const taskCount = Number(
      (
        database
          .prepare("SELECT COUNT(*) AS n FROM horae_task_catalog")
          .get() as { readonly n: number }
      ).n,
    );
    const timestamp = now();
    database
      .prepare(
        `UPDATE horae_catalog_runs
            SET status = 'COMPLETED', last_page = ?, rows_seen = ?,
                task_count = ?, reported_total = ?, updated_at = ?,
                error_message = NULL
          WHERE run_id = ?`,
      )
      .run(pages, rowsSeen, taskCount, reportedTotal ?? null, timestamp, runId);
    return {
      runId,
      status: "COMPLETED",
      pages,
      rowsSeen,
      taskCount,
      ...(reportedTotal !== undefined ? { reportedTotal } : {}),
    };
  } catch (error) {
    database
      .prepare(
        `UPDATE horae_catalog_runs
            SET status = 'FAILED', updated_at = ?, error_message = ?
          WHERE run_id = ?`,
      )
      .run(now(), errorMessage(error), runId);
    throw error;
  } finally {
    database.close();
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : undefined;
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

function databasePathFromCacheRoot(cacheRoot: string): string {
  return join(
    resolve(cacheRoot),
    "schedule-evidence",
    "tasks-sqlite",
    "schedule-evidence.sqlite",
  );
}

function runHoraeSearchPage(
  keyword: string,
  page: number,
  pageSize: number,
  status: string,
  timeoutMs: number,
): HoraeTaskCatalogSearchPage {
  const args = ["horae", "search"];
  if (keyword !== "") args.push(keyword);
  else args.push("");
  args.push(
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
  );
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
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return rowsFromHoraeTaskCatalogPayload(JSON.parse(output));
}

async function main(): Promise<void> {
  const cacheRoot = resolve(
    option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  );
  const keyword = option("--keyword") ?? "";
  const status = option("--status") ?? "";
  const pageSize = integerOption("--page-size", DEFAULT_PAGE_SIZE, 1);
  const intervalMs = integerOption("--interval-ms", DEFAULT_INTERVAL_MS, 0);
  const maxPages = integerOption("--max-pages", Number.MAX_SAFE_INTEGER, 1);
  const timeoutMs = integerOption("--timeout-ms", DEFAULT_TIMEOUT_MS, 1);
  const databasePath = resolve(
    option("--database-path") ?? databasePathFromCacheRoot(cacheRoot),
  );
  const manualTaskIds = requireManualClassification(
    cacheRoot,
    option("--manual-task-ids-file"),
  );
  const result = collectHoraeTaskCatalog({
    databasePath,
    keyword,
    status,
    pageSize,
    intervalMs,
    maxPages,
    manualTaskIds,
    resumeRunId: option("--resume-run-id"),
    searchPage: (page, size) =>
      runHoraeSearchPage(keyword, page, size, status, timeoutMs),
  });
  console.log(JSON.stringify({ databasePath, ...result }));
}

if (process.argv[1]?.endsWith("collect-horae-task-catalog.ts")) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
