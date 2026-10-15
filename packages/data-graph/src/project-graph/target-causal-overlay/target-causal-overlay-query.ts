import type {
  RelationStatus,
  ImpactChannel,
} from "../../contracts/canonical-artifacts.ts";
import {
  TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
  sortedUnique,
  type TargetCausalOverlayEdgeRecord,
  type TargetCausalOverlayNodeRecord,
  type TargetCausalOverlayProjectionV1,
  type TargetCausalOverlayQueryEnvelope,
  type TargetCausalOverlayQueryStatus,
} from "./target-causal-overlay-contract.ts";
import {
  loadTargetCausalOverlayDirectory,
  type LoadedTargetCausalOverlayDirectory,
} from "./target-causal-overlay-publication.ts";

export interface GetTargetCausalOverlayOptions {
  readonly relationStatuses?: readonly RelationStatus[];
  readonly channels?: readonly ImpactChannel[];
  readonly taskIds?: readonly string[];
  readonly offset?: number;
  readonly limit?: number;
}

export type TargetCausalOverlayQuerySource = Pick<
  LoadedTargetCausalOverlayDirectory,
  "projection"
>;

interface CausalSelection {
  readonly targetWrite: readonly TargetCausalOverlayNodeRecord[];
  readonly assessments: readonly TargetCausalOverlayNodeRecord[];
  readonly branches: readonly TargetCausalOverlayNodeRecord[];
  readonly channels: readonly TargetCausalOverlayNodeRecord[];
  readonly tasks: readonly TargetCausalOverlayNodeRecord[];
  readonly gaps: readonly TargetCausalOverlayNodeRecord[];
  readonly edges: readonly TargetCausalOverlayEdgeRecord[];
}

export function getTargetCausalOverlay(
  directory: string,
  options: GetTargetCausalOverlayOptions = {},
): ReturnType<typeof getTargetCausalOverlayFromProjection> {
  return getTargetCausalOverlayFromProjection(
    loadTargetCausalOverlayDirectory(directory),
    options,
  );
}

export function getTargetCausalOverlayFromProjection(
  loaded: TargetCausalOverlayQuerySource,
  options: GetTargetCausalOverlayOptions = {},
): TargetCausalOverlayQueryEnvelope<
  CausalSelection & {
    readonly summary: TargetCausalOverlayProjectionV1["snapshot"]["summary"];
    readonly runtimeRerunDecision: "NOT_EVALUATED";
    readonly page: {
      readonly offset: number;
      readonly limit: number;
      readonly total: number;
      readonly returned: number;
    };
  }
> {
  const offset = nonNegative(options.offset ?? 0, "OFFSET");
  const limit = positive(options.limit ?? 100, "LIMIT");
  const relationStatuses = new Set(options.relationStatuses ?? []);
  const channels = new Set(options.channels ?? []);
  const taskIds = new Set(options.taskIds ?? []);
  const projection = loaded.projection;
  const branchBySourceId = new Map(
    projection.nodes
      .filter(({ nodeType }) => nodeType === "CANDIDATE_BRANCH")
      .map((node) => [text(node.properties.candidateBranchId), node]),
  );
  const channelsByAssessment = groupedNodes(
    projection.nodes.filter(
      ({ nodeType }) => nodeType === "CHANNEL_ASSESSMENT",
    ),
    "assessmentId",
  );
  const allAssessments = projection.nodes
    .filter(({ nodeType }) => nodeType === "CAUSAL_ASSESSMENT")
    .filter((assessment) => {
      const relationStatus = text(assessment.properties.relationStatus);
      if (
        relationStatuses.size > 0 &&
        !relationStatuses.has(relationStatus as RelationStatus)
      )
        return false;
      const assessmentId = text(assessment.properties.assessmentId);
      const assessmentChannels = channelsByAssessment.get(assessmentId) ?? [];
      if (
        channels.size > 0 &&
        !assessmentChannels.some((channel) =>
          channels.has(text(channel.properties.channel) as ImpactChannel),
        )
      )
        return false;
      if (taskIds.size > 0) {
        const branch = branchBySourceId.get(
          text(assessment.properties.candidateBranchId),
        );
        if (
          !branch ||
          ![branch.properties.consumerTaskId, branch.properties.producerTaskId]
            .filter((value): value is string => typeof value === "string")
            .some((taskId) => taskIds.has(taskId))
        )
          return false;
      }
      return true;
    })
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const page = allAssessments.slice(offset, offset + limit);
  const selection = selectAssessmentContext(projection, page);
  const limited = offset + page.length < allAssessments.length;
  return {
    schemaVersion: TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
    query: "get_target_causal_overlay",
    status: queryStatus(projection, limited),
    snapshotId: projection.snapshot.snapshotId,
    result: {
      summary: projection.snapshot.summary,
      runtimeRerunDecision: projection.snapshot.runtimeRerunDecision,
      ...selection,
      page: {
        offset,
        limit,
        total: allAssessments.length,
        returned: page.length,
      },
    },
    warnings: warningsFor(projection, limited),
    limits: { offset, limit },
  };
}

export function getTargetCausalTaskRollup(
  directory: string,
  taskId: string,
  options: { readonly maxAssessments?: number } = {},
): ReturnType<typeof getTargetCausalTaskRollupFromProjection> {
  return getTargetCausalTaskRollupFromProjection(
    loadTargetCausalOverlayDirectory(directory),
    taskId,
    options,
  );
}

export function getTargetCausalTaskRollupFromProjection(
  loaded: TargetCausalOverlayQuerySource,
  taskIdInput: string,
  options: { readonly maxAssessments?: number } = {},
): TargetCausalOverlayQueryEnvelope<
  CausalSelection & {
    readonly task: TargetCausalOverlayNodeRecord | null;
    readonly truncated: boolean;
  }
> {
  const taskId = requiredText(taskIdInput, "TASK_ID");
  const maxAssessments = positive(
    options.maxAssessments ?? 2_000,
    "MAX_ASSESSMENTS",
  );
  const projection = loaded.projection;
  const taskMatches = projection.nodes.filter(
    (node) => node.nodeType === "TASK_REF" && node.properties.taskId === taskId,
  );
  if (taskMatches.length !== 1) {
    return {
      schemaVersion: TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
      query: "get_target_causal_task_rollup",
      status: taskMatches.length === 0 ? "not_found" : "ambiguous",
      snapshotId: projection.snapshot.snapshotId,
      result: {
        task: null,
        ...emptySelection(),
        truncated: false,
      },
      warnings: [
        taskMatches.length === 0 ? "TASK_NOT_FOUND" : "TASK_ID_AMBIGUOUS",
      ],
      limits: { maxAssessments },
    };
  }
  const branchIds = new Set(
    projection.nodes
      .filter(
        (node) =>
          node.nodeType === "CANDIDATE_BRANCH" &&
          (node.properties.producerTaskId === taskId ||
            node.properties.consumerTaskId === taskId),
      )
      .map((node) => text(node.properties.candidateBranchId)),
  );
  const allAssessments = projection.nodes.filter(
    (node) =>
      node.nodeType === "CAUSAL_ASSESSMENT" &&
      branchIds.has(text(node.properties.candidateBranchId)),
  );
  const assessments = allAssessments.slice(0, maxAssessments);
  const truncated = assessments.length < allAssessments.length;
  const selection = selectAssessmentContext(projection, assessments);
  return {
    schemaVersion: TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
    query: "get_target_causal_task_rollup",
    status: queryStatus(projection, truncated),
    snapshotId: projection.snapshot.snapshotId,
    result: {
      task: taskMatches[0]!,
      ...selection,
      truncated,
    },
    warnings: warningsFor(projection, truncated),
    limits: { maxAssessments },
  };
}

export function explainTargetCausalAssessment(
  directory: string,
  assessmentId: string,
  options: { readonly maxAttachments?: number } = {},
): ReturnType<typeof explainTargetCausalAssessmentFromProjection> {
  return explainTargetCausalAssessmentFromProjection(
    loadTargetCausalOverlayDirectory(directory),
    assessmentId,
    options,
  );
}

export function explainTargetCausalAssessmentFromProjection(
  loaded: TargetCausalOverlayQuerySource,
  assessmentIdInput: string,
  options: { readonly maxAttachments?: number } = {},
): TargetCausalOverlayQueryEnvelope<
  CausalSelection & {
    readonly assessment: TargetCausalOverlayNodeRecord | null;
    readonly sourceArtifacts: readonly unknown[];
    readonly truncated: boolean;
  }
> {
  const assessmentId = requiredText(assessmentIdInput, "ASSESSMENT_ID");
  const maxAttachments = positive(
    options.maxAttachments ?? 5_000,
    "MAX_ATTACHMENTS",
  );
  const projection = loaded.projection;
  const matches = projection.nodes.filter(
    (node) =>
      node.nodeType === "CAUSAL_ASSESSMENT" &&
      (node.nodeId === assessmentId ||
        node.properties.assessmentId === assessmentId),
  );
  if (matches.length !== 1) {
    return {
      schemaVersion: TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
      query: "explain_target_causal_assessment",
      status: matches.length === 0 ? "not_found" : "ambiguous",
      snapshotId: projection.snapshot.snapshotId,
      result: {
        assessment: null,
        ...emptySelection(),
        sourceArtifacts: [
          projection.snapshot.projectSource,
          projection.snapshot.fieldEvidenceSource,
          projection.snapshot.causalSource,
        ],
        truncated: false,
      },
      warnings: [
        matches.length === 0
          ? "ASSESSMENT_NOT_FOUND"
          : "ASSESSMENT_ID_AMBIGUOUS",
      ],
      limits: { maxAttachments },
    };
  }
  const full = selectAssessmentContext(projection, matches);
  const attachmentNodes = [
    ...full.targetWrite,
    ...full.assessments,
    ...full.branches,
    ...full.channels,
    ...full.tasks,
    ...full.gaps,
  ];
  const allowedNodes = new Set(
    attachmentNodes.slice(0, maxAttachments).map(({ nodeId }) => nodeId),
  );
  const truncated = allowedNodes.size < attachmentNodes.length;
  const selection: CausalSelection = {
    targetWrite: full.targetWrite.filter(({ nodeId }) =>
      allowedNodes.has(nodeId),
    ),
    assessments: full.assessments.filter(({ nodeId }) =>
      allowedNodes.has(nodeId),
    ),
    branches: full.branches.filter(({ nodeId }) => allowedNodes.has(nodeId)),
    channels: full.channels.filter(({ nodeId }) => allowedNodes.has(nodeId)),
    tasks: full.tasks.filter(({ nodeId }) => allowedNodes.has(nodeId)),
    gaps: full.gaps.filter(({ nodeId }) => allowedNodes.has(nodeId)),
    edges: full.edges.filter(
      ({ fromNodeId, toNodeId }) =>
        allowedNodes.has(fromNodeId) && allowedNodes.has(toNodeId),
    ),
  };
  return {
    schemaVersion: TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
    query: "explain_target_causal_assessment",
    status: queryStatus(projection, truncated),
    snapshotId: projection.snapshot.snapshotId,
    result: {
      assessment: matches[0]!,
      ...selection,
      sourceArtifacts: [
        projection.snapshot.projectSource,
        projection.snapshot.fieldEvidenceSource,
        projection.snapshot.causalSource,
      ],
      truncated,
    },
    warnings: warningsFor(projection, truncated),
    limits: { maxAttachments },
  };
}

function selectAssessmentContext(
  projection: TargetCausalOverlayProjectionV1,
  assessments: readonly TargetCausalOverlayNodeRecord[],
): CausalSelection {
  const assessmentNodeIds = new Set(assessments.map(({ nodeId }) => nodeId));
  const branchSourceIds = new Set(
    assessments.map((node) => text(node.properties.candidateBranchId)),
  );
  const assessmentSourceIds = new Set(
    assessments.map((node) => text(node.properties.assessmentId)),
  );
  const branches = projection.nodes.filter(
    (node) =>
      node.nodeType === "CANDIDATE_BRANCH" &&
      branchSourceIds.has(text(node.properties.candidateBranchId)),
  );
  const channels = projection.nodes.filter(
    (node) =>
      node.nodeType === "CHANNEL_ASSESSMENT" &&
      assessmentSourceIds.has(text(node.properties.assessmentId)),
  );
  const taskIds = new Set(
    branches.flatMap((branch) =>
      [
        branch.properties.consumerTaskId,
        branch.properties.producerTaskId,
      ].filter((value): value is string => typeof value === "string"),
    ),
  );
  taskIds.add(projection.snapshot.targetWrite.taskId);
  const tasks = projection.nodes.filter(
    (node) =>
      node.nodeType === "TASK_REF" && taskIds.has(text(node.properties.taskId)),
  );
  const baseNodeIds = new Set([
    ...assessmentNodeIds,
    ...branches.map(({ nodeId }) => nodeId),
    ...channels.map(({ nodeId }) => nodeId),
    ...tasks.map(({ nodeId }) => nodeId),
    ...projection.nodes
      .filter(
        ({ nodeType }) =>
          nodeType === "TARGET_WRITE" ||
          nodeType === "PROJECT_SNAPSHOT_REF" ||
          nodeType === "FIELD_EVIDENCE_SNAPSHOT_REF",
      )
      .map(({ nodeId }) => nodeId),
  ]);
  const gapNodeIds = new Set(
    projection.edges
      .filter(
        ({ fromNodeId, edgeType }) =>
          baseNodeIds.has(fromNodeId) && edgeType.endsWith("_HAS_GAP"),
      )
      .map(({ toNodeId }) => toNodeId),
  );
  const allNodeIds = new Set([...baseNodeIds, ...gapNodeIds]);
  return {
    targetWrite: projection.nodes.filter(
      ({ nodeType }) =>
        nodeType === "TARGET_WRITE" ||
        nodeType === "PROJECT_SNAPSHOT_REF" ||
        nodeType === "FIELD_EVIDENCE_SNAPSHOT_REF",
    ),
    assessments,
    branches,
    channels,
    tasks,
    gaps: projection.nodes.filter(({ nodeId }) => gapNodeIds.has(nodeId)),
    edges: projection.edges.filter(
      ({ fromNodeId, toNodeId }) =>
        allNodeIds.has(fromNodeId) && allNodeIds.has(toNodeId),
    ),
  };
}

function groupedNodes(
  nodes: readonly TargetCausalOverlayNodeRecord[],
  property: string,
): ReadonlyMap<string, readonly TargetCausalOverlayNodeRecord[]> {
  const result = new Map<string, TargetCausalOverlayNodeRecord[]>();
  for (const node of nodes) {
    const key = text(node.properties[property]);
    result.set(key, [...(result.get(key) ?? []), node]);
  }
  return result;
}

function emptySelection(): CausalSelection {
  return {
    targetWrite: [],
    assessments: [],
    branches: [],
    channels: [],
    tasks: [],
    gaps: [],
    edges: [],
  };
}

function queryStatus(
  projection: TargetCausalOverlayProjectionV1,
  limited: boolean,
): TargetCausalOverlayQueryStatus {
  return projection.snapshot.summary.coverageStatus === "COMPLETE" && !limited
    ? "ok"
    : "partial";
}

function warningsFor(
  projection: TargetCausalOverlayProjectionV1,
  limited: boolean,
): string[] {
  return sortedUnique([
    ...(projection.snapshot.summary.coverageStatus === "COMPLETE"
      ? []
      : ["CAUSAL_EVIDENCE_PARTIAL"]),
    ...(projection.snapshot.runtimeRerunDecision === "NOT_EVALUATED"
      ? ["RUNTIME_RERUN_NOT_EVALUATED"]
      : []),
    ...(limited ? ["QUERY_LIMIT_REACHED"] : []),
  ]);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new Error(`TARGET_CAUSAL_OVERLAY_QUERY_${label}_INVALID`);
  return trimmed;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`TARGET_CAUSAL_OVERLAY_QUERY_${label}_INVALID`);
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`TARGET_CAUSAL_OVERLAY_QUERY_${label}_INVALID`);
  return value;
}
