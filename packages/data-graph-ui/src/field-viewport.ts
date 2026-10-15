import type { GraphEdge } from "./types";

/** Only draw an individual field edge when its port is inside the scroll viewport. */
export function fieldHandleVisible(
  rowTop: number,
  rowBottom: number,
  viewTop: number,
  viewBottom: number,
) {
  const center = (rowTop + rowBottom) / 2;
  return center >= viewTop && center <= viewBottom;
}
export function edgeTouchesHiddenField(
  edge: { sourceHandle?: string | null; targetHandle?: string | null; data?: Record<string, unknown> },
  hidden: ReadonlySet<string>,
) {
  const raw = edge.data?.raw as GraphEdge | undefined;
  if (raw?.kind === "VALUE" && (hidden.has(raw.from) || hidden.has(raw.to))) return true;
  return Boolean(
    (edge.sourceHandle && hidden.has(edge.sourceHandle)) ||
    (edge.targetHandle && hidden.has(edge.targetHandle)),
  );
}
