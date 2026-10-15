import { CardTopics, useCardTopics, type CardTopicData } from "../region-topics/CardTopics";
import { useMemo, useState } from "react";
import { ReactFlow, ReactFlowProvider, Handle, Position, Background, Controls, MiniMap, BaseEdge, getBezierPath, MarkerType, useReactFlow, type Node, type NodeProps, type Edge, type EdgeProps } from "@xyflow/react";
import type { OverviewResult } from "../types";
import { CARD_HEIGHT, CARD_WIDTH, STAGES, layoutOverview, relatedRegions, relationDirection, type Point } from "./layout";
import "./style.css";

type RegionData = Record<string, unknown> & { region: OverviewResult["regions"][number]; onOpen: (schema: string) => void; topics?: CardTopicData; topicsFailed?: boolean };
function RegionCard({ data }: NodeProps<Node<RegionData>>) {
  const { region } = data;
  return <div className="overview-region-card">
    <Handle type="target" position={Position.Left} />
    <div className={`overview-stage stage-${region.stage}`}>{STAGES[region.stage] ?? "未分类"}</div>
    <strong title={region.schema}>{region.schema}</strong>
    <CardTopics value={data.topics} failed={data.topicsFailed} />
    <div className="overview-card-bottom"><span>{region.datasetCount} 张表</span><button className="nodrag nopan" onClick={event => { event.stopPropagation(); data.onOpen(region.schema); }}>查看区域成员 ↗</button></div>
    <Handle type="source" position={Position.Right} />
  </div>;
}
type RouteData = Record<string, unknown> & { points: Point[]; count: number; showLabel: boolean; direction?: "incoming" | "outgoing" };
function RoutedEdge(props: EdgeProps<Edge<RouteData>>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX: props.sourceX, sourceY: props.sourceY, sourcePosition: Position.Right, targetX: props.targetX, targetY: props.targetY, targetPosition: Position.Left, curvature: 0.35 });
  return <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} label={props.data?.showLabel ? `${props.data.direction === "incoming" ? "流入 · " : props.data.direction === "outgoing" ? "流出 · " : ""}${props.data.count} 任务` : undefined} labelX={labelX} labelY={labelY} labelStyle={{ fill: "#254e4b", fontSize: 12 }} labelBgStyle={{ fill: "#ffffff", fillOpacity: 0.95 }} labelBgPadding={[5, 3]} />;
}
const nodeTypes = { overviewRegion: RegionCard };
const edgeTypes = { overviewRoute: RoutedEdge };

function Canvas({ overview, onOpenRegion, patterns, hiddenTables, clusters }: { overview: OverviewResult; onOpenRegion: (schema: string) => void; patterns: string[]; hiddenTables: string[]; clusters?: string[] }) {
  const topicState = useCardTopics(overview.regions.map(region => region.schema), patterns, hiddenTables, overview.version, clusters);
  const viewport = useReactFlow();
  const [expanded, setExpanded] = useState(false);
  const [focus, setFocus] = useState<{ overview: OverviewResult; schema: string }>();
  const [showCounts, setShowCounts] = useState(false);
  const [showAllEdges, setShowAllEdges] = useState(false);
  const selected = focus?.overview === overview ? focus.schema : undefined;
  const graph = useMemo(() => layoutOverview(overview), [overview]);
  const nearby = relatedRegions(overview, selected);
  const focal = [...graph.nodes].sort((a, b) => overview.flows.filter(edge => edge.fromSchema === b.region.schema || edge.toSchema === b.region.schema).length - overview.flows.filter(edge => edge.fromSchema === a.region.schema || edge.toSchema === a.region.schema).length)[0];
  const readable = () => { if (focal) void viewport.setCenter(focal.position.x + CARD_WIDTH / 2, focal.position.y + CARD_HEIGHT / 2, { zoom: 0.85, duration: 200 }); };
  const nodes: Node[] = graph.nodes.map(({ region, position }) => ({
    id: region.schema, type: "overviewRegion", position, zIndex: 5,
    data: { region, topics: topicState?.values?.[region.schema.toLowerCase()], topicsFailed: topicState?.failed, onOpen: (schema: string) => { setExpanded(false); onOpenRegion(schema); } },
    selected: region.schema === selected,
    style: { width: CARD_WIDTH, height: CARD_HEIGHT, opacity: nearby && !nearby.has(region.schema) ? 0.22 : 1 },
  }));
  for (const section of graph.sections) nodes.push({ id: section.id, position: { x: section.x, y: section.y }, data: { label: section.label }, selectable: false, draggable: false, style: { width: 380, background: "transparent", border: "none", color: "#4e706a", fontSize: 14, textAlign: "left" }, className: "overview-isolated-heading" });
  const edges: Edge[] = graph.edges.map(({ flow, id, points }) => {
    const direction = relationDirection(flow.fromSchema, flow.toSchema, selected);
    const active = !selected || Boolean(direction);
    const color = direction === "incoming" ? "#386fa4" : direction === "outgoing" ? "#b87525" : active ? "#267d74" : "#b5cbc5";
    return { hidden: !showAllEdges && (!selected || !active), id, source: flow.fromSchema, target: flow.toSchema, type: "overviewRoute", data: { points, direction, count: flow.taskCount, showLabel: active && (showCounts || Boolean(selected)) }, markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 }, style: { stroke: color, strokeWidth: selected && active ? 2.2 : 1.35, opacity: active ? 0.9 : 0.15 }, zIndex: selected && active ? 2 : 0 };
  });
  return <div className={`overview-canvas${expanded ? " is-expanded" : ""}`} onKeyDown={event => { if (event.key === "Escape") setExpanded(false); }}>
    <div className="overview-canvas-toolbar">
      <span>按阶段紧凑分块 · 位置不代表上下游</span>
      <button onClick={readable}>阅读大小</button>
      <button onClick={() => void viewport.fitView({ padding: 0.1, duration: 200 })}>全图</button>
      <button onClick={() => setExpanded(value => !value)}>{expanded ? "收起画布" : "展开画布"}</button>
      <label><input type="checkbox" checked={showAllEdges} onChange={event => setShowAllEdges(event.target.checked)} />全部连线</label>
      <label><input type="checkbox" checked={showCounts} onChange={event => setShowCounts(event.target.checked)} />显示全部关系数量</label>
      {selected && <span className="overview-direction-legend"><span style={{ color: "#386fa4" }}>━━▶ 流入当前区域</span>　<span style={{ color: "#b87525" }}>━━▶ 流出当前区域</span></span>}
      <button disabled={!selected} onClick={() => setFocus(undefined)}>取消突出</button>
    </div>
    <div className="overview-canvas-stage">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeClick={(_, node) => { if (node.type === "overviewRegion") setFocus(selected === node.id ? undefined : { overview, schema: node.id }); }} onPaneClick={() => setFocus(undefined)} nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null} fitView fitViewOptions={{ padding: 0.06 }} minZoom={0.08} maxZoom={1.8} colorMode="light" attributionPosition="bottom-left">
        <Background color="#d9e6e2" gap={28} />
        <MiniMap pannable zoomable nodeColor="#8ab4aa" maskColor="rgba(240,247,244,.65)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
    <div className="overview-canvas-hint">{selected ? `正在突出 ${selected} 的直接入出关系` : "总览默认收起连线，所有区域保留。单击卡片显示直接入出关系；卡片按钮查看成员。"}{(overview.truncated.regions || overview.truncated.flows) && " 当前返回范围存在截断。"}</div>
  </div>;
}

/** Self-contained renderer shared by ordinary and experimental overviews. */
export function OverviewCanvas(props: { overview: OverviewResult; onOpenRegion: (schema: string) => void; patterns: string[]; hiddenTables: string[]; clusters?: string[] }) {
  return <ReactFlowProvider key={JSON.stringify([props.overview.regions, props.overview.flows])}><Canvas {...props} /></ReactFlowProvider>;
}
