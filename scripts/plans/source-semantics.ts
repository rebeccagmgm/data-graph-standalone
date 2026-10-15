import { toScopes, type Dialect, type QueryExpr, type StatementCell } from "sqllens";

/**
 * The parser profiles are shared by multiple source SQL families. Normalize
 * Oracle's bare SYSDATE on its canonical IR before qualification and native
 * lineage. Preserve CST objects/spans and do not rewrite source SQL text.
 */
export function applySourceSemantics<T extends Pick<StatementCell, "ast" | "scopes">>(
  cell: T,
  sourceFamily?: "oracle",
  sourceSlot?: string,
): T {
  if (sourceFamily !== "oracle" || (sourceSlot !== undefined && sourceSlot !== "query")) return cell;
  const seen = new WeakMap<object, unknown>();
  const bareSystemValue = (item: Record<string, unknown>): boolean =>
    Array.isArray(item.parts) && item.parts.length === 1
    && typeof item.parts[0] === "string" && item.parts[0].toLowerCase() === "sysdate";
  let changes = 0;
  const visit = (item: unknown): unknown => {
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return seen.get(item);
    if (Array.isArray(item)) {
      const out: unknown[] = [];
      seen.set(item, out);
      for (const child of item) {
        // Canonical SelectExpr.columns indexes references separately from Expr.
        if (child?.kind === "columnref" && bareSystemValue(child)) continue;
        out.push(visit(child));
      }
      return out;
    }
    const input = item as Record<string, unknown>;
    if (input.kind === "column" && bareSystemValue(input)) {
      const out = { kind: "function", name: (input.parts as string[])[0], args: [],
        aggregate: false, distinct: false, cst: input.cst };
      seen.set(item, out);
      changes++;
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(item, out);
    for (const [key, value] of Object.entries(input)) {
      // Parser contexts contain cyclic parent links and methods; they remain
      // shared immutable source anchors, never generic-cloned or traversed.
      out[key] = key === "cst" ? value : visit(value);
    }
    return out;
  };
  const ast = visit(cell.ast) as QueryExpr;
  if (!changes) return cell;
  return { ...cell, ast, scopes: toScopes(ast, { dialect: cell.scopes.root.dialect as Dialect }) };
}
