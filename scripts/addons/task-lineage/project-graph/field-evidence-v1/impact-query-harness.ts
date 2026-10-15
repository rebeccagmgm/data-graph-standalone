import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { normalizeName } from "../../../../machine-facts/machine-facts-contract.ts";
import { resolveWorkspacePaths, type WorkspacePathOptions } from "../../../../config/workspace-paths.ts";
import {
	openWriterCatalog,
	writerCatalogPort,
} from "../../../../query/writer-catalog.ts";
import { loadCurrentTaskBundle } from "../../../../query/current-task-bundle.ts";
import { loadUnionContinuationCandidateSource } from "../../../../reconcile/consumer/target-table-upstream-causal-closure/union-continuation-candidate-source.ts";
import { projectTaskLocal } from "../../../../project-graph/task-local/project-task-local.ts";
import type { TaskLocalProjection } from "../../../../project-graph/task-local/contract.ts";
import type { ContinuationPorts } from "./continuation/ports.ts";
import {
  buildReadScopeFromFacts,
} from "./continuation/read-scope-from-facts.ts";
import { resolveProducerTableIdentity } from "../../../../reconcile/shared/producer-table-identity.ts";
import { impactQuery, type ImpactQueryInput } from "./impact-query.ts";
import type { FieldImpactAnchor, FieldImpactResult } from "./impact-result-contract.ts";
import {
  createHoraeScheduleRelationLookupFromCache,
  type HoraeScheduleRelationLookup,
} from "./schedule-preference.ts";

export interface FieldEvidenceQueryRoots {
  readonly dataRoot: string;
  readonly factsRoot: string;
  readonly indexPath: string;
  readonly scheduleCacheRoot: string;
  readonly writerCatalogPath: string | null;
}

export function fieldEvidenceQueryRoots(options: WorkspacePathOptions = {}): FieldEvidenceQueryRoots | null {
  const paths = resolveWorkspacePaths(options);
  const dataRoot = paths.inputPackRoot;
  const factsRoot = paths.factsRoot;
  const required = join(factsRoot, "registry", "tasks");
  if (!existsSync(required)) return null;

  const indexPath = paths.continuationIndexPath;
  if (!existsSync(indexPath)) return null;

  const scheduleCacheRoot = paths.evidenceRoot;

  const writerCatalogCandidate = paths.writerCatalogPath;
  const writerCatalogPath = existsSync(writerCatalogCandidate)
    ? writerCatalogCandidate
    : null;

  return { dataRoot, factsRoot, indexPath, scheduleCacheRoot, writerCatalogPath };
}

export function fieldEvidenceGoldenRequired(): boolean {
  return process.env.FIELD_EVIDENCE_GOLDEN_REQUIRED === "1";
}

function lookupTaskCategory(dataRoot: string, taskId: string): string | null {
  const tasksRoot = join(dataRoot, "tasks");
  if (!existsSync(tasksRoot) || taskId.includes("/") || taskId.includes("\\")) {
    return null;
  }
  const hits = readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(tasksRoot, entry.name, taskId, "task.json"))
    .filter((taskPath) => existsSync(taskPath));
  if (hits.length !== 1) return null;
  try {
    const document = JSON.parse(readFileSync(hits[0]!, "utf8")) as {
      readonly taskCategory?: unknown;
    };
    if (typeof document.taskCategory === "string" && document.taskCategory.trim()) {
      return document.taskCategory.trim();
    }
  } catch {
    return null;
  }
  return basename(dirname(dirname(hits[0]!)));
}

export function createContinuationPorts(input: {
  readonly scheduleRelationLookup: HoraeScheduleRelationLookup;
  readonly writerCatalogPath: string | null;
  readonly factsBundleForTask: ImpactQueryInput["factsBundleForTask"];
  readonly taskCategoryFor: (taskId: string) => string | null;
}): ContinuationPorts {
  const writerCatalog = input.writerCatalogPath
    ? writerCatalogPort(openWriterCatalog(input.writerCatalogPath))
    : null;

  const tableIdentityFor: ContinuationPorts["tableIdentityFor"] = ({
    consumerTaskId,
    qualifiedName,
  }) => resolveProducerTableIdentity({
    qualifiedName,
    taskCategory: input.taskCategoryFor(consumerTaskId),
  });

  return {
    scheduleLookup: input.scheduleRelationLookup,
    writerCatalog,
    taskCategoryFor: input.taskCategoryFor,
    tableIdentityFor,
    readScopeFor: ({ consumerTaskId, readOccurrenceId, qualifiedName }) => {
      const bundle = input.factsBundleForTask?.(consumerTaskId);
      if (!bundle) {
        return { kind: "UNAVAILABLE", reasonCode: "READ_SCOPE_UNAVAILABLE" };
      }

      return buildReadScopeFromFacts({
        readOccurrenceId,
        qualifiedName,
        relationRecords: bundle.relationNodes,
        relationEdgeRecords: bundle.relationEdges,
        partitionFields: [],
      });
    },
  };
}

export function createFieldEvidenceQueryContext(roots: FieldEvidenceQueryRoots): {
  readonly index: ReturnType<typeof loadUnionContinuationCandidateSource>;
  readonly scheduleRelationLookup: HoraeScheduleRelationLookup;
  readonly writerCatalogPath: string | null;
  readonly continuationPorts: ContinuationPorts;
  readonly projectionForTask: (taskId: string) => TaskLocalProjection;
  readonly factsBundleForTask: ImpactQueryInput["factsBundleForTask"];
  readonly runImpactQuery: (
    anchor: FieldImpactAnchor,
    options?: Pick<ImpactQueryInput, "maxDepth" | "budget" | "expandCandidates">,
  ) => FieldImpactResult;
} {
  const index = loadUnionContinuationCandidateSource(roots.indexPath);
  const scheduleRelationLookup = createHoraeScheduleRelationLookupFromCache(
    roots.scheduleCacheRoot,
  );
  const writerCatalogPath = roots.writerCatalogPath;
  const projectionCache = new Map<string, TaskLocalProjection>();
  const bundleCache = new Map<string, ReturnType<typeof loadCurrentTaskBundle>>();

  function projectionForTask(taskId: string): TaskLocalProjection {
    let cached = projectionCache.get(taskId);
    if (!cached) {
      cached = projectTaskLocal({
        factsRoot: roots.factsRoot,
        dataRoot: roots.dataRoot,
        taskId,
      });
      projectionCache.set(taskId, cached);
    }
    return cached;
  }

  const factsBundleForTask: ImpactQueryInput["factsBundleForTask"] = (taskId) => {
    let bundle = bundleCache.get(taskId);
    if (!bundle) {
      bundle = loadCurrentTaskBundle(roots.factsRoot, taskId);
      bundleCache.set(taskId, bundle);
    }
    const relationNodes = bundle.records["relation-nodes.jsonl"] ?? [];
    const relationEdges = bundle.records["relation-edges.jsonl"] ?? [];
    if (relationNodes.length === 0 || relationEdges.length === 0) return null;
    return { relationNodes, relationEdges };
  };

  const taskCategoryCache = new Map<string, string | null>();
  const taskCategoryFor = (taskId: string): string | null => {
    const cached = taskCategoryCache.get(taskId);
    if (cached !== undefined) return cached;
    const category = lookupTaskCategory(roots.dataRoot, taskId);
    taskCategoryCache.set(taskId, category);
    return category;
  };

  const continuationPorts = createContinuationPorts({
    scheduleRelationLookup,
    writerCatalogPath,
    factsBundleForTask,
    taskCategoryFor,
  });

  function runImpactQuery(
    anchor: FieldImpactAnchor,
    options?: Pick<ImpactQueryInput, "maxDepth" | "budget" | "expandCandidates">,
  ): FieldImpactResult {
    return impactQuery({
      anchor,
      index,
      projectionForTask,
      factsBundleForTask,
      scheduleRelationLookup,
      continuationPorts,
      ...options,
    });
  }

  return {
    index,
    scheduleRelationLookup,
    writerCatalogPath,
    continuationPorts,
    projectionForTask,
    factsBundleForTask,
    runImpactQuery,
  };
}

export function primaryFinalWrite(projection: TaskLocalProjection): {
  readonly writeObservationId: string;
} | null {
  const write = projection.localClosure?.finalWrites[0];
  if (!write) return null;
  return { writeObservationId: write.writeObservationId };
}

export function materializationBreakColumns(projection: TaskLocalProjection): readonly string[] {
  const gap = projection.gaps?.find(
    (item) => item.reasonCode === "TASK_LOCAL_MATERIALIZATION_FIELD_BREAK",
  );
  const columns = gap?.details.columns;
  return Array.isArray(columns) ? columns.map(String) : [];
}

export function anchorFromTempTableSource(
  projection: TaskLocalProjection,
): FieldImpactAnchor | null {
  const materializationGap = projection.gaps?.find(
    (gap) => gap.reasonCode === "TASK_LOCAL_MATERIALIZATION_FIELD_BREAK",
  );
  const physicalDataset = String(materializationGap?.details.physicalDataset ?? "");
  if (!physicalDataset) return null;
  const normalizedDataset = normalizeName(physicalDataset);
  const nodeById = new Map(projection.nodes.map((node) => [node.nodeId, node]));
  for (const edge of projection.edges) {
    if (edge.edgeType !== "FIELD_DIRECT" && edge.edgeType !== "FIELD_CONDITIONAL") {
      continue;
    }
    const from = nodeById.get(edge.fromNodeId);
    const qualifiedName = normalizeName(String(from?.properties.qualifiedName ?? ""));
    if (qualifiedName !== normalizedDataset) continue;
    const outputColumn = String(edge.properties.outputColumn ?? "");
    if (!outputColumn) continue;
    const writeObservationId = String(
      nodeById.get(edge.toNodeId)?.properties.writeObservationId ?? "",
    );
    if (!writeObservationId) continue;
    return {
      taskId: projection.taskId,
      writeObservationId,
      outputColumn,
    };
  }
  return null;
}
