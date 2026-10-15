import { canonicalJson, sha256 } from "../../../contracts/runtime.ts";
import {
  PROJECT_TOPOLOGY_PROJECTION_VERSION,
  PROJECT_TOPOLOGY_SCHEMA_VERSION,
  PROJECT_TOPOLOGY_SNAPSHOT_TYPE,
  compareText,
  projectKeySegment,
  sortedUnique,
  type ProjectTopologyCoverageStatus,
  type ProjectTopologySourceMode,
} from "../../contracts/project-topology-contract.ts";
import type {
  TaskLocalUnionBatchManifestRef,
  TaskLocalUnionCoverageStatus,
  TaskLocalUnionProducerIndexRef,
  TaskLocalUnionTaskSource,
} from "../../../continuation/task-local-projection.ts";

export * from "../../../continuation/task-local-projection.ts";

/**
 * Mode-gated snapshot body for TASK_LOCAL_UNION.
 * No rootTaskIds — union graphs have no root semantics.
 */
export interface TaskLocalUnionSnapshotV1 {
  readonly schemaVersion: typeof PROJECT_TOPOLOGY_SCHEMA_VERSION;
  readonly artifactType: typeof PROJECT_TOPOLOGY_SNAPSHOT_TYPE;
  readonly projectionVersion: typeof PROJECT_TOPOLOGY_PROJECTION_VERSION;
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly sourceMode: "TASK_LOCAL_UNION";
  readonly taskSources: readonly TaskLocalUnionTaskSource[];
  readonly producerIndex: TaskLocalUnionProducerIndexRef;
  readonly batchManifestRef: TaskLocalUnionBatchManifestRef;
  readonly coverageStatus: ProjectTopologyCoverageStatus;
  readonly contentHash: string;
}

const SHA256 = /^[a-f0-9]{64}$/i;
const COVERAGE = new Set<TaskLocalUnionCoverageStatus>([
  "PROJECTED",
  "SCHEDULE_ONLY",
  "COLLECTION_FAILED",
]);

/** Reject mixing topology source modes in one snapshot / build. */
export function assertExclusiveSourceModes(
  modes: readonly ProjectTopologySourceMode[],
): void {
  const unique = new Set(modes);
  if (unique.size !== 1) {
    throw new Error("PROJECT_TOPOLOGY_SOURCE_MODE_MIXED");
  }
}

export function taskLocalUnionSnapshotId(input: {
  readonly projectKey: string;
  readonly taskSources: readonly TaskLocalUnionTaskSource[];
  readonly producerIndex: TaskLocalUnionProducerIndexRef;
  readonly batchManifestRef: TaskLocalUnionBatchManifestRef;
}): string {
  projectKeySegment(input.projectKey);
  const contentHash = sha256(
    canonicalJson({
      projectKey: input.projectKey,
      projectionVersion: PROJECT_TOPOLOGY_PROJECTION_VERSION,
      sourceMode: "TASK_LOCAL_UNION",
      taskSources: [...input.taskSources]
        .sort((left, right) => compareText(left.taskId, right.taskId))
        .map((source) => ({
          taskId: source.taskId,
          contentHash: source.contentHash,
          packContentHash: source.packContentHash,
          factsManifestSha256: source.factsManifestSha256,
          coverageStatus: source.coverageStatus,
          failureReasonCode: source.failureReasonCode,
        })),
      producerIndex: input.producerIndex,
      batchManifestContentHash: input.batchManifestRef.contentHash,
    }),
  );
  return `project-snapshot-${contentHash}`;
}

export function taskLocalUnionSnapshotContentHash(
  snapshot: Omit<TaskLocalUnionSnapshotV1, "contentHash">,
): string {
  return sha256(canonicalJson(snapshot));
}

export function validateTaskLocalUnionSnapshot(
  snapshot: TaskLocalUnionSnapshotV1,
): void {
  if (
    snapshot.schemaVersion !== PROJECT_TOPOLOGY_SCHEMA_VERSION ||
    snapshot.artifactType !== PROJECT_TOPOLOGY_SNAPSHOT_TYPE ||
    snapshot.projectionVersion !== PROJECT_TOPOLOGY_PROJECTION_VERSION
  ) {
    throw new Error("TASK_LOCAL_UNION_SNAPSHOT_CONTRACT_INVALID");
  }
  if (snapshot.sourceMode !== "TASK_LOCAL_UNION") {
    throw new Error("TASK_LOCAL_UNION_SOURCE_MODE_INVALID");
  }
  assertExclusiveSourceModes([snapshot.sourceMode]);
  projectKeySegment(snapshot.projectKey);

  if (snapshot.taskSources.length === 0) {
    throw new Error("TASK_LOCAL_UNION_TASK_SOURCES_EMPTY");
  }
  const taskIds = snapshot.taskSources.map((source) => source.taskId);
  if (JSON.stringify(taskIds) !== JSON.stringify(sortedUnique(taskIds))) {
    throw new Error("TASK_LOCAL_UNION_TASK_SOURCES_ORDER_OR_DUPLICATE");
  }
  for (const source of snapshot.taskSources) {
    if (!source.taskId.trim()) {
      throw new Error("TASK_LOCAL_UNION_TASK_ID_INVALID");
    }
    if (!SHA256.test(source.contentHash)) {
      throw new Error(`TASK_LOCAL_UNION_TASK_HASH_INVALID:${source.taskId}`);
    }
    if (!COVERAGE.has(source.coverageStatus)) {
      throw new Error(`TASK_LOCAL_UNION_COVERAGE_INVALID:${source.taskId}`);
    }
  }

  if (
    !SHA256.test(snapshot.producerIndex.contentHash) ||
    !snapshot.producerIndex.inputFingerprint.trim()
  ) {
    throw new Error("TASK_LOCAL_UNION_PRODUCER_INDEX_INVALID");
  }
  if (
    !snapshot.batchManifestRef.path.trim() ||
    !SHA256.test(snapshot.batchManifestRef.contentHash)
  ) {
    throw new Error("TASK_LOCAL_UNION_BATCH_MANIFEST_REF_INVALID");
  }

  if (
    taskLocalUnionSnapshotId({
      projectKey: snapshot.projectKey,
      taskSources: snapshot.taskSources,
      producerIndex: snapshot.producerIndex,
      batchManifestRef: snapshot.batchManifestRef,
    }) !== snapshot.snapshotId
  ) {
    throw new Error("TASK_LOCAL_UNION_SNAPSHOT_ID_INVALID");
  }

  const { contentHash: _contentHash, ...body } = snapshot;
  if (taskLocalUnionSnapshotContentHash(body) !== snapshot.contentHash) {
    throw new Error("TASK_LOCAL_UNION_SNAPSHOT_HASH_INVALID");
  }
}
