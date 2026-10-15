import { createTableLikeSource } from "../../plans/ddl-schema.ts";
import { columnNamesFromCreateTable } from "./sql-table-references.ts";

export const DEFAULT_LIKE_CHAIN_MAX_DEPTH = 3;

export function normalizeQualifiedName(value: string): string {
  return value.trim().toLowerCase();
}

export function qualifyCreateTableLikeSource(
  targetQualifiedName: string,
  likeSource: string,
): string {
  const source = likeSource.trim();
  if (source.includes(".")) return source;
  const schema = targetQualifiedName.split(".").slice(0, -1).join(".");
  return schema ? `${schema}.${source}` : source;
}

export function isCreateTableLikeOnly(ddl: string): boolean {
  return (
    createTableLikeSource(ddl) !== undefined &&
    columnNamesFromCreateTable(ddl).length === 0
  );
}

export function tableHasProvableColumns(ddl: string): boolean {
  return columnNamesFromCreateTable(ddl).length > 0;
}

export type CreateTableLikeChainStopReason =
  | "SOURCE_ROOT"
  | "MAX_DEPTH"
  | "CYCLE"
  | "DDL_MISS";

export interface CreateTableLikeChainResult {
  readonly sources: readonly string[];
  readonly stoppedReason?: CreateTableLikeChainStopReason;
}

/**
 * Returns LIKE source qualified names from leaf to immediate parent of `target`.
 * `readDdl` is consulted while walking the chain; a missing DDL stops traversal.
 */
export function collectCreateTableLikeSources(
  targetQualifiedName: string,
  readDdl: (qualifiedName: string) => string | undefined,
  maxDepth: number = DEFAULT_LIKE_CHAIN_MAX_DEPTH,
): CreateTableLikeChainResult {
  const sources: string[] = [];
  const visited = new Set<string>([
    normalizeQualifiedName(targetQualifiedName),
  ]);
  let current = targetQualifiedName;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const ddl = readDdl(current);
    if (ddl === undefined) {
      return {
        sources: [...sources].reverse(),
        stoppedReason: "DDL_MISS",
      };
    }
    const like = createTableLikeSource(ddl);
    if (like === undefined) {
      return { sources: [...sources].reverse(), stoppedReason: "SOURCE_ROOT" };
    }
    const source = qualifyCreateTableLikeSource(current, like);
    const normalized = normalizeQualifiedName(source);
    if (visited.has(normalized)) {
      return { sources: [...sources].reverse(), stoppedReason: "CYCLE" };
    }
    visited.add(normalized);
    sources.push(source);
    current = source;
  }
  return { sources: [...sources].reverse(), stoppedReason: "MAX_DEPTH" };
}
