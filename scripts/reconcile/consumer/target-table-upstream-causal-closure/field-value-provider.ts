import { readFileSync } from "node:fs";

import { canonicalRelationIdentity, sameRelationIdentity } from "../../../machine-facts/relation-identity.ts";
import type { CandidateBranch } from "../target-field-causal-slice/candidate-universe.ts";

export interface FieldValueImpact {
  readonly candidateBranchId: string;
  readonly status: "CONFIRMED" | "CONDITIONAL" | "UNKNOWN" | "PROVEN_ABSENT" | "NOT_APPLICABLE";
  readonly affectedTargetFields: readonly string[];
  readonly outputFieldBindingIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly gapRefs: readonly string[];
}
interface IndexedFieldValueImpact extends FieldValueImpact {
  readonly readOccurrenceIds: readonly string[];
}
export interface FieldValueEvidenceProvider {
  readonly lookup: (branch: CandidateBranch) => FieldValueImpact;
  readonly scanCount: number;
  readonly edgeCount: number;
}

type JsonRecord = Readonly<Record<string, any>>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function fieldOf(node: JsonRecord): JsonRecord {
  return record(node.field);
}

function physicalTableKey(node: JsonRecord): string {
  const field = fieldOf(node);
  return [text(field.stableTableId), text(field.qualifiedName)].map((value) => (value ?? "").toLowerCase()).join("|");
}

function branchTableKey(branch: CandidateBranch): string {
  const table = branch.table;
  return [table?.stableTableId, table?.qualifiedName].map((value) => (value ?? "").toLowerCase()).join("|");
}

function occurrenceKey(value: string): string {
  return value.trim().toLowerCase();
}

function occurrenceTokenMatches(token: string, branchKeys: ReadonlySet<string>): boolean {
  const normalized = occurrenceKey(token);
  if (branchKeys.has(normalized)) return true;
  const canonical = canonicalRelationIdentity(token);
  if (canonical !== null && branchKeys.has(occurrenceKey(canonical))) return true;
  for (const key of branchKeys) {
    if (sameRelationIdentity(key, token)) return true;
  }
  return false;
}

function branchOccurrenceKeys(branch: CandidateBranch): readonly string[] {
  if (!branch.readOccurrence) return [];
  const occurrence = branch.readOccurrence;
  const keys = new Set<string>();
  for (const raw of [
    occurrence.occurrenceId,
    occurrence.readRelationId,
    `${occurrence.occurrenceId}:${occurrence.readRelationId}`,
    ...occurrence.relationPath ?? [],
  ]) {
    if (!raw) continue;
    keys.add(occurrenceKey(raw));
    const canonical = canonicalRelationIdentity(raw);
    if (canonical) keys.add(occurrenceKey(canonical));
  }
  return [...keys];
}

function occurrenceEvidenceRefs(edge: JsonRecord, consumerTaskId: string): readonly string[] {
  const explicit = [text(edge.readOccurrenceId), text(edge.read_occurrence_id)].filter((value): value is string => value !== null);
  const prefix = `field-lineage:consumer-read:${consumerTaskId}:`;
  const fromEvidence = (Array.isArray(edge.evidenceRefs) ? edge.evidenceRefs : [])
    .map(text)
    .filter((value): value is string => value !== null)
    .filter((value) => value.startsWith(prefix))
    // A field-lineage read evidence locator is either one canonical
    // occurrence token or the canonical occurrence id followed by the
    // canonical read-relation id. Both ids may contain `:`, so the suffix
    // must remain an opaque token and be compared by exact equality.
    .map((value) => value.slice(prefix.length));
  return [...new Set([...explicit, ...fromEvidence].map(occurrenceKey))];
}

function producerWriteEvidenceRefs(edge: JsonRecord, producerTaskId: string): readonly string[] {
  const prefix = `field-lineage:producer-write:${producerTaskId}:`;
  return (Array.isArray(edge.evidenceRefs) ? edge.evidenceRefs : [])
    .map(text)
    .filter((value): value is string => value !== null && value.startsWith(prefix));
}

function mergeStatus(left: FieldValueImpact["status"], right: FieldValueImpact["status"]): FieldValueImpact["status"] {
  const rank = (value: FieldValueImpact["status"]): number => value === "CONFIRMED" ? 4 : value === "CONDITIONAL" ? 3 : value === "UNKNOWN" ? 2 : 1;
  return rank(right) > rank(left) ? right : left;
}

/**
 * Loads the legacy field artifact exactly once and indexes only VALUE_FLOW
 * edges. It is an evidence adapter, not a second traversal engine.
 */
function mergeImpact(
  current: IndexedFieldValueImpact | undefined,
  edge: JsonRecord,
  to: JsonRecord,
  producerTaskId: string,
  occurrenceIds: readonly string[],
): IndexedFieldValueImpact {
  const affected = text(fieldOf(to).column);
  const evidence = [
    text(edge.edgeId),
    text(edge.fromNodeId),
    text(edge.toNodeId),
    text(edge.mapping),
  ].filter((value): value is string => value !== null);
  return {
    candidateBranchId: "",
    readOccurrenceIds: [...new Set([...(current?.readOccurrenceIds ?? []), ...occurrenceIds])].sort(),
    status: mergeStatus(current?.status ?? "PROVEN_ABSENT", text(edge.evidenceStatus) === "CONFIRMED" ? "CONFIRMED" : "CONDITIONAL"),
    affectedTargetFields: [...new Set([...(current?.affectedTargetFields ?? []), ...(affected ? [affected] : [])])].sort(),
    outputFieldBindingIds: [...new Set([...(current?.outputFieldBindingIds ?? []), ...(text(to.bindingId) ? [text(to.bindingId)!] : [])])].sort(),
    evidenceRefs: [...new Set([...(current?.evidenceRefs ?? []), ...evidence.map((value) => `field-lineage:${value}`), ...producerWriteEvidenceRefs(edge, producerTaskId)])].sort(),
    gapRefs: [...(current?.gapRefs ?? [])],
  };
}

function publicImpact(branch: CandidateBranch, value: IndexedFieldValueImpact, gapRefs: readonly string[] = []): FieldValueImpact {
  const { readOccurrenceIds: _readOccurrenceIds, ...publicValue } = value;
  return { ...publicValue, candidateBranchId: branch.candidateBranchId, gapRefs: [...new Set([...publicValue.gapRefs, ...gapRefs])] };
}

export function createFieldValueEvidenceProvider(path: string | null | undefined): FieldValueEvidenceProvider {
  let scanCount = 0;
  const byBranch = new Map<string, IndexedFieldValueImpact[]>();
  const unboundByPair = new Map<string, IndexedFieldValueImpact>();
  if (!path) {
    return unknownProvider(() => ++scanCount);
  }
  try {
    scanCount += 1;
    const artifact = JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
    const nodes = Array.isArray(artifact.nodes) ? artifact.nodes.map(record) : [];
    const nodeById = new Map(nodes.map((node) => [text(node.nodeId) ?? "", node]));
    const edges = Array.isArray(artifact.edges) ? artifact.edges.map(record) : [];
    for (const edge of edges) {
      if (text(edge.kind) !== "VALUE_FLOW") continue;
      const from = nodeById.get(text(edge.fromNodeId) ?? "");
      const to = nodeById.get(text(edge.toNodeId) ?? "");
      if (!from || !to) continue;
      const consumerTaskId = text(edge.consumerTaskId) ?? text(to.taskId);
      const producerTaskId = text(edge.producerTaskId) ?? text(from.taskId);
      if (!consumerTaskId || !producerTaskId) continue;
      const baseKey = `${consumerTaskId}|${producerTaskId}|${physicalTableKey(from)}`.toLowerCase();
      const occurrenceIds = occurrenceEvidenceRefs(edge, consumerTaskId);
      if (occurrenceIds.length === 0) {
        unboundByPair.set(baseKey, mergeImpact(unboundByPair.get(baseKey), edge, to, producerTaskId, []));
        continue;
      }
      const impacts = byBranch.get(baseKey) ?? [];
      for (const occurrenceId of occurrenceIds) {
        const currentIndex = impacts.findIndex((item) => item.readOccurrenceIds.includes(occurrenceId));
        const next = mergeImpact(currentIndex >= 0 ? impacts[currentIndex] : undefined, edge, to, producerTaskId, [occurrenceId]);
        if (currentIndex >= 0) impacts[currentIndex] = next;
        else impacts.push(next);
      }
      byBranch.set(baseKey, impacts);
    }
    return {
      scanCount,
      edgeCount: edges.length,
      lookup: (branch) => {
        if (branch.branchKind !== "PHYSICAL_PRODUCER" || !branch.table || !branch.consumerTaskId || !branch.producerTaskId) return {
          candidateBranchId: branch.candidateBranchId, status: "NOT_APPLICABLE", affectedTargetFields: [], outputFieldBindingIds: [], evidenceRefs: [], gapRefs: [],
        };
        const occurrenceKeys = new Set(branchOccurrenceKeys(branch));
        const baseKey = `${branch.consumerTaskId}|${branch.producerTaskId}|${branchTableKey(branch)}`.toLowerCase();
        const indexed = byBranch.get(baseKey) ?? [];
        const value = indexed
          .filter((item) => item.readOccurrenceIds.some((token) => occurrenceTokenMatches(token, occurrenceKeys)))
          .sort((a, b) => b.evidenceRefs.length - a.evidenceRefs.length)[0];
        if (value) return publicImpact(branch, value);
        if (indexed.length > 0) {
          return {
            candidateBranchId: branch.candidateBranchId,
            status: "UNKNOWN",
            affectedTargetFields: [],
            outputFieldBindingIds: [],
            evidenceRefs: [],
            gapRefs: [`field-value-gap:${branch.candidateBranchId}:OCCURRENCE_EVIDENCE_NOT_FOUND`],
          };
        }
        const unbound = unboundByPair.get(baseKey);
        if (unbound) return publicImpact(branch, unbound);
        return {
          candidateBranchId: branch.candidateBranchId,
          status: "NOT_APPLICABLE",
          affectedTargetFields: [],
          outputFieldBindingIds: [],
          evidenceRefs: [],
          gapRefs: [],
        };
      },
    };
  } catch (error) {
    return unknownProvider(() => ++scanCount, error instanceof Error ? error.message : String(error));
  }
}

function unknownProvider(scan: () => number, detail = "field-lineage artifact unavailable"): FieldValueEvidenceProvider {
  scan();
  return {
    scanCount: 1,
    edgeCount: 0,
    lookup: (branch) => ({ candidateBranchId: branch.candidateBranchId, status: "UNKNOWN", affectedTargetFields: [], outputFieldBindingIds: [], evidenceRefs: [], gapRefs: [`field-value-gap:${branch.candidateBranchId}:${detail}`] }),
  };
}
