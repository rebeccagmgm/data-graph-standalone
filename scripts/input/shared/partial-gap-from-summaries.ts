import { readFileSync } from "node:fs";

export type PartialGapBucket =
  | "ONLY_HIVE_TARGET_GAP"
  | "HAS_AMBIGUOUS"
  | "HAS_RDBMS_DDL_GAP"
  | "OTHER_PARTIAL"
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED"
  | "EXCLUDED";

export interface CollectSummaryRow {
  readonly taskId: string;
  readonly collectionStatus: string;
  readonly taskCategory?: string;
  readonly warnings: readonly string[];
  readonly tablesWritten?: number;
}

export interface PartialGapInventory {
  readonly byBucket: ReadonlyMap<PartialGapBucket, readonly string[]>;
  readonly rows: readonly CollectSummaryRow[];
}

const AMB_RE = /RDBMS_CORE_AMBIGUOUS/;
const DDL_RE = /RDBMS_DDL_/;
const HIVE_RE = /HIVE_DDL_MISS|TABLE_JSONL_MISS|HIVE_METADATA/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseCollectSummaryLine(line: string): CollectSummaryRow | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (record === undefined) return undefined;
  const taskId =
    typeof record.taskId === "string"
      ? record.taskId.trim()
      : typeof record.task_id === "string"
        ? record.task_id.trim()
        : "";
  if (taskId === "") return undefined;
  const collectionStatus =
    typeof record.collectionStatus === "string"
      ? record.collectionStatus
      : typeof record.status === "string"
        ? record.status
        : "UNKNOWN";
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((item): item is string => typeof item === "string")
    : [];
  return {
    taskId,
    collectionStatus,
    taskCategory:
      typeof record.taskCategory === "string" ? record.taskCategory : undefined,
    warnings,
    tablesWritten:
      typeof record.tablesWritten === "number" ? record.tablesWritten : undefined,
  };
}

export function bucketCollectSummary(row: CollectSummaryRow): PartialGapBucket {
  const status = row.collectionStatus.toUpperCase();
  if (status === "SUCCESS") return "SUCCESS";
  if (status === "FAILED") return "FAILED";
  if (status === "SKIPPED") return "SKIPPED";
  if (status === "EXCLUDED") return "EXCLUDED";
  if (status !== "PARTIAL") return "OTHER_PARTIAL";
  const joined = row.warnings.join("|");
  if (AMB_RE.test(joined)) return "HAS_AMBIGUOUS";
  if (DDL_RE.test(joined)) return "HAS_RDBMS_DDL_GAP";
  if (HIVE_RE.test(joined)) return "ONLY_HIVE_TARGET_GAP";
  return "OTHER_PARTIAL";
}

function inventoryFromLatestRows(
  latest: ReadonlyMap<string, CollectSummaryRow>,
): PartialGapInventory {
  const rows = [...latest.values()];
  const buckets = new Map<PartialGapBucket, string[]>();
  for (const row of rows) {
    const bucket = bucketCollectSummary(row);
    const list = buckets.get(bucket) ?? [];
    list.push(row.taskId);
    buckets.set(bucket, list);
  }
  for (const [bucket, ids] of buckets) {
    ids.sort((a, b) => a.localeCompare(b, "en-US", { numeric: true }));
    buckets.set(bucket, ids);
  }
  return { byBucket: buckets, rows };
}

/**
 * Inventory Input Pack collect `summaries.jsonl` into gap buckets.
 * Later fill scripts should take IDs from these buckets instead of ad-hoc greps.
 */
export function inventoryPartialGapsFromSummaries(
  summariesPath: string,
): PartialGapInventory {
  const lines = readFileSync(summariesPath, "utf8").split(/\r?\n/u);
  const latest = new Map<string, CollectSummaryRow>();
  for (const line of lines) {
    const row = parseCollectSummaryLine(line);
    if (row === undefined) continue;
    latest.set(row.taskId, row);
  }
  return inventoryFromLatestRows(latest);
}

/**
 * Merge multiple collect summaries (later files win per taskId), then bucket.
 * Use when refresh / force runs wrote separate `summaries.jsonl` trees.
 */
export function inventoryPartialGapsFromSummaryFiles(
  summariesPaths: readonly string[],
): PartialGapInventory {
  if (summariesPaths.length === 0) throw new Error("SUMMARIES_PATHS_EMPTY");
  const latest = new Map<string, CollectSummaryRow>();
  for (const summariesPath of summariesPaths) {
    const lines = readFileSync(summariesPath, "utf8").split(/\r?\n/u);
    for (const line of lines) {
      const row = parseCollectSummaryLine(line);
      if (row === undefined) continue;
      latest.set(row.taskId, row);
    }
  }
  return inventoryFromLatestRows(latest);
}

export interface HiveDdlLogHealSelection {
  /** ONLY_HIVE_TARGET_GAP ∩ eligible *2hive types (AnyLoader log DDL). */
  readonly eligibleIds: readonly string[];
  /** ONLY_HIVE_TARGET_GAP but not a log-DDL task type (hiveTask / sparkIndex…). */
  readonly skippedIds: readonly string[];
  readonly skippedByCategory: Readonly<Record<string, number>>;
  readonly eligibleByCategory: Readonly<Record<string, number>>;
}

const HIVE_DDL_WARN_RE = /:(HIVE_DDL_MISS|HIVE_DDL_AMBIGUOUS)\b/u;
const HIVEISH_TABLE_MISS_RE =
  /^(odata_|pdata_|ndata_|dm_|ads_|dwd_|dws_|gf_|temp)[^:]*:TABLE_JSONL_MISS\b/iu;

/** True when log-extracted target DDL could plausibly clear the gap. */
export function warningLooksLikeHiveTargetDdlGap(
  warnings: readonly string[],
): boolean {
  return warnings.some(
    (warning) =>
      HIVE_DDL_WARN_RE.test(warning) || HIVEISH_TABLE_MISS_RE.test(warning),
  );
}

/**
 * Split ONLY_HIVE_TARGET_GAP into tasks that can use `fill-hive-ddl-from-log`
 * vs types that need another path (read-table catalog gaps, etc.).
 *
 * *2hive rows whose warnings are only cold RDBMS `TABLE_JSONL_MISS` (no Hive
 * target shape) are skipped — Horae AnyLoader DDL will not help.
 */
export function selectHiveDdlLogHealCandidates(
  rows: readonly CollectSummaryRow[],
  eligibleTaskTypes: ReadonlySet<string>,
): HiveDdlLogHealSelection {
  const eligibleIds: string[] = [];
  const skippedIds: string[] = [];
  const skippedByCategory: Record<string, number> = {};
  const eligibleByCategory: Record<string, number> = {};
  for (const row of rows) {
    if (bucketCollectSummary(row) !== "ONLY_HIVE_TARGET_GAP") continue;
    const category = row.taskCategory?.trim() || "unknown";
    const canHeal =
      eligibleTaskTypes.has(category) &&
      warningLooksLikeHiveTargetDdlGap(row.warnings);
    if (canHeal) {
      eligibleIds.push(row.taskId);
      eligibleByCategory[category] = (eligibleByCategory[category] ?? 0) + 1;
    } else {
      skippedIds.push(row.taskId);
      skippedByCategory[category] = (skippedByCategory[category] ?? 0) + 1;
    }
  }
  const sortIds = (ids: string[]) =>
    ids.sort((a, b) => a.localeCompare(b, "en-US", { numeric: true }));
  return {
    eligibleIds: sortIds(eligibleIds),
    skippedIds: sortIds(skippedIds),
    skippedByCategory,
    eligibleByCategory,
  };
}

export function hiveTargetNamesFromWarnings(
  warnings: readonly string[],
): string[] {
  const names = new Set<string>();
  for (const warning of warnings) {
    const match =
      /^([^:]+):(HIVE_DDL_MISS|TABLE_JSONL_MISS|HIVE_METADATA(?:_AMBIGUOUS_ACTIVE)?)$/u.exec(
        warning.trim(),
      );
    if (!match) continue;
    const name = match[1]!.trim().toLowerCase();
    if (name.includes(".")) names.add(name);
  }
  return [...names].sort();
}
