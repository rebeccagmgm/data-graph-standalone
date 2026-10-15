import { isTemporalPartitionColumn } from "./partition-canonical.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/s, "$2");

/** Project matching policy, not SQL value equality. Date offsets are retained
 * in evidence but do not distinguish producers within a DAY partition unit. */
export function isDayPartitionValue(value: string): boolean {
  const text = unquote(value);
  // Approved legacy DAY placeholder. Original SQL is retained as evidence;
  // recognition here authorizes process continuation, not a concrete date.
  if (/^\{busi_date\}$/i.test(text)) return true;
  // Exact scheduler alias, also used by canonicalTemporalTemplate. Do not
  // classify arbitrary parameter prefixes or rewrite the stored expression.
  if (text === "${data_day_str}") return true;
  if (/^(?:\d{4}-\d{2}-\d{2}|\d{8})$/.test(text)) return true;
  // Uppercase forms without offsets are legacy internal canonical tokens.
  if (/^\$\{(?:YYYY-MM-DD|YYYYMMDD)\}$/.test(text)) return true;
  const offset = "(?:,\\s*[+-]?\\d+\\s*[dtyMqHems])?";
  return new RegExp(`^\\$\\{(?:yyyy-MM-dd|yyyyMMdd)${offset}\\}$`).test(text) ||
    new RegExp(`^\\$\\{yyyy-MM${offset}\\}-\\d{2}$`).test(text) ||
    new RegExp(`^\\$\\{yyyy${offset}\\}-\\d{2}-\\d{2}$`).test(text);
}

function dayExpression(value: unknown, depth: number): boolean {
  if (depth > 24) return false;
  const node = record(value);
  if (!node) return false;
  if (node.kind === "LITERAL") return typeof node.text === "string" && isDayPartitionValue(node.text);
  if (node.kind !== "FUNCTION" || typeof node.name !== "string" || !Array.isArray(node.args)) return false;
  const name = node.name.toLowerCase(), args = node.args;
  const allowed = (names: string[]) => names.includes(name) || names.map(n => `default.${n}`).includes(name);
  if (allowed(["pretradedate", "date_add", "date_sub", "add_months"]) && args.length === 2) {
    const count = record(args[1]);
    return dayExpression(args[0], depth + 1) && count?.kind === "LITERAL" &&
      typeof count.text === "string" && /^[+-]?\d+$/.test(count.text.trim());
  }
  if (allowed(["last_day", "date2datekey", "datekey2date", "to_date"]) && args.length === 1)
    return dayExpression(args[0], depth + 1);
  if (allowed(["date_format"]) && args.length === 2) {
    const format = record(args[1]);
    return dayExpression(args[0], depth + 1) && format?.kind === "LITERAL" && typeof format.text === "string" &&
      ["yyyy-MM-dd", "yyyyMMdd"].includes(unquote(format.text));
  }
  return false;
}

export function matchesDayPartitionUnit(column: string, writeValues: readonly string[], operands: readonly unknown[]): boolean {
  if (!isTemporalPartitionColumn(column) || !writeValues.length || !writeValues.every(isDayPartitionValue) || !operands.length) return false;
  return operands.every(value => {
    const operand = record(value);
    if (!operand) return false;
    if (operand.kind === "LITERAL") {
      const raw = operand.observedValue ?? operand.expression;
      return typeof raw === "string" && isDayPartitionValue(raw);
    }
    return operand.kind === "OTHER" && dayExpression(operand.structured_expression, 0);
  });
}
