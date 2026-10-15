/**
 * Shared Hive-producer tracing bounds.
 *
 * checkdbflag / other no-SQL scheduler types and non-Hive physical tables are
 * expected terminals. They are not Input Pack gaps and must not be re-decided
 * inside individual consumers.
 */

import {
  DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  loadTerminalTableConfig,
  matchingTerminalRole,
} from "./terminal-table-config.ts";

export const NO_SQL_TASK_CATEGORIES: ReadonlySet<string> = new Set([
  "checkdbflag",
  "checkHdfsFlag",
  "alert",
  "checkAlert",
  "exeSql",
  "qualityTask",
  "hiveEmail",
  "file2hive",
  "hive2file",
]);

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function isNoSqlTaskCategory(category: unknown): boolean {
  const value = text(category);
  return value !== null && NO_SQL_TASK_CATEGORIES.has(value);
}

export function isCheckdbflagTask(input: {
  readonly taskCategory?: unknown;
  readonly taskName?: unknown;
  readonly locators?: readonly unknown[];
}): boolean {
  const category = text(input.taskCategory);
  if (category !== null && category.toLocaleLowerCase("en-US") === "checkdbflag")
    return true;
  const taskName = text(input.taskName);
  if (taskName !== null && /^checker\./i.test(taskName)) return true;
  return (input.locators ?? []).some((locator) =>
    /(?:^|\/)checkdbflag(?:\/|$)/i.test(text(locator) ?? ""),
  );
}

/** True when producer-index tracing should stop: platform is known and not Hive. */
export function isNonHiveProducerBoundary(platform: unknown): boolean {
  const value = text(platform);
  if (value === null) return false;
  return value.toLocaleLowerCase("en-US") !== "hive";
}

export function isTaskLocalTempTable(qualifiedName: unknown): boolean {
  const value = text(qualifiedName);
  return value !== null && /^temp\./i.test(value);
}

/** Same-task scratch tables such as dm_rsk_n.*_temp written and read inside one task. */
export function isSameTaskScratchTable(qualifiedName: unknown): boolean {
  const value = text(qualifiedName);
  return value !== null && /(?:^|\.).+_temp$/i.test(value);
}

/** Producer bridge where field-lineage resolves the read as task-local materialization. */
export function isSameTaskScratchProducerBridge(
  consumerTaskId: unknown,
  producerTaskId: unknown,
  qualifiedName: unknown,
): boolean {
  const consumer = text(consumerTaskId);
  const producer = text(producerTaskId);
  return (
    consumer !== null
    && producer !== null
    && consumer === producer
    && isSameTaskScratchTable(qualifiedName)
  );
}

let cachedTerminalConfig: ReturnType<typeof loadTerminalTableConfig> | null = null;

function terminalConfig(): ReturnType<typeof loadTerminalTableConfig> {
  if (!cachedTerminalConfig) {
    cachedTerminalConfig = loadTerminalTableConfig(DEFAULT_TERMINAL_TABLE_CONFIG_PATH);
  }
  return cachedTerminalConfig;
}

export function referenceConfigRole(qualifiedName: unknown): string | null {
  const value = text(qualifiedName);
  if (value === null) return null;
  return matchingTerminalRole(terminalConfig(), value);
}

export function isReferenceConfigTable(qualifiedName: unknown): boolean {
  return referenceConfigRole(qualifiedName) !== null;
}

export interface PhysicalTableLike {
  readonly platform?: unknown;
  readonly qualifiedName?: unknown;
}

/**
 * Tables that must never become UNBOUND/UNKNOWN producer gaps in causal closure.
 * Oracle terminals, reference/config tables, and task-local temp reads are expected
 * stops — the same rules multi-hop already applies.
 */
export function isOutOfScopePhysicalRead(table: PhysicalTableLike | null | undefined): boolean {
  if (!table) return false;
  if (isNonHiveProducerBoundary(table.platform)) return true;
  if (isReferenceConfigTable(table.qualifiedName)) return true;
  if (isTaskLocalTempTable(table.qualifiedName)) return true;
  return false;
}

export function isOutOfScopeTerminalReason(reason: unknown): boolean {
  const value = text(reason);
  return value === "REFERENCE_CONFIG" || value === "TASK_LOCAL_MATERIALIZATION";
}
