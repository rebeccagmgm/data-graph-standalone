import { useMemo, useState, type ReactNode } from "react";
import type { Edge, Node } from "@xyflow/react";
import { appendHiddenBatch, projectVisibility } from "./state";
import "./style.css";

/** View-only state; a new query result starts a fresh hiding session. */
export function NodeVisibility<N extends Node, E extends Edge>({
  nodes, edges, scope, children,
}: {
  nodes: N[]; edges: E[]; scope: unknown;
  children: (graph: { nodes: N[]; edges: E[] }) => ReactNode;
}) {
  const [session, setSession] = useState({ scope, selecting: false, selected: [] as string[], history: [] as string[][] });
  if (session.scope !== scope) {
    setSession({ scope, selecting: false, selected: [], history: [] });
  }
  const graph = useMemo(() => projectVisibility(nodes, edges, session.history, session.selected), [nodes, edges, session.history, session.selected]);
  return <div className="node-visibility">
    <div className="node-visibility-toolbar" role="toolbar" aria-label="节点隐藏">
      <button aria-pressed={session.selecting} onClick={() => setSession(s => ({ ...s, selecting: !s.selecting, selected: [] }))}>
        {session.selecting ? "结束选择" : "选择隐藏"}
      </button>
      <button disabled={!session.selected.length} onClick={() => setSession(s => ({ ...s, history: appendHiddenBatch(s.history, s.selected), selected: [] }))}>隐藏所选（{session.selected.length}）</button>
      <button disabled={!session.history.length} onClick={() => setSession(s => ({ ...s, history: s.history.slice(0, -1), selected: [] }))}>撤销上次隐藏</button>
      <button disabled={!session.history.length} onClick={() => setSession(s => ({ ...s, history: [], selected: [] }))}>恢复全部</button>
      <span role="status">已隐藏 {graph.hiddenCount} 个节点{session.selecting ? "；点击卡片选择或取消，再隐藏所选" : ""}</span>
    </div>
    <div className="node-visibility-canvas" onClickCapture={event => {
      if (!session.selecting) return;
      const target = event.target as Element;
      const card = target.closest(".react-flow__node");
      const id = card?.getAttribute("data-id");
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      setSession(s => ({ ...s, selected: s.selected.includes(id) ? s.selected.filter(value => value !== id) : [...s.selected, id] }));
    }}>
      {children(graph)}
    </div>
  </div>;
}
