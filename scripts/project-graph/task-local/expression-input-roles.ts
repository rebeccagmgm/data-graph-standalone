import { normalizeName } from "../../machine-facts/machine-facts-contract.ts";

type JsonRecord = Record<string, unknown>;
type Effect = "VALUE" | "CONDITIONAL";

export interface ExpressionInputRoles {
  readonly valueInputs: readonly JsonRecord[];
  readonly conditionalInputs: readonly JsonRecord[];
  readonly terminalKind: "LITERAL" | "SYSTEM_VALUE" | "ROWSET_DERIVED" | "DERIVED_VALUE" | "UNKNOWN" | null;
  readonly complete: boolean;
  readonly reasonCode?: string;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord : null;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.flatMap((item) => record(item) ? [record(item)!] : []) : [];
}

function name(value: unknown): string {
  return normalizeName(String(value ?? ""));
}

function pairs(value: JsonRecord): JsonRecord[] {
  const inputs = Array.isArray(value.input_columns)
    ? records(value.input_columns).flatMap((input) => records(input.physical))
    : records(value.input_fields);
  return inputs.flatMap((field) => name(field.table) && name(field.column)
    ? [{ ...field, table: name(field.table), column: name(field.column) }] : []);
}

function expressionRecord(expression: JsonRecord, relationBody: unknown): JsonRecord {
  const relation = record(relationBody);
  if (!relation) return expression;
  const expressions = [...records(relation.expressions), ...records(relation.measures)];
  const output = name(expression.output_name ?? expression.output);
  const matches = expressions.filter((item) => name(item.output ?? item.output_name) === output);
  if (matches.length === 1) return { ...expression, ...matches[0] };
  const ordinal = expression.ordinal;
  if (Number.isInteger(ordinal) && expressions[Number(ordinal)] && matches.includes(expressions[Number(ordinal)]!)) {
    return { ...expression, ...expressions[Number(ordinal)] };
  }
  return expression;
}

function descendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

/** Compose parser-owned operand roles relative to the enclosing output.
 * Role input lists summarize entire subtrees; only structured leaf occurrences
 * may contribute when a structured expression is available.
 */
export function classifyExpressionInputRoles(
  expression: JsonRecord,
  relationBody?: unknown,
): ExpressionInputRoles {
  const source = expressionRecord(expression, relationBody);
  const roles = records(source.expression_roles);
  const values = new Map<string, JsonRecord>();
  const conditions = new Map<string, JsonRecord>();
  const unresolved = records(source.unresolved_input_columns).length > 0
    || ["UNRESOLVED", "PARTIAL", "SQL_CANDIDATE"].includes(String(source.input_dependency_status ?? ""));
  let complete = !unresolved;
  let sawColumn = false;
  let sawUnknownFunction = false;
  let sawSystem = false;
  let sawRowset = Boolean(source.window_spec);
  const add = (fields: readonly JsonRecord[], effects: readonly Effect[]): void => {
    for (const field of fields) {
      const key = `${name(field.table)}\u0000${name(field.column)}\u0000${name(field.qualifier)}`;
      if (effects.includes("VALUE")) values.set(key, field);
      if (effects.includes("CONDITIONAL")) conditions.set(key, field);
    }
  };
  const inputForColumn = (node: JsonRecord, path: string): JsonRecord[] => {
    const candidates = roles.filter((role) => descendant(path, String(role.path ?? "")))
      .sort((a, b) => String(b.path ?? "").length - String(a.path ?? "").length);
    for (const owner of [...candidates, source]) {
      if (Array.isArray(owner.input_columns)) {
        const matching = records(owner.input_columns).filter((input) =>
          name(input.name) === name(node.name)
          && (!name(node.qualifier) || name(input.qualifier) === name(node.qualifier)),
        );
        if (matching.length === 0) continue;
        const fields = matching.flatMap((input) => pairs({ input_columns: [input] })
          .map((field) => ({ ...field, ...(name(input.qualifier) ? { qualifier: name(input.qualifier) } : {}) })));
        if (matching.some((input) => ["UNRESOLVED", "SQL_CANDIDATE"].includes(String(input.resolution)))) complete = false;
        return fields;
      }
      const matching = pairs(owner).filter((field) => name(field.column) === name(node.name));
      if (matching.length > 0) return matching;
    }
    return [];
  };
  const forceConditional = (effects: readonly Effect[]): readonly Effect[] =>
    effects.length > 0 ? ["CONDITIONAL"] : [];
  const visit = (value: unknown, path: string, effects: readonly Effect[]): void => {
    const node = record(value);
    if (!node) { complete = false; return; }
    const kind = String(node.kind ?? "").toUpperCase();
    if (kind === "LITERAL") return;
    if (kind === "COLUMN") {
      sawColumn = true;
      const fields = inputForColumn(node, path);
      if (fields.length === 0) complete = false;
      add(fields, effects);
      return;
    }
    if (kind === "CASE") {
      for (const [index, branch] of records(node.whens).entries()) {
        visit(branch.when, `${path}.when[${index}]`, forceConditional(effects));
        visit(branch.then, `${path}.then[${index}]`, effects);
      }
      if (node.elseExpr) visit(node.elseExpr, `${path}.else`, effects);
      return;
    }
    if (kind === "FUNCTION") {
      const functionName = name(node.name);
      const args = Array.isArray(node.args) ? node.args : [];
      sawSystem ||= /^(current_timestamp|current_date|current_time|now|sysdate|current_user|session_user|uuid|rand|random)$/.test(functionName);
      sawRowset ||= /^(count|row_number|rank|dense_rank|ntile|percent_rank|cume_dist)$/.test(functionName);
      sawUnknownFunction ||= !/^(current_timestamp|current_date|current_time|now|sysdate|current_user|session_user|uuid|rand|random|count|row_number|rank|dense_rank|ntile|percent_rank|cume_dist|coalesce|ifnull|nvl|isnull|if|iif|concat|concat_ws|upper|lower|trim|ltrim|rtrim|substring|substr|length|abs|ceil|floor|round|date_format|to_date|to_timestamp|replace|regexp_replace)$/.test(functionName);
      const roleAt = (index: number) => roles.find((role) => role.path === `${path}.arg[${index}]`);
      const isIf = roleAt(0)?.operator === "IF";
      const isCoalesce = roleAt(0)?.operator === "COALESCE";
      args.forEach((arg, index) => {
        // COUNT(*) is a rowset dependency, not an unbound physical column.
        const operand = record(arg);
        if (functionName === "count" && operand?.kind === "UNSUPPORTED" && /star|wildcard/i.test(String(operand.sourceKind))) return;
        const argumentEffects = isIf && index === 0
          ? forceConditional(effects)
          : isCoalesce && index < args.length - 1
            ? [...new Set<Effect>([...effects, "CONDITIONAL"])]
            : effects;
        visit(arg, `${path}.arg[${index}]`, argumentEffects);
      });
      return;
    }
    if (kind === "BINARY") {
      visit(node.left, `${path}.left`, effects);
      visit(node.right, `${path}.right`, effects);
      return;
    }
    if (kind === "UNARY" || kind === "PREDICATE") {
      visit(node.operand, `${path}.operand`, effects);
      if (kind === "PREDICATE") (Array.isArray(node.args) ? node.args : []).forEach((arg, index) => visit(arg, `${path}.arg[${index}]`, effects));
      return;
    }
    if (kind === "CAST") { visit(node.expr, `${path}.expr`, effects); return; }
    complete = false;
  };
  const structured = record(source.structured_expression);
  if (structured && structured.kind !== "UNSUPPORTED") {
    visit(structured, "root", ["VALUE"]);
  } else if (roles.length > 0) {
    // Legacy roles without a lossless shape remain usable for non-nested
    // operands. Nested summary overlap is explicitly incomplete, not guessed.
    for (const role of roles) {
      const path = String(role.path ?? "");
      const ancestors = roles.filter((candidate) => candidate !== role && descendant(path, String(candidate.path ?? "")));
      const children = roles.filter((candidate) => candidate !== role && descendant(String(candidate.path ?? ""), path));
      const shadowed = new Set(children.flatMap(pairs).map((field) => `${field.table}\u0000${field.column}`));
      if (children.length > 0) complete = false;
      const fields = pairs(role).filter((field) => !shadowed.has(`${field.table}\u0000${field.column}`));
      const conditionalAncestor = ancestors.some((ancestor) => ancestor.role === "BRANCH_SELECTOR");
      const effects = Array.isArray(role.effects) ? role.effects : [];
      add(fields, conditionalAncestor ? ["CONDITIONAL"] : [
        ...(effects.includes("VALUE_CONTRIBUTION") ? ["VALUE" as const] : []),
        ...(effects.includes("BRANCH_SELECTION") ? ["CONDITIONAL" as const] : []),
      ]);
    }
  } else {
    const fields = pairs(source);
    add(fields, ["VALUE"]);
    sawColumn = fields.length > 0;
    if (structured?.kind === "UNSUPPORTED") complete = false;
  }
  const sorted = (fields: Map<string, JsonRecord>) => [...fields.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, field]) => field);
  const hasInputs = values.size + conditions.size > 0;
  const sourceText = String(source.expression_text ?? source.expr_text ?? "").trim();
  const literal = structured?.kind === "LITERAL" || /^(?:'(?:''|[^'])*'|[-+]?\d+(?:\.\d+)?|NULL|TRUE|FALSE)(?:\s+AS\s+\S+)?$/i.test(sourceText);
  const terminalKind: ExpressionInputRoles["terminalKind"] = hasInputs ? null
    : !complete ? "UNKNOWN"
      : sawRowset ? "ROWSET_DERIVED"
        : sawSystem ? "SYSTEM_VALUE"
          : literal ? "LITERAL"
            : !sawColumn && structured !== null && !sawUnknownFunction ? "DERIVED_VALUE"
              : "UNKNOWN";
  if (terminalKind === "UNKNOWN") complete = false;
  return {
    valueInputs: sorted(values), conditionalInputs: sorted(conditions), terminalKind, complete,
    ...(!complete ? { reasonCode: structured?.kind === "UNSUPPORTED" ? "EXPRESSION_STRUCTURE_UNSUPPORTED" : "EXPRESSION_INPUT_ROLES_UNRESOLVED" } : {}),
  };
}
