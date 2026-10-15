// Isolated evidence walker, not a SQL evaluator or a production projection.
// It follows structured expressions and explicit relation links. Derived JOIN
// aliases still depend on the existing immediate-child lexical scope encoding.
const norm = v => String(v ?? '').toLowerCase();
const fail = reason => { throw new Error(reason); };
const outputs = n => n.expressions ?? n.measures ?? [];

export function provePath(frozen, target, { copyOnly = false, bindingMode = 'legacy' } = {}) {
  const common = { controlsStatus: 'NOT_EVALUATED', publicationEligible: false };
  const paths = [], gaps = [], controls = [], bases = new Set(), active = new Set();
  let bindingId = null;
  try {
    const records = frozen.records, rows = records['relation-nodes.jsonl'];
    const byId = new Map(rows.map(r => [r.relation_id, r]));
    if (byId.size !== rows.length) fail('DUPLICATE_RELATION_ID');
    let rootId, field;
    if (typeof target === 'string') {
      const bs = records['output-field-bindings.jsonl'].filter(b => norm(b.target_field) === norm(target));
      if (bs.length !== 1 || bs[0].binding_status !== 'RESOLVED') fail('OUTPUT_BINDING_NOT_UNIQUE');
      bindingId = bs[0].binding_id;
      const es = records['field-expression-nodes.jsonl'].filter(e => e.expression_id === bs[0].expression_id);
      if (es.length !== 1) fail('ROOT_EXPRESSION_NOT_UNIQUE');
      rootId = es[0].relation_id; field = es[0].output_name;
    } else { rootId = target.relationId; field = target.field; }
    const root = byId.get(rootId);
    if (!root) fail('ROOT_RELATION_MISSING');
    const row = id => {
      const r = byId.get(id);
      if (!r || r.task_id !== root.task_id || r.statement_id !== root.statement_id)
        fail('RELATION_MISSING_OR_OUT_OF_STATEMENT');
      return r.relation;
    };
    function guarded(key, action) {
      if (active.has(key)) fail('ROUTE_CYCLE');
      if (active.size > 200 || paths.length > 5000) fail('WITNESS_BUDGET_EXCEEDED');
      active.add(key);
      try { return action(); } finally { active.delete(key); }
    }
    function named(n, name) {
      const es = outputs(n).filter(e => norm(e.output) === norm(name));
      if (es.length !== 1) fail('NAMED_OUTPUT_NOT_UNIQUE');
      return es[0];
    }
    function control(id, n) {
      controls.push({ relationId: id, operator: n.type, status: 'NOT_EVALUATED',
        expression: n.predicate_expr ?? n.condition ?? null });
    }
    function operands(id, scope, seen = new Set()) {
      if (seen.has(id)) fail('JOIN_ROUTE_CYCLE_OR_SHARED_OPERAND');
      seen.add(id);
      const n = row(id);
      if (n.type !== 'join' || n.scope_id !== scope) return [{ id, via: [] }];
      control(id, n);
      return [n.left, n.right].flatMap(child => operands(child, scope, seen)
        .map(o => ({ ...o, via: [id, ...o.via] })));
    }
    function physical(id, n, ref, raw, role, route) {
      if (ref.qualifier && norm(ref.qualifier) !== norm(n.binding)) fail('READ_BINDING_MISMATCH');
      const refs = (raw.input_columns ?? []).filter(c => norm(c.name) === norm(ref.name)
        && norm(c.qualifier) === norm(ref.qualifier));
      if (refs.length !== 1 || refs[0].resolution !== 'PHYSICAL' || refs[0].physical?.length !== 1)
        fail('PHYSICAL_FIELD_NOT_PROVEN');
      const p = refs[0].physical[0];
      if (norm(p.table) !== norm(n.table) || norm(p.column) !== norm(ref.name)) fail('PHYSICAL_FIELD_NOT_PROVEN');
      const ios = records['dataset-io.jsonl'].filter(io => io.direction === 'READ'
        && norm(io.physical_dataset) === norm(n.table) && io.resolution_status === 'RESOLVED');
      const os = ios.flatMap(io => io.read_occurrences ?? []).filter(o => o.relation_id === id);
      if (os.length !== 1 || !os[0].occurrence_id || os[0].scope_id !== n.scope_id)
        fail('READ_OCCURRENCE_NOT_UNIQUE');
      const path = { table: norm(n.table), column: norm(ref.name), readOccurrenceId: os[0].occurrence_id,
        role, route: [...route, { relationId: id, operator: 'read' }] };
      paths.push(path);
      return { kind: 'PHYSICAL_FIELD', pathIndex: paths.length - 1 };
    }
    function reference(id, ref, raw, role, route) {
      return guarded(`ref:${id}:${norm(ref.qualifier)}:${norm(ref.name)}`, () => {
        const n = row(id), next = [...route, { relationId: id, operator: n.type, reference: ref }];
        if (n.type === 'filter') { control(id, n); return reference(n.source, ref, raw, role, next); }
        if (n.type === 'join') {
          if (!ref.qualifier) fail('UNQUALIFIED_JOIN_REFERENCE');
          const matches = operands(id, n.scope_id).flatMap(o => {
            const s = row(o.id);
            if (s.type === 'read') return s.scope_id === n.scope_id && norm(s.binding) === norm(ref.qualifier) ? [o] : [];
            if (!['project', 'setop'].includes(s.type)) return [];
            if (bindingMode === 'explicit') return (s.scope_bindings ?? []).filter(b =>
              b.source_kind === 'subquery' && b.scope_id === n.scope_id && norm(b.binding) === norm(ref.qualifier)
              && b.relation_id === o.id && b.target_relation_id === o.id && b.target_scope_id === s.scope_id)
              .map(() => o);
            return norm(s.scope_id) === `${norm(n.scope_id)}.${norm(ref.qualifier)}` ? [o] : [];
          });
          if (matches.length !== 1) fail('JOIN_BINDING_NOT_UNIQUE');
          const selected = matches[0], s = row(selected.id);
          if (s.type !== 'read') bases.add(bindingMode === 'explicit' ? 'PERSISTED_SCOPE_BINDING' : 'LEXICAL_SCOPE_CONVENTION');
          const selectedRoute = [...next, { operator: 'JOIN_INPUT', alias: ref.qualifier, via: selected.via }];
          return s.type === 'read' ? reference(selected.id, ref, raw, role, selectedRoute)
            : output(selected.id, ref.name, role, selectedRoute);
        }
        if (n.type === 'read') {
          if (n.is_cte === true) {
            if (!n.source || (ref.qualifier && norm(ref.qualifier) !== norm(n.binding))) fail('CTE_BINDING_MISMATCH');
            if (bindingMode === 'explicit') {
              const bs = (n.scope_bindings ?? []).filter(b => b.source_kind === 'cte'
                && b.relation_id === id && b.scope_id === n.scope_id && norm(b.binding) === norm(n.binding)
                && b.target_relation_id === n.source && b.target_scope_id === row(n.source).scope_id);
              if (bs.length !== 1) fail('CTE_SCOPE_BINDING_NOT_UNIQUE');
              bases.add('PERSISTED_SCOPE_BINDING');
            }
            return output(n.source, ref.name, role, next);
          }
          if (n.source) fail('UNSUPPORTED_READ_SOURCE');
          return physical(id, n, ref, raw, role, route);
        }
        if (ref.qualifier) fail('QUALIFIER_NOT_BOUND');
        return output(id, ref.name, role, route);
      });
    }
    function columnTree(raw) {
      if (raw.structured_expression) return raw.structured_expression;
      const cs = raw.input_columns;
      if (raw.star_expansion === true && raw.expr_kind === 'column' && cs?.length === 1
        && norm(cs[0].name) === norm(raw.output) && cs[0].resolution === 'PHYSICAL') {
        bases.add('EXPLICIT_STAR_EXPANSION');
        return { kind: 'COLUMN', name: cs[0].name, ...(cs[0].qualifier ? { qualifier: cs[0].qualifier } : {}) };
      }
      fail('NOT_A_PROVEN_COLUMN_REFERENCE');
    }
    function tree(t, source, raw, role, route) {
      if (!t || (copyOnly && t.kind !== 'COLUMN')) fail('NOT_A_PROVEN_COLUMN_REFERENCE');
      if (t.kind === 'COLUMN') return reference(source, t, raw, role, route);
      if (t.kind === 'LITERAL') return { ...t };
      if (t.kind === 'BINARY' && ['-', '+', '*', '/', '='].includes(t.op)) return {
        kind: t.kind, op: t.op,
        left: tree(t.left, source, raw, role, [...route, { operator: t.op, position: 'left' }]),
        right: tree(t.right, source, raw, role, [...route, { operator: t.op, position: 'right' }]),
      };
      if (t.kind === 'FUNCTION') {
        const fn = norm(t.name), allowed = ['sum', 'max', 'nvl', 'coalesce', 'from_unixtime', 'unix_timestamp',
          'current_timestamp', 'current_date', 'sysdate', 'to_char', 'concat', 'upper', 'row_number'];
        if (!allowed.includes(fn) || !Array.isArray(t.args)) fail('UNSUPPORTED_FUNCTION');
        if (Object.keys(t).some(k => !['kind', 'name', 'args'].includes(k))) fail('UNSUPPORTED_FUNCTION_MODIFIER');
        if (['row_number', 'unix_timestamp', 'current_timestamp', 'current_date', 'sysdate'].includes(fn) && t.args.length)
          fail('UNSUPPORTED_FUNCTION_ARITY');
        if (['sum', 'max'].includes(fn) && t.args.length !== 1) fail('UNSUPPORTED_FUNCTION_ARITY');
        return { kind: t.kind, name: t.name, args: t.args.map((arg, i) =>
          tree(arg, source, raw, role, [...route, { operator: t.name, argument: i }])) };
      }
      if (t.kind === 'CASE') {
        if (Object.keys(t).some(k => !['kind', 'whens', 'elseExpr'].includes(k)) || !t.whens?.length)
          fail('UNSUPPORTED_CASE_SHAPE');
        return { kind: 'CASE', whens: t.whens.map((w, i) => ({
          when: tree(w.when, source, raw, 'BRANCH_SELECTOR', [...route, { operator: 'CASE_WHEN', ordinal: i }]),
          then: tree(w.then, source, raw, role, [...route, { operator: 'CASE_THEN', ordinal: i }]),
        })), elseExpr: t.elseExpr ? tree(t.elseExpr, source, raw, role, [...route, { operator: 'CASE_ELSE' }])
          : { kind: 'LITERAL', text: 'NULL', implicit: true } };
      }
      if (t.kind === 'PREDICATE' && t.op === 'null' && t.args?.length === 0) return {
        kind: t.kind, op: t.op, negated: t.negated,
        operand: tree(t.operand, source, raw, role, route),
      };
      fail('UNSUPPORTED_EXPRESSION');
    }
    function window(raw, source, route) {
      if (!raw.window || !raw.window_spec?.input_bindings) fail('WINDOW_SPEC_MISSING');
      const spec = raw.window_spec;
      const inputs = spec.input_bindings.map(b => {
        const cs = b.input_columns;
        // No parsing of window expressions or reverse mapping from table names.
        if (cs?.length !== 1 || norm(b.expression_text) !== norm(cs[0].name)
          || !['WINDOW_PARTITION', 'WINDOW_ORDER'].includes(b.role)) fail('WINDOW_INPUT_NOT_A_SIMPLE_REFERENCE');
        return { role: b.role, ordinal: b.ordinal, direction: b.direction, nulls: b.nulls,
          input: reference(source, { kind: 'COLUMN', name: cs[0].name, qualifier: cs[0].qualifier },
            { input_columns: cs }, b.role, [...route, { operator: b.role, ordinal: b.ordinal }]) };
      });
      if (!spec.frame || spec.frame.status === 'UNKNOWN') gaps.push('WINDOW_FRAME_NOT_EXPOSED');
      return { expression: spec.expression_text, inputs, frame: spec.frame };
    }
    function output(id, name, role, route, ordinal = null, width = null) {
      return guarded(`out:${id}:${norm(name)}:${ordinal}`, () => {
        const n = row(id), next = [...route, { relationId: id, operator: n.type, output: name, ordinal }];
        if (n.type === 'setop') {
          if (copyOnly || norm(n.setop) !== 'union' || n.all !== true || n.branches?.length < 2)
            fail('UNSUPPORTED_SETOP');
          const cols = n.output_columns;
          if (!Array.isArray(cols) || (width !== null && width !== cols.length)) fail('UNION_WIDTH_MISMATCH');
          const indices = cols.flatMap((c, i) => norm(c) === norm(name) ? [i] : []);
          const index = ordinal ?? (indices.length === 1 ? indices[0] : fail('UNION_OUTPUT_NOT_UNIQUE'));
          if (index < 0 || index >= cols.length) fail('UNION_OUTPUT_ORDINAL_INVALID');
          if (new Set(n.branches).size !== n.branches.length) fail('DUPLICATE_UNION_BRANCH');
          return { kind: 'UNION_ALL', relationId: id, outputOrdinal: index,
            branches: n.branches.map((b, i) => output(b, name, role,
              [...next, { operator: 'UNION_BRANCH', ordinal: i }], index, cols.length)) };
        }
        if (!['project', 'aggregate'].includes(n.type)) fail('UNSUPPORTED_OUTPUT_RELATION');
        if (width !== null && outputs(n).length !== width) fail('UNION_WIDTH_MISMATCH');
        const raw = ordinal === null ? named(n, name) : outputs(n)[ordinal];
        if (!raw) fail('OUTPUT_EXPRESSION_MISSING');
        const t = columnTree(raw);
        if (n.type === 'project' && n.source && row(n.source).type === 'aggregate' && raw.aggregate === true) {
          const measure = named(row(n.source), raw.output);
          if (JSON.stringify(measure.structured_expression) !== JSON.stringify(t)) fail('AGGREGATE_OUTPUT_NOT_IDENTICAL');
          return output(n.source, raw.output, role, next);
        }
        if (n.type === 'aggregate') {
          if (copyOnly) fail('NOT_A_PROVEN_COLUMN_REFERENCE');
          if (!Array.isArray(n.group_by) || n.group_by.length !== n.group_by_exprs?.length)
            fail('GROUP_EVIDENCE_INCOMPLETE');
          control(id, n);
        }
        const result = { kind: 'OUTPUT', relationId: id, output: raw.output, expression: raw.expr_text,
          value: tree(t, n.source, raw, role, next) };
        if (n.type === 'aggregate') result.groupInputs = (n.group_by ?? []).map((c, i) => {
          if (norm(n.group_by_exprs?.[i]) !== norm(c.name)) fail('GROUP_INPUT_NOT_A_SIMPLE_REFERENCE');
          return reference(n.source, { kind: 'COLUMN', name: c.name, qualifier: c.qualifier },
            { input_columns: [c] }, 'GROUP_KEY', [...next, { operator: 'GROUP_BY', ordinal: i }]);
        });
        if (raw.window || norm(t.name) === 'row_number') result.window = window(raw, n.source, next);
        return result;
      });
    }
    const witness = output(rootId, field, 'VALUE', []);
    return { ...common, status: gaps.length ? 'PARTIAL' : 'PROVEN_WITHIN_SCOPE', bindingId,
      paths, witness, gaps: [...new Set(gaps)], controls, bindingEvidence: [...bases] };
  } catch (e) {
    return { ...common, status: 'NOT_EVALUABLE', bindingId, reason: e.message, paths: [],
      gaps: [e.message], bindingEvidence: [...bases] };
  }
}
