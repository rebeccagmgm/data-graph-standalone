// ============================================================================
// Logical Plan Facts —— JSON 契约 v1.4.0（仿 Substrait Relation 缩小版）
//
// 设计原则:
//   1. 事实 / 推断分离 —— 本契约只承载"从 sql-static-lineage IR 确定性提取"的事实;
//      grain / cardinality 推断在独立层 (inferGrain), 允许 unknown。
//   2. unknown 必须显式 —— star 层、解析失败的列、未建模结构都标 unknown,
//      绝不猜。消费方见到 null / "unknown" 即知此处不可信。
//   3. span 可溯源 —— 每个节点带 source span, 可回切 SQL 原文验证。
//   4. 扁平 + id 引用 —— relations 是扁平数组, 节点间用 id 引用 (不是嵌套树),
//      更贴近"facts 表"的机器消费方式。
//   5. 原文不截断 —— 机器消费字段 (*_expr / expr_text) 保存完整原文;
//      截断预览只在 *_display / display_text 字段 (人看)。
//
// v1.1 变更 (2026-08-15):
//   - meta 拆分 contract_version / adapter_version / parser{engine,version}
//   - 原文与预览分离: expr_text + display_text + span (ExprSpec),
//     predicate_expr/predicate_display (Filter), condition_expr/condition_display (Join)
//   - ColumnRef.physical 改为数组 (case 多分支可能多源), 接 schema 后填充
//   - GrainInference 增加 fanout 模型字段 (cardinality_effect/per_input_rows/grain_effect)
//
// v1 范围: 8 类关系节点 read/project/filter/join/aggregate/expand/setop/top_n;
//          window 作为 project expression 的属性 (不单列节点);
//          pipe 等未建模 body 显式标 type="other" 保留。
//
// v1.1.1 变更 (2026-08-15):
//   - 新增 SetopRelation (UNION/EXCEPT/INTERSECT): branches + setop/all,
//     grain 规则 = 输出行数各分支之和 (UNION ALL) / 去重未知 (UNION)。
//
// v1.1.2 变更:
//   - ColumnRef 保留 physical / derived-output / unresolved 解析状态;
//   - ExprSpec 为匿名表达式保留稳定的合成输出名和命名状态。
//
// v1.1.4 变更:
//   - ExprSpec 增加表达式级 window_spec；
//   - Window 输入按一次表达式绑定保留 VALUE / WINDOW_PARTITION / WINDOW_ORDER
//     角色、ordinal、span、物理解析状态；
//   - Window ORDER 输入保留 ASC/DESC 与 NULLS FIRST/LAST/UNSPECIFIED。
//
// v1.3.0 变更:
//   - Filter / Join 保留 predicate tree，并标注表达式子查询；
//   - relation 增加 scope_id，文档级 facts 增加 CTE / derived scope_bindings；
//   - 允许读取侧按物理 ReadRelation occurrence 回溯而不按表名去重。
//
// v1.4.0 变更:
//   - expression roles, query-level Top-N, and explicit UNKNOWN window frames
//     are serialized; these fields require the v1.4.0 contract/cache identity.
// ============================================================================

/** 可溯源的源文本区间 (文档坐标, end 为 exclusive)。 */
export interface SourceSpan {
	start: number;
	end: number;
}

/** 列引用 —— join 条件 / where 谓词 / group by 里出现的列。 */
export interface ColumnRef {
	/** 本层引用的列名 (原文, 含限定符拆分后的末段)。 */
	name: string;
	/** 限定符 (info.agt_id → "info"; 裸 agt_id → 无)。 */
	qualifier?: string;
	/** 该引用出现在哪个子句 (IR ColumnRef.clause 原样搬运)。 */
	clause:
		| "projection"
		| "where"
		| "join"
		| "groupBy"
		| "having"
		| "qualify"
		| "orderBy"
		| "limit"
		| "windowPartition"
		| "windowOrder";
	/** 物理解析结果 (喂 schema 后): 追到基表的 库.表 + 物理列。
	 *  ARRAY —— case 等表达式多分支可能对应多个基表来源。
	 *  null = 未解析 (无 schema / 解析失败 / 需要外部元数据)。 */
	physical: { table: string; column: string }[] | null;
	/** Resolution status when the reference is schema-backed, derived, SQL-bound, or unresolved. */
	resolution?: "PHYSICAL" | "DERIVED_OUTPUT" | "SQL_CANDIDATE" | "UNRESOLVED";
	/** Syntactic source binding emitted only when the SQL scope makes the table unambiguous. */
	sql_candidate?: { table: string; column: string }[];
	/** Derived-output boundary, when resolution=DERIVED_OUTPUT. */
	derived_from?: string;
}

/** 由 IR 表达式树直接提取的结构事实，不从 SQL 文本反向解析。 */
export interface ExpressionFacts {
	operators: string[];
	literals: string[];
	functions: string[];
	predicates: { operator: string; negated: boolean }[];
	comparisons: { operator: string; columns: string[]; literals: string[] }[];
}

/**
 * Lossless, parser-owned expression shape for downstream semantic engines.
 * This is deliberately separate from expression text and from the flattened
 * expression facts: consumers may reconstruct typed operands without parsing
 * SQL again or guessing their order.
 */
export type StructuredExpression =
	| { kind: "COLUMN"; name: string; qualifier?: string }
	| { kind: "LITERAL"; text: string }
	| { kind: "FUNCTION"; name: string; qualifier?: string; args: StructuredExpression[] }
	| { kind: "BINARY"; op: string; left: StructuredExpression; right: StructuredExpression }
	| { kind: "UNARY"; op: string; operand: StructuredExpression }
	| { kind: "CASE"; whens: { when: StructuredExpression; then: StructuredExpression }[]; elseExpr?: StructuredExpression }
	| { kind: "CAST"; expr: StructuredExpression; typeText: string }
	| { kind: "PREDICATE"; op: string; negated: boolean; operand: StructuredExpression; args: StructuredExpression[] }
	| { kind: "UNSUPPORTED"; sourceKind: string };

export type PredicateAtomOperator =
	| "EQ"
	| "NE"
	| "LT"
	| "LTE"
	| "GT"
	| "GTE"
	| "IN"
	| "BETWEEN"
	| "LIKE"
	| "OTHER";

export type PredicateOperand =
	| {
			kind: "COLUMN";
			expression: string;
			column: ColumnRef;
	  }
	| {
			kind: "LITERAL";
			expression: string;
			observedValue: string | null;
	  }
	| {
			kind: "RUNTIME_EXPRESSION" | "OTHER";
			expression: string;
			inputColumns: ColumnRef[];
			/** Parser-owned shape when this is a typed expression, e.g. LIKE pattern concatenation. */
			structured_expression?: StructuredExpression;
		};

export type PredicateTree =
	| {
			kind: "AND" | "OR";
			children: PredicateTree[];
			span: SourceSpan;
	  }
	| {
			kind: "NOT";
			child: PredicateTree;
			span: SourceSpan;
	  }
	| {
			kind: "ATOM";
			operator: PredicateAtomOperator;
			operands: PredicateOperand[];
			span: SourceSpan;
	  };

export type WindowInputRole = "VALUE" | "WINDOW_PARTITION" | "WINDOW_ORDER";
export type WindowNullOrdering = "FIRST" | "LAST" | "UNSPECIFIED";

/** One expression occurrence inside a single output expression's window. */
export interface WindowInputBinding {
	/** Role belongs to this occurrence, never to the physical field identity. */
	role: WindowInputRole;
	/** Position within the corresponding role list (0-based). */
	ordinal: number;
	/** Complete source text for this value/partition/order expression. */
	expression_text: string;
	/** Human preview of the same expression. */
	display_text: string;
	/** Source span of this occurrence, in document coordinates. */
	span: SourceSpan;
	/** Syntactic refs plus native lineage evidence for this occurrence. */
	input_columns: ColumnRef[];
	/** Only present for WINDOW_ORDER. SQL's omitted direction is ASC by default. */
	direction?: "ASC" | "DESC";
	/** NULLS rule as written; omitted SQL syntax remains UNSPECIFIED. */
	nulls?: WindowNullOrdering;
}

/** The expression-level OVER(...) structure; this is not a standalone relation. */
export interface WindowSpecFacts {
	source_span: SourceSpan;
	expression_text: string;
	display_text: string;
	input_bindings: WindowInputBinding[];
	/** Frame syntax is not represented by the current canonical WindowSpec IR. */
	frame?: WindowFrameFacts;
}

export interface WindowFrameFacts {
	/** UNKNOWN is explicit: the adapter must not infer frame syntax from SQL text. */
	status: "EXTRACTED" | "UNKNOWN";
	/** Null means the canonical IR has no frame expression/span to project. */
	expression_text: string | null;
	display_text: string | null;
	span: SourceSpan | null;
	input_columns: ColumnRef[];
	reason?: string;
}

export type ExpressionRole =
	| "BRANCH_SELECTOR"
	| "RESULT_VALUE"
	| "COALESCE_ARGUMENT";
export type ExpressionRoleEffect =
	| "VALUE_CONTRIBUTION"
	| "BRANCH_SELECTION";

/** A structured role for one direct or nested expression operand. */
export interface ExpressionRoleBinding {
	operator: "CASE" | "IF" | "COALESCE";
	role: ExpressionRole;
	effects: ExpressionRoleEffect[];
	/** Stable path within the owning expression, e.g. case.when[0]. */
	path: string;
	/** Branch ordinal for CASE/IF result and selector operands. */
	branch_ordinal?: number;
	ordinal: number;
	expression_text: string;
	display_text: string;
	span: SourceSpan;
	input_columns: ColumnRef[];
}

/** 一个输出列的表达形式 —— project / aggregate 的表达式清单。 */
export interface ExprSpec {
	/** 输出列名 (显式别名, 或裸列引用时的列名; star 时为 "*")。 */
	output: string;
	/** Whether the name is explicit, schema-expanded, or synthetic for an anonymous expression. */
	output_name_status?: "EXPLICIT" | "STAR_EXPANSION" | "ANONYMOUS_EXPRESSION";
	/** IR Expr kind 原样搬运: column/literal/function/case/cast/star/binary/... */
	expr_kind: string;
	/** 是否为窗口函数表达式 (function + OVER)。v1 作为 project 属性, 不单列节点。 */
	window?: boolean;
	/** 表达式级 OVER(...) 结构；不改变现有 input_columns 的兼容语义。 */
	window_spec?: WindowSpecFacts;
	/** 是否为聚合函数表达式 (sum/count/max/...)。 */
	aggregate?: boolean;
	/** 完整原文 (machine truth, 不截断)。 */
	expr_text: string;
	/** 截断预览 (人看, ≤120 字符)。 */
	display_text: string;
	/** 该表达式在源文本中的 span (文档坐标)。 */
	span: SourceSpan;
	/** 可选：project/aggregate 输出表达式的依赖引用及 native lineage 已证明的物理来源。
	 * WHERE/JOIN/GROUP BY 的关系条件依赖仍由各自 relation 的 ColumnRef 承载，不混入输出字段血缘。 */
	input_columns?: ColumnRef[];
	/** 可选：由 IR 提取的运算符、字面量、函数和谓词。 */
	expression_facts?: ExpressionFacts;
	/** Optional parser-owned operand tree; never reconstructed from expr_text. */
	structured_expression?: StructuredExpression;
	/** Optional structured CASE/IF/COALESCE roles; absent when the IR has no such role. */
	expression_roles?: ExpressionRoleBinding[];
}

// ---------------------------------------------------------------------------
// 关系节点 (PlanRelation)
// ---------------------------------------------------------------------------

interface BaseRelation {
	/** 稳定 id: "{scope路径}.{类型}[.{序号}]"。scope 路径按 FROM 源 key 拼接,
	 *  如 root.casttable.x.t.join.2 —— 同一 SQL 重复解析 id 不变。 */
	id: string;
	type: "read" | "project" | "filter" | "join" | "aggregate" | "expand" | "setop" | "top_n" | "other";
	/** 该节点在源文本中的完整 span。 */
	span: SourceSpan;
	/** 节点完整性: "extracted" = 从 IR 完整提取; "unknown" = 结构部分缺失。 */
	provenance: "extracted" | "unknown";
	/** 本节点输出的列名清单; null = unknown (star 展开 / 匿名投影需要 schema)。 */
	output_columns: string[] | null;
	/** 输入节点 id (read 无; project/filter/aggregate 有; join 用 left/right)。 */
	source?: string;
	/** 所属 query scope 的稳定路径；用于跨 CTE/子查询边界回溯。 */
	scope_id?: string;
}

/** 物理表读取 (TableSource / CTE 引用)。 */
export interface ReadRelation extends BaseRelation {
	type: "read";
	/** Stable occurrence identity for this physical read in its owning scope. */
	read_occurrence_id: string;
	/** Source-located identity facts retained for occurrence-aware consumers. */
	read_occurrence: {
		occurrence_id: string;
		relation_id: string;
		scope_id: string;
		source_span: SourceSpan;
	};
	/** 完整表名 (relation.fqn, 含库前缀, 如 "PDATA_N.T98_OTC_DERI_COMP_SALE_INFO")。 */
	table: string;
	/** 本层绑定名 (别名或表名, scope.sources 的 key —— 即 join 条件里的限定符)。 */
	binding: string;
	/** 该源暴露的列 (qualify 喂 schema 后有; 无 schema 为 null)。v1 恒 null。 */
	columns: string[] | null;
	/** true = CTE 引用 (v1 不展开 CTE 子图, 列为表名占位)。 */
	is_cte?: boolean;
	/**
	 * CTE 引用的定义体根关系。物理表读恒为 undefined。
	 * 没有它, CTE 体子树与引用它的读节点之间没有边, 体内的物理读无法回溯到写根。
	 */
	source?: string;
}

/** 投影 (SELECT 列清单)。每个 select body 至少一个。 */
export interface ProjectRelation extends BaseRelation {
	type: "project";
	expressions: ExprSpec[];
}

/** 过滤 (WHERE 谓词)。 */
export interface FilterRelation extends BaseRelation {
	type: "filter";
	/** Explicit clause identity; filters are not interchangeable across query stages. */
	clause: "where" | "having" | "qualify";
	/** 谓词完整原文 (machine truth)。 */
	predicate_expr: string;
	/** 谓词截断预览 (人看)。 */
	predicate_display: string;
	/** 谓词引用的列 (递归表达式树提取)。解析失败列仍列出, 不丢。 */
	predicate_columns: ColumnRef[];
	/** 可选：由 WHERE IR 直接提取的结构事实。 */
	predicate_facts?: ExpressionFacts;
	/** 可选：保留 WHERE 的布尔结构、操作数绑定和源位置。 */
	predicate_tree?: PredicateTree;
	/** true = WHERE 表达式含 EXISTS/IN/scalar subquery 等表达式子查询。 */
	contains_subquery?: boolean;
}

/** 连接 (JOIN)。左深链: 每层 scope 的 join 节点串成 left→right 链。 */
export interface JoinRelation extends BaseRelation {
	type: "join";
	/** ANSI join 类型 (IR JoinKind 原样): inner/left/right/full/cross/semi/anti/asof/natural/lateral。
	 *  逗号隐式连接 (from 多项无 joins) 标 "cross"。 */
	join_type: string;
	/** 左输入节点 id。 */
	left: string;
	/** 右输入节点 id。 */
	right: string;
	/** ON 谓词完整原文; null = cross/natural 无 ON。 */
	condition_expr: string | null;
	/** ON 谓词截断预览 (人看); null = 无 ON。 */
	condition_display: string | null;
	/** ON/USING 引用的列 (递归表达式树提取)。 */
	condition_columns: ColumnRef[];
	/** 可选：由 JOIN 条件 IR 直接提取的结构事实。 */
	condition_facts?: ExpressionFacts;
	/** 可选：保留 ON 条件的布尔结构、操作数绑定和源位置。 */
	condition_tree?: PredicateTree;
	/** true = ON 表达式含表达式子查询。 */
	contains_subquery?: boolean;
	/** true = USING (col, ...) 形式 (无 ON)。 */
	using?: boolean;
}

/** 聚合 (GROUP BY / 全局聚合)。grain 语义属推断层, 此处只记事实。 */
export interface AggregateRelation extends BaseRelation {
	type: "aggregate";
	/** GROUP BY 列引用 (IR body.columns 按 clause=groupBy 过滤); 空数组 = 无 GROUP BY。 */
	group_by: ColumnRef[];
	/** GROUP BY 表达式完整原文 (可能含函数/复杂表达式, 非纯列); 空数组 = 无 GROUP BY。 */
	group_by_exprs: string[];
	/** GROUP BY 表达式截断预览 (人看)。 */
	group_by_exprs_display: string[];
	/** 聚合函数输出列 (projections 中 aggregate=true 的列)。 */
	measures: ExprSpec[];
}

/** 行扩展 (LateralViewSource / explode / unnest 等)。v1 仅识别 lateral 源。 */
export interface ExpandRelation extends BaseRelation {
	type: "expand";
	expand_kind: "lateral" | "pivot" | "unpivot" | "unknown";
	/** 扩展产生的列 (LateralViewSource.columns)。 */
	produced_columns: string[];
}

/** 集合操作 (UNION / EXCEPT / INTERSECT)。v1.1.1 新增。 */
export interface SetopRelation extends BaseRelation {
	type: "setop";
	/** 集合操作符: union / except / intersect。 */
	setop: string;
	/** 是否 ALL (union all / except all); 缺省 = 非 ALL (UNION 语义去重)。 */
	all?: boolean;
	/** 按名合并 (UNION CORRESPONDING BY / BY NAME); 缺省 = 按位合并。 */
	by_name?: boolean;
	/** 分支节点 id 数组 (左→右, 源顺序)。嵌套 setop 时分支可能是 setop 节点。 */
	branches: string[];
}

export type TopNInputRole = "ORDER" | "LIMIT" | "OFFSET" | "FETCH";

/** One IR-backed input to a query-level ORDER BY/LIMIT/TOP/OFFSET-FETCH. */
export interface TopNInputBinding {
	role: TopNInputRole;
	ordinal: number;
	expression_text: string;
	display_text: string;
	span: SourceSpan;
	input_columns: ColumnRef[];
	direction?: "ASC" | "DESC";
	nulls?: WindowNullOrdering;
}

export interface TopNLimitFacts {
	kind: "TOP" | "LIMIT" | "OFFSET_FETCH";
	top?: TopNInputBinding;
	offset?: TopNInputBinding;
	fetch?: TopNInputBinding;
	percent?: boolean;
	with_ties?: boolean;
}

/** Query-level row limiting. Created only when the canonical IR exposes a limit input. */
export interface TopNRelation extends Omit<BaseRelation, "span" | "type"> {
	type: "top_n";
	source: string;
	order_by: TopNInputBinding[];
	limit: TopNLimitFacts;
	/** Whether the relation span covers the complete canonical Top-N construct. */
	span_status: "EXTRACTED" | "UNKNOWN";
	/** Null when Scope does not expose a trustworthy owning QueryExpr/CST span. */
	span: SourceSpan | null;
}

/** v1 未建模结构 (pipe 等), 显式保留而非丢弃。 */
export interface OtherRelation extends BaseRelation {
	type: "other";
	/** 未建模的 body kind。 */
	body_kind: string;
	note: string;
}

export type PlanRelation =
	| ReadRelation
	| ProjectRelation
	| FilterRelation
	| JoinRelation
	| AggregateRelation
	| ExpandRelation
	| SetopRelation
	| TopNRelation
	| OtherRelation;

/**
 * Scope source mapping needed when a logical CTE/derived read is represented by
 * a read node in the enclosing scope but its physical reads live in a child
 * scope.  The mapping is additive and legacy PlanFacts may omit it.
 */
export interface PlanScopeBinding {
	/** Enclosing scope path. */
	scope_id: string;
	/** Logical source relation in the enclosing scope. */
	relation_id: string;
	/** Binding key visible to the enclosing scope. */
	binding: string;
	/** Source kind as resolved by the scope layer. */
	source_kind: "cte" | "subquery" | "relation" | "graphtable" | "pivot";
	/** Target child scope path, null when the adaptor could not map it. */
	target_scope_id: string | null;
	/** Target child scope's root relation, null when the adaptor could not map it. */
	target_relation_id: string | null;
}

// ---------------------------------------------------------------------------
// 文档级事实
// ---------------------------------------------------------------------------

export interface PlanFacts {
	meta: {
		/** 本 JSON 遵循的契约版本 (plan-contract.ts)。 */
		contract_version: string;
		/** adapter 实现版本。 */
		adapter_version: string;
		/** 底层解析引擎。 */
		parser: { engine: string; version: string };
		dialect: string;
		/** 文档内第几条语句 (0-based), 与 cell.scopes 对应。 */
		statement_index: number;
		generated_at: string;
	};
	/** 全部关系节点, 扁平数组, id 唯一。 */
	relations: PlanRelation[];
	/** 最外层节点 id (整条语句的最终输出关系)。 */
	roots: string[];
	/** 全部物理表 (去重, 按首次出现顺序)。 */
	physical_inputs: string[];
	/** CTE/derived scope mappings. Optional for legacy PlanFacts bundles. */
	scope_bindings?: PlanScopeBinding[];
	/** 失败/缺失保留清单: 每个条目 = 一处无法完整提取的结构 + 原因。 */
	unknowns: {
		node_id: string;
		field: string;
		reason: string;
		span?: SourceSpan;
	}[];
	/** Native LineageHop projection; this is VALUE_LINEAGE only and never a relation graph. */
	lineage_hops: PlanLineageHopProjection;
}

// ---------------------------------------------------------------------------
// Grain / Cardinality 推断层 (独立于事实层, 允许 unknown)
// ---------------------------------------------------------------------------

export interface GrainInference {
	/** 推断对象节点 id (与 PlanFacts.relations 对齐)。 */
	node_id: string;
	/** 输出 grain 候选键列 (推断): 聚合 → group by 列集; 空数组 = 全局聚合 (至多 1 行);
	 *  其余 → null (无候选, 含"传播后仍未知")。 */
	grain_candidate: string[] | null;
	/** 行数变化方向 (推断): "non-increasing" / "non-decreasing" / "unknown"。
	 *  注意: 非严格单调 —— non-increasing ≠ 一定减少 (输入本就每键一行则不变);
	 *  fanout (explode 等) 用 unknown + cardinality_effect 描述, 不用 non-decreasing。 */
	cardinality: "non-increasing" | "non-decreasing" | "unknown";
	/** 置信度: high = 结构性事实 (如 GROUP BY 存在 / grain key 传播覆盖); medium = 启发式; low = 猜测。 */
	confidence: "high" | "medium" | "low";
	/** 支持证据 (人类可读)。 */
	evidence: string[];
	/** 消除不确定性所需的元数据 (PK/UK/uniqueness/统计), 供后续 resolver 对接。
	 *  空数组 = 该节点判定不依赖外部元数据。 */
	requires: string[];
	// ---- fanout 模型 (仅 expand 等行扩展节点) ----
	/** 行数效应模型: "fanout" = 每行展开 0..N 行; 无 = 常规。 */
	cardinality_effect?: "fanout" | "filter" | "none";
	/** fanout 的每行产出行数范围 (如 "0..N")。 */
	per_input_rows?: string;
	/** grain 效应: "expanded" = 行扩展改变粒度; "unchanged"; "unknown"。 */
	grain_effect?: "expanded" | "unchanged" | "unknown";
}

// ---------------------------------------------------------------------------
// Native value-lineage Hop projection
// ---------------------------------------------------------------------------

export type HopCoverageState = "FULL_HOP" | "FLAT_ORIGIN_ONLY" | "UNKNOWN_COVERAGE" | "NOT_EVALUABLE";
export type HopProjectionStatus = "PROJECTED" | "PARTIAL_NATIVE" | "NOT_EVALUABLE";
export type HopEdgeType = "PHYSICAL_FIELD_TO_HOP" | "HOP_TO_HOP";

export interface LocalPhysicalField {
	table: string;
	column: string;
}

export interface LocalHopViaStep {
	readonly relation_id: string;
	readonly kind: "rename" | "expand";
}

export interface PlanLineageHopRoot {
	readonly root_expression_id: string;
	readonly head_hop_id: string | null;
	readonly coverage_state: HopCoverageState;
	readonly projection_status: HopProjectionStatus;
	readonly reason_code?: string;
	readonly reason?: string;
	readonly flow_kind: "VALUE_LINEAGE";
	readonly physical_input_fields: readonly LocalPhysicalField[];
	readonly candidate_input_fields: readonly LocalPhysicalField[];
}

export interface PlanLineageHopNode {
	readonly hop_id: string;
	readonly scope_relation_id: string;
	readonly expression_id?: string;
	readonly expr_kind: string;
	readonly expression_text: string;
	readonly source_span: SourceSpan;
	readonly terminal_fields: readonly LocalPhysicalField[];
	readonly terminal: "PRESENT" | "NONE" | "UNRESOLVED";
	readonly has_downstream: boolean;
	readonly via: readonly LocalHopViaStep[];
	readonly flow_kind: "VALUE_LINEAGE";
}

export interface PlanLineageHopEdge {
	readonly edge_id: string;
	readonly edge_type: HopEdgeType;
	readonly from_hop_id?: string;
	readonly from_field?: LocalPhysicalField;
	readonly to_hop_id: string;
	readonly branch_relation_id?: string;
	readonly branch_ordinal?: number;
	readonly flow_kind: "VALUE_LINEAGE";
}

export interface PlanLineageHopProjection {
	readonly roots: readonly PlanLineageHopRoot[];
	readonly nodes: readonly PlanLineageHopNode[];
	readonly edges: readonly PlanLineageHopEdge[];
}
