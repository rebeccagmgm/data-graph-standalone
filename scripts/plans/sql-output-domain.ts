import { SqlSession } from "sqllens";
import { buildPlanFacts } from "./plan-adapter.ts";
import { sanitizeSqlForParser } from "./parser-sql-input.ts";

type Row = Record<string, any>;
const name = (value: unknown): string => String(value ?? "").toLowerCase();

/**
 * Prove a finite output domain through the existing SQL plan, not by collecting
 * same-named aliases anywhere in the text. Every UNION branch must be known.
 * CASE, functions, joins and unknown inputs deliberately stop this small proof:
 * their nested constants are witnesses, never an exhaustive output domain.
 * A null result means UNKNOWN, not an empty set and not permission to prune.
 */
export function provenSqlOutputExpressions(sql: string, field: string): readonly string[] | null {
  try {
    const parser = sanitizeSqlForParser(sql);
    const cells = SqlSession.create(parser.sql, "databricks").doc.statements;
    if (cells.length !== 1 || cells[0]!.errors) return null;
    const plan = parser.restore(buildPlanFacts(cells[0]!, parser.sql, {
      statement_index: 0, dialect: "databricks", include_expression_dependencies: true,
    }));
    if (plan.roots.length !== 1) return null;
    const relations = new Map<string, Row>(plan.relations.map(r => [r.id, r]));
    const visit = (id: string, column: string, active = new Set<string>()): string[] | null => {
      const key = `${id}:${column}`;
      if (active.has(key) || active.size > 64) return null;
      const r = relations.get(id);
      if (!r) return null;
      const next = new Set(active).add(key);
      if (r.type === "project") {
        const outputs = (r.expressions ?? []).filter((e: Row) => name(e.output) === name(column));
        if (outputs.length !== 1) return null;
        const expression = outputs[0].structured_expression;
        if (expression?.kind === "LITERAL") {
          return /^null$/i.test(expression.text) ? null : [expression.text];
        }
        if (expression?.kind !== "COLUMN" || !r.source) return null;
        return visit(r.source, expression.name, next);
      }
      if (r.type === "setop" && r.setop === "union") {
        const ordinal = r.output_columns?.findIndex((c: string) => name(c) === name(column));
        if (ordinal === undefined || ordinal < 0 || !r.branches?.length) return null;
        const values: string[] = [];
        for (const branch of r.branches) {
          const branchColumn = relations.get(branch)?.output_columns?.[ordinal];
          if (!branchColumn) return null;
          const domain = visit(branch, branchColumn, next);
          if (!domain) return null;
          values.push(...domain);
        }
        return [...new Set(values)];
      }
      if (r.type === "read" && r.source) return visit(r.source, column, next);
      if (r.type === "filter") {
        const inherited = visit(r.source, column, next);
        if (inherited) return inherited;
        // A WHERE bound is usable only on this direct physical read. Never
        // attach a filter across JOIN/UNION to a same-named output column.
        const source = relations.get(r.source);
        if (source?.type !== "read" || source.source) return null;
        const bounds = (tree: Row): string[] | null => {
          if (tree?.kind === "AND") {
            const known = tree.children.map(bounds).filter((v: string[] | null): v is string[] => v !== null);
            return known.length ? known.reduce((a: string[], b: string[]) => a.filter(v => b.includes(v))) : null;
          }
          const [left, ...right] = tree?.operands ?? [];
          if (tree?.kind !== "ATOM" || !["EQ", "IN"].includes(tree.operator) ||
            (tree.operator === "EQ" && right.length !== 1) || !right.length ||
            left?.kind !== "COLUMN" || name(left.column?.name) !== name(column) ||
            (left.column?.qualifier && name(left.column.qualifier) !== name(source.binding)) ||
            right.some((v: Row) => v.kind !== "LITERAL" || /^null$/i.test(v.expression))) return null;
          return right.map((v: Row) => v.expression);
        };
        const values = bounds(r.predicate_tree);
        return values?.length ? values : null;
      }
      return null;
    };
    return visit(plan.roots[0]!, field);
  } catch {
    return null;
  }
}
