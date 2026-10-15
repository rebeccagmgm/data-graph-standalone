import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  resolveScheduleEvidenceCacheRoot,
} from "../evidence/schedule-evidence-cache.ts";
import { horaeRelationLookupFromSqlite } from "../input/mainline/expand-horae-relation-closure.ts";
import {
  taskIdsFromFile,
  type HoraeRelationHopLookup,
} from "../input/mainline/fill-horae-relation-cache.ts";

const DEFAULT_PORT = 8765;
const DEFAULT_SEED_FILE =
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data/tmp/from-cache-full/partial-analysis/dm-otc-n/ids-dm-otc-n-all.txt";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickString(obj: Record<string, unknown> | undefined, keys: readonly string[]): string {
  if (!obj) return "";
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function tableFromPayload(payloadJson: string | null): string {
  if (!payloadJson) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return "";
  }
  const root = asRecord(parsed);
  const detail = asRecord(root?.detail) ?? root;
  return (
    pickString(detail, ["targetTable", "qualifiedName", "tableName", "taskName", "name"]) ||
    pickString(asRecord(detail?.syncInfo), ["targetTable"])
  );
}

function defaultSqlitePath(cacheRoot: string): string {
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    "tasks-sqlite",
    "schedule-evidence.sqlite",
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function pageHtml(seedCount: number): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>Horae relation 树（按点展开）</title>
  <style>
    html, body { margin: 0; height: 100%; font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; background: #111; color: #ddd; }
    #bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #333; background: #1a1a1a; flex-wrap: wrap; }
    #bar input { width: 160px; padding: 4px 8px; background: #222; color: #eee; border: 1px solid #444; }
    #bar button { padding: 4px 10px; background: #2a2a2a; color: #eee; border: 1px solid #555; cursor: pointer; }
    #zoomPct { min-width: 3.5em; color: #aaa; }
    #hint { color: #888; font-size: 12px; }
    #stage { position: relative; height: calc(100% - 48px); overflow: hidden; cursor: grab; }
    #stage.drag { cursor: grabbing; }
    svg { width: 100%; height: 100%; display: block; }
    .node rect { fill: #222; stroke: #666; }
    .node.seed rect { stroke: #c9a227; }
    .node text { fill: #eee; font-size: 11px; }
    .edge.up { stroke: #6ea8fe; }
    .edge.down { stroke: #7dcea0; }
    .edge { fill: none; stroke-width: 1.2; }
  </style>
</head>
<body>
  <div id="bar">
    <input id="taskId" placeholder="调度 ID" />
    <button id="open">打开为根</button>
    <button id="zoomIn" title="放大">放大</button>
    <button id="zoomOut" title="缩小">缩小</button>
    <button id="fit">适应窗口</button>
    <span id="zoomPct">100%</span>
    <span id="hint">种子 ${seedCount} 个。滚轮缩放，拖空白平移，点节点展开。展开后可点「适应窗口」看全貌。</span>
  </div>
  <div id="stage"><svg id="svg"></svg></div>
  <script>
    const svg = document.getElementById("svg");
    const stage = document.getElementById("stage");
    const NS = "http://www.w3.org/2000/svg";
    const cam = { x: 40, y: 40, k: 1 };
    let world = null;
    let dragging = false, last = { x: 0, y: 0 };
    const nodes = new Map();
    const edges = [];
    const NODE_W = 180, NODE_H = 36;

    function applyCam() {
      if (world) world.setAttribute("transform", "translate(" + cam.x + " " + cam.y + ") scale(" + cam.k + ")");
      document.getElementById("zoomPct").textContent = Math.round(cam.k * 100) + "%";
    }
    function zoomBy(factor, cx, cy) {
      const next = Math.min(6, Math.max(0.05, cam.k * factor));
      const z = next / cam.k;
      cam.x = cx - (cx - cam.x) * z;
      cam.y = cy - (cy - cam.y) * z;
      cam.k = next;
      applyCam();
    }
    function bounds() {
      if (nodes.size === 0) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes.values()) {
        x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
        x1 = Math.max(x1, n.x + NODE_W); y1 = Math.max(y1, n.y + NODE_H);
      }
      return { x0, y0, x1, y1 };
    }
    function fit() {
      const b = bounds();
      if (!b) return;
      const pad = 48;
      const w = stage.clientWidth, h = stage.clientHeight;
      const bw = Math.max(1, b.x1 - b.x0 + pad * 2);
      const bh = Math.max(1, b.y1 - b.y0 + pad * 2);
      cam.k = Math.min(6, Math.max(0.05, Math.min(w / bw, h / bh)));
      cam.x = (w - (b.x0 + b.x1) * cam.k) / 2;
      cam.y = (h - (b.y0 + b.y1) * cam.k) / 2;
      applyCam();
    }
    svg.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomBy(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
    svg.addEventListener("mousedown", (ev) => {
      if (ev.target.closest(".node")) return;
      dragging = true;
      stage.classList.add("drag");
      last = { x: ev.clientX, y: ev.clientY };
    });
    window.addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      cam.x += ev.clientX - last.x;
      cam.y += ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      applyCam();
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
      stage.classList.remove("drag");
    });

    function draw() {
      svg.replaceChildren();
      world = document.createElementNS(NS, "g");
      for (const e of edges) {
        const a = nodes.get(e.from), b = nodes.get(e.to);
        if (!a || !b) continue;
        const path = document.createElementNS(NS, "path");
        path.setAttribute("class", "edge " + e.dir);
        const x1 = a.x + NODE_W / 2, y1 = a.y + (e.dir === "up" ? 0 : NODE_H);
        const x2 = b.x + NODE_W / 2, y2 = b.y + (e.dir === "up" ? NODE_H : 0);
        path.setAttribute("d", "M" + x1 + " " + y1 + " C " + x1 + " " + ((y1+y2)/2) + " " + x2 + " " + ((y1+y2)/2) + " " + x2 + " " + y2);
        world.appendChild(path);
      }
      for (const n of nodes.values()) {
        const el = document.createElementNS(NS, "g");
        el.setAttribute("class", "node" + (n.seed ? " seed" : ""));
        el.setAttribute("transform", "translate(" + n.x + " " + n.y + ")");
        el.addEventListener("click", (ev) => { ev.stopPropagation(); expand(n.id); });
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("width", String(NODE_W));
        rect.setAttribute("height", String(NODE_H));
        rect.setAttribute("rx", "3");
        const t1 = document.createElementNS(NS, "text");
        t1.setAttribute("x", "8"); t1.setAttribute("y", "14");
        t1.textContent = n.id;
        const t2 = document.createElementNS(NS, "text");
        t2.setAttribute("x", "8"); t2.setAttribute("y", "28");
        t2.textContent = (n.table || "(无表名)").slice(0, 28);
        el.append(rect, t1, t2);
        world.appendChild(el);
      }
      svg.appendChild(world);
      applyCam();
    }

    async function api(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    function placeFan(origin, list, dir) {
      const spread = Math.max(220, list.length * 32);
      list.forEach((item, i) => {
        if (nodes.has(item.id)) return;
        const t = list.length === 1 ? 0.5 : i / (list.length - 1);
        nodes.set(item.id, {
          id: item.id,
          table: item.table,
          seed: false,
          x: origin.x + (t - 0.5) * spread,
          y: origin.y + (dir === "up" ? -110 : 110),
        });
      });
    }

    async function expand(id) {
      const data = await api("/api/expand?id=" + encodeURIComponent(id));
      const origin = nodes.get(id);
      if (!origin) return;
      origin.table = data.table || origin.table;
      placeFan(origin, data.up, "up");
      placeFan(origin, data.down, "down");
      for (const n of data.up) edges.push({ from: id, to: n.id, dir: "up" });
      for (const n of data.down) edges.push({ from: id, to: n.id, dir: "down" });
      draw();
      fit();
    }

    async function openRoot() {
      const id = document.getElementById("taskId").value.trim();
      if (!id) return;
      const data = await api("/api/expand?id=" + encodeURIComponent(id));
      nodes.clear(); edges.length = 0;
      nodes.set(id, { id, table: data.table, seed: true, x: 0, y: 0 });
      placeFan(nodes.get(id), data.up, "up");
      placeFan(nodes.get(id), data.down, "down");
      for (const n of data.up) edges.push({ from: id, to: n.id, dir: "up" });
      for (const n of data.down) edges.push({ from: id, to: n.id, dir: "down" });
      draw();
      fit();
    }
    document.getElementById("open").onclick = openRoot;
    document.getElementById("zoomIn").onclick = () => zoomBy(1.25, stage.clientWidth / 2, stage.clientHeight / 2);
    document.getElementById("zoomOut").onclick = () => zoomBy(1 / 1.25, stage.clientWidth / 2, stage.clientHeight / 2);
    document.getElementById("fit").onclick = fit;
    document.getElementById("taskId").addEventListener("keydown", (e) => {
      if (e.key === "Enter") openRoot();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "+" || e.key === "=") zoomBy(1.25, stage.clientWidth / 2, stage.clientHeight / 2);
      if (e.key === "-" || e.key === "_") zoomBy(1 / 1.25, stage.clientWidth / 2, stage.clientHeight / 2);
      if (e.key === "0" && !e.metaKey && !e.ctrlKey) fit();
    });
    document.getElementById("taskId").value = "103457";
    openRoot();
  </script>
</body>
</html>`;
}

function labelForTask(
  database: DatabaseSync,
  cache: Map<string, string>,
  taskId: string,
): string {
  const cached = cache.get(taskId);
  if (cached !== undefined) return cached;
  const row = database
    .prepare(
      `SELECT evidence_type AS evidenceType, payload_json AS payloadJson
         FROM evidence
        WHERE task_id = ?
          AND evidence_type IN ('szdata-schedule-detail', 'horae-task-type')
        ORDER BY CASE evidence_type WHEN 'szdata-schedule-detail' THEN 0 ELSE 1 END`,
    )
    .all(taskId) as Array<{ evidenceType: unknown; payloadJson: unknown }>;
  let table = "";
  for (const item of row) {
    table = tableFromPayload(
      typeof item.payloadJson === "string" ? item.payloadJson : null,
    );
    if (table) break;
  }
  cache.set(taskId, table);
  return table;
}

function neighborCards(
  lookup: HoraeRelationHopLookup,
  database: DatabaseSync,
  labels: Map<string, string>,
  taskId: string,
  direction: "up" | "down",
): Array<{ id: string; table: string }> {
  if (!lookup.hasEvidence(taskId, direction)) return [];
  return lookup.neighbors(taskId, direction).map((id) => ({
    id,
    table: labelForTask(database, labels, id),
  }));
}

function main(): void {
  const cacheRoot = option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const databasePath = option("--database-path") ?? defaultSqlitePath(cacheRoot);
  if (!existsSync(databasePath)) throw new Error(`SQLITE_DATABASE_MISSING:${databasePath}`);
  const seedFile = option("--task-ids-file") ?? DEFAULT_SEED_FILE;
  const seeds = existsSync(seedFile) ? taskIdsFromFile(seedFile) : [];
  const port = Number(option("--port") ?? DEFAULT_PORT);
  const database = new DatabaseSync(
    `file:${databasePath.replaceAll("\\", "/")}?immutable=1`,
    { readOnly: true },
  );
  const lookup = horaeRelationLookupFromSqlite(database);
  const labels = new Map<string, string>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/") {
        sendHtml(res, pageHtml(seeds.length));
        return;
      }
      if (url.pathname === "/api/expand") {
        const id = url.searchParams.get("id")?.trim() ?? "";
        if (!id) {
          sendJson(res, 400, { error: "ID_MISSING" });
          return;
        }
        sendJson(res, 200, {
          id,
          table: labelForTask(database, labels, id),
          up: neighborCards(lookup, database, labels, id, "up"),
          down: neighborCards(lookup, database, labels, id, "down"),
          missingUp: !lookup.hasEvidence(id, "up"),
          missingDown: !lookup.hasEvidence(id, "down"),
        });
        return;
      }
      sendJson(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(
      `horae-relation-tree http://127.0.0.1:${port}/  seeds=${seeds.length} sqlite=${databasePath}\n`,
    );
  });
}

if (process.argv[1]?.endsWith("horae-relation-tree-explorer.ts")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
