import { api } from "../api";
import { loadAllFieldPages } from "../multi-field-trace";
import { physicalTableAnchor } from "../table-navigation";
import type { GraphNode } from "../types";
import { loadScope } from "./client";
import { graphMembers, memberAllowsNode } from "./model";

/** Prepare the new scope atomically; field selection uses its writers, not the old scope. */
export async function loadPhysicalTableAnalysis(
  node: GraphNode,
  clusters: string[],
  current: () => boolean,
  client: Pick<typeof api, "status" | "search" | "trace" | "fields"> = api,
  progress: (message: string) => void = () => {},
) {
  const anchor = physicalTableAnchor(node);
  const scope = await loadScope([
    { kind: "PHYSICAL_DATASET", id: anchor.nodeId, value: anchor.table ?? anchor.label, enabled: true },
  ], current, client, progress, clusters);
  const fields = await loadAllFieldPages({
    fetchPage: (offset, limit) => client.fields(anchor, offset, limit),
    readVersion: async () => {
      const version = String((await client.status()).version ?? "");
      if (version !== scope.trace.version) throw new Error("图谱已换版，请重新分析此表。");
      return version;
    },
    isCurrent: current,
  });
  const members = graphMembers(scope.trace);
  return {
    scope,
    fields: fields.filter(field => memberAllowsNode(members, field) && !/^temp\./i.test(field.table ?? "")),
  };
}
