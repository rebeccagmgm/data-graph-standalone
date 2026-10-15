import { canonicalJson, sha256 } from "../../../../machine-facts/machine-facts-contract.ts";

export const FIELD_IMPACT_RESULT_SCHEMA_VERSION = "1.1.0" as const;
export const FIELD_IMPACT_RESULT_ARTIFACT_TYPE = "FIELD_IMPACT_RESULT" as const;

export type FieldImpactEvidenceStatus = "CONFIRMED" | "CANDIDATE";

export interface FieldImpactAnchor {
  readonly taskId: string;
  readonly writeObservationId: string;
  readonly outputColumn: string;
}

export interface FieldImpactValueSource {
  readonly qualifiedName: string;
  readonly column: string;
  readonly readOccurrenceId: string | null;
}

export interface FieldImpactValueEntry {
  readonly depth: number;
  readonly taskId: string;
  readonly writeObservationId: string;
  readonly outputColumn: string;
  readonly source: FieldImpactValueSource;
  readonly subtype: string;
  readonly evidenceStatus: FieldImpactEvidenceStatus;
  readonly expressionId: string;
  readonly sourceRelationId: string | null;
  readonly sourceReadOccurrenceStatus: string;
}

export interface FieldImpactControlColumn {
  readonly qualifiedName: string;
  readonly column: string;
}

export interface FieldImpactControlEntry {
  readonly depth: number;
  readonly subtype: string;
  readonly joinType: string;
  readonly controlSide: string;
  readonly column: FieldImpactControlColumn;
  readonly scope: string;
  readonly grain: string;
  readonly relationId: string;
  readonly valueSourceRelationId: string | null;
  readonly outputColumn: string;
}

export type FieldImpactScheduleRelation =
  | "DIRECT_PARENT"
  | "NOT_IN_HORAE_UPSTREAM"
  | "HORAE_UNAVAILABLE";

export interface FieldImpactFrontierCandidate {
  readonly taskId: string;
  readonly writeObservationId: string;
  readonly partitionMatchStatus: string;
  readonly reasonCode?: string;
  readonly l1Eligible: boolean;
  readonly schedulePreferred: boolean;
  readonly scheduleRelation: FieldImpactScheduleRelation;
}

export interface FieldImpactFrontierEntry {
  readonly depth: number;
  readonly readField: { readonly readOccurrenceId: string; readonly column: string };
  readonly candidates: readonly FieldImpactFrontierCandidate[];
  readonly reasonCode: string;
}

export interface FieldImpactGap {
  readonly gapId: string;
  readonly reasonCode: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface FieldImpactBudget {
  readonly maxDepth: number;
  readonly maxEdges: number;
  readonly maxFrontier: number;
  readonly edgesVisited: number;
  readonly frontierCount: number;
  readonly exhausted: boolean;
}

export interface FieldImpactResult {
  readonly artifactType: typeof FIELD_IMPACT_RESULT_ARTIFACT_TYPE;
  readonly schemaVersion: typeof FIELD_IMPACT_RESULT_SCHEMA_VERSION;
  readonly anchor: FieldImpactAnchor;
  readonly value: readonly FieldImpactValueEntry[];
  readonly control: readonly FieldImpactControlEntry[];
  readonly frontier: readonly FieldImpactFrontierEntry[];
  readonly gaps: readonly FieldImpactGap[];
  readonly budget: FieldImpactBudget;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function validateFieldImpactResult(value: unknown): FieldImpactResult {
  const root = record(value);
  if (!root) throw new Error("FIELD_IMPACT_RESULT_INVALID");
  if (root.artifactType !== FIELD_IMPACT_RESULT_ARTIFACT_TYPE) {
    throw new Error("FIELD_IMPACT_RESULT_ARTIFACT_TYPE_INVALID");
  }
  if (root.schemaVersion !== FIELD_IMPACT_RESULT_SCHEMA_VERSION) {
    throw new Error("FIELD_IMPACT_RESULT_SCHEMA_VERSION_INVALID");
  }
  const anchor = record(root.anchor);
  if (!anchor || !text(anchor.taskId) || !text(anchor.writeObservationId) || !text(anchor.outputColumn)) {
    throw new Error("FIELD_IMPACT_RESULT_ANCHOR_INVALID");
  }
  if (!Array.isArray(root.value) || !Array.isArray(root.control)
    || !Array.isArray(root.frontier) || !Array.isArray(root.gaps)) {
    throw new Error("FIELD_IMPACT_RESULT_SECTIONS_INVALID");
  }
  const budget = record(root.budget);
  if (!budget || typeof budget.exhausted !== "boolean") {
    throw new Error("FIELD_IMPACT_RESULT_BUDGET_INVALID");
  }
  return value as FieldImpactResult;
}

export function fieldImpactResultContentHash(result: FieldImpactResult): string {
  const { anchor, value, control, frontier, gaps, budget } = result;
  return sha256(canonicalJson({ anchor, value, control, frontier, gaps, budget }));
}

export function emptyFieldImpactResult(input: {
  readonly anchor: FieldImpactAnchor;
  readonly gaps: readonly FieldImpactGap[];
  readonly budget?: Partial<FieldImpactBudget>;
}): FieldImpactResult {
  return {
    artifactType: FIELD_IMPACT_RESULT_ARTIFACT_TYPE,
    schemaVersion: FIELD_IMPACT_RESULT_SCHEMA_VERSION,
    anchor: input.anchor,
    value: [],
    control: [],
    frontier: [],
    gaps: input.gaps,
    budget: {
      maxDepth: input.budget?.maxDepth ?? 3,
      maxEdges: input.budget?.maxEdges ?? 5000,
      maxFrontier: input.budget?.maxFrontier ?? 200,
      edgesVisited: input.budget?.edgesVisited ?? 0,
      frontierCount: input.budget?.frontierCount ?? 0,
      exhausted: input.budget?.exhausted ?? false,
    },
  };
}
