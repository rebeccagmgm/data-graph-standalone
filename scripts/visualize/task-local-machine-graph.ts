import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runInputPackMachineFacts } from "../machine-facts/input-pack-machine-facts.ts";
import { writeTableInput, writeTaskInput } from "../input/shared/input-pack.ts";
import { projectTaskLocal } from "../project-graph/task-local/project-task-local.ts";
import type {
  TaskLocalEdge,
  TaskLocalNode,
  TaskLocalProjection,
} from "../project-graph/task-local/contract.ts";

export interface MachineGraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly taskId: string | null;
  readonly detail: string;
  readonly source: "projection" | "query_pair";
}

export interface MachineGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly label: string;
  readonly detail: string;
  readonly sourceLayer: "projection" | "query_pair";
  readonly userTier?: "L1" | "L2" | "L3" | string;
  readonly partitionMatchStatus?: string;
}

export interface MachineGraphModel {
  readonly title: string;
  readonly projections: readonly {
    readonly taskId: string;
    readonly contentHash: string;
    readonly nodeCount: number;
    readonly edgeCount: number;
  }[];
  readonly nodes: readonly MachineGraphNode[];
  readonly edges: readonly MachineGraphEdge[];
}

const NODE_KINDS = [
  "TASK",
  "TARGET_WRITE",
  "READ_OCCURRENCE",
  "PHYSICAL_DATASET",
  "PHYSICAL_FIELD",
] as const;

const EDGE_KINDS = [
  "WRITES",
  "READS",
  "FIELD_DIRECT",
  "FIELD_CONDITIONAL",
  "DATASET_CONTROL",
  "CROSS_TASK_PAIR",
] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function shortId(nodeId: string): string {
  if (nodeId.startsWith("task:")) return `task:${nodeId.slice("task:".length)}`;
  if (nodeId.startsWith("write:")) {
    const parts = nodeId.split(":");
    return parts.length >= 3 ? `write:…${parts.at(-1)}` : nodeId;
  }
  if (nodeId.startsWith("read:")) {
    const parts = nodeId.split(":");
    return parts.length >= 2 ? `read:…${parts.at(-1)!.slice(0, 12)}` : nodeId;
  }
  if (nodeId.startsWith("dataset:")) {
    const parts = nodeId.split(":");
    return parts.length >= 4 ? parts.slice(3).join(":") : nodeId;
  }
  if (nodeId.startsWith("field:")) {
    const parts = nodeId.split(":");
    return parts.length >= 2 ? `…${parts.at(-1)}` : nodeId;
  }
  return nodeId;
}

function taskIdFromNode(node: TaskLocalNode): string | null {
  if (node.nodeType === "TASK") {
    return text(node.properties.taskId) || node.nodeId.slice("task:".length);
  }
  const fromProps = text(node.properties.taskId);
  if (fromProps) return fromProps;
  const nodeId = node.nodeId;
  const writeMatch = /^write:([^:]+):/.exec(nodeId);
  if (writeMatch) return writeMatch[1] ?? null;
  const readMatch = /^read:([^:]+):/.exec(nodeId);
  if (readMatch) return readMatch[1] ?? null;
  return null;
}

function taskIdFromNodeId(nodeId: string): string | null {
  if (nodeId.startsWith("task:")) return nodeId.slice("task:".length);
  const scoped = /^(?:write|read):([^:]+):/.exec(nodeId);
  return scoped?.[1] ?? null;
}

function nodeLabel(node: TaskLocalNode): string {
  switch (node.nodeType) {
    case "TASK": {
      const taskId = taskIdFromNodeId(node.nodeId);
      const taskName = text(node.properties.taskName);
      if (taskId && taskName) return `${taskId} · ${taskName}`;
      return taskId || taskName || shortId(node.nodeId);
    }
    case "PHYSICAL_DATASET":
      return text(node.properties.qualifiedName) || shortId(node.nodeId);
    case "PHYSICAL_FIELD":
      return `${text(node.properties.qualifiedName)}.${text(node.properties.column)}`;
    case "TARGET_WRITE":
      return `WRITE ${text(node.properties.qualifiedName) || shortId(node.nodeId)}`;
    case "READ_OCCURRENCE":
      return `READ ${text(node.properties.qualifiedName) || shortId(node.nodeId)}`;
    default:
      return shortId(node.nodeId);
  }
}

function nodeDetail(node: TaskLocalNode): string {
  const lines = [`nodeId: ${node.nodeId}`, `nodeType: ${node.nodeType}`];
  for (const [key, value] of Object.entries(node.properties)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines.join("\n");
}

function edgeLabel(edge: TaskLocalEdge): string {
  if (edge.edgeType === "FIELD_DIRECT" || edge.edgeType === "FIELD_CONDITIONAL") {
    const subtype = text(edge.properties.subtype);
    const output = text(edge.properties.outputColumn);
    return [edge.edgeType, subtype, output].filter(Boolean).join(" ");
  }
  if (edge.edgeType === "DATASET_CONTROL") {
    const subtype = text(edge.properties.subtype);
    const grain = text(edge.properties.grain);
    return [subtype, grain].filter(Boolean).join(" / ");
  }
  return edge.edgeType;
}

function edgeDetail(edge: TaskLocalEdge): string {
  const lines = [
    `edgeId: ${edge.edgeId}`,
    `edgeType: ${edge.edgeType}`,
    `from: ${edge.fromNodeId}`,
    `to: ${edge.toNodeId}`,
  ];
  for (const [key, value] of Object.entries(edge.properties)) {
    if (value === null || value === undefined) continue;
    lines.push(`${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return lines.join("\n");
}

export function buildCrossTaskPairs(
  projections: readonly TaskLocalProjection[],
): MachineGraphEdge[] {
  const pairs: MachineGraphEdge[] = [];
  const writesByTable = new Map<string, { taskId: string; writeNodeId: string; qualifiedName: string }[]>();

  for (const projection of projections) {
    for (const write of projection.localClosure?.finalWrites ?? []) {
      const key = write.qualifiedName;
      const bucket = writesByTable.get(key) ?? [];
      bucket.push({
        taskId: projection.taskId,
        writeNodeId: write.targetWriteNodeId,
        qualifiedName: write.qualifiedName,
      });
      writesByTable.set(key, bucket);
    }
  }

  for (const projection of projections) {
    for (const read of projection.localClosure?.externalReads ?? []) {
      const candidates = writesByTable.get(read.qualifiedName) ?? [];
      for (const write of candidates) {
        if (write.taskId === projection.taskId) continue;
        pairs.push({
          id: `pair:${write.writeNodeId}->${read.readOccurrenceNodeId}`,
          source: write.writeNodeId,
          target: read.readOccurrenceNodeId,
          kind: "CROSS_TASK_PAIR",
          label: `${write.taskId} write × ${projection.taskId} read`,
          detail: [
            "layer: query-time pairing (not stored in TASK_LOCAL_PROJECTION)",
            `table: ${read.qualifiedName}`,
            `producerTaskId: ${write.taskId}`,
            `consumerTaskId: ${projection.taskId}`,
            `writeObservation via node: ${write.writeNodeId}`,
            `readOccurrence via node: ${read.readOccurrenceNodeId}`,
          ].join("\n"),
          sourceLayer: "query_pair",
        });
      }
    }
  }
  return pairs;
}

export function buildMachineGraphModel(
  projections: readonly TaskLocalProjection[],
  options: { readonly title?: string } = {},
): MachineGraphModel {
  const nodeMap = new Map<string, MachineGraphNode>();
  const edges: MachineGraphEdge[] = [];

  for (const projection of projections) {
    for (const node of projection.nodes) {
      if (nodeMap.has(node.nodeId)) continue;
      nodeMap.set(node.nodeId, {
        id: node.nodeId,
        label: nodeLabel(node),
        kind: node.nodeType,
        taskId: taskIdFromNode(node),
        detail: nodeDetail(node),
        source: "projection",
      });
    }
    for (const edge of projection.edges) {
      edges.push({
        id: edge.edgeId,
        source: edge.fromNodeId,
        target: edge.toNodeId,
        kind: edge.edgeType,
        label: edgeLabel(edge),
        detail: edgeDetail(edge),
        sourceLayer: "projection",
      });
    }
  }

  edges.push(...buildCrossTaskPairs(projections));

  return {
    title: options.title ?? `Machine graph (${projections.map((p) => p.taskId).join(", ")})`,
    projections: projections.map((projection) => ({
      taskId: projection.taskId,
      contentHash: projection.contentHash,
      nodeCount: projection.nodes.length,
      edgeCount: projection.edges.length,
    })),
    nodes: [...nodeMap.values()],
    edges,
  };
}

export function renderMachineGraphHtml(model: MachineGraphModel): string {
  const payload = JSON.stringify(model);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(model.title)}</title>
  <script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1419;
      --panel: #1a222c;
      --text: #e7ecf3;
      --muted: #9aa7b5;
      --border: #2d3a47;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
    }
    h1 { margin: 0 0 4px; font-size: 18px; }
    .sub { color: var(--muted); font-size: 13px; }
    main { display: grid; grid-template-columns: 280px 1fr 320px; height: calc(100vh - 72px); }
    aside, .detail {
      border-right: 1px solid var(--border);
      background: var(--panel);
      overflow: auto;
      padding: 12px;
    }
    .detail { border-right: none; border-left: 1px solid var(--border); }
    #cy { width: 100%; height: 100%; background: radial-gradient(circle at top, #18202a, #0f1419); }
    fieldset { border: 1px solid var(--border); border-radius: 8px; margin: 0 0 12px; padding: 8px 10px; }
    legend { padding: 0 4px; color: var(--muted); font-size: 12px; }
    label { display: flex; gap: 8px; align-items: center; font-size: 13px; margin: 4px 0; }
    button {
      background: #2f6fed;
      color: white;
      border: none;
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 13px;
      margin-right: 6px;
      margin-bottom: 6px;
    }
    button.secondary { background: #334155; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.45;
      margin: 0;
      color: #d6e0ea;
    }
    .pill {
      display: inline-block;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      margin-right: 6px;
      background: #243041;
      color: #cbd5e1;
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(model.title)}</h1>
    <div class="sub">机器图全貌：5 种节点 + 任务内边 + 查询期 CROSS_TASK_PAIR（粉色虚线）。默认显示结构层与控制边；字段边太多时点「值路径样例」。</div>
  </header>
  <main>
    <aside>
      <fieldset>
        <legend>节点类型</legend>
        ${NODE_KINDS.map((kind) => `<label><input type="checkbox" class="node-kind" value="${kind}" ${kind === "PHYSICAL_FIELD" ? "" : "checked"} /> ${kind}</label>`).join("")}
      </fieldset>
      <fieldset>
        <legend>边类型</legend>
        ${EDGE_KINDS.map((kind) => `<label><input type="checkbox" class="edge-kind" value="${kind}" ${kind === "FIELD_DIRECT" || kind === "FIELD_CONDITIONAL" ? "" : "checked"} /> ${kind}</label>`).join("")}
      </fieldset>
      <button id="fit">适配视图</button>
      <button class="secondary" id="overview">全貌（结构+控制）</button>
      <button class="secondary" id="value-sample">值路径样例</button>
      <button class="secondary" id="all">全部显示</button>
      <div class="sub" style="margin-top:8px">点节点/边看 machine id。CROSS_TASK_PAIR 不在投影 JSON 里，是查询时按同表配对画出来的。</div>
    </aside>
    <section id="cy"></section>
    <section class="detail">
      <div id="selection-meta" class="sub">点击节点或边查看详情</div>
      <pre id="selection-detail"></pre>
    </section>
  </main>
  <script>
    const model = ${payload};
    const kindColors = {
      TASK: "#4A90D9",
      TARGET_WRITE: "#E67E22",
      READ_OCCURRENCE: "#1ABC9C",
      PHYSICAL_DATASET: "#50C878",
      PHYSICAL_FIELD: "#9B59B6",
    };
    const edgeColors = {
      WRITES: "#94a3b8",
      READS: "#94a3b8",
      FIELD_DIRECT: "#60a5fa",
      FIELD_CONDITIONAL: "#c084fc",
      DATASET_CONTROL: "#f87171",
      CROSS_TASK_PAIR: "#f472b6",
    };

    const cy = cytoscape({
      container: document.getElementById("cy"),
      style: [
        {
          selector: "node",
          style: {
            "label": "data(label)",
            "text-wrap": "wrap",
            "text-max-width": 140,
            "font-size": 10,
            "color": "#e2e8f0",
            "text-valign": "center",
            "text-halign": "center",
            "background-color": "data(color)",
            "border-width": 2,
            "border-color": "#0f172a",
            "width": "mapData(kind, TASK, 56, PHYSICAL_FIELD, 28)",
            "height": "mapData(kind, TASK, 56, PHYSICAL_FIELD, 28)",
            "shape": "data(shape)",
          },
        },
        {
          selector: "edge",
          style: {
            "label": "data(label)",
            "font-size": 9,
            "color": "#cbd5e1",
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "line-color": "data(color)",
            "target-arrow-color": "data(color)",
            "width": 2,
            "text-rotation": "autorotate",
          },
        },
        {
          selector: "edge[kind = 'CROSS_TASK_PAIR']",
          style: {
            "line-style": "dashed",
            "width": 3,
          },
        },
        {
          selector: ":selected",
          style: {
            "border-color": "#fbbf24",
            "line-color": "#fbbf24",
            "target-arrow-color": "#fbbf24",
          },
        },
      ],
      layout: { name: "breadthfirst", directed: true, padding: 30, spacingFactor: 1.1 },
      elements: {
        nodes: model.nodes.map((node) => ({
          data: {
            id: node.id,
            label: node.label,
            kind: node.kind,
            detail: node.detail,
            color: kindColors[node.kind] || "#64748b",
            shape: node.kind === "PHYSICAL_DATASET" ? "round-rectangle"
              : node.kind === "TASK" ? "round-rectangle"
              : node.kind === "TARGET_WRITE" || node.kind === "READ_OCCURRENCE" ? "diamond"
              : "ellipse",
          },
        })),
        edges: model.edges.map((edge) => ({
          data: {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            kind: edge.kind,
            label: edge.label,
            detail: edge.detail,
            color: edgeColors[edge.kind] || "#64748b",
          },
        })),
      },
    });

    const meta = document.getElementById("selection-meta");
    const detail = document.getElementById("selection-detail");

    function applyFilters() {
      const nodeKinds = new Set([...document.querySelectorAll(".node-kind:checked")].map((el) => el.value));
      const edgeKinds = new Set([...document.querySelectorAll(".edge-kind:checked")].map((el) => el.value));
      cy.nodes().forEach((node) => {
        node.style("display", nodeKinds.has(node.data("kind")) ? "element" : "none");
      });
      cy.edges().forEach((edge) => {
        const visible = edgeKinds.has(edge.data("kind"))
          && edge.source().style("display") !== "none"
          && edge.target().style("display") !== "none";
        edge.style("display", visible ? "element" : "none");
      });
      cy.layout({ name: "breadthfirst", directed: true, padding: 30, spacingFactor: 1.05 }).run();
    }

    for (const input of document.querySelectorAll(".node-kind, .edge-kind")) {
      input.addEventListener("change", applyFilters);
    }

    document.getElementById("fit").addEventListener("click", () => cy.fit(undefined, 40));
    function setPreset(preset) {
      if (preset === "overview") {
        for (const input of document.querySelectorAll(".node-kind")) {
          input.checked = input.value !== "PHYSICAL_FIELD";
        }
        for (const input of document.querySelectorAll(".edge-kind")) {
          input.checked = ["WRITES", "READS", "DATASET_CONTROL", "CROSS_TASK_PAIR"].includes(input.value);
        }
      } else if (preset === "value-sample") {
        for (const input of document.querySelectorAll(".node-kind")) input.checked = true;
        for (const input of document.querySelectorAll(".edge-kind")) {
          input.checked = ["WRITES", "READS", "FIELD_DIRECT", "CROSS_TASK_PAIR"].includes(input.value);
        }
      }
      applyFilters();
    }
    document.getElementById("overview").addEventListener("click", () => setPreset("overview"));
    document.getElementById("value-sample").addEventListener("click", () => setPreset("value-sample"));
    document.getElementById("all").addEventListener("click", () => {
      for (const input of document.querySelectorAll(".node-kind, .edge-kind")) input.checked = true;
      applyFilters();
    });

    cy.on("tap", "node, edge", (event) => {
      const ele = event.target;
      meta.innerHTML = '<span class="pill">' + ele.data("kind") + '</span> ' + (ele.isNode() ? "node" : "edge");
      detail.textContent = ele.data("detail") || "";
    });

    setPreset("overview");
    cy.fit(undefined, 40);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

export function buildZipperDemoProjections(): TaskLocalProjection[] {
  return buildDemoProjections({
    cacheKey: "zipper",
    taskIds: ["71698", "105387"],
    setup: setupZipperDemoTables,
    tasks: writeZipperDemoTasks,
  });
}

export function buildGoldChainDemoProjections(): TaskLocalProjection[] {
  return buildDemoProjections({
    cacheKey: "gold-chain",
    taskIds: ["105387", "119044", "176827"],
    setup: setupGoldChainDemoTables,
    tasks: writeGoldChainDemoTasks,
  });
}

interface DemoProjectionBuildInput {
  readonly cacheKey: string;
  readonly taskIds: readonly string[];
  readonly setup: (dataRoot: string) => void;
  readonly tasks: (dataRoot: string) => void;
}

function buildDemoProjections(input: DemoProjectionBuildInput): TaskLocalProjection[] {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), `../../.tmp-machine-graph-demo-${input.cacheKey}`);
  const dataRoot = join(parent, "data");
  const factsRoot = join(parent, "facts");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(factsRoot, { recursive: true });
  input.setup(dataRoot);
  input.tasks(dataRoot);
  runInputPackMachineFacts({
    dataRoot,
    taskIds: [...input.taskIds],
    outputRoot: factsRoot,
  });
  return input.taskIds.map((taskId) => projectTaskLocal({
    dataRoot,
    factsRoot,
    taskId,
    generatedAt: "2026-09-03T00:00:00.000Z",
  }));
}

function writeDemoTable(
  dataRoot: string,
  qualifiedName: string,
  columns: string,
): void {
  writeTableInput(dataRoot, {
    platform: "hive",
    dataSource: "pdata_n",
    qualifiedName,
    objectType: "hive_table",
    partitionFields: [],
    ddl: `CREATE TABLE ${qualifiedName} (${columns});`,
    evidenceProvider: "synthetic:machine-graph-demo",
    collectedAt: "2026-01-01T00:00:00.000Z",
  });
}

function setupZipperDemoTables(dataRoot: string): void {
  const zipperTables = [
    "pdata_n.d_ref_fx_forward",
    "pdata_n.d_ref_fast_trs",
    "pdata_n.d_ref_otc_option_deal",
    "pdata_n.d_ref_trs",
  ];
  for (const table of [
    { qualifiedName: "pdata_n.t03_agt_stati_info_h", columns: "internal_trade_id STRING, stati_cont_desc STRING, inr_ord_id STRING" },
    { qualifiedName: "pdata_n.lineage_trades", columns: "internal_trade_id STRING, k STRING, v STRING" },
    ...zipperTables.map((qualifiedName) => ({
      qualifiedName,
      columns: "k STRING, v STRING",
    })),
  ]) {
    writeDemoTable(dataRoot, table.qualifiedName, table.columns);
  }
}

function writeZipperDemoTasks(dataRoot: string): void {
  writeTaskInput(dataRoot, {
    taskId: "71698",
    taskCategory: "sparkIndex",
    taskName: "lineage_trades_loader",
    target: {
      platform: "hive",
      dataSource: "pdata_n",
      qualifiedName: "pdata_n.lineage_trades",
    },
    targetEvidenceKind: "DIRECT_PLATFORM_TARGET",
    partition: null,
    sql: {
      query: {
        content:
          "INSERT OVERWRITE TABLE pdata_n.lineage_trades SELECT src.internal_trade_id AS internal_trade_id, src.k AS k, src.v AS v FROM pdata_n.lineage_trades src",
        evidenceProvider: "synthetic:machine-graph-demo",
      },
    },
    evidenceProvider: "synthetic:machine-graph-demo",
    collectedAt: "2026-01-01T00:00:00.000Z",
  });
  writeTaskInput(dataRoot, {
    taskId: "105387",
    taskCategory: "sparkIndex",
    taskName: "t03_agt_stati_zipper",
    target: {
      platform: "hive",
      dataSource: "pdata_n",
      qualifiedName: "pdata_n.t03_agt_stati_info_h",
    },
    targetEvidenceKind: "DIRECT_PLATFORM_TARGET",
    partition: null,
    sql: {
      query: {
        content:
          "INSERT OVERWRITE TABLE pdata_n.t03_agt_stati_info_h SELECT t.internal_trade_id AS internal_trade_id, CASE WHEN r1.k IS NOT NULL THEN r1.v ELSE t.v END AS stati_cont_desc FROM pdata_n.lineage_trades t LEFT JOIN pdata_n.d_ref_fx_forward r1 ON t.k = r1.k LEFT JOIN pdata_n.d_ref_fast_trs r2 ON t.k = r2.k LEFT JOIN pdata_n.d_ref_otc_option_deal r3 ON t.k = r3.k LEFT JOIN pdata_n.d_ref_trs r4 ON t.k = r4.k",
        evidenceProvider: "synthetic:machine-graph-demo",
      },
    },
    evidenceProvider: "synthetic:machine-graph-demo",
    collectedAt: "2026-01-01T00:00:00.000Z",
  });
}

function setupGoldChainDemoTables(dataRoot: string): void {
  setupZipperDemoTables(dataRoot);
  for (const table of [
    {
      qualifiedName: "pdata_n.t03_otc_opt_comp_info",
      columns: "comp_id STRING, book_bel_dept STRING, agt_id STRING, src_tbl STRING, stati_cont_desc STRING",
      dataSource: "pdata_n",
    },
    {
      qualifiedName: "pdata_n.t98_sb_otc_opt_comp_info",
      columns: "comp_id STRING, book_bel_dept STRING, stati_cont_desc STRING, inr_ord_id STRING",
      dataSource: "pdata_n",
    },
    {
      qualifiedName: "dm_rsk_n.otc_opt_greek_val_det_h",
      columns: "comp_id STRING, book_bel_dept STRING, stati_cont_desc STRING",
      dataSource: "dm_rsk_n",
    },
    {
      qualifiedName: "pdata_n.t01_pty_name",
      columns: "pty_id STRING, pty_name STRING",
      dataSource: "pdata_n",
    },
  ]) {
    writeTableInput(dataRoot, {
      platform: "hive",
      dataSource: table.dataSource,
      qualifiedName: table.qualifiedName,
      objectType: "hive_table",
      partitionFields: [],
      ddl: `CREATE TABLE ${table.qualifiedName} (${table.columns});`,
      evidenceProvider: "synthetic:machine-graph-demo",
      collectedAt: "2026-01-01T00:00:00.000Z",
    });
  }
}

function writeGoldChainDemoTasks(dataRoot: string): void {
  writeTaskInput(dataRoot, {
    taskId: "105387",
    taskCategory: "sparkIndex",
    taskName: "t03_agt_stati_zipper",
    target: {
      platform: "hive",
      dataSource: "pdata_n",
      qualifiedName: "pdata_n.t03_agt_stati_info_h",
    },
    targetEvidenceKind: "DIRECT_PLATFORM_TARGET",
    partition: null,
    sql: {
      query: {
        content:
          "INSERT OVERWRITE TABLE pdata_n.t03_agt_stati_info_h SELECT t.internal_trade_id AS internal_trade_id, CASE WHEN r1.k IS NOT NULL THEN r1.v ELSE t.v END AS stati_cont_desc, t.internal_trade_id AS inr_ord_id FROM pdata_n.lineage_trades t LEFT JOIN pdata_n.d_ref_fx_forward r1 ON t.k = r1.k LEFT JOIN pdata_n.d_ref_fast_trs r2 ON t.k = r2.k LEFT JOIN pdata_n.d_ref_otc_option_deal r3 ON t.k = r3.k LEFT JOIN pdata_n.d_ref_trs r4 ON t.k = r4.k",
        evidenceProvider: "synthetic:machine-graph-demo",
      },
    },
    evidenceProvider: "synthetic:machine-graph-demo",
    collectedAt: "2026-01-01T00:00:00.000Z",
  });
  writeTaskInput(dataRoot, {
    taskId: "119044",
    taskCategory: "sparkIndex",
    taskName: "t98_sb_otc_opt_comp_info",
    target: {
      platform: "hive",
      dataSource: "pdata_n",
      qualifiedName: "pdata_n.t98_sb_otc_opt_comp_info",
    },
    targetEvidenceKind: "DIRECT_PLATFORM_TARGET",
    partition: null,
    sql: {
      query: {
        content:
          "INSERT OVERWRITE TABLE pdata_n.t98_sb_otc_opt_comp_info SELECT c.comp_id AS comp_id, c.book_bel_dept AS book_bel_dept, s.stati_cont_desc AS stati_cont_desc, s.inr_ord_id AS inr_ord_id FROM pdata_n.t03_otc_opt_comp_info c LEFT JOIN pdata_n.t03_agt_stati_info_h s ON c.agt_id = s.internal_trade_id LEFT JOIN pdata_n.t01_pty_name p ON c.comp_id = p.pty_id WHERE c.src_tbl = 'ODATA_N_TIT.D_TRD_OTC_TRADE'",
        evidenceProvider: "synthetic:machine-graph-demo",
      },
    },
    evidenceProvider: "synthetic:machine-graph-demo",
    collectedAt: "2026-01-01T00:00:00.000Z",
  });
  writeTaskInput(dataRoot, {
    taskId: "176827",
    taskCategory: "sparkIndex",
    taskName: "otc_opt_greek_val_det_h",
    target: {
      platform: "hive",
      dataSource: "dm_rsk_n",
      qualifiedName: "dm_rsk_n.otc_opt_greek_val_det_h",
    },
    targetEvidenceKind: "DIRECT_PLATFORM_TARGET",
    partition: null,
    sql: {
      query: {
        content:
          "INSERT OVERWRITE TABLE dm_rsk_n.otc_opt_greek_val_det_h SELECT t98.comp_id AS comp_id, t98.book_bel_dept AS book_bel_dept, t98.stati_cont_desc AS stati_cont_desc FROM pdata_n.t98_sb_otc_opt_comp_info t98",
        evidenceProvider: "synthetic:machine-graph-demo",
      },
    },
    evidenceProvider: "synthetic:machine-graph-demo",
    collectedAt: "2026-01-01T00:00:00.000Z",
  });
}

export interface TaskLocalMachineGraphCliOptions {
  readonly projectionPaths: readonly string[];
  readonly outputPath: string;
  readonly demoZipper: boolean;
  readonly demoGoldChain: boolean;
  readonly fullStack: boolean;
  readonly continuationIndexPath?: string;
  readonly title?: string;
}

export function parseTaskLocalMachineGraphCli(args: readonly string[]): TaskLocalMachineGraphCliOptions {
  const projectionPaths: string[] = [];
  let outputPath: string | undefined;
  let title: string | undefined;
  let demoZipper = false;
  let demoGoldChain = false;
  let fullStack = false;
  let continuationIndexPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--projection" && args[index + 1]) {
      projectionPaths.push(resolve(args[index + 1]!));
      index += 1;
      continue;
    }
    if (arg === "--output" && args[index + 1]) {
      outputPath = resolve(args[index + 1]!);
      index += 1;
      continue;
    }
    if (arg === "--title" && args[index + 1]) {
      title = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--demo-zipper") {
      demoZipper = true;
    }
    if (arg === "--demo-gold-chain") {
      demoGoldChain = true;
    }
    if (arg === "--full-stack") {
      fullStack = true;
    }
    if (arg === "--continuation-index" && args[index + 1]) {
      continuationIndexPath = resolve(args[index + 1]!);
      index += 1;
    }
  }
  if (!outputPath) {
    throw new Error(
      "usage: visualize-task-local-machine-graph --output <path.html> [--projection <task-local-projection.json> ...] [--demo-zipper] [--demo-gold-chain] [--full-stack] [--continuation-index <index.json>] [--title <text>]",
    );
  }
  if (!demoZipper && !demoGoldChain && projectionPaths.length === 0) {
    throw new Error("provide --projection, --demo-zipper, or --demo-gold-chain");
  }
  if ((demoZipper ? 1 : 0) + (demoGoldChain ? 1 : 0) + (projectionPaths.length > 0 ? 1 : 0) > 1) {
    throw new Error("choose only one input mode: --projection, --demo-zipper, or --demo-gold-chain");
  }
  return { projectionPaths, outputPath, demoZipper, demoGoldChain, fullStack, continuationIndexPath, title };
}

import {
  buildFullStackGraphModel,
  renderFullStackGraphHtml,
} from "./full-stack-machine-graph.ts";

export function runTaskLocalMachineGraphCli(options: TaskLocalMachineGraphCliOptions): string {
  const projections = options.demoGoldChain
    ? buildGoldChainDemoProjections()
    : options.demoZipper
      ? buildZipperDemoProjections()
      : options.projectionPaths.map((path) => {
        if (!existsSync(path)) throw new Error(`PROJECTION_NOT_FOUND:${path}`);
        return JSON.parse(readFileSync(path, "utf8")) as TaskLocalProjection;
      });
  const title = options.title ?? (options.demoGoldChain
    ? "Machine graph demo: 105387 → 119044 → 176827 (gold chain)"
    : options.demoZipper
      ? "Machine graph demo: 71698 → 105387 zipper"
      : `Machine graph (${projections.map((p) => p.taskId).join(", ")})`);

  const html = options.fullStack
    ? renderFullStackGraphHtml(buildFullStackGraphModel(projections, {
      title: options.fullStack && options.demoGoldChain
        ? "全貌 demo: Facts → 投影 → 接续 → L0–L3（105387 → 119044 → 176827）"
        : title,
      inputMode: options.demoGoldChain || options.demoZipper ? "demo" : "projection",
      continuationIndexPath: options.continuationIndexPath,
    }))
    : renderMachineGraphHtml(buildMachineGraphModel(projections, { title }));
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, html, "utf8");
  return options.outputPath;
}

if (process.argv[1] && basename(process.argv[1]).includes("task-local-machine-graph")) {
  const outputPath = runTaskLocalMachineGraphCli(parseTaskLocalMachineGraphCli(process.argv.slice(2)));
  console.log(outputPath);
}
