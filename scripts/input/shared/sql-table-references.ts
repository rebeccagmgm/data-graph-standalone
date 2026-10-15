const SQL_IDENTIFIER = String.raw`(?:[A-Za-z_][A-Za-z0-9_$]*|\x60[^\x60]+\x60|"[^"]+")`;
const SQL_QUALIFIED_IDENTIFIER = String.raw`${SQL_IDENTIFIER}(?:\s*\.\s*${SQL_IDENTIFIER})+`;

function maskSqlCommentsAndLiterals(sql: string): string {
  const characters = [...sql];
  let quote: "'" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index];
    const next = characters[index + 1];
    if (lineComment) {
      if (current === "\n" || current === "\r") lineComment = false;
      else characters[index] = " ";
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        characters[index] = " ";
        characters[index + 1] = " ";
        index += 1;
        blockComment = false;
      } else if (current !== "\n" && current !== "\r") characters[index] = " ";
      continue;
    }
    if (quote !== null) {
      if (current === quote && next === quote) {
        characters[index] = " ";
        characters[index + 1] = " ";
        index += 1;
      } else if (current === quote) {
        characters[index] = " ";
        quote = null;
      } else if (current !== "\n" && current !== "\r") characters[index] = " ";
      continue;
    }
    if (current === "-" && next === "-") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
      lineComment = true;
    } else if (current === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 1;
      blockComment = true;
    } else if (current === "'") {
      characters[index] = " ";
      quote = "'";
    }
  }
  return characters.join("");
}

function normalizeIdentifier(value: string): string {
  return value
    .replaceAll("`", "")
    .replaceAll('"', "")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * Extract physical-looking relations from SQL read clauses. This is only an
 * Input Pack discovery pass: SQL semantics and field lineage remain owned by
 * Machine Facts. Comments and string literals are masked so a source label or
 * example SQL cannot become a table request.
 */
export function extractSqlReadTableNames(sql: string): readonly string[] {
  const masked = maskSqlCommentsAndLiterals(sql);
  const cteNames = new Set<string>();
  const ctePattern = new RegExp(
    String.raw`\b(${SQL_IDENTIFIER})\s+AS\s*\(`,
    "gi",
  );
  for (const match of masked.matchAll(ctePattern)) {
    if (match[1]) cteNames.add(normalizeIdentifier(match[1]).toLowerCase());
  }

  const readPattern = new RegExp(
    String.raw`\b(?:FROM|JOIN)\s+(${SQL_QUALIFIED_IDENTIFIER})`,
    "gi",
  );
  const names = new Set<string>();
  for (const match of masked.matchAll(readPattern)) {
    const name = normalizeIdentifier(match[1] ?? "");
    if (!name || cteNames.has(name.toLowerCase())) continue;
    names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

const SQL_IDENT = String.raw`(?:[A-Za-z_][A-Za-z0-9_$]*|\x60[^\x60]+\x60|"[^"]+")`;
const FROM_JOIN_RESERVED = new Set([
  "on",
  "where",
  "join",
  "left",
  "right",
  "full",
  "inner",
  "outer",
  "cross",
  "natural",
  "using",
  "group",
  "order",
  "having",
  "union",
  "minus",
  "intersect",
  "start",
  "connect",
  "limit",
  "qualify",
  "window",
  "as",
]);

export interface QuerySelectItem {
  readonly outputName: string;
  readonly sourceColumn?: string;
  readonly sourceQualifier?: string;
}

function unquoteIdent(value: string): string {
  return normalizeIdentifier(value);
}

function parenDepthAt(
  sql: string,
  index: number,
  depth: number,
): number {
  const current = sql[index];
  if (current === "(") return depth + 1;
  if (current === ")") return depth > 0 ? depth - 1 : 0;
  return depth;
}

function findTopLevelKeyword(
  sql: string,
  keyword: RegExp,
  start = 0,
): number {
  let depth = 0;
  for (let index = start; index < sql.length; index += 1) {
    depth = parenDepthAt(sql, index, depth);
    if (depth !== 0) continue;
    keyword.lastIndex = index;
    const match = keyword.exec(sql);
    if (match?.index === index) return index;
  }
  return -1;
}

function topLevelSelectAndFrom(
  masked: string,
): { readonly selectList: string; readonly fromClause: string } | undefined {
  const selectAt = findTopLevelKeyword(masked, /\bSELECT\b/gi);
  if (selectAt < 0) return undefined;
  let listStart = selectAt + "SELECT".length;
  const prefix = masked.slice(listStart).match(/^\s+(?:ALL|DISTINCT)\b/i);
  if (prefix) listStart += prefix[0].length;
  const fromAt = findTopLevelKeyword(masked, /\bFROM\b/gi, listStart);
  if (fromAt < 0) return undefined;
  const fromEnd = findTopLevelKeyword(
    masked,
    /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|UNION|MINUS|INTERSECT|QUALIFY|LIMIT|;)\b/gi,
    fromAt + 4,
  );
  return {
    selectList: masked.slice(listStart, fromAt),
    fromClause: masked.slice(fromAt, fromEnd < 0 ? masked.length : fromEnd),
  };
}

function splitTopLevelComma(sql: string): readonly string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index]!;
    if (current === "(") depth += 1;
    else if (current === ")") depth = depth > 0 ? depth - 1 : 0;
    else if (current === "," && depth === 0) {
      items.push(sql.slice(start, index));
      start = index + 1;
    }
  }
  items.push(sql.slice(start));
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

function parseSimpleColumn(
  expr: string,
): { readonly column: string; readonly qualifier?: string } | undefined {
  const trimmed = expr.trim();
  const pattern = new RegExp(
    String.raw`^((?:${SQL_IDENT}\s*\.\s*)*)(${SQL_IDENT})$`,
    "u",
  );
  const match = trimmed.match(pattern);
  if (match?.[2] === undefined) return undefined;
  const column = unquoteIdent(match[2]);
  if (column === "" || column === "*") return undefined;
  const rawPrefix = (match[1] ?? "").replace(/\s+/g, "");
  if (rawPrefix === "") return { column };
  const parts = rawPrefix
    .split(".")
    .filter((part) => part !== "")
    .map(unquoteIdent);
  return { column, qualifier: parts.at(-1) };
}

const UNWRAP_FUNCS = new Set([
  "trim",
  "upper",
  "lower",
  "nvl",
  "coalesce",
  "to_char",
  "to_date",
  "substr",
  "ltrim",
  "rtrim",
]);

function matchingParenClose(sql: string, open: number): number {
  if (sql[open] !== "(") return -1;
  let depth = 0;
  for (let index = open; index < sql.length; index += 1) {
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function unwrapFunctionColumn(
  expr: string,
): { readonly column: string; readonly qualifier?: string } | undefined {
  const trimmed = expr.trim();
  const header = trimmed.match(new RegExp(String.raw`^(${SQL_IDENT})\s*\(`, "u"));
  if (header?.[1] === undefined) return undefined;
  if (!UNWRAP_FUNCS.has(unquoteIdent(header[1]).toLowerCase())) return undefined;
  const open = trimmed.indexOf("(");
  const close = matchingParenClose(trimmed, open);
  if (close < 0) return undefined;
  const firstArg = splitTopLevelComma(trimmed.slice(open + 1, close))[0];
  return firstArg === undefined ? undefined : parseSimpleColumn(firstArg);
}

function parseSelectItem(item: string): QuerySelectItem | undefined {
  const trimmed = item.trim();
  if (trimmed === "" || trimmed === "*" || /\.\s*\*$/u.test(trimmed))
    return undefined;
  const asMatch = trimmed.match(
    new RegExp(String.raw`\bAS\s+(${SQL_IDENT})\s*$`, "iu"),
  );
  if (asMatch?.[1] !== undefined && asMatch.index !== undefined) {
    const outputName = unquoteIdent(asMatch[1]);
    if (outputName === "") return undefined;
    const expr = trimmed.slice(0, asMatch.index).trim();
    const simple = parseSimpleColumn(expr) ?? unwrapFunctionColumn(expr);
    return {
      outputName,
      sourceColumn: simple?.column,
      sourceQualifier: simple?.qualifier,
    };
  }
  const simple = parseSimpleColumn(trimmed) ?? unwrapFunctionColumn(trimmed);
  if (simple !== undefined)
    return {
      outputName: simple.column,
      sourceColumn: simple.column,
      sourceQualifier: simple.qualifier,
    };
  const trailing = trimmed.match(new RegExp(String.raw`\s+(${SQL_IDENT})\s*$`, "u"));
  if (trailing?.[1] === undefined) return undefined;
  const outputName = unquoteIdent(trailing[1]);
  if (outputName === "" || FROM_JOIN_RESERVED.has(outputName.toLowerCase()))
    return undefined;
  const expr = trimmed.slice(0, trimmed.length - trailing[0].length).trim();
  if (expr === "" || parseSimpleColumn(trimmed) !== undefined) return undefined;
  return { outputName };
}

export function extractQuerySelectItems(sql: string): readonly QuerySelectItem[] {
  const parts = topLevelSelectAndFrom(maskSqlCommentsAndLiterals(sql));
  if (parts === undefined) return [];
  const items: QuerySelectItem[] = [];
  const seen = new Set<string>();
  for (const raw of splitTopLevelComma(parts.selectList)) {
    const item = parseSelectItem(raw);
    if (item === undefined) continue;
    const key = item.outputName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

export function queryOutputColumnNames(sql: string): readonly string[] {
  return extractQuerySelectItems(sql).map((item) => item.outputName);
}

interface FromJoinSource {
  readonly qualifiedName: string;
  readonly aliases: readonly string[];
}

function parseFromJoinSources(fromClause: string): readonly FromJoinSource[] {
  const sources: FromJoinSource[] = [];
  const pattern = new RegExp(
    String.raw`\b(?:FROM|JOIN)\s+(${SQL_QUALIFIED_IDENTIFIER})(?:\s+(?:AS\s+)?(${SQL_IDENT}))?`,
    "gi",
  );
  for (const match of fromClause.matchAll(pattern)) {
    const qualifiedName = normalizeIdentifier(match[1] ?? "");
    if (!qualifiedName) continue;
    const aliases = new Set<string>([
      qualifiedName.toLowerCase(),
      qualifiedName.split(".").at(-1)!.toLowerCase(),
    ]);
    const rawAlias = match[2];
    if (rawAlias !== undefined) {
      const alias = unquoteIdent(rawAlias);
      if (alias !== "" && !FROM_JOIN_RESERVED.has(alias.toLowerCase()))
        aliases.add(alias.toLowerCase());
    }
    sources.push({ qualifiedName, aliases: [...aliases] });
  }
  return sources;
}

function sourceMatches(
  source: FromJoinSource,
  qualifiedName: string,
): boolean {
  return source.qualifiedName.toLowerCase() === qualifiedName.toLowerCase();
}

function fromClauseHasTopLevelComma(fromClause: string): boolean {
  let depth = 0;
  for (const current of fromClause) {
    if (current === "(") depth += 1;
    else if (current === ")") depth = depth > 0 ? depth - 1 : 0;
    else if (current === "," && depth === 0) return true;
  }
  return false;
}

export function uniqueQueryFromQualifiedName(sql: string): string | undefined {
  const parts = topLevelSelectAndFrom(maskSqlCommentsAndLiterals(sql));
  if (parts === undefined) return undefined;
  const sources = parseFromJoinSources(parts.fromClause);
  if (sources.length !== 1 || fromClauseHasTopLevelComma(parts.fromClause))
    return undefined;
  return sources[0]?.qualifiedName;
}

/** Exact `SELECT *` from one physical table. Not `t.*`, joins, or a column list. */
export function isSoleStarSelectQuery(sql: string): boolean {
  const masked = maskSqlCommentsAndLiterals(sql);
  const parts = topLevelSelectAndFrom(masked);
  if (parts === undefined) return false;
  if (parts.selectList.trim() !== "*") return false;
  return uniqueQueryFromQualifiedName(sql) !== undefined;
}

export function queryProjectionColumnNames(
  sql: string,
  qualifiedName: string,
): readonly string[] {
  const masked = maskSqlCommentsAndLiterals(sql);
  const parts = topLevelSelectAndFrom(masked);
  if (parts === undefined) return [];
  const sources = parseFromJoinSources(parts.fromClause).filter((source) =>
    sourceMatches(source, qualifiedName),
  );
  if (sources.length === 0) return [];
  const aliases = new Set(
    sources.flatMap((source) => source.aliases.map((alias) => alias.toLowerCase())),
  );
  const singleSource =
    parseFromJoinSources(parts.fromClause).length === 1 && sources.length === 1;
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const item of extractQuerySelectItems(sql)) {
    if (item.sourceColumn === undefined) continue;
    const qualifier = item.sourceQualifier?.toLowerCase();
    const belongs =
      (qualifier !== undefined && aliases.has(qualifier)) ||
      (qualifier === undefined && singleSource);
    if (!belongs) continue;
    const key = item.sourceColumn.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    columns.push(item.sourceColumn);
  }
  return columns;
}

export function columnNamesFromCreateTable(ddl: string): readonly string[] {
  const masked = maskSqlCommentsAndLiterals(ddl);
  const header = masked.match(
    /\bCREATE\s+(?:(?:OR\s+REPLACE)\s+)?(?:(?:TEMPORARY|EXTERNAL)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/iu,
  );
  if (header?.index === undefined) return [];
  let index = header.index + header[0].length;
  while (index < masked.length && /\s/u.test(masked[index]!)) index += 1;
  while (index < masked.length && masked[index] !== "(") {
    if (masked[index] === "'") break;
    index += 1;
  }
  if (masked[index] !== "(") return [];
  let depth = 0;
  const closeAt = (() => {
    for (let cursor = index; cursor < masked.length; cursor += 1) {
      if (masked[cursor] === "(") depth += 1;
      else if (masked[cursor] === ")") {
        depth -= 1;
        if (depth === 0) return cursor;
      }
    }
    return -1;
  })();
  if (closeAt < 0) return [];
  const inner = masked.slice(index + 1, closeAt);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of splitTopLevelComma(inner)) {
    const match = raw.trim().match(new RegExp(String.raw`^(${SQL_IDENT})`, "u"));
    if (match?.[1] === undefined) continue;
    const name = unquoteIdent(match[1]);
    if (name === "" || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}
