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
  const unique = (values) => [...new Set(values)];
  const route = (type, id = "") =>
    `#${type}${id ? `/${encodeURIComponent(id)}` : ""}`;
  const tasks = new Map(DATA.tasks.map((t) => [t.id, t]));
  const tables = new Map(DATA.tables.map((t) => [t.name, t]));
  const families = new Map(DATA.families.map((f) => [f.id, f]));
  const groups = new Map(DATA.groups.map((g) => [g.id, g]));
  const methods = new Map(DATA.methods.map((m) => [m.id, m]));
  const states = new Map();
  let current = location.hash || "#overview";
  let firstRender = true;
  const state = () => {
    if (!states.has(current))
      states.set(current, { query: "", page: 1, scroll: 0, tab: "tables" });
    return states.get(current);
  };
  const def = (name) => DATA.definitions[name];
  const tableTitle = (name) => def(name)?.text || name.split(".").at(-1);
  const familyTitle = (f) => f.definition?.text || f.id;
  const shortDefinition = (text) =>
    String(text)
      .replace(/^场外交易[-－]/, "")
      .replace(/^风控视图[-－]/, "")
      .replace(/^证券[-－]/, "");
  const taskTitle = (t) => {
    const name = t.name
      .replace(/\[(?:环境地址已省略|本地证据文件|已省略)\]/g, "")
      .trim();
    if (name) return name;
    const output = t.outputs.find((n) => tables.has(n)) || t.outputs[0];
    return `${methods.get(t.methodId)?.short || "输出关联"}${output ? ` · ${shortDefinition(tableTitle(output))}` : ` · 任务 ${t.id}`}`;
  };
  const tag = (id) =>
    `<a class="tag" href="${route("method", id)}">${esc(methods.get(id)?.short || id)}</a>`;
  const tableLink = (name, extra = "") =>
    `<a class="table-link${tables.has(name) ? " table-version" : ""}" href="${route("table", name)}"><strong>${esc(shortDefinition(tableTitle(name)))}</strong><span class="code-name">${esc(name)}</span>${extra ? `<small>${esc(extra)}</small>` : ""}</a>`;
  const taskLink = (id) => {
    const t = tasks.get(id);
    if (!t) return "";
    const note = DATA.observations[id];
    return `<a class="task-row" href="${route("task", id)}"><span class="task-id">${esc(id)} ↗</span><span><strong>${esc(note?.title || taskTitle(t))}</strong><small>${esc(t.category)} · ${t.inputs.length} 输入 / ${t.outputs.length} 输出</small></span><small>${DATA.evidence[id] ? "查看 SQL" : "查看表关系"}</small></a>`;
  };
  function intro(kicker, title, description, meta = "") {
    return `<div class="intro"><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="lead">${esc(description)}</p></div>${meta ? `<div class="intro-meta">${meta}</div>` : ""}</div>`;
  }
  const searchShell = (placeholder) =>
    `<div class="search-bar"><input id="filter" type="search" autocomplete="off" aria-label="${esc(placeholder)}" placeholder="${esc(placeholder)}"><span class="result-count" id="result-count"></span></div><div id="results" class="list"></div>`;
  function searchable(items, searchText, renderItem, pageSize = 30) {
    const input = $("filter");
    input.value = state().query;
    function update() {
      const term = state().query.trim().toLowerCase();
      const matches = items.filter((item) =>
        searchText(item).toLowerCase().includes(term),
      );
      const visible = matches.slice(0, state().page * pageSize);
      $("result-count").textContent =
        `${matches.length} 项 · 显示 ${visible.length}`;
      $("results").innerHTML =
        visible.map(renderItem).join("") ||
        '<div class="empty">没有匹配的内容。可换用表名、任务编号或中文说明。</div>';
      if (visible.length < matches.length) {
        const more = document.createElement("button");
        more.className = "more";
        more.textContent = `再显示 ${pageSize} 项 ↓`;
        more.onclick = () => {
          state().page += 1;
          update();
        };
        $("results").append(more);
      }
    }
    input.oninput = () => {
      state().query = input.value;
      state().page = 1;
      update();
    };
    update();
  }
  function familyRow(f) {
    const destinations = unique(
      f.destinations.map((d) => d.name.split(".")[0]),
    );
    return `<div class="object-row"><a href="${route("family", f.id)}"><strong>${esc(shortDefinition(familyTitle(f)))} ↗</strong><span class="code-name">${esc(f.id)}</span><small>${f.tableNames.length} 张同名相关表</small></a><div>${f.methodIds.map(tag).join("") || "<small>本图未关联写入任务</small>"}</div><div class="dest-summary">${f.consumerIds.length ? `${f.consumerIds.length} 个区域外读取任务<br><span class="muted">${esc(destinations.slice(0, 3).join(" · "))}${destinations.length > 3 ? " …" : ""}</span>` : '<span class="muted">本图未见区域外读者</span>'}</div></div>`;
  }
  function listTables(names) {
    return (
      names.map((name) => tableLink(name)).join("") ||
      '<p class="fine">当前范围未记录这一侧的表关联。</p>'
    );
  }
  function boundedTables(names, limit = 7) {
    return (
      listTables(names.slice(0, limit)) +
      (names.length > limit
        ? `<details><summary>展开其余 ${names.length - limit} 张表</summary>${listTables(names.slice(limit))}</details>`
        : "")
    );
  }
  function downstreamNotes(ids) {
    const notes = unique(ids).filter((id) => DATA.observations[id]);
    if (!notes.length) return "";
    return `<section class="section"><div class="section-top"><h2>已经查明的下游变化</h2><small>证据入口；全部成员在下方保留</small></div><div class="method-grid">${notes
      .map((id) => {
        const note = DATA.observations[id];
        return `<a class="method-card" href="${route("task", id)}"><p class="eyebrow">任务 ${esc(id)} · 查看 SQL ↗</p><h3>${esc(note.title)}</h3><p>${esc(note.text)}</p>${note.result ? `<span class="code-name">${esc(note.result)}</span>` : ""}</a>`;
      })
      .join("")}</div></section>`;
  }
  function overview() {
    const c = DATA.counts;
    $("crumb").textContent = "";
    $("main").innerHTML =
      intro(
        "02 / 区域全貌",
        "业务源数据，在这里分成哪些可用结果",
        "沿业务对象看来源、版本与去向。先进入一组对象，再穿透到具体表、加工任务和 SQL。",
        `<strong>${c.tables}</strong><span>张表</span><small>${c.families} 个同名表组 · 全量可查</small>`,
      ) +
      `<div class="context-strip"><span><strong>${c.ingress} 个接入任务</strong>带入业务对象，<strong>${c.internal} 个内部任务</strong>整理部分版本与结果。</span><span><strong>${c.consumers - c.consumersOfProcessed} / ${c.consumers}</strong> 个外部读者未读取内部整理目标，直接供给是重要路线。</span></div>
      <div class="landscape-head"><span>01　区域里是什么对象</span><span>02　这里怎样组织与改变</span><span>03　继续形成什么</span></div>
      <section class="landscape" aria-label="区域业务对象与加工路线">${DATA.groups
        .map((g, index) => {
          const ids = unique(
            g.tableNames.flatMap((n) => tables.get(n).methodIds),
          );
          const destinationSchemas = unique(
            g.destinations.map((d) => d.name.split(".")[0]),
          );
          return `<article class="lane" style="--group:${esc(g.color)}"><div class="lane-object"><span class="lane-number">${String(index + 1).padStart(2, "0")} / OBJECTS</span><a href="${route("group", g.id)}">${esc(g.title)} ↗</a><div class="lane-meta">${g.tableNames.length} 张表 · ${g.familyIds.length} 个同名表组</div></div><div class="lane-change"><p>${esc(g.change)}</p><div class="mini-links">${
            ids
              .filter((id) => id !== "source_supply")
              .map(
                (id) =>
                  `<a class="mini-link" href="${route("method", id)}">${esc(methods.get(id).short)}</a>`,
              )
              .join("") || '<span class="mini-link">查看实际读写关系</span>'
          }</div></div><div class="lane-next"><div class="next-title">${esc(g.destinationsHint || "去向待定位")}<div class="lane-meta">${g.consumerIds.length} 个读取任务 · ${destinationSchemas.length} 个目标区域</div></div><div class="mini-links"><a class="mini-link" href="${route("group", g.id)}">查看完整路线 →</a></div></div></article>`;
        })
        .join("")}</section>
      <div class="overview-tail"><p class="fine">对象分组用于导航；同名表并列不代表已确认版本接续。每组都保留全部成员与实际读写关系。</p><a class="button secondary" href="#catalog">查找表或任务</a><a class="button secondary" href="#methods">对照加工规则</a></div>`;
  }
  function groupPage(id) {
    const g = groups.get(id);
    if (!g) return notFound();
    $("crumb").textContent = `/ ${g.title}`;
    const familyList = g.familyIds.map((key) => families.get(key));
    const sourceSchemas = unique(g.sourceNames.map((n) => n.split(".")[0]));
    const targetSchemas = unique(
      g.destinations.map((d) => d.name.split(".")[0]),
    );
    const methodIds = unique(
      g.tableNames.flatMap((n) => tables.get(n).methodIds),
    );
    $("main").innerHTML =
      intro(
        "03 / 对象分组",
        g.title,
        g.question || g.summary,
        `<strong>${g.tableNames.length}</strong><span>张表</span><small>${g.familyIds.length} 个同名表组</small>`,
      ) +
      `<div class="facts-grid"><div class="fact-box"><p class="eyebrow">这些对象怎样区分</p><p>${esc(g.summary)}</p></div><div class="fact-box"><p class="eyebrow">本区发生的变化</p><p>${esc(g.change)}</p></div></div>
      <div class="counts"><span><b>${g.writerIds.length}</b> 个写入任务</span><span><b>${g.internalIds.length}</b> 个内部关联任务</span><span><b>${g.consumerIds.length}</b> 个区域外读取任务</span></div>
      <p class="fine">可见来源：${esc(sourceSchemas.join(" · ") || "本图缺少关联")}<br>可见去向：${esc(targetSchemas.join(" · ") || "本图未见区域外读者")}</p>
      <div>${methodIds.map(tag).join("")}</div>${downstreamNotes(g.consumerIds)}
      <section class="section"><div class="section-top"><h2>全部对象与相关表</h2><small>同名表组仅用于导航</small></div>${searchShell("搜索对象说明、表名或下游表")}</section>`;
    searchable(
      familyList,
      (f) =>
        `${familyTitle(f)} ${f.tableNames.join(" ")} ${f.destinations.map((d) => d.name).join(" ")}`,
      familyRow,
    );
  }
  function familyPage(id) {
    const f = families.get(id);
    if (!f) return notFound();
    const g = groups.get(f.groupId);
    $("crumb").innerHTML =
      `/ <a href="${route("group", g.id)}">${esc(g.title)}</a> / 对象路线`;
    const targets = f.destinations.map((d) => d.name);
    $("main").innerHTML =
      intro(
        "04 / 对象与分流",
        shortDefinition(familyTitle(f)),
        `${f.tableNames.length} 张同名相关表；从实际写入任务和读取任务查看它们的来源、变化与去向。`,
      ) +
      `<p class="code-name">${esc(f.id)}</p><div class="counts"><span><b>${f.writerIds.length}</b> 个写入任务</span><span><b>${f.consumerIds.length}</b> 个区域外读取任务</span></div>
      <div class="route-grid"><section class="route-stage"><h3>01　进入本区的来源 · ${f.sourceNames.length}</h3>${boundedTables(f.sourceNames)}</section><section class="route-stage"><h3>02　本区的相关表 · ${f.tableNames.length}</h3>${f.tableNames
        .map((n) =>
          tableLink(
            n,
            tables
              .get(n)
              .methodIds.map((key) => methods.get(key).short)
              .join(" · ") || "本图未关联写入任务",
          ),
        )
        .join("")}${f.methodIds
        .filter((key) => key !== "source_supply")
        .map(
          (key) =>
            `<div class="method-inline"><a href="${route("method", key)}">${esc(methods.get(key).short)} ↗</a><p>${esc(methods.get(key).meaning)}</p></div>`,
        )
        .join(
          "",
        )}</section><section class="route-stage"><h3>03　区域外的输出关联 · ${targets.length}</h3>${boundedTables(targets)}</section></div>
      <p class="fine">以上来源与结果通过具体任务关联。查看某张表可区分哪一个任务读它、写它；同任务的输入输出共现不表示所有字段互相传递。</p>${downstreamNotes(f.consumerIds)}
      <section class="section"><div class="section-top"><h2>这组表的完整相关任务</h2><small>包含内部关联及区域外消费</small></div>${searchShell("搜索任务编号、名称或输入输出表")}</section>`;
    taskSearch(unique([...f.writerIds, ...f.internalIds, ...f.consumerIds]));
  }
  function taskSearch(ids) {
    searchable(
      ids.filter((id) => tasks.has(id)),
      (id) => {
        const t = tasks.get(id);
        return `${id} ${taskTitle(t)} ${t.inputs.join(" ")} ${t.outputs.join(" ")}`;
      },
      taskLink,
    );
  }
  function tablePage(name) {
    const t = tables.get(name);
    const readers = DATA.tasks
      .filter((x) => x.inputs.includes(name))
      .map((x) => x.id);
    const writers = DATA.tasks
      .filter((x) => x.outputs.includes(name))
      .map((x) => x.id);
    if (!t && !readers.length && !writers.length) return notFound();
    const f = t && families.get(t.familyId);
    $("crumb").innerHTML = f
      ? `/ <a href="${route("group", f.groupId)}">${esc(groups.get(f.groupId).title)}</a> / <a href="${route("family", f.id)}">对象路线</a> / 表`
      : "/ 关联表";
    const active = state().tab === "readers" ? "readers" : "writers";
    $("main").innerHTML =
      intro(
        "05 / 表与任务",
        shortDefinition(tableTitle(name)),
        t
          ? "比较这张表的写入方式与下游读取方式，继续进入任务查看加工规则和 SQL。"
          : "仅展示与 odata_n_tit 直接相关任务中的读写关联，可返回加工总览继续查看其他区域。",
      ) +
      `<p class="code-name code-title">${esc(name)}</p><div>${(t?.methodIds || []).map(tag).join("")}</div>
      ${t?.methodIds.length > 1 ? '<div class="notice">这张表由不同职责的任务写入，可同时承担接入落表和内部加工结果等角色。</div>' : ""}
      ${name.includes("_tmp") ? '<div class="notice">临时对象的写入可能没有完整进入表图，需结合相关任务 SQL 查看。</div>' : ""}
      <div class="tabs"><button data-tab="writers" aria-pressed="${active === "writers"}">谁写入它<span class="tab-count">${writers.length}</span></button><button data-tab="readers" aria-pressed="${active === "readers"}">谁读取它<span class="tab-count">${readers.length}</span></button></div>${searchShell("搜索关联任务或其他输入输出表")}`;
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.onclick = () => {
        state().tab = button.dataset.tab;
        state().query = "";
        state().page = 1;
        tablePage(name);
      };
    });
    taskSearch(active === "writers" ? writers : readers);
  }
  function taskPage(id) {
    const t = tasks.get(id);
    if (!t) return notFound();
    const m = methods.get(t.methodId),
      observation = DATA.observations[id],
      ev = DATA.evidence[id];
    const relatedGroups = unique(
      [...t.inputs, ...t.outputs]
        .filter((n) => tables.has(n))
        .map((n) => tables.get(n).groupId),
    );
    $("crumb").textContent = `/ 任务 ${id}`;
    $("main").innerHTML =
      intro(
        "06 / 加工任务",
        observation?.title || m?.short || "查看任务的输入与输出",
        observation?.text ||
          (m
            ? m.change
            : "本轮保留此任务的结构和可用 SQL，尚未逐条解释它的业务加工。"),
      ) +
      `<p class="code-name">任务 ${esc(id)} · ${esc(taskTitle(t))} · ${esc(t.category)}</p><div>${m ? tag(m.id) : ""}${relatedGroups.map((key) => `<a class="tag" href="${route("group", key)}">${esc(groups.get(key).title)}</a>`).join("")}</div>
      ${m ? `<div class="method-inline"><p>${esc(m.meaning)}</p><a class="inline-link" href="${route("method", m.id)}">查看这类加工的全部任务与结果 →</a></div>` : ""}
      <section class="section facts-grid"><div><h2>读取来源 · ${t.inputs.length}</h2>${boundedTables(t.inputs, 10)}</div><div><h2>输出关联 · ${t.outputs.length}</h2>${boundedTables(t.outputs, 10)}</div></section>
      <p class="fine">表图可能省略已有结果的回读和临时写入。输出关联也可能包含配置目标，具体操作请对照下面的 SQL。</p>
      <section class="section"><div class="section-top"><h2>SQL 留存</h2><small>${ev ? (ev.reviewed ? "本轮已查阅的 SQL" : "本地留存 · 尚未逐条解释") : "未收录"}</small></div>${
        ev
          ? `<p class="fine">来自本地 Input Pack。日期与宏为留存状态，尚未逐项确认为该图版本的原始 SQL 或当前生产版本。</p><div class="hash">SHA-256 · ${esc(ev.sha256)}</div><pre class="sql" tabindex="0" aria-label="任务 ${esc(id)} 的 SQL">${esc(
              ev.sql
                .split("\n")
                .map(
                  (line, index) => `${String(index + 1).padStart(4)}  ${line}`,
                )
                .join("\n"),
            )}</pre>`
          : '<div class="notice">本地没有这项任务可收录的 query SQL；上方保留已知表关系。</div>'
      }</section>`;
  }
  function methodPage(id) {
    const m = methods.get(id);
    if (!m) return notFound();
    $("crumb").innerHTML =
      `/ <a href="#methods">加工规则</a> / ${esc(m.short)}`;
    $("main").innerHTML =
      intro(
        "03 / 加工规则",
        m.question,
        m.change,
        `<strong>${m.taskIds.length}</strong><span>个任务</span><small>${m.outputNames.length} 张输出表</small>`,
      ) +
      `<div class="method-line"><div><span class="eyebrow">输入</span><br>${esc(m.input)}</div><span>→</span><div><span class="eyebrow">形成的结果</span><br>${esc(m.output)}</div></div><div class="notice">${esc(m.meaning)}</div>
      ${
        m.evidenceIds.length
          ? `<p class="fine">规则与下游使用的证据入口</p><div class="evidence-links">${m.evidenceIds
              .filter((key) => tasks.has(key))
              .map(
                (key) =>
                  `<a class="button secondary" href="${route("task", key)}">任务 ${esc(key)} ↗</a>`,
              )
              .join("")}</div>`
          : ""
      }
      <details><summary>全部 ${m.outputNames.length} 张输出表</summary>${listTables(m.outputNames)}</details>
      <section class="section"><div class="section-top"><h2>全部 ${m.taskIds.length} 个成员任务</h2><small>分类绑定于本轮分析范围</small></div>${searchShell("搜索任务编号、名称或表")}</section>`;
    taskSearch(m.taskIds);
  }
  function methodOverview() {
    $("crumb").textContent = "/ 加工规则";
    $("main").innerHTML =
      intro(
        "03 / 规则对照",
        "这些处理，具体改变了什么",
        "业务对象可以同时经过不同处理。这里查看每种规则的完整任务集合，返回对象路线可看其实际用途。",
      ) +
      `<div class="method-grid">${DATA.methods.map((m) => `<a class="method-card" href="${route("method", m.id)}"><p class="eyebrow">${m.taskIds.length} 个任务 · ${m.outputNames.length} 张结果表</p><h3>${esc(m.question)} ↗</h3><p>${esc(m.change)}</p></a>`).join("")}</div>`;
  }
  function catalog() {
    $("crumb").textContent = "/ 全部表与任务";
    const taskMode = state().tab === "tasks";
    $("main").innerHTML =
      intro(
        "03 / 全量查找",
        "定位一张表或一个任务",
        "保留本区全部表，以及接入、内部处理和区域外读取任务。任务集合按本区读写关系确定。",
      ) +
      `<div class="tabs"><button data-tab="tables" aria-pressed="${!taskMode}">全部区域表<span class="tab-count">${DATA.tables.length}</span></button><button data-tab="tasks" aria-pressed="${taskMode}">全部相关任务<span class="tab-count">${DATA.tasks.length}</span></button></div>${searchShell(taskMode ? "搜索任务编号、名称或表名" : "搜索完整表名、中文说明或对象分组")}`;
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.onclick = () => {
        state().tab = button.dataset.tab;
        state().query = "";
        state().page = 1;
        catalog();
      };
    });
    if (taskMode) taskSearch(DATA.tasks.map((t) => t.id));
    else
      searchable(
        DATA.tables,
        (t) => `${t.name} ${tableTitle(t.name)} ${groups.get(t.groupId).title}`,
        (t) =>
          `<div class="object-row"><a href="${route("table", t.name)}"><strong>${esc(shortDefinition(tableTitle(t.name)))} ↗</strong><span class="code-name">${esc(t.name)}</span></a><div>${t.methodIds.map(tag).join("") || "<small>本图未关联写入任务</small>"}</div><a class="dest-summary" href="${route("group", t.groupId)}">${esc(groups.get(t.groupId).title)} →</a></div>`,
      );
  }
  function about() {
    $("crumb").textContent = "/ 范围与依据";
    $("main").innerHTML =
      intro(
        "阅读边界",
        "这版地图依据什么，又有哪些空白",
        "结构来自本次任务范围；加工解释与本地 SQL 留存绑定。业务对象分组是一种导航组织。",
      ) +
      `<div class="about-grid"><h2>完整覆盖与解释深度</h2><p>${DATA.counts.tables} 张区域表、${DATA.counts.ingress} 个接入任务、${DATA.counts.internal} 个内部任务和 ${DATA.counts.consumers} 个区域外读取任务均可检索。内部任务已按加工职责核查；来源和消费者的全部业务逻辑尚未逐项解释。</p><p>页面收录 ${Object.keys(DATA.evidence).length} 份可用 SQL，其中 ${Object.values(DATA.evidence).filter((e) => e.reviewed).length} 份与本轮分析的摘要一致。其他 SQL 仅提供阅读入口。</p><h2>怎样理解页面里的对象与路线</h2><ul><li>同名表组将后缀不同的相关名称放在一起，便于比较；它不能单独证明版本接续。</li><li>业务分组由本轮按对象名称与已有材料整理，表的中文说明来自本地元数据，其中包含 AI 整理内容；需要通过字段和 SQL 核对具体含义。</li><li>来源与去向表示任务的表级读写关联，同一任务可能跨组、多输入和多输出，任务数不能跨组直接相加。</li><li>表图没有完整表示行情、损益对已有结果的回读及临时表写入，任务 SQL 保留这些细节。</li><li>没有可见读者不代表无人使用，没有可见写者不代表已经确认的源表。</li></ul><h2>固定材料与当前生产</h2><p>分析日期：${esc(DATA.analyzedAt)}。图发布时刻：${esc(DATA.publishedAt)}。Input Pack 保留的 SQL 日期和宏展开状态不同，尚未逐项确认为这个历史图版本的原始 SQL，也不是运行落地或业务验收证明。</p><div class="hash">图版本 · ${esc(DATA.version)}</div><p class="fine">本页离线可读，不请求外部数据。更新材料后，需要重新核查已解释的规则并重建页面。</p></div>`;
  }
  function notFound() {
    $("crumb").textContent = "/ 未找到";
    $("main").innerHTML =
      intro("当前范围", "没有找到这个对象", "该链接不在本页的区域范围中。") +
      '<a class="button" href="#catalog">查找已有表和任务</a>';
  }
  function render() {
    const raw = current.replace(/^#/, "").split("/");
    let key = "";
    try {
      key = decodeURIComponent(raw.slice(1).join("/"));
    } catch {
      return notFound();
    }
    const routes = {
      overview,
      group: () => groupPage(key),
      family: () => familyPage(key),
      table: () => tablePage(key),
      task: () => taskPage(key),
      method: () => methodPage(key),
      methods: methodOverview,
      catalog,
      about,
    };
    (routes[raw[0] || "overview"] || notFound)();
    document.title = `${$("main").querySelector("h1")?.textContent || "区域穿透"} · odata_n_tit`;
    if (!firstRender) $("main").focus({ preventScroll: true });
    requestAnimationFrame(() => window.scrollTo(0, state().scroll));
    firstRender = false;
  }
  function navigate(hash) {
    if (hash === current) return;
    state().scroll = window.scrollY;
    history.pushState({ odata: true, parent: current }, "", hash);
    current = hash;
    render();
  }
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (
      !link ||
      link.hash === "#main" ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(link.hash);
  });
  $("back").onclick = () => {
    if (history.state?.odata && history.state.parent) history.back();
    else if (current !== "#overview") navigate("#overview");
    else location.href = "processing-map.html#overview";
  };
  function restore() {
    if (current === location.hash) return;
    state().scroll = window.scrollY;
    current = location.hash || "#overview";
    render();
  }
  window.addEventListener("popstate", restore);
  window.addEventListener("hashchange", restore);
  history.replaceState({ odata: true, parent: null }, "", current);
  render();
})();
