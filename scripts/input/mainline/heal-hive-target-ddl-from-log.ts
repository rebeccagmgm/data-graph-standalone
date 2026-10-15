/**
 * End-to-end heal for PARTIAL tasks whose only gap is Hive target DDL,
 * when the task type is a *2hive loader that emits `Process hive ddl:` in
 * Horae AnyLoader logs.
 *
 * Pipeline:
 *   summaries.jsonl(+…) → ONLY_HIVE_TARGET_GAP ∩ *2hive
 *     → fill-hive-ddl-from-log (cache hive-target-ddl.sql)
 *     → input-pack:from-cache --force
 *
 * Non-*2hive ONLY_HIVE gaps (hiveTask / sparkIndex / …) are listed and skipped;
 * they need a different catalog path, not this log extract.
 *
 * Usage:
 *   npm run input-pack:heal-hive-target-ddl -- `
 *     --data-root sql-static-lineage-data `
 *     --from-summaries path\to\a\summaries.jsonl,path\to\b\summaries.jsonl `
 *     --data-date 2026-08-27 `
 *     --write-ids-dir sql-static-lineage-data\tmp\from-cache-full\partial-analysis `
 *     --log-dir sql-static-lineage-data\tmp\from-cache-full\logs-heal-hive-ddl
 *
 *   # inventory only
 *   npm run input-pack:heal-hive-target-ddl -- ... --dry-run
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { collectInputPackFromCache } from "./collect-input-pack-from-cache.ts";
import {
  fillHiveDdlFromLogCache,
  HIVE_DDL_FROM_LOG_TASK_TYPES,
  type FillHiveDdlFromLogCacheSummary,
} from "./fill-hive-ddl-from-log-cache.ts";
import { DEFAULT_RUN_SCRIPT_LOG_DATE } from "./run-script-sql-cache.ts";
import { DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT } from "../../evidence/schedule-evidence-cache.ts";
import {
  inventoryPartialGapsFromSummaryFiles,
  selectHiveDdlLogHealCandidates,
  type HiveDdlLogHealSelection,
} from "../shared/partial-gap-from-summaries.ts";

export interface HealHiveTargetDdlFromLogOptions {
  readonly dataRoot: string;
  readonly summariesPaths: readonly string[];
  readonly cacheRoot?: string;
  readonly dataDate?: string;
  readonly writeIdsDir?: string;
  readonly logDir?: string;
  readonly dryRun?: boolean;
  readonly skipFill?: boolean;
  readonly skipForce?: boolean;
  readonly forceFill?: boolean;
  readonly limit?: number;
  readonly maxErrors?: number;
  readonly minIntervalMs?: number;
  readonly hiveMetadataPath?: string;
  readonly hiveDdlPath?: string;
  readonly rdbmsCorePath?: string;
  readonly rdbmsDdlPath?: string;
  readonly indexDir?: string;
}

export interface HealHiveTargetDdlFromLogResult {
  readonly selection: HiveDdlLogHealSelection;
  readonly eligibleIds: readonly string[];
  readonly fill: FillHiveDdlFromLogCacheSummary | null;
  readonly collectCounts: Readonly<Record<string, number>> | null;
  readonly dryRun: boolean;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

/** Collect `--from-summaries a,b --from-summaries c` (comma or repeated flags). */
function fromSummariesPaths(argv: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--from-summaries") continue;
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) values.push(...splitPaths(value));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of values) {
    const key = resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function parseIntegerOption(
  argv: readonly string[],
  name: string,
  fallback: number | undefined,
  allowZero: boolean,
): number | undefined {
  const raw = option(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1))
    throw new Error(
      `${name.slice(2).toUpperCase().replaceAll("-", "_")}_INVALID`,
    );
  return value;
}

function splitPaths(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(/[,;]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function writeIdList(dir: string, fileName: string, ids: readonly string[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, `${ids.join("\n")}${ids.length > 0 ? "\n" : ""}`, "utf8");
  return path;
}

function countStatuses(
  statuses: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of statuses) {
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

export function parseHealHiveTargetDdlFromLogArgs(
  argv: readonly string[],
): HealHiveTargetDdlFromLogOptions {
  const summariesPaths = fromSummariesPaths(argv);
  const dataRoot = option(argv, "--data-root");
  if (dataRoot === undefined || dataRoot.trim() === "")
    throw new Error("DATA_ROOT_REQUIRED");
  if (summariesPaths.length === 0) throw new Error("FROM_SUMMARIES_REQUIRED");
  return {
    dataRoot,
    summariesPaths,
    cacheRoot: option(argv, "--cache-root"),
    dataDate: option(argv, "--data-date"),
    writeIdsDir: option(argv, "--write-ids-dir"),
    logDir: option(argv, "--log-dir"),
    dryRun: hasFlag(argv, "--dry-run"),
    skipFill: hasFlag(argv, "--skip-fill"),
    skipForce: hasFlag(argv, "--skip-force"),
    forceFill: hasFlag(argv, "--force-fill"),
    limit: parseIntegerOption(argv, "--limit", undefined, false),
    maxErrors: parseIntegerOption(argv, "--max-errors", undefined, true),
    minIntervalMs: parseIntegerOption(argv, "--min-interval-ms", undefined, true),
    hiveMetadataPath: option(argv, "--hive-metadata-jsonl"),
    hiveDdlPath: option(argv, "--hive-ddl-jsonl"),
    rdbmsCorePath: option(argv, "--rdbms-core-jsonl"),
    rdbmsDdlPath: option(argv, "--rdbms-ddl-jsonl"),
    indexDir: option(argv, "--index-dir"),
  };
}

export async function healHiveTargetDdlFromLog(
  options: HealHiveTargetDdlFromLogOptions,
): Promise<HealHiveTargetDdlFromLogResult> {
  const inventory = inventoryPartialGapsFromSummaryFiles(options.summariesPaths);
  const selection = selectHiveDdlLogHealCandidates(
    inventory.rows,
    HIVE_DDL_FROM_LOG_TASK_TYPES,
  );
  let eligibleIds = [...selection.eligibleIds];
  if (options.limit !== undefined) eligibleIds = eligibleIds.slice(0, options.limit);

  if (options.writeIdsDir !== undefined) {
    const eligiblePath = writeIdList(
      options.writeIdsDir,
      "ids-ONLY_HIVE_TARGET_GAP-2hive-eligible.txt",
      eligibleIds,
    );
    const skippedPath = writeIdList(
      options.writeIdsDir,
      "ids-ONLY_HIVE_TARGET_GAP-not-2hive.txt",
      selection.skippedIds,
    );
    process.stderr.write(
      `[heal-hive-ddl] wrote eligible ${eligibleIds.length} → ${eligiblePath}\n`,
    );
    process.stderr.write(
      `[heal-hive-ddl] wrote skipped ${selection.skippedIds.length} → ${skippedPath}\n`,
    );
  }

  process.stderr.write(
    `[heal-hive-ddl] plan ${JSON.stringify({
      summaries: options.summariesPaths.length,
      onlyHiveGap: selection.eligibleIds.length + selection.skippedIds.length,
      eligible: eligibleIds.length,
      eligibleByCategory: selection.eligibleByCategory,
      skipped: selection.skippedIds.length,
      skippedByCategory: selection.skippedByCategory,
      dryRun: options.dryRun === true,
      skipFill: options.skipFill === true,
      skipForce: options.skipForce === true,
    })}\n`,
  );

  if (options.dryRun === true) {
    return {
      selection,
      eligibleIds,
      fill: null,
      collectCounts: null,
      dryRun: true,
    };
  }

  if (eligibleIds.length === 0) {
    process.stderr.write("[heal-hive-ddl] no eligible *2hive ids; done\n");
    return {
      selection,
      eligibleIds,
      fill: null,
      collectCounts: null,
      dryRun: false,
    };
  }

  const cacheRoot = options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const dataDate = options.dataDate ?? DEFAULT_RUN_SCRIPT_LOG_DATE;

  let fill: FillHiveDdlFromLogCacheSummary | null = null;
  if (options.skipFill !== true) {
    fill = await fillHiveDdlFromLogCache({
      cacheRoot,
      taskIds: eligibleIds,
      dataDate,
      maxErrors: options.maxErrors,
      minIntervalMs: options.minIntervalMs,
      force: options.forceFill === true,
    });
    process.stderr.write(`[heal-hive-ddl] fill ${JSON.stringify(fill)}\n`);
    if (fill.stopped || fill.errors > 0) {
      throw new Error(
        `HIVE_DDL_FILL_FAILED:errors=${fill.errors}:stopped=${fill.stopped}`,
      );
    }
  }

  let collectCounts: Record<string, number> | null = null;
  if (options.skipForce !== true) {
    const summaries = collectInputPackFromCache({
      dataRoot: options.dataRoot,
      cacheRoot,
      taskIds: eligibleIds,
      force: true,
      logDir: options.logDir,
      hiveMetadataPath: options.hiveMetadataPath,
      hiveDdlPath: options.hiveDdlPath,
      rdbmsCorePath: options.rdbmsCorePath,
      rdbmsDdlPath: options.rdbmsDdlPath,
      indexDir: options.indexDir,
    });
    collectCounts = countStatuses(
      summaries.map((row) => row.collectionStatus),
    );
    process.stderr.write(
      `[heal-hive-ddl] collect ${JSON.stringify(collectCounts)}\n`,
    );
  }

  return {
    selection,
    eligibleIds,
    fill,
    collectCounts,
    dryRun: false,
  };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry?.endsWith("heal-hive-target-ddl-from-log.ts") ?? false;
}

if (isDirectExecution()) {
  try {
    const result = await healHiveTargetDdlFromLog(
      parseHealHiveTargetDdlFromLogArgs(process.argv),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
