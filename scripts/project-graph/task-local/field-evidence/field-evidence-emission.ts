import { normalizeName } from "../../../machine-facts/machine-facts-contract.ts";
import type { PhysicalFieldIdentity } from "../../../reconcile/shared/physical-field.ts";
import type {
  TaskLocalDirectSubtype,
  TaskLocalProjectionGap,
  TaskLocalSubtypeReason,
} from "../contract.ts";
import { stableId } from "../ids.ts";
import { classifyExpressionInputRoles } from "../expression-input-roles.ts";
import {
  buildRelationTreeIndex,
  type RelationTreeIndex,
  withIncomingRelations,
} from "./relation-tree.ts";
import {
  classifyExpressionSubtype,
  composePathSubtype,
  type ExpressionSubtypeResult,
} from "./subtype-classifier.ts";
import {
  expandSetopBranchExpressions,
  expressionsByRelationAndOrdinal,
  leafRelationIdForExpression,
  routeNamedOutputContexts,
  resolveSourceReadOccurrence,
  type FieldExpressionContext,
  type SourceReadOccurrenceResolution,
} from "./source-read-occurrence.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

export interface ExpandedMaterializedField {
  readonly field: PhysicalFieldIdentity;
  readonly materializationBridgeIds: readonly string[];
  readonly leafExpressionId: string | null;
  readonly leafRelationId: string | null;
  readonly pathHadAggregation: boolean;
  readonly subtypeHops: readonly ExpressionSubtypeResult[];
  /** Role after composing every materialization hop with the consumer. */
  readonly dependencyRole?: "VALUE" | "CONDITIONAL";
  /** Consumer-side source restricts folded evidence to the matching setop branch. */
  readonly materializationInputField?: PhysicalFieldIdentity;
  /** Raw consumer references already resolved to materializationInputField. */
  readonly materializationInputFields?: readonly JsonRecord[];
  readonly sourceInputFields?: readonly JsonRecord[];
}

export interface FieldEvidenceEmissionInput {
  readonly taskId: string;
  readonly expressions: readonly JsonRecord[];
  readonly relationNodes: readonly JsonRecord[];
  readonly relationEdges: readonly JsonRecord[];
  readonly datasetIoReads: readonly JsonRecord[];
}

export interface FieldEvidenceIndexes {
  readonly relationTree: RelationTreeIndex;
  readonly expressionsById: ReadonlyMap<string, JsonRecord>;
  readonly expressionsByRelation: ReadonlyMap<string, ReadonlyMap<number, JsonRecord>>;
  readonly relationExpressionsByRelationId: ReadonlyMap<string, readonly JsonRecord[]>;
  readonly readOccurrenceByRelationId: ReadonlyMap<string, string>;
  readonly bindingByReadRelation: ReadonlyMap<string, string>;
}

export interface EmittedFieldEvidence {
  readonly expressionContexts: readonly FieldExpressionContext[];
  readonly sourceResolution: SourceReadOccurrenceResolution;
  readonly subtype: TaskLocalDirectSubtype;
  readonly subtypeReason: TaskLocalSubtypeReason | null;
  readonly leafRelationId: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function relationBody(relation: JsonRecord): JsonRecord {
  return record(relation.relation) ?? relation;
}

export function buildFieldEvidenceIndexes(
  input: FieldEvidenceEmissionInput,
): FieldEvidenceIndexes {
  const relationTree = withIncomingRelations(
    buildRelationTreeIndex(input.relationNodes),
    input.relationEdges,
  );
  const readOccurrenceByRelationId = new Map<string, string>();
  const bindingByReadRelation = new Map<string, string>();
  const relationExpressionsByRelationId = new Map<string, readonly JsonRecord[]>();
  for (const relation of input.relationNodes) {
    const relationId = text(relation.relation_id);
    if (!relationId) continue;
    const body = relationBody(relation);
    const expressionRecords = body.expressions ?? body.measures;
    const rawExpressions = Array.isArray(expressionRecords)
      ? expressionRecords.map(record).filter((item): item is JsonRecord => item !== null)
      : [];
    if (rawExpressions.length > 0) relationExpressionsByRelationId.set(relationId, rawExpressions);
    if (String(relation.relation_type ?? "").toLowerCase() === "read") {
      const binding = text(body.binding);
      if (binding) bindingByReadRelation.set(relationId, binding);
    }
  }
  for (const read of input.datasetIoReads) {
    if (String(read.direction ?? "").toUpperCase() !== "READ") continue;
    const occurrences = Array.isArray(read.read_occurrences) ? read.read_occurrences : [];
    for (const occurrence of occurrences) {
      const item = record(occurrence);
      const relationId = text(item?.relation_id);
      const occurrenceId = text(item?.occurrence_id) ?? relationId;
      if (relationId && occurrenceId) {
        readOccurrenceByRelationId.set(relationId, occurrenceId);
      }
    }
  }
  return {
    relationTree,
    expressionsById: new Map(
      input.expressions
        .map((expression) => [text(expression.expression_id), expression] as const)
        .filter((entry): entry is readonly [string, JsonRecord] => entry[0] !== null),
    ),
    expressionsByRelation: expressionsByRelationAndOrdinal(input.expressions),
    relationExpressionsByRelationId,
    readOccurrenceByRelationId,
    bindingByReadRelation,
  };
}

export function relationTypeForExpression(
  indexes: FieldEvidenceIndexes,
  relationId: string | null,
): string | null {
  if (!relationId) return null;
  return indexes.relationTree.relations.get(relationId)?.relationType ?? null;
}

/**
 * After setop ordinal sink, only keep sources that the *branch* expression
 * actually lists. Top-level project/setop expressions often union inputs from
 * every branch; pairing those foreign sources with a branch leaf yields false
 * CTE_SCOPE_UNRESOLVED edges.
 */
export function expressionAcceptsSourceField(
  expression: JsonRecord,
  sourceField: PhysicalFieldIdentity,
  resolvedInputFields: readonly JsonRecord[] = [],
): boolean {
  const inputFields = Array.isArray(expression.input_fields) ? expression.input_fields : [];
  if (inputFields.length === 0) return false;
  const targetTable = normalizeName(sourceField.qualifiedName);
  const targetColumn = normalizeName(sourceField.column);
  return inputFields.some((raw) => {
    const input = record(raw);
    if (!input) return false;
    const column = normalizeName(String(input.column ?? input.name ?? ""));
    if (column !== targetColumn) return false;
    const table = normalizeName(String(input.table ?? input.physical_dataset ?? ""));
    if (!table) return true;
    return table === targetTable || resolvedInputFields.some((resolved) =>
      normalizeName(String(resolved.table ?? "")) === table
      && normalizeName(String(resolved.column ?? "")) === column,
    );
  });
}

function relationQualifiersForSourceField(input: {
  readonly expression: JsonRecord;
  readonly sourceField: PhysicalFieldIdentity;
  readonly indexes: FieldEvidenceIndexes;
}): readonly string[] | null {
  const relationId = text(input.expression.relation_id);
  const outputName = text(input.expression.output_name);
  if (!relationId || !outputName) return null;
  const rawExpressions = input.indexes.relationExpressionsByRelationId.get(relationId) ?? [];
  const matchingExpressions = rawExpressions.filter((candidate) =>
    normalizeName(String(candidate.output ?? "")) === normalizeName(outputName),
  );
  if (matchingExpressions.length !== 1) return null;
  const qualifiers = new Set<string>();
  const targetTable = normalizeName(input.sourceField.qualifiedName);
  const targetColumn = normalizeName(input.sourceField.column);
  const inputColumns = Array.isArray(matchingExpressions[0]!.input_columns)
    ? matchingExpressions[0]!.input_columns
    : [];
  let matchedSource = false;
  for (const rawInput of inputColumns) {
    const inputColumn = record(rawInput);
    if (!inputColumn) continue;
    const physical = Array.isArray(inputColumn.physical) ? inputColumn.physical : [];
    const matchesSource = physical.some((rawPhysical) => {
      const physical = record(rawPhysical);
      return physical !== null
        && normalizeName(String(physical.table ?? "")) === targetTable
        && normalizeName(String(physical.column ?? "")) === targetColumn;
    });
    if (!matchesSource) continue;
    matchedSource = true;
    const qualifier = text(inputColumn.qualifier);
    if (!qualifier) return null;
    qualifiers.add(normalizeName(qualifier));
  }
  return matchedSource && qualifiers.size > 0 ? [...qualifiers].sort() : null;
}

function cteInputReferenceForSourceField(input: {
  readonly expression: JsonRecord;
  readonly sourceField: PhysicalFieldIdentity;
  readonly indexes: FieldEvidenceIndexes;
}): Readonly<{ outputColumn: string; relationQualifier: string | null }> | null {
  const relationId = text(input.expression.relation_id);
  const outputName = text(input.expression.output_name);
  if (!relationId || !outputName) return null;
  const expressions = input.indexes.relationExpressionsByRelationId.get(relationId) ?? [];
  const matching = expressions.filter((candidate) =>
    normalizeName(String(candidate.output ?? "")) === normalizeName(outputName),
  );
  if (matching.length !== 1) return null;
  const table = normalizeName(input.sourceField.qualifiedName);
  const column = normalizeName(input.sourceField.column);
  const references = new Map<string, Set<string | null>>();
  for (const rawInput of Array.isArray(matching[0]!.input_columns)
    ? matching[0]!.input_columns
    : []) {
    const item = record(rawInput);
    const physical = Array.isArray(item?.physical) ? item.physical : [];
    if (physical.some((raw) => {
      const field = record(raw);
      return field !== null
        && normalizeName(String(field.table ?? "")) === table
        && normalizeName(String(field.column ?? "")) === column;
    })) {
      const name = text(item?.name);
      if (name) {
        const normalizedName = normalizeName(name);
        const qualifiers = references.get(normalizedName) ?? new Set<string | null>();
        qualifiers.add(text(item?.qualifier) ? normalizeName(text(item?.qualifier)!) : null);
        references.set(normalizedName, qualifiers);
      }
    }
  }
  if (references.size !== 1) return null;
  const [outputColumn, qualifiers] = [...references.entries()][0]!;
  // The named CTE output is still proven when the outer expression references
  // it through more than one logical reader.  The reader itself is ambiguous
  // in that case, so leave its qualifier unset rather than dropping the
  // output-to-input proof or choosing one reader.
  return {
    outputColumn,
    relationQualifier: qualifiers.size === 1 ? [...qualifiers][0]! : null,
  };
}

export function emitFieldEvidenceForInput(input: {
  readonly taskId: string;
  readonly expression: JsonRecord;
  readonly sourceField: PhysicalFieldIdentity;
  readonly inputField: JsonRecord;
  readonly expanded: ExpandedMaterializedField;
  readonly indexes: FieldEvidenceIndexes;
  /** The caller already selected the output ordinal in this setop branch. */
  readonly branchScoped?: boolean;
}): readonly EmittedFieldEvidence[] {
  const expandedContexts: readonly FieldExpressionContext[] = input.branchScoped ? [{
    expression: input.expression,
    expressionId: String(input.expression.expression_id),
    relationId: text(input.expression.relation_id),
    ordinal: typeof input.expression.ordinal === "number" ? input.expression.ordinal : null,
  }] : expandSetopBranchExpressions({
    expression: input.expression,
    expressionsByRelation: input.indexes.expressionsByRelation,
    index: input.indexes.relationTree,
  });
  // Preserve the established resolver and its contexts first.  Named-output
  // routing is deliberately a CTE-scope fallback: applying it before this
  // point changes successful and ambiguous results, and leaks the route leaf
  // into the downstream expression identity.
  const expressionContexts = expandedContexts;
  const outputs: EmittedFieldEvidence[] = [];
  const materializationLeafExpression = input.expanded.materializationBridgeIds.length > 0
    && input.expanded.leafExpressionId
    ? input.indexes.expressionsById.get(input.expanded.leafExpressionId) ?? null
    : null;
  for (const context of expressionContexts) {
    if (input.expanded.materializationInputField
      && !expressionAcceptsSourceField(context.expression, input.expanded.materializationInputField,
        input.expanded.materializationInputFields)) continue;
    const directSource = !materializationLeafExpression && expressionAcceptsSourceField(
      context.expression,
      input.sourceField,
      input.expanded.sourceInputFields,
    );
    const sourceExpression = directSource
      ? context.expression
      : materializationLeafExpression;
    if (
      !sourceExpression
      || !expressionAcceptsSourceField(sourceExpression, input.sourceField, input.expanded.sourceInputFields)
    ) {
      continue;
    }
    const leafRelationId = leafRelationIdForExpression(
      sourceExpression,
      directSource
        // Prefer the sunk branch relation; parent materialization leaf may sit
        // above the setop and would re-open sibling-branch reads.
        ? text(context.expression.relation_id) ?? input.expanded.leafRelationId
        : input.expanded.leafRelationId ?? text(sourceExpression.relation_id),
    );
    const branchInputField = inputFieldRecordForSource(
      sourceExpression,
      input.sourceField,
    );
    const roleQualifiers = input.expanded.sourceInputFields;
    const hasRoleQualifiers = roleQualifiers && roleQualifiers.length > 0
      && roleQualifiers.every((field) => text(field.qualifier));
    const relationQualifiers = hasRoleQualifiers
      ? [...new Set(roleQualifiers.map((field) => normalizeName(String(field.qualifier))))]
      : relationQualifiersForSourceField({
      expression: sourceExpression,
      sourceField: input.sourceField,
      indexes: input.indexes,
    });
    // This source expression can already prove a named CTE output even when
    // its physical input is read through several logical aliases.  Preserve
    // the output proof for the normal emission path; the resolver still has
    // to establish that every viable reader reaches one CTE body.
    const cteInputReference = cteInputReferenceForSourceField({
      expression: sourceExpression,
      sourceField: input.sourceField,
      indexes: input.indexes,
    });
    // Split only structured physical references, never the set of possible reads.
    for (const relationQualifier of relationQualifiers ?? [null]) {
      // These raw references were resolved to sourceField by the physical resolver.
      // Match read occurrences in their original SQL namespace, retaining the
      // canonical identity for the emitted field node. No tail-name matching.
      const resolvedReferences = (input.expanded.sourceInputFields ?? []).filter((field) =>
        !relationQualifier || normalizeName(String(field.qualifier ?? "")) === relationQualifier,
      );
      const referenceTables = [...new Set(resolvedReferences.map((field) => text(field.table)).filter((table): table is string => table !== null))];
      const resolvedInput = resolvedReferences.length === 1 ? resolvedReferences[0] : null;
      const sourceResolution = resolveSourceReadOccurrence({
        taskId: input.taskId,
        expressionId: directSource
          ? context.expressionId
          : input.expanded.leafExpressionId ?? context.expressionId,
        sourceTable: referenceTables.length === 1 ? referenceTables[0]! : input.sourceField.qualifiedName,
        sourceColumn: input.sourceField.column,
        inputField: relationQualifier
          ? { ...(resolvedInput ?? branchInputField), qualifier: relationQualifier }
          : resolvedInput ?? branchInputField,
        expressionText: text(context.expression.expression_text),
        ...(relationQualifiers && (hasRoleQualifiers || relationQualifiers.length > 1) && relationQualifier
          ? { referenceQualifier: relationQualifier }
          : {}),
        cteOutputColumn: cteInputReference?.outputColumn ?? null,
        cteRelationQualifier: cteInputReference?.relationQualifier ?? null,
        leafRelationId,
        index: input.indexes.relationTree,
        readOccurrenceByRelationId: input.indexes.readOccurrenceByRelationId,
        bindingByReadRelation: input.indexes.bindingByReadRelation,
      });
      const expressionSubtype = classifyExpressionSubtype(
        context.expression,
        relationTypeForExpression(input.indexes, context.relationId),
      );
      const composed = composePathSubtype([
        ...input.expanded.subtypeHops,
        expressionSubtype,
      ]);
      outputs.push({
        expressionContexts: [context],
        sourceResolution,
        subtype: composed.subtype,
        subtypeReason: composed.subtypeReason,
        leafRelationId,
      });
    }
  }

  const isOuterOnlyContext = expressionContexts.length === 1
    && expressionContexts[0]?.expressionId === text(input.expression.expression_id);
  const needsCteScopeFallback = outputs.some((output) =>
    output.sourceResolution.sourceReadOccurrenceStatus === "UNRESOLVED"
    && output.sourceResolution.sourceReadOccurrenceReason === "CTE_SCOPE_UNRESOLVED",
  );
  if (!isOuterOnlyContext || !needsCteScopeFallback) return outputs;

  const routedContexts = routeNamedOutputContexts({
    expression: input.expression,
    sourceTable: input.sourceField.qualifiedName,
    sourceColumn: input.sourceField.column,
    relationExpressionsByRelationId: input.indexes.relationExpressionsByRelationId,
    expressionsByRelation: input.indexes.expressionsByRelation,
    index: input.indexes.relationTree,
  });
  if (routedContexts.length === 0) return outputs;

  const outerContext = expressionContexts[0]!;
  const routedOutputs: EmittedFieldEvidence[] = [];
  for (const routed of routedContexts) {
    if (!expressionAcceptsSourceField(routed.expression, input.sourceField)) continue;
    const routeLeafRelationId = leafRelationIdForExpression(
      routed.expression,
      text(routed.expression.relation_id) ?? input.expanded.leafRelationId,
    );
    const branchInputField = inputFieldRecordForSource(routed.expression, input.sourceField);
    const relationQualifiers = relationQualifiersForSourceField({
      expression: routed.expression,
      sourceField: input.sourceField,
      indexes: input.indexes,
    });
    const cteInputReference = cteInputReferenceForSourceField({
      expression: routed.expression,
      sourceField: input.sourceField,
      indexes: input.indexes,
    });
    for (const relationQualifier of relationQualifiers ?? [null]) {
      const sourceResolution = resolveSourceReadOccurrence({
        taskId: input.taskId,
        expressionId: routed.expressionId,
        sourceTable: input.sourceField.qualifiedName,
        sourceColumn: input.sourceField.column,
        inputField: relationQualifier
          ? { ...branchInputField, qualifier: relationQualifier }
          : branchInputField,
        expressionText: text(routed.expression.expression_text),
        ...(relationQualifiers && relationQualifiers.length > 1 && relationQualifier
          ? { referenceQualifier: relationQualifier }
          : {}),
        cteOutputColumn: cteInputReference?.outputColumn ?? null,
        cteRelationQualifier: cteInputReference?.relationQualifier ?? null,
        leafRelationId: routeLeafRelationId,
        index: input.indexes.relationTree,
        readOccurrenceByRelationId: input.indexes.readOccurrenceByRelationId,
        bindingByReadRelation: input.indexes.bindingByReadRelation,
      });
      const routeHops = routed.routeExpressionHops ?? [routed.expression];
      const composed = composePathSubtype([
        ...input.expanded.subtypeHops,
        ...routeHops.map((expression) => classifyExpressionSubtype(
          expression,
          relationTypeForExpression(input.indexes, text(expression.relation_id)),
        )),
        ...(routed.routePathHadAggregation ? [{
          subtype: "AGGREGATION" as const,
          subtypeReason: null,
          pathHadAggregation: true,
        }] : []),
      ]);
      routedOutputs.push({
        // The route only proves the source-read identity.  Consumers use this
        // context as the target edge identity, so it must remain the outer
        // expression that initiated the route.
        expressionContexts: [outerContext],
        sourceResolution,
        subtype: composed.subtype,
        subtypeReason: composed.subtypeReason,
        leafRelationId: routeLeafRelationId,
      });
    }
  }
  if (routedOutputs.length === 0) return outputs;
  // A route represents one logical output through every required setop branch.
  // If any branch lacks a confirmed occurrence, retaining only its resolved
  // siblings would falsely present the outer dependency as complete.
  if (routedOutputs.some((output) =>
    output.sourceResolution.sourceReadOccurrenceStatus !== "RESOLVED",
  )) return outputs;

  // Multiple branches can prove the same physical read.  Emit it once and
  // compose their evidence so consumer map insertion cannot depend on output
  // order or overwrite a stronger subtype.
  const byReadIdentity = new Map<string, EmittedFieldEvidence[]>();
  for (const output of routedOutputs) {
    const key = `${output.sourceResolution.sourceReadOccurrenceId!}\u0000${output.sourceResolution.sourceRelationId!}`;
    const values = byReadIdentity.get(key) ?? [];
    values.push(output);
    byReadIdentity.set(key, values);
  }
  const mergedRoutedOutputs = [...byReadIdentity.values()].map((values) => {
    const first = values[0]!;
    const composed = composePathSubtype(values.map((value) => ({
      subtype: value.subtype,
      subtypeReason: value.subtypeReason,
      pathHadAggregation: value.subtype === "AGGREGATION",
    })));
    return {
      ...first,
      subtype: composed.subtype,
      subtypeReason: composed.subtypeReason,
    };
  });
  const withoutCteScopeFallback = outputs.filter((output) => !(
    output.sourceResolution.sourceReadOccurrenceStatus === "UNRESOLVED"
    && output.sourceResolution.sourceReadOccurrenceReason === "CTE_SCOPE_UNRESOLVED"
  ));
  return [...withoutCteScopeFallback, ...mergedRoutedOutputs];
}

export function materializationBreakGap(input: {
  readonly taskId: string;
  readonly physicalDataset: string;
  readonly columns: readonly string[];
  readonly affectedEdgeCount: number;
  readonly writeObservationIds: readonly string[];
  readonly materializationRecords: number;
}): TaskLocalProjectionGap {
  return {
    gapId: stableId("gap", {
      reasonCode: "TASK_LOCAL_MATERIALIZATION_FIELD_BREAK",
      taskId: input.taskId,
      physicalDataset: input.physicalDataset,
    }),
    reasonCode: "TASK_LOCAL_MATERIALIZATION_FIELD_BREAK",
    details: {
      taskId: input.taskId,
      physicalDataset: input.physicalDataset,
      columns: [...input.columns].sort((left, right) => left.localeCompare(right)),
      affectedEdgeCount: input.affectedEdgeCount,
      writeObservationIds: [...input.writeObservationIds].sort((left, right) =>
        left.localeCompare(right),
      ),
      materializationRecords: input.materializationRecords,
    },
  };
}

export function controlSideGap(input: {
  readonly taskId: string;
  readonly relationId: string;
  readonly controlId: string;
}): TaskLocalProjectionGap {
  return {
    gapId: stableId("gap", {
      reasonCode: "CONTROL_SIDE_UNRESOLVED",
      taskId: input.taskId,
      relationId: input.relationId,
      controlId: input.controlId,
    }),
    reasonCode: "CONTROL_SIDE_UNRESOLVED",
    details: {
      taskId: input.taskId,
      relationId: input.relationId,
      controlId: input.controlId,
    },
  };
}

export function inputFieldRecordForSource(
  expression: JsonRecord,
  sourceField: PhysicalFieldIdentity,
): JsonRecord {
  const targetTable = normalizeName(sourceField.qualifiedName);
  const targetColumn = normalizeName(sourceField.column);
  const inputFields = Array.isArray(expression.input_fields) ? expression.input_fields : [];
  for (const raw of inputFields) {
    const input = record(raw);
    if (!input) continue;
    if (
      normalizeName(String(input.table ?? "")) === targetTable
      && normalizeName(String(input.column ?? "")) === targetColumn
    ) {
      return input;
    }
  }
  return { table: sourceField.qualifiedName, column: sourceField.column };
}

export function isConstantExpression(expression: JsonRecord): boolean {
  return classifyExpressionInputRoles(expression).terminalKind === "LITERAL";
}
