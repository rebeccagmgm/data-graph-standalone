import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { sha256 } from "../../contracts/runtime.ts";
import {
  physicalFieldKey,
  validateFieldLineageArtifact,
  type FieldLineageArtifact,
  type FieldLineageEdge,
  type FieldLineageNode,
  type PhysicalFieldIdentity,
} from "../../contracts/canonical-artifacts.ts";
import {
  physicalDatasetNodeId,
  sortedUnique,
  taskNodeId,
  type ProjectTopologyEdgeRecord,
} from "../contracts/project-topology-contract.ts";
import {
  loadProjectTopologyDirectory,
  PROJECT_TOPOLOGY_MANIFEST_FILE,
  type LoadedProjectTopologyDirectory,
} from "../topology/project-topology-publication.ts";
import {
  FIELD_EVIDENCE_PROJECTION_VERSION,
  fieldEvidenceDatasetNodeId,
  normalizedPhysicalField,
  type FieldEvidenceArtifactSourceRef,
  type FieldEvidenceProjectSourceRef,
  type FieldEvidenceProjectionLimits,
  type FieldEvidenceTargetIdentity,
} from "./field-evidence-contract.ts";

export interface LoadFieldEvidenceSourceOptions {
  readonly projectTopologyDirectory: string;
  readonly fieldLineagePath: string;
  readonly rootTaskId: string;
  readonly writeObservationId: string;
  readonly target: FieldEvidenceTargetIdentity;
  readonly rootFields: readonly string[];
  readonly limits?: Partial<FieldEvidenceProjectionLimits>;
  readonly projectLogicalLocator?: string;
  readonly fieldLogicalLocator?: string;
  readonly maxSourceBytes?: number;
}

export interface FieldEvidencePrimaryBridge {
  readonly topologyEdgeId: string;
  readonly consumerTaskId: string;
  readonly producerTaskId: string;
  readonly datasetNodeId: string;
  readonly occurrenceId: string;
  readonly readRelationId: string;
  readonly statementIndex: number | null;
  readonly relationPath: readonly string[];
  readonly canonicalConsumerReadRef: string;
}

export interface SelectedFieldEvidenceSlice {
  readonly selectedRootNodes: Readonly<Record<string, FieldLineageNode>>;
  readonly nodes: readonly FieldLineageNode[];
  readonly edges: readonly FieldLineageEdge[];
  readonly reachableTaskIds: readonly string[];
  readonly truncated: boolean;
  readonly limitReasons: readonly string[];
  readonly exploredPaths: number;
}

export interface LoadedFieldEvidenceSource {
  readonly project: LoadedProjectTopologyDirectory;
  readonly artifact: FieldLineageArtifact;
  readonly projectSource: FieldEvidenceProjectSourceRef;
  readonly fieldSource: FieldEvidenceArtifactSourceRef;
  readonly rootTaskId: string;
  readonly writeObservationId: string;
  readonly target: FieldEvidenceTargetIdentity;
  readonly rootFields: readonly string[];
  readonly limits: FieldEvidenceProjectionLimits;
  readonly slice: SelectedFieldEvidenceSlice;
  readonly primaryBridges: readonly FieldEvidencePrimaryBridge[];
}

export const DEFAULT_FIELD_EVIDENCE_LIMITS: FieldEvidenceProjectionLimits =
  Object.freeze({
    maxNodes: 5_000,
    maxEdges: 10_000,
    maxPaths: 10_000,
    maxControls: 10_000,
    maxCandidates: 1_000,
    maxGaps: 1_000,
  });

export function loadFieldEvidenceSource(
  options: LoadFieldEvidenceSourceOptions,
): LoadedFieldEvidenceSource {
  const maxSourceBytes = positiveLimit(
    options.maxSourceBytes ?? 512 * 1024 * 1024,
    "MAX_SOURCE_BYTES",
  );
  const limits = normalizeLimits(options.limits);
  const project = loadProjectTopologyDirectory(
    options.projectTopologyDirectory,
    { maxFileBytes: maxSourceBytes },
  );
  if (!project.projection.snapshot.rootTaskIds.includes(options.rootTaskId))
    throw new Error(
      `FIELD_EVIDENCE_PROJECT_ROOT_MISSING:${options.rootTaskId}`,
    );

  const fieldPath = resolve(options.fieldLineagePath);
  const fieldBytes = readBounded(fieldPath, maxSourceBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fieldBytes.toString("utf8"));
  } catch {
    throw new Error("FIELD_EVIDENCE_FIELD_ARTIFACT_JSON_INVALID");
  }
  const validationErrors = validateFieldLineageArtifact(parsed);
  if (validationErrors.length > 0)
    throw new Error(
      `FIELD_EVIDENCE_FIELD_ARTIFACT_INVALID:${validationErrors.join(";")}`,
    );
  const artifact = parsed as FieldLineageArtifact;
  const target = normalizedTarget(options.target);
  const rootFields = normalizeRootFields(options.rootFields);
  validateRootAlignment({
    artifact,
    rootTaskId: options.rootTaskId,
    writeObservationId: options.writeObservationId,
    target,
    rootFields,
  });
  const slice = selectUpstreamFieldSlice(artifact, target, rootFields, limits);
  const primaryBridges = selectedPrimaryBridges(project, slice.edges, artifact);
  validateSliceCoherence(project, artifact, slice, primaryBridges);

  const manifestBytes = readBounded(
    join(project.directory, PROJECT_TOPOLOGY_MANIFEST_FILE),
    maxSourceBytes,
  );
  const projectSource: FieldEvidenceProjectSourceRef = {
    snapshotId: project.projection.snapshot.snapshotId,
    projectKey: project.projection.snapshot.projectKey,
    manifestContentHash: project.manifest.contentHash,
    manifestSha256: sha256(manifestBytes),
    snapshotSha256: project.manifest.files.snapshot.sha256,
    nodesSha256: project.manifest.files.nodes.sha256,
    edgesSha256: project.manifest.files.edges.sha256,
    logicalLocator:
      options.projectLogicalLocator ??
      `project-topology:${project.projection.snapshot.snapshotId}`,
  };
  const fieldSource: FieldEvidenceArtifactSourceRef = {
    schemaVersion: artifact.schemaVersion,
    artifactType: artifact.artifactType,
    rootTaskId: artifact.request.rootTaskId,
    contentSha256: sha256(fieldBytes),
    declaredContentHash: artifact.contentHash,
    logicalLocator:
      options.fieldLogicalLocator ??
      `field-lineage:${artifact.request.rootTaskId}:${artifact.contentHash}`,
  };
  return {
    project,
    artifact,
    projectSource,
    fieldSource,
    rootTaskId: options.rootTaskId,
    writeObservationId: options.writeObservationId,
    target,
    rootFields,
    limits,
    slice,
    primaryBridges,
  };
}

export function selectUpstreamFieldSlice(
  artifact: FieldLineageArtifact,
  target: FieldEvidenceTargetIdentity,
  rootFields: readonly string[],
  limits: FieldEvidenceProjectionLimits,
): SelectedFieldEvidenceSlice {
  const nodeById = new Map(artifact.nodes.map((node) => [node.nodeId, node]));
  const targetKey = targetTableKey(target);
  const selectedRootNodes: Record<string, FieldLineageNode> = {};
  for (const rootField of rootFields) {
    const matches = artifact.rootNodeIds
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is FieldLineageNode => node !== undefined)
      .filter(
        (node) =>
          targetTableKey(node.field) === targetKey &&
          normalizeText(node.field.column) === rootField,
      );
    if (matches.length !== 1)
      throw new Error(
        `FIELD_EVIDENCE_ROOT_FIELD_${matches.length === 0 ? "MISSING" : "AMBIGUOUS"}:${rootField}`,
      );
    selectedRootNodes[rootField] = matches[0]!;
  }

  const incoming = new Map<string, FieldLineageEdge[]>();
  for (const edge of artifact.edges) {
    const list = incoming.get(edge.toNodeId) ?? [];
    list.push(edge);
    incoming.set(edge.toNodeId, list);
  }
  for (const list of incoming.values())
    list.sort((left, right) => left.edgeId.localeCompare(right.edgeId));

  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const frontier = Object.values(selectedRootNodes)
    .map((node) => node.nodeId)
    .sort();
  const queued = new Set(frontier);
  let exploredPaths = 0;
  let truncated = false;
  const reasons = new Set<string>();

  while (frontier.length > 0) {
    const nodeId = frontier.shift()!;
    queued.delete(nodeId);
    if (nodeIds.has(nodeId)) continue;
    if (nodeIds.size >= limits.maxNodes) {
      truncated = true;
      reasons.add("MAX_NODES_REACHED");
      break;
    }
    nodeIds.add(nodeId);
    for (const edge of incoming.get(nodeId) ?? []) {
      if (exploredPaths >= limits.maxPaths) {
        truncated = true;
        reasons.add("MAX_PATHS_REACHED");
        break;
      }
      exploredPaths += 1;
      if (!edgeIds.has(edge.edgeId) && edgeIds.size >= limits.maxEdges) {
        truncated = true;
        reasons.add("MAX_EDGES_REACHED");
        break;
      }
      edgeIds.add(edge.edgeId);
      if (!nodeIds.has(edge.fromNodeId) && !queued.has(edge.fromNodeId)) {
        frontier.push(edge.fromNodeId);
        frontier.sort();
        queued.add(edge.fromNodeId);
      }
    }
    if (truncated && reasons.has("MAX_PATHS_REACHED")) break;
    if (truncated && reasons.has("MAX_EDGES_REACHED")) break;
  }

  const nodes = artifact.nodes.filter((node) => nodeIds.has(node.nodeId));
  const edges = artifact.edges.filter(
    (edge) =>
      edgeIds.has(edge.edgeId) &&
      nodeIds.has(edge.fromNodeId) &&
      nodeIds.has(edge.toNodeId),
  );
  return {
    selectedRootNodes,
    nodes,
    edges,
    reachableTaskIds: sortedUnique(nodes.map((node) => node.taskId)),
    truncated,
    limitReasons: [...reasons].sort(),
    exploredPaths,
  };
}

function validateRootAlignment(input: {
  readonly artifact: FieldLineageArtifact;
  readonly rootTaskId: string;
  readonly writeObservationId: string;
  readonly target: FieldEvidenceTargetIdentity;
  readonly rootFields: readonly string[];
}): void {
  const { artifact } = input;
  if (artifact.request.rootTaskId !== input.rootTaskId)
    throw new Error("FIELD_EVIDENCE_ROOT_TASK_MISMATCH");
  if (
    artifact.request.rootWriteObservationIds.length !== 1 ||
    artifact.request.rootWriteObservationIds[0] !== input.writeObservationId
  )
    throw new Error("FIELD_EVIDENCE_ROOT_WRITE_AMBIGUOUS_OR_MISMATCHED");
  if (normalizeText(artifact.request.rootTable) !== input.target.qualifiedName)
    throw new Error("FIELD_EVIDENCE_ROOT_TARGET_MISMATCH");
  const nodeById = new Map(artifact.nodes.map((node) => [node.nodeId, node]));
  const rootNodes = artifact.rootNodeIds.map((nodeId) => nodeById.get(nodeId));
  if (rootNodes.some((node) => node === undefined))
    throw new Error("FIELD_EVIDENCE_ROOT_ENDPOINT_MISSING");
  const targetKeys = new Set(
    rootNodes.map((node) => targetTableKey(node!.field)),
  );
  if (targetKeys.size !== 1 || !targetKeys.has(targetTableKey(input.target)))
    throw new Error("FIELD_EVIDENCE_ROOT_PHYSICAL_TARGET_MISMATCH");
  const rootTaskIds = new Set(rootNodes.map((node) => node!.taskId));
  if (rootTaskIds.size !== 1 || !rootTaskIds.has(input.rootTaskId))
    throw new Error("FIELD_EVIDENCE_ROOT_NODE_TASK_MISMATCH");
  for (const field of input.rootFields) {
    if (!artifact.request.rootFields.includes(field))
      throw new Error(`FIELD_EVIDENCE_REQUESTED_FIELD_NOT_DECLARED:${field}`);
  }
}

function validateSliceCoherence(
  project: LoadedProjectTopologyDirectory,
  artifact: FieldLineageArtifact,
  slice: SelectedFieldEvidenceSlice,
  primaryBridges: readonly FieldEvidencePrimaryBridge[],
): void {
  const projectTaskIds = new Set(
    project.projection.nodes
      .filter((node) => node.nodeType === "TASK")
      .map((node) => String(node.properties.taskId)),
  );
  for (const taskId of slice.reachableTaskIds) {
    if (!projectTaskIds.has(taskId))
      throw new Error(`FIELD_EVIDENCE_REACHABLE_TASK_MISSING:${taskId}`);
  }
  const nodeById = new Map(artifact.nodes.map((node) => [node.nodeId, node]));
  for (const edge of slice.edges) {
    if (edge.evidenceStatus !== "CONFIRMED") continue;
    const from = nodeById.get(edge.fromNodeId)!;
    const to = nodeById.get(edge.toNodeId)!;
    if (from.taskId === to.taskId) continue;
    if (
      edge.consumerTaskId !== to.taskId ||
      edge.producerTaskId !== from.taskId
    )
      throw new Error(
        `FIELD_EVIDENCE_CROSS_TASK_ENDPOINT_MISMATCH:${edge.edgeId}`,
      );
    const datasetNodeId = fieldEvidenceDatasetNodeId(to.field);
    const matches = primaryBridges.filter(
      (bridge) =>
        bridge.consumerTaskId === edge.consumerTaskId &&
        bridge.producerTaskId === edge.producerTaskId &&
        bridge.datasetNodeId === datasetNodeId,
    );
    if (matches.length === 0)
      throw new Error(
        `FIELD_EVIDENCE_PRIMARY_PAIR_MISSING:${edge.edgeId}:${edge.consumerTaskId}:${edge.producerTaskId}:${datasetNodeId}`,
      );
  }
}

function selectedPrimaryBridges(
  project: LoadedProjectTopologyDirectory,
  selectedEdges: readonly FieldLineageEdge[],
  artifact: FieldLineageArtifact,
): FieldEvidencePrimaryBridge[] {
  const selectedPairs = new Set(
    selectedEdges
      .filter((edge) => edge.producerTaskId !== null)
      .map(
        (edge) =>
          `${edge.consumerTaskId}|${edge.producerTaskId}|${edgeDatasetNodeId(edge, artifact)}`,
      ),
  );
  const bridges: FieldEvidencePrimaryBridge[] = [];
  for (const edge of project.projection.edges) {
    if (edge.edgeType !== "PRODUCER_BRIDGE") continue;
    for (const observation of observations(edge)) {
      if (observation.producerRole !== "PRIMARY") continue;
      const datasetNodeId = text(observation.physicalDatasetNodeId);
      const occurrence = record(observation.readOccurrenceRef);
      const occurrenceId = text(occurrence?.occurrenceId);
      const readRelationId = text(occurrence?.readRelationId);
      const consumerTaskId = taskIdFromNode(edge.fromNodeId);
      const producerTaskId = taskIdFromNode(edge.toNodeId);
      if (
        !datasetNodeId ||
        !occurrenceId ||
        !readRelationId ||
        !consumerTaskId ||
        !producerTaskId ||
        !selectedPairs.has(
          `${consumerTaskId}|${producerTaskId}|${datasetNodeId}`,
        )
      )
        continue;
      const relationPath = Array.isArray(occurrence?.relationPath)
        ? occurrence.relationPath.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      bridges.push({
        topologyEdgeId: edge.edgeId,
        consumerTaskId,
        producerTaskId,
        datasetNodeId,
        occurrenceId,
        readRelationId,
        statementIndex:
          typeof occurrence?.statementIndex === "number"
            ? occurrence.statementIndex
            : null,
        relationPath,
        canonicalConsumerReadRef: `field-lineage:consumer-read:${consumerTaskId}:${occurrenceId}:${readRelationId}`,
      });
    }
  }
  const uniqueBridges = new Map<string, FieldEvidencePrimaryBridge>();
  for (const bridge of bridges) {
    const key = [
      bridge.consumerTaskId,
      bridge.producerTaskId,
      bridge.datasetNodeId,
      bridge.occurrenceId,
      bridge.readRelationId,
      String(bridge.statementIndex),
      JSON.stringify(bridge.relationPath),
    ].join("|");
    uniqueBridges.set(key, bridge);
  }
  return [...uniqueBridges.values()].sort((left, right) =>
    `${left.consumerTaskId}|${left.producerTaskId}|${left.datasetNodeId}|${left.occurrenceId}`.localeCompare(
      `${right.consumerTaskId}|${right.producerTaskId}|${right.datasetNodeId}|${right.occurrenceId}`,
    ),
  );
}

function edgeDatasetNodeId(
  edge: FieldLineageEdge,
  artifact: FieldLineageArtifact,
): string {
  const to = artifact.nodes.find((node) => node.nodeId === edge.toNodeId);
  if (!to)
    throw new Error(`FIELD_EVIDENCE_EDGE_ENDPOINT_MISSING:${edge.edgeId}`);
  return physicalDatasetNodeId(to.field);
}

function observations(
  edge: ProjectTopologyEdgeRecord,
): readonly Record<string, unknown>[] {
  const value = edge.properties.observations;
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => record(item) !== null,
      )
    : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function taskIdFromNode(nodeId: string): string | null {
  const prefix = "task:";
  return nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : null;
}

function normalizeLimits(
  input: Partial<FieldEvidenceProjectionLimits> | undefined,
): FieldEvidenceProjectionLimits {
  return {
    maxNodes: positiveLimit(
      input?.maxNodes ?? DEFAULT_FIELD_EVIDENCE_LIMITS.maxNodes,
      "MAX_NODES",
    ),
    maxEdges: positiveLimit(
      input?.maxEdges ?? DEFAULT_FIELD_EVIDENCE_LIMITS.maxEdges,
      "MAX_EDGES",
    ),
    maxPaths: positiveLimit(
      input?.maxPaths ?? DEFAULT_FIELD_EVIDENCE_LIMITS.maxPaths,
      "MAX_PATHS",
    ),
    maxControls: positiveLimit(
      input?.maxControls ?? DEFAULT_FIELD_EVIDENCE_LIMITS.maxControls,
      "MAX_CONTROLS",
    ),
    maxCandidates: positiveLimit(
      input?.maxCandidates ?? DEFAULT_FIELD_EVIDENCE_LIMITS.maxCandidates,
      "MAX_CANDIDATES",
    ),
    maxGaps: positiveLimit(
      input?.maxGaps ?? DEFAULT_FIELD_EVIDENCE_LIMITS.maxGaps,
      "MAX_GAPS",
    ),
  };
}

function normalizeRootFields(fields: readonly string[]): string[] {
  const normalized = sortedUnique(
    fields.map(normalizeText).filter((field) => field !== ""),
  );
  if (normalized.length === 0)
    throw new Error("FIELD_EVIDENCE_ROOT_FIELDS_REQUIRED");
  return normalized;
}

function normalizedTarget(
  target: FieldEvidenceTargetIdentity,
): FieldEvidenceTargetIdentity {
  const normalized = normalizedPhysicalField({ ...target, column: "_" });
  for (const [key, value] of Object.entries(normalized)) {
    if (key !== "column" && value === "")
      throw new Error(`FIELD_EVIDENCE_TARGET_${key.toUpperCase()}_REQUIRED`);
  }
  return {
    platform: normalized.platform,
    dataSource: normalized.dataSource,
    stableTableId: normalized.stableTableId,
    qualifiedName: normalized.qualifiedName,
  };
}

function targetTableKey(
  target: FieldEvidenceTargetIdentity | PhysicalFieldIdentity,
): string {
  return [
    target.platform,
    target.dataSource,
    target.stableTableId,
    target.qualifiedName,
  ]
    .map(normalizeText)
    .join("|");
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function readBounded(path: string, maxBytes: number): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(
      `FIELD_EVIDENCE_SOURCE_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (bytes.byteLength > maxBytes)
    throw new Error("FIELD_EVIDENCE_SOURCE_LIMIT");
  return bytes;
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`FIELD_EVIDENCE_${label}_INVALID`);
  return value;
}

export const FIELD_EVIDENCE_SOURCE_CONTRACT = Object.freeze({
  projectionVersion: FIELD_EVIDENCE_PROJECTION_VERSION,
  fieldArtifactType: "FIELD_MULTI_HOP_RECONCILIATION",
  fieldSchemaVersion: "1.1.0",
  rootWriteCardinality: "EXACTLY_ONE",
  traversal: "INCOMING_VALUE_FLOW_ONLY",
  externalCalls: 0,
  topologyMutation: false,
});

export function physicalFieldMatches(
  left: PhysicalFieldIdentity,
  right: PhysicalFieldIdentity,
): boolean {
  return physicalFieldKey(left) === physicalFieldKey(right);
}

export { taskNodeId };
