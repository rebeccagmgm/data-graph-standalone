import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqlSession } from "sqllens";
import { sanitizeSqlForParser } from "../plans/parser-sql-input.ts";
import { temporalTemplateGranularity } from "./shared/temporal-template.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Values are exact textual substitutions, not evaluated expressions. */
export function convertSqlInput(sql: string, dialect: string, parameters: Record<string, string> = {}) {
  if (!["databricks", "tsql", "snowflake", "bigquery", "redshift", "postgres", "duckdb", "trino", "sqlite", "mysql"].includes(dialect)) {
    throw new Error("Unsupported parser dialect; use an explicit sqllens dialect (Hive tasks use databricks in the existing pipeline)");
  }
  for (const [key, value] of Object.entries(parameters)) {
    if (!/^\$\{[^{}\r\n]+\}$/.test(key) || typeof value !== "string") {
      throw new Error("Parameters must map exact ${name} tokens to strings");
    }
  }
  const parser = sanitizeSqlForParser(sql);
  const session = SqlSession.create(parser.sql, dialect as Parameters<typeof SqlSession.create>[1]);
  const replacements: Array<{ start: number; end: number; token: string; value: string; mapped: boolean; temporal: string | null }> = [];
  // Substitutions use source coordinates; replacements are never recursively evaluated.
  const convertedSql = sql.replace(/\$\{[^{}\r\n]+\}/g, (token, start: number) => {
    const mapped = Object.hasOwn(parameters, token);
    const value = mapped ? parameters[token]! : token;
    replacements.push({ start, end: start + token.length, token, value, mapped,
      temporal: temporalTemplateGranularity(token) ?? null });
    return value;
  });
  const convertedParser = sanitizeSqlForParser(convertedSql);
  const convertedSession = SqlSession.create(convertedParser.sql, dialect as Parameters<typeof SqlSession.create>[1]);
  const spans = session.doc.statements.map(cell => ({ start: cell.span.start, end: cell.span.end }));
  const translated = (offset: number) => offset + replacements.filter(r => r.end <= offset)
    .reduce((sum, r) => sum + r.value.length - (r.end - r.start), 0);
  const mappedSpans = spans.map(span => ({ start: translated(span.start), end: translated(span.end) }));
  const boundaryPreserved = mappedSpans.length === convertedSession.doc.statements.length && mappedSpans.every((span, i) => {
    const actual = convertedSession.doc.statements[i]!.span;
    return span.start === actual.start && span.end === actual.end;
  });
  const statements = session.doc.statements.map((cell, ordinal) => {
    const span = spans[ordinal]!;
    const rawSql = sql.slice(span.start, span.end);
    const significant = parser.sql.slice(span.start, span.end).replace(/^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, "");
    const keyword = significant.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? "";
    const role = keyword === "SET" || keyword === "USE" ? "CONFIGURATION"
      : ["SELECT", "WITH", "INSERT", "MERGE", "UPDATE", "DELETE"].includes(keyword) ? "QUERY_OR_WRITE"
      : ["CREATE", "ALTER", "DROP", "TRUNCATE"].includes(keyword) ? "DDL"
      : significant.replace(/;\s*$/, "").trim() === "" ? "EMPTY" : "UNSUPPORTED";
    const convertedCell = boundaryPreserved ? convertedSession.doc.statements[ordinal] : undefined;
    return { ordinal, span, convertedSpan: mappedSpans[ordinal], rawSql,
      convertedSql: convertedSql.slice(mappedSpans[ordinal]!.start, mappedSpans[ordinal]!.end),
      role, keyword, parserErrors: cell.errors, convertedParserErrors: convertedCell?.errors ?? null,
      diagnostics: cell.diagnostics, parameters: replacements.filter(r => r.start >= span.start && r.end <= span.end) };
  });
  const gaps = [
    ...(!boundaryPreserved ? ["PARAMETER_CHANGED_STATEMENT_BOUNDARIES"] : []),
    ...(statements.some(s => s.role === "UNSUPPORTED") ? ["UNSUPPORTED_STATEMENT"] : []),
    ...(statements.some(s => s.parserErrors || s.convertedParserErrors) ? ["PARSER_DIAGNOSTIC"] : []),
    ...(replacements.some(r => !r.mapped) ? ["SYMBOLIC_PARAMETERS_RETAINED"] : []),
  ];
  return { version: "sql-input-conversion-v1", dialect, sourceSha256: hash(sql), convertedSha256: hash(convertedSql),
    status: gaps.length ? "PARTIAL" : "CONVERTED", boundaryPreserved, gaps,
    sourceSql: sql, convertedSql, parameters, replacements, statements };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node --experimental-strip-types scripts/input/convert-sql-input.ts --sql FILE --dialect DIALECT --out NEW.json [--parameters MAP.json]");
  } else {
    const options: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!["--sql", "--dialect", "--out", "--parameters"].includes(args[i]!) || !args[i + 1] || options[args[i]!]) throw new Error("Invalid CLI arguments");
      options[args[i]!] = args[i + 1]!;
    }
    if (!options["--sql"] || !options["--dialect"] || !options["--out"]) throw new Error("--sql, --dialect and --out are required");
    const parameters = options["--parameters"] ? JSON.parse(readFileSync(options["--parameters"], "utf8")) : {};
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("Invalid parameter map");
    const result = convertSqlInput(readFileSync(options["--sql"], "utf8"), options["--dialect"], parameters);
    writeFileSync(options["--out"], JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ status: result.status, statements: result.statements.length, gaps: result.gaps, output: resolve(options["--out"]) }));
  }
}
