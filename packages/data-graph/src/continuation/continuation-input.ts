import type {
  TaskLocalProjectionClosure,
  TaskLocalUnionBatchManifestRef,
  TaskLocalUnionProducerIndexRef,
} from "./task-local-projection.ts";

export type TaskLocalUnionGapCode =
  "DATASET_IDENTITY_DIVERGENT" | "UNION_EDGE_CONFLICT";

export interface TaskLocalUnionGap {
  readonly gapId: string;
  readonly reasonCode: TaskLocalUnionGapCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface TaskLocalUnionNode {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly sourceTaskIds: readonly string[];
}

export interface TaskLocalUnionEdge {
  readonly edgeId: string;
  readonly edgeType: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly sourceTaskIds: readonly string[];
  readonly derived: false;
}

export interface TaskLocalUnionMergeReport {
  readonly taskCount: number;
  readonly projectedCount: number;
  readonly boundaryOnlyCount: number;
  readonly nodeCounts: {
    readonly input: number;
    readonly output: number;
    readonly deduped: number;
  };
  readonly edgeCounts: {
    readonly input: number;
    readonly output: number;
    readonly deduped: number;
  };
  readonly gaps: readonly TaskLocalUnionGap[];
}

export interface TaskLocalUnionTaskEvidence {
  readonly taskId: string;
  readonly contentHash: string;
  readonly packContentHash: string;
  readonly factsManifestSha256: string;
  readonly projectionSchemaVersion: string;
  readonly coverageStatus: string;
  readonly localClosure: TaskLocalProjectionClosure | null;
}

/** Structural input consumed by continuation; topology-only fields stay opaque. */
export interface TaskLocalUnionMergeResult {
  readonly sourceMode: "TASK_LOCAL_UNION";
  readonly nodes: readonly TaskLocalUnionNode[];
  readonly edges: readonly TaskLocalUnionEdge[];
  readonly report: TaskLocalUnionMergeReport;
  readonly taskEvidence: readonly TaskLocalUnionTaskEvidence[];
  readonly producerIndex: TaskLocalUnionProducerIndexRef;
  readonly batchManifestRef: TaskLocalUnionBatchManifestRef;
}

/** Narrow loader view used only to fail closed on projection-schema drift. */
export interface LoadedTaskLocalUnionSources {
  readonly tasks: readonly {
    readonly taskSource: {
      readonly taskId: string;
      readonly coverageStatus: string;
    };
    readonly envelope: {
      readonly cacheKeyParts: { readonly schemaVersion: string };
    };
    readonly projection: { readonly schemaVersion: string };
  }[];
}

/** Match task-local and Machine Facts name normalization. */
export function normalizeName(value: string): string {
  return value
    .replace(/[`"\[\]]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}
