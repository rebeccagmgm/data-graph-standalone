/**
 * TU-3 edge vocabulary freeze for TASK_LOCAL_UNION.
 *
 * WP-3 local edges are carried as-is (same edgeId). Derived edges are
 * physically separable (`derived: true`) and kill-switchable at continuation time.
 *
 * WRITES two-hop: keep WP-3 shape
 *   TASK → TARGET_WRITE  (edgeType WRITES)
 *   TARGET_WRITE → PHYSICAL_DATASET  (edgeType WRITES)
 * Endpoint nodeTypes distinguish the hops. Do NOT introduce MATERIALIZES in WP-5.
 */

export const TASK_LOCAL_UNION_LOCAL_EDGE_TYPES = [
  "READS",
  "WRITES",
  "FIELD_DIRECT",
  "FIELD_CONDITIONAL",
  "DATASET_CONTROL",
] as const;

export const TASK_LOCAL_UNION_DERIVED_EDGE_TYPES = [
  "PRODUCER_BRIDGE",
  "SCHEDULE_DEPENDS_ON",
] as const;

export type TaskLocalUnionLocalEdgeType =
  (typeof TASK_LOCAL_UNION_LOCAL_EDGE_TYPES)[number];

export type TaskLocalUnionDerivedEdgeType =
  (typeof TASK_LOCAL_UNION_DERIVED_EDGE_TYPES)[number];

export type TaskLocalUnionEdgeProvenance =
  "TASK_LOCAL_PROJECTION" | "PRODUCER_INDEX" | "SCHEDULE_REFERENCE";

export interface TaskLocalUnionDerivedEdge {
  readonly edgeId: string;
  readonly edgeType: TaskLocalUnionDerivedEdgeType;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly derived: true;
  readonly provenance: TaskLocalUnionEdgeProvenance;
  readonly evidenceStatus: "CONFIRMED" | "CANDIDATE";
}

/** Neo4j / query-index labels reuse existing data-graph edgeType strings. */
export const TASK_LOCAL_UNION_NEO4J_EDGE_LABELS = {
  local: TASK_LOCAL_UNION_LOCAL_EDGE_TYPES,
  derived: TASK_LOCAL_UNION_DERIVED_EDGE_TYPES,
} as const;

export function isTaskLocalUnionLocalEdgeType(
  edgeType: string,
): edgeType is TaskLocalUnionLocalEdgeType {
  return (TASK_LOCAL_UNION_LOCAL_EDGE_TYPES as readonly string[]).includes(
    edgeType,
  );
}

export function isTaskLocalUnionDerivedEdgeType(
  edgeType: string,
): edgeType is TaskLocalUnionDerivedEdgeType {
  return (TASK_LOCAL_UNION_DERIVED_EDGE_TYPES as readonly string[]).includes(
    edgeType,
  );
}
