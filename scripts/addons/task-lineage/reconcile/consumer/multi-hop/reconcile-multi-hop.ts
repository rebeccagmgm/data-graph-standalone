import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalHash,
  type JsonValue,
} from "../../../../../input/shared/input-pack.ts";
import {
  prepareOneHopContext,
  reconcileOneHopWithPreparedContext,
  type OneHopReconciliationResult,
} from "../one-hop/reconcile-one-hop.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  readHoraeRelationCache,
} from "../../../../../evidence/schedule-evidence-cache.ts";
import {
  fingerprintTableProducerInputs,
  loadTableProducerIndex,
  validateTableProducerIndex,
  type ProducerTableIdentity,
  type ProducerWriteObservation,
  type TableProducerIndex,
} from "../../../../../reconcile/producer/producer-index.ts";
import {
  isLegacyProducerIndexPath,
  resolveWriterLookup,
  taskContentHashesFor,
  writerLookupMeta,
  type WriterLookup,
} from "../../../../../query/table-writer-lookup.ts";
import type { WriterCatalogHandle } from "../../../../../query/writer-catalog.ts";
import {
  buildTaskReadEvidenceRepository,
  type TaskReadEvidenceRepository,
  type TaskDirectReadObservation,
  type TaskInputPackStatus,
  type TaskReadBlockReason,
  type TaskReadEvidence,
  type TaskReadTableRef,
} from "./task-read-evidence.ts";
import {
  DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  loadTerminalTableConfig,
  matchingTerminalRole,
  type TerminalTableConfig,
} from "../../../../../reconcile/shared/terminal-table-config.ts";
import {
  isSameTaskScratchTable,
  isTaskLocalTempTable,
} from "../../../../../reconcile/shared/lineage-scope.ts";

type ExpansionStatus = "EXPANDED" | "TERMINAL" | "TRUNCATED";

const DEFAULT_MAX_TASKS = 1000;
const DEFAULT_MAX_EDGES = 10000;

export type MultiHopTerminalReason =
  | Exclude<TaskInputPackStatus, "TASK_INPUT_PACK_AVAILABLE">
  | TaskReadBlockReason
  | "NO_DIRECT_READS"
  | "NO_CONFIRMED_PRODUCER_OBSERVED"
  | "MULTIPLE_OVERLAPPING_PRODUCERS"
  | "MAX_DEPTH_REACHED"
  | "MAX_TASKS_REACHED"
  | "MAX_EDGES_REACHED"
  | "CYCLE"
  | "ALREADY_DISCOVERED"
  | "TASK_LOCAL_MATERIALIZATION"
  | "REFERENCE_CONFIG";

export interface MultiHopTaskNode {
  readonly taskId: string;
  readonly minDepth: number;
  readonly expansionStatus: ExpansionStatus;
  readonly taskInputPackStatus: TaskInputPackStatus | null;
  readonly taskContentHash: string | null;
  readonly evidence: readonly TaskReadEvidence[];
  readonly upstreamDecision: MultiHopUpstreamDecision | null;
}

export interface MultiHopUpstreamDecision {
  readonly source: "ONE_HOP_FINAL_UPSTREAM";
  readonly primary: readonly string[];
  readonly additional: readonly string[];
  readonly unknown: readonly string[];
  readonly decision: OneHopReconciliationResult["finalUpstreamTaskIds"]["decision"];
  readonly evidence: readonly unknown[];
}

export interface MultiHopTableNode {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string;
  readonly identityStatus: TaskReadTableRef["identityStatus"];
}

export interface MultiHopReadEdge {
  readonly consumerTaskId: string;
  readonly table: TaskReadTableRef;
  readonly statementIndexes: readonly number[];
  readonly eligibleStatementIndexes: readonly number[];
  readonly blockedStatementIndexes: readonly number[];
  readonly recursionStatus: TaskDirectReadObservation["recursionStatus"];
  readonly blockReasons: readonly TaskReadBlockReason[];
  readonly evidence: readonly TaskReadEvidence[];
}

export interface MultiHopWriteEdge {
  readonly producerTaskId: string;
  readonly table: ProducerTableIdentity;
  readonly writes: readonly ProducerWriteObservation[];
  readonly producerIndexContentHash: string;
}

export interface MultiHopProducerBridge {
  readonly consumerTaskId: string;
  readonly table: ProducerTableIdentity;
  readonly producerTaskId: string;
  readonly producerDepth: number;
  readonly producerRole: "PRIMARY" | "ADDITIONAL" | "UNKNOWN" | "CANDIDATE";
  readonly readOccurrence: {
    readonly occurrenceId: string;
    readonly readRelationId: string;
    readonly statementIndex: number;
    readonly relationPath: readonly string[];
  } | null;
}

export interface MultiHopScheduleEdge {
  readonly consumerTaskId: string;
  readonly producerTaskId: string;
  readonly producerDepth: number;
  readonly evidence: readonly unknown[];
}

export interface MultiHopTerminal {
  readonly taskId: string;
  readonly depth: number;
  readonly reason: MultiHopTerminalReason;
  readonly table?: TaskReadTableRef | ProducerTableIdentity;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface MultiHopReconciliationResult {
  readonly schemaVersion: "1.1.0";
  readonly artifactType: "TABLE_MULTI_HOP_RECONCILIATION";
  readonly rootTaskId: string;
  readonly generatedAt: string;
  readonly producerIndex: {
    readonly contentHash: string;
    readonly inputFingerprint: string;
    readonly status: "VALID_SUCCESS" | "VALID_PARTIAL";
  };
  readonly terminalTableConfig: {
    readonly version: string;
    readonly stopRoles: readonly string[];
  };
  readonly taskNodes: readonly MultiHopTaskNode[];
  readonly tableNodes: readonly MultiHopTableNode[];
  readonly readEdges: readonly MultiHopReadEdge[];
  readonly writeEdges: readonly MultiHopWriteEdge[];
  readonly producerBridges: readonly MultiHopProducerBridge[];
  readonly scheduleEdges: readonly MultiHopScheduleEdge[];
  readonly terminals: readonly MultiHopTerminal[];
  readonly scheduleSkeleton: {
    readonly boundary: "ROOT_DEPTH_1_ONLY";
    readonly parents: readonly {
      readonly taskId: string;
      readonly taskName: string | null;
      readonly evidence: readonly unknown[];
    }[];
  };
  readonly coverage: {
    readonly semantics: "OBSERVED_EVIDENCE_ONLY";
    readonly status: "COMPLETE_OBSERVED_EVIDENCE" | "PARTIAL_EVIDENCE";
    readonly producerIndexStatus: "VALID_SUCCESS" | "VALID_PARTIAL";
    readonly taskPacksDiscovered: number;
    readonly taskPacksInvalid: number;
    readonly tablePacksDiscovered: number;
    readonly tablePacksInvalid: number;
    readonly eligibleReadEdges: number;
    readonly blockedReadEdges: number;
    readonly readsWithConfirmedProducer: number;
    readonly readsWithoutConfirmedProducer: number;
  };
  readonly limits: {
    readonly maxDepth: number;
    readonly maxTasks: number;
    readonly maxEdges: number;
    readonly truncated: boolean;
    readonly truncationReason: Extract<
      MultiHopTerminalReason,
      "MAX_DEPTH_REACHED" | "MAX_TASKS_REACHED" | "MAX_EDGES_REACHED"
    > | null;
    readonly remainingFrontierTasks: number;
  };
  readonly counts: {
    readonly taskNodes: number;
    readonly tableNodes: number;
    readonly readEdges: number;
    readonly writeEdges: number;
    readonly producerBridges: number;
    readonly scheduleEdges: number;
    readonly terminals: number;
  };
  readonly countSemantics: "NODE_AND_UNIQUE_EDGE_COUNTS";
  readonly issues: readonly string[];
  readonly boundaries: {
    readonly staticSqlOnly: true;
    readonly openCli: "NOT_USED";
    readonly producerCandidatesAreWrites: false;
    readonly partitionScope: "TASK_TO_TABLE_WRITE";
    readonly schedulerExecution: "NOT_EVALUATED";
    readonly runtimeDelivery: "NOT_EVALUATED";
    readonly businessCorrectness: "NOT_EVALUATED";
  };
  readonly contentHash: string;
}

export interface ReconcileMultiHopOptions {
  readonly dataRoot: string;
  readonly producerIndex?: TableProducerIndex;
  readonly writerCatalog?: WriterCatalogHandle;
  readonly maxDepth: number;
  readonly maxTasks: number;
  readonly maxEdges: number;
  readonly now?: () => string;
  readonly rootOneHop?: OneHopReconciliationResult;
  /** Frozen one-hop snapshots for non-root tasks, when scheduler evidence is available offline. */
  readonly oneHopSnapshots?: ReadonlyMap<string, OneHopReconciliationResult>;
  readonly terminalTableConfig?: TerminalTableConfig;
  /** Fingerprint already verified by an owning pipeline snapshot. */
  readonly trustedInputFingerprint?: string;
  /**
   * Offline Horae relation cache root used when a task has no frozen one-hop
   * snapshot. `undefined` uses the default cache; `null` disables cache reads
   * and keeps empty schedule rows (fail-closed for overlapping overwrites).
   */
  readonly scheduleEvidenceCacheRoot?: string | null;
}

interface MultiHopPreparedContext {
  readonly dataRoot: string;
  readonly repository: TaskReadEvidenceRepository;
  readonly inputFingerprint: string;
  readonly oneHopContext: ReturnType<typeof prepareOneHopContext>;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new Error(`${field.toUpperCase()}_INVALID`);
  return record;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field.toUpperCase()}_INVALID`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field.toUpperCase()}_INVALID`);
  return value;
}

function validateArtifactTable(
  value: unknown,
  field: string,
  requireResolved: boolean,
): ProducerTableIdentity | TaskReadTableRef {
  const table = requireRecord(value, field);
  const qualifiedName = requireString(
    table.qualifiedName,
    `${field}.qualifiedName`,
  );
  const platform = table.platform;
  const dataSource = table.dataSource;
  const identityStatus = table.identityStatus;
  if (requireResolved) {
    const identity = {
      platform: requireString(platform, `${field}.platform`).toLowerCase(),
      dataSource: requireString(
        dataSource,
        `${field}.dataSource`,
      ).toLowerCase(),
      qualifiedName,
    };
    if (identity.dataSource === "default")
      throw new Error(`${field.toUpperCase()}_DEFAULT_IDENTITY_INVALID`);
    return identity;
  }
  if (
    !["RESOLVED", "QUALIFIED_NAME_ONLY", "AMBIGUOUS"].includes(
      String(identityStatus),
    )
  )
    throw new Error(`${field.toUpperCase()}_IDENTITY_STATUS_INVALID`);
  if (
    identityStatus === "RESOLVED" &&
    (typeof platform !== "string" ||
      platform.trim() === "" ||
      typeof dataSource !== "string" ||
      dataSource.trim() === "" ||
      dataSource.trim().toLowerCase() === "default")
  )
    throw new Error(`${field.toUpperCase()}_RESOLVED_IDENTITY_INVALID`);
  return {
    platform: typeof platform === "string" ? platform : null,
    dataSource: typeof dataSource === "string" ? dataSource : null,
    qualifiedName,
    identityStatus: identityStatus as TaskReadTableRef["identityStatus"],
  };
}

function validateArtifactEvidence(
  value: unknown,
  field: string,
  options: {
    readonly allowedSources?: readonly string[];
    readonly requireNonEmpty?: boolean;
  } = {},
): void {
  const items = requireArray(value, field);
  if (options.requireNonEmpty && items.length === 0)
    throw new Error(`${field.toUpperCase()}_EMPTY`);
  for (const [index, item] of items.entries()) {
    const evidence = requireRecord(item, `${field}[${index}]`);
    const source = requireString(evidence.source, `${field}[${index}].source`);
    if (options.allowedSources && !options.allowedSources.includes(source))
      throw new Error(`${field.toUpperCase()}_SOURCE_INVALID`);
    requireString(evidence.provider, `${field}[${index}].provider`);
    requireString(evidence.locator, `${field}[${index}].locator`);
    if (!("observedAt" in evidence))
      throw new Error(`${field.toUpperCase()}_OBSERVED_AT_MISSING`);
    if (evidence.observedAt !== null && typeof evidence.observedAt !== "string")
      throw new Error(`${field.toUpperCase()}_OBSERVED_AT_INVALID`);
  }
}

export function validateMultiHopReconciliation(
  value: unknown,
): asserts value is MultiHopReconciliationResult {
  const artifact = requireRecord(value, "artifact");
  if (
    artifact.schemaVersion !== "1.1.0" ||
    artifact.artifactType !== "TABLE_MULTI_HOP_RECONCILIATION" ||
    artifact.countSemantics !== "NODE_AND_UNIQUE_EDGE_COUNTS"
  )
    throw new Error("MULTI_HOP_CONTRACT_INVALID");
  const rootTaskId = requireString(artifact.rootTaskId, "rootTaskId");
  const producerIndex = requireRecord(artifact.producerIndex, "producerIndex");
  const producerIndexContentHash = requireString(
    producerIndex.contentHash,
    "producerIndex.contentHash",
  );
  requireString(
    producerIndex.inputFingerprint,
    "producerIndex.inputFingerprint",
  );
  if (
    !["VALID_SUCCESS", "VALID_PARTIAL"].includes(String(producerIndex.status))
  )
    throw new Error("PRODUCER_INDEX_STATUS_INVALID");
  const taskNodes = requireArray(artifact.taskNodes, "taskNodes");
  const taskIds = new Set<string>();
  for (const [index, item] of taskNodes.entries()) {
    const node = requireRecord(item, `taskNodes[${index}]`);
    const taskId = requireString(node.taskId, `taskNodes[${index}].taskId`);
    if (taskIds.has(taskId)) throw new Error("TASK_NODE_DUPLICATE");
    taskIds.add(taskId);
    if (!Number.isSafeInteger(node.minDepth) || Number(node.minDepth) < 0)
      throw new Error("TASK_NODE_DEPTH_INVALID");
    if (
      !["EXPANDED", "TERMINAL", "TRUNCATED"].includes(
        String(node.expansionStatus),
      )
    )
      throw new Error("TASK_NODE_STATUS_INVALID");
    validateArtifactEvidence(node.evidence, `taskNodes[${index}].evidence`);
    if (node.upstreamDecision !== null) {
      const decision = requireRecord(
        node.upstreamDecision,
        `taskNodes[${index}].upstreamDecision`,
      );
      if (decision.source !== "ONE_HOP_FINAL_UPSTREAM")
        throw new Error("TASK_NODE_UPSTREAM_SOURCE_INVALID");
      for (const field of ["primary", "additional", "unknown"])
        requireArray(
          decision[field],
          `taskNodes[${index}].upstreamDecision.${field}`,
        );
      if (
        ![
          "SCHEDULE_DATA_INTERSECTION",
          "DATA_FALLBACK",
          "SCHEDULE_FALLBACK",
          "MULTIPLE_OVERLAPPING_PRODUCERS",
        ].includes(String(decision.decision))
      )
        throw new Error("TASK_NODE_UPSTREAM_DECISION_INVALID");
      requireArray(
        decision.evidence,
        `taskNodes[${index}].upstreamDecision.evidence`,
      );
    }
  }
  if (!taskIds.has(rootTaskId)) throw new Error("ROOT_TASK_NODE_MISSING");
  const tableNodes = requireArray(artifact.tableNodes, "tableNodes");
  const tableKeys = new Set<string>();
  for (const [index, item] of tableNodes.entries()) {
    const table = validateArtifactTable(item, `tableNodes[${index}]`, false);
    const key = tableKey(table);
    if (tableKeys.has(key)) throw new Error("TABLE_NODE_DUPLICATE");
    tableKeys.add(key);
  }
  const readEdges = requireArray(artifact.readEdges, "readEdges");
  const readKeys = new Set<string>();
  for (const [index, item] of readEdges.entries()) {
    const edge = requireRecord(item, `readEdges[${index}]`);
    const consumer = requireString(
      edge.consumerTaskId,
      `readEdges[${index}].consumerTaskId`,
    );
    if (!taskIds.has(consumer)) throw new Error("READ_EDGE_TASK_MISSING");
    const table = validateArtifactTable(
      edge.table,
      `readEdges[${index}].table`,
      false,
    ) as TaskReadTableRef;
    const key = readKey(consumer, table);
    if (readKeys.has(key)) throw new Error("READ_EDGE_DUPLICATE");
    if (!tableKeys.has(tableKey(table)))
      throw new Error("READ_EDGE_TABLE_MISSING");
    readKeys.add(key);
    requireArray(edge.statementIndexes, `readEdges[${index}].statementIndexes`);
    requireArray(
      edge.eligibleStatementIndexes,
      `readEdges[${index}].eligibleStatementIndexes`,
    );
    requireArray(
      edge.blockedStatementIndexes,
      `readEdges[${index}].blockedStatementIndexes`,
    );
    if (!["ELIGIBLE", "BLOCKED"].includes(String(edge.recursionStatus)))
      throw new Error("READ_EDGE_STATUS_INVALID");
    requireArray(edge.blockReasons, `readEdges[${index}].blockReasons`);
    validateArtifactEvidence(edge.evidence, `readEdges[${index}].evidence`, {
      allowedSources: [
        "INPUT_PACK_TASK",
        "INPUT_PACK_SQL",
        "TABLE_PACK",
        "SQL_PARSE",
      ],
      requireNonEmpty: true,
    });
  }
  const writeEdges = requireArray(artifact.writeEdges, "writeEdges");
  const writeKeys = new Set<string>();
  for (const [index, item] of writeEdges.entries()) {
    const edge = requireRecord(item, `writeEdges[${index}]`);
    const producer = requireString(
      edge.producerTaskId,
      `writeEdges[${index}].producerTaskId`,
    );
    if (!taskIds.has(producer)) throw new Error("WRITE_EDGE_TASK_MISSING");
    const table = validateArtifactTable(
      edge.table,
      `writeEdges[${index}].table`,
      true,
    ) as ProducerTableIdentity;
    const key = writeKey(producer, table);
    if (writeKeys.has(key)) throw new Error("WRITE_EDGE_DUPLICATE");
    if (!tableKeys.has(tableKey(table)))
      throw new Error("WRITE_EDGE_TABLE_MISSING");
    writeKeys.add(key);
    const writes = requireArray(edge.writes, `writeEdges[${index}].writes`);
    if (writes.length === 0) throw new Error("WRITE_OBSERVATIONS_MISSING");
    for (const [writeIndex, writeValue] of writes.entries()) {
      const write = requireRecord(
        writeValue,
        `writeEdges[${index}].writes[${writeIndex}]`,
      );
      const observationKind = requireString(
        write.observationKind,
        `writeEdges[${index}].writes[${writeIndex}].observationKind`,
      );
      if (!["DIRECT_TARGET", "SQL_EXPLICIT_WRITE"].includes(observationKind))
        throw new Error("WRITE_OBSERVATION_KIND_INVALID");
      if (
        write.declaredWriteMode !== null &&
        typeof write.declaredWriteMode !== "string"
      )
        throw new Error("WRITE_DECLARED_MODE_INVALID");
      if (
        ![
          "INSERT_OVERWRITE",
          "INSERT_INTO",
          "MERGE_INTO",
          "CTAS",
          null,
        ].includes(write.sqlWriteKind as string | null)
      )
        throw new Error("SQL_WRITE_KIND_INVALID");
      if (
        write.writeDirection !== undefined &&
        write.writeDirection !== "WRITE_CONFIRMED"
      )
        throw new Error("WRITE_DIRECTION_INVALID");
      if (
        write.targetEvidenceKind !== undefined &&
        !["DIRECT_PLATFORM_TARGET", "SQL_EXACT_TABLE_TARGET"].includes(
          String(write.targetEvidenceKind),
        )
      )
        throw new Error("TARGET_EVIDENCE_KIND_INVALID");
      if (
        observationKind === "SQL_EXPLICIT_WRITE" &&
        write.targetEvidenceKind !== undefined
      )
        throw new Error("WRITE_TARGET_EVIDENCE_MIXED");
      if (
        write.operationClass !== undefined &&
        ![
          "INSERT_OVERWRITE",
          "INSERT_INTO",
          "MERGE_INTO",
          "CTAS",
          "PLATFORM_TRANSFER",
          "DELETE",
          "TRUNCATE",
          "UNKNOWN",
        ].includes(String(write.operationClass))
      )
        throw new Error("OPERATION_CLASS_INVALID");
      if (
        write.dataPathRole !== undefined &&
        !["PRODUCER", "MUTATION_ONLY", "UNKNOWN"].includes(
          String(write.dataPathRole),
        )
      )
        throw new Error("DATA_PATH_ROLE_INVALID");
      if (
        write.operationClass !== undefined &&
        write.dataPathRole !== undefined &&
        (["DELETE", "TRUNCATE"] as readonly string[]).includes(
          String(write.operationClass),
        ) !==
          (write.dataPathRole === "MUTATION_ONLY")
      )
        throw new Error("WRITE_SEMANTICS_MISMATCH");
      for (const [partitionIndex, partitionValue] of requireArray(
        write.partition,
        `writeEdges[${index}].writes[${writeIndex}].partition`,
      ).entries()) {
        const partition = requireRecord(
          partitionValue,
          `writeEdges[${index}].writes[${writeIndex}].partition[${partitionIndex}]`,
        );
        requireString(partition.field, "partition.field");
        requireString(partition.expression, "partition.expression");
        if (
          ![
            "OBSERVED_RENDERED_VALUE",
            "RUNTIME_EXPRESSION",
            "UNKNOWN",
          ].includes(String(partition.valueStatus)) ||
          !(
            partition.observedValue === null ||
            typeof partition.observedValue === "string"
          )
        )
          throw new Error("WRITE_PARTITION_INVALID");
      }
      validateArtifactEvidence(
        write.evidence,
        `writeEdges[${index}].writes[${writeIndex}].evidence`,
        {
          allowedSources: [
            "INPUT_PACK_TASK",
            "INPUT_PACK_SQL",
            "TABLE_PACK",
            "SQL_PARSE",
          ],
          requireNonEmpty: true,
        },
      );
    }
    const edgeIndexContentHash = requireString(
      edge.producerIndexContentHash,
      `writeEdges[${index}].producerIndexContentHash`,
    );
    if (edgeIndexContentHash !== producerIndexContentHash)
      throw new Error("WRITE_EDGE_PRODUCER_INDEX_MISMATCH");
  }
  const bridges = requireArray(artifact.producerBridges, "producerBridges");
  const bridgeKeys = new Set<string>();
  for (const [index, item] of bridges.entries()) {
    const bridge = requireRecord(item, `producerBridges[${index}]`);
    const consumer = requireString(
      bridge.consumerTaskId,
      `producerBridges[${index}].consumerTaskId`,
    );
    const producer = requireString(
      bridge.producerTaskId,
      `producerBridges[${index}].producerTaskId`,
    );
    if (!taskIds.has(consumer) || !taskIds.has(producer))
      throw new Error("PRODUCER_BRIDGE_TASK_MISSING");
    const table = validateArtifactTable(
      bridge.table,
      `producerBridges[${index}].table`,
      true,
    ) as ProducerTableIdentity;
    if (
      !Number.isSafeInteger(bridge.producerDepth) ||
      Number(bridge.producerDepth) < 1
    )
      throw new Error("PRODUCER_BRIDGE_DEPTH_INVALID");
    if (
      !["PRIMARY", "ADDITIONAL", "UNKNOWN", "CANDIDATE"].includes(
        String(bridge.producerRole),
      )
    )
      throw new Error("PRODUCER_BRIDGE_ROLE_INVALID");
    let occurrenceId: string | null = null;
    if (bridge.readOccurrence !== null) {
      const occurrence = requireRecord(
        bridge.readOccurrence,
        `producerBridges[${index}].readOccurrence`,
      );
      occurrenceId = requireString(
        occurrence.occurrenceId,
        `producerBridges[${index}].readOccurrence.occurrenceId`,
      );
      requireString(
        occurrence.readRelationId,
        `producerBridges[${index}].readOccurrence.readRelationId`,
      );
      if (!Number.isSafeInteger(occurrence.statementIndex))
        throw new Error("PRODUCER_BRIDGE_OCCURRENCE_INVALID");
      for (const relationId of requireArray(
        occurrence.relationPath,
        `producerBridges[${index}].readOccurrence.relationPath`,
      ))
        requireString(relationId, "producerBridge.relationPath[]");
    }
    const key = bridgeKey(consumer, table, producer, occurrenceId);
    if (bridgeKeys.has(key)) throw new Error("PRODUCER_BRIDGE_DUPLICATE");
    if (!tableKeys.has(tableKey(table)))
      throw new Error("PRODUCER_BRIDGE_TABLE_MISSING");
    if (
      !readKeys.has(
        readKey(consumer, { ...table, identityStatus: "RESOLVED" }),
      ) ||
      !writeKeys.has(writeKey(producer, table))
    )
      throw new Error("PRODUCER_BRIDGE_EDGE_MISSING");
    bridgeKeys.add(key);
  }
  const scheduleEdges = requireArray(artifact.scheduleEdges, "scheduleEdges");
  const scheduleEdgeKeys = new Set<string>();
  for (const [index, item] of scheduleEdges.entries()) {
    const edge = requireRecord(item, `scheduleEdges[${index}]`);
    const consumer = requireString(
      edge.consumerTaskId,
      `scheduleEdges[${index}].consumerTaskId`,
    );
    const producer = requireString(
      edge.producerTaskId,
      `scheduleEdges[${index}].producerTaskId`,
    );
    if (!taskIds.has(consumer) || !taskIds.has(producer))
      throw new Error("SCHEDULE_EDGE_TASK_MISSING");
    if (
      !Number.isSafeInteger(edge.producerDepth) ||
      Number(edge.producerDepth) < 1
    )
      throw new Error("SCHEDULE_EDGE_DEPTH_INVALID");
    const key = `${consumer}\u0000${producer}`;
    if (scheduleEdgeKeys.has(key)) throw new Error("SCHEDULE_EDGE_DUPLICATE");
    scheduleEdgeKeys.add(key);
    validateArtifactEvidence(
      edge.evidence,
      `scheduleEdges[${index}].evidence`,
      { allowedSources: ["HORAE_RELATION"], requireNonEmpty: true },
    );
  }
  const terminals = requireArray(artifact.terminals, "terminals");
  const counts = requireRecord(artifact.counts, "counts");
  const expectedCounts = {
    taskNodes: taskNodes.length,
    tableNodes: tableNodes.length,
    readEdges: readEdges.length,
    writeEdges: writeEdges.length,
    producerBridges: bridges.length,
    scheduleEdges: scheduleEdges.length,
    terminals: terminals.length,
  };
  for (const [field, expected] of Object.entries(expectedCounts))
    if (counts[field] !== expected) throw new Error("MULTI_HOP_COUNTS_INVALID");
  const coverage = requireRecord(artifact.coverage, "coverage");
  if (
    coverage.semantics !== "OBSERVED_EVIDENCE_ONLY" ||
    !["COMPLETE_OBSERVED_EVIDENCE", "PARTIAL_EVIDENCE"].includes(
      String(coverage.status),
    )
  )
    throw new Error("MULTI_HOP_COVERAGE_INVALID");
  const schedule = requireRecord(artifact.scheduleSkeleton, "scheduleSkeleton");
  if (schedule.boundary !== "ROOT_DEPTH_1_ONLY")
    throw new Error("SCHEDULE_BOUNDARY_INVALID");
  for (const [index, item] of requireArray(
    schedule.parents,
    "schedule.parents",
  ).entries()) {
    const parent = requireRecord(item, `schedule.parents[${index}]`);
    requireString(parent.taskId, `schedule.parents[${index}].taskId`);
    validateArtifactEvidence(
      parent.evidence,
      `schedule.parents[${index}].evidence`,
      { allowedSources: ["HORAE_RELATION"], requireNonEmpty: true },
    );
  }
  requireString(artifact.contentHash, "contentHash");
  const expectedHash = canonicalHash(artifact as unknown as JsonValue, [
    "generatedAt",
    "contentHash",
  ]);
  if (artifact.contentHash !== expectedHash)
    throw new Error("MULTI_HOP_CONTENT_HASH_INVALID");
}

interface MutableTaskNode {
  taskId: string;
  minDepth: number;
  expansionStatus: ExpansionStatus;
  taskInputPackStatus: TaskInputPackStatus | null;
  taskContentHash: string | null;
  evidence: readonly TaskReadEvidence[];
  upstreamDecision: MultiHopUpstreamDecision | null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function catalogModule(): typeof import("../../../../../query/writer-catalog.ts") {
  return createRequire(import.meta.url)(
    "../../../../../query/writer-catalog.ts",
  ) as typeof import("../../../../../query/writer-catalog.ts");
}

function requireWriterLookup(options: ReconcileMultiHopOptions): WriterLookup {
  const lookup = resolveWriterLookup({
    writerCatalog: options.writerCatalog,
    producerIndex: options.producerIndex,
  });
  if (!lookup) throw new Error("WRITER_LOOKUP_REQUIRED");
  return lookup;
}

function packFingerprintFor(options: ReconcileMultiHopOptions): string {
  if (options.trustedInputFingerprint !== undefined) {
    if (!/^[a-f0-9]{64}$/i.test(options.trustedInputFingerprint))
      throw new Error("TRUSTED_INPUT_FINGERPRINT_INVALID");
    return options.trustedInputFingerprint;
  }
  return fingerprintTableProducerInputs(options.dataRoot);
}

function assertLegacyIndexFresh(
  lookup: WriterLookup,
  packFingerprint: string,
  trusted: string | undefined,
): void {
  if (lookup.kind !== "legacyIndex") return;
  if (
    trusted !== undefined &&
    lookup.index.inputFingerprint !== trusted
  )
    throw new Error("TRUSTED_INPUT_FINGERPRINT_INVALID");
  if (packFingerprint !== lookup.index.inputFingerprint)
    throw new Error("PRODUCER_INDEX_STALE");
}

function emittedIndexMeta(
  lookup: WriterLookup,
  packFingerprint: string,
): {
  readonly contentHash: string;
  readonly inputFingerprint: string;
  readonly status: "VALID_SUCCESS" | "VALID_PARTIAL";
} {
  const meta = writerLookupMeta(lookup);
  return {
    contentHash: meta.contentHash,
    inputFingerprint:
      lookup.kind === "legacyIndex"
        ? lookup.index.inputFingerprint
        : packFingerprint,
    status: meta.status,
  };
}

function validateRootOneHopSnapshot(
  value: unknown,
  rootTaskId: string,
  indexMeta: { readonly contentHash: string; readonly inputFingerprint: string },
): asserts value is OneHopReconciliationResult {
  const snapshot = asRecord(value);
  const schedule = asRecord(snapshot?.schedule);
  const index = asRecord(snapshot?.producerIndex);
  if (
    snapshot?.taskId !== rootTaskId ||
    schedule?.direction !== "UPSTREAM" ||
    schedule.depth !== 1 ||
    !Array.isArray(schedule.parents) ||
    index?.contentHash !== indexMeta.contentHash ||
    index.inputFingerprint !== indexMeta.inputFingerprint
  )
    throw new Error("ROOT_ONE_HOP_INVALID");
  for (const parent of schedule.parents) {
    const record = asRecord(parent);
    if (
      typeof record?.taskId !== "string" ||
      record.taskId.trim() === "" ||
      !(record.taskName === null || typeof record.taskName === "string") ||
      !Array.isArray(record.evidence) ||
      record.evidence.length === 0
    )
      throw new Error("ROOT_ONE_HOP_INVALID");
    for (const evidence of record.evidence) {
      const observation = asRecord(evidence);
      if (
        observation?.source !== "HORAE_RELATION" ||
        typeof observation.provider !== "string" ||
        observation.provider.trim() === "" ||
        typeof observation.locator !== "string" ||
        observation.locator.trim() === "" ||
        !("observedAt" in observation) ||
        !(
          observation.observedAt === null ||
          typeof observation.observedAt === "string"
        )
      )
        throw new Error("ROOT_ONE_HOP_INVALID");
    }
  }
  const final = asRecord(snapshot.finalUpstreamTaskIds);
  if (
    !final ||
    !Array.isArray(final.primary) ||
    !Array.isArray(final.additional) ||
    !Array.isArray(final.unknown) ||
    ![
      "SCHEDULE_DATA_INTERSECTION",
      "DATA_FALLBACK",
      "SCHEDULE_FALLBACK",
      "MULTIPLE_OVERLAPPING_PRODUCERS",
    ].includes(String(final.decision))
  )
    throw new Error("ROOT_ONE_HOP_INVALID");
}

function tableKey(table: {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string | null;
}): string {
  return [table.platform ?? "", table.dataSource ?? "", table.qualifiedName]
    .map((value) => (value ?? "").trim().toLowerCase())
    .join("\u0000");
}

function readKey(taskId: string, table: TaskReadTableRef): string {
  return `${taskId}\u0000${tableKey(table)}`;
}

function writeKey(taskId: string, table: ProducerTableIdentity): string {
  return `${taskId}\u0000${tableKey(table)}`;
}

function bridgeKey(
  consumerTaskId: string,
  table: ProducerTableIdentity,
  producerTaskId: string,
  occurrenceId: string | null,
): string {
  return `${consumerTaskId}\u0000${tableKey(table)}\u0000${producerTaskId}\u0000${occurrenceId ?? ""}`;
}

function requireLimit(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name.toUpperCase()}_INVALID`);
}

/**
 * Build the expensive, immutable evidence context once for a batch of roots.
 * The producer index fingerprint is still checked against the same snapshot,
 * but Task/Table Pack discovery and parsing are shared by every root.
 */
function prepareMultiHopContext(
  dataRootInput: string,
  inputFingerprint: string,
): MultiHopPreparedContext {
  const repository = buildTaskReadEvidenceRepository(dataRootInput, {
    taskLoading: "LAZY",
    tableLoading: "METADATA_ONLY",
    trustedTreeFingerprint: inputFingerprint,
  });
  return {
    dataRoot: repository.dataRoot,
    repository,
    inputFingerprint,
    oneHopContext: prepareOneHopContext(repository.dataRoot, {
      includeFingerprint: false,
      trustedInputFingerprint: inputFingerprint,
      schemaLoading: "TASK_SCOPED",
    }),
  };
}

function hasTaskPath(
  fromTaskId: string,
  toTaskId: string,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (fromTaskId === toTaskId) return true;
  const seen = new Set<string>();
  const pending = [fromTaskId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === toTaskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}

function sortTerminals(
  left: MultiHopTerminal,
  right: MultiHopTerminal,
): number {
  return (
    left.depth - right.depth ||
    compareText(left.taskId, right.taskId) ||
    compareText(
      left.table?.qualifiedName ?? "",
      right.table?.qualifiedName ?? "",
    ) ||
    compareText(left.reason, right.reason)
  );
}

/** Shared root-scoped traversal kernel used by both legacy and project runs. */
function reconcileMultiHopRootTraversalKernel(
  rootTaskId: string,
  options: ReconcileMultiHopOptions,
  preparedContext: MultiHopPreparedContext,
): MultiHopReconciliationResult {
  if (rootTaskId.trim() === "") throw new Error("TASK_ID_REQUIRED");
  requireLimit(options.maxDepth, "max_depth", 0);
  requireLimit(options.maxTasks, "max_tasks", 1);
  requireLimit(options.maxEdges, "max_edges", 1);
  const lookup = requireWriterLookup(options);
  if (lookup.kind === "legacyIndex") validateTableProducerIndex(lookup.index);
  const lookupMeta = writerLookupMeta(lookup);
  const indexMeta = emittedIndexMeta(lookup, preparedContext.inputFingerprint);
  const terminalTableConfig = options.terminalTableConfig;
  const repository = preparedContext.repository;
  if (
    lookup.kind === "legacyIndex" &&
    preparedContext.inputFingerprint !== lookup.index.inputFingerprint
  )
    throw new Error("PRODUCER_INDEX_STALE");
  if (options.rootOneHop)
    validateRootOneHopSnapshot(
      options.rootOneHop,
      rootTaskId,
      indexMeta,
    );
  const now = options.now ?? (() => new Date().toISOString());
  const taskNodes = new Map<string, MutableTaskNode>();
  const tableNodes = new Map<string, MultiHopTableNode>();
  const readEdges = new Map<string, MultiHopReadEdge>();
  const writeEdges = new Map<string, MultiHopWriteEdge>();
  const bridges = new Map<string, MultiHopProducerBridge>();
  const scheduleEdges = new Map<string, MultiHopScheduleEdge>();
  const producerTaskContentHashes = new Map(taskContentHashesFor(lookup));
  const terminals: MultiHopTerminal[] = [];
  const terminalKeys = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const frontier: { taskId: string; depth: number }[] = [
    { taskId: rootTaskId, depth: 0 },
  ];
  let traversalStopped = false;
  let truncationReason: MultiHopReconciliationResult["limits"]["truncationReason"] =
    null;
  let readsWithConfirmedProducer = 0;
  let readsWithoutConfirmedProducer = 0;

  const addTerminal = (terminal: MultiHopTerminal): void => {
    const key = [
      terminal.taskId,
      String(terminal.depth),
      terminal.reason,
      terminal.table ? tableKey(terminal.table) : "",
    ].join("\u0000");
    if (!terminalKeys.has(key)) {
      terminalKeys.add(key);
      terminals.push(terminal);
    }
  };

  const markTruncated = (
    reason: NonNullable<
      MultiHopReconciliationResult["limits"]["truncationReason"]
    >,
    terminal: MultiHopTerminal,
    stopTraversal: boolean,
  ): void => {
    truncationReason ??= reason;
    addTerminal(terminal);
    if (stopTraversal) traversalStopped = true;
  };

  const canAddGraphEdge = (terminal: MultiHopTerminal): boolean => {
    if (readEdges.size + writeEdges.size < options.maxEdges) return true;
    markTruncated(
      "MAX_EDGES_REACHED",
      {
        ...terminal,
        reason: "MAX_EDGES_REACHED",
      },
      true,
    );
    return false;
  };

  taskNodes.set(rootTaskId, {
    taskId: rootTaskId,
    minDepth: 0,
    expansionStatus: "TERMINAL",
    taskInputPackStatus: null,
    taskContentHash: null,
    evidence: [],
    upstreamDecision: null,
  });

  while (frontier.length > 0 && !traversalStopped) {
    frontier.sort(
      (left, right) =>
        left.depth - right.depth || compareText(left.taskId, right.taskId),
    );
    const current = frontier.shift()!;
    const node = taskNodes.get(current.taskId)!;
    if (current.depth >= options.maxDepth) {
      node.expansionStatus = "TERMINAL";
      markTruncated(
        "MAX_DEPTH_REACHED",
        {
          taskId: current.taskId,
          depth: current.depth,
          reason: "MAX_DEPTH_REACHED",
        },
        false,
      );
      continue;
    }

    const taskReads = repository.getTaskReads(current.taskId);
    node.taskInputPackStatus = taskReads.status;
    node.taskContentHash = taskReads.taskContentHash;
    node.evidence = taskReads.evidence;
    if (taskReads.status !== "TASK_INPUT_PACK_AVAILABLE") {
      node.expansionStatus = "TERMINAL";
      addTerminal({
        taskId: current.taskId,
        depth: current.depth,
        reason: taskReads.status,
        detail: { issues: taskReads.issues },
      });
      continue;
    }
    const frozenOneHop =
      current.taskId === rootTaskId
        ? options.rootOneHop
        : options.oneHopSnapshots?.get(current.taskId);
    let oneHop: OneHopReconciliationResult;
    if (frozenOneHop) {
      validateRootOneHopSnapshot(
        frozenOneHop,
        current.taskId,
        indexMeta,
      );
      oneHop = frozenOneHop;
    } else {
      // Multi-hop is an offline artifact builder: never call the live Horae
      // runner. Prefer a frozen snapshot; otherwise reuse the read-through
      // schedule evidence cache. Empty rows remain the fail-closed fallback
      // when the cache misses, but must not be the default when parents are
      // already on disk — otherwise overlapping INSERT OVERWRITE writers are
      // falsely demoted to UNKNOWN (e.g. 105387/108951 under 119044).
      const cacheRoot =
        options.scheduleEvidenceCacheRoot === undefined
          ? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT
          : options.scheduleEvidenceCacheRoot;
      const cached =
        cacheRoot === null
          ? null
          : readHoraeRelationCache(current.taskId, cacheRoot);
      const scheduleRows =
        cached?.status === "HIT" ? cached.rows : [];
      oneHop = reconcileOneHopWithPreparedContext(
        current.taskId,
        {
          dataRoot: options.dataRoot,
          producerIndex: options.producerIndex,
          writerCatalog: options.writerCatalog,
          verifyInputFingerprint: true,
          trustedInputFingerprint: preparedContext.inputFingerprint,
          scheduleRows,
          now,
        },
        preparedContext.oneHopContext,
      );
    }
    const partitionUnknownTaskIds = new Set(
      oneHop.partitionAwareNextDataTaskIds.unknown,
    );
    const recursivePrimaryTaskIds = new Set(
      oneHop.finalUpstreamTaskIds.primary.filter(
        (taskId) => !partitionUnknownTaskIds.has(taskId),
      ),
    );
    const upstreamEvidence = [
      ...oneHop.schedule.evidence,
      ...oneHop.schedule.parents.flatMap((parent) => parent.evidence),
      ...oneHop.dataPath.confirmedProducers.flatMap((producer) =>
        producer.writes.flatMap((write) => write.evidence),
      ),
      ...oneHop.dataPath.nonConfirmedRelations.flatMap(
        (relation) => relation.evidence,
      ),
    ];
    node.upstreamDecision = {
      source: "ONE_HOP_FINAL_UPSTREAM",
      primary: oneHop.finalUpstreamTaskIds.primary,
      additional: oneHop.finalUpstreamTaskIds.additional,
      unknown: [
        ...new Set([
          ...oneHop.finalUpstreamTaskIds.unknown,
          ...oneHop.partitionAwareNextDataTaskIds.unknown,
        ]),
      ].sort(compareText),
      decision: oneHop.finalUpstreamTaskIds.decision,
      evidence: upstreamEvidence,
    };
    for (const statementIssue of taskReads.statementIssues)
      addTerminal({
        taskId: current.taskId,
        depth: current.depth,
        reason: statementIssue.code,
        detail: {
          slot: statementIssue.slot,
          statementIndex: statementIssue.statementIndex,
          locator: statementIssue.locator,
          ...statementIssue.detail,
        },
      });
    if (taskReads.directReads.length === 0) {
      node.expansionStatus = "TERMINAL";
      if (taskReads.statementIssues.length === 0)
        addTerminal({
          taskId: current.taskId,
          depth: current.depth,
          reason: "NO_DIRECT_READS",
        });
      continue;
    }
    node.expansionStatus = "EXPANDED";

    for (const read of taskReads.directReads) {
      if (traversalStopped) break;
      if (
        !canAddGraphEdge({
          taskId: current.taskId,
          depth: current.depth,
          reason: "MAX_EDGES_REACHED",
          table: read.tableRef,
        })
      ) {
        node.expansionStatus = "TRUNCATED";
        break;
      }
      const currentReadKey = readKey(current.taskId, read.tableRef);
      if (!readEdges.has(currentReadKey)) {
        readEdges.set(currentReadKey, {
          consumerTaskId: current.taskId,
          table: read.tableRef,
          statementIndexes: read.statementIndexes,
          eligibleStatementIndexes: read.eligibleStatementIndexes,
          blockedStatementIndexes: read.blockedStatementIndexes,
          recursionStatus: read.recursionStatus,
          blockReasons: read.blockReasons,
          evidence: read.evidence,
        });
      }
      tableNodes.set(tableKey(read.tableRef), { ...read.tableRef });
      if (
        isTaskLocalTempTable(read.tableRef.qualifiedName)
        || isSameTaskScratchTable(read.tableRef.qualifiedName)
      ) {
        addTerminal({
          taskId: current.taskId,
          depth: current.depth,
          reason: "TASK_LOCAL_MATERIALIZATION",
          table: read.tableRef,
          detail: {
            rule: isTaskLocalTempTable(read.tableRef.qualifiedName)
              ? "QUALIFIED_NAME_PREFIX"
              : "SAME_TASK_SCRATCH_SUFFIX",
            pattern: isTaskLocalTempTable(read.tableRef.qualifiedName) ? "TEMP.*" : "*_TEMP",
          },
        });
        continue;
      }
      if (read.recursionStatus === "BLOCKED") {
        readsWithoutConfirmedProducer += 1;
        addTerminal({
          taskId: current.taskId,
          depth: current.depth,
          reason: read.blockReason ?? "TABLE_IDENTITY_UNRESOLVED",
          table: read.tableRef,
          detail: { blockReasons: read.blockReasons },
        });
        continue;
      }
      if (
        read.tableRef.identityStatus !== "RESOLVED" ||
        read.tableRef.platform === null ||
        read.tableRef.dataSource === null ||
        read.tableRef.dataSource === "default"
      ) {
        readsWithoutConfirmedProducer += 1;
        addTerminal({
          taskId: current.taskId,
          depth: current.depth,
          reason: "TABLE_IDENTITY_UNRESOLVED",
          table: read.tableRef,
        });
        continue;
      }
      const terminalRole = terminalTableConfig
        ? matchingTerminalRole(terminalTableConfig, read.tableRef.qualifiedName)
        : null;
      if (terminalRole) {
        readsWithoutConfirmedProducer += 1;
        addTerminal({
          taskId: current.taskId,
          depth: current.depth,
          reason: "REFERENCE_CONFIG",
          table: read.tableRef,
          detail: {
            role: terminalRole,
            configVersion: terminalTableConfig?.version,
          },
        });
        continue;
      }
      const identity: ProducerTableIdentity = {
        platform: read.tableRef.platform,
        dataSource: read.tableRef.dataSource,
        qualifiedName: read.tableRef.qualifiedName,
      };
      const producers = [
        ...oneHop.dataPath.confirmedProducers
          .filter(
            (producer) =>
              tableKey(producer.table) === tableKey({ ...identity }),
          )
          .map((producer) => ({
            taskId: producer.taskId,
            taskContentHash:
              producerTaskContentHashes.get(producer.taskId) ?? null,
            table: identity,
            writes: producer.writes as readonly ProducerWriteObservation[],
          })),
      ].sort(
        (left, right) =>
          Number(!recursivePrimaryTaskIds.has(left.taskId)) -
            Number(!recursivePrimaryTaskIds.has(right.taskId)) ||
          compareText(left.taskId, right.taskId),
      );
      const occurrenceDecisions = (
        oneHop.dataPath.readOccurrenceDecisions ?? []
      ).filter(
        (decision) => tableKey(decision.table) === tableKey({ ...identity }),
      );
      type ProducerBinding = {
        readonly producer: (typeof producers)[number];
        readonly producerRole: MultiHopProducerBridge["producerRole"];
        readonly readOccurrence: MultiHopProducerBridge["readOccurrence"];
      };
      const producerBindings: ProducerBinding[] = producers
        .flatMap<ProducerBinding>((producer) => {
          if (occurrenceDecisions.length === 0) {
            const producerRole = oneHop.finalUpstreamTaskIds.primary.includes(
              producer.taskId,
            )
              ? ("PRIMARY" as const)
              : oneHop.finalUpstreamTaskIds.additional.includes(producer.taskId)
                ? ("ADDITIONAL" as const)
                : oneHop.finalUpstreamTaskIds.unknown.includes(producer.taskId)
                  ? ("UNKNOWN" as const)
                  : ("CANDIDATE" as const);
            return [{ producer, producerRole, readOccurrence: null }];
          }
          return occurrenceDecisions
            .filter((decision) =>
              decision.candidates.some(
                (candidate) => candidate.taskId === producer.taskId,
              ),
            )
            .map((decision) => ({
              producer,
              producerRole: decision.primary.includes(producer.taskId)
                ? ("PRIMARY" as const)
                : decision.additional.includes(producer.taskId)
                  ? ("ADDITIONAL" as const)
                  : decision.unknown.includes(producer.taskId)
                    ? ("UNKNOWN" as const)
                    : ("CANDIDATE" as const),
              readOccurrence: {
                occurrenceId: decision.occurrenceId,
                readRelationId: decision.readRelationId,
                statementIndex: decision.statementIndex,
                relationPath: decision.relationPath,
              },
            }));
        })
        .sort(
          (left, right) =>
            compareText(left.producer.taskId, right.producer.taskId) ||
            compareText(
              left.readOccurrence?.occurrenceId ?? "",
              right.readOccurrence?.occurrenceId ?? "",
            ),
        );
      if (producerBindings.length === 0) {
        readsWithoutConfirmedProducer += 1;
        addTerminal({
          taskId: current.taskId,
          depth: current.depth,
          reason: "NO_CONFIRMED_PRODUCER_OBSERVED",
          table: identity,
        });
        continue;
      }
      const unknownProducers = producerBindings.filter(
        (binding) => binding.producerRole === "UNKNOWN",
      );
      if (
        unknownProducers.length > 0 &&
        oneHop.finalUpstreamTaskIds.decision ===
          "MULTIPLE_OVERLAPPING_PRODUCERS"
      ) {
        addTerminal({
          taskId: current.taskId,
          depth: current.depth,
          reason: "MULTIPLE_OVERLAPPING_PRODUCERS",
          table: identity,
          detail: {
            producerTaskIds: unknownProducers.map(
              ({ producer }) => producer.taskId,
            ),
            action: "STOP_BRANCH",
          },
        });
      }
      readsWithConfirmedProducer += 1;
      for (const binding of producerBindings) {
        if (traversalStopped) break;
        const { producer, producerRole, readOccurrence } = binding;
        const isPrimary =
          producerRole === "PRIMARY" &&
          recursivePrimaryTaskIds.has(producer.taskId);
        const currentWriteKey = writeKey(producer.taskId, identity);
        const writeEdgeExists = writeEdges.has(currentWriteKey);
        const producerNodeExists = taskNodes.has(producer.taskId);
        if (!producerNodeExists && taskNodes.size >= options.maxTasks) {
          node.expansionStatus = "TRUNCATED";
          markTruncated(
            "MAX_TASKS_REACHED",
            {
              taskId: producer.taskId,
              depth: current.depth + 1,
              reason: "MAX_TASKS_REACHED",
              table: identity,
              detail: { consumerTaskId: current.taskId },
            },
            true,
          );
          break;
        }
        if (!writeEdgeExists) {
          if (
            !canAddGraphEdge({
              taskId: producer.taskId,
              depth: current.depth + 1,
              reason: "MAX_EDGES_REACHED",
              table: identity,
            })
          ) {
            node.expansionStatus = "TRUNCATED";
            break;
          }
          writeEdges.set(currentWriteKey, {
            producerTaskId: producer.taskId,
            table: identity,
            writes: producer.writes,
            producerIndexContentHash: indexMeta.contentHash,
          });
        }
        const currentBridgeKey = bridgeKey(
          current.taskId,
          identity,
          producer.taskId,
          readOccurrence?.occurrenceId ?? null,
        );
        if (!bridges.has(currentBridgeKey))
          bridges.set(currentBridgeKey, {
            consumerTaskId: current.taskId,
            table: identity,
            producerTaskId: producer.taskId,
            producerDepth: current.depth + 1,
            producerRole,
            readOccurrence,
          });
        if (!producerNodeExists)
          taskNodes.set(producer.taskId, {
            taskId: producer.taskId,
            minDepth: current.depth + 1,
            expansionStatus: "TERMINAL",
            taskInputPackStatus: null,
            taskContentHash: producer.taskContentHash,
            evidence: [],
            upstreamDecision: null,
          });
        if (!isPrimary) continue;
        const nextTasks = adjacency.get(current.taskId) ?? new Set<string>();
        const createsCycle = hasTaskPath(
          producer.taskId,
          current.taskId,
          adjacency,
        );
        nextTasks.add(producer.taskId);
        adjacency.set(current.taskId, nextTasks);
        if (createsCycle) {
          addTerminal({
            taskId: producer.taskId,
            depth: current.depth + 1,
            reason: "CYCLE",
            table: identity,
            detail: { consumerTaskId: current.taskId },
          });
          continue;
        }
        if (producerNodeExists) {
          addTerminal({
            taskId: producer.taskId,
            depth: current.depth + 1,
            reason: "ALREADY_DISCOVERED",
            table: identity,
            detail: { consumerTaskId: current.taskId },
          });
          continue;
        }
        frontier.push({ taskId: producer.taskId, depth: current.depth + 1 });
      }
    }

    // A schedule-primary parent may have no confirmed local WRITE bridge.  It
    // is still a valid one-hop recursion entry, but it must remain visibly
    // schedule-sourced rather than being fabricated as a Table bridge.
    const scheduleParentsById = new Map(
      oneHop.schedule.parents.map((parent) => [parent.taskId, parent]),
    );
    for (const producerTaskId of oneHop.finalUpstreamTaskIds.primary) {
      const parent = scheduleParentsById.get(producerTaskId);
      if (!parent) continue;
      const producerDepth = current.depth + 1;
      if (parent) {
        const scheduleKey = `${current.taskId}\u0000${producerTaskId}`;
        if (!scheduleEdges.has(scheduleKey))
          scheduleEdges.set(scheduleKey, {
            consumerTaskId: current.taskId,
            producerTaskId,
            producerDepth,
            evidence: parent.evidence,
          });
      }
      const shouldRecurse = recursivePrimaryTaskIds.has(producerTaskId);
      if (shouldRecurse) {
        const nextTasks = adjacency.get(current.taskId) ?? new Set<string>();
        const createsCycle = hasTaskPath(
          producerTaskId,
          current.taskId,
          adjacency,
        );
        nextTasks.add(producerTaskId);
        adjacency.set(current.taskId, nextTasks);
        if (createsCycle || producerTaskId === current.taskId) {
          addTerminal({
            taskId: producerTaskId,
            depth: producerDepth,
            reason: "CYCLE",
            detail: { consumerTaskId: current.taskId },
          });
          continue;
        }
      }
      const existingNode = taskNodes.get(producerTaskId);
      const alreadyQueued = frontier.some(
        (pending) => pending.taskId === producerTaskId,
      );
      if (
        shouldRecurse &&
        existingNode &&
        (existingNode.expansionStatus === "EXPANDED" || alreadyQueued)
      ) {
          addTerminal({
            taskId: producerTaskId,
            depth: producerDepth,
            reason: "ALREADY_DISCOVERED",
            detail: { consumerTaskId: current.taskId },
          });
        continue;
      }
      if (!existingNode && taskNodes.size >= options.maxTasks) {
        node.expansionStatus = "TRUNCATED";
        markTruncated(
          "MAX_TASKS_REACHED",
          {
            taskId: producerTaskId,
            depth: producerDepth,
            reason: "MAX_TASKS_REACHED",
            detail: { consumerTaskId: current.taskId },
          },
          true,
        );
        break;
      }
      if (!existingNode)
        taskNodes.set(producerTaskId, {
          taskId: producerTaskId,
          minDepth: producerDepth,
          expansionStatus: "TERMINAL",
          taskInputPackStatus: null,
          taskContentHash: null,
          evidence: [],
          upstreamDecision: null,
        });
      if (shouldRecurse)
        frontier.push({ taskId: producerTaskId, depth: producerDepth });
    }
  }

  if (traversalStopped) {
    for (const pending of frontier) {
      const node = taskNodes.get(pending.taskId);
      if (node && node.expansionStatus !== "EXPANDED")
        node.expansionStatus = "TRUNCATED";
    }
  }

  const orderedTaskNodes = [...taskNodes.values()].sort(
    (left, right) =>
      left.minDepth - right.minDepth || compareText(left.taskId, right.taskId),
  );
  const orderedTableNodes = [...tableNodes.values()].sort((left, right) =>
    compareText(tableKey(left), tableKey(right)),
  );
  const orderedReadEdges = [...readEdges.values()].sort((left, right) =>
    compareText(
      readKey(left.consumerTaskId, left.table),
      readKey(right.consumerTaskId, right.table),
    ),
  );
  const orderedWriteEdges = [...writeEdges.values()].sort((left, right) =>
    compareText(
      writeKey(left.producerTaskId, left.table),
      writeKey(right.producerTaskId, right.table),
    ),
  );
  const orderedBridges = [...bridges.values()].sort((left, right) =>
    compareText(
      bridgeKey(
        left.consumerTaskId,
        left.table,
        left.producerTaskId,
        left.readOccurrence?.occurrenceId ?? null,
      ),
      bridgeKey(
        right.consumerTaskId,
        right.table,
        right.producerTaskId,
        right.readOccurrence?.occurrenceId ?? null,
      ),
    ),
  );
  const orderedScheduleEdges = [...scheduleEdges.values()].sort((left, right) =>
    compareText(
      `${left.consumerTaskId}\u0000${left.producerTaskId}`,
      `${right.consumerTaskId}\u0000${right.producerTaskId}`,
    ),
  );
  const orderedTerminals = [...terminals].sort(sortTerminals);
  const producerIndexStatus = indexMeta.status;
  const scheduleParents = (options.rootOneHop?.schedule.parents ?? [])
    .map((parent) => ({
      taskId: parent.taskId,
      taskName: parent.taskName,
      evidence: parent.evidence,
    }))
    .sort((left, right) => compareText(left.taskId, right.taskId));
  const withoutHash = {
    schemaVersion: "1.1.0" as const,
    artifactType: "TABLE_MULTI_HOP_RECONCILIATION" as const,
    rootTaskId,
    generatedAt: now(),
    producerIndex: {
      contentHash: indexMeta.contentHash,
      inputFingerprint: indexMeta.inputFingerprint,
      status: producerIndexStatus,
    },
    terminalTableConfig: {
      version: terminalTableConfig?.version ?? "disabled",
      stopRoles: terminalTableConfig?.stopRoles ?? [],
    },
    taskNodes: orderedTaskNodes,
    tableNodes: orderedTableNodes,
    readEdges: orderedReadEdges,
    writeEdges: orderedWriteEdges,
    producerBridges: orderedBridges,
    scheduleEdges: orderedScheduleEdges,
    terminals: orderedTerminals,
    scheduleSkeleton: {
      boundary: "ROOT_DEPTH_1_ONLY" as const,
      parents: scheduleParents,
    },
    coverage: {
      semantics: "OBSERVED_EVIDENCE_ONLY" as const,
      status:
        producerIndexStatus === "VALID_PARTIAL" ||
        lookupMeta.counts.invalidTaskPacks > 0 ||
        lookupMeta.counts.tablePacksInvalid > 0 ||
        truncationReason !== null
          ? ("PARTIAL_EVIDENCE" as const)
          : ("COMPLETE_OBSERVED_EVIDENCE" as const),
      producerIndexStatus,
      taskPacksDiscovered: lookupMeta.counts.taskPacksDiscovered,
      taskPacksInvalid: lookupMeta.counts.invalidTaskPacks,
      tablePacksDiscovered: lookupMeta.counts.tablePacksDiscovered,
      tablePacksInvalid: lookupMeta.counts.tablePacksInvalid,
      eligibleReadEdges: orderedReadEdges.filter(
        (edge) => edge.recursionStatus === "ELIGIBLE",
      ).length,
      blockedReadEdges: orderedReadEdges.filter(
        (edge) => edge.recursionStatus === "BLOCKED",
      ).length,
      readsWithConfirmedProducer,
      readsWithoutConfirmedProducer,
    },
    limits: {
      maxDepth: options.maxDepth,
      maxTasks: options.maxTasks,
      maxEdges: options.maxEdges,
      truncated: truncationReason !== null,
      truncationReason,
      remainingFrontierTasks: frontier.length,
    },
    counts: {
      taskNodes: orderedTaskNodes.length,
      tableNodes: orderedTableNodes.length,
      readEdges: orderedReadEdges.length,
      writeEdges: orderedWriteEdges.length,
      producerBridges: orderedBridges.length,
      scheduleEdges: orderedScheduleEdges.length,
      terminals: orderedTerminals.length,
    },
    countSemantics: "NODE_AND_UNIQUE_EDGE_COUNTS" as const,
    issues: lookupMeta.issues,
    boundaries: {
      staticSqlOnly: true as const,
      openCli: "NOT_USED" as const,
      producerCandidatesAreWrites: false as const,
      partitionScope: "TASK_TO_TABLE_WRITE" as const,
      schedulerExecution: "NOT_EVALUATED" as const,
      runtimeDelivery: "NOT_EVALUATED" as const,
      businessCorrectness: "NOT_EVALUATED" as const,
    },
  };
  const result = {
    ...withoutHash,
    contentHash: canonicalHash(withoutHash as unknown as JsonValue, [
      "generatedAt",
      "contentHash",
    ]),
  };
  validateMultiHopReconciliation(result);
  return result;
}

export function reconcileMultiHop(
  rootTaskId: string,
  options: ReconcileMultiHopOptions,
): MultiHopReconciliationResult {
  const lookup = requireWriterLookup(options);
  const inputFingerprint = packFingerprintFor(options);
  assertLegacyIndexFresh(lookup, inputFingerprint, options.trustedInputFingerprint);
  return reconcileMultiHopRootTraversalKernel(
    rootTaskId,
    options,
    prepareMultiHopContext(options.dataRoot, inputFingerprint),
  );
}

export interface MultiHopBatchRoot {
  readonly taskId: string;
  readonly rootOneHop?: OneHopReconciliationResult;
}

export function reconcileMultiHopBatch(
  roots: readonly MultiHopBatchRoot[],
  options: Omit<ReconcileMultiHopOptions, "rootOneHop">,
): readonly MultiHopReconciliationResult[] {
  const lookup = requireWriterLookup(options);
  const inputFingerprint = packFingerprintFor(options);
  assertLegacyIndexFresh(lookup, inputFingerprint, options.trustedInputFingerprint);
  const preparedContext = prepareMultiHopContext(
    options.dataRoot,
    inputFingerprint,
  );
  const results = roots.map((root) =>
    reconcileMultiHopRootTraversalKernel(
      root.taskId,
      {
        ...options,
        ...(root.rootOneHop ? { rootOneHop: root.rootOneHop } : {}),
      },
      preparedContext,
    ),
  );
  if (
    options.trustedInputFingerprint === undefined &&
    fingerprintTableProducerInputs(options.dataRoot) !==
    preparedContext.inputFingerprint
  )
    throw new Error("INPUT_CHANGED_DURING_MULTI_HOP_BATCH");
  return results;
}

interface CliOptions {
  taskId: string;
  dataRoot: string;
  producerIndexPath: string;
  rootOneHopPath: string | null;
  oneHopSnapshotPaths: readonly string[];
  outputPath: string | null;
  maxDepth: number;
  maxTasks: number;
  maxEdges: number;
  terminalTableConfigPath: string;
}

function parseCli(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--task-id",
    "--data-root",
    "--producer-index",
    "--writer-catalog",
    "--root-one-hop",
    "--one-hop-snapshots",
    "--output",
    "--max-depth",
    "--max-tasks",
    "--max-edges",
    "--terminal-table-config",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Error(`INVALID_ARGUMENT:${flag ?? "MISSING"}`);
    if (!allowed.has(flag)) throw new Error(`UNKNOWN_ARGUMENT:${flag}`);
    if (values.has(flag)) throw new Error(`DUPLICATE_ARGUMENT:${flag}`);
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value)
      throw new Error(
        `${flag.slice(2).toUpperCase().replaceAll("-", "_")}_REQUIRED`,
      );
    return value;
  };
  const integer = (flag: string, fallback: number): number => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value))
      throw new Error(`${flag.slice(2).toUpperCase()}_INVALID`);
    return value;
  };
  return {
    taskId: required("--task-id"),
    dataRoot: required("--data-root"),
    producerIndexPath:
      values.get("--writer-catalog") ??
      values.get("--producer-index") ??
      catalogModule().defaultWriterCatalogPath(required("--data-root")),
    rootOneHopPath: values.get("--root-one-hop") ?? null,
    oneHopSnapshotPaths: (values.get("--one-hop-snapshots") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    outputPath: values.get("--output") ?? null,
    maxDepth: integer("--max-depth", 3),
    maxTasks: integer("--max-tasks", DEFAULT_MAX_TASKS),
    maxEdges: integer("--max-edges", DEFAULT_MAX_EDGES),
    terminalTableConfigPath:
      values.get("--terminal-table-config") ??
      DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  };
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const lookupPath = resolve(cli.producerIndexPath);
  const producerIndex = isLegacyProducerIndexPath(lookupPath)
    ? loadTableProducerIndex(lookupPath)
    : undefined;
  const writerCatalog = isLegacyProducerIndexPath(lookupPath)
    ? undefined
    : catalogModule().openWriterCatalog(lookupPath);
  const terminalTableConfig = loadTerminalTableConfig(
    resolve(cli.terminalTableConfigPath),
  );
  const rootOneHop = cli.rootOneHopPath
    ? (JSON.parse(readFileSync(resolve(cli.rootOneHopPath), "utf8")) as unknown)
    : undefined;
  const oneHopSnapshots = new Map<string, OneHopReconciliationResult>();
  for (const snapshotPath of cli.oneHopSnapshotPaths) {
    const snapshot = JSON.parse(
      readFileSync(resolve(snapshotPath), "utf8"),
    ) as OneHopReconciliationResult;
    if (!snapshot.taskId?.trim()) throw new Error("ONE_HOP_SNAPSHOT_TASK_ID_REQUIRED");
    if (snapshot.taskId === cli.taskId) throw new Error("ROOT_ONE_HOP_MUST_USE_ROOT_FLAG");
    if (oneHopSnapshots.has(snapshot.taskId))
      throw new Error(`ONE_HOP_SNAPSHOT_DUPLICATE:${snapshot.taskId}`);
    oneHopSnapshots.set(snapshot.taskId, snapshot);
  }
  const result = reconcileMultiHop(cli.taskId, {
    dataRoot: cli.dataRoot,
    producerIndex,
    writerCatalog,
    maxDepth: cli.maxDepth,
    maxTasks: cli.maxTasks,
    maxEdges: cli.maxEdges,
    terminalTableConfig,
    ...(oneHopSnapshots.size > 0 ? { oneHopSnapshots } : {}),
    ...(rootOneHop
      ? { rootOneHop: rootOneHop as OneHopReconciliationResult }
      : {}),
  });
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (cli.outputPath) {
    const output = resolve(cli.outputPath);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, rendered, "utf8");
  } else process.stdout.write(rendered);
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) main();
