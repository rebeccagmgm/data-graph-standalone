import type { Expr } from "sqllens";
import type {
	ColumnRef,
	ExpressionFacts,
	ExpressionRole,
	ExpressionRoleEffect,
	PredicateOperand,
	PredicateTree,
	StructuredExpression,
} from "../plan-contract.js";
import { fullTextOf, spanOfCst } from "./plan-text.js";

type RefWithOffset = ColumnRef & { _cellOffset?: number };

type ExprCst = {
	start?: { start?: number } | null;
	stop?: { stop?: number } | null;
};

export interface ExpressionRoleNode {
	operator: "CASE" | "IF" | "COALESCE";
	role: ExpressionRole;
	effects: ExpressionRoleEffect[];
	path: string;
	branch_ordinal?: number;
	ordinal: number;
	expression: Expr;
}

/**
 * Simple CASE is lowered to one synthetic equality per WHEN.  The equality's
 * CST is the whole WHEN section in the canonical IR, so it is not a
 * trustworthy source span for the selector role.  The shared left operand is
 * the canonical CASE subject and keeps its own exact CST span.
 */
function simpleCaseSelector(
	whens: readonly { when: Expr }[],
): Expr | undefined {
	if (whens.length === 0) return undefined;
	const comparisons = whens.map(({ when }) => {
		if (when.kind !== "binary" || when.op !== "=") return undefined;
		const cst = when.cst as ExprCst;
		const left = when.left.cst as ExprCst;
		const right = when.right.cst as ExprCst;
		const cstStart = cst.start?.start;
		const cstStop = cst.stop?.stop;
		const leftStart = left.start?.start;
		const rightStop = right.stop?.stop;
		// A searched CASE comparison normally has the same CST envelope as its
		// operands.  A simple CASE comparison is lowered with the WHEN section
		// (or the complete CASE in one dialect) as its CST, which extends beyond
		// at least one canonical operand.
		return cstStart !== undefined &&
			cstStop !== undefined &&
			leftStart !== undefined &&
			rightStop !== undefined &&
			(cstStart !== leftStart || cstStop !== rightStop)
			? when
			: undefined;
	});
	const selector = comparisons[0]?.left;
	if (!selector) return undefined;
	return comparisons.every((comparison) => comparison?.left === selector)
		? selector
		: undefined;
}

/**
 * Project only roles that are explicit in the canonical expression IR.  This
 * deliberately does not inspect expression text, so an unmodelled expression
 * remains absent/unknown instead of being classified by a string heuristic.
 */
export function expressionRoleNodes(
	e: Expr | null | undefined,
	dialect = "databricks",
): ExpressionRoleNode[] {
	const out: ExpressionRoleNode[] = [];
	const dialectName = dialect.toLowerCase();
	const isDatabricksIsNull =
		dialectName === "databricks" || dialectName === "spark";
	const visit = (node: Expr | null | undefined, path: string): void => {
		if (!node) return;
		if (node.kind === "case") {
			const selector = simpleCaseSelector(node.whens);
			for (const [ordinal, branch] of node.whens.entries()) {
				out.push({
					operator: "CASE",
					role: "BRANCH_SELECTOR",
					effects: ["BRANCH_SELECTION"],
					path: `${path}.when[${ordinal}]`,
					branch_ordinal: ordinal,
					ordinal,
					expression: selector ?? branch.when,
				});
				out.push({
					operator: "CASE",
					role: "RESULT_VALUE",
					effects: ["VALUE_CONTRIBUTION"],
					path: `${path}.then[${ordinal}]`,
					branch_ordinal: ordinal,
					ordinal,
					expression: branch.then,
				});
				visit(branch.when, `${path}.when[${ordinal}]`);
				visit(branch.then, `${path}.then[${ordinal}]`);
			}
			if (node.elseExpr) {
				out.push({
					operator: "CASE",
					role: "RESULT_VALUE",
					effects: ["VALUE_CONTRIBUTION"],
					path: `${path}.else`,
					ordinal: node.whens.length,
					expression: node.elseExpr,
				});
				visit(node.elseExpr, `${path}.else`);
			}
			return;
		}
		if (node.kind === "function") {
			const name = node.name.toLowerCase();
			const isIf = name === "if" || name === "iif";
			const isCoalesce =
				name === "coalesce" ||
				name === "ifnull" ||
				name === "nvl" ||
				(name === "isnull" &&
					!isDatabricksIsNull &&
					node.args.length >= 2);
			for (const [ordinal, arg] of node.args.entries()) {
				if (isIf && ordinal < 3) {
					out.push({
						operator: "IF",
						role: ordinal === 0 ? "BRANCH_SELECTOR" : "RESULT_VALUE",
						effects:
							ordinal === 0
								? ["BRANCH_SELECTION"]
								: ["VALUE_CONTRIBUTION"],
						path: `${path}.arg[${ordinal}]`,
						branch_ordinal: ordinal > 0 ? ordinal - 1 : undefined,
						ordinal,
						expression: arg,
					});
				} else if (isCoalesce) {
					out.push({
						operator: "COALESCE",
						role: "COALESCE_ARGUMENT",
						effects: ["VALUE_CONTRIBUTION", "BRANCH_SELECTION"],
						path: `${path}.arg[${ordinal}]`,
						ordinal,
						expression: arg,
					});
				}
				visit(arg, `${path}.arg[${ordinal}]`);
			}
			return;
		}
		if (node.kind === "binary") {
			visit(node.left, `${path}.left`);
			visit(node.right, `${path}.right`);
		} else if (node.kind === "unary") visit(node.operand, `${path}.operand`);
		else if (node.kind === "cast") visit(node.expr, `${path}.expr`);
		else if (node.kind === "predicate") {
			visit(node.operand, `${path}.operand`);
			for (const [ordinal, arg] of node.args.entries())
				visit(arg, `${path}.arg[${ordinal}]`);
		} else if (node.kind === "subscript") {
			visit(node.base, `${path}.base`);
			visit(node.index, `${path}.index`);
			visit(node.end, `${path}.end`);
			visit(node.step, `${path}.step`);
		} else if (node.kind === "lambda") visit(node.body, `${path}.body`);
		else if (node.kind === "with") {
			for (const [ordinal, binding] of node.bindings.entries())
				visit(binding.value, `${path}.binding[${ordinal}]`);
			visit(node.result, `${path}.result`);
		}
	};
	visit(e, "root");
	return out;
}

/** 递归提取表达式树里的列引用。 */
export function collectColumns(
	e: Expr | null | undefined,
	clause: ColumnRef["clause"],
	out: ColumnRef[],
): void {
	if (!e) return;
	switch (e.kind) {
		case "column":
			out.push({
				name: e.parts[e.parts.length - 1] ?? "?",
				qualifier: e.parts.length > 1 ? e.parts[0] : undefined,
				clause,
				physical: null,
				_cellOffset: e.partSpans?.[0]?.start,
			} as RefWithOffset);
			return;
		case "binary":
			collectColumns(e.left, clause, out);
			collectColumns(e.right, clause, out);
			return;
		case "unary":
			collectColumns(e.operand, clause, out);
			return;
		case "function":
			for (const a of e.args) collectColumns(a, clause, out);
			return;
		case "case":
			for (const w of e.whens) {
				collectColumns(w.when, clause, out);
				collectColumns(w.then, clause, out);
			}
			if (e.elseExpr) collectColumns(e.elseExpr, clause, out);
			return;
		case "cast":
			collectColumns(e.expr, clause, out);
			return;
		case "predicate":
			collectColumns(e.operand, clause, out);
			for (const a of e.args ?? []) collectColumns(a, clause, out);
			return;
		case "subscript":
			collectColumns(e.base, clause, out);
			if (e.index) collectColumns(e.index, clause, out);
			return;
		default:
			return;
	}
}

function normalizedLiteralValue(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'"))
		return trimmed.slice(1, -1).replaceAll("''", "'");
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"'))
		return trimmed.slice(1, -1).replaceAll('""', '"');
	if (/^(?:[-+]?\d+(?:\.\d+)?|true|false)$/iu.test(trimmed))
		return trimmed;
	return null;
}

function predicateColumnRef(
	e: Extract<Expr, { kind: "column" }>,
	clause: ColumnRef["clause"],
): ColumnRef {
	return {
		name: e.parts[e.parts.length - 1] ?? "?",
		qualifier: e.parts.length > 1 ? e.parts[0] : undefined,
		clause,
		physical: null,
		_cellOffset: e.partSpans?.[0]?.start,
	} as RefWithOffset;
}

function predicateOperand(
	e: Expr,
	sql: string,
	cellBase: number,
	clause: ColumnRef["clause"],
): PredicateOperand {
	const expression = fullTextOf(sql, cellBase, e.cst);
	if (e.kind === "column")
		return {
			kind: "COLUMN",
			expression,
			column: predicateColumnRef(e, clause),
		};
	if (e.kind === "literal")
		return {
			kind: "LITERAL",
			expression: e.text,
			observedValue: normalizedLiteralValue(e.text),
		};
	if (e.kind === "parameter" || e.kind === "variable")
		return {
			kind: "RUNTIME_EXPRESSION",
			expression,
			inputColumns: [],
		};
	const inputColumns: ColumnRef[] = [];
	collectColumns(e, clause, inputColumns);
	const structured_expression = structuredExpressionOf(e);
	return {
		kind: "OTHER",
		expression,
		inputColumns,
		...(structured_expression ? { structured_expression } : {}),
	};
}

export function predicateTreeOf(
	e: Expr,
	sql: string,
	cellBase: number,
	clause: ColumnRef["clause"],
): PredicateTree {
	const span = spanOfCst(cellBase, e.cst);
	if (e.kind === "binary") {
		const op = e.op.toLowerCase();
		if (op === "and" || op === "or")
			return {
				kind: op.toUpperCase() as "AND" | "OR",
				children: [
					predicateTreeOf(e.left, sql, cellBase, clause),
					predicateTreeOf(e.right, sql, cellBase, clause),
				],
				span,
			};
		return {
			kind: "ATOM",
			operator:
				({
					"=": "EQ",
					"<>": "NE",
					"!=": "NE",
					"<": "LT",
					"<=": "LTE",
					">": "GT",
					">=": "GTE",
				} as Record<
					string,
					"EQ" | "NE" | "LT" | "LTE" | "GT" | "GTE"
				>)[op] ?? "OTHER",
			operands: [
				predicateOperand(e.left, sql, cellBase, clause),
				predicateOperand(e.right, sql, cellBase, clause),
			],
			span,
		};
	}
	if (e.kind === "unary" && e.op.toLowerCase() === "not")
		return {
			kind: "NOT",
			child: predicateTreeOf(e.operand, sql, cellBase, clause),
			span,
		};
	if (e.kind === "predicate") {
		const op = e.op.toLowerCase();
		const operator =
			op === "in"
				? "IN"
				: op === "between"
					? "BETWEEN"
					: op === "like" || op === "ilike"
						? "LIKE"
						: "OTHER";
		const atom: PredicateTree = {
			kind: "ATOM",
			operator,
			operands: [
				predicateOperand(e.operand, sql, cellBase, clause),
				...e.args.map((arg) =>
					predicateOperand(arg, sql, cellBase, clause),
				),
			],
			span,
		};
		return e.negated ? { kind: "NOT", child: atom, span } : atom;
	}
	return {
		kind: "ATOM",
		operator: "OTHER",
		operands: [predicateOperand(e, sql, cellBase, clause)],
		span,
	};
}

export function predicateColumnsOf(
	tree: PredicateTree,
	output: ColumnRef[] = [],
): ColumnRef[] {
	if (tree.kind === "AND" || tree.kind === "OR")
		for (const child of tree.children) predicateColumnsOf(child, output);
	else if (tree.kind === "NOT") predicateColumnsOf(tree.child, output);
	else if (tree.kind === "ATOM")
		for (const operand of tree.operands) {
			if (operand.kind === "COLUMN") output.push(operand.column);
			else if (operand.kind === "OTHER") output.push(...operand.inputColumns);
		}
	return output;
}

/** 直接遍历 sql-static-lineage IR，保留表达式判断所需的结构事实。 */
export function expressionFacts(
	e: Expr | null | undefined,
): ExpressionFacts {
	const operators = new Set<string>();
	const literals = new Set<string>();
	const functions = new Set<string>();
	const predicates = new Map<string, { operator: string; negated: boolean }>();
	const comparisons: ExpressionFacts["comparisons"] = [];
	const collectLiterals = (
		node: Expr | null | undefined,
		out: string[],
	): void => {
		if (!node) return;
		if (node.kind === "literal") {
			out.push(node.text);
			return;
		}
		if (node.kind === "binary") {
			collectLiterals(node.left, out);
			collectLiterals(node.right, out);
		} else if (node.kind === "unary") collectLiterals(node.operand, out);
		else if (node.kind === "function")
			for (const arg of node.args) collectLiterals(arg, out);
		else if (node.kind === "case") {
			for (const branch of node.whens) {
				collectLiterals(branch.when, out);
				collectLiterals(branch.then, out);
			}
			collectLiterals(node.elseExpr, out);
		} else if (node.kind === "cast") collectLiterals(node.expr, out);
		else if (node.kind === "predicate") {
			collectLiterals(node.operand, out);
			for (const arg of node.args) collectLiterals(arg, out);
		}
	};
	const visit = (node: Expr | null | undefined): void => {
		if (!node) return;
		switch (node.kind) {
			case "literal":
				literals.add(node.text);
				return;
			case "binary":
				operators.add(node.op.toLowerCase());
				if (["=", "!=", "<>", "<", "<=", ">", ">="].includes(node.op.toLowerCase())) {
					const refs: ColumnRef[] = [];
					const comparisonLiterals: string[] = [];
					collectColumns(node, "where", refs);
					collectLiterals(node, comparisonLiterals);
					comparisons.push({
						operator: node.op.toLowerCase(),
						columns: [...new Set(refs.map((ref) => ref.name.toLowerCase()))],
						literals: [...new Set(comparisonLiterals)],
					});
				}
				visit(node.left);
				visit(node.right);
				return;
			case "unary":
				operators.add(node.op.toLowerCase());
				visit(node.operand);
				return;
			case "function":
				functions.add(node.name.toLowerCase());
				for (const arg of node.args) visit(arg);
				return;
			case "case":
				for (const branch of node.whens) {
					visit(branch.when);
					visit(branch.then);
				}
				visit(node.elseExpr);
				return;
			case "cast":
				visit(node.expr);
				return;
			case "predicate": {
				const operator = node.op.toLowerCase();
				predicates.set(`${operator}:${node.negated}`, {
					operator,
					negated: node.negated,
				});
				visit(node.operand);
				for (const arg of node.args) visit(arg);
				return;
			}
			case "subscript":
				visit(node.base);
				visit(node.index);
				visit(node.end);
				visit(node.step);
				return;
			case "lambda":
				visit(node.body);
				return;
			default:
				return;
		}
	};
	visit(e);
	return {
		operators: [...operators],
		literals: [...literals],
		functions: [...functions],
		predicates: [...predicates.values()],
		comparisons,
	};
}

/**
 * Serialize the canonical IR expression shape without carrying parser nodes
 * or reparsing the expression text.  Unsupported IR forms remain explicit so
 * a downstream semantic engine can stop conservatively at that boundary.
 */
export function structuredExpressionOf(
	e: Expr | null | undefined,
): StructuredExpression | undefined {
	if (!e) return undefined;
	switch (e.kind) {
		case "column": {
			const name = e.parts.at(-1);
			if (!name) return { kind: "UNSUPPORTED", sourceKind: e.kind };
			return {
				kind: "COLUMN",
				name,
				...(e.parts.length > 1 ? { qualifier: e.parts[0] } : {}),
			};
		}
		case "literal":
			return { kind: "LITERAL", text: e.text };
		case "function":
			return {
				kind: "FUNCTION",
				name: e.name,
				...(e.qualifier ? { qualifier: e.qualifier } : {}),
				args: e.args.flatMap((arg) => {
					const result = structuredExpressionOf(arg);
					return result ? [result] : [];
				}),
			};
		case "binary": {
			const left = structuredExpressionOf(e.left);
			const right = structuredExpressionOf(e.right);
			return left && right
				? { kind: "BINARY", op: e.op, left, right }
				: { kind: "UNSUPPORTED", sourceKind: e.kind };
		}
		case "unary": {
			const operand = structuredExpressionOf(e.operand);
			return operand
				? { kind: "UNARY", op: e.op, operand }
				: { kind: "UNSUPPORTED", sourceKind: e.kind };
		}
		case "case": {
			const whens = e.whens.flatMap((branch) => {
				const when = structuredExpressionOf(branch.when);
				const then = structuredExpressionOf(branch.then);
				return when && then ? [{ when, then }] : [];
			});
			if (whens.length !== e.whens.length) return { kind: "UNSUPPORTED", sourceKind: e.kind };
			const elseExpr = structuredExpressionOf(e.elseExpr);
			return {
				kind: "CASE",
				whens,
				...(e.elseExpr && elseExpr ? { elseExpr } : {}),
			};
		}
		case "cast": {
			const expr = structuredExpressionOf(e.expr);
			return expr
				? { kind: "CAST", expr, typeText: e.typeText }
				: { kind: "UNSUPPORTED", sourceKind: e.kind };
		}
		case "predicate": {
			const operand = structuredExpressionOf(e.operand);
			const args = e.args.flatMap((arg) => {
				const result = structuredExpressionOf(arg);
				return result ? [result] : [];
			});
			return operand && args.length === e.args.length
				? { kind: "PREDICATE", op: e.op, negated: e.negated, operand, args }
				: { kind: "UNSUPPORTED", sourceKind: e.kind };
		}
		default:
			return { kind: "UNSUPPORTED", sourceKind: e.kind };
	}
}
