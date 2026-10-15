import { buildRelationTreeIndex, withIncomingRelations } from "./field-evidence/relation-tree.ts";
import { resolveSourceReadOccurrence } from "./field-evidence/source-read-occurrence.ts";

type Fact = Record<string, any>;
const norm = (value: unknown): string => String(value ?? "").toLowerCase();
const bare = (value: unknown): string => String(value ?? "").trim()
  .replace(/\s+(?:as\s+)?[a-z_][\w$]*$/iu, "").trim();
const simple = (value: string): boolean => /^(?:[a-z_][\w$]*\.)?[a-z_][\w$]*$/iu.test(value);

export interface PartitionValueDomain {
  /** Complete finite set of possible non-NULL values. null domain means unknown. */
  readonly values: readonly string[];
  readonly mayBeNull: boolean;
}

type ResolverInput = {
  readonly bindings: readonly Fact[];
  readonly expressions: readonly Fact[];
  readonly relations: readonly Fact[];
  readonly materializations: readonly Fact[];
  readonly literal: (value: unknown) => string | null;
};

/** Legacy scalar consumer: never silently discard a possible SQL NULL. */
export function createPartitionValueResolver(input: ResolverInput): (expression: Fact) => readonly string[] | null {
  const resolve = createPartitionValueDomainResolver(input);
  return expression => { const domain = resolve(expression); return domain && !domain.mayBeNull ? domain.values : null; };
}

/** Finite abstract values: projection preserves, UNION joins, outer JOIN adds NULL. */
export function createPartitionValueDomainResolver(input: ResolverInput): (expression: Fact) => PartitionValueDomain | null {
  const index = withIncomingRelations(buildRelationTreeIndex(input.relations), input.relations.flatMap(row => {
    const body = row.relation ?? {};
    return [body.source, body.left, body.right, ...(body.branches ?? [])].filter(Boolean)
      .map(from => ({ from_relation_id: from, to_relation_id: row.relation_id }));
  }));
  const bodies = new Map(input.relations.map(r => [r.relation_id, r.relation as Fact]));
  const expressions = new Map(input.expressions.map(e => [e.expression_id, e]));
  const readIds = new Map(input.relations.filter(r => r.relation?.type === "read")
    .map(r => [r.relation_id, r.relation.read_occurrence_id ?? r.relation_id]));
  const readBindings = new Map([...index.relations].flatMap(([id, r]) => r.binding ? [[id, r.binding] as const] : []));

  function paths(from: string, to: string, active = new Set<string>()): string[][] {
    if (active.has(from)) return [];
    if (from === to) return [[from]];
    const body = bodies.get(from);
    if (!body || !["read", "project", "filter", "join"].includes(body.type)) return [];
    const children: string[] = body.type === "join" ? [body.left, body.right] : [body.source];
    return children.filter(Boolean).flatMap(child => paths(child, to, new Set(active).add(from))
      .map(path => [from, ...path]));
  }

  function resolve(expression: Fact, active: ReadonlySet<string>): PartitionValueDomain | null {
    const id = expression.expression_id;
    if (!id || active.has(id) || active.size > 64) return null;
    const next = new Set(active).add(id), body = bodies.get(expression.relation_id);
    if (expression.role === "SETOP_OUTPUT") {
      if (body?.type !== "setop" || body.setop !== "union" || !body.branches?.length) return null;
      const values: string[] = [];
      let mayBeNull = false;
      for (const branch of body.branches) {
        const candidates = input.expressions.filter(e => e.relation_id === branch && e.ordinal === expression.ordinal);
        if (candidates.length !== 1) return null;
        const branchValues = resolve(candidates[0]!, next);
        if (!branchValues) return null;
        values.push(...branchValues.values);
        mayBeNull ||= branchValues.mayBeNull;
      }
      return { values: [...new Set(values)], mayBeNull };
    }
    if (expression.role !== "PROJECT_EXPRESSION") return null;
    const literal = input.literal(expression.expression_text);
    if (literal !== null) return { values: [literal], mayBeNull: false };
    if (bare(expression.expression_text).toUpperCase() === "NULL" && !expression.input_fields?.length)
      return { values: [], mayBeNull: true };
    const sql = bare(expression.expression_text), fields = expression.input_fields;
    if (!simple(sql) || !Array.isArray(fields) || fields.length !== 1 ||
      ["PARTIAL", "UNRESOLVED", "SQL_CANDIDATE"].includes(expression.input_dependency_status) ||
      expression.unresolved_input_columns?.length) return null;
    const field = fields[0];
    if (!field?.table || norm(sql.split(".").at(-1)) !== norm(field.column)) return null;
    const source = resolveSourceReadOccurrence({ taskId: String(expression.task_id ?? ""), expressionId: id,
      sourceTable: field.table, sourceColumn: field.column, inputField: field, expressionText: sql,
      referenceQualifier: sql.includes(".") ? sql.split(".")[0] : undefined,
      cteOutputColumn: field.column,
      leafRelationId: expression.relation_id, index, readOccurrenceByRelationId: readIds,
      bindingByReadRelation: readBindings });
    if (source.sourceReadOccurrenceStatus !== "RESOLVED" || !source.sourceRelationId) return null;
    const routes = paths(expression.relation_id, source.sourceRelationId);
    if (routes.length !== 1) return null;
    const route = routes[0]!;
    let mayBeNull = false;
    for (let offset = 0; offset < route.length; offset++) {
      const relation = bodies.get(route[offset]!)!;
      if (relation.type === "join") {
        const side = route[offset + 1] === relation.left ? "left" : "right";
        if (!["inner", "left", "right", "full"].includes(relation.join_type)) return null;
        mayBeNull ||= relation.join_type !== "inner" && relation.join_type !== side;
      }
      // A projection inside a CTE/subquery must preserve this field, not transform it.
      if (offset > 0 && relation.type === "project") {
        const outputs = input.expressions.filter(e => e.relation_id === route[offset] && norm(e.output_name) === norm(field.column));
        if (outputs.length !== 1 || !simple(bare(outputs[0]!.expression_text)) ||
          norm(bare(outputs[0]!.expression_text).split(".").at(-1)) !== norm(field.column) ||
          outputs[0]!.input_fields?.length !== 1 ||
          norm(outputs[0]!.input_fields[0].column) !== norm(field.column) ||
          norm(outputs[0]!.input_fields[0].table) !== norm(field.table)) return null;
      }
    }
    let constrained: string[] | null = null;
    for (const relationId of route) {
      const filter = bodies.get(relationId)!;
      const read = bodies.get(filter.source);
      if (filter.type !== "filter" || read?.type !== "read" || read.source || norm(read.table) !== norm(field.table)) continue;
      const visit = (node: Fact | undefined): void => {
        if (node?.kind === "AND") { node.children?.forEach(visit); return; }
        if (node?.kind !== "ATOM" || !["EQ", "IN"].includes(node.operator) || node.operands?.length < 2) return;
        if (node.operator === "EQ" && node.operands.length !== 2) return;
        const [left, ...right] = node.operands, origins = left.column?.physical;
        if (left.kind !== "COLUMN" || left.column?.resolution !== "PHYSICAL" || origins?.length !== 1 ||
          norm(origins[0].table) !== norm(field.table) || norm(origins[0].column) !== norm(field.column) ||
          right.some((operand: Fact) => operand.kind !== "LITERAL")) return;
        const values = right.map((operand: Fact) => input.literal(operand.expression));
        if (values.some((value: string | null) => value === null)) return;
        constrained = constrained === null ? values : constrained.filter(value => values.includes(value));
      };
      visit(filter.predicate_tree);
    }
    if (constrained !== null) return (constrained as string[]).length ? { values: constrained, mayBeNull } : null;
    const bridges = input.materializations.filter(m => norm(m.column) === norm(field.column) &&
      m.read_expression_ids?.includes(id));
    if (bridges.length !== 1 || bridges[0]!.status !== "RESOLVED") return null;
    const bridge = bridges[0]!;
    const dataset = norm(bridge.physical_dataset), table = norm(field.table);
    if (!dataset || (dataset !== table && !dataset.endsWith(`.${table}`))) return null;
    if (!Number.isInteger(bridge.write_statement_index) || !Number.isInteger(bridge.read_statement_index) ||
      bridge.write_statement_index >= bridge.read_statement_index) return null;
    const bindingIds = [...new Set([bridge.output_binding_id, ...(bridge.output_binding_ids ?? [])].filter(Boolean))];
    if (bindingIds.length !== 1) return null;
    const bindings = input.bindings.filter(b => b.binding_id === bindingIds[0] && b.binding_status === "RESOLVED" &&
      b.write_observation_id === bridge.write_observation_id && norm(b.target_field) === norm(field.column));
    if (bindings.length === 1 && norm(bindings[0]!.target_dataset) !== dataset) return null;
    const producer = bindings.length === 1 ? expressions.get(bindings[0]!.expression_id) : null;
    const domain = producer ? resolve(producer, next) : null;
    return domain ? { values: domain.values, mayBeNull: mayBeNull || domain.mayBeNull } : null;
  }
  return expression => resolve(expression, new Set());
}
