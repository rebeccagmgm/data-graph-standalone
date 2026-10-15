import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  indexTaskInputPacks,
  loadPhysicalTableCatalog,
  type PhysicalTableCatalogEntry,
} from "../../../machine-facts/input-pack-machine-facts.ts";
import {
  canonicalJson,
  sha256,
} from "../../../machine-facts/machine-facts-contract.ts";
import {
  canonicalBundleIdentity,
  createCurrentTaskBundleReader,
  type CurrentBundleLoad,
} from "../../../query/current-task-bundle.ts";
import { validateTableProducerIndex } from "../../producer/producer-index.ts";
import {
  catalogFingerprint,
  openWriterCatalog,
} from "../../../query/writer-catalog.ts";
import { isLegacyProducerIndexPath } from "../../../query/table-writer-lookup.ts";
import { validateMultiHopReconciliation } from "../../../addons/task-lineage/reconcile/consumer/multi-hop/reconcile-multi-hop.ts";
import {
  projectTargetTableCandidateUniverse,
  type CandidateBranch,
  type CandidateUniverse,
  type CandidateWriteScope,
} from "./candidate-universe.ts";
import {
  canonicalizeTargetTableArtifact,
  TARGET_TABLE_CAUSAL_CLOSURE_ARTIFACT_TYPE,
  TARGET_TABLE_CAUSAL_CLOSURE_SCHEMA_VERSION,
  type CausalStageMetric,
  type TargetTableCausalClosureArtifact,
} from "./artifact-contract.ts";
import { buildCausalClosure, type WriteScope } from "./causal-closure.ts";
import { buildImpactGraph } from "./impact-graph.ts";
import {
  formatTargetTableCausalSummary,
  renderTargetTableCausalHtml,
} from "./format-target-table-causal-closure.ts";
import { createFieldValueEvidenceProvider } from "./field-value-provider.ts";
import { normalizeReadScopes } from "./read-scope.ts";
import { validateCausalClosure } from "./proof-validator.ts";
import {
  buildShrinkReport,
  unknownReasonCodesForAssessment,
} from "./static-assessment.ts";
import {
  relationSummaryKey,
  summarizeTaskRelations,
} from "./task-relation-summary.ts";
import {
  resolveTargetWrite,
  type AnalysisSnapshotRef,
} from "./target-write-contract.ts";
import { inferTaskDefaultSchema } from "../../shared/task-default-schema.ts";
import { canonicalCandidateBranchId } from "../target-field-causal-slice/candidate-universe.ts";
import {
  continuationIndexEntryReference,
  loadUnionContinuationCandidateSource,
  type UnionContinuationCandidateSource,
  type UnionContinuationIndexCandidate,
} from "./union-continuation-candidate-source.ts";
import {
  createUnionV2ScheduleRelationLookup,
  projectUnionV2CandidateUniverse,
  selectUnionV2Candidates,
  type UnionV2ScheduleRelationLookup,
} from "./union-v2-candidate-universe.ts";
import {
  createUnionV2FieldValueEvidenceProvider,
  type UnionV2FieldValueEvidenceProvider,
} from "./union-v2-field-value-provider.ts";
import type { ContinuationStats } from "./artifact-contract.ts";

export type CandidateSourceMode = "legacy" | "union-v2";

export interface CliOptions {
  readonly dataRoot: string;
  readonly factsRoot: string;
  readonly producerIndex: string;
  readonly tableMultiHop: string;
  readonly fieldLineage: string | null;
  readonly taskId: string;
  readonly targetTable: string;
  readonly writeObservationIds: readonly string[];
  readonly output: string;
  readonly summaryOutput: string | null;
  readonly htmlOutput: string | null;
  readonly fieldLineageHtmlHref: string | null;
  readonly maxTimeMs: number;
  readonly maxMemoryBytes: number;
  readonly maxBranches: number;
  readonly maxDepth: number;
  readonly maxStateUpdates: number;
  readonly maxNodeStates: number;
  readonly maxWitnessDepth: number;
  readonly candidateSource: CandidateSourceMode;
  readonly continuationIndex: string | null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
function fileHash(path: string): string {
  return sha256(readFileSync(path));
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve Task Pack documents the same way field-lineage / one-hop do:
 * scan every `tasks/<category>/<taskId>/task.json`, not only sparkIndex.
 * Ambiguous or missing packs stay empty so defaultSchema fails closed.
 */
export function createTaskPackDocumentReader(
  dataRoot: string,
): (taskId: string) => Record<string, unknown> {
  let index: ReadonlyMap<string, readonly string[]> | null = null;
  const cache = new Map<string, Record<string, unknown>>();
  return (taskId: string): Record<string, unknown> => {
    const cached = cache.get(taskId);
    if (cached) return cached;
    index ??= indexTaskInputPacks(dataRoot);
    const paths = index.get(taskId) ?? [];
    if (paths.length !== 1) {
      cache.set(taskId, {});
      return {};
    }
    try {
      const value = readJson(paths[0]!);
      const record =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      cache.set(taskId, record);
      return record;
    } catch {
      cache.set(taskId, {});
      return {};
    }
  };
}
function outputPath(path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}
function tableFromCatalog(entry: PhysicalTableCatalogEntry): {
  platform: string;
  dataSource: string;
  qualifiedName: string;
  stableTableId: string;
  identityStatus: string;
} {
  return {
    platform: entry.platform,
    dataSource: entry.dataSource,
    qualifiedName: entry.qualifiedName,
    stableTableId: entry.stableTableId,
    identityStatus: "SCHEMA_BACKED",
  };
}
function normalized(value: string): string {
  return value.trim().toLowerCase();
}
function samePhysicalTableName(left: string, right: string): boolean {
  const normalizedLeft = normalized(left);
  const normalizedRight = normalized(right);
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.includes(".") && normalizedRight.includes("."))
    return false;
  const leftTail = normalizedLeft.slice(normalizedLeft.lastIndexOf(".") + 1);
  const rightTail = normalizedRight.slice(normalizedRight.lastIndexOf(".") + 1);
  return leftTail === rightTail;
}
function isSameTaskSelfRead(
  load: CurrentBundleLoad,
  qualifiedName: string,
): boolean {
  if (!qualifiedName) return false;
  return records(load.records["dataset-io.jsonl"]).some(
    (record) =>
      normalized(String(record.direction ?? "")) === "write" &&
      samePhysicalTableName(
        String(record.physical_dataset ?? ""),
        qualifiedName,
      ),
  );
}
function uniqueFieldProducingWriteIds(
  load: CurrentBundleLoad,
  taskId: string,
  targetTable: string,
): readonly string[] {
  return [
    ...new Set(
      records(load.records["dataset-io.jsonl"])
        .filter(
          (record) =>
            normalized(String(record.direction ?? "")) === "write" &&
            record.field_producing === true &&
            normalized(String(record.task_id ?? "")) === normalized(taskId) &&
            normalized(String(record.physical_dataset ?? "")) ===
              normalized(targetTable),
        )
        .map((record) => String(record.write_observation_id ?? ""))
        .filter((id) => id.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}
function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}
function resolveCatalogTable(
  catalog: ReturnType<typeof loadPhysicalTableCatalog>,
  requested: string,
  task: Record<string, unknown>,
): PhysicalTableCatalogEntry {
  const key = normalized(requested);
  const exact = catalog.byQualifiedName.get(key) ?? [];
  if (exact.length === 1) return exact[0]!;
  const target =
    typeof task.target === "object" && task.target !== null
      ? (task.target as Record<string, unknown>)
      : {};
  const platform = text(target.platform)?.toLowerCase();
  const dataSource = text(target.dataSource)?.toLowerCase();
  const qualifiedName = text(target.qualifiedName)?.toLowerCase();
  const constrained = catalog.entries.filter(
    (entry) =>
      normalized(entry.qualifiedName) === key &&
      (!platform || entry.platform.toLowerCase() === platform) &&
      (!dataSource || entry.dataSource.toLowerCase() === dataSource) &&
      (!qualifiedName || normalized(entry.qualifiedName) === qualifiedName),
  );
  if (constrained.length === 1) return constrained[0]!;
  // A unique tail-name match is not a physical identity proof.  Do not turn
  // an unqualified table name into a SCHEMA_BACKED/confirmed target.
  throw new Error(`TARGET_TABLE_PHYSICAL_IDENTITY_UNRESOLVED:${requested}`);
}
export function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`ARGUMENT_VALUE_MISSING:${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value) throw new Error(`ARGUMENT_MISSING:${key}`);
    return value;
  };
  const budget = (key: string, fallback: number): number => {
    const value = values.get(key);
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0)
      throw new Error(`ARGUMENT_INVALID:${key}`);
    return parsed;
  };
  const candidateSource = values.get("candidate-source") ?? "legacy";
  if (candidateSource !== "legacy" && candidateSource !== "union-v2")
    throw new Error("ARGUMENT_INVALID:candidate-source");
  const continuationIndex = values.get("continuation-index") ?? null;
  if (candidateSource === "union-v2" && continuationIndex === null)
    throw new Error("ARGUMENT_MISSING:continuation-index");
  return {
    dataRoot: required("data-root"),
    factsRoot: required("facts-root"),
    producerIndex: values.get("writer-catalog") ?? required("producer-index"),
    tableMultiHop: required("table-multi-hop"),
    fieldLineage: values.get("field-lineage") ?? null,
    taskId: required("task-id"),
    targetTable: required("target-table"),
    writeObservationIds: (values.get("write-observation-id") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    output: required("output"),
    summaryOutput: values.get("summary-output") ?? null,
    htmlOutput: values.get("html-output") ?? null,
    fieldLineageHtmlHref: values.get("field-lineage-html-href") ?? null,
    maxTimeMs: budget("max-time-ms", 300_000),
    maxMemoryBytes: budget("max-memory-bytes", 1_073_741_824),
    maxBranches: budget("max-branches", 10_000),
    maxDepth: budget("max-depth", 25),
    maxStateUpdates: budget("max-state-updates", 100_000),
    maxNodeStates: budget("max-node-states", 50_000),
    maxWitnessDepth: budget("max-witness-depth", 25),
    candidateSource,
    continuationIndex,
  };
}

function statementOrdinal(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(?:^|:)statement:(\d+)(?::|$)/i);
  return match ? Number(match[1]) : null;
}

function canonicalSqlSourceId(value: string): string {
  const match = value.trim().match(/^(.*?):statement:\d+(?::|$)/i);
  return match?.[1] ?? value.trim();
}

function relationFromExpression(value: string | null): string | null {
  if (!value) return null;
  const marker = ":expression:";
  const index = value.indexOf(marker);
  return index > 0 ? value.slice(0, index) : null;
}

function producerWriteScope(
  load: CurrentBundleLoad,
  taskId: string,
  targetTable: string,
  writeObservationId: string,
): CandidateWriteScope | null {
  const bindings = records(load.records["output-field-bindings.jsonl"]).filter(
    (binding) =>
      String(binding.task_id ?? "") === taskId &&
      String(binding.write_observation_id ?? "") === writeObservationId &&
      normalized(String(binding.target_dataset ?? "")) ===
        normalized(targetTable),
  );
  const statementIds = new Set(
    bindings
      .map(
        (binding) =>
          text(binding.write_statement_id) ??
          text(binding.statement_id) ??
          text(binding.query_producer_statement_id),
      )
      .filter((value): value is string => value !== null),
  );
  const rootRelationIds = new Set(
    bindings
      .map((binding) => relationFromExpression(text(binding.expression_id)))
      .filter((value): value is string => value !== null),
  );
  const ordinals = new Set(
    [...statementIds]
      .map(statementOrdinal)
      .filter((value): value is number => value !== null),
  );
  if (
    statementIds.size !== 1 ||
    rootRelationIds.size !== 1 ||
    ordinals.size !== 1
  )
    return null;
  const rootRelationId = [...rootRelationIds][0]!;
  const rootStatement = statementOrdinal(rootRelationId);
  const writeStatement = [...ordinals][0]!;
  return {
    sqlSourceId: canonicalSqlSourceId([...statementIds][0]!),
    statementOrdinal: rootStatement ?? writeStatement,
    rootRelationId,
  };
}

function producerWritesForTable(
  load: CurrentBundleLoad,
  taskId: string,
  targetTable: string,
): readonly Record<string, unknown>[] {
  return [
    ...new Map(
      records(load.records["dataset-io.jsonl"])
        .filter(
          (record) =>
            normalized(String(record.direction ?? "")) === "write" &&
            normalized(String(record.task_id ?? "")) === normalized(taskId) &&
            normalized(String(record.physical_dataset ?? "")) ===
              normalized(targetTable) &&
            record.field_producing === true,
        )
        .map(
          (record) =>
            [String(record.write_observation_id ?? ""), record] as const,
        )
        .filter(([writeObservationId]) => writeObservationId.length > 0),
    ).values(),
  ];
}

function bindProducerWrite(
  branch: CandidateBranch,
  load: CurrentBundleLoad,
  write: Record<string, unknown>,
): CandidateBranch {
  const writeObservationId = String(write.write_observation_id);
  const writeScope = producerWriteScope(
    load,
    branch.producerTaskId!,
    branch.table!.qualifiedName!,
    writeObservationId,
  );
  return {
    ...branch,
    writeObservationId,
    ...(writeScope ? { writeScope } : {}),
    evidenceRefs: [
      ...branch.evidenceRefs,
      {
        evidenceRefId: `producer-write-evidence:${sha256(canonicalJson({ taskId: branch.producerTaskId, writeObservationId, table: branch.table }))}`,
        source: "MACHINE_FACTS_DATASET_IO",
        locator: `machine-facts:${branch.producerTaskId}:dataset-io.jsonl#write-observation:${writeObservationId}`,
      },
      ...(writeScope
        ? []
        : [
            {
              evidenceRefId: `producer-write-scope-gap:${sha256(canonicalJson({ taskId: branch.producerTaskId, writeObservationId, table: branch.table }))}`,
              source: "MACHINE_FACTS_OUTPUT_BINDINGS",
              locator: `machine-facts:${branch.producerTaskId}:output-field-bindings.jsonl#write-observation:${writeObservationId}`,
            },
          ]),
    ],
    gapRefs: writeScope
      ? branch.gapRefs
      : [
          ...new Set([
            ...branch.gapRefs,
            `bridge-gap:${branch.candidateBranchId}:PRODUCER_WRITE_SCOPE_UNRESOLVED`,
          ]),
        ],
  };
}

function enrichProducerWriteBridges(
  universe: CandidateUniverse,
  loadForTask: (taskId: string) => CurrentBundleLoad,
): {
  readonly universe: CandidateUniverse;
  readonly stats: {
    readonly resolved: number;
    readonly ambiguous: number;
    readonly missing: number;
  };
} {
  let resolved = 0;
  let ambiguous = 0;
  let missing = 0;
  const branches = universe.branches.flatMap(
    (branch): readonly CandidateBranch[] => {
      if (
        branch.branchKind !== "PHYSICAL_PRODUCER" ||
        !branch.producerTaskId ||
        !branch.table?.qualifiedName
      )
        return [branch];
      const load = loadForTask(branch.producerTaskId);
      const writes = producerWritesForTable(
        load,
        branch.producerTaskId,
        branch.table.qualifiedName,
      );
      if (writes.length === 0) {
        missing += 1;
        return [
          {
            ...branch,
            gapRefs: [
              ...new Set([
                ...branch.gapRefs,
                `bridge-gap:${branch.candidateBranchId}:PRODUCER_WRITE_OBSERVATION_MISSING`,
              ]),
            ],
          },
        ];
      }
      if (writes.length === 1) {
        resolved += 1;
        return [bindProducerWrite(branch, load, writes[0]!)];
      }
      // Preserve the legacy artifact count one write at a time. Union-v2 below
      // counts only L1-eligible candidates whose exact scope binds successfully.
      for (let index = 0; index < writes.length; index += 1) resolved += 1;
      return writes.map((write) => {
        const writeObservationId = String(write.write_observation_id);
        return bindProducerWrite(
          {
            ...branch,
            candidateBranchId: `${branch.candidateBranchId}:${writeObservationId}`,
          },
          load,
          write,
        );
      });
    },
  );
  return {
    universe: { ...universe, branches },
    stats: { resolved, ambiguous, missing },
  };
}

function unionContinuationGapRefs(
  branchId: string,
  entry: { readonly gaps: readonly { readonly reasonCode: string }[] },
  candidate: UnionContinuationIndexCandidate,
): readonly string[] {
  const codes = [
    ...entry.gaps.map((gap) => gap.reasonCode),
    candidate.alignmentGapCode,
    candidate.reasonCode,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(codes)]
    .sort((left, right) => left.localeCompare(right))
    .map((code) => `continuation-gap:${branchId}:${code}`);
}

function branchIdForWrite(
  branch: CandidateBranch,
  writeObservationId: string,
): string {
  return canonicalCandidateBranchId({ ...branch, writeObservationId });
}

function bindIndexedProducerWrite(
  branch: CandidateBranch,
  load: CurrentBundleLoad,
  candidate: UnionContinuationIndexCandidate,
  continuation: NonNullable<CandidateBranch["continuation"]>,
  indexEntryRef: string,
  entry: { readonly gaps: readonly { readonly reasonCode: string }[] },
): CandidateBranch {
  const writeObservationId = candidate.writeObservationId;
  const writeScope =
    branch.producerTaskId && branch.table?.qualifiedName
      ? producerWriteScope(
          load,
          branch.producerTaskId,
          branch.table.qualifiedName,
          writeObservationId,
        )
      : null;
  const scopeGap = writeScope
    ? []
    : [
        `bridge-gap:${branch.candidateBranchId}:PRODUCER_WRITE_SCOPE_UNRESOLVED`,
      ];
  return {
    ...branch,
    candidateBranchId: branchIdForWrite(branch, writeObservationId),
    writeObservationId,
    ...(writeScope ? { writeScope } : {}),
    continuation,
    evidenceRefs: [
      ...branch.evidenceRefs,
      {
        evidenceRefId: indexEntryRef,
        source: "UNION_CONTINUATION_INDEX",
        locator: indexEntryRef,
      },
      {
        evidenceRefId: `producer-write-evidence:${sha256(canonicalJson({ taskId: branch.producerTaskId, writeObservationId, table: branch.table }))}`,
        source: "MACHINE_FACTS_DATASET_IO",
        locator: `machine-facts:${branch.producerTaskId}:dataset-io.jsonl#write-observation:${writeObservationId}`,
      },
      ...(writeScope
        ? []
        : [
            {
              evidenceRefId: `producer-write-scope-gap:${sha256(canonicalJson({ taskId: branch.producerTaskId, writeObservationId, table: branch.table }))}`,
              source: "MACHINE_FACTS_OUTPUT_BINDINGS",
              locator: `machine-facts:${branch.producerTaskId}:output-field-bindings.jsonl#write-observation:${writeObservationId}`,
            },
          ]),
    ].filter(
      (value, index, all) =>
        all.findIndex(
          (other) => other.evidenceRefId === value.evidenceRefId,
        ) === index,
    ),
    gapRefs: [
      ...new Set([
        ...branch.gapRefs,
        ...unionContinuationGapRefs(branch.candidateBranchId, entry, candidate),
        ...scopeGap,
      ]),
    ],
  };
}

export function enrichUnionV2ProducerBridges(
  universe: CandidateUniverse,
  source: UnionContinuationCandidateSource,
  loadForTask: (taskId: string) => CurrentBundleLoad,
  scheduleRelation: UnionV2ScheduleRelationLookup,
): {
  readonly universe: CandidateUniverse;
  readonly stats: {
    readonly resolved: number;
    readonly ambiguous: number;
    readonly missing: number;
  };
  readonly continuationStats: ContinuationStats;
} {
  let resolved = 0;
  let ambiguous = 0;
  let missing = 0;
  const continuationStats = {
    l1: 0,
    l2Assumed: 0,
    l2Unknown: 0,
    piOnly: 0,
    disjointPruned: 0,
    ambiguousReads: 0,
    unmatchedReads: 0,
  } satisfies ContinuationStats;
  const ambiguousReadKeys = new Set<string>();
  const unmatchedReadKeys = new Set<string>();
  const branches = universe.branches.flatMap(
    (branch): readonly CandidateBranch[] => {
      if (branch.branchKind === "SCHEDULE_ONLY") return [];
      if (
        branch.branchKind !== "PHYSICAL_PRODUCER" ||
        !branch.producerTaskId ||
        !branch.table?.qualifiedName ||
        !branch.consumerTaskId ||
        !branch.readOccurrence
      )
        return [branch];
      const readKey = `${branch.consumerTaskId}\u0000${branch.readOccurrence.occurrenceId}`;
      const entry = source.entryForRead(
        branch.consumerTaskId,
        branch.readOccurrence.occurrenceId,
      );
      if (!entry) {
        if (!unmatchedReadKeys.has(readKey)) {
          unmatchedReadKeys.add(readKey);
          continuationStats.unmatchedReads += 1;
        }
        missing += 1;
        return [
          {
            ...branch,
            gapRefs: [
              ...new Set([
                ...branch.gapRefs,
                `continuation-gap:${branch.candidateBranchId}:CONTINUATION_READ_NOT_FOUND`,
              ]),
            ],
          },
        ];
      }
      const selection = selectUnionV2Candidates({
        source,
        scheduleRelation,
        consumerTaskId: branch.consumerTaskId,
        readOccurrenceId: branch.readOccurrence.occurrenceId,
        producerTaskId: branch.producerTaskId,
        qualifiedName: branch.table.qualifiedName,
        exactWriteObservationId: branch.writeObservationId,
      });
      const retainedCandidates = selection.candidates;
      continuationStats.disjointPruned += selection.disjointPruned;
      if (retainedCandidates.length >= 2 && !ambiguousReadKeys.has(readKey)) {
        ambiguousReadKeys.add(readKey);
        ambiguous += 1;
        continuationStats.ambiguousReads += 1;
      }
      if (retainedCandidates.length === 0) {
        if (selection.reason === "DISJOINT") return [];
        if (
          selection.reason === "SCHEDULE_RELATION_UNRESOLVED" ||
          selection.reason === "SCHEDULE_RELATION_NO_MATCH"
        ) {
          missing += 1;
          const boundary = {
            ...branch,
            branchKind: "UNBOUND_READ" as const,
            producerTaskId: null,
            producerRole: null,
            writeObservationId: null,
            writeScope: undefined,
            continuation: undefined,
            boundaryReason: selection.reason,
            gapRefs: [
              ...new Set([
                ...branch.gapRefs,
                `continuation-gap:${branch.candidateBranchId}:${selection.reason}`,
              ]),
            ],
          } satisfies Omit<CandidateBranch, "candidateBranchId">;
          return [
            {
              ...boundary,
              candidateBranchId: canonicalCandidateBranchId(boundary),
            },
          ];
        }
        missing += 1;
        return [
          {
            ...branch,
            gapRefs: [
              ...new Set([
                ...branch.gapRefs,
                `continuation-gap:${branch.candidateBranchId}:CONTINUATION_PRODUCER_NOT_FOUND`,
              ]),
            ],
          },
        ];
      }
      const retained = retainedCandidates.flatMap(
        (candidate): readonly CandidateBranch[] => {
          if (candidate.source === "PRODUCER_INDEX_ONLY")
            continuationStats.piOnly += 1;
          else if (
            candidate.l1Eligible &&
            candidate.partitionMatchStatus === "CONFIRMED" &&
            candidate.evidenceLayer === "L1"
          )
            continuationStats.l1 += 1;
          else if (candidate.partitionMatchStatus === "ASSUMED")
            continuationStats.l2Assumed += 1;
          else continuationStats.l2Unknown += 1;
          const indexEntryRef = continuationIndexEntryReference(
            source,
            branch.consumerTaskId!,
            branch.readOccurrence!.occurrenceId,
          );
          const continuation = {
            source: candidate.source,
            partitionMatchStatus: candidate.partitionMatchStatus,
            evidenceLayer: candidate.evidenceLayer,
            l1Eligible: candidate.l1Eligible,
            indexEntryRef,
          } satisfies NonNullable<CandidateBranch["continuation"]>;
          const loaded = loadForTask(branch.producerTaskId!);
          const bound = bindIndexedProducerWrite(
            branch,
            loaded,
            candidate,
            continuation,
            indexEntryRef,
            entry,
          );
          if (candidate.l1Eligible && bound.writeScope) resolved += 1;
          return [bound];
        },
      );
      return retained;
    },
  );
  return {
    universe: { ...universe, branches },
    stats: { resolved, ambiguous, missing },
    continuationStats,
  };
}

function sameTaskUpstreamWrites(
  load: CurrentBundleLoad,
  taskId: string,
  writeObservationId: string,
): readonly WriteScope[] {
  const write = records(load.records["dataset-io.jsonl"]).find(
    (record) =>
      normalized(String(record.direction ?? "")) === "write" &&
      String(record.write_observation_id ?? "") === writeObservationId &&
      normalized(String(record.task_id ?? "")) === normalized(taskId),
  );
  if (!write) return [];
  const statementId =
    text(write.write_statement_id) ?? text(write.statement_id);
  const writeTable = normalized(String(write.physical_dataset ?? ""));
  if (!statementId || !writeTable) return [];
  const readTables = [
    ...new Set(
      records(load.records["dataset-io.jsonl"])
        .filter(
          (record) =>
            normalized(String(record.direction ?? "")) === "read" &&
            normalized(String(record.task_id ?? "")) === normalized(taskId) &&
            String(record.statement_id ?? "") === statementId,
        )
        .map((record) => String(record.physical_dataset ?? ""))
        .filter(
          (table) => table.length > 0 && normalized(table) !== writeTable,
        ),
    ),
  ];
  return readTables.flatMap((table) =>
    producerWritesForTable(load, taskId, table).flatMap((producer) => {
      const id = String(producer.write_observation_id ?? "");
      if (!id || id === writeObservationId) return [];
      const scope = producerWriteScope(load, taskId, table, id);
      return scope ? [{ taskId, writeObservationId: id, ...scope }] : [];
    }),
  );
}

function buildSameTaskUpstreamWrites(
  taskIds: readonly string[],
  loadForTask: (taskId: string) => CurrentBundleLoad,
): ReadonlyMap<string, readonly WriteScope[]> {
  const map = new Map<string, readonly WriteScope[]>();
  for (const taskId of [...new Set(taskIds.filter(Boolean))]) {
    const load = loadForTask(taskId);
    for (const write of records(load.records["dataset-io.jsonl"])) {
      if (
        normalized(String(write.direction ?? "")) !== "write" ||
        write.field_producing !== true
      )
        continue;
      if (normalized(String(write.task_id ?? "")) !== normalized(taskId))
        continue;
      const id = String(write.write_observation_id ?? "");
      if (!id) continue;
      map.set(`${taskId}|${id}`, sameTaskUpstreamWrites(load, taskId, id));
    }
  }
  return map;
}

export function runTargetTableCausalClosure(
  options: CliOptions,
): TargetTableCausalClosureArtifact {
  const runStart = performance.now();
  const stages: CausalStageMetric[] = [];
  let peakMemoryBytes = process.memoryUsage().rss;
  const stage = (
    name: string,
    start: number,
    calls: number,
    cacheHits: number,
    cacheMisses: number,
    nodes: number,
    edges: number,
  ): void => {
    peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
    stages.push({
      stage: name,
      elapsedMs: Math.round(performance.now() - start),
      calls,
      cacheHits,
      cacheMisses,
      nodes,
      edges,
      peakMemoryBytes,
    });
  };
  const assertBudget = (stageName: string, branches = 0, depth = 0): void => {
    const elapsedMs = performance.now() - runStart;
    const memoryBytes = process.memoryUsage().rss;
    if (elapsedMs > options.maxTimeMs)
      throw new Error(
        `CAUSAL_BUDGET_EXCEEDED:${stageName}:TIME_MS=${Math.round(elapsedMs)}:MAX=${options.maxTimeMs}`,
      );
    if (memoryBytes > options.maxMemoryBytes)
      throw new Error(
        `CAUSAL_BUDGET_EXCEEDED:${stageName}:MEMORY_BYTES=${memoryBytes}:MAX=${options.maxMemoryBytes}`,
      );
    if (branches > options.maxBranches)
      throw new Error(
        `CAUSAL_BUDGET_EXCEEDED:${stageName}:BRANCHES=${branches}:MAX=${options.maxBranches}`,
      );
    if (depth > options.maxDepth)
      throw new Error(
        `CAUSAL_BUDGET_EXCEEDED:${stageName}:DEPTH=${depth}:MAX=${options.maxDepth}`,
      );
  };
  const loadStart = performance.now();
  const producerIndexHash = isLegacyProducerIndexPath(options.producerIndex)
    ? (() => {
        const producerIndex = readJson(options.producerIndex);
        validateTableProducerIndex(producerIndex);
        return fileHash(options.producerIndex);
      })()
    : catalogFingerprint(openWriterCatalog(options.producerIndex));
  const tableArtifact = readJson(options.tableMultiHop);
  validateMultiHopReconciliation(tableArtifact);
  const catalog = loadPhysicalTableCatalog(options.dataRoot, { lazyDdl: true });
  const taskJson = createTaskPackDocumentReader(options.dataRoot);
  const targetEntry = resolveCatalogTable(
    catalog,
    options.targetTable,
    taskJson(options.taskId),
  );
  const targetTable = tableFromCatalog(targetEntry);
  const rootReader = createCurrentTaskBundleReader(options.factsRoot, {
    requestedFiles: [
      "statements.jsonl",
      "relation-nodes.jsonl",
      "relation-edges.jsonl",
      "output-field-bindings.jsonl",
      "dataset-io.jsonl",
    ],
    validateOutputHashes: "requested",
  });
  const rootLoad = rootReader.load(options.taskId);
  stage("load", loadStart, 1, 0, 1, 0, 0);
  const snapshot: AnalysisSnapshotRef = {
    inputPackFingerprint:
      text(rootLoad.manifest?.input_fingerprint) ??
      text(rootLoad.manifest?.inputFingerprint) ??
      canonicalBundleIdentity(rootLoad),
    machineFactsHash:
      rootLoad.manifestSha256 ?? sha256(canonicalJson(rootLoad.records)),
    producerIndexHash,
    tableMultiHopHash: fileHash(options.tableMultiHop),
    ...(options.fieldLineage && existsSync(options.fieldLineage)
      ? { fieldLineageHash: fileHash(options.fieldLineage) }
      : {}),
    semanticRuleVersion: "target-table-causal-closure-native-v1",
  };
  const writeObservationIds =
    options.writeObservationIds.length > 0
      ? options.writeObservationIds
      : uniqueFieldProducingWriteIds(
          rootLoad,
          options.taskId,
          targetEntry.qualifiedName,
        );
  if (
    options.writeObservationIds.length === 0 &&
    writeObservationIds.length > 1
  ) {
    throw new Error("TARGET_WRITE_UNRESOLVED:TARGET_WRITE_AMBIGUOUS");
  }
  const targetResolution = resolveTargetWrite({
    taskId: options.taskId,
    targetTable: targetEntry.qualifiedName,
    writeObservationIds,
    load: rootLoad,
    snapshot,
  });
  if (!targetResolution.ref)
    throw new Error(
      `TARGET_WRITE_UNRESOLVED:${targetResolution.gaps.map((gap) => gap.reasonCode).join(",")}`,
    );
  assertBudget("target-write");
  const projectionStart = performance.now();
  let universe = projectTargetTableCandidateUniverse({
    targetWrite: targetResolution.ref,
    tableArtifact,
    targetTable,
    resolvePhysicalTable: (table) => {
      if (table.stableTableId) {
        const match = catalog.entries.find(
          (entry) => entry.stableTableId === table.stableTableId,
        );
        if (match) return tableFromCatalog(match);
      }
      const matches = table.qualifiedName
        ? (catalog.byQualifiedName.get(normalized(table.qualifiedName)) ?? [])
        : [];
      return matches.length === 1 ? tableFromCatalog(matches[0]!) : table;
    },
  });
  const taskLoads = new Map<string, ReturnType<typeof rootReader.load>>([
    [options.taskId, rootLoad],
  ]);
  const loadForTask = (taskId: string): ReturnType<typeof rootReader.load> => {
    const cached = taskLoads.get(taskId);
    if (cached) return cached;
    const loaded = rootReader.load(taskId);
    taskLoads.set(taskId, loaded);
    return loaded;
  };
  let bridgeEnrichmentStats: {
    readonly resolved: number;
    readonly ambiguous: number;
    readonly missing: number;
  };
  let continuationStats: ContinuationStats | undefined;
  let unionV2FieldProvider: UnionV2FieldValueEvidenceProvider | undefined;
  if (options.candidateSource === "union-v2") {
    if (!options.continuationIndex)
      throw new Error("ARGUMENT_MISSING:continuation-index");
    const continuationSource = loadUnionContinuationCandidateSource(
      options.continuationIndex,
    );
    const scheduleRelation = createUnionV2ScheduleRelationLookup(tableArtifact);
    universe = normalizeReadScopes(universe, loadForTask, {
      canonicalizePlaceholderOccurrences: true,
    });
    const projected = projectUnionV2CandidateUniverse({
      rootTaskId: options.taskId,
      baseUniverse: universe,
      source: continuationSource,
      scheduleRelation,
      isSameTaskSelfRead: (consumerTaskId, qualifiedName) =>
        isSameTaskSelfRead(loadForTask(consumerTaskId), qualifiedName),
      resolvePhysicalTable: (table) => {
        if (table.stableTableId) {
          const match = catalog.entries.find(
            (entry) => entry.stableTableId === table.stableTableId,
          );
          if (match) return tableFromCatalog(match);
        }
        const matches = table.qualifiedName
          ? (catalog.byQualifiedName.get(normalized(table.qualifiedName)) ?? [])
          : [];
        return matches.length === 1 ? tableFromCatalog(matches[0]!) : table;
      },
    });
    universe = projected.universe;
    const enriched = enrichUnionV2ProducerBridges(
      universe,
      continuationSource,
      loadForTask,
      scheduleRelation,
    );
    universe = enriched.universe;
    bridgeEnrichmentStats = enriched.stats;
    continuationStats = {
      ...enriched.continuationStats,
      disjointPruned:
        enriched.continuationStats.disjointPruned + projected.disjointPruned,
      unmatchedReads:
        enriched.continuationStats.unmatchedReads + projected.unmatchedReads,
      selfReadBoundaries: projected.selfReadBoundaries,
    };
    unionV2FieldProvider = createUnionV2FieldValueEvidenceProvider({
      legacyProvider: createFieldValueEvidenceProvider(options.fieldLineage),
      source: continuationSource,
      branches: universe.branches,
      loadForTask,
    });
  } else {
    const enriched = enrichProducerWriteBridges(universe, loadForTask);
    universe = normalizeReadScopes(enriched.universe, loadForTask);
    bridgeEnrichmentStats = enriched.stats;
  }
  stage(
    "candidate-projection",
    projectionStart,
    1,
    0,
    1,
    universe.branches.length,
    universe.branches.length,
  );
  assertBudget(
    "candidate-projection",
    universe.branches.length,
    Math.max(
      0,
      ...universe.branches.map(
        (branch) => branch.readOccurrence?.relationPath?.length ?? 0,
      ),
    ),
  );
  const sameTaskUpstreamWrites = buildSameTaskUpstreamWrites(
    [
      options.taskId,
      ...universe.branches.flatMap((branch) =>
        [branch.consumerTaskId, branch.producerTaskId].filter(
          (value): value is string => value !== null,
        ),
      ),
    ],
    loadForTask,
  );
  const summaries = new Map<
    string,
    ReturnType<typeof summarizeTaskRelations>
  >();
  const summaryStart = performance.now();
  const scopes = [
    {
      taskId: targetResolution.ref.identity.taskId,
      sqlSourceId: targetResolution.ref.identity.sqlSourceId,
      statementIndex: targetResolution.ref.identity.statementOrdinal,
      rootRelationId: targetResolution.ref.identity.rootRelationId,
    },
    ...universe.branches
      .filter(
        (
          branch,
        ): branch is CandidateBranch & {
          readonly consumerTaskId: string;
          readonly readOccurrence: NonNullable<
            CandidateBranch["readOccurrence"]
          >;
        } => branch.consumerTaskId !== null && branch.readOccurrence !== null,
      )
      .map((branch) => ({
        taskId: branch.consumerTaskId,
        sqlSourceId:
          branch.readOccurrence.sqlSourceId ??
          branch.readOccurrence.occurrenceId,
        statementIndex: branch.readOccurrence.statementIndex,
        rootRelationId: branch.readOccurrence.rootRelationId ?? null,
      })),
    ...[...sameTaskUpstreamWrites.values()].flat().map((scope) => ({
      taskId: scope.taskId,
      sqlSourceId: scope.sqlSourceId,
      statementIndex: scope.statementOrdinal,
      rootRelationId: scope.rootRelationId,
    })),
  ];
  let summaryCacheHits = 0;
  for (const scope of scopes) {
    if (
      !scope.taskId ||
      scope.sqlSourceId == null ||
      !Number.isSafeInteger(scope.statementIndex)
    )
      continue;
    const key = relationSummaryKey(
      scope.taskId,
      scope.sqlSourceId,
      scope.statementIndex,
      scope.rootRelationId,
    );
    if (summaries.has(key)) {
      summaryCacheHits += 1;
      continue;
    }
    const load = loadForTask(scope.taskId);
    summaries.set(
      key,
      summarizeTaskRelations({
        taskId: scope.taskId,
        sqlSourceId: scope.sqlSourceId,
        statementIndex: scope.statementIndex,
        rootRelationId: scope.rootRelationId ?? undefined,
        relationRecords: load.records["relation-nodes.jsonl"] ?? [],
        relationEdgeRecords: load.records["relation-edges.jsonl"] ?? [],
        statementRecords: load.records["statements.jsonl"] ?? [],
        defaultSchema: inferTaskDefaultSchema(taskJson(scope.taskId)),
      }),
    );
  }
  stage(
    "semantic-summary",
    summaryStart,
    scopes.length,
    summaryCacheHits,
    scopes.length - summaryCacheHits,
    summaries.size,
    [...summaries.values()].reduce((sum, value) => sum + value.edgeCount, 0),
  );
  assertBudget("semantic-summary", universe.branches.length);
  const providerStart = performance.now();
  const fieldProvider =
    unionV2FieldProvider ??
    createFieldValueEvidenceProvider(options.fieldLineage);
  stage(
    "field-value-index",
    providerStart,
    1,
    0,
    1,
    0,
    fieldProvider.edgeCount,
  );
  assertBudget("field-value-index", universe.branches.length);
  const graphStart = performance.now();
  const graph = buildImpactGraph(universe.branches, summaries);
  stage(
    "impact-graph",
    graphStart,
    1,
    0,
    1,
    graph.taskIds.length,
    graph.localEdges.length + graph.bridgeEdges.length,
  );
  assertBudget("impact-graph", universe.branches.length);
  const propagationStart = performance.now();
  const closure = buildCausalClosure({
    targetWriteId: targetResolution.ref!.identity.targetWriteId,
    rootTaskId: options.taskId,
    universe,
    summaries,
    fieldValueProvider: fieldProvider,
    rootWriteScope: {
      taskId: targetResolution.ref.identity.taskId,
      writeObservationId: targetResolution.ref.identity.writeObservationId,
      sqlSourceId: targetResolution.ref.identity.sqlSourceId,
      statementOrdinal: targetResolution.ref.identity.statementOrdinal,
      rootRelationId: targetResolution.ref.identity.rootRelationId,
    },
    sameTaskUpstreamWrites,
    budget: {
      deadlineAt: runStart + options.maxTimeMs,
      maxStateUpdates: options.maxStateUpdates,
      maxNodeStates: options.maxNodeStates,
      maxWitnessDepth: options.maxWitnessDepth,
    },
    baseGraph: graph,
  });
  const assessments = closure.assessments;
  stage(
    "propagation",
    propagationStart,
    1,
    0,
    1,
    closure.graph.reachableTaskIds.length,
    closure.graph.branchEdges.length,
  );
  assertBudget("propagation", universe.branches.length);
  const validationStart = performance.now();
  const validation = validateCausalClosure({
    targetWriteId: targetResolution.ref.identity.targetWriteId,
    universe,
    assessments,
  });
  if (!validation.valid)
    throw new Error(`CAUSAL_CLOSURE_INVALID:${validation.errors.join(",")}`);
  stage("validation", validationStart, 1, 0, 1, assessments.length, 0);
  assertBudget("validation", universe.branches.length);
  const confirmed = assessments.filter(
    (assessment) => assessment.relationStatus === "CONFIRMED_RELATED",
  );
  const closureRate =
    confirmed.length === 0
      ? "NOT_APPLICABLE"
      : confirmed.every(
            (assessment) =>
              assessment.candidateBranchId.startsWith(
                "target-table-root-write:",
              ) ||
              assessment.channelAssessments.some(
                (channel) =>
                  channel.status === "CONFIRMED" &&
                  channel.witnessRefs.length > 0,
              ),
          )
        ? 1
        : 0;
  const branchesById = new Map(
    universe.branches.map((branch) => [branch.candidateBranchId, branch]),
  );
  const writeScopedConfirmedCount = confirmed.filter((assessment) => {
    const branch = branchesById.get(assessment.candidateBranchId);
    if (!branch) return false;
    if (branch.branchKind === "ROOT_WRITE") return true;
    return Boolean(
      branch.writeObservationId &&
      branch.writeScope &&
      assessment.channelAssessments.some(
        (channel) =>
          channel.status === "CONFIRMED" && channel.witnessRefs.length > 0,
      ),
    );
  }).length;
  const crossChannelConfirmedBranchCount = assessments.filter((assessment) =>
    assessment.channelAssessments.some(
      (channel) =>
        (channel.channel === "ROW_MEMBERSHIP" ||
          channel.channel === "MULTIPLICITY") &&
        channel.status === "CONFIRMED" &&
        channel.localTransferKinds?.includes("VALUE_FLOW"),
    ),
  ).length;
  const unknownReasonCounts = assessments
    .filter((assessment) => assessment.relationStatus === "UNKNOWN")
    .flatMap((assessment) =>
      unknownReasonCodesForAssessment(
        branchesById.get(assessment.candidateBranchId),
        assessment,
      ),
    )
    .reduce<Record<string, number>>(
      (counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }),
      {},
    );
  const gapCandidates = [
    ...targetResolution.gaps.map((gap) => ({
      gapId: gap.gapId,
      reasonCode: gap.reasonCode,
      message: gap.message,
      evidenceRefs: gap.evidenceRefs,
    })),
    ...universe.boundaryGapRefs.map((gapId) => ({
      gapId,
      reasonCode: "CANDIDATE_UNIVERSE_BOUNDARY",
      message: `candidate universe boundary: ${gapId}`,
      evidenceRefs: [] as string[],
    })),
    ...[...summaries.values()].flatMap((summary) =>
      summary.gaps.map((gapId) => ({
        gapId,
        reasonCode: "TASK_RELATION_SUMMARY_UNKNOWN",
        message: `relation summary incomplete: ${gapId}`,
        evidenceRefs: [] as string[],
      })),
    ),
    ...closure.gaps,
    ...assessments.flatMap((assessment) =>
      assessment.gapRefs.map((gapId) => ({
        gapId,
        reasonCode: "CAUSAL_EVIDENCE_INCOMPLETE",
        message: `causal evidence incomplete: ${gapId}`,
        evidenceRefs: assessment.evidenceRefs,
      })),
    ),
  ];
  const gaps = [
    ...new Map(gapCandidates.map((gap) => [gap.gapId, gap])).values(),
  ].sort((a, b) => a.gapId.localeCompare(b.gapId));
  const bridgeStats = {
    resolved: bridgeEnrichmentStats.resolved,
    ambiguous: bridgeEnrichmentStats.ambiguous,
    missing:
      bridgeEnrichmentStats.missing +
      universe.branches.filter(
        (branch) =>
          branch.branchKind === "UNBOUND_READ" ||
          branch.branchKind === "BLOCKED_READ" ||
          branch.branchKind === "COVERAGE_BOUNDARY",
      ).length,
  };
  peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
  const raw: Omit<TargetTableCausalClosureArtifact, "contentHash"> = {
    schemaVersion: TARGET_TABLE_CAUSAL_CLOSURE_SCHEMA_VERSION,
    artifactType: TARGET_TABLE_CAUSAL_CLOSURE_ARTIFACT_TYPE,
    generatedAt: new Date().toISOString(),
    targetWrite: targetResolution.ref,
    candidateUniverse: universe,
    assessments,
    taskRollup: closure.taskRollup,
    minimumCertainTaskIds: closure.minimumCertainTaskIds,
    conservativeSafetyTaskIds: closure.conservativeSafetyTaskIds,
    runtimeRerunDecision: "NOT_EVALUATED",
    shrinkReport: buildShrinkReport({
      branches: universe.branches,
      assessments,
      ...(unionV2FieldProvider
        ? {
            unionV2ValueCertainBranchIds:
              unionV2FieldProvider.valueCertainBranchIds,
          }
        : {}),
    }),
    relationSummaries: [...summaries.values()].map((summary) => ({
      taskId: summary.taskId,
      sqlSourceId: summary.sqlSourceId,
      statementIndex: summary.statementIndex,
      rootRelationId: summary.rootRelationId,
      digest: summary.digest,
      complete: summary.complete,
      gapCount: summary.gaps.length,
    })),
    metrics: {
      candidateBranchCount: universe.branches.length,
      assessmentCount: assessments.length,
      upstreamTaskCount: closure.taskRollup.length,
      fieldValueEvidenceScanCount: fieldProvider.scanCount,
      evidenceClosureRate: closureRate,
      decisionCoverage: {
        numerator: assessments.length,
        denominator: universe.branches.length,
        rate:
          universe.branches.length === 0
            ? 1
            : assessments.length / universe.branches.length,
      },
      bridgeStats,
      ...(continuationStats ? { continuationStats } : {}),
      peakMemoryBytes,
      confirmedAssessmentCount: confirmed.length,
      writeScopedConfirmedCount,
      crossChannelConfirmedBranchCount,
      crossWriteScopeLeakCount: closure.writeScopeLeakCount,
      unknownReasonCounts,
    },
    stages,
    gaps,
  };
  return canonicalizeTargetTableArtifact(raw);
}

export function main(argv = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  const artifact = runTargetTableCausalClosure(options);
  outputPath(options.output);
  writeFileSync(
    options.output,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  const summary = formatTargetTableCausalSummary(artifact);
  if (options.summaryOutput) {
    outputPath(options.summaryOutput);
    writeFileSync(options.summaryOutput, `${summary}\n`, "utf8");
  }
  if (options.htmlOutput) {
    outputPath(options.htmlOutput);
    writeFileSync(
      options.htmlOutput,
      renderTargetTableCausalHtml(artifact, {
        ...(options.fieldLineageHtmlHref
          ? { fieldLineageHtmlHref: options.fieldLineageHtmlHref }
          : {}),
      }),
      "utf8",
    );
  }
  console.log(summary);
}

if (
  process.argv[1] &&
  basename(process.argv[1]).startsWith("reconcile-target-table-causal-closure")
)
  main();
