import { canonicalJson, sha256 } from "../../../contracts/runtime.ts";
import {
  isUnionContinuationV2ProjectionSchema,
  type TaskLocalUnionBatchManifestRef,
  type TaskLocalUnionProducerIndexRef,
} from "../../../continuation/task-local-projection.ts";
import { compareText } from "../../../contracts/ordering.ts";
import type {
  TaskLocalUnionMergeResult,
  TaskLocalUnionTaskEvidence,
} from "../../../continuation/continuation-input.ts";
import type {
  TraceUnionContinuationV2Result,
  UnionContinuationCandidate,
  UnionContinuationGap,
} from "../../../continuation/continuation-v2.ts";

export const UNION_CONTINUATION_EVIDENCE_SCHEMA_VERSION = "1.0.0" as const;
export const UNION_CONTINUATION_EVIDENCE_ARTIFACT_TYPE =
  "UNION_CONTINUATION_EVIDENCE" as const;

export interface UnionContinuationEvidenceEnvelope {
  readonly schemaVersion: typeof UNION_CONTINUATION_EVIDENCE_SCHEMA_VERSION;
  readonly artifactType: typeof UNION_CONTINUATION_EVIDENCE_ARTIFACT_TYPE;
  readonly generatedAt: string;
  readonly input: {
    readonly sourceMode: "TASK_LOCAL_UNION";
    readonly consumerTaskId: string;
    readonly readOccurrenceId: string;
    readonly projectionSchemaVersion: "1.2.0" | "1.3.0";
    readonly taskProjections: readonly UnionContinuationTaskProjectionRef[];
    readonly producerIndex: TaskLocalUnionProducerIndexRef;
    readonly batchManifest: TaskLocalUnionBatchManifestRef;
  };
  /** L0: source coverage and candidate counts before reading L1-L3. */
  readonly coverage: {
    readonly evidenceLayer: "L0";
    readonly consumerCoverageStatus: string;
    readonly taskCount: number;
    readonly candidateCounts: {
      readonly table: number;
      readonly partition: number;
      readonly writeObservation: number;
    };
    readonly gapCount: number;
  };
  /** L1: only confirmed, in-union, partition-confirmed writes. */
  readonly l1: UnionContinuationEvidenceLayer;
  /** L2: retained candidates that are not L1; includes ASSUMED/UNKNOWN. */
  readonly l2: UnionContinuationEvidenceLayer;
  /** L3: explicit uncertainty and evidence gaps. */
  readonly l3: {
    readonly evidenceLayer: "L3";
    readonly gaps: readonly UnionContinuationGap[];
  };
  /** The complete v2 three-tier result for deterministic replay. */
  readonly result: TraceUnionContinuationV2Result;
  readonly contentHash: string;
}

export interface UnionContinuationTaskProjectionRef {
  readonly taskId: string;
  readonly contentHash: string;
  readonly packContentHash: string;
  readonly factsManifestSha256: string;
  readonly projectionSchemaVersion: string;
  readonly coverageStatus: string;
}

export interface UnionContinuationEvidenceLayer {
  readonly evidenceLayer: "L1" | "L2";
  readonly candidateWriteObservationIds: readonly string[];
  readonly candidates: readonly UnionContinuationCandidate[];
}

export interface BuildUnionContinuationEvidenceEnvelopeOptions {
  readonly merge: TaskLocalUnionMergeResult;
  readonly result: TraceUnionContinuationV2Result;
  readonly generatedAt: string;
}

export function buildUnionContinuationEvidenceEnvelope(
  options: BuildUnionContinuationEvidenceEnvelopeOptions,
): UnionContinuationEvidenceEnvelope {
  const consumerTaskId = findConsumerTaskId(options.merge, options.result);
  const consumer = options.merge.taskEvidence.find(
    (evidence) => evidence.taskId === consumerTaskId,
  );
  if (
    !consumer ||
    !isUnionContinuationV2ProjectionSchema(consumer.projectionSchemaVersion)
  ) {
    throw new Error(
      `UNION_CONTINUATION_ENVELOPE_CONSUMER_UNSUPPORTED:${consumerTaskId}`,
    );
  }

  const writeCandidates = options.result.tiers.writeObservation.candidates;
  const l1Candidates = writeCandidates.filter(
    (candidate) => candidate.l1Eligible,
  );
  const l2Candidates = writeCandidates.filter(
    (candidate) => !candidate.l1Eligible,
  );
  const body: Omit<UnionContinuationEvidenceEnvelope, "contentHash"> = {
    schemaVersion: UNION_CONTINUATION_EVIDENCE_SCHEMA_VERSION,
    artifactType: UNION_CONTINUATION_EVIDENCE_ARTIFACT_TYPE,
    generatedAt: options.generatedAt,
    input: {
      sourceMode: "TASK_LOCAL_UNION",
      consumerTaskId,
      readOccurrenceId: options.result.readOccurrence.readOccurrenceId,
      projectionSchemaVersion:
        consumer.projectionSchemaVersion === "1.3.0" ? "1.3.0" : "1.2.0",
      taskProjections: options.merge.taskEvidence
        .map(taskProjectionRef)
        .sort((left, right) => compareText(left.taskId, right.taskId)),
      producerIndex: options.merge.producerIndex,
      batchManifest: options.merge.batchManifestRef,
    },
    coverage: {
      evidenceLayer: "L0",
      consumerCoverageStatus: consumer.coverageStatus,
      taskCount: options.merge.taskEvidence.length,
      candidateCounts: {
        table: options.result.tiers.table.candidates.length,
        partition: options.result.tiers.partition.candidates.length,
        writeObservation: writeCandidates.length,
      },
      gapCount: options.result.gaps.length,
    },
    l1: evidenceLayer("L1", l1Candidates),
    l2: evidenceLayer("L2", l2Candidates),
    l3: {
      evidenceLayer: "L3",
      gaps: options.result.gaps,
    },
    result: options.result,
  };
  return {
    ...body,
    contentHash: unionContinuationEvidenceContentHash(body),
  };
}

export function unionContinuationEvidenceContentHash(
  envelope: Omit<UnionContinuationEvidenceEnvelope, "contentHash">,
): string {
  const { generatedAt: _generatedAt, ...stable } = envelope;
  return sha256(canonicalJson(stable));
}

export function assertUnionContinuationEvidenceEnvelope(
  envelope: UnionContinuationEvidenceEnvelope,
): void {
  if (
    envelope.schemaVersion !== UNION_CONTINUATION_EVIDENCE_SCHEMA_VERSION ||
    envelope.artifactType !== UNION_CONTINUATION_EVIDENCE_ARTIFACT_TYPE
  ) {
    throw new Error("UNION_CONTINUATION_EVIDENCE_CONTRACT_INVALID");
  }
  const { contentHash: _contentHash, ...body } = envelope;
  if (unionContinuationEvidenceContentHash(body) !== envelope.contentHash) {
    throw new Error("UNION_CONTINUATION_EVIDENCE_HASH_MISMATCH");
  }
}

function evidenceLayer(
  layer: "L1" | "L2",
  candidates: readonly UnionContinuationCandidate[],
): UnionContinuationEvidenceLayer {
  return {
    evidenceLayer: layer,
    candidateWriteObservationIds: candidates.map(
      (candidate) => candidate.writeObservation.writeObservationId,
    ),
    candidates,
  };
}

function taskProjectionRef(
  evidence: TaskLocalUnionTaskEvidence,
): UnionContinuationTaskProjectionRef {
  return {
    taskId: evidence.taskId,
    contentHash: evidence.contentHash,
    packContentHash: evidence.packContentHash,
    factsManifestSha256: evidence.factsManifestSha256,
    projectionSchemaVersion: evidence.projectionSchemaVersion,
    coverageStatus: evidence.coverageStatus,
  };
}

function findConsumerTaskId(
  merge: TaskLocalUnionMergeResult,
  result: TraceUnionContinuationV2Result,
): string {
  const owner = merge.taskEvidence.find((evidence) =>
    evidence.localClosure?.externalReads.some(
      (read) =>
        read.readOccurrenceId === result.readOccurrence.readOccurrenceId,
    ),
  );
  if (!owner) {
    throw new Error(
      `UNION_CONTINUATION_ENVELOPE_READ_OWNER_NOT_FOUND:${result.readOccurrence.readOccurrenceId}`,
    );
  }
  return owner.taskId;
}
