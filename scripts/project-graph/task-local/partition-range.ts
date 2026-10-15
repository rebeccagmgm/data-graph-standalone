import { matchesDayPartitionUnit } from "./partition-day-grain.ts";
type RecordValue = Record<string, any>;
const object = (v: unknown): RecordValue | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : null;
const name = (v: unknown): string => typeof v === "string" ? v.trim().toLowerCase() : "";

export interface ReadPartitionRange {
  readonly version: 1;
  readonly table: string;
  readonly trees: readonly unknown[];
}

/** Preserve boolean structure only where all filters above a read stay on a
 * single-source path. Filters across joins/UNION need occurrence binding first. */
export function readPartitionRanges(relations: readonly RecordValue[]): ReadonlyMap<string, ReadPartitionRange> {
  const rows = relations.map(r => object(r.relation) ?? r);
  const parents = new Map<string, RecordValue[]>();
  for (const r of rows) {
    for (const id of [r.source, r.left, r.right, ...(Array.isArray(r.branches) ? r.branches : [])]) {
      if (typeof id !== "string") continue;
      parents.set(id, [...(parents.get(id) ?? []), r]);
    }
  }
  const result = new Map<string, ReadPartitionRange>();
  for (const read of rows.filter(r => r.type === "read" && typeof r.id === "string" && typeof r.table === "string")) {
    const queue: { id: string; crossed: boolean }[] = [{ id: read.id, crossed: false }];
    const seen = new Set<string>(), trees: unknown[] = [];
    let valid = true;
    while (queue.length && valid) {
      const current = queue.pop()!;
      const key = `${current.id}:${current.crossed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const p of parents.get(current.id) ?? []) {
        const crossed = current.crossed || !["filter", "project", "alias"].includes(p.type);
        if (p.type === "filter") {
          if (crossed || !object(p.predicate_tree)) { valid = false; break; }
          trees.push(p.predicate_tree);
        }
        queue.push({ id: p.id, crossed });
      }
    }
    if (valid && trees.length) result.set(read.id, { version: 1, table: read.table, trees });
  }
  return result;
}

type Point = { kind: "month" | "day"; offset: number; position: "current" | "first" | "last" }
  | { kind: "yearStart"; unit: "month" | "day" }
  | { kind: "literal"; value: string };

function point(raw: string): Point {
  const value = raw.trim().replace(/^(['"])(.*)\1$/s, "$2");
  const token = value.match(/^\$\{(yyyy(?:-?mm)?(?:-?dd)?)(?:,\s*([+-]?\d+)([mMyY]))?\}(.*)$/i);
  if (!token) return { kind: "literal", value };
  const format = token[1]!.toLowerCase(), suffix = token[4]!;
  // Scheduler M means months; lowercase m means minutes, never months.
  if (token[3] && !["M", "y"].includes(token[3])) return { kind: "literal", value };
  const offset = Number(token[2] ?? 0) * (name(token[3]) === "y" ? 12 : 1);
  if (!Number.isSafeInteger(offset)) return { kind: "literal", value };
  if (format === "yyyy" && offset === 0 && ["01", "-01-01"].includes(suffix))
    return { kind: "yearStart", unit: suffix === "01" ? "month" : "day" };
  if (format === "yyyy" || (suffix && suffix !== "-01")) return { kind: "literal", value };
  if (format.endsWith("dd") && !suffix) return { kind: "day", offset, position: "current" };
  if (suffix === "-01") return { kind: "day", offset, position: "first" };
  return { kind: "month", offset, position: "current" };
}

function operandPoint(operand: RecordValue): Point | null {
  if (operand.kind === "LITERAL") return point(String(operand.observedValue ?? operand.expression ?? ""));
  const e = object(operand.structured_expression);
  // Only the built-in month end operation is interpreted. UDF names are opaque.
  const arg = Array.isArray(e?.args) && e.args.length === 1 ? object(e.args[0]) : null;
  if (e?.kind === "FUNCTION" && name(e.name) === "last_day" && arg?.kind === "LITERAL" && typeof arg.text === "string") {
    const p = point(arg.text);
    if (p.kind === "day") return { ...p, position: "last" };
  }
  return null;
}

/** Possible ordering signs, not a sample evaluation at today's date. */
function order(a: Point, b: Point): readonly number[] | null {
  if (a.kind === "literal" || b.kind === "literal") {
    if (a.kind !== "literal" || b.kind !== "literal") return null;
    if (/\$\{|\(|\)/.test(a.value + b.value)) return null;
    return [a.value === b.value ? 0 : a.value < b.value ? -1 : 1];
  }
  if (a.kind === "yearStart" || b.kind === "yearStart") {
    if (a.kind === "yearStart" && b.kind === "yearStart") return a.unit === b.unit ? [0] : null;
    const start = a.kind === "yearStart" ? a : b as Extract<Point, {kind: "yearStart"}>;
    const p = a.kind === "yearStart" ? b : a;
    if (p.kind === "yearStart" || p.kind !== start.unit || p.offset !== 0) return null;
    return a.kind === "yearStart" ? [-1, 0] : [0, 1];
  }
  if (a.kind !== b.kind) return null;
  if (a.offset !== b.offset) return [a.offset < b.offset ? -1 : 1];
  if (a.position === b.position) return [0];
  const rank = { first: 0, current: 1, last: 2 };
  return rank[a.position] < rank[b.position] ? [-1, 0] : [0, 1];
}

function comparison(a: Point, op: string, b: Point): boolean | null {
  // Ordering arbitrary strings/numbers depends on SQL types and collation.
  if (op !== "EQ" && a.kind === "literal" && b.kind === "literal" &&
    (!/^(?:\d{4}-\d{2}(?:-\d{2})?|\d{6})$/.test(a.value) ||
     !/^(?:\d{4}-\d{2}(?:-\d{2})?|\d{6})$/.test(b.value) || a.value.length !== b.value.length)) return null;
  const signs = order(a, b);
  if (!signs) return null;
  const test = (s: number) => op === "EQ" ? s === 0 : op === "LT" ? s < 0 : op === "LTE" ? s <= 0 : op === "GT" ? s > 0 : s >= 0;
  const results = signs.map(test);
  return results.every(Boolean) ? true : results.every(v => !v) ? false : null;
}

/** A positive result proves a known write point satisfies every partition
 * constraint. Unknown values, OR, NULL and unsupported expressions cannot pass. */
export function matchesReadPartitionRange(scopeValue: unknown, parts: readonly {
  column: string; values: readonly string[]; mayBeNull?: boolean; partitionStatus?: string; valueStatus?: string;
}[]): boolean | null {
  const scope = object(scopeValue);
  if (scope?.version !== 1 || typeof scope.table !== "string" || !Array.isArray(scope.trees)) return null;
  const partition = new Map(parts.map(p => [name(p.column), p]));
  if (!parts.length || parts.some(p => p.mayBeNull || p.values.length !== 1 ||
    /CONFLICT|UNKNOWN|DYNAMIC/i.test(p.partitionStatus ?? "") || /UNKNOWN|DYNAMIC/i.test(p.valueStatus ?? ""))) return null;
  let visited = 0, compared = false;
  const evaluate = (value: unknown): boolean | null => {
    if (++visited > 512) return null;
    const node = object(value);
    if (!node) return null;
    if (node.kind === "AND" && Array.isArray(node.children)) {
      const results = node.children.map(evaluate);
      return results.includes(false) ? false : results.includes(null) ? null : true;
    }
    if (node.kind !== "ATOM" || !Array.isArray(node.operands)) return null;
    const lhs = object(node.operands[0]), column = object(lhs?.column);
    if (lhs?.kind !== "COLUMN" || !column) return null;
    const physical = column.physical;
    if (!Array.isArray(physical) || physical.length !== 1 || !object(physical[0]) || name(physical[0].table) !== name(scope.table)) return null;
    const part = partition.get(name(physical[0].column));
    if (!part) return true; // Row filters do not constrain the partition identity.
    compared = true;
    const operandCountValid = node.operator === "IN" ? node.operands.length >= 2 :
      node.operator === "BETWEEN" ? node.operands.length === 3 : node.operands.length === 2;
    if (operandCountValid && ["EQ", "IN", "BETWEEN", "LT", "LTE", "GT", "GTE"].includes(node.operator) &&
      matchesDayPartitionUnit(part.column, part.values, node.operands.slice(1))) return true;
    const a = point(part.values[0]!);
    const values: (Point | null)[] = node.operands.slice(1).map((o: unknown) => object(o) ? operandPoint(object(o)!) : null);
    if (!values.length || values.some(p => p === null)) return null;
    const rhs = values as Point[];
    if (node.operator === "BETWEEN" && rhs.length === 2) {
      const low = comparison(a, "GTE", rhs[0]!), high = comparison(a, "LTE", rhs[1]!);
      return low === false || high === false ? false : low === true && high === true ? true : null;
    }
    if (node.operator === "IN") {
      const results = rhs.map((p: Point) => comparison(a, "EQ", p));
      return results.includes(true) ? true : results.includes(null) ? null : false;
    }
    return ["EQ", "LT", "LTE", "GT", "GTE"].includes(node.operator) && rhs.length === 1
      ? comparison(a, node.operator, rhs[0]!) : null;
  };
  const results = scope.trees.map(evaluate);
  return compared && results.every((x: boolean | null) => x === true) ? true : null;
}
