import { NodeToolbar, Position } from "@xyflow/react";
import type { GraphNode } from "../types";
import "./node-analysis-toolbar.css";

/** Explicit navigation actions stay beside the focused card, at screen size. */
export function NodeAnalysisToolbar({
  nodeId,
  node,
  disabled,
  onAnalyze,
  onEvidence,
  onExpandUp,
  onExpandDown,
}: {
  nodeId: string;
  node: GraphNode;
  disabled?: boolean;
  onAnalyze: () => void;
  onEvidence: () => void;
  onExpandUp?: () => void;
  onExpandDown?: () => void;
}) {
  return (
    <NodeToolbar
      nodeId={nodeId}
      isVisible
      position={Position.Bottom}
      align="start"
      offset={8}
    >
      <div
        className="node-analysis-toolbar nodrag nopan"
        role="toolbar"
        aria-label="所选节点操作"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <button disabled={disabled} onClick={onAnalyze}>
          {node.kind === "TASK" ? "分析此调度" : "分析此表"}
        </button>
        <button disabled={disabled} onClick={onEvidence}>
          查看加工证据
        </button>
        {onExpandUp && <button disabled={disabled} onClick={onExpandUp}>向上展开一层</button>}
        {onExpandDown && <button disabled={disabled} onClick={onExpandDown}>向下展开一层</button>}
      </div>
    </NodeToolbar>
  );
}
