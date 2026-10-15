import type { Edge, Node } from "@xyflow/react";
import { withVisibility } from "./stable-copy";

export function appendHiddenBatch(history: string[][], ids: string[]): string[][] {
  const hidden = new Set(history.flat());
  const batch = [...new Set(ids)].filter(id => !hidden.has(id));
  return batch.length ? [...history, batch] : history;
}

export function projectVisibility<N extends Node, E extends Edge>(
  nodes: N[], edges: E[], history: string[][], selected: string[],
) {
  const hidden = new Set(history.flat());
  const selection = new Set(selected);
  return {
    nodes: nodes.map(node => {
      const nextHidden = Boolean(node.hidden || hidden.has(node.id));
      const nextSelected = !hidden.has(node.id) && selection.has(node.id);
      return withVisibility(node, {hidden:nextHidden, selected:nextSelected});
    }),
    edges: edges.map(edge => {
      const nextHidden = Boolean(edge.hidden || hidden.has(edge.source) || hidden.has(edge.target));
      return withVisibility(edge, {hidden:nextHidden});
    }),
    hiddenCount: nodes.filter(node => hidden.has(node.id)).length,
  };
}
