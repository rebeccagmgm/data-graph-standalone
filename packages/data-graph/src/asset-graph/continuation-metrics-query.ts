import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertUnionContinuationIndex,
  type UnionContinuationIndex,
} from "../continuation/continuation-index.ts";
import {
  calculateContinuationMetrics,
  classifyContinuationGaps,
  isPolicyTerminalRead,
  isSourceEndpointBoundaryRead,
  withoutBoundaryContinuationGaps,
  withoutPolicyContinuationGaps,
} from "./continuation-metrics.ts";
import {
  assertTerminalPolicySnapshot,
  type TerminalPolicySnapshot,
} from "./terminal-policy.ts";
import {
  assertSourceEndpointBoundarySnapshot,
  type SourceEndpointBoundarySnapshot,
} from "./source-endpoint-boundary.ts";

export const CONTINUATION_GAP_LAYERS = [
  "boundary",
  "actionable",
  "material",
  "unclassified",
] as const;
export type ContinuationGapLayer = (typeof CONTINUATION_GAP_LAYERS)[number];

/** Read one immutable published snapshot. Never prepare or contact Neo4j. */
export function readPublishedContinuationMetrics(input: {
  graphOutputRoot: string;
  gapLayer?: string;
  reasonCode?: string;
  publicationVersion?: string;
  offset?: number;
  limit?: number;
  terminalRole?: string;
}) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
    throw new Error("INVALID_ARGUMENT:--offset");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("INVALID_ARGUMENT:--limit");
  if (
    input.gapLayer &&
    !CONTINUATION_GAP_LAYERS.some((layer) => layer === input.gapLayer)
  )
    throw new Error("INVALID_ARGUMENT:--gap-layer");
  if (input.reasonCode !== undefined && input.reasonCode.trim().length === 0)
    throw new Error("INVALID_ARGUMENT:--reason-code");
  if (input.gapLayer && input.terminalRole)
    throw new Error("INVALID_ARGUMENT:--gap-layer_and_--terminal-role");
  if (input.terminalRole && input.terminalRole !== "REFERENCE_CONFIG")
    throw new Error("INVALID_ARGUMENT:--terminal-role");
  const {
    publication,
    index,
    pinnedIndexHash,
    policyTerminals,
    boundarySnapshot,
  } = loadPublishedContinuationIndex({
    graphOutputRoot: input.graphOutputRoot,
    publicationVersion: input.publicationVersion,
  });
  const boundaryEvidence = boundarySnapshot
    ? {
        sourceEndpointBoundaryReadOccurrenceIds: boundarySnapshot.reads.map(
          (read) => read.readOccurrenceId,
        ),
        expectedWriterMissingReadOccurrenceIds:
          boundarySnapshot.expectedWriterMissingReadOccurrenceIds,
      }
    : undefined;
  const confirmed = publication.confirmedFieldContinuations;
  const candidate = publication.candidateFieldContinuations;
  const confirmedCount =
    typeof confirmed === "number" &&
    Number.isSafeInteger(confirmed) &&
    confirmed >= 0
      ? confirmed
      : null;
  const candidateCount =
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
      ? candidate
      : null;
  const hasEdgeCounts = confirmedCount !== null && candidateCount !== null;
  const metrics = calculateContinuationMetrics({
    index,
    boundaryEvidence,
    boundaryReads: boundarySnapshot?.reads,
    policyTerminals,
    continuationEdgeMetrics: hasEdgeCounts
      ? {
          totalContinuationEdges: confirmedCount + candidateCount,
          confirmedContinuationEdges: confirmedCount,
        }
      : undefined,
  });
  const rows = input.gapLayer
    ? index.entries.flatMap((entry) => {
        const gapEntry = isPolicyTerminalRead(entry, policyTerminals)
          ? withoutPolicyContinuationGaps(entry)
          : boundarySnapshot &&
              isSourceEndpointBoundaryRead(entry, boundarySnapshot.reads)
            ? withoutBoundaryContinuationGaps(entry)
            : entry;
        const gaps = classifyContinuationGaps(
          gapEntry,
          boundaryEvidence,
        ).filter(
          (gap) =>
            gap.group === input.gapLayer &&
            (input.reasonCode === undefined ||
              gap.reasonCode === input.reasonCode),
        );
        return gaps.length
          ? [
              {
                consumerTaskId: entry.consumerTaskId,
                readOccurrenceId: entry.readOccurrenceId,
                qualifiedName: entry.qualifiedName,
                reasonCodes: [
                  ...new Set(gaps.map((gap) => gap.reasonCode)),
                ].sort(),
              },
            ]
          : [];
      })
    : [];
  rows.sort(
    (a, b) =>
      a.consumerTaskId.localeCompare(b.consumerTaskId) ||
      a.readOccurrenceId.localeCompare(b.readOccurrenceId),
  );
  const policyRows = policyTerminals
    .filter((terminal) => terminal.role === input.terminalRole)
    .map((terminal) => ({
      consumerTaskId: terminal.consumerTaskId,
      readOccurrenceId: terminal.readOccurrenceId,
      qualifiedName: terminal.qualifiedName,
      classification: "POLICY_TERMINAL" as const,
      role: terminal.role,
      ruleRef: terminal.ruleRef,
    }));
  return {
    snapshotKind: "PUBLISHED_INDEX" as const,
    publicationVersion: publication.version as string,
    compilerVersion: publication.compilerVersion as string,
    indexContentHash: index.contentHash,
    indexBinding:
      pinnedIndexHash === undefined
        ? ("LEGACY_PUBLICATION_DIRECTORY" as const)
        : ("PUBLICATION_CONTENT_HASH" as const),
    taskCount: publication.taskCount as number,
    metrics,
    ...(input.gapLayer
      ? {
          gapLayer: input.gapLayer,
          items: rows.slice(offset, offset + limit),
          pagination: {
            offset,
            limit,
            total: rows.length,
            nextOffset: offset + limit < rows.length ? offset + limit : null,
          },
        }
      : {}),
    ...(input.terminalRole
      ? {
          terminalRole: input.terminalRole,
          items: policyRows.slice(offset, offset + limit),
          pagination: {
            offset,
            limit,
            total: policyRows.length,
            nextOffset:
              offset + limit < policyRows.length ? offset + limit : null,
          },
        }
      : {}),
  };
}

/** Read the immutable INDEX located by one published snapshot. */
export function loadPublishedContinuationIndex(input: {
  graphOutputRoot: string;
  publicationVersion?: string;
}): {
  publication: Record<string, unknown>;
  publicationPath: string;
  index: UnionContinuationIndex;
  pinnedIndexHash: unknown;
  policyTerminals: TerminalPolicySnapshot["reads"];
  boundarySnapshot: SourceEndpointBoundarySnapshot | null;
} {
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const current = read(join(input.graphOutputRoot, "current.json"));
  const publicationPath = String(current.publicationPath);
  const publication = read(publicationPath) as Record<string, unknown>;
  if (publication.version !== current.version)
    throw new Error("CONTINUATION_PUBLICATION_VERSION_MISMATCH");
  if (
    input.publicationVersion !== undefined &&
    input.publicationVersion !== publication.version
  )
    throw new Error("CONTINUATION_PUBLICATION_VERSION_CHANGED");
  const index = read(
    join(dirname(publicationPath), "union-continuation-index.json"),
  ) as UnionContinuationIndex;
  assertUnionContinuationIndex(index);
  const pinnedIndexHash = publication.continuationIndexContentHash;
  if (pinnedIndexHash !== undefined && pinnedIndexHash !== index.contentHash)
    throw new Error("CONTINUATION_PUBLICATION_INDEX_MISMATCH");
  const terminalPolicyHash = publication.terminalPolicyContentHash;
  const policyTerminals: TerminalPolicySnapshot["reads"] = terminalPolicyHash
    ? (() => {
        const snapshot = read(
          join(dirname(publicationPath), "terminal-policy.json"),
        ) as TerminalPolicySnapshot;
        assertTerminalPolicySnapshot(
          snapshot,
          index.contentHash,
          String(terminalPolicyHash),
        );
        return snapshot.reads;
      })()
    : [];
  const boundaryPolicyHash = publication.sourceEndpointBoundaryContentHash;
  const boundarySnapshot: SourceEndpointBoundarySnapshot | null =
    boundaryPolicyHash
      ? (() => {
          const snapshot = read(
            join(dirname(publicationPath), "source-endpoint-boundary.json"),
          ) as SourceEndpointBoundarySnapshot;
          assertSourceEndpointBoundarySnapshot(
            snapshot,
            index.contentHash,
            String(boundaryPolicyHash),
          );
          return snapshot;
        })()
      : null;
  return {
    publication,
    publicationPath,
    index,
    pinnedIndexHash,
    policyTerminals,
    boundarySnapshot,
  };
}
