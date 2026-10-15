import { redact } from "./redact.mjs";

// Small DDL lexer: quoted literals and nested type delimiters stay intact.
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    const start = i,
      quote = sql[i];
    if (["'", '"', "`", "["].includes(quote)) {
      const closing = quote === "[" ? "]" : quote;
      let value = "",
        closed = false;
      i++;
      while (i < sql.length) {
        if (sql[i] === closing) {
          if (sql[i + 1] === closing) {
            value += closing;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (sql[i] === "\\" && i + 1 < sql.length) {
          value += sql[i + 1];
          i += 2;
        } else value += sql[i++];
      }
      if (!closed) return null;
      tokens.push({
        value,
        kind: quote === "'" ? "string" : "identifier",
        start,
        end: i,
      });
    } else if (/[A-Za-z_\u0080-\uFFFF]/.test(sql[i])) {
      i++;
      while (i < sql.length && /[\w$\u0080-\uFFFF]/.test(sql[i])) i++;
      tokens.push({ value: sql.slice(start, i), kind: "word", start, end: i });
    } else {
      tokens.push({ value: sql[i++], kind: "symbol", start, end: i });
    }
  }
  return tokens;
}
const keyword = (token, value) =>
  token?.kind === "word" && token.value.toUpperCase() === value;
const identifier = (token) => ["word", "identifier"].includes(token?.kind);

function columnList(tokens, start, sql) {
  if (tokens[start]?.value !== "(") return null;
  let depth = 0,
    angle = 0,
    segmentStart = start + 1;
  const segments = [];
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "symbol") continue;
    if (token.value === "(") depth++;
    if (token.value === "<") angle++;
    if (token.value === ">") angle--;
    if (token.value === ")") {
      if (depth === 0) {
        if (segmentStart < i) segments.push(tokens.slice(segmentStart, i));
        return {
          fields: segments
            .map((segment) => parseColumn(segment, sql))
            .filter(Boolean),
          next: i + 1,
        };
      }
      depth--;
    }
    if (token.value === "," && depth === 0 && angle === 0) {
      segments.push(tokens.slice(segmentStart, i));
      segmentStart = i + 1;
    }
  }
  return null;
}

function parseColumn(tokens, sql) {
  if (
    !identifier(tokens[0]) ||
    !identifier(tokens[1]) ||
    ["CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK"].some((word) =>
      keyword(tokens[0], word),
    )
  )
    return null;
  let end = tokens.length,
    depth = 0,
    angle = 0,
    comment = "";
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      depth === 0 &&
      angle === 0 &&
      [
        "COMMENT",
        "NOT",
        "NULL",
        "DEFAULT",
        "PRIMARY",
        "REFERENCES",
        "CONSTRAINT",
        "UNIQUE",
        "CHECK",
        "GENERATED",
        "ENCODE",
      ].some((word) => keyword(token, word))
    ) {
      end = Math.min(end, i);
      if (keyword(token, "COMMENT") && tokens[i + 1]?.kind === "string")
        comment = tokens[i + 1].value;
    }
    if (token.kind !== "symbol") continue;
    if (token.value === "(") depth++;
    if (token.value === ")") depth--;
    if (token.value === "<") angle++;
    if (token.value === ">") angle--;
  }
  if (end <= 1) return null;
  return {
    name: tokens[0].value,
    type: redact(sql.slice(tokens[1].start, tokens[end - 1].end).trim()),
    comment: redact(comment),
  };
}

/** Extract explicit CREATE TABLE columns only; CTAS and view columns remain unknown. */
export function parseDefinition(input) {
  const sql = String(input ?? ""),
    tokens = tokenize(sql);
  const unknown = {
    objectType: "UNKNOWN",
    fields: [],
    description: "",
    parseStatus: "UNSUPPORTED",
  };
  if (!tokens) return { ...unknown, parseStatus: "INVALID" };
  let cursor = tokens.findIndex((token) => keyword(token, "CREATE"));
  if (cursor < 0) return unknown;
  cursor++;
  if (keyword(tokens[cursor], "OR") && keyword(tokens[cursor + 1], "REPLACE"))
    cursor += 2;
  while (
    ["EXTERNAL", "TEMP", "TEMPORARY", "MATERIALIZED"].some((word) =>
      keyword(tokens[cursor], word),
    )
  )
    cursor++;
  const objectType = keyword(tokens[cursor], "TABLE")
    ? "TABLE"
    : keyword(tokens[cursor], "VIEW")
      ? "VIEW"
      : "UNKNOWN";
  if (objectType === "UNKNOWN") return unknown;
  cursor++;
  if (
    keyword(tokens[cursor], "IF") &&
    keyword(tokens[cursor + 1], "NOT") &&
    keyword(tokens[cursor + 2], "EXISTS")
  )
    cursor += 3;
  if (!identifier(tokens[cursor]))
    return { ...unknown, objectType, parseStatus: "INVALID" };
  const names = [tokens[cursor++].value];
  while (tokens[cursor]?.value === "." && identifier(tokens[cursor + 1])) {
    names.push(tokens[cursor + 1].value);
    cursor += 2;
  }
  const result = { ...unknown, objectType, qualifiedName: names.join(".") };
  if (objectType !== "TABLE" || tokens[cursor]?.value !== "(") return result;
  const columns = columnList(tokens, cursor, sql);
  if (!columns) return { ...result, parseStatus: "INVALID" };
  const fields = [...columns.fields];
  cursor = columns.next;
  let description = "";
  for (let i = cursor; i < tokens.length && tokens[i].value !== ";"; i++) {
    if (keyword(tokens[i], "COMMENT")) {
      const next = tokens[i + 1]?.value === "=" ? tokens[i + 2] : tokens[i + 1];
      if (next?.kind === "string" && !description) description = next.value;
    }
    if (keyword(tokens[i], "PARTITIONED") && keyword(tokens[i + 1], "BY")) {
      const partition = columnList(tokens, i + 2, sql);
      if (!partition) return { ...result, parseStatus: "INVALID" };
      fields.push(
        ...partition.fields.map((field) => ({ ...field, partition: true })),
      );
      i = partition.next - 1;
    }
  }
  return {
    ...result,
    fields: fields.map((field, ordinal) => ({ ...field, ordinal })),
    description: redact(description),
    parseStatus: "PARSED",
  };
}
