import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  taskLocalSchemaVersionAtLeast,
  validateTaskLocalProjection,
  type TaskLocalProjection,
} from "../../../project-graph/task-local/contract.ts";
import type { CurrentBundleLoad } from "../../../query/current-task-bundle.ts";
import type { CandidateBranch } from "../target-field-causal-slice/candidate-universe.ts";
import type {
  FieldValueEvidenceProvider,
  FieldValueImpact,
} from "./field-value-provider.ts";
import type { UnionContinuationCandidateSource } from "./union-continuation-candidate-source.ts";

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface LocalFactsEvidence {
  readonly projectionPath: string;
  readonly finalWriteNodeId: string;
  readonly localFieldPathCount: number;
  readonly bindingIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface UnionV2FieldValueEvidenceProvider extends FieldValueEvidenceProvider {
  /** Branches with both L1 continuation and current Facts local proof. */
  readonly valueCertainBranchIds: ReadonlySet<string>;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function records(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is JsonRecord => item !== null)
    : [];
}

function absolutePath(path: string, basePath?: string): string {
  return resolve(basePath ? dirname(basePath) : process.cwd(), path);
}

function taskProjectionPath(
  source: UnionContinuationCandidateSource,
  taskId: string,
): string | null {
  const projectionRef = source.index.input.taskProjections.find(
    (item) => item.taskId === taskId,
  );
  if (!projectionRef) return null;
  const rawRef = projectionRef as unknown as JsonRecord;
  const directPath = text(rawRef.path);
  if (directPath) return absolutePath(directPath);

  const batchManifestPath = text(source.index.input.batchManifestRef.path);
  if (!batchManifestPath || !existsSync(batchManifestPath)) return null;
  try {
    const batch = record(JSON.parse(readFileSync(batchManifestPath, "utf8")));
    const task = records(batch?.tasks).find(
      (item) => text(item.taskId) === taskId,
    );
    const path = text(task?.path);
    return path ? absolutePath(path, batchManifestPath) : null;
  } catch {
    return null;
  }
}

function l1Eligible(branch: CandidateBranch): boolean {
  const continuation = branch.continuation;
  return (
    continuation?.source === "IN_UNION_FINAL_WRITE" &&
    continuation.partitionMatchStatus === "CONFIRMED" &&
    continuation.evidenceLayer === "L1" &&
    continuation.l1Eligible === true
  );
}

function localFactsProof(
  branch: CandidateBranch,
  source: UnionContinuationCandidateSource,
  loadForTask: (taskId: string) => CurrentBundleLoad,
  cache: Map<string, LocalFactsEvidence | null>,
): LocalFactsEvidence | null {
  if (
    branch.branchKind !== "PHYSICAL_PRODUCER" ||
    !branch.producerTaskId ||
    !branch.writeObservationId
  )
    return null;
  const cacheKey = `${branch.producerTaskId}\u0000${branch.writeObservationId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
  const path = taskProjectionPath(source, branch.producerTaskId);
  const projectionRef = source.index.input.taskProjections.find(
    (item) => item.taskId === branch.producerTaskId,
  );
  if (!path || !projectionRef || !existsSync(path)) {
    cache.set(cacheKey, null);
    return null;
  }
  let projection: TaskLocalProjection;
  try {
    const parsed = record(JSON.parse(readFileSync(path, "utf8")));
    const rawProjection = record(parsed?.projection) ?? parsed;
    if (!rawProjection) {
      cache.set(cacheKey, null);
      return null;
    }
    projection = rawProjection as unknown as TaskLocalProjection;
    if (
      !taskLocalSchemaVersionAtLeast(projection.schemaVersion, "1.2.0")
      || projection.artifactType !== "TASK_LOCAL_PROJECTION"
      || projection.coverageStatus !== "PROJECTED"
      || projection.taskId !== branch.producerTaskId
      || projection.contentHash !== projectionRef.contentHash
      || !projection.localClosure
    ) {
      cache.set(cacheKey, null);
      return null;
    }
    validateTaskLocalProjection(projection);
  } catch {
    cache.set(cacheKey, null);
    return null;
  }
  const finalWrite = projection.localClosure.finalWrites.find(
    (write) =>
      write.writeObservationId === branch.writeObservationId &&
      (!branch.table?.qualifiedName ||
        write.qualifiedName.toLowerCase() ===
          branch.table.qualifiedName.toLowerCase()),
  );
  if (!finalWrite) {
    cache.set(cacheKey, null);
    return null;
  }
  const localFieldPaths = projection.localClosure.localFieldPaths.filter(
    (fieldPath) =>
      fieldPath.targetWriteNodeId === finalWrite.targetWriteNodeId &&
      fieldPath.sourceFieldNodeId.length > 0,
  );
  const bindingRows = records(
    loadForTask(branch.producerTaskId).records["output-field-bindings.jsonl"],
  ).filter(
    (binding) =>
      text(binding.task_id) === branch.producerTaskId &&
      text(binding.write_observation_id) === branch.writeObservationId &&
      text(binding.binding_status)?.toUpperCase() === "RESOLVED",
  );
  if (localFieldPaths.length === 0 || bindingRows.length === 0) {
    cache.set(cacheKey, null);
    return null;
  }
  const bindingIds = bindingRows
    .map((binding) => text(binding.binding_id))
    .filter((value): value is string => value !== null);
  const evidence: LocalFactsEvidence = {
    projectionPath: path,
    finalWriteNodeId: finalWrite.targetWriteNodeId,
    localFieldPathCount: localFieldPaths.length,
    bindingIds,
    evidenceRefs: [
      `task-local-projection:${projection.taskId}:${projection.contentHash}:write:${branch.writeObservationId}`,
      `task-local-projection:${projection.taskId}:${projection.contentHash}:local-field-paths:${finalWrite.targetWriteNodeId}`,
      ...bindingIds.map(
        (bindingId) =>
          `machine-facts:${projection.taskId}:output-field-bindings.jsonl#binding:${bindingId}`,
      ),
    ],
  };
  cache.set(cacheKey, evidence);
  return evidence;
}

function cappedImpact(
  branch: CandidateBranch,
  impact: FieldValueImpact,
  facts: LocalFactsEvidence | null,
): FieldValueImpact {
  if (impact.status !== "CONFIRMED") return impact;
  return {
    ...impact,
    status: "CONDITIONAL",
    evidenceRefs: [
      ...impact.evidenceRefs,
      "union-v2-field-value-provider:L2:LEGACY_FIELD_LINEAGE_CAPPED",
      ...(facts?.evidenceRefs ?? []),
    ].filter((value, index, all) => all.indexOf(value) === index),
    candidateBranchId: branch.candidateBranchId,
  };
}

/**
 * Keep the legacy field-lineage scan available for mappings, but make it a
 * capped L2 input in union-v2. Certainty is exposed separately and requires
 * the INDEX L1 continuation plus current Facts local closure.
 */
export function createUnionV2FieldValueEvidenceProvider(input: {
  readonly legacyProvider: FieldValueEvidenceProvider;
  readonly source: UnionContinuationCandidateSource;
  readonly branches: readonly CandidateBranch[];
  readonly loadForTask: (taskId: string) => CurrentBundleLoad;
}): UnionV2FieldValueEvidenceProvider {
  const projectionCache = new Map<string, LocalFactsEvidence | null>();
  const valueCertainBranchIds = new Set<string>();
  for (const branch of input.branches) {
    if (!l1Eligible(branch)) continue;
    const legacyImpact = input.legacyProvider.lookup(branch);
    if (legacyImpact.status !== "CONFIRMED") continue;
    if (
      localFactsProof(branch, input.source, input.loadForTask, projectionCache)
    ) {
      valueCertainBranchIds.add(branch.candidateBranchId);
    }
  }
  return {
    scanCount: input.legacyProvider.scanCount,
    edgeCount: input.legacyProvider.edgeCount,
    valueCertainBranchIds,
    lookup: (branch) => {
      const impact = input.legacyProvider.lookup(branch);
      if (branch.branchKind !== "PHYSICAL_PRODUCER") return impact;
      const facts = valueCertainBranchIds.has(branch.candidateBranchId)
        ? localFactsProof(
            branch,
            input.source,
            input.loadForTask,
            projectionCache,
          )
        : null;
      return cappedImpact(branch, impact, facts);
    },
  };
}
