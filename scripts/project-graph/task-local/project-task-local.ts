import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  indexTaskInputPacks,
  loadPhysicalTableCatalog,
  type PhysicalTableCatalog,
  type PhysicalTableCatalogEntry,
} from "../../machine-facts/input-pack-machine-facts.ts";
import { normalizeName } from "../../machine-facts/machine-facts-contract.ts";
import {
  validateTaskDocument,
  type TaskDocument,
} from "../../input/shared/input-pack.ts";
import {
  loadCurrentTaskBundle,
  type CurrentBundleLoad,
  type JsonRecord,
} from "../../query/current-task-bundle.ts";
import { readPartitionRanges } from "./partition-range.ts";
import {
  sourceFieldsForExpression,
} from "./field-expression-dependencies.ts";
import {
  datasetControlsForStatement,
} from "../../reconcile/shared/dataset-controls.ts";
import { physicalFieldKey, type PhysicalFieldIdentity } from "../../reconcile/shared/physical-field.ts";
import { inferTaskDefaultSchema } from "../../reconcile/shared/task-default-schema.ts";
import {
  buildCollectionFailedProjection,
  buildScheduleOnlyProjection,
  factsEvidenceStatus,
  failureReasonFromLoad,
  taskNodeProperties,
} from "./coverage.ts";
import {
  canonicalizeTaskLocalProjection,
  TASK_LOCAL_PROJECTION_SCHEMA_VERSION,
  type TaskLocalEdge,
  type TaskLocalFailureReasonCode,
  type TaskLocalFieldPathSummary,
  type TaskLocalExternalReadSummary,
  type TaskLocalFinalWriteSummary,
  type TaskLocalNode,
  type TaskLocalProjection,
  type TaskLocalProjectionGap,
} from "./contract.ts";
import {
  buildFieldEvidenceIndexes,
  controlSideGap,
  emitFieldEvidenceForInput,
  inputFieldRecordForSource,
  materializationBreakGap,
  type ExpandedMaterializedField,
} from "./field-evidence/field-evidence-emission.ts";
import { expandSetopBranchExpressions } from "./field-evidence/source-read-occurrence.ts";
import { classifyExpressionSubtype } from "./field-evidence/subtype-classifier.ts";
import {
  fieldConditionalEdgeSemanticKey,
  fieldDirectEdgeSemanticKey,
  fieldEvidencePhysicalFieldNodeId,
  physicalDatasetNodeId,
  readOccurrenceNodeId,
  targetWriteNodeId,
  taskLocalEdgeId,
  taskNodeId,
} from "./ids.ts";
import {
  isTempLikeTableName,
  resolveTaskLocalTableIdentity,
  type TaskLocalTableIdentity,
} from "./identity.ts";
import {
  partitionPredicatesByReadOccurrence,
  readPartitionPredicatesForOccurrence,
} from "./partition-predicates.ts";
import { readTaskScheduleContext, readTaskCategoryFromScheduleCache, type TaskScheduleContext } from "./schedule-context.ts";

export interface ProjectTaskLocalOptions {
  readonly currentBundle?: CurrentBundleLoad;
  readonly factsRoot: string;
  readonly dataRoot: string;
  readonly taskId: string;
  readonly scheduleCacheRoot?: string;
  readonly generatedAt?: string;
}

// A CLI process projects many tasks against one immutable Pack/catalog snapshot.
// Cache only directory indexes; file contents and Facts remain per-task reads.
const physicalCatalogCache = new Map<string, PhysicalTableCatalog>();
const taskPackIndexCache = new Map<string, ReadonlyMap<string, readonly string[]>>();

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function records(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

export interface TaskLocalReadOccurrenceIdentity {
  readonly occurrenceId: string;
  readonly relationId: string | null;
}

/**
 * Recover a task-global read occurrence from relation evidence when the
 * dataset-io row predates nested read_occurrences. Only an exact same-task,
 * same-statement, same-physical-table read relation is accepted. When that
 * evidence is unavailable, retain the historical legacy fallback so callers
 * can keep the read unresolved instead of inventing a canonical id.
 */
export function resolveTaskLocalReadOccurrenceIdentities(input: {
  readonly taskId: string;
  readonly read: JsonRecord;
  readonly qualifiedName: string;
  readonly relationRecords: readonly JsonRecord[];
}): readonly TaskLocalReadOccurrenceIdentity[] {
  const statementId = text(input.read.statement_id);
  const rawName = text(input.read.physical_dataset);
  const normalizedQualifiedName = normalizeName(input.qualifiedName);
  const normalizedRawName = rawName ? normalizeName(rawName) : null;
  const relationIds = input.relationRecords
    .filter((row) => {
      if (text(row.task_id) !== input.taskId) return false;
      if (text(row.statement_id) !== statementId || !statementId) return false;
      const relation = record(row.relation);
      const relationType = (
        text(row.relation_type)
        ?? text(relation?.type)
        ?? ""
      ).toLowerCase();
      if (relationType !== "read") return false;
      const relationName =
        text(row.physical_dataset)
        ?? text(relation?.table)
        ?? text(relation?.physical_dataset)
        ?? text(relation?.qualifiedName)
        ?? text(relation?.qualified_name);
      if (relationName === null) return false;
      const normalizedRelationName = normalizeName(relationName);
      return normalizedRelationName === normalizedQualifiedName
        || (normalizedRawName !== null
          && !normalizedRawName.includes(".")
          && normalizedRelationName === normalizedRawName);
    })
    .map((row) => {
      const relation = record(row.relation);
      return text(row.relation_id) ?? text(relation?.id);
    })
    .filter((value): value is string => value !== null);
  const uniqueRelationIds = [...new Set(relationIds)].sort(compareText);
  const relationIdSet = new Set(uniqueRelationIds);
  const occurrences = records(input.read.read_occurrences);
  const fallback = (index: number): TaskLocalReadOccurrenceIdentity => ({
    occurrenceId: `legacy:${input.taskId}:${statementId ?? "statement"}:${input.qualifiedName}:${index}`,
    relationId: null,
  });

  if (occurrences.length > 0) {
    return occurrences.map((occurrence, index) => {
      const occurrenceId = text(occurrence.occurrence_id);
      const relationId = text(occurrence.relation_id) ?? occurrenceId;
      if (occurrenceId) return { occurrenceId, relationId };
      if (relationId && relationIdSet.has(relationId)) {
        return { occurrenceId: relationId, relationId };
      }
      if (!relationId && uniqueRelationIds.length === occurrences.length) {
        const recovered = uniqueRelationIds[index];
        if (recovered) return { occurrenceId: recovered, relationId: recovered };
      }
      if (!relationId && uniqueRelationIds.length === 1) {
        const recovered = uniqueRelationIds[0]!;
        return { occurrenceId: recovered, relationId: recovered };
      }
      return fallback(index);
    });
  }

  if (uniqueRelationIds.length > 0) {
    return uniqueRelationIds.map((relationId) => ({ occurrenceId: relationId, relationId }));
  }
  return [fallback(0)];
}

function loadTaskPack(
  dataRoot: string,
  catalog: PhysicalTableCatalog,
  taskId: string,
  load: CurrentBundleLoad,
): { document: TaskDocument & JsonRecord; target: PhysicalTableCatalogEntry | null } | null {
  const index = taskPackIndexCache.get(dataRoot)
    ?? (() => {
      const next = indexTaskInputPacks(dataRoot);
      taskPackIndexCache.set(dataRoot, next);
      return next;
    })();
  const paths = index.get(taskId) ?? [];
  const path = paths.length === 1 ? paths[0] : null;
  if (!path) return null;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  validateTaskDocument(raw);
  const document = raw as TaskDocument & JsonRecord;
  const manifestInputs = record(load.manifest?.inputs);
  const inputPack = record(manifestInputs?.input_pack);
  const tableLocator = text(inputPack?.table_locator);
  const tableContentHash = text(inputPack?.table_content_hash);
  let target: PhysicalTableCatalogEntry | null = null;
  if (
    tableLocator
    && tableContentHash
    && /^[a-f0-9]{64}$/.test(tableContentHash)
    && !isAbsolute(tableLocator)
    && !tableLocator.split(/[\\/]+/).includes("..")
  ) {
    const expectedPath = resolve(dataRoot, tableLocator);
    const containedPath = relative(dataRoot, expectedPath);
    if (containedPath !== "" && !containedPath.startsWith("..") && !isAbsolute(containedPath)) {
      target = catalog.entries.find(
        (entry) =>
          resolve(entry.tablePath) === expectedPath
          && entry.tableContentHash === tableContentHash,
      ) ?? null;
    }
  }
  return { document, target };
}

function ensureNode(
  nodes: Map<string, TaskLocalNode>,
  node: TaskLocalNode,
): void {
  if (!nodes.has(node.nodeId)) nodes.set(node.nodeId, node);
}

function ensureFieldNode(
  nodes: Map<string, TaskLocalNode>,
  field: PhysicalFieldIdentity,
  catalog: PhysicalTableCatalog,
): string {
  const nodeId = fieldEvidencePhysicalFieldNodeId(field);
  const identity = resolveTaskLocalTableIdentity({
    catalog,
    rawName: field.qualifiedName,
    defaultSchema: null,
    fallback: field,
  });
  ensureNode(nodes, {
    nodeId,
    nodeType: "PHYSICAL_FIELD",
    properties: {
      platform: field.platform,
      dataSource: field.dataSource,
      qualifiedName: field.qualifiedName,
      stableTableId: field.stableTableId,
      column: field.column,
      identityStatus: identity.identityStatus,
      ...(identity.qualificationStatus
        ? { qualificationStatus: identity.qualificationStatus }
        : {}),
      ...(identity.identityReasonCode
        ? { identityReasonCode: identity.identityReasonCode }
        : {}),
    },
  });
  return nodeId;
}

function datasetProperties(identity: TaskLocalTableIdentity): Record<string, unknown> {
  return {
    platform: identity.platform,
    dataSource: identity.dataSource,
    qualifiedName: identity.qualifiedName,
    identityStatus: identity.identityStatus,
    ...(identity.qualificationStatus
      ? { qualificationStatus: identity.qualificationStatus }
      : {}),
    ...(identity.identityReasonCode
      ? { identityReasonCode: identity.identityReasonCode }
      : {}),
  };
}

function ensureDatasetNode(
  nodes: Map<string, TaskLocalNode>,
  identity: TaskLocalTableIdentity,
): string {
  const nodeId = physicalDatasetNodeId(identity);
  ensureNode(nodes, {
    nodeId,
    nodeType: "PHYSICAL_DATASET",
    properties: datasetProperties(identity),
  });
  return nodeId;
}

function materializationKey(dataset: string, column: string): string {
  return `${normalizeName(dataset)}\u0000${normalizeName(column)}`;
}

export interface MaterializationContext {
  readonly statementId: string | null;
  readonly expressionId: string | null;
  readonly controlRelationId?: string;
  readonly readOccurrenceId?: string;
}

function materializationContextForExpression(expression: JsonRecord): MaterializationContext {
  return {
    statementId: text(expression.statement_id),
    expressionId: text(expression.expression_id),
  };
}

function materializationContextKey(context: MaterializationContext): string {
  return `${context.statementId ?? ""}\u0000${context.expressionId ?? ""}\u0000${context.controlRelationId ?? ""}\u0000${context.readOccurrenceId ?? ""}`;
}

function materializationRecordsForDataset(
  materializationRecords: readonly JsonRecord[],
  rawDataset: string,
  qualifiedDataset: string,
): readonly JsonRecord[] {
  const normalizedRaw = normalizeName(rawDataset);
  const normalizedQualified = normalizeName(qualifiedDataset);
  return materializationRecords.filter((materialization) => {
    const materializedDataset = normalizeName(String(materialization.physical_dataset ?? ""));
    return materializedDataset === normalizedRaw || materializedDataset === normalizedQualified;
  });
}

function materializationRecordHasContext(materialization: JsonRecord): boolean {
  return text(materialization.read_statement_id) !== null
    || (Array.isArray(materialization.read_expression_ids)
      && materialization.read_expression_ids.some((value: unknown) => text(value) !== null));
}

export function materializationRecordsForField(
  materializationsByField: ReadonlyMap<string, readonly JsonRecord[]>,
  source: PhysicalFieldIdentity,
  context: MaterializationContext,
): readonly JsonRecord[] {
  const all = materializationsByField.get(materializationKey(source.qualifiedName, source.column)) ?? [];
  if (context.controlRelationId) {
    return all.filter((materialization) => text(materialization.read_statement_id) === context.statementId
      && records(materialization.read_control_refs).some((reference) =>
        text(reference.relation_id) === context.controlRelationId
        && reference.resolution_status === "RESOLVED"
        && text(reference.read_relation_id) !== null
        && text(reference.read_occurrence_id) !== null
        && (!context.readOccurrenceId || reference.read_occurrence_id === context.readOccurrenceId),
      ));
  }
  if (context.expressionId) {
    const expressionMatches = all.filter((materialization) =>
      Array.isArray(materialization.read_expression_ids)
      && materialization.read_expression_ids.some(
        (value: unknown) => text(value) === context.expressionId,
      ),
    );
    if (expressionMatches.length > 0) return expressionMatches;
  }
  if (context.statementId) {
    const statementMatches = all.filter(
      (materialization) => text(materialization.read_statement_id) === context.statementId,
    );
    if (statementMatches.length > 0) return statementMatches;
  }
  return all.every((materialization) => !materializationRecordHasContext(materialization)) ? all : [];
}

function materializationOutputBindingIds(materialization: JsonRecord): string[] {
  const values = [
    text(materialization.output_binding_id),
    ...(Array.isArray(materialization.output_binding_ids)
      ? materialization.output_binding_ids.map((value: unknown) => text(value))
      : []),
  ].filter((value): value is string => value !== null);
  return [...new Set(values)].sort(compareText);
}

function isStaticPartitionMaterialization(materialization: JsonRecord): boolean {
  return text(materialization.producer_kind) === "STATIC_PARTITION_ASSIGNMENT";
}

function hasPossibleLaterTaskRead(
  writeIdentity: TaskLocalTableIdentity,
  writeStatementIndex: number | undefined,
  reads: readonly {
    readonly identity: TaskLocalTableIdentity;
    readonly statementIndex: number | undefined;
  }[],
): boolean {
  if (writeStatementIndex === undefined) return true;
  const writeDatasetNodeId = physicalDatasetNodeId(writeIdentity);
  return reads.some(({ identity, statementIndex }) => {
    if (statementIndex !== undefined && statementIndex <= writeStatementIndex) return false;
    if (identity.identityStatus === "CONFIRMED") {
      return physicalDatasetNodeId(identity) === writeDatasetNodeId;
    }
    if (!identity.originalName || identity.qualifiedName === writeIdentity.qualifiedName) return true;
    // An unqualified, unresolved read is only a possible consumer. Block the
    // SQL_UNCONSUMED claim; do not bind it to this write or promote its identity.
    return !identity.qualifiedName.includes(".")
      && identity.qualifiedName === writeIdentity.qualifiedName.split(".").at(-1);
  });
}

function finalWriteQualification(
  physicalDataset: string,
  targetQualifiedName: string | null,
  writeKind: string | null,
  hasPossibleLaterRead: boolean,
  hasConfirmedIdentity: boolean,
): "PLATFORM_TARGET" | "SQL_UNCONSUMED" | null {
  if (writeKind?.toUpperCase() === "CREATE_TABLE") return null;
  const normalized = normalizeName(physicalDataset);
  if (targetQualifiedName && normalized === normalizeName(targetQualifiedName)) {
    return "PLATFORM_TARGET";
  }
  // A non-target write is eligible only when this Task never reads it later.
  // That separates observable SQL outputs from the Task's own materializations
  // without claiming that a name alone proves a temporary table.
  if (hasPossibleLaterRead || !hasConfirmedIdentity || isTempLikeTableName(normalized)) return null;
  return "SQL_UNCONSUMED";
}

function taskLocalSourceFieldsForExpression(
  expression: JsonRecord,
  catalog: PhysicalTableCatalog,
  load: CurrentBundleLoad,
  taskId: string,
  taskTarget: PhysicalTableCatalogEntry,
  defaultSchema: ReturnType<typeof inferTaskDefaultSchema>,
  effect: "VALUE" | "CONDITIONAL" = "VALUE",
): ReturnType<typeof sourceFieldsForExpression> {
  const result = sourceFieldsForExpression(
    expression,
    catalog,
    load,
    taskId,
    taskTarget,
    defaultSchema,
    effect,
  );
  // The legacy resolver can use a unique catalog tail when no task schema exists.
  // Keep task-local projection fail-closed for that one case; task-local schema-backed
  // fields remain valid evidence.
  if (defaultSchema !== null) return result;
  const bareInputTables = new Set(
    records(expression.input_fields)
      .map((input) => normalizeName(String(input.table ?? "")))
      .filter((table) => table !== "" && !table.includes(".")),
  );
  if (bareInputTables.size === 0) return result;
  const rejectedFields = result.fields.filter((field) => field.identityStatus !== "TASK_LOCAL_SCHEMA_BACKED"
    && bareInputTables.has(normalizeName(field.qualifiedName.split(".").at(-1) ?? "")));
  return {
    ...result,
    unresolved: [...result.unresolved, ...rejectedFields.flatMap((field) =>
      (result.inputFieldsByFieldKey.get(physicalFieldKey(field)) ?? []).map((input) => ({
        table: String(input.table), column: field.column, reason: "SOURCE_TABLE_QUALIFICATION_UNPROVEN",
      })))],
    fields: result.fields.filter(
      (field) =>
        field.identityStatus === "TASK_LOCAL_SCHEMA_BACKED"
        || !bareInputTables.has(normalizeName(field.qualifiedName.split(".").at(-1) ?? "")),
    ),
  };
}

/** Candidate names remain diagnostic evidence; they are not physical control inputs. */
function physicalControlEvidence(value: unknown, unresolved: JsonRecord[]): unknown {
  if (Array.isArray(value)) return value.map((item) => physicalControlEvidence(item, unresolved));
  const item = record(value);
  if (!item) return value;
  const resolution = text(item.resolution);
  const unresolvedColumn = resolution && resolution !== "PHYSICAL" && resolution !== "NO_PHYSICAL_INPUT";
  if (unresolvedColumn) {
    const candidates = records(item.sql_candidate);
    for (const candidate of candidates.length > 0 ? candidates : [{ column: item.name }]) {
      unresolved.push({ table: text(candidate.table), column: text(candidate.column), reason: resolution });
    }
  }
  return Object.fromEntries(Object.entries(item)
    .filter(([key]) => key !== "sql_candidate" && !(unresolvedColumn && key === "physical"))
    .map(([key, child]) => [key, physicalControlEvidence(child, unresolved)]));
}

function expressionFor(load: CurrentBundleLoad, binding: JsonRecord): JsonRecord | null {
  const expressionId = text(binding.expression_id);
  if (!expressionId) return null;
  return records(load.records["field-expression-nodes.jsonl"]).find(
    (expression) => text(expression.expression_id) === expressionId,
  ) ?? null;
}

function readPackTaskCategory(dataRoot: string, taskId: string): string | null {
  const path = join(dataRoot, "tasks", taskId, "task.json");
  if (!existsSync(path)) return null;
  const doc = JSON.parse(readFileSync(path, "utf8")) as { taskCategory?: unknown };
  return typeof doc.taskCategory === "string" ? doc.taskCategory : null;
}

function resolveProjectionTaskCategory(input: {
  readonly taskId: string;
  readonly dataRoot: string;
  readonly scheduleCacheRoot?: string;
  readonly packCategory?: string | null;
}): string | null {
  return (
    input.packCategory
    ?? readTaskCategoryFromScheduleCache(input.taskId, input.scheduleCacheRoot)
    ?? null
  );
}

function projectTaskLocalFromFacts(input: {
  readonly taskId: string;
  readonly generatedAt: string;
  readonly load: CurrentBundleLoad;
  readonly evidenceStatus: "CONFIRMED" | "PROVISIONAL_LEGACY";
  readonly dataRoot: string;
  readonly schedule: TaskScheduleContext | null;
  readonly taskCategory: string | null;
}): TaskLocalProjection {
  const { taskId, generatedAt, load, evidenceStatus, dataRoot, schedule, taskCategory } = input;
  const catalog = physicalCatalogCache.get(dataRoot)
    ?? (() => {
      const next = loadPhysicalTableCatalog(dataRoot, { lazyDdl: true });
      physicalCatalogCache.set(dataRoot, next);
      return next;
    })();
  const pack = loadTaskPack(dataRoot, catalog, taskId, load);
  const resolvedTaskCategory = taskCategory ?? pack?.document.taskCategory ?? null;
  const fallbackTable = pack?.target ?? { platform: "hive", dataSource: "unknown" };
  const defaultSchema = pack ? inferTaskDefaultSchema(pack.document) : null;
  const nodes = new Map<string, TaskLocalNode>();
  const edges: TaskLocalEdge[] = [];
  const edgeIds = new Set<string>();

  const pushEdge = (edge: TaskLocalEdge): void => {
    if (edgeIds.has(edge.edgeId)) return;
    edgeIds.add(edge.edgeId);
    edges.push(edge);
  };

  ensureNode(nodes, {
    nodeId: taskNodeId(taskId),
    nodeType: "TASK",
    properties: taskNodeProperties({
      packTaskName: pack?.document.taskName ?? null,
      schedule,
    }),
  });

  const writeRecords = records(load.records["dataset-io.jsonl"]).filter(
    (record) =>
      text(record.task_id) === taskId
      && String(record.direction ?? "").toUpperCase() === "WRITE"
      && text(record.write_observation_id),
  );
  if (writeRecords.length === 0) {
    return buildCollectionFailedProjection({
      taskId,
      generatedAt,
      failureReasonCode: "NO_RESOLVED_WRITE",
      taskCategory: resolvedTaskCategory,
      taskProperties: taskNodeProperties({
        packTaskName: pack?.document.taskName ?? null,
        schedule,
      }),
    });
  }

  const resolvedBindings = records(load.records["output-field-bindings.jsonl"]).filter(
    (binding) =>
      text(binding.task_id) === taskId
      && binding.binding_status === "RESOLVED"
      && text(binding.write_observation_id),
  );
  const primaryTarget = pack?.target ?? null;
  if (resolvedBindings.length > 0 && !primaryTarget) {
    return buildCollectionFailedProjection({
      taskId,
      generatedAt,
      failureReasonCode: "SCHEMA_UNRESOLVED",
      taskCategory: resolvedTaskCategory,
      taskProperties: taskNodeProperties({
        packTaskName: pack?.document.taskName ?? null,
        schedule,
      }),
    });
  }

  const writeObservationByStatement = new Map<string, string>();
  for (const write of writeRecords) {
    const writeObservationId = text(write.write_observation_id)!;
    const statementId =
      text(write.write_statement_id)
      ?? text(write.statement_id);
    if (statementId) writeObservationByStatement.set(statementId, writeObservationId);
  }
  for (const binding of resolvedBindings) {
    const writeObservationId = text(binding.write_observation_id);
    const statementId =
      text(binding.write_statement_id)
      ?? text(binding.statement_id);
    if (writeObservationId && statementId && !writeObservationByStatement.has(statementId)) {
      writeObservationByStatement.set(statementId, writeObservationId);
    }
  }

  const outputBindings = records(load.records["output-field-bindings.jsonl"]);
  const bindingById = new Map(
    outputBindings
      .map((binding) => [text(binding.binding_id), binding] as const)
      .filter((entry): entry is readonly [string, JsonRecord] => entry[0] !== null),
  );
  const materializationRecords = records(load.records["task-local-materializations.jsonl"])
    .filter((record) => text(record.task_id) === taskId);
  const materializationsByField = new Map<string, JsonRecord[]>();
  for (const materialization of materializationRecords) {
    const dataset = text(materialization.physical_dataset);
    const column = text(materialization.column);
    if (!dataset || !column) continue;
    const key = materializationKey(dataset, column);
    const values = materializationsByField.get(key) ?? [];
    values.push(materialization);
    materializationsByField.set(key, values);
  }

  const targetWriteNodes = new Map<string, string>();
  const finalWriteSummaries: TaskLocalFinalWriteSummary[] = [];
  const finalDatasetNames = new Set<string>();
  const statementIndexById = new Map(
    records(load.records["statements.jsonl"])
      .filter((statement) => text(statement.task_id) === taskId)
      .map((statement) => [text(statement.statement_id), statement.statement_index] as const)
      .filter((entry): entry is readonly [string, number] =>
        entry[0] !== null
        && typeof entry[1] === "number"
        && Number.isSafeInteger(entry[1])
        && entry[1] >= 0,
      ),
  );
  const taskReads = records(load.records["dataset-io.jsonl"])
    .filter((read) => text(read.task_id) === taskId && String(read.direction ?? "").toUpperCase() === "READ")
    .map((read) => ({
      read,
      statementIndex: statementIndexById.get(text(read.statement_id) ?? ""),
      identity: resolveTaskLocalTableIdentity({
        catalog,
        rawName: String(read.physical_dataset ?? ""),
        defaultSchema,
        fallback: fallbackTable,
      }),
    }));
  for (const write of writeRecords) {
    const writeObservationId = text(write.write_observation_id)!;
    const baseIdentity = resolveTaskLocalTableIdentity({
      catalog,
      rawName: String(write.physical_dataset ?? ""),
      defaultSchema,
      fallback: fallbackTable,
    });
    const writeMaterializations = materializationRecordsForDataset(
      materializationRecords,
      String(write.physical_dataset ?? ""),
      baseIdentity.qualifiedName,
    );
    const identity = isTempLikeTableName(String(write.physical_dataset ?? ""))
      && writeMaterializations.length === 0
      && baseIdentity.identityStatus === "CONFIRMED"
      ? {
        ...baseIdentity,
        identityStatus: "CANDIDATE_DATASET" as const,
        identityReasonCode: "TEMP_MATERIALIZATION_MISSING",
      }
      : baseIdentity;
    const datasetNodeId = ensureDatasetNode(nodes, identity);
    const writeNodeId = targetWriteNodeId({
      taskId,
      datasetNodeId,
      writeObservationId,
    });
    ensureNode(nodes, {
      nodeId: writeNodeId,
      nodeType: "TARGET_WRITE",
      properties: {
        writeObservationId,
        qualifiedName: identity.qualifiedName,
      },
    });
    targetWriteNodes.set(writeObservationId, writeNodeId);
    pushEdge({
      edgeId: taskLocalEdgeId({
        edgeType: "WRITES",
        fromNodeId: taskNodeId(taskId),
        toNodeId: writeNodeId,
        semanticKey: { writeObservationId },
      }),
      edgeType: "WRITES",
      fromNodeId: taskNodeId(taskId),
      toNodeId: writeNodeId,
      properties: { writeObservationId },
    });
    pushEdge({
      edgeId: taskLocalEdgeId({
        edgeType: "WRITES",
        fromNodeId: writeNodeId,
        toNodeId: datasetNodeId,
        semanticKey: { writeObservationId },
      }),
      edgeType: "WRITES",
      fromNodeId: writeNodeId,
      toNodeId: datasetNodeId,
      properties: { writeObservationId },
    });
    const writeStatementId = text(write.write_statement_id) ?? text(write.statement_id);
    const writeStatementIndex = writeStatementId === null
      ? undefined
      : statementIndexById.get(writeStatementId);
    const outputQualification = finalWriteQualification(
      identity.qualifiedName,
      pack?.target?.qualifiedName ?? null,
      text(write.write_kind),
      hasPossibleLaterTaskRead(identity, writeStatementIndex, taskReads),
      identity.identityStatus === "CONFIRMED",
    );
    if (outputQualification !== null) {
      // SELF_READ retains its pre-existing platform-target meaning. An
      // SQL_UNCONSUMED output can have an earlier read of the same table, which
      // is not evidence that the read consumed this Task's later write.
      if (outputQualification === "PLATFORM_TARGET") {
        finalDatasetNames.add(identity.qualifiedName);
      }
      finalWriteSummaries.push({
        writeObservationId,
        targetWriteNodeId: writeNodeId,
        datasetNodeId,
        qualifiedName: identity.qualifiedName,
        outputQualification,
      });
    }
  }

  const relationRecords = records(load.records["relation-nodes.jsonl"]);
  const partitionRanges = readPartitionRanges(relationRecords);
  const predicatesByOccurrence = partitionPredicatesByReadOccurrence({
    taskId,
    relationRecords,
    relationEdgeRecords: records(load.records["relation-edges.jsonl"]),
  });
  const externalReadSummaries: TaskLocalExternalReadSummary[] = [];
  for (const { read, identity: baseIdentity } of taskReads) {
    const rawReadDataset = normalizeName(String(read.physical_dataset ?? ""));
    const datasetMaterializations = materializationRecordsForDataset(
      materializationRecords,
      rawReadDataset,
      baseIdentity.qualifiedName,
    );
    const identity = isTempLikeTableName(rawReadDataset) && datasetMaterializations.length === 0
      ? {
        ...baseIdentity,
        identityStatus: "CANDIDATE_DATASET" as const,
        identityReasonCode: "TEMP_MATERIALIZATION_MISSING",
      }
      : baseIdentity;
    const datasetNodeId = ensureDatasetNode(nodes, identity);
    const hasResolvedMaterialization = datasetMaterializations.some(
      (materialization) => String(materialization.status ?? "").toUpperCase() === "RESOLVED",
    );
    const hasUnresolvedMaterialization = datasetMaterializations.some(
      (materialization) => String(materialization.status ?? "").toUpperCase() !== "RESOLVED",
    );
    const readOccurrenceIds = resolveTaskLocalReadOccurrenceIdentities({
      taskId,
      read,
      qualifiedName: identity.qualifiedName,
      relationRecords,
    });
    for (const [occurrenceIndex, occurrence] of readOccurrenceIds.entries()) {
      const partition = readPartitionPredicatesForOccurrence(
        predicatesByOccurrence,
        occurrence.relationId,
      );
      const selfRead = finalDatasetNames.has(identity.qualifiedName);
      const readDisposition = selfRead
        ? "SELF_READ"
        : hasResolvedMaterialization && !hasUnresolvedMaterialization
        ? "LOCAL_MATERIALIZATION"
        : "EXTERNAL_READ";
      const occurrenceNodeId = readOccurrenceNodeId({
        consumerTaskId: taskId,
        occurrenceId: occurrence.occurrenceId,
        readRelationId: occurrence.relationId ?? `${identity.qualifiedName}:${occurrenceIndex}`,
      });
      ensureNode(nodes, {
        nodeId: occurrenceNodeId,
        nodeType: "READ_OCCURRENCE",
        properties: {
          taskId,
          occurrenceId: occurrence.occurrenceId,
          relationId: occurrence.relationId,
          statementId: text(read.statement_id),
          datasetNodeId,
          physicalDataset: identity.qualifiedName,
          identityStatus: identity.identityStatus,
          ...(identity.qualificationStatus
            ? { qualificationStatus: identity.qualificationStatus }
            : {}),
          ...(identity.identityReasonCode
            ? { identityReasonCode: identity.identityReasonCode }
            : {}),
          readDisposition,
          partitionPredicates: partition.predicates,
          partitionPredicateStatus: partition.status,
          ...(occurrence.relationId && partitionRanges.has(occurrence.relationId) ? { partitionRange: partitionRanges.get(occurrence.relationId)! } : {}),
          ...(hasUnresolvedMaterialization
            ? { materializationBoundaryReason: "MATERIALIZATION_NOT_RESOLVED" }
            : {}),
        },
      });
      pushEdge({
        edgeId: taskLocalEdgeId({
          edgeType: "READS",
          fromNodeId: taskNodeId(taskId),
          toNodeId: occurrenceNodeId,
          semanticKey: { readOccurrenceId: occurrence.occurrenceId },
        }),
        edgeType: "READS",
        fromNodeId: taskNodeId(taskId),
        toNodeId: occurrenceNodeId,
        properties: {
          readOccurrenceId: occurrence.occurrenceId,
          readDisposition,
        },
      });
      pushEdge({
        edgeId: taskLocalEdgeId({
          edgeType: "READS",
          fromNodeId: occurrenceNodeId,
          toNodeId: datasetNodeId,
          semanticKey: { readOccurrenceId: occurrence.occurrenceId },
        }),
        edgeType: "READS",
        fromNodeId: occurrenceNodeId,
        toNodeId: datasetNodeId,
        properties: {
          readOccurrenceId: occurrence.occurrenceId,
          partitionPredicates: partition.predicates,
          partitionPredicateStatus: partition.status,
          readDisposition,
        },
      });
      if (readDisposition === "EXTERNAL_READ") {
        externalReadSummaries.push({
          readOccurrenceId: occurrence.occurrenceId,
          readOccurrenceNodeId: occurrenceNodeId,
          datasetNodeId,
          qualifiedName: identity.qualifiedName,
          identityStatus: identity.identityStatus,
        });
      }
    }
  }

  const fieldEvidenceIndexes = buildFieldEvidenceIndexes({
    taskId,
    expressions: records(load.records["field-expression-nodes.jsonl"]),
    relationNodes: records(load.records["relation-nodes.jsonl"]),
    relationEdges: records(load.records["relation-edges.jsonl"]),
    datasetIoReads: records(load.records["dataset-io.jsonl"]).filter(
      (row) => text(row.task_id) === taskId,
    ),
  });
  const gaps: TaskLocalProjectionGap[] = [];
  const gapIds = new Set<string>();
  const pushGap = (gap: TaskLocalProjectionGap): void => {
    if (gapIds.has(gap.gapId)) return;
    gapIds.add(gap.gapId);
    gaps.push(gap);
  };
  const writtenDatasets = new Set(
    writeRecords.map((write) => normalizeName(String(write.physical_dataset ?? ""))),
  );
  const materializationBreakTracker = new Map<string, {
    columns: Set<string>;
    affectedEdgeCount: number;
    writeObservationIds: Set<string>;
    materializationRecords: number;
  }>();
  const materializationBreakKeys = new Set<string>();

  const branchExpressions = (expression: JsonRecord): readonly JsonRecord[] =>
    expandSetopBranchExpressions({
      expression,
      expressionsByRelation: fieldEvidenceIndexes.expressionsByRelation,
      index: fieldEvidenceIndexes.relationTree,
    }).map((context) => context.expression);

  const expressionDependencies = (expression: JsonRecord) => {
    const value = taskLocalSourceFieldsForExpression(
      expression, catalog, load, taskId, primaryTarget!, defaultSchema, "VALUE",
    );
    const conditional = taskLocalSourceFieldsForExpression(
      expression, catalog, load, taskId, primaryTarget!, defaultSchema, "CONDITIONAL",
    );
    const unresolved = [...value.unresolved, ...conditional.unresolved];
    if (!value.roles.complete || unresolved.length > 0) {
      const expressionId = text(expression.expression_id);
      pushGap({
        gapId: "field-dependency:" + taskId + ":" + expressionId,
        reasonCode: "FIELD_DEPENDENCY_UNRESOLVED",
        details: {
          taskId, expressionId, statementId: text(expression.statement_id),
          reason: value.roles.reasonCode ?? "PHYSICAL_INPUT_IDENTITY_UNRESOLVED",
          unresolved,
        },
      });
    }
    return {
      roles: value.roles,
      unresolved,
      sources: [
        ...value.fields.map((field) => ({ field, dependencyRole: "VALUE" as const, inputFields: value.inputFieldsByFieldKey.get(physicalFieldKey(field)) })),
        ...conditional.fields.map((field) => ({ field, dependencyRole: "CONDITIONAL" as const, inputFields: conditional.inputFieldsByFieldKey.get(physicalFieldKey(field)) })),
      ],
    };
  };

  const expandedMaterializationMemo = new Map<string, ExpandedMaterializedField[]>();
  const expandMaterializedField = (
    source: PhysicalFieldIdentity,
    visited: ReadonlySet<string> = new Set(),
    context: MaterializationContext = { statementId: null, expressionId: null },
    subtypeHops: readonly ReturnType<typeof classifyExpressionSubtype>[] = [],
    dependencyRole: "VALUE" | "CONDITIONAL" = "VALUE",
    sourceInputFields?: readonly JsonRecord[],
  ): ExpandedMaterializedField[] => {
    const fieldKey = materializationKey(source.qualifiedName, source.column);
    const traversalKey = fieldKey + "\u0000" + (context.statementId ?? "");
    const memoKey = fieldKey + "\u0000" + materializationContextKey(context) + "\u0000" + dependencyRole;
    if (visited.size === 0) {
      const cached = expandedMaterializationMemo.get(memoKey);
      if (cached) return cached;
    }
    const candidates = materializationRecordsForField(materializationsByField, source, context);
    const resolved = candidates.filter((materialization) =>
      String(materialization.status ?? "").toUpperCase() === "RESOLVED"
      && (materializationOutputBindingIds(materialization).length > 0 || isStaticPartitionMaterialization(materialization)),
    );
    const unexpanded = (expression?: JsonRecord): ExpandedMaterializedField[] => [{
      field: source, dependencyRole, materializationBridgeIds: [], sourceInputFields,
      leafExpressionId: text(expression?.expression_id) ?? context.expressionId,
      leafRelationId: text(expression?.relation_id),
      pathHadAggregation: subtypeHops.some((hop) => hop.pathHadAggregation),
      subtypeHops,
    }];
    if (candidates.length !== 1 || resolved.length !== 1 || !primaryTarget || visited.has(traversalKey)) {
      const result = unexpanded();
      if (visited.size === 0) expandedMaterializationMemo.set(memoKey, result);
      return result;
    }
    const materialization = resolved[0]!;
    if (isStaticPartitionMaterialization(materialization)) {
      if (visited.size === 0) expandedMaterializationMemo.set(memoKey, []);
      return [];
    }
    const bindingIds = materializationOutputBindingIds(materialization);
    const producerRoots = bindingIds.flatMap((bindingId) => {
      const binding = bindingById.get(bindingId);
      const expression = binding?.binding_status === "RESOLVED" ? expressionFor(load, binding) : null;
      return expression ? [expression] : [];
    });
    if (producerRoots.length !== bindingIds.length) return unexpanded();
    const nextVisited = new Set(visited);
    nextVisited.add(traversalKey);
    const result = producerRoots.flatMap(branchExpressions).flatMap((expression) => {
      const hop = classifyExpressionSubtype(
        expression,
        fieldEvidenceIndexes.relationTree.relations.get(text(expression.relation_id) ?? "")?.relationType ?? null,
      );
      const underlying = expressionDependencies(expression);
      if (underlying.sources.length === 0) {
        if (underlying.roles.complete && underlying.unresolved.length === 0
          && underlying.roles.terminalKind !== "UNKNOWN") return [];
        return unexpanded(expression);
      }
      return underlying.sources.flatMap((input) =>
        expandMaterializedField(
          input.field, nextVisited, materializationContextForExpression(expression),
          [...subtypeHops, hop],
          dependencyRole === "CONDITIONAL" ? "CONDITIONAL" : input.dependencyRole,
          input.inputFields,
        ).map((expanded) => ({
          ...expanded,
          materializationBridgeIds: [
            text(materialization.bridge_id) ?? "", ...expanded.materializationBridgeIds,
          ].filter(Boolean),
          leafExpressionId: expanded.leafExpressionId ?? text(expression.expression_id),
          leafRelationId: expanded.leafRelationId ?? text(expression.relation_id),
        })),
      );
    });
    if (visited.size === 0) expandedMaterializationMemo.set(memoKey, result);
    return result;
  };

  const localFieldPaths: TaskLocalFieldPathSummary[] = [];
  const localFieldPathKeys = new Set<string>();
  const statementIds = new Set<string>();
  for (const binding of resolvedBindings) {
    const writeObservationId = text(binding.write_observation_id)!;
    const targetWriteNode = targetWriteNodes.get(writeObservationId);
    if (!targetWriteNode || !primaryTarget) continue;
    const outputColumn = normalizeName(String(binding.target_field ?? ""));
    if (!outputColumn) continue;
    const boundExpression = expressionFor(load, binding);
    if (!boundExpression) continue;
    for (const expression of branchExpressions(boundExpression)) {
      const statementId = text(expression.statement_id);
      if (statementId) statementIds.add(statementId);
      const dependencies = expressionDependencies(expression);
      for (const rawSource of dependencies.sources) {
        for (const expanded of expandMaterializedField(
          rawSource.field, new Set(), materializationContextForExpression(expression), [], rawSource.dependencyRole, rawSource.inputFields,
        )) {
          const source = {
            ...expanded,
            ...(expanded.materializationBridgeIds.length > 0 ? {
              materializationInputField: rawSource.field, materializationInputFields: rawSource.inputFields,
            } : {}),
          };
          const inputField = inputFieldRecordForSource(expression, source.field);
          const emissions = emitFieldEvidenceForInput({
            taskId, expression, sourceField: source.field, inputField,
            expanded: source, indexes: fieldEvidenceIndexes,
            branchScoped: true,
          });
          if (emissions.length === 0) {
            pushGap({
              gapId: "field-emission:" + taskId + ":" + text(expression.expression_id) + ":" + physicalFieldKey(source.field) + ":" + source.dependencyRole,
              reasonCode: "FIELD_DEPENDENCY_UNRESOLVED",
              details: {
                taskId, expressionId: text(expression.expression_id), leafExpressionId: source.leafExpressionId,
                statementId, reason: "SOURCE_READ_SCOPE_NOT_EMITTED",
                unresolved: (source.sourceInputFields ?? [{ table: source.field.qualifiedName, column: source.field.column }]).map((input) => ({
                  table: text(input.table), column: text(input.column), reason: "SOURCE_READ_SCOPE_NOT_EMITTED",
                })),
              },
            });
          }
          for (const emission of emissions) {
            const context = emission.expressionContexts[0];
            if (!context) continue;
            if (emission.sourceResolution.gap) pushGap(emission.sourceResolution.gap);
            const fromNodeId = ensureFieldNode(nodes, source.field, catalog);
            // The array is a consumer-to-producer path, not an unordered set.
            const bridgeIds = [...new Set(source.materializationBridgeIds)];
            const sourceReadOccurrenceId = emission.sourceResolution.sourceReadOccurrenceStatus === "RESOLVED"
              ? emission.sourceResolution.sourceReadOccurrenceId : null;
            const conditional = source.dependencyRole === "CONDITIONAL";
            const edgeType = conditional ? "FIELD_CONDITIONAL" as const : "FIELD_DIRECT" as const;
            const commonKey = {
              outputColumn, sourceColumn: source.field.column,
              sourceTable: source.field.qualifiedName, sourceReadOccurrenceId,
              expressionId: context.expressionId,
            };
            const semanticKey = conditional
              ? fieldConditionalEdgeSemanticKey({
                ...commonKey, conditionalId: "field-conditional:task-local:" + taskId + ":" + outputColumn,
              })
              : fieldDirectEdgeSemanticKey(commonKey);
            pushEdge({
              edgeId: taskLocalEdgeId({
                edgeType, fromNodeId, toNodeId: targetWriteNode,
                semanticKey: {
                  ...semanticKey,
                  ...(bridgeIds.length > 0 ? { materializationBridgeIds: bridgeIds } : {}),
                },
              }),
              edgeType, fromNodeId, toNodeId: targetWriteNode,
              properties: {
                subtype: conditional ? "CONDITIONAL" : emission.subtype,
                ...(!conditional && emission.subtypeReason ? { subtypeReason: emission.subtypeReason } : {}),
                outputColumn, bindingId: text(binding.binding_id),
                expressionId: context.expressionId, sourceReadOccurrenceId,
                sourceReadOccurrenceStatus: emission.sourceResolution.sourceReadOccurrenceStatus,
                ...(emission.sourceResolution.sourceReadOccurrenceReason
                  ? { sourceReadOccurrenceReason: emission.sourceResolution.sourceReadOccurrenceReason } : {}),
                sourceRelationId: emission.sourceResolution.sourceRelationId,
                ...(bridgeIds.length > 0 ? {
                  materializationBridgeIds: bridgeIds, materializationFolded: true,
                  materializationLeafExpressionId: source.leafExpressionId,
                } : {}),
              },
            });
            const sourceStillTemp = bridgeIds.length === 0
              && writtenDatasets.has(normalizeName(source.field.qualifiedName))
              && isTempLikeTableName(source.field.qualifiedName);
            if (sourceStillTemp) {
              const breakKey = writeObservationId + "|" + outputColumn + "|" + rawSource.field.column + "|" + edgeType;
              if (!materializationBreakKeys.has(breakKey)) {
                materializationBreakKeys.add(breakKey);
                const sourceDataset = normalizeName(rawSource.field.qualifiedName);
                const tracker = materializationBreakTracker.get(sourceDataset) ?? {
                  columns: new Set<string>(), affectedEdgeCount: 0,
                  writeObservationIds: new Set<string>(),
                  materializationRecords: materializationRecordsForDataset(materializationRecords, sourceDataset, sourceDataset).length,
                };
                tracker.columns.add(rawSource.field.column);
                tracker.affectedEdgeCount += 1;
                tracker.writeObservationIds.add(writeObservationId);
                materializationBreakTracker.set(sourceDataset, tracker);
              }
            }
            if (bridgeIds.length > 0) {
              const pathKey = fromNodeId + "|" + targetWriteNode + "|" + outputColumn + "|" + bridgeIds.join("|");
              if (!localFieldPathKeys.has(pathKey)) {
                localFieldPathKeys.add(pathKey);
                localFieldPaths.push({
                  sourceFieldNodeId: fromNodeId, targetWriteNodeId: targetWriteNode,
                  outputColumn, materializationBridgeIds: bridgeIds,
                });
              }
            }
          }
        }
      }
    }
  }
  for (const [physicalDataset, tracker] of materializationBreakTracker) {
    pushGap(materializationBreakGap({
      taskId,
      physicalDataset,
      columns: [...tracker.columns],
      affectedEdgeCount: tracker.affectedEdgeCount,
      writeObservationIds: [...tracker.writeObservationIds],
      materializationRecords: tracker.materializationRecords,
    }));
  }

  for (const statementId of writeObservationByStatement.keys()) {
    statementIds.add(statementId);
  }

  const controlUnresolvedByRelation = new Map<string, JsonRecord[]>();
  const controlLoad: CurrentBundleLoad = { ...load, records: { ...load.records,
    "relation-nodes.jsonl": records(load.records["relation-nodes.jsonl"]).map((relation) => {
      const unresolved: JsonRecord[] = [];
      const body = physicalControlEvidence(relation.relation, unresolved);
      if (unresolved.length > 0) controlUnresolvedByRelation.set(String(relation.relation_id), unresolved);
      return { ...relation, relation: body };
    }),
  } };
  for (const statementId of [...statementIds].sort(compareText)) {
    for (const control of datasetControlsForStatement(
      controlLoad,
      taskId,
      statementId,
      catalog,
      defaultSchema,
      primaryTarget ?? fallbackTable,
      evidenceStatus,
    )) {
      const unresolved = controlUnresolvedByRelation.get(control.relationId ?? "") ?? [];
      if (unresolved.length > 0 || control.evidenceStatus === "UNRESOLVED") {
        pushGap({
          gapId: "control-dependency:" + taskId + ":" + control.relationId,
          reasonCode: "DATASET_CONTROL_DEPENDENCY_UNRESOLVED",
          details: { taskId, relationId: control.relationId, statementId: control.statementId,
            reason: control.reasonCode ?? "CONTROL_INPUT_NOT_PHYSICAL", unresolved },
        });
      }
      if (!control.field) continue;
      const writeObservationId =
        writeObservationByStatement.get(control.statementId)
        ?? writeObservationByStatement.get(statementId);
      const targetWriteNode = writeObservationId
        ? targetWriteNodes.get(writeObservationId)
        : undefined;
      if (!targetWriteNode) continue;
      if (control.controlSide === "BOTH") {
        pushGap(controlSideGap({
          taskId,
          relationId: control.relationId ?? "unresolved",
          controlId: control.controlId,
        }));
      }
      const fromNodeId = ensureFieldNode(nodes, control.field, catalog);
      pushEdge({
        edgeId: taskLocalEdgeId({
          edgeType: "DATASET_CONTROL",
          fromNodeId,
          toNodeId: targetWriteNode,
          semanticKey: { controlId: control.controlId },
        }),
        edgeType: "DATASET_CONTROL",
        fromNodeId,
        toNodeId: targetWriteNode,
        properties: {
          subtype: control.subtype,
          grain: control.grain,
          ...(control.grainReason ? { grainReason: control.grainReason } : {}),
          relationId: control.relationId,
          statementId: control.statementId,
          writeObservationId,
          joinType: control.joinType ?? "N/A",
          controlSide: control.controlSide ?? "N/A",
          ...(control.leftRelationId ? { leftRelationId: control.leftRelationId } : {}),
          ...(control.rightRelationId ? { rightRelationId: control.rightRelationId } : {}),
        },
      });
      // Preserve the computed control above. Fold its proven inputs only as
      // DATASET_CONTROL edges scoped to this exact predicate and read use.
      const controlBridges = (materializationsByField.get(materializationKey(control.field.qualifiedName, control.field.column)) ?? [])
        .filter((bridge) => text(bridge.read_statement_id) === control.statementId);
      const controlRefs = controlBridges.flatMap((bridge) => records(bridge.read_control_refs))
        .filter((reference) => text(reference.relation_id) === control.relationId);
      for (const reference of controlRefs) {
        if (reference.resolution_status !== "RESOLVED"
          || !text(reference.read_occurrence_id) || !text(reference.read_relation_id)) {
          pushGap({
            gapId: "control-materialization:" + control.controlId,
            reasonCode: "TASK_LOCAL_CONTROL_MATERIALIZATION_UNRESOLVED",
            details: { taskId, relationId: control.relationId, reason: reference.reason_code ?? "CONTROL_READ_BINDING_UNRESOLVED" },
          });
          continue;
        }
        const controlContext: MaterializationContext = {
          statementId: control.statementId, expressionId: null,
          controlRelationId: control.relationId!, readOccurrenceId: text(reference.read_occurrence_id)!,
        };
        for (const source of expandMaterializedField(control.field, new Set(), controlContext, [], "CONDITIONAL")) {
          if (source.materializationBridgeIds.length === 0) {
            pushGap({
              gapId: "control-materialization-producer:" + control.controlId + ":" + reference.read_occurrence_id,
              reasonCode: "TASK_LOCAL_CONTROL_MATERIALIZATION_UNRESOLVED",
              details: {
                taskId, relationId: control.relationId, readOccurrenceId: reference.read_occurrence_id,
                reason: "CONTROL_PRODUCER_NOT_PROVABLE",
                producerStatuses: controlBridges.map((bridge) => bridge.status),
              },
            });
            continue;
          }
          const leaf = source.leafExpressionId ? fieldEvidenceIndexes.expressionsById.get(source.leafExpressionId) : null;
          if (!leaf) continue;
          for (const emission of emitFieldEvidenceForInput({
            taskId, expression: leaf, sourceField: source.field,
            inputField: inputFieldRecordForSource(leaf, source.field), expanded: source, indexes: fieldEvidenceIndexes,
            branchScoped: true,
          })) {
            if (emission.sourceResolution.gap) pushGap(emission.sourceResolution.gap);
            const sourceNodeId = ensureFieldNode(nodes, source.field, catalog);
            const sourceReadOccurrenceId = emission.sourceResolution.sourceReadOccurrenceStatus === "RESOLVED"
              ? emission.sourceResolution.sourceReadOccurrenceId : null;
            pushEdge({
              edgeId: taskLocalEdgeId({
                edgeType: "DATASET_CONTROL", fromNodeId: sourceNodeId, toNodeId: targetWriteNode,
                semanticKey: {
                  controlId: control.controlId, controlReadOccurrenceId: reference.read_occurrence_id,
                  sourceReadOccurrenceId, materializationBridgeIds: source.materializationBridgeIds,
                },
              }),
              edgeType: "DATASET_CONTROL", fromNodeId: sourceNodeId, toNodeId: targetWriteNode,
              properties: {
                subtype: control.subtype, grain: control.grain,
                ...(control.grainReason ? { grainReason: control.grainReason } : {}),
                relationId: control.relationId, statementId: control.statementId, writeObservationId,
                joinType: control.joinType ?? "N/A", controlSide: control.controlSide ?? "N/A",
                ...(control.leftRelationId ? { leftRelationId: control.leftRelationId } : {}),
                ...(control.rightRelationId ? { rightRelationId: control.rightRelationId } : {}),
                controlInputColumn: control.field.column,
                controlReadOccurrenceId: reference.read_occurrence_id,
                sourceExpressionId: source.leafExpressionId, sourceReadOccurrenceId,
                sourceReadOccurrenceStatus: emission.sourceResolution.sourceReadOccurrenceStatus,
                ...(emission.sourceResolution.sourceReadOccurrenceReason
                  ? { sourceReadOccurrenceReason: emission.sourceResolution.sourceReadOccurrenceReason } : {}),
                materializationBridgeIds: source.materializationBridgeIds, materializationFolded: true,
              },
            });
          }
        }
      }
    }
  }

  return canonicalizeTaskLocalProjection({
    schemaVersion: TASK_LOCAL_PROJECTION_SCHEMA_VERSION,
    artifactType: "TASK_LOCAL_PROJECTION",
    generatedAt,
    taskId,
    taskCategory: resolvedTaskCategory,
    coverageStatus: "PROJECTED",
    coverageDisposition: "DATA_LINEAGE",
    failureReasonCode: null,
    nodes: [...nodes.values()],
    edges,
    gaps,
    localClosure: {
      finalWrites: uniqueByKey(
        [...finalWriteSummaries].sort((left, right) =>
          compareText(left.writeObservationId, right.writeObservationId),
        ),
        (write) => write.writeObservationId,
      ),
      externalReads: uniqueByKey(
        [...externalReadSummaries].sort((left, right) =>
          compareText(left.readOccurrenceId, right.readOccurrenceId),
        ),
        (read) => read.readOccurrenceId,
      ),
      localFieldPaths: [...localFieldPaths].sort((left, right) =>
        compareText(
          `${left.targetWriteNodeId}|${left.outputColumn}|${left.sourceFieldNodeId}`,
          `${right.targetWriteNodeId}|${right.outputColumn}|${right.sourceFieldNodeId}`,
        ),
      ),
    },
  });
}

export function projectTaskLocal(options: ProjectTaskLocalOptions): TaskLocalProjection {
  const taskId = options.taskId.trim();
  const factsRoot = resolve(options.factsRoot);
  const dataRoot = resolve(options.dataRoot);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const schedule = readTaskScheduleContext(taskId, options.scheduleCacheRoot);
  const load = options.currentBundle ?? loadCurrentTaskBundle(factsRoot, taskId);
  const evidenceStatus = factsEvidenceStatus(load);
  const packCategory = readPackTaskCategory(dataRoot, taskId);
  const taskCategory = resolveProjectionTaskCategory({
    taskId,
    dataRoot,
    scheduleCacheRoot: options.scheduleCacheRoot,
    packCategory,
  });

  if (!evidenceStatus) {
    if (schedule) {
      return buildScheduleOnlyProjection({ taskId, generatedAt, schedule, taskCategory });
    }
    return buildCollectionFailedProjection({
      taskId,
      generatedAt,
      failureReasonCode: failureReasonFromLoad(load),
      taskCategory,
    });
  }

  try {
    return projectTaskLocalFromFacts({
      taskId,
      generatedAt,
      load,
      evidenceStatus,
      dataRoot,
      schedule,
      taskCategory,
    });
  } catch (error) {
    const failureReasonCode: TaskLocalFailureReasonCode =
      error instanceof Error && error.message.startsWith("SCHEMA_UNRESOLVED:")
        ? "SCHEMA_UNRESOLVED"
        : "PROJECTION_FAILED";
    return buildCollectionFailedProjection({
      taskId,
      generatedAt,
      failureReasonCode,
      taskCategory,
      failureMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
