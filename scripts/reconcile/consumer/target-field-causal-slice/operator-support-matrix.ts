import {
  canonicalProofRefId,
  EFFECT_KINDS,
  LOCAL_EDGE_KINDS,
  OPERATOR_KINDS,
  SUBJECT_KINDS,
  type EffectKind,
  type LocalEdgeKind,
  type OperatorKind,
  type ProofRef,
  type SubjectKind,
  type SupportStatus,
} from "./semantic-dependency-contract.ts";

export type OperatorVariant =
  | "CASE"
  | "IF"
  | "COALESCE"
  | "COLUMN_EXPRESSION"
  | "WHERE"
  | "HAVING"
  | "QUALIFY"
  | "INNER"
  | "LEFT"
  | "RIGHT"
  | "FULL"
  | "SEMI"
  | "ANTI"
  | "CROSS"
  | "GROUP_BY"
  | "AGGREGATE_INPUT"
  | "COUNT_STAR"
  | "DISTINCT_KEY"
  | "UNION"
  | "UNION_ALL"
  | "INTERSECT"
  | "EXCEPT"
  | "WINDOW_VALUE"
  | "WINDOW_PARTITION_BY"
  | "WINDOW_ORDER_BY"
  | "WINDOW_FRAME"
  | "LIMIT"
  | "TOP"
  | "FETCH"
  | "SCALAR"
  | "EXISTS"
  | "IN"
  | "CORRELATED"
  | "CROSS_JOIN"
  | "LITERAL_FROM_RELATION";

export type OperatorRole =
  | "VALUE"
  | "BRANCH_SELECTOR"
  | "BRANCH_VALUE"
  | "PREDICATE"
  | "JOIN_CONDITION"
  | "LEFT_INPUT"
  | "RIGHT_INPUT"
  | "GROUP_KEY"
  | "AGGREGATE_ARGUMENT"
  | "RELATION"
  | "SET_MEMBER"
  | "WINDOW_INPUT"
  | "PARTITION_KEY"
  | "ORDER_KEY"
  | "FRAME_BOUND"
  | "RANK_LIMIT"
  | "CORRELATED_INPUT"
  | "CARDINALITY";

export interface OperatorSupportQuery {
  readonly operatorKind: OperatorKind;
  readonly operatorVariant: OperatorVariant;
  readonly operatorRole: OperatorRole;
  readonly subjectKind: SubjectKind;
  readonly effectKind: EffectKind;
  readonly localEdgeKind: LocalEdgeKind;
}

export interface OperatorSupportCell extends OperatorSupportQuery {
  readonly status: SupportStatus;
  readonly proofObligations: readonly string[];
  readonly reasonCode: string;
  readonly proofRefs: readonly ProofRef[];
}

export interface OperatorSupportGap {
  readonly status: "UNKNOWN" | "UNSUPPORTED";
  readonly reasonCode: "UNKNOWN_OPERATOR_OR_ROLE" | "UNMODELED_CELL";
  readonly message: string;
  readonly proofRefs: readonly ProofRef[];
}

export interface OperatorSupportResult {
  readonly query: OperatorSupportQuery;
  readonly matched: boolean;
  readonly cell: OperatorSupportCell;
  readonly gap: OperatorSupportGap | null;
}

function key(query: OperatorSupportQuery): string {
  return [
    query.operatorKind,
    query.operatorVariant,
    query.operatorRole,
    query.subjectKind,
    query.effectKind,
    query.localEdgeKind,
  ].join("|");
}

function cell(
  query: OperatorSupportQuery,
  proofObligations: readonly string[],
  status: SupportStatus = "SUPPORTED",
): OperatorSupportCell {
  return {
    ...query,
    status,
    proofObligations,
    reasonCode: status === "SUPPORTED" ? "SUPPORTED_RULE" : "CONDITIONAL_RULE",
    proofRefs: [
      {
        proofRefId: canonicalProofRefId("SUPPORT_MATRIX", key(query)),
        kind: "SUPPORT_MATRIX",
        refId: key(query),
      },
    ],
  };
}

function q(
  operatorKind: OperatorKind,
  operatorVariant: OperatorVariant,
  operatorRole: OperatorRole,
  subjectKind: SubjectKind,
  effectKind: EffectKind,
  localEdgeKind: LocalEdgeKind,
  proofObligations: readonly string[],
  status: SupportStatus = "SUPPORTED",
): OperatorSupportCell {
  return cell(
    {
      operatorKind,
      operatorVariant,
      operatorRole,
      subjectKind,
      effectKind,
      localEdgeKind,
    },
    proofObligations,
    status,
  );
}

const EXPRESSION_PROOF = ["EXPRESSION_ID", "SOURCE_SPAN"] as const;
const RELATION_PROOF = ["RELATION_OCCURRENCE", "SOURCE_SPAN"] as const;
const PREDICATE_PROOF = ["PREDICATE_TREE", "SOURCE_SPAN"] as const;
const JOIN_PROOF = ["JOIN_RELATIONS", "JOIN_CONDITION", "SOURCE_SPAN"] as const;

/**
 * Every entry is an exact semantic cell. There is intentionally no wildcard
 * row: a missing subject/effect/edge combination must remain fail-closed.
 */
export const OPERATOR_SUPPORT_MATRIX: readonly OperatorSupportCell[] = [
  q(
    "PROJECT",
    "CASE",
    "BRANCH_SELECTOR",
    "PHYSICAL_FIELD",
    "BRANCH_SELECTION",
    "EXPRESSION_CONTROL",
    EXPRESSION_PROOF,
  ),
  q(
    "PROJECT",
    "CASE",
    "BRANCH_VALUE",
    "PHYSICAL_FIELD",
    "VALUE_CONTRIBUTION",
    "VALUE_FLOW",
    EXPRESSION_PROOF,
  ),
  q(
    "PROJECT",
    "IF",
    "BRANCH_SELECTOR",
    "PHYSICAL_FIELD",
    "BRANCH_SELECTION",
    "EXPRESSION_CONTROL",
    EXPRESSION_PROOF,
  ),
  q(
    "PROJECT",
    "IF",
    "BRANCH_VALUE",
    "PHYSICAL_FIELD",
    "VALUE_CONTRIBUTION",
    "VALUE_FLOW",
    EXPRESSION_PROOF,
  ),
  q(
    "PROJECT",
    "COALESCE",
    "BRANCH_SELECTOR",
    "PHYSICAL_FIELD",
    "BRANCH_SELECTION",
    "EXPRESSION_CONTROL",
    EXPRESSION_PROOF,
  ),
  q(
    "PROJECT",
    "COALESCE",
    "BRANCH_VALUE",
    "PHYSICAL_FIELD",
    "VALUE_CONTRIBUTION",
    "VALUE_FLOW",
    EXPRESSION_PROOF,
  ),
  q(
    "PROJECT",
    "COLUMN_EXPRESSION",
    "VALUE",
    "PHYSICAL_FIELD",
    "VALUE_CONTRIBUTION",
    "VALUE_FLOW",
    EXPRESSION_PROOF,
  ),

  q(
    "FILTER",
    "WHERE",
    "PREDICATE",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    PREDICATE_PROOF,
  ),
  q(
    "FILTER",
    "HAVING",
    "PREDICATE",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    PREDICATE_PROOF,
  ),
  q(
    "FILTER",
    "QUALIFY",
    "PREDICATE",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    PREDICATE_PROOF,
  ),

  q(
    "JOIN",
    "INNER",
    "JOIN_CONDITION",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    JOIN_PROOF,
  ),
  q(
    "JOIN",
    "LEFT",
    "JOIN_CONDITION",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    JOIN_PROOF,
  ),
  q(
    "JOIN",
    "RIGHT",
    "JOIN_CONDITION",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    JOIN_PROOF,
  ),
  q(
    "JOIN",
    "FULL",
    "JOIN_CONDITION",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    JOIN_PROOF,
  ),
  q(
    "JOIN",
    "SEMI",
    "JOIN_CONDITION",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    JOIN_PROOF,
  ),
  q(
    "JOIN",
    "ANTI",
    "JOIN_CONDITION",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    JOIN_PROOF,
  ),
  q(
    "JOIN",
    "CROSS",
    "LEFT_INPUT",
    "RELATION_OCCURRENCE",
    "MULTIPLICITY",
    "RELATION_CONTEXT",
    RELATION_PROOF,
  ),
  q(
    "JOIN",
    "CROSS",
    "RIGHT_INPUT",
    "RELATION_OCCURRENCE",
    "MULTIPLICITY",
    "RELATION_CONTEXT",
    RELATION_PROOF,
  ),

  q(
    "AGGREGATE",
    "GROUP_BY",
    "GROUP_KEY",
    "PHYSICAL_FIELD",
    "GROUPING",
    "ROWSET_CONTROL",
    ["GROUPING_KEYS", "SOURCE_SPAN"],
  ),
  q(
    "AGGREGATE",
    "AGGREGATE_INPUT",
    "AGGREGATE_ARGUMENT",
    "PHYSICAL_FIELD",
    "VALUE_CONTRIBUTION",
    "VALUE_FLOW",
    ["AGGREGATE_EXPRESSION", "SOURCE_SPAN"],
  ),
  q(
    "AGGREGATE",
    "COUNT_STAR",
    "RELATION",
    "RELATION_OCCURRENCE",
    "RELATION_EXISTENCE",
    "RELATION_CONTEXT",
    RELATION_PROOF,
  ),
  q(
    "AGGREGATE",
    "COUNT_STAR",
    "RELATION",
    "RELATION_OCCURRENCE",
    "MULTIPLICITY",
    "RELATION_CONTEXT",
    RELATION_PROOF,
  ),

  q(
    "DISTINCT",
    "DISTINCT_KEY",
    "VALUE",
    "PHYSICAL_FIELD",
    "SET_MEMBERSHIP",
    "ROWSET_CONTROL",
    ["DISTINCT_KEYS", "SOURCE_SPAN"],
  ),
  q(
    "DISTINCT",
    "DISTINCT_KEY",
    "VALUE",
    "PHYSICAL_FIELD",
    "MULTIPLICITY",
    "ROWSET_CONTROL",
    ["DISTINCT_KEYS", "SOURCE_SPAN"],
  ),

  q(
    "SETOP",
    "UNION",
    "SET_MEMBER",
    "PHYSICAL_FIELD",
    "SET_MEMBERSHIP",
    "ROWSET_CONTROL",
    ["SET_OPERAND", "SOURCE_SPAN"],
  ),
  q(
    "SETOP",
    "UNION_ALL",
    "SET_MEMBER",
    "PHYSICAL_FIELD",
    "SET_MEMBERSHIP",
    "ROWSET_CONTROL",
    ["SET_OPERAND", "SOURCE_SPAN"],
  ),
  q(
    "SETOP",
    "UNION_ALL",
    "SET_MEMBER",
    "PHYSICAL_FIELD",
    "MULTIPLICITY",
    "ROWSET_CONTROL",
    ["SET_OPERAND", "SOURCE_SPAN"],
  ),
  q(
    "SETOP",
    "INTERSECT",
    "SET_MEMBER",
    "PHYSICAL_FIELD",
    "SET_MEMBERSHIP",
    "ROWSET_CONTROL",
    ["SET_OPERAND", "SOURCE_SPAN"],
  ),
  q(
    "SETOP",
    "EXCEPT",
    "SET_MEMBER",
    "PHYSICAL_FIELD",
    "SET_MEMBERSHIP",
    "ROWSET_CONTROL",
    ["SET_OPERAND", "SOURCE_SPAN"],
  ),

  q(
    "WINDOW",
    "WINDOW_VALUE",
    "WINDOW_INPUT",
    "PHYSICAL_FIELD",
    "VALUE_CONTRIBUTION",
    "VALUE_FLOW",
    ["WINDOW_EXPRESSION", "SOURCE_SPAN"],
  ),
  q(
    "WINDOW",
    "WINDOW_PARTITION_BY",
    "PARTITION_KEY",
    "PHYSICAL_FIELD",
    "GROUPING",
    "WINDOW_CONTEXT",
    ["WINDOW_SPEC", "SOURCE_SPAN"],
  ),
  q(
    "WINDOW",
    "WINDOW_ORDER_BY",
    "ORDER_KEY",
    "PHYSICAL_FIELD",
    "ORDERING",
    "WINDOW_CONTEXT",
    ["WINDOW_SPEC", "SOURCE_SPAN"],
  ),
  q(
    "WINDOW",
    "WINDOW_FRAME",
    "FRAME_BOUND",
    "PHYSICAL_FIELD",
    "WINDOW_CONTEXT",
    "WINDOW_CONTEXT",
    ["WINDOW_SPEC", "FRAME_SPEC", "SOURCE_SPAN"],
  ),

  q(
    "TOP_N",
    "LIMIT",
    "RANK_LIMIT",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    ["ORDERING", "LIMIT_VALUE", "SOURCE_SPAN"],
  ),
  q(
    "TOP_N",
    "TOP",
    "RANK_LIMIT",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    ["ORDERING", "LIMIT_VALUE", "SOURCE_SPAN"],
  ),
  q(
    "TOP_N",
    "FETCH",
    "RANK_LIMIT",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    ["ORDERING", "LIMIT_VALUE", "SOURCE_SPAN"],
  ),
  q(
    "TOP_N",
    "LIMIT",
    "ORDER_KEY",
    "PHYSICAL_FIELD",
    "ORDERING",
    "ROWSET_CONTROL",
    ["ORDERING", "LIMIT_VALUE", "SOURCE_SPAN"],
  ),
  q(
    "TOP_N",
    "TOP",
    "ORDER_KEY",
    "PHYSICAL_FIELD",
    "ORDERING",
    "ROWSET_CONTROL",
    ["ORDERING", "LIMIT_VALUE", "SOURCE_SPAN"],
  ),
  q(
    "TOP_N",
    "FETCH",
    "ORDER_KEY",
    "PHYSICAL_FIELD",
    "ORDERING",
    "ROWSET_CONTROL",
    ["ORDERING", "LIMIT_VALUE", "SOURCE_SPAN"],
  ),

  q(
    "SUBQUERY",
    "SCALAR",
    "VALUE",
    "PHYSICAL_FIELD",
    "VALUE_CONTRIBUTION",
    "VALUE_FLOW",
    ["SUBQUERY_SCOPE", "SOURCE_SPAN"],
  ),
  q(
    "SUBQUERY",
    "EXISTS",
    "RELATION",
    "RELATION_OCCURRENCE",
    "RELATION_EXISTENCE",
    "RELATION_CONTEXT",
    RELATION_PROOF,
  ),
  q(
    "SUBQUERY",
    "IN",
    "RELATION",
    "RELATION_OCCURRENCE",
    "SET_MEMBERSHIP",
    "RELATION_CONTEXT",
    ["SUBQUERY_SCOPE", "SOURCE_SPAN"],
  ),
  q(
    "SUBQUERY",
    "CORRELATED",
    "CORRELATED_INPUT",
    "PHYSICAL_FIELD",
    "ROW_MEMBERSHIP",
    "ROWSET_CONTROL",
    ["CORRELATION_SCOPE", "SOURCE_SPAN"],
  ),

  q(
    "RELATION",
    "CROSS_JOIN",
    "CARDINALITY",
    "RELATION_OCCURRENCE",
    "MULTIPLICITY",
    "RELATION_CONTEXT",
    RELATION_PROOF,
  ),
  q(
    "RELATION",
    "LITERAL_FROM_RELATION",
    "RELATION",
    "RELATION_OCCURRENCE",
    "RELATION_EXISTENCE",
    "RELATION_CONTEXT",
    RELATION_PROOF,
  ),
];

const MATRIX_BY_KEY = new Map(
  OPERATOR_SUPPORT_MATRIX.map((entry) => [key(entry), entry]),
);

const KNOWN_OPERATOR_VARIANTS = new Set<string>(
  OPERATOR_SUPPORT_MATRIX.map((entry) => entry.operatorVariant),
);
const KNOWN_OPERATOR_ROLES = new Set<string>(
  OPERATOR_SUPPORT_MATRIX.map((entry) => entry.operatorRole),
);

function gapFor(
  query: OperatorSupportQuery,
  status: "UNKNOWN" | "UNSUPPORTED",
  reasonCode: "UNKNOWN_OPERATOR_OR_ROLE" | "UNMODELED_CELL",
  message: string,
): OperatorSupportGap {
  const refId = ["operator-support-gap", key(query)].join(":");
  return {
    status,
    reasonCode,
    message,
    proofRefs: [
      {
        proofRefId: canonicalProofRefId("GAP", refId),
        kind: "GAP",
        refId,
      },
    ],
  };
}

export function lookupOperatorSupport(
  query: OperatorSupportQuery,
): OperatorSupportResult {
  const matched = MATRIX_BY_KEY.get(key(query));
  if (matched) return { query, matched: true, cell: matched, gap: null };

  const knownDimensions =
    OPERATOR_KINDS.includes(query.operatorKind) &&
    SUBJECT_KINDS.includes(query.subjectKind) &&
    EFFECT_KINDS.includes(query.effectKind) &&
    LOCAL_EDGE_KINDS.includes(query.localEdgeKind) &&
    KNOWN_OPERATOR_VARIANTS.has(query.operatorVariant) &&
    KNOWN_OPERATOR_ROLES.has(query.operatorRole);
  const status = knownDimensions ? "UNSUPPORTED" : "UNKNOWN";
  const reasonCode = knownDimensions
    ? "UNMODELED_CELL"
    : "UNKNOWN_OPERATOR_OR_ROLE";
  const gap = gapFor(
    query,
    status,
    reasonCode,
    knownDimensions
      ? "The exact operator semantic cell is not modeled."
      : "The operator or semantic role is not recognized by the matrix.",
  );
  return {
    query,
    matched: false,
    cell: {
      ...query,
      status,
      proofObligations: [],
      reasonCode,
      proofRefs: gap.proofRefs,
    },
    gap,
  };
}

export function operatorSupportMatrixKey(query: OperatorSupportQuery): string {
  return key(query);
}

export function validateOperatorSupportMatrix(): readonly string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of OPERATOR_SUPPORT_MATRIX) {
    const entryKey = key(entry);
    if (seen.has(entryKey)) errors.push(`duplicate matrix cell: ${entryKey}`);
    seen.add(entryKey);
    if (entry.status === "UNKNOWN" || entry.status === "UNSUPPORTED") {
      errors.push(
        `matrix cell must not predeclare fail-closed status: ${entryKey}`,
      );
    }
    if (entry.proofRefs.length === 0)
      errors.push(`matrix cell is missing proof ref: ${entryKey}`);
  }
  return errors;
}
