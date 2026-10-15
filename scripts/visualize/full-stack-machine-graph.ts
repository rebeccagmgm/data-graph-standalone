import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { UnionContinuationIndex, UnionContinuationIndexEntry } from "../reconcile/consumer/target-table-upstream-causal-closure/union-continuation-candidate-source.ts";
import type { TaskLocalProjection } from "../project-graph/task-local/contract.ts";
import {
  buildMachineGraphModel,
  type MachineGraphEdge,
  type MachineGraphModel,
} from "./task-local-machine-graph.ts";

export interface FactsTaskSummary {
  readonly taskId: string;
  readonly coverageStatus: string;
  readonly contentHash: string;
  readonly finalWrites: number;
  readonly externalReads: number;
  readonly fieldDirectEdges: number;
  readonly datasetControlEdges: number;
}

export interface ContinuationViewEntry {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly qualifiedName: string;
  readonly partitionPredicateStatus: string;
  readonly candidates: readonly {
    readonly producerTaskId: string;
    readonly writeObservationId: string;
    readonly partitionMatchStatus: string;
    readonly l1Eligible: boolean;
    readonly evidenceLayer: "L1" | "L2";
  }[];
  readonly gaps: readonly { readonly reasonCode: string; readonly message: string }[];
  readonly userTier: "L1" | "L2" | "L3";
}

export interface NarrativeGap {
  readonly reasonCode: string;
  readonly message: string;
  readonly taskId: string | null;
  readonly qualifiedName: string | null;
}

export interface NarrativeSummary {
  readonly l0: {
    readonly projected: number;
    readonly scheduleOnly: number;
    readonly collectionFailed: number;
    readonly taskIds: readonly string[];
  };
  readonly l1Count: number;
  readonly l2Count: number;
  readonly l3Count: number;
  readonly gaps: readonly NarrativeGap[];
}

export interface FullStackGraphModel {
  readonly title: string;
  readonly inputMode: "demo" | "projection";
  readonly facts: readonly FactsTaskSummary[];
  readonly projection: MachineGraphModel;
  readonly continuation: readonly ContinuationViewEntry[];
  readonly narrative: NarrativeSummary;
}

function summarizeFacts(projections: readonly TaskLocalProjection[]): FactsTaskSummary[] {
  return projections.map((projection) => ({
    taskId: projection.taskId,
    coverageStatus: projection.coverageStatus,
    contentHash: projection.contentHash,
    finalWrites: projection.localClosure?.finalWrites.length ?? 0,
    externalReads: projection.localClosure?.externalReads.length ?? 0,
    fieldDirectEdges: projection.edges.filter((edge) => edge.edgeType === "FIELD_DIRECT").length,
    datasetControlEdges: projection.edges.filter((edge) => edge.edgeType === "DATASET_CONTROL").length,
  }));
}

function tierFromEntry(entry: ContinuationViewEntry): "L1" | "L2" | "L3" {
  if (entry.gaps.length > 0) return "L3";
  if (entry.candidates.some((candidate) => candidate.l1Eligible)) return "L1";
  if (entry.candidates.length > 0) return "L2";
  return "L3";
}

export function buildDemoContinuationEntries(
  projections: readonly TaskLocalProjection[],
): ContinuationViewEntry[] {
  const writesByTable = new Map<string, { taskId: string; writeObservationId: string }[]>();
  for (const projection of projections) {
    for (const write of projection.localClosure?.finalWrites ?? []) {
      const bucket = writesByTable.get(write.qualifiedName) ?? [];
      const writeObservationId = write.writeObservationId;
      bucket.push({ taskId: projection.taskId, writeObservationId });
      writesByTable.set(write.qualifiedName, bucket);
    }
  }

  const entries: ContinuationViewEntry[] = [];
  for (const projection of projections) {
    for (const read of projection.localClosure?.externalReads ?? []) {
      const producers = (writesByTable.get(read.qualifiedName) ?? [])
        .filter((write) => write.taskId !== projection.taskId);
      const gaps: { reasonCode: string; message: string }[] = [];
      let candidates: ContinuationViewEntry["candidates"] = [];

      if (producers.length === 0) {
        gaps.push({
          reasonCode: "WRITER_NOT_IN_UNION",
          message: `本批投影内没有写到 ${read.qualifiedName} 的上游任务（例如 t03_otc_opt_comp_info 的 writer 不在三金样内）`,
        });
      } else {
        candidates = producers.map((producer, index) => {
          const partitionMatchStatus = index === 0 ? "CONFIRMED" : "UNKNOWN";
          const l1Eligible = partitionMatchStatus === "CONFIRMED";
          return {
            producerTaskId: producer.taskId,
            writeObservationId: producer.writeObservationId,
            partitionMatchStatus,
            l1Eligible,
            evidenceLayer: l1Eligible ? "L1" as const : "L2" as const,
          };
        });
        if (producers.length > 1) {
          gaps.push({
            reasonCode: "MULTIPLE_WRITERS",
            message: `同表 ${read.qualifiedName} 在本批内有 ${producers.length} 个写观察，需按分区收窄`,
          });
        }
      }

      const draft: Omit<ContinuationViewEntry, "userTier"> = {
        consumerTaskId: projection.taskId,
        readOccurrenceId: read.readOccurrenceId,
        qualifiedName: read.qualifiedName,
        partitionPredicateStatus: read.qualifiedName.includes("stati") ? "LITERAL" : "NON_LITERAL_PRESENT",
        candidates,
        gaps,
      };
      entries.push({ ...draft, userTier: tierFromEntry({ ...draft, userTier: "L3" }) });
    }
  }
  return entries;
}

function continuationFromIndex(index: UnionContinuationIndex): ContinuationViewEntry[] {
  return index.entries.map((entry: UnionContinuationIndexEntry) => {
    const draft: Omit<ContinuationViewEntry, "userTier"> = {
      consumerTaskId: entry.consumerTaskId,
      readOccurrenceId: entry.readOccurrenceId,
      qualifiedName: entry.qualifiedName,
      partitionPredicateStatus: entry.partitionPredicateStatus,
      candidates: entry.candidates.map((candidate) => ({
        producerTaskId: candidate.taskId,
        writeObservationId: candidate.writeObservationId,
        partitionMatchStatus: candidate.partitionMatchStatus,
        l1Eligible: candidate.l1Eligible,
        evidenceLayer: candidate.evidenceLayer,
      })),
      gaps: entry.gaps.map((gap) => ({
        reasonCode: gap.reasonCode,
        message: gap.message,
      })),
    };
    return { ...draft, userTier: tierFromEntry({ ...draft, userTier: "L3" }) };
  });
}

function buildNarrative(
  projections: readonly TaskLocalProjection[],
  continuation: readonly ContinuationViewEntry[],
): NarrativeSummary {
  let projected = 0;
  let scheduleOnly = 0;
  let collectionFailed = 0;
  for (const projection of projections) {
    if (projection.coverageStatus === "PROJECTED") projected += 1;
    else if (projection.coverageStatus === "SCHEDULE_ONLY") scheduleOnly += 1;
    else collectionFailed += 1;
  }

  const gaps: NarrativeGap[] = [];
  let l1 = 0;
  let l2 = 0;
  let l3 = 0;
  for (const entry of continuation) {
    if (entry.userTier === "L1") l1 += 1;
    else if (entry.userTier === "L2") l2 += 1;
    else l3 += 1;
    for (const gap of entry.gaps) {
      gaps.push({
        reasonCode: gap.reasonCode,
        message: gap.message,
        taskId: entry.consumerTaskId,
        qualifiedName: entry.qualifiedName,
      });
    }
  }

  return {
    l0: {
      projected,
      scheduleOnly,
      collectionFailed,
      taskIds: projections.map((projection) => projection.taskId),
    },
    l1Count: l1,
    l2Count: l2,
    l3Count: l3,
    gaps,
  };
}

function enrichContinuationEdges(
  model: MachineGraphModel,
  continuation: readonly ContinuationViewEntry[],
): MachineGraphEdge[] {
  const pairTier = new Map<string, { tier: string; partition: string; label: string; detail: string }>();
  for (const entry of continuation) {
    for (const candidate of entry.candidates) {
      const key = `${candidate.producerTaskId}:${entry.consumerTaskId}:${entry.qualifiedName}`;
      pairTier.set(key, {
        tier: candidate.l1Eligible ? "L1" : "L2",
        partition: candidate.partitionMatchStatus,
        label: `${candidate.producerTaskId}→${entry.consumerTaskId} ${candidate.partitionMatchStatus}`,
        detail: [
          "layer: continuation (WP-8 / UNION_CONTINUATION_INDEX)",
          `consumer: ${entry.consumerTaskId}`,
          `readOccurrenceId: ${entry.readOccurrenceId}`,
          `producer: ${candidate.producerTaskId}`,
          `writeObservationId: ${candidate.writeObservationId}`,
          `partitionMatchStatus: ${candidate.partitionMatchStatus}`,
          `l1Eligible: ${candidate.l1Eligible}`,
          `userTier: ${candidate.l1Eligible ? "L1" : "L2"}`,
        ].join("\n"),
      });
    }
  }

  return model.edges.map((edge) => {
    if (edge.kind !== "CROSS_TASK_PAIR") return edge;
    const producer = /producerTaskId: (\d+)/.exec(edge.detail)?.[1];
    const consumer = /consumerTaskId: (\d+)/.exec(edge.detail)?.[1];
    const table = /table: ([^\n]+)/.exec(edge.detail)?.[1];
    if (!producer || !consumer || !table) return edge;
    const enriched = pairTier.get(`${producer}:${consumer}:${table}`);
    if (!enriched) return edge;
    return {
      ...edge,
      label: enriched.label,
      detail: `${edge.detail}\n${enriched.detail}`,
      sourceLayer: "query_pair" as const,
      userTier: enriched.tier,
      partitionMatchStatus: enriched.partition,
    };
  });
}

export function buildFullStackGraphModel(
  projections: readonly TaskLocalProjection[],
  options: {
    readonly title?: string;
    readonly inputMode?: "demo" | "projection";
    readonly continuationIndexPath?: string;
  } = {},
): FullStackGraphModel {
  const base = buildMachineGraphModel(projections, { title: options.title });
  const continuation = options.continuationIndexPath && existsSync(options.continuationIndexPath)
    ? continuationFromIndex(
      JSON.parse(readFileSync(resolve(options.continuationIndexPath), "utf8")) as UnionContinuationIndex,
    )
    : buildDemoContinuationEntries(projections);

  const projection: MachineGraphModel = {
    ...base,
    edges: enrichContinuationEdges(base, continuation),
  };

  return {
    title: options.title ?? base.title,
    inputMode: options.inputMode ?? "projection",
    facts: summarizeFacts(projections),
    projection,
    continuation,
    narrative: buildNarrative(projections, continuation),
  };
}

export function renderFullStackGraphHtml(model: FullStackGraphModel): string {
  const payload = JSON.stringify(model);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(model.title)}</title>
  <script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
  <style>
    :root { color-scheme: light dark; --bg:#0f1419; --panel:#1a222c; --text:#e7ecf3; --muted:#9aa7b5; --border:#2d3a47; --l1:#4ade80; --l2:#facc15; --l3:#f87171; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:"Segoe UI",system-ui,sans-serif; background:var(--bg); color:var(--text); }
    header { padding:12px 16px; border-bottom:1px solid var(--border); background:var(--panel); }
    h1 { margin:0 0 8px; font-size:18px; }
    .sub { color:var(--muted); font-size:13px; line-height:1.5; }
    .layers { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:12px 0 4px; }
    .layer { border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:#121820; font-size:12px; }
    .layer strong { display:block; margin-bottom:4px; }
    .stats { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
    .stat { border-radius:8px; padding:6px 10px; font-size:12px; border:1px solid var(--border); background:#121820; }
    .stat.l1 { border-color:var(--l1); } .stat.l2 { border-color:var(--l2); } .stat.l3 { border-color:var(--l3); }
    main { display:grid; grid-template-columns:300px 1fr 340px; height:calc(100vh - 190px); }
    aside,.detail,.bottom { border-right:1px solid var(--border); background:var(--panel); overflow:auto; padding:12px; }
    .detail { border-right:none; border-left:1px solid var(--border); }
    #cy { width:100%; height:100%; background:radial-gradient(circle at top,#18202a,#0f1419); }
    fieldset { border:1px solid var(--border); border-radius:8px; margin:0 0 10px; padding:8px 10px; }
    legend { padding:0 4px; color:var(--muted); font-size:12px; }
    label { display:flex; gap:8px; align-items:center; font-size:13px; margin:4px 0; }
    button { background:#2f6fed; color:white; border:none; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:13px; margin:0 6px 6px 0; }
    button.secondary { background:#334155; }
    pre,table { font-size:12px; line-height:1.45; }
    pre { white-space:pre-wrap; word-break:break-word; margin:0; color:#d6e0ea; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid var(--border); padding:4px 6px; text-align:left; vertical-align:top; }
    .pill { display:inline-block; border-radius:999px; padding:2px 8px; font-size:11px; margin-right:6px; background:#243041; }
    .tier-L1 { color:var(--l1); } .tier-L2 { color:var(--l2); } .tier-L3 { color:var(--l3); }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(model.title)}</h1>
    <div class="sub">四层全貌：Facts 摘要 → 任务内投影 → 跨任务接续（分区/L1）→ 用户陈述（L0–L3）。粉色/绿色虚线 = 接续边，颜色表示 L1/L2。</div>
    <div class="layers">
      <div class="layer"><strong>① Facts</strong>Machine Facts / 字段绑定 / 写观察 / 读次（本页只显示每任务统计）</div>
      <div class="layer"><strong>② 任务内投影</strong>TASK / WRITE / READ / 表 / 字段值边 / 控制边</div>
      <div class="layer"><strong>③ 跨任务接续</strong>读次×写观察×分区；CROSS_TASK_PAIR 升级带 partitionMatchStatus</div>
      <div class="layer"><strong>④ 用户陈述</strong>L0 覆盖 / L1 确定 / L2 候选 / L3 缺口（右侧与下表）</div>
    </div>
    <div class="stats">
      <div class="stat">L0 已投影 ${model.narrative.l0.projected} 任务</div>
      <div class="stat l1">L1 读次 ${model.narrative.l1Count}</div>
      <div class="stat l2">L2 读次 ${model.narrative.l2Count}</div>
      <div class="stat l3">L3 缺口 ${model.narrative.l3Count}</div>
      <div class="stat">模式 ${model.inputMode}</div>
    </div>
  </header>
  <main>
    <aside>
      <fieldset><legend>图层</legend>
        <label><input type="checkbox" class="layer-toggle" value="structure" checked /> 结构（WRITE/READ）</label>
        <label><input type="checkbox" class="layer-toggle" value="control" checked /> 控制（DATASET_CONTROL）</label>
        <label><input type="checkbox" class="layer-toggle" value="value" /> 值（FIELD_DIRECT）</label>
        <label><input type="checkbox" class="layer-toggle" value="continuation" checked /> 接续（CROSS_TASK_PAIR）</label>
      </fieldset>
      <button id="fit">适配视图</button>
      <button class="secondary" id="preset-full">四层默认</button>
      <h3 style="font-size:13px;margin:12px 0 6px">Facts 摘要</h3>
      <table><tr><th>任务</th><th>写</th><th>读</th><th>值边</th><th>控制</th></tr>
      ${model.facts.map((f) => `<tr><td>${escapeHtml(f.taskId)}</td><td>${f.finalWrites}</td><td>${f.externalReads}</td><td>${f.fieldDirectEdges}</td><td>${f.datasetControlEdges}</td></tr>`).join("")}
      </table>
      <h3 style="font-size:13px;margin:12px 0 6px">接续表</h3>
      <table><tr><th>消费</th><th>表</th><th>层</th></tr>
      ${model.continuation.map((c) => `<tr><td>${escapeHtml(c.consumerTaskId)}</td><td>${escapeHtml(c.qualifiedName.split(".").pop() ?? c.qualifiedName)}</td><td class="tier-${c.userTier}">${c.userTier}</td></tr>`).join("")}
      </table>
    </aside>
    <section id="cy"></section>
    <section class="detail">
      <div id="selection-meta" class="sub">点击图元素查看详情</div>
      <pre id="selection-detail"></pre>
      <h3 style="font-size:13px;margin:12px 0 6px">L3 缺口</h3>
      <pre>${escapeHtml(model.narrative.gaps.map((g) => `[${g.reasonCode}] ${g.taskId ?? "?"} / ${g.qualifiedName ?? "?"}: ${g.message}`).join("\n") || "（无）")}</pre>
    </section>
  </main>
  <script>
    const model = ${payload};
    const cy = cytoscape({
      container: document.getElementById("cy"),
      style: [
        { selector: "node", style: {
          label: "data(label)", "text-wrap": "wrap", "text-max-width": 130, "font-size": 10, color: "#e2e8f0",
          "text-valign": "center", "text-halign": "center", "background-color": "data(color)", "border-width": 2,
          "border-color": "#0f172a", width: 46, height: 46, shape: "data(shape)",
        }},
        { selector: "edge", style: {
          label: "data(label)", "font-size": 9, color: "#cbd5e1", "curve-style": "bezier",
          "target-arrow-shape": "triangle", "line-color": "data(color)", "target-arrow-color": "data(color)", width: 2,
        }},
        { selector: "edge[kind = 'CROSS_TASK_PAIR']", style: { "line-style": "dashed", width: 3 }},
        { selector: ":selected", style: { "border-color": "#fbbf24", "line-color": "#fbbf24", "target-arrow-color": "#fbbf24" }},
      ],
      layout: { name: "breadthfirst", directed: true, padding: 30 },
      elements: {
        nodes: model.projection.nodes.map((node) => ({
          data: {
            id: node.id, label: node.label, kind: node.kind, detail: node.detail,
            color: ({ TASK:"#4A90D9", TARGET_WRITE:"#E67E22", READ_OCCURRENCE:"#1ABC9C", PHYSICAL_DATASET:"#50C878", PHYSICAL_FIELD:"#9B59B6" })[node.kind] || "#64748b",
            shape: node.kind === "PHYSICAL_DATASET" || node.kind === "TASK" ? "round-rectangle" : node.kind.includes("WRITE") || node.kind.includes("READ") ? "diamond" : "ellipse",
            layer: node.kind === "PHYSICAL_FIELD" ? "value" : node.kind === "TASK" || node.kind.includes("WRITE") || node.kind.includes("READ") || node.kind === "PHYSICAL_DATASET" ? "structure" : "structure",
          },
        })),
        edges: model.projection.edges.map((edge) => ({
          data: {
            id: edge.id, source: edge.source, target: edge.target, kind: edge.kind, label: edge.label, detail: edge.detail,
            color: edge.kind === "CROSS_TASK_PAIR" ? (edge.userTier === "L1" ? "#4ade80" : edge.userTier === "L2" ? "#facc15" : "#f472b6") :
              edge.kind === "DATASET_CONTROL" ? "#f87171" : edge.kind === "FIELD_DIRECT" ? "#60a5fa" : "#94a3b8",
            layer: edge.kind === "CROSS_TASK_PAIR" ? "continuation" : edge.kind === "DATASET_CONTROL" ? "control" : edge.kind === "FIELD_DIRECT" ? "value" : "structure",
          },
        })),
      },
    });
    const meta = document.getElementById("selection-meta");
    const detail = document.getElementById("selection-detail");
    function applyLayers() {
      const on = new Set([...document.querySelectorAll(".layer-toggle:checked")].map((el) => el.value));
      cy.nodes().forEach((n) => n.style("display", on.has(n.data("layer")) ? "element" : "none"));
      cy.edges().forEach((e) => {
        const ok = on.has(e.data("layer")) && e.source().style("display") !== "none" && e.target().style("display") !== "none";
        e.style("display", ok ? "element" : "none");
      });
      cy.layout({ name: "breadthfirst", directed: true, padding: 30 }).run();
    }
    document.querySelectorAll(".layer-toggle").forEach((el) => el.addEventListener("change", applyLayers));
    document.getElementById("fit").onclick = () => cy.fit(undefined, 40);
    document.getElementById("preset-full").onclick = () => { document.querySelectorAll(".layer-toggle").forEach((el) => { el.checked = el.value !== "value"; }); applyLayers(); };
    cy.on("tap", "node, edge", (ev) => {
      const ele = ev.target;
      meta.innerHTML = '<span class="pill">' + ele.data("kind") + '</span> ' + (ele.isNode() ? "node" : "edge");
      detail.textContent = ele.data("detail") || "";
    });
    applyLayers(); cy.fit(undefined, 40);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}
