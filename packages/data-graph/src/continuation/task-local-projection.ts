/** WP-3/WP-7 projection schema versions accepted by the TASK_LOCAL_UNION loader. */
export const TASK_LOCAL_UNION_SUPPORTED_PROJECTION_SCHEMAS = [
  "1.1.0",
  "1.2.0",
  "1.3.0",
] as const;

/** Read-occurrence projections that WP-8 continuation can index. 1.3.0 is a field-evidence superset of 1.2.0. */
export const UNION_CONTINUATION_V2_PROJECTION_SCHEMAS = [
  "1.2.0",
  "1.3.0",
] as const;

export type TaskLocalUnionSupportedProjectionSchema =
  (typeof TASK_LOCAL_UNION_SUPPORTED_PROJECTION_SCHEMAS)[number];

export type TaskLocalUnionCoverageStatus =
  "PROJECTED" | "SCHEDULE_ONLY" | "COLLECTION_FAILED";

export interface TaskLocalUnionTaskSource {
  readonly taskId: string;
  readonly contentHash: string;
  readonly packContentHash: string;
  readonly factsManifestSha256: string;
  readonly coverageStatus: TaskLocalUnionCoverageStatus;
  readonly failureReasonCode: string | null;
}

export interface TaskLocalUnionProducerIndexRef {
  readonly contentHash: string;
  readonly inputFingerprint: string;
}

export interface TaskLocalUnionBatchManifestRef {
  readonly path: string;
  readonly contentHash: string;
}

export interface TaskLocalProjectionEnvelopeCacheKeyParts {
  readonly taskId: string;
  readonly packContentHash: string;
  readonly factsManifestSha256: string;
  readonly schemaVersion: string;
}

export interface TaskLocalProjectionBody {
  readonly schemaVersion: string;
  readonly artifactType: "TASK_LOCAL_PROJECTION";
  readonly generatedAt?: string;
  readonly taskId: string;
  readonly coverageStatus: TaskLocalUnionCoverageStatus;
  readonly failureReasonCode: string | null;
  readonly contentHash: string;
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
  /** WP-7 task-local summaries consumed by union-continuation-v2. */
  readonly localClosure?: TaskLocalProjectionClosure;
}

export interface TaskLocalProjectionClosure {
  readonly finalWrites: readonly TaskLocalFinalWrite[];
  readonly externalReads: readonly TaskLocalExternalRead[];
  readonly localFieldPaths?: readonly unknown[];
}

export interface TaskLocalFinalWrite {
  readonly writeObservationId: string;
  readonly targetWriteNodeId: string;
  readonly datasetNodeId: string;
  readonly qualifiedName: string;
  readonly outputQualification?: "PLATFORM_TARGET" | "SQL_UNCONSUMED";
}

export interface TaskLocalExternalRead {
  readonly readOccurrenceId: string;
  readonly readOccurrenceNodeId: string;
  readonly datasetNodeId: string;
  readonly qualifiedName: string;
  readonly identityStatus: string;
}

export interface TaskLocalProjectionEnvelope {
  readonly cacheKey: string;
  readonly cacheKeyParts: TaskLocalProjectionEnvelopeCacheKeyParts;
  readonly projectionContentHash: string;
  readonly projection: TaskLocalProjectionBody;
}

export interface UnpackedTaskLocalProjection {
  readonly envelope: TaskLocalProjectionEnvelope;
  readonly projection: TaskLocalProjectionBody;
  readonly taskSource: TaskLocalUnionTaskSource;
}

const SHA256 = /^[a-f0-9]{64}$/i;
const COVERAGE = new Set<TaskLocalUnionCoverageStatus>([
  "PROJECTED",
  "SCHEDULE_ONLY",
  "COLLECTION_FAILED",
]);

export function isSupportedTaskLocalProjectionSchema(
  schemaVersion: string,
): schemaVersion is TaskLocalUnionSupportedProjectionSchema {
  return (
    TASK_LOCAL_UNION_SUPPORTED_PROJECTION_SCHEMAS as readonly string[]
  ).includes(schemaVersion);
}

export function isUnionContinuationV2ProjectionSchema(
  schemaVersion: string,
): boolean {
  return (
    UNION_CONTINUATION_V2_PROJECTION_SCHEMAS as readonly string[]
  ).includes(schemaVersion);
}

/**
 * Unpack a WP-3 disk envelope and enforce triple contentHash agreement:
 * projectionContentHash === projection.contentHash === manifest.tasks[].contentHash
 */
export function unpackTaskLocalProjectionEnvelope(input: {
  readonly envelope: unknown;
  readonly manifestTaskContentHash: string;
}): UnpackedTaskLocalProjection {
  const envelope = parseEnvelope(input.envelope);
  const { projection } = envelope;

  if (!isSupportedTaskLocalProjectionSchema(projection.schemaVersion)) {
    throw new Error(
      `TASK_LOCAL_PROJECTION_SCHEMA_UNSUPPORTED:${projection.schemaVersion}`,
    );
  }
  if (projection.artifactType !== "TASK_LOCAL_PROJECTION") {
    throw new Error("TASK_LOCAL_PROJECTION_ARTIFACT_TYPE_INVALID");
  }
  if (
    !SHA256.test(envelope.projectionContentHash) ||
    !SHA256.test(projection.contentHash) ||
    !SHA256.test(input.manifestTaskContentHash)
  ) {
    throw new Error("TASK_LOCAL_ENVELOPE_HASH_FORMAT_INVALID");
  }
  if (
    envelope.projectionContentHash !== projection.contentHash ||
    envelope.projectionContentHash !== input.manifestTaskContentHash
  ) {
    throw new Error("TASK_LOCAL_ENVELOPE_HASH_MISMATCH");
  }
  if (envelope.cacheKeyParts.taskId !== projection.taskId) {
    throw new Error("TASK_LOCAL_ENVELOPE_TASK_ID_MISMATCH");
  }
  if (!COVERAGE.has(projection.coverageStatus)) {
    throw new Error("TASK_LOCAL_PROJECTION_COVERAGE_INVALID");
  }

  const taskSource: TaskLocalUnionTaskSource = {
    taskId: projection.taskId,
    contentHash: projection.contentHash,
    packContentHash: envelope.cacheKeyParts.packContentHash,
    factsManifestSha256: envelope.cacheKeyParts.factsManifestSha256,
    coverageStatus: projection.coverageStatus,
    failureReasonCode: projection.failureReasonCode,
  };

  return { envelope, projection, taskSource };
}

function parseEnvelope(value: unknown): TaskLocalProjectionEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TASK_LOCAL_ENVELOPE_INVALID");
  }
  const record = value as Record<string, unknown>;
  const cacheKey = text(record.cacheKey);
  const projectionContentHash = text(record.projectionContentHash);
  const cacheKeyPartsRaw = record.cacheKeyParts;
  const projectionRaw = record.projection;
  if (
    !cacheKey ||
    !projectionContentHash ||
    typeof cacheKeyPartsRaw !== "object" ||
    cacheKeyPartsRaw === null ||
    Array.isArray(cacheKeyPartsRaw) ||
    typeof projectionRaw !== "object" ||
    projectionRaw === null ||
    Array.isArray(projectionRaw)
  ) {
    throw new Error("TASK_LOCAL_ENVELOPE_INVALID");
  }
  const parts = cacheKeyPartsRaw as Record<string, unknown>;
  const projection = projectionRaw as Record<string, unknown>;
  const taskId = text(parts.taskId);
  const packContentHash = text(parts.packContentHash);
  const factsManifestSha256 = text(parts.factsManifestSha256);
  const partsSchema = text(parts.schemaVersion);
  const schemaVersion = text(projection.schemaVersion);
  const artifactType = text(projection.artifactType);
  const projectionTaskId = text(projection.taskId);
  const coverageStatus = text(projection.coverageStatus);
  const contentHash = text(projection.contentHash);
  if (
    !taskId ||
    !packContentHash ||
    !factsManifestSha256 ||
    !partsSchema ||
    !schemaVersion ||
    artifactType !== "TASK_LOCAL_PROJECTION" ||
    !projectionTaskId ||
    !coverageStatus ||
    !contentHash ||
    !Array.isArray(projection.nodes) ||
    !Array.isArray(projection.edges)
  ) {
    throw new Error("TASK_LOCAL_ENVELOPE_INVALID");
  }
  const failureReasonCode =
    projection.failureReasonCode === null ||
    projection.failureReasonCode === undefined
      ? null
      : text(projection.failureReasonCode);

  const localClosure = parseLocalClosure(projection.localClosure);
  return {
    cacheKey,
    cacheKeyParts: {
      taskId,
      packContentHash,
      factsManifestSha256,
      schemaVersion: partsSchema,
    },
    projectionContentHash,
    projection: {
      schemaVersion,
      artifactType: "TASK_LOCAL_PROJECTION",
      ...(typeof projection.generatedAt === "string"
        ? { generatedAt: projection.generatedAt }
        : {}),
      taskId: projectionTaskId,
      coverageStatus: coverageStatus as TaskLocalUnionCoverageStatus,
      failureReasonCode,
      contentHash,
      nodes: projection.nodes,
      edges: projection.edges,
      ...(localClosure ? { localClosure } : {}),
    },
  };
}

function parseLocalClosure(
  value: unknown,
): TaskLocalProjectionClosure | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TASK_LOCAL_PROJECTION_LOCAL_CLOSURE_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.finalWrites) ||
    !Array.isArray(record.externalReads)
  ) {
    throw new Error("TASK_LOCAL_PROJECTION_LOCAL_CLOSURE_INVALID");
  }
  const finalWrites = record.finalWrites.map((item) => {
    const write = objectRecord(item);
    const outputQualification = parseTaskLocalOutputQualification(
      write.outputQualification,
    );
    return {
      writeObservationId: requiredText(write.writeObservationId),
      targetWriteNodeId: requiredText(write.targetWriteNodeId),
      datasetNodeId: requiredText(write.datasetNodeId),
      qualifiedName: requiredText(write.qualifiedName),
      ...(outputQualification === undefined ? {} : { outputQualification }),
    } satisfies TaskLocalFinalWrite;
  });
  const externalReads = record.externalReads.map((item) => {
    const read = objectRecord(item);
    return {
      readOccurrenceId: requiredText(read.readOccurrenceId),
      readOccurrenceNodeId: requiredText(read.readOccurrenceNodeId),
      datasetNodeId: requiredText(read.datasetNodeId),
      qualifiedName: requiredText(read.qualifiedName),
      identityStatus: requiredText(read.identityStatus),
    } satisfies TaskLocalExternalRead;
  });
  if (
    record.localFieldPaths !== undefined &&
    !Array.isArray(record.localFieldPaths)
  ) {
    throw new Error("TASK_LOCAL_PROJECTION_LOCAL_CLOSURE_INVALID");
  }
  return {
    finalWrites,
    externalReads,
    ...(record.localFieldPaths !== undefined
      ? { localFieldPaths: record.localFieldPaths }
      : {}),
  };
}

/** Missing qualification is a legacy projection; explicit invalid values fail closed. */
export function parseTaskLocalOutputQualification(
  value: unknown,
): TaskLocalFinalWrite["outputQualification"] {
  if (
    value === undefined ||
    value === "PLATFORM_TARGET" ||
    value === "SQL_UNCONSUMED"
  )
    return value;
  throw new Error("TASK_LOCAL_PROJECTION_OUTPUT_QUALIFICATION_INVALID");
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TASK_LOCAL_PROJECTION_LOCAL_CLOSURE_INVALID");
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  const result = text(value);
  if (!result) throw new Error("TASK_LOCAL_PROJECTION_LOCAL_CLOSURE_INVALID");
  return result;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
