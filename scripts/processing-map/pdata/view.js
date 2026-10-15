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
  const fmt = (n) => Number(n).toLocaleString("zh-CN");
  const branchMap = new Map(DATA.branches.map((b) => [b.id, b]));
  const tableMap = new Map(DATA.allTables.map((t) => [t.name, t]));
  const taskMap = new Map(DATA.tasks.map((t) => [t.id, t]));
  const widgets = new Map();
  const scopes = {
    output: "本批有写入",
    "read-only": "本批未见生产者",
    unlinked: "本批无读写关系",
    "outside-region": "区域外对象",
  };
  let widgetId = 0;
  let pageCrumbs = [];
  let captureGraphs = () => [];
  const navigation = PdataNavigation.create({ capture: captureView, render });
  const route = (type, id = "") =>
    `${type}${id ? `/${encodeURIComponent(id)}` : ""}`;
  const button = (label, target, className = "", extra = "") =>
    `<button class="${esc(className)}" data-route="${esc(target)}" ${extra}>${label}</button>`;
  const reader = PdataReading.create({
    button,
    route,
    esc,
    heading,
    crumbs,
    sqlBlock,
  });
  const titleOf = (name) =>
    reader.title(name) ||
    DATA.placement.records[name]?.meaning.split(/[；。]/)[0] ||
    DATA.definitions[name] ||
    name.split(".").at(-1);
  const categories = PdataCategories.create({
    reader,
    esc,
    button,
    route,
    heading,
    crumbs,
    titleOf,
    sqlBlock,
  });
  const listTitle = (title, note = "") =>
    `<div class="section-header"><h2>${esc(title)}</h2>${note ? `<small>${esc(note)}</small>` : ""}</div>`;

  function navigate(target, payload) {
    navigation.navigate(target, payload);
  }
  function crumbs(items) {
    pageCrumbs = items;
  }
  function captureView() {
    return {
      scroll: scrollY,
      reader: categories.capture(),
      graphs: captureGraphs(),
      lists: [...widgets.entries()]
        .filter(([, item]) => ["tasks", "tables"].includes(item.kind))
        .map(([key, item]) => ({
          key,
          filter: item.filter,
          limit: item.limit,
        })),
      details: [...$("content").querySelectorAll("details")].map(
        (item) => item.open,
      ),
      sql: [...$("content").querySelectorAll(".sql-scroll")].map((item) => ({
        top: item.scrollTop,
        left: item.scrollLeft,
      })),
    };
  }
  function heading(kicker, title, description = "", extraClass = "") {
    return `<div class="${esc(extraClass)}"><p class="eyebrow">${esc(kicker)}</p><h1 tabindex="-1">${esc(title)}</h1>${description ? `<p class="lede">${esc(description)}</p>` : ""}</div>`;
  }
  function tableCrumbs(table, tail) {
    const branch = branchMap.get(table?.branchId);
    const part = branch?.parts.find((p) => p.id === table.partId);
    const items = branch
      ? [
          [branch.title, route("branch", branch.id)],
          [part.title, route("part", part.id)],
        ]
      : [["输入与范围边界", "boundary"]];
    if (table) items.push([titleOf(table.name), route("table", table.name)]);
    if (tail) items.push([tail, ""]);
    crumbs(items);
  }
  function taskSetButton(ids, title, caption, css = "flow-row") {
    const key = memberSet(ids, title, caption);
    return `<button class="${css}" data-set="${key}"><strong>${esc(title)} <span class="number">${fmt(ids.length)}</span></strong><small>${esc(caption)}</small></button>`;
  }
  function memberSet(ids, title, caption = "", kind = "task-set") {
    const key = `set-${widgets.size}`;
    widgets.set(key, { kind, ids: unique(ids), title, caption });
    return key;
  }
  function flowEdge(from, to, ids, title, extra = {}) {
    const members = unique(ids);
    return {
      from,
      to,
      ids: members,
      set: memberSet(
        members,
        title,
        "连线保留的同任务读写关联；不代表逐字段因果或运行接续。",
      ),
      ...extra,
    };
  }
  function collectionNode(id, title, ids, lane, extra = {}) {
    return {
      id,
      title,
      lane,
      meta: `${unique(ids).length} 个相关任务`,
      set: memberSet(ids, title),
      ...extra,
    };
  }
  function overviewBranches() {
    return (
      '<section class="output-map" aria-label="本批产出分支">' +
      DATA.branches
        .map((b) =>
          button(
            '<span class="output-title">' +
              esc(b.title) +
              "</span>" +
              '<span class="output-result">' +
              esc(b.result || b.summary) +
              "</span>" +
              '<span class="output-count"><strong>' +
              b.tables.length +
              "</strong> 张可见产出表</span>" +
              '<span class="output-open">查看加工关系 →</span>',
            route("branch", b.id),
            "output-branch",
            'style="--branch:' + esc(b.color) + '"',
          ),
        )
        .join("") +
      "</section>"
    );
  }
  function inputRows(branch) {
    const sources = branch.inputs.filter(
      (x) => !["temp", "pdata_n"].includes(x.schema),
    );
    return (
      sources
        .map((row) =>
          taskSetButton(
            row.taskIds,
            row.schema,
            `${row.tables.length} 个输入表节点 · 查看相关任务`,
          ),
        )
        .join("") +
      branch.inputBranches
        .map((row) =>
          button(
            `<strong>${esc(branchMap.get(row.schema).title)} <span class="number">${row.tables.length} 表</span></strong><small>本分支 ${row.taskIds.length} 个任务读取这些模型结果</small>`,
            route("branch", row.schema),
            "source-row",
          ),
        )
        .join("") +
      (branch.inputs.some((x) => ["temp", "pdata_n"].includes(x.schema))
        ? button(
            "<strong>共享与待解析输入 ↗</strong><small>生产过程未全部包含在本批</small>",
            route("boundary", branch.id),
            "source-row boundary-link",
          )
        : "")
    );
  }
  function downstreamRows(rows, compact = false) {
    return (
      rows
        .map((row) =>
          taskSetButton(
            row.taskIds,
            row.schema,
            row.boundaryOnly
              ? `${row.fromOutputs.length} 个读取本批输出${row.boundaryOnly.length ? `；${row.boundaryOnly.length} 个只读边界表` : ""}`
              : `${row.tables.length} 个输出表节点 · 查看消费任务`,
          ),
        )
        .join("") +
      (compact
        ? ""
        : '<p class="lane-note">一个任务可读取多个分支、写向多个区域，方向数字不可直接相加。</p>')
    );
  }
  function overview() {
    crumbs([]);
    const c = DATA.counts;
    return (
      heading(
        "03 / 模型与主题",
        "pdata_n 主要加工什么",
        "从主体、合约和业务事件出发，整理身份与关系，维护历史，形成整合主题及按日结果。选择一个分支，沿实际任务看输入怎样变成结果。",
      ) +
      '<p class="overview-standards">模型层职责参照规范；下面是本批的业务阅读分组，分类仍随加工分析校正。' +
      button("规范依据 ↗", "standards", "text-link") +
      "</p>" +
      '<div class="scope-line primary-counts">' +
      button("<strong>" + c.tables + "</strong>表节点", "all-tables") +
      taskSetButton(
        DATA.writerIds,
        "输出关联任务",
        "同一表可由多个任务写入",
        "count-button",
      ) +
      taskSetButton(
        unique(DATA.tables.flatMap((t) => t.readers)),
        "读取任务",
        "包括本区域内部读取",
        "count-button",
      ) +
      "</div>" +
      '<div class="placement-bar">' +
      Object.entries(DATA.placement.counts)
        .filter(([k]) => k !== "explainedWrites")
        .map(([k, n]) => '<span class="chip">定位' + k + " " + n + "</span>")
        .join("") +
      "<span>其中 " +
      DATA.placement.counts.explainedWrites +
      " 个节点有列明写入解释；位置与生产覆盖分开</span></div>" +
      reader.overviewGraph() +
      button(
        "沿销售路线阅读：结果 → 阶段 → 消费",
        "sales-route",
        "primary-reader",
      ) +
      overviewBranches() +
      '<aside class="overview-boundary"><strong>本批范围之外，仍可能有生产过程</strong><p>' +
      c.readOnly +
      " 个只读对象中，" +
      c.directReadOnly +
      " 个直接关联本批输出任务（含内部临时或未解析对象），" +
      c.consumerReadOnly +
      " 个仅作为其他消费任务的并用资料。另有 " +
      c.unlinked +
      " 个无读写关系节点。</p>" +
      button("查看只读对象与边界 ↗", "boundary", "text-link") +
      "</aside>" +
      '<div class="graph-index">' +
      button("全部 " + c.outputs + " 张可见产出表", "outputs") +
      button("区域输入", "incoming") +
      button("实际消费方向", "downstream") +
      button("无读写关系节点", "unlinked") +
      button("3,615 个任务的取数范围", "scope") +
      "</div>"
    );
  }
  function groupedGraph(groups, title, color) {
    // Membership is navigation, not dependency. Table/task views retain exact read/write edges.
    return PdataFlow.render({
      label: title + "成员定位图（无依赖推断）",
      columns: [],
      layout: {
        width: 1040,
        height: Math.max(260, Math.ceil(groups.length / 3) * 115 + 70),
      },
      nodes: groups.map((g, i) => ({
        id: g.id,
        title: g.title,
        lane: 1,
        x: 24 + (i % 3) * 345,
        y: 55 + Math.floor(i / 3) * 115,
        color,
        route: g.route,
        meta: DATA.placement.records[g.id]
          ? "定位：" +
            DATA.placement.records[g.id].status +
            " · " +
            (DATA.placement.records[g.id].explainedWrites.length
              ? "有列明写入解释"
              : "生产写入未展开")
          : g.tables.length + " 个完整成员",
        boundary: DATA.placement.records[g.id]?.status === "暂定",
      })),
      edges: [],
    });
  }
  function objectGraph(object, kind) {
    const isTask = kind === "task";
    const center = {
      id: "center",
      title: isTask ? `任务 ${object.id}` : titleOf(object.name),
      lane: 1,
      meta: isTask
        ? DATA.evidence[object.id]?.note
          ? "已读加工说明 · SQL 在图下方"
          : "加工任务 · 输入与输出分别保留"
        : object.name.split(".").at(-1),
      color: "#8ac8bc",
      route: isTask ? route("task", object.id) : route("table", object.name),
    };
    const nodes = [center],
      edges = [];
    for (const lane of [0, 2]) {
      const members = isTask
        ? lane === 0
          ? object.inputs
          : object.outputs
        : lane === 0
          ? object.writers
          : object.readers;
      const displayed = members.slice(0, 10);
      for (const member of displayed) {
        const item = isTask ? tableMap.get(member) : taskMap.get(member);
        const key = `${lane}:${member}`;
        nodes.push({
          id: key,
          title: isTask
            ? titleOf(member)
            : DATA.evidence[member]?.note?.title ||
              item?.name ||
              `任务 ${member}`,
          lane,
          meta: isTask ? member : `任务 ${member}`,
          route: route(isTask ? "table" : "task", member),
          boundary: isTask && item?.scope === "read-only",
        });
        const from = lane === 0 ? key : "center",
          to = lane === 0 ? "center" : key;
        edges.push(
          flowEdge(
            from,
            to,
            [isTask ? object.id : member],
            isTask
              ? `任务 ${object.id} 的${lane === 0 ? "输入" : "输出"}表`
              : `${object.name} 的${lane === 0 ? "写入" : "读取"}任务`,
            { caption: lane === 0 ? "读取 / 写入关系" : "写入 / 读取关系" },
          ),
        );
      }
      const rest = members.slice(10);
      if (rest.length) {
        const key = `${lane}:other`,
          title = `其余 ${rest.length} 个${isTask ? "表" : "任务"}`;
        nodes.push({
          id: key,
          title,
          lane,
          meta: "点击展开全部其余成员",
          set: memberSet(
            rest,
            title,
            "完整保留其余读写成员。",
            isTask ? "table-set" : "task-set",
          ),
        });
        edges.push(
          flowEdge(
            lane === 0 ? key : "center",
            lane === 0 ? "center" : key,
            isTask ? [object.id] : rest,
            title,
          ),
        );
      }
    }
    return PdataFlow.render({
      nodes,
      edges,
      direct: true,
      label: isTask ? "任务输入输出流程图" : "表的生产与消费流程图",
      columns: isTask
        ? ["01 输入表", "02 加工任务", "03 输出表"]
        : ["01 写入任务", "02 表对象", "03 读取任务"],
    });
  }
  function branchView(id) {
    const branch = branchMap.get(id);
    return branch
      ? categories.render(branch, navigation.view?.reader)
      : notFound();
  }
  function knowledgeSection(branchId) {
    const notes = (DATA.knowledgeNotes ?? []).filter((note) =>
      note.branches.includes(branchId),
    );
    if (!notes.length) return "";
    return `<section class="section knowledge-section">${listTitle("结合已有业务材料理解", "业务概念与本批 SQL 对照阅读")}${notes.map((note) => `<article class="note-row"><h3>${esc(note.title)}</h3><p>${esc(note.text)}</p><p><span class="evidence-label">放回本批加工：</span>${esc(note.connection)}</p><details class="knowledge-source"><summary>出处：${esc(note.sourceTitle)} · ${esc(note.reviewedAt)}</summary><p class="below-note">历史材料状态：${esc(note.maturity)}。用于解释业务概念；不是当前生产实现或运行成功的证明。</p><p class="source-path">${esc(note.source)}</p>${note.excerpts.map((excerpt) => `<p class="excerpt-label">原文第 ${excerpt.start}–${excerpt.end} 行</p><pre>${esc(excerpt.text)}</pre>`).join("")}</details></article>`).join("")}</section>`;
  }
  function noteRow(id) {
    const note = DATA.evidence[id].note;
    return `<article class="note-row"><h3>${esc(note.title)}</h3><p>${esc(note.text)}</p>${button(`读取任务 ${id} 与 SQL ↗`, route("task", id))}</article>`;
  }
  function memberList(kind, ids, title = "") {
    const key = `list-${++widgetId}`;
    widgets.set(key, { kind, ids, title, filter: "", limit: 30 });
    return `<div class="member-list" data-widget="${key}"><div class="list-toolbar"><input type="search" aria-label="筛选${kind === "tasks" ? "任务" : "表成员"}" placeholder="输入名称、表名${kind === "tasks" ? "或任务编号" : ""}" data-filter="${key}"><small data-count="${key}"></small></div><div data-rows="${key}"></div><button class="load-more" data-more="${key}">再显示 30 项</button></div>`;
  }
  function refreshWidget(key) {
    const state = widgets.get(key);
    if (!state || !["tasks", "tables"].includes(state.kind)) return;
    const q = state.filter.toLowerCase();
    const rows = state.ids
      .map((id) =>
        state.kind === "tasks" ? taskMap.get(id) : tableMap.get(id),
      )
      .filter(Boolean)
      .filter((item) =>
        (state.kind === "tasks"
          ? `${item.id} ${item.name} ${item.inputs.join(" ")} ${item.outputs.join(" ")}`
          : `${item.name} ${titleOf(item.name)} ${DATA.placement.records[item.name]?.status ?? ""}`
        )
          .toLowerCase()
          .includes(q),
      );
    document.querySelector(`[data-count="${key}"]`).textContent =
      `匹配 ${fmt(rows.length)} 项 / 共 ${fmt(state.ids.length)} 项`;
    const visible = rows.slice(0, state.limit);
    document.querySelector(`[data-rows="${key}"]`).innerHTML = visible.length
      ? `<div class="table-wrap"><table><thead><tr><th>${state.kind === "tasks" ? "任务及输出" : "对象"}</th><th>${state.kind === "tasks" ? "任务编号" : "写任务"}</th><th>${state.kind === "tasks" ? "材料" : "读任务"}</th></tr></thead><tbody>${visible
          .map((item) =>
            state.kind === "tasks"
              ? `<tr><td>${button(`<span class="member-name">${esc(item.name || `任务 ${item.id}`)}</span>${item.outputs.map((name) => `<code>${esc(name)}</code>`).join("")}`, route("task", item.id), "row-link")}</td><td class="mono">${esc(item.id)}</td><td>${DATA.evidence[item.id]?.note ? '<span class="evidence-label">有加工说明</span>' : DATA.evidence[item.id]?.sql ? "有 SQL 留存" : "表级关系"}</td></tr>`
              : `<tr><td>${button(`<span class="member-name">${esc(titleOf(item.name))}</span><code>${esc(item.name)}</code>`, route("table", item.name), "row-link")}${reader.status(item.name)}${item.scope !== "output" ? `<small>${esc(scopes[item.scope])}</small>` : ""}</td><td>${item.writers.length}</td><td>${item.readers.length}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : '<p class="empty">没有匹配成员。可调整关键词。</p>';
    document.querySelector(`[data-more="${key}"]`).hidden =
      rows.length <= state.limit;
  }
  function partView(id) {
    const branch = DATA.branches.find((b) => b.parts.some((p) => p.id === id));
    const part = branch?.parts.find((p) => p.id === id);
    if (!part) return notFound();
    crumbs([
      [branch.title, route("branch", branch.id)],
      [part.title, ""],
    ]);
    return (
      heading("PDATA / 子分支", part.title, part.description) +
      `<div class="scope-line"><span><strong>${part.tables.length}</strong>输出表</span><span><strong>${part.taskIds.length}</strong>写任务</span></div>` +
      groupedGraph(
        part.tables.map((name) => ({
          id: name,
          title: titleOf(name),
          tables: [name],
          taskIds: tableMap.get(name).writers,
          route: route("table", name),
        })),
        "全部表成员",
        branch.color,
      ) +
      `<details class="reading-details"><summary>完整成员清单与筛选 · ${part.tables.length} 个表</summary>${memberList("tables", part.tables)}</details>` +
      `<p class="below-note">表的多个写入任务可能对应不同来源、产品或批次；进入表后分别查看。</p>`
    );
  }
  function tableView(name) {
    const table = tableMap.get(name);
    if (!table) return notFound();
    tableCrumbs(table);
    const inBatch = table.scope === "output";
    return (
      heading("PDATA / 表对象", titleOf(name), "", "table-title") +
      `<p class="lede mono">${esc(name)}</p>
      <div class="scope-line"><span class="chip ${inBatch ? "" : "boundary"}">${esc(scopes[table.scope])}</span><span><strong>${table.writers.length}</strong>写任务</span><span><strong>${table.readers.length}</strong>读任务</span></div>
      ${reader.result(name)}
      <details class="reading-details"><summary>完整表级读写图（关联索引）</summary>${objectGraph(table, "table")}</details>
      ${!inBatch ? '<p class="section-description">当前页面只能沿本批保留的关系继续阅读。生产者可能在取数范围外，或对象身份尚未解析；不能把未见关系解释为业务不存在。</p>' : '<p class="section-description">先比较各写入任务，再查看下游如何读取。下面的索引表示表级关联，不代表同一日期分区已接续。</p>'}
      <details class="reading-details"><summary>完整写入与读取任务清单</summary>
      <section class="section">${listTitle("怎样形成这个结果", "各写入分支保留为独立任务")}${table.writers.length ? memberList("tasks", table.writers) : '<p class="empty">本批未见写入任务</p>'}</section>
      <section class="section">${listTitle("谁读取这个结果")}${table.readers.length ? memberList("tasks", table.readers) : '<p class="empty">本批未见读取任务；不能据此判断无人使用。</p>'}</section></details>`
    );
  }
  function ioList(names, title) {
    return `<section class="io-group">${listTitle(title, `${names.length} 个表级关联`)}${
      names
        .map((name) => {
          const table = tableMap.get(name);
          return button(
            `<code>${esc(name)}</code><small>${esc(DATA.definitions[name] ?? scopes[table?.scope] ?? "对象身份待核对")}</small>`,
            route("table", name),
            "io-item",
          );
        })
        .join("") || '<p class="lane-note">本批未记录相关表。</p>'
    }</section>`;
  }
  function sqlBlock(sql, ranges = [], excerpt = false) {
    const lines = sql.split(/\r?\n/);
    return `<div class="sql-scroll">${lines
      .map((line, i) => {
        const selected = ranges.some(([a, b]) => i + 1 >= a && i + 1 <= b);
        if (excerpt && !selected) return "";
        return `<div class="sql-line ${selected ? "highlight" : ""}"><span class="line-number">${i + 1}</span><span>${esc(line)}</span></div>`;
      })
      .join("")}</div>`;
  }
  function taskView(id) {
    const task = taskMap.get(id);
    if (!task) return notFound();
    const table = task.outputs
      .map((name) => tableMap.get(name))
      .find((t) => t?.branchId);
    if (table) tableCrumbs(table, `任务 ${id}`);
    else
      crumbs([
        ["任务", ""],
        [id, ""],
      ]);
    const evidence = DATA.evidence[id];
    return (
      heading(
        `加工任务 / ${id}`,
        evidence?.note?.title || task.name || `任务 ${id}`,
        evidence?.note ? task.name : "",
      ) +
      reader.taskIntro(id) +
      (reader.hasStages(id)
        ? `<details class="reading-details"><summary>固定网络表级关联（含临时／未解析引用）</summary>${objectGraph(task, "task")}</details>`
        : objectGraph(task, "task")) +
      (evidence?.note
        ? `<div class="reading-summary"><div><h3>已核 SQL 所表达的变化</h3><p>${esc(evidence.note.text)}</p></div><div><h3>适用范围</h3><p>说明仅适用于本页留存 SQL。真实行唯一性、运行接续与正式业务口径尚未验收。</p></div></div>`
        : DATA.reading.consumers[id] ||
            DATA.processingAnalyses.some((r) => r.taskId === id)
          ? ""
          : '<p class="section-description">此任务保留输入、输出和可用 SQL；尚未编写专属业务解释。</p>') +
      `<details class="reading-details"><summary>完整输入与输出表清单</summary><section class="section"><div class="io-grid">${ioList(task.inputs, "读取什么")}${ioList(task.outputs, "形成什么")}</div></section></details>` +
      `<section class="section">${listTitle("加工证据", "表关系固定于地图快照；SQL 来自本地任务留存")}${
        evidence?.sql
          ? `${evidence.note ? `<details class="sql-disclosure" open><summary>与说明对应的 SQL 选段 · 保留原行号</summary>${sqlBlock(evidence.sql, evidence.note.ranges, true)}</details>` : ""}
        <details class="sql-disclosure"><summary>完整 query SQL · ${evidence.sql.split(/\r?\n/).length} 行</summary>${sqlBlock(evidence.sql, evidence.note?.ranges)}</details>
        ${evidence.ddl ? `<details class="sql-disclosure"><summary>目标定义与字段注释</summary>${sqlBlock(evidence.ddl)}</details>` : '<p class="below-note">本任务未收录目标 DDL。</p>'}
        <details class="sql-disclosure"><summary>来源版本与核对信息</summary><p class="evidence-note">${esc(evidence.basis)}<br>SQL SHA-256：<code>${esc(evidence.sha256)}</code><br>留存文件：<code>${esc(evidence.evidenceFile)}</code></p></details>`
          : '<p class="section-description">本页未收录这项任务的 SQL。当前只展示固定图中的输入输出，不据此推断具体公式。</p>'
      }</section>`
    );
  }
  function boundaryView(branchId) {
    const branch = branchMap.get(branchId);
    const names = branch
      ? unique(branch.taskIds.flatMap((id) => taskMap.get(id).inputs)).filter(
          (name) => tableMap.get(name)?.scope !== "output",
        )
      : DATA.tables.filter((t) => t.scope === "read-only").map((t) => t.name);
    crumbs(
      branch
        ? [
            [branch.title, route("branch", branch.id)],
            ["输入边界", ""],
          ]
        : [["输入与范围边界", ""]],
    );
    return (
      heading(
        "PDATA / 范围边界",
        branch
          ? `${branch.title}的外部与共享输入`
          : "未见生产过程的对象，仍保留在整体中",
        "3,615 个任务来自两组调度闭包的交集。其他来源的生产任务可能没有入选；占位名和临时引用也需要另行核对。",
      ) +
      `<p class="below-note">${branch ? "本页包含区域外来源，以及 pdata_n 中本批未见生产者的输入。" : `本页完整保留区域内 ${DATA.counts.readOnly} 个只读节点；另 ${DATA.counts.unlinked} 个无读写关系节点可从总览单独查看。`}${button("查看取数范围 ↗", "scope", "text-link")}</p>` +
      memberList("tables", names)
    );
  }
  function scopeView() {
    crumbs([["范围与证据", ""]]);
    return (
      heading(
        "PDATA / 阅读边界",
        "这是一份有明确取数范围的加工地图",
        "区域成员来自固定的 3,615 个任务，范围由用户确认。调度闭包交集不保证每张表的数据来源和全部消费者都闭合。",
      ) +
      `<div class="scope-equation"><div><strong>870</strong> 个写入 ODATA_N_TIT 的 2hive 任务<br>→ 调度下游闭包 <strong>11 跳 / 4,316 个任务</strong></div><span class="operator">∩</span><div><strong>992</strong> 个 DM_OTC_N 种子任务<br>→ 双向调度闭包 <strong>12 跳 / 84,147 个任务</strong></div><span class="operator">=</span><div><strong>3,615 个任务</strong> · 当前地图的任务范围</div></div>
      <div class="scope-findings"><article><h2>284 是可见节点，不是全部产出</h2><p>132 个表节点有本批写入者；151 个只被读取；1 个无读写关系。这里也可能包含临时、占位或未解析对象，不能全称为已确认物理表。</p></article><article><h2>212 是任务数，不是表数</h2><p>212 个任务同时读取 odata_n_tit 并写入 pdata_n。一个任务可读多个来源，schema 方向也只是同任务读写关联。</p></article><article><h2>分支覆盖完整，业务解释仍有深浅</h2><p>${DATA.counts.outputs} 个输出节点依定位文档进入 ${DATA.branches.length} 个可重叠路线。${DATA.placement.counts["暂定"]} 个仍暂定；分组成员完整不等于加工语义全部解释。</p></article><article><h2>图关系、SQL 与运行是不同证据</h2><p>图使用固定批次；构建时补入本地 SQL 留存。已读说明绑定原文摘要，其他任务只提供阅读材料；不证明生产当前版本或执行成功。</p></article></div>
      <p class="below-note">图发布：${esc(DATA.publishedAt.slice(0, 10))} · 页面构建：${esc(DATA.builtAt.slice(0, 10))} · ${Object.keys(DATA.evidence).length} / ${DATA.counts.writers} 个写任务有 SQL 材料。</p>
      <details class="sql-disclosure"><summary>固定图版本</summary><p class="evidence-note mono">${esc(DATA.version)}</p></details>`
    );
  }
  function notFound() {
    crumbs([["未找到", ""]]);
    return (
      heading("阅读位置", "当前材料没有这个对象") +
      button("返回 pdata_n", "overview")
    );
  }
  function render() {
    const savedView = navigation.view;
    widgets.clear();
    widgetId = 0;
    pageCrumbs = [];
    const hash = location.hash.slice(1) || "overview";
    const [type, raw = ""] = hash.split("/");
    let id;
    try {
      id = decodeURIComponent(raw);
    } catch {
      id = "";
    }
    let html;
    if (type === "overview") html = overview();
    else if (type === "branch") html = branchView(id);
    else if (type === "part") html = partView(id);
    else if (type === "table") html = tableView(id);
    else if (type === "task") html = taskView(id);
    else if (type === "boundary") html = boundaryView(id);
    else if (type === "scope") html = scopeView();
    else if (type === "sales-route") html = branchView("sales");
    else if (type === "products") html = reader.productsPage();
    else if (type === "stages") html = reader.stagesPage(id);
    else if (type === "stage") html = reader.stagePage(id);
    else if (type === "evidence") html = reader.evidencePage(id);
    else if (type === "source") html = reader.sourcePage(id);
    else if (type === "standards")
      html =
        heading("PDATA / 规范依据", "模型层职责与当前分析边界") +
        DATA.standards
          .map(
            (s) =>
              `<article class="note-row"><h2>${esc(s.title)}</h2><p>${esc(s.use)}</p>${s.excerpts.map((e) => `<p>原文 L${e.start}–${e.end}</p><pre>${esc(e.text)}</pre>`).join("")}</article>`,
          )
          .join("");
    else if (
      ["outputs", "all-tables", "branch-tables", "unlinked"].includes(type)
    ) {
      const branch = branchMap.get(id);
      const title = branch
        ? `${branch.title} · 全部输出`
        : type === "outputs"
          ? `本批 ${DATA.counts.outputs} 个输出表`
          : type === "unlinked"
            ? "本批无读写关系的节点"
            : `区域全部 ${DATA.counts.tables} 个可见节点`;
      crumbs(
        branch
          ? [
              [branch.title, route("branch", id)],
              ["全部输出", ""],
            ]
          : [[title, ""]],
      );
      const names = branch
        ? branch.tables
        : DATA.tables
            .filter(
              (t) =>
                type === "all-tables" ||
                t.scope === (type === "unlinked" ? "unlinked" : "output"),
            )
            .map((t) => t.name);
      html =
        heading(
          "PDATA / 完整成员",
          title,
          "成员与定位状态来自修正版定位表；共享成员保持同一结果身份。位置有依据与生产写入已解释分开显示。",
        ) + memberList("tables", names);
    } else if (type === "incoming") {
      crumbs([["全部区域外输入", ""]]);
      html =
        heading(
          "PDATA / 区域输入",
          "保留全部输入区域，不只展示主要来源",
          "这些任务读取区域外的表引用并写入 pdata_n。temp 等名字也可能表示临时过程，不能全部视作外部业务系统。",
        ) +
        `<div class="section">${DATA.incoming.map((row) => taskSetButton(row.taskIds, row.schema, `${row.tables.length} 个输入表节点 · 查看相关写任务`)).join("")}</div>`;
    } else if (type === "downstream") {
      crumbs([["消费方向", ""]]);
      html =
        heading("PDATA / 区域消费", "区分本批输出与其他共享资料的消费") +
        `<p class="section-description">每个方向单独计算任务数，方向之间可重叠。未见生产者的共享输入同样会形成消费方向。</p><div class="section">${downstreamRows(DATA.downstream)}</div>`;
    } else if (type === "tasks" && history.state?.ids) {
      crumbs([[history.state.title, ""]]);
      html =
        heading(
          "PDATA / 关联任务集合",
          history.state.title,
          history.state.caption,
        ) +
        memberList(
          history.state.kind === "table-set" ? "tables" : "tasks",
          history.state.ids,
        );
    } else html = notFound();
    $("content").innerHTML = html;
    captureGraphs = PdataFlow.mount(
      $("content"),
      savedView?.graphs,
      ".inline-result",
    );
    categories.mount(savedView?.reader);
    for (const item of savedView?.lists ?? []) {
      const state = widgets.get(item.key);
      if (!state || !["tasks", "tables"].includes(state.kind)) continue;
      state.filter = item.filter;
      state.limit = item.limit;
      $("content").querySelector(`[data-filter="${item.key}"]`).value =
        item.filter;
    }
    for (const key of widgets.keys()) refreshWidget(key);
    if (savedView) {
      $("content")
        .querySelectorAll("details")
        .forEach((item, i) => {
          if (i < savedView.details.length) item.open = savedView.details[i];
        });
      $("content")
        .querySelectorAll(".sql-scroll")
        .forEach((item, i) => {
          item.scrollTop = savedView.sql[i]?.top ?? 0;
          item.scrollLeft = savedView.sql[i]?.left ?? 0;
        });
    }
    document.title = `${$("content").querySelector("h1")?.textContent ?? "pdata_n"} · 股衍加工地图`;
    navigation.update(pageCrumbs.at(-1)?.[0] || "pdata_n 总览");
    requestAnimationFrame(() => {
      scrollTo(0, savedView?.scroll ?? 0);
      $("content").querySelector("h1")?.focus({ preventScroll: true });
    });
  }
  document.addEventListener("click", (event) => {
    const target = event.target.closest(
      "[data-route],[data-set],[data-more],[data-reader-anchor]",
    );
    if (!target) return;
    const origin = target.closest(".graph-node,.graph-edge");
    if (origin) {
      origin
        .closest(".flow-graph")
        .querySelectorAll(".graph-origin")
        .forEach((item) => item.classList.remove("graph-origin"));
      origin.classList.add("graph-origin");
    }
    if (categories.handleClick(target)) return;
    if (target.dataset.route) navigate(target.dataset.route);
    else if (target.dataset.set) {
      const item = widgets.get(target.dataset.set);
      navigate("tasks", item);
    } else if (target.dataset.more) {
      const state = widgets.get(target.dataset.more);
      state.limit += 30;
      refreshWidget(target.dataset.more);
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.matches(".category-search")) {
      categories.filter();
      return;
    }
    const key = event.target.dataset.filter;
    if (!key || !widgets.has(key)) return;
    const state = widgets.get(key);
    state.filter = event.target.value;
    state.limit = 30;
    refreshWidget(key);
  });
  navigation.start();
})();
