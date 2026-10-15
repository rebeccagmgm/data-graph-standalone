// ============================================================================
// plan-adapter —— 薄 adapter: sql-static-lineage scope 树 → Logical Plan Facts (JSON)
//
// 不做任何解析: 原料全部来自 sql-static-lineage 已建模的 IR + scope:
//   - 每个 query scope → read*/join*/filter?/aggregate?/project 节点链
//   - 子查询源递归展开, 父节点引用子图根 (project) id
//   - unknown 显式标注: star 层 outputs、未建模 body、缺 schema 的列
//
// v1.1 (2026-08-15):
//   - 原文不截断: *_expr / expr_text 完整原文, *_display / display_text 截断预览
//   - ColumnRef.physical: 接 schema 后复用原生 lineageAt/originsOf 解析到基表 (数组, 多源可能)
//   - inferGrain + propagateGrain: aggregate 的 grain key 沿 plan 传播,
//     join 右表 key 被连接条件覆盖时可判定不扩行 (无需外部元数据)
//   - expand: fanout 模型 (cardinality_effect/per_input_rows/grain_effect),
//     不再用 non-decreasing
//
// 坐标系: cell 内 IR 的 cst 是 CELL-RELATIVE (见 document.ts nodeAt);
//          本文件所有 span/offset 平移 cellBase 后为 DOCUMENT 坐标。
// ============================================================================
import { readFileSync } from "node:fs";
import {
  displayName,
  foldIdentifier,
  lineageAt,
  lineageOf,
  originsOfExpr,
  qualify,
  type ColumnRef as SqlLensColumnRef,
  type Expr,
  type LineageHop,
  type Projection,
  type Scope,
  type ScopeTree,
  type SchemaProvider,
  type SelectExpr,
} from "sqllens";
import type {
	AggregateRelation,
	ColumnRef,
	ExprSpec,
	ExpressionRoleBinding,
	ExpandRelation,
	FilterRelation,
	GrainInference,
  JoinRelation,
  PlanFacts,
  PlanLineageHopEdge,
  PlanLineageHopNode,
  PlanLineageHopProjection,
  PlanLineageHopRoot,
  PlanRelation,
  ProjectRelation,
  ReadRelation,
  PlanScopeBinding,
	SetopRelation,
	SourceSpan,
	TopNInputBinding,
	TopNLimitFacts,
	TopNRelation,
	WindowInputBinding,
	WindowSpecFacts,
} from "./plan-contract.js";
import {
	collectColumns,
	expressionFacts,
	expressionRoleNodes,
	predicateColumnsOf,
	predicateTreeOf,
	structuredExpressionOf,
} from "./internal/plan-expressions.js";
import {
  displayTextOf,
  fullTextOf,
  spanOf,
  spanOfCst,
} from "./internal/plan-text.js";
import { assemblePlanFacts } from "./internal/plan-output.js";
import {
  buildScopePlanIndex,
  legacySourceBindingKey,
  type SelectScopePlan,
} from "./internal/plan-scope-plan.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Detect expression subqueries from the IR instead of scanning SQL text. */
function containsExpressionSubquery(e: Expr | null | undefined): boolean {
  if (!e) return false;
  switch (e.kind) {
    case "subquery":
    case "exists":
      return true;
    case "binary":
      return containsExpressionSubquery(e.left) || containsExpressionSubquery(e.right);
    case "unary":
      return containsExpressionSubquery(e.operand);
    case "function":
      return e.args.some((arg) => containsExpressionSubquery(arg));
    case "case":
      return (
        e.whens.some(
          (branch) =>
            containsExpressionSubquery(branch.when) ||
            containsExpressionSubquery(branch.then),
        ) || containsExpressionSubquery(e.elseExpr)
      );
    case "cast":
      return containsExpressionSubquery(e.expr);
    case "predicate":
      return (
        containsExpressionSubquery(e.operand) ||
        e.args.some((arg) => containsExpressionSubquery(arg))
      );
    case "lambda":
      return containsExpressionSubquery(e.body);
    case "subscript":
      return (
        containsExpressionSubquery(e.base) ||
        containsExpressionSubquery(e.index) ||
        containsExpressionSubquery(e.end) ||
        containsExpressionSubquery(e.step)
      );
    default:
      return false;
  }
}

// In-memory provenance only; these supplemental origins carry no syntactic alias.
const nativeOriginRefs = new WeakSet<ColumnRef>();

/**
 * Keep the adapter's syntactic references, but add the physical origins already
 * proven by sql-static-lineage's native expression lineage walk.  The latter is
 * essential for nested scalar/EXISTS subqueries: their columns live in a child
 * scope and are not direct ColumnRef nodes of the enclosing scope.
 */
function inputColumnsFor(
  e: Expr | null | undefined,
  scope: Scope,
  clause: ColumnRef["clause"],
  schema: unknown,
  dialect: string,
  includeNativeLineage = false,
  onNativeLineageError?: (error: unknown) => void,
): ColumnRef[] {
  const out: ColumnRef[] = [];
  collectColumns(e, clause, out);
  if (!includeNativeLineage || !e || !schema) return out;
  try {
    for (const origin of originsOfExpr(e, scope, schema as SchemaProvider)) {
      const table = origin.table.join(".");
      if (!schemaContainsField(schema, table, origin.column, dialect)) continue;
      const ref: ColumnRef = {
        name: displayName(origin.column, dialect),
        clause,
        physical: [{ table, column: displayName(origin.column, dialect) }],
        resolution: "PHYSICAL",
      };
      nativeOriginRefs.add(ref);
      out.push(ref);
    }
  } catch (error) {
    // Keep the existing syntactic path as a fallback, but never hide the
    // native failure from Machine Facts consumers.
    onNativeLineageError?.(error);
  }
  return out;
}

type CstLike = {
	start?: { start?: number } | null;
	stop?: { stop?: number } | null;
	parentCtx?: CstLike | null;
	parent?: CstLike | null;
  constructor?: { name?: string };
  getChildCount?: () => number;
  getChild?: (index: number) => unknown;
  symbol?: { text?: string };
};

/** Find the sort item that owns a lowered window ORDER expression. */
function sortItemOf(expr: Expr): CstLike | null {
  let node: CstLike | null =
    ((expr as Expr & { cst?: CstLike }).cst as CstLike | undefined) ?? null;
  while (node) {
    if (node.constructor?.name === "SortItemContext") return node;
    node = node.parentCtx ?? node.parent ?? null;
  }
	return null;
}

/**
 * Some lowerers currently leak a frame-bound expression into partitionBy
 * while WindowSpec has no frame field.  Use only the CST parent structure as a
 * guard against publishing that bound as a partition input; the frame itself
 * remains UNKNOWN below.  No SQL text is inspected or reconstructed here.
 */
function isWindowFrameExpression(expr: Expr): boolean {
	let node: CstLike | null =
		((expr as Expr & { cst?: CstLike }).cst as CstLike | undefined) ?? null;
	while (node) {
		const name = node.constructor?.name?.toLowerCase() ?? "";
		if (name.includes("windowframe") || name.includes("framebound"))
			return true;
		node = node.parentCtx ?? node.parent ?? null;
	}
	return false;
}

/** Read only direction/NULLS tokens from the owning sort item; never infer NULLS defaults. */
function orderSemanticsOf(expr: Expr): {
  direction: "ASC" | "DESC";
  nulls: "FIRST" | "LAST" | "UNSPECIFIED";
} {
  const sortItem = sortItemOf(expr);
  const terminalTexts: string[] = [];
  for (let i = 0; sortItem && i < (sortItem.getChildCount?.() ?? 0); i++) {
    const child = sortItem.getChild?.(i) as CstLike | undefined;
    const text =
      child?.symbol?.text ??
      (child?.constructor?.name === "TerminalNode"
        ? (child as any).getText?.()
        : undefined);
    if (text) terminalTexts.push(text.toLowerCase());
  }
  const direction = terminalTexts.includes("desc") ? "DESC" : "ASC";
  const nullsIndex = terminalTexts.indexOf("nulls");
  const nullsToken =
    nullsIndex >= 0 ? terminalTexts[nullsIndex + 1] : undefined;
  const nulls =
    nullsToken === "first" || nullsToken === "last"
      ? (nullsToken.toUpperCase() as "FIRST" | "LAST")
      : "UNSPECIFIED";
  return { direction, nulls };
}

/** Reuse the expression-level syntactic refs for Window occurrences so physical resolution and
 * Unknown reporting happen once per source occurrence, while native lineage-only refs remain local
 * to the occurrence that produced them. */
function shareWindowInputRefs(expression: ExprSpec): void {
  const all = expression.input_columns ?? [];
  const byOffset = new Map<number, ColumnRef>();
  for (const ref of all) {
    const offset = (ref as RefWithOffset)._cellOffset;
    if (offset != null && !byOffset.has(offset)) byOffset.set(offset, ref);
  }
  for (const binding of expression.window_spec?.input_bindings ?? []) {
    binding.input_columns = binding.input_columns.map((ref) => {
      const offset = (ref as RefWithOffset)._cellOffset;
      return offset == null ? ref : (byOffset.get(offset) ?? ref);
    });
  }
}

function expressionRoleBindings(
	expression: Expr,
	sql: string,
	cellBase: number,
	scope: Scope,
	schema: unknown,
	dialect: string,
	includeDependencies: boolean,
	onNativeLineageError: (error: unknown) => void,
): ExpressionRoleBinding[] {
	if (!includeDependencies) return [];
	const all = expressionInputColumns(expression);
	const byOffset = new Map<number, ColumnRef>();
	for (const ref of all) {
		const offset = (ref as RefWithOffset)._cellOffset;
		if (offset != null && !byOffset.has(offset)) byOffset.set(offset, ref);
	}
	return expressionRoleNodes(expression, dialect).map((role) => {
		const inputColumns = inputColumnsFor(
			role.expression,
			scope,
			"projection",
			schema,
			dialect,
			true,
			onNativeLineageError,
		).map((ref) => {
			const offset = (ref as RefWithOffset)._cellOffset;
			return offset == null ? ref : (byOffset.get(offset) ?? ref);
		});
		return {
			operator: role.operator,
			role: role.role,
			effects: role.effects,
			path: role.path,
			...(role.branch_ordinal === undefined
				? {}
				: { branch_ordinal: role.branch_ordinal }),
			ordinal: role.ordinal,
			expression_text: fullTextOf(sql, cellBase, role.expression.cst),
			display_text: displayTextOf(sql, cellBase, role.expression.cst),
			span: spanOf(cellBase, role.expression.cst),
			input_columns: inputColumns,
		};
	});
}

function expressionInputColumns(expression: Expr): ColumnRef[] {
	const refs: ColumnRef[] = [];
	collectColumns(expression, "projection", refs);
	return refs;
}

function windowInputBinding(
  role: WindowInputBinding["role"],
  ordinal: number,
  input: Expr,
  sql: string,
  cellBase: number,
  scope: Scope,
  schema: unknown,
  dialect: string,
  includeDependencies: boolean,
  onNativeLineageError: (error: unknown) => void,
): WindowInputBinding {
  const clause =
    role === "WINDOW_PARTITION"
      ? "windowPartition"
      : role === "WINDOW_ORDER"
        ? "windowOrder"
        : "projection";
  const inputColumns = includeDependencies
    ? inputColumnsFor(
        input,
        scope,
        clause,
        schema,
        dialect,
        true,
        onNativeLineageError,
      )
    : [];
  const binding: WindowInputBinding = {
    role,
    ordinal,
    expression_text: fullTextOf(sql, cellBase, input.cst as any),
    display_text: displayTextOf(sql, cellBase, input.cst as any),
    span: spanOf(cellBase, input.cst as any),
    input_columns: inputColumns,
  };
  if (role === "WINDOW_ORDER") Object.assign(binding, orderSemanticsOf(input));
  return binding;
}

function windowSpecOf(
  expression: Expr & {
    window?: { partitionBy: Expr[]; orderBy: Expr[]; cst: unknown };
    args: Expr[];
  },
  sql: string,
  cellBase: number,
  scope: Scope,
  schema: unknown,
  dialect: string,
  includeDependencies: boolean,
  onNativeLineageError: (error: unknown) => void,
): WindowSpecFacts | undefined {
  const window = expression.window;
  if (!window) return undefined;
  const input_bindings: WindowInputBinding[] = [];
  for (const [ordinal, input] of expression.args.entries())
    input_bindings.push(
      windowInputBinding(
        "VALUE",
        ordinal,
        input,
        sql,
        cellBase,
        scope,
        schema,
        dialect,
        includeDependencies,
        onNativeLineageError,
      ),
    );
	for (const [ordinal, input] of window.partitionBy.entries()) {
		if (isWindowFrameExpression(input)) continue;
		input_bindings.push(
			windowInputBinding(
        "WINDOW_PARTITION",
        ordinal,
        input,
        sql,
        cellBase,
        scope,
        schema,
        dialect,
        includeDependencies,
        onNativeLineageError,
			),
		);
	}
  for (const [ordinal, input] of window.orderBy.entries())
    input_bindings.push(
      windowInputBinding(
        "WINDOW_ORDER",
        ordinal,
        input,
        sql,
        cellBase,
        scope,
        schema,
        dialect,
        includeDependencies,
        onNativeLineageError,
      ),
    );
	return {
		source_span: spanOf(cellBase, window.cst as any),
		expression_text: fullTextOf(sql, cellBase, window.cst as any),
		display_text: displayTextOf(sql, cellBase, window.cst as any),
		input_bindings,
		// WindowSpec in the canonical IR currently has no frame member. Keep the
		// dependency surface explicit without inspecting the CST or SQL text.
		frame: {
			status: "UNKNOWN",
			expression_text: null,
			display_text: null,
			span: spanOf(cellBase, window.cst as any),
			input_columns: [],
			reason: "canonical WindowSpec IR does not expose frame bounds",
		},
	};
}

function topNInputBinding(
	role: TopNInputBinding["role"],
	ordinal: number,
	input: Expr,
	sql: string,
	cellBase: number,
	scope: Scope,
	schema: unknown,
	dialect: string,
	includeDependencies: boolean,
	onNativeLineageError: (error: unknown) => void,
): TopNInputBinding {
	const binding: TopNInputBinding = {
		role,
		ordinal,
		expression_text: fullTextOf(sql, cellBase, input.cst),
		display_text: displayTextOf(sql, cellBase, input.cst),
		span: spanOf(cellBase, input.cst),
		input_columns: includeDependencies
			? inputColumnsFor(
					input,
					scope,
					role === "ORDER" ? "orderBy" : "limit",
					schema,
					dialect,
					true,
					onNativeLineageError,
				)
			: [],
	};
	if (role === "ORDER") Object.assign(binding, orderSemanticsOf(input));
	return binding;
}

function cstParent(node: CstLike | null): CstLike | null {
	return node?.parent ?? node?.parentCtx ?? null;
}

function cstContains(outer: CstLike, inner: CstLike): boolean {
	const outerStart = outer.start?.start;
	const outerStop = outer.stop?.stop;
	const innerStart = inner.start?.start;
	const innerStop = inner.stop?.stop;
	return (
		outerStart !== undefined &&
		outerStop !== undefined &&
		innerStart !== undefined &&
		innerStop !== undefined &&
		outerStart <= innerStart &&
		outerStop >= innerStop
	);
}

/**
 * Find the owning query CST only when it is a named query/select container and
 * contains both the relation body and every Top-N input.  Scope intentionally
 * does not carry QueryExpr.cst, so a missing trustworthy ancestor stays null;
 * expression-span min/max must not be used as a fabricated SQL span.
 */
function topNSpanOf(
	scope: Scope,
	inputs: readonly Expr[],
	cellBase: number,
): SourceSpan | null {
	const anchors = [
		scope.body.cst as unknown as CstLike,
		...inputs.map((input) => input.cst as unknown as CstLike),
	];
	let candidate: CstLike | null = anchors[0] ?? null;
	while (candidate) {
		const name = candidate.constructor?.name?.toLowerCase() ?? "";
		const isQueryContainer =
			(name.includes("query") || name.includes("select")) &&
			!name.includes("multistatement");
		if (isQueryContainer && anchors.every((anchor) => cstContains(candidate!, anchor))) {
			const span = spanOf(cellBase, candidate);
			if (span.end > span.start) return span;
		}
		candidate = cstParent(candidate);
	}
	return null;
}

function nativeLineageErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "unknown error";
}

/** Remove duplicate physical origins after syntactic refs and native origins meet. */
function dedupePhysicalInputColumns(
  refs: ColumnRef[],
  preserveOccurrenceQualifier = false,
): ColumnRef[] {
  const seen = new Set<string>();
  const seenPhysical = new Set<string>();
  return refs.flatMap((ref) => {
    if (ref.resolution !== "PHYSICAL" || !ref.physical?.length) return [ref];
    const qualifier = preserveOccurrenceQualifier
      ? (ref.qualifier?.toLowerCase() ?? "")
      : "";
    const physical = ref.physical.filter((item) => {
      const physicalKey = `${item.table}.${item.column}`.toLowerCase();
      // Native origins supplement syntactic refs but have no read qualifier.
      // Do not reintroduce an unqualified copy of an already witnessed input.
      if (
        preserveOccurrenceQualifier
        && nativeOriginRefs.has(ref)
        && seenPhysical.has(physicalKey)
      ) return false;
      // A physical field can occur through two aliases of the same table.
      // Keep those READ-occurrence bindings distinct; only duplicate evidence
      // for the same syntactic qualifier is removed.
      const key = `${qualifier}\u0000${item.table}.${item.column}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      seenPhysical.add(physicalKey);
      return true;
    });
    return physical.length > 0 ? [{ ...ref, physical }] : [];
  });
}

type RefWithOffset = ColumnRef & { _cellOffset?: number };

/**
 * Resolve a source table from SQL structure alone when the scope has exactly
 * one eligible physical table, or when a qualifier names one explicitly.
 * This is a candidate binding: without Schema Evidence the column's
 * existence is not verified.
 */
function sqlCandidateFor(
  ref: ColumnRef,
  scope: Scope,
): { table: string; column: string }[] | null {
  const qualified = ref.qualifier
    ? [...scope.sources.entries()].find(
        ([key]) => key.toLowerCase() === ref.qualifier!.toLowerCase(),
      )?.[1]
    : undefined;
  if (qualified?.kind === "table" && qualified.source?.relation?.fqn) {
    return [{ table: qualified.source.relation.fqn, column: ref.name }];
  }
  if (ref.qualifier) return null;
  const tables = [...scope.sources.values()]
    .filter(
      (source: any) => source.kind === "table" && source.source?.relation?.fqn,
    )
    .map((source: any) => String(source.source.relation.fqn));
  return tables.length === 1 ? [{ table: tables[0]!, column: ref.name }] : null;
}

function schemaContainsField(
  schema: unknown,
  table: string,
  column: string,
  dialect: string,
): boolean {
  const provider = schema as {
    columnsFor?: (
      parts: string[],
      dialect?: string,
    ) => Array<{ name?: string }> | undefined;
  } | null;
  const columns = provider?.columnsFor?.(table.split("."), dialect);
  const foldedColumn = foldIdentifier(column, dialect);
  return (
    Array.isArray(columns) &&
    columns.some(
      (candidate) =>
        candidate.name !== undefined &&
        foldIdentifier(candidate.name, dialect) === foldedColumn,
    )
  );
}

type DerivedOutputResolution =
  | { kind: "PHYSICAL"; physical: { table: string; column: string }[] }
  | { kind: "SQL_CANDIDATE"; candidates: { table: string; column: string }[] }
  | { kind: "DERIVED_OUTPUT" }
  | null;

type DerivedOutputResolver = (
  scope: Scope,
  name: string,
) => DerivedOutputResolution;

/** Resolve one output column through a UNION/UNION ALL subquery boundary. */
function resolveSetopOutput(
  cell: { scopes: ScopeTree },
  schema: unknown,
  scope: Scope,
  name: string,
  resolveDerivedOutput?: DerivedOutputResolver,
): DerivedOutputResolution {
  if (scope.body.kind === "setop") {
    if (!scope.branches) return null;
    const branches = [scope.branches.left, scope.branches.right];
    const resolutions = branches.map(
      (branch) =>
        resolveDerivedOutput?.(branch, name) ??
        resolveSetopOutput(cell, schema, branch, name, resolveDerivedOutput),
    );
    if (resolutions.some((resolution) => resolution === null)) return null;
    const physical = resolutions.flatMap((resolution) =>
      resolution?.kind === "PHYSICAL" ? resolution.physical : [],
    );
    const candidates = resolutions.flatMap((resolution) =>
      resolution?.kind === "SQL_CANDIDATE" ? resolution.candidates : [],
    );
    if (physical.length > 0 && candidates.length > 0) {
      const seen = new Set<string>();
      return {
        kind: "SQL_CANDIDATE",
        candidates: [...physical, ...candidates].filter((item) => {
          const key = `${item.table}.${item.column}`.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    }
    if (physical.length > 0) {
      const seen = new Set<string>();
      return {
        kind: "PHYSICAL",
        physical: physical.filter((item) => {
          const key = `${item.table}.${item.column}`.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    }
    if (candidates.length > 0) {
      const seen = new Set<string>();
      return {
        kind: "SQL_CANDIDATE",
        candidates: candidates.filter((item) => {
          const key = `${item.table}.${item.column}`.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    }
    return { kind: "DERIVED_OUTPUT" };
  }
  if (scope.body.kind !== "select" || !Array.isArray(scope.outputs))
    return null;
  const ordinal = scope.outputs.findIndex(
    (output) => output.toLowerCase() === name.toLowerCase(),
  );
  const projection = ordinal >= 0 ? scope.body.projections[ordinal] : undefined;
  if (!projection) return null;
  if (projection.expr.kind === "literal") return { kind: "DERIVED_OUTPUT" };
  if (
    projection.expr.kind !== "column" ||
    projection.expr.partSpans?.[0]?.start == null
  )
    return null;
  const hop = lineageAt(
    cell.scopes,
    projection.expr.partSpans[0].start,
    schema as never,
  );
  if (
    hop &&
    hop.terminal !== "unresolved" &&
    hop.terminal &&
    hop.terminal.every((origin) =>
      schemaContainsField(
        schema,
        origin.table.join("."),
        origin.column,
        cell.scopes.root.dialect,
      ),
    )
  ) {
    return {
      kind: "PHYSICAL",
      physical: hop.terminal.map((origin) => ({
        table: origin.table.join("."),
        column: displayName(origin.column, cell.scopes.root.dialect),
      })),
    };
  }
  const parts = projection.expr.parts;
  const candidate = sqlCandidateFor(
    {
      name: parts[parts.length - 1] ?? name,
      qualifier: parts.length > 1 ? parts[0] : undefined,
      clause: "projection",
      physical: null,
    },
    scope,
  );
  return candidate ? { kind: "SQL_CANDIDATE", candidates: candidate } : null;
}

/** 物理解析: 用 sql-static-lineage lineageAt 把列引用追到基表 (喂 schema 后)。
 *  锚定用 IR partSpans[0] (列名 token 的 cell 坐标) —— nodeAt 是裸数值比较,
 *  必须精确落在列名 token 上, 否则会命中父表达式/别名 (错位解析)。
 *  注意: lineageAt 返回的 hop.terminal 可能为 undefined (followColumn 无来源),
 *  此时列保持 physical=null, 并由调用方记入 unknowns。 */
function resolvePhysical(
  cell: { scopes: ScopeTree },
  schema: unknown,
  scope: Scope,
  nodeId: string,
  refs: ColumnRef[],
  unknownSink: {
    node_id: string;
    field: string;
    reason: string;
    span?: SourceSpan;
  }[],
  dialect: string,
  systemValueNames: ReadonlySet<string>,
  resolveDerivedOutput?: DerivedOutputResolver,
): void {
  const schemaHasColumn = (table: string[], column: string): boolean => {
    const provider = schema as {
      columnsFor?: (
        parts: string[],
        dialect?: string,
      ) => Array<{ name?: string }> | undefined;
    };
    const columns = provider.columnsFor?.(table, dialect);
    const foldedColumn = foldIdentifier(column, dialect);
    return (
      Array.isArray(columns) &&
      columns.some(
        (candidate) =>
          candidate.name !== undefined &&
          foldIdentifier(candidate.name, dialect) === foldedColumn,
      )
    );
  };
  const sourceFor = (qualifier: string): any => {
    for (const [key, source] of scope.sources) {
      if (key.toLowerCase() === qualifier.toLowerCase()) return source;
    }
    return undefined;
  };
  const qualification =
    schema !== undefined && schema !== null
      ? qualify(cell.scopes, schema as SchemaProvider)
      : undefined;
  const resolveColumnBinding = (parts: string[]) =>
    qualification?.bindingOf(scope, { kind: "columnref", parts } as SqlLensColumnRef);
  for (const ref of refs) {
    const withOff = ref as RefWithOffset;
    if (withOff._cellOffset == null) continue;
    if (!ref.qualifier && systemValueNames.has(ref.name.toLowerCase())) {
      ref.resolution = "DERIVED_OUTPUT";
      ref.derived_from = `SYSTEM_VALUE:${ref.name.toUpperCase()}`;
      delete withOff._cellOffset;
      continue;
    }
    if (ref.qualifier) {
      const source = sourceFor(ref.qualifier);
      if (
        source?.kind === "lateral" &&
        Array.isArray(source.source?.columns) &&
        source.source.columns.some(
          (column: string) => column.toLowerCase() === ref.name.toLowerCase(),
        )
      ) {
        ref.resolution = "DERIVED_OUTPUT";
        ref.derived_from = `LATERAL_OUTPUT:${ref.qualifier}.${ref.name}`;
        delete withOff._cellOffset;
        continue;
      }
      // CTEs and parenthesized derived tables expose the same output
      // boundary. Keep both on the adapter path so CTE references do not
      // fall back to lineageAt and get misreported as a lateral blind spot.
      const sourceScope =
        source?.kind === "subquery"
          ? source.scope
          : source?.kind === "cte"
            ? source.ref.scope
            : undefined;
      const sourceOutputs = sourceScope?.outputs;
      if (sourceScope && sourceScope.body.kind !== "setop") {
        const derived = resolveDerivedOutput?.(sourceScope, ref.name);
        if (derived?.kind === "PHYSICAL") {
          ref.physical = derived.physical;
          ref.resolution = "PHYSICAL";
          delete withOff._cellOffset;
          continue;
        }
        if (derived?.kind === "SQL_CANDIDATE") {
          ref.sql_candidate = derived.candidates;
          ref.resolution = "SQL_CANDIDATE";
          delete withOff._cellOffset;
          continue;
        }
        if (derived?.kind === "DERIVED_OUTPUT") {
          ref.resolution = "DERIVED_OUTPUT";
          ref.derived_from = `SUBQUERY_OUTPUT:${ref.qualifier}.${ref.name}`;
          delete withOff._cellOffset;
          continue;
        }
      }
      if (
        sourceScope?.body.kind === "setop" &&
        (Array.isArray(sourceOutputs)
          ? sourceOutputs.some(
              (output: string) =>
                output.toLowerCase() === ref.name.toLowerCase(),
            )
          : true)
      ) {
        const derived = resolveSetopOutput(
          cell,
          schema,
          sourceScope,
          ref.name,
          resolveDerivedOutput,
        );
        if (derived?.kind === "PHYSICAL") {
          ref.physical = derived.physical;
          ref.resolution = "PHYSICAL";
          delete withOff._cellOffset;
          continue;
        }
        if (derived?.kind === "SQL_CANDIDATE") {
          ref.sql_candidate = derived.candidates;
          ref.resolution = "SQL_CANDIDATE";
          delete withOff._cellOffset;
          continue;
        }
        if (derived?.kind === "DERIVED_OUTPUT") {
          ref.resolution = "DERIVED_OUTPUT";
          ref.derived_from = `SETOP_OUTPUT:${ref.qualifier}.${ref.name}`;
          delete withOff._cellOffset;
          continue;
        }
      }
      if (source && source.kind !== "table" && source.kind !== "lateral") {
        const derivedFromAlias =
          source.kind === "subquery"
            ? source.source.alias
            : source.kind === "cte"
              ? source.ref.def.name
              : source.kind === "pivot"
                ? source.alias
                : ref.qualifier ?? source.kind;
        if (derivedFromAlias !== undefined) {
          ref.resolution = "DERIVED_OUTPUT";
          ref.derived_from = `SUBQUERY_OUTPUT:${derivedFromAlias}.${ref.name}`;
          delete withOff._cellOffset;
          continue;
        }
      }
    }
    if (!ref.qualifier && scope.sources.size === 1) {
      const onlySource = [...scope.sources.values()][0];
      if (onlySource?.kind === "subquery" || onlySource?.kind === "cte") {
        const onlySourceScope =
          onlySource.kind === "subquery"
            ? onlySource.scope
            : onlySource.ref.scope;
        const derived =
          onlySourceScope.body.kind === "setop"
            ? resolveSetopOutput(
                cell,
                schema,
                onlySourceScope,
                ref.name,
                resolveDerivedOutput,
              )
            : resolveDerivedOutput?.(onlySourceScope, ref.name);
        if (derived?.kind === "PHYSICAL") {
          ref.physical = derived.physical;
          ref.resolution = "PHYSICAL";
          delete withOff._cellOffset;
          continue;
        }
        if (derived?.kind === "SQL_CANDIDATE") {
          ref.sql_candidate = derived.candidates;
          ref.resolution = "SQL_CANDIDATE";
          delete withOff._cellOffset;
          continue;
        }
        if (derived?.kind === "DERIVED_OUTPUT") {
          ref.resolution = "DERIVED_OUTPUT";
          ref.derived_from = `SUBQUERY_OUTPUT:${ref.name}`;
          delete withOff._cellOffset;
          continue;
        }
        const boundOnlySource = resolveColumnBinding([ref.name])?.source;
        if (boundOnlySource?.kind === "subquery") {
          ref.resolution = "DERIVED_OUTPUT";
          ref.derived_from = `SUBQUERY_OUTPUT:${boundOnlySource.source.alias ?? ref.name}.${ref.name}`;
          delete withOff._cellOffset;
          continue;
        }
        if (boundOnlySource?.kind === "cte") {
          ref.resolution = "DERIVED_OUTPUT";
          ref.derived_from = `SUBQUERY_OUTPUT:${boundOnlySource.ref.def.name}.${ref.name}`;
          delete withOff._cellOffset;
          continue;
        }
      }
    }
    if (!ref.qualifier) {
      const bound = resolveColumnBinding([ref.name]);
      if (bound?.source.kind === "lateral") {
        ref.resolution = "DERIVED_OUTPUT";
        ref.derived_from = `LATERAL_OUTPUT:${bound.source.source.alias ?? ref.name}.${ref.name}`;
        delete withOff._cellOffset;
        continue;
      }
      if (bound?.source.kind !== undefined && bound.source.kind !== "table") {
        const derivedFromAlias =
          bound.source.kind === "subquery"
            ? bound.source.source.alias ?? ref.name
            : bound.source.kind === "cte"
              ? bound.source.ref.def.name
              : bound.source.kind === "pivot"
                ? bound.source.alias
                : bound.source.kind;
        ref.resolution = "DERIVED_OUTPUT";
        ref.derived_from = `SUBQUERY_OUTPUT:${derivedFromAlias}.${ref.name}`;
        delete withOff._cellOffset;
        continue;
      }
    }
    const hop = lineageAt(cell.scopes, withOff._cellOffset, schema as never);
    if (
      hop &&
      hop.terminal !== "unresolved" &&
      hop.terminal &&
      hop.terminal.every((output) =>
        schemaHasColumn(output.table, output.column),
      )
    ) {
      ref.physical = hop.terminal.map((o) => ({
        table: o.table.join("."),
        column: displayName(o.column, dialect),
      }));
      ref.resolution = "PHYSICAL";
    } else {
      const candidate = sqlCandidateFor(ref, scope);
      if (candidate) {
        ref.sql_candidate = candidate;
        ref.resolution = "SQL_CANDIDATE";
        delete withOff._cellOffset;
        continue;
      }
      const why = !hop
        ? "锚定失败"
        : hop.terminal === "unresolved"
          ? "sql-static-lineage 判定 unresolved (列不在 schema/绑定失败)"
          : Array.isArray(hop.terminal) &&
              !hop.terminal.every((output) =>
                schemaHasColumn(output.table, output.column),
              )
            ? "lineage 已找到候选基表，但当前 schema 快照缺少字段证据"
            : "followColumn 无来源 (sql-static-lineage 对 lateral 子查询别名列盲区)";
      ref.resolution = "UNRESOLVED";
      unknownSink.push({
        node_id: nodeId,
        field: "physical",
        reason: `${ref.qualifier ? ref.qualifier + "." : ""}${ref.name} 无法解析到基表: ${why}`,
      });
    }
    delete withOff._cellOffset; // 解析完清除中间值 (不进 JSON)
  }
}

// ---------------------------------------------------------------------------
// adapter 主体
// ---------------------------------------------------------------------------

export interface PlanAdapterOptions {
  statement_index?: number;
  adapter_version?: string;
  /** Internal parity switch; default keeps the parallel ScopePlan path. */
  scope_projection?: "legacy" | "parallel";
  /** 可选 schema (sql-static-lineage Schema 实例), 提供后条件列 physical 解析启用。 */
  schema?: unknown;
  /** 方言 (用于 schema 列折叠), 默认 databricks。 */
  dialect?: string;
  /**
   * Explicit bare system values emitted by a source/target SQL contract (for example Oracle
   * SYSDATE in a parameterized VALUES clause). These names are treated as derived values, not
   * as physical columns. Keep this opt-in: a real unqualified column with the same name must not
   * be globally hidden from lineage resolution.
   */
  system_value_names?: readonly string[];
  /** 为指标因果路径生成结构化表达式依赖；默认关闭以保持既有产物稳定。 */
  include_expression_dependencies?: boolean;
}

type HopRequest = {
  projection?: Projection;
  scope: Scope;
  relationId: string;
  expressionId: string;
  expression: ExprSpec;
};

function exprHasSubquery(expr: Expr | null | undefined): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "subquery":
    case "exists":
      return true;
    case "binary":
      return exprHasSubquery(expr.left) || exprHasSubquery(expr.right);
    case "unary":
      return exprHasSubquery(expr.operand);
    case "function":
      return expr.args.some((arg) => exprHasSubquery(arg));
    case "case":
      return (
        expr.whens.some(
          (branch) =>
            exprHasSubquery(branch.when) || exprHasSubquery(branch.then),
        ) || exprHasSubquery(expr.elseExpr)
      );
    case "cast":
      return exprHasSubquery(expr.expr);
    case "predicate":
      return (
        exprHasSubquery(expr.operand) ||
        expr.args.some((arg) => exprHasSubquery(arg))
      );
    case "subscript":
      return (
        exprHasSubquery(expr.base) ||
        exprHasSubquery(expr.index) ||
        exprHasSubquery(expr.end) ||
        exprHasSubquery(expr.step)
      );
    case "lambda":
      return exprHasSubquery(expr.body);
    case "with":
      return (
        expr.bindings.some((binding) => exprHasSubquery(binding.value)) ||
        exprHasSubquery(expr.result)
      );
    default:
      return false;
  }
}

function scopeHasUnsupportedHopCoverage(
  scope: Scope,
  visiting = new Set<Scope>(),
): boolean {
  if (visiting.has(scope)) return true;
  const next = new Set(visiting).add(scope);
  const body = scope.body as any;
  if (body.kind === "pipe" || body.pivot || body.unpivot) return true;
  if (Array.isArray(body.unsupported) && body.unsupported.length > 0)
    return true;
  for (const source of scope.sources.values() as Iterable<any>) {
    if (
      [
        "lateral",
        "pivot",
        "unpivot",
        "tvf",
        "tableFunction",
        "graphtable",
      ].includes(String(source.kind))
    )
      return true;
    const child = source.scope ?? source.ref?.scope;
    if (child && scopeHasUnsupportedHopCoverage(child, next)) return true;
  }
  return false;
}

function physicalFieldsOf(
  expression: ExprSpec,
  candidate: boolean,
): { table: string; column: string }[] {
  const fields: { table: string; column: string }[] = [];
  for (const input of expression.input_columns ?? []) {
    if (candidate && input.resolution === "SQL_CANDIDATE") {
      fields.push(...(input.sql_candidate ?? []));
    } else if (!candidate && input.resolution === "PHYSICAL") {
      fields.push(...(input.physical ?? []));
    }
  }
  const seen = new Set<string>();
  return fields.filter((field) => {
    const key = `${field.table}.${field.column}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function localFieldKey(field: { table: string; column: string }): string {
  return `${field.table}.${field.column}`.toLowerCase();
}

function descendantRelationIds(
  relationId: string,
  byId: Map<string, JsonLikeRelation>,
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(relationId)) return seen;
  seen.add(relationId);
  const relation = byId.get(relationId);
  if (!relation) return seen;
  for (const child of [
    relation.source,
    relation.left,
    relation.right,
    ...(relation.branches ?? []),
  ]) {
    if (child) descendantRelationIds(child, byId, seen);
  }
  return seen;
}

type JsonLikeRelation = {
  id: string;
  type: string;
  source?: string;
  left?: string;
  right?: string;
  branches?: string[];
};

function setopBranchOf(
  relationId: string,
  relations: readonly PlanRelation[],
): { relation_id: string; ordinal: number } | undefined {
  const byId = new Map(
    relations.map((relation) => [relation.id, relation as JsonLikeRelation]),
  );
  for (const relation of relations) {
    if (relation.type !== "setop") continue;
    for (const [ordinal, branch] of relation.branches.entries()) {
      const descendants = descendantRelationIds(branch, byId);
      if (descendants.has(relationId))
        return { relation_id: relation.id, ordinal };
    }
  }
  return undefined;
}

function nativeHopProjection(
  cellBase: number,
  sql: string,
  schema: unknown,
  dialect: string,
  relations: readonly PlanRelation[],
  relationScopes: ReadonlyMap<string, Scope>,
  scopeRelationIds: ReadonlyMap<Scope, string>,
  projectionLocators: ReadonlyMap<
    Scope,
    ReadonlyMap<Projection, { relationId: string; expressionId: string }>
  >,
  requests: readonly HopRequest[],
): PlanLineageHopProjection {
  const roots: PlanLineageHopRoot[] = [];
  const nodes = new Map<string, PlanLineageHopNode>();
  const edges = new Map<string, PlanLineageHopEdge>();

  for (const request of requests) {
    const physicalInputs = physicalFieldsOf(request.expression, false);
    const candidateInputs = physicalFieldsOf(request.expression, true);
    const base = {
      flow_kind: "VALUE_LINEAGE" as const,
      root_expression_id: request.expressionId,
      physical_input_fields: physicalInputs,
      candidate_input_fields: candidateInputs,
    };
    if (
      request.expression.output_name_status === "STAR_EXPANSION" ||
      request.expression.output === "*"
    ) {
      const hasPhysicalOrigin = physicalInputs.length > 0;
      roots.push({
        ...base,
        head_hop_id: null,
        coverage_state: hasPhysicalOrigin
          ? "FLAT_ORIGIN_ONLY"
          : "NOT_EVALUABLE",
        projection_status: hasPhysicalOrigin
          ? "PARTIAL_NATIVE"
          : "NOT_EVALUABLE",
        reason_code: "NATIVE_STAR_COLUMN_ANCHOR_UNAVAILABLE",
        reason: hasPhysicalOrigin
          ? "Schema-backed Star Expansion has physical origins, but no native per-column Projection anchor"
          : "Star Expansion has no proven physical origin or native per-column Projection anchor",
      });
      continue;
    }

    const locator = request.projection
      ? projectionLocators.get(request.scope)?.get(request.projection)
      : undefined;
    const scopeRelationId =
      locator?.relationId ?? scopeRelationIds.get(request.scope);
    const unsupported = scopeHasUnsupportedHopCoverage(request.scope);
    const flatOnly = exprHasSubquery(request.projection?.expr);
    const unknownExpr = request.projection?.expr.kind === "other";
    let head: LineageHop | null = null;
    let nativeFailure: string | undefined;
    if (!scopeRelationId) {
      nativeFailure = "NATIVE_SCOPE_RELATION_MAPPING_UNAVAILABLE";
    } else {
      try {
        if (!request.projection)
          throw new Error("NATIVE_PROJECTION_MAPPING_UNAVAILABLE");
        head = lineageOf(request.projection, request.scope, schema as never);
      } catch (error) {
        nativeFailure = `NATIVE_LINEAGE_FAILED: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const localNodes = new Map<string, PlanLineageHopNode>();
    const localEdges = new Map<string, PlanLineageHopEdge>();
    let mappingFailure = nativeFailure;
    const serializedIds = new Map<LineageHop, string>();
    const active = new Set<string>();
    const serialize = (
      hop: LineageHop,
      preferredLocator?: { relationId: string; expressionId: string },
    ): string | null => {
      const hopLocator =
        preferredLocator ??
        (hop.projection
          ? projectionLocators.get(hop.scope)?.get(hop.projection)
          : undefined);
      const relationId =
        hopLocator?.relationId ?? scopeRelationIds.get(hop.scope);
      if (!relationId) {
        mappingFailure ??= "NATIVE_SCOPE_RELATION_MAPPING_UNAVAILABLE";
        return null;
      }
      const span = spanOfCst(cellBase, hop.expr.cst);
      const expressionId = hopLocator?.expressionId;
      const localId = `hop:${relationId}:${expressionId ?? `span:${span.start}:${span.end}`}:${hop.expr.kind}`;
      const existing = serializedIds.get(hop);
      if (existing) return existing;
      if (active.has(localId)) {
        mappingFailure ??= "NATIVE_HOP_CYCLE";
        // Do not serialize a back-edge. Returning the active id would still
        // make the caller persist an HOP_TO_HOP edge and turn a native
        // uncertainty into an invalid graph. The root is downgraded below.
        return null;
      }
      serializedIds.set(hop, localId);
      active.add(localId);
      const terminalFields = Array.isArray(hop.terminal)
        ? hop.terminal.map((origin) => ({
            table: origin.table.join("."),
            column: displayName(origin.column, dialect),
          }))
        : [];
      const via = [];
      for (const step of hop.via ?? []) {
        const viaRelation = scopeRelationIds.get(step.scope);
        if (!viaRelation)
          mappingFailure ??= "NATIVE_SCOPE_RELATION_MAPPING_UNAVAILABLE";
        else via.push({ relation_id: viaRelation, kind: step.kind });
      }
      const node: PlanLineageHopNode = {
        hop_id: localId,
        scope_relation_id: relationId,
        ...(expressionId ? { expression_id: expressionId } : {}),
        expr_kind: hop.expr.kind,
        expression_text: fullTextOf(sql, cellBase, hop.expr.cst as any),
        source_span: span,
        terminal_fields: terminalFields,
        terminal:
          hop.terminal === "unresolved"
            ? "UNRESOLVED"
            : terminalFields.length > 0
              ? "PRESENT"
              : "NONE",
        // This is finalized from the edges that are actually persisted.
        has_downstream: false,
        via,
        flow_kind: "VALUE_LINEAGE",
      };
      localNodes.set(localId, node);
      for (const field of terminalFields) {
        const edgeId = `hop-edge:physical:${localFieldKey(field)}->${localId}`;
        localEdges.set(edgeId, {
          edge_id: edgeId,
          edge_type: "PHYSICAL_FIELD_TO_HOP",
          from_field: field,
          to_hop_id: localId,
          flow_kind: "VALUE_LINEAGE",
        });
      }
      for (const downstream of hop.downstream) {
        const downstreamId = serialize(downstream);
        if (!downstreamId) continue;
        const branch = setopBranchOf(
          scopeRelationIds.get(downstream.scope) ?? "",
          relations,
        );
        const edgeId = `hop-edge:hop:${downstreamId}->${localId}:${branch?.relation_id ?? ""}:${branch?.ordinal ?? ""}`;
        localEdges.set(edgeId, {
          edge_id: edgeId,
          edge_type: "HOP_TO_HOP",
          from_hop_id: downstreamId,
          to_hop_id: localId,
          ...(branch
            ? {
                branch_relation_id: branch.relation_id,
                branch_ordinal: branch.ordinal,
              }
            : {}),
          flow_kind: "VALUE_LINEAGE",
        });
      }
      active.delete(localId);
      return localId;
    };

    const headLocator =
      head?.projection === request.projection && request.projection
        ? { relationId: request.relationId, expressionId: request.expressionId }
        : undefined;
    const headId = head ? serialize(head, headLocator) : null;
    const persistedDownstream = new Set(
      [...localEdges.values()]
        .filter((edge) => edge.edge_type === "HOP_TO_HOP")
        .map((edge) => edge.to_hop_id),
    );
    const finalizedNodes = [...localNodes.values()].map((node) => ({
      ...node,
      has_downstream: persistedDownstream.has(node.hop_id),
    }));
    const terminalByHop = new Map<string, PlanLineageHopNode>();
    for (const node of finalizedNodes) terminalByHop.set(node.hop_id, node);
    const terminalKeys = new Set<string>();
    const collectTerminals = (
      hopId: string,
      seen = new Set<string>(),
    ): void => {
      if (seen.has(hopId)) return;
      seen.add(hopId);
      const node = terminalByHop.get(hopId);
      if (!node) return;
      for (const field of node.terminal_fields)
        terminalKeys.add(localFieldKey(field));
      for (const edge of localEdges.values())
        if (
          edge.edge_type === "HOP_TO_HOP" &&
          edge.to_hop_id === hopId &&
          edge.from_hop_id
        )
          collectTerminals(edge.from_hop_id, seen);
    };
    if (headId) collectTerminals(headId);
    const expectedKeys = new Set(physicalInputs.map(localFieldKey));
    const conservationMismatch =
      ![...expectedKeys].every((key) => terminalKeys.has(key)) ||
      ![...terminalKeys].every((key) => expectedKeys.has(key));
    let coverageState: PlanLineageHopRoot["coverage_state"] = "FULL_HOP";
    if (nativeFailure || mappingFailure) {
      coverageState =
        nativeFailure === "NATIVE_SCOPE_RELATION_MAPPING_UNAVAILABLE" ||
        mappingFailure === "NATIVE_SCOPE_RELATION_MAPPING_UNAVAILABLE"
          ? "NOT_EVALUABLE"
          : "UNKNOWN_COVERAGE";
    } else if (unsupported || unknownExpr) coverageState = "UNKNOWN_COVERAGE";
    else if (flatOnly) coverageState = "FLAT_ORIGIN_ONLY";
    const hasCandidate = candidateInputs.length > 0;
    const hasUnresolved =
      (request.expression.input_columns ?? []).some(
        (input) =>
          input.resolution !== "PHYSICAL" &&
          input.resolution !== "DERIVED_OUTPUT" &&
          input.resolution !== "SQL_CANDIDATE",
      ) || finalizedNodes.some((node) => node.terminal === "UNRESOLVED");
    let projectionStatus: PlanLineageHopRoot["projection_status"] = "PROJECTED";
    let reasonCode: string | undefined;
    if (coverageState === "NOT_EVALUABLE") {
      projectionStatus = "NOT_EVALUABLE";
      reasonCode = nativeFailure ?? mappingFailure;
    } else if (
      coverageState !== "FULL_HOP" ||
      hasCandidate ||
      hasUnresolved ||
      conservationMismatch ||
      !headId
    ) {
      projectionStatus = "PARTIAL_NATIVE";
      reasonCode =
        nativeFailure ??
        mappingFailure ??
        (conservationMismatch
          ? "ORIGIN_CONSERVATION_MISMATCH"
          : flatOnly
            ? "NATIVE_SCALAR_OR_EXISTS_FLATTENED"
            : hasCandidate
              ? "NATIVE_INPUT_CANDIDATE"
              : hasUnresolved
                ? "NATIVE_UNRESOLVED"
                : unsupported || unknownExpr
                  ? "NATIVE_UNSUPPORTED_COVERAGE"
                  : !headId
                    ? "NATIVE_HEAD_UNAVAILABLE"
                    : undefined);
    }
    if (
      projectionStatus === "PROJECTED" ||
      projectionStatus === "PARTIAL_NATIVE"
    ) {
      for (const node of finalizedNodes) {
        const existing = nodes.get(node.hop_id);
        nodes.set(
          node.hop_id,
          existing
            ? {
                ...node,
                has_downstream: existing.has_downstream || node.has_downstream,
              }
            : node,
        );
      }
      for (const [id, edge] of localEdges) edges.set(id, edge);
    }
    roots.push({
      ...base,
      head_hop_id: projectionStatus === "NOT_EVALUABLE" ? null : headId,
      coverage_state: coverageState,
      projection_status: projectionStatus,
      ...(reasonCode ? { reason_code: reasonCode, reason: reasonCode } : {}),
    });
  }

  return {
    roots,
    nodes: [...nodes.values()].sort((left, right) =>
      left.hop_id.localeCompare(right.hop_id),
    ),
    edges: [...edges.values()].sort((left, right) =>
      left.edge_id.localeCompare(right.edge_id),
    ),
  };
}

const CONTRACT_VERSION = "1.4.0";
const ADAPTER_VERSION = "0.5.1";
const EXPRESSION_DEPENDENCY_CONTRACT_VERSION = "1.4.0";
export const EXPRESSION_DEPENDENCY_ADAPTER_VERSION = "0.5.2";

export function buildPlanFacts(
  cell: { scopes: ScopeTree; span: { start: number } },
  sql: string,
  opts?: PlanAdapterOptions,
): PlanFacts {
  const scopePlanIndex =
    opts?.scope_projection === "legacy"
      ? null
      : buildScopePlanIndex(cell.scopes);
  const relations: PlanRelation[] = [];
  const unknowns: PlanFacts["unknowns"] = [];
  const nativeLineageFailures = new Set<string>();
  const physical = new Set<string>();
  const relationScopes = new Map<string, Scope>();
  const scopeRelationIds = new Map<Scope, string>();
  const scopePathByScope = new Map<Scope, string>();
  const pendingScopeBindings: {
    readonly scope_id: string;
    readonly relation_id: string;
    readonly binding: string;
    readonly source_kind: PlanScopeBinding["source_kind"];
    readonly target_scope: Scope;
  }[] = [];
  const projectionLocators = new Map<
    Scope,
    Map<Projection, { relationId: string; expressionId: string }>
  >();
  const roots: string[] = [];
  const root = cell.scopes.root;
  const cellBase = cell.span.start ?? 0;
  const schema = opts?.schema;
  const dialect = opts?.dialect ?? "databricks";
  const systemValueNames = new Set(
    (opts?.system_value_names ?? []).map((name) => name.toLowerCase()),
  );
  const recordNativeLineageFailure = (
    nodeId: string,
    clause: ColumnRef["clause"],
    span: SourceSpan,
    error: unknown,
  ): void => {
    const message = nativeLineageErrorMessage(error);
    const key = `${nodeId}:${clause}:${span.start}:${span.end}:${message}`;
    if (nativeLineageFailures.has(key)) return;
    nativeLineageFailures.add(key);
    unknowns.push({
      node_id: nodeId,
      field: "native_lineage",
      reason: `sql-static-lineage originsOf failed for ${clause}: ${message}`,
      span,
    });
  };

  // 每个 scope 的根节点 id 缓存 (子查询源可能被多次引用, 如 join 右臂 + from 列表)
  const rootIds = new Map<Scope, string>();
  const pendingCteBodyLinks: {
    readonly readRelation: ReadRelation;
    readonly bodyScope: Scope;
  }[] = [];

  function addTopN(
    scope: Scope,
    path: string,
    sourceId: string,
    outputColumns: string[] | null,
  ): string {
    const limitInfo = scope.limit;
    const limitInputs = [limitInfo?.top, limitInfo?.offset, limitInfo?.fetch].filter(
      (input): input is Expr => input !== undefined,
    );
    if (!limitInfo || limitInputs.length === 0) return sourceId;

    const topNId = `${path}.top_n`;
    const onNativeLineageError = (error: unknown): void =>
      recordNativeLineageFailure(
        topNId,
        "limit",
        spanOf(cellBase, scope.body.cst),
        error,
      );
    const includeDependencies = Boolean(opts?.include_expression_dependencies);
    const orderBy = (scope.orderBy ?? []).map((input, ordinal) =>
      topNInputBinding(
        "ORDER",
        ordinal,
        input,
        sql,
        cellBase,
        scope,
        schema,
        dialect,
        includeDependencies,
        onNativeLineageError,
      ),
    );
	const topNLimit: TopNLimitFacts = {
		kind:
			dialect === "tsql" && limitInfo.top
				? "TOP"
				: limitInfo.offset || limitInfo.fetch
					? "OFFSET_FETCH"
					: "LIMIT",
      percent: limitInfo.percent || undefined,
      with_ties: limitInfo.withTies || undefined,
    };
    if (limitInfo.top)
      topNLimit.top = topNInputBinding(
        "LIMIT",
        0,
        limitInfo.top,
        sql,
        cellBase,
        scope,
        schema,
        dialect,
        includeDependencies,
        onNativeLineageError,
      );
    if (limitInfo.offset)
      topNLimit.offset = topNInputBinding(
        "OFFSET",
        0,
        limitInfo.offset,
        sql,
        cellBase,
        scope,
        schema,
        dialect,
        includeDependencies,
        onNativeLineageError,
      );
    if (limitInfo.fetch)
      topNLimit.fetch = topNInputBinding(
        "FETCH",
        0,
        limitInfo.fetch,
        sql,
        cellBase,
        scope,
        schema,
        dialect,
        includeDependencies,
        onNativeLineageError,
      );

	const topNSpan = topNSpanOf(
		scope,
		[...(scope.orderBy ?? []), ...limitInputs],
		cellBase,
	);
    if (!topNSpan) {
      unknowns.push({
        node_id: topNId,
        field: "span",
        reason:
          "Top-N full construct span is UNKNOWN: Scope does not expose a trustworthy owning QueryExpr/CST span",
        span: spanOf(cellBase, scope.body.cst),
      });
    }
    const topN: TopNRelation = {
      id: topNId,
      type: "top_n",
      source: sourceId,
      order_by: orderBy,
      limit: topNLimit,
      span_status: topNSpan ? "EXTRACTED" : "UNKNOWN",
      span: topNSpan,
      provenance: topNSpan ? "extracted" : "unknown",
      output_columns: outputColumns,
    };
    relations.push(topN);
    relationScopes.set(topNId, scope);
    rootIds.set(scope, topNId);
    return topNId;
  }

  function buildChildScopes(scope: Scope, path: string): void {
    for (const [childIndex, child] of scope.children.entries()) {
      if (!rootIds.has(child))
        buildScope(
          child,
          `${path}.(child${childIndex === 0 ? "" : `-${childIndex}`})`,
        );
    }
  }

  function buildScope(scope: Scope, path: string): string {
    if (!scopePathByScope.has(scope)) scopePathByScope.set(scope, path);
    if (rootIds.has(scope)) return rootIds.get(scope)!;
    const body = scope.body;
    const outCols = Array.isArray(scope.outputs) ? scope.outputs : null;

    // setop body (UNION/EXCEPT/INTERSECT) → setop 节点 + 分支子图
    //   分支取 scope.branches (嵌套 setop 递归保留), 不用 children (会混入 CTE 子块)
    if (body.kind === "setop") {
      const id = `${path}.setop`;
      const branchIds: string[] = [];
      const walkBranch = (sc: Scope) => {
        branchIds.push(buildScope(sc, `${path}.setop.b${branchIds.length}`));
      };
      if (scope.branches) {
        walkBranch(scope.branches.left);
        walkBranch(scope.branches.right);
      }
      const branchOutputs = branchIds.map(
        (branchId) =>
          relations.find((relation) => relation.id === branchId)
            ?.output_columns,
      );
      const inferredOutputs =
        branchOutputs.length > 0 &&
        branchOutputs.every(
          (outputs): outputs is string[] =>
            Array.isArray(outputs) && outputs.length > 0,
        ) &&
        branchOutputs.every(
          (outputs) => outputs.length === branchOutputs[0]!.length,
        )
          ? branchOutputs[0]
          : null;
      const s: SetopRelation = {
        id,
        type: "setop",
        setop: (body as { op?: string }).op ?? "union",
        all: (body as { all?: boolean }).all ?? undefined,
        by_name: (body as { byName?: boolean }).byName ?? undefined,
        branches: branchIds,
        span: spanOf(cellBase, body.cst),
        provenance: branchIds.length > 0 ? "extracted" : "unknown",
        output_columns: outCols ?? inferredOutputs,
      };
      relations.push(s);
      relationScopes.set(id, scope);
      if (branchIds.length === 0) {
        unknowns.push({
          node_id: id,
          field: "branches",
          reason: "setop 无 branches (sql-static-lineage 未建模分支)",
          span: spanOf(cellBase, body.cst),
        });
      }
      rootIds.set(scope, id);
      // CTE bodies belong to children, not branches. Build them after the
      // branch list is frozen so they remain linked evidence, not UNION inputs.
      buildChildScopes(scope, path);
      return addTopN(scope, path, id, outCols ?? inferredOutputs);
    }

    // 非 select/setop body (pipe/…) → other 节点显式保留
    if (body.kind !== "select") {
      const id = `${path}.other`;
      relations.push({
        id,
        type: "other",
        body_kind: body.kind,
        note: "v1 未建模 body, 显式保留",
        span: spanOf(cellBase, body.cst),
        provenance: "unknown",
        output_columns: outCols,
      } as PlanRelation);
      unknowns.push({
        node_id: id,
        field: "body",
        reason: `body.kind=${body.kind} 未建模 (v1 范围: select)`,
        span: spanOf(cellBase, body.cst),
      });
      rootIds.set(scope, id);
      return id;
    }

    // Keep the old source/Join interpretation available only through the
    // explicit legacy parity mode. The default parallel path consumes the
    // normalized ScopePlan and records an evidence gap when it cannot bind.
    const scopePlan = scopePlanIndex?.byScope.get(scope);
    const selectPlan: SelectScopePlan | null =
      scopePlan?.kind === "select" ? scopePlan : null;
    const projectedJoinOrderStable =
      scopePlanIndex !== null &&
      selectPlan !== null &&
      selectPlan.joins.every(
        (join, ordinal) => join.sourceIndex === ordinal + 1,
      );

    // ---- 1. read 节点: 每个 table/cte 源一个; lateral 源 → expand ----
    const nodeIds = new Map<string, string>(); // 绑定 key → 节点 id
    for (const [key, src] of scope.sources) {
      if (src.kind === "table" || src.kind === "cte") {
        const id = `${path}.read.${key}`;
        const rel = src.source.relation;
        // CTE references are logical read nodes, not physical input tables.
        // Keep them in the relation graph (with is_cte=true), but do not ask
        // the external table catalog for a schema named after the CTE.
        if (src.kind === "table" && rel?.fqn) physical.add(rel.fqn);
        const r: ReadRelation = {
          id,
          type: "read",
			read_occurrence_id: id,
			read_occurrence: {
				occurrence_id: id,
				relation_id: id,
				scope_id: path,
				source_span: spanOf(cellBase, src.source.cst),
			},
          table: rel?.fqn ?? key,
          binding: key,
          columns: null, // 列清单需 qualify 展开, v1 不填充
          is_cte: src.kind === "cte" ? true : undefined,
          span: spanOf(cellBase, src.source.cst),
          provenance: "extracted",
          output_columns: null,
        };
        relations.push(r);
        relationScopes.set(id, scope);
        nodeIds.set(key, id);
        // The CTE body is built as its own subtree. Record the reference so it
        // can be wired once every scope has an id; without that edge the body's
        // physical reads never reach the statement root.
        if (src.kind === "cte" && src.ref?.scope)
          pendingCteBodyLinks.push({ readRelation: r, bodyScope: src.ref.scope });
      } else if (src.kind === "lateral") {
        const id = `${path}.expand.${key}`;
        const e: ExpandRelation = {
          id,
          type: "expand",
          expand_kind: "lateral",
          produced_columns: src.source.columns ?? [],
          span: spanOf(cellBase, src.source.cst),
          provenance: "extracted",
          output_columns: null,
        };
        relations.push(e);
        relationScopes.set(id, scope);
        nodeIds.set(key, id);
      }
    }

    // 绑定 key → 节点 id (subquery 源递归建子图)
    function sourceNodeId(
      key: string,
      src: { kind: string; scope?: Scope },
    ): string | null {
      if (src.kind === "subquery" && src.scope)
        return buildScope(src.scope, `${path}.${key}`);
      return nodeIds.get(key) ?? null;
    }

    // ---- 2. from 源 → 左深链: from[0] 起, 按序 join/expand 挂接 ----
    //   table/subquery 源: 第 1 个为链首, 后续生成 join (有 joins 记录用其 kind, 无则逗号 cross)
    //   lateral 源: 行扩展, 挂接当前链尾 (Spark LATERAL VIEW 语义), 不产生 join
    let chainTail: string | null = null;
    let first = true;
    const fromEntries = body.from ?? [];
    for (let fi = 0; fi < fromEntries.length; fi++) {
      const f = fromEntries[fi] as SelectExpr["from"][number];
      const normalizedFrom = selectPlan?.from[fi];
      // An unaliased derived table binds under the empty key, which is a valid
      // Scope source. Testing truthiness here dropped the whole FROM entry and
      // orphaned its subtree from the statement root.
      const planBindingKey = normalizedFrom?.bindingKey ?? null;
      const boundKey =
        scopePlanIndex === null
          ? legacySourceBindingKey(scope, f)
          : planBindingKey !== null && scope.sources.has(planBindingKey)
            ? planBindingKey
            : null;
      if (boundKey === null) {
        unknowns.push({
          node_id: `${path}.from.${fi}`,
          field: "source_binding",
          reason: "ScopePlan 无法将 FROM source 绑定到 Scope source",
          span: spanOfCst(cellBase, f.cst),
        });
        continue;
      }
      // scope.sources is keyed by name, so a derived table and a LATERAL VIEW
      // that share an alias collapse onto one entry. Resolve through
      // sourceList by ordinal, which keeps both.
      const boundSource = (normalizedFrom?.sourceOrdinal != null
        ? scope.sourceList[normalizedFrom.sourceOrdinal]?.source
        : undefined) ?? scope.sources.get(boundKey);
      const isLateral = boundSource?.kind === "lateral";
      const nodeId = sourceNodeId(
        boundKey,
        boundSource as { kind: string; scope?: Scope },
      );
      if (!nodeId) continue;

      if (isLateral) {
        // 行扩展挂接链尾
        const e = relations.find((r) => r.id === nodeId) as ExpandRelation;
        if (e && chainTail) e.source = chainTail;
        chainTail = nodeId;
        continue;
      }

      if (first) {
        chainTail = nodeId;
        first = false;
        continue;
      }
      // join 节点 (左深链)
      const joinRec =
        scopePlanIndex === null || !projectedJoinOrderStable
          ? (body.joins ?? [])[fi - 1]
          : selectPlan?.joins.find((join) => join.sourceIndex === fi)?.join;
      const id = `${path}.join.${fi}`;
      const conditionTree = joinRec?.on
        ? predicateTreeOf(joinRec.on, sql, cellBase, "join")
        : null;
      const treeColumns = conditionTree ? predicateColumnsOf(conditionTree) : [];
      const inputColumns = joinRec?.on
        ? inputColumnsFor(
            joinRec.on,
            scope,
            "join",
            schema,
            dialect,
            true,
            (error) =>
              recordNativeLineageFailure(
                id,
                "join",
                spanOfCst(cellBase, joinRec.on!.cst),
                error,
              ),
          )
        : [];
      const treeOffsets = new Set(
        treeColumns
          .map((ref) => (ref as RefWithOffset)._cellOffset)
          .filter((offset): offset is number => offset !== undefined),
      );
      const joinCols = [
        ...treeColumns,
        ...inputColumns.filter((ref) => {
          const offset = (ref as RefWithOffset)._cellOffset;
          return offset === undefined || !treeOffsets.has(offset);
        }),
      ];
      const j: JoinRelation = {
        id,
        type: "join",
        join_type: joinRec?.kind ?? "cross", // 无 join 记录 = 逗号隐式连接
        left: chainTail ?? "?",
        right: nodeId,
        condition_expr: joinRec
          ? joinRec.on
            ? fullTextOf(sql, cellBase, joinRec.on.cst)
            : joinRec.using
              ? `USING (${joinRec.using.join(", ")})`
              : null
          : null,
        condition_display: joinRec
          ? joinRec.on
            ? displayTextOf(sql, cellBase, joinRec.on.cst)
            : joinRec.using
              ? `USING (${joinRec.using.join(", ")})`
              : null
          : null,
        condition_columns: joinCols,
        condition_facts: opts?.include_expression_dependencies
          ? expressionFacts(joinRec?.on)
          : undefined,
        condition_tree: conditionTree ?? undefined,
        contains_subquery: joinRec?.on
          ? containsExpressionSubquery(joinRec.on) || undefined
          : undefined,
        using: joinRec?.using ? true : undefined,
        span: joinRec ? spanOf(cellBase, joinRec.cst) : spanOf(cellBase, f.cst),
        provenance: "extracted",
        output_columns: null,
      };
      relations.push(j);
      relationScopes.set(id, scope);
      chainTail = id;
    }

    // Keep the source-to-child scope edge explicit.  CTE reads are logical
    // read nodes in the enclosing scope, so the relation graph alone cannot
    // connect them to the child project that exposes their physical inputs.
    for (const [key, source] of scope.sources) {
      const sourceKind =
        source.kind === "cte" ||
        source.kind === "subquery" ||
        source.kind === "relation" ||
        source.kind === "graphtable" ||
        source.kind === "pivot"
          ? source.kind
          : null;
      if (!sourceKind) continue;
      const targetScope =
        source.kind === "cte"
          ? source.ref.scope
          : source.kind === "subquery" ||
              source.kind === "relation" ||
              source.kind === "graphtable"
            ? source.scope
            : undefined;
      if (!targetScope) continue;
      const relationId =
        source.kind === "subquery"
          ? sourceNodeId(key, source)
          : nodeIds.get(key);
      if (!relationId) continue;
      pendingScopeBindings.push({
        scope_id: path,
        relation_id: relationId,
        binding: key,
        source_kind: sourceKind,
        target_scope: targetScope,
      });
    }

    // ---- 3. filter 节点 ----
    const addFilter = (
      clause: FilterRelation["clause"],
      predicate: Expr,
      source: string | undefined,
    ): string => {
      const id = `${path}.filter${clause === "where" ? "" : `.${clause}`}`;
      const predicateTree = predicateTreeOf(
        predicate,
        sql,
        cellBase,
        clause,
      );
      const treeColumns = predicateColumnsOf(predicateTree);
      const inputColumns = inputColumnsFor(
        predicate,
        scope,
        clause,
        schema,
        dialect,
        true,
        (error) =>
              recordNativeLineageFailure(
                id,
                clause,
                spanOfCst(cellBase, predicate.cst),
                error,
              ),
      );
      const treeOffsets = new Set(
        treeColumns
          .map((ref) => (ref as RefWithOffset)._cellOffset)
          .filter((offset): offset is number => offset !== undefined),
      );
      const whereCols = [
        ...treeColumns,
        ...inputColumns.filter((ref) => {
          const offset = (ref as RefWithOffset)._cellOffset;
          return offset === undefined || !treeOffsets.has(offset);
        }),
      ];
      const f: FilterRelation = {
        id,
        type: "filter",
        clause,
        predicate_expr: fullTextOf(sql, cellBase, predicate.cst),
        predicate_display: displayTextOf(sql, cellBase, predicate.cst),
        predicate_columns: whereCols,
        predicate_facts: opts?.include_expression_dependencies
          ? expressionFacts(predicate)
          : undefined,
        predicate_tree: predicateTree,
        contains_subquery:
          containsExpressionSubquery(predicate) || undefined,
        span: spanOf(cellBase, predicate.cst),
        provenance: "extracted",
        output_columns: null,
        source,
      };
      relations.push(f);
      relationScopes.set(id, scope);
      chainTail = id;
      return id;
    };
    if (body.where) addFilter("where", body.where, chainTail ?? undefined);

    // ---- 4. aggregate 节点 ----
    const gbExprs = body.groupBy ?? [];
    if (body.aggregated) {
      const id = `${path}.aggregate`;
      const gbCols: ColumnRef[] = [];
      for (const e of gbExprs)
        gbCols.push(
          ...inputColumnsFor(
            e,
            scope,
            "groupBy",
            schema,
            dialect,
            true,
            (error) =>
              recordNativeLineageFailure(
                id,
                "groupBy",
                spanOfCst(cellBase, e.cst),
                error,
              ),
          ),
        );
      const a: AggregateRelation = {
        id,
        type: "aggregate",
        group_by: gbCols,
        group_by_exprs: gbExprs.map((e) => fullTextOf(sql, cellBase, e.cst)),
        group_by_exprs_display: gbExprs.map((e) =>
          displayTextOf(sql, cellBase, e.cst),
        ),
        measures: body.projections
          .filter(
            (p) =>
              p.expr.kind === "function" &&
              (p.expr as { aggregate?: boolean }).aggregate,
          )
          .map((p, ordinal) => {
            const inputColumns = opts?.include_expression_dependencies
              ? inputColumnsFor(
                  p.expr,
                  scope,
                  "projection",
                  schema,
                  dialect,
                  true,
                  (error) =>
                    recordNativeLineageFailure(
                      id,
                      "projection",
                      spanOf(cellBase, p.cst),
                      error,
                    ),
                )
              : [];
            return {
              output: p.name ?? `$expr_${ordinal}`,
              output_name_status: p.name
                ? ("EXPLICIT" as const)
                : ("ANONYMOUS_EXPRESSION" as const),
              expr_kind: p.expr.kind,
              aggregate: true,
              expr_text: fullTextOf(sql, cellBase, p.cst),
              display_text: displayTextOf(sql, cellBase, p.cst),
              span: spanOf(cellBase, p.cst),
				input_columns: inputColumns.length > 0 ? inputColumns : undefined,
					expression_facts: opts?.include_expression_dependencies
						? expressionFacts(p.expr)
						: undefined,
				structured_expression: opts?.include_expression_dependencies
						? structuredExpressionOf(p.expr)
						: undefined,
				...(opts?.include_expression_dependencies
					? {
							expression_roles: expressionRoleBindings(
								p.expr,
								sql,
								cellBase,
								scope,
								schema,
								dialect,
								true,
								(error) =>
									recordNativeLineageFailure(
										id,
										"projection",
										spanOf(cellBase, p.cst),
										error,
									),
								),
						}
					: {}),
			};
          }),
        span:
          gbExprs.length > 0
            ? spanOf(cellBase, gbExprs[0].cst)
            : spanOf(cellBase, body.cst),
        provenance: "extracted",
        output_columns: null,
        source: chainTail ?? undefined,
      };
      relations.push(a);
      relationScopes.set(id, scope);
      chainTail = id;
    }

    // ---- 5. project 节点 (每层必有) ----
    // star 展开: 限定 T.* → schema 列清单 / 子查询输出列传播; 裸 * → 各源列并集
    type ExpandedColumn = { name: string; input_columns?: ColumnRef[] };
    const expandStar = (p: {
      expr: { kind: string; qualifier?: string };
    }): ExpandedColumn[] | null => {
      if (p.expr.kind !== "star") return null;
      const qual = p.expr.qualifier;
      const qlast = Array.isArray(qual) ? qual[qual.length - 1] : qual; // qualifier 可能是分段数组 (db.tbl.*)
      const foldKey = (k: string) => k.toLowerCase(); // databricks 大小写不敏感, 绑定名与 qualifier 允许大小写差异
      const cols: ExpandedColumn[] = [];
      for (const [key, src] of scope.sources) {
        if (qlast && foldKey(key) !== foldKey(String(qlast))) continue; // 限定 star 只取匹配绑定
        if (src.kind === "table") {
          const fqn = src.source.relation?.fqn;
          if (!schema || !fqn) return null; // 缺 schema 无法枚举
          const c = (schema as any).columnsFor(fqn.split("."), dialect);
          if (!c) return null;
          cols.push(
            ...c.map((x: any) => ({
              name: x.name,
              input_columns: opts?.include_expression_dependencies
                ? [
                    {
                      name: x.name,
                      qualifier: key,
                      clause: "projection" as const,
                      physical: [{ table: fqn, column: x.name }],
                      resolution: "PHYSICAL" as const,
                    },
                  ]
                : undefined,
            })),
          );
        } else if (
          (src.kind === "subquery" && src.scope) ||
          (src.kind === "cte" && src.ref?.scope)
        ) {
          // A CTE is a derived relation too. Its source relation is only a
          // logical read node (for example `ind_t`); the output columns come
          // from the referenced CTE scope, especially when that scope is a
          // UNION/UNION ALL set-op. Falling back to the external schema here
          // incorrectly reports `cte.*` as unknown.
          const sourceScope =
            src.kind === "subquery" ? src.scope : src.ref.scope;
          const subId = buildScope(sourceScope, `${path}.${key}`);
          const sub = relations.find((r) => r.id === subId);
          const subOut = sub?.output_columns;
          if (!Array.isArray(subOut) || subOut.length === 0) return null;
          const projectExpressions =
            sub && Array.isArray((sub as Partial<ProjectRelation>).expressions)
              ? (sub as ProjectRelation).expressions
              : [];
          cols.push(
            ...(subOut as string[]).map((name) => ({
              name,
              input_columns:
                projectExpressions.find((expression) => expression.output === name)
                  ?.input_columns ??
                (sourceScope.body.kind === "setop"
                  ? (() => {
                      const resolved = resolveSetopOutput(
                        cell,
                        schema,
                        sourceScope,
                        name,
                        undefined,
                      );
                      return resolved?.kind === "PHYSICAL"
                        ? resolved.physical.map((origin) => ({
                            name: origin.column,
                            qualifier: key,
                            clause: "projection" as const,
                            physical: [origin],
                            resolution: "PHYSICAL" as const,
                          }))
                        : undefined;
                    })()
                  : undefined),
            })),
          );
        } else if (src.kind === "lateral") {
          cols.push(...(src.source.columns ?? []).map((name) => ({ name })));
        }
      }
      return cols.length > 0 ? cols : null;
    };

    const pid = `${path}.project`;
    const exprs: any[] = [];
    const outNames: string[] = [];
    let starFailed = false;
    for (const p of body.projections) {
      if (p.isStar) {
        const starCols = expandStar(
          p as { expr: { kind: string; qualifier?: string } },
        );
        if (starCols) {
          for (const c of starCols) {
            exprs.push({
              output: c.name,
              output_name_status: "STAR_EXPANSION",
              expr_kind: "column",
              expr_text: c.name,
              display_text: c.name,
              span: spanOf(cellBase, p.cst),
              star_expansion: true,
              input_columns: c.input_columns,
            });
            outNames.push(c.name);
          }
        } else {
          const expr = p.expr as { kind: string };
          exprs.push({
            output: "*",
            expr_kind: expr.kind,
            expr_text: fullTextOf(sql, cellBase, p.cst),
            display_text: displayTextOf(sql, cellBase, p.cst),
            span: spanOf(cellBase, p.cst),
          });
          starFailed = true;
        }
      } else {
        const expr = p.expr as Expr & { window?: unknown; aggregate?: boolean };
        const anonymous = !p.name;
        const output = p.name ?? `$expr_${outNames.length}`;
        const inputColumns = opts?.include_expression_dependencies
          ? inputColumnsFor(
              expr,
              scope,
              "projection",
              schema,
              dialect,
              true,
              (error) =>
                recordNativeLineageFailure(
                  pid,
                  "projection",
                  spanOf(cellBase, p.cst),
                  error,
                ),
            )
          : [];
        const expressionRoles = opts?.include_expression_dependencies
          ? expressionRoleBindings(
              expr,
              sql,
              cellBase,
              scope,
              schema,
              dialect,
              true,
              (error) =>
                recordNativeLineageFailure(
                  pid,
                  "projection",
                  spanOf(cellBase, p.cst),
                  error,
                ),
            )
          : undefined;
      const exprSpec: ExprSpec = {
          output,
          output_name_status: anonymous ? "ANONYMOUS_EXPRESSION" : "EXPLICIT",
          expr_kind: expr.kind,
          window: expr.kind === "function" && expr.window ? true : undefined,
          window_spec:
            opts?.include_expression_dependencies && expr.kind === "function"
              ? windowSpecOf(
                  expr,
                  sql,
                  cellBase,
                  scope,
                  schema,
                  dialect,
                  true,
                  (error) =>
                    recordNativeLineageFailure(
                      pid,
                      "projection",
                      spanOf(cellBase, p.cst),
                      error,
                    ),
                )
              : undefined,
          aggregate:
            expr.kind === "function" && expr.aggregate ? true : undefined,
          expr_text: fullTextOf(sql, cellBase, p.cst),
          display_text: displayTextOf(sql, cellBase, p.cst),
          span: spanOf(cellBase, p.cst),
			input_columns: inputColumns.length > 0 ? inputColumns : undefined,
			expression_facts: opts?.include_expression_dependencies
				? expressionFacts(expr)
				: undefined,
		structured_expression: opts?.include_expression_dependencies
				? structuredExpressionOf(expr)
				: undefined,
			...(opts?.include_expression_dependencies
				? { expression_roles: expressionRoles }
				: {}),
        };
        if (exprSpec.window_spec?.frame?.status === "UNKNOWN") {
          unknowns.push({
            node_id: pid,
            field: `expressions[${outNames.length}].window.frame`,
            reason:
              "window frame semantics are UNKNOWN: canonical WindowSpec IR does not expose frame bounds",
            span: exprSpec.window_spec.source_span,
          });
        }
        shareWindowInputRefs(exprSpec);
        exprs.push(exprSpec);
        outNames.push(output);
      }
    }
    const computedOut = !starFailed && outNames.length > 0 ? outNames : null;
    const pr: ProjectRelation = {
      id: pid,
      type: "project",
      expressions: exprs,
      span: spanOf(cellBase, body.cst),
      provenance: computedOut ? "extracted" : "unknown",
      output_columns: computedOut ?? outCols,
      source: chainTail ?? undefined,
    };
    relations.push(pr);
    relationScopes.set(pid, scope);
    scopeRelationIds.set(scope, pid);
    chainTail = pid;
    if (!computedOut) {
      unknowns.push({
        node_id: pid,
        field: "output_columns",
        reason: "star/匿名投影无法枚举: 缺该表 schema 或子查询输出列未知",
        span: spanOf(cellBase, body.cst),
      });
    }
    if (body.having)
      addFilter("having", body.having, chainTail ?? undefined);
    if (body.qualify)
      addFilter("qualify", body.qualify, chainTail ?? undefined);

    rootIds.set(scope, chainTail ?? pid);
    addTopN(scope, path, chainTail ?? pid, computedOut ?? outCols);

    // 表达式子查询 / CTE 子块
    buildChildScopes(scope, path);
    return rootIds.get(scope) ?? pid;
  }

  roots.push(buildScope(root, "root"));

  for (const link of pendingCteBodyLinks) {
    const bodyRootId = rootIds.get(link.bodyScope);
    if (bodyRootId && bodyRootId !== link.readRelation.id)
      link.readRelation.source = bodyRootId;
  }

  const scopeBindings: PlanScopeBinding[] = pendingScopeBindings.map(
    (pending) => ({
      scope_id: pending.scope_id,
      relation_id: pending.relation_id,
      binding: pending.binding,
      source_kind: pending.source_kind,
      target_scope_id: scopePathByScope.get(pending.target_scope) ?? null,
      target_relation_id: rootIds.get(pending.target_scope) ?? null,
    }),
  );

  // Keep the native IR objects alive long enough to invoke lineageOf().  The
  // writer later globalizes these local locators; it must not try to recover
  // Projection/Scope identity from already-serialized relation JSON.
  const hopRequests: HopRequest[] = [];
  for (const relation of relations) {
    const scope = relationScopes.get(relation.id);
    if (!scope) continue;
    if (relation.type === "project" && scope.body.kind === "select") {
      let ordinal = 0;
      for (const projection of scope.body.projections) {
        if (projection.isStar) {
          while (ordinal < relation.expressions.length) {
            const expression = relation.expressions[ordinal];
            if (
              expression.output_name_status !== "STAR_EXPANSION" &&
              expression.output !== "*"
            )
              break;
            const expressionId = `${relation.id}:expression:project_expression:${ordinal}`;
            hopRequests.push({
              scope,
              relationId: relation.id,
              expressionId,
              expression,
            });
            ordinal++;
          }
          continue;
        }
        const expression = relation.expressions[ordinal];
        if (!expression) continue;
        const expressionId = `${relation.id}:expression:project_expression:${ordinal}`;
        const locators =
          projectionLocators.get(scope) ??
          new Map<Projection, { relationId: string; expressionId: string }>();
        locators.set(projection, { relationId: relation.id, expressionId });
        projectionLocators.set(scope, locators);
        hopRequests.push({
          projection,
          scope,
          relationId: relation.id,
          expressionId,
          expression,
        });
        ordinal++;
      }
    } else if (relation.type === "aggregate" && scope.body.kind === "select") {
      const measures = scope.body.projections.filter(
        (projection) =>
          projection.expr.kind === "function" &&
          (projection.expr as { aggregate?: boolean }).aggregate,
      );
      for (const [ordinal, projection] of measures.entries()) {
        const expression = relation.measures[ordinal];
        if (!expression) continue;
        const expressionId = `${relation.id}:expression:aggregate_measure:${ordinal}`;
        const locators =
          projectionLocators.get(scope) ??
          new Map<Projection, { relationId: string; expressionId: string }>();
        locators.set(projection, { relationId: relation.id, expressionId });
        projectionLocators.set(scope, locators);
        hopRequests.push({
          projection,
          scope,
          relationId: relation.id,
          expressionId,
          expression,
        });
      }
    }
  }

  // Resolve ordinary derived-table outputs from the already-built child project
  // facts. This complements the SETOP-specific resolver above: a parent scope
  // referencing `deal.notional` must inherit the physical input recorded by
  // `deal`'s `SELECT *` project instead of asking lineageAt to cross an alias
  // boundary it does not own.
  const resolveDerivedOutput: DerivedOutputResolver = (scope, name) => {
    const project = relations.find(
      (relation) =>
        relationScopes.get(relation.id) === scope && relation.type === "project",
    ) as ProjectRelation | undefined;
    const expression = project?.expressions.find(
      (candidate) => candidate.output.toLowerCase() === name.toLowerCase(),
    );
    if (!expression) return null;
    const inputs = expression.input_columns ?? [];
    if (
      inputs.length === 0 &&
      expression.output_name_status === "STAR_EXPANSION" &&
      scope.sources.size === 1
    ) {
      const source = [...scope.sources.values()][0];
      const sourceScope =
        source?.kind === "subquery"
          ? source.scope
          : source?.kind === "cte"
            ? source.ref.scope
            : undefined;
      if (sourceScope?.body.kind === "setop") {
        const derived = resolveSetopOutput(
          cell,
          schema,
          sourceScope,
          name,
          resolveDerivedOutput,
        );
        if (derived) return derived;
      }
    }
    const physical = inputs.flatMap((input) =>
      input.resolution === "PHYSICAL" ? (input.physical ?? []) : [],
    );
    const candidates = inputs.flatMap((input) =>
      input.resolution === "SQL_CANDIDATE" ? (input.sql_candidate ?? []) : [],
    );
    const unresolved = inputs.some(
      (input) =>
        input.resolution !== "PHYSICAL" &&
        input.resolution !== "DERIVED_OUTPUT" &&
        input.resolution !== "SQL_CANDIDATE",
    );
    if (physical.length > 0 && candidates.length === 0 && !unresolved) {
      const seen = new Set<string>();
      return {
        kind: "PHYSICAL",
        physical: physical.filter((item) => {
          const key = `${item.table}.${item.column}`.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    }
    if (physical.length === 0 && candidates.length > 0 && !unresolved) {
      const seen = new Set<string>();
      return {
        kind: "SQL_CANDIDATE",
        candidates: candidates.filter((item) => {
          const key = `${item.table}.${item.column}`.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    }
    if (
      physical.length === 0 &&
      candidates.length === 0 &&
      inputs.length > 0 &&
      inputs.every((input) => input.resolution === "DERIVED_OUTPUT")
    ) {
      return { kind: "DERIVED_OUTPUT" };
    }
    // An expression with no column inputs is still a derived output when it
  // is a function, CASE, cast, or arithmetic expression rather than a
  // literal. Do not turn a computed constant/system value into a fake
  // physical-field Unknown at a derived-table or set-op boundary.
    if (
      physical.length === 0 &&
      candidates.length === 0 &&
      inputs.length === 0 &&
      expression.expr_kind !== "column"
    ) {
      return { kind: "DERIVED_OUTPUT" };
    }
    return null;
  };

  // ---- 物理解析: 所有条件/谓词/分组列追到基表 ----
  if (schema) {
    // Resolve a source scope before the scope that consumes it. CTEs are
    // siblings in Scope.children (and can depend on earlier CTEs), so parent
    // depth alone is insufficient: MAPPING must wait for CONTRACT_MAPPING,
    // even though both are direct children of the query scope. Preserve the
    // original relation order within each scope after this dependency order.
    const scopeDependencies = (scope: Scope): Scope[] => {
      const dependencies: Scope[] = [];
      const add = (candidate: Scope | undefined): void => {
        if (candidate && candidate !== scope && !dependencies.includes(candidate))
          dependencies.push(candidate);
      };
      for (const source of scope.sources.values()) {
        if (source.kind === "cte") add(source.ref.scope);
        else if (
          source.kind === "subquery" ||
          source.kind === "graphtable" ||
          source.kind === "relation"
        )
          add(source.scope);
      }
      if (scope.body.kind === "setop" && scope.branches) {
        add(scope.branches.left);
        add(scope.branches.right);
      }
      return dependencies;
    };
    const scopesInRelationOrder: Scope[] = [];
    const seenScopes = new Set<Scope>();
    for (const relation of relations) {
      const scope = relationScopes.get(relation.id);
      if (scope && !seenScopes.has(scope)) {
        seenScopes.add(scope);
        scopesInRelationOrder.push(scope);
      }
    }
    const orderedScopes: Scope[] = [];
    const visitingScopes = new Set<Scope>();
    const visitedScopes = new Set<Scope>();
    const visitScope = (scope: Scope): void => {
      if (visitedScopes.has(scope)) return;
      if (visitingScopes.has(scope)) return; // defensive cycle break
      visitingScopes.add(scope);
      for (const dependency of scopeDependencies(scope)) visitScope(dependency);
      visitingScopes.delete(scope);
      visitedScopes.add(scope);
      orderedScopes.push(scope);
    };
    for (const scope of scopesInRelationOrder) visitScope(scope);
    const scopeOrder = new Map(orderedScopes.map((scope, index) => [scope, index]));
    const resolutionRelations = relations
      .map((relation, index) => ({
        relation,
        index,
        scopeOrder:
          scopeOrder.get(relationScopes.get(relation.id)!) ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort(
        (left, right) => left.scopeOrder - right.scopeOrder || left.index - right.index,
      )
      .map(({ relation }) => relation);
    for (const r of resolutionRelations) {
      const scope = relationScopes.get(r.id);
      if (!scope) continue;
      if (r.type === "join")
        resolvePhysical(
          cell,
          schema,
          scope,
          r.id,
          r.condition_columns,
          unknowns,
          dialect,
          systemValueNames,
          resolveDerivedOutput,
        );
      else if (r.type === "filter")
        resolvePhysical(
          cell,
          schema,
          scope,
          r.id,
          r.predicate_columns,
          unknowns,
          dialect,
          systemValueNames,
          resolveDerivedOutput,
        );
      else if (r.type === "aggregate") {
        resolvePhysical(
          cell,
          schema,
          scope,
          r.id,
          r.group_by,
          unknowns,
          dialect,
          systemValueNames,
          resolveDerivedOutput,
        );
        for (const measure of r.measures) {
          if (measure.input_columns)
            resolvePhysical(
              cell,
              schema,
              scope,
              r.id,
              measure.input_columns,
              unknowns,
              dialect,
              systemValueNames,
              resolveDerivedOutput,
            );
          for (const role of measure.expression_roles ?? [])
            resolvePhysical(
              cell,
              schema,
              scope,
              r.id,
              role.input_columns,
              unknowns,
              dialect,
              systemValueNames,
              resolveDerivedOutput,
            );
        }
      } else if (r.type === "project") {
        for (const expression of r.expressions) {
          if (expression.input_columns)
            resolvePhysical(
              cell,
              schema,
              scope,
              r.id,
              expression.input_columns,
              unknowns,
              dialect,
              systemValueNames,
              resolveDerivedOutput,
            );
          for (const binding of expression.window_spec?.input_bindings ?? []) {
            resolvePhysical(
              cell,
              schema,
              scope,
              r.id,
              binding.input_columns,
              unknowns,
              dialect,
              systemValueNames,
              resolveDerivedOutput,
            );
          }
          for (const role of expression.expression_roles ?? [])
            resolvePhysical(
              cell,
              schema,
              scope,
              r.id,
              role.input_columns,
              unknowns,
              dialect,
              systemValueNames,
              resolveDerivedOutput,
            );
        }
      } else if (r.type === "top_n") {
        for (const input of r.order_by) {
          resolvePhysical(
            cell,
            schema,
            scope,
            r.id,
            input.input_columns,
            unknowns,
            dialect,
            systemValueNames,
            resolveDerivedOutput,
          );
        }
        for (const input of [r.limit.top, r.limit.offset, r.limit.fetch]) {
          if (!input) continue;
          resolvePhysical(
            cell,
            schema,
            scope,
            r.id,
            input.input_columns,
            unknowns,
            dialect,
            systemValueNames,
            resolveDerivedOutput,
          );
        }
      }
    }
  }

  // Native origins and syntactic refs can describe the same physical field
  // through different names (for example `x.record_id` and `base.id`). Keep
  // the first evidence-bearing ref and remove only duplicate physical origins;
  // unresolved and SQL-candidate refs remain untouched.
  for (const relation of relations) {
    const relationScope = relationScopes.get(relation.id);
    const scopeId = relationScope
      ? scopePathByScope.get(relationScope)
      : undefined;
    if (scopeId) relation.scope_id = scopeId;
    if (relation.type === "join") {
      relation.condition_columns = dedupePhysicalInputColumns(
        relation.condition_columns,
        true,
      );
    } else if (relation.type === "filter") {
      relation.predicate_columns = dedupePhysicalInputColumns(
        relation.predicate_columns,
        true,
      );
    } else if (relation.type === "aggregate") {
      relation.group_by = dedupePhysicalInputColumns(relation.group_by);
      for (const measure of relation.measures) {
        if (measure.input_columns)
          measure.input_columns = dedupePhysicalInputColumns(
            measure.input_columns,
            true,
          );
        for (const role of measure.expression_roles ?? [])
          role.input_columns = dedupePhysicalInputColumns(role.input_columns);
      }
    } else if (relation.type === "project") {
      for (const expression of relation.expressions) {
        if (expression.input_columns)
          expression.input_columns = dedupePhysicalInputColumns(
            expression.input_columns,
            true,
          );
        for (const binding of expression.window_spec?.input_bindings ?? [])
          binding.input_columns = dedupePhysicalInputColumns(
            binding.input_columns,
          );
        for (const role of expression.expression_roles ?? [])
          role.input_columns = dedupePhysicalInputColumns(role.input_columns);
      }
    } else if (relation.type === "top_n") {
      for (const input of relation.order_by)
        input.input_columns = dedupePhysicalInputColumns(input.input_columns);
      for (const input of [
        relation.limit.top,
        relation.limit.offset,
        relation.limit.fetch,
      ]) {
        if (input)
          input.input_columns = dedupePhysicalInputColumns(input.input_columns);
      }
    }
  }

  const lineageHops: PlanLineageHopProjection = nativeHopProjection(
    cellBase,
    sql,
    schema,
    dialect,
    relations,
    relationScopes,
    scopeRelationIds,
    projectionLocators,
    hopRequests,
  );

  // parser 版本 (sql-static-lineage package.json)
  let parserVersion = "unknown";
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      version?: string;
    };
    parserVersion = pkg.version ?? "unknown";
  } catch {
    // 非仓库内运行时 fallback
  }

  return assemblePlanFacts({
    contractVersion: opts?.include_expression_dependencies
      ? EXPRESSION_DEPENDENCY_CONTRACT_VERSION
      : CONTRACT_VERSION,
    adapterVersion:
      opts?.adapter_version ??
      (opts?.include_expression_dependencies
        ? EXPRESSION_DEPENDENCY_ADAPTER_VERSION
        : ADAPTER_VERSION),
    parserVersion,
    dialect: root.dialect ?? "unknown",
    statementIndex: opts?.statement_index ?? 0,
    relations,
    roots,
    physicalInputs: [...physical],
    scopeBindings,
    unknowns,
    lineageHops,
  });
}

// ---------------------------------------------------------------------------
// Grain / Cardinality 推断层 v1.1
//   1. propagateGrain: aggregate 的 grain key 沿 plan 自底向上传播
//   2. inferGrain: 结合传播结果输出判定 (join 右表 key 覆盖 → 不扩行)
// ---------------------------------------------------------------------------

interface GrainState {
  /** grain key 列集; null = 未知; [] = 全局聚合 (至多 1 行, 任何键唯一)。 */
  grain: string[] | null;
  note: string;
}

/** 右表 binding: id 形如 ...{path}.project 或 ...{path}.read.{key} → 取倒数第二段 (read 取末段)。 */
function rightBindingOf(nodeId: string): string {
  const segs = nodeId.split(".");
  return segs[segs.length - 2] === "read"
    ? segs[segs.length - 1]
    : segs[segs.length - 2];
}

/** 沿 source 链传播 grain (relations 数组顺序 ≈ 拓扑序: 子图先于父节点)。 */
export function propagateGrain(facts: PlanFacts): Map<string, GrainState> {
  const st = new Map<string, GrainState>();
  for (const r of facts.relations) {
    switch (r.type) {
      case "read":
        st.set(r.id, { grain: null, note: "物理表, 无键信息" });
        break;
      case "expand":
        st.set(r.id, { grain: null, note: "行扩展改变粒度" });
        break;
      case "filter": {
        const src = r.source ? st.get(r.source) : null;
        st.set(r.id, src ? { ...src } : { grain: null, note: "上游未知" });
        break;
      }
      case "project": {
        const src = r.source ? st.get(r.source) : null;
        if (!src || src.grain === null) {
          st.set(r.id, { grain: null, note: "上游无 grain" });
          break;
        }
        const outs = r.output_columns ?? [];
        // 输出列需保留全部键列才可传播 (重命名/删除 → 保守 null)
        if (outs && src.grain.every((k) => outs.includes(k))) {
          st.set(r.id, { grain: [...src.grain], note: src.note });
        } else {
          st.set(r.id, { grain: null, note: "投影后键列不可见" });
        }
        break;
      }
      case "aggregate": {
        const keys = [...new Set(r.group_by.map((c) => c.name))];
        st.set(r.id, {
          grain: keys.length > 0 ? keys : [],
          note:
            keys.length > 0
              ? `GROUP BY ${keys.join(", ")}`
              : "全局聚合 (至多 1 行)",
        });
        break;
      }
      case "join": {
        const rightSt = st.get(r.right) ?? { grain: null, note: "右表未知" };
        const leftSt = st.get(r.left) ?? { grain: null, note: "左表未知" };
        let out: GrainState;
        if (r.join_type === "cross") out = { grain: null, note: "笛卡尔积" };
        else if (r.join_type === "left" || r.join_type === "inner")
          out = { grain: leftSt.grain, note: leftSt.note };
        else out = { grain: rightSt.grain, note: rightSt.note }; // right/full: 输出由右表决定 (v1 保守)
        st.set(r.id, out);
        break;
      }
      case "other":
        st.set(r.id, { grain: null, note: "未建模" });
        break;
      case "setop":
        st.set(r.id, {
          grain: null,
          note: `${r.setop.toUpperCase()}${r.all ? " ALL" : ""}: 分支合并, 输出行数 = 各分支之和/去重, grain 键不保证`,
        });
        break;
      case "top_n": {
        const src = st.get(r.source);
        st.set(r.id, src ? { ...src } : { grain: null, note: "上游未知" });
        break;
      }
    }
  }
  return st;
}

/** 右表 grain key 是否被连接条件覆盖 (右表每键至多 1 行 → 该 join 不因右表扩行)。 */
function joinRightKeyCovered(
  r: JoinRelation,
  states: Map<string, GrainState>,
): { covered: boolean; key: string[] | null; note: string } {
  const rightSt = states.get(r.right);
  if (!rightSt || rightSt.grain === null)
    return { covered: false, key: null, note: "右表无传播 grain" };
  const rightBinding = rightBindingOf(r.right);
  const rightCols = new Set(
    r.condition_columns
      .filter((c) => c.qualifier === rightBinding)
      .map((c) => c.name),
  );
  const key = rightSt.grain;
  const covered = key.length > 0 && key.every((k) => rightCols.has(k));
  return {
    covered,
    key,
    note: covered
      ? `连接条件覆盖右表 grain key [${key.join(", ")}] (来自上游: ${rightSt.note})`
      : `右表 grain key [${key.join(", ")}] 未被连接条件完全覆盖 (右列: ${[...rightCols].join(", ") || "无"})`,
  };
}

export function inferGrain(facts: PlanFacts): GrainInference[] {
  const states = propagateGrain(facts);
  const out: GrainInference[] = [];
  for (const r of facts.relations) {
    switch (r.type) {
      case "aggregate": {
        const keys = [...new Set(r.group_by.map((c) => c.name))];
        if (keys.length > 0) {
          out.push({
            node_id: r.id,
            grain_candidate: keys,
            cardinality: "non-increasing", // 非严格: 输入本就每键一行则行数不变
            confidence: "high",
            evidence: [`GROUP BY ${keys.join(", ")} (聚合节点)`],
            requires: [],
          });
        } else {
          out.push({
            node_id: r.id,
            grain_candidate: [],
            cardinality: "non-increasing", // 全局聚合 → 至多 1 行
            confidence: "high",
            evidence: ["无 GROUP BY 的聚合 (全局聚合, 至多 1 行)"],
            requires: [],
          });
        }
        break;
      }
      case "join": {
        const rightSt = states.get(r.right) ?? {
          grain: null,
          note: "右表未知",
        };
        const outGrain = states.get(r.id)?.grain ?? null;
        const covered = joinRightKeyCovered(r, states);
        const cond = r.condition_display ?? "无";
        if (r.join_type === "cross") {
          out.push({
            node_id: r.id,
            grain_candidate: null,
            cardinality: "unknown", // 笛卡尔积: 行数 = 左×右, 非单调 (右表 0 行 → 0 行)
            confidence: "high",
            evidence: ["CROSS JOIN (笛卡尔积, 行数 = 左表行数 × 右表行数)"],
            requires: [],
          });
          break;
        }
        if (covered.covered) {
          const nonInc = r.join_type === "left" || r.join_type === "inner";
          out.push({
            node_id: r.id,
            grain_candidate: outGrain,
            cardinality: nonInc ? "non-increasing" : "unknown",
            confidence: "high",
            evidence: [
              `${r.join_type.toUpperCase()} JOIN (条件: ${cond})`,
              covered.note,
              nonInc
                ? "右表每键至多 1 行 → 本 join 不因右表扩行"
                : "RIGHT/FULL JOIN 保留右表全部行, 行数仍可能变化",
            ],
            requires: [],
          });
        } else {
          const allCols = [...new Set(r.condition_columns.map((c) => c.name))];
          const rightBinding = rightBindingOf(r.right);
          const rightCols = [
            ...new Set(
              r.condition_columns
                .filter((c) => c.qualifier === rightBinding)
                .map((c) => c.name),
            ),
          ];
          out.push({
            node_id: r.id,
            grain_candidate: outGrain,
            cardinality: "unknown", // 是否扩行取决于右表条件列唯一性
            confidence: "medium",
            evidence: [
              `${r.join_type.toUpperCase()} JOIN (条件: ${cond})`,
              covered.note,
            ],
            requires:
              rightCols.length > 0
                ? [
                    `右表 ${r.right} 的 ${rightCols.join("/")} 唯一性 (PK/UK/distinct 统计); 条件涉及列: ${allCols.join("/") || "无"}`,
                  ]
                : [
                    `右表 ${r.right} 连接键唯一性; 条件涉及列: ${allCols.join("/") || "无"} (PK/UK/distinct 统计)`,
                  ],
          });
        }
        break;
      }
      case "expand": {
        out.push({
          node_id: r.id,
          grain_candidate: null,
          cardinality: "unknown", // explode: 空集合/NULL → 0 行, 非空 → N 行, 非单调
          confidence: "medium",
          evidence: [
            `${r.expand_kind} 行扩展 (产生列: ${r.produced_columns.join(", ") || "无"})`,
            "explode/posexplode 对空集合/NULL 不产生行 → 每行产出 0..N 行",
          ],
          requires: [],
          cardinality_effect: "fanout",
          per_input_rows: "0..N",
          grain_effect: "expanded",
        });
        break;
      }
      case "setop": {
        out.push({
          node_id: r.id,
          grain_candidate: null,
          // UNION ALL: 行数 = 各分支之和 (非递减); UNION/EXCEPT/INTERSECT: 去重/集合语义, 未知
          cardinality: r.all ? "non-decreasing" : "unknown",
          confidence: "high",
          evidence: [
            `${r.setop.toUpperCase()}${r.all ? " ALL" : ""} (分支: ${r.branches.length} 个)`,
            r.all
              ? "UNION ALL: 输出行数 = 各分支行数之和 (不减少)"
              : "UNION/EXCEPT/INTERSECT: 去重或集合语义, 行数需分支基数",
          ],
          requires: r.all
            ? []
            : ["各分支行数 + 去重语义 (UNION) 或集合基数 (EXCEPT/INTERSECT)"],
        });
        break;
      }
      case "top_n": {
        const source = states.get(r.source);
        out.push({
          node_id: r.id,
          grain_candidate: source?.grain ?? null,
          cardinality: "non-increasing",
          confidence: "high",
          evidence: [
            "Top-N / row-limiting relation: output rows cannot exceed its input",
            r.order_by.length > 0 ? "query-level ORDER BY is preserved" : "no query-level ORDER BY",
          ],
          requires: [],
        });
        break;
      }
      case "read": {
        out.push({
          node_id: r.id,
          grain_candidate: null,
          cardinality: "unknown",
          confidence: "low",
          evidence: [`读取 ${r.table}`],
          requires: [`${r.table} 的 PK/UK 元数据`],
        });
        break;
      }
      default:
        // project/filter/other: 不改变行数与 grain (v1 保守)
        break;
    }
  }
  return out;
}
