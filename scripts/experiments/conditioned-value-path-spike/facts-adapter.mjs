// Bounded adapter over frozen relation records. No SQL parsing, names of tasks,
// business tables or metric codes, and no production imports or writes.
const norm = value => String(value ?? '').toLowerCase();
const fail = reason => { throw new Error(reason); };
const list = node => node.expressions ?? node.measures ?? [];
const stringLiteral = tree => tree?.kind === 'LITERAL'
  && /^'(?:[^']|'')*'$/.test(tree.text ?? '')
  ? tree.text.slice(1, -1).replaceAll("''", "'") : null;

export function adaptOutput(frozen, targetField) {
  const records = frozen.records;
  const relations = records['relation-nodes.jsonl'];
  const byId = new Map(relations.map(r => [r.relation_id, r]));
  if (byId.size !== relations.length) fail('DUPLICATE_RELATION_ID');
  const bindings = records['output-field-bindings.jsonl']
    .filter(b => norm(b.target_field) === norm(targetField) && b.binding_status === 'RESOLVED');
  if (bindings.length !== 1) fail('OUTPUT_BINDING_NOT_UNIQUE');
  const binding = bindings[0];
  const expressions = records['field-expression-nodes.jsonl']
    .filter(e => e.expression_id === binding.expression_id);
  if (expressions.length !== 1) fail('ROOT_EXPRESSION_NOT_UNIQUE');
  const root = byId.get(expressions[0].relation_id);
  if (!root) fail('ROOT_RELATION_MISSING');
  const prefix = [], controls = [], active = new Set(), references = new Set();
  const row = id => {
    const r = byId.get(id);
    if (!r || r.task_id !== root.task_id || r.statement_id !== root.statement_id)
      fail('RELATION_MISSING_OR_OUT_OF_STATEMENT');
    return r.relation;
  };
  const output = (node, name) => {
    const candidates = list(node).filter(e => norm(e.output) === norm(name));
    if (candidates.length !== 1) fail('NAMED_OUTPUT_NOT_UNIQUE');
    return candidates[0];
  };

  function reference(id, name, qualifier) {
    const key = `${id}:${norm(name)}:${norm(qualifier)}`;
    if (references.has(key)) fail('REFERENCE_ROUTE_CYCLE');
    references.add(key);
    const n = row(id);
    prefix.push({ relationId: id, operator: n.type, column: name });
    if (n.type === 'filter') {
      controls.push({ relationId: id, kind: 'FILTER', status: 'NOT_EVALUATED' });
      return reference(n.source, name, qualifier);
    }
    if (n.type === 'join') {
      if (!qualifier) fail('UNQUALIFIED_JOIN_REFERENCE');
      const matches = [n.left, n.right].filter(side => {
        const s = row(side);
        return s.type === 'read' && norm(s.binding) === norm(qualifier)
          && s.scope_id === n.scope_id;
      });
      if (matches.length !== 1) fail('JOIN_BINDING_NOT_UNIQUE');
      controls.push({ relationId: id, kind: 'JOIN', status: 'NOT_EVALUATED' });
      return reference(matches[0], name, null);
    }
    if (n.type === 'read' && n.is_cte === true && n.source) {
      if (qualifier && norm(qualifier) !== norm(n.binding)) fail('CTE_BINDING_MISMATCH');
      return trace(n.source, name);
    }
    if (qualifier) fail('QUALIFIER_NOT_BOUND');
    return trace(id, name);
  }

  function trace(id, name) {
    const key = `${id}:${norm(name)}`;
    if (active.has(key)) fail('OUTPUT_ROUTE_CYCLE');
    active.add(key);
    const n = row(id), e = output(n, name), tree = e.structured_expression;
    prefix.push({ relationId: id, operator: n.type, column: name, span: e.span });
    if (tree?.kind === 'COLUMN') return reference(n.source, tree.name, tree.qualifier);
    if (tree?.kind === 'FUNCTION' && norm(tree.name) === 'coalesce'
        && tree.args.length >= 2 && tree.args[0].kind === 'COLUMN'
        && tree.args.slice(1).every(a => a.kind === 'LITERAL')) {
      prefix.push({ relationId: id, operator: 'COALESCE', defaults: tree.args.slice(1) });
      return reference(n.source, tree.args[0].name, tree.args[0].qualifier);
    }
    // Facts repeat aggregate expressions on their enclosing project. Follow
    // only an explicitly identical aggregate measure; do not apply it twice.
    if (n.type === 'project' && n.source && row(n.source).type === 'aggregate') {
      const measure = output(row(n.source), name);
      if (JSON.stringify(measure.structured_expression) !== JSON.stringify(tree))
        fail('AGGREGATE_OUTPUT_NOT_IDENTICAL');
      return trace(n.source, name);
    }
    if (n.type !== 'aggregate' || tree?.kind !== 'FUNCTION'
        || norm(tree.name) !== 'max' || tree.args?.length !== 1) fail('UNSUPPORTED_EXPRESSION');
    const c = tree.args[0], w = c.whens?.[0];
    if (c.kind !== 'CASE' || c.whens?.length !== 1 || c.else != null
        || c.else_expr != null || c.elseExpr != null
        || w?.when?.kind !== 'BINARY' || w.when.op !== '='
        || w.when.left?.kind !== 'COLUMN' || w.then?.kind !== 'COLUMN'
        || w.when.left.qualifier || w.then.qualifier) fail('UNSUPPORTED_CASE');
    // Unknown CASE members (especially ELSE encodings) must not be ignored.
    if (Object.keys(c).some(k => !['kind', 'whens'].includes(k))) fail('UNSUPPORTED_CASE_MEMBER');
    const literal = stringLiteral(w.when.right);
    if (literal === null) fail('UNSUPPORTED_SELECTOR_LITERAL');
    controls.push({ relationId: id, kind: 'GROUP_MEMBERSHIP', status: 'NOT_EVALUATED' });
    return { setopId: n.source, selectorName: w.when.left.name,
      valueName: w.then.name, literal, aggregateId: id };
  }

  const pivot = trace(root.relation_id, expressions[0].output_name);
  const setop = row(pivot.setopId);
  const ord = name => {
    const indices = (setop.output_columns ?? []).flatMap((c, i) => norm(c) === norm(name) ? [i] : []);
    if (indices.length !== 1) fail('SETOP_OUTPUT_ORDINAL_NOT_UNIQUE');
    return indices[0];
  };
  const selectorOrdinal = ord(pivot.selectorName), valueOrdinal = ord(pivot.valueName);
  const branches = [], setops = new Set(), leafIds = new Set();

  function physicalValue(leaf, valueExpression) {
    const t = valueExpression?.structured_expression;
    if (t?.kind !== 'COLUMN') return { kind: 'UNSUPPORTED' };
    let id = leaf.source;
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const n = row(id);
      if (n.type === 'filter') { id = n.source; continue; }
      if (n.type !== 'read' || n.is_cte || n.source
          || (t.qualifier && norm(t.qualifier) !== norm(n.binding))) break;
      const refs = (valueExpression.input_columns ?? []).filter(i =>
        i.resolution === 'PHYSICAL' && norm(i.name) === norm(t.name)
        && norm(i.qualifier) === norm(t.qualifier));
      if (refs.length !== 1 || refs[0].physical?.length !== 1) break;
      const physical = refs[0].physical[0];
      if (norm(physical.table) !== norm(n.table) || norm(physical.column) !== norm(t.name)) break;
      const occurrences = records['dataset-io.jsonl']
        .filter(io => io.direction === 'READ' && norm(io.physical_dataset) === norm(n.table))
        .flatMap(io => io.read_occurrences ?? []).filter(o => o.relation_id === id);
      if (occurrences.length !== 1 || !occurrences[0].occurrence_id) break;
      return { kind: 'FIELD', table: norm(n.table), column: norm(t.name),
        readOccurrenceId: occurrences[0].occurrence_id };
    }
    return { kind: 'UNSUPPORTED' };
  }

  function collect(id, path) {
    const n = row(id);
    if (n.type === 'setop') {
      if (setops.has(id)) fail('SETOP_CYCLE_OR_SHARED_NODE');
      setops.add(id);
      if (norm(n.setop) !== 'union' || n.all !== true || n.branches?.length < 2
          || n.output_columns?.length !== setop.output_columns.length) fail('UNSUPPORTED_OR_INCOMPLETE_SETOP');
      for (const [ordinal, child] of n.branches.entries()) collect(child, [...path, { relationId: id, ordinal }]);
      return;
    }
    if (n.type !== 'project' || leafIds.has(id)) fail('INVALID_OR_DUPLICATE_BRANCH');
    leafIds.add(id);
    if (list(n).length !== setop.output_columns.length) fail('BRANCH_OUTPUT_WIDTH_MISMATCH');
    const literal = stringLiteral(list(n)[selectorOrdinal]?.structured_expression);
    branches.push({ relationId: id, branchPath: path,
      selector: literal === null ? { kind: 'UNKNOWN' } : { kind: 'LITERAL', value: literal },
      value: physicalValue(n, list(n)[valueOrdinal]), evidence: [id, pivot.aggregateId] });
  }
  collect(pivot.setopId, []);
  return { operation: 'MAX_CASE_EQUALITY', output: targetField, selectorValue: pivot.literal,
    branchInventoryComplete: true, branches, prefix, controls,
    bindingId: binding.binding_id, setopCount: setops.size };
}
