import type {
  FieldEvidenceEdgeRecord,
  FieldEvidenceNodeRecord,
  FieldEvidenceSelection,
  FieldEvidenceSliceSummary,
} from "../field-evidence/field-evidence-contract.ts";

export interface FieldDrilldownBundle {
  readonly selection: FieldEvidenceSelection;
  readonly slice: FieldEvidenceSliceSummary;
  readonly nodes: readonly FieldEvidenceNodeRecord[];
  readonly edges: readonly FieldEvidenceEdgeRecord[];
}

export interface FieldTraceLimits {
  readonly maxHops?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxPaths?: number;
}

export interface FieldTraceResult {
  readonly status: "ok" | "partial" | "not_found";
  readonly startStateId: string | null;
  readonly states: readonly FieldEvidenceNodeRecord[];
  readonly valueEdges: readonly FieldEvidenceEdgeRecord[];
  readonly annotationNodes: readonly FieldEvidenceNodeRecord[];
  readonly annotationEdges: readonly FieldEvidenceEdgeRecord[];
  readonly exploredPaths: number;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  readonly limits: Required<FieldTraceLimits>;
}

export interface FieldTraceTaskField {
  readonly key: string;
  readonly column: string;
  readonly qualifiedName: string;
  readonly displayName: string;
}

export interface FieldTraceTaskGroup {
  readonly taskId: string;
  readonly taskName: string | null;
  readonly depth: number;
  readonly minDepth: number;
  readonly maxDepth: number;
  readonly stateCount: number;
  readonly internalValueFlowCount: number;
  readonly target: boolean;
  readonly fields: readonly FieldTraceTaskField[];
}

export interface FieldTraceTaskLink {
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly valueFlowCount: number;
  readonly transitionLabels: readonly string[];
  readonly edgeIds: readonly string[];
}

export interface FieldTraceSummary {
  readonly targetTaskId: string | null;
  readonly sourceTaskIds: readonly string[];
  readonly groups: readonly FieldTraceTaskGroup[];
  readonly links: readonly FieldTraceTaskLink[];
}

export function traceFieldBundle(
  bundle: FieldDrilldownBundle,
  rootField: string,
  limits?: FieldTraceLimits,
): FieldTraceResult;

export function summarizeFieldTrace(trace: FieldTraceResult): FieldTraceSummary;

export function initializeFieldDrilldown(root?: Document): Promise<void>;
