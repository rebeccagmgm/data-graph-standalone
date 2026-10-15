import { useCallback, useEffect, useRef } from "react";
import { ReactFlow, useNodesState, type Node, type NodeChange, type ReactFlowProps } from "@xyflow/react";
import type { LineageNodeData } from "../graph-adapter";
import { placeBranchNodes, type BranchPlacement } from "../branch-placement";

type CanvasNode = Node<LineageNodeData>;
type Props = Omit<ReactFlowProps<CanvasNode>, "nodes" | "onNodesChange"> & {
  nodes: CanvasNode[];
  scope: unknown;
  placement?: BranchPlacement;
};

/** Keep pointer-frequency updates below the explorer and graph projection. */
export function DraggableLineageCanvas({ nodes: projectedNodes, scope, placement, ...props }: Props) {
  const [nodes, setNodes, applyChanges] = useNodesState<CanvasNode>(projectedNodes);
  const session = useRef({ scope, positions: new Map<string, CanvasNode["position"]>() });
  const lastInputs = useRef(new Map<string, CanvasNode>());
  useEffect(() => {
    const sameScope = session.current.scope === scope;
    if (!sameScope) session.current = {scope, positions: new Map()};
    const previousInputs = lastInputs.current;
    const incoming = new Map(projectedNodes.map(node => [node.id, node]));
    lastInputs.current = incoming;
    setNodes(previous => {
      const byId = new Map(previous.map(node => [node.id, node]));
      const placed = placeBranchNodes(projectedNodes, session.current.positions, placement);
      for (const node of placed) session.current.positions.set(node.id, node.position);
      return placed.map(node => {
        const existing = byId.get(node.id);
        if (sameScope && existing && previousInputs.get(node.id) === incoming.get(node.id) &&
          existing.position.x === node.position.x && existing.position.y === node.position.y &&
          Boolean(existing.selected) === Boolean(node.selected)) return existing;
        return {...node, measured:existing?.measured, position:session.current.positions.get(node.id) ?? node.position};
      });
    });
  }, [projectedNodes, scope, placement, setNodes]);
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position)
        session.current.positions.set(change.id, change.position);
    }
    applyChanges(changes);
  }, [applyChanges]);
  return <ReactFlow {...props} onlyRenderVisibleElements nodes={nodes} onNodesChange={onNodesChange} />;
}
