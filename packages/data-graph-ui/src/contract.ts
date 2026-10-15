import type { GraphNode } from "./types";

export function normalizeRegionItems(items: GraphNode[]): GraphNode[] {
  return items.map((item) => ({
    ...item,
    kind: item.kind || "PHYSICAL_DATASET",
  }));
}

export function isSameGraphVersion(
  activeVersion: string | undefined,
  responseVersion: string,
): boolean {
  return activeVersion === undefined || activeVersion === responseVersion;
}
