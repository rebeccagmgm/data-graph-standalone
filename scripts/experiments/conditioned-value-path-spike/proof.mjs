/** Experimental value-contribution proof. Never a publishable lineage result. */
export function proveConditionalValues(input) {
  const paths = [], exclusions = [], gaps = [];
  const result = (status) => ({
    status, paths, exclusions, gaps,
    scope: 'MAX_CASE_EQUALITY_VALUE_CONTRIBUTION_ONLY',
    controls: 'NOT_EVALUATED', publicationEligible: false,
  });
  if (input.operation !== 'MAX_CASE_EQUALITY'
      || typeof input.selectorValue !== 'string'
      || !Array.isArray(input.branches) || input.branches.length === 0
      || input.branches.some(b => !b.relationId)
      || new Set(input.branches.map(b => b.relationId)).size !== input.branches.length) {
    gaps.push('INVALID_OR_UNSUPPORTED_CONTRACT');
    return result('NOT_EVALUABLE');
  }
  if (input.branchInventoryComplete !== true) gaps.push('BRANCH_INVENTORY_INCOMPLETE');
  for (const b of input.branches) {
    const known = b.selector?.kind === 'LITERAL' && typeof b.selector.value === 'string';
    if (known && b.selector.value !== input.selectorValue) {
      exclusions.push({ relationId: b.relationId, reason: 'LITERAL_MISMATCH',
        selectorValue: b.selector.value, evidence: [...(b.evidence ?? [])] });
      continue;
    }
    if (!known) gaps.push(`SELECTOR_UNKNOWN:${b.relationId}`);
    if (b.value?.kind !== 'FIELD' || !b.value.table || !b.value.column
        || !b.value.readOccurrenceId) {
      gaps.push(`VALUE_READ_NOT_PROVEN:${b.relationId}`);
      continue;
    }
    paths.push({ table: b.value.table, column: b.value.column,
      readOccurrenceId: b.value.readOccurrenceId, relationId: b.relationId,
      branchPath: [...b.branchPath], certainty: known ? 'PROVEN' : 'CANDIDATE',
      condition: { equals: input.selectorValue }, evidence: [...(b.evidence ?? [])] });
  }
  return result(gaps.length ? 'PARTIAL' : 'PROVEN_WITHIN_SCOPE');
}
