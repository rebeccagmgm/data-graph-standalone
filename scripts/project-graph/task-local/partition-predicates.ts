import type { JsonRecord } from "../../query/current-task-bundle.ts";
import {
  canonicalPartitionValue,
  isRuntimeTemplateExpression,
} from "./partition-canonical.ts";

export interface PartitionPredicate {
  readonly column: string;
  readonly values: readonly string[];
}

export type PartitionPredicateStatus =
  | "NONE"
  | "LITERAL"
  | "NON_LITERAL_PRESENT";

export interface ReadPartitionPredicates {
  readonly status: PartitionPredicateStatus;
  readonly predicates: readonly PartitionPredicate[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function records(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
      (item): item is JsonRecord =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    : [];
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function relationIdOf(row: JsonRecord): string | null {
  return text(row.relation_id) ?? text(record(row.relation)?.id);
}

function relationTypeOf(row: JsonRecord): string {
  return (
    text(row.relation_type)
    ?? text(record(row.relation)?.type)
    ?? ""
  ).toLowerCase();
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function literalValue(operand: JsonRecord): string | null {
  if (text(operand.kind)?.toUpperCase() !== "LITERAL") return null;
  const observed = text(operand.observedValue);
  if (observed) return observed;
  const expression = text(operand.expression);
  return expression ? stripQuotes(expression) : null;
}

function comparablePartitionLiteral(operand: JsonRecord): string | null {
  const value = literalValue(operand);
  if (!value) return null;
  return value;
}

function columnName(operand: JsonRecord): string | null {
  if (text(operand.kind)?.toUpperCase() !== "COLUMN") return null;
  const column = record(operand.column);
  return text(column?.name) ?? text(operand.expression);
}

function atomIsLiteralEqOrIn(node: JsonRecord): boolean {
  const operator = text(node.operator)?.toUpperCase();
  if (operator !== "EQ" && operator !== "IN") return false;
  const operands = records(node.operands);
  if (operands.length < 2) return false;
  if (!columnName(operands[0]!)) return false;
  return operands.slice(1).every((operand) => comparablePartitionLiteral(operand) !== null);
}

function walkPredicateAtoms(
  tree: unknown,
  visit: (atom: JsonRecord) => void,
): void {
  const node = record(tree);
  if (!node) return;
  const kind = text(node.kind)?.toUpperCase();
  if (kind === "AND" || kind === "OR") {
    for (const child of records(node.children)) walkPredicateAtoms(child, visit);
    return;
  }
  if (kind === "ATOM") visit(node);
}

/** Only EQ / IN literals — value-set shape for producer partition matching. */
function collectLiteralPredicates(
  tree: unknown,
  into: Map<string, { column: string; values: Set<string> }>,
): void {
  walkPredicateAtoms(tree, (atom) => {
    if (!atomIsLiteralEqOrIn(atom)) return;
    const operands = records(atom.operands);
    const column = columnName(operands[0]!);
    if (!column) return;
    const values = operands.slice(1).map((operand) => {
      const raw = comparablePartitionLiteral(operand)!;
      return isRuntimeTemplateExpression(raw)
        ? canonicalPartitionValue(column, raw)
        : raw;
    });
    const key = column.toLowerCase();
    const existing = into.get(key) ?? { column, values: new Set<string>() };
    for (const value of values) existing.values.add(value);
    into.set(key, existing);
  });
}

function classifyFilterTree(tree: unknown): {
  readonly predicates: PartitionPredicate[];
  readonly hasAtom: boolean;
  readonly hasNonLiteralAtom: boolean;
} {
  const collected = new Map<string, { column: string; values: Set<string> }>();
  collectLiteralPredicates(tree, collected);
  let hasAtom = false;
  let hasNonLiteralAtom = false;
  walkPredicateAtoms(tree, (atom) => {
    hasAtom = true;
    if (!atomIsLiteralEqOrIn(atom)) hasNonLiteralAtom = true;
  });
  const predicates = [...collected.values()]
    .map((entry) => ({
      column: entry.column,
      values: [...entry.values].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.column.localeCompare(right.column));
  return { predicates, hasAtom, hasNonLiteralAtom };
}

function mergePredicates(
  left: readonly PartitionPredicate[],
  right: readonly PartitionPredicate[],
): PartitionPredicate[] {
  const merged = new Map<string, { column: string; values: Set<string> }>();
  for (const predicate of [...left, ...right]) {
    const key = predicate.column.toLowerCase();
    const existing = merged.get(key) ?? {
      column: predicate.column,
      values: new Set<string>(),
    };
    for (const value of predicate.values) existing.values.add(value);
    merged.set(key, existing);
  }
  return [...merged.values()]
    .map((entry) => ({
      column: entry.column,
      values: [...entry.values].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.column.localeCompare(right.column));
}

/**
 * Map read relation id → literal FILTER predicates from downstream filters on
 * the read's plan subtree (read → … → filter).
 */
export function partitionPredicatesByReadOccurrence(input: {
  readonly taskId: string;
  readonly relationRecords: readonly JsonRecord[];
  readonly relationEdgeRecords: readonly JsonRecord[];
}): ReadonlyMap<string, ReadPartitionPredicates> {
  const filters = new Map<string, ReturnType<typeof classifyFilterTree>>();
  for (const row of input.relationRecords) {
    if (text(row.task_id) !== null && text(row.task_id) !== input.taskId) continue;
    if (relationTypeOf(row) !== "filter") continue;
    const id = relationIdOf(row);
    if (!id) continue;
    const relation = record(row.relation) ?? row;
    filters.set(id, classifyFilterTree(relation.predicate_tree));
  }

  const downstream = new Map<string, string[]>();
  for (const edge of input.relationEdgeRecords) {
    if (text(edge.task_id) !== null && text(edge.task_id) !== input.taskId) continue;
    const from = text(edge.from_relation_id);
    const to = text(edge.to_relation_id);
    if (!from || !to) continue;
    const next = downstream.get(from) ?? [];
    next.push(to);
    downstream.set(from, next);
  }

  const filtersAboveRead = new Map<string, ReturnType<typeof classifyFilterTree>>();
  for (const startId of [...downstream.keys()]) {
    const merged = {
      predicates: [] as PartitionPredicate[],
      hasFilter: false,
      hasNonLiteralAtom: false,
    };
    const visited = new Set<string>();
    const queue = [startId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const classified = filters.get(current);
      if (classified) {
        merged.hasFilter = true;
        merged.hasNonLiteralAtom =
          merged.hasNonLiteralAtom || classified.hasNonLiteralAtom;
        merged.predicates = mergePredicates(
          merged.predicates,
          classified.predicates,
        );
      }
      for (const next of downstream.get(current) ?? []) queue.push(next);
    }
    if (merged.hasFilter) {
      filtersAboveRead.set(startId, {
        predicates: merged.predicates,
        hasAtom: merged.hasFilter,
        hasNonLiteralAtom: merged.hasNonLiteralAtom,
      });
    }
  }

  const byOccurrence = new Map<string, {
    predicates: PartitionPredicate[];
    hasFilter: boolean;
    hasNonLiteralAtom: boolean;
  }>();
  for (const [occurrenceId, classified] of filtersAboveRead) {
    byOccurrence.set(occurrenceId, {
      predicates: classified.predicates,
      hasFilter: classified.hasAtom,
      hasNonLiteralAtom: classified.hasNonLiteralAtom,
    });
  }

  const result = new Map<string, ReadPartitionPredicates>();
  for (const [occurrenceId, entry] of byOccurrence) {
    const status: PartitionPredicateStatus = !entry.hasFilter
      ? "NONE"
      : entry.hasNonLiteralAtom
      ? "NON_LITERAL_PRESENT"
      : "LITERAL";
    result.set(occurrenceId, { status, predicates: entry.predicates });
  }
  return result;
}

export function readPartitionPredicatesForOccurrence(
  byOccurrence: ReadonlyMap<string, ReadPartitionPredicates>,
  relationId: string | null,
): ReadPartitionPredicates {
  if (!relationId) return { status: "NONE", predicates: [] };
  return byOccurrence.get(relationId) ?? { status: "NONE", predicates: [] };
}
