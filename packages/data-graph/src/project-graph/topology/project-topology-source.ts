import { readFileSync } from "node:fs";

import { canonicalJson, safeSegment, sha256 } from "../../contracts/runtime.ts";
import type { OneHopReconciliationResult } from "../../contracts/canonical-artifacts.ts";
import {
  validateMultiHopReconciliation,
  type MultiHopReconciliationResult,
} from "../../contracts/canonical-artifacts.ts";
import {
  PROJECT_TOPOLOGY_SCHEMA_VERSION,
  compareText,
  sortedUnique,
  type ProjectTopologyArtifactRef,
  type ProjectTopologyRootSource,
} from "../contracts/project-topology-contract.ts";

const SHA256 = /^[a-f0-9]{64}$/i;

export interface ProjectTopologyRootInput {
  readonly rootTaskId: string;
  readonly oneHopPath: string;
  readonly multiHopPath: string;
  readonly oneHopLogicalLocator?: string;
  readonly multiHopLogicalLocator?: string;
}

export interface LoadedProjectTopologyRoot {
  readonly source: ProjectTopologyRootSource;
  readonly oneHop: OneHopReconciliationResult;
  readonly multiHop: MultiHopReconciliationResult;
}

export interface LoadProjectTopologySourcesOptions {
  readonly maxRoots?: number;
  readonly maxSourceBytesPerFile?: number;
  readonly maxTotalSourceBytes?: number;
}

export function loadProjectTopologySources(
  inputs: readonly ProjectTopologyRootInput[],
  options: LoadProjectTopologySourcesOptions = {},
): LoadedProjectTopologyRoot[] {
  const maxRoots = positiveLimit(options.maxRoots ?? 32, "MAX_ROOTS");
  const maxSourceBytesPerFile = positiveLimit(
    options.maxSourceBytesPerFile ?? 256 * 1024 * 1024,
    "MAX_SOURCE_BYTES_PER_FILE",
  );
  const maxTotalSourceBytes = positiveLimit(
    options.maxTotalSourceBytes ?? 1024 * 1024 * 1024,
    "MAX_TOTAL_SOURCE_BYTES",
  );
  if (inputs.length === 0 || inputs.length > maxRoots)
    throw new Error("PROJECT_TOPOLOGY_ROOT_COUNT_INVALID");
  const rootIds = inputs.map((input) =>
    safeSegment(input.rootTaskId, "rootTaskId"),
  );
  if (sortedUnique(rootIds).length !== rootIds.length)
    throw new Error("PROJECT_TOPOLOGY_ROOT_DUPLICATE");

  let totalBytes = 0;
  const loaded = inputs.map((input) => {
    const oneHop = readArtifactFile(
      input.oneHopPath,
      maxSourceBytesPerFile,
      "ONE_HOP",
    );
    const multiHop = readArtifactFile(
      input.multiHopPath,
      maxSourceBytesPerFile,
      "MULTI_HOP",
    );
    totalBytes += oneHop.bytes.byteLength + multiHop.bytes.byteLength;
    if (totalBytes > maxTotalSourceBytes)
      throw new Error("PROJECT_TOPOLOGY_TOTAL_SOURCE_LIMIT");

    validateOneHopSource(oneHop.parsed, input.rootTaskId);
    validateMultiHopReconciliation(multiHop.parsed);
    if (multiHop.parsed.rootTaskId !== input.rootTaskId)
      throw new Error(
        `PROJECT_TOPOLOGY_MULTI_HOP_ROOT_MISMATCH:${input.rootTaskId}`,
      );
    const oneHopProducer = oneHop.parsed.producerIndex;
    const multiHopProducer = multiHop.parsed.producerIndex;
    if (
      oneHopProducer.contentHash !== multiHopProducer.contentHash ||
      oneHopProducer.inputFingerprint !== multiHopProducer.inputFingerprint
    )
      throw new Error(
        `PROJECT_TOPOLOGY_PRODUCER_PAIR_MISMATCH:${input.rootTaskId}`,
      );

    const oneHopRef = artifactRef({
      rootTaskId: input.rootTaskId,
      contract: "OneHopReconciliationResult",
      artifactType: null,
      schemaVersion: oneHop.parsed.schemaVersion,
      contentSha256: oneHop.contentSha256,
      declaredContentHash: null,
      logicalLocator:
        input.oneHopLogicalLocator ??
        `task-artifact:${input.rootTaskId}/one-hop.json`,
    });
    const multiHopRef = artifactRef({
      rootTaskId: input.rootTaskId,
      contract: "MultiHopReconciliationResult",
      artifactType: multiHop.parsed.artifactType,
      schemaVersion: multiHop.parsed.schemaVersion,
      contentSha256: multiHop.contentSha256,
      declaredContentHash: multiHop.parsed.contentHash,
      logicalLocator:
        input.multiHopLogicalLocator ??
        `task-artifact:${input.rootTaskId}/multi-hop.json`,
    });
    const source: ProjectTopologyRootSource = {
      rootTaskId: input.rootTaskId,
      sourceMode: "LEGACY_ARTIFACT_PAIRS",
      oneHop: oneHopRef,
      multiHop: multiHopRef,
      producerIndex: { ...multiHop.parsed.producerIndex },
      coverage: { ...multiHop.parsed.coverage },
      limits: { ...multiHop.parsed.limits },
      sourceIssues: [...multiHop.parsed.issues],
      sourceBoundaries: { ...multiHop.parsed.boundaries },
    };
    return {
      source,
      oneHop: oneHop.parsed,
      multiHop: multiHop.parsed,
    };
  });
  return loaded.sort((left, right) =>
    compareText(left.source.rootTaskId, right.source.rootTaskId),
  );
}

function readArtifactFile<T = unknown>(
  path: string,
  maxBytes: number,
  label: string,
): {
  readonly bytes: Buffer;
  readonly contentSha256: string;
  readonly parsed: T;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(
      `${label}_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (bytes.byteLength > maxBytes) throw new Error(`${label}_SOURCE_LIMIT`);
  let parsed: T;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(`${label}_JSON_INVALID`);
  }
  return { bytes, contentSha256: sha256(bytes), parsed };
}

export function validateOneHopSource(
  value: unknown,
  rootTaskId: string,
): asserts value is OneHopReconciliationResult {
  const artifact = record(value, "ONE_HOP_ARTIFACT");
  if (artifact.schemaVersion !== "1.1.0" || artifact.taskId !== rootTaskId)
    throw new Error(
      `PROJECT_TOPOLOGY_ONE_HOP_ROOT_OR_SCHEMA_INVALID:${rootTaskId}`,
    );
  const currentTask = record(artifact.currentTask, "ONE_HOP_CURRENT_TASK");
  requireString(currentTask.inputPackPath, "ONE_HOP_INPUT_PACK_PATH");
  requireString(currentTask.inputPackContentHash, "ONE_HOP_INPUT_PACK_HASH");
  requireArray(currentTask.directReads, "ONE_HOP_DIRECT_READS");
  const schedule = record(artifact.schedule, "ONE_HOP_SCHEDULE");
  if (schedule.direction !== "UPSTREAM" || schedule.depth !== 1)
    throw new Error("ONE_HOP_SCHEDULE_INVALID");
  requireArray(schedule.parents, "ONE_HOP_SCHEDULE_PARENTS");
  requireArray(schedule.evidence, "ONE_HOP_SCHEDULE_EVIDENCE");
  requireArray(artifact.parents, "ONE_HOP_PARENTS");
  requireArray(artifact.reconciliation, "ONE_HOP_RECONCILIATION");
  record(artifact.counts, "ONE_HOP_COUNTS");
  record(artifact.countSemantics, "ONE_HOP_COUNT_SEMANTICS");
  const producer = record(artifact.producerIndex, "ONE_HOP_PRODUCER_INDEX");
  if (
    !SHA256.test(requireString(producer.contentHash, "ONE_HOP_PRODUCER_HASH"))
  )
    throw new Error("ONE_HOP_PRODUCER_HASH_INVALID");
  if (
    !SHA256.test(
      requireString(producer.inputFingerprint, "ONE_HOP_INPUT_FINGERPRINT"),
    )
  )
    throw new Error("ONE_HOP_INPUT_FINGERPRINT_INVALID");
  record(artifact.dataPath, "ONE_HOP_DATA_PATH");
  record(artifact.coverage, "ONE_HOP_COVERAGE");
  requireArray(artifact.nextScheduleTaskIds, "ONE_HOP_NEXT_SCHEDULE_TASKS");
  requireArray(artifact.nextDataTaskIds, "ONE_HOP_NEXT_DATA_TASKS");
  record(
    artifact.partitionAwareNextDataTaskIds,
    "ONE_HOP_PARTITION_AWARE_TASKS",
  );
  const final = record(artifact.finalUpstreamTaskIds, "ONE_HOP_FINAL_UPSTREAM");
  requireArray(final.primary, "ONE_HOP_FINAL_PRIMARY");
  requireArray(final.additional, "ONE_HOP_FINAL_ADDITIONAL");
  requireArray(final.unknown, "ONE_HOP_FINAL_UNKNOWN");
  if (
    ![
      "SCHEDULE_DATA_INTERSECTION",
      "DATA_FALLBACK",
      "SCHEDULE_FALLBACK",
      "MULTIPLE_OVERLAPPING_PRODUCERS",
    ].includes(String(final.decision))
  )
    throw new Error("ONE_HOP_FINAL_DECISION_INVALID");
  requireArray(artifact.issues, "ONE_HOP_ISSUES");
  requireArray(artifact.issueDetails, "ONE_HOP_ISSUE_DETAILS");
  record(artifact.boundaries, "ONE_HOP_BOUNDARIES");
}

function artifactRef(
  input: Omit<ProjectTopologyArtifactRef, "refId">,
): ProjectTopologyArtifactRef {
  const refId = `artifact-ref:${sha256(canonicalJson(input))}`;
  return { refId, ...input };
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label}_INVALID`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label}_INVALID`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}_INVALID`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label}_INVALID`);
  return value;
}

export const PROJECT_TOPOLOGY_SOURCE_CONTRACT = Object.freeze({
  schemaVersion: PROJECT_TOPOLOGY_SCHEMA_VERSION,
  oneHop: Object.freeze({
    sourceSchemaVersion: "1.1.0",
    topLevelArtifactType: false,
    topLevelContentHash: false,
    contentIdentity: "EXACT_FILE_SHA256",
  }),
  multiHop: Object.freeze({
    sourceSchemaVersion: "1.1.0",
    artifactType: "TABLE_MULTI_HOP_RECONCILIATION",
    declaredContentHash: true,
    contentIdentity: "DECLARED_CANONICAL_HASH_AND_EXACT_FILE_SHA256",
  }),
});
