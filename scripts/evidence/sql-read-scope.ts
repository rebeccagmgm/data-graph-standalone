import type {
  ColumnRef,
  PredicateOperand,
  PredicateTree,
} from "../plans/plan-contract.ts";
import { isYearStartDateRuntimeExpression } from "./partition-value-normalizer.ts";

export type ReadPartitionScopeStatus =
  "UNPARTITIONED" | "ALL_PARTITIONS" | "CONSTRAINED" | "PARTIAL" | "UNKNOWN";

export type ReadPartitionOperator =
  "EQ" | "LT" | "LTE" | "GT" | "GTE" | "IN" | "BETWEEN";

export interface ReadPartitionValue {
  readonly kind: "LITERAL" | "RUNTIME_EXPRESSION" | "UNKNOWN";
  readonly expression: string;
  readonly observedValue: string | null;
}

export interface PartitionConstraintAtom {
  readonly kind: "ATOM";
  readonly field: string;
  readonly operator: ReadPartitionOperator;
  readonly values: readonly ReadPartitionValue[];
}

export type PartitionConstraintTree =
  | PartitionConstraintAtom
  | {
      readonly kind: "AND" | "OR";
      readonly children: readonly PartitionConstraintTree[];
    };

export interface ReadPartitionScope {
  readonly status: ReadPartitionScopeStatus;
  readonly partitionFields: readonly string[];
  readonly predicate: PartitionConstraintTree | null;
  readonly reasonCodes: readonly string[];
  readonly evidence: readonly ReadPartitionScopeEvidence[];
}

export interface ReadPartitionScopeEvidence {
  readonly source: "SQL_PARSE" | "TABLE_PACK";
  readonly provider: string;
  readonly locator: string;
  readonly observedAt: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

interface Evaluation {
  readonly status: "IRRELEVANT" | "SUPPORTED" | "PARTIAL" | "UNKNOWN";
  readonly predicate: PartitionConstraintTree | null;
  readonly reasonCodes: readonly string[];
}

function normalize(value: string): string {
  return value.trim().replaceAll("`", "").replaceAll('"', "").toLowerCase();
}

/**
 * Plan facts may retain the SQL-visible bare table name even after the caller
 * has resolved the READ occurrence to a physical qualified name from the
 * Input Pack.  Once that physical identity is already resolved, the final
 * identifier component is a safe equivalence check; it does not infer a
 * schema or choose among catalog candidates.
 */
function tableReferenceMatches(
  physicalTable: string,
  qualifiedTable: string,
): boolean {
  const physical = normalize(physicalTable);
  const qualified = normalize(qualifiedTable);
  if (physical === qualified) return true;
  if (physical.includes(".")) return false;
  const qualifiedParts = qualified.split(".");
  return qualifiedParts.length > 1 && qualifiedParts.at(-1) === physical;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function fieldsOf(tree: PartitionConstraintTree): readonly string[] {
  if (tree.kind === "ATOM") return [tree.field];
  return uniqueSorted(tree.children.flatMap(fieldsOf));
}

function physicalColumns(operand: PredicateOperand): readonly ColumnRef[] {
  if (operand.kind === "COLUMN") return [operand.column];
  // An expression such as date(busi_date) is not a direct partition-column
  // constraint. Treating its input column as the partition field would make
  // the downstream overlap comparison unsound.
  if (operand.kind === "OTHER") return [];
  return [];
}

function valueOf(operand: PredicateOperand): ReadPartitionValue | null {
  if (operand.kind === "LITERAL") {
    const expression = operand.expression.trim();
    const observedValue = operand.observedValue?.trim() ?? null;
    const templateValue =
      observedValue ?? expression.replace(/^['"]|['"]$/gu, "");
    if (/^\$\{[^}]+\}$/u.test(templateValue.trim()))
      return {
        kind: "RUNTIME_EXPRESSION",
        expression: templateValue.trim(),
        observedValue: null,
      };
    return {
      kind: observedValue === null ? "UNKNOWN" : "LITERAL",
      expression,
      observedValue,
    };
  }
  if (operand.kind === "RUNTIME_EXPRESSION")
    return {
      kind: "RUNTIME_EXPRESSION",
      expression: operand.expression,
      observedValue: null,
    };
  if (
    operand.kind === "OTHER" &&
    operand.inputColumns.length === 0 &&
    isYearStartDateRuntimeExpression(operand.expression)
  )
    return {
      kind: "RUNTIME_EXPRESSION",
      expression: operand.expression,
      observedValue: null,
    };
  return null;
}

function columnFor(
  operand: PredicateOperand,
  tableName: string,
  fields: ReadonlySet<string>,
): string | null | undefined {
  const columns = physicalColumns(operand);
  if (columns.length !== 1) return undefined;
  const refs = columns[0]!.physical ?? [];
  const candidates = refs
    .filter((ref) => tableReferenceMatches(ref.table, tableName))
    .map((ref) => normalize(ref.column));
  if (candidates.length !== 1) return undefined;
  const field = candidates[0]!;
  return fields.has(field) ? field : null;
}

function atomEvaluation(
  tree: Extract<PredicateTree, { kind: "ATOM" }>,
  tableName: string,
  fields: ReadonlySet<string>,
): Evaluation {
  const first = tree.operands[0];
  if (!first)
    return {
      status: "UNKNOWN",
      predicate: null,
      reasonCodes: ["PARTITION_PREDICATE_OPERAND_MISSING"],
    };

  const field = columnFor(first, tableName, fields);
  if (field === null)
    return { status: "IRRELEVANT", predicate: null, reasonCodes: [] };
  if (field === undefined)
    return {
      status: "UNKNOWN",
      predicate: null,
      reasonCodes: ["PARTITION_COLUMN_PHYSICAL_ORIGIN_UNRESOLVED"],
    };

  const values = tree.operands.slice(1).map(valueOf);
  if (values.some((value) => value === null))
    return {
      status: "UNKNOWN",
      predicate: null,
      reasonCodes: ["PARTITION_PREDICATE_VALUE_UNSUPPORTED"],
    };
  const normalizedValues = values as ReadPartitionValue[];
  const partitionOperator: ReadPartitionOperator | null =
    ["EQ", "LT", "LTE", "GT", "GTE", "IN", "BETWEEN"].includes(tree.operator)
      ? tree.operator as ReadPartitionOperator
      : null;
  if (
    partitionOperator === null ||
    (partitionOperator === "BETWEEN" && normalizedValues.length !== 2) ||
    (partitionOperator === "IN" && normalizedValues.length === 0) ||
    (partitionOperator !== "IN" &&
      partitionOperator !== "BETWEEN" &&
      normalizedValues.length !== 1)
  )
    return {
      status: "UNKNOWN",
      predicate: null,
      reasonCodes: ["PARTITION_PREDICATE_FORM_UNSUPPORTED"],
    };

  return {
    status: "SUPPORTED",
    predicate: {
      kind: "ATOM",
      field,
      operator: partitionOperator,
      values: normalizedValues,
    },
    reasonCodes: [],
  };
}

function combine(
  kind: "AND" | "OR",
  children: readonly Evaluation[],
): Evaluation {
  const relevant = children.filter((child) => child.status !== "IRRELEVANT");
  if (relevant.length === 0)
    return { status: "IRRELEVANT", predicate: null, reasonCodes: [] };
  const reasonCodes = uniqueSorted(
    relevant.flatMap((child) => child.reasonCodes),
  );
  if (kind === "OR" && relevant.length !== children.length)
    return {
      status: "PARTIAL",
      predicate: null,
      reasonCodes: [...reasonCodes, "PARTITION_OR_BRANCH_NOT_CONSTRAINED"],
    };
  const predicateChildren = relevant
    .map((child) => child.predicate)
    .filter((child): child is PartitionConstraintTree => child !== null);
  if (predicateChildren.length === 0)
    return {
      status: relevant.some((child) => child.status === "UNKNOWN")
        ? "UNKNOWN"
        : "PARTIAL",
      predicate: null,
      reasonCodes: [
        ...reasonCodes,
        ...(relevant.some((child) => child.status === "UNKNOWN")
          ? ["PARTITION_PREDICATE_UNKNOWN"]
          : ["PARTITION_PREDICATE_PARTIAL"]),
      ],
    };
  if (
    kind === "OR" &&
    uniqueSorted(predicateChildren.flatMap(fieldsOf)).length !== 1
  )
    return {
      status: "PARTIAL",
      predicate: null,
      reasonCodes: [...reasonCodes, "PARTITION_OR_FIELDS_MIXED"],
    };
  return {
    status: relevant.some((child) => child.status === "PARTIAL")
      ? "PARTIAL"
      : "SUPPORTED",
    predicate:
      predicateChildren.length === 1
        ? predicateChildren[0]!
        : { kind, children: predicateChildren },
    reasonCodes,
  };
}

function evaluate(
  tree: PredicateTree | null,
  tableName: string,
  fields: ReadonlySet<string>,
): Evaluation {
  if (!tree) return { status: "IRRELEVANT", predicate: null, reasonCodes: [] };
  if (tree.kind === "ATOM") return atomEvaluation(tree, tableName, fields);
  if (tree.kind === "NOT") {
    const child = evaluate(tree.child, tableName, fields);
    return child.status === "IRRELEVANT"
      ? child
      : {
          status: "UNKNOWN",
          predicate: null,
          reasonCodes: ["PARTITION_NOT_OPERATOR_UNSUPPORTED"],
        };
  }
  return combine(
    tree.kind,
    tree.children.map((child) => evaluate(child, tableName, fields)),
  );
}

export function resolveReadPartitionScope(options: {
  readonly predicate: PredicateTree | null;
  readonly tableQualifiedName: string;
  /** null means the table's partition metadata is unavailable. [] means known unpartitioned. */
  readonly partitionFields: readonly string[] | null;
  readonly partitionReasonCodes?: readonly string[];
  readonly evidence?: readonly ReadPartitionScopeEvidence[];
}): ReadPartitionScope {
  const evidence = options.evidence ?? [];
  const metadataReasons = options.partitionReasonCodes ?? [];
  if (options.partitionFields === null)
    return {
      status: "UNKNOWN",
      partitionFields: [],
      predicate: null,
      reasonCodes: uniqueSorted([
        ...metadataReasons,
        "PARTITION_FIELDS_UNAVAILABLE",
      ]),
      evidence,
    };
  const partitionFields = uniqueSorted(options.partitionFields.map(normalize));
  if (partitionFields.length === 0)
    return {
      status: "UNPARTITIONED",
      partitionFields,
      predicate: null,
      reasonCodes: [],
      evidence,
    };
  const evaluation = evaluate(
    options.predicate,
    normalize(options.tableQualifiedName),
    new Set(partitionFields),
  );
  if (evaluation.status === "IRRELEVANT")
    return {
      status: "ALL_PARTITIONS",
      partitionFields,
      predicate: null,
      reasonCodes: ["PARTITION_PREDICATE_ABSENT"],
      evidence,
    };
  if (
    evaluation.status === "SUPPORTED" &&
    evaluation.predicate !== null &&
    partitionFields.some(
      (field) => !fieldsOf(evaluation.predicate!).includes(field),
    )
  )
    return {
      status: "PARTIAL",
      partitionFields,
      predicate: evaluation.predicate,
      reasonCodes: ["PARTITION_FIELDS_PARTIAL"],
      evidence,
    };
  return {
    status:
      evaluation.status === "SUPPORTED" ? "CONSTRAINED" : evaluation.status,
    partitionFields,
    predicate: evaluation.predicate,
    reasonCodes: evaluation.reasonCodes,
    evidence,
  };
}
