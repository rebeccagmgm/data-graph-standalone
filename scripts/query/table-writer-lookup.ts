import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { PartitionAssignment } from "../evidence/sql-write-evidence.ts";
import type { ReadPartitionScope } from "../evidence/sql-read-scope.ts";
import {
  loadTableProducerIndex,
  type ConfirmedProducerEdge,
  type NonConfirmedRelation,
  type ProducerTableIdentity,
  type ProducerWriteObservation,
  type TableProducerIndex,
} from "../reconcile/producer/producer-index.ts";
import {
  lookupConfirmedProducers,
  lookupNonConfirmedRelations,
  lookupProducerWritesByTask,
  matchProducersByReadScopeFromEdges,
  type ProducerPartitionMatch,
  type ProducerTaskWriteLookup,
} from "./producer-index-query.ts";
import type {
  TaskCoverageRow,
  WriterCatalogHandle,
  WriterHit,
} from "./writer-catalog.ts";

const loadCatalogModule = createRequire(import.meta.url);

function catalogModule(): typeof import("./writer-catalog.ts") {
  return loadCatalogModule("./writer-catalog.ts") as typeof import("./writer-catalog.ts");
}

export type WriterLookup =
  | { readonly kind: "catalog"; readonly handle: WriterCatalogHandle }
  | { readonly kind: "legacyIndex"; readonly index: TableProducerIndex };

export interface WriterLookupMeta {
  readonly contentHash: string;
  readonly inputFingerprint: string | null;
  readonly status: "VALID_SUCCESS" | "VALID_PARTIAL";
  readonly issues: readonly string[];
  readonly counts: {
    readonly taskPacksDiscovered: number;
    readonly invalidTaskPacks: number;
    readonly tablePacksDiscovered: number;
    readonly tablePacksInvalid: number;
  };
}

const SQL_WRITE_KINDS = new Set([
  "INSERT_OVERWRITE",
  "INSERT_INTO",
  "MERGE_INTO",
  "CTAS",
]);

export function isLegacyProducerIndexPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".json") || lower.endsWith(".jsonl");
}

export function resolveWriterLookup(options: {
  readonly writerCatalog?: WriterCatalogHandle | null;
  readonly producerIndex?: TableProducerIndex | null;
}): WriterLookup | null {
  if (options.writerCatalog) return { kind: "catalog", handle: options.writerCatalog };
  if (options.producerIndex)
    return { kind: "legacyIndex", index: options.producerIndex };
  return null;
}

export function openWriterLookupFromPath(pathInput: string): WriterLookup {
  const path = resolve(pathInput);
  if (isLegacyProducerIndexPath(path))
    return { kind: "legacyIndex", index: loadTableProducerIndex(path) };
  return { kind: "catalog", handle: catalogModule().openWriterCatalog(path) };
}

export function openWriterLookupFromPathIfPresent(
  pathInput: string,
): WriterLookup | null {
  const path = resolve(pathInput);
  if (!existsSync(path) && !isLegacyProducerIndexPath(path))
    return { kind: "catalog", handle: catalogModule().openWriterCatalog(path) };
  if (!existsSync(path)) return null;
  return openWriterLookupFromPath(path);
}

function sqlWriteKind(
  writeKind: string | null,
): ProducerWriteObservation["sqlWriteKind"] {
  if (!writeKind) return null;
  const normalized = writeKind.trim().toUpperCase().replaceAll("-", "_");
  return SQL_WRITE_KINDS.has(normalized)
    ? (normalized as NonNullable<ProducerWriteObservation["sqlWriteKind"]>)
    : null;
}

function partitionFromJson(raw: string | null): readonly PartitionAssignment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PartitionAssignment[]) : [];
  } catch {
    return [];
  }
}

function writeFromHit(
  hit: WriterHit,
  coverage: TaskCoverageRow | null,
): ProducerWriteObservation {
  const sqlKind = sqlWriteKind(hit.writeKind);
  const partition = partitionFromJson(hit.partitionJson);
  return {
    observationKind: "SQL_EXPLICIT_WRITE",
    declaredWriteMode: hit.writeKind,
    sqlWriteKind: sqlKind,
    partition,
    partitionStatus: partition.length > 0 ? "COMPLETE" : "NOT_PARTITIONED",
    evidence: [
      {
        source: "SQL_PARSE",
        provider: "writer-catalog",
        locator: `${hit.taskId}:${hit.writeObservationId}`,
        observedAt: coverage?.indexedAt ?? null,
      },
    ],
    writeDirection: "WRITE_CONFIRMED",
    operationClass: sqlKind ?? "UNKNOWN",
    dataPathRole: "PRODUCER",
  };
}

function edgesFromHits(
  hits: readonly WriterHit[],
  coverageOf: (taskId: string) => TaskCoverageRow | null,
): ConfirmedProducerEdge[] {
  const grouped = new Map<string, WriterHit[]>();
  for (const hit of hits) {
    const key = `${hit.taskId}\u0000${hit.table.platform}\u0000${hit.table.dataSource}\u0000${hit.table.qualifiedName}`;
    const list = grouped.get(key);
    if (list) list.push(hit);
    else grouped.set(key, [hit]);
  }
  return [...grouped.values()]
    .map((group) => {
      const hit = group[0]!;
      const coverage = coverageOf(hit.taskId);
      return {
        taskId: hit.taskId,
        taskCategory: coverage?.taskCategory ?? "",
        taskContentHash: coverage?.taskContentHash ?? "",
        table: {
          platform: hit.table.platform,
          dataSource: hit.table.dataSource,
          qualifiedName: hit.table.qualifiedName,
          identityStatus: "RESOLVED" as const,
        },
        writes: group.map((item) => writeFromHit(item, coverage)),
      };
    })
    .sort((left, right) =>
      left.taskId < right.taskId
        ? -1
        : left.taskId > right.taskId
          ? 1
          : left.table.qualifiedName < right.table.qualifiedName
            ? -1
            : left.table.qualifiedName > right.table.qualifiedName
              ? 1
              : 0,
    );
}

export function writerLookupMeta(lookup: WriterLookup): WriterLookupMeta {
  if (lookup.kind === "legacyIndex") {
    const index = lookup.index;
    return {
      contentHash: index.contentHash,
      inputFingerprint: index.inputFingerprint,
      status: index.buildStatus === "PARTIAL" ? "VALID_PARTIAL" : "VALID_SUCCESS",
      issues: index.issues,
      counts: {
        taskPacksDiscovered: index.counts.taskPacksDiscovered,
        invalidTaskPacks: index.counts.invalidTaskPacks,
        tablePacksDiscovered: index.counts.tablePacksDiscovered,
        tablePacksInvalid: index.counts.invalidTablePacks,
      },
    };
  }
  const catalog = catalogModule();
  const counts = catalog.catalogCoverageCounts(lookup.handle);
  return {
    contentHash: catalog.catalogFingerprint(lookup.handle),
    inputFingerprint: null,
    status: counts.tasksFailed > 0 ? "VALID_PARTIAL" : "VALID_SUCCESS",
    issues: [],
    counts: {
      taskPacksDiscovered: counts.tasksIndexed,
      invalidTaskPacks: counts.tasksFailed,
      tablePacksDiscovered: 0,
      tablePacksInvalid: 0,
    },
  };
}

export function lookupConfirmedProducersFor(
  lookup: WriterLookup,
  table: ProducerTableIdentity,
): readonly ConfirmedProducerEdge[] {
  if (lookup.kind === "legacyIndex")
    return lookupConfirmedProducers(lookup.index, table);
  return edgesFromHits(catalogModule().writersForTable(lookup.handle, table), (taskId) =>
    catalogModule().taskCoverage(lookup.handle, taskId),
  );
}

export function lookupNonConfirmedRelationsFor(
  lookup: WriterLookup,
  table: ProducerTableIdentity,
): readonly NonConfirmedRelation[] {
  if (lookup.kind === "legacyIndex")
    return lookupNonConfirmedRelations(lookup.index, table);
  return [];
}

export function lookupProducerWritesByTaskFor(
  lookup: WriterLookup,
  taskId: string,
): ProducerTaskWriteLookup {
  if (lookup.kind === "legacyIndex")
    return lookupProducerWritesByTask(lookup.index, taskId);
  return {
    confirmedWrites: edgesFromHits(
      catalogModule().writersForTask(lookup.handle, taskId),
      () => catalogModule().taskCoverage(lookup.handle, taskId),
    ),
    nonConfirmedRelations: [],
  };
}

export function matchProducersByReadScopeFor(
  lookup: WriterLookup,
  table: ProducerTableIdentity,
  readScope: ReadPartitionScope,
): readonly ProducerPartitionMatch[] {
  return matchProducersByReadScopeFromEdges(
    lookupConfirmedProducersFor(lookup, table),
    readScope,
  );
}

export function taskContentHashesFor(
  lookup: WriterLookup,
): ReadonlyMap<string, string> {
  if (lookup.kind === "legacyIndex") {
    return new Map(
      lookup.index.confirmedProducerEdges.map((edge) => [
        edge.taskId,
        edge.taskContentHash,
      ]),
    );
  }
  const rows = lookup.handle.db
    .prepare(
      `SELECT task_id, task_content_hash FROM task_coverage ORDER BY task_id`,
    )
    .all() as { task_id: string; task_content_hash: string }[];
  return new Map(
    rows.map((row) => [String(row.task_id), String(row.task_content_hash)]),
  );
}

export function catalogHasWriterForTableKey(
  lookup: WriterLookup,
  identity: ProducerTableIdentity,
): boolean {
  return lookupConfirmedProducersFor(lookup, identity).length > 0;
}
