import type { PlanFacts, PlanScopeBinding } from "../plans/plan-contract.ts";
import { globalRelationId } from "./plan-occurrence-id.ts";

/** Preserve source mappings already produced by the parser-side scope layer. */
export function globalizePlanScopeBindings(
  plan: PlanFacts,
  taskId: string,
  statementIndex: number,
): ReadonlyMap<string, readonly PlanScopeBinding[]> {
  const byId = new Map(plan.relations.map(r => [r.id, r]));
  const scopes = new Set(plan.relations.map(r => r.scope_id).filter(Boolean));
  const result = new Map<string, PlanScopeBinding[]>();
  if (byId.size !== plan.relations.length) throw new Error("SCOPE_BINDING_DUPLICATE_RELATION_ID");
  for (const binding of plan.scope_bindings ?? []) {
    const owner = byId.get(binding.relation_id);
    if (!owner || !scopes.has(binding.scope_id)) throw new Error("SCOPE_BINDING_OWNER_MISSING");
    const target = binding.target_relation_id === null ? null : byId.get(binding.target_relation_id);
    if (binding.target_relation_id !== null && !target) throw new Error("SCOPE_BINDING_TARGET_MISSING");
    if (target ? target.scope_id !== binding.target_scope_id : binding.target_scope_id !== null)
      throw new Error("SCOPE_BINDING_TARGET_SCOPE_MISMATCH");
    if (binding.source_kind === "cte" && (owner.type !== "read" || owner.is_cte !== true
      || owner.scope_id !== binding.scope_id || (target && owner.source !== binding.target_relation_id)))
      throw new Error("SCOPE_BINDING_CTE_LINK_MISMATCH");
    if (binding.source_kind === "subquery" && target && owner.id !== target.id)
      throw new Error("SCOPE_BINDING_DERIVED_LINK_MISMATCH");
    const global = { ...binding, relation_id: globalRelationId(taskId, statementIndex, binding.relation_id),
      target_relation_id: binding.target_relation_id === null ? null
        : globalRelationId(taskId, statementIndex, binding.target_relation_id) };
    const bindings = result.get(binding.relation_id) ?? [];
    // Preserve multiplicity. Consumers must reject ambiguous bindings rather
    // than the writer silently selecting or merging one candidate.
    bindings.push(global);
    result.set(binding.relation_id, bindings);
  }
  return result;
}
