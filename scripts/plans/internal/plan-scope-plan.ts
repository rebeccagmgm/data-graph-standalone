import type {
  Expr,
  Join,
  ResolvedSource,
  Scope,
  ScopeTree,
  Source,
} from "sqllens";

/**
 * A normalized, plan-local view of ScopeTree.
 *
 * This is intentionally not PlanFacts. It keeps native IR/Scope references so
 * the existing adapter can be compared with it before any production path is
 * changed. It also deliberately does not resolve schema, physical columns, or
 * VALUE_LINEAGE.
 */
export interface ScopePlanSource {
	readonly key: string;
	readonly source: ResolvedSource;
	readonly ordinal: number;
}

export interface ScopePlanFrom {
	readonly ordinal: number;
	readonly source: Source;
	readonly bindingKey: string | null;
	/**
	 * Index into `Scope.sourceList`. Scope.sources is keyed by name, so two
	 * sources sharing an alias (a derived table plus a LATERAL VIEW named `t`)
	 * collapse there; only this ordinal identifies the source unambiguously.
	 */
	readonly sourceOrdinal: number | null;
	readonly match: "identity" | "fallback" | "unresolved";
}

export interface ScopePlanJoin {
	readonly ordinal: number;
	readonly join: Join;
	readonly sourceIndex: number;
	readonly bindingKey: string | null;
	readonly sourceOrdinal: number | null;
	readonly match: "identity" | "fallback" | "unresolved";
}

export interface ScopePlanCommon {
	readonly scope: Scope;
	readonly outputColumns: string[] | null;
	readonly children: ScopePlan[];
}

export interface SelectScopePlan extends ScopePlanCommon {
	readonly kind: "select";
	readonly sources: ScopePlanSource[];
	readonly from: ScopePlanFrom[];
	readonly joins: ScopePlanJoin[];
	readonly where: Expr | undefined;
	readonly aggregate: boolean;
	readonly groupBy: readonly Expr[];
	readonly projectionCount: number;
}

export interface SetopScopePlan extends ScopePlanCommon {
	readonly kind: "setop";
	readonly branches: ScopePlan[];
	readonly operator: string;
}

export interface OtherScopePlan extends ScopePlanCommon {
	readonly kind: "other";
	readonly bodyKind: string;
}

export type ScopePlan = SelectScopePlan | SetopScopePlan | OtherScopePlan;

export interface ScopePlanIndex {
	readonly root: ScopePlan;
	readonly byScope: WeakMap<Scope, ScopePlan>;
}

interface SourceMatch {
	readonly key: string | null;
	readonly sourceOrdinal: number | null;
	readonly match: ScopePlanFrom["match"];
}

/**
 * The pre-ScopePlan source matcher, kept byte-for-byte in meaning so tests can
 * compare the new identity-aware projection against the old fallback.
 */
export function legacySourceBindingKey(
	scope: Scope,
	source: Source,
): string | null {
	for (const { key, source: resolved } of scope.sourceList) {
		if (resolved.kind === "table" || resolved.kind === "cte") {
			const alias = resolved.source.alias;
			if (
				source.kind === "table" &&
				((source.alias && alias?.toLowerCase() === source.alias.toLowerCase()) ||
					(!source.alias &&
						(resolved.source.relation?.name ?? "") === source.relation.name))
			) {
				return key;
			}
		} else if (
			resolved.kind === "subquery" &&
			resolved.source.alias === source.alias
		) {
			return key;
		} else if (
			resolved.kind === "lateral" &&
			resolved.source.alias === source.alias
		) {
			return key;
		}
	}

	for (const { key, source: resolved } of scope.sourceList) {
		if (resolved.kind === "table" && !resolved.source.alias) return key;
	}
	return null;
}

/** Build the new, read-only ScopeTree projection without touching buildScope. */
export function buildScopePlan(tree: ScopeTree): ScopePlan {
	return buildScopePlanFromScope(tree.root);
}

/** Build one plan and index every recursively reachable Scope exactly once. */
export function buildScopePlanIndex(tree: ScopeTree): ScopePlanIndex {
	const root = buildScopePlan(tree);
	const byScope = new WeakMap<Scope, ScopePlan>();

	function index(plan: ScopePlan): void {
		if (byScope.has(plan.scope)) return;
		byScope.set(plan.scope, plan);
		plan.children.forEach(index);
		if (plan.kind === "setop") plan.branches.forEach(index);
	}

	index(root);
	return { root, byScope };
}

/** Build the same projection for one recursively visited Scope. */
export function buildScopePlanFromScope(scope: Scope): ScopePlan {
	const cache = new WeakMap<Scope, ScopePlan>();

	function build(scope: Scope): ScopePlan {
		const cached = cache.get(scope);
		if (cached) return cached;

		const common = {
			scope,
			outputColumns: Array.isArray(scope.outputs) ? [...scope.outputs] : null,
		};
		const body = scope.body;

		if (body.kind === "setop") {
			const branches = scope.branches
				? [build(scope.branches.left), build(scope.branches.right)]
				: [];
			const result: SetopScopePlan = {
				...common,
				kind: "setop",
				branches,
				operator: body.op,
				children: scope.children.map(build),
			};
			cache.set(scope, result);
			return result;
		}

		if (body.kind !== "select") {
			const result: OtherScopePlan = {
				...common,
				kind: "other",
				bodyKind: body.kind,
				children: scope.children.map(build),
			};
			cache.set(scope, result);
			return result;
		}

		const sources = scope.sourceList.map(({ key, source }, ordinal) => ({
			key,
			source,
			ordinal,
		}));
		const from = body.from.map((source, ordinal) => {
			const match = matchSource(scope, source);
			return {
				ordinal,
				source,
				bindingKey: match.key,
				sourceOrdinal: match.sourceOrdinal,
				match: match.match,
			};
		});
		const joins = (body.joins ?? []).map((join, ordinal) => {
			const sourceIndex = body.from.findIndex((source) => source === join.source);
			const match = matchSource(scope, join.source);
			return {
				ordinal,
				join,
				sourceIndex,
				bindingKey: match.key,
				sourceOrdinal: match.sourceOrdinal,
				match: match.match,
			};
		});

		const result: SelectScopePlan = {
			...common,
			kind: "select",
			sources,
			from,
			joins,
			where: body.where,
			aggregate: body.aggregated,
			groupBy: body.groupBy ?? [],
			projectionCount: body.projections.length,
			children: scope.children.map(build),
		};
		cache.set(scope, result);
		return result;
	}

	return build(scope);
}

function matchSource(scope: Scope, source: Source): SourceMatch {
	const identity = scope.sourceList.findIndex(
		(entry) => resolvedSourceObject(entry.source) === source,
	);
	if (identity >= 0)
		return {
			key: scope.sourceList[identity]!.key,
			sourceOrdinal: identity,
			match: "identity",
		};

	const fallback = scope.sourceList.findIndex((entry) =>
		sourceLooksLike(entry.source, source),
	);
	if (fallback >= 0)
		return {
			key: scope.sourceList[fallback]!.key,
			sourceOrdinal: fallback,
			match: "fallback",
		};
	return { key: null, sourceOrdinal: null, match: "unresolved" };
}

function resolvedSourceObject(source: ResolvedSource): object | undefined {
	switch (source.kind) {
		case "table":
		case "cte":
		case "lateral":
		case "graphtable":
			return source.source;
		case "subquery":
			return source.source;
		case "relation":
			return undefined;
		case "pivot":
			return undefined;
	}
}

function sourceLooksLike(resolved: ResolvedSource, source: Source): boolean {
	if (resolved.kind === "subquery") {
		return source.kind === "subquery" && resolved.source.alias === source.alias;
	}
	if (resolved.kind === "lateral") {
		return source.kind === "lateral" && resolved.source.alias === source.alias;
	}
	if (resolved.kind === "graphtable") {
		return source.kind === "graphtable" && resolved.source.alias === source.alias;
	}
	if (resolved.kind === "table" || resolved.kind === "cte") {
		return (
			source.kind === "table" &&
			resolved.source.alias === source.alias &&
			resolved.source.relation.key.join(".") === source.relation.key.join(".")
		);
	}
	return false;
}

/** A small structural summary used by tests to compare the new plan with legacy PlanFacts. */
export function summarizeScopePlan(plan: ScopePlan): string[] {
	const lines: string[] = [];
	function visit(current: ScopePlan, path: string): void {
		if (current.kind === "select") {
			lines.push(
				`${path}:select:${current.sources.map((source) => source.key).join(",")}:` +
					`${current.from.map((entry) => entry.bindingKey ?? "?").join(",")}:` +
					`${current.joins.map((join) => `${join.join.kind}@${join.sourceIndex}`).join(",")}:` +
					`${current.where ? "filter" : "no-filter"}:` +
					`${current.aggregate ? "aggregate" : "no-aggregate"}:` +
					`${current.projectionCount}`,
			);
			current.children.forEach((child, index) => visit(child, `${path}.child${index}`));
			return;
		}
		if (current.kind === "setop") {
			lines.push(`${path}:setop:${current.operator}:${current.branches.length}`);
			current.branches.forEach((branch, index) => visit(branch, `${path}.branch${index}`));
			return;
		}
		lines.push(`${path}:other:${current.bodyKind}`);
	}
	visit(plan, "root");
	return lines;
}
