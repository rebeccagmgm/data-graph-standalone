import type { JsonRecord } from "../../../../../query/current-task-bundle.ts";
import type { PredicateTree } from "../../../../../plans/plan-contract.ts";
import {
  resolveReadPartitionScope,
  type ReadPartitionScope,
} from "../../../../../evidence/sql-read-scope.ts";
import type { ReadScopeLookupResult } from "./ports.ts";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function predicateTreeOf(row: JsonRecord): PredicateTree | null {
  const relation = record(row.relation) ?? row;
  const tree = relation.predicate_tree ?? relation.predicateTree;
  if (!tree || typeof tree !== "object") return null;
  return tree as PredicateTree;
}

function andTrees(trees: readonly PredicateTree[]): PredicateTree | null {
  const filtered = trees.filter((tree): tree is PredicateTree => tree !== null);
  if (filtered.length === 0) return null;
  if (filtered.length === 1) return filtered[0]!;
  return {
    kind: "AND",
    children: [...filtered],
    span: { start: 0, end: 0 },
  };
}

function resolveRelationId(
  readOccurrenceId: string,
  relationRecords: readonly JsonRecord[],
): string | null {
  for (const row of relationRecords) {
    const relationId = relationIdOf(row);
    if (relationId === readOccurrenceId) return relationId;
  }
  const suffix = readOccurrenceId.includes(":")
    ? readOccurrenceId.split(":").slice(-1)[0]
    : readOccurrenceId;
  for (const row of relationRecords) {
    const relationId = relationIdOf(row);
    if (!relationId) continue;
    if (relationId === suffix || relationId.endsWith(`:${suffix}`)) return relationId;
  }
  return readOccurrenceId;
}

function predicateTreeForReadOccurrence(input: {
  readonly readOccurrenceId: string;
  readonly relationRecords: readonly JsonRecord[];
  readonly relationEdgeRecords: readonly JsonRecord[];
}): PredicateTree | null {
  const readRelationId = resolveRelationId(
    input.readOccurrenceId,
    input.relationRecords,
  );
  if (!readRelationId) return null;

  const filters = new Map<string, PredicateTree | null>();
  for (const row of input.relationRecords) {
    if (relationTypeOf(row) !== "filter") continue;
    const id = relationIdOf(row);
    if (!id) continue;
    filters.set(id, predicateTreeOf(row));
  }

  const predicateTrees: PredicateTree[] = [];
  for (const edge of input.relationEdgeRecords) {
    const from = text(edge.from_relation_id);
    const to = text(edge.to_relation_id);
    if (!from || !to) continue;
    if (from !== readRelationId) continue;
    const filterTree = filters.get(to);
    if (filterTree) predicateTrees.push(filterTree);
  }

  return andTrees(predicateTrees);
}

export function buildReadScopeFromFacts(input: {
  readonly readOccurrenceId: string;
  readonly qualifiedName: string;
  readonly relationRecords: readonly JsonRecord[];
  readonly relationEdgeRecords: readonly JsonRecord[];
  readonly partitionFields: readonly string[] | null;
}): ReadScopeLookupResult {
  const predicate = predicateTreeForReadOccurrence({
    readOccurrenceId: input.readOccurrenceId,
    relationRecords: input.relationRecords,
    relationEdgeRecords: input.relationEdgeRecords,
  });

  if (input.partitionFields === null) {
    return { kind: "UNAVAILABLE", reasonCode: "READ_SCOPE_UNAVAILABLE" };
  }

  const scope: ReadPartitionScope = resolveReadPartitionScope({
    predicate,
    tableQualifiedName: input.qualifiedName,
    partitionFields: input.partitionFields,
    evidence: [{
      source: "SQL_PARSE",
      provider: "sql-static-lineage:field-evidence-continuation",
      locator: input.readOccurrenceId,
      observedAt: null,
    }],
  });

  return { kind: "OK", scope };
}

export function partitionFieldsFromWrites(
  writes: readonly { readonly partition: readonly { readonly field: string }[] }[],
): readonly string[] | null {
  const fields = new Set<string>();
  for (const write of writes) {
    for (const assignment of write.partition) {
      fields.add(assignment.field.trim().toLowerCase());
    }
  }
  if (fields.size === 0) return null;
  return [...fields].sort((left, right) => left.localeCompare(right));
}
