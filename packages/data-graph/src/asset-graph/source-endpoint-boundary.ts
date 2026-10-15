import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  sha256,
} from "../../../../scripts/machine-facts/machine-facts-contract.ts";
import {
  loadSourceEndpointBoundaryConfig,
  matchingSourceEndpointBoundaryRole,
  DEFAULT_SOURCE_ENDPOINT_BOUNDARY_CONFIG_PATH,
  type SourceEndpointBoundaryConfig,
} from "../../../../scripts/reconcile/shared/source-endpoint-boundary-config.ts";
import {
  openWriterCatalog,
  writerCatalogPort,
  type WriterCatalogPort,
} from "../../../../scripts/query/writer-catalog.ts";
import type {
  UnionContinuationIndex,
  UnionContinuationIndexEntry,
} from "../continuation/continuation-index.ts";
import type { ContinuationBoundaryEvidence } from "./continuation-metrics.ts";

export interface SourceEndpointBoundaryRead {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly qualifiedName: string;
  readonly role: string;
  readonly ruleRef: string;
  readonly evidenceRefs: readonly string[];
}

export interface SourceEndpointBoundarySnapshot {
  readonly schemaVersion: "1.0.0";
  readonly config: SourceEndpointBoundaryConfig;
  readonly configHash: string;
  readonly indexContentHash: string;
  readonly reads: readonly SourceEndpointBoundaryRead[];
  readonly expectedWriterMissingReadOccurrenceIds: readonly string[];
  readonly contentHash: string;
}

export function loadGraphSourceEndpointBoundary(): SourceEndpointBoundaryConfig {
  return loadSourceEndpointBoundaryConfig(
    fileURLToPath(
      new URL(
        `../../../../${DEFAULT_SOURCE_ENDPOINT_BOUNDARY_CONFIG_PATH}`,
        import.meta.url,
      ),
    ),
  );
}

export const sourceEndpointBoundaryConfigHash = (
  config: SourceEndpointBoundaryConfig,
): string => sha256(canonicalJson(config));

/** Independent source-endpoint proof; never a claim that a producer is absent. */
export function sourceEndpointBoundaryNodeDetails(
  qualifiedName: string,
  consumerTaskCategory: string | null | undefined,
  config: SourceEndpointBoundaryConfig,
) {
  const match = matchingSourceEndpointBoundaryRole(
    config,
    qualifiedName,
    consumerTaskCategory,
  );
  if (!match) return null;
  return {
    continuationDisposition: "SOURCE_ENDPOINT_BOUNDARY" as const,
    boundaryRole: match.role,
    terminalReason: "源端点边界，停止展开",
    terminalRuleRef: match.ruleRef,
    boundaryConfigHash: sourceEndpointBoundaryConfigHash(config),
  };
}

export function sourceEndpointBoundaryKey(
  read: Pick<SourceEndpointBoundaryRead, "consumerTaskId" | "readOccurrenceId">,
): string {
  return `${read.consumerTaskId}\u0000${read.readOccurrenceId}`;
}

export function isIndexEntrySourceEndpointBoundary(
  entry: UnionContinuationIndexEntry,
  reads: readonly SourceEndpointBoundaryRead[],
): boolean {
  const key = `${entry.consumerTaskId}\u0000${entry.readOccurrenceId}`;
  return reads.some((read) => sourceEndpointBoundaryKey(read) === key);
}

export function classifySourceEndpointBoundaryRead(
  entry: UnionContinuationIndexEntry,
  config: SourceEndpointBoundaryConfig,
  taskCategoryFor: (taskId: string) => string | null | undefined,
  configHash: string,
): SourceEndpointBoundaryRead | null {
  if (entry.identityStatus !== "CONFIRMED" || entry.candidates.length > 0)
    return null;
  const match = matchingSourceEndpointBoundaryRole(
    config,
    entry.qualifiedName,
    taskCategoryFor(entry.consumerTaskId),
  );
  if (!match) return null;
  const evidenceRef = `source-endpoint-boundary:${configHash}#${match.ruleRef}`;
  return {
    consumerTaskId: entry.consumerTaskId,
    readOccurrenceId: entry.readOccurrenceId,
    qualifiedName: entry.qualifiedName,
    role: match.role,
    ruleRef: match.ruleRef,
    evidenceRefs: [evidenceRef],
  };
}

export function buildExpectedWriterMissingIds(
  index: UnionContinuationIndex,
  boundaryReads: readonly SourceEndpointBoundaryRead[],
  unionTaskIds: ReadonlySet<string>,
  catalog: WriterCatalogPort | null,
): string[] {
  if (!catalog) return [];
  const boundaryIds = new Set(
    boundaryReads.map((read) => read.readOccurrenceId),
  );
  const missing: string[] = [];
  for (const entry of index.entries) {
    if (entry.identityStatus !== "CONFIRMED" || entry.candidates.length > 0)
      continue;
    if (boundaryIds.has(entry.readOccurrenceId)) continue;
    const writers = catalog.writersForQualifiedName(entry.qualifiedName);
    if (writers.length === 0) continue;
    if (writers.every((writer) => !unionTaskIds.has(writer.taskId)))
      missing.push(entry.readOccurrenceId);
  }
  return [...new Set(missing)].sort();
}

export function buildSourceEndpointBoundarySnapshot(input: {
  readonly index: UnionContinuationIndex;
  readonly config: SourceEndpointBoundaryConfig;
  readonly taskCategoryFor: (taskId: string) => string | null | undefined;
  readonly unionTaskIds: ReadonlySet<string>;
  readonly writerCatalogPath?: string | null;
  readonly catalog?: WriterCatalogPort | null;
}): SourceEndpointBoundarySnapshot {
  const configHash = sourceEndpointBoundaryConfigHash(input.config);
  const reads = input.index.entries
    .flatMap((entry): SourceEndpointBoundaryRead[] => {
      const read = classifySourceEndpointBoundaryRead(
        entry,
        input.config,
        input.taskCategoryFor,
        configHash,
      );
      return read ? [read] : [];
    })
    .sort(
      (left, right) =>
        left.consumerTaskId.localeCompare(right.consumerTaskId) ||
        left.readOccurrenceId.localeCompare(right.readOccurrenceId),
    );
  let catalog = input.catalog ?? null;
  if (
    !catalog &&
    input.writerCatalogPath &&
    existsSync(input.writerCatalogPath)
  ) {
    catalog = writerCatalogPort(openWriterCatalog(input.writerCatalogPath));
  }
  const expectedWriterMissingReadOccurrenceIds = buildExpectedWriterMissingIds(
    input.index,
    reads,
    input.unionTaskIds,
    catalog,
  );
  const body = {
    schemaVersion: "1.0.0" as const,
    config: input.config,
    configHash,
    indexContentHash: input.index.contentHash,
    reads,
    expectedWriterMissingReadOccurrenceIds,
  };
  return { ...body, contentHash: sha256(canonicalJson(body)) };
}

export function boundaryEvidenceFromSnapshot(
  snapshot: SourceEndpointBoundarySnapshot,
): ContinuationBoundaryEvidence {
  return {
    sourceEndpointBoundaryReadOccurrenceIds: snapshot.reads.map(
      (read) => read.readOccurrenceId,
    ),
    expectedWriterMissingReadOccurrenceIds:
      snapshot.expectedWriterMissingReadOccurrenceIds,
  };
}

export function augmentIndexWithSourceEndpointBoundaries(
  index: UnionContinuationIndex,
  snapshot: SourceEndpointBoundarySnapshot,
): UnionContinuationIndex {
  const byKey = new Map(
    snapshot.reads.map((read) => [sourceEndpointBoundaryKey(read), read]),
  );
  const entries = index.entries.map((entry) => {
    const boundary = byKey.get(
      `${entry.consumerTaskId}\u0000${entry.readOccurrenceId}`,
    );
    if (!boundary) return entry;
    const gaps = [
      ...entry.gaps.filter(
        (gap) => String(gap.reasonCode) !== "SOURCE_ENDPOINT_BOUNDARY",
      ),
      {
        gapId: `source-endpoint-boundary:${entry.readOccurrenceId}`,
        reasonCode: "SOURCE_ENDPOINT_BOUNDARY" as const,
        message: `Source endpoint boundary for ${entry.qualifiedName}`,
        details: {
          role: boundary.role,
          ruleRef: boundary.ruleRef,
          evidenceRefs: [...boundary.evidenceRefs],
        },
      },
    ];
    return { ...entry, gaps };
  });
  return { ...index, entries };
}

export function assertSourceEndpointBoundarySnapshot(
  snapshot: SourceEndpointBoundarySnapshot,
  indexHash: string,
  expectedHash: string,
): void {
  if (
    snapshot.schemaVersion !== "1.0.0" ||
    !Array.isArray(snapshot.reads) ||
    snapshot.indexContentHash !== indexHash ||
    snapshot.contentHash !== expectedHash ||
    sourceEndpointBoundaryConfigHash(snapshot.config) !== snapshot.configHash
  )
    throw new Error("SOURCE_ENDPOINT_BOUNDARY_SNAPSHOT_MISMATCH");
  const { contentHash, ...body } = snapshot;
  if (sha256(canonicalJson(body)) !== contentHash)
    throw new Error("SOURCE_ENDPOINT_BOUNDARY_CONTENT_HASH_MISMATCH");
}
