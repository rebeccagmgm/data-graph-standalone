import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MACHINE_FACTS_CONTRACT_VERSION,
  isPlatformTargetQueryOutputKind,
  normalizeName,
} from "../../../../../machine-facts/machine-facts-contract.ts";
import {
  type CurrentBundleLoad,
  type JsonRecord,
} from "../../../../../query/current-task-bundle.ts";
import {
  type PhysicalTableCatalog,
  type PhysicalTableCatalogEntry,
  physicalTableKey,
} from "../../../../../machine-facts/input-pack-machine-facts.ts";
import {
  validateTaskDocument,
  type TaskDocument,
} from "../../../../../input/shared/input-pack.ts";
import {
  inferTaskDefaultSchema,
  type TaskDefaultSchema,
} from "../../../../../reconcile/shared/task-default-schema.ts";
import { isCheckdbflagTask } from "../../../../../reconcile/shared/lineage-scope.ts";
import {
  physicalFieldForTable,
} from "../../../../../reconcile/shared/physical-field-resolver.ts";
import {
  physicalFieldKey,
  type FactsPolicy,
  type FieldLineageGap,
  type PhysicalFieldIdentity,
} from "./field-lineage-contract.ts";

export type PhysicalFieldExpanderTaskPack = {
  readonly document: TaskDocument & JsonRecord;
  readonly path: string;
  readonly target: PhysicalTableCatalogEntry | null;
};

export interface PhysicalFieldExpanderTaskPackLookup {
  readonly get: (
    taskId: string,
  ) => PhysicalFieldExpanderTaskPack | undefined;
}

export interface PhysicalFieldExpanderContext {
  readonly dataRoot: string;
  readonly catalog: PhysicalTableCatalog;
  readonly tableLineage: JsonRecord;
  readonly taskPacks: PhysicalFieldExpanderTaskPackLookup;
  readonly loadFacts: (taskId: string) => CurrentBundleLoad;
  readonly factsPolicy: FactsPolicy;
}

export type PhysicalFieldEvidenceMode = "LEGACY_COMPAT" | "STRICT_CAUSAL";

export interface PhysicalFieldExpanderOptions {
  readonly evidenceMode?: PhysicalFieldEvidenceMode;
}

export interface PhysicalFieldExpansionRequest {
  readonly consumerTaskId: string;
  readonly consumerPack: PhysicalFieldExpanderTaskPack;
  readonly consumerLoad: CurrentBundleLoad;
  readonly sourceNodeId: string;
  readonly source: PhysicalFieldIdentity;
  readonly expressionText: string;
  readonly expression?: JsonRecord;
  readonly depth: number;
  readonly maxDepth: number;
  /** Optional causal-consumer metadata; kept out of legacy decisions. */
  readonly candidateBranchId?: string;
  readonly rootDependenceKind?: string;
  readonly localDependenceKind?: string;
  readonly pathCertainty?: string;
  readonly relationState?: JsonRecord;
}

export interface PhysicalFieldProducerExpansion {
  readonly producerTaskId: string;
  readonly producerPack: PhysicalFieldExpanderTaskPack | null;
  readonly producerField: PhysicalFieldIdentity | null;
  readonly producerBindings: readonly JsonRecord[];
  readonly bridge: JsonRecord | null;
  readonly bridges: readonly JsonRecord[];
  readonly producerRole: "PRIMARY" | "ADDITIONAL" | "UNKNOWN" | "CANDIDATE";
  readonly evidenceStatus: "CONFIRMED" | "PROVISIONAL_LEGACY" | "UNRESOLVED";
  readonly evidenceRefs: readonly string[];
  readonly shouldRecurse: boolean;
}

export interface PhysicalFieldExpansion {
  readonly classified: boolean;
  readonly ambiguous: boolean;
  readonly producers: readonly PhysicalFieldProducerExpansion[];
  readonly candidates: readonly {
    readonly candidateId: string;
    readonly consumerTaskId: string;
    readonly producerTaskId: string;
    readonly field: PhysicalFieldIdentity;
    readonly reasonCode: string;
  }[];
  readonly gaps: readonly FieldLineageGap[];
}

type ClassifiedProducerRole =
  | "PRIMARY"
  | "ADDITIONAL"
  | "UNKNOWN"
  | "CANDIDATE";

type LineageDecision = {
  readonly primary: readonly string[];
  readonly additional: readonly string[];
  readonly unknown: readonly string[];
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

function isSkippedLineageTask(document: TaskDocument & JsonRecord): boolean {
  return isCheckdbflagTask({
    taskCategory: document.taskCategory,
    taskName: document.taskName,
  });
}

function factsStatus(
  load: CurrentBundleLoad,
  policy: FactsPolicy,
): "CONFIRMED" | "PROVISIONAL_LEGACY" | null {
  if (load.state === "CURRENT_L1") return "CONFIRMED";
  if (
    load.state === "LEGACY_NOT_L1" &&
    policy === "current-only" &&
    load.manifest?.schema_version === MACHINE_FACTS_CONTRACT_VERSION
  )
    return "CONFIRMED";
  if (load.state === "LEGACY_NOT_L1" && policy === "allow-legacy-partial")
    return "PROVISIONAL_LEGACY";
  return null;
}

function tableLineageDecision(
  tableLineage: JsonRecord,
  taskId: string,
): LineageDecision | undefined {
  const node = (Array.isArray(tableLineage.taskNodes)
    ? tableLineage.taskNodes
    : []
  )
    .map(asRecord)
    .find((item) => item?.taskId === taskId);
  const decision = asRecord(node?.upstreamDecision);
  if (!decision) return undefined;
  const values = (key: string): string[] =>
    (Array.isArray(decision[key]) ? decision[key] : [])
      .map(String)
      .filter(Boolean)
      .sort(compareText);
  return {
    primary: values("primary"),
    additional: values("additional"),
    unknown: values("unknown"),
  };
}

function bridgeRole(bridge: JsonRecord): ClassifiedProducerRole | null {
  const role = String(bridge.producerRole ?? "");
  return ["PRIMARY", "ADDITIONAL", "UNKNOWN", "CANDIDATE"].includes(role)
    ? (role as ClassifiedProducerRole)
    : null;
}

function bridgeTableMatchesField(
  bridge: JsonRecord,
  field: PhysicalFieldIdentity,
): boolean {
  const table = asRecord(bridge.table);
  return (
    normalizeName(String(table?.qualifiedName ?? "")) ===
      normalizeName(field.qualifiedName) &&
    normalizeName(String(table?.platform ?? "")) ===
      normalizeName(field.platform) &&
    normalizeName(String(table?.dataSource ?? "")) ===
      normalizeName(field.dataSource)
  );
}

function expressionQualifiersForColumn(
  expressionText: string,
  column: string,
): readonly string[] {
  const escapedColumn = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|[^\\w$])["\\x60]?([A-Za-z_][\\w$]*)["\\x60]?\\s*\\.\\s*["\\x60]?${escapedColumn}["\\x60]?(?![\\w$])`,
    "gi",
  );
  const qualifiers = new Set<string>();
  for (const match of expressionText.matchAll(pattern))
    if (match[1]) qualifiers.add(normalizeName(match[1]));
  return [...qualifiers].sort(compareText);
}

type BundleIndexes = {
  readonly relations: ReadonlyMap<string, JsonRecord>;
  readonly incomingRelations: ReadonlyMap<string, readonly string[]>;
};

const bundleIndexesCache = new WeakMap<object, BundleIndexes>();

function bundleIndexesFor(load: CurrentBundleLoad): BundleIndexes {
  const cached = bundleIndexesCache.get(load);
  if (cached) return cached;
  const relations = new Map<string, JsonRecord>();
  for (const relation of load.records["relation-nodes.jsonl"] ?? []) {
    const relationId = String(relation.relation_id ?? "");
    if (relationId && !relations.has(relationId)) relations.set(relationId, relation);
  }
  const incomingRelations = new Map<string, string[]>();
  for (const edge of load.records["relation-edges.jsonl"] ?? []) {
    const to = String(edge.to_relation_id ?? "");
    const from = String(edge.from_relation_id ?? "");
    if (!to || !from) continue;
    incomingRelations.set(to, [
      ...(incomingRelations.get(to) ?? []),
      from,
    ]);
  }
  const indexes = { relations, incomingRelations };
  bundleIndexesCache.set(load, indexes);
  return indexes;
}

type RawRelationExpression = {
  readonly relationId: string;
  readonly outputName: string;
  readonly inputNames: readonly string[];
  readonly qualifiers: readonly string[];
  readonly raw: JsonRecord;
};

function rawRelationExpressions(
  relationId: string,
  value: unknown,
): RawRelationExpression[] {
  const result: RawRelationExpression[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = asRecord(candidate);
    if (!record) return;
    const outputName = nonEmpty(record.output);
    const inputColumns = Array.isArray(record.input_columns)
      ? record.input_columns
          .map(asRecord)
          .filter((item): item is JsonRecord => item !== null)
      : [];
    if (outputName && inputColumns.length > 0) {
      result.push({
        relationId,
        outputName: normalizeName(outputName),
        inputNames: inputColumns
          .map((input) => normalizeName(String(input.name ?? "")))
          .filter(Boolean),
        qualifiers: inputColumns
          .map((input) => normalizeName(String(input.qualifier ?? "")))
          .filter(Boolean),
        raw: record,
      });
    }
    for (const key of ["expressions", "measures"]) visit(record[key]);
  };
  visit(value);
  return result;
}

function rawPhysicalInputs(value: unknown, field: PhysicalFieldIdentity): boolean {
  const record = asRecord(value);
  const inputColumns = Array.isArray(record?.input_columns)
    ? record.input_columns
    : [];
  return inputColumns.some((input) => {
    const inputRecord = asRecord(input);
    const physical = Array.isArray(inputRecord?.physical)
      ? inputRecord.physical
      : [];
    return physical.some((item) => {
      const physicalRecord = asRecord(item);
      return (
        normalizeName(String(physicalRecord?.table ?? "")) ===
          normalizeName(field.qualifiedName) &&
        normalizeName(String(physicalRecord?.column ?? "")) === field.column
      );
    });
  });
}

function relationDistance(
  indexes: BundleIndexes,
  fromRelationId: string,
  targetRelationId: string,
): number {
  const sameRelation = (left: string, right: string): boolean =>
    left === right ||
    left.endsWith(`:relation:${right}`) ||
    right.endsWith(`:relation:${left}`);
  if (sameRelation(fromRelationId, targetRelationId)) return 0;
  const queue: Array<{ relationId: string; distance: number }> = [
    { relationId: fromRelationId, distance: 0 },
  ];
  const seen = new Set<string>([fromRelationId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of indexes.incomingRelations.get(current.relationId) ?? []) {
      if (seen.has(child)) continue;
      if (sameRelation(child, targetRelationId)) return current.distance + 1;
      seen.add(child);
      queue.push({ relationId: child, distance: current.distance + 1 });
    }
  }
  return Number.POSITIVE_INFINITY;
}

function relationPathHasQualifier(relationId: string, qualifier: string): boolean {
  const normalized = normalizeName(qualifier);
  return (
    normalized !== "" &&
    relationId.split(/[.:]/).some((part) => normalizeName(part) === normalized)
  );
}

function derivedOccurrenceSelection(
  load: CurrentBundleLoad,
  expression: JsonRecord,
  field: PhysicalFieldIdentity,
  matching: readonly JsonRecord[],
): ReadonlySet<string> {
  const indexes = bundleIndexesFor(load);
  const relationId = String(expression.relation_id ?? "");
  const relation = indexes.relations.get(relationId);
  if (!relationId || !relation) return new Set();
  const expressionOutput = normalizeName(
    String(expression.output_name ?? expression.output ?? ""),
  );
  const currentExpressions = rawRelationExpressions(
    relationId,
    relation.relation,
  ).filter(
    (candidate) =>
      candidate.outputName === expressionOutput &&
      rawPhysicalInputs(candidate.raw, field),
  );
  const inputNames = new Set(
    currentExpressions.flatMap((candidate) => candidate.inputNames),
  );
  if (inputNames.size === 0) return new Set();
  const descendants = new Set<string>();
  const queue = [relationId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (descendants.has(current)) continue;
    descendants.add(current);
    queue.push(...(indexes.incomingRelations.get(current) ?? []));
  }
  const rawCandidates: RawRelationExpression[] = [];
  for (const candidateRelationId of descendants) {
    if (candidateRelationId === relationId) continue;
    const candidateRelation = indexes.relations.get(candidateRelationId);
    if (!candidateRelation) continue;
    for (const candidate of rawRelationExpressions(
      candidateRelationId,
      candidateRelation.relation,
    )) {
      if (
        inputNames.has(candidate.outputName) &&
        rawPhysicalInputs(candidate.raw, field)
      )
        rawCandidates.push(candidate);
    }
  }
  if (rawCandidates.length === 0) return new Set();
  const statementIndex =
    String(expression.statement_id ?? "").match(/:statement:(\d+)$/)?.[1] ??
    null;
  const scored = new Map<string, number>();
  for (const bridge of matching) {
    const occurrence = asRecord(bridge.readOccurrence);
    const occurrenceId = nonEmpty(occurrence?.occurrenceId);
    const readRelationId = nonEmpty(occurrence?.readRelationId);
    if (!occurrenceId || !readRelationId) continue;
    if (
      statementIndex !== null &&
      String(occurrence?.statementIndex ?? "") !== statementIndex
    )
      continue;
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of rawCandidates) {
      const distance = relationDistance(
        indexes,
        candidate.relationId,
        readRelationId,
      );
      if (!Number.isFinite(distance)) continue;
      const qualifierMatch = candidate.qualifiers.some((qualifier) =>
        relationPathHasQualifier(readRelationId, qualifier),
      );
      best = Math.min(best, qualifierMatch ? 0 : distance);
    }
    if (Number.isFinite(best)) scored.set(occurrenceId, best);
  }
  if (scored.size === 0) return new Set();
  const minimum = Math.min(...scored.values());
  return new Set(
    [...scored.entries()]
      .filter(([, score]) => score === minimum)
      .map(([occurrenceId]) => occurrenceId),
  );
}

function selectBridges(
  tableLineage: JsonRecord,
  consumerTaskId: string,
  field: PhysicalFieldIdentity,
  expressionText: string,
  load?: CurrentBundleLoad,
  expression?: JsonRecord,
): {
  readonly classified: boolean;
  readonly ambiguous: boolean;
  readonly selected: readonly JsonRecord[];
  readonly matching: readonly JsonRecord[];
} {
  const matching = (Array.isArray(tableLineage.producerBridges)
    ? tableLineage.producerBridges
    : []
  )
    .map(asRecord)
    .filter(
      (bridge): bridge is JsonRecord =>
        bridge !== null &&
        bridge.consumerTaskId === consumerTaskId &&
        bridgeTableMatchesField(bridge, field),
    );
  const classified = matching.length > 0 && matching.every(bridgeRole);
  if (!classified) return { classified: false, ambiguous: false, selected: [], matching };
  if (matching.every((bridge) => bridge.readOccurrence === null))
    return { classified: true, ambiguous: false, selected: matching, matching };
  const byOccurrence = new Map<string, JsonRecord[]>();
  for (const bridge of matching) {
    const occurrenceId = nonEmpty(asRecord(bridge.readOccurrence)?.occurrenceId);
    if (!occurrenceId)
      return { classified: true, ambiguous: true, selected: [], matching };
    byOccurrence.set(occurrenceId, [
      ...(byOccurrence.get(occurrenceId) ?? []),
      bridge,
    ]);
  }
  if (byOccurrence.size === 1)
    return { classified: true, ambiguous: false, selected: matching, matching };
  const producerSignatures = new Set(
    [...byOccurrence.values()].map((bridges) =>
      bridges
        .map(
          (bridge) =>
            `${String(bridge.producerTaskId ?? "")}:${String(bridgeRole(bridge) ?? "")}`,
        )
        .sort(compareText)
        .join("|"),
    ),
  );
  if (producerSignatures.size === 1)
    return { classified: true, ambiguous: false, selected: matching, matching };
  const qualifiers = expressionQualifiersForColumn(expressionText, field.column);
  if (qualifiers.length === 0 && load && expression) {
    const occurrenceIds = derivedOccurrenceSelection(load, expression, field, matching);
    if (occurrenceIds.size > 0)
      return {
        classified: true,
        ambiguous: false,
        selected: matching.filter((bridge) =>
          occurrenceIds.has(String(asRecord(bridge.readOccurrence)?.occurrenceId ?? "")),
        ),
        matching,
      };
  }
  if (qualifiers.length === 0)
    return { classified: true, ambiguous: true, selected: [], matching };
  const selectedOccurrenceIds = new Set<string>();
  for (const qualifier of qualifiers) {
    const occurrenceIds = new Set(
      matching
        .filter((bridge) => {
          const occurrence = asRecord(bridge.readOccurrence);
          return [
            occurrence?.readRelationId,
            ...(Array.isArray(occurrence?.relationPath) ? occurrence.relationPath : []),
          ]
            .map((value) => normalizeName(String(value ?? "")))
            .some((relationId) => relationId.split(".").includes(qualifier));
        })
        .map((bridge) => String(asRecord(bridge.readOccurrence)?.occurrenceId ?? ""))
        .filter(Boolean),
    );
    if (occurrenceIds.size !== 1)
      return { classified: true, ambiguous: true, selected: [], matching };
    selectedOccurrenceIds.add([...occurrenceIds][0]!);
  }
  return {
    classified: true,
    ambiguous: false,
    selected: matching.filter((bridge) =>
      selectedOccurrenceIds.has(String(asRecord(bridge.readOccurrence)?.occurrenceId ?? "")),
    ),
    matching,
  };
}

function hasTaskEdge(
  tableLineage: JsonRecord,
  consumerTaskId: string,
  producerTaskId: string,
): boolean {
  return [
    ...(Array.isArray(tableLineage.producerBridges) ? tableLineage.producerBridges : []),
    ...(Array.isArray(tableLineage.scheduleEdges) ? tableLineage.scheduleEdges : []),
  ].some((raw) => {
    const edge = asRecord(raw);
    return edge?.consumerTaskId === consumerTaskId && edge?.producerTaskId === producerTaskId;
  });
}

function producerTargetsConsumerTable(
  taskPacks: PhysicalFieldExpanderTaskPackLookup,
  consumerTaskId: string,
  producerTaskId: string,
): boolean {
  const consumerTarget = taskPacks.get(consumerTaskId)?.target;
  const producerTarget = taskPacks.get(producerTaskId)?.target;
  return (
    consumerTarget !== null &&
    consumerTarget !== undefined &&
    producerTarget !== null &&
    producerTarget !== undefined &&
    physicalTableKey(consumerTarget) === physicalTableKey(producerTarget)
  );
}

function producerRelationMatchesField(
  context: PhysicalFieldExpanderContext,
  consumerTaskId: string,
  producerTaskId: string,
  field: PhysicalFieldIdentity,
): boolean {
  if (!hasTaskEdge(context.tableLineage, consumerTaskId, producerTaskId)) return false;
  const bridgeMatch = (Array.isArray(context.tableLineage.producerBridges)
    ? context.tableLineage.producerBridges
    : []
  ).some((raw) => {
    const bridge = asRecord(raw);
    return (
      bridge?.consumerTaskId === consumerTaskId &&
      bridge?.producerTaskId === producerTaskId &&
      bridgeTableMatchesField(bridge, field)
    );
  });
  if (bridgeMatch) return true;
  return scheduleReadFallbackMatches(context, consumerTaskId, producerTaskId, field);
}

function scheduleReadFallbackMatches(
  context: PhysicalFieldExpanderContext,
  consumerTaskId: string,
  producerTaskId: string,
  field: PhysicalFieldIdentity,
): boolean {
  const decision = tableLineageDecision(context.tableLineage, consumerTaskId);
  if (decision?.primary.length !== 1 || decision.primary[0] !== producerTaskId) return false;
  const scheduleMatch = (Array.isArray(context.tableLineage.scheduleEdges)
    ? context.tableLineage.scheduleEdges
    : []
  ).some((raw) => {
    const edge = asRecord(raw);
    return edge?.consumerTaskId === consumerTaskId && edge?.producerTaskId === producerTaskId;
  });
  if (!scheduleMatch) return false;
  const eligibleReads = (Array.isArray(context.tableLineage.readEdges)
    ? context.tableLineage.readEdges
    : []
  ).filter((raw) => {
    const edge = asRecord(raw);
    return edge?.consumerTaskId === consumerTaskId && edge?.recursionStatus === "ELIGIBLE";
  });
  if (eligibleReads.length !== 1) return false;
  const table = asRecord(asRecord(eligibleReads[0])?.table);
  return (
    normalizeName(String(table?.qualifiedName ?? "")) === normalizeName(field.qualifiedName) &&
    normalizeName(String(table?.platform ?? "")) === normalizeName(field.platform) &&
    normalizeName(String(table?.dataSource ?? "")) === normalizeName(field.dataSource)
  );
}

function producerMatchesField(
  context: PhysicalFieldExpanderContext,
  consumerTaskId: string,
  producerTaskId: string,
  field: PhysicalFieldIdentity,
): boolean {
  if (!producerRelationMatchesField(context, consumerTaskId, producerTaskId, field))
    return false;
  const target = context.taskPacks.get(producerTaskId)?.target;
  if (!target) return true;
  if (physicalTableKey(target) !== physicalTableKey(field)) return false;
  const targetField = physicalFieldForTable(target, field.column);
  return targetField !== null && physicalFieldKey(targetField) === physicalFieldKey(field);
}

function canonicalRelationIdentity(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const withoutQueryPrefix = raw
    .replace(/^query#[^:]+:/i, "")
    .replace(/^\d+:/, "");
  const marker = withoutQueryPrefix.lastIndexOf(":relation:");
  return normalizeName(
    marker >= 0 ? withoutQueryPrefix.slice(marker + ":relation:".length) : withoutQueryPrefix,
  );
}

function sameRelationIdentity(left: unknown, right: unknown): boolean {
  const leftIdentity = canonicalRelationIdentity(left);
  const rightIdentity = canonicalRelationIdentity(right);
  return leftIdentity !== null && leftIdentity === rightIdentity;
}

function statementIndexForRelation(
  load: CurrentBundleLoad,
  relation: JsonRecord,
): number | null {
  const statementId = nonEmpty(relation.statement_id);
  const statement = (load.records["statements.jsonl"] ?? []).find(
    (candidate) => String(candidate.statement_id ?? "") === statementId,
  );
  if (Number.isSafeInteger(statement?.statement_index))
    return Number(statement?.statement_index);
  return String(relation.relation_id ?? "").match(/:statement:(\d+):relation:/)?.[1]
    ? Number(String(relation.relation_id).match(/:statement:(\d+):relation:/)?.[1])
    : null;
}

function statementIndexForId(
  load: CurrentBundleLoad,
  statementId: unknown,
): number | null {
  const normalizedStatementId = nonEmpty(statementId);
  if (!normalizedStatementId) return null;
  const statement = (load.records["statements.jsonl"] ?? []).find(
    (candidate) => String(candidate.statement_id ?? "") === normalizedStatementId,
  );
  const statementIndex = statement?.statement_index;
  if (Number.isSafeInteger(statementIndex)) return Number(statementIndex);
  const match = normalizedStatementId.match(/:statement:(\d+)(?::|$)/);
  return match ? Number(match[1]) : null;
}

function relationPathBinding(relationPath: readonly string[]): string | null {
  for (const rawPathItem of relationPath) {
    const pathItem = canonicalRelationIdentity(rawPathItem);
    if (!pathItem) continue;
    const parts = pathItem.split(".");
    const readIndex = parts.indexOf("read");
    if (readIndex < 0) continue;
    const binding =
      parts[readIndex + 1] === parts.at(-1)
        ? parts[readIndex - 1]
        : parts[readIndex + 1] ?? parts[readIndex - 1];
    if (binding && binding !== "read") return binding;
  }
  return null;
}

function validateConsumerReadOccurrence(
  load: CurrentBundleLoad,
  field: PhysicalFieldIdentity,
  occurrence: JsonRecord,
): { readonly valid: boolean; readonly reason: string | null } {
  const occurrenceId = nonEmpty(occurrence.occurrenceId);
  const readRelationId = nonEmpty(occurrence.readRelationId);
  const statementIndex = occurrence.statementIndex;
  const relationPath = occurrence.relationPath;
  if (
    !occurrenceId ||
    !readRelationId ||
    !Number.isSafeInteger(statementIndex) ||
    !Array.isArray(relationPath) ||
    relationPath.length === 0 ||
    relationPath.some((item) => !nonEmpty(item))
  )
    return { valid: false, reason: "CONSUMER_READ_OCCURRENCE_EVIDENCE_MISMATCH" };

  // Older callers did not load relation-nodes into their synthetic bundles.
  // Keep that compatibility shape working, while an explicitly present file
  // is authoritative and must prove the occurrence below.
  if (!Object.prototype.hasOwnProperty.call(load.records, "relation-nodes.jsonl"))
    return { valid: true, reason: null };

  const qualifiedTable = normalizeName(field.qualifiedName);
  const tableTail = qualifiedTable.split(".").at(-1) ?? qualifiedTable;
  const expectedBinding = relationPathBinding(relationPath);
  const matchingRead = (load.records["relation-nodes.jsonl"] ?? []).find((node) => {
    const relation = asRecord(node.relation);
    const relationTable = normalizeName(String(relation?.table ?? ""));
    const bareTableIsSupported =
      relationTable === tableTail &&
      (load.records["dataset-io.jsonl"] ?? []).some(
        (record) =>
          record.direction === "READ" &&
          record.task_id === load.taskId &&
          normalizeName(String(record.physical_dataset ?? "")).split(".").at(-1) ===
            tableTail,
      );
    if (
      String(node.task_id ?? "") !== load.taskId ||
      String(node.relation_type ?? relation?.type ?? "") !== "read" ||
      (relationTable !== qualifiedTable && !bareTableIsSupported)
    )
      return false;
    const actualOccurrenceId = nonEmpty(
      relation?.read_occurrence_id ??
        asRecord(relation?.read_occurrence)?.occurrence_id ??
        node.read_occurrence_id,
    );
    const actualRelationId = nonEmpty(
      node.relation_id ??
        relation?.id ??
        asRecord(relation?.read_occurrence)?.relation_id,
    );
    const relationIdentityMatches = sameRelationIdentity(actualRelationId, readRelationId);
    const occurrenceIdentityMatches =
      actualOccurrenceId !== null &&
      sameRelationIdentity(actualOccurrenceId, occurrenceId);
    const legacyIdentity =
      expectedBinding !== null &&
      normalizeName(String(relation?.binding ?? "")) === expectedBinding &&
      normalizeName(String(relation?.scope_id ?? "")).split(".")[0] ===
        normalizeName(
          String(canonicalRelationIdentity(relationPath[0]) ?? "").split(".")[0],
        );
    // Legacy 1.3 bundles do not carry read_occurrence_id on relation nodes.
    // A canonical relation id is still occurrence-specific within a
    // statement, so it is sufficient when the occurrence field itself is
    // absent.  Never use this fallback when an occurrence id is present but
    // disagrees: that remains a hard evidence mismatch.
    const identityProven =
      occurrenceIdentityMatches
        ? relationIdentityMatches
        : actualOccurrenceId === null
          ? relationIdentityMatches || legacyIdentity
          : false;
    return (
      identityProven &&
      statementIndexForRelation(load, node) === statementIndex
    );
  });
  if (!matchingRead)
    return { valid: false, reason: "CONSUMER_READ_OCCURRENCE_NOT_PROVEN" };

  const statementDatasetReads = (load.records["dataset-io.jsonl"] ?? []).filter(
    (record) => {
      if (
        record.direction !== "READ" ||
        String(record.task_id ?? "") !== load.taskId
      )
        return false;
      const dataset = normalizeName(String(record.physical_dataset ?? ""));
      if (dataset !== qualifiedTable && dataset.split(".").at(-1) !== tableTail)
        return false;
      return statementIndexForId(load, record.statement_id) === statementIndex;
    },
  );
  const matchingDatasetRead = statementDatasetReads.some((record) => {
    if (Array.isArray(record.read_occurrences))
      return record.read_occurrences.some((rawOccurrence) => {
        const readOccurrence = asRecord(rawOccurrence);
        return (
          readOccurrence !== null &&
          sameRelationIdentity(
            readOccurrence.occurrence_id,
            matchingRead.relation?.read_occurrence_id ??
              matchingRead.read_occurrence_id,
          ) &&
          sameRelationIdentity(readOccurrence.relation_id, matchingRead.relation_id)
        );
      });
    // Without occurrence data, accept only a unique physical read in the
    // statement.  This preserves self-join/repeated-read isolation.
    return statementDatasetReads.length === 1;
  });
  if (!matchingDatasetRead)
    return { valid: false, reason: "CONSUMER_READ_OCCURRENCE_NOT_PROVEN" };

  const relation = asRecord(matchingRead.relation);
  const expectedScope = nonEmpty(occurrence.scopeId ?? occurrence.scope_id);
  const actualScope = nonEmpty(relation?.scope_id ?? asRecord(relation?.read_occurrence)?.scope_id);
  if (expectedScope !== null && actualScope !== expectedScope)
    return { valid: false, reason: "CONSUMER_READ_OCCURRENCE_EVIDENCE_MISMATCH" };
  return { valid: true, reason: null };
}

function bridgeGroupsForProducer(
  bridges: readonly JsonRecord[],
  producerTaskId: string,
): readonly (readonly JsonRecord[])[] {
  const matching = bridges.filter(
    (bridge) => String(bridge.producerTaskId ?? "") === producerTaskId,
  );
  if (matching.length === 0) return [[]];
  const groups = new Map<string, JsonRecord[]>();
  for (const bridge of matching) {
    const occurrenceId = nonEmpty(asRecord(bridge.readOccurrence)?.occurrenceId);
    const key = occurrenceId ?? "<legacy-no-occurrence>";
    groups.set(key, [...(groups.get(key) ?? []), bridge]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, group]) => group);
}

export function outputBindingsFor(
  load: CurrentBundleLoad,
  targetQualifiedName: string,
  field: PhysicalFieldIdentity,
  writeObservationIds?: ReadonlySet<string>,
  expectedTarget?: PhysicalTableCatalogEntry,
  evidenceMode: PhysicalFieldEvidenceMode = "LEGACY_COMPAT",
): JsonRecord[] {
  const normalizedTarget = normalizeName(targetQualifiedName);
  const expectedTargetName = expectedTarget ? normalizeName(expectedTarget.qualifiedName) : null;
  const expectedTargetTail = expectedTargetName?.split(".").at(-1) ?? null;
  const hasDeclaredPhysicalTarget = expectedTarget
    ? (load.records["dataset-io.jsonl"] ?? []).some(
        (record) =>
          record.task_id === load.taskId &&
          record.direction === "WRITE" &&
          normalizeName(String(record.physical_dataset ?? "")) === expectedTargetName,
      )
    : false;
  return (load.records["output-field-bindings.jsonl"] ?? [])
    .filter(
      (binding) => {
        const writeObservationId = nonEmpty(binding.write_observation_id);
        const write = (load.records["dataset-io.jsonl"] ?? []).find(
          (record) =>
            record.direction === "WRITE" &&
            record.task_id === load.taskId &&
            nonEmpty(record.write_observation_id) === writeObservationId,
        );
        const bindingWriteStatementId = nonEmpty(binding.write_statement_id);
        const writeStatementId = nonEmpty(
          write?.write_statement_id ?? write?.statement_id,
        );
        const bindingStatementId = nonEmpty(binding.statement_id);
        const writeRecordStatementId = nonEmpty(write?.statement_id);
        return (
          binding.task_id === load.taskId &&
         (normalizeName(String(binding.target_dataset ?? "")) === normalizedTarget ||
          (hasDeclaredPhysicalTarget &&
            expectedTargetTail !== null &&
            normalizeName(String(binding.target_dataset ?? "")) === expectedTargetTail &&
             normalizedTarget === expectedTargetName &&
             binding.task_id === load.taskId)) &&
         normalizeName(String(binding.target_field ?? "")) === field.column &&
         (evidenceMode === "LEGACY_COMPAT" ||
           (bindingWriteStatementId === null || bindingWriteStatementId === writeStatementId)) &&
         (evidenceMode === "LEGACY_COMPAT" ||
           (bindingStatementId === null || bindingStatementId === writeRecordStatementId)) &&
         (writeObservationIds === undefined ||
           writeObservationIds.has(String(binding.write_observation_id ?? ""))) &&
          binding.binding_status === "RESOLVED"
        );
      },
    )
    .sort((left, right) => compareText(String(left.binding_id ?? ""), String(right.binding_id ?? "")));
}

type ProducerWriteProof = {
  readonly ids: ReadonlySet<string>;
  readonly status: "PROVEN" | "AMBIGUOUS" | "MISSING";
  readonly reason: string | null;
};

function hasConcretePartitionScope(artifactWrite: JsonRecord): boolean {
  if (String(artifactWrite.partitionStatus ?? "") !== "COMPLETE") return false;
  const assignments = (Array.isArray(artifactWrite.partition)
    ? artifactWrite.partition
    : []
  )
    .map(asRecord)
    .filter((assignment): assignment is JsonRecord => assignment !== null);
  return (
    assignments.length > 0 &&
    assignments.every(
      (assignment) =>
        nonEmpty(assignment.field) !== null &&
        String(assignment.valueStatus ?? "") === "OBSERVED_RENDERED_VALUE" &&
        nonEmpty(assignment.observedValue) !== null,
    )
  );
}

function resolvedFieldWriteObservationIds(
  producerTaskId: string,
  field: PhysicalFieldIdentity,
  producerLoad: CurrentBundleLoad,
): ReadonlySet<string> {
  return new Set(
    outputBindingsFor(
      producerLoad,
      field.qualifiedName,
      field,
      undefined,
      undefined,
      "STRICT_CAUSAL",
    )
      .map((binding) => nonEmpty(binding.write_observation_id))
      .filter((id): id is string => id !== null)
      .filter((id) => id.startsWith(`write-observation:${producerTaskId}:`)),
  );
}

/**
 * A table-level write edge may intentionally omit write occurrence identity.
 * When it still carries a concrete partition and every matching Machine Facts
 * write resolves the same target field, keep all occurrences as supporting
 * evidence instead of manufacturing a single winner.  This does not apply to
 * incomplete/unknown partitions, so the existing fail-closed behavior remains
 * for genuinely unconstrained multi-write matches.
 */
function aggregateableWriteMatches(
  artifactWrite: JsonRecord,
  matchIds: readonly string[],
  producerTaskId: string,
  field: PhysicalFieldIdentity,
  producerLoad: CurrentBundleLoad,
): readonly string[] {
  const ids = [...new Set(matchIds)].sort(compareText);
  if (ids.length < 2 || !hasConcretePartitionScope(artifactWrite)) return [];
  const resolvedIds = resolvedFieldWriteObservationIds(
    producerTaskId,
    field,
    producerLoad,
  );
  return ids.every((id) => resolvedIds.has(id)) ? ids : [];
}

function writeObservationIds(value: unknown): readonly string[] {
  const record = asRecord(value);
  return [
    record?.writeObservationId,
    record?.write_observation_id,
    record?.producerWriteObservationId,
    record?.producer_write_observation_id,
  ]
    .map(nonEmpty)
    .filter((id): id is string => id !== null);
}

function artifactWriteEdgesFor(
  tableLineage: JsonRecord,
  producerTaskId: string,
  field: PhysicalFieldIdentity,
): JsonRecord[] {
  return (Array.isArray(tableLineage.writeEdges) ? tableLineage.writeEdges : [])
    .map(asRecord)
    .filter(
      (edge): edge is JsonRecord =>
        edge !== null &&
        edge.producerTaskId === producerTaskId &&
        bridgeTableMatchesField(edge, field),
    );
}

function producerWriteRecords(
  producerTaskId: string,
  field: PhysicalFieldIdentity,
  producerLoad: CurrentBundleLoad,
): JsonRecord[] {
  return (producerLoad.records["dataset-io.jsonl"] ?? []).filter(
    (record) =>
      record.direction === "WRITE" &&
      record.task_id === producerTaskId &&
      nonEmpty(record.write_observation_id) !== null &&
      normalizeName(String(record.physical_dataset ?? "")) ===
        normalizeName(field.qualifiedName),
  );
}

function sqlParseSpan(
  write: JsonRecord,
): { readonly start: number; readonly end: number } | null {
  for (const rawEvidence of Array.isArray(write.evidence) ? write.evidence : []) {
    const evidence = asRecord(rawEvidence);
    if (String(evidence?.source ?? "") !== "SQL_PARSE") continue;
    const detail = asRecord(evidence?.detail);
    if (
      Number.isSafeInteger(detail?.statementStart) &&
      Number.isSafeInteger(detail?.statementEnd)
    )
      return {
        start: Number(detail?.statementStart),
        end: Number(detail?.statementEnd),
      };
    const match = String(evidence?.locator ?? "").match(/#char=(\d+)-(\d+)$/);
    if (match) return { start: Number(match[1]), end: Number(match[2]) };
  }
  return null;
}

function spanEquals(
  value: unknown,
  expected: { readonly start: number; readonly end: number },
): boolean {
  const span = asRecord(value);
  return (
    Number.isSafeInteger(span?.start) &&
    Number.isSafeInteger(span?.end) &&
    Number(span?.start) === expected.start &&
    Number(span?.end) === expected.end
  );
}

/**
 * The table-producer snapshot and Machine Facts use the same SQL statement,
 * but older producers recorded the final character as an inclusive endpoint
 * while the current bundle records a half-open endpoint.  Treat only that
 * one-character representation difference as equivalent; the statement id,
 * write kind and provenance are still checked by the caller.
 */
function spanMatchesBoundaryConvention(
  value: unknown,
  expected: { readonly start: number; readonly end: number },
): boolean {
  if (spanEquals(value, expected)) return true;
  const span = asRecord(value);
  return (
    Number.isSafeInteger(span?.start) &&
    Number.isSafeInteger(span?.end) &&
    Number(span?.start) === expected.start &&
    Math.abs(Number(span?.end) - expected.end) === 1
  );
}

function strictWriteMatchesArtifact(
  artifactWrite: JsonRecord,
  producerRecord: JsonRecord,
  producerLoad: CurrentBundleLoad,
): boolean {
  const observationKind = String(artifactWrite.observationKind ?? "");
  const provenance = String(producerRecord.provenance ?? "");
  if (observationKind === "SQL_EXPLICIT_WRITE") {
    if (provenance !== "SQL_PARSE") return false;
    const expectedKind = nonEmpty(artifactWrite.sqlWriteKind);
    if (
      expectedKind !== null &&
      normalizeName(String(producerRecord.write_kind ?? "")) !== normalizeName(expectedKind)
    )
      return false;
    const expectedSpan = sqlParseSpan(artifactWrite);
    if (expectedSpan === null) return false;
    const expectedStatementId = nonEmpty(
      artifactWrite.writeStatementId ??
        artifactWrite.write_statement_id ??
        artifactWrite.statementId,
    );
    const statementId = String(
      producerRecord.write_statement_id ?? producerRecord.statement_id ?? "",
    );
    if (expectedStatementId !== null && expectedStatementId !== statementId)
      return false;
    const statement = (producerLoad.records["statements.jsonl"] ?? []).find(
      (candidate) => String(candidate.statement_id ?? "") === statementId,
    );
    const span = asRecord(statement?.span);
    const boundary = asRecord(producerRecord.source_as_boundary)?.statement_span;
    const boundarySpan = asRecord(boundary);
    return (
      spanMatchesBoundaryConvention(span, expectedSpan) ||
      spanMatchesBoundaryConvention(boundarySpan, expectedSpan)
    );
  }
  if (observationKind === "DIRECT_TARGET")
    return (
      provenance === "PLATFORM_TARGET" ||
      isPlatformTargetQueryOutputKind(producerRecord.write_kind)
    );
  return false;
}

function legacySqlParseStart(write: JsonRecord): number | null {
  for (const rawEvidence of Array.isArray(write.evidence) ? write.evidence : []) {
    const evidence = asRecord(rawEvidence);
    if (String(evidence?.source ?? "") !== "SQL_PARSE") continue;
    const detail = asRecord(evidence?.detail);
    const statementStart = detail?.statementStart;
    if (Number.isSafeInteger(statementStart)) return Number(statementStart);
    const start = String(evidence?.locator ?? "").match(/#char=(\d+)(?:-\d+)?$/)?.[1];
    if (start !== undefined) return Number(start);
  }
  return null;
}

function legacyWriteMatchesArtifact(
  artifactWrite: JsonRecord,
  producerRecord: JsonRecord,
  producerLoad: CurrentBundleLoad,
  requireSqlPosition = true,
): boolean {
  const observationKind = String(artifactWrite.observationKind ?? "");
  const provenance = String(producerRecord.provenance ?? "");
  if (observationKind === "SQL_EXPLICIT_WRITE") {
    if (provenance !== "SQL_PARSE") return false;
    const expectedKind = nonEmpty(artifactWrite.sqlWriteKind);
    if (
      expectedKind !== null &&
      normalizeName(String(producerRecord.write_kind ?? "")) !== normalizeName(expectedKind)
    )
      return false;
    if (!requireSqlPosition) return true;
    const expectedStart = legacySqlParseStart(artifactWrite);
    if (expectedStart === null) return true;
    const statementId = String(
      producerRecord.write_statement_id ?? producerRecord.statement_id ?? "",
    );
    const statement = (producerLoad.records["statements.jsonl"] ?? []).find(
      (candidate) => String(candidate.statement_id ?? "") === statementId,
    );
    const span = asRecord(statement?.span);
    const boundary = asRecord(producerRecord.source_as_boundary)?.statement_span;
    const boundarySpan = asRecord(boundary);
    return [span?.start, span?.end, boundarySpan?.start, boundarySpan?.end].some(
      (value) => Number.isSafeInteger(value) && Number(value) === expectedStart,
    );
  }
  if (observationKind === "DIRECT_TARGET")
    return (
      provenance === "PLATFORM_TARGET" ||
      isPlatformTargetQueryOutputKind(producerRecord.write_kind)
    );
  return false;
}

function legacyProducerWriteProof(
  tableLineage: JsonRecord,
  producerTaskId: string,
  field: PhysicalFieldIdentity,
  bridges: readonly JsonRecord[],
  producerLoad: CurrentBundleLoad | null,
): ProducerWriteProof {
  const explicitIds = new Set(bridges.flatMap(writeObservationIds));
  if (producerLoad === null)
    return {
      ids: new Set(),
      status: "MISSING",
      reason: "PRODUCER_WRITE_OBSERVATION_NOT_PROVEN",
    };
  const records = producerWriteRecords(producerTaskId, field, producerLoad);
  const recordById = new Map(
    records.map((record) => [String(record.write_observation_id), record]),
  );
  if (explicitIds.size > 0) {
    const valid = [...explicitIds].every((id) => recordById.has(id));
    return valid
      ? { ids: explicitIds, status: "PROVEN", reason: null }
      : {
          ids: new Set(),
          status: "MISSING",
          reason: "PRODUCER_WRITE_OBSERVATION_NOT_PROVEN",
        };
  }

  const edges = artifactWriteEdgesFor(tableLineage, producerTaskId, field);
  const artifactWrites = edges.flatMap((edge) =>
    (Array.isArray(edge.writes) ? edge.writes : []).map(asRecord).filter(
      (write): write is JsonRecord => write !== null,
    ),
  );
  if (edges.length === 0 && artifactWrites.length === 0)
    return records.length === 1
      ? {
          ids: new Set([String(records[0]!.write_observation_id)]),
          status: "PROVEN",
          reason: null,
        }
      : {
          ids: new Set(),
          status: records.length === 0 ? "MISSING" : "AMBIGUOUS",
          reason:
            records.length === 0
              ? "PRODUCER_WRITE_OBSERVATION_NOT_PROVEN"
              : "PRODUCER_WRITE_OBSERVATION_AMBIGUOUS",
        };
  if (edges.length !== 1 || artifactWrites.length === 0)
    return {
      ids: new Set(),
      status: records.length === 0 ? "MISSING" : "AMBIGUOUS",
      reason:
        records.length === 0
          ? "PRODUCER_WRITE_OBSERVATION_NOT_PROVEN"
          : "PRODUCER_WRITE_OBSERVATION_AMBIGUOUS",
    };

  const matchedIds = new Set<string>();
  let ambiguous = false;
  let hasAggregatedMatches = false;
  for (const artifactWrite of artifactWrites) {
    const embeddedIds = writeObservationIds(artifactWrite).filter((id) =>
      recordById.has(id),
    );
    const matches = embeddedIds.length > 0
      ? [...new Set(embeddedIds)]
      : (() => {
          const exactMatches = records
            .filter((record) =>
              legacyWriteMatchesArtifact(artifactWrite, record, producerLoad),
            )
            .map((record) => String(record.write_observation_id));
          if (exactMatches.length > 0) return exactMatches;
          // Table-level and producer facts may use different SQL span offsets;
          // keep the fallback unique by physical table and write kind.
          return records
            .filter((record) =>
              legacyWriteMatchesArtifact(artifactWrite, record, producerLoad, false),
            )
            .map((record) => String(record.write_observation_id));
        })();
    const aggregatedIds = aggregateableWriteMatches(
      artifactWrite,
      matches,
      producerTaskId,
      field,
      producerLoad,
    );
    if (aggregatedIds.length > 0) {
      hasAggregatedMatches = true;
      aggregatedIds.forEach((id) => matchedIds.add(id));
      continue;
    }
    if (matches.length !== 1) {
      ambiguous = true;
      continue;
    }
    matchedIds.add(matches[0]!);
  }
  if (
    ambiguous ||
    matchedIds.size === 0 ||
    (matchedIds.size !== 1 && !hasAggregatedMatches)
  )
    return {
      ids: new Set(),
      status: "AMBIGUOUS",
      reason: "PRODUCER_WRITE_OBSERVATION_AMBIGUOUS",
    };
  return { ids: matchedIds, status: "PROVEN", reason: null };
}

function strictProducerWriteProof(
  tableLineage: JsonRecord,
  producerTaskId: string,
  field: PhysicalFieldIdentity,
  bridges: readonly JsonRecord[],
  producerLoad: CurrentBundleLoad | null,
): ProducerWriteProof {
  const explicitIds = new Set(bridges.flatMap(writeObservationIds));
  if (producerLoad === null) {
    return { ids: new Set(), status: "MISSING", reason: "PRODUCER_WRITE_OBSERVATION_NOT_PROVEN" };
  }
  const records = producerWriteRecords(producerTaskId, field, producerLoad);
  const recordById = new Map(
    records.map((record) => [String(record.write_observation_id), record]),
  );
  const edges = artifactWriteEdgesFor(tableLineage, producerTaskId, field);
  const artifactWrites = edges.flatMap((edge) =>
    (Array.isArray(edge.writes) ? edge.writes : []).map(asRecord).filter(
      (write): write is JsonRecord => write !== null,
    ),
  );
  const ambiguous = (): ProducerWriteProof => ({
    ids: new Set(),
    status: records.length === 0 ? "MISSING" : "AMBIGUOUS",
    reason:
      records.length === 0
        ? "PRODUCER_WRITE_OBSERVATION_NOT_PROVEN"
        : "PRODUCER_WRITE_OBSERVATION_AMBIGUOUS",
  });

  if (artifactWrites.length === 0) {
    if (explicitIds.size > 0 || edges.length !== 0 || records.length !== 1)
      return ambiguous();
    const record = records[0]!;
    const statementId = nonEmpty(record.write_statement_id ?? record.statement_id);
    const boundary = asRecord(record.source_as_boundary)?.statement_span;
    const statement = (producerLoad.records["statements.jsonl"] ?? []).find(
      (candidate) => String(candidate.statement_id ?? "") === statementId,
    );
    const hasExactWriteSpan =
      statementId !== null &&
      Number.isSafeInteger(boundary?.start) &&
      Number.isSafeInteger(boundary?.end) &&
      spanEquals(statement?.span, {
        start: Number(boundary?.start),
        end: Number(boundary?.end),
      });
    const hasExactPlatformWrite =
      String(record.provenance ?? "") === "PLATFORM_TARGET" &&
      isPlatformTargetQueryOutputKind(record.write_kind);
    const hasExactBinding = (producerLoad.records["output-field-bindings.jsonl"] ?? []).some(
      (binding) =>
        binding.task_id === producerTaskId &&
        binding.binding_status === "RESOLVED" &&
        normalizeName(String(binding.target_dataset ?? "")) ===
          normalizeName(field.qualifiedName) &&
        normalizeName(String(binding.target_field ?? "")) === normalizeName(field.column) &&
        String(binding.write_observation_id ?? "") ===
          String(record.write_observation_id ?? ""),
    );
    return (hasExactWriteSpan || hasExactPlatformWrite) && hasExactBinding
      ? {
          ids: new Set([String(record.write_observation_id)]),
          status: "PROVEN",
          reason: null,
        }
      : ambiguous();
  }
  if (edges.length !== 1) return ambiguous();

  const exactSpanKeys = new Map<string, Set<string>>();
  for (const artifactWrite of artifactWrites) {
    const span = sqlParseSpan(artifactWrite);
    if (!span) continue;
    const writeKey = writeObservationIds(artifactWrite).join("\u0000") || "<unbound>";
    const spanKey = `${span.start}:${span.end}`;
    exactSpanKeys.set(writeKey, new Set([...(exactSpanKeys.get(writeKey) ?? []), spanKey]));
  }
  if ([...exactSpanKeys.values()].some((spans) => spans.size > 1))
    return ambiguous();

  const matchedIds = new Set<string>();
  let hasAmbiguousMatch = false;
  let hasAggregatedMatches = false;
  const usedIds = new Set<string>();
  for (const artifactWrite of artifactWrites) {
    const embeddedIds = writeObservationIds(artifactWrite).filter(
      (id) =>
        recordById.has(id) &&
        strictWriteMatchesArtifact(artifactWrite, recordById.get(id)!, producerLoad),
    );
    const matches = embeddedIds.length > 0
      ? [...new Set(embeddedIds)]
      : records
          .filter((record) =>
            strictWriteMatchesArtifact(artifactWrite, record, producerLoad),
          )
          .map((record) => String(record.write_observation_id));
    const scopedMatches = explicitIds.size > 0
      ? matches.filter((id) => explicitIds.has(id))
      : matches;
    const aggregateCandidates = (
      scopedMatches.length > 0
        ? scopedMatches
        : records
            .filter((record) =>
              legacyWriteMatchesArtifact(artifactWrite, record, producerLoad, false),
            )
            .map((record) => String(record.write_observation_id))
            .filter((id) => explicitIds.size === 0 || explicitIds.has(id))
    );
    const aggregatedIds = aggregateableWriteMatches(
      artifactWrite,
      aggregateCandidates,
      producerTaskId,
      field,
      producerLoad,
    );
    if (aggregatedIds.length > 0) {
      hasAggregatedMatches = true;
      aggregatedIds.forEach((id) => {
        usedIds.add(id);
        matchedIds.add(id);
      });
      continue;
    }
    if (scopedMatches.length !== 1 || usedIds.has(scopedMatches[0]!)) {
      hasAmbiguousMatch = true;
      continue;
    }
    usedIds.add(scopedMatches[0]!);
    matchedIds.add(scopedMatches[0]!);
  }
  if (
    hasAmbiguousMatch ||
    matchedIds.size === 0 ||
    (matchedIds.size !== 1 && !hasAggregatedMatches) ||
    (explicitIds.size > 0 && [...explicitIds].some((id) => !matchedIds.has(id)))
  )
    return {
      ids: new Set(),
      status: "AMBIGUOUS",
      reason: "PRODUCER_WRITE_OBSERVATION_AMBIGUOUS",
    };
  return { ids: matchedIds, status: "PROVEN", reason: null };
}

function bridgeEvidence(
  consumerTaskId: string,
  producerTaskId: string,
  field: PhysicalFieldIdentity,
  bridges: readonly JsonRecord[],
  consumerLoad: CurrentBundleLoad,
  producerLoad: CurrentBundleLoad | null,
  producerBindings: readonly JsonRecord[],
  provenWriteObservationIds: ReadonlySet<string>,
  evidenceMode: PhysicalFieldEvidenceMode,
  candidateBranchId: string | undefined,
  writeProofReason: string | null,
): { readonly valid: boolean; readonly refs: readonly string[]; readonly reason: string | null } {
  const strict = evidenceMode === "STRICT_CAUSAL";
  const refs = new Set<string>();
  const occurrenceIds = new Set<string>();
  let valid = bridges.length > 0;
  let evidenceReason: string | null = strict ? writeProofReason : null;
  for (const bridge of bridges) {
    const occurrence = asRecord(bridge.readOccurrence);
    const occurrenceId = nonEmpty(occurrence?.occurrenceId);
    const readRelationId = nonEmpty(occurrence?.readRelationId);
    const statementIndex = occurrence?.statementIndex;
    const relationPath = occurrence?.relationPath;
    if (strict && occurrence !== null) {
      const readCheck = validateConsumerReadOccurrence(
        consumerLoad,
        field,
        occurrence,
      );
      if (!readCheck.valid) {
        valid = false;
        evidenceReason ??= readCheck.reason;
        continue;
      }
    }
    if (
      !occurrenceId ||
      !readRelationId ||
      !Number.isSafeInteger(statementIndex) ||
      !Array.isArray(relationPath) ||
      relationPath.some((item) => !nonEmpty(item))
    ) {
      valid = false;
      if (strict && occurrence !== null)
        evidenceReason ??= "CONSUMER_READ_OCCURRENCE_EVIDENCE_MISMATCH";
      continue;
    }
    occurrenceIds.add(occurrenceId);
    refs.add(`field-lineage:consumer-read:${consumerTaskId}:${occurrenceId}:${readRelationId}`);
  }
  if (occurrenceIds.size === 0) valid = false;
  if (producerLoad === null) valid = false;
  const writeIds = new Set<string>();
  const bindingIds = new Set<string>();
  for (const binding of producerBindings) {
    const bindingId = nonEmpty(binding.binding_id);
    const writeObservationId = nonEmpty(binding.write_observation_id);
    if (
      !bindingId ||
      !writeObservationId ||
      (strict &&
        (bindingIds.has(bindingId) ||
          String(binding.task_id ?? "") !== producerTaskId ||
          String(binding.binding_status ?? "") !== "RESOLVED" ||
          normalizeName(String(binding.target_field ?? "")) !==
            normalizeName(field.column)))
    ) {
      valid = false;
      if (strict) evidenceReason ??= "PRODUCER_OUTPUT_BINDING_NOT_PROVEN";
      continue;
    }
    const write = (producerLoad?.records["dataset-io.jsonl"] ?? []).find(
      (record) =>
        record.direction === "WRITE" &&
        record.task_id === producerTaskId &&
        String(record.write_observation_id ?? "") === writeObservationId &&
        provenWriteObservationIds.has(writeObservationId) &&
        normalizeName(String(record.physical_dataset ?? "")) ===
          normalizeName(field.qualifiedName),
    );
    if (!write) {
      valid = false;
      if (strict) evidenceReason ??= "PRODUCER_WRITE_OBSERVATION_NOT_PROVEN";
      continue;
    }
    if (strict) {
      const bindingStatementId = nonEmpty(binding.write_statement_id);
      const writeStatementId = nonEmpty(
        write.write_statement_id ?? write.statement_id,
      );
      if (bindingStatementId !== null && bindingStatementId !== writeStatementId) {
        valid = false;
        evidenceReason ??= "PRODUCER_OUTPUT_BINDING_NOT_PROVEN";
        continue;
      }
      bindingIds.add(bindingId);
      if (writeIds.has(writeObservationId)) {
        valid = false;
        evidenceReason ??= "PRODUCER_OUTPUT_BINDING_AMBIGUOUS";
        continue;
      }
    }
    writeIds.add(writeObservationId);
    refs.add(`field-lineage:producer-write:${producerTaskId}:${writeObservationId}:${bindingId}`);
  }
  if (writeIds.size === 0) valid = false;
  if (candidateBranchId)
    refs.add(`field-lineage:candidate-branch:${candidateBranchId}`);
  for (const ref of [
    consumerLoad.evidence["dataset-io.jsonl"],
    consumerLoad.evidence["relation-nodes.jsonl"],
    producerLoad?.evidence["dataset-io.jsonl"],
    producerLoad?.evidence["output-field-bindings.jsonl"],
  ])
    if (ref) refs.add(ref);
  return {
    valid,
    refs: [...refs].sort(compareText),
    reason: valid
      ? null
      : strict
        ? evidenceReason ?? "CROSS_TASK_BRIDGE_EVIDENCE_INCOMPLETE"
        : "CROSS_TASK_BRIDGE_EVIDENCE_INCOMPLETE",
  };
}

function gap(
  request: PhysicalFieldExpansionRequest,
  reasonCode: string,
  message: string,
  taskId = request.consumerTaskId,
  field: PhysicalFieldIdentity | null = request.source,
  evidenceRefs: readonly string[] = [],
): FieldLineageGap {
  return {
    gapId: `gap:${request.sourceNodeId}:${reasonCode.toLowerCase()}:${taskId}`,
    taskId,
    nodeId: request.sourceNodeId,
    field,
    reasonCode,
    message,
    evidenceStatus: "UNRESOLVED",
    evidenceRefs,
  };
}

export class PhysicalFieldExpander {
  private readonly evidenceMode: PhysicalFieldEvidenceMode;

  public constructor(
    private readonly context: PhysicalFieldExpanderContext,
    options: PhysicalFieldExpanderOptions = {},
  ) {
    this.evidenceMode = options.evidenceMode ?? "LEGACY_COMPAT";
  }

  public expand(request: PhysicalFieldExpansionRequest): PhysicalFieldExpansion {
    const selected = selectBridges(
      this.context.tableLineage,
      request.consumerTaskId,
      request.source,
      request.expressionText,
      request.consumerLoad,
      request.expression,
    );
    const gaps: FieldLineageGap[] = [];
    if (selected.ambiguous)
      gaps.push(
        gap(
          request,
          "READ_OCCURRENCE_FIELD_BINDING_UNKNOWN",
          "the field expression cannot be uniquely bound to one repeated physical-table read occurrence",
          request.consumerTaskId,
          request.source,
          [request.consumerLoad.evidence["field-expression-nodes.jsonl"]].filter(
            (value): value is string => Boolean(value),
          ),
        ),
      );
    if (selected.ambiguous) {
      const candidates = new Map<string, PhysicalFieldExpansion["candidates"][number]>();
      for (const bridge of selected.matching) {
        const producerTaskId = nonEmpty(bridge.producerTaskId);
        if (!producerTaskId) continue;
        const candidateId = `candidate:occurrence-unbound:${request.consumerTaskId}:${producerTaskId}:${physicalFieldKey(request.source)}`;
        candidates.set(candidateId, {
          candidateId,
          consumerTaskId: request.consumerTaskId,
          producerTaskId,
          field: request.source,
          reasonCode: "READ_OCCURRENCE_FIELD_BINDING_UNKNOWN",
        });
      }
      return {
        classified: selected.classified,
        ambiguous: true,
        producers: [],
        candidates: [...candidates.values()].sort((left, right) =>
          compareText(left.candidateId, right.candidateId),
        ),
        gaps,
      };
    }

    const tableDecision = tableLineageDecision(this.context.tableLineage, request.consumerTaskId);
    const decision = selected.classified
      ? {
          primary: selected.selected
            .filter((bridge) => bridgeRole(bridge) === "PRIMARY")
            .map((bridge) => String(bridge.producerTaskId))
            .filter((taskId, index, taskIds) => taskIds.indexOf(taskId) === index)
            .sort(compareText),
          additional: selected.selected
            .filter((bridge) => ["ADDITIONAL", "CANDIDATE"].includes(String(bridgeRole(bridge))))
            .map((bridge) => String(bridge.producerTaskId))
            .filter((taskId, index, taskIds) => taskIds.indexOf(taskId) === index)
            .sort(compareText),
          unknown: selected.selected
            .filter((bridge) => bridgeRole(bridge) === "UNKNOWN")
            .map((bridge) => String(bridge.producerTaskId))
            .filter((taskId, index, taskIds) => taskIds.indexOf(taskId) === index)
            .sort(compareText),
        }
      : tableDecision;
    if (!decision) {
      gaps.push(
        gap(
          request,
          "TABLE_LINEAGE_PRIMARY_DECISION_MISSING",
          "table-level artifact has no one-hop producer decision for this Task",
        ),
      );
      return { classified: selected.classified, ambiguous: selected.ambiguous, producers: [], candidates: [], gaps };
    }

    const allDecisionIds = [...new Set([...decision.primary, ...decision.additional, ...decision.unknown])].filter(Boolean);
    const sameTableProducerIds = allDecisionIds.filter(
      (producerTaskId) =>
        producerMatchesField(this.context, request.consumerTaskId, producerTaskId, request.source) &&
        producerTargetsConsumerTable(this.context.taskPacks, request.consumerTaskId, producerTaskId),
    );
    const candidates = new Map<string, PhysicalFieldExpansion["candidates"][number]>();
    const addCandidate = (producerTaskId: string, reasonCode: string): void => {
      const candidateId = `candidate:${request.consumerTaskId}:${producerTaskId}:${physicalFieldKey(request.source)}`;
      candidates.set(candidateId, {
        candidateId,
        consumerTaskId: request.consumerTaskId,
        producerTaskId,
        field: request.source,
        reasonCode,
      });
    };
    for (const producerTaskId of sameTableProducerIds)
      addCandidate(producerTaskId, "SAME_PHYSICAL_TABLE_PRODUCER_NOT_RECURSED");
    for (const producerTaskId of decision.additional.filter((taskId) => !sameTableProducerIds.includes(taskId)))
      if (producerMatchesField(this.context, request.consumerTaskId, producerTaskId, request.source))
        addCandidate(producerTaskId, "ONE_HOP_ADDITIONAL_NOT_RECURSED");
    for (const producerTaskId of decision.unknown.filter((taskId) => !sameTableProducerIds.includes(taskId))) {
      if (!producerMatchesField(this.context, request.consumerTaskId, producerTaskId, request.source)) continue;
      addCandidate(producerTaskId, "ONE_HOP_UNKNOWN_NOT_RECURSED");
      const unknownGap = gap(
        request,
        "ONE_HOP_UPSTREAM_UNKNOWN",
        `one-hop classifies Task ${producerTaskId} as unknown for the current physical source field; the field branch is not recursed`,
        producerTaskId,
      );
      gaps.push({
        ...unknownGap,
        gapId: `gap:upstream-unknown:${request.consumerTaskId}:${producerTaskId}:${physicalFieldKey(request.source)}`,
      });
    }

    const producers: PhysicalFieldProducerExpansion[] = [];
    for (const producerTaskId of decision.primary.filter((taskId) => !sameTableProducerIds.includes(taskId))) {
      const relationMatches = producerRelationMatchesField(
        this.context,
        request.consumerTaskId,
        producerTaskId,
        request.source,
      );
      if (!relationMatches) continue;
      const fieldMatches = producerMatchesField(
        this.context,
        request.consumerTaskId,
        producerTaskId,
        request.source,
      );
      if (request.depth >= request.maxDepth) {
        gaps.push(
          gap(
            request,
            "MAX_DEPTH_REACHED",
            `maximum depth ${request.maxDepth} reached before Task ${producerTaskId}`,
          ),
        );
        continue;
      }
      const bridgeGroups = bridgeGroupsForProducer(
        selected.selected,
        producerTaskId,
      );
      for (const bridge of bridgeGroups) {
        const producerPack = this.context.taskPacks.get(producerTaskId) ?? null;
        if (producerPack && isSkippedLineageTask(producerPack.document)) continue;
      const producerLoad = producerPack ? this.context.loadFacts(producerTaskId) : null;
      const writeProof =
        this.evidenceMode === "STRICT_CAUSAL"
          ? strictProducerWriteProof(
              this.context.tableLineage,
              producerTaskId,
              request.source,
              bridge,
              producerLoad,
            )
          : legacyProducerWriteProof(
              this.context.tableLineage,
              producerTaskId,
              request.source,
              bridge,
              producerLoad,
            );
      const producerBindings =
        fieldMatches &&
        producerPack &&
        producerLoad &&
        writeProof.status === "PROVEN"
        ? outputBindingsFor(
            producerLoad,
            request.source.qualifiedName,
            request.source,
            writeProof.ids,
            producerPack.target ?? undefined,
            this.evidenceMode,
          )
        : [];
      const producerFactsStatus = producerLoad
        ? factsStatus(producerLoad, this.context.factsPolicy)
        : null;
      if (
        producerPack &&
        producerLoad &&
        !producerFactsStatus
      ) {
        gaps.push(
          gap(
            request,
            producerLoad.state === "LEGACY_NOT_L1"
              ? "LEGACY_FACTS_NOT_ALLOWED"
              : "MACHINE_FACTS_UNAVAILABLE",
            producerLoad.issues.join(";") ||
              `Machine Facts state is ${producerLoad.state}`,
            producerTaskId,
            request.source,
            [producerLoad.indexPath],
          ),
        );
      }
      const bridgeCheck = bridgeEvidence(
        request.consumerTaskId,
        producerTaskId,
        request.source,
        bridge,
        request.consumerLoad,
        producerLoad,
        producerBindings,
        writeProof.ids,
        this.evidenceMode,
        request.candidateBranchId,
        writeProof.reason,
      );
      let evidenceStatus: PhysicalFieldProducerExpansion["evidenceStatus"] =
        bridgeCheck.valid ? "CONFIRMED" : "UNRESOLVED";
      if (evidenceStatus === "CONFIRMED" && producerLoad) {
        const producerFactsStatus = factsStatus(producerLoad, this.context.factsPolicy);
        const consumerFactsStatus = factsStatus(request.consumerLoad, this.context.factsPolicy);
        if (!producerFactsStatus || !consumerFactsStatus) evidenceStatus = "UNRESOLVED";
        else if (producerFactsStatus === "PROVISIONAL_LEGACY" || consumerFactsStatus === "PROVISIONAL_LEGACY") evidenceStatus = "PROVISIONAL_LEGACY";
      }
      const producerField = producerPack?.target
        ? physicalFieldForTable(producerPack.target, request.source.column)
        : null;
      if (!fieldMatches)
        gaps.push(
          gap(
            request,
            "PHYSICAL_FIELD_IDENTITY_MISMATCH",
            "producer target field or physical table does not exactly match the consumer physical source field",
            producerTaskId,
            request.source,
          ),
        );
      if (
        bridge.length === 0 &&
        scheduleReadFallbackMatches(
          this.context,
          request.consumerTaskId,
          producerTaskId,
          request.source,
        )
      )
        gaps.push(
          gap(
            request,
            "LEGACY_SCHEDULE_READ_FALLBACK_UNRESOLVED",
            "legacy schedule/read fallback identifies a producer candidate but does not provide a continuous consumer READ to producer WRITE bridge",
            producerTaskId,
            request.source,
            bridgeCheck.refs,
          ),
        );
      if (!producerPack) {
        const excluded = taskExcludedDetail(this.context.dataRoot, producerTaskId);
        gaps.push(
          gap(
            request,
            excluded ? "TASK_INPUT_PACK_EXCLUDED" : "TASK_INPUT_PACK_MISSING",
            excluded
              ? `upstream Task Input Pack is excluded: ${excluded.reason}`
              : "upstream Task Input Pack is missing",
            producerTaskId,
            request.source,
            excluded?.evidence ?? [],
          ),
        );
      } else if (
        producerField &&
        physicalFieldKey(producerField) !== physicalFieldKey(request.source) &&
        fieldMatches
      ) {
        gaps.push(
          gap(
            request,
            "PHYSICAL_FIELD_IDENTITY_MISMATCH",
            "producer target field does not exactly match the consumer physical source field",
            producerTaskId,
            request.source,
          ),
        );
      }
      if (!bridgeCheck.valid)
        gaps.push(
          gap(
            request,
            bridgeCheck.reason ?? "CROSS_TASK_BRIDGE_EVIDENCE_INCOMPLETE",
            "cross-Task field expansion lacks a continuous consumer READ occurrence to producer WRITE/output binding evidence chain",
            producerTaskId,
            request.source,
            bridgeCheck.refs,
          ),
        );
      producers.push({
        producerTaskId,
        producerPack,
        producerField,
        producerBindings,
        bridge: bridge.length === 1 ? bridge.at(0) ?? null : null,
        bridges: bridge,
        producerRole: "PRIMARY",
        evidenceStatus,
        evidenceRefs: bridgeCheck.refs,
        shouldRecurse: Boolean(
          producerPack &&
            producerField &&
            fieldMatches &&
            bridgeCheck.valid &&
            evidenceStatus !== "UNRESOLVED",
        ),
      });
      }
    }
    return {
      classified: selected.classified,
      ambiguous: selected.ambiguous,
      producers,
      candidates: [...candidates.values()].sort((left, right) => compareText(left.candidateId, right.candidateId)),
      gaps,
    };
  }
}

export function createPhysicalFieldExpander(
  context: PhysicalFieldExpanderContext,
  options: PhysicalFieldExpanderOptions = {},
): PhysicalFieldExpander {
  return new PhysicalFieldExpander(context, options);
}

export function loadPhysicalFieldExpanderTaskPacks(
  dataRoot: string,
  catalog: PhysicalTableCatalog,
  taskPathIndex: ReadonlyMap<string, readonly string[]>,
): PhysicalFieldExpanderTaskPackLookup {
  const cache = new Map<string, PhysicalFieldExpanderTaskPack | null>();
  return {
    get: (taskId: string): PhysicalFieldExpanderTaskPack | undefined => {
      if (cache.has(taskId)) return cache.get(taskId) ?? undefined;
      const paths = taskPathIndex.get(taskId) ?? [];
      if (paths.length !== 1) {
        cache.set(taskId, null);
        return undefined;
      }
      try {
        const path = paths[0]!;
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        validateTaskDocument(raw);
        const document = raw as TaskDocument & JsonRecord;
        if (document.taskId !== taskId) throw new Error("TASK_IDENTITY_MISMATCH");
        const target = asRecord(document.target);
        const platform = nonEmpty(target?.platform);
        const dataSource = nonEmpty(target?.dataSource);
        const qualifiedName = nonEmpty(target?.qualifiedName);
        const targetEntry = platform && dataSource && qualifiedName
          ? catalog.byPhysicalKey.get(
              physicalTableKey({ platform, dataSource, qualifiedName }),
            ) ?? null
          : null;
        const pack = { document, path, target: targetEntry };
        cache.set(taskId, pack);
        return pack;
      } catch {
        cache.set(taskId, null);
        return undefined;
      }
    },
  };
}

export function taskDefaultSchemaFor(
  pack: PhysicalFieldExpanderTaskPack,
): TaskDefaultSchema | null {
  return inferTaskDefaultSchema(pack.document);
}

export function taskExcludedDetail(
  dataRoot: string,
  taskId: string,
): { readonly reason: string; readonly evidence: readonly string[] } | null {
  const statusPath = `${resolve(dataRoot)}.input-pack-status.json`;
  if (!existsSync(statusPath)) return null;
  try {
    const status = JSON.parse(readFileSync(statusPath, "utf8")) as JsonRecord;
    const task = asRecord(asRecord(status.tasks)?.[taskId]);
    if (!task || task.status !== "EXCLUDED") return null;
    return {
      reason: nonEmpty(task.exclusionReason) ?? "EXCLUDED",
      evidence: [statusPath],
    };
  } catch {
    return null;
  }
}
