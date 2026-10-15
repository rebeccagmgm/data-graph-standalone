import type { Node } from "@xyflow/react";
import type { LineageNodeData } from "./graph-adapter";
export type BranchPlacement = {anchorId: string; direction: "up" | "down"};
type CanvasNode = Node<LineageNodeData>;

export function placeBranchNodes(nodes: CanvasNode[], positions: Map<string, CanvasNode["position"]>, placement?: BranchPlacement): CanvasNode[] {
  const anchor = nodes.find(node => node.id === placement?.anchorId);
  const origin = anchor && positions.get(anchor.id);
  const occupied = [...positions.values()];
  return nodes.map(node => {
    const existing = positions.get(node.id);
    if (existing) return {...node, position: existing};
    if (!placement || !anchor || !origin) return node;
    const depthDelta = Number(node.data.raw?.depth ?? 0) - Number(anchor.data.raw?.depth ?? 0);
    const position = {
      x: origin.x + depthDelta * (placement.direction === "up" ? -360 : 360),
      y: origin.y,
    };
    while (occupied.some(other => Math.abs(other.x - position.x) < 350 && Math.abs(other.y - position.y) < 180)) position.y += 180;
    occupied.push(position);
    return {...node, position};
  });
}
