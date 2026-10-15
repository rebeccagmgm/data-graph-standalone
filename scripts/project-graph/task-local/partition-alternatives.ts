import { canonicalPartitionValue } from "./partition-canonical.ts";

export interface PartitionAlternative {
  readonly key: string;
  readonly value: string;
  readonly valueStatus?: string;
  readonly expression?: string;
}

/** Expand correlated tuples, never the Cartesian product of column values. */
export function expandPartitionAlternatives<T extends {
  readonly column: string;
  readonly values: readonly string[];
  readonly valueStatus?: string;
  readonly alternatives?: readonly PartitionAlternative[];
}>(parts: readonly T[]): T[][] | null {
  const grouped = parts.filter(part => part.alternatives !== undefined);
  if (!grouped.length) return [[...parts]];
  if (grouped.some(part => !Array.isArray(part.alternatives) || part.alternatives.some(a =>
    !a || typeof a.key !== "string" || !a.key || typeof a.value !== "string"))) return null;
  const keys = grouped[0]!.alternatives!.map(a => a.key);
  if (!keys.length || new Set(keys).size !== keys.length) return null;
  if (grouped.some(part => {
    const alternatives = part.alternatives!;
    return alternatives.length !== keys.length || new Set(alternatives.map(a => a.key)).size !== keys.length ||
      alternatives.some(a => !keys.includes(a.key) || typeof a.value !== "string");
  })) return null;
  return keys.map(key => parts.map(part => {
    if (!part.alternatives) return part;
    const alternative = part.alternatives.find(a => a.key === key)!;
    const { alternatives: _alternatives, ...base } = part;
    return { ...base, values: [canonicalPartitionValue(part.column, alternative.value)],
      observedValue: alternative.value, expression: alternative.expression,
      valueStatus: alternative.valueStatus ?? part.valueStatus } as unknown as T;
  }));
}
