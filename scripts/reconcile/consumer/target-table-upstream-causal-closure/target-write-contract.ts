import { canonicalJson, sha256 } from "../../../machine-facts/machine-facts-contract.ts";
import type { CurrentBundleLoad } from "../../../query/current-task-bundle.ts";
import {
  resolveCanonicalTargetWriteOccurrence,
  type CanonicalTargetWriteResolution,
} from "../target-write-evidence-resolver.ts";

export interface TargetWriteIdentity {
  readonly targetWriteId: string;
  readonly taskId: string;
  readonly targetTableKey: string;
  readonly sqlSourceId: string;
  readonly statementOrdinal: number;
  /** Zero-based ordinal among this task's canonical WRITE observations. */
  readonly taskWriteOrdinal: number;
  readonly rootRelationId: string;
  readonly writeObservationId: string;
  readonly evidenceRefs: readonly string[];
}

export interface AnalysisSnapshotRef {
  readonly inputPackFingerprint: string;
  readonly machineFactsHash: string;
  readonly producerIndexHash: string;
  readonly tableMultiHopHash: string;
  readonly fieldLineageHash?: string;
  readonly semanticRuleVersion: string;
}

export interface TargetWriteRef {
  readonly identity: TargetWriteIdentity;
  readonly snapshot: AnalysisSnapshotRef;
}

export interface TargetWriteGap {
  readonly gapId: string;
  readonly reasonCode:
    | "TARGET_WRITE_AMBIGUOUS"
    | "TARGET_WRITE_RELATION_UNMAPPED"
    | "TARGET_WRITE_EVIDENCE_MISSING"
    | "TARGET_TABLE_MISMATCH";
  readonly message: string;
  readonly evidenceRefs: readonly string[];
}

export interface ResolveTargetWriteInput {
  readonly taskId: string;
  readonly targetTable: string;
  readonly writeObservationIds: readonly string[];
  readonly load: CurrentBundleLoad;
  readonly snapshot: AnalysisSnapshotRef;
}

export interface TargetWriteResolution {
  readonly ref: TargetWriteRef | null;
  readonly gaps: readonly TargetWriteGap[];
}

function tableKey(value: string): string {
  return value.trim().toLowerCase();
}

function gap(
  taskId: string,
  reasonCode: TargetWriteGap["reasonCode"],
  message: string,
  evidenceRefs: readonly string[] = [],
): TargetWriteGap {
  return {
    gapId: `target-write-gap:${taskId}:${reasonCode}:${sha256(message)}`,
    reasonCode,
    message,
    evidenceRefs: [...new Set(evidenceRefs)].sort((left, right) => left.localeCompare(right)),
  };
}

function gapForCanonicalFailure(
  input: ResolveTargetWriteInput,
  resolution: CanonicalTargetWriteResolution,
): TargetWriteGap {
  const evidenceRefs = resolution.evidenceRefs;
  if (resolution.reasonCode === "OUTPUT_BINDING_MISSING") {
    const ambiguous = resolution.observedWriteObservationIds.length > 1;
    return gap(
      input.taskId,
      ambiguous ? "TARGET_WRITE_AMBIGUOUS" : "TARGET_WRITE_EVIDENCE_MISSING",
      ambiguous
        ? `requested write observation does not uniquely select one of ${resolution.observedWriteObservationIds.length} target writes`
        : `target write observation is not bound to a resolved output-field binding: ${input.writeObservationIds.join(",")}`,
      evidenceRefs,
    );
  }
  if (resolution.reasonCode === "ROOT_RELATION_UNMAPPED") {
    return gap(
      input.taskId,
      "TARGET_WRITE_RELATION_UNMAPPED",
      "target output bindings do not expose one canonical root relation",
      evidenceRefs,
    );
  }
  if (resolution.reasonCode === "WRITE_TARGET_MISMATCH") {
    return gap(
      input.taskId,
      "TARGET_TABLE_MISMATCH",
      `write observation ${input.writeObservationIds.join(",")} does not write ${input.targetTable}`,
      evidenceRefs,
    );
  }
  if (
    resolution.reasonCode === "WRITE_OBSERVATION_AMBIGUOUS" ||
    resolution.reasonCode === "STATEMENT_CHAIN_CONFLICT" ||
    resolution.reasonCode === "WRITE_STATEMENT_RECORD_CONFLICT" ||
    resolution.reasonCode === "QUERY_STATEMENT_RECORD_CONFLICT" ||
    resolution.reasonCode === "STATEMENT_OCCURRENCE_AMBIGUOUS"
  ) {
    return gap(
      input.taskId,
      "TARGET_WRITE_AMBIGUOUS",
      "target write resolves to multiple or contradictory SQL statement identities",
      evidenceRefs,
    );
  }
  const message = resolution.reasonCode === "WRITE_OBSERVATION_MISSING"
    ? `write observation ${input.writeObservationIds.join(",")} is not present in canonical dataset-io evidence`
    : resolution.reasonCode === "WRITE_OBSERVATION_CONFLICT"
    ? `write observation ${input.writeObservationIds.join(",")} has multiple canonical dataset-io records`
    : resolution.reasonCode === "BUNDLE_NOT_CANONICAL"
    ? `canonical Machine Facts bundle is unavailable for task ${input.taskId}`
    : "an explicit canonical write observation is required";
  return gap(
    input.taskId,
    "TARGET_WRITE_EVIDENCE_MISSING",
    message,
    evidenceRefs,
  );
}

/** Resolve a write only from Machine Facts write/output-binding evidence. */
export function resolveTargetWrite(
  input: ResolveTargetWriteInput,
): TargetWriteResolution {
  const targetTable = tableKey(input.targetTable);
  const canonical = resolveCanonicalTargetWriteOccurrence({
    taskId: input.taskId,
    targetTable,
    writeObservationIds: input.writeObservationIds,
    load: input.load,
  });
  if (!canonical.occurrence) {
    return {
      ref: null,
      gaps: [gapForCanonicalFailure(input, canonical)],
    };
  }
  const occurrence = canonical.occurrence;
  const identityInput = {
    taskId: input.taskId,
    targetTableKey: targetTable,
    sqlSourceId: occurrence.sqlSourceId,
    statementOrdinal: occurrence.statementOrdinal,
    taskWriteOrdinal: occurrence.taskWriteOrdinal,
    rootRelationId: occurrence.rootRelationId,
    writeObservationId: occurrence.writeObservationId,
  };
  const identity: TargetWriteIdentity = {
    ...identityInput,
    targetWriteId: `target-write:${sha256(canonicalJson(identityInput))}`,
    evidenceRefs: occurrence.evidenceRefs,
  };
  return { ref: { identity, snapshot: input.snapshot }, gaps: [] };
}
