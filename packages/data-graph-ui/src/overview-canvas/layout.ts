import type { OverviewResult } from "../types";

export const CARD_WIDTH = 220, CARD_HEIGHT = 148;
export const STAGES: Record<string, string> = {
  SOURCE: "01 来源", ODATA: "02 采集与整理", PDATA: "03 模型与主题",
  DM: "04 应用加工", DELIVERY: "05 交付", UNCLASSIFIED: "未分类",
};
export type Point = { x: number; y: number };

export function layoutOverview(overview: OverviewResult) {
  const regions = [...overview.regions].sort((a, b) => a.schema.localeCompare(b.schema));
  const ids = new Set(regions.map(region => region.schema));
  const flows = overview.flows.filter(flow => ids.has(flow.fromSchema) && ids.has(flow.toSchema));
  const blocks = [...new Set(regions.map(region => region.stage))].map(stage => {
    const members = regions.filter(region => region.stage === stage);
    const columns = Math.min(members.length, Math.max(2, Math.ceil(Math.sqrt(members.length * CARD_HEIGHT * 1.4 / CARD_WIDTH))));
    return { stage, members, columns, width: columns * (CARD_WIDTH + 24), height: Math.ceil(members.length / columns) * (CARD_HEIGHT + 24) + 48 };
  }).sort((a, b) => b.height - a.height || a.stage.localeCompare(b.stage));
  // Pack stage blocks into shelves; choose the candidate with the best landscape fit.
  const pack = (limit: number) => {
    let x = 32, y = 48, rowHeight = 0, width = 0;
    const placements = blocks.map(block => {
      if (x > 32 && x + block.width > limit) { y += rowHeight; x = 32; rowHeight = 0; }
      const position = { x, y };
      x += block.width + 32; rowHeight = Math.max(rowHeight, block.height); width = Math.max(width, x);
      return { block, position };
    });
    return { placements, score: Math.max(width / 1.8, y + rowHeight) };
  };
  const minimum = Math.max(320, ...blocks.map(block => block.width + 64));
  const candidates = Array.from({ length: 8 }, (_, index) => pack(minimum + index * 240));
  const packed = candidates.sort((a, b) => a.score - b.score)[0];
  const sections: Array<{ id: string; label: string; x: number; y: number }> = [];
  const nodes: Array<{ region: OverviewResult["regions"][number]; position: Point }> = [];
  for (const { block, position } of packed.placements) {
    sections.push({ id: `section:${block.stage}`, label: `${STAGES[block.stage] ?? "未分类"} · ${block.members.length} 个区域`, x: position.x, y: position.y - 30 });
    block.members.forEach((region, index) => nodes.push({ region, position: { x: position.x + index % block.columns * (CARD_WIDTH + 24), y: position.y + Math.floor(index / block.columns) * (CARD_HEIGHT + 24) } }));
  }
  const positions = new Map(nodes.map(node => [node.region.schema, node.position]));
  const edges = flows.map((flow, index) => {
    const source = positions.get(flow.fromSchema)!, target = positions.get(flow.toSchema)!;
    return { flow, id: `overview-edge:${index}`, points: [
      { x: source.x + CARD_WIDTH, y: source.y + CARD_HEIGHT / 2 },
      { x: target.x, y: target.y + CARD_HEIGHT / 2 },
    ] };
  });
  return { nodes, edges, sections };
}

/** Smooth Dagre's routed polyline, preserving its intermediate routing lanes. */
export function curvedRoute(points: Point[]) {
  if (!points.length) return "";
  let path = `M ${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const next = points[i + 1], current = points[i];
    path += ` Q ${current.x},${current.y} ${(current.x + next.x) / 2},${(current.y + next.y) / 2}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x},${last.y}`;
}

export function relatedRegions(overview: OverviewResult, selected: string | undefined) {
  if (!selected) return undefined;
  return new Set([selected, ...overview.flows.filter(flow => flow.fromSchema === selected || flow.toSchema === selected).flatMap(flow => [flow.fromSchema, flow.toSchema])]);
}

export function relationDirection(from: string, to: string, selected?: string): "incoming" | "outgoing" | undefined {
  if (!selected) return undefined;
  if (from === selected) return "outgoing";
  if (to === selected) return "incoming";
  return undefined;
}
