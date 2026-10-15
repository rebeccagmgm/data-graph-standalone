import type { JsonValue, TableEvidence } from "./input-pack.ts";

export type TargetEvidenceKind =
  | "DIRECT_PLATFORM_TARGET"
  | "TABLE_TASK_RELATION_DIRECTION_UNKNOWN"
  | "SQL_EXACT_TABLE_TARGET";

export const CONTROLLED_TASK_ENDPOINT_DATA_SOURCES: Readonly<
  Record<string, Readonly<{ source?: string; target?: string }>>
> = {
  oracle2hive: { target: "gfhive" },
  mysql2hive: { target: "gfhive" },
  hive2oracle: { source: "gfhive" },
  hive2starrocks: { source: "gfhive", target: "gfstarrocks_idms_all" },
  sparkIndex: { source: "gfhive", target: "gfhive" },
  "hiveTask-2.0": { source: "gfhive", target: "gfhive" },
};

/**
 * The task category is the controlled evidence for the endpoint platform
 * when a task source is only a connector/data-source label. This is used to
 * validate a table candidate after its physical DDL has been loaded; it does
 * not manufacture a physical table identity.
 */
export const CONTROLLED_TASK_ENDPOINT_PLATFORMS: Readonly<
  Record<string, Readonly<{ source?: string; target?: string }>>
> = {
  mysql2hive: { source: "mysql", target: "hive" },
  oracle2hive: { source: "oracle", target: "hive" },
  td2hive: { source: "td", target: "hive" },
  mongo2hive: { source: "mongo", target: "hive" },
  postgre2hive: { source: "postgres", target: "hive" },
  pg2hive: { source: "postgres", target: "hive" },
  postgres2hive: { source: "postgres", target: "hive" },
  sqlserver2hive: { source: "sqlserver", target: "hive" },
  oceanbase2hive: { source: "oceanbase", target: "hive" },
  dolphindb2hive: { source: "dolphindb", target: "hive" },
  oracle2mysql: { source: "oracle", target: "mysql" },
  hive2mysql: { source: "hive", target: "mysql" },
  hive2postgre: { source: "hive", target: "postgre" },
  hive2oracle: { source: "hive", target: "oracle" },
  hive2td: { source: "hive", target: "td" },
  hive2sqlserver: { source: "hive", target: "sqlserver" },
  hive2mongo: { source: "hive", target: "mongo" },
  hive2oceanbase: { source: "hive", target: "oceanbase" },
  hive2dolphindb: { source: "hive", target: "dolphindb" },
  sparkIndex: { source: "hive", target: "hive" },
  "hiveTask-2.0": { source: "hive", target: "hive" },
  hive2starrocks: { source: "hive", target: "starrocks" },
};

export function controlledTaskEndpointDataSource(
  taskCategory: string | null | undefined,
  side: "source" | "target",
): string | undefined {
  return CONTROLLED_TASK_ENDPOINT_DATA_SOURCES[taskCategory ?? ""]?.[side];
}

export function controlledTaskEndpointPlatform(
  taskCategory: string | null | undefined,
  side: "source" | "target",
): string | undefined {
  return CONTROLLED_TASK_ENDPOINT_PLATFORMS[taskCategory ?? ""]?.[side];
}

export function inputCollectionStatus(
  tableResultCount: number,
  hasUnavailableTable: boolean,
  hasEndpointConflict: boolean,
  hasUnavailableSql = false,
  hasUnavailableReference = false,
): "SUCCESS" | "PARTIAL" {
  return tableResultCount === 0 ||
    hasUnavailableTable ||
    hasEndpointConflict ||
    hasUnavailableSql ||
    hasUnavailableReference
    ? "PARTIAL"
    : "SUCCESS";
}

export function shouldUseTaskRelationFallback(
  source: unknown,
  target: unknown,
): boolean {
  const hasDirectValue = (value: unknown): boolean =>
    value !== undefined &&
    value !== null &&
    !(
      typeof value === "string" &&
      (value.trim() === "" || value.trim() === "-")
    );
  return !hasDirectValue(source) && !hasDirectValue(target);
}

export function targetEvidenceKindFor(
  target: JsonValue | undefined,
  relationTarget: TableEvidence | undefined,
  sqlTarget: TableEvidence | undefined = undefined,
): TargetEvidenceKind | undefined {
  if (relationTarget !== undefined)
    return "TABLE_TASK_RELATION_DIRECTION_UNKNOWN";
  if ((target === undefined || target === null) && sqlTarget !== undefined)
    return "SQL_EXACT_TABLE_TARGET";
  return target !== undefined && target !== null
    ? "DIRECT_PLATFORM_TARGET"
    : undefined;
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function qualifiedNameOf(value: JsonValue): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.includes(".") && !trimmed.includes("@")
      ? trimmed
      : undefined;
  }
  if (!isObject(value)) return undefined;
  const qualifiedName = value.qualifiedName;
  if (typeof qualifiedName !== "string") return undefined;
  const trimmed = qualifiedName.trim();
  return trimmed.includes(".") && !trimmed.includes("@") ? trimmed : undefined;
}

function nonEmptyString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * Adds physical endpoint identity to direct task source/target configuration.
 * It never turns a non-table value into a table reference.
 */
export function enrichTaskEndpoint(
  value: JsonValue | undefined,
  table: TableEvidence | undefined,
): JsonValue | undefined {
  if (value === null) return null;
  if (value === undefined && table !== undefined)
    return {
      platform: table.platform,
      qualifiedName: table.qualifiedName,
      dataSource: table.dataSource,
    };
  if (value === undefined) return undefined;
  const qualifiedName = qualifiedNameOf(value);
  if (qualifiedName === undefined) return value;

  const existing = isObject(value) ? value : {};
  const dataSource = table?.dataSource ?? nonEmptyString(existing.dataSource);
  if (dataSource === undefined) return value;

  return {
    ...existing,
    ...(table?.platform === undefined ? {} : { platform: table.platform }),
    qualifiedName: table?.qualifiedName ?? qualifiedName,
    dataSource,
  };
}
