import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import { sha256File } from "../shared/input-pack.ts";
import {
  DEFAULT_HIVE_DDL_JSONL_PATH,
  DEFAULT_HIVE_METADATA_JSONL_PATH,
  DEFAULT_RDBMS_CORE_JSONL_PATH,
  DEFAULT_RDBMS_DDL_JSONL_PATH,
} from "../shared/offline-table-resolver.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  resolveScheduleEvidenceCacheRoot,
} from "../../evidence/schedule-evidence-cache.ts";
import { defaultTaskStatusFile } from "./task-status.ts";

const CACHE_WRITER_PATTERN =
  /input-pack:fill-(?:horae-detail|szdata-detail|hive-task-sql|run-script-sql|hive-ddl-from-log)/iu;
const RELATION_ONLY_PATTERN = /input-pack:fill-horae-relation/iu;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const CACHE_FILES = [
  "horae-task-type.json",
  "szdata-schedule-detail.json",
  "hive-task.sql",
  "run-script.sql",
  "hive-target-ddl.sql",
] as const;

export interface PartialInventoryOptions {
  readonly dataRoot: string;
  readonly cacheRoot?: string;
  readonly statusFile?: string;
  readonly outputPath?: string;
  readonly requireStable?: boolean;
  readonly activeWriters?: () => readonly string[];
  readonly now?: () => Date;
}

export interface PartialInventoryRow {
  readonly taskId: string;
  readonly taskCategory?: string;
  readonly status: "PARTIAL";
  readonly warnings: readonly string[];
  readonly tablesUnavailable: readonly string[];
  readonly candidateNames: readonly string[];
  readonly sqlSlots: readonly string[];
  readonly cacheFiles: readonly string[];
  readonly hasScriptLog: boolean;
  readonly taskPackPath?: string;
}

export interface PartialInventoryDocument {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "INPUT_PACK_PARTIAL_INVENTORY";
  readonly generatedAt: string;
  readonly stable: boolean;
  readonly activeWriters: readonly string[];
  readonly dataRoot: string;
  readonly cacheRoot: string;
  readonly statusFile: string;
  readonly statusSha256: string;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly catalogs: Readonly<Record<string, { readonly path: string; readonly exists: boolean }>>;
  readonly rows: readonly PartialInventoryRow[];
}

interface StatusRecord {
  readonly taskId?: unknown;
  readonly status?: unknown;
  readonly taskCategory?: unknown;
  readonly warnings?: unknown;
  readonly tablesUnavailable?: unknown;
  readonly directory?: unknown;
}

interface StatusDocument {
  readonly schemaVersion?: unknown;
  readonly dataRoot?: unknown;
  readonly tasks?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readStatusDocument(statusFile: string, dataRoot: string): StatusDocument & {
  readonly tasks: Record<string, StatusRecord>;
} {
  const parsed = JSON.parse(readFileSync(statusFile, "utf8")) as StatusDocument;
  if (parsed.schemaVersion !== "1.0.0" || parsed.dataRoot !== resolve(dataRoot))
    throw new Error(`STATUS_ROOT_OR_SCHEMA_INVALID:${statusFile}`);
  if (!parsed.tasks || typeof parsed.tasks !== "object" || Array.isArray(parsed.tasks))
    throw new Error(`STATUS_TASKS_INVALID:${statusFile}`);
  return parsed as StatusDocument & { readonly tasks: Record<string, StatusRecord> };
}

function defaultActiveWriters(): readonly string[] {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -notmatch '^(powershell|pwsh)\\.exe$' -and $_.CommandLine -notmatch 'inventory-input-pack-partials' -and $_.CommandLine -match 'input-pack:fill-(horae-detail|szdata-detail|hive-task-sql|run-script-sql|hive-ddl-from-log)' -and $_.CommandLine -notmatch 'input-pack:fill-horae-relation' } | ForEach-Object { $_.CommandLine }",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    return output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && CACHE_WRITER_PATTERN.test(line))
      .map((line) => line.slice(0, 240));
  } catch {
    return ["ACTIVE_WRITERS_UNVERIFIED"];
  }
}

function candidateNames(warnings: readonly string[], unavailable: readonly string[]): string[] {
  const names = new Set<string>();
  for (const value of [...warnings, ...unavailable]) {
    const name = value.includes(":") ? value.slice(0, value.indexOf(":")) : value;
    if (name.includes(".")) names.add(name.trim());
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function taskPackInfo(
  dataRoot: string,
  record: StatusRecord,
): { readonly sqlSlots: readonly string[]; readonly path?: string } {
  const direct = nonEmptyString(record.directory);
  const category = nonEmptyString(record.taskCategory);
  const taskId = nonEmptyString(record.taskId);
  const path = direct ??
    (category !== undefined && taskId !== undefined
      ? join(dataRoot, "tasks", category, taskId)
      : undefined);
  if (path === undefined) return { sqlSlots: [] };
  const taskPath = join(path, "task.json");
  if (!existsSync(taskPath)) return { sqlSlots: [], path };
  try {
    const document = JSON.parse(readFileSync(taskPath, "utf8")) as {
      readonly sqlFiles?: unknown;
    };
    const slots = Array.isArray(document.sqlFiles)
      ? document.sqlFiles
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .map((item) => nonEmptyString(item.slot))
          .filter((item): item is string => item !== undefined)
      : [];
    return { sqlSlots: slots.sort(), path };
  } catch {
    return { sqlSlots: [], path };
  }
}

function scriptLogTaskIds(cacheRoot: string): ReadonlySet<string> {
  const logRoot = join(resolveScheduleEvidenceCacheRoot(cacheRoot), "script-log");
  if (!existsSync(logRoot)) return new Set();
  const ids = new Set<string>();
  for (const entry of readdirSync(logRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^(.+)_\d{8}\.log$/u.exec(entry.name);
    if (match?.[1] && TASK_ID_PATTERN.test(match[1])) ids.add(match[1]);
  }
  return ids;
}

function catalogPaths(): Readonly<Record<string, string>> {
  return {
    hiveMetadata: DEFAULT_HIVE_METADATA_JSONL_PATH,
    hiveDdl: DEFAULT_HIVE_DDL_JSONL_PATH,
    rdbmsCore: DEFAULT_RDBMS_CORE_JSONL_PATH,
    rdbmsDdl: DEFAULT_RDBMS_DDL_JSONL_PATH,
  };
}

export function buildPartialInventory(
  options: PartialInventoryOptions,
): PartialInventoryDocument {
  const dataRoot = resolve(options.dataRoot);
  const cacheRoot = resolve(options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT);
  const statusFile = resolve(options.statusFile ?? defaultTaskStatusFile(dataRoot));
  const activeWriters = [...(options.activeWriters ?? defaultActiveWriters)()];
  if ((options.requireStable ?? true) && activeWriters.length > 0)
    throw new Error(`CACHE_WRITERS_ACTIVE:${activeWriters.join("|")}`);
  const status = readStatusDocument(statusFile, dataRoot);
  const records = Object.values(status.tasks).filter(
    (record) => record.status === "PARTIAL",
  );
  const taskIdsWithLogs = scriptLogTaskIds(cacheRoot);
  const scheduleRoot = resolveScheduleEvidenceCacheRoot(cacheRoot);
  const counts: Record<string, number> = {};
  const rows: PartialInventoryRow[] = [];
  for (const record of records) {
    const taskId = nonEmptyString(record.taskId);
    if (taskId === undefined) continue;
    const taskCategory = nonEmptyString(record.taskCategory);
    const taskDir = join(scheduleRoot, "tasks", taskId);
    const cacheFiles = CACHE_FILES.filter((file) => existsSync(join(taskDir, file)));
    const pack = taskPackInfo(dataRoot, record);
    const warnings = stringArray(record.warnings);
    const tablesUnavailable = stringArray(record.tablesUnavailable);
    const row: PartialInventoryRow = {
      taskId,
      ...(taskCategory === undefined ? {} : { taskCategory }),
      status: "PARTIAL",
      warnings,
      tablesUnavailable,
      candidateNames: candidateNames(warnings, tablesUnavailable),
      sqlSlots: pack.sqlSlots,
      cacheFiles,
      hasScriptLog: taskIdsWithLogs.has(taskId),
      ...(pack.path === undefined ? {} : { taskPackPath: pack.path }),
    };
    rows.push(row);
  }
  for (const record of Object.values(status.tasks)) {
    const key = nonEmptyString(record.status) ?? "UNKNOWN";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const paths = catalogPaths();
  return {
    schemaVersion: "1.0.0",
    artifactType: "INPUT_PACK_PARTIAL_INVENTORY",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    stable: activeWriters.length === 0,
    activeWriters,
    dataRoot,
    cacheRoot,
    statusFile,
    statusSha256: sha256File(statusFile),
    statusCounts: counts,
    catalogs: Object.fromEntries(
      Object.entries(paths).map(([key, path]) => [key, { path, exists: existsSync(path) }]),
    ),
    rows: rows.sort((left, right) =>
      left.taskId.localeCompare(right.taskId, "en-US", { numeric: true }),
    ),
  };
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dataRoot = optionValue(argv, "--data-root");
  if (dataRoot === undefined) throw new Error("MISSING_DATA_ROOT");
  const document = buildPartialInventory({
    dataRoot,
    cacheRoot: optionValue(argv, "--cache-root"),
    statusFile: optionValue(argv, "--status-file"),
    outputPath: optionValue(argv, "--output"),
    requireStable: !argv.includes("--allow-unstable"),
  });
  const output = `${JSON.stringify(document, null, 2)}\n`;
  const outputPath = optionValue(argv, "--output");
  if (outputPath === undefined) process.stdout.write(output);
  else writeFileSync(resolve(outputPath), output, "utf8");
}

if (basename(process.argv[1] ?? "") === "inventory-input-pack-partials.ts") {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
