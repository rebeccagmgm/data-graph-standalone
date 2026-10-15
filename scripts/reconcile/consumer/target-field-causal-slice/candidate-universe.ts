import {
  canonicalJson,
  normalizeName,
  sha256,
  type JsonValue,
} from "../../../machine-facts/machine-facts-contract.ts";
import type { RootCriterion } from "./write-scoped-plan-inputs.ts";
import {
  isCheckdbflagTask,
  isNonHiveProducerBoundary,
  isOutOfScopePhysicalRead,
  isOutOfScopeTerminalReason,
  isSameTaskScratchProducerBridge,
  isSameTaskScratchTable,
} from "../../shared/lineage-scope.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

export const CANDIDATE_BRANCH_KINDS = [
  "ROOT_WRITE",
  "PHYSICAL_PRODUCER",
  "SCHEDULE_ONLY",
  "UNBOUND_READ",
  "BLOCKED_READ",
  "COVERAGE_BOUNDARY",
] as const;
export type CandidateBranchKind = (typeof CANDIDATE_BRANCH_KINDS)[number];

export type CandidateUniverseStatus =
  | "COMPLETE_OBSERVED_EVIDENCE"
  | "INCOMPLETE";

export interface CandidateReadOccurrence {
  readonly occurrenceId: string;
  readonly readRelationId: string;
  /** Canonical SQL source/slot identity, independent of statement ordinal. */
  readonly sqlSourceId?: string | null;
  readonly statementIndex: number;
  /** Optional exact write-root relation proven to contain this read. */
  readonly rootRelationId?: string | null;
  readonly relationPath: readonly string[];
}

/** Canonical write scope used to prove which SQL write owns a read branch. */
export interface CandidateWriteScope {
  readonly sqlSourceId: string;
  readonly statementOrdinal: number;
  readonly rootRelationId: string;
}

export interface CandidatePhysicalTable {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string | null;
  readonly stableTableId: string | null;
  readonly identityStatus: string | null;
}

export interface CandidateEvidenceRef {
  readonly evidenceRefId: string;
  readonly source: string | null;
  readonly locator: string | null;
}

/** Read-only continuation evidence attached by the union-v2 consumer path. */
export interface CandidateContinuation {
  readonly source: "IN_UNION_FINAL_WRITE" | "PRODUCER_INDEX_ONLY";
  readonly partitionMatchStatus: "CONFIRMED" | "ASSUMED" | "UNKNOWN" | "DISJOINT";
  readonly evidenceLayer: "L1" | "L2";
  readonly l1Eligible: boolean;
  readonly indexEntryRef: string;
}

export interface CandidateBranch {
  readonly candidateBranchId: string;
  readonly branchKind: CandidateBranchKind;
  readonly rootTaskId: string;
  readonly consumerTaskId: string | null;
  readonly producerTaskId: string | null;
  readonly table: CandidatePhysicalTable | null;
  readonly readOccurrence: CandidateReadOccurrence | null;
  /** Exact root WRITE criterion; null for non-root branches. */
  readonly writeObservationId?: string | null;
  /** Evidence judgment is metadata and deliberately excluded from branch ID. */
  readonly producerRole: string | null;
  /** Exact producer write scope; absent means the bridge cannot be propagated. */
  readonly writeScope?: CandidateWriteScope | null;
  readonly evidenceRefs: readonly CandidateEvidenceRef[];
  readonly gapRefs: readonly string[];
  readonly boundaryReason: string | null;
  readonly continuation?: CandidateContinuation;
}

export interface CandidateUniverse {
  readonly rootTaskId: string;
  readonly status: CandidateUniverseStatus;
  readonly branches: readonly CandidateBranch[];
  readonly boundaryGapRefs: readonly string[];
  readonly coverage: Readonly<{
    readonly sourceArtifactType: string;
    readonly sourceCoverageStatus: string | null;
    readonly sourceCoverageSemantics: string | null;
    readonly sourceLimitsTruncated: boolean;
  }>;
}

export interface CandidateUniverseProjectionInput {
  /** @deprecated Candidate projection is table-scoped; prefer rootCriteria. */
  readonly rootTargetFields?: readonly string[];
  readonly tableArtifact: unknown;
  /** Canonical path: exact write/output occurrences for ROOT_WRITE branches. */
  readonly rootCriteria?: readonly RootCriterion[];
  /** @deprecated Use rootCriteria; observation ids alone cannot prove the target table. */
  readonly rootWriteObservationIds?: readonly string[];
  /** Resolve table-level artifacts that predate stable physical identities. */
  readonly resolvePhysicalTable?: (
    table: CandidatePhysicalTable,
  ) => CandidatePhysicalTable | null;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function records(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is JsonRecord => item !== null)
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function tableOf(value: unknown): CandidatePhysicalTable | null {
  const source = record(value);
  if (!source) return null;
  return {
    platform: text(source.platform),
    dataSource: text(source.dataSource),
    qualifiedName: text(source.qualifiedName),
    stableTableId: text(source.stableTableId),
    identityStatus: text(source.identityStatus),
  };
}

function tableIdentity(table: CandidatePhysicalTable | null): JsonValue {
  if (!table) return null;
  return {
    platform: table.platform,
    dataSource: table.dataSource,
    qualifiedName: table.qualifiedName,
    stableTableId: table.stableTableId,
    identityStatus: table.identityStatus,
  };
}

/** Physical identity is stable; resolution status is mutable evidence metadata. */
function stableTableIdentity(table: CandidatePhysicalTable | null): JsonValue {
  if (!table) return null;
  return {
    platform: table.platform,
    dataSource: table.dataSource,
    qualifiedName: table.qualifiedName,
    stableTableId: table.stableTableId,
  };
}

function tableKey(table: CandidatePhysicalTable | null): string {
  return canonicalJson(stableTableIdentity(table));
}

function occurrenceOf(value: unknown): CandidateReadOccurrence | null {
  const source = record(value);
  if (!source) return null;
  const occurrenceId = text(source.occurrenceId);
  const readRelationId = text(source.readRelationId);
  const sqlSourceId = text(source.sqlSourceId) ?? text(source.sql_source_id) ??
    text(source.statementId) ?? text(source.statement_id);
  const statementIndex = integer(source.statementIndex);
  const rootRelationId = text(source.rootRelationId) ?? text(source.root_relation_id);
  const relationPath = Array.isArray(source.relationPath)
    ? source.relationPath.filter((item): item is string => typeof item === "string")
    : [];
  if (
    occurrenceId === null ||
    readRelationId === null ||
    statementIndex === null ||
    relationPath.length === 0
  )
    return null;
  return {
    occurrenceId,
    readRelationId,
    ...(sqlSourceId ? { sqlSourceId: canonicalSqlSourceId(sqlSourceId) } : {}),
    statementIndex,
    ...(rootRelationId ? { rootRelationId } : {}),
    relationPath,
  };
}

/** Keep SQL slot identity separate from the statement ordinal. */
function canonicalSqlSourceId(value: string): string {
  const normalized = value.trim();
  const statement = normalized.match(/^(.*?):statement:\d+(?::|$)/i);
  if (statement?.[1]) return statement[1];
  const relation = normalized.match(/^(.*?):relation:/i);
  if (relation?.[1]) return relation[1];
  const query = normalized.match(/^(query#\d+)(?::|$)/i);
  return query?.[1] ?? normalized;
}

function occurrenceIdentity(occurrence: CandidateReadOccurrence | null): JsonValue {
  if (!occurrence) return null;
  return {
    occurrenceId: occurrence.occurrenceId,
    readRelationId: occurrence.readRelationId,
    sqlSourceId: occurrence.sqlSourceId ?? null,
    statementIndex: occurrence.statementIndex,
    ...(occurrence.rootRelationId ? { rootRelationId: occurrence.rootRelationId } : {}),
    relationPath: [...occurrence.relationPath],
  };
}

function evidenceRefsOf(value: unknown): readonly CandidateEvidenceRef[] {
  return records(value)
    .map((item) => {
      const source = text(item.source);
      const locator = text(item.locator);
      if (source === null && locator === null) return null;
      const evidenceRefId = `candidate-evidence:${sha256(
        canonicalJson({ source, locator } as JsonValue),
      )}`;
      return { evidenceRefId, source, locator } satisfies CandidateEvidenceRef;
    })
    .filter((item): item is CandidateEvidenceRef => item !== null)
    .sort((a, b) => a.evidenceRefId.localeCompare(b.evidenceRefId));
}

function writeEvidenceRefs(value: unknown): readonly CandidateEvidenceRef[] {
  return records(value).flatMap((write) => evidenceRefsOf(write.evidence));
}

function gapId(
  rootTaskId: string,
  kind: string,
  identity: JsonValue,
): string {
  return `candidate-gap:${rootTaskId}:${kind}:${sha256(canonicalJson(identity))}`;
}

function branchId(
  rootTaskId: string,
  branchKind: CandidateBranchKind,
  identity: JsonValue,
): string {
  return `candidate-branch:${branchKind.toLowerCase()}:${sha256(
    canonicalJson({ rootTaskId, branchKind, identity } as unknown as JsonValue),
  )}`;
}

function branchIdentity(input: {
  readonly branchKind: CandidateBranchKind;
  readonly consumerTaskId: string | null;
  readonly producerTaskId: string | null;
  readonly table: CandidatePhysicalTable | null;
  readonly readOccurrence: CandidateReadOccurrence | null;
  readonly writeObservationId: string | null;
  readonly boundaryReason: string | null;
}): JsonValue {
  return {
    branchKind: input.branchKind,
    consumerTaskId: input.consumerTaskId,
    producerTaskId: input.producerTaskId,
    table: stableTableIdentity(input.table),
    readOccurrence: occurrenceIdentity(input.readOccurrence),
    writeObservationId: input.writeObservationId,
    boundaryReason: input.boundaryReason,
  };
}

export function canonicalCandidateBranchId(
	branch: Pick<
		CandidateBranch,
		| "rootTaskId"
		| "branchKind"
		| "consumerTaskId"
		| "producerTaskId"
		| "table"
		| "readOccurrence"
		| "writeObservationId"
		| "boundaryReason"
	>,
): string {
	return branchId(
		branch.rootTaskId,
		branch.branchKind,
		branchIdentity({
			branchKind: branch.branchKind,
			consumerTaskId: branch.consumerTaskId,
			producerTaskId: branch.producerTaskId,
			table: branch.table,
			readOccurrence: branch.readOccurrence,
			writeObservationId: branch.writeObservationId ?? null,
			boundaryReason: branch.boundaryReason,
		}),
	);
}

function makeBranch(input: {
  readonly rootTaskId: string;
  readonly branchKind: CandidateBranchKind;
  readonly consumerTaskId?: string | null;
  readonly producerTaskId?: string | null;
  readonly table?: CandidatePhysicalTable | null;
  readonly readOccurrence?: CandidateReadOccurrence | null;
  readonly writeObservationId?: string | null;
  readonly producerRole?: string | null;
  readonly evidenceRefs?: readonly CandidateEvidenceRef[];
  readonly gapRefs?: readonly string[];
  readonly boundaryReason?: string | null;
  readonly resolvePhysicalTable?: (
    table: CandidatePhysicalTable,
  ) => CandidatePhysicalTable | null;
}): CandidateBranch {
  const consumerTaskId = input.consumerTaskId ?? null;
  const producerTaskId = input.producerTaskId ?? null;
  const sourceTable = input.table ?? null;
  const table = sourceTable === null
    ? null
    : input.resolvePhysicalTable?.(sourceTable) ?? sourceTable;
  const readOccurrence = input.readOccurrence ?? null;
  const writeObservationId = input.writeObservationId ?? null;
  const boundaryReason = input.boundaryReason ?? null;
	const branchInput = {
		branchKind: input.branchKind,
		rootTaskId: input.rootTaskId,
    consumerTaskId,
    producerTaskId,
    table,
    readOccurrence,
    writeObservationId,
    producerRole: input.producerRole ?? null,
    evidenceRefs: [...(input.evidenceRefs ?? [])].sort((a, b) =>
      a.evidenceRefId.localeCompare(b.evidenceRefId),
    ),
		gapRefs: sortedUnique(input.gapRefs ?? []),
		boundaryReason,
	};
	return {
		candidateBranchId: canonicalCandidateBranchId(branchInput),
		...branchInput,
	};
}

function readKey(
  consumerTaskId: string | null,
  table: CandidatePhysicalTable | null,
  occurrence: CandidateReadOccurrence | null,
): string {
  return canonicalJson({
    consumerTaskId,
    table: tableIdentity(table),
    occurrence: occurrenceIdentity(occurrence),
  } as JsonValue);
}

function bridgeMatchesRead(
  bridge: JsonRecord,
  read: JsonRecord,
  readTable: CandidatePhysicalTable | null,
): boolean {
  if (text(bridge.consumerTaskId) !== text(read.consumerTaskId)) return false;
  if (tableKey(tableOf(bridge.table)) !== tableKey(readTable)) return false;
  if (text(bridge.producerTaskId) === null) return false;
  const readOccurrence = occurrenceOf(read.readOccurrence);
  // Table multi-hop readEdges are consumer+table grain and do not carry
  // occurrence. A producer bridge for that pair already covers the read.
  if (readOccurrence === null) return true;
  const bridgeOccurrence = occurrenceOf(bridge.readOccurrence);
  if (bridgeOccurrence === null) return false;
  return canonicalJson(occurrenceIdentity(bridgeOccurrence)) ===
    canonicalJson(occurrenceIdentity(readOccurrence));
}

function readIsBlocked(read: JsonRecord): boolean {
  const status = text(read.recursionStatus);
  return (
    status === "BLOCKED" ||
    (Array.isArray(read.blockedStatementIndexes) &&
      read.blockedStatementIndexes.length > 0) ||
    (Array.isArray(read.blockReasons) && read.blockReasons.length > 0) ||
    tableOf(read.table)?.identityStatus === "UNRESOLVED"
  );
}

function boundaryTerminalReason(value: unknown): string | null {
  const reason = text(value);
  if (reason === null) return null;
  if (
    reason.startsWith("MAX_") ||
    reason === "NO_CONFIRMED_PRODUCER_OBSERVED" ||
    reason === "MULTIPLE_OVERLAPPING_PRODUCERS" ||
    reason === "TASK_INPUT_PACK_UNAVAILABLE" ||
    reason === "TASK_INPUT_PACK_INVALID" ||
    reason === "TABLE_PACK_UNAVAILABLE" ||
    reason === "TABLE_PACK_INVALID" ||
    reason === "READ_IDENTITY_UNRESOLVED"
  )
    return reason;
  return null;
}

function isCheckdbflagProducer(artifact: JsonRecord, producerTaskId: string): boolean {
  return records(artifact.taskNodes).some((node) => {
    if (text(node.taskId) !== producerTaskId) return false;
    return isCheckdbflagTask({
      taskCategory: node.taskCategory,
      taskName: node.taskName,
      locators: records(node.evidence).map((item) => item.locator),
    });
  });
}

function sourceArtifactType(artifact: JsonRecord): string {
  return text(artifact.artifactType) ?? "TABLE_MULTI_HOP_RECONCILIATION";
}

function rootTableForCriterion(criterion: RootCriterion): CandidatePhysicalTable {
  const parts = criterion.rootTargetFieldId.split("|");
  if (parts.length < 5)
    throw new Error(`ROOT_CRITERION_PHYSICAL_FIELD_INVALID:${criterion.rootCriterionId}`);
  const [platform, dataSource, stableTableId, qualifiedName] = parts;
  const targetKey = criterion.targetTableKey.split("|");
  if (
    targetKey.length !== 3 ||
    [platform, dataSource, qualifiedName].some(
      (value, index) =>
        normalizeName(value ?? "") !== normalizeName(targetKey[index] ?? ""),
    )
  )
    throw new Error(`ROOT_CRITERION_TARGET_TABLE_MISMATCH:${criterion.rootCriterionId}`);
  return {
    platform: platform!,
    dataSource: dataSource!,
    stableTableId: stableTableId!,
    qualifiedName: qualifiedName!,
    identityStatus: "ROOT_CRITERION",
  };
}

function samePhysicalTable(
  left: CandidatePhysicalTable | null,
  right: CandidatePhysicalTable | null,
): boolean {
  if (!left || !right) return false;
  const leftIdentity = [
    left.platform,
    left.dataSource,
    left.stableTableId,
    left.qualifiedName,
  ];
  const rightIdentity = [
    right.platform,
    right.dataSource,
    right.stableTableId,
    right.qualifiedName,
  ];
  return leftIdentity.every(
    (value, index) =>
      normalizeName(value ?? "") === normalizeName(rightIdentity[index] ?? ""),
  );
}

export function projectCandidateUniverse(
  input: CandidateUniverseProjectionInput,
): CandidateUniverse {
  const artifact = record(input.tableArtifact);
  if (!artifact) throw new Error("TABLE_MULTI_HOP_ARTIFACT_INVALID");
  const rootTaskId = text(artifact.rootTaskId);
  if (rootTaskId === null) throw new Error("TABLE_MULTI_HOP_ROOT_TASK_MISSING");

  const branches = new Map<string, CandidateBranch>();
  const add = (candidate: CandidateBranch): void => {
    const current = branches.get(candidate.candidateBranchId);
    if (!current) {
      branches.set(candidate.candidateBranchId, candidate);
      return;
    }
    branches.set(candidate.candidateBranchId, {
      ...current,
      producerRole: current.producerRole ?? candidate.producerRole,
      evidenceRefs: [...current.evidenceRefs, ...candidate.evidenceRefs].filter(
        (item, index, all) =>
          all.findIndex((other) => other.evidenceRefId === item.evidenceRefId) === index,
      ),
      gapRefs: sortedUnique([...current.gapRefs, ...candidate.gapRefs]),
    });
  };

  const writeEdges = records(artifact.writeEdges);
  const rootWrites = writeEdges.filter(
    (edge) => text(edge.producerTaskId) === rootTaskId,
  );
  const rootCriteria = input.rootCriteria ?? [];
  const selectedWriteObservationIds = sortedUnique(input.rootWriteObservationIds ?? []);
  if (rootCriteria.length > 0) {
    for (const criterion of rootCriteria) {
      if (criterion.rootTaskId !== rootTaskId)
        throw new Error(`ROOT_CRITERION_TASK_MISMATCH:${criterion.rootCriterionId}`);
      const criterionTable = rootTableForCriterion(criterion);
      const matchingWrites = rootWrites.filter((write) => {
        const sourceTable = tableOf(write.table);
        const resolvedTable = sourceTable === null
          ? null
          : input.resolvePhysicalTable?.(sourceTable) ?? sourceTable;
        return samePhysicalTable(resolvedTable, criterionTable);
      });
      const matchedTable = tableOf(matchingWrites[0]?.table);
      add(makeBranch({
        rootTaskId,
        branchKind: "ROOT_WRITE",
        producerTaskId: rootTaskId,
        table: matchedTable ?? criterionTable,
        evidenceRefs: matchingWrites.flatMap((write) => writeEvidenceRefs(write.writes)),
        writeObservationId: criterion.rootWriteObservationId,
        resolvePhysicalTable: input.resolvePhysicalTable,
      }));
    }
  } else if (rootWrites.length === 0) {
    for (const writeObservationId of selectedWriteObservationIds.length > 0
      ? selectedWriteObservationIds
      : [null])
      add(makeBranch({
        rootTaskId,
        branchKind: "ROOT_WRITE",
        producerTaskId: rootTaskId,
        writeObservationId,
        resolvePhysicalTable: input.resolvePhysicalTable,
      }));
  } else {
    for (const write of rootWrites)
      for (const writeObservationId of selectedWriteObservationIds.length > 0
        ? selectedWriteObservationIds
        : [null])
        add(makeBranch({
          rootTaskId,
          branchKind: "ROOT_WRITE",
          producerTaskId: rootTaskId,
        table: tableOf(write.table),
        evidenceRefs: writeEvidenceRefs(write.writes),
        writeObservationId,
        resolvePhysicalTable: input.resolvePhysicalTable,
      }));
  }

  const producerBridges = records(artifact.producerBridges);
  for (const bridge of producerBridges) {
    const consumerTaskId = text(bridge.consumerTaskId);
    const producerTaskId = text(bridge.producerTaskId);
    if (consumerTaskId === null || producerTaskId === null) continue;
    const bridgeTable = tableOf(bridge.table);
    if (!bridgeTable) continue;
    if (isSameTaskScratchProducerBridge(consumerTaskId, producerTaskId, bridgeTable.qualifiedName)) continue;
    add(
      makeBranch({
        rootTaskId,
        branchKind: "PHYSICAL_PRODUCER",
        consumerTaskId,
        producerTaskId,
        table: tableOf(bridge.table),
        readOccurrence: occurrenceOf(bridge.readOccurrence),
        producerRole: text(bridge.producerRole),
        resolvePhysicalTable: input.resolvePhysicalTable,
      }),
    );
  }

  const scheduleEdges = records(artifact.scheduleEdges);
  const physicalPairs = new Set(
    [...branches.values()]
      .filter((branch) => branch.branchKind === "PHYSICAL_PRODUCER")
      .map((branch) => `${branch.consumerTaskId ?? ""}\0${branch.producerTaskId ?? ""}`),
  );
  for (const edge of scheduleEdges) {
    const consumerTaskId = text(edge.consumerTaskId);
    const producerTaskId = text(edge.producerTaskId);
    if (consumerTaskId === null || producerTaskId === null) continue;
    if (physicalPairs.has(`${consumerTaskId}\0${producerTaskId}`)) continue;
    if (isCheckdbflagProducer(artifact, producerTaskId)) continue;
    add(
      makeBranch({
        rootTaskId,
        branchKind: "SCHEDULE_ONLY",
        consumerTaskId,
        producerTaskId,
        evidenceRefs: evidenceRefsOf(edge.evidence),
        resolvePhysicalTable: input.resolvePhysicalTable,
      }),
    );
  }

  const readEdges = records(artifact.readEdges);
  const blockedReadGapRefs: string[] = [];
  const unboundReadGapRefs: string[] = [];
  for (const read of readEdges) {
    const consumerTaskId = text(read.consumerTaskId);
    if (consumerTaskId === null) continue;
    const table = tableOf(read.table);
    if (!table || isOutOfScopePhysicalRead(table)) continue;
    if (consumerTaskId === rootTaskId && isSameTaskScratchTable(table.qualifiedName)) continue;
    const occurrence = occurrenceOf(read.readOccurrence);
    const matchingBridge = producerBridges.some((bridge) =>
      bridgeMatchesRead(bridge, read, table),
    );
    if (matchingBridge) continue;
    const blocked = readIsBlocked(read);
    const kind: CandidateBranchKind = blocked ? "BLOCKED_READ" : "UNBOUND_READ";
    const gap = gapId(
      rootTaskId,
      kind,
      {
        consumerTaskId,
        table: tableIdentity(table),
        occurrence: occurrenceIdentity(occurrence),
        blockReasons: records(read.blockReasons),
      } as unknown as JsonValue,
    );
    if (blocked) blockedReadGapRefs.push(gap);
    else unboundReadGapRefs.push(gap);
    add(
      makeBranch({
        rootTaskId,
        branchKind: kind,
        consumerTaskId,
        table,
        readOccurrence: occurrence,
        evidenceRefs: evidenceRefsOf(read.evidence),
        gapRefs: [gap],
        boundaryReason: blocked ? "READ_EVIDENCE_BLOCKED" : "PRODUCER_NOT_OBSERVED",
        resolvePhysicalTable: input.resolvePhysicalTable,
      }),
    );
  }

  const boundaryGapRefs: string[] = [
    ...blockedReadGapRefs,
    ...unboundReadGapRefs,
  ];
  const coverage = record(artifact.coverage);
  const limits = record(artifact.limits);
  const sourceCoverageStatus = text(coverage?.status);
  const sourceLimitsTruncated = bool(limits?.truncated);
  if (sourceCoverageStatus !== "COMPLETE_OBSERVED_EVIDENCE")
    boundaryGapRefs.push(
      gapId(rootTaskId, "COVERAGE_STATUS", sourceCoverageStatus ?? "MISSING"),
    );
  if (sourceLimitsTruncated)
    boundaryGapRefs.push(
      gapId(rootTaskId, "LIMIT_TRUNCATED", text(limits?.truncationReason) ?? "UNKNOWN"),
    );

  for (const terminal of records(artifact.terminals)) {
    const reason = boundaryTerminalReason(terminal.reason);
    if (reason === null) continue;
    if (isOutOfScopeTerminalReason(terminal.reason)) continue;
    const terminalTable = tableOf(terminal.table);
    if (isOutOfScopePhysicalRead(terminalTable)) continue;
    const terminalGap = gapId(
      rootTaskId,
      "TERMINAL",
      {
        taskId: text(terminal.taskId),
        depth: integer(terminal.depth),
        reason,
        table: tableIdentity(terminalTable),
      } as unknown as JsonValue,
    );
    boundaryGapRefs.push(terminalGap);
    add(
      makeBranch({
        rootTaskId,
        branchKind: "COVERAGE_BOUNDARY",
        consumerTaskId: text(terminal.taskId),
        table: terminalTable,
        gapRefs: [terminalGap],
        boundaryReason: reason,
        resolvePhysicalTable: input.resolvePhysicalTable,
      }),
    );
  }

  const uniqueBoundaryGapRefs = sortedUnique(boundaryGapRefs);
  if (uniqueBoundaryGapRefs.length > 0)
    add(
      makeBranch({
        rootTaskId,
        branchKind: "COVERAGE_BOUNDARY",
        gapRefs: uniqueBoundaryGapRefs,
        boundaryReason: "CANDIDATE_UNIVERSE_BOUNDARY",
        resolvePhysicalTable: input.resolvePhysicalTable,
      }),
    );

  const orderedBranches = [...branches.values()].sort((left, right) =>
    left.candidateBranchId.localeCompare(right.candidateBranchId),
  );
  return {
    rootTaskId,
    status: uniqueBoundaryGapRefs.length === 0 ? "COMPLETE_OBSERVED_EVIDENCE" : "INCOMPLETE",
    branches: orderedBranches,
    boundaryGapRefs: uniqueBoundaryGapRefs,
    coverage: {
      sourceArtifactType: sourceArtifactType(artifact),
      sourceCoverageStatus,
      sourceCoverageSemantics: text(coverage?.semantics),
      sourceLimitsTruncated,
    },
  };
}
