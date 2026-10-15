import { readFileSync } from "node:fs";

import {
  parseTaskLocalOutputQualification,
  type TaskLocalUnionProducerIndexRef,
} from "../../../continuation/task-local-projection.ts";
import type { ProducerIndexWriter } from "../../../continuation/producer-writer.ts";

export type { ProducerIndexWriter } from "../../../continuation/producer-writer.ts";

const SHA256 = /^[a-f0-9]{64}$/i;

export interface LoadedProducerIndex {
  readonly identity: TaskLocalUnionProducerIndexRef;
  readonly writers: readonly ProducerIndexWriter[];
}

/**
 * Load TABLE_PRODUCER_INDEX identity + confirmed writer observations for §5.2/§5.4.
 */
export function loadProducerIndex(path: string): LoadedProducerIndex {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  const contentHash = text(parsed.contentHash);
  const inputFingerprint = text(parsed.inputFingerprint);
  if (!contentHash || !SHA256.test(contentHash) || !inputFingerprint) {
    throw new Error("TASK_LOCAL_UNION_PRODUCER_INDEX_INVALID");
  }
  const edges = Array.isArray(parsed.confirmedProducerEdges)
    ? parsed.confirmedProducerEdges
    : [];
  const writers: ProducerIndexWriter[] = [];
  for (const edge of edges) {
    if (typeof edge !== "object" || edge === null || Array.isArray(edge))
      continue;
    const record = edge as Record<string, unknown>;
    const taskId = text(record.taskId);
    if (!taskId) continue;
    const table =
      typeof record.table === "object" &&
      record.table !== null &&
      !Array.isArray(record.table)
        ? (record.table as Record<string, unknown>)
        : null;
    const qualifiedName = table ? text(table.qualifiedName) : null;
    const edgeQualification = parseTaskLocalOutputQualification(
      record.outputQualification,
    );
    const writes = Array.isArray(record.writes) ? record.writes : [];
    if (writes.length === 0) {
      writers.push({
        taskId,
        qualifiedName: qualifiedName ?? undefined,
        ...(edgeQualification === undefined
          ? {}
          : { outputQualification: edgeQualification }),
      });
      continue;
    }
    // Keep one producer-index item per write observation.  Flattening all
    // writes into one task-level partition silently cross-combines partitions
    // for same-table multi-write tasks.
    writes.forEach((write, index) => {
      if (typeof write !== "object" || write === null || Array.isArray(write)) {
        return;
      }
      const writeRecord = write as Record<string, unknown>;
      const writeQualification = parseTaskLocalOutputQualification(
        writeRecord.outputQualification,
      );
      // An explicit candidate cannot be upgraded by broader task/table evidence.
      const outputQualification =
        edgeQualification === "SQL_UNCONSUMED" ||
        writeQualification === "SQL_UNCONSUMED"
          ? "SQL_UNCONSUMED"
          : (writeQualification ?? edgeQualification);
      writers.push({
        taskId,
        writeObservationId:
          text(writeRecord.writeObservationId) ??
          text(writeRecord.write_observation_id) ??
          text(record.writeObservationId) ??
          text(record.write_observation_id) ??
          `write-observation:${taskId}:${index}`,
        qualifiedName: qualifiedName ?? undefined,
        ...(outputQualification === undefined ? {} : { outputQualification }),
        partition: parsePartition(writeRecord),
      });
    });
  }
  return {
    identity: { contentHash, inputFingerprint },
    writers,
  };
}

function parsePartition(
  write: Record<string, unknown>,
): ProducerIndexWriter["partition"] {
  const parts: NonNullable<ProducerIndexWriter["partition"]>[number][] = [];
  const partitionStatus = text(write.partitionStatus) ?? undefined;
  const partition = Array.isArray(write.partition) ? write.partition : [];
  for (const item of partition) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const part = item as Record<string, unknown>;
    const column = text(part.field) ?? text(part.column);
    if (!column) continue;
    const observedValue =
      part.observedValue === null ? null : text(part.observedValue);
    const expression = text(part.expression);
    const values: string[] = [];
    if (observedValue) values.push(observedValue);
    if (expression && !values.includes(expression)) values.push(expression);
    parts.push({
      column,
      values,
      ...(partitionStatus ? { partitionStatus } : {}),
      ...(text(part.valueStatus)
        ? { valueStatus: text(part.valueStatus)! }
        : {}),
      ...(part.observedValue === null || observedValue
        ? { observedValue }
        : {}),
      ...(expression ? { expression } : {}),
    });
  }
  return parts;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
