/** Exact qualified table-name rules; no wildcard or recursive exclusions. */
export function normalizeHiddenTables(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(table =>
    typeof table !== "string" || table.length > 256 || !/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(table.trim()),
  )) throw new Error("INVALID_HIDDEN_TABLES");
  return [...new Set(value.map(table => table.trim().toLowerCase()))];
}

export function tableVisibilityPredicate(alias: "n" | "source" | "target") {
  return `NOT toLower(coalesce(${alias}.table,'')) IN $hiddenTables`;
}
