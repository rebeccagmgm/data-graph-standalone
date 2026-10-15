import { stableId } from "../../../../scripts/project-graph/task-local/ids.ts";
import type { TaskLocalProjection } from "../../../../scripts/project-graph/task-local/contract.ts";
import { addAssetCatalog } from "./catalog.ts";
import {
  compileTask,
  type AssetNode,
  type CompiledTask,
  type FactRecord,
} from "./compile.ts";

export const ASSET_CATALOG_COMPILER_VERSION = "1.0.0";

/**
 * Opt-in asset catalogue over the existing occurrence compiler. Keeping this
 * entrypoint separate lets an in-progress graph publication finish unchanged.
 */
export function compileCatalogTask(
  projection: TaskLocalProjection,
  bindings: readonly FactRecord[] = [],
): CompiledTask {
  const graph = compileTask(projection, bindings);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges.map((edge) => {
    const source = nodes.get(edge.from);
    if (edge.layer !== "field" || source?.kind !== "PHYSICAL_FIELD")
      return edge;

    // An unresolved occurrence must not turn a shared asset into a lineage hub.
    const evidence = JSON.parse(edge.detail) as FactRecord;
    const id = stableId("unresolved-read-field", {
      taskId: graph.taskId,
      sourceEdgeId: edge.id,
    });
    const boundary: AssetNode = {
      ...source,
      id,
      kind: "UNRESOLVED_READ_FIELD",
      taskId: graph.taskId,
      detail: JSON.stringify({
        ...(JSON.parse(source.detail) as FactRecord),
        sourceFieldNodeId: source.id,
        sourceEdgeId: edge.id,
        sourceReadOccurrenceStatus:
          evidence.sourceReadOccurrenceStatus ?? "UNRESOLVED",
        sourceReadOccurrenceReason:
          evidence.sourceReadOccurrenceReason ?? "READ_OCCURRENCE_UNAVAILABLE",
      }),
    };
    nodes.set(id, boundary);
    return { ...edge, from: id };
  });
  return addAssetCatalog(projection, {
    ...graph,
    nodes: [...nodes.values()],
    edges,
  });
}
