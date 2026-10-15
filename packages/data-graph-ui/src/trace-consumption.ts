import type {
  ConsumptionBranch,
  ConsumptionField,
  ConsumptionGroup,
  ConsumptionWriteRef,
  TraceConsumption,
} from "./types";
import {
  consumptionScopeIdentity,
  mergeConsumptionScopes,
} from "../../data-graph/src/asset-graph/consumption-scope";

const union = (...values: string[][]) => [...new Set(values.flat())].sort();

function mergeWriteRefs(
  refs: ConsumptionWriteRef[],
  allowedNodeIds: Set<string>,
  allowedEdgeIds: Set<string>,
) {
  const result = new Map<string, ConsumptionWriteRef>();
  for (const ref of refs) {
    const rawNodeIds = ref.rawNodeIds.filter((id) => allowedNodeIds.has(id));
    const rawEdgeIds = ref.rawEdgeIds.filter((id) => allowedEdgeIds.has(id));
    if (!rawNodeIds.length && !rawEdgeIds.length) continue;
    const key = `${ref.taskId}|${ref.writeId}|${consumptionScopeIdentity(ref.scope)}`;
    const existing = result.get(key);
    result.set(key, {
      ...ref,
      rawNodeIds: union(existing?.rawNodeIds ?? [], rawNodeIds),
      rawEdgeIds: union(existing?.rawEdgeIds ?? [], rawEdgeIds),
    });
  }
  return [...result.values()].sort((left, right) =>
    `${left.taskId}|${left.writeId}`.localeCompare(
      `${right.taskId}|${right.writeId}`,
    ),
  );
}

function mergeFields(
  fields: ConsumptionField[],
  allowedNodeIds: Set<string>,
  allowedEdgeIds: Set<string>,
) {
  const result = new Map<string, ConsumptionField>();
  for (const field of fields) {
    const rawNodeIds = field.rawNodeIds.filter((id) => allowedNodeIds.has(id));
    if (!rawNodeIds.length) continue;
    const key = field.column.toLowerCase();
    const existing = result.get(key);
    result.set(key, {
      column: existing?.column ?? field.column,
      rawNodeIds: union(existing?.rawNodeIds ?? [], rawNodeIds),
      rawEdgeIds: union(
        existing?.rawEdgeIds ?? [],
        field.rawEdgeIds.filter((id) => allowedEdgeIds.has(id)),
      ),
      writeRefs: mergeWriteRefs(
        [...(existing?.writeRefs ?? []), ...field.writeRefs],
        allowedNodeIds,
        allowedEdgeIds,
      ),
    });
  }
  return [...result.values()].sort((left, right) =>
    left.column.localeCompare(right.column),
  );
}

/** Merge per-root server contracts without deriving any new display lineage. */
export function mergeTraceConsumptions(input: {
  consumptions: TraceConsumption[];
  allowedNodeIds: Set<string>;
  allowedEdgeIds: Set<string>;
  allRootNodeIds: string[];
}): TraceConsumption | undefined {
  if (!input.consumptions.length) return undefined;
  const groups = new Map<string, ConsumptionGroup>();
  const branches = new Map<string, ConsumptionBranch>();
  const rootPaths = new Map<string, TraceConsumption["rootPaths"][number]>();
  for (const consumption of input.consumptions) {
    for (const group of consumption.groups) {
      const rawNodeIds = group.rawNodeIds.filter((id) =>
        input.allowedNodeIds.has(id),
      );
      if (!rawNodeIds.length) continue;
      const existing = groups.get(group.id);
      groups.set(group.id, {
        ...group,
        depth: Math.min(existing?.depth ?? group.depth, group.depth),
        scope: mergeConsumptionScopes([
          ...(existing ? [existing.scope] : []),
          group.scope,
        ]),
        rawNodeIds: union(existing?.rawNodeIds ?? [], rawNodeIds),
        rawEdgeIds: union(
          existing?.rawEdgeIds ?? [],
          group.rawEdgeIds.filter((id) => input.allowedEdgeIds.has(id)),
        ),
        rootNodeIds: union(
          existing?.rootNodeIds ?? [],
          group.rootNodeIds.filter((id) =>
            input.allRootNodeIds.includes(id),
          ),
        ),
        fields: mergeFields(
          [...(existing?.fields ?? []), ...group.fields],
          input.allowedNodeIds,
          input.allowedEdgeIds,
        ),
        writeRefs: mergeWriteRefs(
          [...(existing?.writeRefs ?? []), ...group.writeRefs],
          input.allowedNodeIds,
          input.allowedEdgeIds,
        ),
      });
    }
    for (const branch of consumption.branches) {
      const rawEdgeIds = branch.rawEdgeIds.filter((id) =>
        input.allowedEdgeIds.has(id),
      );
      if (!rawEdgeIds.length) continue;
      const existing = branches.get(branch.id);
      const fieldMappings = [
        ...(existing?.fieldMappings ?? []),
        ...branch.fieldMappings,
      ]
        .map((mapping) => ({
          ...mapping,
          sourceNodeIds: mapping.sourceNodeIds.filter((id) =>
            input.allowedNodeIds.has(id),
          ),
          targetNodeIds: mapping.targetNodeIds.filter((id) =>
            input.allowedNodeIds.has(id),
          ),
          rawEdgeIds: mapping.rawEdgeIds.filter((id) =>
            input.allowedEdgeIds.has(id),
          ),
        }))
        .filter(
          (mapping) =>
            mapping.rawEdgeIds.length > 0 &&
            mapping.sourceNodeIds.length > 0 &&
            mapping.targetNodeIds.length > 0,
        )
        .filter(
          (mapping, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.sourceColumn === mapping.sourceColumn &&
                candidate.targetColumn === mapping.targetColumn &&
                candidate.rawEdgeIds.join("|") ===
                  mapping.rawEdgeIds.join("|"),
            ) === index,
        );
      branches.set(branch.id, {
        ...branch,
        rawEdgeIds: union(existing?.rawEdgeIds ?? [], rawEdgeIds),
        rootNodeIds: union(
          existing?.rootNodeIds ?? [],
          branch.rootNodeIds.filter((id) =>
            input.allRootNodeIds.includes(id),
          ),
        ),
        fieldMappings,
      });
    }
    for (const path of consumption.rootPaths) {
      if (!input.allRootNodeIds.includes(path.rootNodeId)) continue;
      const existing = rootPaths.get(path.rootNodeId);
      rootPaths.set(path.rootNodeId, {
        rootNodeId: path.rootNodeId,
        rawNodeIds: union(
          existing?.rawNodeIds ?? [],
          path.rawNodeIds.filter((id) => input.allowedNodeIds.has(id)),
        ),
        rawEdgeIds: union(
          existing?.rawEdgeIds ?? [],
          path.rawEdgeIds.filter((id) => input.allowedEdgeIds.has(id)),
        ),
        groupIds: union(existing?.groupIds ?? [], path.groupIds),
        branchIds: union(existing?.branchIds ?? [], path.branchIds),
      });
    }
  }
  for (const rootNodeId of input.allRootNodeIds)
    if (!rootPaths.has(rootNodeId))
      rootPaths.set(rootNodeId, {
        rootNodeId,
        rawNodeIds: [rootNodeId],
        rawEdgeIds: [],
        groupIds: [],
        branchIds: [],
      });
  const finalGroups = [...groups.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const groupIds = new Set(finalGroups.map(({ id }) => id));
  const finalBranches = [...branches.values()]
    .filter(
      (branch) =>
        groupIds.has(branch.fromGroupId) && groupIds.has(branch.toGroupId),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: "1.0.0",
    groups: finalGroups,
    branches: finalBranches,
    rootPaths: [...rootPaths.values()].map((path) => {
      const pathNodeIds = new Set(path.rawNodeIds);
      const pathEdgeIds = new Set(path.rawEdgeIds);
      return {
        ...path,
        groupIds: finalGroups
          .filter((group) =>
            group.rawNodeIds.some((id) => pathNodeIds.has(id)),
          )
          .map(({ id }) => id),
        branchIds: finalBranches
          .filter((branch) =>
            branch.rawEdgeIds.some((id) => pathEdgeIds.has(id)),
          )
          .map(({ id }) => id),
      };
    }),
  };
}
