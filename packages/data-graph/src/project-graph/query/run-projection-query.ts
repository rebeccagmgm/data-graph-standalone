import {
  explainTopologyEdgeFromProjection,
  getProjectTopologyFromProjection,
  traceProjectUpstreamFromProjection,
  type ProjectTopologyQuerySource,
} from "./project-topology-query.ts";
import {
  explainFieldEvidenceRecordFromProjection,
  getFieldEvidenceFromProjection,
  traceFieldValuePathFromProjection,
  type FieldEvidenceQuerySource,
} from "../field-evidence/field-evidence-query.ts";
import {
  explainTargetCausalAssessmentFromProjection,
  getTargetCausalOverlayFromProjection,
  getTargetCausalTaskRollupFromProjection,
  type TargetCausalOverlayQuerySource,
} from "../target-causal-overlay/target-causal-overlay-query.ts";
import type {
  ProjectTopologyNodeType,
  ProjectTopologyEdgeType,
  ProjectTopologyRelationLayer,
} from "../contracts/project-topology-contract.ts";
import type {
  FieldEvidenceNodeType,
  FieldEvidenceEdgeType,
} from "../field-evidence/field-evidence-contract.ts";
import type {
  RelationStatus,
  ImpactChannel,
} from "../../contracts/canonical-artifacts.ts";
import {
  requiredOne,
  optionalOne,
  optionalInteger,
  type QueryName,
} from "./query-cli-options.ts";

// Only the source for the requested query family is loaded. Both CLI entrypoints
// execute the same projection functions; storage does not define query semantics.
export interface ProjectionQuerySources {
  readonly topology: () =>
    ProjectTopologyQuerySource | Promise<ProjectTopologyQuerySource>;
  readonly field: () =>
    FieldEvidenceQuerySource | Promise<FieldEvidenceQuerySource>;
  readonly causal: () =>
    TargetCausalOverlayQuerySource | Promise<TargetCausalOverlayQuerySource>;
}

export async function runProjectionQuery(
  sources: ProjectionQuerySources,
  options: {
    readonly query: QueryName;
    readonly values: ReadonlyMap<string, readonly string[]>;
  },
): Promise<unknown> {
  const one = (name: string) => optionalOne(options.values, name);
  const many = (name: string) => options.values.get(name);
  const integer = (
    name: string,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER,
  ) => optionalInteger(options.values, name, minimum, maximum);
  switch (options.query) {
    case "get_project_topology":
      return getProjectTopologyFromProjection(await sources.topology(), {
        nodeTypes: many("--node-type") as
          readonly ProjectTopologyNodeType[] | undefined,
        edgeTypes: many("--edge-type") as
          readonly ProjectTopologyEdgeType[] | undefined,
        offset: integer("--offset", 0),
        limit: integer("--limit", 1, 5_000),
      });
    case "trace_project_upstream":
      return traceProjectUpstreamFromProjection(await sources.topology(), {
        startNodeId: requiredOne(options.values, "--start-node-id"),
        relationLayers: many("--relation-layer") as
          readonly ProjectTopologyRelationLayer[] | undefined,
        maxHops: integer("--max-hops", 0, 100),
        maxNodes: integer("--max-nodes", 1, 100_000),
        maxEdges: integer("--max-edges", 1, 250_000),
        maxPaths: integer("--max-paths", 1, 1_000_000),
      });
    case "explain_topology_edge":
      return explainTopologyEdgeFromProjection(
        await sources.topology(),
        requiredOne(options.values, "--edge-id"),
      );
    case "get_field_evidence":
      return getFieldEvidenceFromProjection(await sources.field(), {
        nodeTypes: many("--node-type") as
          readonly FieldEvidenceNodeType[] | undefined,
        edgeTypes: many("--edge-type") as
          readonly FieldEvidenceEdgeType[] | undefined,
        offset: integer("--offset", 0),
        limit: integer("--limit", 1),
      });
    case "trace_field_value_path":
      return traceFieldValuePathFromProjection(await sources.field(), {
        rootField: one("--root-field"),
        startStateId: one("--start-state-id"),
        maxHops: integer("--max-hops", 1),
        maxNodes: integer("--max-nodes", 1),
        maxEdges: integer("--max-edges", 1),
        maxPaths: integer("--max-paths", 1),
      });
    case "explain_field_evidence_record":
      return explainFieldEvidenceRecordFromProjection(
        await sources.field(),
        requiredOne(options.values, "--record-id"),
        { maxAttachments: integer("--max-attachments", 1) },
      );
    case "get_target_causal_overlay":
      return getTargetCausalOverlayFromProjection(await sources.causal(), {
        relationStatuses: many("--relation-status") as
          readonly RelationStatus[] | undefined,
        channels: many("--channel") as readonly ImpactChannel[] | undefined,
        taskIds: many("--task-id"),
        offset: integer("--offset", 0),
        limit: integer("--limit", 1),
      });
    case "get_target_causal_task_rollup":
      return getTargetCausalTaskRollupFromProjection(
        await sources.causal(),
        requiredOne(options.values, "--task-id"),
        { maxAssessments: integer("--max-assessments", 1) },
      );
    case "explain_target_causal_assessment":
      return explainTargetCausalAssessmentFromProjection(
        await sources.causal(),
        requiredOne(options.values, "--assessment-id"),
        { maxAttachments: integer("--max-attachments", 1) },
      );
  }
}
