import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  canonicalJson,
  sha256,
} from "../../../machine-facts/machine-facts-contract.ts";
import type {
  CandidateBranch,
  CandidatePhysicalTable,
  CandidateReadOccurrence,
  CandidateWriteScope,
} from "../target-field-causal-slice/candidate-universe.ts";
import {
  loadUnionContinuationCandidateSource,
  type UnionContinuationCandidateSource,
} from "./union-continuation-candidate-source.ts";
import type {
  TargetTableCausalClosureArtifact,
} from "./artifact-contract.ts";

export const GATE_B_UNION_L1_SET_SCHEMA_VERSION = "1.0.0" as const;
export const GATE_B_UNION_L1_SET_ARTIFACT_TYPE =
  "TARGET_TABLE_CAUSAL_CLOSURE_L1_SET" as const;

export interface GateBUnionReadOccurrenceChain {
  readonly occurrenceId: string;
  readonly readRelationId: string;
  readonly statementIndex: number;
  readonly sqlSourceId?: string | null;
  readonly rootRelationId?: string | null;
  readonly relationPath: readonly string[];
}

export interface GateBUnionL1Member {
  /** The exact task pair is explicit; producerTaskId is the task that wrote the observed output. */
  readonly consumerTaskId: string;
  readonly producerTaskId: string;
  readonly writeObservationId: string;
  readonly readOccurrenceChain: GateBUnionReadOccurrenceChain;
  readonly candidateBranchId: string;
  readonly table: CandidatePhysicalTable;
  readonly targetWriteNodeId: string | null;
  readonly datasetNodeId: string | null;
  readonly continuation: {
    readonly source: "IN_UNION_FINAL_WRITE";
    readonly partitionMatchStatus: "CONFIRMED";
    readonly evidenceLayer: "L1";
    readonly l1Eligible: true;
    readonly indexEntryRef: string;
  };
  readonly writeScope: CandidateWriteScope;
  readonly evidenceRefs: readonly string[];
}

export interface GateBUnionL1Set {
  readonly schemaVersion: typeof GATE_B_UNION_L1_SET_SCHEMA_VERSION;
  readonly artifactType: typeof GATE_B_UNION_L1_SET_ARTIFACT_TYPE;
  readonly generatedAt: string;
  readonly gate: "B-UNION";
  readonly sourceMode: "union-v2";
  readonly qualification: "L1";
  readonly targetWrite: {
    readonly taskId: string;
    readonly targetWriteId: string;
    readonly writeObservationId: string;
    readonly targetTableKey: string;
  };
  readonly input: {
    readonly closureArtifact: {
      readonly path: string;
      readonly contentHash: string;
      readonly schemaVersion: string;
      readonly artifactType: string;
    };
    readonly continuationIndex: {
      readonly path: string;
      readonly contentHash: string;
      readonly schemaVersion: string;
      readonly artifactType: string;
    };
  };
  readonly sourceMetrics: {
    readonly indexedPhysicalProducerCount: number;
    readonly l1EligibleCandidateCount: number;
  };
  readonly members: readonly GateBUnionL1Member[];
  readonly contentHash: string;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GATE_B_UNION_CLOSURE_INVALID:${label}`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`GATE_B_UNION_CLOSURE_INVALID:${label}`);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`GATE_B_UNION_CLOSURE_INVALID:${label}`);
  }
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`GATE_B_UNION_CLOSURE_INVALID:${label}`);
  }
  return value;
}

function readClosureArtifact(path: string): TargetTableCausalClosureArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `GATE_B_UNION_CLOSURE_READ_FAILED:${path}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const source = asRecord(parsed, "artifact");
  if (
    source.schemaVersion !== "1.2.0" ||
    source.artifactType !== "TARGET_TABLE_UPSTREAM_CAUSAL_CLOSURE"
  ) {
    throw new Error("GATE_B_UNION_CLOSURE_CONTRACT_INVALID");
  }
  const contentHash = text(source.contentHash, "contentHash");
  const { contentHash: _contentHash, ...stable } = source;
  if (sha256(canonicalJson(stable)) !== contentHash) {
    throw new Error("GATE_B_UNION_CLOSURE_HASH_MISMATCH");
  }
  const metrics = asRecord(source.metrics, "metrics");
  const continuationStats = asRecord(
    metrics.continuationStats,
    "metrics.continuationStats",
  );
  for (const field of [
    "l1",
    "l2Assumed",
    "l2Unknown",
    "piOnly",
    "disjointPruned",
    "ambiguousReads",
    "unmatchedReads",
  ]) {
    numberValue(continuationStats[field], `metrics.continuationStats.${field}`);
  }
  const targetWrite = asRecord(source.targetWrite, "targetWrite");
  const targetIdentity = asRecord(targetWrite.identity, "targetWrite.identity");
  const targetTaskId = text(targetIdentity.taskId, "targetWrite.identity.taskId");
  const candidateUniverse = asRecord(source.candidateUniverse, "candidateUniverse");
  if (text(candidateUniverse.rootTaskId, "candidateUniverse.rootTaskId") !== targetTaskId) {
    throw new Error("GATE_B_UNION_CLOSURE_ROOT_TASK_MISMATCH");
  }
  array(candidateUniverse.branches, "candidateUniverse.branches");
  return parsed as TargetTableCausalClosureArtifact;
}

function readOccurrenceChain(
  value: CandidateReadOccurrence | null,
  branchId: string,
): GateBUnionReadOccurrenceChain {
  if (!value) throw new Error(`GATE_B_UNION_L1_BRANCH_INVALID:${branchId}:readOccurrence`);
  return {
    occurrenceId: value.occurrenceId,
    readRelationId: value.readRelationId,
    statementIndex: value.statementIndex,
    ...(value.sqlSourceId === undefined ? {} : { sqlSourceId: value.sqlSourceId }),
    ...(value.rootRelationId === undefined ? {} : { rootRelationId: value.rootRelationId }),
    relationPath: [...value.relationPath],
  };
}

function l1Candidate(
  branch: CandidateBranch,
  source: UnionContinuationCandidateSource,
): {
  readonly branch: CandidateBranch;
  readonly indexTargetWriteNodeId: string | null;
  readonly indexDatasetNodeId: string | null;
} | null {
  const continuation = branch.continuation;
  if (
    branch.branchKind !== "PHYSICAL_PRODUCER" ||
    !branch.consumerTaskId ||
    !branch.producerTaskId ||
    !branch.writeObservationId ||
    !branch.writeScope ||
    !branch.table ||
    !continuation ||
    continuation.source !== "IN_UNION_FINAL_WRITE" ||
    continuation.partitionMatchStatus !== "CONFIRMED" ||
    continuation.evidenceLayer !== "L1" ||
    continuation.l1Eligible !== true
  ) {
    return null;
  }
  const occurrence = readOccurrenceChain(branch.readOccurrence, branch.candidateBranchId);
  const expectedEntryRef = `union-continuation-index:${source.index.contentHash}:entry:${branch.consumerTaskId}:${occurrence.occurrenceId}`;
  if (continuation.indexEntryRef !== expectedEntryRef) {
    throw new Error(
      `GATE_B_UNION_INDEX_ENTRY_REF_MISMATCH:${branch.candidateBranchId}`,
    );
  }
  const entry = source.entryForRead(
    branch.consumerTaskId,
    occurrence.occurrenceId,
  );
  if (!entry) {
    throw new Error(`GATE_B_UNION_INDEX_ENTRY_MISSING:${branch.candidateBranchId}`);
  }
  const candidates = entry.candidates.filter(
    (candidate) =>
      candidate.taskId === branch.producerTaskId &&
      candidate.writeObservationId === branch.writeObservationId,
  );
  if (candidates.length !== 1) {
    throw new Error(
      `GATE_B_UNION_INDEX_CANDIDATE_MISMATCH:${branch.candidateBranchId}`,
    );
  }
  const candidate = candidates[0]!;
  if (
    candidate.source !== continuation.source ||
    candidate.partitionMatchStatus !== continuation.partitionMatchStatus ||
    candidate.evidenceLayer !== continuation.evidenceLayer ||
    candidate.l1Eligible !== continuation.l1Eligible
  ) {
    throw new Error(
      `GATE_B_UNION_INDEX_L1_STATUS_MISMATCH:${branch.candidateBranchId}`,
    );
  }
  if (branch.table.qualifiedName !== candidate.qualifiedName) {
    throw new Error(
      `GATE_B_UNION_INDEX_TABLE_MISMATCH:${branch.candidateBranchId}`,
    );
  }
  const hasIndexEvidence = branch.evidenceRefs.some(
    (ref) => ref.source === "UNION_CONTINUATION_INDEX",
  );
  const hasWriteEvidence = branch.evidenceRefs.some(
    (ref) => ref.source === "MACHINE_FACTS_DATASET_IO",
  );
  if (!hasIndexEvidence || !hasWriteEvidence) {
    throw new Error(
      `GATE_B_UNION_L1_EVIDENCE_INCOMPLETE:${branch.candidateBranchId}`,
    );
  }
  return {
    branch,
    indexTargetWriteNodeId: candidate.targetWriteNodeId,
    indexDatasetNodeId: candidate.datasetNodeId,
  };
}

function memberFor(
  branch: CandidateBranch,
  targetWriteNodeId: string | null,
  datasetNodeId: string | null,
): GateBUnionL1Member {
  const continuation = branch.continuation!;
  return {
    consumerTaskId: branch.consumerTaskId!,
    producerTaskId: branch.producerTaskId!,
    writeObservationId: branch.writeObservationId!,
    readOccurrenceChain: readOccurrenceChain(
      branch.readOccurrence,
      branch.candidateBranchId,
    ),
    candidateBranchId: branch.candidateBranchId,
    table: branch.table!,
    targetWriteNodeId,
    datasetNodeId,
    continuation: {
      source: "IN_UNION_FINAL_WRITE",
      partitionMatchStatus: "CONFIRMED",
      evidenceLayer: "L1",
      l1Eligible: true,
      indexEntryRef: continuation.indexEntryRef,
    },
    writeScope: branch.writeScope!,
    evidenceRefs: branch.evidenceRefs
      .map((ref) => ref.evidenceRefId)
      .sort((left, right) => left.localeCompare(right)),
  };
}

function memberKey(member: Pick<GateBUnionL1Member, "consumerTaskId" | "producerTaskId" | "writeObservationId" | "readOccurrenceChain">): string {
  return [
    member.consumerTaskId,
    member.producerTaskId,
    member.writeObservationId,
    member.readOccurrenceChain.occurrenceId,
  ].join("\u0000");
}

function stableSetBody(input: Omit<GateBUnionL1Set, "contentHash" | "generatedAt">): Omit<GateBUnionL1Set, "contentHash" | "generatedAt"> {
  return {
    ...input,
    members: [...input.members].sort(
      (left, right) => memberKey(left).localeCompare(memberKey(right)),
    ),
  };
}

export function assertGateBUnionL1Set(value: GateBUnionL1Set): void {
  if (
    value.schemaVersion !== GATE_B_UNION_L1_SET_SCHEMA_VERSION ||
    value.artifactType !== GATE_B_UNION_L1_SET_ARTIFACT_TYPE ||
    value.gate !== "B-UNION" ||
    value.sourceMode !== "union-v2" ||
    value.qualification !== "L1"
  ) {
    throw new Error("GATE_B_UNION_L1_SET_CONTRACT_INVALID");
  }
  const keys = new Set<string>();
  for (const member of value.members) {
    const key = memberKey(member);
    if (keys.has(key)) throw new Error(`GATE_B_UNION_L1_SET_DUPLICATE:${key}`);
    keys.add(key);
    if (
      member.continuation.source !== "IN_UNION_FINAL_WRITE" ||
      member.continuation.partitionMatchStatus !== "CONFIRMED" ||
      member.continuation.evidenceLayer !== "L1" ||
      member.continuation.l1Eligible !== true
    ) {
      throw new Error(`GATE_B_UNION_L1_SET_CONTAMINATED:${key}`);
    }
  }
  const { contentHash: _contentHash, generatedAt: _generatedAt, ...stable } = value;
  if (sha256(canonicalJson(stable)) !== value.contentHash) {
    throw new Error("GATE_B_UNION_L1_SET_HASH_MISMATCH");
  }
}

export function createGateBUnionL1Set(input: {
  readonly closureArtifactPath: string;
  readonly continuationIndexPath: string;
}): GateBUnionL1Set {
  const closureArtifactPath = resolve(input.closureArtifactPath);
  const continuationIndexPath = resolve(input.continuationIndexPath);
  const closure = readClosureArtifact(closureArtifactPath);
  const source = loadUnionContinuationCandidateSource(continuationIndexPath);
  const branches = closure.candidateUniverse.branches;
  const l1Members = branches.flatMap((branch) => {
    const selected = l1Candidate(branch, source);
    return selected
      ? [
          memberFor(
            selected.branch,
            selected.indexTargetWriteNodeId,
            selected.indexDatasetNodeId,
          ),
        ]
      : [];
  });
  const keys = new Set<string>();
  for (const member of l1Members) {
    const key = memberKey(member);
    if (keys.has(key)) throw new Error(`GATE_B_UNION_L1_SET_DUPLICATE:${key}`);
    keys.add(key);
  }
  const continuationStats = closure.metrics.continuationStats!;
  if (continuationStats.l1 !== l1Members.length) {
    throw new Error(
      `GATE_B_UNION_L1_COUNT_MISMATCH:${continuationStats.l1}:${l1Members.length}`,
    );
  }
  const indexedPhysicalProducerCount = branches.filter(
    (branch) => branch.branchKind === "PHYSICAL_PRODUCER" && branch.continuation,
  ).length;
  const body = stableSetBody({
    schemaVersion: GATE_B_UNION_L1_SET_SCHEMA_VERSION,
    artifactType: GATE_B_UNION_L1_SET_ARTIFACT_TYPE,
    gate: "B-UNION",
    sourceMode: "union-v2",
    qualification: "L1",
    targetWrite: {
      taskId: closure.targetWrite.identity.taskId,
      targetWriteId: closure.targetWrite.identity.targetWriteId,
      writeObservationId: closure.targetWrite.identity.writeObservationId,
      targetTableKey: closure.targetWrite.identity.targetTableKey,
    },
    input: {
      closureArtifact: {
        path: closureArtifactPath,
        contentHash: closure.contentHash,
        schemaVersion: closure.schemaVersion,
        artifactType: closure.artifactType,
      },
      continuationIndex: {
        path: continuationIndexPath,
        contentHash: source.index.contentHash,
        schemaVersion: source.index.schemaVersion,
        artifactType: source.index.artifactType,
      },
    },
    sourceMetrics: {
      indexedPhysicalProducerCount: indexedPhysicalProducerCount,
      l1EligibleCandidateCount: continuationStats.l1,
    },
    members: l1Members,
  });
  const result: GateBUnionL1Set = {
    ...body,
    generatedAt: new Date().toISOString(),
    contentHash: sha256(canonicalJson(body)),
  };
  assertGateBUnionL1Set(result);
  return result;
}
