import {
  FIELD_EVIDENCE_SCHEMA_VERSION,
  sortedUnique,
  type FieldEvidenceEdgeRecord,
  type FieldEvidenceEdgeType,
  type FieldEvidenceNodeRecord,
  type FieldEvidenceNodeType,
  type FieldEvidenceQueryEnvelope,
  type FieldEvidenceQueryStatus,
} from "./field-evidence-contract.ts";
import { loadFieldEvidenceDirectory } from "./field-evidence-publication.ts";
import type { LoadedFieldEvidenceDirectory } from "./field-evidence-publication.ts";

export interface GetFieldEvidenceOptions {
  readonly nodeTypes?: readonly FieldEvidenceNodeType[];
  readonly edgeTypes?: readonly FieldEvidenceEdgeType[];
  readonly offset?: number;
  readonly limit?: number;
}

export interface TraceFieldValuePathOptions {
  readonly rootField?: string;
  readonly startStateId?: string;
  readonly maxHops?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxPaths?: number;
}

export type FieldEvidenceQuerySource = Pick<
  LoadedFieldEvidenceDirectory,
  "projection"
>;

export function getFieldEvidence(
  directory: string,
  options: GetFieldEvidenceOptions = {},
): ReturnType<typeof getFieldEvidenceFromProjection> {
  return getFieldEvidenceFromProjection(
    loadFieldEvidenceDirectory(directory),
    options,
  );
}

export function getFieldEvidenceFromProjection(
  loaded: FieldEvidenceQuerySource,
  options: GetFieldEvidenceOptions = {},
): FieldEvidenceQueryEnvelope<{
  readonly selection: ReturnType<
    typeof loadFieldEvidenceDirectory
  >["projection"]["snapshot"]["selection"];
  readonly sourceCoverage: string;
  readonly sliceCoverage: string;
  readonly diagnostics: ReturnType<
    typeof loadFieldEvidenceDirectory
  >["projection"]["snapshot"]["slice"];
  readonly nodes: readonly FieldEvidenceNodeRecord[];
  readonly edges: readonly FieldEvidenceEdgeRecord[];
  readonly boundaries: readonly FieldEvidenceNodeRecord[];
  readonly page: {
    readonly offset: number;
    readonly limit: number;
    readonly total: number;
    readonly returned: number;
  };
}> {
  const offset = nonNegative(options.offset ?? 0, "OFFSET");
  const limit = positive(options.limit ?? 500, "LIMIT");
  const nodeTypes = new Set(options.nodeTypes ?? []);
  const edgeTypes = new Set(options.edgeTypes ?? []);
  const nodeFilterProvided = options.nodeTypes !== undefined;
  const edgeFilterProvided = options.edgeTypes !== undefined;
  const includeNodes = !edgeFilterProvided || nodeFilterProvided;
  const includeEdges = !nodeFilterProvided || edgeFilterProvided;
  const allRecords: (FieldEvidenceNodeRecord | FieldEvidenceEdgeRecord)[] = [
    ...loaded.projection.nodes.filter(
      (node) =>
        includeNodes && (nodeTypes.size === 0 || nodeTypes.has(node.nodeType)),
    ),
    ...loaded.projection.edges.filter(
      (edge) =>
        includeEdges && (edgeTypes.size === 0 || edgeTypes.has(edge.edgeType)),
    ),
  ].sort((left, right) => recordId(left).localeCompare(recordId(right)));
  const page = allRecords.slice(offset, offset + limit);
  const nodeIds = new Set(
    page
      .filter((record): record is FieldEvidenceNodeRecord => isNode(record))
      .map((record) => record.nodeId),
  );
  const edgeIds = new Set(
    page
      .filter((record): record is FieldEvidenceEdgeRecord => !isNode(record))
      .map((record) => record.edgeId),
  );
  const queryLimited = offset + page.length < allRecords.length;
  const warnings = warningsFor(
    loaded.projection.snapshot.slice.coverageStatus,
    queryLimited,
  );
  return {
    schemaVersion: FIELD_EVIDENCE_SCHEMA_VERSION,
    query: "get_field_evidence",
    status: queryStatus(
      loaded.projection.snapshot.slice.coverageStatus,
      queryLimited,
    ),
    snapshotId: loaded.projection.snapshot.snapshotId,
    result: {
      selection: loaded.projection.snapshot.selection,
      sourceCoverage: loaded.projection.snapshot.slice.sourceOverallStatus,
      sliceCoverage: loaded.projection.snapshot.slice.coverageStatus,
      diagnostics: loaded.projection.snapshot.slice,
      nodes: loaded.projection.nodes.filter((node) => nodeIds.has(node.nodeId)),
      edges: loaded.projection.edges.filter((edge) => edgeIds.has(edge.edgeId)),
      boundaries: loaded.projection.nodes.filter(
        (node) => node.nodeType === "BOUNDARY",
      ),
      page: {
        offset,
        limit,
        total: allRecords.length,
        returned: page.length,
      },
    },
    warnings,
    limits: { offset, limit },
  };
}

export function traceFieldValuePath(
  directory: string,
  options: TraceFieldValuePathOptions,
): ReturnType<typeof traceFieldValuePathFromProjection> {
  return traceFieldValuePathFromProjection(
    loadFieldEvidenceDirectory(directory),
    options,
  );
}

export function traceFieldValuePathFromProjection(
  loaded: FieldEvidenceQuerySource,
  options: TraceFieldValuePathOptions,
): FieldEvidenceQueryEnvelope<{
  readonly startStateId: string | null;
  readonly nodes: readonly FieldEvidenceNodeRecord[];
  readonly valueEdges: readonly FieldEvidenceEdgeRecord[];
  readonly annotationNodes: readonly FieldEvidenceNodeRecord[];
  readonly annotationEdges: readonly FieldEvidenceEdgeRecord[];
  readonly exploredPaths: number;
  readonly truncated: boolean;
}> {
  const maxHops = positive(options.maxHops ?? 25, "MAX_HOPS");
  const maxNodes = positive(options.maxNodes ?? 5_000, "MAX_NODES");
  const maxEdges = positive(options.maxEdges ?? 10_000, "MAX_EDGES");
  const maxPaths = positive(options.maxPaths ?? 10_000, "MAX_PATHS");
  const startStateId = resolveStartState(
    loaded.projection.snapshot.selection,
    options,
  );
  const nodeById = new Map(
    loaded.projection.nodes.map((node) => [node.nodeId, node]),
  );
  if (!startStateId || !nodeById.has(startStateId)) {
    return {
      schemaVersion: FIELD_EVIDENCE_SCHEMA_VERSION,
      query: "trace_field_value_path",
      status: "not_found",
      snapshotId: loaded.projection.snapshot.snapshotId,
      result: {
        startStateId,
        nodes: [],
        valueEdges: [],
        annotationNodes: [],
        annotationEdges: [],
        exploredPaths: 0,
        truncated: false,
      },
      warnings: ["START_STATE_NOT_FOUND"],
      limits: { maxHops, maxNodes, maxEdges, maxPaths },
    };
  }

  const incoming = new Map<string, FieldEvidenceEdgeRecord[]>();
  for (const edge of loaded.projection.edges) {
    if (edge.edgeType !== "VALUE_FLOW") continue;
    const values = incoming.get(edge.toNodeId) ?? [];
    values.push(edge);
    incoming.set(edge.toNodeId, values);
  }
  for (const values of incoming.values())
    values.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  const frontier: { readonly nodeId: string; readonly depth: number }[] = [
    { nodeId: startStateId, depth: 0 },
  ];
  const queued = new Set([startStateId]);
  let exploredPaths = 0;
  let truncated = false;
  while (frontier.length > 0) {
    const current = frontier.shift()!;
    queued.delete(current.nodeId);
    if (seenNodes.has(current.nodeId)) continue;
    if (seenNodes.size >= maxNodes) {
      truncated = true;
      break;
    }
    seenNodes.add(current.nodeId);
    const parents = incoming.get(current.nodeId) ?? [];
    if (parents.length > 0 && current.depth >= maxHops) {
      truncated = true;
      continue;
    }
    for (const edge of parents) {
      if (exploredPaths >= maxPaths || seenEdges.size >= maxEdges) {
        truncated = true;
        break;
      }
      const addsParent =
        !seenNodes.has(edge.fromNodeId) && !queued.has(edge.fromNodeId);
      if (addsParent && seenNodes.size + queued.size >= maxNodes) {
        truncated = true;
        continue;
      }
      exploredPaths += 1;
      seenEdges.add(edge.edgeId);
      if (addsParent) {
        frontier.push({ nodeId: edge.fromNodeId, depth: current.depth + 1 });
        frontier.sort(
          (left, right) =>
            left.depth - right.depth || left.nodeId.localeCompare(right.nodeId),
        );
        queued.add(edge.fromNodeId);
      }
    }
  }
  const valueEdges = loaded.projection.edges.filter((edge) =>
    seenEdges.has(edge.edgeId),
  );
  const annotationCandidates = loaded.projection.edges
    .filter(
      (edge) =>
        edge.edgeType !== "VALUE_FLOW" &&
        (seenNodes.has(edge.fromNodeId) ||
          seenNodes.has(edge.toNodeId) ||
          (typeof edge.properties.valueEdgeId === "string" &&
            seenEdges.has(edge.properties.valueEdgeId))),
    )
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const annotationNodeIds = new Set<string>();
  const annotationEdges: FieldEvidenceEdgeRecord[] = [];
  for (const edge of annotationCandidates) {
    if (valueEdges.length + annotationEdges.length >= maxEdges) {
      truncated = true;
      break;
    }
    const requiredNodeIds = sortedUnique([
      edge.fromNodeId,
      edge.toNodeId,
    ]).filter(
      (nodeId) => !seenNodes.has(nodeId) && !annotationNodeIds.has(nodeId),
    );
    if (
      seenNodes.size + annotationNodeIds.size + requiredNodeIds.length >
      maxNodes
    ) {
      truncated = true;
      continue;
    }
    annotationEdges.push(edge);
    for (const nodeId of requiredNodeIds) annotationNodeIds.add(nodeId);
  }
  const sourcePartial =
    loaded.projection.snapshot.slice.coverageStatus !== "COMPLETE";
  return {
    schemaVersion: FIELD_EVIDENCE_SCHEMA_VERSION,
    query: "trace_field_value_path",
    status: sourcePartial || truncated ? "partial" : "ok",
    snapshotId: loaded.projection.snapshot.snapshotId,
    result: {
      startStateId,
      nodes: loaded.projection.nodes.filter((node) =>
        seenNodes.has(node.nodeId),
      ),
      valueEdges,
      annotationNodes: loaded.projection.nodes.filter((node) =>
        annotationNodeIds.has(node.nodeId),
      ),
      annotationEdges,
      exploredPaths,
      truncated,
    },
    warnings: warningsFor(
      loaded.projection.snapshot.slice.coverageStatus,
      truncated,
    ),
    limits: { maxHops, maxNodes, maxEdges, maxPaths },
  };
}

export function explainFieldEvidenceRecord(
  directory: string,
  recordIdInput: string,
  options: { readonly maxAttachments?: number } = {},
): ReturnType<typeof explainFieldEvidenceRecordFromProjection> {
  return explainFieldEvidenceRecordFromProjection(
    loadFieldEvidenceDirectory(directory),
    recordIdInput,
    options,
  );
}

export function explainFieldEvidenceRecordFromProjection(
  loaded: FieldEvidenceQuerySource,
  recordIdInput: string,
  options: { readonly maxAttachments?: number } = {},
): FieldEvidenceQueryEnvelope<{
  readonly record: FieldEvidenceNodeRecord | FieldEvidenceEdgeRecord | null;
  readonly endpoints: readonly FieldEvidenceNodeRecord[];
  readonly bindingStates: readonly FieldEvidenceNodeRecord[];
  readonly expressions: readonly FieldEvidenceNodeRecord[];
  readonly precisionRecords: readonly FieldEvidenceNodeRecord[];
  readonly attachments: readonly (
    FieldEvidenceNodeRecord | FieldEvidenceEdgeRecord
  )[];
  readonly sourceArtifacts: readonly unknown[];
}> {
  const maxAttachments = positive(
    options.maxAttachments ?? 500,
    "MAX_ATTACHMENTS",
  );
  const nodeMatches = loaded.projection.nodes.filter(
    (node) => node.nodeId === recordIdInput,
  );
  const edgeMatches = loaded.projection.edges.filter(
    (edge) => edge.edgeId === recordIdInput,
  );
  const matches = [...nodeMatches, ...edgeMatches];
  const baseStatus: FieldEvidenceQueryStatus =
    matches.length === 0
      ? "not_found"
      : matches.length > 1
        ? "ambiguous"
        : loaded.projection.snapshot.slice.coverageStatus === "COMPLETE"
          ? "ok"
          : "partial";
  const record = matches.length === 1 ? matches[0]! : null;
  const nodeById = new Map(
    loaded.projection.nodes.map((node) => [node.nodeId, node]),
  );
  const subjectNodeIds = new Set(
    !record || isNode(record)
      ? record
        ? [record.nodeId]
        : []
      : [record.fromNodeId, record.toNodeId],
  );
  const allRelatedEdges = record
    ? loaded.projection.edges.filter(
        (edge) =>
          (edge.edgeType !== "VALUE_FLOW" &&
            (subjectNodeIds.has(edge.fromNodeId) ||
              subjectNodeIds.has(edge.toNodeId))) ||
          edge.properties.valueEdgeId === recordIdInput,
      )
    : [];
  const endpointIds = isNode(record)
    ? []
    : record
      ? [record.fromNodeId, record.toNodeId]
      : [];
  const allRelatedNodeIds = new Set(
    allRelatedEdges.flatMap((edge) => [edge.fromNodeId, edge.toNodeId]),
  );
  const allRelatedNodes = loaded.projection.nodes.filter((node) =>
    allRelatedNodeIds.has(node.nodeId),
  );
  const allAttachments: (FieldEvidenceNodeRecord | FieldEvidenceEdgeRecord)[] =
    [...allRelatedNodes, ...allRelatedEdges].sort((left, right) =>
      recordId(left).localeCompare(recordId(right)),
    );
  const attachments = allAttachments.slice(0, maxAttachments);
  const attachmentLimited = attachments.length < allAttachments.length;
  const attachmentNodeIds = new Set(
    attachments
      .filter((item): item is FieldEvidenceNodeRecord => isNode(item))
      .map((item) => item.nodeId),
  );
  const relatedNodes = allRelatedNodes.filter((node) =>
    attachmentNodeIds.has(node.nodeId),
  );
  const status: FieldEvidenceQueryStatus =
    attachmentLimited && (baseStatus === "ok" || baseStatus === "partial")
      ? "partial"
      : baseStatus;
  const bindingStates = [
    ...loaded.projection.nodes.filter(
      (node) =>
        endpointIds.includes(node.nodeId) &&
        node.nodeType === "FIELD_BINDING_STATE",
    ),
    ...relatedNodes.filter((node) => node.nodeType === "FIELD_BINDING_STATE"),
  ].filter(uniqueNode);
  const expressionIds = new Set(
    loaded.projection.edges
      .filter(
        (edge) =>
          edge.edgeType === "STATE_COMPUTED_BY" &&
          bindingStates.some((node) => node.nodeId === edge.fromNodeId),
      )
      .map((edge) => edge.toNodeId),
  );
  return {
    schemaVersion: FIELD_EVIDENCE_SCHEMA_VERSION,
    query: "explain_field_evidence_record",
    status,
    snapshotId: loaded.projection.snapshot.snapshotId,
    result: {
      record,
      endpoints: endpointIds
        .map((nodeId) => nodeById.get(nodeId))
        .filter((node): node is FieldEvidenceNodeRecord => node !== undefined),
      bindingStates,
      expressions: loaded.projection.nodes.filter((node) =>
        expressionIds.has(node.nodeId),
      ),
      precisionRecords: relatedNodes.filter(
        (node) =>
          node.nodeType === "READ_OCCURRENCE" ||
          node.nodeType === "WRITE_OBSERVATION",
      ),
      attachments,
      sourceArtifacts: [
        loaded.projection.snapshot.projectSource,
        loaded.projection.snapshot.fieldSource,
      ],
    },
    warnings:
      status === "not_found"
        ? ["RECORD_NOT_FOUND"]
        : status === "ambiguous"
          ? ["RECORD_ID_AMBIGUOUS"]
          : warningsFor(
              loaded.projection.snapshot.slice.coverageStatus,
              attachmentLimited,
            ),
    limits: { maxAttachments },
  };
}

function resolveStartState(
  selection: {
    readonly rootStateIds: Readonly<Record<string, string>>;
  },
  options: TraceFieldValuePathOptions,
): string | null {
  if (options.startStateId && options.rootField)
    throw new Error("FIELD_EVIDENCE_TRACE_START_AMBIGUOUS");
  if (options.startStateId) return options.startStateId;
  if (!options.rootField)
    throw new Error("FIELD_EVIDENCE_TRACE_START_REQUIRED");
  return selection.rootStateIds[options.rootField.trim().toLowerCase()] ?? null;
}

function queryStatus(
  coverage: string,
  limited: boolean,
): FieldEvidenceQueryStatus {
  return coverage === "COMPLETE" && !limited ? "ok" : "partial";
}

function warningsFor(coverage: string, limited: boolean): string[] {
  return sortedUnique([
    ...(coverage === "COMPLETE" ? [] : ["SOURCE_OR_SLICE_PARTIAL"]),
    ...(limited ? ["QUERY_LIMIT_REACHED"] : []),
  ]);
}

function isNode(
  record: FieldEvidenceNodeRecord | FieldEvidenceEdgeRecord | null,
): record is FieldEvidenceNodeRecord {
  return record?.recordType === "NODE";
}

function recordId(
  record: FieldEvidenceNodeRecord | FieldEvidenceEdgeRecord,
): string {
  return isNode(record) ? record.nodeId : record.edgeId;
}

function uniqueNode(
  node: FieldEvidenceNodeRecord,
  index: number,
  nodes: readonly FieldEvidenceNodeRecord[],
): boolean {
  return (
    nodes.findIndex((candidate) => candidate.nodeId === node.nodeId) === index
  );
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`FIELD_EVIDENCE_QUERY_${label}_INVALID`);
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`FIELD_EVIDENCE_QUERY_${label}_INVALID`);
  return value;
}
