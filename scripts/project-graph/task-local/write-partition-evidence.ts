import { provenSqlOutputExpressions } from "../../plans/sql-output-domain.ts";
import { extractSqlWrites } from "../../evidence/sql-write-evidence.ts";
import type { PartitionAlternative } from "./partition-alternatives.ts";
import { createPartitionValueResolver, createPartitionValueDomainResolver } from "./partition-value-propagation.ts";
import {
  canonicalPartitionValue,
  isRuntimeTemplateExpression,
  isTemporalPartitionColumn,
} from "./partition-canonical.ts";

export interface WritePartitionPart {
  readonly mayBeNull?: boolean;
  readonly alternatives?: readonly PartitionAlternative[];
  readonly column: string;
  readonly values: readonly string[];
  readonly valueStatus?: string;
  readonly observedValue?: string | null;
  readonly expression?: string;
  readonly partitionStatus?: string;
  readonly reason?: WritePartitionReason;
}

export interface WritePartitionFacts {
  readonly provenance?: unknown;
  readonly write_observation_id?: unknown;
  readonly physical_dataset?: unknown;
  readonly partition_mode?: unknown;
  readonly partition_status?: unknown;
  readonly partition_binding_status?: unknown;
  readonly partition_columns?: unknown;
  readonly partition_assignments?: unknown;
}

type FactRecord = Record<string, unknown>;

function record(value: unknown): FactRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as FactRecord : null;
}

/** Only project -> filter -> read: no joins, subqueries or inferred aliases. */
function filteredDirectColumnLiteral(
  expression: FactRecord,
  relations: ReadonlyMap<string | null, FactRecord>,
): string | null {
  const raw = text(expression.expression_text);
  if (!raw || !/^(?:[A-Za-z_][\w$]*\.)?[A-Za-z_][\w$]*$/u.test(raw)) return null;
  const inputs = Array.isArray(expression.input_fields) ? expression.input_fields : [];
  if (inputs.length !== 1) return null;
  const input = record(inputs[0]);
  const table = text(input?.table)?.toLowerCase(), column = text(input?.column)?.toLowerCase();
  if (!table || !column || raw.split(".").at(-1)?.toLowerCase() !== column) return null;
  const project = record(relations.get(text(expression.relation_id))?.relation);
  const filter = record(relations.get(text(project?.source))?.relation);
  const read = record(relations.get(text(filter?.source))?.relation);
  if (project?.type !== "project" || filter?.type !== "filter" || read?.type !== "read" ||
    text(read.table)?.toLowerCase() !== table) return null;
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    const node = record(value);
    if (node?.kind === "AND" && Array.isArray(node.children)) {
      node.children.forEach(visit);
      return;
    }
    // An atom under OR/NOT does not constrain every output row.
    if (node?.kind !== "ATOM" || !["EQ", "IN"].includes(String(node.operator))) return;
    const operands = Array.isArray(node.operands) ? node.operands.map(record) : [];
    if (operands.length !== 2 || operands[0]?.kind !== "COLUMN" || operands[1]?.kind !== "LITERAL") return;
    const ref = record(operands[0].column);
    const physical = Array.isArray(ref?.physical) ? ref.physical : [];
    const origin = physical.length === 1 ? record(physical[0]) : null;
    if (ref?.resolution !== "PHYSICAL" || text(origin?.table)?.toLowerCase() !== table ||
      text(origin?.column)?.toLowerCase() !== column) return;
    const literal = literalFromExpression(operands[1].expression);
    if (literal !== null) found.add(literal);
  };
  visit(filter.predicate_tree);
  return found.size === 1 ? [...found][0]! : null;
}

type WritePartitionReason =
  | "DYNAMIC_PARTITION_BINDING_MISSING"
  | "DYNAMIC_PARTITION_EXPRESSION_ROOT_MISSING"
  | "DYNAMIC_PARTITION_EXPRESSION_TEXT_MISSING"
  | "DYNAMIC_PARTITION_UNSUPPORTED_EXPRESSION_ROLE"
  | "DYNAMIC_PARTITION_RELATION_LOOP_OR_MISSING"
  | "DYNAMIC_PARTITION_SETOP_NOT_UNION"
  | "DYNAMIC_PARTITION_BRANCHES_MISSING"
  | "DYNAMIC_PARTITION_BRANCH_ORDINAL_MISSING"
  | "DYNAMIC_PARTITION_OUTPUT_REFERENCE_UNRESOLVED"
  | "DYNAMIC_PARTITION_OUTPUT_REFERENCE_NOT_UNIQUE"
  | "DYNAMIC_PARTITION_EXPRESSION_NOT_LITERAL"
  | "DYNAMIC_PARTITION_UNION_BRANCH_CONFLICT"
  | "DYNAMIC_PARTITION_EXPRESSION_UNRESOLVED";

function splitExpressionAlias(value: string): { expression: string; alias?: string } {
  const trimmed = value.trim();
  const alias = trimmed.match(/^(.*?)[ \t]+(?:AS[ \t]+)?[`"]?([A-Za-z_][A-Za-z0-9_$]*)[`"]?$/iu);
  if (!alias) return { expression: trimmed };
  return { expression: alias[1]!.trim(), alias: alias[2]!.trim() };
}

function literalFromExpression(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const { expression } = splitExpressionAlias(value);
  const quote = expression[0];
  if (quote === "'" || quote === '"') {
    if (expression.at(-1) !== quote) return null;
    let result = "";
    for (let index = 1; index < expression.length - 1; index += 1) {
      const current = expression[index]!;
      if (current === "\\" && index + 1 < expression.length - 1) {
        result += expression[++index]!;
      } else if (current === quote) {
        if (expression[index + 1] !== quote) return null;
        result += quote;
        index += 1;
      } else result += current;
    }
    return result;
  }
  if (isRuntimeTemplateExpression(expression)) return expression;
  return /^(?:[-+]?\d+(?:\.\d+)?|true|false)$/iu.test(expression)
    ? expression
    : null;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function resolveOutputReference(expression: string, field: string, sql: string | null): { expression: string | undefined; reason?: WritePartitionReason } {
  if (literalFromExpression(expression) !== null) return { expression };
  if (!/^(?:[`"]?[A-Za-z_][A-Za-z0-9_$]*[`"]?\.)?[`"]?[A-Za-z_][A-Za-z0-9_$]*[`"]?$/u.test(expression)) return { expression };
  const values = sql ? provenSqlOutputExpressions(sql, field) : null;
  return values?.length === 1 ? { expression: values[0] } : {
    expression: undefined, reason: values ? "DYNAMIC_PARTITION_OUTPUT_REFERENCE_NOT_UNIQUE" : "DYNAMIC_PARTITION_OUTPUT_REFERENCE_UNRESOLVED",
  };
}

type DynamicPartitionResolution =
  | { readonly state: "SKIP" }
  | {
      readonly state: "RESOLVED";
      readonly expression: string;
      readonly value: string;
      readonly alternatives?: readonly PartitionAlternative[];
      readonly mayBeNull?: boolean;
      readonly valueStatus: "OBSERVED_RENDERED_VALUE" | "RUNTIME_EXPRESSION";
    }
  | { readonly state: "UNRESOLVED"; readonly reason: WritePartitionReason };

type ResolvedDynamicExpression =
  | { readonly ok: false; readonly reason: WritePartitionReason }
  | {
      readonly ok: true;
      readonly expression: string;
      readonly value: string;
      readonly canonical: string;
      readonly valueStatus: "OBSERVED_RENDERED_VALUE" | "RUNTIME_EXPRESSION";
    };

function dynamicPartitionResolution(
  facts: WritePartitionFacts,
  writeObservationId: string,
  field: string,
  bindings: readonly FactRecord[],
  expressions: readonly FactRecord[],
  relations: readonly FactRecord[],
  statementSql: string | null,
  materializations: readonly FactRecord[],
): DynamicPartitionResolution {
  const assignments = Array.isArray(facts.partition_assignments) ? facts.partition_assignments : [];
  const assignment = assignments.find((item) => item && typeof item === "object" && !Array.isArray(item) &&
    text((item as FactRecord).field)?.toLowerCase() === field.toLowerCase());
  if (!assignment || text((assignment as FactRecord).status)?.toUpperCase() !== "CONFIRMED" ||
    text((assignment as FactRecord).mapping_method)?.toUpperCase() !== "DYNAMIC_PARTITION_OUTPUT_ORDINAL") return { state: "SKIP" };
  const binding = bindings.find((item) => text(item.write_observation_id) === writeObservationId &&
    text(item.target_field)?.toLowerCase() === field.toLowerCase() &&
    text(item.binding_status)?.toUpperCase() === "RESOLVED" &&
    Number.isInteger(Number(item.source_ordinal)));
  if (!binding) return { state: "UNRESOLVED", reason: "DYNAMIC_PARTITION_BINDING_MISSING" };
  const expressionId = text(binding.expression_id);
  const root = expressionId ? expressions.find((item) => text(item.expression_id) === expressionId) : undefined;
  if (!root) return { state: "UNRESOLVED", reason: "DYNAMIC_PARTITION_EXPRESSION_ROOT_MISSING" };
  // A single partition column has no cross-column tuple correlation to lose.
  // Preserve possible SQL NULL separately from its complete non-NULL value set.
  if (factColumns(facts).length === 1) {
    const resolverInput = { bindings, expressions, relations, materializations, literal: literalFromExpression };
    const domain = createPartitionValueDomainResolver(resolverInput)(root);
    const certain = createPartitionValueResolver(resolverInput);
    const witnessedValues = (expression: FactRecord, active = new Set<string>()): readonly string[] => {
      const id = text(expression.expression_id);
      if (!id || active.has(id)) return [];
      const known = certain(expression);
      if (known) return known;
      if (expression.role !== "SETOP_OUTPUT") return [];
      const body = record(relations.find(r => r.relation_id === expression.relation_id)?.relation);
      if (body?.type !== "setop" || body.setop !== "union" || !Array.isArray(body.branches)) return [];
      return body.branches.flatMap(branch => expressions.filter(e => e.relation_id === branch && e.ordinal === expression.ordinal)
        .flatMap(e => witnessedValues(e, new Set(active).add(id))));
    };
    const witnesses = new Set(witnessedValues(root).map(value => canonicalPartitionValue(field, value)));
    // Bounds alone cannot confirm an output value. Each non-NULL value also
    // needs a branch whose value is proven without nullable-side assumptions.
    if (domain?.mayBeNull && domain.values.length && domain.values.every(value => !isRuntimeTemplateExpression(value) &&
      witnesses.has(canonicalPartitionValue(field, value)))) {
      const values = [...new Set(domain.values)];
      return { state: "RESOLVED", value: values[0]!, expression: quoteSqlLiteral(values[0]!),
        valueStatus: "OBSERVED_RENDERED_VALUE", mayBeNull: true,
        ...(values.length > 1 ? { alternatives: values.map((value, index) => ({
          key: `value-domain:${index}`, value, expression: quoteSqlLiteral(value), valueStatus: "OBSERVED_RENDERED_VALUE",
        })) } : {}),
      };
    }
  }
  const ordinal = Number(binding.source_ordinal);
  const relationById = new Map(relations.map((item) => [text(item.relation_id), item]));
  const referenceValues = createPartitionValueResolver({ bindings, expressions, relations, materializations, literal: literalFromExpression });
  const leafExpressionTexts = (
    expression: FactRecord,
    active = new Set<string>(),
  ): { readonly texts: readonly string[]; readonly keys?: readonly string[]; readonly reason?: WritePartitionReason } => {
    if (text(expression.role)?.toUpperCase() === "PROJECT_EXPRESSION") {
      const propagated = literalFromExpression(expression.expression_text) === null ? referenceValues(expression) : null;
      // Multi-column domains need a shared branch key. Never combine independent value sets.
      if (propagated?.length && (propagated.length === 1 || factColumns(facts).length === 1)) {
        return { texts: propagated.map(quoteSqlLiteral), keys: propagated.map((_, index) => propagated.length === 1
          ? text(expression.relation_id) ?? "root" : `${text(expression.relation_id)}:${index}`) };
      }
      const filteredValue = filteredDirectColumnLiteral(expression, relationById);
      if (filteredValue !== null) return { texts: [quoteSqlLiteral(filteredValue)], keys: [text(expression.relation_id) ?? "root"] };
      const expressionText = text(expression.expression_text);
      return expressionText
        ? { texts: [expressionText], keys: [text(expression.relation_id) ?? "root"] }
        : { texts: [], reason: "DYNAMIC_PARTITION_EXPRESSION_TEXT_MISSING" };
    }
    if (text(expression.role)?.toUpperCase() !== "SETOP_OUTPUT") {
      return { texts: [], reason: "DYNAMIC_PARTITION_UNSUPPORTED_EXPRESSION_ROLE" };
    }
    const relationId = text(expression.relation_id);
    if (!relationId || active.has(relationId)) {
      return { texts: [], reason: "DYNAMIC_PARTITION_RELATION_LOOP_OR_MISSING" };
    }
    const relation = relationById.get(relationId);
    const body = relation?.relation;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      text((body as FactRecord).type)?.toLowerCase() !== "setop" ||
      text((body as FactRecord).setop)?.toLowerCase() !== "union") {
      return { texts: [], reason: "DYNAMIC_PARTITION_SETOP_NOT_UNION" };
    }
    const branchValues = (body as FactRecord).branches;
    const branches: string[] = Array.isArray(branchValues) ? branchValues.map(String) : [];
    if (branches.length === 0) {
      return { texts: [], reason: "DYNAMIC_PARTITION_BRANCHES_MISSING" };
    }
    const next = new Set(active).add(relationId);
    const branchTexts: string[][] = [];
    const branchKeys: string[] = [];
    for (const branchId of branches) {
      const branchRelation = relationById.get(branchId);
      const branchExpressions = expressions.filter((item) => text(item.relation_id) === branchId && Number(item.ordinal) === ordinal);
      if (!branchRelation || branchExpressions.length === 0) {
        return {
          texts: [],
          reason: "DYNAMIC_PARTITION_BRANCH_ORDINAL_MISSING",
        };
      }
      const nested = branchExpressions
        .map((item) => leafExpressionTexts(item, next));
      const unresolved = nested.find((item) => item.texts.length === 0);
      if (unresolved) return unresolved;
      branchTexts.push(nested.flatMap((item) => item.texts));
      branchKeys.push(...nested.flatMap(item => item.keys ?? []));
    }
    return { texts: branchTexts.flat(), keys: branchKeys };
  };
  const textResolution = leafExpressionTexts(root);
  if (textResolution.texts.length === 0) {
    return {
      state: "UNRESOLVED",
      reason: textResolution.reason ?? "DYNAMIC_PARTITION_EXPRESSION_UNRESOLVED",
    };
  }
  const resolved: ResolvedDynamicExpression[] = textResolution.texts.map((rawExpression) => {
    const { expression } = splitExpressionAlias(rawExpression);
    const reference = resolveOutputReference(expression, field, statementSql);
    if (reference.expression === undefined) {
      return {
        ok: false as const,
        reason: reference.reason ?? "DYNAMIC_PARTITION_OUTPUT_REFERENCE_UNRESOLVED",
      };
    }
    const value = literalFromExpression(reference.expression);
    if (value === null) {
      return {
        ok: false as const,
        reason: "DYNAMIC_PARTITION_EXPRESSION_NOT_LITERAL",
      };
    }
    return {
      ok: true as const,
      expression: reference.expression,
      value,
      canonical: canonicalPartitionValue(field, value),
      valueStatus: isRuntimeTemplateExpression(value)
        ? "RUNTIME_EXPRESSION" as const
        : "OBSERVED_RENDERED_VALUE" as const,
    };
  });
  const unresolved = resolved.find((item) => !item.ok);
  if (unresolved && !unresolved.ok) {
    return { state: "UNRESOLVED", reason: unresolved.reason };
  }
  const comparable = resolved.filter((item): item is Extract<ResolvedDynamicExpression, { ok: true }> => item.ok);
  if (comparable.length === 0) {
    return { state: "UNRESOLVED", reason: "DYNAMIC_PARTITION_EXPRESSION_UNRESOLVED" };
  }
  const alternatives = new Set(comparable.map(item => item.canonical)).size > 1 ? comparable.map((item, index) => ({
    key: textResolution.keys![index]!, value: item.value,
    expression: item.expression, valueStatus: item.valueStatus,
  })) : undefined;
  const best = comparable.find((item) => item.valueStatus === "OBSERVED_RENDERED_VALUE") ?? comparable[0]!;
  return {
    state: "RESOLVED",
    expression: best.expression,
    value: best.value,
    alternatives,
    valueStatus: comparable.some((item) => item.valueStatus === "RUNTIME_EXPRESSION")
      ? "RUNTIME_EXPRESSION"
      : best.valueStatus,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTableName(value: string): string {
  return value.replace(/[`"\[\]]/g, "").replace(/\s+/g, "").toLowerCase();
}

function normalizeColumnName(value: string): string {
  return normalizeTableName(value);
}

function tablesMatch(left: string, right: string): boolean {
  const a = normalizeTableName(left);
  const b = normalizeTableName(right);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function partFromPackEntry(column: string, value: string): WritePartitionPart {
  return {
    column,
    values: [canonicalPartitionValue(column, value)],
    valueStatus: isRuntimeTemplateExpression(value) ? "RUNTIME_EXPRESSION" : "OBSERVED_RENDERED_VALUE",
    observedValue: value,
    expression: value,
    partitionStatus: "STATIC",
  };
}

function partsFromPackPartition(
  packPartition: Record<string, unknown>,
): WritePartitionPart[] {
  return Object.entries(packPartition)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([column, value]) => partFromPackEntry(column, value));
}

function partsFromSqlExtract(
  qualifiedName: string,
  statementSql: string,
): { matched: boolean; parts: WritePartitionPart[] } {
  const extracted = extractSqlWrites(statementSql).filter((write) =>
    tablesMatch(qualifiedName, write.qualifiedName),
  );
  if (extracted.length !== 1) return { matched: false, parts: [] };
  return {
    matched: true,
    parts: extracted[0]!.partition.map((part) => {
      const column = part.field.trim();
      const raw = part.observedValue ?? part.expression;
      return {
        column,
        values: part.valueStatus === "UNKNOWN" ? [] : [canonicalPartitionValue(column, raw)],
        valueStatus: part.valueStatus,
        observedValue: part.observedValue,
        expression: part.expression,
        partitionStatus:
          part.valueStatus === "UNKNOWN" ? "DYNAMIC" : extracted[0]!.partitionMode === "NONE" ? "NON_PARTITIONED" : "STATIC",
      };
    }),
  };
}

function factColumns(facts: WritePartitionFacts): string[] {
  const assignments = Array.isArray(facts.partition_assignments)
    ? facts.partition_assignments
    : [];
  const fromAssignments = assignments.flatMap((assignment) => {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment))
      return [];
    const field = text((assignment as Record<string, unknown>).field);
    return field ? [field] : [];
  });
  const fromColumns = Array.isArray(facts.partition_columns)
    ? facts.partition_columns.flatMap((column) => {
        const value = text(column);
        return value ? [value] : [];
      })
    : [];
  return [...new Set([...fromAssignments, ...fromColumns].map((column) => column.toLowerCase()))];
}

function factsHaveConflict(facts: WritePartitionFacts): boolean {
  if (text(facts.partition_status)?.toUpperCase() === "CONFLICT") return true;
  const bindingStatus = text(facts.partition_binding_status)?.toUpperCase();
  if (bindingStatus === "CONFLICT") return true;
  return Array.isArray(facts.partition_assignments) && facts.partition_assignments.some(
    (assignment) => {
      if (!assignment || typeof assignment !== "object" || Array.isArray(assignment))
        return true;
      const status = text((assignment as Record<string, unknown>).status)?.toUpperCase();
      return status === "CONFLICT";
    },
  );
}

function partsFromPackAlternatives(value: readonly unknown[], columns: readonly string[]): WritePartitionPart[] | null {
  if (!value.length || !columns.length) return null;
  const rows = value.map(record);
  if (rows.some(row => !row || Object.keys(row).length !== columns.length ||
    columns.some(column => typeof row[column] !== "string" || !String(row[column]).trim()))) return null;
  return columns.map(column => {
    const alternatives = rows.map((row, index) => ({ key: `pack:${index}`, value: String(row![column]),
      valueStatus: isRuntimeTemplateExpression(String(row![column])) ? "RUNTIME_EXPRESSION" : "OBSERVED_RENDERED_VALUE",
      expression: String(row![column]) }));
    return { column, values: [...new Set(alternatives.map(a => canonicalPartitionValue(column, a.value)))],
      valueStatus: alternatives.some(a => a.valueStatus === "RUNTIME_EXPRESSION") ? "RUNTIME_EXPRESSION" : "OBSERVED_RENDERED_VALUE",
      partitionStatus: "STATIC", alternatives };
  });
}

function factsHaveUnknownBinding(facts: WritePartitionFacts): boolean {
  const bindingStatus = text(facts.partition_binding_status)?.toUpperCase();
  if (bindingStatus === "UNKNOWN") return true;
  return Array.isArray(facts.partition_assignments) && facts.partition_assignments.some(
    (assignment) => {
      if (!assignment || typeof assignment !== "object" || Array.isArray(assignment))
        return true;
      return text((assignment as Record<string, unknown>).status)?.toUpperCase() === "UNKNOWN";
    },
  );
}

function unknownParts(
  facts: WritePartitionFacts | null,
  status = "UNKNOWN",
): WritePartitionPart[] {
  const columns = facts ? factColumns(facts) : [];
  return (columns.length > 0 ? columns : ["__unresolved_partition__"]).map(
    (column) => ({ column, values: [], valueStatus: "UNKNOWN", partitionStatus: status }),
  );
}

function packTargetMatches(packTarget: unknown, qualifiedName: string): boolean {
  if (!packTarget || typeof packTarget !== "object" || Array.isArray(packTarget))
    return false;
  const targetName = text((packTarget as Record<string, unknown>).qualifiedName);
  return targetName !== null && tablesMatch(targetName, qualifiedName);
}

function factsBindThisWrite(
  facts: WritePartitionFacts | null,
  writeObservationId: string | null,
  qualifiedName: string,
): boolean {
  return (
    facts !== null &&
    writeObservationId !== null &&
    text(facts.write_observation_id) === writeObservationId &&
    text(facts.physical_dataset) !== null &&
    tablesMatch(text(facts.physical_dataset)!, qualifiedName)
  );
}

function sameColumns(left: readonly WritePartitionPart[], right: readonly string[]): boolean {
  if (right.length === 0) return true;
  const actual = new Set(left.map((part) => part.column.toLowerCase()));
  return actual.size === right.length && right.every((column) => actual.has(column));
}

function hasExactNonEmptyFactColumns(
  parts: readonly WritePartitionPart[],
  facts: WritePartitionFacts,
): boolean {
  const columns = factColumns(facts);
  return columns.length > 0 && parts.length === columns.length && sameColumns(parts, columns);
}

/** Resolve write-side partition parts using only evidence bound to this write observation. */
export function buildWritePartitionParts(input: {
  readonly qualifiedName: string;
  readonly statementSql: string | null;
  readonly packPartition: Record<string, unknown> | readonly Record<string, unknown>[] | null;
  readonly packTarget?: unknown;
  readonly factsWrite?: WritePartitionFacts | null;
  readonly writeObservationId?: string | null;
  /** Number of final write occurrences for this physical target only. */
  readonly targetWriteCount?: number;
  readonly bindings?: readonly FactRecord[];
  readonly expressions?: readonly FactRecord[];
  readonly relations?: readonly FactRecord[];
  readonly materializations?: readonly FactRecord[];
}): WritePartitionPart[] {
  const facts = input.factsWrite ?? null;
  const mode = text(facts?.partition_mode)?.toUpperCase() ?? null;
  const boundFacts = factsBindThisWrite(
    facts,
    input.writeObservationId ?? null,
    input.qualifiedName,
  );
  const canUsePack =
    boundFacts &&
    input.targetWriteCount === 1 &&
    packTargetMatches(input.packTarget, input.qualifiedName);
  const protectPackParts = (parts: WritePartitionPart[]): WritePartitionPart[] => {
    if (facts?.provenance !== "PLATFORM_TARGET") return parts;
    // Legacy Pack values may contain only constants found in nested aliases.
    // COMPLETE describes the old binding, not completeness of a CASE/UNION
    // value domain. Re-prove SQL-derived business fields before using them to
    // exclude writers. Explicit scheduler assignments remain authoritative;
    // temporal fields retain the approved process-grain matching policy.
    return parts.map(part => {
      const assignments: FactRecord[] = Array.isArray(facts.partition_assignments) ? facts.partition_assignments : [];
      const assignment = assignments.find(a =>
        normalizeColumnName(String(a.field ?? "")) === normalizeColumnName(part.column));
      if (isTemporalPartitionColumn(part.column) || assignment?.mapping_method === "SCHEDULER_EXPLICIT_FIELD_VALUE") return part;
      const domain = input.statementSql ? provenSqlOutputExpressions(input.statementSql, part.column) : null;
      const values = domain?.map(literalFromExpression);
      const actual = new Set(part.values);
        if (values?.length && values.every(value => value !== null && actual.has(value)) &&
          part.values.every(value => values.includes(value))) return part;
        // A proven scalar output replaces stale text-derived candidates (for
        // example constants belonging to joined lookup tables). A singleton
        // cannot lose cross-column tuple correlation. Multi-value mismatches
        // stay UNKNOWN rather than constructing unproven Cartesian tuples.
        if (values?.length === 1 && values[0] !== null) {
          return { column: part.column, values: [values[0]!], observedValue: values[0],
            expression: domain![0], valueStatus: isRuntimeTemplateExpression(values[0]!) ? "RUNTIME_EXPRESSION" : "OBSERVED_RENDERED_VALUE",
            partitionStatus: "STATIC" };
        }
      return { column: part.column, values: [], valueStatus: "UNKNOWN", partitionStatus: "UNKNOWN",
        reason: "DYNAMIC_PARTITION_OUTPUT_REFERENCE_UNRESOLVED" };
    });
  };
  const packParts =
    canUsePack &&
    input.packPartition &&
    !Array.isArray(input.packPartition) &&
    !("schemaVersion" in input.packPartition)
      ? protectPackParts(partsFromPackPartition(input.packPartition as Record<string, unknown>))
      : [];

  if (boundFacts && factsHaveConflict(facts!))
    return unknownParts(facts, "CONFLICT");
  if (canUsePack && facts?.provenance === "PLATFORM_TARGET" && Array.isArray(input.packPartition) &&
    text(facts.partition_binding_status)?.toUpperCase() === "COMPLETE") {
    const alternatives = partsFromPackAlternatives(input.packPartition, factColumns(facts));
    if (alternatives) {
      return protectPackParts(alternatives);
    }
  }
  if (boundFacts && mode === "UNKNOWN") {
    if (canUsePack && hasExactNonEmptyFactColumns(packParts, facts!)) return packParts;
    return unknownParts(facts);
  }
  if (boundFacts && factsHaveUnknownBinding(facts!)) return unknownParts(facts);
  if (boundFacts && (mode === "DYNAMIC" || mode === "MIXED")) {
    const assignments = Array.isArray(facts!.partition_assignments) ? facts!.partition_assignments : [];
    const mixedSql = mode === "MIXED" && input.statementSql ? partsFromSqlExtract(input.qualifiedName, input.statementSql) : null;
    const parts = assignments.flatMap((assignment) => {
      if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) return [];
      const field = text((assignment as FactRecord).field);
      if (!field) return [];
      if (mode === "MIXED" && text((assignment as FactRecord).mapping_method) === "STATIC_SQL_ASSIGNMENT") {
        const part = mixedSql?.parts.find(part => normalizeColumnName(part.column) === normalizeColumnName(field));
        return part && part.valueStatus !== "UNKNOWN" ? [part] : [];
      }
      const resolved = dynamicPartitionResolution(
        facts!,
        input.writeObservationId!,
        field,
        input.bindings ?? [],
        input.expressions ?? [],
        input.relations ?? [],
        input.statementSql,
        input.materializations ?? [],
      );
      const packPart = packParts.find(
        (part) =>
          normalizeColumnName(part.column) === normalizeColumnName(field) &&
          isTemporalPartitionColumn(field),
      );
      if (resolved.state === "SKIP") return packPart ? [packPart] : [];
      if (resolved.state === "UNRESOLVED") {
        // The Pack has already bound this one target write's temporal period.
        // An unresolved dynamic SQL output must not discard that date evidence.
        if (packPart) return [packPart];
        return [{
          column: field,
          values: [],
          valueStatus: "UNKNOWN",
          observedValue: null,
          expression: undefined,
          partitionStatus: "UNKNOWN",
          reason: resolved.reason,
        }];
      }
      return [{
        column: field,
        values: [...new Set((resolved.alternatives?.map(a => a.value) ?? [resolved.value]).map(value => canonicalPartitionValue(field, value)))],
        valueStatus: resolved.valueStatus,
        observedValue: resolved.alternatives || resolved.mayBeNull ? null : resolved.value,
        expression: resolved.alternatives || resolved.mayBeNull ? undefined : resolved.expression,
        ...(resolved.mayBeNull ? { mayBeNull: true } : {}),
        ...(resolved.alternatives ? { alternatives: resolved.alternatives } : {}),
        partitionStatus: "STATIC",
      }];
    });
    return parts.length === assignments.length && parts.length > 0 ? parts : unknownParts(facts, "DYNAMIC");
  }

  const sql = input.statementSql
    ? partsFromSqlExtract(input.qualifiedName, input.statementSql)
    : { matched: false, parts: [] };
  if (boundFacts && mode === "NONE")
    return sql.matched && sql.parts.length > 0 ? unknownParts(facts) : [];
  if (sql.matched && sql.parts.length > 0) {
    if (boundFacts && mode !== null && !sameColumns(sql.parts, factColumns(facts!)))
      return unknownParts(facts);
    return sql.parts;
  }

  if (packParts.length > 0) {
    const parts = packParts;
    if (mode !== null && !sameColumns(parts, factColumns(facts!)))
      return unknownParts(facts);
    return parts;
  }
  return unknownParts(facts);
}
