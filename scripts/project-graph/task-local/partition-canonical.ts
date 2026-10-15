import { canonicalTemporalTemplate } from "../../input/shared/temporal-template.ts";

/**
 * Canonical partition values for cross-task continuation matching.
 * Aligns Input Pack temporal templates with read predicates and write partitions.
 */

export function isTemporalPartitionColumn(column: string): boolean {
  const normalized = column.trim().toLowerCase();
  return (
    normalized === "busi_date" ||
    normalized === "data_date" ||
    normalized === "busi_mon" ||
    normalized === "busi_year" ||
    normalized === "quarter" ||
    normalized === "qtr" ||
    normalized.endsWith("_date") ||
    normalized.endsWith("_mon") ||
    normalized.endsWith("_month") ||
    normalized.endsWith("_year") ||
    normalized.endsWith("_quarter") ||
    normalized.endsWith("_qtr")
  );
}

export function isRuntimeTemplateExpression(value: string): boolean {
  return /\$\{|\{\{|\{%|<%/u.test(value);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function temporalTemplateFromInner(inner: string): string | undefined {
  return canonicalTemporalTemplate(inner);
}

/** Canonicalize one partition value for equality checks. */
export function canonicalPartitionValue(
  column: string,
  raw: string,
): string {
  const value = stripQuotes(raw);
  if (!value) return value;
  if (isTemporalPartitionColumn(column)) {
    // Process lineage, not a run-instance/date-equality assertion. This legacy
    // scheduler spelling denotes the same DAY process as ${yyyy-MM-dd}; keep
    // the allowlist exact so {table}, unknown variables and h15/h10 stay distinct.
    if (/^\{busi_date\}$/i.test(value)) return "${YYYY-MM-DD}";
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "${YYYY-MM-DD}";
    if (/^\d{4}-\d{2}$|^\d{6}$/u.test(value)) return "${YYYYMM}";
    if (/^\d{4}$/u.test(value)) return "${YYYY}";
  }
  const template = value.match(/^\$\{([^}]+)\}$/u);
  if (template) {
    if (isTemporalPartitionColumn(column)) {
      const temporal = temporalTemplateFromInner(template[1]!);
      if (temporal) return temporal;
    }
    return `\${${template[1]!.trim()}}`;
  }
  if (/\$\{[^}]+\}/u.test(value) && isTemporalPartitionColumn(column)) {
    const token = value.match(/\$\{([^}]+)\}/u);
    if (token) {
      const temporal = temporalTemplateFromInner(token[1]!);
      if (temporal) return temporal;
    }
  }
  return value;
}

export function canonicalPartitionValues(
  column: string,
  values: readonly string[],
): readonly string[] {
  return [...new Set(values.map((value) => canonicalPartitionValue(column, value)))];
}

export function partitionCanonicalValuesOverlap(
  column: string,
  leftValues: readonly string[],
  rightValues: readonly string[],
): boolean {
  const left = new Set(
    canonicalPartitionValues(column, leftValues).map((value) => value.toLowerCase()),
  );
  return canonicalPartitionValues(column, rightValues).some((value) =>
    left.has(value.toLowerCase()),
  );
}

export function writePartitionRawValues(part: {
  readonly values: readonly string[];
  readonly expression?: string;
  readonly observedValue?: string | null;
}): readonly string[] {
  const raw = [
    ...part.values,
    ...(part.expression ? [part.expression] : []),
    ...(part.observedValue ? [part.observedValue] : []),
  ].filter((value) => value.trim().length > 0);
  return raw.length > 0 ? raw : part.values;
}
