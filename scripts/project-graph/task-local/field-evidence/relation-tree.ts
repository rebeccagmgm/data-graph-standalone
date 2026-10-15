import { normalizeName } from "../../../machine-facts/machine-facts-contract.ts";
import type { TaskLocalControlSide, TaskLocalJoinType } from "../contract.ts";

export type RelationRecord = Readonly<{
  readonly relationId: string;
  readonly relationType: string;
  readonly physicalDataset: string | null;
  /** SQL binding/alias for a read relation, when Facts expose one. */
  readonly binding: string | null;
  /** Relation that supplies a logical CTE/read alias, when Facts expose one. */
  readonly sourceRelationId: string | null;
  /** Proven physical inputs of a named output from this relation. */
  readonly outputInputColumns: readonly RelationOutputInputColumn[];
  readonly outputColumns: readonly string[];
  readonly joinType: string | null;
  readonly leftRelationId: string | null;
  readonly rightRelationId: string | null;
  readonly setopBranches: readonly string[];
  readonly scopeId: string | null;
}>;

export type RelationOutputInputColumn = Readonly<{
  readonly outputName: string;
  readonly inputName: string;
  readonly physicalDataset: string;
  readonly physicalColumn: string;
  readonly qualifier: string | null;
}>;

export interface RelationTreeIndex {
  readonly relations: ReadonlyMap<string, RelationRecord>;
  readonly incomingByTo: ReadonlyMap<string, readonly string[]>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function relationBody(relation: Record<string, unknown>): Record<string, unknown> {
  return record(relation.relation) ?? relation;
}

function normalizedLiteral(value: unknown): string | null {
  const literal = text(value);
  if (!literal) return null;
  const match = literal.match(/^(['\"])(.*)\1$/s);
  return normalizeName(match ? match[2] : literal);
}

function pivotValueInputs(
  expression: Record<string, unknown>,
): readonly Record<string, unknown>[] | null | undefined {
  // This is deliberately narrower than "a CASE exists".  A pivot output is
  // safe to bridge only when the named aggregate output is exactly the one
  // literal selected by one CASE branch, and exactly one RESULT_VALUE role
  // supplies the physical value.  Anything nested or plural stays unknown.
  if (expression.aggregate !== true) return undefined;
  const output = text(expression.output);
  const roles = Array.isArray(expression.expression_roles)
    ? expression.expression_roles.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : [];
  const selectors = roles.filter((role) => text(role.role) === "BRANCH_SELECTOR");
  const values = roles.filter((role) => text(role.role) === "RESULT_VALUE");
  if (selectors.length === 0 && values.length === 0) return undefined;
  if (!output || selectors.length !== 1 || values.length !== 1) return null;
  const facts = record(expression.expression_facts);
  const literals = Array.isArray(facts?.literals) ? facts.literals : [];
  if (literals.length !== 1 || normalizedLiteral(literals[0]) !== normalizeName(output)) return null;
  const comparisons = Array.isArray(facts?.comparisons) ? facts.comparisons : [];
  if (comparisons.length !== 1 || text(record(comparisons[0])?.operator) !== "=") return null;
  const valueInputs = Array.isArray(values[0]!.input_columns) ? values[0]!.input_columns : [];
  const mapped = valueInputs.map(record).filter((item): item is Record<string, unknown> => item !== null);
  const physicalInputs = mapped.flatMap((input) =>
    (Array.isArray(input.physical) ? input.physical : []).map(record)
      .filter((item): item is Record<string, unknown> => item !== null),
  );
  return mapped.length === 1 && physicalInputs.length === 1 ? mapped : null;
}

function outputInputColumns(body: Record<string, unknown>): readonly RelationOutputInputColumn[] {
  const expressions = Array.isArray(body.expressions)
    ? body.expressions
    : Array.isArray(body.measures) ? body.measures : [];
  const columns: RelationOutputInputColumn[] = [];
  for (const rawExpression of expressions) {
    const expression = record(rawExpression);
    const outputName = text(expression?.output);
    if (!expression || !outputName) continue;
    const pivotInputs = pivotValueInputs(expression);
    // A malformed pivot candidate is not a generic aggregate witness.  Its
    // broad input_columns include selector fields and can otherwise route an
    // output to the wrong setop leaf.
    const inputs = pivotInputs === undefined
      ? (Array.isArray(expression.input_columns) ? expression.input_columns : [])
      : pivotInputs ?? [];
    for (const rawInput of inputs) {
      const input = record(rawInput);
      const inputName = text(input?.name);
      const physical = Array.isArray(input?.physical) ? input.physical : [];
      if (!input || !inputName) continue;
      for (const rawPhysical of physical) {
        const item = record(rawPhysical);
        const physicalDataset = text(item?.table);
        const physicalColumn = text(item?.column);
        if (!item || !physicalDataset || !physicalColumn) continue;
        columns.push({
          outputName: normalizeName(outputName),
          inputName: normalizeName(inputName),
          physicalDataset: normalizeName(physicalDataset),
          physicalColumn: normalizeName(physicalColumn),
          qualifier: text(input.qualifier) ? normalizeName(text(input.qualifier)!) : null,
        });
      }
    }
  }
  return columns;
}

function outputColumnNames(body: Record<string, unknown>): readonly string[] {
  const explicit = Array.isArray(body.output_columns)
    ? body.output_columns
      .map((value) => text(value))
      .filter((value): value is string => value !== null)
    : [];
  if (explicit.length > 0) return explicit.map(normalizeName);

  // Some SQL_PLAN CTE/project nodes omit output_columns but retain the
  // structured expression records.  Those explicit output names are enough
  // to identify a named CTE route; do not infer names from input columns.
  const expressions = Array.isArray(body.expressions)
    ? body.expressions
    : Array.isArray(body.measures) ? body.measures : [];
  return expressions
    .map(record)
    .map((expression) => text(expression?.output))
    .filter((value): value is string => value !== null)
    .map(normalizeName);
}

export function buildRelationTreeIndex(
  relationNodes: readonly Record<string, unknown>[],
): RelationTreeIndex {
  const relations = new Map<string, RelationRecord>();
  for (const row of relationNodes) {
    const relationId = text(row.relation_id);
    if (!relationId) continue;
    const body = relationBody(row);
    const relationType = (
      text(row.relation_type)
      ?? text(body.type)
      ?? ""
    ).toLowerCase();
    const physicalDataset = text(row.physical_dataset)
      ?? text(body.table)
      ?? text(body.physical_dataset);
    const branches = Array.isArray(body.branches)
      ? body.branches.map((value) => String(value)).filter(Boolean)
      : [];
    const outputColumns = outputColumnNames(body);
    relations.set(relationId, {
      relationId,
      relationType,
      physicalDataset: physicalDataset ? normalizeName(physicalDataset) : null,
      binding: text(body.binding) ? normalizeName(text(body.binding)!) : null,
      sourceRelationId: text(body.source) ?? text(row.source),
      outputInputColumns: outputInputColumns(body),
      outputColumns,
      joinType: text(body.join_type),
      leftRelationId: text(body.left),
      rightRelationId: text(body.right),
      setopBranches: branches,
      scopeId: text(row.scope_id) ?? text(body.scope_id),
    });
  }
  return { relations, incomingByTo: new Map() };
}

export function withIncomingRelations(
  index: RelationTreeIndex,
  relationEdges: readonly Record<string, unknown>[],
): RelationTreeIndex {
  const incomingByTo = new Map<string, string[]>();
  for (const edge of relationEdges) {
    const to = text(edge.to_relation_id);
    const from = text(edge.from_relation_id);
    if (!to || !from) continue;
    const values = incomingByTo.get(to) ?? [];
    values.push(from);
    incomingByTo.set(to, values);
  }
  return { ...index, incomingByTo };
}

export function relationSubtree(
  index: RelationTreeIndex,
  rootRelationId: string,
): ReadonlySet<string> {
  const visited = new Set<string>();
  const stack = [rootRelationId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const parent of index.incomingByTo.get(current) ?? []) {
      if (!visited.has(parent)) stack.push(parent);
    }
  }
  return visited;
}

export function subtreeContains(
  index: RelationTreeIndex,
  ancestorRelationId: string,
  descendantRelationId: string,
): boolean {
  return relationSubtree(index, ancestorRelationId).has(descendantRelationId);
}

export function readRelationsInSubtree(
  index: RelationTreeIndex,
  rootRelationId: string,
): readonly RelationRecord[] {
  const subtree = relationSubtree(index, rootRelationId);
  return [...subtree]
    .map((relationId) => index.relations.get(relationId))
    .filter((relation): relation is RelationRecord =>
      relation !== undefined && relation.relationType === "read",
    )
    .sort((left, right) => left.relationId.localeCompare(right.relationId));
}

export function nearestSetopAncestor(
  index: RelationTreeIndex,
  relationId: string,
): RelationRecord | null {
  const visited = new Set<string>();
  let current: string | null = relationId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const relation = index.relations.get(current);
    if (relation?.relationType === "setop") return relation;
    const parents: readonly string[] = index.incomingByTo.get(current) ?? [];
    current = parents.length === 1 ? parents[0]! : null;
  }
  return null;
}

export function normalizeJoinType(joinType: string | null): TaskLocalJoinType {
  const kind = (joinType ?? "").trim().toUpperCase();
  if (kind.includes("SEMI")) return "SEMI";
  if (kind.includes("ANTI")) return "ANTI";
  if (kind.includes("INNER")) return "INNER";
  if (kind.includes("LEFT")) return "LEFT";
  if (kind.includes("RIGHT")) return "RIGHT";
  if (kind.includes("FULL")) return "FULL";
  if (kind.includes("CROSS")) return "CROSS";
  return "N/A";
}

export function controlSideForJoin(input: {
  readonly index: RelationTreeIndex;
  readonly joinRelation: RelationRecord;
  readonly controlReadRelationId: string | null;
}): TaskLocalControlSide {
  const { index, joinRelation, controlReadRelationId } = input;
  if (!controlReadRelationId || !joinRelation.leftRelationId || !joinRelation.rightRelationId) {
    return "BOTH";
  }
  const inLeft = subtreeContains(index, joinRelation.leftRelationId, controlReadRelationId);
  const inRight = subtreeContains(index, joinRelation.rightRelationId, controlReadRelationId);
  if (inLeft && !inRight) return "LEFT";
  if (inRight && !inLeft) return "RIGHT";
  return "BOTH";
}
