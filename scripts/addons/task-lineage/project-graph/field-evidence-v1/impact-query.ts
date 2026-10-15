import { normalizeName } from "../../../../machine-facts/machine-facts-contract.ts";
import type { JsonRecord } from "../../../../query/current-task-bundle.ts";
import type { UnionContinuationCandidateSource } from "../../../../reconcile/consumer/target-table-upstream-causal-closure/union-continuation-candidate-source.ts";
import {
  taskLocalSchemaVersionAtLeast,
  TASK_LOCAL_PROJECTION_FIELD_EVIDENCE_SCHEMA_VERSION,
  type TaskLocalProjection,
  type TaskLocalProjectionGap,
} from "../../../../project-graph/task-local/contract.ts";
import { stableId } from "../../../../project-graph/task-local/ids.ts";
import { computeControlScope } from "./control-scope.ts";
import {
  buildFieldEdgeIndex,
  materializationBreakGapForDataset,
  readOccurrenceGapsForFieldEdge,
  type FieldEdgeIndex,
  type IndexedFieldEdge,
} from "./field-edge-index.ts";
import {
  emptyFieldImpactResult,
  type FieldImpactAnchor,
  type FieldImpactControlEntry,
  type FieldImpactFrontierEntry,
  type FieldImpactGap,
  type FieldImpactResult,
  type FieldImpactValueEntry,
} from "./impact-result-contract.ts";
import { resolveReadField } from "./resolve-read-field.ts";
import {
  enrichFrontierCandidates,
  type HoraeScheduleRelationLookup,
} from "./schedule-preference.ts";
import type { ContinuationPorts } from "./continuation/ports.ts";

export interface ImpactQueryBudget {
  readonly maxEdges?: number;
  readonly maxFrontier?: number;
}

export interface ImpactQueryInput {
  readonly anchor: FieldImpactAnchor;
  readonly index: UnionContinuationCandidateSource;
  readonly projectionForTask: (taskId: string) => TaskLocalProjection | null;
  readonly factsBundleForTask?: (taskId: string) => {
    readonly relationNodes: readonly JsonRecord[];
    readonly relationEdges: readonly JsonRecord[];
  } | null;
  readonly maxDepth?: number;
  readonly budget?: ImpactQueryBudget;
  readonly expandCandidates?: boolean;
  readonly scheduleRelationLookup?: HoraeScheduleRelationLookup | null;
  readonly continuationPorts?: ContinuationPorts | null;
}

interface TraversalState {
  readonly values: FieldImpactValueEntry[];
  readonly controls: FieldImpactControlEntry[];
  readonly frontiers: FieldImpactFrontierEntry[];
  readonly gaps: FieldImpactGap[];
  readonly gapKeys: Set<string>;
  edgesVisited: number;
  frontierCount: number;
  exhausted: boolean;
  exhaustedAt: { readonly which: string; readonly at: string } | null;
}

function gapKey(gap: TaskLocalProjectionGap | FieldImpactGap): string {
  return `${gap.reasonCode}\u0000${gap.gapId}`;
}

function pushGap(state: TraversalState, gap: FieldImpactGap): void {
  const key = gapKey(gap);
  if (state.gapKeys.has(key)) return;
  state.gapKeys.add(key);
  state.gaps.push(gap);
}

function projectionGapToImpact(gap: TaskLocalProjectionGap): FieldImpactGap {
  return {
    gapId: gap.gapId,
    reasonCode: gap.reasonCode,
    details: gap.details,
  };
}

function budgetExceeded(
  state: TraversalState,
  which: "maxDepth" | "maxEdges" | "maxFrontier",
  at: string,
): boolean {
  if (state.exhausted) return true;
  state.exhausted = true;
  state.exhaustedAt = { which, at };
  pushGap(state, {
    gapId: stableId("gap", { reasonCode: "TRAVERSAL_BUDGET_EXCEEDED", which, at }),
    reasonCode: "TRAVERSAL_BUDGET_EXCEEDED",
    details: { which, at },
  });
  return true;
}

function loadIndex(
  cache: Map<string, FieldEdgeIndex>,
  input: ImpactQueryInput,
  taskId: string,
): FieldEdgeIndex | null {
  if (cache.has(taskId)) return cache.get(taskId)!;

  const projection = input.projectionForTask(taskId);
  if (!projection) return null;
  if (
    !taskLocalSchemaVersionAtLeast(
      projection.schemaVersion,
      TASK_LOCAL_PROJECTION_FIELD_EVIDENCE_SCHEMA_VERSION,
    )
  ) {
    return null;
  }
  const bundle = input.factsBundleForTask?.(taskId);
  const index = buildFieldEdgeIndex({
    projection,
    relationNodes: bundle?.relationNodes,
    relationEdges: bundle?.relationEdges,
  });
  cache.set(taskId, index);
  return index;
}

function valueEntryFromEdge(input: {
  readonly depth: number;
  readonly taskId: string;
  readonly edge: IndexedFieldEdge;
  readonly evidenceStatus: "CONFIRMED" | "CANDIDATE";
}): FieldImpactValueEntry {
  return {
    depth: input.depth,
    taskId: input.taskId,
    writeObservationId: input.edge.writeObservationId,
    outputColumn: input.edge.outputColumn,
    source: {
      qualifiedName: input.edge.sourceQualifiedName,
      column: input.edge.sourceColumn,
      readOccurrenceId: input.edge.sourceReadOccurrenceId,
    },
    subtype: input.edge.subtype,
    evidenceStatus: input.evidenceStatus,
    expressionId: input.edge.expressionId,
    sourceRelationId: input.edge.sourceRelationId,
    sourceReadOccurrenceStatus: input.edge.sourceReadOccurrenceStatus,
  };
}

function emitControlsForValue(input: {
  readonly state: TraversalState;
  readonly depth: number;
  readonly taskId: string;
  readonly taskIndex: FieldEdgeIndex;
  readonly writeObservationId: string;
  readonly outputColumn: string;
  readonly valueEdge: IndexedFieldEdge;
  readonly maxEdges: number;
}): void {
  for (const control of input.taskIndex.controlsForWrite(input.writeObservationId)) {
    if (input.state.edgesVisited >= input.maxEdges) {
      budgetExceeded(input.state, "maxEdges", `control:${control.edgeId}`);
      return;
    }
    input.state.edgesVisited += 1;
    const scope = computeControlScope({
      relationTree: input.taskIndex.relationTree,
      valueSourceRelationId: input.valueEdge.sourceRelationId,
      controlRelationId: control.relationId,
      controlSubtype: control.subtype,
      joinType: control.joinType,
      leftRelationId: control.leftRelationId,
      rightRelationId: control.rightRelationId,
    });
    input.state.controls.push({
      depth: input.depth,
      subtype: control.subtype,
      joinType: control.joinType,
      controlSide: control.controlSide,
      column: {
        qualifiedName: control.sourceQualifiedName,
        column: control.sourceColumn,
      },
      scope,
      grain: control.grain,
      relationId: control.relationId,
      valueSourceRelationId: input.valueEdge.sourceRelationId,
      outputColumn: input.outputColumn,
    });
  }
}

function traverseValueEdge(input: {
  readonly state: TraversalState;
  readonly query: ImpactQueryInput;
  readonly indexCache: Map<string, FieldEdgeIndex>;
  readonly depth: number;
  readonly taskId: string;
  readonly edge: IndexedFieldEdge;
  readonly evidenceStatus: "CONFIRMED" | "CANDIDATE";
  readonly maxDepth: number;
  readonly maxEdges: number;
  readonly maxFrontier: number;
}): void {
  const { state, query, depth, taskId, edge, evidenceStatus, indexCache } = input;
  if (state.exhausted) return;
  if (depth >= input.maxDepth) return;

  if (state.edgesVisited >= input.maxEdges) {
    budgetExceeded(state, "maxEdges", `value:${edge.edgeId}`);
    return;
  }
  state.edgesVisited += 1;
  state.values.push(valueEntryFromEdge({ depth, taskId, edge, evidenceStatus }));

  const taskIndex = loadIndex(indexCache, query, taskId);
  if (!taskIndex) return;

  emitControlsForValue({
    state,
    depth,
    taskId,
    taskIndex,
    writeObservationId: edge.writeObservationId,
    outputColumn: edge.outputColumn,
    valueEdge: edge,
    maxEdges: input.maxEdges,
  });

  const materializationGap = materializationBreakGapForDataset(
    taskIndex,
    edge.sourceQualifiedName,
  );
  if (materializationGap) {
    pushGap(state, projectionGapToImpact(materializationGap));
    return;
  }

  if (edge.sourceReadOccurrenceStatus !== "RESOLVED") {
    for (const gap of readOccurrenceGapsForFieldEdge(taskIndex, edge)) {
      pushGap(state, projectionGapToImpact(gap));
    }
    return;
  }

  if (!edge.sourceReadOccurrenceId) return;

  const resolved = resolveReadField({
    consumerTaskId: taskId,
    readOccurrenceId: edge.sourceReadOccurrenceId,
    column: edge.sourceColumn,
    index: query.index,
    producerIndexForTask: (producerTaskId) =>
      loadIndex(indexCache, query, producerTaskId),
    continuationPorts: query.continuationPorts ?? {
      scheduleLookup: query.scheduleRelationLookup ?? null,
      writerCatalog: null,
      taskCategoryFor: () => null,
      readScopeFor: () => ({ kind: "UNAVAILABLE", reasonCode: "READ_SCOPE_UNAVAILABLE" }),
      tableIdentityFor: ({ qualifiedName }) => ({
        platform: "unknown",
        dataSource: "unknown",
        qualifiedName: qualifiedName.trim().toLowerCase(),
      }),
    },
  });

  if (resolved.kind === "NO_INDEX_ENTRY") {
    pushGap(state, {
      gapId: stableId("gap", {
        reasonCode: "PRODUCER_NOT_PROJECTED",
        taskId,
        readOccurrenceId: resolved.readOccurrenceId,
        column: resolved.column,
      }),
      reasonCode: "PRODUCER_NOT_PROJECTED",
      details: {
        consumerTaskId: taskId,
        readOccurrenceId: resolved.readOccurrenceId,
        column: resolved.column,
      },
    });
    return;
  }

  if (resolved.kind === "FRONTIER") {
    for (const gap of resolved.gaps) {
      pushGap(state, gap);
    }
    if (resolved.candidates.length === 0) {
      return;
    }
    if (state.frontierCount >= input.maxFrontier) {
      budgetExceeded(state, "maxFrontier", resolved.readOccurrenceId);
      return;
    }
    state.frontierCount += 1;
    const baseCandidates = resolved.candidates.map((candidate) => ({
      taskId: candidate.taskId,
      writeObservationId: candidate.writeObservationId,
      partitionMatchStatus: candidate.partitionMatchStatus,
      ...(candidate.reasonCode ? { reasonCode: candidate.reasonCode } : {}),
      l1Eligible: candidate.l1Eligible,
      schedulePreferred: false,
      scheduleRelation: "HORAE_UNAVAILABLE" as const,
    }));
    const scheduleEnrichment = enrichFrontierCandidates({
      consumerTaskId: taskId,
      readOccurrenceId: resolved.readOccurrenceId,
      column: resolved.column,
      candidates: baseCandidates,
      lookup: query.scheduleRelationLookup,
    });
    for (const gap of scheduleEnrichment.gaps) {
      pushGap(state, gap);
    }
    state.frontiers.push({
      depth: depth + 1,
      readField: {
        readOccurrenceId: resolved.readOccurrenceId,
        column: resolved.column,
      },
      candidates: scheduleEnrichment.candidates,
      reasonCode: resolved.reasonCode,
    });
    if (!query.expandCandidates) return;
    for (const candidate of scheduleEnrichment.candidates) {
      if (state.exhausted) return;
      const producerIndex = loadIndex(indexCache, query, candidate.taskId);
      if (!producerIndex) continue;
      const producerEdges = producerIndex.edgesForBinding(
        candidate.writeObservationId,
        resolved.column,
      );
      for (const producerEdge of producerEdges) {
        traverseValueEdge({
          state,
          query,
          indexCache,
          depth: depth + 1,
          taskId: candidate.taskId,
          edge: producerEdge,
          evidenceStatus: "CANDIDATE",
          maxDepth: input.maxDepth,
          maxEdges: input.maxEdges,
          maxFrontier: input.maxFrontier,
        });
      }
    }
    return;
  }

  if (resolved.kind === "NO_BINDING") {
    pushGap(state, {
      gapId: stableId("gap", {
        reasonCode: "PRODUCER_BINDING_NOT_FOUND",
        producerTaskId: resolved.candidate.taskId,
        writeObservationId: resolved.candidate.writeObservationId,
        column: resolved.column,
      }),
      reasonCode: "PRODUCER_BINDING_NOT_FOUND",
      details: {
        producerTaskId: resolved.candidate.taskId,
        writeObservationId: resolved.candidate.writeObservationId,
        column: resolved.column,
      },
    });
    return;
  }

  const producerIndex = loadIndex(indexCache, query, resolved.candidate.taskId);
  if (!producerIndex) {
    pushGap(state, {
      gapId: stableId("gap", {
        reasonCode: "PRODUCER_NOT_PROJECTED",
        producerTaskId: resolved.candidate.taskId,
      }),
      reasonCode: "PRODUCER_NOT_PROJECTED",
      details: { producerTaskId: resolved.candidate.taskId },
    });
    return;
  }

  for (const producerEdge of resolved.producerEdges) {
    if (depth + 1 >= input.maxDepth) {
      if (depth + 1 > input.maxDepth) {
        budgetExceeded(state, "maxDepth", producerEdge.edgeId);
      }
      continue;
    }
    traverseValueEdge({
      state,
      query,
      indexCache,
      depth: depth + 1,
      taskId: resolved.candidate.taskId,
      edge: producerEdge,
      evidenceStatus: "CONFIRMED",
      maxDepth: input.maxDepth,
      maxEdges: input.maxEdges,
      maxFrontier: input.maxFrontier,
    });
  }
}

export function impactQuery(input: ImpactQueryInput): FieldImpactResult {
  const anchor: FieldImpactAnchor = {
    taskId: input.anchor.taskId,
    writeObservationId: input.anchor.writeObservationId,
    outputColumn: normalizeName(input.anchor.outputColumn),
  };
  const maxDepth = input.maxDepth ?? 3;
  const maxEdges = input.budget?.maxEdges ?? 5000;
  const maxFrontier = input.budget?.maxFrontier ?? 200;
  const indexCache = new Map<string, FieldEdgeIndex>();

  const anchorProjection = input.projectionForTask(anchor.taskId);
  if (
    !anchorProjection
    || !taskLocalSchemaVersionAtLeast(
      anchorProjection.schemaVersion,
      TASK_LOCAL_PROJECTION_FIELD_EVIDENCE_SCHEMA_VERSION,
    )
  ) {
    return emptyFieldImpactResult({
      anchor,
      gaps: [{
        gapId: stableId("gap", { reasonCode: "CONTRACT_TOO_OLD", taskId: anchor.taskId }),
        reasonCode: "CONTRACT_TOO_OLD",
        details: {
          taskId: anchor.taskId,
          requiredSchemaVersion: TASK_LOCAL_PROJECTION_FIELD_EVIDENCE_SCHEMA_VERSION,
          actualSchemaVersion: anchorProjection?.schemaVersion ?? null,
        },
      }],
      budget: { maxDepth, maxEdges, maxFrontier },
    });
  }

  const anchorIndex = loadIndex(indexCache, input, anchor.taskId);
  if (!anchorIndex) {
    return emptyFieldImpactResult({
      anchor,
      gaps: [{
        gapId: stableId("gap", { reasonCode: "CONTRACT_TOO_OLD", taskId: anchor.taskId }),
        reasonCode: "CONTRACT_TOO_OLD",
        details: { taskId: anchor.taskId },
      }],
      budget: { maxDepth, maxEdges, maxFrontier },
    });
  }

  const state: TraversalState = {
    values: [],
    controls: [],
    frontiers: [],
    gaps: [],
    gapKeys: new Set(),
    edgesVisited: 0,
    frontierCount: 0,
    exhausted: false,
    exhaustedAt: null,
  };

  const anchorEdges = anchorIndex.edgesForBinding(
    anchor.writeObservationId,
    anchor.outputColumn,
  );

  for (const edge of anchorEdges) {
    traverseValueEdge({
      state,
      query: input,
      indexCache,
      depth: 0,
      taskId: anchor.taskId,
      edge,
      evidenceStatus: "CONFIRMED",
      maxDepth,
      maxEdges,
      maxFrontier,
    });
  }

  return {
    artifactType: "FIELD_IMPACT_RESULT",
    schemaVersion: "1.1.0",
    anchor,
    value: state.values,
    control: state.controls,
    frontier: state.frontiers,
    gaps: state.gaps,
    budget: {
      maxDepth,
      maxEdges,
      maxFrontier,
      edgesVisited: state.edgesVisited,
      frontierCount: state.frontierCount,
      exhausted: state.exhausted,
    },
  };
}
