import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
	indexTaskInputPacks,
	loadPhysicalTableCatalog,
  physicalTableKey,
  type PhysicalTableCatalog,
  type PhysicalTableCatalogEntry,
} from "../../../../../machine-facts/input-pack-machine-facts.ts";
import {
  MACHINE_FACTS_CONTRACT_VERSION,
  normalizeName,
} from "../../../../../machine-facts/machine-facts-contract.ts";
import {
  validateTaskDocument,
  type TaskDocument,
} from "../../../../../input/shared/input-pack.ts";
import {
	createCurrentTaskBundleReader,
	type CurrentBundleLoad,
	type JsonRecord,
} from "../../../../../query/current-task-bundle.ts";
import {
  inferTaskDefaultSchema,
  type TaskDefaultSchema,
} from "../../../../../reconcile/shared/task-default-schema.ts";
import { datasetControlsForStatement } from "../../../../../reconcile/shared/dataset-controls.ts";
export { datasetControlsForStatement } from "../../../../../reconcile/shared/dataset-controls.ts";
import { isCheckdbflagTask } from "../../../../../reconcile/shared/lineage-scope.ts";
import {
  expressionInputDependencyStatus,
  fieldConditionalsForNode,
  fieldExpressionFor,
  sourceFieldsForExpression,
} from "../../../../../project-graph/task-local/field-expression-dependencies.ts";
export {
  fieldConditionalsForExpression,
  sourceFieldsForExpression,
  valueContributionInputFields,
} from "../../../../../project-graph/task-local/field-expression-dependencies.ts";
import {
  FIELD_LINEAGE_ARTIFACT_TYPE,
  FIELD_LINEAGE_SCHEMA_VERSION,
  canonicalizeFieldLineageArtifact,
  physicalFieldKey,
  type FactsPolicy,
  type FieldLineageArtifact,
  type FieldLineageEdge,
  type FieldLineageGap,
  type FieldLineageNode,
  type FieldLineageTableEdge,
  type FieldProducerCandidate,
  type DatasetControlAnnotation,
  type FieldConditionalAnnotation,
  type PhysicalTableIdentity,
  type PhysicalFieldIdentity,
} from "./field-lineage-contract.ts";
import { physicalFieldForTable } from "../../../../../reconcile/shared/physical-field-resolver.ts";
import {
  createPhysicalFieldExpander,
  type PhysicalFieldExpander,
} from "./physical-field-expander.ts";

type TaskPack = {
  readonly document: TaskDocument & JsonRecord;
  readonly path: string;
  readonly target: PhysicalTableCatalogEntry | null;
};

type TaskPackLookup = {
	readonly get: (taskId: string) => TaskPack | undefined;
};

type TableLineageArtifact = JsonRecord & {
  readonly rootTaskId?: string;
  readonly generatedAt?: string;
  readonly taskNodes?: readonly JsonRecord[];
  readonly producerBridges?: readonly JsonRecord[];
  readonly readEdges?: readonly JsonRecord[];
	readonly scheduleEdges?: readonly JsonRecord[];
};

type LineageDecision = {
	readonly primary: readonly string[];
	readonly additional: readonly string[];
	readonly unknown: readonly string[];
};

export interface ReconcileFieldLineageOptions {
	readonly dataRoot: string;
	readonly factsRoot: string;
	readonly tableCatalog?: PhysicalTableCatalog;
  readonly tableLineage: TableLineageArtifact;
  readonly rootTaskId: string;
  readonly rootTable: string;
  readonly rootWriteObservationIds?: readonly string[];
  readonly rootFields: readonly string[];
  readonly factsPolicy: FactsPolicy;
  readonly maxDepth: number;
  readonly maxStates: number;
  readonly maxPaths: number;
  readonly taskPathIndex?: ReadonlyMap<string, readonly string[]>;
  readonly now?: () => string;
}

export const DEFAULT_FIELD_LINEAGE_MAX_STATES = 5000;
export const DEFAULT_FIELD_LINEAGE_MAX_PATHS = 10000;

type TraversalState = {
  readonly taskId: string;
  readonly field: PhysicalFieldIdentity;
  readonly bindingId: string | null;
  readonly nodeId: string | null;
  readonly depth: number;
  readonly active: ReadonlySet<string>;
  readonly incoming: {
    readonly sourceNodeId: string;
    readonly consumerTaskId: string;
    readonly producerTaskId: string | null;
    readonly evidenceStatus:
      | "CONFIRMED"
      | "PROVISIONAL_LEGACY"
      | "UNRESOLVED";
    readonly evidenceRefs: readonly string[];
  } | null;
};

const FIELD_LINEAGE_BUNDLE_FILES = [
	"statements.jsonl",
	"dataset-io.jsonl",
	"relation-nodes.jsonl",
	"relation-edges.jsonl",
	"field-expression-nodes.jsonl",
	"column-lineage-edges.jsonl",
	"output-field-bindings.jsonl",
	"task-local-materializations.jsonl",
	"unknowns.jsonl",
	"schema-refs.jsonl",
] as const;

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

function taskTarget(
  document: TaskDocument & JsonRecord,
  catalog: PhysicalTableCatalog,
): PhysicalTableCatalogEntry | null {
  const target = asRecord(document.target);
  const platform = nonEmpty(target?.platform);
  const dataSource = nonEmpty(target?.dataSource);
  const qualifiedName = nonEmpty(target?.qualifiedName);
  if (!platform || !dataSource || !qualifiedName) return null;
  return (
    catalog.byPhysicalKey.get(
      physicalTableKey({ platform, dataSource, qualifiedName }),
    ) ?? null
  );
}

function rootPhysicalTarget(
  catalog: PhysicalTableCatalog,
  rootPack: TaskPack,
  rootTable: string,
): PhysicalTableCatalogEntry {
  const candidates = catalog.byQualifiedName.get(normalizeName(rootTable)) ?? [];
  if (candidates.length === 1) return candidates[0]!;
  if (rootPack.target) {
    const sameSource = candidates.filter(
      (candidate) =>
        candidate.platform === rootPack.target!.platform &&
        candidate.dataSource === rootPack.target!.dataSource,
    );
    if (sameSource.length === 1) return sameSource[0]!;
  }
  if (candidates.length === 0)
    throw new Error(`ROOT_TARGET_IDENTITY_UNRESOLVED:${normalizeName(rootTable)}`);
  throw new Error(`ROOT_TARGET_IDENTITY_AMBIGUOUS:${normalizeName(rootTable)}`);
}

function loadTaskPacks(
	dataRoot: string,
	catalog: PhysicalTableCatalog,
  taskPathIndex: ReadonlyMap<string, readonly string[]>,
): TaskPackLookup {
	const cache = new Map<string, TaskPack | null>();
	return {
		get: (taskId: string): TaskPack | undefined => {
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
				const pack = { document, path, target: taskTarget(document, catalog) };
				cache.set(taskId, pack);
				return pack;
			} catch {
				// Invalid packs remain unavailable to the field consumer. Their status is
				// surfaced when a lineage branch tries to enter the Task.
				cache.set(taskId, null);
				return undefined;
			}
		},
	};
}

function excludedTaskDetail(
  dataRoot: string,
  taskId: string,
): { reason: string; evidence: string[] } | null {
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

function nodeId(
  taskId: string,
  field: PhysicalFieldIdentity,
  bindingId: string | null,
): string {
  return `field-node:${taskId}:${physicalFieldKey(field)}:${bindingId ?? "unresolved"}`;
}

function sourceNodeId(
  taskId: string,
  field: PhysicalFieldIdentity,
  bindingId: string,
): string {
  return `field-source-node:${taskId}:${physicalFieldKey(field)}:${bindingId}`;
}

function stateKey(
  taskId: string,
  field: PhysicalFieldIdentity,
  bindingId: string,
): string {
  return `${taskId}|${physicalFieldKey(field)}|${bindingId}`;
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

function targetBindings(
  load: CurrentBundleLoad,
  targetQualifiedName: string,
  field: PhysicalFieldIdentity,
  writeObservationIds?: ReadonlySet<string>,
  expectedTarget?: PhysicalTableCatalogEntry,
): JsonRecord[] {
  const normalizedTarget = normalizeName(targetQualifiedName);
  const expectedTargetName = expectedTarget
    ? normalizeName(expectedTarget.qualifiedName)
    : null;
  const expectedTargetTail = expectedTargetName?.split(".").at(-1) ?? null;
  const hasDeclaredPhysicalTarget = expectedTarget
    ? (load.records["dataset-io.jsonl"] ?? []).some(
        (record) =>
          record.task_id === load.taskId &&
          record.direction === "WRITE" &&
          normalizeName(String(record.physical_dataset ?? "")) ===
            expectedTargetName,
      )
    : false;
  return (load.records["output-field-bindings.jsonl"] ?? [])
    .filter(
      (binding) =>
        (normalizeName(String(binding.target_dataset ?? "")) ===
          normalizedTarget ||
          (hasDeclaredPhysicalTarget &&
            expectedTargetTail !== null &&
            normalizeName(String(binding.target_dataset ?? "")) ===
              expectedTargetTail &&
            normalizedTarget === expectedTargetName &&
            binding.task_id === load.taskId)) &&
        normalizeName(String(binding.target_field ?? "")) === field.column &&
        (writeObservationIds === undefined ||
          writeObservationIds.has(String(binding.write_observation_id ?? ""))) &&
        binding.binding_status === "RESOLVED",
    )
    .sort((left, right) =>
      compareText(
        String(left.binding_id ?? ""),
        String(right.binding_id ?? ""),
      ),
    );
}

function writeObservationIdsForTarget(
  load: CurrentBundleLoad,
  taskId: string,
  target: PhysicalTableIdentity,
): string[] {
  return [
    ...new Set(
      (load.records["dataset-io.jsonl"] ?? [])
        .filter(
          (record) =>
            record.task_id === taskId &&
            record.direction === "WRITE" &&
            typeof record.write_observation_id === "string" &&
            normalizeName(String(record.physical_dataset ?? "")) ===
              normalizeName(target.qualifiedName),
        )
        .map((record) => String(record.write_observation_id)),
    ),
  ].sort(compareText);
}

function assertRootWriteObservation(
  load: CurrentBundleLoad,
  taskId: string,
  target: PhysicalTableIdentity,
  writeObservationId: string,
): void {
  const matched = (load.records["dataset-io.jsonl"] ?? []).some(
    (record) =>
      record.task_id === taskId &&
      record.direction === "WRITE" &&
      record.write_observation_id === writeObservationId &&
      normalizeName(String(record.physical_dataset ?? "")) ===
        normalizeName(target.qualifiedName),
  );
  if (!matched)
    throw new Error(`ROOT_WRITE_OBSERVATION_NOT_FOUND:${writeObservationId}`);
}

function taskLocalMaterializationBindingIds(
  load: CurrentBundleLoad,
  taskId: string,
  field: PhysicalFieldIdentity,
): string[] {
  return [
    ...new Set(
      (load.records["task-local-materializations.jsonl"] ?? [])
        .filter(
          (record) =>
            record.task_id === taskId &&
            record.status === "RESOLVED" &&
            normalizeName(String(record.physical_dataset ?? "")) ===
              normalizeName(field.qualifiedName) &&
            normalizeName(String(record.column ?? "")) === field.column,
        )
        .flatMap((record) => [
          ...(typeof record.output_binding_id === "string" && record.output_binding_id.length > 0
            ? [record.output_binding_id]
            : []),
          ...(Array.isArray(record.output_binding_ids)
            ? record.output_binding_ids.filter(
                (value: unknown): value is string =>
                  typeof value === "string" && value.length > 0,
              )
            : []),
        ]),
    ),
  ].sort(compareText);
}

function isResolvedTaskLocalStaticPartition(
  load: CurrentBundleLoad,
  taskId: string,
  field: PhysicalFieldIdentity,
  expressionId: string,
): boolean {
  const matchingField = (load.records["task-local-materializations.jsonl"] ?? [])
    .filter(
      (record) =>
        record.task_id === taskId &&
        normalizeName(String(record.physical_dataset ?? "")) ===
          normalizeName(field.qualifiedName) &&
        normalizeName(String(record.column ?? "")) === field.column,
    );
  const contextual = matchingField.filter(
    (record) =>
      Array.isArray(record.read_expression_ids) &&
      record.read_expression_ids.some((value: unknown) => String(value) === expressionId),
  );
  const candidates = contextual.length > 0
    ? contextual
    : matchingField.every(
        (record) =>
          !Array.isArray(record.read_expression_ids) ||
          record.read_expression_ids.length === 0,
      )
      ? matchingField
      : [];
  return candidates.length === 1 &&
    candidates[0]?.status === "RESOLVED" &&
    candidates[0]?.producer_kind === "STATIC_PARTITION_ASSIGNMENT";
}

function lineageDecisions(tableLineage: TableLineageArtifact): ReadonlyMap<string, LineageDecision> {
	const result = new Map<string, LineageDecision>();
  for (const raw of Array.isArray(tableLineage.taskNodes)
    ? tableLineage.taskNodes
    : []) {
    const node = asRecord(raw);
    const taskId = nonEmpty(node?.taskId);
    const decision = asRecord(node?.upstreamDecision);
    if (!taskId || !decision) continue;
    const values = (key: string): string[] =>
      (Array.isArray(decision[key]) ? decision[key] : [])
        .map(String)
        .filter(Boolean)
        .sort(compareText);
    result.set(taskId, {
      primary: values("primary"),
      additional: values("additional"),
      unknown: values("unknown"),
    });
  }
	return result;
}

function tableEdgesOf(
  tableLineage: TableLineageArtifact,
): FieldLineageTableEdge[] {
  const decisions = lineageDecisions(tableLineage);
  const edges: FieldLineageTableEdge[] = [];
  for (const [consumerTaskId, decision] of decisions) {
    for (const producerTaskId of decision.primary)
      edges.push({ consumerTaskId, producerTaskId, classification: "PRIMARY" });
    for (const producerTaskId of decision.additional)
      edges.push({
        consumerTaskId,
        producerTaskId,
        classification: "ADDITIONAL",
      });
    for (const producerTaskId of decision.unknown)
      edges.push({ consumerTaskId, producerTaskId, classification: "UNKNOWN" });
  }
  return edges;
}

export function reconcileFieldLineage(
  options: ReconcileFieldLineageOptions,
): FieldLineageArtifact {
  if (!options.rootTaskId.trim()) throw new Error("ROOT_TASK_ID_REQUIRED");
  if (!options.rootTable.trim()) throw new Error("ROOT_TABLE_REQUIRED");
  for (const [name, value, minimum] of [
    ["maxDepth", options.maxDepth, 0],
    ["maxStates", options.maxStates, 1],
    ["maxPaths", options.maxPaths, 1],
  ] as const)
    if (!Number.isInteger(value) || value < minimum)
      throw new Error(`${name.toUpperCase()}_INVALID`);
  if (
    options.tableLineage.rootTaskId &&
    options.tableLineage.rootTaskId !== options.rootTaskId
  )
    throw new Error("TABLE_LINEAGE_ROOT_MISMATCH");

  const dataRoot = resolve(options.dataRoot);
	const catalog = options.tableCatalog ?? loadPhysicalTableCatalog(dataRoot, { lazyDdl: true });
	const taskPathIndex = options.taskPathIndex ?? indexTaskInputPacks(dataRoot);
	const taskPacks = loadTaskPacks(dataRoot, catalog, taskPathIndex);
  const rootPack = taskPacks.get(options.rootTaskId);
  if (!rootPack)
    throw new Error(`ROOT_TASK_INPUT_PACK_MISSING:${options.rootTaskId}`);
  if (!rootPack.target)
    throw new Error(`ROOT_TARGET_IDENTITY_UNRESOLVED:${options.rootTaskId}`);
  const rootTarget = rootPhysicalTarget(catalog, rootPack, options.rootTable);

  const rootFieldSelection =
    options.rootFields.length > 0 ? "EXPLICIT" : "ALL_TARGET_COLUMNS";
  const rootFields = [
    ...new Set(
      (options.rootFields.length > 0
        ? options.rootFields
        : rootTarget.columns
      )
        .map(normalizeName)
        .filter(Boolean),
    ),
  ].sort(compareText);
  if (rootFields.length === 0)
    throw new Error("ROOT_TARGET_SCHEMA_EMPTY");

  const nodes = new Map<string, FieldLineageNode>();
  const edges = new Map<string, FieldLineageEdge>();
  const controls = new Map<string, DatasetControlAnnotation>();
  const fieldConditionals = new Map<string, FieldConditionalAnnotation>();
	const candidates = new Map<string, FieldProducerCandidate>();
	const gaps = new Map<string, FieldLineageGap>();
	const rootNodeIds: string[] = [];
	const frontier: TraversalState[] = [];
	const visited = new Set<string>();
	const collectedStatements = new Set<string>();
	const limitReasons = new Set<
		"MAX_DEPTH_REACHED" | "MAX_STATES_REACHED" | "MAX_PATHS_REACHED"
	>();
	let pathCount = 0;
	let startedRoots = 0;

	const factsReader = createCurrentTaskBundleReader(options.factsRoot, {
		requestedFiles: FIELD_LINEAGE_BUNDLE_FILES,
		validateOutputHashes: "requested",
	});
	const loadFacts = (taskId: string): CurrentBundleLoad => factsReader.load(taskId);
  const physicalFieldExpander: PhysicalFieldExpander = createPhysicalFieldExpander({
    dataRoot,
    catalog,
    tableLineage: options.tableLineage,
    taskPacks,
    loadFacts,
    factsPolicy: options.factsPolicy,
  });
  const rootFacts = loadFacts(options.rootTaskId);
  const rootObservationIds = writeObservationIdsForTarget(
    rootFacts,
    options.rootTaskId,
    rootTarget,
  );
  const rootTargetMatchesPlatformTarget =
    normalizeName(rootPack.target.qualifiedName) ===
    normalizeName(rootTarget.qualifiedName);
  const selectedRootObservationIds = options.rootWriteObservationIds
    ? [...new Set(options.rootWriteObservationIds.map((id) => id.trim()).filter(Boolean))].sort(compareText)
    : rootTargetMatchesPlatformTarget
      ? rootObservationIds
      : [];
  if (selectedRootObservationIds.length === 0)
    throw new Error(
      rootObservationIds.length === 0
        ? `ROOT_WRITE_OBSERVATION_NOT_FOUND_FOR_TARGET:${normalizeName(rootTarget.qualifiedName)}`
        : `ROOT_WRITE_OBSERVATION_REQUIRED:${normalizeName(rootTarget.qualifiedName)}`,
    );
  for (const writeObservationId of selectedRootObservationIds)
    assertRootWriteObservation(
      rootFacts,
      options.rootTaskId,
      rootTarget,
      writeObservationId,
    );
  const rootWriteObservationSet = new Set(selectedRootObservationIds);
  const addGap = (gap: FieldLineageGap): void => {
    gaps.set(gap.gapId, gap);
  };
  const connectIncoming = (
    bindingNodeId: string,
    field: PhysicalFieldIdentity,
    incoming: NonNullable<TraversalState["incoming"]> | null,
  ): void => {
    if (!incoming) return;
    const edgeId = `value-edge:${bindingNodeId}->${incoming.sourceNodeId}:cross-task`;
    if (edges.has(edgeId)) return;
    edges.set(edgeId, {
      edgeId,
      fromNodeId: bindingNodeId,
      toNodeId: incoming.sourceNodeId,
      consumerTaskId: incoming.consumerTaskId,
      producerTaskId: incoming.producerTaskId,
      kind: "VALUE_FLOW",
      mapping: `${field.qualifiedName}.${field.column} -> ${field.qualifiedName}.${field.column}`,
      evidenceStatus: incoming.evidenceStatus,
      evidenceRefs: incoming.evidenceRefs,
    });
  };

  for (const requestedField of rootFields) {
    const field = physicalFieldForTable(rootTarget, requestedField);
    if (!field) throw new Error(`ROOT_FIELD_NOT_IN_SCHEMA:${requestedField}`);
    frontier.push({
      taskId: options.rootTaskId,
      field,
      bindingId: null,
      nodeId: null,
      depth: 0,
      active: new Set(),
      incoming: null,
    });
  }

  while (frontier.length > 0) {
    frontier.sort(
      (left, right) =>
        left.depth - right.depth ||
        compareText(left.taskId, right.taskId) ||
        compareText(
          physicalFieldKey(left.field),
          physicalFieldKey(right.field),
        ) ||
        compareText(left.bindingId ?? "", right.bindingId ?? ""),
    );
    const current = frontier.shift()!;
    const pack = taskPacks.get(current.taskId);
    if (pack && isSkippedLineageTask(pack.document)) continue;
    if (!pack || !pack.target) {
      const excluded = excludedTaskDetail(dataRoot, current.taskId);
      const unresolvedNodeId =
        current.nodeId ??
        nodeId(current.taskId, current.field, current.bindingId);
      if (!nodes.has(unresolvedNodeId))
        nodes.set(unresolvedNodeId, {
          nodeId: unresolvedNodeId,
          taskId: current.taskId,
          taskName: pack ? nonEmpty(pack.document.taskName) : null,
          depth: current.depth,
          field: current.field,
          bindingId: current.bindingId,
          expressionId: null,
          expressionText: null,
          evidenceStatus: "UNRESOLVED",
        });
      if (current.depth === 0) rootNodeIds.push(unresolvedNodeId);
      addGap({
        gapId: `gap:${unresolvedNodeId}:task-pack`,
        taskId: current.taskId,
        nodeId: unresolvedNodeId,
        field: current.field,
        reasonCode: excluded
          ? "TASK_INPUT_PACK_EXCLUDED"
          : "TASK_INPUT_PACK_MISSING",
        message: excluded
          ? `Task Input Pack is excluded: ${excluded.reason}`
          : "Task Input Pack is missing from the primary data root",
        evidenceStatus: "UNRESOLVED",
        evidenceRefs: excluded?.evidence ?? [],
      });
      continue;
    }
    const load = loadFacts(current.taskId);
    const evidenceStatus = factsStatus(load, options.factsPolicy);
    if (!evidenceStatus) {
      const unresolvedNodeId =
        current.nodeId ??
        nodeId(current.taskId, current.field, current.bindingId);
      if (!nodes.has(unresolvedNodeId))
        nodes.set(unresolvedNodeId, {
          nodeId: unresolvedNodeId,
          taskId: current.taskId,
          taskName: nonEmpty(pack.document.taskName),
          depth: current.depth,
          field: current.field,
          bindingId: current.bindingId,
          expressionId: null,
          expressionText: null,
          evidenceStatus: "UNRESOLVED",
        });
      if (current.depth === 0) rootNodeIds.push(unresolvedNodeId);
      addGap({
        gapId: `gap:${unresolvedNodeId}:facts-policy`,
        taskId: current.taskId,
        nodeId: unresolvedNodeId,
        field: current.field,
        reasonCode:
          load.state === "LEGACY_NOT_L1"
            ? "LEGACY_FACTS_NOT_ALLOWED"
            : "MACHINE_FACTS_UNAVAILABLE",
        message:
          load.issues.join("; ") || `Machine Facts state is ${load.state}`,
        evidenceStatus: "UNRESOLVED",
        evidenceRefs: [load.indexPath],
      });
      continue;
    }
    if (current.bindingId === null) {
      const bindings = targetBindings(
        load,
        current.field.qualifiedName,
        current.field,
        current.depth === 0 && current.nodeId === null
          ? rootWriteObservationSet
          : undefined,
        pack.target,
      );
      if (bindings.length === 0) {
        const unresolvedNodeId = nodeId(current.taskId, current.field, null);
        nodes.set(unresolvedNodeId, {
          nodeId: unresolvedNodeId,
          taskId: current.taskId,
          taskName: nonEmpty(pack.document.taskName),
          depth: current.depth,
          field: current.field,
          bindingId: null,
          expressionId: null,
          expressionText: null,
          evidenceStatus: "UNRESOLVED",
        });
        if (current.depth === 0) rootNodeIds.push(unresolvedNodeId);
        addGap({
          gapId: `gap:${unresolvedNodeId}:binding`,
          taskId: current.taskId,
          nodeId: unresolvedNodeId,
          field: current.field,
          reasonCode: "OUTPUT_FIELD_BINDING_NOT_PROVABLE",
          message: "exact target output binding is missing",
          evidenceStatus: "UNRESOLVED",
          evidenceRefs: [
            load.evidence["output-field-bindings.jsonl"] ?? load.bundleDir,
          ],
        });
        continue;
      }
      for (const binding of bindings) {
        const bindingId = String(binding.binding_id);
        const bindingNodeId = nodeId(current.taskId, current.field, bindingId);
        const bindingStateKey = stateKey(
          current.taskId,
          current.field,
          bindingId,
        );
        if (!nodes.has(bindingNodeId))
          nodes.set(bindingNodeId, {
            nodeId: bindingNodeId,
            taskId: current.taskId,
            taskName: nonEmpty(pack.document.taskName),
            depth: current.depth,
            field: current.field,
            bindingId,
            expressionId: null,
            expressionText: null,
            evidenceStatus,
          });
        if (current.depth === 0) rootNodeIds.push(bindingNodeId);
        connectIncoming(bindingNodeId, current.field, current.incoming);
        if (current.active.has(bindingStateKey)) {
          addGap({
            gapId: `gap:${bindingNodeId}:cycle`,
            taskId: current.taskId,
            nodeId: bindingNodeId,
            field: current.field,
            reasonCode: "CYCLE",
            message:
              "field traversal returned to a Task/physical-field/output-binding state already active on this path",
            evidenceStatus: "UNRESOLVED",
            evidenceRefs: [],
          });
          continue;
        }
        frontier.push({
          ...current,
          bindingId,
          nodeId: bindingNodeId,
          active: new Set([...current.active, bindingStateKey]),
        });
      }
      continue;
    }
    const currentNodeId = current.nodeId!;
    const currentNode = nodes.get(currentNodeId)!;
    const currentStateKey = stateKey(
      current.taskId,
      current.field,
      current.bindingId,
    );
    if (visited.has(currentStateKey)) continue;
    if (visited.size >= options.maxStates) {
      limitReasons.add("MAX_STATES_REACHED");
      addGap({
        gapId: `gap:${current.nodeId}:max-states`,
        taskId: current.taskId,
        nodeId: current.nodeId,
        field: current.field,
        reasonCode: "MAX_STATES_REACHED",
        message: `maximum traversal states ${options.maxStates} reached`,
        evidenceStatus: "UNRESOLVED",
        evidenceRefs: [],
      });
      break;
    }
    visited.add(currentStateKey);
    const binding = targetBindings(
      load,
      current.field.qualifiedName,
      current.field,
      current.depth === 0 && current.nodeId === null
        ? rootWriteObservationSet
        : undefined,
      pack.target,
    ).find((candidate) => candidate.binding_id === current.bindingId);
    if (!binding) {
      addGap({
        gapId: `gap:${current.nodeId}:binding`,
        taskId: current.taskId,
        nodeId: current.nodeId,
        field: current.field,
        reasonCode: "OUTPUT_FIELD_BINDING_NOT_PROVABLE",
        message: `output binding ${current.bindingId} is no longer present in the current bundle`,
        evidenceStatus: "UNRESOLVED",
        evidenceRefs: [
          load.evidence["output-field-bindings.jsonl"] ?? load.bundleDir,
        ],
      });
      continue;
    }
    connectIncoming(currentNodeId, current.field, current.incoming);
    const expression = fieldExpressionFor(load, binding);
    if (!expression) {
      addGap({
        gapId: `gap:${current.nodeId}:expression`,
        taskId: current.taskId,
        nodeId: current.nodeId,
        field: currentNode.field,
        reasonCode: "OUTPUT_EXPRESSION_MISSING",
        message: "output binding expression endpoint is missing",
        evidenceStatus: "UNRESOLVED",
        evidenceRefs: [
          load.evidence["field-expression-nodes.jsonl"] ?? load.bundleDir,
        ],
      });
      continue;
    }
    const resolvedNode: FieldLineageNode = {
      ...currentNode,
      bindingId: String(binding.binding_id),
      expressionId: String(expression.expression_id),
      expressionText: String(expression.expression_text ?? ""),
      inputDependencyStatus: expressionInputDependencyStatus(expression),
      evidenceStatus,
    };
    nodes.set(currentNodeId, resolvedNode);
    if (current.depth === 0) startedRoots += 1;
    const taskDefaultSchema = inferTaskDefaultSchema(pack.document);
    const fallbackTable = pack.target ?? {
      platform: resolvedNode.field.platform,
      dataSource: resolvedNode.field.dataSource,
    };
    const statementId = String(expression.statement_id ?? "");
    const statementKey = `${current.taskId}:${statementId}`;
    if (statementId && !collectedStatements.has(statementKey)) {
      collectedStatements.add(statementKey);
      for (const control of datasetControlsForStatement(
        load,
        current.taskId,
        statementId,
        catalog,
        taskDefaultSchema,
        fallbackTable,
        evidenceStatus,
      ))
        controls.set(control.controlId, control);
    }
    for (const conditional of fieldConditionalsForNode(
      load,
      resolvedNode,
      expression,
      catalog,
      taskDefaultSchema,
      fallbackTable,
      evidenceStatus,
    ))
      fieldConditionals.set(conditional.conditionalId, conditional);

    const sources = sourceFieldsForExpression(
      expression,
      catalog,
      load,
      current.taskId,
      pack.target,
      taskDefaultSchema,
    );
    for (const [kind, records] of [
      [
        "SOURCE_FIELD_SCHEMA_UNVERIFIED",
        Array.isArray(expression.candidate_input_fields)
          ? expression.candidate_input_fields
          : [],
      ],
      [
        "PHYSICAL_FIELD_UNRESOLVED",
        Array.isArray(expression.unresolved_input_columns)
          ? expression.unresolved_input_columns
          : [],
      ],
    ] as const) {
      for (const [index, record] of records.entries())
        addGap({
          gapId: `gap:${current.nodeId}:${kind.toLowerCase()}:${index}`,
          taskId: current.taskId,
          nodeId: current.nodeId,
          field: null,
          reasonCode: kind,
          message: `output expression input is not backed by an exact Table Pack field: ${JSON.stringify(record)}`,
          evidenceStatus: "UNRESOLVED",
          evidenceRefs: [
            load.evidence["field-expression-nodes.jsonl"] ?? load.bundleDir,
          ],
        });
    }
    for (const unresolved of sources.unresolved) {
      addGap({
        gapId: `gap:${current.nodeId}:${unresolved.reason}:${unresolved.table}.${unresolved.column}`,
        taskId: current.taskId,
        nodeId: current.nodeId,
        field: null,
        reasonCode: unresolved.reason,
        message: `${unresolved.table}.${unresolved.column} lacks one exact Schema-backed physical identity`,
        evidenceStatus: "UNRESOLVED",
        evidenceRefs: [
          load.evidence["field-expression-nodes.jsonl"] ?? load.bundleDir,
        ],
      });
    }
    for (const rawSource of sources.fields) {
      if (
        isResolvedTaskLocalStaticPartition(
          load,
          current.taskId,
          rawSource,
          String(expression.expression_id ?? ""),
        )
      ) continue;
      const taskLocalBindings =
        physicalTableKey(rawSource) !== physicalTableKey(pack.target)
          ? targetBindings(load, rawSource.qualifiedName, rawSource)
          : [];
      const taskLocalMaterializationBindings =
        taskLocalMaterializationBindingIds(load, current.taskId, rawSource);
      const localBindingIds = [
        ...new Set([
          ...taskLocalBindings.map((binding) => String(binding.binding_id)),
          ...taskLocalMaterializationBindings,
        ]),
      ].filter(Boolean).sort(compareText);
      const source: PhysicalFieldIdentity =
        localBindingIds.length > 0
          ? {
              ...rawSource,
              stableTableId: `task-local:${current.taskId}:${rawSource.qualifiedName}`,
              identityStatus: "TASK_LOCAL_SCHEMA_BACKED",
            }
          : rawSource;
      if (pathCount >= options.maxPaths) {
        limitReasons.add("MAX_PATHS_REACHED");
        addGap({
          gapId: `gap:${current.nodeId}:max-paths`,
          taskId: current.taskId,
          nodeId: current.nodeId,
          field: source,
          reasonCode: "MAX_PATHS_REACHED",
          message: `maximum value-flow paths ${options.maxPaths} reached`,
          evidenceStatus: "UNRESOLVED",
          evidenceRefs: [],
        });
        break;
      }
      pathCount += 1;
      const sourceId = sourceNodeId(current.taskId, source, current.bindingId);
      if (!nodes.has(sourceId))
        nodes.set(sourceId, {
          nodeId: sourceId,
          taskId: current.taskId,
          taskName: nonEmpty(pack.document.taskName),
          depth: current.depth,
          field: source,
          bindingId: null,
          expressionId: null,
          expressionText: null,
          evidenceStatus,
        });
      const internalEdgeId = `value-edge:${sourceId}->${currentNodeId}:${String(expression.expression_id)}`;
      edges.set(internalEdgeId, {
        edgeId: internalEdgeId,
        fromNodeId: sourceId,
        toNodeId: currentNodeId,
        consumerTaskId: current.taskId,
        producerTaskId: null,
        kind: "VALUE_FLOW",
        mapping: `${source.column} -> ${currentNode.field.column}`,
        evidenceStatus,
        evidenceRefs: [
          load.evidence["field-expression-nodes.jsonl"] ?? load.bundleDir,
          load.evidence["output-field-bindings.jsonl"] ?? load.bundleDir,
        ],
      });
      if (source.identityStatus === "TASK_LOCAL_SCHEMA_BACKED") {
        for (const bindingId of localBindingIds) {
          const localNodeId = nodeId(current.taskId, source, bindingId);
          if (!nodes.has(localNodeId))
            nodes.set(localNodeId, {
              nodeId: localNodeId,
              taskId: current.taskId,
              taskName: nonEmpty(pack.document.taskName),
              depth: current.depth,
              field: source,
              bindingId,
              expressionId: null,
              expressionText: null,
              evidenceStatus,
            });
          frontier.push({
            taskId: current.taskId,
            field: source,
            bindingId,
            nodeId: localNodeId,
            depth: current.depth,
            active: current.active,
          incoming: {
            sourceNodeId: sourceId,
            consumerTaskId: current.taskId,
            producerTaskId: null,
            evidenceStatus,
            evidenceRefs: [
              load.evidence["field-expression-nodes.jsonl"] ?? load.bundleDir,
              load.evidence["output-field-bindings.jsonl"] ?? load.bundleDir,
            ],
          },
          });
        }
        continue;
      }

      const expansion = physicalFieldExpander.expand({
        consumerTaskId: current.taskId,
        consumerPack: pack,
        consumerLoad: load,
        sourceNodeId: sourceId,
        source,
        expressionText: String(expression.expression_text ?? ""),
        expression,
        depth: current.depth,
        maxDepth: options.maxDepth,
      });
      for (const expansionGap of expansion.gaps) addGap(expansionGap);
      for (const candidate of expansion.candidates)
        candidates.set(candidate.candidateId, {
          ...candidate,
          evidenceStatus: "CANDIDATE",
        });
      if (expansion.ambiguous) continue;
      const nextActive = new Set([
        ...current.active,
        currentStateKey,
      ]);
      for (const producer of expansion.producers) {
        if (!producer.producerField || !producer.shouldRecurse) continue;
        const nextBindings = producer.producerBindings.length > 0
          ? producer.producerBindings.map((binding) => String(binding.binding_id))
          : [null];
        for (const bindingId of nextBindings) {
          const nextStateKey = stateKey(
            producer.producerTaskId,
            producer.producerField,
            bindingId ?? "unresolved",
          );
          if (nextActive.has(nextStateKey)) {
            addGap({
              gapId: `gap:${sourceId}:cycle:${producer.producerTaskId}:${bindingId ?? "unresolved"}`,
              taskId: producer.producerTaskId,
              nodeId: sourceId,
              field: producer.producerField,
              reasonCode: "CYCLE",
              message:
                "field traversal returned to a Task/physical-field/output-binding state already active on this path",
              evidenceStatus: "UNRESOLVED",
              evidenceRefs: producer.evidenceRefs,
            });
            continue;
          }
          const producerNodeId = bindingId === null
            ? null
            : nodeId(producer.producerTaskId, producer.producerField, bindingId);
          if (producerNodeId && !nodes.has(producerNodeId))
            nodes.set(producerNodeId, {
              nodeId: producerNodeId,
              taskId: producer.producerTaskId,
              taskName: nonEmpty(producer.producerPack?.document.taskName),
              depth: current.depth + 1,
              field: producer.producerField,
              bindingId,
              expressionId: null,
              expressionText: null,
              evidenceStatus: producer.evidenceStatus,
            });
          frontier.push({
            taskId: producer.producerTaskId,
            field: producer.producerField,
            bindingId,
            nodeId: producerNodeId,
            depth: current.depth + 1,
            active: nextActive,
            incoming: {
              sourceNodeId: sourceId,
              consumerTaskId: current.taskId,
              producerTaskId: producer.producerTaskId,
              evidenceStatus:
                producer.evidenceStatus === "CONFIRMED" ||
                producer.evidenceStatus === "PROVISIONAL_LEGACY"
                  ? producer.evidenceStatus
                  : "UNRESOLVED",
              evidenceRefs: producer.evidenceRefs,
            },
          });
        }
      }
    }
  }

  const allNodes = [...nodes.values()];
  const allEdges = [...edges.values()];
  const allControls = [...controls.values()];
  const allConditionals = [...fieldConditionals.values()];
  const allGaps = [...gaps.values()];
  const hasLegacy =
    allNodes.some((node) => node.evidenceStatus === "PROVISIONAL_LEGACY") ||
    allEdges.some((edge) => edge.evidenceStatus === "PROVISIONAL_LEGACY");
  const hasUnresolved =
    allNodes.some((node) => node.evidenceStatus === "UNRESOLVED") ||
    allEdges.some((edge) => edge.evidenceStatus === "UNRESOLVED") ||
    allControls.some((control) => control.evidenceStatus === "UNRESOLVED") ||
    allConditionals.some((item) => item.evidenceStatus === "UNRESOLVED");
  const overallStatus =
    startedRoots === 0
      ? "BLOCKED"
      : allGaps.length > 0 ||
          hasLegacy ||
          hasUnresolved ||
          limitReasons.size > 0
        ? "PARTIAL"
        : "COMPLETE";
  return canonicalizeFieldLineageArtifact({
    schemaVersion: FIELD_LINEAGE_SCHEMA_VERSION,
    artifactType: FIELD_LINEAGE_ARTIFACT_TYPE,
    generatedAt:
      options.tableLineage.generatedAt ??
      options.now?.() ??
      new Date().toISOString(),
    request: {
      rootTaskId: options.rootTaskId,
      rootTable: normalizeName(options.rootTable),
      rootWriteObservationIds: selectedRootObservationIds,
      rootFields,
      rootFieldSelection,
      factsPolicy: options.factsPolicy,
    },
    overallStatus,
    rootNodeIds,
    nodes: allNodes,
    edges: allEdges,
    datasetControls: allControls,
    fieldConditionals: allConditionals,
    candidates: [...candidates.values()],
    gaps: allGaps,
    tableEdges: tableEdgesOf(options.tableLineage),
    limits: {
      maxDepth: options.maxDepth,
      maxStates: options.maxStates,
      maxPaths: options.maxPaths,
      truncated: limitReasons.size > 0,
      reasons: [...limitReasons],
    },
    boundaries: {
      staticSqlOnly: true,
      runtimeExecution: "NOT_EVALUATED",
      dataCorrectness: "NOT_EVALUATED",
      businessAcceptance: "NOT_EVALUATED",
    },
  });
}
