import { canonicalJson, sha256 } from "../../machine-facts/machine-facts-contract.ts";

/** Copied from data-graph project-topology-contract; keep frozen vectors in sync. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function safeSegment(value: string, label: string): string {
  const reserved = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
    || /[. ]$/.test(value)
    || reserved.test(value)
  ) {
    throw new Error(`${label} must be a safe path segment`);
  }
  return value;
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${sha256(canonicalJson(value))}`;
}

export function taskNodeId(taskId: string): string {
  return `task:${safeSegment(taskId, "taskId")}`;
}

export function physicalDatasetIdentity(input: {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string;
}): Readonly<Record<string, string | null>> {
  return {
    platform: input.platform?.trim().toLowerCase() ?? null,
    dataSource: input.dataSource?.trim().toLowerCase() ?? null,
    qualifiedName: input.qualifiedName.trim().toLowerCase(),
  };
}

export function physicalDatasetNodeId(input: {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string;
}): string {
  return stableId("dataset", physicalDatasetIdentity(input));
}

export function normalizedPhysicalField(input: {
  readonly platform: string;
  readonly dataSource: string;
  readonly stableTableId: string;
  readonly qualifiedName: string;
  readonly column: string;
}): Readonly<Record<string, string>> {
  return {
    platform: input.platform.trim().toLowerCase(),
    dataSource: input.dataSource.trim().toLowerCase(),
    stableTableId: input.stableTableId.trim().toLowerCase(),
    qualifiedName: input.qualifiedName.trim().toLowerCase(),
    column: input.column.trim().toLowerCase(),
  };
}

export function fieldEvidencePhysicalFieldNodeId(input: {
  readonly platform: string;
  readonly dataSource: string;
  readonly stableTableId: string;
  readonly qualifiedName: string;
  readonly column: string;
}): string {
  return stableId("physical-field", normalizedPhysicalField(input));
}

export function targetWriteNodeId(input: {
  readonly taskId: string;
  readonly datasetNodeId: string;
  readonly writeObservationId: string;
}): string {
  return stableId("target-write", input);
}

/** Kept in parity with data-graph field-evidence occurrence identities. */
export function readOccurrenceNodeId(input: {
  readonly consumerTaskId: string;
  readonly occurrenceId: string;
  readonly readRelationId: string;
}): string {
  return stableId("read-occurrence", input);
}

export function taskLocalEdgeId(input: {
  readonly edgeType: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly semanticKey?: unknown;
}): string {
  return stableId("edge", input);
}

export function fieldDirectEdgeSemanticKey(input: {
  readonly outputColumn: string;
  readonly sourceColumn: string;
  readonly sourceTable: string;
  readonly sourceReadOccurrenceId: string | null;
  readonly expressionId: string;
}): Readonly<Record<string, string | null>> {
  return {
    outputColumn: input.outputColumn,
    sourceColumn: input.sourceColumn,
    sourceTable: input.sourceTable,
    sourceReadOccurrenceId: input.sourceReadOccurrenceId,
    expressionId: input.expressionId,
  };
}

export function fieldConditionalEdgeSemanticKey(input: {
  readonly outputColumn: string;
  readonly sourceColumn: string;
  readonly sourceTable: string;
  readonly sourceReadOccurrenceId: string | null;
  readonly expressionId: string;
  readonly conditionalId: string;
}): Readonly<Record<string, string | null>> {
  return {
    outputColumn: input.outputColumn,
    sourceColumn: input.sourceColumn,
    sourceTable: input.sourceTable,
    sourceReadOccurrenceId: input.sourceReadOccurrenceId,
    expressionId: input.expressionId,
    conditionalId: input.conditionalId,
  };
}
