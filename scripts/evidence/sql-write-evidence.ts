export interface PartitionAssignment {
  readonly field: string;
  readonly expression: string;
  readonly valueStatus:
    | "OBSERVED_RENDERED_VALUE"
    | "RUNTIME_EXPRESSION"
    | "UNKNOWN";
  readonly observedValue: string | null;
}

export function partitionValueStatus(
  status: string,
): PartitionAssignment["valueStatus"] {
  if (status === "CONFIRMED") return "OBSERVED_RENDERED_VALUE";
  if (status === "RUNTIME_EXPRESSION") return "RUNTIME_EXPRESSION";
  return "UNKNOWN";
}

export interface SqlWrite {
  readonly qualifiedName: string;
  readonly writeKind:
    "INSERT_OVERWRITE" | "INSERT_INTO" | "MERGE_INTO" | "CTAS";
  readonly statementSpan: { readonly start: number; readonly end: number };
  /** One-based write order within the SQL slot. */
  readonly statementOrdinal: number;
  readonly partitionMode: "NONE" | "STATIC" | "DYNAMIC" | "MIXED" | "UNKNOWN";
  readonly partitionFields: readonly string[];
  readonly partition: readonly PartitionAssignment[];
}

function normalizeTable(value: string): string {
  return value.replaceAll("`", "").replaceAll('"', "").trim().toLowerCase();
}

function splitTopLevelComma(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result.map((item) => item.trim()).filter(Boolean);
}

export function partitionAssignments(
  value: string | null,
): PartitionAssignment[] {
  if (!value) return [];
  return splitTopLevelComma(value).map((assignment) => {
    const equals = assignment.indexOf("=");
    const field = (equals >= 0 ? assignment.slice(0, equals) : assignment)
      .trim()
      .replaceAll("`", "")
      .toLowerCase();
    const expression = (
      equals >= 0 ? assignment.slice(equals + 1) : "UNKNOWN"
    ).trim();
    const literal =
      expression.match(/^'(.*)'$/s)?.[1] ??
      expression.match(/^"(.*)"$/s)?.[1] ??
      (/^(?:[-+]?\d+(?:\.\d+)?|true|false|null)$/i.test(expression)
        ? expression
        : null);
    return {
      field,
      expression,
      valueStatus:
        equals < 0 ? "UNKNOWN" : literal === null ? "RUNTIME_EXPRESSION" : "OBSERVED_RENDERED_VALUE",
      observedValue: literal,
    };
  });
}

function partitionShape(value: string | null): {
  readonly mode: SqlWrite["partitionMode"];
  readonly fields: readonly string[];
} {
  if (!value) return { mode: "NONE", fields: [] };
  const fields = splitTopLevelComma(value).map((assignment) => {
    const equals = assignment.indexOf("=");
    return (equals >= 0 ? assignment.slice(0, equals) : assignment)
      .trim()
      .replaceAll("`", "")
      .toLowerCase();
  });
  const hasStatic = splitTopLevelComma(value).some((item) => item.includes("="));
  const hasDynamic = splitTopLevelComma(value).some((item) => !item.includes("="));
  return {
    mode: hasStatic && hasDynamic ? "MIXED" : hasStatic ? "STATIC" : "DYNAMIC",
    fields,
  };
}

function balancedParenthesized(
  sql: string,
  openingIndex: number,
): { content: string; end: number } | null {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let index = openingIndex; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote) {
      if (character === quote && sql[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0)
        return { content: sql.slice(openingIndex + 1, index), end: index + 1 };
    }
  }
  return null;
}

function maskSqlCommentsAndStrings(sql: string): string {
  // SQL spans and String#slice use UTF-16 offsets, not Unicode code points.
  const masked = sql.split("");
  let state: "CODE" | "LINE_COMMENT" | "BLOCK_COMMENT" = "CODE";
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (quote) {
      // Keep quoted identifiers matchable while hiding keywords and separators.
      // The original target name is recovered from the same source offsets.
      const replacement = quote === "'" ? " " : "_";
      if (character !== "\n" && character !== "\r") masked[index] = replacement;
      if (character === "\\" && index + 1 < sql.length) {
        if (next !== "\n" && next !== "\r") masked[index + 1] = replacement;
        index += 1;
      } else if (character === quote && next === quote) {
        masked[index + 1] = replacement;
        index += 1;
      } else if (character === quote) {
        masked[index] = quote === "'" ? " " : quote;
        quote = null;
      }
      continue;
    }
    if (state === "LINE_COMMENT") {
      if (character === "\n" || character === "\r") state = "CODE";
      else masked[index] = " ";
      continue;
    }
    if (state === "BLOCK_COMMENT") {
      if (character === "*" && next === "/") {
        masked[index] = " ";
        masked[index + 1] = " ";
        index += 1;
        state = "CODE";
      } else if (character !== "\n" && character !== "\r") masked[index] = " ";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      masked[index] = character === "'" ? " " : character;
      quote = character;
    } else if (character === "-" && next === "-") {
      masked[index] = " ";
      masked[index + 1] = " ";
      index += 1;
      state = "LINE_COMMENT";
    } else if (character === "/" && next === "*") {
      masked[index] = " ";
      masked[index + 1] = " ";
      index += 1;
      state = "BLOCK_COMMENT";
    }
  }
  return masked.join("");
}

export function extractSqlWrites(sql: string): SqlWrite[] {
  const maskedSql = maskSqlCommentsAndStrings(sql);
  const pattern =
    /\b(INSERT\s+(OVERWRITE|INTO)\s+(?:TABLE\s+)?(?!DIRECTORY\b)|MERGE\s+INTO\s+)([`"A-Za-z0-9_.-]+)/gi;
  const writes: SqlWrite[] = [];
  for (const match of maskedSql.matchAll(pattern)) {
    const start = match.index ?? 0;
    const afterTarget = start + match[0].length;
    const qualifiedName = normalizeTable(sql.slice(start + match[1]!.length, afterTarget));
    const matchedText = match[1]!.toUpperCase();
    const writeKind = matchedText.startsWith("MERGE")
      ? "MERGE_INTO"
      : match[2]!.toUpperCase() === "OVERWRITE"
        ? "INSERT_OVERWRITE"
        : "INSERT_INTO";
    const tail = maskedSql.slice(afterTarget);
    const partitionMatch = tail.match(/^\s*PARTITION\s*\(/i);
    const openingIndex = partitionMatch
      ? afterTarget + partitionMatch[0].lastIndexOf("(")
      : -1;
    const partition =
      openingIndex >= 0 ? balancedParenthesized(sql, openingIndex) : null;
    const partitionContent = partition?.content ?? null;
    const shape = partitionShape(partitionContent);
    const statementEnd = maskedSql.indexOf(";", partition?.end ?? afterTarget);
    writes.push({
      qualifiedName,
      writeKind,
      statementSpan: {
        start,
        end: statementEnd >= 0 ? statementEnd : sql.length,
      },
      statementOrdinal: 0,
      partitionMode: shape.mode,
      partitionFields: shape.fields,
      partition: partitionAssignments(partitionContent),
    });
  }
  const ctasPattern =
    /\b(CREATE\s+(?:(?:OR\s+REPLACE|EXTERNAL|TEMPORARY|TEMP)\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)([`"A-Za-z0-9_.-]+)\s+AS\s+(?=SELECT\b|WITH\b)/gi;
  for (const match of maskedSql.matchAll(ctasPattern)) {
    const start = match.index ?? 0;
    const targetStart = start + match[1]!.length;
    const statementEnd = maskedSql.indexOf(";", start + match[0].length);
    writes.push({
      qualifiedName: normalizeTable(sql.slice(targetStart, targetStart + match[2]!.length)),
      writeKind: "CTAS",
      statementSpan: {
        start,
        end: statementEnd >= 0 ? statementEnd : sql.length,
      },
      statementOrdinal: 0,
      partitionMode: "NONE",
      partitionFields: [],
      partition: [],
    });
  }
  return writes
    .sort(
    (left, right) => left.statementSpan.start - right.statementSpan.start,
    )
    .map((write, index) => ({ ...write, statementOrdinal: index + 1 }));
}
