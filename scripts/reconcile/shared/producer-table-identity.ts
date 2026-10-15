import { normalizeName } from "../../machine-facts/machine-facts-contract.ts";
import type { ProducerTableIdentity } from "../producer/producer-index.ts";

const NATIVE_HIVE_COMPUTE_CATEGORIES = new Set([
  "sparkindex",
  "hivetask",
  "hivetask-2.0",
]);

export function isNativeHiveComputeCategory(
  taskCategory: string | null | undefined,
): boolean {
  return NATIVE_HIVE_COMPUTE_CATEGORIES.has(
    taskCategory?.trim().toLowerCase() ?? "",
  );
}

export function isToHiveSyncCategory(
  taskCategory: string | null | undefined,
): boolean {
  const category = taskCategory?.trim().toLowerCase() ?? "";
  return category.endsWith("2hive") && !isNativeHiveComputeCategory(category);
}

export function unavailableReadScopeReason(
  taskCategory: string | null | undefined,
): "SOURCE_ENDPOINT_BOUNDARY" | "READ_SCOPE_UNAVAILABLE" {
  return isToHiveSyncCategory(taskCategory)
    ? "SOURCE_ENDPOINT_BOUNDARY"
    : "READ_SCOPE_UNAVAILABLE";
}

export function resolveProducerTableIdentity(input: {
  readonly qualifiedName: string;
  readonly taskCategory: string | null;
}): ProducerTableIdentity {
  const normalized = normalizeName(input.qualifiedName);
  const parts = normalized.split(".");
  if (parts.length >= 3) {
    return {
      platform: parts[0]!,
      dataSource: parts[1]!,
      qualifiedName: parts.slice(2).join("."),
    };
  }
  if (parts.length === 2 && isNativeHiveComputeCategory(input.taskCategory)) {
    return {
      platform: "hive",
      dataSource: "gfhive",
      qualifiedName: normalized,
    };
  }
  return {
    platform: "unknown",
    dataSource: "unknown",
    qualifiedName: normalized,
  };
}
