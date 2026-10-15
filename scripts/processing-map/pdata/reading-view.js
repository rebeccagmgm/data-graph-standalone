/* Reading views reuse the existing graph, routes, SQL renderer and history. */
const PdataReading = (() => {
  function create({ button, route, esc, heading, crumbs, sqlBlock }) {
    const R = DATA.reading;
    const records = DATA.placement.records;
    const table = (name) => route("table", name);
    const proof = (id, a, b) => route("evidence", `${id}:${a}-${b}`);
    const source = (at) => route("source", at);
    const analysis = (id) =>
      DATA.processingAnalyses.find(
        (r) => r.taskId === id && r.stages.some((s) => s.id),
      );
    const node = (
      id,
      title,
      target,
      x,
      y,
      meta = "点击进入说明",
      boundary = false,
    ) => {
      const record = target.startsWith("table/")
        ? records[decodeURIComponent(target.slice(6))]
        : null;
      return {
        id,
        title,
        route: target,
        x,
        y,
        lane: 1,
        meta: record ? `定位${record.status} · ${meta}` : meta,
        detail: record ? `${record.meaning}；${record.coverage}` : meta,
        boundary: boundary || (record && record.status !== "已有依据"),
      };
    };
    const edge = (from, to, caption, target, boundary = false) => ({
      from,
      to,
      caption,
      route: target,
      ids: [],
      boundary,
    });
    const graph = (nodes, edges, width, height, label) =>
      PdataFlow.render({
        nodes,
        edges,
        columns: [],
        layout: { width, height },
        label,
      });
    const sourceButton = (at, label = "已有分析与证据 ↗") =>
      button(label, source(at), "text-link");
    const status = (name) =>
      records[name]
        ? `<span class="placement-status ${records[name].status === "已有依据" ? "supported" : "tentative"}">定位：${esc(records[name].status)}</span><small class="coverage-label">${records[name].explainedWrites.length ? `关键写入已解释：${records[name].explainedWrites.join("、")}` : "生产写入未展开"}</small>`
        : "";
    const memberships = (name) =>
      (records[name]?.routes ?? [])
        .map((code) => {
          const b = DATA.branches.find((b) => b.code === code);
          return button(esc(b.title), route("branch", b.id), "chip");
        })
        .join("");
    function markup(text) {
      // Deliberately small, escaped Markdown subset: no arbitrary HTML or URL execution.
      return String(text ?? "")
        .split(/(\[[^\]]+\](?:\[[^\]]+\]|\([^)]*\))|`[^`]+`|§3 Q\d+)/g)
        .map((token) => {
          if (
            token.startsWith("§3 Q") &&
            DATA.placement.questions[token.slice(3)]
          )
            return sourceButton(
              `pdata-output-placement.md:${DATA.placement.questions[token.slice(3)]}`,
              token,
            );
          const m = /^\[([^\]]+)\](?:\[([^\]]+)\]|\(([^)]+)\))$/.exec(token);
          if (m) {
            const ref = m[2],
              path = m[3] ?? DATA.placement.refs[ref];
            if (ref?.startsWith("ev-"))
              return button(
                esc(m[1]),
                route("task", ref.slice(3)),
                "text-link",
              );
            const doc = /([^/]+\.md)(?::(\d+))?/.exec(path ?? "");
            if (doc && DATA.sources[doc[1]])
              return sourceButton(`${doc[1]}:${doc[2] ?? 1}`, m[1]);
            if (ref === "meta")
              return sourceButton(
                "pdata-output-placement.md:1",
                "页面注释／旧分组（M层，仅暂定）",
              );
            return esc(m[1]);
          }
          return token.startsWith("`")
            ? `<code>${esc(token.slice(1, -1))}</code>`
            : esc(token);
        })
        .join("");
    }
    function overviewGraph() {
      const positions = {
        A: [24, 70],
        B: [24, 255],
        C: [24, 440],
        S: [455, 70],
        R: [455, 255],
        L: [455, 440],
        F: [455, 625],
        W: [24, 810],
        P: [24, 625],
      };
      const nodes = DATA.branches.map((b) =>
        node(
          b.code,
          b.title,
          route("branch", b.id),
          ...positions[b.code],
          `${b.tables.length} 个成员 · 可共享归属`,
        ),
      );
      nodes.push(
        node(
          "sale",
          "销售消费：参数／收入／创收",
          "sales-route",
          920,
          70,
          "展开并行消费及适用范围",
        ),
        node(
          "risk",
          "Greeks、盈亏、互换估值",
          "downstream",
          920,
          255,
          "R 的实际消费任务入口",
        ),
        node(
          "fin",
          "财务交割等消费",
          "downstream",
          920,
          625,
          "F 的实际消费任务入口",
        ),
        node(
          "reward",
          "已有奖励汇总",
          table(R.reward),
          920,
          440,
          "范围外生产 · 参与118141保底",
          true,
        ),
      );
      return graph(
        nodes,
        [
          edge("A", "S", "105743 人员机构", proof("105743", 64, 87)),
          edge(
            "B",
            "R",
            "169145 合约及子交易",
            source("pdata-output-placement.md:331"),
          ),
          edge("R", "L", "176877 持仓用于保证金", proof("176877", 64, 115)),
          edge("C", "L", "176877 状态说明", proof("176877", 80, 81)),
          edge("P", "sale", "参数在消费时匹配", "sales-route"),
          edge("S", "sale", "按各自业务范围读取", "sales-route"),
          edge("reward", "sale", "118141 保底输入", proof("118141", 407, 418)),
          edge(
            "R",
            "risk",
            "选定风险消费",
            source("pdata-output-placement.md:337"),
          ),
          edge(
            "F",
            "fin",
            "200199 财务材料消费",
            source("pdata-output-placement.md:338"),
          ),
        ],
        1240,
        940,
        "PDATA整体位置与选定消费",
      );
    }
    function salesGraph() {
      const nodes = [
        node(
          "products",
          "四类产品写入销售基础",
          "products",
          24,
          120,
          "期权／互换／金仕达／极速",
        ),
        node(
          "base",
          "销售合约基础",
          table(R.base),
          380,
          120,
          "Agt_Id、Inr_Seri_No、快照日",
        ),
        node(
          "mgmt",
          "管理归属快照",
          table(R.management),
          745,
          55,
          "105743 · 三组横向归属",
        ),
        node(
          "daily",
          "按日附加明细",
          table(R.daily),
          745,
          325,
          "107491 · 计提日金额",
        ),
        node(
          "params",
          "销售经营参数",
          route("branch", "parameters"),
          745,
          595,
          "基础系数／价差系数",
        ),
        node(
          "para",
          "118143 参数快照",
          route("task", "118143"),
          1160,
          55,
          "与收入并行消费",
        ),
        node(
          "income",
          "118141 销售收入",
          route("task", "118141"),
          1160,
          325,
          "产品筛选、保底、分配、累计",
        ),
        node(
          "rev",
          "230202 创收",
          route("task", "230202"),
          1160,
          795,
          "补充v3；固定v2缺失",
          true,
        ),
        node(
          "fee",
          "期权日计提费用",
          table(R.fee),
          745,
          955,
          "Src_Prd_Id＋Busi_Date",
        ),
        node(
          "reward",
          "已有奖励汇总",
          table(R.reward),
          1160,
          595,
          "本批未见生产 · 保底调整输入",
          true,
        ),
        node(
          "intro",
          "介绍关系／人员机构",
          route("stages", "105743"),
          380,
          470,
          "客户、合约关系分别整理",
        ),
        node(
          "history",
          "历史持仓／事件／费用",
          route("stages", "107491"),
          380,
          795,
          "进入任务内各自整理阶段",
        ),
      ];
      return graph(
        nodes,
        [
          edge("products", "base", "四项写入", "products"),
          edge("base", "mgmt", "105743 逐字段回退", route("stages", "105743")),
          edge("intro", "mgmt", "排序、前三组", route("stages", "105743")),
          edge("base", "daily", "107491 展开日期", route("stages", "107491")),
          edge(
            "history",
            "daily",
            "按键＋计提日接入",
            route("stages", "107491"),
          ),
          edge("base", "para", "118143 适用合约", proof("118143", 124, 130)),
          edge("mgmt", "para", "管理归属", proof("118143", 124, 220)),
          edge("params", "para", "匹配系数", proof("118143", 131, 220)),
          edge("base", "income", "118141 适用合约", proof("118141", 297, 311)),
          edge("mgmt", "income", "分配比例", proof("118141", 297, 403)),
          edge("daily", "income", "逐日金额", proof("118141", 297, 403)),
          edge("params", "income", "按各参数有效期", proof("118141", 297, 403)),
          edge(
            "reward",
            "income",
            "已有奖励参与保底",
            proof("118141", 407, 418),
          ),
          edge("base", "rev", "销售基础 · v3", proof("230202", 156, 179), true),
          edge(
            "daily",
            "rev",
            "按Agt_Id接日明细 · v3",
            proof("230202", 180, 184),
            true,
          ),
          edge(
            "fee",
            "rev",
            "产品号＋业务日 · v3",
            proof("230202", 185, 195),
            true,
          ),
        ],
        1480,
        1070,
        "销售路线：共用基础、并行加工与消费",
      );
    }
    function salesPage() {
      crumbs([
        ["S 销售、归属与按日信息", route("branch", "sales")],
        ["销售阅读路径", ""],
      ]);
      return (
        heading(
          "PDATA / 已读路线",
          "从销售基础走到经营消费",
          "四类产品分别写入共同基础，归属与日明细并行加工；消费者按各自范围取用。",
        ) +
        salesGraph() +
        `<p class="below-note">118143 参数快照与118141收入并行；230202的三项输入由补充v3支持，固定v2缺失。连线点击可查看对应SQL。分成记录与日计提费用等其余S成员仍在完整成员入口。</p>${button("S 完整成员", route("branch-tables", "sales"))}`
      );
    }
    function productsPage() {
      crumbs([
        ["销售阅读路径", "sales-route"],
        ["四类产品写入", ""],
      ]);
      return (
        heading("销售基础 / 来源分支", "四类产品分别形成销售基础") +
        `<div class="reading-cards">${R.products.map((p) => `<article><h2>${esc(p.title)}</h2><p>${esc(p.detail)}</p>${button(`任务 ${p.id} 与SQL`, route("task", p.id))}</article>`).join("")}</div>${button("进入销售基础说明", table(R.base))}${sourceButton("pdata调研v2.md:98")}`
      );
    }
    function localButton(label, anchor, css = "text-link") {
      return `<button class="${css}" data-reader-anchor="${esc(anchor)}">${esc(label)}</button>`;
    }
    function narrative(id) {
      const r = analysis(id);
      if (!r?.narrative) return "";
      const stageById = new Map(r.stages.map((s) => [s.id, s]));
      return `<article class="processing-prose" id="process-${id}" data-process="${id}">
        <header><p class="eyebrow">任务 ${id} · 加工逻辑</p><h2>${esc(r.title)}</h2></header>
        ${r.narrative.intro}
        <nav class="prose-outline" aria-label="本段加工目录">${r.narrative.sections.map((s) => localButton(s.title, `process-${id}-${s.id}`)).join("")}</nav>
        <details class="prose-graph"><summary>对照加工阶段图（点击节点定位到下方正文）</summary>${stageGraph(id)}</details>
        ${r.narrative.sections
          .map((s) => {
            const stage = stageById.get(s.id);
            return `<section class="prose-stage" id="process-${id}-${s.id}" tabindex="-1" data-stage="${s.id}"><h3>${esc(s.title)}</h3>${s.html}<details class="inline-sql"><summary>核对这一段 SQL · ${id} L${stage.lines[0]}–${stage.lines[1]}</summary><p class="below-note">${esc(DATA.evidence[id].basis)}</p>${sqlBlock(DATA.evidence[id].sql, [stage.lines], true)}</details></section>`;
          })
          .join("")}
        <details class="prose-source"><summary>说明来源与 SQL 版本</summary><p>正文维护在 <code>${esc(r.narrativeFile)}</code>，复用第一轮与销售路线说明。适用于本页留存 SQL。</p><p><code>${esc(DATA.evidence[id].evidenceFile)}</code></p><p>SQL SHA-256：<code>${esc(r.sha256)}</code></p></details>
      </article>`;
    }
    function result(name) {
      const r =
        R.results[name] ??
        Object.values(R.consumers).find((r) => r.output === name);
      const placement = records[name];
      let html = r
        ? `<section class="result-explanation"><p class="result-purpose">${esc(r.purpose)}</p><div class="reading-cards"><article><h2>一行代表什么</h2><p>${esc(r.row)}</p></article><article><h2>编号怎样关联</h2><p>${esc(r.identifiers)}</p></article><article><h2>日期怎样理解</h2><p>${esc(r.dates)}</p></article><article><h2>怎样产生、谁继续使用</h2><p>${esc(r.formation)}</p>${(r.tasks ?? []).map((id) => (analysis(id) ? localButton(`阅读 ${id} 完整加工逻辑 ↓`, `process-${id}`) : button(`写入 ${id}`, route("task", id)))).join("")}${r.scope ? `<p><strong>适用范围：</strong>${esc(r.scope)}</p>` : ""}</article></div>${r.example ? `<details class="example"><summary>看一个示意例子（非真实数据）</summary><p>${esc(r.example)}</p></details>` : ""}${button("销售加工与消费图 ↗", "sales-route", "text-link")}</section>`
        : placement
          ? `<p class="result-purpose">${esc(placement.meaning)}</p><p>${esc(placement.duty)}</p>`
          : "";
      if (placement)
        html += `<div class="placement-bar">${status(name)}${memberships(name)}</div>`;
      for (const record of DATA.processingAnalyses.filter(
        (a) => a.output === name,
      ))
        html += record.narrative
          ? narrative(record.taskId)
          : recordProse(record);
      if (name === R.reward)
        html += `<p class="result-purpose">已有奖励汇总被118141读取，参与部分期权保底调整。它属于下游并用资料，本批未见生产者，生产粒度及奖励发放过程未解释。</p>${button("118141 保底读取证据", proof("118141", 407, 418))}${button("回到销售路线", "sales-route")}`;
      if (placement)
        html += `<details class="reading-details placement-evidence"><summary>定位依据、已解释写入与剩余缺口</summary><p><strong>判断依据：</strong>${markup(placement.basis)}</p><p><strong>解释覆盖：</strong>${esc(placement.coverage)}</p><p><strong>主要疑点：</strong>${esc(placement.gaps || "本项未另列影响定位的疑点；不等于唯一性或运行已验证。")}</p>${sourceButton(`pdata-output-placement.md:${placement.line}`, "打开定位原文行及其上下文")}${r?.source ? sourceButton(r.source) : ""}</details>`;
      return html;
    }
    function stageGraph(id) {
      const r = analysis(id);
      if (!r) return "";
      return graph(
        r.stages.map((s) =>
          node(
            s.id,
            s.title,
            route("stage", `${id}:${s.id}`),
            s.x,
            s.y,
            s.output,
          ),
        ),
        r.stages.flatMap((s) =>
          (s.parents ?? []).map((parent) =>
            edge(
              parent,
              s.id,
              s.id === "amount" ? "按各自键＋日期" : "整理后接续",
              route("stage", `${id}:${s.id}`),
            ),
          ),
        ),
        id === "105743" ? 1690 : 1450,
        id === "105743" ? 280 : 960,
        `${id} 内部加工阶段图`,
      );
    }
    function stagesPage(id, selected) {
      const r = analysis(id);
      if (!r) return heading("任务阶段", "本任务尚未展开阶段图");
      crumbs([
        ["销售阅读路径", "sales-route"],
        ["结果说明", table(r.output)],
        [`${id} 阶段图`, route("stages", id)],
        ...(selected ? [[selected.title, ""]] : []),
      ]);
      return (
        heading(
          `内部加工 / ${id}`,
          "完整加工说明",
          "正文按处理顺序展开；图和 SQL 在文中对照，无需逐阶段换页。",
        ) +
        `<div class="reader-actions">${button("返回结果说明", table(r.output))}${button("销售路线位置", "sales-route")}${button("完整任务与输入输出", route("task", id))}</div>` +
        narrative(id)
      );
    }
    function stagePage(value) {
      const [id, key] = value.split(":");
      return stagesPage(
        id,
        analysis(id)?.stages.find((s) => s.id === key),
      );
    }
    function recordProse(r) {
      return `<article class="processing-prose"><h2>${esc(r.taskId)} · ${esc(r.title)}</h2><p>${esc(r.summary)}</p><p><strong>一行：</strong>${esc(r.grain.object)}</p><p><strong>标识与关联：</strong>${esc(r.grain.keys)}</p><p><strong>日期：</strong>${esc(r.grain.time)}</p>${r.stages.map((s) => `<section class="prose-stage"><h3>${esc(s.title)}</h3><p>${esc(s.detail)}</p><details class="inline-sql"><summary>核对本段 SQL · ${r.taskId} L${s.lines.join("–")}</summary>${sqlBlock(DATA.evidence[r.taskId].sql, [s.lines], true)}</details></section>`).join("")}<details class="prose-source"><summary>解释范围与证据版本</summary><p>${esc(r.grain.limitation)}</p><p>本段仅解释 ${esc(r.taskId)} 对本结果的写入。</p><code>${esc(DATA.evidence[r.taskId].evidenceFile)}</code></details></article>`;
    }
    function taskIntro(id) {
      const c = R.consumers[id];
      if (c)
        return (
          result(c.output) +
          `<p class="below-note">${esc(DATA.evidence[id]?.basis)}</p>`
        );
      if (analysis(id)) return narrative(id);
      const notes = DATA.processingAnalyses.filter((r) => r.taskId === id);
      return notes.map((r) => recordProse(r)).join("");
    }
    function evidencePage(value) {
      const [id, span = ""] = value.split(":");
      const [a, b] = span.split("-").map(Number);
      const e = DATA.evidence[id];
      crumbs([
        [`任务 ${id}`, route("task", id)],
        ["SQL证据", ""],
      ]);
      if (!e?.sql) return heading("证据", "此任务未收录SQL");
      return (
        heading(`证据 / ${id}`, `query SQL · L${a}–${b}`, e.basis) +
        `<p>留存文件：<code>${esc(e.evidenceFile)}</code></p><details><summary>SQL SHA-256</summary><code>${esc(e.sha256)}</code></details>${sqlBlock(e.sql, [[a, b]], true)}${button("完整任务与SQL", route("task", id))}`
      );
    }
    function sourcePage(value) {
      const [name, start = "1"] = value.split(":");
      const a = Math.max(1, Number(start) || 1);
      const text = DATA.sources[name];
      crumbs([["已有分析依据", ""]]);
      if (!text) return heading("依据", "未收录此材料");
      return (
        heading(
          "分析依据 / 保留原行号",
          name,
          `原文第 ${a} 行附近；完整材料可展开。`,
        ) +
        sqlBlock(text, [[Math.max(1, a - 2), a + 18]], true) +
        `<details class="reading-details"><summary>完整原文</summary>${sqlBlock(text)}</details>`
      );
    }
    return {
      status,
      memberships,
      result,
      overviewGraph,
      salesGraph,
      salesPage,
      productsPage,
      stagesPage,
      stagePage,
      taskIntro,
      evidencePage,
      sourcePage,
      hasStages: (id) => !!analysis(id),
      title: (name) =>
        R.results[name]?.title ??
        Object.values(R.consumers).find((r) => r.output === name)?.title,
    };
  }
  return { create };
})();
