import { canonicalJson, sha256 } from "../contracts/runtime.ts";
import { compareText } from "../contracts/ordering.ts";
import type {
  ProducerPartition,
  TraceUnionContinuationV2Result,
  UnionContinuationCandidate,
  UnionContinuationGap,
} from "./continuation-v2.ts";
import type { ProducerIndexWriter } from "./producer-writer.ts";
import { traceUnionTaskContinuationV2 } from "./continuation-v2.ts";
import {
  isUnionContinuationV2ProjectionSchema,
  parseTaskLocalOutputQualification,
  type TaskLocalUnionBatchManifestRef,
  type TaskLocalUnionProducerIndexRef,
} from "./task-local-projection.ts";
import type {
  LoadedTaskLocalUnionSources,
  TaskLocalUnionMergeResult,
} from "./continuation-input.ts";

export const UNION_CONTINUATION_INDEX_SCHEMA_VERSION = "1.0.0" as const;
export const UNION_CONTINUATION_INDEX_ARTIFACT_TYPE =
  "UNION_CONTINUATION_INDEX" as const;

export interface UnionContinuationIndexTaskProjectionRef {
  readonly taskId: string;
  readonly contentHash: string;
  readonly schemaVersion: string;
}

export interface UnionContinuationIndexCandidate {
  readonly taskId: string;
  readonly writeObservationId: string;
  readonly targetWriteNodeId: string | null;
  readonly datasetNodeId: string | null;
  readonly qualifiedName: string;
  readonly source: UnionContinuationCandidate["writeObservation"]["source"];
  readonly outputQualification?: UnionContinuationCandidate["writeObservation"]["outputQualification"];
  readonly partitionMatchStatus: UnionContinuationCandidate["partitionMatchStatus"];
  readonly partition: readonly ProducerPartition[];
  readonly evidenceLayer: UnionContinuationCandidate["evidenceLayer"];
  readonly l1Eligible: boolean;
  readonly alignmentGapCode?: string;
  readonly reasonCode?: string;
}

export interface UnionContinuationIndexEntry {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly readOccurrenceNodeId: string;
  readonly datasetNodeId: string;
  readonly qualifiedName: string;
  readonly identityStatus: string;
  readonly partitionPredicateStatus: "NONE" | "LITERAL" | "NON_LITERAL_PRESENT";
  readonly candidates: readonly UnionContinuationIndexCandidate[];
  readonly prunedWriteObservationIds: readonly string[];
  readonly gaps: readonly UnionContinuationGap[];
}

export interface UnionContinuationIndexInput {
  readonly batchManifestRef: TaskLocalUnionBatchManifestRef;
  readonly producerIndex: TaskLocalUnionProducerIndexRef;
  readonly taskProjections: readonly UnionContinuationIndexTaskProjectionRef[];
}

export interface UnionContinuationIndex {
  readonly schemaVersion: typeof UNION_CONTINUATION_INDEX_SCHEMA_VERSION;
  readonly artifactType: typeof UNION_CONTINUATION_INDEX_ARTIFACT_TYPE;
  readonly generatedAt: string;
  readonly input: UnionContinuationIndexInput;
  readonly entries: readonly UnionContinuationIndexEntry[];
  readonly contentHash: string;
}

export interface BuildUnionContinuationIndexOptions {
  readonly merge: TaskLocalUnionMergeResult;
  readonly producerIndexWriters: readonly ProducerIndexWriter[];
  readonly generatedAt: string;
  readonly consumerTaskIds?: readonly string[];
}

export function buildUnionContinuationIndex(
  options: BuildUnionContinuationIndexOptions,
): UnionContinuationIndex {
  assertV2IndexInputs(options.merge);
  const projectedTaskIds = options.merge.taskEvidence
    .filter((evidence) => evidence.coverageStatus === "PROJECTED")
    .map((evidence) => evidence.taskId)
    .sort(compareText);
  const consumerTaskIds = selectConsumerTaskIds(
    projectedTaskIds,
    options.consumerTaskIds,
  );
  const entries: UnionContinuationIndexEntry[] = [];

  for (const consumerTaskId of consumerTaskIds) {
    const result = traceUnionTaskContinuationV2({
      merge: options.merge,
      consumerTaskId,
      producerIndexWriters: options.producerIndexWriters,
    });
    entries.push(
      ...result.readOccurrences.map((readResult) =>
        indexEntry(consumerTaskId, readResult),
      ),
    );
  }

  const body: Omit<UnionContinuationIndex, "contentHash"> = {
    schemaVersion: UNION_CONTINUATION_INDEX_SCHEMA_VERSION,
    artifactType: UNION_CONTINUATION_INDEX_ARTIFACT_TYPE,
    generatedAt: options.generatedAt,
    input: {
      batchManifestRef: options.merge.batchManifestRef,
      producerIndex: options.merge.producerIndex,
      taskProjections: options.merge.taskEvidence
        .filter((evidence) => evidence.coverageStatus === "PROJECTED")
        .map((evidence) => ({
          taskId: evidence.taskId,
          contentHash: evidence.contentHash,
          schemaVersion: evidence.projectionSchemaVersion,
        }))
        .sort((left, right) => compareText(left.taskId, right.taskId)),
    },
    entries: entries.sort((left, right) =>
      compareText(
        `${left.consumerTaskId}\u0000${left.readOccurrenceId}`,
        `${right.consumerTaskId}\u0000${right.readOccurrenceId}`,
      ),
    ),
  };
  const index: UnionContinuationIndex = {
    ...body,
    contentHash: unionContinuationIndexContentHash(body),
  };
  assertUnionContinuationIndex(index);
  return index;
}

export function assertV2IndexInputs(merge: TaskLocalUnionMergeResult): void {
  const invalid = merge.taskEvidence
    .filter((evidence) => evidence.coverageStatus === "PROJECTED")
    .filter(
      (evidence) =>
        !isUnionContinuationV2ProjectionSchema(
          evidence.projectionSchemaVersion,
        ),
    )
    .map((evidence) => evidence.taskId)
    .sort(compareText);
  if (invalid.length > 0) {
    throw new Error(
      `UNION_CONTINUATION_INDEX_PROJECTED_SCHEMA_UNSUPPORTED:${invalid.join(",")}`,
    );
  }
}

export function assertV2LoadedInputs(
  loaded: LoadedTaskLocalUnionSources,
): void {
  const invalid = loaded.tasks
    .filter((task) => task.taskSource.coverageStatus === "PROJECTED")
    .filter(
      (task) =>
        !isUnionContinuationV2ProjectionSchema(task.projection.schemaVersion) ||
        !isUnionContinuationV2ProjectionSchema(
          task.envelope.cacheKeyParts.schemaVersion,
        ),
    )
    .map((task) => task.taskSource.taskId)
    .sort(compareText);
  if (invalid.length > 0) {
    throw new Error(
      `UNION_CONTINUATION_INDEX_PROJECTED_SCHEMA_DRIFT:${invalid.join(",")}`,
    );
  }
}

export function unionContinuationIndexContentHash(
  index: Omit<UnionContinuationIndex, "contentHash">,
): string {
  const { generatedAt: _generatedAt, ...stable } = index;
  return sha256(canonicalJson(stable));
}

export function assertUnionContinuationIndex(
  index: UnionContinuationIndex,
): void {
  if (
    index.schemaVersion !== UNION_CONTINUATION_INDEX_SCHEMA_VERSION ||
    index.artifactType !== UNION_CONTINUATION_INDEX_ARTIFACT_TYPE
  ) {
    throw new Error("UNION_CONTINUATION_INDEX_CONTRACT_INVALID");
  }
  assertV2IndexInputRefs(index.input);
  const entryKeys = new Set<string>();
  for (const entry of index.entries) {
    const key = `${entry.consumerTaskId}\u0000${entry.readOccurrenceId}`;
    if (entryKeys.has(key))
      throw new Error(`UNION_CONTINUATION_INDEX_ENTRY_DUPLICATE:${key}`);
    entryKeys.add(key);
    const candidateKeys = new Set<string>();
    for (const candidate of entry.candidates) {
      const candidateKey = `${candidate.taskId}\u0000${candidate.writeObservationId}`;
      if (candidateKeys.has(candidateKey))
        throw new Error(
          `UNION_CONTINUATION_INDEX_CANDIDATE_DUPLICATE:${candidateKey}`,
        );
      candidateKeys.add(candidateKey);
      parseTaskLocalOutputQualification(candidate.outputQualification);
      if (
        candidate.outputQualification === "SQL_UNCONSUMED" &&
        (candidate.l1Eligible || candidate.evidenceLayer === "L1")
      ) {
        throw new Error("UNION_CONTINUATION_INDEX_L1_ELIGIBILITY_INVALID");
      }
      if (
        candidate.source === "PRODUCER_INDEX_ONLY" ||
        candidate.partitionMatchStatus !== "CONFIRMED" ||
        entry.identityStatus !== "CONFIRMED"
      ) {
        if (candidate.l1Eligible)
          throw new Error("UNION_CONTINUATION_INDEX_L1_ELIGIBILITY_INVALID");
      }
      if (
        candidate.partitionMatchStatus === "DISJOINT" &&
        !entry.prunedWriteObservationIds.includes(candidate.writeObservationId)
      ) {
        throw new Error("UNION_CONTINUATION_INDEX_PRUNED_CANDIDATE_MISSING");
      }
    }
  }
  const { contentHash: _contentHash, ...body } = index;
  if (unionContinuationIndexContentHash(body) !== index.contentHash)
    throw new Error("UNION_CONTINUATION_INDEX_HASH_MISMATCH");
}

function assertV2IndexInputRefs(input: UnionContinuationIndexInput): void {
  if (
    input.taskProjections.some(
      (task) => !isUnionContinuationV2ProjectionSchema(task.schemaVersion),
    )
  )
    throw new Error("UNION_CONTINUATION_INDEX_INPUT_SCHEMA_INVALID");
  const taskIds = new Set<string>();
  for (const task of input.taskProjections) {
    if (taskIds.has(task.taskId))
      throw new Error(
        `UNION_CONTINUATION_INDEX_INPUT_TASK_DUPLICATE:${task.taskId}`,
      );
    taskIds.add(task.taskId);
  }
}

function selectConsumerTaskIds(
  projectedTaskIds: readonly string[],
  requestedTaskIds: readonly string[] | undefined,
): readonly string[] {
  if (!requestedTaskIds || requestedTaskIds.length === 0)
    return projectedTaskIds;
  const projected = new Set(projectedTaskIds);
  const selected = [...new Set(requestedTaskIds)].sort(compareText);
  const invalid = selected.filter((taskId) => !projected.has(taskId));
  if (invalid.length > 0)
    throw new Error(
      `UNION_CONTINUATION_INDEX_CONSUMER_NOT_PROJECTED:${invalid.join(",")}`,
    );
  return selected;
}

function indexEntry(
  consumerTaskId: string,
  result: TraceUnionContinuationV2Result,
): UnionContinuationIndexEntry {
  return {
    consumerTaskId,
    readOccurrenceId: result.readOccurrence.readOccurrenceId,
    readOccurrenceNodeId: result.readOccurrence.readOccurrenceNodeId,
    datasetNodeId: result.readOccurrence.datasetNodeId,
    qualifiedName: result.readOccurrence.qualifiedName,
    identityStatus: result.readOccurrence.identityStatus,
    partitionPredicateStatus: result.readOccurrence.partitionPredicateStatus,
    candidates: result.tiers.partition.candidates.map((candidate) =>
      indexCandidate(candidate, result.gaps),
    ),
    prunedWriteObservationIds: result.tiers.partition.prunedWriteObservationIds,
    gaps: result.gaps,
  };
}

function indexCandidate(
  candidate: UnionContinuationCandidate,
  gaps: readonly UnionContinuationGap[],
): UnionContinuationIndexCandidate {
  const write = candidate.writeObservation;
  const relatedCodes = gaps
    .filter((gap) => gapAppliesToCandidate(gap, candidate))
    .map((gap) => gap.reasonCode);
  const alignmentGapCode = relatedCodes.find(
    (code) => code === "WRITE_OBSERVATION_ALIGNMENT_AMBIGUOUS",
  );
  const reasonCode = relatedCodes[0];
  return {
    taskId: write.taskId,
    writeObservationId: write.writeObservationId,
    targetWriteNodeId: write.targetWriteNodeId,
    datasetNodeId: write.datasetNodeId,
    qualifiedName: write.qualifiedName,
    source: write.source,
    ...(write.outputQualification === undefined
      ? {}
      : { outputQualification: write.outputQualification }),
    partitionMatchStatus: candidate.partitionMatchStatus,
    partition: write.partition,
    evidenceLayer: candidate.evidenceLayer,
    l1Eligible: candidate.l1Eligible,
    ...(alignmentGapCode ? { alignmentGapCode } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function gapAppliesToCandidate(
  gap: UnionContinuationGap,
  candidate: UnionContinuationCandidate,
): boolean {
  const details = gap.details;
  const writeObservationId = candidate.writeObservation.writeObservationId;
  if (details.writeObservationId === writeObservationId) return true;
  for (const key of [
    "finalWriteObservationIds",
    "producerIndexWriteObservationIds",
  ]) {
    const values = details[key];
    if (Array.isArray(values) && values.includes(writeObservationId))
      return true;
  }
  return false;
}
