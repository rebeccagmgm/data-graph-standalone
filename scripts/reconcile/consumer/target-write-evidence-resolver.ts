import type {
  CurrentBundleLoad,
  JsonRecord,
} from "../../query/current-task-bundle.ts";
import { MACHINE_FACTS_CONTRACT_VERSION } from "../../machine-facts/machine-facts-contract.ts";

export type CanonicalTargetWriteFailureReason =
  | "BUNDLE_NOT_CANONICAL"
  | "WRITE_OBSERVATION_REQUIRED"
  | "OUTPUT_BINDING_MISSING"
  | "WRITE_OBSERVATION_AMBIGUOUS"
  | "WRITE_OBSERVATION_MISSING"
  | "WRITE_OBSERVATION_CONFLICT"
  | "WRITE_TARGET_MISMATCH"
  | "STATEMENT_CHAIN_CONFLICT"
  | "WRITE_STATEMENT_RECORD_CONFLICT"
  | "QUERY_STATEMENT_RECORD_CONFLICT"
  | "STATEMENT_OCCURRENCE_AMBIGUOUS"
  | "ROOT_RELATION_UNMAPPED";

export interface CanonicalTargetWriteOccurrence {
  readonly taskId: string;
  readonly targetTable: string;
  readonly writeObservationId: string;
  readonly writeRecord: JsonRecord;
  readonly writeStatementId: string;
  readonly queryProducerStatementId: string | null;
  /** The write statement retained by the target-table consumer's identity. */
  readonly statementId: string;
  readonly sqlSourceId: string;
  readonly statementOrdinal: number;
  readonly statementRecord: JsonRecord | null;
  readonly statementIndex: number;
  readonly queryStatementRecord: JsonRecord | null;
  readonly queryStatementIndex: number | null;
  readonly rootRelationId: string;
  readonly expressionIds: readonly string[];
  readonly bindingIds: readonly string[];
  readonly targetOrdinals: readonly number[];
  readonly bindings: readonly JsonRecord[];
  readonly taskWriteOrdinal: number;
  readonly evidenceRefs: readonly string[];
}

export interface CanonicalTargetWriteResolution {
  readonly occurrence: CanonicalTargetWriteOccurrence | null;
  readonly reasonCode: CanonicalTargetWriteFailureReason | null;
  readonly observedWriteObservationIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface ResolveCanonicalTargetWriteInput {
  readonly taskId: string;
  readonly targetTable: string;
  readonly writeObservationIds: readonly string[];
  readonly load: CurrentBundleLoad;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalized(value: unknown): string {
  return text(value)?.toLowerCase() ?? "";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function records(load: CurrentBundleLoad, name: string): readonly JsonRecord[] {
  return load.records[name] ?? [];
}

function refsOf(value: unknown): readonly string[] {
  if (Array.isArray(value))
    return unique(value.flatMap((item) =>
      typeof item === "string" && item.trim().length > 0
        ? [item.trim()]
        : refsOf(item)
    ));
  if (typeof value !== "object" || value === null) return [];
  const source = value as JsonRecord;
  const ref = text(source.refId) ?? text(source.locator) ?? text(source.source);
  return ref ? [ref] : [];
}

function evidenceRefs(
  load: CurrentBundleLoad,
  taskId: string,
  fileName: string,
  rows: readonly JsonRecord[],
): readonly string[] {
  return unique([
    `machine-facts:${taskId}:${fileName}`,
    ...(text(load.evidence[fileName]) ? [text(load.evidence[fileName])!] : []),
    ...rows.flatMap((row) => [
      ...refsOf(row.evidence_refs),
      ...refsOf(row.evidence),
    ]),
  ]);
}

/**
 * The publisher currently emits contract 1.3 bundles that the generic reader
 * labels LEGACY_NOT_L1. They are canonical for read-only consumers only when
 * the manifest still declares the active publisher contract.
 */
export function isCanonicalTargetWriteBundle(
  load: CurrentBundleLoad,
  taskId: string,
): boolean {
  if (load.taskId !== taskId) return false;
  if (load.state === "CURRENT_L1") return true;
  return load.state === "LEGACY_NOT_L1" &&
    load.manifest?.schema_version === MACHINE_FACTS_CONTRACT_VERSION;
}

function statementOrdinal(statementId: string): number | null {
  const match = statementId.match(/(?:^|:)statement:(\d+)(?::|$)/i);
  return match ? Number(match[1]) : null;
}

function sqlSourceId(statementId: string): string {
  const match = statementId.match(/^(.*?):statement:\d+(?::|$)/i);
  return match?.[1] ?? statementId;
}

function relationFromExpression(expressionId: string | null): string | null {
  if (!expressionId) return null;
  const marker = ":expression:";
  const index = expressionId.indexOf(marker);
  return index > 0 ? expressionId.slice(0, index) : null;
}

function failure(
  reasonCode: CanonicalTargetWriteFailureReason,
  observedWriteObservationIds: readonly string[],
  evidence: readonly string[],
): CanonicalTargetWriteResolution {
  return {
    occurrence: null,
    reasonCode,
    observedWriteObservationIds: unique(observedWriteObservationIds),
    evidenceRefs: unique(evidence),
  };
}

/**
 * Resolve only canonical Machine Facts occurrences. This primitive deliberately
 * does not validate field-level dataset ids, expression records, or relation
 * records; the stricter field consumer retains those additional gates.
 */
export function resolveCanonicalTargetWriteOccurrence(
  input: ResolveCanonicalTargetWriteInput,
): CanonicalTargetWriteResolution {
  if (!isCanonicalTargetWriteBundle(input.load, input.taskId))
    return failure("BUNDLE_NOT_CANONICAL", [], input.load.issues);

  const requested = unique(input.writeObservationIds.map((value) => value.trim()));
  if (requested.length === 0)
    return failure("WRITE_OBSERVATION_REQUIRED", [], []);

  const targetTable = normalized(input.targetTable);
  const allBindings = records(input.load, "output-field-bindings.jsonl").filter(
    (binding) =>
      text(binding.task_id) === input.taskId &&
      normalized(binding.target_dataset) === targetTable &&
      normalized(binding.binding_status) === "resolved",
  );
  const observedWriteObservationIds = unique(
    allBindings.flatMap((binding) => {
      const id = text(binding.write_observation_id);
      return id ? [id] : [];
    }),
  );
  const requestedSet = new Set(requested);
  const bindings = allBindings.filter((binding) => {
    const id = text(binding.write_observation_id);
    return id !== null && requestedSet.has(id);
  });
  const bindingEvidence = evidenceRefs(
    input.load,
    input.taskId,
    "output-field-bindings.jsonl",
    bindings,
  );
  if (bindings.length === 0)
    return failure(
      "OUTPUT_BINDING_MISSING",
      observedWriteObservationIds,
      bindingEvidence,
    );

  const selectedWriteIds = unique(bindings.flatMap((binding) => {
    const id = text(binding.write_observation_id);
    return id ? [id] : [];
  }));
  if (selectedWriteIds.length !== 1)
    return failure(
      "WRITE_OBSERVATION_AMBIGUOUS",
      observedWriteObservationIds,
      bindingEvidence,
    );
  const writeObservationId = selectedWriteIds[0]!;

  const allWrites = records(input.load, "dataset-io.jsonl").filter(
    (row) =>
      text(row.task_id) === input.taskId && normalized(row.direction) === "write",
  );
  const writeMatches = allWrites.filter(
    (row) => text(row.write_observation_id) === writeObservationId,
  );
  const writeEvidence = evidenceRefs(
    input.load,
    input.taskId,
    "dataset-io.jsonl",
    writeMatches,
  );
  if (writeMatches.length === 0)
    return failure(
      "WRITE_OBSERVATION_MISSING",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );
  if (writeMatches.length !== 1)
    return failure(
      "WRITE_OBSERVATION_CONFLICT",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );
  if (normalized(writeMatches[0]!.physical_dataset) !== targetTable)
    return failure(
      "WRITE_TARGET_MISMATCH",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );

  const bindingWriteStatementIds = unique(bindings.flatMap((binding) => {
    const id = text(binding.write_statement_id);
    return id ? [id] : [];
  }));
  if (bindingWriteStatementIds.length !== 1)
    return failure(
      "STATEMENT_OCCURRENCE_AMBIGUOUS",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );
  const writeStatementId = bindingWriteStatementIds[0]!;
  const writeRecordStatementId = text(writeMatches[0]!.write_statement_id);
  if (!writeRecordStatementId || writeRecordStatementId !== writeStatementId)
    return failure(
      "STATEMENT_CHAIN_CONFLICT",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );
  const bindingStatementConflict = bindings.some((binding) => {
    const statementId = text(binding.statement_id);
    return statementId !== null && statementId !== writeStatementId;
  });
  const writeRecordStatementConflict = text(writeMatches[0]!.statement_id) !==
    null && text(writeMatches[0]!.statement_id) !== writeStatementId;
  if (bindingStatementConflict || writeRecordStatementConflict)
    return failure(
      "STATEMENT_CHAIN_CONFLICT",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );

  const producerStatementIds = unique(bindings.flatMap((binding) => {
    const id = text(binding.query_producer_statement_id);
    return id ? [id] : [];
  }));
  const writeRecordProducerStatementId = text(
    writeMatches[0]!.query_producer_statement_id,
  );
  const queryProducerStatementIds = unique([
    ...producerStatementIds,
    ...(writeRecordProducerStatementId ? [writeRecordProducerStatementId] : []),
  ]);
  if (queryProducerStatementIds.length > 1)
    return failure(
      "STATEMENT_CHAIN_CONFLICT",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );
  const queryProducerStatementId = queryProducerStatementIds[0] ?? null;
  const parsedStatementOrdinal = statementOrdinal(writeStatementId);
  if (parsedStatementOrdinal === null)
    return failure(
      "STATEMENT_OCCURRENCE_AMBIGUOUS",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );

  const expressionIds = unique(bindings.flatMap((binding) => {
    const id = text(binding.expression_id);
    return id ? [id] : [];
  }));
  const relationIds = unique(expressionIds.flatMap((expressionId) => {
    const id = relationFromExpression(expressionId);
    return id ? [id] : [];
  }));
  if (
    bindings.some((binding) => text(binding.expression_id) === null) ||
    relationIds.length !== 1
  )
    return failure(
      "ROOT_RELATION_UNMAPPED",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );

  const statementMatches = records(input.load, "statements.jsonl").filter(
    (row) =>
      text(row.task_id) === input.taskId &&
      text(row.statement_id) === writeStatementId,
  );
  if (statementMatches.length > 1)
    return failure(
      "WRITE_STATEMENT_RECORD_CONFLICT",
      observedWriteObservationIds,
      [
        ...bindingEvidence,
        ...writeEvidence,
        ...evidenceRefs(
          input.load,
          input.taskId,
          "statements.jsonl",
          statementMatches,
        ),
      ],
    );
  const statementRecord = statementMatches[0] ?? null;
  const statementIndex = statementRecord === null
    ? parsedStatementOrdinal
    : integer(statementRecord.statement_index);
  if (statementIndex === null)
    return failure(
      "STATEMENT_OCCURRENCE_AMBIGUOUS",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );

  const queryStatementMatches = queryProducerStatementId === null
    ? []
    : records(input.load, "statements.jsonl").filter(
      (row) =>
        text(row.task_id) === input.taskId &&
        text(row.statement_id) === queryProducerStatementId,
    );
  if (queryStatementMatches.length > 1)
    return failure(
      "QUERY_STATEMENT_RECORD_CONFLICT",
      observedWriteObservationIds,
      [
        ...bindingEvidence,
        ...writeEvidence,
        ...evidenceRefs(
          input.load,
          input.taskId,
          "statements.jsonl",
          queryStatementMatches,
        ),
      ],
    );
  const queryStatementRecord = queryStatementMatches[0] ?? null;
  const queryStatementIndex = queryStatementRecord
    ? integer(queryStatementRecord.statement_index)
    : queryProducerStatementId
    ? statementOrdinal(queryProducerStatementId)
    : null;

  const orderedWriteIds = unique(allWrites.flatMap((row) => {
    const id = text(row.write_observation_id);
    return id && text(row.write_statement_id) ? [id] : [];
  })).sort((leftId, rightId) => {
    const left = allWrites.find((row) => text(row.write_observation_id) === leftId);
    const right = allWrites.find((row) => text(row.write_observation_id) === rightId);
    const leftOrdinal = statementOrdinal(
      text(left?.write_statement_id) ?? "",
    ) ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = statementOrdinal(
      text(right?.write_statement_id) ?? "",
    ) ?? Number.MAX_SAFE_INTEGER;
    return leftOrdinal - rightOrdinal || leftId.localeCompare(rightId);
  });
  const taskWriteOrdinal = orderedWriteIds.indexOf(writeObservationId);
  if (taskWriteOrdinal < 0)
    return failure(
      "WRITE_OBSERVATION_MISSING",
      observedWriteObservationIds,
      [...bindingEvidence, ...writeEvidence],
    );

  const allEvidence = unique([
    ...bindingEvidence,
    ...writeEvidence,
    ...(statementRecord
      ? evidenceRefs(
        input.load,
        input.taskId,
        "statements.jsonl",
        [statementRecord],
      )
      : []),
    ...(queryStatementRecord
      ? evidenceRefs(
        input.load,
        input.taskId,
        "statements.jsonl",
        [queryStatementRecord],
      )
      : []),
  ]);
  return {
    occurrence: {
      taskId: input.taskId,
      targetTable,
      writeObservationId,
      writeRecord: writeMatches[0]!,
      writeStatementId,
      queryProducerStatementId,
      statementId: writeStatementId,
      sqlSourceId: sqlSourceId(writeStatementId),
      statementOrdinal: parsedStatementOrdinal,
      statementRecord,
      statementIndex,
      queryStatementRecord,
      queryStatementIndex,
      rootRelationId: relationIds[0]!,
      expressionIds,
      bindingIds: unique(bindings.flatMap((binding) => {
        const id = text(binding.binding_id);
        return id ? [id] : [];
      })),
      targetOrdinals: [...new Set(bindings.flatMap((binding) => {
        const ordinal = integer(binding.target_ordinal);
        return ordinal === null ? [] : [ordinal];
      }))].sort((left, right) => left - right),
      bindings,
      taskWriteOrdinal,
      evidenceRefs: allEvidence,
    },
    reasonCode: null,
    observedWriteObservationIds,
    evidenceRefs: allEvidence,
  };
}
