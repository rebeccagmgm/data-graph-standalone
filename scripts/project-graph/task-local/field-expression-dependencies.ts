import type {
  PhysicalTableCatalog,
  PhysicalTableCatalogEntry,
} from "../../machine-facts/input-pack-machine-facts.ts";
import {
  normalizeName,
  type InputDependencyStatus,
} from "../../machine-facts/machine-facts-contract.ts";
import type {
  CurrentBundleLoad,
  JsonRecord,
} from "../../query/current-task-bundle.ts";
import type { FieldConditionalAnnotation } from "../../reconcile/shared/field-control-contract.ts";
import {
  physicalFieldKey,
  type PhysicalFieldIdentity,
} from "../../reconcile/shared/physical-field.ts";
import { resolvePhysicalInputField } from "../../reconcile/shared/physical-field-resolver.ts";
import type { TaskDefaultSchema } from "../../reconcile/shared/task-default-schema.ts";
import { classifyExpressionInputRoles, type ExpressionInputRoles } from "./expression-input-roles.ts";
export { classifyExpressionInputRoles, type ExpressionInputRoles } from "./expression-input-roles.ts";

type FieldExpressionDependencyIndexes = {
  readonly expressions: ReadonlyMap<string, JsonRecord>;
  readonly relations: ReadonlyMap<string, JsonRecord>;
  readonly rolesByExpressionId: ReadonlyMap<string, ExpressionInputRoles>;
};

export type FieldDependencySourceResult = {
  fields: PhysicalFieldIdentity[];
  unresolved: {
    table: string;
    column: string;
    reason: string;
  }[];
  readonly roles: ExpressionInputRoles;
  readonly inputFieldsByFieldKey: ReadonlyMap<string, readonly JsonRecord[]>;
};

export type FieldConditionalNode = {
  readonly nodeId: string;
  readonly taskId: string;
  readonly field: Pick<PhysicalFieldIdentity, "column">;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? null : trimmed;
}

const INPUT_DEPENDENCY_STATUSES = new Set<InputDependencyStatus>([
  "PHYSICAL",
  "DERIVED_OUTPUT",
  "SQL_CANDIDATE",
  "PARTIAL",
  "UNRESOLVED",
  "NO_PHYSICAL_INPUT",
]);

export function valueContributionInputFields(
  value: unknown,
  outputName: string,
): JsonRecord[] | null {
  const normalizedOutput = normalizeName(outputName);
  if (!normalizedOutput) return null;
  const matches: JsonRecord[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = asRecord(candidate);
    if (!record) return;
    const candidateOutput = normalizeName(
      String(record.output ?? record.output_name ?? ""),
    );
    if (
      candidateOutput === normalizedOutput &&
      Array.isArray(record.expression_roles) &&
      record.expression_roles.length > 0
    )
      matches.push(record);
    for (const key of ["expressions", "measures"]) visit(record[key]);
  };
  visit(value);
  if (matches.length === 0) return null;

  const fields = new Map<string, JsonRecord>();
  for (const match of matches) for (const field of classifyExpressionInputRoles(match).valueInputs) {
    fields.set(`${field.table}.${field.column}`, field);
  }
  return [...fields.values()].sort((left, right) =>
    compareText(
      `${left.table}.${left.column}`,
      `${right.table}.${right.column}`,
    ),
  );
}

const dependencyIndexesCache = new WeakMap<
  object,
  FieldExpressionDependencyIndexes
>();

function dependencyIndexesFor(
  load: CurrentBundleLoad,
): FieldExpressionDependencyIndexes {
  const cached = dependencyIndexesCache.get(load);
  if (cached) return cached;
  const expressions = new Map<string, JsonRecord>();
  for (const expression of load.records["field-expression-nodes.jsonl"] ?? []) {
    const expressionId = String(expression.expression_id ?? "");
    if (expressionId && !expressions.has(expressionId))
      expressions.set(expressionId, expression);
  }
  const relations = new Map<string, JsonRecord>();
  for (const relation of load.records["relation-nodes.jsonl"] ?? []) {
    const relationId = String(relation.relation_id ?? "");
    if (relationId && !relations.has(relationId))
      relations.set(relationId, relation);
  }
  const rolesByExpressionId = new Map<string, ExpressionInputRoles>();
  for (const [expressionId, expression] of expressions) {
    const relation = relations.get(String(expression.relation_id ?? ""));
    rolesByExpressionId.set(expressionId, classifyExpressionInputRoles(expression, relation?.relation));
  }
  const indexes = {
    expressions,
    relations,
    rolesByExpressionId,
  };
  dependencyIndexesCache.set(load, indexes);
  return indexes;
}

export function fieldExpressionFor(
  load: CurrentBundleLoad,
  binding: JsonRecord,
): JsonRecord | null {
  return (
    dependencyIndexesFor(load).expressions.get(
      String(binding.expression_id ?? ""),
    ) ?? null
  );
}

export function expressionInputDependencyStatus(
  expression: JsonRecord,
): InputDependencyStatus | undefined {
  const status = String(expression.input_dependency_status ?? "");
  return INPUT_DEPENDENCY_STATUSES.has(status as InputDependencyStatus)
    ? (status as InputDependencyStatus)
    : undefined;
}

export function sourceFieldsForExpression(
  expression: JsonRecord,
  catalog: PhysicalTableCatalog,
  load: CurrentBundleLoad,
  taskId: string,
  taskTarget: PhysicalTableCatalogEntry,
  defaultSchema: TaskDefaultSchema | null,
  effect: "VALUE" | "CONDITIONAL" = "VALUE",
): FieldDependencySourceResult {
  const fields = new Map<string, PhysicalFieldIdentity>();
  const inputFieldsByFieldKey = new Map<string, JsonRecord[]>();
  const unresolved: { table: string; column: string; reason: string }[] = [];
  const roles = expressionRolesFor(load, expression);
  const inputFields = effect === "VALUE" ? roles.valueInputs : roles.conditionalInputs;
  for (const raw of inputFields) {
    const input = asRecord(raw);
    const rawTableName = normalizeName(String(input?.table ?? ""));
    const column = normalizeName(String(input?.column ?? ""));
    if (!rawTableName || !column) continue;
    const resolution = resolvePhysicalInputField(
      {
        catalog,
        taskId,
        defaultSchema,
        fallbackTable: taskTarget,
        schemaRefs: load.records["schema-refs.jsonl"] ?? [],
      },
      { table: rawTableName, column },
    );
    if (resolution.status === "UNRESOLVED") {
      unresolved.push({
        table: resolution.table,
        column,
        reason:
          resolution.reason === "TABLE_PACK_MISSING"
            ? "SOURCE_TABLE_PACK_MISSING"
            : resolution.reason === "TABLE_IDENTITY_AMBIGUOUS"
              ? "SOURCE_TABLE_IDENTITY_AMBIGUOUS"
              : "SOURCE_FIELD_NOT_IN_SCHEMA",
      });
      continue;
    }
    fields.set(physicalFieldKey(resolution.field), resolution.field);
    const fieldKey = physicalFieldKey(resolution.field);
    inputFieldsByFieldKey.set(fieldKey, [...(inputFieldsByFieldKey.get(fieldKey) ?? []), raw as JsonRecord]);
  }
  return {
    roles,
    inputFieldsByFieldKey,
    fields: [...fields.values()].sort((left, right) =>
      compareText(physicalFieldKey(left), physicalFieldKey(right)),
    ),
    unresolved: unresolved.sort((left, right) =>
      compareText(
        `${left.table}.${left.column}`,
        `${right.table}.${right.column}`,
      ),
    ),
  };
}

export function expressionRolesFor(load: CurrentBundleLoad, expression: JsonRecord): ExpressionInputRoles {
  const indexes = dependencyIndexesFor(load);
  return indexes.rolesByExpressionId.get(String(expression.expression_id ?? ""))
    ?? classifyExpressionInputRoles(expression, indexes.relations.get(String(expression.relation_id ?? ""))?.relation);
}

export function fieldConditionalsForNode(
  load: CurrentBundleLoad,
  node: FieldConditionalNode,
  expression: JsonRecord,
  catalog: PhysicalTableCatalog,
  defaultSchema: TaskDefaultSchema | null,
  fallbackTable: Pick<PhysicalTableCatalogEntry, "platform" | "dataSource">,
  status: "CONFIRMED" | "PROVISIONAL_LEGACY",
): FieldConditionalAnnotation[] {
  const inputs = expressionRolesFor(load, expression).conditionalInputs;
  if (!inputs || inputs.length === 0) return [];
  const fields = new Map<string, PhysicalFieldIdentity>();
  let unresolved = false;
  for (const pair of inputs) {
    const resolution = resolvePhysicalInputField(
      {
        catalog,
        taskId: node.taskId,
        defaultSchema,
        fallbackTable,
        schemaRefs: load.records["schema-refs.jsonl"] ?? [],
      },
      { table: String(pair.table), column: String(pair.column) },
    );
    if (resolution.status === "RESOLVED")
      fields.set(physicalFieldKey(resolution.field), resolution.field);
    else unresolved = true;
  }
  if (fields.size === 0 && !unresolved) return [];
  return [
    {
      conditionalId: `field-conditional:${node.nodeId}`,
      taskId: node.taskId,
      nodeId: node.nodeId,
      statementId: String(expression.statement_id ?? ""),
      relationId: nonEmpty(expression.relation_id),
      subtype: "CONDITIONAL",
      masking: false,
      fields: [...fields.values()],
      sourceText: nonEmpty(expression.expression_text),
      evidenceStatus: unresolved ? "UNRESOLVED" : status,
      reasonCode: unresolved ? "FIELD_CONDITIONAL_IDENTITY_UNRESOLVED" : null,
      evidenceRefs: [
        load.evidence["field-expression-nodes.jsonl"] ??
          "machine-facts:field-expression-nodes.jsonl",
      ],
    },
  ];
}

export function fieldConditionalsForExpression(
  load: CurrentBundleLoad,
  taskId: string,
  outputColumn: string,
  expression: JsonRecord,
  catalog: PhysicalTableCatalog,
  defaultSchema: TaskDefaultSchema | null,
  fallbackTable: Pick<PhysicalTableCatalogEntry, "platform" | "dataSource">,
  status: "CONFIRMED" | "PROVISIONAL_LEGACY",
): FieldConditionalAnnotation[] {
  return fieldConditionalsForNode(
    load,
    {
      nodeId: `task-local:${taskId}:${outputColumn}`,
      taskId,
      field: { column: outputColumn },
    },
    expression,
    catalog,
    defaultSchema,
    fallbackTable,
    status,
  );
}
