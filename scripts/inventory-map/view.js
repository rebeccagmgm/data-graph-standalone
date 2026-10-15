const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n ?? 0).toLocaleString("zh-CN");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (v) =>
  v
    ? String(v)
        .replace("T", " ")
        .replace(/\.\d+Z$/, " UTC")
    : "未记录";
const short = (value, max = 24) => {
  const chars = [...String(value ?? "")];
  return chars.length > max
    ? chars.slice(0, max - 1).join("") + "…"
    : chars.join("");
};
let summary,
  graph,
  current = { kind: "overview" },
  camera = { x: 0, y: 0, scale: 1 },
  drag = null,
  moved = false,
  pending = 0,
  viewSequence = 0,
  regionSequence = 0,
  panelSequence = 0;
let panelTrail = [],
  regionNext = 0,
  regionItems = [],
  cameras = new Map();
const stageInfo = (id) => summary?.stages.find((s) => s.id === id);
const regionInfo = (id) => summary?.regions.find((s) => s.id === id);
async function api(command, params = {}) {
  pending++;
  $("busy").hidden = false;
  try {
    if (summary?.limits) {
      params = { ...params };
      const limits = summary.limits;
      if (params.limit !== undefined)
        params.limit = Math.min(
          params.limit,
          command === "neighbors" ? limits.maxNodes : limits.maxPageSize,
        );
      if (params.edgeLimit !== undefined)
        params.edgeLimit = Math.min(params.edgeLimit, limits.maxEdges);
      if (command === "neighbors" && params.depth !== undefined)
        params.depth = Math.min(params.depth, limits.maxDepth);
    }
    const response = await fetch(
      `/api/${command}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))}`,
    );
    const json = await response.json();
    if (!json.ok) throw new Error(json.error?.message || "读取失败");
    return json.data;
  } finally {
    pending--;
    $("busy").hidden = pending === 0;
  }
}
function report(error) {
  $("error-banner").textContent = error.message || String(error);
  $("error-banner").hidden = false;
}
function run(fn) {
  return (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch(report);
}
function hideError() {
  $("error-banner").hidden = true;
}
function bind(selector, fn, root = document) {
  root.querySelectorAll(selector).forEach((el) =>
    el.addEventListener(
      "click",
      run(() => fn(el)),
    ),
  );
}
function nodeSvg(tag, attributes = {}, text) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}
function interactive(el, label, fn) {
  el.setAttribute("tabindex", "0");
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", label);
  el.addEventListener(
    "click",
    run((event) => {
      event.stopPropagation();
      if (!moved) return fn();
    }),
  );
  el.addEventListener(
    "keydown",
    run((event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        return fn();
      }
    }),
  );
}
function curve(a, b, index = 0) {
  const w = a.width || 226,
    h = a.height || 88,
    bw = b.width || 226,
    bh = b.height || 88;
  if (a.id === b.id)
    return `M ${a.x + w} ${a.y + h / 3} C ${a.x + w + 70} ${a.y - 30}, ${a.x + w + 70} ${a.y + h + 30}, ${a.x + w} ${a.y + h * 0.7}`;
  const forward = b.x > a.x,
    sx = a.x + (forward ? w : 0),
    sy = a.y + h * 0.47,
    tx = b.x + (forward ? 0 : bw),
    ty = b.y + bh * 0.47;
  if (graph.scope === "stages") {
    const top = forward;
    const lane = top
      ? 38 - (index % 3) * 20
      : Math.max(a.y + h, b.y + bh) + 48 + (index % 4) * 24;
    return `M ${sx} ${sy} C ${sx + (forward ? 50 : -50)} ${lane}, ${tx - (forward ? 50 : -50)} ${lane}, ${tx} ${ty}`;
  }
  const bend = Math.max(45, Math.abs(tx - sx) * 0.45);
  return `M ${sx} ${sy} C ${sx + (forward ? bend : -bend)} ${sy}, ${tx - (forward ? bend : -bend)} ${ty}, ${tx} ${ty}`;
}
function renderMap() {
  const scene = $("scene");
  scene.replaceChildren();
  const index = new Map(graph.nodes.map((n) => [n.id, n]));
  graph.edges.forEach((edge, i) => {
    const a = index.get(edge.source),
      b = index.get(edge.target);
    if (!a || !b) return;
    const group = nodeSvg("g", {
      class: `edge ${b.x < a.x ? "backward" : ""}`,
    });
    const d = curve(a, b, i),
      visible = nodeSvg("path", { d, class: "visible" });
    if (graph.scope === "stages")
      visible.style.strokeWidth = String(
        1 + Math.min(3, Math.log10((edge.edgeCount || 1) + 1) * 0.6),
      );
    group.append(visible, nodeSvg("path", { d, class: "hit" }));
    scene.append(group);
    if (edge.edgeCount) {
      const point = visible.getPointAtLength(visible.getTotalLength() * 0.5);
      group.append(
        nodeSvg(
          "text",
          { x: point.x, y: point.y - 6, "text-anchor": "middle" },
          fmt(edge.edgeCount),
        ),
      );
    }
    interactive(
      group,
      `${a.label || a.name} → ${b.label || b.name}，查看依赖成员`,
      () => {
        if (graph.scope === "stages")
          return showFlows(
            { sourceStage: a.id, targetStage: b.id },
            `${a.label} → ${b.label}`,
          );
        if (graph.scope === "region")
          return showFlows(
            { sourceRegion: a.id, targetRegion: b.id },
            `${a.label} → ${b.label}`,
          );
        return showEdge(edge, a, b);
      },
    );
  });
  graph.nodes.forEach((node, i) => {
    const g = nodeSvg("g", {
        class: `node ${node.root ? "root" : ""}`,
        transform: `translate(${node.x},${node.y})`,
      }),
      width = node.width || 226,
      height = node.height || 88;
    g.append(nodeSvg("rect", { class: "card", width, height }));
    g.append(nodeSvg("title", {}, node.label || node.name || node.id));
    if (graph.scope === "stages") {
      g.append(
        nodeSvg("rect", {
          x: 0,
          y: 0,
          width,
          height: 3,
          fill: node.color || "#5b899d",
        }),
      );
      g.append(
        nodeSvg(
          "text",
          { x: 17, y: 25, class: "stage-number" },
          `${String(i + 1).padStart(2, "0")} / 阅读分组`,
        ),
      );
      g.append(
        nodeSvg("text", { x: 17, y: 52, class: "node-title" }, node.label),
      );
      g.append(
        nodeSvg(
          "text",
          { x: 17, y: 97, class: "node-total" },
          fmt(node.taskCount),
        ),
      );
      g.append(
        nodeSvg(
          "text",
          { x: 17, y: 117, class: "node-count-label" },
          `库存任务 · ${fmt(node.regionCount)} 个主题`,
        ),
      );
      g.append(
        nodeSvg("line", {
          x1: 17,
          y1: 133,
          x2: width - 17,
          y2: 133,
          class: "divider",
        }),
      );
      node.regions.forEach((r, j) => {
        const item = nodeSvg("g", { class: "region-mini" });
        item.append(
          nodeSvg("rect", {
            x: 10,
            y: 145 + j * 28,
            width: width - 20,
            height: 27,
            fill: "transparent",
          }),
        );
        item.append(
          nodeSvg("text", { x: 17, y: 163 + j * 28 }, short(r.label, 18)),
        );
        item.append(
          nodeSvg(
            "text",
            { x: width - 17, y: 163 + j * 28, "text-anchor": "end" },
            fmt(r.taskCount),
          ),
        );
        interactive(item, `展开主题 ${r.label}`, () =>
          navigate({ kind: "region", id: r.id }),
        );
        g.append(item);
      });
      g.append(
        nodeSvg(
          "text",
          { x: 17, y: height - 15, class: "node-meta" },
          "查看阶段成员与主题 ↗",
        ),
      );
      interactive(
        g,
        `${node.label}，${fmt(node.taskCount)} 个任务，查看阶段`,
        () => showStage(node.id),
      );
    } else {
      const title = node.label || node.name || `任务 ${node.id}`;
      g.append(
        nodeSvg(
          "text",
          { x: 14, y: 27, class: "node-title" },
          short(title, 25),
        ),
      );
      const sub =
        graph.scope === "region"
          ? `${fmt(node.taskCount)} 个库存任务`
          : `任务 ${node.id} · ${node.inInventory ? "库存任务" : "外部引用"}`;
      g.append(
        nodeSvg(
          "text",
          { x: 14, y: 49, class: "node-subtitle" },
          short(sub, 29),
        ),
      );
      const meta =
        graph.scope === "region"
          ? `${stageInfo(node.stageId)?.label || "未分类"} · 展开成员`
          : `上游 ${fmt(node.inDegree)} · 下游 ${fmt(node.outDegree)}`;
      g.append(nodeSvg("text", { x: 14, y: 72, class: "node-meta" }, meta));
      interactive(
        g,
        `${title}，${graph.scope === "region" ? "查看主题" : "查看任务"}`,
        () =>
          graph.scope === "region"
            ? showTasks({ region: node.id }, title)
            : showTask(node.id),
      );
    }
    scene.append(g);
  });
  $("map-empty").hidden = graph.nodes.length > 0;
  applyCamera();
}
function applyCamera() {
  $("scene").setAttribute(
    "transform",
    `translate(${camera.x},${camera.y}) scale(${camera.scale})`,
  );
  $("zoom-value").value = `${Math.round(camera.scale * 100)}%`;
}
function fit() {
  if (!graph?.nodes.length) return;
  const box = $("scene").getBBox(),
    area = $("map-canvas").getBoundingClientRect();
  if (!box.width) return;
  const fitted = Math.min(
    1.45,
    (area.width - 40) / (box.width + 20),
    (area.height - 28) / (box.height + 20),
  );
  const scale = Math.max(graph.scope === "stages" ? 0.7 : 0.85, fitted);
  const root = graph.nodes.find((n) => n.root);
  const centerX =
    scale > fitted && root ? root.x + root.width / 2 : box.x + box.width / 2;
  const centerY =
    scale > fitted && root ? root.y + root.height / 2 : box.y + box.height / 2;
  camera = {
    scale,
    x: area.width / 2 - centerX * scale,
    y: area.height / 2 - centerY * scale,
  };
  $("map-canvas").title =
    scale > fitted
      ? "保持可读字号；拖动画布查看其余节点，也可手动缩小。"
      : "拖动画布、滚轮缩放";
  applyCamera();
}
function zoom(factor) {
  const rect = $("map-canvas").getBoundingClientRect(),
    next = Math.min(3, Math.max(0.08, camera.scale * factor)),
    ratio = next / camera.scale;
  camera = {
    x: rect.width / 2 - (rect.width / 2 - camera.x) * ratio,
    y: rect.height / 2 - (rect.height / 2 - camera.y) * ratio,
    scale: next,
  };
  applyCamera();
}
async function navigate(next, record = true) {
  const seq = ++viewSequence;
  hideError();
  if (graph) cameras.set(JSON.stringify(current), { ...camera });
  let result;
  if (next.kind === "task")
    result = await api("neighbors", {
      id: next.id,
      direction: next.direction || "both",
      depth: next.depth || 1,
      limit: 60,
      edgeLimit: 160,
    });
  else
    result = await api(
      "overview",
      next.kind === "region" ? { region: next.id } : {},
    );
  if (seq !== viewSequence) return;
  if (next.kind === "task")
    next = { ...next, depth: result.depth, direction: result.direction };
  current = next;
  graph = next.kind === "task" ? { ...result, scope: "task" } : result;
  const hash =
    next.kind === "overview"
      ? "#overview"
      : `#${next.kind}/${encodeURIComponent(next.id)}${next.kind === "task" ? `/${next.direction || "both"}/${next.depth || 1}` : ""}`;
  if (record) history.pushState(next, "", hash);
  else history.replaceState(next, "", hash);
  closePanel();
  $("home").classList.toggle("active", next.kind === "overview");
  $("view-members").hidden = next.kind === "overview";
  $("view-flows").hidden = next.kind === "task";
  $("view-flows").textContent =
    next.kind === "overview" ? "全部阶段流向" : "查看全部流向";
  if (next.kind === "overview") {
    $("map-kicker").textContent = "01 / 全量总览";
    $("map-title").textContent = "任务如何在主题间连接";
    $("map-subtitle").textContent =
      `显示依赖最多的 ${result.edges.length} 条阶段流向。卡片内进入主题，连线数字追查真实任务对，全部 ${result.totalFlows} 条流向可从右侧入口查看。`;
    $("breadcrumbs").innerHTML = "<button data-home>总览</button>";
    $("map-boundary").textContent =
      "连线是已缓存调度依赖；阶段是阅读规则，不证明每个任务的 SQL 加工职责。阶段内部依赖计入总数，可从成员继续查。";
  } else if (next.kind === "region") {
    const region = regionInfo(next.id);
    $("map-kicker").textContent = "02 / 主题与周边";
    $("map-title").textContent = region.label;
    $("map-subtitle").textContent =
      `${fmt(region.taskCount)} 个库存任务 · 主题内部 ${fmt(result.internalEdges)} 对依赖 · 展示连接最多的 ${result.shownFlows} / ${result.totalFlows} 条跨主题流向。`;
    $("breadcrumbs").innerHTML =
      `<button data-home>总览</button><span>/ ${esc(region.label)}</span>`;
    $("map-boundary").textContent = result.truncated
      ? "当前展示主要流向，其他流向可通过“查看全部流向”追查。主题成员与内部依赖均保留。"
      : "连线为主题间调度依赖；点击卡片查成员，点击连线查去重任务对。";
  } else {
    const task = result.nodes.find((n) => n.id === next.id);
    $("map-kicker").textContent = "03 / 任务局部路径";
    $("map-title").textContent = task?.name || `任务 ${next.id}`;
    $("map-subtitle").textContent =
      `任务 ${next.id} · ${next.direction === "up" ? "向上游" : next.direction === "down" ? "向下游" : "双向"}展开 ${next.depth || 1} 层 · 点击任务阅读证据。`;
    $("breadcrumbs").innerHTML =
      `<button data-home>总览</button><span>/ 任务 ${esc(next.id)}</span>`;
    $("map-boundary").textContent = result.truncated
      ? `当前是有界局部结果：${result.stoppedBy.map((s) => ({ DEPTH_LIMIT: "已到设定层数", NODE_LIMIT: "已到节点上限", EDGE_LIMIT: "已到边数上限", MISSING_TASK: "部分邻居信息缺失" })[s] || s).join("；")}。可选一个任务继续追查。`
      : "此范围内可达的调度依赖已展开；不代表 SQL 数据因果或运行成功。";
  }
  $("map-counts").textContent =
    `当前画布 ${fmt(graph.nodes.length)} 个节点 · ${fmt(graph.edges.length)} 条连线`;
  renderMap();
  camera = cameras.get(JSON.stringify(next)) || camera;
  cameras.has(JSON.stringify(next)) ? applyCamera() : fit();
  bind("[data-home]", () => navigate({ kind: "overview" }));
  document
    .querySelectorAll(".region-entry")
    .forEach((e) =>
      e.classList.toggle("selected", e.dataset.region === next.id),
    );
}
async function refreshRegions(append = false) {
  const seq = ++regionSequence;
  const data = await api("regions", {
    q: $("region-search").value,
    stage: $("stage-filter").value,
    offset: append ? regionNext || 0 : 0,
    limit: 40,
  });
  if (seq !== regionSequence) return;
  regionItems = append ? [...regionItems, ...data.items] : data.items;
  regionNext = data.nextOffset;
  $("region-more").hidden = regionNext === null;
  $("region-total").textContent = fmt(data.total);
  $("region-list").innerHTML =
    regionItems
      .map(
        (r) =>
          `<button class="region-entry ${current.id === r.id ? "selected" : ""}" data-region="${esc(r.id)}" title="${esc(r.label)}"><span>${esc(r.label)}</span><span>${fmt(r.taskCount)}</span></button>`,
      )
      .join("") || '<p class="empty">没有匹配主题</p>';
  bind(
    "[data-region]",
    (el) => navigate({ kind: "region", id: el.dataset.region }),
    $("region-list"),
  );
}
function paintPanel(kicker, html) {
  $("inspector").hidden = false;
  $("panel-kicker").textContent = kicker;
  $("panel-content").innerHTML = html;
  $("panel-content").scrollTop = 0;
  $("panel-back").hidden = panelTrail.length < 2;
  $("panel-content").focus({ preventScroll: true });
}
function closePanel() {
  panelSequence++;
  $("inspector").hidden = true;
  panelTrail = [];
}
async function openPanel(render, push = true) {
  if (push) panelTrail.push(render);
  const seq = ++panelSequence;
  await render(seq);
}
function taskRows(items) {
  return (
    items
      .map(
        (t) =>
          `<button class="list-row" data-task="${esc(t.id)}"><strong>${esc(t.name)}</strong><small>${esc(t.id)} · ${esc(t.topic || "未分类")} · 上游 ${fmt(t.inDegree)} / 下游 ${fmt(t.outDegree)}${t.hasSql ? " · 有 SQL" : ""}</small></button>`,
      )
      .join("") || '<p class="empty">没有匹配任务。</p>'
  );
}
function pagination(data) {
  return `<div class="pagination"><span>${data.items.length ? fmt(data.offset + 1) : 0}–${fmt(data.offset + data.items.length)} / ${fmt(data.total)}</span><div><button id="page-prev" ${data.offset === 0 ? "disabled" : ""}>上一页</button> <button id="page-next" ${data.nextOffset === null ? "disabled" : ""}>下一页</button></div></div>`;
}
async function showTasks(
  params = {},
  title = "任务检索",
  offset = 0,
  push = true,
) {
  const render = async (seq) => {
    const data = await api("tasks", { ...params, offset, limit: 30 });
    if (seq !== panelSequence) return;
    paintPanel(
      "成员列表",
      `<h2>${esc(title)}</h2><p>${fmt(data.total)} 个库存任务 · 按直接下游数排序</p><form id="panel-search-form" class="panel-search"><input id="panel-search" placeholder="在当前范围搜索任务" value="${esc(params.q || "")}" aria-label="成员搜索"><button>筛选</button></form>${taskRows(data.items)}${pagination(data)}`,
    );
    bind("[data-task]", (el) => showTask(el.dataset.task), $("panel-content"));
    $("page-prev").onclick = run(() =>
      showTasks(params, title, Math.max(0, offset - data.limit), false),
    );
    $("page-next").onclick = run(() =>
      showTasks(params, title, data.nextOffset, false),
    );
    $("panel-search-form").onsubmit = (event) => {
      event.preventDefault();
      run(() =>
        showTasks({ ...params, q: $("panel-search").value }, title, 0, false),
      )();
    };
  };
  if (!push) panelTrail[panelTrail.length - 1] = render;
  return openPanel(render, push);
}
async function showStage(id) {
  const stage = stageInfo(id),
    regions = summary.regions
      .filter((r) => r.stageId === id)
      .sort((a, b) => b.taskCount - a.taskCount);
  return openPanel(async () => {
    paintPanel(
      "阶段阅读分组",
      `<h2>${esc(stage.label)}</h2><p>${fmt(stage.taskCount)} 个任务 · ${regions.length} 个主题</p><div class="notice">此阶段由主题名称和版本化规则归类，不把阶段含义自动传递为每个任务的 SQL 职责。</div><button id="stage-tasks" class="primary">查看全部阶段任务</button>${regions.map((r) => `<button class="list-row" data-region="${esc(r.id)}"><strong>${esc(r.label)}</strong><small>${fmt(r.taskCount)} 个任务 · 跨主题连接 ${fmt(r.inEdges + r.outEdges)}</small></button>`).join("")}`,
    );
    $("stage-tasks").onclick = run(() => showTasks({ stage: id }, stage.label));
    bind(
      "[data-region]",
      (el) => navigate({ kind: "region", id: el.dataset.region }),
      $("panel-content"),
    );
  });
}
async function showStageFlows() {
  const edges = summary.stageFlows
    .filter((e) => e.source !== e.target)
    .sort((a, b) => b.edgeCount - a.edgeCount);
  return openPanel(async () => {
    paintPanel(
      "全部跨阶段流向",
      `<h2>${edges.length} 条跨阶段流向</h2><p>总览默认显示依赖最多的 8 条。这里保留全部阶段组合，点击可核对任务对。</p>${edges.map((e) => `<button class="list-row" data-from="${esc(e.source)}" data-to="${esc(e.target)}"><strong>${esc(stageInfo(e.source)?.label)} → ${esc(stageInfo(e.target)?.label)}</strong><small>${fmt(e.edgeCount)} 对去重调度依赖</small></button>`).join("")}`,
    );
    bind(
      "[data-from]",
      (el) =>
        showFlows(
          { sourceStage: el.dataset.from, targetStage: el.dataset.to },
          `${stageInfo(el.dataset.from)?.label} → ${stageInfo(el.dataset.to)?.label}`,
        ),
      $("panel-content"),
    );
  });
}
async function showFlows(params, title, offset = 0, push = true) {
  const render = async (seq) => {
    const data = await api("flows", { ...params, offset, limit: 30 });
    if (seq !== panelSequence) return;
    paintPanel(
      "依赖成员",
      `<h2>${esc(title)}</h2><p>${fmt(data.total)} 对去重任务依赖</p><div class="notice">每行是一对上游 → 下游任务。上游和下游方向的缓存命中同一对任务时，仅计一次。</div>${data.items.map((e) => `<div class="evidence-row"><button class="list-row" data-task="${esc(e.source)}"><strong>${esc(e.sourceName || e.source)}</strong><small>上游 ${esc(e.source)}</small></button><button class="list-row" data-task="${esc(e.target)}"><strong>↓ ${esc(e.targetName || e.target)}</strong><small>下游 ${esc(e.target)} · ${e.seenUp && e.seenDown ? "两个方向均有缓存" : "一个方向有缓存"}</small></button></div>`).join("") || '<p class="empty">此范围没有依赖对。</p>'}${pagination(data)}`,
    );
    bind("[data-task]", (el) => showTask(el.dataset.task), $("panel-content"));
    $("page-prev").onclick = run(() =>
      showFlows(params, title, Math.max(0, offset - data.limit), false),
    );
    $("page-next").onclick = run(() =>
      showFlows(params, title, data.nextOffset, false),
    );
  };
  if (!push) panelTrail[panelTrail.length - 1] = render;
  return openPanel(render, push);
}
async function showEdge(edge, a, b) {
  return openPanel(async () => {
    paintPanel(
      "调度关系",
      `<h2>${esc(a.name)} → ${esc(b.name)}</h2><p>上游 ${esc(a.id)} · 下游 ${esc(b.id)}</p><div class="notice">${edge.seenUp && edge.seenDown ? "两个方向的缓存均记录了这对依赖" : "目前有一个方向的缓存记录了这对依赖"}。该关系不证明 SQL 字段值来源。</div><div class="action-row"><button data-task="${esc(a.id)}">上游任务详情</button><button data-task="${esc(b.id)}">下游任务详情</button></div>`,
    );
    bind("[data-task]", (el) => showTask(el.dataset.task), $("panel-content"));
  });
}
async function showTask(id) {
  return openPanel(async (seq) => {
    const data = await api("task", { id });
    if (seq !== panelSequence) return;
    const t = data.task;
    paintPanel(
      "任务与证据",
      `<h2>${esc(t.name)}</h2><p>任务 ${esc(t.id)}</p><div class="pills"><span class="pill">${esc(t.topic || "未分类")}</span><span class="pill">${esc(stageInfo(t.stageId)?.label || "未分类")}</span>${!t.inInventory ? '<span class="pill amber">清单外引用</span>' : ""}</div>
  <dl class="detail-grid"><dt>直接上游</dt><dd>${fmt(t.inDegree)} ${t.hasUp ? "· 有上游缓存" : "· 无上游缓存，可能由邻居引用发现"}</dd><dt>直接下游</dt><dd>${fmt(t.outDegree)} ${t.hasDown ? "· 有下游缓存" : "· 无下游缓存，可能由邻居引用发现"}</dd><dt>任务类型</dt><dd>${esc(t.type || "未记录")}</dd><dt>配置库</dt><dd>${esc(t.schemaName || "未记录")}</dd><dt>配置状态原码</dt><dd>${esc(t.status || "未记录")}</dd><dt>周期</dt><dd>${esc(t.cycle || "未记录")}</dd><dt>详情采集</dt><dd>${esc(date(t.metadataObservedAt))}</dd></dl>
  <div class="notice">依赖是调度配置关系；配置库不等于 SQL 实际写出表，配置状态也不等于本次运行状态。</div>
  <h3>沿这个任务继续看</h3><div class="action-row"><button data-neighborhood="up" class="primary">上游路径</button><button data-neighborhood="down">下游路径</button><button data-neighborhood="both">双向一层</button><button data-neighborhood="both" data-depth="2">双向两层</button></div>
  <div class="action-row"><button id="task-sql" ${t.hasSql ? "" : "disabled"}>读取 SQL ${t.hasSql ? "↗" : "· 未收录"}</button><button id="task-knowledge">公共知识 ↗</button><button id="task-theme">主题地图 ↗</button></div><h3>这份地图使用的证据</h3>${data.evidence.map((e) => `<div class="evidence-row">${esc(e.evidenceType)}<span>${esc(date(e.observedAt))}</span><span class="hash">${esc(e.contentSha256)}</span></div>`).join("") || '<p class="empty">无独立证据记录，仅保留清单身份或邻居引用。</p>'}`,
    );
    bind(
      "[data-neighborhood]",
      (el) =>
        navigate({
          kind: "task",
          id,
          direction: el.dataset.neighborhood,
          depth: Number(el.dataset.depth || 1),
        }),
      $("panel-content"),
    );
    $("task-sql").onclick = run(() => showSql(id));
    $("task-knowledge").onclick = run(() => showKnowledge(id));
    $("task-theme").onclick = run(() =>
      navigate({ kind: "region", id: t.regionId }),
    );
  });
}
async function showSql(id, start = 1, push = true) {
  const render = async (seq) => {
    const data = await api("sql", { id, lineStart: start, lineCount: 120 });
    if (seq !== panelSequence) return;
    paintPanel(
      "SQL 原始证据",
      `<h2>任务 ${esc(id)} · SQL</h2>${data.available ? `<p>${esc(data.evidenceType)} · ${fmt(data.totalLines)} 行</p><div class="notice">${esc(data.boundary)}</div><p>${esc(date(data.observedAt))}${data.redacted ? " · 环境地址和敏感配置已省略" : ""}</p><pre class="sql">${esc(data.sql)}</pre><div class="hash">${esc(data.contentSha256)}</div><div class="pagination"><span>第 ${fmt(data.lineStart)}–${fmt(data.lineStart + data.lineCount - 1)} 行</span><div><button id="sql-prev" ${start <= 1 ? "disabled" : ""}>上一段</button> <button id="sql-next" ${data.hasMore ? "" : "disabled"}>下一段</button></div></div>` : `<p class="empty">${esc(data.reason)}</p>`}`,
    );
    if (data.available) {
      $("sql-prev").onclick = run(() =>
        showSql(id, Math.max(1, start - 120), false),
      );
      $("sql-next").onclick = run(() => showSql(id, start + 120, false));
    }
  };
  if (!push) panelTrail[panelTrail.length - 1] = render;
  return openPanel(render, push);
}
async function showKnowledge(id) {
  return openPanel(async (seq) => {
    const data = await api("knowledge", { id });
    if (seq !== panelSequence) return;
    paintPanel(
      "公共知识",
      `<h2>${esc(data.title || "任务公共知识")}</h2>${data.available ? `<div class="notice">${esc(data.boundary)}</div><div class="knowledge-text">${esc(data.content)}</div>` : `<p class="empty">${esc(data.reason)}</p>`}`,
    );
  });
}
async function showCoverage() {
  return openPanel(async () => {
    const c = summary.counts;
    paintPanel(
      "覆盖、来源与统计口径",
      `<h2>全量库存，有界阅读</h2><p>当前页面固定使用一次构建的结果。重新构建后，重新启动本地服务以切换版本。</p>${[
        ["源清单任务", c.inventoryTasks],
        ["清单外引用", c.externalTasks],
        ["有数综详情", c.detailTasks],
        ["有上游缓存", c.upTasks],
        ["有下游缓存", c.downTasks],
        ["有 SQL 证据", c.sqlTasks],
        ["去重依赖对", c.edges],
        ["双方向均有缓存的依赖对", c.bothDirectionEdges],
        ["单方向有缓存的依赖对", c.singleDirectionEdges],
        ["自依赖", c.selfEdges],
        ["无法使用的证据行", c.invalidRows],
      ]
        .map(
          ([label, n]) =>
            `<div class="coverage-row"><span>${esc(label)}</span><strong>${fmt(n)}</strong></div>`,
        )
        .join(
          "",
        )}<h3>统计规则</h3><p>任务数按库存 task ID 去重；调度边按上游 → 下游任务对去重。相同任务可参与多条依赖，依赖对数不能当作任务数。跨阶段流向不含阶段内部依赖。</p><div class="notice">主题来自缓存元数据，阶段来自显式阅读规则。没有公共知识或 SQL 的任务继续可查。SQL 读取核对本快照记录的证据哈希，变化后不会直接混入旧快照。</div><h3>快照信息</h3><p>构建：${esc(date(summary.builtAt))}<br>证据观察：${esc(date(summary.source.observedMin))} — ${esc(date(summary.source.observedMax))}</p><div class="hash">版本 ${esc(summary.version)}<br>规则 ${esc(summary.rulesHash)}</div>`,
    );
  });
}
function renderInsights() {
  const topics = [...summary.regions]
      .filter((r) => r.taskCount > 0)
      .sort((a, b) => b.inEdges + b.outEdges - (a.inEdges + a.outEdges))
      .slice(0, 5),
    max = Math.max(1, ...topics.map((r) => r.inEdges + r.outEdges));
  $("topic-highlights").innerHTML = topics
    .map(
      (r) =>
        `<button class="insight-row" data-region="${esc(r.id)}"><div><strong>${esc(r.label)}</strong><small>${fmt(r.taskCount)} 个任务 · ${esc(stageInfo(r.stageId)?.label)}</small><div class="bar-track"><i style="width:${Math.max(2, (100 * (r.inEdges + r.outEdges)) / max)}%"></i></div></div><span class="count">${fmt(r.inEdges + r.outEdges)}</span></button>`,
    )
    .join("");
  const hubs = (summary.highlights?.hubs || []).slice(0, 5);
  $("task-highlights").innerHTML = hubs
    .map(
      (t) =>
        `<button class="insight-row" data-task="${esc(t.id)}"><div><strong>${esc(t.name || t.id)}</strong><small>${esc(t.id)} · ${esc(t.topic || "未分类")}</small></div><span class="count">${fmt(t.outDegree)}</span></button>`,
    )
    .join("");
  bind(
    "[data-region]",
    (el) => navigate({ kind: "region", id: el.dataset.region }),
    $("topic-highlights"),
  );
  bind("[data-task]", (el) => showTask(el.dataset.task), $("task-highlights"));
}
function routeFromHash() {
  const [kind, raw, direction, depth] = location.hash.slice(1).split("/");
  if (["region", "task"].includes(kind) && raw)
    return {
      kind,
      id: decodeURIComponent(raw),
      ...(kind === "task"
        ? { direction: direction || "both", depth: Number(depth || 1) }
        : {}),
    };
  return { kind: "overview" };
}
$("home").onclick = run(() => navigate({ kind: "overview" }));
$("coverage-button").onclick = run(showCoverage);
$("panel-close").onclick = closePanel;
$("panel-back").onclick = run(async () => {
  if (panelTrail.length < 2) return;
  panelTrail.pop();
  await openPanel(panelTrail.at(-1), false);
});
$("region-more").onclick = run(() => refreshRegions(true));
$("stage-filter").onchange = run(() => refreshRegions());
let searchTimer;
$("region-search").oninput = () => {
  document
    .querySelector(".navigator")
    .classList.toggle("mobile-open", !!$("region-search").value);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(
    run(() => refreshRegions()),
    200,
  );
};
$("task-search-form").onsubmit = (event) => {
  event.preventDefault();
  run(() => showTasks({ q: $("task-search").value }, "任务检索"))();
};
$("view-members").onclick = run(() =>
  current.kind === "region"
    ? showTasks({ region: current.id }, regionInfo(current.id).label)
    : showTask(current.id),
);
$("view-flows").onclick = run(() =>
  current.kind === "overview"
    ? showStageFlows()
    : showFlows(
        { region: current.id },
        `${regionInfo(current.id).label} · 全部依赖`,
      ),
);
$("zoom-in").onclick = () => zoom(1.2);
$("zoom-out").onclick = () => zoom(1 / 1.2);
$("fit").onclick = fit;
$("map-canvas").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, startX: camera.x, startY: camera.y };
  moved = false;
});
window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 5)
    moved = true;
  if (moved) {
    $("map-canvas").classList.add("dragging");
    camera.x = drag.startX + e.clientX - drag.x;
    camera.y = drag.startY + e.clientY - drag.y;
    applyCamera();
  }
});
window.addEventListener("pointerup", () => {
  drag = null;
  $("map-canvas").classList.remove("dragging");
  setTimeout(() => {
    moved = false;
  }, 0);
});
$("map-canvas").addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.08 : 1 / 1.08);
  },
  { passive: false },
);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePanel();
});
window.addEventListener(
  "popstate",
  run(() => navigate(routeFromHash(), false)),
);
new ResizeObserver(() => {
  if (graph) fit();
}).observe($("map-canvas"));
await run(async () => {
  summary = await api("summary");
  const c = summary.counts;
  $("metric-tasks").textContent = fmt(c.inventoryTasks);
  $("inventory-badge").textContent = fmt(c.inventoryTasks);
  $("metric-regions").textContent = fmt(summary.regions.length);
  $("metric-edges").textContent = fmt(c.edges);
  $("metric-sql").textContent = fmt(c.sqlTasks);
  $("metric-external").textContent = c.externalTasks
    ? `另有 ${fmt(c.externalTasks)} 个清单外引用`
    : "源清单完整保留";
  $("metric-both").textContent = `${fmt(c.bothDirectionEdges)} 对有双方向缓存`;
  $("snapshot-label").textContent = `快照 · ${summary.builtAt.slice(0, 10)}`;
  $("version-label").textContent = `版本 ${summary.version.slice(0, 12)}`;
  $("source-period").textContent = `构建 ${date(summary.builtAt)}`;
  $("stage-filter").innerHTML =
    '<option value="">所有阅读阶段</option>' +
    summary.stages
      .map(
        (s) =>
          `<option value="${esc(s.id)}">${esc(s.label)} · ${fmt(s.taskCount)}</option>`,
      )
      .join("");
  renderInsights();
  await Promise.all([refreshRegions(), navigate(routeFromHash(), false)]);
  if (summary.quality?.status === "PARTIAL")
    report(
      new Error(
        `部分证据无法使用：${fmt(c.invalidRows)} 行。全部任务身份仍保留，请查看覆盖与口径。`,
      ),
    );
})();
