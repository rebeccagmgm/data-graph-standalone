(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const tasks = new Map(DATA.tasks.map((t) => [t.id, t]));
  const schemas = new Map(DATA.schemas.map((s) => [s.schema, s]));
  const sourceTopics = new Map(
    (DATA.sourceTopics ?? []).map((topic) => [topic.id, topic]),
  );
  const svgNS = "http://www.w3.org/2000/svg";
  const unique = (values) => [...new Set(values)];
  const fmt = (n) => Number(n).toLocaleString("zh-CN");
  const coverageLabels = {
    PROJECTED: "有投影材料",
    SCHEDULE_ONLY: "仅调度材料",
    COLLECTION_FAILED: "采集失败",
  };
  let current = "overview";
  let trail = ["overview"];
  let camera = { x: 0, y: 0, scale: 1 };
  const cameras = new Map();
  let previousPanel = null;
  let drag = null;
  let moved = false;
  let focusOrigin = null;
  let initialized = false;
  const W = 215,
    H = 88;

  function svg(tag, attrs, text) {
    const el = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attrs ?? {}))
      el.setAttribute(key, value);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function clickTarget(el, action) {
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "button");
    el.addEventListener("click", () => {
      if (!moved) action();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        action();
      }
    });
  }
  function short(text, limit = 28) {
    let width = 0,
      out = "";
    for (const c of text ?? "") {
      width += c.charCodeAt(0) > 255 ? 1.8 : 1;
      if (width > limit) return `${out}…`;
      out += c;
    }
    return out;
  }
  function flowGroups(edge) {
    if (edge.sourceTopic) {
      const topic = sourceTopics.get(edge.sourceTopic);
      return topic
        ? topic.sourceSchemas
            .map((source) =>
              DATA.flows.find(
                (flow) =>
                  flow.from === source.schema &&
                  flow.to === topic.targetSchema,
              ),
            )
            .filter(Boolean)
        : [];
    }
    if (edge.otherSources)
      return DATA.flows.filter(
        (f) =>
          f.to === "odata_n_tit" &&
          f.from !== "odata_n_tit" &&
          ![...sourceTopics.values()].some((topic) =>
            f.from.startsWith(topic.sourceSchemaPrefix),
          ),
      );
    return (edge.pairs ?? [])
      .map(([a, b]) => DATA.flows.find((f) => f.from === a && f.to === b))
      .filter(Boolean);
  }
  function edgeLabel(edge) {
    const groups = flowGroups(edge);
    if (edge.sourceTopic) {
      const topic = sourceTopics.get(edge.sourceTopic);
      return topic ? `${fmt(topic.uniqueIngressTaskIds.length)} 任务` : edge.label;
    }
    if (edge.otherSources)
      return groups.length
        ? `${fmt(unique(groups.flatMap((group) => group.taskIds)).length)} 任务`
        : "其他来源";
    return groups.length
      ? `${groups.map((f) => f.tasks).join(" / ")}${edge.suffix ? ` ${edge.suffix}` : ""}`
      : edge.label;
  }
  function edgePath(a, b, edge) {
    const dx = b.x - a.x,
      dy = b.y - a.y;
    if (Math.abs(dx) < W * 0.55 && edge.viaY === undefined) {
      const sx = a.x + W / 2,
        sy = a.y + (dy > 0 ? H : 0);
      const tx = b.x + W / 2,
        ty = b.y + (dy > 0 ? 0 : H);
      const middle = (sy + ty) / 2;
      return `M ${sx} ${sy} C ${sx} ${middle}, ${tx} ${middle}, ${tx} ${ty}`;
    }
    const sx = a.x + (dx >= 0 ? W : 0),
      sy = a.y + H / 2;
    const tx = b.x + (dx >= 0 ? 0 : W),
      ty = b.y + H / 2;
    if (edge.viaY !== undefined) {
      const mx = (sx + tx) / 2;
      return `M ${sx} ${sy} C ${sx + Math.sign(dx) * 60} ${sy}, ${sx + Math.sign(dx) * 65} ${edge.viaY}, ${mx} ${edge.viaY} S ${tx - Math.sign(dx) * 60} ${ty}, ${tx} ${ty}`;
    }
    const bend = Math.max(40, Math.abs(tx - sx) * 0.48);
    return `M ${sx} ${sy} C ${sx + Math.sign(dx) * bend} ${sy}, ${tx - Math.sign(dx) * bend} ${ty}, ${tx} ${ty}`;
  }
  function draw() {
    const view = DATA.views[current];
    const scene = $("scene");
    scene.replaceChildren();
    for (const [x, title] of view.stages ?? []) {
      scene.append(svg("text", { x, y: 20, class: "stage-label" }, title));
      scene.append(
        svg("line", {
          x1: x,
          y1: 35,
          x2: x + 160,
          y2: 35,
          class: "stage-line",
        }),
      );
    }
    const nodes = new Map(view.nodes.map((n) => [n.id, n]));
    for (const edge of view.edges) {
      const a = nodes.get(edge.from),
        b = nodes.get(edge.to),
        label = edgeLabel(edge);
      const g = svg("g", {
        class: "edge",
        "aria-label": `${a.title} → ${b.title} ${label}，查看关联`,
      });
      const d = edgePath(a, b, edge);
      const path = svg("path", {
        d,
        class: "visible",
        ...(edge.dashed ? { "stroke-dasharray": "4 5" } : {}),
      });
      g.append(path, svg("path", { d, class: "hit" }));
      scene.append(g);
      if (label) {
        const point = path.getPointAtLength(path.getTotalLength() * 0.5);
        g.append(
          svg(
            "text",
            {
              x: point.x + (edge.labelOffset?.[0] ?? 0),
              y: point.y - 8 + (edge.labelOffset?.[1] ?? 0),
              "text-anchor": "middle",
            },
            label,
          ),
        );
      }
      clickTarget(g, () => showEdge(edge, a, b));
    }
    for (const node of view.nodes) {
      const g = svg("g", {
        class: `node ${node.kind ?? ""} ${node.accent ? "accent" : ""}`,
        transform: `translate(${node.x},${node.y})`,
        "aria-label": `${node.title}，${node.subtitle}，${node.view ? "展开内部加工" : "查看详情"}`,
      });
      g.append(svg("title", {}, `${node.title}\n${node.subtitle}`));
      g.append(svg("rect", { width: W, height: H, rx: 3 }));
      g.append(
        svg(
          "text",
          { x: 14, y: 27, class: "node-title" },
          short(node.title, 24),
        ),
      );
      g.append(
        svg(
          "text",
          { x: 14, y: 48, class: "node-subtitle" },
          short(node.subtitle, 27),
        ),
      );
      const count =
        node.schemas?.length === 1
          ? schemas.get(node.schemas[0])?.tables
          : null;
      const sourceTopic = sourceTopics.get(node.sourceTopic);
      const meta =
        node.tasks?.length === 1
          ? `任务 ${node.tasks[0]}`
          : sourceTopic
            ? `${sourceTopic.sourceSchemas.length} schema · ${fmt(sourceTopic.tableIdentities)} 表身份`
          : node.view
            ? `${count ? `${count} 表节点 · ` : ""}展开内部加工`
            : node.principal
              ? "四产品公式与证据"
              : node.kind === "table"
                ? "查看输入与消费"
                : "查看区域与成员";
      g.append(svg("text", { x: 14, y: 74, class: "node-meta" }, meta));
      g.append(
        svg(
          "text",
          { x: W - 23, y: 26, class: "enter" },
          node.view ? "↗" : "›",
        ),
      );
      clickTarget(g, () => openNode(node));
      scene.append(g);
    }
    applyCamera();
  }
  function applyCamera() {
    $("scene").setAttribute(
      "transform",
      `translate(${camera.x},${camera.y}) scale(${camera.scale})`,
    );
    $("zoom-value").textContent = `${Math.round(camera.scale * 100)}%`;
  }
  function fit() {
    const v = DATA.views[current],
      box = $("canvas").getBoundingClientRect();
    const minScale = box.width < 700 ? 0.65 : 0;
    const scale = Math.max(
      minScale,
      Math.min((box.width - 36) / v.width, (box.height - 55) / v.height, 1.35),
    );
    camera = {
      scale,
      x: Math.max(16, (box.width - v.width * scale) / 2),
      y: Math.max(12, (box.height - v.height * scale) / 2 - 10),
    };
    applyCamera();
  }
  function zoom(multiplier) {
    const box = $("canvas").getBoundingClientRect();
    const next = Math.max(0.25, Math.min(2.5, camera.scale * multiplier));
    const ratio = next / camera.scale;
    camera = {
      x: box.width / 2 - (box.width / 2 - camera.x) * ratio,
      y: box.height / 2 - (box.height / 2 - camera.y) * ratio,
      scale: next,
    };
    applyCamera();
  }
  function setView(id, record = true) {
    if (id === "odata") {
      location.replace("processing-map-odata.html");
      return;
    }
    if (!DATA.views[id]) id = "overview";
    if (initialized) cameras.set(current, { ...camera });
    current = id;
    if (record && trail.at(-1) !== id) trail.push(id);
    if (id === "overview") trail = ["overview"];
    closePanel(false);
    const v = DATA.views[id];
    $("view-title").textContent = v.title;
    $("view-subtitle").textContent = v.subtitle;
    $("boundary").textContent = v.boundary;
    $("view-index").textContent =
      id === "overview"
        ? "01 / 全局"
        : id === "principal"
          ? "03 / 宽表与字段"
          : "02 / 区域内部";
    $("crumbs").replaceChildren();
    if (trail.length > 2) {
      const parent = document.createElement("button");
      parent.textContent = `/ ${DATA.views[trail.at(-2)].title.split(" · ")[0]} `;
      parent.onclick = back;
      $("crumbs").append(parent);
    }
    $("crumbs").append(
      document.createTextNode(
        id === "overview"
          ? "/ 主加工骨架"
          : `/ ${id === "principal" ? "合约销售基础宽表" : v.title.split(" · ")[0]}`,
      ),
    );
    $("members").hidden = !v.schemas?.length;
    $("sales-reading").hidden = !["principal", "otc", "pdata"].includes(id);
    $("back").disabled = trail.length < 2;
    draw();
    requestAnimationFrame(() => {
      if (cameras.has(id)) {
        camera = { ...cameras.get(id) };
        applyCamera();
      } else fit();
      initialized = true;
    });
  }
  function navigate(id) {
    if (id === "odata") {
      location.href = "processing-map-odata.html";
      return;
    }
    if (current === id) return;
    setView(id);
    history.pushState({ trail: [...trail] }, "", `#${id}`);
  }
  function back() {
    if (trail.length < 2) return;
    // A directly opened inner view has no previous page in this document.
    if (history.state?.direct) {
      trail.pop();
      setView(trail.at(-1), false);
      history.replaceState({ trail: [...trail] }, "", `#${current}`);
    } else history.back();
  }
  function panel(kicker, html, backAction = null) {
    $("inspector").classList.remove("reading-mode");
    if ($("inspector").hidden) focusOrigin = document.activeElement;
    $("panel-kicker").textContent = kicker;
    $("panel-content").innerHTML = html;
    $("panel-content").scrollTop = 0;
    previousPanel = backAction;
    $("panel-back").hidden = !backAction;
    $("inspector").hidden = false;
    $("panel-content").focus({ preventScroll: true });
  }
  function closePanel(restoreFocus = true) {
    $("inspector").classList.remove("reading-mode");
    $("inspector").hidden = true;
    previousPanel = null;
    if (restoreFocus && focusOrigin?.isConnected)
      focusOrigin.focus({ preventScroll: true });
  }
  function bindButtons(selector, callback) {
    $("panel-content")
      .querySelectorAll(selector)
      .forEach((el) =>
        el.addEventListener("click", () => callback(el.dataset)),
      );
  }
  function taskButton(id) {
    const t = tasks.get(id);
    if (!t) return "";
    return `<button class="row-button" data-task="${esc(id)}"><span class="count">${esc(id)} ↗</span><strong>${esc(DATA.taskNotes[id]?.[0] ?? short(t.name || t.category, 45))}</strong><small>${esc(t.category)} · ${t.inputs.length} 输入 / ${t.outputs.length} 输出关联</small></button>`;
  }
  function taskList(ids, title, description = "", returnTo = null) {
    const list = unique(ids).filter((id) => tasks.has(id));
    const recall = () => taskList(list, title, description, returnTo);
    panel(
      "任务集合",
      `<h2>${esc(title)}</h2><p class="micro">${esc(description)}</p><input id="task-search" class="search" aria-label="筛选任务" placeholder="按任务编号、名称或表名筛选"><div id="task-results"></div>`,
      returnTo,
    );
    let page = 1;
    function update() {
      const query = $("task-search").value.trim().toLowerCase();
      const matches = list.filter((id) => {
        const t = tasks.get(id);
        return `${id} ${t.name} ${t.inputs.map((x) => x.table)} ${t.outputs.map((x) => x.table)}`
          .toLowerCase()
          .includes(query);
      });
      const visible = matches.slice(0, page * 30);
      $("task-results").innerHTML =
        `<div class="list-count">${fmt(matches.length)} 个去重任务 · 当前显示 ${visible.length}</div>${visible.map(taskButton).join("") || '<div class="empty">没有匹配的任务。</div>'}${visible.length < matches.length ? '<button id="more-tasks" class="row-button">再显示 30 个 ↓</button>' : ""}`;
      bindButtons("[data-task]", ({ task }) => taskDetail(task, recall));
      if ($("more-tasks"))
        $("more-tasks").onclick = () => {
          page += 1;
          update();
        };
    }
    $("task-search").addEventListener("input", () => {
      page = 1;
      update();
    });
    update();
  }
  function knowledgeDetail(id) {
    const record = DATA.knowledge?.[id];
    if (!record) return "";
    const tags = [...record.tags.topics, ...record.tags.duties]
      .map((tag) => `<span class="pill muted">${esc(tag)}</span>`)
      .join("");
    const observations = record.observations
      .map(
        (item) =>
          `<p class="micro">${esc(item.label)} · query 第 ${esc(item.startLine)} 行</p><pre class="formula">${esc(item.text)}</pre>`,
      )
      .join("");
    return `<section data-knowledge="${esc(record.knowledgeId)}" data-revision="${esc(record.knowledgeRevision)}">${tags}<p class="micro">Agent 整理 · 已核留存 SQL 与引用位置 · 业务口径待确认</p><details><summary>加工说明与核验依据</summary><pre class="doc-text">${esc(record.markdown)}</pre>${observations}<p class="micro">共享知识：${esc(record.source)}；核验对应固定证据，不表示运行或业务验收。</p><div class="hash">知识版本 · ${esc(record.knowledgeRevision)}</div></details></section>`;
  }
  function taskDetail(id, returnTo = null) {
    const t = tasks.get(id),
      notes = DATA.taskNotes[id],
      ev = DATA.evidence[id];
    if (!t) return;
    const input = t.inputs
      .map((x) => `<div class="table-name">${esc(x.table)}</div>`)
      .join("");
    const output = t.outputs
      .map((x) => `<div class="table-name">${esc(x.table)}</div>`)
      .join("");
    const sql = ev
      ? `<details><summary>固定 query SQL · ${ev.sql.split("\n").length} 行</summary><p class="micro">行号对应此 query slot；业务日期来自固定快照。${ev.redacted ? "环境地址已隐藏，行号保持原位；摘要对应原文。" : ""}</p><div class="hash">SHA-256 · ${esc(ev.sha256)}</div><pre class="sql">${esc(
          ev.sql
            .split("\n")
            .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
            .join("\n"),
        )}</pre></details>`
      : '<div class="notice">本页没有收录这项任务的固定 SQL 阅读结果；这里仅展示快照里的表级关系。</div>';
    panel(
      `任务 ${id}`,
      `<h2>${esc(notes?.[0] ?? t.name)}</h2><span class="pill">${esc(t.category)}</span><span class="pill muted">${esc(coverageLabels[t.coverage] ?? t.coverage)}</span><p>${esc(notes?.[1] ?? "该任务已有结构定位，具体加工职责尚未逐项解释。")}</p><div class="notice">${esc(notes?.[2] ?? "输入与输出关联不等于已经确认的字段因果或运行落地。")}</div>${knowledgeDetail(id)}<h3>读取来源 · ${t.inputs.length}</h3>${input || '<p class="micro">当前表级快照缺少输入关系，不代表实际没有读取。</p>'}<h3>输出关联 · ${t.outputs.length}</h3>${output || '<p class="micro">当前表级快照缺少输出关系。</p>'}<p class="micro">输出可能来自 SQL 写入、平台目标声明或导出配置。固定 SQL 与说明用于进一步判断。</p>${sql}<details><summary>来源标记</summary><p class="micro">table-network.json · 固定发布版本。SQL 来自已核版本的留存快照；不代表当前运行版本或完整发布证据。</p><div class="hash">${esc(DATA.version)}</div></details>`,
      returnTo,
    );
    if (["107491", "223867"].includes(id)) addReadingEntry(() => taskDetail(id, returnTo));
  }
  function addReadingEntry(returnTo) {
    const button = document.createElement("button");
    button.className = "row-button primary";
    button.textContent = "合约到按日创收 · 阅读加工说明与证据 ↗";
    button.dataset.salesEntry = "true";
    button.onclick = () => showReading("salesIncome", "", returnTo);
    $("panel-content").prepend(button);
  }
  function showEdge(edge, a, b) {
    const groups = flowGroups(edge);
    const description = edge.sourceTopic
      ? "每个任务在当前表级快照中读取该来源 topic 的一个 schema，并有 odata_n_tit 输出关联。它不是逐字段映射，也不能证明同一批次已接续。"
      : "同一任务读取来源区域，并具有目标区域输出关联。任务集合可与其他方向重叠；不是逐字段因果或运行落地证明。";
    if (groups.length === 1)
      return taskList(
        groups[0].taskIds,
        `${groups[0].from} → ${groups[0].to}`,
        description,
      );
    if (groups.length > 1) {
      const show = () => {
        panel(
          "区域关联",
          `<h2>${esc(a.title)} → ${esc(b.title)}</h2><p>${esc(description)}</p><p class="micro">各组分别计数，不能直接相加。${edge.sourceTopic ? "同一 topic 仅按当前直接进入 OData 的 schema 汇聚。" : edge.otherSources ? "这里列出非来源 topic 的其他已见接入关系，职责尚未逐域核验。" : ""}</p>${groups.map((g, i) => `<button class="row-button" data-group="${i}"><span class="count">${g.tasks} 任务 ↗</span><strong>${esc(g.from)} → ${esc(g.to)}</strong></button>`).join("")}`,
        );
        bindButtons("[data-group]", ({ group }) => {
          const g = groups[Number(group)];
          taskList(g.taskIds, `${g.from} → ${g.to}`, description, show);
        });
      };
      show();
      return;
    }
    const ids = unique([...(a.tasks ?? []), ...(b.tasks ?? [])]);
    if (ids.length)
      return taskList(
        ids,
        `${a.title} → ${b.title}`,
        "这条代表路线来自知识稿的表级关系及 SQL 阅读；以下任务是该段的阅读入口，运行批次接续未确认。",
      );
    panel(
      "知识稿中的关联",
      `<h2>${esc(a.title)} → ${esc(b.title)}</h2><p>${esc(DATA.views[current].boundary)}</p><p class="micro">这是知识稿中的归纳连接。当前未为这段单独绑定精确任务集合，可从两端节点继续查看。</p><button id="edge-document" class="primary">阅读本段知识稿</button>`,
    );
    $("edge-document").onclick = () => showDocument(DATA.views[current].source);
  }
  function openNode(node) {
    if (node.sourceTopic) return sourceTopicDetail(node.sourceTopic);
    if (node.view) return navigate(node.view);
    if (node.principal) return showPrincipal();
    if (node.tasks?.length === 1) return taskDetail(node.tasks[0]);
    if (node.tasks?.length) return taskList(node.tasks, node.title);
    if (node.table) return tableDetail(node.table);
    if (node.schemas?.length) return regionDetail(node.schemas, node.title);
    if (node.id === "X")
      return showEdge({ otherSources: true }, node, { title: "odata_n_tit" });
    panel(
      "加工单元",
      `<h2>${esc(node.title)}</h2><p>${esc(node.subtitle)}</p><div class="notice">这个单元已有结构定位，尚未单独完成业务职责核验。</div>`,
    );
  }
  function sourceTopicDetail(topicId, returnTo = null) {
    const topic = sourceTopics.get(topicId);
    if (!topic) return;
    const ingressFlows = topic.sourceSchemas
      .map((source) =>
        DATA.flows.find(
          (flow) =>
            flow.from === source.schema && flow.to === topic.targetSchema,
        ),
      )
      .filter(Boolean);
    const downstreamFlows = DATA.flows
      .filter(
        (flow) =>
          flow.from === topic.targetSchema && flow.to !== topic.targetSchema,
      )
      .sort((left, right) => right.tasks - left.tasks || left.to.localeCompare(right.to));
    const recall = () => sourceTopicDetail(topicId, returnTo);
    panel(
      "来源 topic 分析",
      `<h2>${esc(topic.title)}</h2><p>按 <code>${esc(topic.sourceSchemaPrefix)}*</code> 且直接进入 <code>${esc(topic.targetSchema)}</code> 的当前表级关系聚合。这里的 topic 是来源归属规则，不等于已经完成业务对象分类。</p><div class="stats"><div><strong>${fmt(topic.sourceSchemas.length)}</strong><span>接入 source schema</span></div><div><strong>${fmt(topic.tableIdentities)}</strong><span>本批表身份</span></div><div><strong>${fmt(topic.uniqueIngressTaskIds.length)}</strong><span>不重复接入任务</span></div></div><div class="notice">“进入 OData”仅表示同一任务读取来源 schema 且具有 <code>odata_n_tit</code> 输出关联。没有字段级映射、写入分区和运行批次证据时，不把它说成逐表复制或已成功落地。</div><div class="panel-actions"><button id="topic-ingress-tasks" class="primary">查看接入任务</button><button id="topic-objects">查看来源对象</button><button id="open-odata-topic">进入 OData 区域分析</button></div><h3>按 schema 看进入 OData</h3>${topic.sourceSchemas.map((source) => `<button class="row-button" data-source-schema="${esc(source.schema)}"><span class="count">${fmt(source.tasks)} 接入任务 ↗</span><strong>${esc(source.schema)}</strong><small>${fmt(source.tables)} 表身份 · 点击查看该 schema 的当前关联</small></button>`).join("") || '<div class="empty">当前快照没有匹配的直接接入 schema。</div>'}<h3>进入 OData 后的可见去向</h3><p class="micro">下列是 <code>odata_n_tit</code> 的区域级输出关联，不能反推某个来源任务必然由同一批次继续处理。</p>${downstreamFlows.slice(0, 8).map((flow, index) => `<button class="row-button" data-topic-output="${index}"><span class="count">${fmt(flow.tasks)} 任务 ↗</span><strong>${esc(topic.targetSchema)} → ${esc(flow.to)}</strong></button>`).join("") || '<div class="empty">当前快照没有可展示的下游区域关联。</div>'}<h3>字段与 knowledge 覆盖</h3><div class="notice">该页面的固定快照只携带表身份和任务关联；没有受控的来源字段元数据、对象类型或来源标签绑定。因此不显示字段数、TABLE/VIEW 比例或标签分布，也不把缺失误报为 0。补入有范围的元数据和 knowledge 后，才应在这里按同一对象身份统计。</div>`,
      returnTo,
    );
    $("topic-ingress-tasks").onclick = () =>
      taskList(
        topic.uniqueIngressTaskIds,
        `${topic.title} → ${topic.targetSchema}`,
        "按来源 topic 去重后的直接接入任务。单个任务仍可能读取多张表；此处不提供字段级映射。",
        recall,
      );
    $("topic-objects").onclick = () => sourceTopicObjects(topicId, recall);
    $("open-odata-topic").onclick = () => navigate("odata");
    bindButtons("[data-source-schema]", ({ sourceSchema }) =>
      regionDetail([sourceSchema], `${topic.title} · ${sourceSchema}`, recall),
    );
    bindButtons("[data-topic-output]", ({ topicOutput }) => {
      const flow = downstreamFlows[Number(topicOutput)];
      taskList(
        flow.taskIds,
        `${topic.targetSchema} → ${flow.to}`,
        "这是 OData 区域级的可见输出关联；与上方来源任务没有被证明为同一批次的连续路径。",
        recall,
      );
    });
  }
  function sourceTopicObjects(topicId, returnTo = null) {
    const topic = sourceTopics.get(topicId);
    if (!topic) return;
    const sourceSchemas = new Set(topic.sourceSchemas.map((source) => source.schema));
    const objects = DATA.tables
      .filter((table) => sourceSchemas.has(table.name.split(".", 1)[0]))
      .sort((left, right) => left.name.localeCompare(right.name));
    const recall = () => sourceTopicObjects(topicId, returnTo);
    panel(
      "来源对象",
      `<h2>${esc(topic.title)} · 本批表身份</h2><p class="micro">显示 ${fmt(objects.length)} 个当前图中的来源对象。表身份不是已核实的 TABLE/VIEW 类型；只提供名称与任务关联，不展示未载入的字段和标签。</p><input id="topic-object-search" class="search" aria-label="筛选来源对象" placeholder="按完整对象名筛选"><div id="topic-object-results"></div>`,
      returnTo,
    );
    let page = 1;
    function update() {
      const query = $("topic-object-search").value.trim().toLowerCase();
      const matches = objects.filter((object) =>
        object.name.toLowerCase().includes(query),
      );
      const visible = matches.slice(0, page * 30);
      $("topic-object-results").innerHTML =
        `<div class="list-count">${fmt(matches.length)} 个匹配对象 · 当前显示 ${fmt(visible.length)}</div>${visible.map((object) => `<button class="row-button" data-topic-object="${esc(object.name)}"><span class="count">${fmt(object.readers.length)} 读取 / ${fmt(object.writers.length)} 输出 ↗</span><strong>${esc(object.name)}</strong><small>图中的表身份；对象类型、字段和知识标签尚未载入</small></button>`).join("") || '<div class="empty">没有匹配的来源对象。</div>'}${visible.length < matches.length ? '<button id="more-topic-objects" class="row-button">再显示 30 个 ↓</button>' : ""}`;
      bindButtons("[data-topic-object]", ({ topicObject }) =>
        tableDetail(topicObject, recall),
      );
      if ($("more-topic-objects"))
        $("more-topic-objects").onclick = () => {
          page += 1;
          update();
        };
    }
    $("topic-object-search").addEventListener("input", () => {
      page = 1;
      update();
    });
    update();
  }
  function regionDetail(names, title, returnTo = null) {
    const selected = names.map((n) => schemas.get(n)).filter(Boolean);
    const writerIds = unique(selected.flatMap((s) => s.writerTaskIds));
    const readerIds = unique(selected.flatMap((s) => s.readerTaskIds));
    const flows = DATA.flows.filter(
      (f) => names.includes(f.from) || names.includes(f.to),
    );
    const recall = () => regionDetail(names, title, returnTo);
    panel(
      "区域定位",
      `<h2>${esc(title)}</h2><p class="micro">${esc(names.join(" / "))} · 本批表级网络</p><div class="stats"><div><strong>${fmt(selected.reduce((sum, s) => sum + s.tables, 0))}</strong><span>表节点</span></div><div><strong>${fmt(writerIds.length)}</strong><span>输出关联任务</span></div><div><strong>${fmt(readerIds.length)}</strong><span>读取任务</span></div></div><div class="panel-actions"><button id="region-writers" class="primary">输出关联任务</button><button id="region-readers">读取任务</button></div><div class="notice">区域命名不自动等于业务职责；表节点中可能有临时、占位或测试对象。没有解释的部分先保留结构位置。</div><h3>已见方向 · ${flows.length}</h3>${flows
        .sort((a, b) => b.tasks - a.tasks)
        .map(
          (f) =>
            `<button class="row-button" data-from="${esc(f.from)}" data-to="${esc(f.to)}"><span class="count">${f.tasks} ↗</span><strong>${esc(f.from)} → ${esc(f.to)}</strong></button>`,
        )
        .join("")}`,
      returnTo,
    );
    $("region-writers").onclick = () =>
      taskList(
        writerIds,
        `${title} · 输出关联任务`,
        "输出关联可能来自目标声明或导出配置，不能全部计为 SQL 写表。",
        recall,
      );
    $("region-readers").onclick = () =>
      taskList(
        readerIds,
        `${title} · 读取任务`,
        "这些任务在当前快照中读取本区域的表节点。",
        recall,
      );
    bindButtons("[data-from]", ({ from, to }) => {
      const f = flows.find((x) => x.from === from && x.to === to);
      taskList(
        f.taskIds,
        `${from} → ${to}`,
        "同任务读写区域关联，各方向可能重叠。",
        recall,
      );
    });
  }
  function tableDetail(name) {
    const items = DATA.tables.filter(
      (t) => t.name.toLowerCase() === name.toLowerCase(),
    );
    const readers = unique(items.flatMap((t) => t.readers));
    const writers = unique(items.flatMap((t) => t.writers));
    const recall = () => tableDetail(name);
    panel(
      "表的输入与消费",
      `<h2>${esc(name.split(".").at(-1))}</h2><p class="micro">${esc(name)}</p><div class="stats"><div><strong>${items.length}</strong><span>匹配表身份</span></div><div><strong>${writers.length}</strong><span>输出关联任务</span></div><div><strong>${readers.length}</strong><span>读取任务</span></div></div>${items.length > 1 ? '<div class="notice">同名对应多个图中表身份。以下仅合并展示任务索引，不认定为同一个物理实例。</div>' : ""}<div class="panel-actions"><button id="table-writers">看输出关联任务</button><button id="table-readers" class="primary">看读取任务</button></div>${name === DATA.saleTable ? '<button id="table-principal" class="row-button">本金字段族 · 四产品口径与证据 ↗</button><div class="notice">候选粒度为业务日期 × 产品分区 × 合约标识；目前没有数据验证证明唯一。</div>' : '<p class="micro">同名表的读写关系只给出阅读方向，尚未证明写入分区与读取批次可以接续。</p>'}${items.length ? "" : '<div class="notice">此处为知识稿或 SQL 补证中的表名，当前快照未匹配到表身份。</div>'}`,
    );
    $("table-writers").onclick = () =>
      taskList(writers, "输出关联任务", name, recall);
    $("table-readers").onclick = () =>
      taskList(
        readers,
        "读取任务",
        `${name} · 表级读者不等于每个字段的已确认消费者。`,
        recall,
      );
    if ($("table-principal")) $("table-principal").onclick = showPrincipal;
    if ([DATA.saleTable, "pdata_n.t98_otc_deri_comp_sale_adtnl_det", "dm_otc_n.otc_rev_daily_rpt"].includes(name))
      addReadingEntry(() => tableDetail(name));
  }
  function showPrincipal() {
    const cards = DATA.writers
      .map((w) => {
        const note = DATA.taskNotes[w.id];
        const expressions = w.expressions.filter(
          (e) => e.name.toLowerCase() === "init_nom_prin",
        );
        return `<article class="writer-card"><h3>${esc(note[0])}</h3><p>${esc(note[1])}</p>${expressions.map((e) => `<div class="micro">${e.role === "AGGREGATE_MEASURE" ? "内层汇总" : "投影表达式"}</div><pre class="formula">${esc(e.text)}</pre><details><summary>物理来源与表达式位置</summary>${(e.inputs ?? []).map((i) => `<div class="table-name">${esc(i.table)}.${esc(i.column)}</div>`).join("") || '<p class="micro">此摘录未提供物理来源列表。</p>'}<div class="hash">SQL 字符范围 ${esc(e.span?.start)}–${esc(e.span?.end)} · 原始 Facts 位置</div></details>`).join("")}<p class="micro">待确认：${esc(note[2])}</p><button data-task="${w.id}">查看任务与固定 SQL ↗</button></article>`;
      })
      .join("");
    panel(
      "宽表 / 本金字段族",
      `<h2>初始名义本金<br>四产品口径对照</h2><p class="micro">${esc(DATA.saleTable)}.init_nom_prin</p><p>四个任务分别装载 grp_id = 01 / 02 / 03 / 04。相同字段名下，历史日期选择、本金形成和本层汇率处理都有区别。</p><div class="notice">四路最终金额单位和“初始”定义尚未统一确认。没有汇率乘法，不能推断上游没有折算。</div>${cards}<h3>一个已核实的下游</h3><pre class="formula">sum(coalesce(Init_Nom_Prin, 0)) as Nom_Prin</pre><p>103457 保留合约、产品等分组维度，不能说已经混加四产品。若互换汇率分支未命中并产生 NULL，进入该下游范围后可能被当作 0；尚无运行数据证明已发生。</p><button data-task="103457" class="primary">查看下游 103457 ↗</button><h3>同族字段的当前进度</h3><p class="micro">dyna_nom_prin：已观察附加明细的产品分支，尚非全链验收。<br>absl_nom_prin：本轮未完成四路对照。<br>cny_ex_rate：本层分支、NULL 或常量 1，不能直接断言最终金额单位。</p><button id="principal-doc" class="row-button">阅读完整本金知识稿 ↗</button>`,
    );
    bindButtons("[data-task]", ({ task }) => taskDetail(task, showPrincipal));
    $("principal-doc").onclick = () => showDocument("principal", showPrincipal);
  }
  function directory() {
    panel(
      "全局 / 区域目录",
      `<h2>所有区域都有位置</h2><p class="micro">${DATA.schemas.length} 个 schema 名称。主要区域已展开代表链，其余保留结构定位。</p><input id="schema-search" class="search" placeholder="查找区域名称" aria-label="查找区域名称"><div id="schema-results"></div>`,
    );
    function update() {
      const query = $("schema-search").value.trim().toLowerCase();
      const list = DATA.schemas.filter((s) => s.schema.includes(query));
      $("schema-results").innerHTML =
        list
          .map(
            (s) =>
              `<button class="row-button" data-schema="${esc(s.schema)}"><span class="count">${s.tables} 表节点 ↗</span><strong>${esc(s.schema)}</strong><small>${s.writers} 输出关联任务 · ${s.readers} 读取任务</small></button>`,
          )
          .join("") || '<div class="empty">没有匹配的区域。</div>';
      bindButtons("[data-schema]", ({ schema }) =>
        regionDetail([schema], schema, directory),
      );
    }
    $("schema-search").oninput = update;
    update();
  }
  function showDocument(key = "skeleton", returnTo = null) {
    if (["salesIncome", "salesEvidence", "fixedSql"].includes(key))
      return showReading(key, "", returnTo);
    const doc = DATA.documents[key] ?? DATA.documents.skeleton;
    panel(
      "知识稿 / Markdown 原文",
      `<h2>${key === "principal" ? "四路合约本金" : key === "inventory" ? "区域盘点" : "股衍数据加工骨架 V0"}</h2><p class="micro">${esc(doc.path)} · 本页内置调查时的文稿。图的交互展示位于左侧，原文保留上下文和证据边界。</p><pre class="doc-text">${esc(doc.text)}</pre>`,
      returnTo,
    );
  }
  function showReading(key = "salesIncome", anchor = "", returnTo = null, state = null) {
    const doc = DATA.documents[key];
    const body = key === "fixedSql"
      ? `<h2>本条链的固定 SQL</h2><p>选择任务查看全文及摘要；返回可继续阅读原处。</p>${["86840", "86841", "86842", "220650", "107491", "223867"].map(taskButton).join("")}`
      : `<p class="micro">共享知识 · 构建时内置 · 已核历史 SQL，业务待确认</p><article class="reading-body">${doc.html}</article><p class="micro">来源：${esc(doc.path)}</p>`;
    panel("合约到创收 / 加工说明与证据", body, returnTo);
    $("inspector").classList.add("reading-mode");
    $("panel-content").scrollTop = 0;
    const captureReturn = () => {
      const saved = {
        scroll: $("panel-content").scrollTop,
        sections: [...$("panel-content").querySelectorAll(".reading-section")].map((s) => s.open),
      };
      return () => showReading(key, "", returnTo, saved);
    };
    bindButtons("[data-reading]", ({ reading, anchor: target }) => {
      const restore = captureReturn();
      if (reading.startsWith("task:")) taskDetail(reading.slice(5), restore);
      else if (["salesIncome", "salesEvidence", "fixedSql"].includes(reading)) showReading(reading, target, restore);
      else showDocument(reading, restore);
    });
    bindButtons("[data-task]", ({ task }) => taskDetail(task, captureReturn()));
    if (state) {
      $("panel-content").querySelectorAll(".reading-section").forEach((s, i) => { s.open = state.sections[i]; });
      $("panel-content").scrollTop = state.scroll;
    } else if (anchor) {
      const marker = document.getElementById(`reading-${anchor}`);
      const section = marker?.nextElementSibling;
      if (section?.matches("details")) section.open = true;
      marker?.scrollIntoView({ block: "start" });
    }
  }
  function coverage() {
    panel(
      "范围与证据",
      `<h2>有明确空白的第一版</h2><div class="stats"><div><strong>${fmt(DATA.counts.tasks)}</strong><span>任务</span></div><div><strong>${fmt(DATA.counts.tables)}</strong><span>表节点</span></div><div><strong>${DATA.schemas.length}</strong><span>区域名称</span></div></div><h3>这版已经整理</h3><p>全量表层盘点、主要流向、各层代表链、交付与日志区别，以及四产品本金的字段证据。</p><h3>覆盖状态</h3>${Object.entries(
        DATA.coverage,
      )
        .map(
          ([k, v]) =>
            `<button class="row-button" data-coverage="${esc(k)}"><span class="count">${fmt(v)} ↗</span><strong>${esc(coverageLabels[k] ?? k)}</strong></button>`,
        )
        .join(
          "",
        )}<div class="notice">有投影材料不代表全部语义已解释。仅调度材料不一定应该有 SQL，也不能补成数据读写关系。</div><h3>尚未完成</h3><p>全部任务的加工语义、业务职责与正式口径确认、Join 后唯一性、运行批次接续、目标送达验证。</p><h3>图与 Facts 在这里各自负责什么</h3><p>图的固定快照提供区域流向和任务成员；Machine Facts 与固定 SQL 支撑代表任务的加工解释；区域职责和阅读分组来自已整理的知识稿。</p><p class="micro">区域数字是同任务的来源与输出关联数，集合可重叠。12,256 条原始边包含读次与写观察，不等于独立关系数。</p><details><summary>固定来源版本</summary><div class="hash">${esc(DATA.version)}</div><p class="micro">发布：${esc(DATA.publishedAt)}<br>快照导出：${esc(DATA.exportedAt)}<br>本地 HTML 内置该批材料，不会自动查询更新。</p></details>`,
    );
    bindButtons("[data-coverage]", ({ coverage: state }) =>
      taskList(
        DATA.tasks.filter((t) => t.coverage === state).map((t) => t.id),
        coverageLabels[state],
        "覆盖状态是材料状态，不是业务或运行验收结论。",
        coverage,
      ),
    );
  }

  $("region-count").textContent = DATA.schemas.length;
  $("home").onclick = () => navigate("overview");
  document.querySelector(".brand").onclick = (e) => {
    e.preventDefault();
    navigate("overview");
  };
  $("back").onclick = back;
  $("directory").onclick = directory;
  $("coverage").onclick = coverage;
  $("document").onclick = () => showDocument(DATA.views[current].source);
  $("sales-reading").onclick = () => showReading();
  $("members").onclick = () =>
    regionDetail(
      DATA.views[current].schemas,
      DATA.views[current].title.split(" · ")[0],
    );
  $("principal-shortcut").onclick = () => navigate("principal");
  $("close-panel").onclick = () => closePanel();
  $("panel-back").onclick = () => previousPanel?.();
  $("zoom-in").onclick = () => zoom(1.2);
  $("zoom-out").onclick = () => zoom(1 / 1.2);
  $("fit").onclick = fit;
  $("canvas").addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".map-controls")) return;
    moved = false;
    drag = {
      x: e.clientX,
      y: e.clientY,
      cx: camera.x,
      cy: camera.y,
      id: e.pointerId,
    };
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      moved = true;
      camera.x = drag.cx + dx;
      camera.y = drag.cy + dy;
      $("canvas").classList.add("dragging");
      applyCamera();
    }
  });
  const finishDrag = () => {
    drag = null;
    $("canvas").classList.remove("dragging");
    setTimeout(() => {
      moved = false;
    }, 0);
  };
  window.addEventListener("pointerup", finishDrag);
  window.addEventListener("pointercancel", finishDrag);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });
  window.addEventListener("popstate", (e) => {
    const id = DATA.views[location.hash.slice(1)]
      ? location.hash.slice(1)
      : "overview";
    trail =
      Array.isArray(e.state?.trail) &&
      e.state.trail.every((key) => DATA.views[key])
        ? [...e.state.trail]
        : id === "overview"
          ? ["overview"]
          : ["overview", id];
    setView(id, false);
  });
  let previousSize = null;
  new ResizeObserver(([entry]) => {
    const next = entry.contentRect;
    if (previousSize && initialized) {
      camera.x += (next.width - previousSize.width) / 2;
      camera.y += (next.height - previousSize.height) / 2;
      applyCamera();
    }
    previousSize = { width: next.width, height: next.height };
  }).observe($("canvas"));
  const initial = location.hash.slice(1);
  if (DATA.views[initial] && initial !== "overview") trail.push(initial);
  history.replaceState(
    { trail: [...trail], direct: trail.length > 1 },
    "",
    `#${DATA.views[initial] ? initial : "overview"}`,
  );
  setView(DATA.views[initial] ? initial : "overview", false);
})();
