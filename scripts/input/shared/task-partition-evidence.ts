import { provenSqlOutputExpressions } from "../../plans/sql-output-domain.ts";
import {
  extractSqlWrites,
  type SqlWrite,
} from "../../evidence/sql-write-evidence.ts";
import type {
  SqlSlot,
  TableEvidence,
  TaskPartitionAssignment,
  TaskPartitionEvidence,
  TaskPartitionEvidenceRef,
  TaskPartitionMap,
  TaskPartitionValue,
  TaskPartitionStatus,
  TaskPartitionTarget,
  TaskPartitionWrite,
  TaskCodeEvidence,
  TaskSchedulerEvidence,
} from "./input-pack.ts";

type SqlBySlot = Partial<Record<SqlSlot, string>>;

const DATABASE_SOURCE_TO_HIVE_CATEGORIES = new Set([
  "mysql2hive",
  "oracle2hive",
  "td2hive",
  "mongo2hive",
  "postgre2hive",
  "pg2hive",
  "postgres2hive",
  "sqlserver2hive",
  "oceanbase2hive",
  "dolphindb2hive",
]);

export function isDatabaseSourceToHiveTask(
  taskCategory: string | null | undefined,
): boolean {
  return DATABASE_SOURCE_TO_HIVE_CATEGORIES.has(
    taskCategory?.trim().toLowerCase() ?? "",
  );
}

export interface TaskPartitionBuildInput {
  readonly taskTarget?: string;
  readonly tables: readonly TableEvidence[];
  readonly sql: SqlBySlot;
  readonly schedulerEvidence?: TaskSchedulerEvidence;
  readonly codeEvidence?: TaskCodeEvidence;
  /**
   * Whether a target without an explicit SQL WRITE may bind its partition
   * fields to the trailing SELECT projection. Source-extraction tasks such
   * as oracle2hive provide source SQL here, not target-write SQL.
   */
  readonly allowImplicitQueryOutput?: boolean;
  /**
   * Allow a database-source task to emit the target's known temporal
   * partition template without treating source SQL projection as a target
   * write. This is used for oracle2hive-like ingestion tasks.
   */
  readonly allowSourceTemporalPartitionDefault?: boolean;
  readonly sparkIndexMode?: boolean;
}

export interface SimpleTaskPartitionMapInput {
  readonly taskTarget?: string;
  readonly tables: readonly TableEvidence[];
  readonly sql: SqlBySlot;
  readonly schedulerEvidence?: TaskSchedulerEvidence;
  readonly allowImplicitQueryOutput?: boolean;
  readonly allowSourceTemporalPartitionDefault?: boolean;
  /** Enable the broader target-expression projection used by sparkIndex. */
  readonly sparkIndexMode?: boolean;
  /** Proven variable bindings from schedule-evidence cache (e.g. src_table → source qn). */
  readonly partitionBindingOverrides?: TaskPartitionMap;
}

function normalize(value: string): string {
  return value.replaceAll("`", "").replaceAll('"', "").trim().toLowerCase();
}

const SYNTHETIC_WRITE_TARGETS = new Set([
  "placeholder_insert_db.placeholder_insert_table",
]);
const SPARK_INDEX_DYNAMIC_PARTITION_WILDCARD = "*";

function isSyntheticWriteTarget(value: string): boolean {
  return SYNTHETIC_WRITE_TARGETS.has(normalize(value));
}

function sameTable(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

function sameTableName(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftParts = normalizedLeft.split(".");
  const rightParts = normalizedRight.split(".");
  if (leftParts.length > 1 && rightParts.length > 1) return false;
  return leftParts.at(-1) === rightParts.at(-1);
}

function staticPartitionValue(expression: string): string | undefined {
  const value = literalValue(expression);
  return value === null || isRuntimeExpression(expression) ? undefined : value;
}

export function collectStaticPartitionValues(
  field: string,
  sql: string,
): ReadonlySet<string> {
  const content = stripSqlComments(sql);
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const identifier = `\\b${escapedField}\\b`;
  const valuePattern =
    "(?:'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|[-+]?\\d+(?:\\.\\d+)?)";
  const values = new Set<string>();
  const add = (expression: string): void => {
    const value = staticPartitionValue(expression.trim());
    if (value !== undefined) values.add(value);
  };
  const equalityPattern = new RegExp(
    `(?:[A-Za-z_][A-Za-z0-9_$]*\\.)?${identifier}\\s*=\\s*(${valuePattern})`,
    "giu",
  );
  for (const match of content.matchAll(equalityPattern)) {
    if (match[1] !== undefined) add(match[1]);
  }
  const inPattern = new RegExp(
    `(?:[A-Za-z_][A-Za-z0-9_$]*\\.)?${identifier}\\s+IN\\s*\\(([^)]*)\\)`,
    "giu",
  );
  for (const match of content.matchAll(inPattern)) {
    for (const item of splitTopLevelComma(match[1] ?? "")) add(item);
  }
  const quotedValuePattern = "(?:'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\")";
  const aliasPattern = new RegExp(
    `(${quotedValuePattern})\\s+AS\\s+${identifier}(?![A-Za-z0-9_$])`,
    "giu",
  );
  for (const match of content.matchAll(aliasPattern)) {
    if (match[1] !== undefined) add(match[1]);
  }
  return values;
}

function statementReadsTarget(statement: string, target: string): boolean {
  const tableName = normalize(target).split(".").at(-1);
  if (tableName === undefined) return false;
  const escapedTableName = tableName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `\\b(?:FROM|JOIN)\\s+(?:[A-Za-z_][A-Za-z0-9_$]*\\.)?${escapedTableName}(?![A-Za-z0-9_$])`,
    "iu",
  ).test(statement);
}

function inferredPartitionValuesForWrite(
  target: string,
  fields: readonly string[],
  sql: string,
  write: SqlWrite,
  createSql: string | undefined,
): ReadonlyMap<string, string> {
  const statement = sql.slice(write.statementSpan.start, write.statementSpan.end);
  const statementValues = statementReadsTarget(statement, target)
    ? fields.map((field) => collectStaticPartitionValues(field, statement))
    : fields.map(() => new Set<string>());
  const createValues = fields.map((field) =>
    createSql === undefined
      ? new Set<string>()
      : collectStaticPartitionValues(field, createSql),
  );
  const result = new Map<string, string>();
  fields.forEach((field, index) => {
    const values = new Set([
      ...(statementValues[index] ?? []),
      ...(createValues[index] ?? []),
    ]);
    if (values.size === 1) result.set(field.toLowerCase(), [...values][0]!);
  });
  return result;
}

/**
 * Emits only the target table's physical partition map. Source predicates,
 * such as a source table's BUSI_DATE, are intentionally outside this map.
 * A value is emitted only when every observed write context yields one unique
 * static value for the target partition field.
 */
export function buildSimpleTaskPartitionMap(
  input: SimpleTaskPartitionMapInput,
): Readonly<Record<string, string>> | undefined {
  const evidence = buildTaskPartitionEvidence(input);
  const targets = evidence.targets.filter(
    (target) =>
      input.taskTarget === undefined ||
      sameTable(target.target, input.taskTarget),
  );
  const result: Record<string, string> = {};
  const resultKeys: Record<string, string> = {};
  for (const target of targets) {
    for (const write of target.writes) {
      for (const assignment of write.assignments) {
        const value = simplePartitionValue(
          assignment,
          input.sparkIndexMode === true,
        );
        if (value === undefined) continue;
        const key = partitionAssignmentComparisonKey(assignment);
        const previous = result[assignment.field];
        if (previous !== undefined && resultKeys[assignment.field] !== key)
          return undefined;
        result[assignment.field] = value;
        resultKeys[assignment.field] = key;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Public Input Pack value.  The detailed evidence tree is deliberately kept
 * internal to the resolver; task.json only carries a value map when the
 * target write is uniquely proven. In sparkIndex mode, a confirmed target
 * partition field whose dynamic value cannot be enumerated is represented by
 * `*`; null still means the target is proven non-partitioned, and unavailable
 * target/partition evidence still omits the field.
 */
export function buildCompactTaskPartition(
  input: SimpleTaskPartitionMapInput,
): TaskPartitionValue | null | undefined {
  const evidence = buildTaskPartitionEvidence(input);
  const requestedTarget = input.taskTarget;
  const partitionedTargets = evidence.targets.filter(
    (item) => item.tableStatus === "PARTITIONED",
  );
  const target =
    requestedTarget === undefined
      ? partitionedTargets.length === 1
        ? partitionedTargets[0]
        : evidence.targets.length === 1
          ? evidence.targets[0]
          : undefined
      : evidence.targets.find((item) =>
          sameTable(item.target, requestedTarget),
      );
  if (target === undefined) return undefined;
  if (target.tableStatus === "NOT_PARTITIONED") return null;
  if (
    target.tableStatus !== "PARTITIONED" ||
    target.status === "UNKNOWN" ||
    target.status === "CONFLICT"
  )
    return undefined;
  const map =
    input.sparkIndexMode === true
      ? buildDynamicPartitionValue(target, input.sql, true)
      : target.status === "COMPLETE" ||
          hasTargetWriteEvidence(target) ||
          input.allowSourceTemporalPartitionDefault === true
        ? buildDynamicPartitionValue(target, input.sql, true)
        : undefined;
  if (map === undefined) return undefined;
  if (!Array.isArray(map)) {
    const singleMap = map as TaskPartitionMap;
    if (target.fields.some((field) => singleMap[field] === undefined))
      return undefined;
  }
  if (
    input.partitionBindingOverrides !== undefined &&
    map !== undefined &&
    !Array.isArray(map)
  ) {
    const merged: Record<string, string> = { ...(map as TaskPartitionMap) };
    for (const [field, value] of Object.entries(input.partitionBindingOverrides)) {
      const key =
        target.fields.find((item) => item.toLowerCase() === field.toLowerCase()) ??
        field.toLowerCase();
      const existing = merged[key];
      if (
        existing === undefined ||
        (typeof existing === "string" && /^\$\{/u.test(existing))
      )
        merged[key] = value;
    }
    return merged as TaskPartitionMap;
  }
  return map;
}

function hasTargetWriteEvidence(target: TaskPartitionTarget): boolean {
  return target.writes.some(
    (write) =>
      write.sqlSlot !== null &&
      write.mode !== "UNKNOWN",
  );
}

function buildDynamicPartitionValue(
  target: TaskPartitionTarget,
  sqlBySlot: Partial<Record<SqlSlot, string>>,
  useTemporalTemplates: boolean,
): TaskPartitionValue | undefined {
  const maps: TaskPartitionMap[] = [];
  for (const write of target.writes) {
    const variants = write.assignmentVariants ?? [write.assignments];
    const writeMaps = variants
      .map((assignments) =>
        partitionMapFromAssignments(
          assignments,
          target.fields,
          write.sqlSlot === null ? undefined : sqlBySlot[write.sqlSlot],
          useTemporalTemplates,
        ),
      )
      .filter((map): map is TaskPartitionMap => map !== undefined);
    if (writeMaps.length !== variants.length) return undefined;
    maps.push(...writeMaps);
  }
  const uniqueMaps = maps.filter(
    (map, index, values) =>
      values.findIndex(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(map),
      ) === index,
  );
  if (uniqueMaps.length === 0) return undefined;
  return uniqueMaps.length === 1 ? uniqueMaps[0]! : uniqueMaps;
}

function partitionMapFromAssignments(
  assignments: readonly TaskPartitionAssignment[],
  fields: readonly string[],
  sql: string | undefined,
  useTemporalTemplates: boolean,
): TaskPartitionMap | undefined {
  const result: Record<string, string> = {};
  for (const assignment of assignments) {
    const value = simplePartitionValue(assignment, true);
    if (value === undefined) continue;
    const previous = result[assignment.field];
    if (previous !== undefined && previous !== value) return undefined;
    result[assignment.field] = value;
  }
  for (const field of fields) {
    const explicitAssignment = assignments.some(
      (assignment) =>
        assignment.field.toLowerCase() === field.toLowerCase() &&
        (assignment.status === "CONFIRMED" ||
          assignment.mappingMethod === "SCHEDULER_EXPLICIT_FIELD_VALUE"),
    );
    const defaultValue = useTemporalTemplates
      ? sparkIndexTemporalPartitionDefault(field, sql)
      : undefined;
    if (
      defaultValue !== undefined &&
      !(explicitAssignment && result[field] !== undefined)
    )
      result[field] = defaultValue;
    else if (result[field] === undefined)
      result[field] = SPARK_INDEX_DYNAMIC_PARTITION_WILDCARD;
  }
  return result;
}

function sparkIndexTemporalPartitionDefault(
  field: string,
  sql: string | undefined,
): string | undefined {
  const normalizedField = field.toLowerCase();
  const content = sql ?? "";
  if (normalizedField === "busi_date") return "${YYYY-MM-DD}";
  if (normalizedField === "busi_year") {
    return hasTemporalToken(content, "year") || hasTemporalSubstring(content, 4)
      ? "${YYYY}"
      : undefined;
  }
  if (normalizedField === "mon_no") {
    return hasTemporalToken(content, "month") ||
      hasTemporalSubstring(content, 6)
      ? "${YYYYMM}"
      : undefined;
  }
  if (normalizedField !== "busi_mon") return undefined;

  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const aliasExpressions = [
    ...content.matchAll(
      new RegExp(
        "([^;\\n]+?)\\s+AS\\s+[\"'`]?" +
          escapedField +
          "[\"'`]?(?![A-Za-z0-9_$])",
        "giu",
      ),
    ),
  ].map((match) => match[1] ?? "");
  const aliasTemplates = aliasExpressions
    .map(temporalTemplateFromExpression)
    .filter((value): value is string => value !== undefined);
  if (aliasTemplates.length > 0) return mostCommonTemplate(aliasTemplates);

  const fieldExpressions = [
    ...content.matchAll(new RegExp(`\\b${field}\\s*=\\s*([^;\\n]+)`, "giu")),
  ].map((match) => match[1] ?? "");
  const fieldTemplates = fieldExpressions
    .map(temporalTemplateFromExpression)
    .filter((value): value is string => value !== undefined);
  if (fieldTemplates.length > 0) return mostCommonTemplate(fieldTemplates);

  const token = content.match(
    /\$\{(yyyy(?:-MM)?|YYYY(?:-MM)?)(,[-+]?\d+[mMdDyY])?\}/u,
  );
  if (token?.[1] !== undefined) {
    const format = token[1].toLowerCase() === "yyyy-mm" ? "YYYY-MM" : "YYYYMM";
    return `\${${format}${token[2] ?? ""}}`;
  }
  return "${YYYYMM}";
}

function hasTemporalToken(content: string, kind: "year" | "month"): boolean {
  return kind === "year"
    ? /\$\{yyyy(?:-MM-dd|MMdd|MM)?\}/iu.test(content)
    : /\$\{yyyy(?:MMdd|MM|-MM)?\}/iu.test(content);
}

function hasTemporalSubstring(content: string, length: 4 | 6): boolean {
  return new RegExp(
    `(?:substr|substring)\\s*\\([^,]+,\\s*1\\s*,\\s*${length}\\s*\\)`,
    "iu",
  ).test(content);
}

function temporalTemplateFromExpression(
  expression: string,
): string | undefined {
  const token = expression.match(
    /\$\{(yyyy(?:-MM)?|YYYY(?:-MM)?)(,[-+]?\d+[mMdDyY])?\}/u,
  );
  if (token?.[1] !== undefined) {
    const format = token[1].toLowerCase() === "yyyy-mm" ? "YYYY-MM" : "YYYYMM";
    return `\${${format}${token[2] ?? ""}}`;
  }
  const offset = expression.match(/add_months\s*\([^,]+,\s*(-?\d+)\s*\)/iu);
  if (offset?.[1] !== undefined) {
    const monthOffset = `${Number(offset[1]) >= 0 ? "+" : ""}${Number(offset[1])}M`;
    return /1\s*,\s*7\s*\)/u.test(expression)
      ? `\${YYYY-MM,${monthOffset}}`
      : `\${YYYYMM,${monthOffset}}`;
  }
  if (
    /regexp_replace\s*\(/iu.test(expression) &&
    /1\s*,\s*6\s*\)/u.test(expression)
  )
    return "${YYYYMM}";
  if (/1\s*,\s*7\s*\)/u.test(expression)) return "${YYYY-MM}";
  if (/1\s*,\s*6\s*\)/u.test(expression)) return "${YYYYMM}";
  return undefined;
}

function mostCommonTemplate(values: readonly string[]): string {
  return values
    .map((value, index) => ({
      value,
      count: values.filter((candidate) => candidate === value).length,
      index,
    }))
    .sort(
      (left, right) => right.count - left.count || left.index - right.index,
    )[0]!.value;
}

function simplePartitionValue(
  assignment: TaskPartitionAssignment,
  sparkIndexMode: boolean,
): string | undefined {
  if (assignment.status === "CONFIRMED" && assignment.value !== null)
    return sparkIndexMode
      ? (canonicalizePartitionValue(assignment.value) ?? undefined)
      : assignment.value;
  if (
    assignment.status === "RUNTIME_EXPRESSION" &&
    assignment.expression !== null &&
    (sparkIndexMode
      ? isSerializablePartitionExpression(assignment.expression)
      : isRuntimeExpression(assignment.expression))
  ) {
    const expression = assignment.expression.trim();
    const quoted = expression.match(/^(['"])(.*)\1$/s);
    return quoted?.[2] ?? expression;
  }
  return undefined;
}

function isSerializablePartitionExpression(expression: string): boolean {
  const trimmed = expression.trim();
  return trimmed !== "" && !/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(trimmed);
}

function partitionAssignmentComparisonKey(
  assignment: TaskPartitionAssignment,
): string {
  if (assignment.status === "CONFIRMED" && assignment.expression !== null) {
    const literal = literalValue(assignment.expression);
    if (literal !== null) return `literal:${literal}`;
  }
  if (assignment.status === "CONFIRMED" && assignment.value !== null)
    return `value:${assignment.value}`;
  if (assignment.expression !== null)
    return `expression:${assignment.expression.trim().replaceAll(/\s+/gu, " ")}`;
  return `${assignment.status}:${assignment.reason ?? ""}`;
}

function resolveWriteTarget(
  taskTarget: string | undefined,
  writeTarget: string,
): string {
  if (taskTarget === undefined || writeTarget.includes(".")) return writeTarget;
  const targetParts = normalize(taskTarget).split(".");
  return targetParts.at(-1) === normalize(writeTarget)
    ? taskTarget
    : writeTarget;
}

function splitTopLevelComma(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== null) {
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
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

function topLevelKeyword(value: string, keyword: string, start = 0): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  const upperKeyword = keyword.toUpperCase();
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (quote !== null) {
      if (character === quote && value[index - 1] !== "\\") {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "-" && next === "-") {
      index += 2;
      while (index < value.length && value[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index + 1 < value.length &&
        !(value[index] === "*" && value[index + 1] === "/")
      )
        index += 1;
      index += 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      depth !== 0 ||
      value.slice(index, index + keyword.length).toUpperCase() !== upperKeyword
    )
      continue;
    const before = value[index - 1];
    const after = value[index + keyword.length];
    if (
      (before === undefined || !/[A-Za-z0-9_]/u.test(before)) &&
      (after === undefined || !/[A-Za-z0-9_]/u.test(after))
    )
      return index;
  }
  return -1;
}

function stripSqlComments(value: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (quote !== null) {
      result += character;
      if (character === quote) {
        if (next === quote) {
          result += next;
          index += 1;
        } else if (value[index - 1] !== "\\") quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += character;
      continue;
    }
    if (character === "-" && next === "-") {
      index += 2;
      while (index < value.length && value[index] !== "\n") index += 1;
      if (index < value.length) result += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index + 1 < value.length &&
        !(value[index] === "*" && value[index + 1] === "/")
      )
        index += 1;
      index += 1;
      continue;
    }
    result += character;
  }
  return result;
}

type ProjectionBranch = {
  readonly sql: string;
  readonly items: readonly string[];
};

type ProjectionResult =
  | {
      readonly items: readonly string[];
      readonly branches: readonly ProjectionBranch[];
    }
  | { readonly reason: string };

function splitTopLevelUnion(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        if (next === quote) index += 1;
        else if (value[index - 1] !== "\\") quote = null;
      }
      continue;
    }
    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      depth !== 0 ||
      value.slice(index, index + 5).toUpperCase() !== "UNION" ||
      (index > 0 && /[A-Za-z0-9_]/u.test(value[index - 1]!)) ||
      (index + 5 < value.length && /[A-Za-z0-9_]/u.test(value[index + 5]!))
    )
      continue;
    result.push(value.slice(start, index).trim());
    index += 5;
    while (index < value.length && /\s/u.test(value[index]!)) index += 1;
    const qualifier = value.slice(index, index + 8).toUpperCase();
    if (
      qualifier.startsWith("ALL") &&
      !/[A-Za-z0-9_]/u.test(value[index + 3] ?? "")
    )
      index += 3;
    else if (
      qualifier.startsWith("DISTINCT") &&
      !/[A-Za-z0-9_]/u.test(value[index + 8] ?? "")
    )
      index += 8;
    start = index;
    index -= 1;
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

function projectionItemsFromStatement(
  statement: string,
): { readonly items: readonly string[] } | { readonly reason: string } {
  const selectAt = topLevelKeyword(statement, "SELECT");
  if (selectAt < 0) return { reason: "DYNAMIC_PARTITION_SELECT_NOT_FOUND" };
  const fromAt = topLevelKeyword(statement, "FROM", selectAt + 6);
  const projection = stripSqlComments(
    statement.slice(selectAt + 6, fromAt >= 0 ? fromAt : undefined),
  ).trim();
  if (projection === "") return { reason: "DYNAMIC_PARTITION_OUTPUT_EMPTY" };
  const items = splitTopLevelComma(projection);
  if (items.some((item) => item === "*" || /\.\s*\*$/u.test(item)))
    return { reason: "DYNAMIC_PARTITION_WILDCARD_OUTPUT" };
  return { items };
}

function projectionItems(sql: string, write: SqlWrite): ProjectionResult {
  const statement = sql.slice(
    write.statementSpan.start,
    write.statementSpan.end,
  );
  const branches: ProjectionBranch[] = [];
  for (const branchSql of splitTopLevelUnion(statement)) {
    const projection = projectionItemsFromStatement(branchSql);
    if ("reason" in projection) return projection;
    branches.push({ sql: branchSql, items: projection.items });
  }
  return {
    items: branches[0]?.items ?? [],
    branches,
  };
}

function expressionAndAlias(item: string): {
  readonly expression: string;
  readonly alias?: string;
} {
  const asMatch = item.match(
    /^(.*?)[ \t]+AS[ \t]+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?$/iu,
  );
  if (asMatch)
    return { expression: asMatch[1]!.trim(), alias: asMatch[2]!.toLowerCase() };
  const bareMatch = item.match(
    /^(.*?)[ \t]+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?$/u,
  );
  if (bareMatch) {
    const expression = bareMatch[1]!.trim();
    if (!/[+\-*/%<>=|&^~,]$/u.test(expression))
      return { expression, alias: bareMatch[2]!.toLowerCase() };
  }
  return { expression: item.trim() };
}

function literalValue(expression: string): string | null {
  const trimmed = expression.trim();
  const quoted =
    trimmed.match(/^'(.*)'$/s)?.[1] ?? trimmed.match(/^"(.*)"$/s)?.[1];
  if (quoted !== undefined) return quoted;
  return /^(?:[-+]?\d+(?:\.\d+)?|true|false|null)$/iu.test(trimmed)
    ? trimmed
    : null;
}

function canonicalizePartitionValue(value: string | null): string | null {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? value
    : "${YYYY-MM-DD}";
}

function temporalPartitionBranchesEquivalent(
  field: string,
  sql: string,
  assignments: readonly TaskPartitionAssignment[],
): boolean {
  if (field.toLowerCase() !== "busi_date") return false;
  if (sparkIndexTemporalPartitionDefault(field, sql) === undefined) return false;
  return assignments.every(
    (assignment) =>
      assignment.status === "RUNTIME_EXPRESSION" ||
      (assignment.status === "CONFIRMED" &&
        canonicalizePartitionValue(assignment.value) === "${YYYY-MM-DD}"),
  );
}

function sqlRef(slot: SqlSlot, write: SqlWrite): TaskPartitionEvidenceRef {
  return {
    source: "INPUT_PACK_SQL",
    locator: `sql/${slot}.sql#char=${write.statementSpan.start}-${write.statementSpan.end}`,
    detail: `statementOrdinal=${write.statementOrdinal}`,
  };
}

function tableRef(table: TableEvidence): TaskPartitionEvidenceRef {
  return {
    source: "TABLE_PACK",
    locator: `table-pack:${table.platform}/${table.qualifiedName}@@${table.dataSource}`,
    detail: `partitionFields=${(table.partitionFields ?? []).join(",")};logical locator;path is resolved by Input Pack table identity`,
  };
}

function schedulerRefs(
  schedulerEvidence?: TaskSchedulerEvidence,
): TaskPartitionEvidenceRef[] {
  return schedulerEvidence === undefined
    ? []
    : [{ source: "SCHEDULER_CONFIG", locator: "task-source.hivePartition" }];
}

function codeRefs(codeEvidence?: TaskCodeEvidence): TaskPartitionEvidenceRef[] {
  return codeEvidence?.scriptParams === undefined
    ? []
    : [{ source: "CODE_EVIDENCE", locator: "task.codeEvidence.scriptParams" }];
}

function explicitFieldValues(
  value: string | undefined,
  singleTargetFields: readonly string[] = [],
): ReadonlyMap<string, string> {
  if (value === undefined) return new Map();
  const result = new Map<string, string>();
  const pattern =
    /(?:^|[,;\s])([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^,;\s]+))/gu;
  for (const match of value.matchAll(pattern)) {
    const field = match[1]?.toLowerCase();
    const raw = match[2] ?? match[3] ?? match[4];
    if (field !== undefined && raw !== undefined) result.set(field, raw);
  }
  // Ingestion configuration can supply just the value for one known target
  // partition field. Never infer positional bindings for multiple fields.
  if (result.size === 0 && singleTargetFields.length === 1) {
    const raw = value.trim();
    const unquoted = literalValue(raw) ?? raw;
    const field = singleTargetFields[0]!.toLowerCase();
    if (
      (/^[A-Za-z0-9_.:-]+$/u.test(unquoted) ||
        /^\$\{[^{}\r\n]+\}$/u.test(unquoted)) &&
      ![field, "none", "null"].includes(unquoted.toLowerCase())
    )
      result.set(field, unquoted);
  }
  return result;
}

function unknownAssignment(
  field: string,
  evidence: readonly TaskPartitionEvidenceRef[],
  reason: string,
  status: "UNKNOWN" | "CONFLICT" = "UNKNOWN",
): TaskPartitionAssignment {
  return {
    field,
    expression: null,
    value: null,
    status,
    mappingMethod: status === "CONFLICT" ? "CONFLICT" : "UNKNOWN",
    evidence,
    reason,
  };
}

function assignmentFromExpression(
  field: string,
  expression: string,
  mappingMethod: TaskPartitionAssignment["mappingMethod"],
  evidence: readonly TaskPartitionEvidenceRef[],
): TaskPartitionAssignment {
  const value = literalValue(expression);
  const runtime = isRuntimeExpression(expression);
  return {
    field,
    expression,
    value: runtime ? null : value,
    status: runtime || value === null ? "RUNTIME_EXPRESSION" : "CONFIRMED",
    mappingMethod,
    evidence,
  };
}

function assignmentFromExplicitConfig(
  field: string,
  value: string,
  mappingMethod: "SCHEDULER_EXPLICIT_FIELD_VALUE",
  evidence: readonly TaskPartitionEvidenceRef[],
): TaskPartitionAssignment {
  const runtime = /\$\{|\{\{|\{%|<%/u.test(value);
  return {
    field,
    expression: value,
    value: runtime ? null : value,
    status: runtime ? "RUNTIME_EXPRESSION" : "CONFIRMED",
    mappingMethod,
    evidence,
  };
}

function isRuntimeExpression(value: string): boolean {
  return /\$\{|\{\{|\{%|<%/u.test(value);
}

function dynamicAssignments(
  fieldNames: readonly string[],
  sql: string,
  write: SqlWrite,
  evidence: readonly TaskPartitionEvidenceRef[],
  allowMultiplePartitionInstances = false,
): {
  readonly assignments: readonly TaskPartitionAssignment[];
  readonly variants?: readonly (readonly TaskPartitionAssignment[])[];
  readonly reason: string | undefined;
} {
  const projection = projectionItems(sql, write);
  if ("reason" in projection) {
    return {
      assignments: fieldNames.map((field) =>
        unknownAssignment(field, evidence, projection.reason),
      ),
      reason: projection.reason,
    };
  }
  const branches =
    projection.branches.length > 0
      ? projection.branches
      : [{ sql: "", items: projection.items }];
  if (branches.some((branch) => branch.items.length < fieldNames.length))
    return {
      assignments: fieldNames.map((field) =>
        unknownAssignment(
          field,
          evidence,
          "DYNAMIC_PARTITION_OUTPUT_TOO_SHORT",
        ),
      ),
      reason: "DYNAMIC_PARTITION_OUTPUT_TOO_SHORT",
    };
  let aliasMismatch = false;
  const branchAssignments = branches.map((branch, branchIndex) =>
    fieldNames.map((field, index) => {
      const parsed = expressionAndAlias(
        branch.items[branch.items.length - fieldNames.length + index]!,
      );
      if (parsed.alias !== undefined && parsed.alias !== field.toLowerCase())
        aliasMismatch = true;
      return assignmentFromExpression(
        field,
        parsed.expression,
        "DYNAMIC_PARTITION_OUTPUT_ORDINAL",
        [
          ...evidence,
          {
            source: "INPUT_PACK_SQL" as const,
            locator: "dynamic-output-ordinal",
            detail: `branch=${branchIndex + 1};ordinal=${branch.items.length - fieldNames.length + index + 1};alias=${parsed.alias ?? "-"}`,
          },
        ],
      );
    }),
  );
  const assignments: TaskPartitionAssignment[] = [];
  let unionConflict = false;
  fieldNames.forEach((field, index) => {
    const fieldAssignments = branchAssignments.map((branch) => branch[index]!);
    const branchKeys = fieldAssignments.map((assignment) =>
      partitionAssignmentComparisonKey(assignment),
    );
    if (
      !allowMultiplePartitionInstances &&
      new Set(branchKeys).size > 1 &&
      !temporalPartitionBranchesEquivalent(field, sql, fieldAssignments)
    ) {
      unionConflict = true;
      assignments.push(
        unknownAssignment(
          field,
          evidence,
          "DYNAMIC_PARTITION_UNION_BRANCH_CONFLICT",
          "CONFLICT",
        ),
      );
      return;
    }
    const unresolved = fieldAssignments.find(
      (assignment) =>
        assignment.status === "UNKNOWN" || assignment.status === "CONFLICT",
    );
    assignments.push(unresolved ?? fieldAssignments[0]!);
  });
  return {
    assignments,
    variants:
      allowMultiplePartitionInstances && branchAssignments.length > 1
        ? branchAssignments
        : undefined,
    reason: unionConflict
      ? "DYNAMIC_PARTITION_UNION_BRANCH_CONFLICT"
      : aliasMismatch
        ? "DYNAMIC_PARTITION_ALIAS_NOT_USED"
        : undefined,
  };
}

export function partitionFieldsFromDdl(
  sql: string | undefined,
): readonly string[] {
  return partitionFieldsFromCreateSql(sql);
}

function partitionFieldsFromCreateSql(sql: string | undefined): string[] {
  if (sql === undefined) return [];
  const match = sql.match(/\bPARTITIONED\s+BY\s*\(([^)]*)\)/iu);
  if (!match) return [];
  return splitTopLevelComma(match[1]!)
    .map((definition) =>
      definition
        .match(/^[`"]?([A-Za-z_][A-Za-z0-9_$]*)[`"]?/u)?.[1]
        ?.toLowerCase(),
    )
    .filter((field): field is string => field !== undefined);
}

function partitionFieldsFromMatchingCreateSql(
  sql: string | undefined,
  target: string,
): string[] {
  if (sql === undefined) return [];
  const createPattern =
    /\bCREATE\s+(?:EXTERNAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:[`"]?[A-Za-z_][A-Za-z0-9_$]*[`"]?\s*\.\s*)?[`"]?[A-Za-z_][A-Za-z0-9_$]*[`"]?)/giu;
  const creates = [...sql.matchAll(createPattern)];
  const index = creates.findIndex((match) => {
    const createTarget = match[1]?.replaceAll(/\s+/gu, "");
    return createTarget !== undefined && sameTableName(createTarget, target);
  });
  if (index < 0) return [];
  const start = creates[index]!.index;
  const end = creates[index + 1]?.index ?? sql.length;
  return partitionFieldsFromCreateSql(sql.slice(start, end));
}

function partitionFieldsFor(
  table: TableEvidence | undefined,
  createSql: string | undefined,
  target: string,
): {
  readonly fields: readonly string[];
  readonly known: boolean;
  readonly usedCreateFallback: boolean;
} {
  if (Array.isArray(table?.partitionFields))
    return {
      fields: table.partitionFields,
      known: true,
      usedCreateFallback: false,
    };
  const fields = partitionFieldsFromMatchingCreateSql(createSql, target);
  return {
    fields,
    known: fields.length > 0,
    usedCreateFallback: fields.length > 0,
  };
}

function resolveOutputReference(expression: string, field: string, sql: string): { readonly expression: string | undefined; readonly reason?: string } {
  const reference = expression.match(/^(?:[`"]?[A-Za-z_][A-Za-z0-9_$]*[`"]?\.)?[`"]?([A-Za-z_][A-Za-z0-9_$]*)[`"]?$/u);
  if (reference?.[1]?.toLowerCase() !== field.toLowerCase()) return { expression };
  const values = provenSqlOutputExpressions(sql, field);
  return values?.length === 1 ? { expression: values[0] } : {
    expression: undefined, reason: values ? "DYNAMIC_PARTITION_OUTPUT_REFERENCE_NOT_UNIQUE" : "DYNAMIC_PARTITION_OUTPUT_REFERENCE_UNRESOLVED",
  };
}

function outputReferenceCandidates(field: string, sql: string): string[] {
  return [...(provenSqlOutputExpressions(sql, field) ?? [])];
}

function directQueryProjection(
  fields: readonly string[],
  sql: string,
  evidence: readonly TaskPartitionEvidenceRef[],
  allowMultiplePartitionInstances = false,
): {
  readonly assignments: readonly TaskPartitionAssignment[];
  readonly variants?: readonly (readonly TaskPartitionAssignment[])[];
  readonly reason?: string;
} {
  const projection = projectionItems(sql, {
    qualifiedName: "__implicit_task_target__",
    writeKind: "INSERT_INTO",
    statementSpan: { start: 0, end: sql.length },
    statementOrdinal: 1,
    partitionMode: "DYNAMIC",
    partitionFields: [...fields],
    partition: [],
  });
  if ("reason" in projection)
    return {
      assignments: fields.map((field) =>
        unknownAssignment(field, evidence, projection.reason),
      ),
      reason: projection.reason,
    };
  const branches =
    projection.branches.length > 0
      ? projection.branches
      : [{ sql, items: projection.items }];
  if (branches.some((branch) => branch.items.length < fields.length))
    return {
      assignments: fields.map((field) =>
        unknownAssignment(
          field,
          evidence,
          "DYNAMIC_PARTITION_OUTPUT_TOO_SHORT",
        ),
      ),
      reason: "DYNAMIC_PARTITION_OUTPUT_TOO_SHORT",
    };

  const branchAssignments = branches.flatMap((branch, branchIndex) => {
    let variants: TaskPartitionAssignment[][] = [[]];
    fields.forEach((field, index) => {
      const start = branch.items.length - fields.length;
      const parsed = expressionAndAlias(branch.items[start + index]!);
      const resolved = resolveOutputReference(
        parsed.expression,
        field,
        branch.sql,
      );
      const expressions =
        resolved.expression === undefined && allowMultiplePartitionInstances
          ? outputReferenceCandidates(field, branch.sql)
          : resolved.expression === undefined
            ? []
            : [resolved.expression];
      const candidates =
        expressions.length > 0
          ? expressions.map((expression) =>
              assignmentFromExpression(
                field,
                expression,
                "DYNAMIC_PARTITION_OUTPUT_ORDINAL",
                [
                  ...evidence,
                  {
                    source: "INPUT_PACK_SQL",
                    locator: "sql/query.sql#implicit-target-output",
                    detail: `branch=${branchIndex + 1};ordinal=${start + index + 1};alias=${parsed.alias ?? "-"}`,
                  },
                ],
              ),
            )
          : [
              unknownAssignment(
                field,
                evidence,
                resolved.reason ??
                  "DYNAMIC_PARTITION_OUTPUT_REFERENCE_UNRESOLVED",
              ),
            ];
      variants = variants.flatMap((prefix) =>
        candidates.map((candidate) => [...prefix, candidate]),
      );
    });
    return variants;
  });
  const assignments = fields.map((field, index) => {
    const fieldAssignments = branchAssignments.map((branch) => branch[index]!);
    const unresolved = fieldAssignments.find(
      (assignment) =>
        assignment.status === "UNKNOWN" || assignment.status === "CONFLICT",
    );
    if (unresolved !== undefined) return unresolved;
    const branchKeys = fieldAssignments.map((assignment) =>
      partitionAssignmentComparisonKey(assignment),
    );
    if (!allowMultiplePartitionInstances && new Set(branchKeys).size > 1)
      return unknownAssignment(
        field,
        fieldAssignments.flatMap((assignment) => assignment.evidence),
        "DYNAMIC_PARTITION_UNION_BRANCH_CONFLICT",
        "CONFLICT",
      );
    return fieldAssignments[0]!;
  });
  return {
    assignments,
    variants:
      allowMultiplePartitionInstances && branchAssignments.length > 1
        ? branchAssignments
        : undefined,
    reason: assignments.find(
      (item) => item.status === "UNKNOWN" || item.status === "CONFLICT",
    )?.reason,
  };
}

function addPartitionFromSql(
  fields: readonly string[],
  target: string,
  sql: Partial<Record<SqlSlot, string>>,
):
  | {
      readonly assignments: readonly TaskPartitionAssignment[];
      readonly sqlSlot: SqlSlot;
      readonly evidence: readonly TaskPartitionEvidenceRef[];
    }
  | undefined {
  for (const [rawSlot, content] of Object.entries(sql)) {
    if (content === undefined) continue;
    const slot = rawSlot as SqlSlot;
    const pattern =
      /\bALTER\s+TABLE\s+[`"]?([^\s(`"]+)[`"]?\s+ADD\s+(?:IF\s+NOT\s+EXISTS\s+)?PARTITION\s*\(([^)]*)\)/giu;
    for (const match of content.matchAll(pattern)) {
      if (!sameTable(match[1]!, target)) continue;
      const clause = new Map<string, string>();
      for (const item of splitTopLevelComma(match[2]!)) {
        const equals = item.indexOf("=");
        if (equals < 0) continue;
        const field = item
          .slice(0, equals)
          .trim()
          .replaceAll("`", "")
          .replaceAll('"', "")
          .toLowerCase();
        clause.set(field, item.slice(equals + 1).trim());
      }
      const evidence: TaskPartitionEvidenceRef[] = [
        {
          source: "INPUT_PACK_SQL",
          locator: `sql/${slot}.sql#ALTER-ADD-PARTITION`,
          detail: `target=${target};partition maintenance scope`,
        },
      ];
      return {
        sqlSlot: slot,
        evidence,
        assignments: fields.map((field) => {
          const expression = clause.get(field.toLowerCase());
          return expression === undefined
            ? unknownAssignment(
                field,
                evidence,
                "ADD_PARTITION_FIELD_NOT_PRESENT",
              )
            : assignmentFromExpression(
                field,
                expression,
                "STATIC_SQL_ASSIGNMENT",
                evidence,
              );
        }),
      };
    }
  }
  return undefined;
}

function buildSqlWrite(
  table: TableEvidence | undefined,
  target: string,
  sqlSlot: SqlSlot,
  sql: string,
  write: SqlWrite,
  createSql: string | undefined,
  schedulerEvidence?: TaskSchedulerEvidence,
  codeEvidence?: TaskCodeEvidence,
  sparkIndexMode = false,
  partitionValueHints?: ReadonlyMap<string, string>,
): TaskPartitionWrite {
  const partitionFields = partitionFieldsFor(table, createSql, target);
  const tableFields = partitionFields.fields;
  const mappingEvidence = [
    ...(table === undefined ? [] : [tableRef(table)]),
    sqlRef(sqlSlot, write),
    ...(partitionFields.usedCreateFallback
      ? [
          {
            source: "INPUT_PACK_SQL" as const,
            locator: "sql/create.sql#PARTITIONED-BY",
            detail:
              "fallback partition-field discovery; existing table metadata did not provide partitionFields",
          },
        ]
      : []),
  ];
  const writeEvidence = [
    ...mappingEvidence,
    ...schedulerRefs(schedulerEvidence),
    ...codeRefs(codeEvidence),
  ];
  if (!partitionFields.known)
    return {
      target,
      sqlSlot,
      statementOrdinal: write.statementOrdinal,
      statementSpan: write.statementSpan,
      mode: write.partitionMode,
      status: "UNKNOWN",
      assignments: [],
      evidence: writeEvidence,
      reasonCodes: ["TABLE_PACK_PARTITION_FIELDS_UNAVAILABLE"],
    };
  if (tableFields.length === 0)
    return {
      target,
      sqlSlot,
      statementOrdinal: write.statementOrdinal,
      statementSpan: write.statementSpan,
      mode: "NONE",
      status: "NOT_PARTITIONED",
      assignments: [],
      evidence: writeEvidence,
      reasonCodes: ["TABLE_NOT_PARTITIONED"],
    };
  const staticAssignments = new Map(
    write.partition
      .filter((item) => item.expression !== "UNKNOWN")
      .map((item) => [item.field.toLowerCase(), item.expression]),
  );
  for (const [field, expression] of partitionValueHints ?? [])
    if (!staticAssignments.has(field.toLowerCase()))
      staticAssignments.set(field.toLowerCase(), `'${expression}'`);
  const dynamicFields = write.partitionFields.filter(
    (field) => !staticAssignments.has(field.toLowerCase()),
  );
  let dynamic: {
    readonly assignments: readonly TaskPartitionAssignment[];
    readonly variants?: readonly (readonly TaskPartitionAssignment[])[];
    readonly reason: string | undefined;
  } = { assignments: [], reason: undefined };
  if (dynamicFields.length > 0)
    dynamic = dynamicAssignments(
      dynamicFields,
      sql,
      write,
      mappingEvidence,
      true,
    );
  const schedulerValues = explicitFieldValues(schedulerEvidence?.hivePartition);
  const buildAssignments = (
    dynamicAssignmentsForVariant: readonly TaskPartitionAssignment[],
  ): readonly TaskPartitionAssignment[] =>
    tableFields.map((field) => {
      const key = field.toLowerCase();
      const staticAssignment = staticAssignments.get(key);
      const dynamicAssignment = dynamicAssignmentsForVariant.find(
        (item) => item.field.toLowerCase() === key,
      );
      const assignment =
        staticAssignment !== undefined
          ? assignmentFromExpression(
              field,
              staticAssignment,
              "STATIC_SQL_ASSIGNMENT",
              mappingEvidence,
            )
          : (dynamicAssignment ??
            unknownAssignment(
              field,
              mappingEvidence,
              "PARTITION_FIELD_NOT_PRESENT_IN_WRITE",
            ));
      const schedulerValue = schedulerValues.get(key);
      if (
        assignment.status === "CONFIRMED" &&
        assignment.value !== null &&
        schedulerValue !== undefined &&
        !isRuntimeExpression(schedulerValue) &&
        assignment.value !== schedulerValue
      )
        return {
          ...assignment,
          value: null,
          status: "CONFLICT" as const,
          mappingMethod: "CONFLICT" as const,
          evidence: [...mappingEvidence, ...schedulerRefs(schedulerEvidence)],
          reason: `SQL_SCHEDULER_PARTITION_CONFLICT:sql=${assignment.value};scheduler=${schedulerValue}`,
        };
      return assignment;
    });
  const assignments = buildAssignments(dynamic.assignments);
  const assignmentVariants = dynamic.variants?.map(buildAssignments);
  const statuses = (
    assignmentVariants === undefined ? assignments : assignmentVariants.flat()
  ).map((item) => item.status);
  const status: TaskPartitionStatus = statuses.includes("CONFLICT")
    ? "CONFLICT"
    : statuses.includes("UNKNOWN")
      ? "INCOMPLETE"
      : "COMPLETE";
  const reasonCodes =
    status === "CONFLICT"
      ? ["SQL_SCHEDULER_PARTITION_CONFLICT"]
      : [
          ...(dynamic.reason === undefined ? [] : [dynamic.reason]),
          status === "COMPLETE"
            ? "PARTITION_EVIDENCE_COMPLETE"
            : (dynamic.reason ?? "PARTITION_FIELD_VALUE_NOT_PROVABLE"),
        ];
  return {
    target,
    sqlSlot,
    statementOrdinal: write.statementOrdinal,
    statementSpan: write.statementSpan,
    mode: write.partitionMode,
    status,
    assignments,
    ...(assignmentVariants === undefined ? {} : { assignmentVariants }),
    evidence: writeEvidence,
    reasonCodes: [...new Set(reasonCodes)],
  };
}

function buildDirectWrite(
  table: TableEvidence | undefined,
  target: string,
  querySql: string | undefined,
  createSql: string | undefined,
  addPartition:
    | {
        readonly assignments: readonly TaskPartitionAssignment[];
        readonly sqlSlot: SqlSlot;
        readonly evidence: readonly TaskPartitionEvidenceRef[];
      }
    | undefined,
  schedulerEvidence?: TaskSchedulerEvidence,
  codeEvidence?: TaskCodeEvidence,
  allowImplicitQueryOutput = true,
  sparkIndexMode = false,
): TaskPartitionWrite {
  const partitionFields = partitionFieldsFor(table, createSql, target);
  const evidence: TaskPartitionEvidenceRef[] = [
    ...(table === undefined ? [] : [tableRef(table)]),
    ...(partitionFields.usedCreateFallback
      ? [
          {
            source: "INPUT_PACK_SQL" as const,
            locator: "sql/create.sql#PARTITIONED-BY",
            detail:
              "fallback partition-field discovery; existing table metadata did not provide partitionFields",
          },
        ]
      : []),
    ...schedulerRefs(schedulerEvidence),
    ...codeRefs(codeEvidence),
  ];
  if (!partitionFields.known)
    return {
      target,
      sqlSlot: null,
      statementOrdinal: null,
      mode: "UNKNOWN",
      status: "UNKNOWN",
      assignments: [],
      evidence:
        evidence.length > 0
          ? evidence
          : [{ source: "SCHEDULER_CONFIG", locator: "task.target" }],
      reasonCodes: ["TABLE_PACK_PARTITION_FIELDS_UNAVAILABLE"],
    };
  if (partitionFields.fields.length === 0)
    return {
      target,
      sqlSlot: null,
      statementOrdinal: null,
      mode: "NONE",
      status: "NOT_PARTITIONED",
      assignments: [],
      evidence:
        evidence.length > 0
          ? evidence
          : [{ source: "SCHEDULER_CONFIG", locator: "task.target" }],
      reasonCodes: ["TABLE_NOT_PARTITIONED"],
    };
  const fields = partitionFields.fields;
  const writeEvidence: TaskPartitionEvidenceRef[] =
    evidence.length > 0
      ? evidence
      : [{ source: "SCHEDULER_CONFIG", locator: "task.target" }];
  const schedulerAssignmentEvidence = [
    ...(table === undefined ? [] : [tableRef(table)]),
    ...schedulerRefs(schedulerEvidence),
  ];
  const queryEvidence =
    querySql === undefined || !allowImplicitQueryOutput
      ? []
      : [
          {
            source: "INPUT_PACK_SQL" as const,
            locator: "sql/query.sql#implicit-target-output",
            detail:
              "fallback partition binding for a task with no explicit INSERT target",
          },
        ];
  const queryAssignments =
    querySql === undefined || !allowImplicitQueryOutput
      ? undefined
      : directQueryProjection(
          fields,
          querySql,
          [...writeEvidence, ...queryEvidence],
          true,
        );
  const addEvidence = addPartition?.evidence ?? [];
  const unknownAssignmentEvidence = [
    ...(table === undefined ? [] : [tableRef(table)]),
    ...schedulerRefs(schedulerEvidence),
    ...codeRefs(codeEvidence),
    ...queryEvidence,
  ];
  const schedulerValues = explicitFieldValues(
    schedulerEvidence?.hivePartition,
    fields,
  );
  const buildAssignments = (
    queryAssignmentsForVariant: readonly TaskPartitionAssignment[] | undefined,
  ): readonly TaskPartitionAssignment[] =>
    fields.map((field) => {
      const key = field.toLowerCase();
      const schedulerValue = schedulerValues.get(key);
      const queryAssignment = queryAssignmentsForVariant?.find(
        (item) => item.field.toLowerCase() === key,
      );
      const addAssignment = addPartition?.assignments.find(
        (item) => item.field.toLowerCase() === key,
      );
      if (schedulerValue !== undefined) {
        const schedulerAssignment = assignmentFromExplicitConfig(
          field,
          schedulerValue,
          "SCHEDULER_EXPLICIT_FIELD_VALUE",
          schedulerAssignmentEvidence,
        );
        if (
          queryAssignment?.status === "CONFIRMED" &&
          schedulerAssignment.status === "CONFIRMED" &&
          queryAssignment.value !== schedulerAssignment.value
        )
          return {
            ...unknownAssignment(
              field,
              [...schedulerAssignment.evidence, ...queryAssignment.evidence],
              "SQL_SCHEDULER_PARTITION_CONFLICT",
              "CONFLICT",
            ),
            mappingMethod: "CONFLICT" as const,
          };
        return schedulerAssignment;
      }
      if (addAssignment !== undefined && addAssignment.status !== "UNKNOWN")
        return addAssignment;
      if (queryAssignment !== undefined && queryAssignment.status !== "UNKNOWN")
        return queryAssignment;
      return unknownAssignment(
        field,
        unknownAssignmentEvidence.length > 0
          ? unknownAssignmentEvidence
          : writeEvidence,
        queryAssignments?.reason ??
          (!allowImplicitQueryOutput
            ? "SOURCE_SQL_NOT_TARGET_WRITE"
            : codeEvidence?.scriptParams === undefined
              ? "EXPLICIT_PARTITION_VALUE_NOT_FOUND"
              : "SCRIPT_PARAMS_NOT_PARTITION_MAPPING"),
      );
    });
  const assignments = buildAssignments(queryAssignments?.assignments);
  const assignmentVariants = queryAssignments?.variants?.map((variant) =>
    buildAssignments(variant),
  );
  const statusAssignments =
    assignmentVariants === undefined ? assignments : assignmentVariants.flat();
  const status: TaskPartitionStatus = statusAssignments.some(
    (item) => item.status === "CONFLICT",
  )
    ? "CONFLICT"
    : statusAssignments.some((item) => item.status === "UNKNOWN")
      ? "INCOMPLETE"
      : "COMPLETE";
  return {
    target,
    sqlSlot:
      addPartition?.sqlSlot ??
      (querySql !== undefined && allowImplicitQueryOutput ? "query" : null),
    statementOrdinal: null,
    mode:
      addPartition !== undefined ||
      (!sparkIndexMode && fields.length > 0 && fields.every((field) => schedulerValues.has(field.toLowerCase())))
        ? "STATIC"
        : querySql !== undefined && allowImplicitQueryOutput
          ? "DYNAMIC"
          : "UNKNOWN",
    status,
    assignments,
    ...(assignmentVariants === undefined ? {} : { assignmentVariants }),
    evidence: [...writeEvidence, ...queryEvidence, ...addEvidence],
    reasonCodes: [
      ...(status === "CONFLICT" ? ["SQL_SCHEDULER_PARTITION_CONFLICT"] : []),
      ...(status === "COMPLETE"
        ? ["PARTITION_EVIDENCE_COMPLETE"]
        : [
            queryAssignments?.reason ??
              (!allowImplicitQueryOutput
                ? "SOURCE_SQL_NOT_TARGET_WRITE"
                : "EXPLICIT_PARTITION_VALUE_NOT_FOUND"),
          ]),
    ],
  };
}

function targetStatus(
  partitionFieldsKnown: boolean,
  partitionFields: readonly string[],
  writes: readonly TaskPartitionWrite[],
): {
  readonly status: TaskPartitionStatus;
  readonly reasonCodes: readonly string[];
} {
  if (!partitionFieldsKnown)
    return {
      status: "UNKNOWN",
      reasonCodes: ["TABLE_PACK_PARTITION_FIELDS_UNAVAILABLE"],
    };
  if (partitionFields.length === 0)
    return {
      status: "NOT_PARTITIONED",
      reasonCodes: ["TABLE_NOT_PARTITIONED"],
    };
  if (writes.length === 0)
    return {
      status: "UNKNOWN",
      reasonCodes: ["SQL_WRITE_EVIDENCE_UNAVAILABLE"],
    };
  if (writes.some((write) => write.status === "CONFLICT"))
    return { status: "CONFLICT", reasonCodes: ["PARTITION_WRITE_CONFLICT"] };
  if (
    writes.some(
      (write) => write.status === "INCOMPLETE" || write.status === "UNKNOWN",
    )
  )
    return {
      status: "INCOMPLETE",
      reasonCodes: ["PARTITION_WRITE_VALUE_INCOMPLETE"],
    };
  return { status: "COMPLETE", reasonCodes: ["PARTITION_EVIDENCE_COMPLETE"] };
}

function sourceTemporalPartitionStatus(
  input: TaskPartitionBuildInput,
  target: string,
  partitionFields: readonly string[],
  writes: readonly TaskPartitionWrite[],
): { readonly status: TaskPartitionStatus; readonly reasonCodes: readonly string[] } | undefined {
  if (
    input.allowSourceTemporalPartitionDefault !== true ||
    input.taskTarget === undefined ||
    !sameTable(input.taskTarget, target) ||
    partitionFields.length !== 1 ||
    partitionFields[0]?.toLowerCase() !== "busi_date" ||
    writes.some((write) => write.status === "CONFLICT")
  )
    return undefined;
  if (
    writes.some(
      (write) => write.status === "INCOMPLETE" || write.status === "UNKNOWN",
    )
  )
    return {
      status: "COMPLETE",
      reasonCodes: ["PARTITION_TEMPLATE_FROM_TARGET_AND_SCHEDULER"],
    };
  return undefined;
}

function summaryCompletionStatus(
  input: TaskPartitionBuildInput,
  target: string,
  partitionFields: readonly string[],
  writes: readonly TaskPartitionWrite[],
  state: ReturnType<typeof targetStatus>,
): ReturnType<typeof targetStatus> {
  if (
    state.status !== "INCOMPLETE" ||
    input.taskTarget === undefined ||
    !sameTable(input.taskTarget, target) ||
    partitionFields.length === 0 ||
    writes.some((write) => write.status === "CONFLICT") ||
    (!input.sparkIndexMode &&
      input.allowSourceTemporalPartitionDefault !== true &&
      !(
        partitionFields.length === 1 &&
        partitionFields[0]?.toLowerCase() === "busi_date"
      )) ||
    (!input.sparkIndexMode &&
      !writes.some(
        (write) => write.sqlSlot !== null && write.mode !== "UNKNOWN",
      ) &&
      input.allowSourceTemporalPartitionDefault !== true)
  )
    return state;
  const summary = buildDynamicPartitionValue(
    {
      target,
      tableStatus: "PARTITIONED",
      fields: partitionFields,
      status: state.status,
      writes,
      reasonCodes: state.reasonCodes,
    },
    input.sql,
    true,
  );
  return summary === undefined
    ? state
    : {
        status: "COMPLETE",
        reasonCodes: ["PARTITION_SUMMARY_COMPLETE"],
      };
}

export function buildTaskPartitionEvidence(
  input: TaskPartitionBuildInput,
): TaskPartitionEvidence {
  const sqlWrites = Object.entries(input.sql).flatMap(([slot, content]) =>
    content === undefined
      ? []
      : extractSqlWrites(content)
          .filter((write) => !isSyntheticWriteTarget(write.qualifiedName))
          .map((write) => ({
            slot: slot as SqlSlot,
            content,
            write,
            target: resolveWriteTarget(input.taskTarget, write.qualifiedName),
          })),
  );
  const targetNames = [
    ...(input.taskTarget === undefined ? [] : [input.taskTarget]),
    ...sqlWrites.map((item) => item.target),
  ].filter(
    (value, index, values) =>
      values.findIndex((candidate) => sameTable(candidate, value)) === index,
  );
  const targets: TaskPartitionTarget[] = targetNames.map((target) => {
    const table = input.tables.find((candidate) =>
      sameTable(candidate.qualifiedName, target),
    );
    const createSql = input.sql.create;
    const partitionFieldEvidence = partitionFieldsFor(table, createSql, target);
    const partitionFields = partitionFieldEvidence.fields;
    const addPartition = addPartitionFromSql(
      partitionFields,
      target,
      input.sql,
    );
    const writes = sqlWrites
      .filter((item) => sameTable(item.target, target))
      .map((item) =>
        buildSqlWrite(
          table,
          target,
          item.slot,
          item.content,
          item.write,
          createSql,
          input.schedulerEvidence,
          input.codeEvidence,
          input.sparkIndexMode === true,
          input.taskTarget !== undefined &&
            sameTable(input.taskTarget, target)
            ? inferredPartitionValuesForWrite(
                target,
                partitionFields,
                item.content,
                item.write,
                createSql,
              )
            : undefined,
        ),
      );
    const effectiveWrites =
      writes.length > 0
        ? writes
        : input.taskTarget !== undefined && sameTable(input.taskTarget, target)
          ? [
              buildDirectWrite(
                table,
                target,
                input.sql.query,
                createSql,
                addPartition,
                input.schedulerEvidence,
                input.codeEvidence,
                input.allowImplicitQueryOutput,
                input.sparkIndexMode === true,
              ),
            ]
          : [];
    const rawState = targetStatus(
      partitionFieldEvidence.known,
      partitionFields,
      effectiveWrites,
    );
    const state =
      sourceTemporalPartitionStatus(
        input,
        target,
        partitionFields,
        effectiveWrites,
      ) ??
      summaryCompletionStatus(
        input,
        target,
        partitionFields,
        effectiveWrites,
        rawState,
      );
    return {
      target,
      tableStatus: !partitionFieldEvidence.known
        ? "UNKNOWN"
        : partitionFields.length === 0
          ? "NOT_PARTITIONED"
          : "PARTITIONED",
      fields: partitionFields,
      status: state.status,
      writes: effectiveWrites,
      reasonCodes: state.reasonCodes,
    };
  });
  const publicTargets =
    input.taskTarget === undefined
      ? targets.filter((target) => target.tableStatus === "PARTITIONED")
      : targets.filter((target) => sameTable(target.target, input.taskTarget!));
  const statusTargets = publicTargets.length === 1 ? publicTargets : targets;
  const statuses = statusTargets.map((target) => target.status);
  const status: TaskPartitionStatus =
    targets.length === 0
      ? "UNKNOWN"
      : statuses.every((item) => item === "NOT_PARTITIONED")
        ? "NOT_PARTITIONED"
        : statuses.includes("CONFLICT")
          ? "CONFLICT"
          : statuses.includes("UNKNOWN")
            ? "UNKNOWN"
            : statuses.includes("INCOMPLETE")
              ? "INCOMPLETE"
              : "COMPLETE";
  const reasonCodes = [
    ...new Set(statusTargets.flatMap((target) => target.reasonCodes)),
  ];
  return {
    status,
    targets,
    reasonCodes:
      reasonCodes.length > 0 ? reasonCodes : ["PARTITION_EVIDENCE_COMPLETE"],
  };
}
