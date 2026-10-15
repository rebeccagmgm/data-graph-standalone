/* PDATA → category relationships → one result, with the category retained while reading. */
const PdataCategories = (() => {
  function create({
    reader,
    esc,
    button,
    route,
    heading,
    crumbs,
    titleOf,
    sqlBlock,
  }) {
    const byName = new Map(DATA.allTables.map((t) => [t.name, t]));
    const byTask = new Map(DATA.tasks.map((t) => [t.id, t]));
    let capturePane = () => [],
      selection = null,
      evidenceSelection = null;
    const short = (name) => titleOf(name).split(/[；。]/)[0];
    function connections(b) {
      return (DATA.reading.categories[b.id]?.connections ?? []).map((c) => {
        const task = byTask.get(c.id),
          analysis = DATA.processingAnalyses.find((r) => r.taskId === c.id);
        const inputs =
          c.inputs === "members"
            ? task.inputs.filter((n) => b.tables.includes(n))
            : c.inputs === "explained"
              ? [...new Set(analysis.inputs.map((i) => i.table))].filter((n) =>
                  task.inputs.includes(n),
                )
              : c.inputs;
        return { ...task, selectedInputs: inputs, displayTitle: c.title };
      });
    }
    function relationGraph(b, selected) {
      if (b.id === "sales") return reader.salesGraph();
      if (!selected.length)
        return `<p class="empty">这一类尚未解释出可串联的内部加工。成员仍可逐项查看写入、消费及证据；不按同类名称强行连线。</p>`;
      const nodes = new Map(),
        edges = [];
      const resultNames = new Set(selected.flatMap((t) => t.outputs));
      for (const task of selected) {
        const note = DATA.processingAnalyses.find((r) => r.taskId === task.id);
        nodes.set(`task:${task.id}`, {
          id: `task:${task.id}`,
          title:
            task.displayTitle ??
            note?.title ??
            DATA.reading.consumers[task.id]?.title ??
            DATA.evidence[task.id]?.note?.title ??
            `任务 ${task.id}`,
          meta: `${task.id} · 点击阅读加工与证据`,
          lane: 1,
          route: route("task", task.id),
        });
        for (const [direction, names] of [
          ["read", task.selectedInputs],
          ["write", task.outputs],
        ]) {
          for (const name of names) {
            const placement = DATA.placement.records[name];
            nodes.set(name, {
              id: name,
              title: short(name),
              meta: placement
                ? `定位${placement.status} · ${name.split(".").at(-1)}`
                : name,
              lane: resultNames.has(name) ? 2 : 0,
              route: route("table", name),
              boundary: placement?.status === "暂定",
            });
            edges.push({
              from: direction === "read" ? name : `task:${task.id}`,
              to: direction === "read" ? `task:${task.id}` : name,
              ids: [task.id],
              caption:
                direction === "read"
                  ? (note?.inputs.find((i) => i.table === name)?.reason ??
                    "参与这项加工；具体作用见正文")
                  : "写入关联",
              route: route("task", task.id),
            });
          }
        }
      }
      return PdataFlow.render({
        nodes: [...nodes.values()],
        edges,
        direct: true,
        label: `${b.title}内部关键关系`,
        columns: ["选定基础及共享依赖", "怎样加工 · 点开看逻辑", "形成的结果"],
      });
    }
    function related(name) {
      const t = byName.get(name);
      if (!t) return "";
      const ids = t.writers;
      return `<section class="result-relations"><h3>写入分支与后续消费</h3><p>同表多个写入分开理解；下面每个入口对应一个具体任务。</p>
        <div class="writer-choices">${ids.map((id) => button(`${id} · ${esc(DATA.evidence[id]?.note?.title ?? byTask.get(id)?.name ?? "写入关联")}`, route("task", id))).join("") || "本批未见生产者。"}</div>
        <p>本批读取任务 ${t.readers.length} 个${t.readers.length ? "，其中包括：" : "；不能由此推断业务上无人使用。"}</p>
        <div class="reader-choices">${t.readers
          .filter((id) => DATA.reading.consumers[id] || reader.hasStages(id))
          .map((id) =>
            button(
              `${id} · ${esc(DATA.reading.consumers[id]?.title ?? DATA.evidence[id]?.note?.title)}`,
              route("task", id),
            ),
          )
          .join("")}</div>
        ${t.readers.length ? `<details><summary>完整消费任务索引</summary><div class="task-index">${t.readers.map((id) => button(`${id} · ${esc(byTask.get(id)?.name ?? "读取关联")}`, route("task", id))).join("")}</div></details>` : ""}</section>`;
    }
    function selectionHTML(value) {
      if (value.kind === "products")
        return `<h2>四类产品怎样进入销售基础</h2>${DATA.reading.products.map((p) => `<section class="prose-stage"><h3>${esc(p.title)}</h3><p>${esc(p.detail)}</p>${button(`写入 ${p.id} 与证据`, route("task", p.id))}</section>`).join("")}`;
      if (value.kind === "task") {
        const task = byTask.get(value.id),
          e = DATA.evidence[value.id];
        if (!task) return "";
        const explanation = reader.taskIntro(value.id);
        const placements = task.outputs
          .map((n) => DATA.placement.records[n])
          .filter(Boolean);
        const context = Object.values(DATA.reading.categories)
          .flatMap((g) => g.connections)
          .find((c) => c.id === value.id && c.source);
        return `<p class="eyebrow">具体加工 / ${value.id}</p><h2>${esc(DATA.reading.consumers[value.id]?.title ?? e?.note?.title ?? task.name)}</h2>${explanation || `<p>${esc(e?.note?.text ?? "此任务尚未嵌入连续加工正文。以下复用结果定位说明，具体覆盖以列明写入为准。")}</p>${placements.map((p) => `<p>${esc(p.duty)}<br><small>${esc(p.coverage)}</small></p>`).join("")}`}${context ? button("查看已有分析依据", route("source", context.source)) : ""}
          <div class="reader-actions">${task.outputs.map((name) => button(`结果：${esc(short(name))}`, route("table", name))).join("")}</div>
          <details class="inline-sql"><summary>完整 SQL 与版本</summary>${e?.sql ? sqlBlock(e.sql) : "此任务未收录SQL"}<p>${esc(e?.basis)}</p><code>${esc(e?.evidenceFile)}</code></details>
          <details><summary>固定输入与输出索引（不作两两因果）</summary><h3>读取</h3><div class="task-index">${task.inputs.map((n) => button(esc(n), route("table", n))).join("")}</div><h3>写入</h3><div class="task-index">${task.outputs.map((n) => button(esc(n), route("table", n))).join("")}</div></details>`;
      }
      const t = byName.get(value.id);
      if (!t) return "";
      return `<p class="eyebrow">结果说明</p><h2>${esc(short(value.id))}</h2><p class="source-path"><code>${esc(value.id)}</code></p>${reader.result(value.id)}${related(value.id)}`;
    }
    function render(b, saved) {
      crumbs([[b.title, ""]]);
      const selected = connections(b),
        guide = DATA.reading.categories[b.id];
      selection = saved?.selection ?? {
        kind: "table",
        id:
          b.id === "sales"
            ? DATA.reading.base
            : (selected
                .flatMap((t) => t.outputs)
                .find((n) => b.tables.includes(n)) ?? b.tables[0]),
      };
      evidenceSelection = saved?.evidence ?? null;
      return `<div class="learning-layout" data-category="${b.id}">
        <aside class="learning-outline"><h2>PDATA</h2><nav aria-label="PDATA 类别">${DATA.branches.map((g) => button(`${esc(g.title)} <small>${g.tables.length}</small>`, route("branch", g.id), g.id === b.id ? "current-category" : "")).join("")}</nav><h3>本类完整成员 · ${b.tables.length}</h3><input type="search" class="category-search" aria-label="查找本类结果" placeholder="表名或业务含义" value="${esc(saved?.filter ?? "")}"><div class="category-members">${b.tables.map((n) => `<div class="category-member" data-member="${esc(n)}">${button(`${esc(short(n))}<code>${esc(n.split(".").at(-1))}</code>`, route("table", n))}${reader.status(n)}</div>`).join("")}</div></aside>
        <div class="learning-content"><section id="category-relationships">${heading("PDATA / 类别中的加工关系", b.title, b.summary)}
          <p class="category-intro">${esc(guide?.intro ?? "四类产品写入共同销售基础。管理归属回答归谁、按什么比例分配，按日附加明细回答每个计提日取什么金额；两项加工并行。参数快照、销售收入和创收再按各自范围读取，既有奖励参与收入保底，日计提费用另用于创收。点击图中结果，在下方连续阅读。")}</p>
          ${relationGraph(b, selected)}<section id="relation-evidence">${evidenceSelection?.location === "relation-evidence" ? evidenceHTML(evidenceSelection) : ""}</section></section>
          <div class="inline-reading-toolbar"><strong>结果与加工正文</strong><button data-reader-anchor="category-relationships">回看本类关系 ↑</button></div>
          <section class="inline-result" aria-live="polite">${selectionHTML(selection)}</section><section id="inline-evidence">${evidenceSelection?.location === "inline-evidence" ? evidenceHTML(evidenceSelection) : ""}</section>
        </div></div>`;
    }
    function focus(anchor) {
      const element = document.getElementById(anchor);
      if (!element) return false;
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      )
        if (parent.tagName === "DETAILS") parent.open = true;
      element.scrollIntoView({ block: "start" });
      element.focus?.({ preventScroll: true });
      return true;
    }
    function mount(saved) {
      const pane = document.querySelector(".inline-result");
      capturePane = pane ? PdataFlow.mount(pane, saved?.graphs) : () => [];
      document
        .querySelectorAll(".category-member")
        .forEach((row) =>
          row.classList.toggle(
            "selected-member",
            selection?.kind === "table" && row.dataset.member === selection.id,
          ),
        );
      filter();
    }
    function evidenceHTML(value) {
      const [id, range = ""] = value.id.split(":");
      if (value.kind === "source") {
        const start = Math.max(1, Number(range) || 1),
          text = DATA.sources[id];
        return `<details class="inline-sql" open><summary>分析依据 · ${esc(id)} L${start} 附近</summary>${text ? sqlBlock(text, [[Math.max(1, start - 2), start + 18]], true) : "未收录此材料"}</details>`;
      }
      const [a, b] = range.split("-").map(Number),
        e = DATA.evidence[id];
      return `<details class="inline-sql" open><summary>任务 ${esc(id)} · SQL L${a}–${b}</summary><p>${esc(e?.basis)}</p>${e?.sql ? sqlBlock(e.sql, [[a, b]], true) : "未收录"}</details>`;
    }
    function clearEvidence() {
      evidenceSelection = null;
      for (const id of ["inline-evidence", "relation-evidence"])
        document.getElementById(id).innerHTML = "";
    }
    function handleClick(target) {
      if (target.dataset.readerAnchor)
        return focus(target.dataset.readerAnchor);
      const value = target.dataset.route;
      if (!value) return false;
      const [kind, raw = ""] = value.split("/");
      const id = decodeURIComponent(raw);
      if (kind === "stage") {
        const [task, stage] = id.split(":");
        if (focus(`process-${task}-${stage}`)) return true;
      }
      if (kind === "stages" && focus(`process-${id}`)) return true;
      const pane = document.querySelector(".inline-result");
      if (!pane) return false;
      if (kind === "stages" || kind === "stage") {
        const [task, stage] = id.split(":");
        if (
          !DATA.processingAnalyses.some((r) => r.taskId === task && r.narrative)
        )
          return false;
        selection = { kind: "task", id: task };
        pane.innerHTML = selectionHTML(selection);
        clearEvidence();
        mount();
        focus(stage ? `process-${task}-${stage}` : `process-${task}`);
        return true;
      }
      if (kind === "evidence" || kind === "source") {
        const location = target.closest("#category-relationships")
          ? "relation-evidence"
          : "inline-evidence";
        clearEvidence();
        evidenceSelection = { kind, id, location };
        document.getElementById(location).innerHTML =
          evidenceHTML(evidenceSelection);
        focus(location);
        return true;
      }
      if (
        value === "sales-route" &&
        document.querySelector('[data-category="sales"]')
      )
        return focus("category-relationships");
      if (!["table", "task", "products"].includes(kind)) return false;
      selection = { kind, id };
      pane.innerHTML = selectionHTML(selection);
      clearEvidence();
      mount();
      document
        .querySelectorAll(".category-member")
        .forEach((row) =>
          row.classList.toggle("selected-member", row.dataset.member === id),
        );
      pane.scrollIntoView({ block: "start" });
      return true;
    }
    function filter() {
      const input = document.querySelector(".category-search");
      if (!input) return;
      const q = input.value.trim().toLowerCase();
      document
        .querySelectorAll(".category-member")
        .forEach(
          (row) => (row.hidden = !row.textContent.toLowerCase().includes(q)),
        );
    }
    return {
      render,
      handleClick,
      mount,
      filter,
      capture: () =>
        document.querySelector(".inline-result")
          ? {
              selection,
              evidence: evidenceSelection,
              graphs: capturePane(),
              filter: document.querySelector(".category-search")?.value,
            }
          : null,
    };
  }
  return { create };
})();
