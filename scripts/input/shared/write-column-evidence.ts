import { createHash } from "node:crypto";
import { loaderProperty, verifyRuntimeTargetIdentity } from "./runtime-target-evidence.ts";
import type { HoraeDatasourceIndex } from "./horae-datasource-cache.ts";

export interface TaskWriteColumnEvidence {
  readonly querySha256: string;
  readonly targetIdentitySha256: string;
  readonly columns: readonly string[];
  readonly sourceSha256: string;
  readonly source: string;
  readonly observedAt: string;
  readonly runtimeTargetSha256?: string;
}
export const evidenceHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export function targetIdentityHash(target: unknown): string {
  const t = target as Record<string, unknown>;
  if (!t || typeof t !== "object" || !["platform", "dataSource", "qualifiedName"].every(k => typeof t[k] === "string" && t[k]))
    throw new Error("WRITE_COLUMNS_TARGET_IDENTITY_INCOMPLETE");
  return evidenceHash(JSON.stringify([t.platform, t.dataSource, String(t.qualifiedName).toLowerCase()]));
}
export function validateWriteColumnEvidence(value: unknown): asserts value is TaskWriteColumnEvidence {
  const v = value as TaskWriteColumnEvidence;
  if (!v || ![v.querySha256, v.targetIdentitySha256, v.sourceSha256].every(h => typeof h === "string" && /^[a-f0-9]{64}$/.test(h)) ||
    !Array.isArray(v.columns) || !v.columns.length || v.columns.length > 4096 ||
    !v.columns.every(c => typeof c === "string" && /^[a-z_][a-z0-9_$]*$/i.test(c)) ||
    new Set(v.columns.map(c => c.toLowerCase())).size !== v.columns.length ||
    typeof v.source !== "string" || !v.source.trim() || typeof v.observedAt !== "string" || !Number.isFinite(Date.parse(v.observedAt)))
    throw new Error("WRITE_COLUMNS_EVIDENCE_INVALID");
}
export function verifiedWriteColumns(value: unknown, query: string, target: unknown): TaskWriteColumnEvidence {
  validateWriteColumnEvidence(value);
  if (value.querySha256 !== evidenceHash(query) || value.targetIdentitySha256 !== targetIdentityHash(target))
    throw new Error("WRITE_COLUMNS_EVIDENCE_STALE");
  if (typeof value.runtimeTargetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.runtimeTargetSha256))
    throw new Error("WRITE_COLUMNS_RUNTIME_TARGET_NOT_PROVEN");
  return value;
}

// Compare SQL tokens, preserving quoted values; whitespace and comments do not
// change the query identity. Only the scheduler's plain data-date variables are
// rendered here. Unsupported variables fail closed.
function sqlTokens(sql: string): string {
  return (sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|--[^\r\n]*|\/\*[\s\S]*?\*\/|[a-z_][\w$]*|\d+(?:\.\d+)?|[^\s]/gi) ?? [])
    .filter(t => !t.startsWith("--") && !t.startsWith("/*"))
    .map(t => /^[a-z_]/i.test(t) ? t.toLowerCase() : t).join(" ").replace(/(?: ;)+$/, "");
}

function streamLoadColumns(log: string, target: Record<string, unknown>): string[][] {
  const property = (key: string): string => {
    const values = [...log.matchAll(/^\[INFO\] \[[^\r\n]+\] \[[^\r\n]+, AnyLoader\]\s+\$\{([^}]+)\}\s*=\s*([^\r\n]*)/gm)]
      .filter(m => m[1] === key).map(m => m[2]!.trim());
    if (!values.length || new Set(values).size !== 1) throw new Error("WRITE_COLUMNS_TARGET_NOT_MATCHED");
    return values[0]!;
  };
  const name = `${property("target.db.database")}.${property("target.db.table")}`;
  if (name.toLowerCase() !== String(target.qualifiedName).toLowerCase()) throw new Error("WRITE_COLUMNS_TARGET_NOT_MATCHED");
  return [...log.matchAll(/^\[[\d:\s-]+\]-\[INFO\]\s*Stream load 参数：([^\r\n]+)/gm)].map(m => {
    const properties = JSON.parse(m[1]!);
    if (typeof properties.columns !== "string") throw new Error("WRITE_COLUMNS_EVIDENCE_INVALID");
    return properties.columns.split(",").map((c: string) => c.trim().toLowerCase());
  });
}

// Loader-added literals consume no SELECT value. Only placeholders establish
// a source ordinal; arbitrary SQL expressions remain unsupported.
function placeholderColumns(columnList: string, valueList: string): string[] {
  const columns = columnList.split(",").map(c => c.trim().toLowerCase());
  if (columns.some(c => !/^[a-z_][a-z0-9_$]*$/i.test(c)) || new Set(columns).size !== columns.length)
    throw new Error("WRITE_COLUMNS_EVIDENCE_INVALID");
  const values = splitValues(valueList);
  const literal = (value: string) => /^(?:'(?:''|[^'])*'|null|[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(value);
  const generated = (value: string) => {
    if (/^(?:sysdate|current_date|current_timestamp)$/i.test(value)) return true;
    const call = value.match(/^[a-z_][\w$]*\(([\s\S]*)\)$/i);
    return call !== null && (!call[1]!.trim() || splitValues(call[1]!).every(literal));
  };
  if (values.some(value => value !== "?" && !literal(value) && !generated(value))) throw new Error("WRITE_COLUMNS_VALUES_NOT_POSITIONAL");
  if (values.length !== columns.length) throw new Error("WRITE_COLUMNS_VALUES_NOT_POSITIONAL");
  return columns.filter((_, index) => values[index] === "?");
}

function splitValues(text: string): string[] {
  const values: string[] = [];
  let start = 0, depth = 0, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "'") {
      if (quoted && text[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (char === "(") depth++;
      if (char === ")" && --depth < 0) throw new Error("WRITE_COLUMNS_VALUES_NOT_POSITIONAL");
      if (char === "," && depth === 0) { values.push(text.slice(start,i).trim()); start = i + 1; }
    }
  }
  if (quoted || depth !== 0) throw new Error("WRITE_COLUMNS_VALUES_NOT_POSITIONAL");
  values.push(text.slice(start).trim());
  return values;
}

function renderDataDate(query: string, dataDate: string): string {
  const original = new Date(`${dataDate}T00:00:00Z`);
  if (!Number.isFinite(original.valueOf()) || original.toISOString().slice(0, 10) !== dataDate)
    throw new Error("WRITE_COLUMNS_DATE_INVALID");
  return query.replace(/\$\{(yyyy-MM-dd|YYYY-MM-DD|yyyyMMdd|YYYYMMDD|yyyy-MM|yyyyMM|yyyy|MM|dd)(?:,\s*([+-]?\d+)\s*([dMy]))?\}/g,
    (full, format: string, count: string | undefined, unit: string | undefined) => {
      const offset = Number(count ?? 0);
      if (!Number.isSafeInteger(offset) || Math.abs(offset) > 36600) return full;
      const date = new Date(original);
      if (unit === "d") date.setUTCDate(date.getUTCDate() + offset);
      if (unit === "M" || unit === "y") {
        const day = date.getUTCDate();
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() + offset * (unit === "y" ? 12 : 1));
        const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        date.setUTCDate(Math.min(day, lastDay));
      }
      const iso = date.toISOString().slice(0, 10);
      return format.replace(/yyyy|YYYY|MM|dd|DD/g, token => token === "yyyy" || token === "YYYY" ? iso.slice(0, 4) : token === "MM" ? iso.slice(5, 7) : iso.slice(8, 10));
    });
}
export function writeColumnsFromSyncLog(input: {
  taskId: string; query: string; target: unknown; log: string; dataDate: string; observedAt: string; datasources: HoraeDatasourceIndex | undefined;
}): TaskWriteColumnEvidence {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dataDate)) throw new Error("WRITE_COLUMNS_DATE_INVALID");
  const rendered = renderDataDate(input.query, input.dataDate);
  if (/\$\{|#\{|\{\{/.test(rendered)) throw new Error("WRITE_COLUMNS_QUERY_TEMPLATE_UNSUPPORTED");
  const target = input.target as Record<string, unknown>;
  const streamLoad = target?.platform === "starrocks";
  const queryPattern = streamLoad
    ? /^\[[\d:\s-]+\]-\[INFO\]\s*Running sql with Hive:[^\r\n]*?\bstored\s+as\s+textfile\s+as\s+([\s\S]*?)(?=^\[[\d:\s-]+\]-\[|$(?![\s\S]))/gim
    : /^\[[\d:\s-]+\]-\[INFO\]\s*create temp table sql:[^\r\n]*?\bstored\s+as\s+textfile\s+as\s+([^\r\n]+)/gim;
  const records = [...input.log.matchAll(queryPattern)];
  const queries = records.map(m => sqlTokens(m[1]!));
  if (!queries.length || queries.some(q => q !== sqlTokens(rendered))) throw new Error("WRITE_COLUMNS_QUERY_NOT_MATCHED");
  const runtimeTargetSha256 = verifyRuntimeTargetIdentity(input.log, input.target, input.datasources);
  const stages = records.map(m => m[0].match(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([\w.]+)\s+stored\s+as\s+textfile/i)?.[1]?.split(".").at(-1));
  const readPath = loaderProperty(input.log, "hdfs.path").split(/[\\/]/);
  if (stages.some(stage => !stage || !readPath.includes(stage))) throw new Error("WRITE_COLUMNS_LOADER_STAGE_NOT_MATCHED");
  if (!streamLoad) {
    const loaderSql = loaderProperty(input.log, "hive.sql");
    const loaderQuery = loaderSql.match(/\bstored\s+as\s+textfile\s+as\s+([\s\S]+)/i)?.[1];
    if (!loaderQuery || sqlTokens(loaderQuery) !== sqlTokens(rendered)) throw new Error("WRITE_COLUMNS_LOADER_QUERY_NOT_MATCHED");
    const loaderInsert = loaderProperty(input.log, "insert.sql");
    const inserts = [...input.log.matchAll(/^\[[\d:\s-]+\]-\[INFO\]\s*insert\.sql:\s*([^\r\n]+)/gim)].map(m => sqlTokens(m[1]!));
    if (!inserts.length || inserts.some(sql => sql !== sqlTokens(loaderInsert))) throw new Error("WRITE_COLUMNS_LOADER_INSERT_NOT_MATCHED");
  }
  const identity = targetIdentityHash(target);
  const lists = streamLoad ? streamLoadColumns(input.log, target) : [...input.log.matchAll(/^\[[\d:\s-]+\]-\[INFO\][ \t]*insert\.sql:[ \t]*insert\s+into\s+([a-z_][\w$]*\.[a-z_][\w$]*)\s*\(([^)\r\n]+)\)\s*values[ \t]*\(([^\r\n]*)\)[ \t]*;?[ \t]*$/gim)]
    .filter(m => m[1]!.toLowerCase() === String(target.qualifiedName).toLowerCase())
    .map(m => placeholderColumns(m[2]!, m[3]!));
  if (!lists.length || lists.some(l => JSON.stringify(l) !== JSON.stringify(lists[0]))) throw new Error("WRITE_COLUMNS_INSERT_AMBIGUOUS");
  const result: TaskWriteColumnEvidence = {querySha256: evidenceHash(input.query), targetIdentitySha256: identity, columns: lists[0]!,
    sourceSha256: evidenceHash(input.log), source: `schedule-run-log:${input.taskId}:${input.dataDate}`, observedAt: input.observedAt, runtimeTargetSha256};
  validateWriteColumnEvidence(result);
  return result;
}
