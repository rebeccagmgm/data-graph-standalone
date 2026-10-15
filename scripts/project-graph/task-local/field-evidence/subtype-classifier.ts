import type {
  TaskLocalDirectSubtype,
  TaskLocalSubtypeReason,
} from "../contract.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

const AGGREGATE_PATTERN = /\b(sum|count|avg|min|max|stddev|variance|collect_list|collect_set)\s*\(/i;
const WINDOW_ONLY_ROLES = new Set(["PARTITION_BY", "ORDER_BY", "WINDOW_FRAME"]);

function expressionRoles(expression: JsonRecord): readonly JsonRecord[] {
  if (!Array.isArray(expression.expression_roles)) return [];
  return expression.expression_roles.filter(
    (role): role is JsonRecord => record(role) !== null,
  );
}

function hasWindowOnlyRoles(expression: JsonRecord): boolean {
  const roles = expressionRoles(expression);
  if (roles.length === 0) return false;
  return roles.every((role) => {
    const effects = Array.isArray(role.effects) ? role.effects.map(String) : [];
    return effects.length > 0
      && effects.every((effect) => WINDOW_ONLY_ROLES.has(effect) || effect === "BRANCH_SELECTION");
  });
}

function isBareColumnReference(expressionText: string): boolean {
  const trimmed = expressionText.trim();
  const withoutAlias = trimmed.replace(/\s+as\s+\S+$/i, "").trim();
  return /^[`"]?[\w.]+[`"]?$/.test(withoutAlias);
}

export interface ExpressionSubtypeResult {
  readonly subtype: TaskLocalDirectSubtype;
  readonly subtypeReason: TaskLocalSubtypeReason | null;
  readonly pathHadAggregation: boolean;
}

export function classifyExpressionSubtype(
  expression: JsonRecord,
  relationType: string | null,
): ExpressionSubtypeResult {
  const dependencyStatus = text(expression.input_dependency_status);
  if (dependencyStatus && dependencyStatus !== "PHYSICAL") {
    return {
      subtype: "UNKNOWN",
      subtypeReason: "INPUT_DEPENDENCY_NOT_PHYSICAL",
      pathHadAggregation: false,
    };
  }
  if (hasWindowOnlyRoles(expression)) {
    return {
      subtype: "UNKNOWN",
      subtypeReason: "WINDOW_CONTEXT_ONLY",
      pathHadAggregation: false,
    };
  }
  const expressionText = text(expression.expression_text) ?? text(expression.display_text) ?? "";
  if (!expressionText) {
    return {
      subtype: "UNKNOWN",
      subtypeReason: "EXPRESSION_TEXT_UNPARSEABLE",
      pathHadAggregation: false,
    };
  }
  const normalizedRelation = (relationType ?? "").toLowerCase();
  const hasAggregateFn = AGGREGATE_PATTERN.test(expressionText);
  const aggregateContext = normalizedRelation === "aggregate";
  if (hasAggregateFn || aggregateContext) {
    return {
      subtype: "AGGREGATION",
      subtypeReason: null,
      pathHadAggregation: true,
    };
  }
  const inputFields = Array.isArray(expression.input_fields) ? expression.input_fields : [];
  if (inputFields.length === 0) {
    return {
      subtype: "UNKNOWN",
      subtypeReason: "EXPRESSION_TEXT_UNPARSEABLE",
      pathHadAggregation: false,
    };
  }
  if (isBareColumnReference(expressionText)) {
    return {
      subtype: "IDENTITY",
      subtypeReason: null,
      pathHadAggregation: false,
    };
  }
  if (/\b(case\b|\bwhen\b|\bif\s*\()/i.test(expressionText) && expressionRoles(expression).length > 0) {
    return {
      subtype: "TRANSFORMATION",
      subtypeReason: null,
      pathHadAggregation: false,
    };
  }
  return {
    subtype: "TRANSFORMATION",
    subtypeReason: null,
    pathHadAggregation: false,
  };
}

export function composePathSubtype(
  hops: readonly ExpressionSubtypeResult[],
): ExpressionSubtypeResult {
  if (hops.length === 0) {
    return {
      subtype: "UNKNOWN",
      subtypeReason: "EXPRESSION_TEXT_UNPARSEABLE",
      pathHadAggregation: false,
    };
  }
  if (hops.some((hop) => hop.subtype === "UNKNOWN")) {
    const unknown = hops.find((hop) => hop.subtype === "UNKNOWN")!;
    return {
      subtype: "UNKNOWN",
      subtypeReason: unknown.subtypeReason,
      pathHadAggregation: hops.some((hop) => hop.pathHadAggregation),
    };
  }
  if (hops.some((hop) => hop.pathHadAggregation || hop.subtype === "AGGREGATION")) {
    return {
      subtype: "AGGREGATION",
      subtypeReason: null,
      pathHadAggregation: true,
    };
  }
  if (hops.some((hop) => hop.subtype === "TRANSFORMATION")) {
    return {
      subtype: "TRANSFORMATION",
      subtypeReason: null,
      pathHadAggregation: false,
    };
  }
  return {
    subtype: "IDENTITY",
    subtypeReason: null,
    pathHadAggregation: false,
  };
}
