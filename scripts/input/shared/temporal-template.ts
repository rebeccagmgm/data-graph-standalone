export type TemporalTemplateGranularity =
  | "DAY"
  | "MONTH"
  | "QUARTER"
  | "YEAR";

function templateInner(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\$\{([^{}\r\n]+)\}$/u);
  return (match?.[1] ?? trimmed).trim();
}

/**
 * Classify scheduler time tokens without treating structural placeholders
 * (for example `${DB_TEMP}`) as temporal values.
 */
export function temporalTemplateGranularity(
  value: string,
): TemporalTemplateGranularity | undefined {
  const inner = templateInner(value);
  const normalized = inner.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (
    /^(?:dataday|datatoday|datadate|busidate|rundate|etldate|filename|datatime|dataupt|sysdate)/u.test(normalized) ||
    normalized === "startday" ||
    normalized === "endday" ||
    /^\d{8}$/u.test(normalized) ||
    /^\d{4}-\d{2}-\d{2}$/u.test(inner) ||
    (normalized.startsWith("yyyy") && normalized.includes("mm") && normalized.includes("dd"))
  ) return "DAY";
  if (normalized === "q" || normalized === "qq") return "QUARTER";
  if (
    /^\d{6}$/u.test(normalized) ||
    /^\d{4}-\d{2}$/u.test(inner) ||
    (normalized.startsWith("yyyy") && normalized.includes("mm"))
  ) return "MONTH";
  if (/^\d{4}$/u.test(normalized) || normalized === "yyyy") return "YEAR";
  return undefined;
}

export function isTemporalSqlTemplateVariable(value: string): boolean {
  return temporalTemplateGranularity(value) !== undefined;
}

/** Canonical value used by temporal partition equality checks. */
export function canonicalTemporalTemplate(value: string): string | undefined {
  const inner = templateInner(value);
  const granularity = temporalTemplateGranularity(inner);
  if (granularity === "DAY") return "${YYYY-MM-DD}";
  if (granularity === "QUARTER") return "${QQ}";
  if (granularity === "YEAR") return "${YYYY}";
  if (granularity === "MONTH") {
    const offset = inner.match(/,\s*([-+]?\d+[mMdDyY])\s*$/u)?.[1];
    return `\${YYYYMM${offset ? `,${offset}` : ""}}`;
  }
  return undefined;
}
