import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqlSession } from "sqllens";
import { sanitizeSqlForParser } from "../../plans/parser-sql-input.ts";
import { canonicalJson, sha256Text, type JsonValue } from "./input-pack.ts";

export const STANDARDIZED_SQL_VERSION = "standardized-sql-v1";
// Reviewed configuration-only Hive settings. Variable assignment, USE and
// parser-mode settings deliberately remain on the normal analysis path.
const settingKeys = new Set([
  "hive.merge.mapfiles", "hive.merge.mapredfiles", "hive.merge.size.per.task",
  "hive.merge.smallfiles.avgsize", "hive.merge.orcfile.stripe.level",
  "hive.exec.dynamic.partition", "hive.exec.dynamic.partition.mode",
  "hive.exec.max.created.files", "hive.exec.max.dynamic.partitions.pernode",
  "hive.exec.max.dynamic.partitions", "hive.auto.convert.join",
  "hive.optimize.sort.dynamic.partition", "hive.map.aggr",
  "hive.groupby.skewindata", "hive.support.concurrency",
]);
export const statementFingerprint = (sql: string) => sha256Text(sql.replace(/\r\n?/g, "\n").trim());

export function describeStandardizedSql(sql: string, dialect: "databricks" | "duckdb") {
  const parser = sanitizeSqlForParser(sql);
  return SqlSession.create(parser.sql, dialect).doc.statements.map((cell, ordinal) => {
    const raw = sql.slice(cell.span.start, cell.span.end);
    const significant = raw.replace(/^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, "");
    const match = significant.match(/^SET\s+(hive\.[a-z.]+)\s*=\s*(true|false|strict|nonstrict|\d+)\s*;?\s*$/i);
    const configuration = dialect === "databricks" && cell.category === "utility" && cell.errors === 0 && match && settingKeys.has(match[1]!.toLowerCase())
      ? { key: match[1]!.toLowerCase(), value: match[2]!, fieldAnalysis: "NOT_APPLICABLE" as const }
      : null;
    return { ordinal, span: { start: cell.span.start, end: cell.span.end },
      statementSha256: statementFingerprint(raw), category: cell.category,
      parserErrors: cell.errors, configuration };
  });
}

export function buildStandardizedSql(taskId: string, taskHash: string, dialect: "databricks" | "duckdb", slots: Array<{slot: string; content: string}>) {
  return { version: STANDARDIZED_SQL_VERSION, taskId, taskHash, dialect,
    slots: slots.map(s => ({ slot: s.slot, sqlSha256: sha256Text(s.content), statements: describeStandardizedSql(s.content, dialect) })) };
}

export interface StandardizedInput {
  readonly version: string;
  readonly artifactSha256: string;
  readonly configurations: readonly { readonly ordinal: number; readonly start: number; readonly end: number; readonly statementSha256: string; readonly key: string; readonly value: string }[];
}

/** Verify against the actual Pack bytes before consuming any role assignment. */
export function loadStandardizedInput(taskPath: string, task: {taskId: string; contentHash: string; sqlFiles: JsonValue[]}, dialect: "databricks" | "duckdb", combinedSql: string) {
  const manifestPath = join(dirname(taskPath), "standardized-sql.json");
  const bytes = readFileSync(manifestPath, "utf8");
  const actual = JSON.parse(bytes);
  const slots = task.sqlFiles.map(value => {
    const file = value as {slot: string; path: string; sha256: string};
    const content = readFileSync(join(dirname(taskPath), file.path), "utf8");
    if (sha256Text(content) !== file.sha256) throw new Error("STANDARDIZED_SQL_SOURCE_CHANGED");
    return { slot: file.slot, content };
  });
  const expected = buildStandardizedSql(task.taskId, task.contentHash, dialect, slots);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("STANDARDIZED_SQL_MANIFEST_MISMATCH");
  const known = new Set(expected.slots.flatMap(s => s.statements.filter(r => r.configuration).map(r => r.statementSha256)));
  // The existing preparation step may trim/repeat-normalize slots. Only carry
  // exact, fingerprint-matched standardized records to its resulting positions.
  const configurations = describeStandardizedSql(combinedSql, dialect).flatMap(r =>
    r.configuration && known.has(r.statementSha256) ? [{ ordinal: r.ordinal, start: r.span.start, end: r.span.end,
      statementSha256: r.statementSha256, key: r.configuration.key, value: r.configuration.value }] : []);
  return { manifestPath, bytes, profile: { version: STANDARDIZED_SQL_VERSION, artifactSha256: sha256Text(bytes), configurations } satisfies StandardizedInput };
}
