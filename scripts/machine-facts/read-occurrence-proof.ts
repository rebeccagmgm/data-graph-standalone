import { normalizeName } from "./machine-facts-contract.ts";
import { canonicalRelationIdentity, sameRelationIdentity } from "./relation-identity.ts";
import type { CurrentBundleLoad, JsonRecord } from "../query/current-task-bundle.ts";

export interface ReadOccurrenceTable {
  readonly qualifiedName: string;
}

export interface ReadOccurrenceProof {
  readonly valid: boolean;
  readonly reason: string | null;
  readonly relationId: string | null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? null : trimmed;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function statementIndexForRelation(
  load: CurrentBundleLoad,
  relation: JsonRecord,
): number | null {
  const statementId = nonEmpty(relation.statement_id);
  const statement = (load.records["statements.jsonl"] ?? []).find(
    (candidate) => String(candidate.statement_id ?? "") === statementId,
  );
  if (Number.isSafeInteger(statement?.statement_index))
    return Number(statement?.statement_index);
  return String(relation.relation_id ?? "").match(/:statement:(\d+):relation:/)?.[1]
    ? Number(String(relation.relation_id).match(/:statement:(\d+):relation:/)?.[1])
    : null;
}

function statementIndexForId(
  load: CurrentBundleLoad,
  statementId: unknown,
): number | null {
  const normalizedStatementId = nonEmpty(statementId);
  if (!normalizedStatementId) return null;
  const statement = (load.records["statements.jsonl"] ?? []).find(
    (candidate) => String(candidate.statement_id ?? "") === normalizedStatementId,
  );
  const statementIndex = statement?.statement_index;
  if (Number.isSafeInteger(statementIndex)) return Number(statementIndex);
  const match = normalizedStatementId.match(/:statement:(\d+)(?::|$)/);
  return match ? Number(match[1]) : null;
}

function relationPathBinding(relationPath: readonly string[]): string | null {
  for (const rawPathItem of relationPath) {
    const pathItem = canonicalRelationIdentity(rawPathItem);
    if (!pathItem) continue;
    const parts = pathItem.split(".");
    const readIndex = parts.indexOf("read");
    if (readIndex < 0) continue;
    const binding =
      parts[readIndex + 1] === parts.at(-1)
        ? parts[readIndex - 1]
        : parts[readIndex + 1] ?? parts[readIndex - 1];
    if (binding && binding !== "read") return binding;
  }
  return null;
}

/**
 * Prove one consumer read occurrence against a Machine Facts bundle.
 * Field-lineage STRICT mode and causal-closure read-scope share this proof.
 */
export function proveReadOccurrence(
  load: CurrentBundleLoad,
  table: ReadOccurrenceTable,
  occurrence: JsonRecord,
): ReadOccurrenceProof {
  const occurrenceId = nonEmpty(occurrence.occurrenceId);
  const readRelationId = nonEmpty(occurrence.readRelationId);
  const statementIndex = occurrence.statementIndex;
  const relationPath = occurrence.relationPath;
  if (
    !occurrenceId ||
    !readRelationId ||
    !Number.isSafeInteger(statementIndex) ||
    !Array.isArray(relationPath) ||
    relationPath.length === 0 ||
    relationPath.some((item) => !nonEmpty(item))
  )
    return { valid: false, reason: "CONSUMER_READ_OCCURRENCE_EVIDENCE_MISMATCH", relationId: null };

  if (!Object.prototype.hasOwnProperty.call(load.records, "relation-nodes.jsonl"))
    return { valid: true, reason: null, relationId: null };

  const qualifiedTable = normalizeName(table.qualifiedName);
  const tableTail = qualifiedTable.split(".").at(-1) ?? qualifiedTable;
  const expectedBinding = relationPathBinding(relationPath);
  const matchingRead = (load.records["relation-nodes.jsonl"] ?? []).find((node) => {
    const relation = asRecord(node.relation);
    const relationTable = normalizeName(String(relation?.table ?? ""));
    const bareTableIsSupported =
      relationTable === tableTail &&
      (load.records["dataset-io.jsonl"] ?? []).some(
        (record) =>
          record.direction === "READ" &&
          record.task_id === load.taskId &&
          normalizeName(String(record.physical_dataset ?? "")).split(".").at(-1) ===
            tableTail,
      );
    if (
      String(node.task_id ?? "") !== load.taskId ||
      String(node.relation_type ?? relation?.type ?? "") !== "read" ||
      (relationTable !== qualifiedTable && !bareTableIsSupported)
    )
      return false;
    const actualOccurrenceId = nonEmpty(
      relation?.read_occurrence_id ??
        asRecord(relation?.read_occurrence)?.occurrence_id ??
        node.read_occurrence_id,
    );
    const actualRelationId = nonEmpty(
      node.relation_id ??
        relation?.id ??
        asRecord(relation?.read_occurrence)?.relation_id,
    );
    const relationIdentityMatches = sameRelationIdentity(actualRelationId, readRelationId);
    const occurrenceIdentityMatches =
      actualOccurrenceId !== null &&
      sameRelationIdentity(actualOccurrenceId, occurrenceId);
    const legacyIdentity =
      expectedBinding !== null &&
      normalizeName(String(relation?.binding ?? "")) === expectedBinding &&
      normalizeName(String(relation?.scope_id ?? "")).split(".")[0] ===
        normalizeName(
          String(canonicalRelationIdentity(relationPath[0]) ?? "").split(".")[0],
        );
    const identityProven =
      occurrenceIdentityMatches
        ? relationIdentityMatches
        : actualOccurrenceId === null
          ? relationIdentityMatches || legacyIdentity
          : false;
    return (
      identityProven &&
      statementIndexForRelation(load, node) === statementIndex
    );
  });
  if (!matchingRead)
    return { valid: false, reason: "CONSUMER_READ_OCCURRENCE_NOT_PROVEN", relationId: null };

  const statementDatasetReads = (load.records["dataset-io.jsonl"] ?? []).filter(
    (record) => {
      if (
        record.direction !== "READ" ||
        String(record.task_id ?? "") !== load.taskId
      )
        return false;
      const dataset = normalizeName(String(record.physical_dataset ?? ""));
      if (dataset !== qualifiedTable && dataset.split(".").at(-1) !== tableTail)
        return false;
      return statementIndexForId(load, record.statement_id) === statementIndex;
    },
  );
  const matchingDatasetRead = statementDatasetReads.some((record) => {
    if (Array.isArray(record.read_occurrences))
      return record.read_occurrences.some((rawOccurrence) => {
        const readOccurrence = asRecord(rawOccurrence);
        return (
          readOccurrence !== null &&
          sameRelationIdentity(
            readOccurrence.occurrence_id,
            matchingRead.relation?.read_occurrence_id ??
              matchingRead.read_occurrence_id,
          ) &&
          sameRelationIdentity(readOccurrence.relation_id, matchingRead.relation_id)
        );
      });
    return statementDatasetReads.length === 1;
  });
  if (!matchingDatasetRead)
    return { valid: false, reason: "CONSUMER_READ_OCCURRENCE_NOT_PROVEN", relationId: null };

  const relation = asRecord(matchingRead.relation);
  const expectedScope = nonEmpty(occurrence.scopeId ?? occurrence.scope_id);
  const actualScope = nonEmpty(relation?.scope_id ?? asRecord(relation?.read_occurrence)?.scope_id);
  if (expectedScope !== null && actualScope !== expectedScope)
    return { valid: false, reason: "CONSUMER_READ_OCCURRENCE_EVIDENCE_MISMATCH", relationId: null };
  return {
    valid: true,
    reason: null,
    relationId: nonEmpty(matchingRead.relation_id ?? relation?.id) ,
  };
}
