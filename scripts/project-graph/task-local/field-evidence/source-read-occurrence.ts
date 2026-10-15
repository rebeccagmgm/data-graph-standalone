import { normalizeName } from "../../../machine-facts/machine-facts-contract.ts";
import type {
  TaskLocalProjectionGap,
  TaskLocalSourceReadOccurrenceReason,
  TaskLocalSourceReadOccurrenceStatus,
} from "../contract.ts";
import { stableId } from "../ids.ts";
import {
  nearestSetopAncestor,
  readRelationsInSubtree,
  relationSubtree,
  type RelationRecord,
  type RelationTreeIndex,
} from "./relation-tree.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

export interface SourceReadOccurrenceResolution {
  readonly sourceReadOccurrenceId: string | null;
  readonly sourceReadOccurrenceStatus: TaskLocalSourceReadOccurrenceStatus;
  readonly sourceReadOccurrenceReason: TaskLocalSourceReadOccurrenceReason | null;
  readonly sourceRelationId: string | null;
  readonly gap: TaskLocalProjectionGap | null;
}

export interface FieldExpressionContext {
  readonly expressionId: string;
  readonly expression: JsonRecord;
  readonly relationId: string | null;
  readonly ordinal: number | null;
  readonly originExpressionId?: string;
  readonly routeRelationPath?: readonly string[];
  /** Expressions traversed while routing a named output to this context. */
  readonly routeExpressionHops?: readonly JsonRecord[];
  readonly routePathHadAggregation?: boolean;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tableKey(value: string): string {
  return normalizeName(value);
}

function gapForStatus(input: {
  readonly taskId: string;
  readonly expressionId: string;
  readonly sourceTable: string;
  readonly sourceColumn: string;
  readonly status: TaskLocalSourceReadOccurrenceStatus;
  readonly reason: TaskLocalSourceReadOccurrenceReason;
}): TaskLocalProjectionGap {
  const reasonCode = input.status === "AMBIGUOUS"
    ? "FIELD_SOURCE_READ_OCCURRENCE_AMBIGUOUS"
    : "FIELD_SOURCE_READ_OCCURRENCE_UNRESOLVED";
  return {
    gapId: stableId("gap", {
      reasonCode,
      taskId: input.taskId,
      expressionId: input.expressionId,
      sourceTable: input.sourceTable,
      sourceColumn: input.sourceColumn,
    }),
    reasonCode,
    details: {
      taskId: input.taskId,
      expressionId: input.expressionId,
      sourceTable: input.sourceTable,
      sourceColumn: input.sourceColumn,
      sourceReadOccurrenceStatus: input.status,
      reasonCode: input.reason,
    },
  };
}

function unresolved(
  input: {
    readonly taskId: string;
    readonly expressionId: string;
    readonly sourceTable: string;
    readonly sourceColumn: string;
    readonly reason: TaskLocalSourceReadOccurrenceReason;
  },
): SourceReadOccurrenceResolution {
  return {
    sourceReadOccurrenceId: null,
    sourceReadOccurrenceStatus: "UNRESOLVED",
    sourceReadOccurrenceReason: input.reason,
    sourceRelationId: null,
    gap: gapForStatus({
      ...input,
      status: "UNRESOLVED",
    }),
  };
}

function ambiguous(
  input: {
    readonly taskId: string;
    readonly expressionId: string;
    readonly sourceTable: string;
    readonly sourceColumn: string;
    readonly reason: TaskLocalSourceReadOccurrenceReason;
  },
): SourceReadOccurrenceResolution {
  return {
    sourceReadOccurrenceId: null,
    sourceReadOccurrenceStatus: "AMBIGUOUS",
    sourceReadOccurrenceReason: input.reason,
    sourceRelationId: null,
    gap: gapForStatus({
      ...input,
      status: "AMBIGUOUS",
    }),
  };
}

function resolved(
  sourceReadOccurrenceId: string,
  sourceRelationId: string,
): SourceReadOccurrenceResolution {
  return {
    sourceReadOccurrenceId,
    sourceReadOccurrenceStatus: "RESOLVED",
    sourceReadOccurrenceReason: null,
    sourceRelationId,
    gap: null,
  };
}

function qualifierFromInput(inputField: JsonRecord): string | null {
  return text(inputField.qualifier) ?? text(inputField.alias);
}

/**
 * Extract table/alias qualifiers that appear as `qualifier.column` in expression text.
 * Ported from physical-field-expander expressionQualifiersForColumn — no task literals.
 */
export function expressionQualifiersForColumn(
  expressionText: string | null | undefined,
  column: string,
): readonly string[] {
  if (!expressionText?.trim() || !column.trim()) return [];
  const escapedColumn = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|[^\\w$])["\`\\[]?([A-Za-z_][\\w$]*)["\`\\]]?\\s*\\.\\s*["\`\\[]?${escapedColumn}["\`\\]]?(?![\\w$])`,
    "gi",
  );
  const qualifiers = new Set<string>();
  for (const match of expressionText.matchAll(pattern)) {
    if (match[1]) qualifiers.add(normalizeName(match[1]));
  }
  return [...qualifiers].sort((left, right) => left.localeCompare(right));
}

function readOccurrenceIdForRelation(
  readOccurrenceByRelationId: ReadonlyMap<string, string>,
  relationId: string,
): string | null {
  return readOccurrenceByRelationId.get(relationId) ?? relationId;
}

/** Facts mark CTE-body scopes with `.(child)`; expressions outside that body must not bind its reads. */
export function cteBodyScopePrefix(scopeId: string | null | undefined): string | null {
  if (!scopeId) return null;
  const marker = ".(child)";
  const index = scopeId.indexOf(marker);
  if (index < 0) return null;
  return scopeId.slice(0, index + marker.length);
}

export function isReadVisibleFromExpressionScope(
  expressionScopeId: string | null,
  readScopeId: string | null,
): boolean {
  const expressionCte = cteBodyScopePrefix(expressionScopeId);
  const readCte = cteBodyScopePrefix(readScopeId);
  if (readCte && readCte !== expressionCte) return false;
  return true;
}

function matchingReads(input: {
  readonly index: RelationTreeIndex;
  readonly leafRelationId: string;
  readonly sourceTable: string;
  readonly sourceColumn: string;
  /** Logical CTE output read by this exact branch expression. */
  readonly cteOutputColumn: string | null;
  /** Optional logical relation qualifier from that same structured input. */
  readonly cteRelationQualifier: string | null;
  /** Exact direct-read qualifier for the routed structured reference. */
  readonly referenceQualifier: string | null;
  readonly bindingByReadRelation: ReadonlyMap<string, string>;
}): readonly RelationRecord[] {
  const targetTable = tableKey(input.sourceTable);
  const targetColumn = normalizeName(input.sourceColumn);
  const expressionScopeId = input.index.relations.get(input.leafRelationId)?.scopeId ?? null;
  const matches = new Map<string, RelationRecord>();
  const reads = readRelationsInSubtree(input.index, input.leafRelationId);
  // A CTE bridge is sound only when this branch has one immediate input
  // relation.  Counting just source-backed reads silently ignores a physical
  // sibling in the same join, which makes an unqualified CTE reference look
  // unique when it is not.
  const directInputReads = reads.filter((relation) =>
    isReadVisibleFromExpressionScope(expressionScopeId, relation.scopeId),
  );
  const referencedInputReads = input.cteRelationQualifier
    ? directInputReads.filter((relation) => relationMatchesQualifier(
      relation, input.cteRelationQualifier!, input.bindingByReadRelation,
    ))
    : directInputReads;
  // Unqualified inputs can cross a CTE only if the entire immediate logical
  // input domain is singular.  A matching CTE body must not hide a sibling
  // derived/CTE relation that could also supply the column.
  const hasUniqueDirectInput = referencedInputReads.length === 1;
  // A setop branch can read the same CTE body more than once (for example,
  // current and baseline aggregates over `t`).  That remains safe only when
  // every immediate logical input points at that one body.
  const sharedCteBodyId = referencedInputReads[0]?.sourceRelationId ?? null;
  const hasRepeatedSharedCteInput = sharedCteBodyId !== null
    && referencedInputReads.length > 1
    && referencedInputReads.every(
      (relation) => relation.sourceRelationId === sharedCteBodyId,
    );
  const canBridgeCteInput = hasUniqueDirectInput || hasRepeatedSharedCteInput;
  const cteBridges: Array<{
    readonly cteRead: RelationRecord;
    readonly cteBody: RelationRecord;
    readonly qualifier: string | null;
  }> = [];
  const cteOutputColumn = input.cteOutputColumn;
  for (const relation of reads) {
    if (relation.physicalDataset === targetTable) {
      if (
        isReadVisibleFromExpressionScope(expressionScopeId, relation.scopeId)
        && (!input.referenceQualifier || relationMatchesQualifier(
          relation,
          input.referenceQualifier,
          input.bindingByReadRelation,
        ))
      ) {
        matches.set(relation.relationId, relation);
      }
      continue;
    }

    // A CTE reference may cross its body only after three Facts agree: this
    // branch reads a named logical output, the body emits that output, and that
    // output lists this physical field.  A CTE source pointer or table match
    // alone is insufficient evidence.
    if (
        !canBridgeCteInput
      || !relation.sourceRelationId
      || !cteOutputColumn
      || !referencedInputReads.some(
        (candidate) => candidate.relationId === relation.relationId,
      )
    ) continue;
    if (!isReadVisibleFromExpressionScope(expressionScopeId, relation.scopeId)) continue;
    const cteBody = input.index.relations.get(relation.sourceRelationId);
    if (!cteBody) continue;
    const witnesses = cteBody.outputInputColumns.filter((column) =>
      column.outputName === normalizeName(cteOutputColumn)
      && column.physicalDataset === targetTable
      && column.physicalColumn === targetColumn,
    );
    if (witnesses.length !== 1) continue;
    cteBridges.push({ cteRead: relation, cteBody, qualifier: witnesses[0]!.qualifier });
  }

  const cteBodies = new Map<string, typeof cteBridges[number]>();
  for (const bridge of cteBridges) {
    cteBodies.set(bridge.cteBody.relationId, bridge);
  }
  if (cteBodies.size !== 1) {
    return [...matches.values()].sort((left, right) => left.relationId.localeCompare(right.relationId));
  }
  const bridge = [...cteBodies.values()][0]!;
  const bodyScope = bridge.cteBody.scopeId;
  for (const sourceRead of readRelationsInSubtree(input.index, bridge.cteBody.relationId)) {
    const suffix = bodyScope && sourceRead.scopeId?.startsWith(`${bodyScope}.`)
      ? sourceRead.scopeId.slice(bodyScope.length)
      : sourceRead.scopeId === bodyScope ? "" : null;
    // Do not recursively traverse a nested CTE body.  That needs another
    // explicit output-to-input bridge and is deliberately left unresolved.
    const isDirectBodyRead = suffix !== null && !suffix.includes(".(child)");
    if (
      isDirectBodyRead
      && sourceRead.physicalDataset === targetTable
      && (!bridge.qualifier || relationMatchesQualifier(
        sourceRead, bridge.qualifier, input.bindingByReadRelation,
      ))
    ) {
      matches.set(sourceRead.relationId, sourceRead);
    }
  }
  return [...matches.values()].sort((left, right) => left.relationId.localeCompare(right.relationId));
}

function relationMatchesQualifier(
  relation: RelationRecord,
  qualifier: string,
  bindingByReadRelation: ReadonlyMap<string, string>,
): boolean {
  const normalizedQualifier = normalizeName(qualifier);
  const binding = bindingByReadRelation.get(relation.relationId);
  if (binding !== undefined && normalizeName(binding) === normalizedQualifier) {
    return true;
  }
  if (relation.scopeId) {
    const scopeTail = relation.scopeId.split(".").at(-1);
    if (scopeTail && normalizeName(scopeTail) === normalizedQualifier) return true;
  }
  const relationSegments = relation.relationId.toLowerCase().split(/[:.]/);
  return relationSegments.includes(normalizedQualifier);
}

function outputExpression(
  relationId: string,
  outputName: string,
  expressions: ReadonlyMap<string, readonly JsonRecord[]>,
): JsonRecord | null {
  const matches = (expressions.get(relationId) ?? []).filter((expression) =>
    normalizeName(String(expression.output ?? "")) === normalizeName(outputName),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function physicalInput(input: JsonRecord, sourceTable: string, sourceColumn: string): boolean {
  return (Array.isArray(input.physical) ? input.physical : []).some((raw) => {
    const field = record(raw);
    return field !== null
      && normalizeName(String(field.table ?? "")) === normalizeName(sourceTable)
      && normalizeName(String(field.column ?? "")) === normalizeName(sourceColumn);
  });
}

/**
 * Route a physical input through named derived outputs only.  This is a
 * bounded fallback for an outer projection which current setop sinking cannot
 * reach through intervening joins/filters/aggregates.  It never guesses an
 * unqualified join side: every selected producer must be unique in Facts.
 */
export function routeNamedOutputContexts(input: {
  readonly expression: JsonRecord;
  readonly sourceTable: string;
  readonly sourceColumn: string;
  readonly relationExpressionsByRelationId: ReadonlyMap<string, readonly JsonRecord[]>;
  readonly expressionsByRelation: ReadonlyMap<string, ReadonlyMap<number, JsonRecord>>;
  readonly index: RelationTreeIndex;
}): readonly FieldExpressionContext[] {
  let current = input.expression;
  const originExpressionId = text(current.expression_id);
  const path: string[] = [];
  const routeExpressionHops: JsonRecord[] = [];
  let routePathHadAggregation = false;
  const visited = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    const relationId = text(current.relation_id);
    const outputName = text(current.output_name);
    if (!relationId || !outputName || visited.has(relationId)) return [];
    visited.add(relationId);
    path.push(relationId);
    const raw = outputExpression(relationId, outputName, input.relationExpressionsByRelationId);
    if (!raw) return [];
    // `current` is the field-expression record and has the expression text,
    // physical dependency status, and relation id required for classification.
    // The relation-body expression below is only a routing witness.
    routeExpressionHops.push(current);
    const matchingInputs = (Array.isArray(raw.input_columns) ? raw.input_columns : [])
      .map(record)
      .filter((item): item is JsonRecord => item !== null && physicalInput(
        item, input.sourceTable, input.sourceColumn,
      ));
    if (matchingInputs.length !== 1) return [];
    const namedInput = matchingInputs[0]!;
    const inputName = text(namedInput.name);
    if (!inputName) return [];
    const qualifier = text(namedInput.qualifier);
    if (qualifier) {
      const currentScope = input.index.relations.get(relationId)?.scopeId;
      if (!currentScope) return [];
      // Relation scopes are lexical: root -> root.index -> root.index.x.
      // Exact equality prevents a same-named nested alias from shadowing this
      // output while still allowing an outer root scope.
      const expectedScope = `${currentScope}.${normalizeName(qualifier)}`;
      const candidates = [...relationSubtree(input.index, relationId)]
        .map((id) => input.index.relations.get(id))
        .filter((relation): relation is RelationRecord => relation !== undefined)
        .filter((relation) =>
          normalizeName(relation.scopeId ?? "") === expectedScope
          && outputExpression(relation.relationId, inputName, input.relationExpressionsByRelationId) !== null,
        );
      if (candidates.length === 1) {
        const next = outputExpression(
          candidates[0]!.relationId, inputName, input.relationExpressionsByRelationId,
        );
        const nextExpression = next && [...(input.expressionsByRelation.get(candidates[0]!.relationId)?.values() ?? [])]
          .filter((item) => normalizeName(String(item.output_name ?? "")) === normalizeName(inputName));
        if (!nextExpression || nextExpression.length !== 1) return [];
        current = nextExpression[0]!;
        continue;
      }

      // A CTE reader is represented as a read in the *same* lexical scope as
      // its consumer, rather than a child scope named after the binding.  It
      // is usable only when binding, source body, and that body's named output
      // are each unique.  Do not match same-named bindings in nested scopes.
      const normalizedScope = normalizeName(currentScope);
      const normalizedBinding = normalizeName(qualifier);
      const cteReaders = [...relationSubtree(input.index, relationId)]
        .map((id) => input.index.relations.get(id))
        .filter((relation): relation is RelationRecord => relation !== undefined)
        .filter((relation) =>
          relation.relationType === "read"
          && normalizeName(relation.scopeId ?? "") === normalizedScope
          && relation.binding === normalizedBinding
          && relation.sourceRelationId !== null,
        );
      const cteBodies = new Set(cteReaders.map((reader) => reader.sourceRelationId!));
      if (cteReaders.length !== 1 || cteBodies.size !== 1) return [];
      const cteBody = input.index.relations.get(cteReaders[0]!.sourceRelationId!);
      if (
        !cteBody
        || !cteBody.outputColumns.some((column) => normalizeName(column) === normalizeName(inputName))
      ) return [];
      const next = outputExpression(
        cteBody.relationId, inputName, input.relationExpressionsByRelationId,
      );
      const nextExpression = next && [...(input.expressionsByRelation.get(cteBody.relationId)?.values() ?? [])]
        .filter((item) => normalizeName(String(item.output_name ?? "")) === normalizeName(inputName));
      if (!nextExpression || nextExpression.length !== 1) return [];
      current = nextExpression[0]!;
      continue;
    }
    let sourceId = input.index.relations.get(relationId)?.sourceRelationId ?? null;
    while (sourceId && !visited.has(sourceId)) {
      const source = input.index.relations.get(sourceId);
      if (!source) return [];
      path.push(sourceId);
      if (source.relationType === "setop") {
        const setopOrdinals = source.outputColumns
          .map((column, ordinal) => normalizeName(column) === normalizeName(inputName)
            ? ordinal
            : null)
          .filter((ordinal): ordinal is number => ordinal !== null);
        if (setopOrdinals.length !== 1) return [];
        const setopOrdinal = setopOrdinals[0]!;
        if (!hasCompleteSetopBranchEvidence({
          setopRelation: source,
          ordinal: setopOrdinal,
          expressionsByRelation: input.expressionsByRelation,
          index: input.index,
        })) return [];
        const contexts = expandSetopBranches({
          setopRelation: source,
          ordinal: setopOrdinal,
          expressionsByRelation: input.expressionsByRelation,
          index: input.index,
        });
        return contexts.map((context) => ({
          ...context,
          originExpressionId: originExpressionId ?? undefined,
          routeRelationPath: [...path, context.relationId ?? ""].filter(Boolean),
          routeExpressionHops: [...routeExpressionHops, context.expression],
          routePathHadAggregation,
        })).filter((context) => expressionAcceptsPhysicalSource(
          context.expression, input.sourceTable, input.sourceColumn,
        ));
      }
      // The only non-setop hop observed for this repair is the aggregate that
      // directly supplies the setop output.  Do not treat arbitrary source
      // pointers (and their possible renames) as transparent projections.
      if (source.relationType !== "aggregate") return [];
      routePathHadAggregation = true;
      visited.add(sourceId);
      sourceId = source.sourceRelationId;
    }
    return [];
  }
  return [];
}

/**
 * Router fallback is stricter than the established setop expander.  A missing
 * branch expression or dependency record is unknown, not evidence that the
 * physical field is absent from that branch.  A present `input_fields: []`
 * (or explicit NO_PHYSICAL_INPUT) is the only safe non-dependency.
 */
function hasCompleteSetopBranchEvidence(input: {
  readonly setopRelation: RelationRecord;
  readonly ordinal: number;
  readonly expressionsByRelation: ReadonlyMap<string, ReadonlyMap<number, JsonRecord>>;
  readonly index: RelationTreeIndex;
  readonly seenSetops?: ReadonlySet<string>;
}): boolean {
  const seen = new Set(input.seenSetops ?? []);
  if (seen.has(input.setopRelation.relationId)) return false;
  seen.add(input.setopRelation.relationId);
  if (input.setopRelation.setopBranches.length === 0) return false;
  return input.setopRelation.setopBranches.every((branchRelationId) => {
    const branchRelation = input.index.relations.get(branchRelationId);
    if (!branchRelation) return false;
    if (branchRelation.relationType === "setop") {
      return hasCompleteSetopBranchEvidence({
        setopRelation: branchRelation,
        ordinal: input.ordinal,
        expressionsByRelation: input.expressionsByRelation,
        index: input.index,
        seenSetops: seen,
      });
    }
    const expression = input.expressionsByRelation.get(branchRelationId)?.get(input.ordinal);
    if (!expression) return false;
    const dependencyStatus = text(expression.input_dependency_status);
    const unresolvedInputs = expression.unresolved_input_columns;
    if (
      (Array.isArray(unresolvedInputs) && unresolvedInputs.length > 0)
      || dependencyStatus === "PARTIAL"
      || dependencyStatus === "UNRESOLVED"
      || dependencyStatus === "SQL_CANDIDATE"
    ) return false;
    const inputFields = expression.input_fields;
    if (!Array.isArray(inputFields)) return false;
    // A legacy non-empty list is sufficient evidence for the old producer.
    // An empty list is evidence of no dependency only when the producer says
    // so explicitly; otherwise it is an omitted/incomplete dependency record.
    return inputFields.length > 0 || dependencyStatus === "NO_PHYSICAL_INPUT";
  });
}

function expressionAcceptsPhysicalSource(
  expression: JsonRecord,
  sourceTable: string,
  sourceColumn: string,
): boolean {
  return (Array.isArray(expression.input_fields) ? expression.input_fields : []).some((raw) => {
    const field = record(raw);
    return field !== null
      && normalizeName(String(field.table ?? "")) === normalizeName(sourceTable)
      && normalizeName(String(field.column ?? "")) === normalizeName(sourceColumn);
  });
}

function narrowByQualifiers(input: {
  readonly matches: readonly RelationRecord[];
  readonly qualifiers: readonly string[];
  readonly bindingByReadRelation: ReadonlyMap<string, string>;
}): readonly RelationRecord[] {
  if (input.qualifiers.length === 0 || input.matches.length <= 1) return input.matches;
  const narrowed = input.matches.filter((relation) =>
    input.qualifiers.some((qualifier) =>
      relationMatchesQualifier(relation, qualifier, input.bindingByReadRelation),
    ),
  );
  return narrowed.length > 0 ? narrowed : input.matches;
}

export function resolveSourceReadOccurrence(input: {
  readonly taskId: string;
  readonly expressionId: string;
  readonly sourceTable: string;
  readonly sourceColumn: string;
  readonly inputField: JsonRecord;
  readonly expressionText?: string | null;
  /** A single structured reference, already separated from its sibling inputs. */
  readonly referenceQualifier?: string;
  /** Named CTE output from the branch relation's structured input_columns. */
  readonly cteOutputColumn?: string | null;
  readonly cteRelationQualifier?: string | null;
  readonly leafRelationId: string | null;
  readonly index: RelationTreeIndex;
  readonly readOccurrenceByRelationId: ReadonlyMap<string, string>;
  readonly bindingByReadRelation: ReadonlyMap<string, string>;
}): SourceReadOccurrenceResolution {
  const base = {
    taskId: input.taskId,
    expressionId: input.expressionId,
    sourceTable: input.sourceTable,
    sourceColumn: input.sourceColumn,
  };
  if (!input.leafRelationId) {
    return unresolved({ ...base, reason: "MATERIALIZATION_LEAF_MISSING" });
  }

  const inputQualifier = qualifierFromInput(input.inputField);
  const textQualifiers = expressionQualifiersForColumn(
    input.expressionText,
    input.sourceColumn,
  );
  const qualifiers = [
    ...new Set([
      ...(inputQualifier ? [normalizeName(inputQualifier)] : []),
      ...textQualifiers,
    ]),
  ];

  const candidates = matchingReads({
    index: input.index,
    leafRelationId: input.leafRelationId,
    sourceTable: input.sourceTable,
    sourceColumn: input.sourceColumn,
    cteOutputColumn: input.cteOutputColumn ?? null,
    // Narrow the logical CTE reader before bridging; the body read may use a
    // different alias, so filtering it afterwards would reject valid evidence.
    cteRelationQualifier: input.cteRelationQualifier
      ?? input.referenceQualifier
      ?? null,
    referenceQualifier: input.referenceQualifier ?? null,
    bindingByReadRelation: input.bindingByReadRelation,
  });
  const matches = narrowByQualifiers({
    matches: candidates,
    qualifiers,
    bindingByReadRelation: input.bindingByReadRelation,
  });
  if (matches.length === 1) {
    const relation = matches[0]!;
    const occurrenceId = readOccurrenceIdForRelation(
      input.readOccurrenceByRelationId,
      relation.relationId,
    );
    if (!occurrenceId) {
      return unresolved({ ...base, reason: "CTE_SCOPE_UNRESOLVED" });
    }
    return resolved(occurrenceId, relation.relationId);
  }
  if (matches.length > 1) {
    return ambiguous({ ...base, reason: "SELF_JOIN_NO_QUALIFIER" });
  }
  return unresolved({ ...base, reason: "CTE_SCOPE_UNRESOLVED" });
}

export function expressionsByRelationAndOrdinal(
  expressions: readonly JsonRecord[],
): ReadonlyMap<string, ReadonlyMap<number, JsonRecord>> {
  const byRelation = new Map<string, Map<number, JsonRecord>>();
  for (const expression of expressions) {
    const relationId = text(expression.relation_id);
    const ordinal = numberValue(expression.ordinal);
    if (!relationId || ordinal === null) continue;
    const ordinals = byRelation.get(relationId) ?? new Map<number, JsonRecord>();
    if (!ordinals.has(ordinal)) ordinals.set(ordinal, expression);
    byRelation.set(relationId, ordinals);
  }
  return byRelation;
}

export function expandSetopBranchExpressions(input: {
  readonly expression: JsonRecord;
  readonly expressionsByRelation: ReadonlyMap<string, ReadonlyMap<number, JsonRecord>>;
  readonly index: RelationTreeIndex;
}): readonly FieldExpressionContext[] {
  const expressionId = text(input.expression.expression_id);
  const relationId = text(input.expression.relation_id);
  const ordinal = numberValue(input.expression.ordinal);
  if (!expressionId || !relationId || ordinal === null) {
    return [{
      expressionId,
      expression: input.expression,
      relationId,
      ordinal,
    }].filter((item): item is FieldExpressionContext => item.expressionId !== null);
  }

  const directRelation = input.index.relations.get(relationId);
  if (directRelation?.relationType === "setop") {
    const nested = expandSetopBranches({
      setopRelation: directRelation,
      ordinal,
      expressionsByRelation: input.expressionsByRelation,
      index: input.index,
    });
    return nested.length > 0
      ? nested
      : [{
        expressionId,
        expression: input.expression,
        relationId,
        ordinal,
      }];
  }

  const setopAncestor = nearestSetopAncestor(input.index, relationId);
  if (setopAncestor?.setopBranches.length) {
    const branchContexts = expandSetopBranches({
      setopRelation: setopAncestor,
      ordinal,
      expressionsByRelation: input.expressionsByRelation,
      index: input.index,
    });
    return branchContexts.length > 0
      ? branchContexts
      : [{
        expressionId,
        expression: input.expression,
        relationId,
        ordinal,
      }];
  }

  // A projection can consume a derived setop through a join. Its ordinal is
  // local to the outer projection, so locate the qualified setop and sink by
  // its named output rather than accidentally treating sibling branches as a
  // self-join of the same physical source.
  const outputName = text(input.expression.output_name);
  const qualifiers = outputName
    ? expressionQualifiersForColumn(text(input.expression.expression_text), outputName)
    : [];
  const qualifiedSetop = setopForQualifiedOutput({
    index: input.index,
    relationId,
    qualifiers,
  });
  const setopOrdinal = qualifiedSetop && outputName
    ? uniqueOutputOrdinalInFirstBranch({
      setopRelation: qualifiedSetop,
      outputName,
      expressionsByRelation: input.expressionsByRelation,
    })
    : null;
  if (!qualifiedSetop || setopOrdinal === null || qualifiedSetop.setopBranches.length === 0) {
    return [{
      expressionId,
      expression: input.expression,
      relationId,
      ordinal,
    }];
  }
  const branchContexts = expandSetopBranches({
    setopRelation: qualifiedSetop,
    ordinal: setopOrdinal,
    expressionsByRelation: input.expressionsByRelation,
    index: input.index,
  });
  return branchContexts.length > 0
    ? branchContexts
    : [{
      expressionId,
      expression: input.expression,
      relationId,
      ordinal,
    }];
}

function setopForQualifiedOutput(input: {
  readonly index: RelationTreeIndex;
  readonly relationId: string;
  readonly qualifiers: readonly string[];
}): RelationRecord | null {
  if (input.qualifiers.length === 0) return null;
  const candidates = [...relationSubtree(input.index, input.relationId)]
    .map((relationId) => input.index.relations.get(relationId))
    .filter((relation): relation is RelationRecord =>
      relation?.relationType === "setop"
      && relation.scopeId !== null
      && input.qualifiers.some((qualifier) =>
        normalizeName(relation.scopeId!.split(".").at(-1) ?? "")
          === normalizeName(qualifier)
      )
    );
  return candidates.length === 1 ? candidates[0]! : null;
}

function uniqueOutputOrdinalInFirstBranch(input: {
  readonly setopRelation: RelationRecord;
  readonly outputName: string;
  readonly expressionsByRelation: ReadonlyMap<string, ReadonlyMap<number, JsonRecord>>;
}): number | null {
  const firstBranch = input.setopRelation.setopBranches[0];
  if (!firstBranch) return null;
  const matches = [...(input.expressionsByRelation.get(firstBranch)?.values() ?? [])]
    .filter((expression) =>
      normalizeName(String(expression.output_name ?? ""))
        === normalizeName(input.outputName)
    );
  return matches.length === 1 ? numberValue(matches[0]?.ordinal) : null;
}

function expandSetopBranches(input: {
  readonly setopRelation: RelationRecord;
  readonly ordinal: number;
  readonly expressionsByRelation: ReadonlyMap<string, ReadonlyMap<number, JsonRecord>>;
  readonly index: RelationTreeIndex;
  readonly seenSetops?: ReadonlySet<string>;
}): readonly FieldExpressionContext[] {
  const seen = new Set(input.seenSetops ?? []);
  if (seen.has(input.setopRelation.relationId)) return [];
  seen.add(input.setopRelation.relationId);

  const contexts: FieldExpressionContext[] = [];
  for (const branchRelationId of input.setopRelation.setopBranches) {
    const branchRelation = input.index.relations.get(branchRelationId);
    if (branchRelation?.relationType === "setop") {
      contexts.push(...expandSetopBranches({
        setopRelation: branchRelation,
        ordinal: input.ordinal,
        expressionsByRelation: input.expressionsByRelation,
        index: input.index,
        seenSetops: seen,
      }));
      continue;
    }

    const branchExpression = input.expressionsByRelation
      .get(branchRelationId)
      ?.get(input.ordinal);
    if (!branchExpression) continue;
    const expressionId = text(branchExpression.expression_id);
    if (!expressionId) continue;
    const expressionRelationId = text(branchExpression.relation_id) ?? branchRelationId;
    const expressionRelation = input.index.relations.get(expressionRelationId);
    if (expressionRelation?.relationType === "setop") {
      contexts.push(...expandSetopBranches({
        setopRelation: expressionRelation,
        ordinal: numberValue(branchExpression.ordinal) ?? input.ordinal,
        expressionsByRelation: input.expressionsByRelation,
        index: input.index,
        seenSetops: seen,
      }));
      continue;
    }
    contexts.push({
      expressionId,
      expression: branchExpression,
      relationId: expressionRelationId,
      ordinal: numberValue(branchExpression.ordinal),
    });
  }
  return contexts;
}

export function leafRelationIdForExpression(
  expression: JsonRecord,
  materializedLeafRelationId: string | null,
): string | null {
  return materializedLeafRelationId ?? text(expression.relation_id);
}
