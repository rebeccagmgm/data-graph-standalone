export type SqlTargetSlot =
  "create" | "query" | "prepare" | "truncate" | "finish";

export interface SqlTargetEvidence {
  readonly qualifiedName: string;
  readonly slot: SqlTargetSlot;
  readonly statementKind:
    | "CREATE_TABLE"
    | "INSERT_TABLE"
    | "TRUNCATE_TABLE"
    | "DELETE_TABLE";
  /** Offset of the target token in its SQL slot, used only for local ordering. */
  readonly targetStart?: number;
  readonly targetEnd?: number;
}

export type SqlWriteStatementKind =
  | SqlTargetEvidence["statementKind"]
  | "ALTER_TABLE";

export interface SqlWriteTargetEvidence
  extends Omit<SqlTargetEvidence, "statementKind"> {
  readonly statementKind: SqlWriteStatementKind;
}

const TARGET_PATTERNS: readonly {
  readonly statementKind: SqlTargetEvidence["statementKind"];
  readonly pattern: RegExp;
}[] = [
  {
    statementKind: "INSERT_TABLE",
    pattern:
      /\binsert\s+(?:overwrite|into)\s+(?:table\s+)?((?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*))?)/gi,
  },
  {
    statementKind: "CREATE_TABLE",
    pattern:
      /\bcreate\s+(?:(?:or\s+replace)\s+)?(?:(?:external|temporary)\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*))?)/gi,
  },
  {
    statementKind: "TRUNCATE_TABLE",
    pattern:
      /\btruncate\s+table\s+((?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*))?)/gi,
  },
  {
    statementKind: "DELETE_TABLE",
    pattern:
      /\bdelete\s+from\s+((?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*))?)/gi,
  },
];

const WRITE_TARGET_PATTERNS: readonly {
  readonly statementKind: SqlWriteStatementKind;
  readonly pattern: RegExp;
}[] = [
  ...TARGET_PATTERNS,
  {
    statementKind: "ALTER_TABLE",
    pattern:
      /\balter\s+table\s+((?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*)(?:\s*\.\s*(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#-]*))?)/gi,
  },
];

function maskCommentsAndStringLiterals(sql: string): string {
  const output = [...sql];
  let state: "normal" | "singleQuote" | "lineComment" | "blockComment" =
    "normal";
  for (let index = 0; index < output.length; index += 1) {
    const current = sql[index]!;
    const next = sql[index + 1];
    if (state === "normal") {
      if (current === "'") {
        output[index] = " ";
        state = "singleQuote";
      } else if (current === "-" && next === "-") {
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
        state = "lineComment";
      } else if (current === "/" && next === "*") {
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
        state = "blockComment";
      }
      continue;
    }
    if (state === "singleQuote") {
      if (current === "\n" || current === "\r") {
        continue;
      }
      output[index] = " ";
      if (current === "\\" && index + 1 < output.length) {
        output[index + 1] = " ";
        index += 1;
      } else if (current === "'" && next === "'") {
        output[index + 1] = " ";
        index += 1;
      } else if (current === "'") {
        state = "normal";
      }
      continue;
    }
    if (state === "lineComment") {
      if (current === "\n" || current === "\r") state = "normal";
      else output[index] = " ";
      continue;
    }
    if (current === "*" && next === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 1;
      state = "normal";
    } else if (current !== "\n" && current !== "\r") {
      output[index] = " ";
    }
  }
  return output.join("");
}

function normalizeQualifiedName(token: string): string | undefined {
  const parts = token
    .split(".")
    .map((part) => part.trim().replace(/^([`"])(.*)\1$/, "$2"));
  if (parts.some((part) => part === "" || part.includes("@"))) return undefined;
  if (parts.length !== 1 && parts.length !== 2) return undefined;
  // CREATE TABLE IF NOT EXISTS ${DB}.t → false capture "IF" + schema qualify
  const reserved = new Set([
    "if",
    "exists",
    "not",
    "table",
    "set",
    "values",
    "select",
    "from",
    "join",
    "where",
    "and",
    "or",
    "as",
    "on",
    "into",
    "overwrite",
    "partition",
    "by",
    "drop",
    "create",
    "alter",
    "insert",
    "update",
    "delete",
    "with",
    "using",
    "true",
    "false",
    "null",
  ]);
  if (parts.some((part) => reserved.has(part.toLowerCase()))) return undefined;
  return parts.join(".");
}

function taskNameBaseTable(taskName: string): string | undefined {
  const separator = taskName.indexOf(".");
  if (separator <= 0 || separator === taskName.length - 1) return undefined;
  const schema = taskName.slice(0, separator).trim();
  const table = taskName
    .slice(separator + 1)
    .trim()
    .replace(/_TIT\d+(?:_h\d+)?$/i, "");
  return schema !== "" && table !== "" ? `${schema}.${table}` : undefined;
}

function qualifyUnqualifiedTarget(
  target: string,
  taskName: string | undefined,
  allowSchemaOnlyQualification: boolean,
): string | undefined {
  if (target.includes(".")) return target;
  if (taskName === undefined) return undefined;
  const taskTable = taskNameBaseTable(taskName);
  if (taskTable === undefined) return undefined;
  const separator = taskTable.indexOf(".");
  const taskTableName = taskTable.slice(separator + 1);
  const normalizedTarget = target.toLowerCase();
  const normalizedTaskTable = taskTableName.toLowerCase();
  if (normalizedTaskTable !== normalizedTarget && !allowSchemaOnlyQualification)
    return undefined;
  return `${taskTable.slice(0, separator)}.${target}`;
}

function collectSqlTargetEvidenceWithPatterns(
  sql: Readonly<Partial<Record<SqlTargetSlot, string>>>,
  taskName: string | undefined,
  options: Readonly<{ allowSchemaOnlyQualification?: boolean }>,
  patterns: readonly {
    readonly statementKind: SqlWriteStatementKind;
    readonly pattern: RegExp;
  }[] = TARGET_PATTERNS,
): SqlWriteTargetEvidence[] {
  const found: SqlWriteTargetEvidence[] = [];
  for (const slot of [
    "create",
    "query",
    "prepare",
    "truncate",
    "finish",
  ] as const) {
    const content = sql[slot];
    if (typeof content !== "string" || content.trim() === "") continue;
    const withoutComments = maskCommentsAndStringLiterals(content);
    for (const { statementKind, pattern } of patterns) {
      pattern.lastIndex = 0;
      for (const match of withoutComments.matchAll(pattern)) {
        const rawTarget = match[1]!;
        const parsed = normalizeQualifiedName(rawTarget);
        if (parsed === undefined) continue;
        const qualifiedName = qualifyUnqualifiedTarget(
          parsed,
          taskName,
          options.allowSchemaOnlyQualification === true,
        );
        if (qualifiedName === undefined) continue;
        const matchStart = match.index ?? 0;
        const targetStart = matchStart + match[0].indexOf(rawTarget);
        found.push({
          qualifiedName,
          slot,
          statementKind,
          targetStart,
          targetEnd: targetStart + rawTarget.length,
        });
      }
    }
  }
  return found;
}

function collectSqlTargetEvidence(
  sql: Readonly<Partial<Record<SqlTargetSlot, string>>>,
  taskName: string | undefined,
  options: Readonly<{ allowSchemaOnlyQualification?: boolean }>,
): SqlTargetEvidence[] {
  return collectSqlTargetEvidenceWithPatterns(
    sql,
    taskName,
    options,
    TARGET_PATTERNS,
  ) as SqlTargetEvidence[];
}

const SQL_SLOT_ORDER: readonly SqlTargetSlot[] = [
  "create",
  "query",
  "prepare",
  "truncate",
  "finish",
];

function slotOrder(slot: SqlTargetSlot): number {
  return SQL_SLOT_ORDER.indexOf(slot);
}

function evidencePosition(evidence: SqlTargetEvidence): [number, number] {
  return [slotOrder(evidence.slot), evidence.targetStart ?? -1];
}

function isAfter(
  candidate: SqlTargetEvidence,
  other: SqlTargetEvidence,
): boolean {
  const [candidateSlot, candidateOffset] = evidencePosition(candidate);
  const [otherSlot, otherOffset] = evidencePosition(other);
  return (
    candidateSlot > otherSlot ||
    (candidateSlot === otherSlot && candidateOffset > otherOffset)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function targetReferencePattern(qualifiedName: string): RegExp {
  const parts = qualifiedName.split(".");
  const qualified = parts
    .map((part) => escapeRegExp(part))
    .join("\\s*\\.\\s*");
  const leaf = escapeRegExp(parts[parts.length - 1]!);
  return new RegExp(
    `(?:^|[^A-Za-z0-9_$#-])(?:${qualified}|${leaf})(?![A-Za-z0-9_$#-])`,
    "i",
  );
}

/**
 * A write is terminal only when its target is not referenced by a later SQL
 * statement in the same task. Comments and string literals are masked before
 * this check, so a log message or embedded example cannot keep a target alive.
 */
function isReferencedLaterInTask(
  evidence: SqlTargetEvidence,
  sql: Readonly<Partial<Record<SqlTargetSlot, string>>>,
): boolean {
  const pattern = targetReferencePattern(evidence.qualifiedName);
  for (const slot of SQL_SLOT_ORDER) {
    if (slotOrder(slot) < slotOrder(evidence.slot)) continue;
    const content = sql[slot];
    if (typeof content !== "string" || content.trim() === "") continue;
    const masked = maskCommentsAndStringLiterals(content);
    const laterContent =
      slot === evidence.slot
        ? masked.slice(masked.indexOf(";", evidence.targetEnd ?? 0) + 1)
        : masked;
    if (slot === evidence.slot && !masked.includes(";", evidence.targetEnd ?? 0))
      continue;
    if (pattern.test(laterContent)) return true;
  }
  return false;
}

function uniqueSqlTargetEvidence(
  found: readonly SqlTargetEvidence[],
): SqlTargetEvidence[] | undefined {
  const unique = new Map<string, SqlTargetEvidence>();
  for (const evidence of found) {
    const key = evidence.qualifiedName.toLowerCase();
    const existing = unique.get(key);
    if (existing === undefined) unique.set(key, evidence);
    else if (existing.qualifiedName !== evidence.qualifiedName) return undefined;
  }
  return [...unique.values()];
}

/**
 * Finds an unambiguous SQL-declared table target. This is deliberately limited
 * to structural write/DDL clauses; ordinary table mentions and task names do
 * not create evidence by themselves.
 */
export function findSqlTargetEvidence(
  sql: Readonly<Partial<Record<SqlTargetSlot, string>>>,
  taskName?: string,
  options: Readonly<{ allowSchemaOnlyQualification?: boolean }> = {},
): SqlTargetEvidence | undefined {
  const unique = uniqueSqlTargetEvidence(
    collectSqlTargetEvidence(sql, taskName, options),
  );
  return unique?.length === 1 ? unique[0] : undefined;
}

/**
 * Finds the final DML target in a task whose SQL also materializes temporary
 * tables. A task-name match is only used to choose among INSERT targets; the
 * caller must still obtain physical Table evidence before publishing it.
 */
export function findSqlFinalTargetEvidence(
  sql: Readonly<Partial<Record<SqlTargetSlot, string>>>,
  taskName?: string,
  options: Readonly<{ allowSchemaOnlyQualification?: boolean }> = {},
): SqlTargetEvidence | undefined {
  const allEvidence = collectSqlTargetEvidence(sql, taskName, options);
  const byName = new Map<string, SqlTargetEvidence>();
  for (const evidence of allEvidence) {
    const key = evidence.qualifiedName.toLowerCase();
    const existing = byName.get(key);
    if (
      existing === undefined ||
      (existing.statementKind !== "INSERT_TABLE" &&
        evidence.statementKind === "INSERT_TABLE") ||
      (existing.statementKind === evidence.statementKind &&
        isAfter(evidence, existing))
    )
      byName.set(key, evidence);
  }
  const inserts = [...byName.values()].filter(
    (evidence) => evidence.statementKind === "INSERT_TABLE",
  );
  if (inserts.length === 0)
    return byName.size === 1 ? [...byName.values()][0] : undefined;
  const terminalInserts = inserts.filter(
    (evidence) => !isReferencedLaterInTask(evidence, sql),
  );
  const taskTable = taskName ? taskNameBaseTable(taskName) : undefined;
  const taskMatch = taskTable
    ? terminalInserts.filter(
        (evidence) =>
          evidence.qualifiedName.toLowerCase() === taskTable.toLowerCase(),
      )
    : [];
  if (taskMatch.length === 1) return taskMatch[0];
  return terminalInserts.length === 1 ? terminalInserts[0] : undefined;
}

/**
 * Extracts only SQL-declared write/DDL targets. Unqualified identifiers are
 * intentionally ignored unless the caller explicitly supplies the same
 * qualification policy used by the generic collector. SparkIndex calls this
 * without a task-name fallback so task names can never manufacture a table.
 */
export function extractSqlWriteTableNames(
  sql: Readonly<Partial<Record<SqlTargetSlot, string>>>,
  taskName?: string,
  options: Readonly<{ allowSchemaOnlyQualification?: boolean }> = {},
): readonly string[] {
  const names = new Map<string, string>();
  for (const evidence of collectSqlTargetEvidenceWithPatterns(
    sql,
    taskName,
    options,
    WRITE_TARGET_PATTERNS,
  )) {
    const key = evidence.qualifiedName.toLowerCase();
    if (!names.has(key)) names.set(key, evidence.qualifiedName);
  }
  return [...names.values()].sort((left, right) =>
    left.localeCompare(right),
  );
}
