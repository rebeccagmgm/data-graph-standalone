export function normalizePartitionToken(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/gu, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

export function isDatePartitionField(field: string): boolean {
  return /^(busi_date|business_date|biz_date|trade_date|data_date|month_date|monthdate|dt)$/iu.test(
    normalizePartitionToken(field),
  );
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value.trim());
}

export function isDateRuntimeTemplate(value: string): boolean {
  return normalizePartitionToken(value) === "${yyyy-mm-dd}";
}

/**
 * Recognize the canonical year-start expression used with the runtime
 * business date.  This remains symbolic: it does not evaluate a runtime
 * date, it only proves that the expression is a date-valued boundary derived
 * from the same scheduler parameter.
 */
export function isYearStartDateRuntimeExpression(value: string): boolean {
  const normalized = value.trim().replace(/\s+/gu, "").toLowerCase();
  return /^concat\(substr\(['"]?\$\{yyyy-mm-dd\}['"]?,1,5\),['"]?01-01['"]?\)$/u.test(
    normalized,
  );
}

export function datePartitionValuesCompatible(
  left: string,
  right: string,
): boolean {
  const normalizedLeft = normalizePartitionToken(left);
  const normalizedRight = normalizePartitionToken(right);
  if (normalizedLeft === normalizedRight) return true;
  return (
    (isDateRuntimeTemplate(normalizedLeft) && isIsoDate(normalizedRight)) ||
    (isDateRuntimeTemplate(normalizedRight) && isIsoDate(normalizedLeft))
  );
}
