import type {
	PlanFacts,
	PlanLineageHopProjection,
	PlanRelation,
	PlanScopeBinding,
} from "../plan-contract.js";

export interface PlanFactsOutputInput {
	readonly contractVersion: string;
	readonly adapterVersion: string;
	readonly parserVersion: string;
	readonly dialect: string;
	readonly statementIndex: number;
	readonly relations: PlanRelation[];
	readonly roots: string[];
	readonly physicalInputs: readonly string[];
	readonly scopeBindings?: readonly PlanScopeBinding[];
	readonly unknowns: PlanFacts["unknowns"];
	readonly lineageHops: PlanLineageHopProjection;
}

/** Assemble the canonical PlanFacts object without changing adapter semantics. */
export function assemblePlanFacts(
	input: PlanFactsOutputInput,
): PlanFacts {
	return {
		meta: {
			contract_version: input.contractVersion,
			adapter_version: input.adapterVersion,
			parser: {
				engine: "sql-static-lineage",
				version: input.parserVersion,
			},
			dialect: input.dialect,
			statement_index: input.statementIndex,
			generated_at: new Date().toISOString(),
		},
		relations: input.relations,
		roots: input.roots,
		physical_inputs: [...input.physicalInputs],
		scope_bindings: input.scopeBindings ? [...input.scopeBindings] : undefined,
		unknowns: input.unknowns,
		lineage_hops: input.lineageHops,
	};
}
