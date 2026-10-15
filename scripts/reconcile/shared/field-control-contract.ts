import type { PhysicalFieldIdentity } from "./physical-field.ts";

export type OpenLineageIndirectSubtype =
  "JOIN" | "GROUP_BY" | "FILTER" | "SORT" | "WINDOW" | "CONDITIONAL";

export type DatasetControlGrain =
  "REDUCE" | "PRESERVE" | "EXPAND_RISK" | "UNKNOWN";

export type DatasetControlGrainReason =
  | "GRAIN_JOIN_CARDINALITY_UNPROVEN"
  | "GRAIN_JOIN_NULLABLE_SIDE_MAY_EXPAND"
  | "GRAIN_GROUPING_REDUCES_ROWS"
  | "GRAIN_SETOP_REDUCES_ROWS"
  | "GRAIN_FILTER_MAY_DROP_ROWS"
  | "GRAIN_WINDOW_CARDINALITY_UNPROVEN";

export type DatasetControlJoinType =
  "SEMI" | "ANTI" | "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS" | "N/A";

export type DatasetControlSide = "LEFT" | "RIGHT" | "BOTH" | "N/A";

export interface DatasetControlAnnotation {
  readonly controlId: string;
  readonly taskId: string;
  readonly statementId: string;
  readonly relationId: string | null;
  readonly subtype: OpenLineageIndirectSubtype;
  readonly masking: boolean;
  readonly grain: DatasetControlGrain;
  /** Why `grain` is not PRESERVE. Required unless grain === "PRESERVE". Independent of evidence `reasonCode`. */
  readonly grainReason: DatasetControlGrainReason | null;
  readonly field: PhysicalFieldIdentity | null;
  readonly sourceText: string | null;
  readonly evidenceStatus: "CONFIRMED" | "PROVISIONAL_LEGACY" | "UNRESOLVED";
  readonly reasonCode: string | null;
  readonly evidenceRefs: readonly string[];
  readonly joinType?: DatasetControlJoinType;
  readonly leftRelationId?: string | null;
  readonly rightRelationId?: string | null;
  readonly controlSide?: DatasetControlSide;
}

export interface FieldConditionalAnnotation {
  readonly conditionalId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly statementId: string;
  readonly relationId: string | null;
  readonly subtype: "CONDITIONAL";
  readonly masking: boolean;
  readonly fields: readonly PhysicalFieldIdentity[];
  readonly sourceText: string | null;
  readonly evidenceStatus: "CONFIRMED" | "PROVISIONAL_LEGACY" | "UNRESOLVED";
  readonly reasonCode: string | null;
  readonly evidenceRefs: readonly string[];
}
