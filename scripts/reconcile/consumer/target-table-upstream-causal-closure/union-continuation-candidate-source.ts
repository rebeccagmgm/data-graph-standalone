import { readFileSync } from "node:fs";

import { canonicalJson, sha256 } from "../../../machine-facts/machine-facts-contract.ts";
import { taskLocalSchemaVersionAtLeast } from "../../../project-graph/task-local/contract.ts";

export const UNION_CONTINUATION_INDEX_SCHEMA_VERSION = "1.0.0" as const;
export const UNION_CONTINUATION_INDEX_ARTIFACT_TYPE = "UNION_CONTINUATION_INDEX" as const;

export type ContinuationSource = "IN_UNION_FINAL_WRITE" | "PRODUCER_INDEX_ONLY";
export type ContinuationPartitionMatchStatus = "CONFIRMED" | "ASSUMED" | "UNKNOWN" | "DISJOINT";
export type ContinuationEvidenceLayer = "L1" | "L2";
export type ContinuationPartitionPredicateStatus = "NONE" | "LITERAL" | "NON_LITERAL_PRESENT";

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
  readonly source: ContinuationSource;
  readonly outputQualification?: "PLATFORM_TARGET" | "SQL_UNCONSUMED";
  readonly partitionMatchStatus: ContinuationPartitionMatchStatus;
  readonly partition: readonly Readonly<Record<string, unknown>>[];
  readonly evidenceLayer: ContinuationEvidenceLayer;
  readonly l1Eligible: boolean;
  readonly alignmentGapCode?: string;
  readonly reasonCode?: string;
}

export interface UnionContinuationIndexGap {
  readonly gapId: string;
  readonly reasonCode: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface UnionContinuationIndexEntry {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly readOccurrenceNodeId: string;
  readonly datasetNodeId: string;
  readonly qualifiedName: string;
  readonly identityStatus: string;
  readonly partitionPredicateStatus: ContinuationPartitionPredicateStatus;
  readonly candidates: readonly UnionContinuationIndexCandidate[];
  readonly prunedWriteObservationIds: readonly string[];
  readonly gaps: readonly UnionContinuationIndexGap[];
}

export interface UnionContinuationIndexInput {
  readonly batchManifestRef: Readonly<Record<string, unknown>>;
  readonly producerIndex: Readonly<Record<string, unknown>>;
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

export interface UnionContinuationCandidateSource {
  readonly index: UnionContinuationIndex;
  /** Exact lookup; an absent entry returns an empty candidate list. */
  readonly candidatesForRead: (
    consumerTaskId: string,
    readOccurrenceId: string,
  ) => readonly UnionContinuationIndexCandidate[];
  /** Exact lookup used to distinguish an empty entry from an absent entry. */
  readonly entryForRead: (
    consumerTaskId: string,
    readOccurrenceId: string,
  ) => UnionContinuationIndexEntry | undefined;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const PARTITION_MATCH_STATUSES = new Set<ContinuationPartitionMatchStatus>([
  "CONFIRMED",
  "ASSUMED",
  "UNKNOWN",
  "DISJOINT",
]);
const CONTINUATION_SOURCES = new Set<ContinuationSource>([
  "IN_UNION_FINAL_WRITE",
  "PRODUCER_INDEX_ONLY",
]);
const EVIDENCE_LAYERS = new Set<ContinuationEvidenceLayer>(["L1", "L2"]);
const OUTPUT_QUALIFICATIONS = new Set(["PLATFORM_TARGET", "SQL_UNCONSUMED"] as const);
const PARTITION_PREDICATE_STATUSES = new Set<ContinuationPartitionPredicateStatus>([
  "NONE",
  "LITERAL",
  "NON_LITERAL_PRESENT",
]);

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`UNION_CONTINUATION_INDEX_FIELD_INVALID:${path}`);
  }
  return value as JsonRecord;
}

function optionalRecord(value: unknown, path: string): JsonRecord | null {
  if (value === null || value === undefined) return null;
  return record(value, path);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`UNION_CONTINUATION_INDEX_FIELD_INVALID:${path}`);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`UNION_CONTINUATION_INDEX_FIELD_INVALID:${path}`);
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`UNION_CONTINUATION_INDEX_FIELD_INVALID:${path}`);
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  return array(value, path).map((item, index) => text(item, `${path}[${index}]`));
}

function recordArray(value: unknown, path: string): readonly JsonRecord[] {
  return array(value, path).map((item, index) => record(item, `${path}[${index}]`));
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, path: string): T {
  const parsed = text(value, path) as T;
  if (!allowed.has(parsed)) throw new Error(`UNION_CONTINUATION_INDEX_FIELD_INVALID:${path}`);
  return parsed;
}

function indexEntryRef(indexContentHash: string, entry: Pick<UnionContinuationIndexEntry, "consumerTaskId" | "readOccurrenceId">): string {
  return `union-continuation-index:${indexContentHash}:entry:${entry.consumerTaskId}:${entry.readOccurrenceId}`;
}

function parseTaskProjection(value: unknown, path: string): UnionContinuationIndexTaskProjectionRef {
  const source = record(value, path);
  return {
    taskId: text(source.taskId, `${path}.taskId`),
    contentHash: text(source.contentHash, `${path}.contentHash`),
    schemaVersion: text(source.schemaVersion, `${path}.schemaVersion`),
  };
}

function parseGap(value: unknown, path: string): UnionContinuationIndexGap {
  const source = record(value, path);
  return {
    gapId: text(source.gapId, `${path}.gapId`),
    reasonCode: text(source.reasonCode, `${path}.reasonCode`),
    message: text(source.message, `${path}.message`),
    details: optionalRecord(source.details, `${path}.details`) ?? {},
  };
}

function parseCandidate(value: unknown, path: string): UnionContinuationIndexCandidate {
  const source = record(value, path);
  return {
    taskId: text(source.taskId, `${path}.taskId`),
    writeObservationId: text(source.writeObservationId, `${path}.writeObservationId`),
    targetWriteNodeId: nullableText(source.targetWriteNodeId, `${path}.targetWriteNodeId`),
    datasetNodeId: nullableText(source.datasetNodeId, `${path}.datasetNodeId`),
    qualifiedName: text(source.qualifiedName, `${path}.qualifiedName`),
    source: enumValue(source.source, CONTINUATION_SOURCES, `${path}.source`),
    ...(source.outputQualification === undefined ? {} : {
      outputQualification: enumValue(source.outputQualification, OUTPUT_QUALIFICATIONS, `${path}.outputQualification`),
    }),
    partitionMatchStatus: enumValue(source.partitionMatchStatus, PARTITION_MATCH_STATUSES, `${path}.partitionMatchStatus`),
    partition: recordArray(source.partition, `${path}.partition`),
    evidenceLayer: enumValue(source.evidenceLayer, EVIDENCE_LAYERS, `${path}.evidenceLayer`),
    l1Eligible: boolean(source.l1Eligible, `${path}.l1Eligible`),
    ...(source.alignmentGapCode === undefined ? {} : { alignmentGapCode: text(source.alignmentGapCode, `${path}.alignmentGapCode`) }),
    ...(source.reasonCode === undefined ? {} : { reasonCode: text(source.reasonCode, `${path}.reasonCode`) }),
  };
}

function parseEntry(value: unknown, path: string): UnionContinuationIndexEntry {
  const source = record(value, path);
  const candidates = array(source.candidates, `${path}.candidates`).map((item, index) => parseCandidate(item, `${path}.candidates[${index}]`));
  const candidateKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.taskId}\u0000${candidate.writeObservationId}`;
    if (candidateKeys.has(key)) throw new Error(`UNION_CONTINUATION_INDEX_CANDIDATE_DUPLICATE:${key}`);
    candidateKeys.add(key);
  }
  const entry: UnionContinuationIndexEntry = {
    consumerTaskId: text(source.consumerTaskId, `${path}.consumerTaskId`),
    readOccurrenceId: text(source.readOccurrenceId, `${path}.readOccurrenceId`),
    readOccurrenceNodeId: text(source.readOccurrenceNodeId, `${path}.readOccurrenceNodeId`),
    datasetNodeId: text(source.datasetNodeId, `${path}.datasetNodeId`),
    qualifiedName: text(source.qualifiedName, `${path}.qualifiedName`),
    identityStatus: text(source.identityStatus, `${path}.identityStatus`),
    partitionPredicateStatus: enumValue(source.partitionPredicateStatus, PARTITION_PREDICATE_STATUSES, `${path}.partitionPredicateStatus`),
    candidates,
    prunedWriteObservationIds: stringArray(source.prunedWriteObservationIds, `${path}.prunedWriteObservationIds`),
    gaps: array(source.gaps, `${path}.gaps`).map((item, index) => parseGap(item, `${path}.gaps[${index}]`)),
  };
  for (const candidate of entry.candidates) {
    if (
      candidate.outputQualification === "SQL_UNCONSUMED"
      && (candidate.l1Eligible || candidate.evidenceLayer === "L1")
    ) {
      throw new Error(`UNION_CONTINUATION_INDEX_L1_ELIGIBILITY_INVALID:${candidate.writeObservationId}`);
    }
    if (candidate.partitionMatchStatus === "DISJOINT" && !entry.prunedWriteObservationIds.includes(candidate.writeObservationId)) {
      throw new Error(`UNION_CONTINUATION_INDEX_PRUNED_CANDIDATE_MISSING:${candidate.writeObservationId}`);
    }
    if (
      candidate.l1Eligible
      && (candidate.source !== "IN_UNION_FINAL_WRITE" || candidate.partitionMatchStatus !== "CONFIRMED" || entry.identityStatus !== "CONFIRMED")
    ) {
      throw new Error(`UNION_CONTINUATION_INDEX_L1_ELIGIBILITY_INVALID:${candidate.writeObservationId}`);
    }
  }
  return entry;
}

function parseIndex(value: unknown): UnionContinuationIndex {
  const source = record(value, "index");
  const schemaVersion = text(source.schemaVersion, "schemaVersion");
  const artifactType = text(source.artifactType, "artifactType");
  if (schemaVersion !== UNION_CONTINUATION_INDEX_SCHEMA_VERSION || artifactType !== UNION_CONTINUATION_INDEX_ARTIFACT_TYPE) {
    throw new Error("UNION_CONTINUATION_INDEX_CONTRACT_INVALID");
  }
  const inputSource = record(source.input, "input");
  const projectionValues = array(inputSource.taskProjections, "input.taskProjections");
  const taskProjections = projectionValues.map((item, index) => parseTaskProjection(item, `input.taskProjections[${index}]`));
  if (taskProjections.some((projection) => !taskLocalSchemaVersionAtLeast(projection.schemaVersion as "1.1.0" | "1.2.0" | "1.3.0", "1.2.0"))) {
    throw new Error("UNION_CONTINUATION_INDEX_INPUT_SCHEMA_INVALID");
  }
  const taskIds = new Set<string>();
  for (const projection of taskProjections) {
    if (taskIds.has(projection.taskId)) throw new Error(`UNION_CONTINUATION_INDEX_INPUT_TASK_DUPLICATE:${projection.taskId}`);
    taskIds.add(projection.taskId);
  }
  const entries = array(source.entries, "entries").map((item, index) => parseEntry(item, `entries[${index}]`));
  const entryKeys = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.consumerTaskId}\u0000${entry.readOccurrenceId}`;
    if (entryKeys.has(key)) throw new Error(`UNION_CONTINUATION_INDEX_ENTRY_DUPLICATE:${key}`);
    entryKeys.add(key);
  }
  const generatedAt = text(source.generatedAt, "generatedAt");
  const contentHash = text(source.contentHash, "contentHash");
  const input: UnionContinuationIndexInput = {
    batchManifestRef: record(inputSource.batchManifestRef, "input.batchManifestRef"),
    producerIndex: record(inputSource.producerIndex, "input.producerIndex"),
    taskProjections,
  };
  const body = {
    schemaVersion: UNION_CONTINUATION_INDEX_SCHEMA_VERSION,
    artifactType: UNION_CONTINUATION_INDEX_ARTIFACT_TYPE,
    generatedAt,
    input,
    entries,
  };
  const { generatedAt: _generatedAt, ...stableBody } = body;
  const expectedHash = sha256(canonicalJson(stableBody));
  if (expectedHash !== contentHash) throw new Error("UNION_CONTINUATION_INDEX_HASH_MISMATCH");
  return { ...body, contentHash };
}

export function assertUnionContinuationIndex(index: UnionContinuationIndex): void {
  parseIndex(index);
}

export function loadUnionContinuationCandidateSource(path: string): UnionContinuationCandidateSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`UNION_CONTINUATION_INDEX_READ_FAILED:${path}:${error instanceof Error ? error.message : String(error)}`);
  }
  return createUnionContinuationCandidateSource(parsed);
}

export function createUnionContinuationCandidateSource(value: unknown): UnionContinuationCandidateSource {
  const index = parseIndex(value);
  const entries = new Map(index.entries.map((entry) => [
    `${entry.consumerTaskId}\u0000${entry.readOccurrenceId}`,
    entry,
  ]));
  return {
    index,
    candidatesForRead: (consumerTaskId, readOccurrenceId) => entries.get(`${consumerTaskId}\u0000${readOccurrenceId}`)?.candidates ?? [],
    entryForRead: (consumerTaskId, readOccurrenceId) => entries.get(`${consumerTaskId}\u0000${readOccurrenceId}`),
  };
}

export function continuationIndexEntryReference(
  source: UnionContinuationCandidateSource,
  consumerTaskId: string,
  readOccurrenceId: string,
): string {
  return indexEntryRef(source.index.contentHash, { consumerTaskId, readOccurrenceId });
}
