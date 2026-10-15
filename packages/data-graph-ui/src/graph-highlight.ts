import { applyDirectTaskHighlight, relatedLineageHighlight, valueOutputLabel, type LineageNodeData } from "./graph-adapter";
import type { Edge, Node } from "@xyflow/react";
import type { GraphEdge, GraphNode, TraceResult } from "./types";

type Graph = {nodes: Node<LineageNodeData>[]; edges: Edge[]};
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** A highlight changes styles/active ports, never grouping, layout or evidence. */
export function createGraphHighlighter(trace: TraceResult, base: Graph) {
  let previous = base;
  const edgeIds = new Map(trace.edges.map((edge, index) => [edge, edge.id ?? edge.key ?? `${edge.from}|${edge.to}|${edge.kind}|${edge.status ?? ""}|${index}`]));
  return (selection?: string | string[], taskId?: string): Graph => {
    const highlight = relatedLineageHighlight(trace, selection);
    const oldNodes = new Map(previous.nodes.map(node => [node.id, node]));
    const oldEdges = new Map(previous.edges.map(edge => [edge.id, edge]));
    const graph = !highlight ? base : {
      nodes: base.nodes.map(node => {
        const data = node.data;
        const members = data.members?.flatMap(member => [member, ...(data.fieldAliases?.[member.id] ?? [])]) ?? (data.raw ? [data.raw] : []);
        const ids = data.taskPorts?.map(port => port.fieldNodeId) ?? members.filter(member => member.kind.includes("FIELD")).map(member => member.id);
        const activeFieldIds = ids.filter(id => highlight.nodeIds.has(id)).sort();
        const active = data.taskPorts ? activeFieldIds.length > 0 : members.some(member => highlight.nodeIds.has(member.id));
        const opacity = active ? 1 : 0.22;
        const old = oldNodes.get(node.id);
        if (old?.data.highlightActive && old.style?.opacity === opacity && sameIds(old.data.activeFieldIds, activeFieldIds)) return old;
        return {...node, style:{...node.style, opacity}, data:{...data, highlightActive:true, activeFieldIds}};
      }),
      edges: base.edges.map(edge => {
        const raw = edge.data?.raw as GraphEdge | undefined;
        const rawNode = edge.data?.rawNode as GraphNode | undefined;
        const active = raw ? highlight.edgeIds.has(edgeIds.get(raw) ?? "") : Boolean(rawNode && highlight.nodeIds.has(rawNode.id));
        const opacity = active ? 1 : 0.14;
        let label = edge.label;
        if (active && raw?.kind === "CONTINUES" && raw.status !== "CANDIDATE") label = "跨任务接续";
        if (active && raw?.kind === "VALUE") {
          label = edge.id.endsWith(":input") ? "输入"
            : edge.id.endsWith(":output") ? valueOutputLabel(raw)
            : raw.detail?.materializationFolded === true && Array.isArray(raw.detail.materializationBridgeIds) && raw.detail.materializationBridgeIds.length
              ? `取值 · 经 ${new Set(raw.detail.materializationBridgeIds).size} 个中间步骤` : "取值";
        }
        if (active && rawNode) label = "生成字段";
        const old = oldEdges.get(edge.id);
        if (old?.style?.opacity === opacity && old.label === label) return old;
        return {...edge, label, style:{...edge.style,opacity},labelStyle:{...edge.labelStyle,opacity},labelBgStyle:{...edge.labelBgStyle,opacity}};
      }),
    };
    previous = applyDirectTaskHighlight(graph, taskId);
    return previous;
  };
}
