/** An expression description for the experiment, not a physical-lineage resolver. */
export function describeOutput(tree, windowSpec = null) {
  const valueReferences = [], controlReferences = [], literals = [], parameters = [];
  const functions = [], operators = [], defaults = [], clocks = [], unknownKinds = [];
  function walk(node, role = 'VALUE', path = 'root') {
    if (!node || typeof node !== 'object') { unknownKinds.push('MISSING_EXPRESSION'); return; }
    if (node.kind === 'COLUMN') {
      (role === 'VALUE' ? valueReferences : controlReferences)
        .push({ name: node.name, qualifier: node.qualifier ?? null, path });
    } else if (node.kind === 'LITERAL') {
      const matches = [...String(node.text).matchAll(/\$\{([^{}]+)\}/g)];
      if (matches.length) parameters.push(...matches.map(m => ({ name: m[1], role, path, template: node.text })));
      else literals.push({ value: node.text, role, path });
    } else if (node.kind === 'BINARY') {
      operators.push(node.op);
      walk(node.left, role, `${path}.left`); walk(node.right, role, `${path}.right`);
    } else if (node.kind === 'CASE') {
      for (const [i, w] of (node.whens ?? []).entries()) {
        walk(w.when, 'CONTROL', `${path}.when[${i}]`);
        walk(w.then, role, `${path}.then[${i}]`);
      }
      if (node.elseExpr) walk(node.elseExpr, role, `${path}.else`);
      if (node.operand) walk(node.operand, 'CONTROL', `${path}.operand`);
    } else if (node.kind === 'PREDICATE') {
      operators.push(node.op);
      walk(node.operand, 'CONTROL', `${path}.operand`);
      (node.args ?? []).forEach((a, i) => walk(a, 'CONTROL', `${path}.arg[${i}]`));
    } else if (node.kind === 'FUNCTION') {
      const name = String(node.name).toLowerCase(), args = node.args ?? [];
      functions.push(name);
      if (['unix_timestamp', 'current_timestamp', 'current_date', 'sysdate'].includes(name) && args.length === 0)
        clocks.push({ function: name, path });
      if (['coalesce', 'nvl'].includes(name)) defaults.push({ function: name, path, alternatives: args.slice(1) });
      args.forEach((a, i) => walk(a, name === 'if' && i === 0 ? 'CONTROL' : role, `${path}.arg[${i}]`));
    } else {
      unknownKinds.push(node.kind ?? 'MISSING_KIND');
    }
  }
  walk(tree);
  let generation;
  if (unknownKinds.length) generation = 'UNKNOWN';
  else if (windowSpec) generation = 'WINDOW_GENERATION';
  else if (functions.some(f => ['sum', 'max', 'min', 'avg', 'count'].includes(f))) generation = 'AGGREGATION';
  else if (tree.kind === 'CASE' || functions.includes('if')) generation = 'CONDITIONAL_VALUE';
  else if (clocks.length) generation = valueReferences.length ? 'MIXED_GENERATION' : 'CURRENT_TIME';
  else if (tree.kind === 'BINARY') generation = 'CALCULATION';
  else if (valueReferences.length) generation = tree.kind === 'COLUMN' ? 'FIELD_COPY' : 'FIELD_TRANSFORMATION';
  else if (parameters.length) generation = functions.length ? 'PARAMETER_TRANSFORMATION' : 'TEMPLATE_PARAMETER';
  else if (tree.kind === 'LITERAL') generation = String(tree.text).toUpperCase() === 'NULL' ? 'NULL_VALUE' : 'FIXED_VALUE';
  else generation = 'UNCLASSIFIED_FUNCTION';
  const descriptionStatus = ['UNKNOWN', 'UNCLASSIFIED_FUNCTION'].includes(generation)
    ? 'UNCLASSIFIED' : 'DESCRIBED';
  const fieldPathApplicability = descriptionStatus === 'UNCLASSIFIED' ? 'UNKNOWN_INPUT_DEPENDENCY'
    : valueReferences.length || controlReferences.length || windowSpec
      ? 'HAS_FIELD_DEPENDENCY' : 'NO_PHYSICAL_FIELD_INPUT';
  return { generation,
    operation: tree?.kind === 'LITERAL' ? 'DIRECT_ASSIGNMENT' : generation,
    ...(tree?.kind === 'LITERAL' ? { assignmentExpression: tree.text } : {}),
    descriptionStatus, fieldPathApplicability, valueReferences, controlReferences, literals, parameters,
    functions, operators, defaults, clocks, unknownKinds,
    windowInputs: windowSpec?.input_bindings ?? [],
    purpose: 'EXPRESSION_DESCRIPTION_ONLY', physicalPaths: 'NOT_EVALUATED', publicationEligible: false };
}
