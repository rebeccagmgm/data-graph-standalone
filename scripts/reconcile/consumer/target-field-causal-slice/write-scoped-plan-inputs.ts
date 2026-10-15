import {
  canonicalJson,
  datasetId,
  fieldId,
  sha256,
} from "../../../machine-facts/machine-facts-contract.ts";
import type {
  CurrentBundleLoad,
  JsonRecord,
} from "../../../query/current-task-bundle.ts";
import {
  localExpressionId,
  localRelationId,
} from "../../../machine-facts/plan-occurrence-id.ts";
import {
  isCanonicalTargetWriteBundle,
  resolveCanonicalTargetWriteOccurrence,
} from "../target-write-evidence-resolver.ts";

export interface RootCriterion {
  readonly rootCriterionId: string;
  readonly rootTaskId: string;
  readonly targetTableKey: string;
  readonly targetFieldName: string;
  /** Canonical physical-field key used by the causal graph. */
  readonly rootTargetFieldId: string;
  /** Machine Facts field id proving the output-field binding. */
  readonly targetFieldBindingId: string;
  readonly rootWriteObservationId: string;
  readonly writeKind: string;
  readonly sqlSourceId: string;
  readonly sqlSnapshot: string;
  readonly sqlSha256: string;
  readonly writeStatementId: string;
  readonly writeStatementIndex: number;
  readonly statementId: string;
  readonly statementIndex: number;
  readonly queryProducerStatementId: string;
  readonly rootRelationId: string;
  readonly outputExpressionId: string;
  readonly outputBindingId: string;
  readonly sourceOrdinal: number;
  readonly targetOrdinal: number;
  readonly producerOutputName: string | null;
  readonly expressionRole: string;
  readonly localRootRelationId: string;
  readonly localOutputExpressionId: string;
  readonly evidenceRefs: readonly string[];
}

export type WriteScopedPlanInputGapReason =
  | "BUNDLE_NOT_CURRENT"
  | "MANIFEST_SQL_SOURCE_MISSING"
  | "TARGET_TABLE_KEY_INVALID"
  | "WRITE_OBSERVATION_MISSING"
  | "WRITE_OBSERVATION_CONFLICT"
  | "WRITE_TARGET_MISMATCH"
  | "WRITE_STATEMENT_MISSING"
  | "WRITE_STATEMENT_CONFLICT"
  | "QUERY_STATEMENT_MISSING"
  | "QUERY_STATEMENT_CONFLICT"
  | "OUTPUT_BINDING_MISSING"
  | "OUTPUT_BINDING_CONFLICT"
  | "OUTPUT_EXPRESSION_MISSING"
  | "OUTPUT_EXPRESSION_CONFLICT"
  | "ROOT_RELATION_MISSING"
  | "ROOT_RELATION_CONFLICT"
  | "SCOPE_EVIDENCE_CONTRADICTORY"
  | "PHYSICAL_ROOT_FIELD_UNRESOLVED"
  | "SQL_SNAPSHOT_MISSING_OR_UNSAFE"
  | "SQL_SNAPSHOT_HASH_MISMATCH"
  | "PLAN_STATEMENT_MISSING"
  | "PLAN_SCOPE_MISMATCH"
  | "PLAN_BUILD_FAILED";

export interface WriteScopedPlanInputGap {
  readonly gapId: string;
  readonly reasonCode: WriteScopedPlanInputGapReason;
  readonly rootCriterionId: string | null;
  readonly taskId: string;
  readonly targetTableKey: string;
  readonly writeObservationId: string | null;
  readonly targetFieldName: string | null;
  readonly message: string;
  readonly evidenceRefs: readonly string[];
  readonly blocksConfirmedCausality: true;
  readonly blocksNegativeProof: true;
}

export interface ResolveWriteScopedPlanInputsInput {
  readonly taskId: string;
  readonly targetTableKey: string;
  readonly writeObservationIds: readonly string[];
  /** Empty means every exactly resolved target field for each selected write. */
  readonly requestedTargetFields: readonly string[];
  readonly load: CurrentBundleLoad;
  /**
   * Resolve the richer physical identity at the catalog boundary. Machine Facts'
   * target_field_id is binding evidence and must never be used as its substitute.
   */
  readonly resolveRootTargetFieldId: (
    targetFieldName: string,
    bindingRecord: Readonly<JsonRecord>,
  ) => string | null;
}

export interface WriteScopedPlanInputResolution {
  readonly rootCriteria: readonly RootCriterion[];
  readonly gaps: readonly WriteScopedPlanInputGap[];
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function normalized(value: unknown): string {
  return text(value)?.toLowerCase() ?? "";
}

function refs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function records(load: CurrentBundleLoad, name: string): readonly JsonRecord[] {
  return load.records[name] ?? [];
}

function targetDatasetFromKey(targetTableKey: string): string | null {
  const parts = targetTableKey.split("|").map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  return parts[2]!.toLowerCase();
}

function manifestSqlSource(load: CurrentBundleLoad, taskId: string): {
  readonly sqlSourceId: string;
  readonly sqlSnapshot: string;
  readonly sqlSha256: string;
  readonly logicalSourceId: string;
} | null {
  const manifest = load.manifest ?? {};
  const inputs = typeof manifest.inputs === "object" && manifest.inputs !== null
    ? manifest.inputs as JsonRecord
    : {};
  const sqlSha256 = text(inputs.sql_sha256);
  const sqlSnapshot = text(inputs.sql_snapshot);
  const logicalSourceId = text(manifest.logical_source_id);
  if (!sqlSha256 || !sqlSnapshot || !logicalSourceId) return null;
  return {
    sqlSourceId: `sql:${taskId}:${sqlSha256}`,
    sqlSnapshot,
    sqlSha256,
    logicalSourceId,
  };
}

export function makeWriteScopedPlanInputGap(input: {
  readonly rootCriterionId?: string | null;
  readonly taskId: string;
  readonly targetTableKey: string;
  readonly writeObservationId?: string | null;
  readonly targetFieldName?: string | null;
  readonly reasonCode: WriteScopedPlanInputGapReason;
  readonly message: string;
  readonly evidenceRefs?: readonly string[];
}): WriteScopedPlanInputGap {
  const identity = {
    rootCriterionId: input.rootCriterionId ?? null,
    taskId: input.taskId,
    targetTableKey: input.targetTableKey,
    writeObservationId: input.writeObservationId ?? null,
    targetFieldName: input.targetFieldName ?? null,
    reasonCode: input.reasonCode,
    message: input.message,
  };
  return {
    gapId: `write-scope-gap:${sha256(canonicalJson(identity))}`,
    ...identity,
    evidenceRefs: unique(input.evidenceRefs ?? []),
    blocksConfirmedCausality: true,
    blocksNegativeProof: true,
  };
}

const makeGap = makeWriteScopedPlanInputGap;

function evidenceFor(
  load: CurrentBundleLoad,
  taskId: string,
  file: string,
  row?: JsonRecord,
): readonly string[] {
  return unique([
    `machine-facts:${taskId}:${file}`,
    ...(text(load.evidence[file]) ? [text(load.evidence[file])!] : []),
    ...refs(row?.evidence_refs),
  ]);
}

function exactRecord(
  rows: readonly JsonRecord[],
  predicate: (row: JsonRecord) => boolean,
): { readonly row: JsonRecord | null; readonly count: number } {
  const matches = rows.filter(predicate);
  return { row: matches.length === 1 ? matches[0]! : null, count: matches.length };
}

export function canonicalRootCriterionId(
  input: Omit<RootCriterion, "rootCriterionId"> | RootCriterion,
): string {
  const identity = {
    rootTaskId: input.rootTaskId,
    targetTableKey: input.targetTableKey,
    targetFieldName: input.targetFieldName,
    rootTargetFieldId: input.rootTargetFieldId,
    targetFieldBindingId: input.targetFieldBindingId,
    rootWriteObservationId: input.rootWriteObservationId,
    sqlSourceId: input.sqlSourceId,
    writeStatementId: input.writeStatementId,
    writeStatementIndex: input.writeStatementIndex,
    statementId: input.statementId,
    statementIndex: input.statementIndex,
    queryProducerStatementId: input.queryProducerStatementId,
    rootRelationId: input.rootRelationId,
    outputExpressionId: input.outputExpressionId,
    outputBindingId: input.outputBindingId,
    sourceOrdinal: input.sourceOrdinal,
    targetOrdinal: input.targetOrdinal,
    producerOutputName: input.producerOutputName,
    expressionRole: input.expressionRole,
    localRootRelationId: input.localRootRelationId,
    localOutputExpressionId: input.localOutputExpressionId,
  };
  return `root-criterion:${sha256(canonicalJson(identity))}`;
}

function rootCriterion(input: Omit<RootCriterion, "rootCriterionId">): RootCriterion {
  return {
    ...input,
    rootCriterionId: canonicalRootCriterionId(input),
  };
}

/**
 * Resolve causal Plan inputs only through an exact Machine Facts occurrence
 * chain: write -> output binding -> expression -> relation -> statement.
 */
export function resolveWriteScopedPlanInputs(
  input: ResolveWriteScopedPlanInputsInput,
): WriteScopedPlanInputResolution {
  const gaps: WriteScopedPlanInputGap[] = [];
  const criteria: RootCriterion[] = [];
  const addGap = (value: WriteScopedPlanInputGap): void => {
    gaps.push(value);
  };

  if (!isCanonicalTargetWriteBundle(input.load, input.taskId)) {
    addGap(makeGap({
      taskId: input.taskId,
      targetTableKey: input.targetTableKey,
      reasonCode: "BUNDLE_NOT_CURRENT",
      message: `current Machine Facts bundle is unavailable for task ${input.taskId}`,
      evidenceRefs: input.load.issues,
    }));
    return { rootCriteria: [], gaps };
  }
  const sqlSource = manifestSqlSource(input.load, input.taskId);
  if (!sqlSource) {
    addGap(makeGap({
      taskId: input.taskId,
      targetTableKey: input.targetTableKey,
      reasonCode: "MANIFEST_SQL_SOURCE_MISSING",
      message: "Machine Facts manifest does not identify one immutable SQL snapshot",
      evidenceRefs: evidenceFor(input.load, input.taskId, "manifest.json"),
    }));
    return { rootCriteria: [], gaps };
  }
  const targetDataset = targetDatasetFromKey(input.targetTableKey);
  if (!targetDataset) {
    addGap(makeGap({
      taskId: input.taskId,
      targetTableKey: input.targetTableKey,
      reasonCode: "TARGET_TABLE_KEY_INVALID",
      message: `target table key is not a canonical platform|dataSource|qualifiedName key: ${input.targetTableKey}`,
    }));
    return { rootCriteria: [], gaps };
  }

  const relations = records(input.load, "relation-nodes.jsonl");
  const expressions = records(input.load, "field-expression-nodes.jsonl");
  const requestedWrites = unique(input.writeObservationIds);
  const requestedTargetFields = unique(
    input.requestedTargetFields.map((field) => field.toLowerCase()),
  );
  if (requestedWrites.length === 0) {
    addGap(makeGap({
      taskId: input.taskId,
      targetTableKey: input.targetTableKey,
      reasonCode: "WRITE_OBSERVATION_MISSING",
      message: "at least one explicit write observation is required",
    }));
    return { rootCriteria: [], gaps };
  }

  for (const writeObservationId of requestedWrites) {
    const canonical = resolveCanonicalTargetWriteOccurrence({
      taskId: input.taskId,
      targetTable: targetDataset,
      writeObservationIds: [writeObservationId],
      load: input.load,
    });
    if (!canonical.occurrence) {
      if (canonical.reasonCode === "OUTPUT_BINDING_MISSING") {
        const fields = requestedTargetFields.length > 0
          ? requestedTargetFields
          : [null];
        for (const targetFieldName of fields) {
          addGap(makeGap({
            taskId: input.taskId,
            targetTableKey: input.targetTableKey,
            writeObservationId,
            targetFieldName,
            reasonCode: "OUTPUT_BINDING_MISSING",
            message: targetFieldName
              ? `target field ${targetFieldName} is not bound for write ${writeObservationId}`
              : `write observation ${writeObservationId} has no resolved target-field binding`,
            evidenceRefs: canonical.evidenceRefs,
          }));
        }
        continue;
      }

      if (canonical.reasonCode === "ROOT_RELATION_UNMAPPED") {
        const rawWriteBindings = records(
          input.load,
          "output-field-bindings.jsonl",
        ).filter((row) =>
          text(row.task_id) === input.taskId &&
          text(row.write_observation_id) === writeObservationId &&
          normalized(row.target_dataset) === targetDataset &&
          normalized(row.binding_status) === "resolved"
        );
        const fields = requestedTargetFields.length > 0
          ? requestedTargetFields
          : unique(
            rawWriteBindings.map((row) => normalized(row.target_field)).filter(
              Boolean,
            ),
          );
        const conflictingFields = fields.filter((field) =>
          rawWriteBindings.filter((row) => normalized(row.target_field) === field)
              .length > 1
        );
        if (conflictingFields.length > 0) {
          for (const targetFieldName of conflictingFields) {
            addGap(makeGap({
              taskId: input.taskId,
              targetTableKey: input.targetTableKey,
              writeObservationId,
              targetFieldName,
              reasonCode: "OUTPUT_BINDING_CONFLICT",
              message: `target field ${targetFieldName} has multiple bindings for write ${writeObservationId}`,
              evidenceRefs: canonical.evidenceRefs,
            }));
          }
        } else {
          for (const targetFieldName of fields.length > 0 ? fields : [null]) {
            addGap(makeGap({
              taskId: input.taskId,
              targetTableKey: input.targetTableKey,
              writeObservationId,
              targetFieldName,
              reasonCode: "SCOPE_EVIDENCE_CONTRADICTORY",
              message: `write observation ${writeObservationId} does not resolve to one canonical root relation`,
              evidenceRefs: canonical.evidenceRefs,
            }));
          }
        }
        continue;
      }

      const reasonCode: WriteScopedPlanInputGapReason =
        canonical.reasonCode === "WRITE_OBSERVATION_MISSING"
          ? "WRITE_OBSERVATION_MISSING"
          : canonical.reasonCode === "WRITE_OBSERVATION_CONFLICT"
          ? "WRITE_OBSERVATION_CONFLICT"
          : canonical.reasonCode === "WRITE_TARGET_MISMATCH"
          ? "WRITE_TARGET_MISMATCH"
          : canonical.reasonCode === "WRITE_STATEMENT_RECORD_CONFLICT"
          ? "WRITE_STATEMENT_CONFLICT"
          : canonical.reasonCode === "QUERY_STATEMENT_RECORD_CONFLICT"
          ? "QUERY_STATEMENT_CONFLICT"
          : canonical.reasonCode === "BUNDLE_NOT_CANONICAL"
          ? "BUNDLE_NOT_CURRENT"
          : "SCOPE_EVIDENCE_CONTRADICTORY";
      addGap(makeGap({
        taskId: input.taskId,
        targetTableKey: input.targetTableKey,
        writeObservationId,
        reasonCode,
        message: `write observation ${writeObservationId} has incomplete or contradictory canonical occurrence evidence (${canonical.reasonCode})`,
        evidenceRefs: canonical.evidenceRefs,
      }));
      continue;
    }
    const occurrence = canonical.occurrence;
    const write = occurrence.writeRecord;
    const expectedDatasetId = datasetId(sqlSource.logicalSourceId, targetDataset);
    if (
      normalized(write.physical_dataset) !== targetDataset ||
      text(write.dataset_id) !== expectedDatasetId
    ) {
      addGap(makeGap({
        taskId: input.taskId,
        targetTableKey: input.targetTableKey,
        writeObservationId,
        reasonCode: "WRITE_TARGET_MISMATCH",
        message: `write observation ${writeObservationId} does not target ${targetDataset}`,
        evidenceRefs: evidenceFor(input.load, input.taskId, "dataset-io.jsonl", write),
      }));
      continue;
    }

    const writeStatementId = occurrence.writeStatementId;
    const queryStatementId = occurrence.queryProducerStatementId;
    if (
      !writeStatementId || !queryStatementId ||
      text(write.statement_id) !== writeStatementId ||
      write.field_producing !== true ||
      text(write.producer_enumeration_status) !== "COMPLETE"
    ) {
      addGap(makeGap({
        taskId: input.taskId,
        targetTableKey: input.targetTableKey,
        writeObservationId,
        reasonCode: "SCOPE_EVIDENCE_CONTRADICTORY",
        message: `write observation ${writeObservationId} lacks a consistent write/query statement chain`,
        evidenceRefs: evidenceFor(input.load, input.taskId, "dataset-io.jsonl", write),
      }));
      continue;
    }

    const writeStatement = occurrence.statementRecord;
    if (!writeStatement) {
      addGap(makeGap({
        taskId: input.taskId,
        targetTableKey: input.targetTableKey,
        writeObservationId,
        reasonCode: "WRITE_STATEMENT_MISSING",
        message: `write statement ${writeStatementId} has no canonical record`,
        evidenceRefs: evidenceFor(input.load, input.taskId, "statements.jsonl"),
      }));
      continue;
    }
    const queryStatement = occurrence.queryStatementRecord;
    if (!queryStatement) {
      addGap(makeGap({
        taskId: input.taskId,
        targetTableKey: input.targetTableKey,
        writeObservationId,
        reasonCode: "QUERY_STATEMENT_MISSING",
        message: `query producer statement ${queryStatementId} has no canonical record`,
        evidenceRefs: evidenceFor(input.load, input.taskId, "statements.jsonl"),
      }));
      continue;
    }
    const writeStatementIndex = integer(writeStatement.statement_index);
    const statementIndex = integer(queryStatement.statement_index);
    if (
      writeStatementIndex === null || statementIndex === null ||
      normalized(writeStatement.parse_status) !== "success" ||
      normalized(queryStatement.parse_status) !== "success"
    ) {
      addGap(makeGap({
        taskId: input.taskId,
        targetTableKey: input.targetTableKey,
        writeObservationId,
        reasonCode: "SCOPE_EVIDENCE_CONTRADICTORY",
        message: "write/query statement index is absent or invalid",
        evidenceRefs: evidenceFor(input.load, input.taskId, "statements.jsonl"),
      }));
      continue;
    }

    const writeBindings = occurrence.bindings;
    const targetFields = requestedTargetFields.length > 0
      ? requestedTargetFields
      : unique(writeBindings.map((row) => normalized(row.target_field)).filter(Boolean));
    if (targetFields.length === 0) {
      addGap(makeGap({
        taskId: input.taskId,
        targetTableKey: input.targetTableKey,
        writeObservationId,
        reasonCode: "OUTPUT_BINDING_MISSING",
        message: `write observation ${writeObservationId} has no resolved target-field binding`,
        evidenceRefs: evidenceFor(input.load, input.taskId, "output-field-bindings.jsonl"),
      }));
      continue;
    }

    for (const targetFieldName of targetFields) {
      const bindingMatch = exactRecord(writeBindings, (row) =>
        normalized(row.target_field) === targetFieldName,
      );
      if (!bindingMatch.row) {
        addGap(makeGap({
          taskId: input.taskId,
          targetTableKey: input.targetTableKey,
          writeObservationId,
          targetFieldName,
          reasonCode: bindingMatch.count === 0
            ? "OUTPUT_BINDING_MISSING"
            : "OUTPUT_BINDING_CONFLICT",
          message: bindingMatch.count === 0
            ? `target field ${targetFieldName} is not bound for write ${writeObservationId}`
            : `target field ${targetFieldName} has ${bindingMatch.count} bindings for write ${writeObservationId}`,
          evidenceRefs: evidenceFor(input.load, input.taskId, "output-field-bindings.jsonl"),
        }));
        continue;
      }
      const binding = bindingMatch.row;
      const bindingId = text(binding.binding_id);
      const targetFieldBindingId = text(binding.target_field_id);
      const expressionId = text(binding.expression_id);
      const sourceOrdinal = integer(binding.source_ordinal);
      const targetOrdinal = integer(binding.target_ordinal);
      const expectedTargetFieldBindingId = fieldId(
        sqlSource.logicalSourceId,
        targetDataset,
        targetFieldName,
      );
      if (
        !bindingId || !targetFieldBindingId || !expressionId ||
        sourceOrdinal === null || targetOrdinal === null ||
        text(binding.target_dataset_id) !== expectedDatasetId ||
        targetFieldBindingId !== expectedTargetFieldBindingId ||
        text(binding.write_kind) !== text(write.write_kind) ||
        text(binding.write_statement_id) !== writeStatementId ||
        text(binding.statement_id) !== writeStatementId ||
        text(binding.query_producer_statement_id) !== queryStatementId
      ) {
        addGap(makeGap({
          taskId: input.taskId,
          targetTableKey: input.targetTableKey,
          writeObservationId,
          targetFieldName,
          reasonCode: "SCOPE_EVIDENCE_CONTRADICTORY",
          message: `output binding for ${targetFieldName} does not preserve the selected write/query occurrence`,
          evidenceRefs: evidenceFor(input.load, input.taskId, "output-field-bindings.jsonl", binding),
        }));
        continue;
      }

      const expressionMatch = exactRecord(expressions, (row) =>
        text(row.task_id) === input.taskId && text(row.expression_id) === expressionId,
      );
      if (!expressionMatch.row) {
        addGap(makeGap({
          taskId: input.taskId,
          targetTableKey: input.targetTableKey,
          writeObservationId,
          targetFieldName,
          reasonCode: expressionMatch.count === 0
            ? "OUTPUT_EXPRESSION_MISSING"
            : "OUTPUT_EXPRESSION_CONFLICT",
          message: `output expression ${expressionId} has ${expressionMatch.count} canonical records`,
          evidenceRefs: evidenceFor(input.load, input.taskId, "field-expression-nodes.jsonl"),
        }));
        continue;
      }
      const expression = expressionMatch.row;
      const relationId = text(expression.relation_id);
      const expressionOrdinal = integer(expression.ordinal);
      const expressionRole = text(expression.role);
      const producerOutputName = text(expression.output_name);
      if (
        !relationId || !expressionRole || expressionOrdinal === null ||
        relationId !== occurrence.rootRelationId ||
        expressionOrdinal !== sourceOrdinal ||
        text(expression.statement_id) !== queryStatementId ||
        text(expression.artifact_id) !== sqlSource.sqlSourceId
      ) {
        addGap(makeGap({
          taskId: input.taskId,
          targetTableKey: input.targetTableKey,
          writeObservationId,
          targetFieldName,
          reasonCode: "SCOPE_EVIDENCE_CONTRADICTORY",
          message: `output expression ${expressionId} is outside the selected query statement or SQL snapshot`,
          evidenceRefs: evidenceFor(input.load, input.taskId, "field-expression-nodes.jsonl", expression),
        }));
        continue;
      }

      const relationMatch = exactRecord(relations, (row) =>
        text(row.task_id) === input.taskId && text(row.relation_id) === relationId,
      );
      if (!relationMatch.row) {
        addGap(makeGap({
          taskId: input.taskId,
          targetTableKey: input.targetTableKey,
          writeObservationId,
          targetFieldName,
          reasonCode: relationMatch.count === 0
            ? "ROOT_RELATION_MISSING"
            : "ROOT_RELATION_CONFLICT",
          message: `root relation ${relationId} has ${relationMatch.count} canonical records`,
          evidenceRefs: evidenceFor(input.load, input.taskId, "relation-nodes.jsonl"),
        }));
        continue;
      }
      const relation = relationMatch.row;
      const localRootRelationId = localRelationId(
        input.taskId,
        statementIndex,
        relationId,
      );
      const localOutputExpressionId = localExpressionId(
        input.taskId,
        statementIndex,
        expressionId,
      );
      if (
        text(relation.statement_id) !== queryStatementId ||
        !localRootRelationId ||
        !localOutputExpressionId ||
        !localOutputExpressionId.startsWith(`${localRootRelationId}:expression:`)
      ) {
        addGap(makeGap({
          taskId: input.taskId,
          targetTableKey: input.targetTableKey,
          writeObservationId,
          targetFieldName,
          reasonCode: "SCOPE_EVIDENCE_CONTRADICTORY",
          message: `relation/expression identity does not match statement index ${statementIndex}`,
          evidenceRefs: [
            ...evidenceFor(input.load, input.taskId, "relation-nodes.jsonl", relation),
            ...evidenceFor(input.load, input.taskId, "field-expression-nodes.jsonl", expression),
          ],
        }));
        continue;
      }

      let rootTargetFieldId: string | null = null;
      try {
        rootTargetFieldId = text(input.resolveRootTargetFieldId(targetFieldName, binding));
      } catch {
        rootTargetFieldId = null;
      }
      if (!rootTargetFieldId) {
        addGap(makeGap({
          taskId: input.taskId,
          targetTableKey: input.targetTableKey,
          writeObservationId,
          targetFieldName,
          reasonCode: "PHYSICAL_ROOT_FIELD_UNRESOLVED",
          message: `target field ${targetFieldName} cannot be mapped to one canonical physical field`,
          evidenceRefs: evidenceFor(input.load, input.taskId, "output-field-bindings.jsonl", binding),
        }));
        continue;
      }

      criteria.push(rootCriterion({
        rootTaskId: input.taskId,
        targetTableKey: input.targetTableKey.toLowerCase(),
        targetFieldName,
        rootTargetFieldId,
        targetFieldBindingId,
        rootWriteObservationId: writeObservationId,
        writeKind: text(write.write_kind) ?? "UNKNOWN",
        sqlSourceId: sqlSource.sqlSourceId,
        sqlSnapshot: sqlSource.sqlSnapshot,
        sqlSha256: sqlSource.sqlSha256,
        writeStatementId,
        writeStatementIndex,
        statementId: queryStatementId,
        statementIndex,
        queryProducerStatementId: queryStatementId,
        rootRelationId: relationId,
        outputExpressionId: expressionId,
        outputBindingId: bindingId,
        sourceOrdinal,
        targetOrdinal,
        producerOutputName,
        expressionRole,
        localRootRelationId,
        localOutputExpressionId,
        evidenceRefs: unique([
          sqlSource.sqlSourceId,
          writeObservationId,
          writeStatementId,
          queryStatementId,
          relationId,
          expressionId,
          bindingId,
          targetFieldBindingId,
          ...occurrence.evidenceRefs,
          ...evidenceFor(input.load, input.taskId, "manifest.json"),
          ...evidenceFor(input.load, input.taskId, "dataset-io.jsonl", write),
          ...evidenceFor(input.load, input.taskId, "statements.jsonl"),
          ...evidenceFor(input.load, input.taskId, "relation-nodes.jsonl", relation),
          ...evidenceFor(input.load, input.taskId, "field-expression-nodes.jsonl", expression),
          ...evidenceFor(input.load, input.taskId, "output-field-bindings.jsonl", binding),
        ]),
      }));
    }
  }

  return {
    rootCriteria: criteria.sort((left, right) => left.rootCriterionId.localeCompare(right.rootCriterionId)),
    gaps: gaps.sort((left, right) => left.gapId.localeCompare(right.gapId)),
  };
}
