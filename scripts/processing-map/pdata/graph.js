/* Local SVG presentation only. Relationships and counts are supplied by view.js. */
const PdataFlow = (() => {
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
  function wrap(value, budget = 30, maxLines = 2) {
    const rows = [""];
    let width = 0;
    for (const char of String(value)) {
      const size = char.charCodeAt(0) > 255 ? 2 : 1;
      if (width + size > budget) {
        if (rows.length === maxLines) {
          rows[rows.length - 1] = rows.at(-1).slice(0, -1) + "…";
          break;
        }
        rows.push("");
        width = 0;
      }
      rows[rows.length - 1] += char;
      width += size;
    }
    return rows;
  }
  function action(item) {
    return item.route
      ? `data-route="${esc(item.route)}"`
      : item.set
        ? `data-set="${esc(item.set)}"`
        : "";
  }
  function networkPositions(nodes, edges, height) {
    const ids = new Set(nodes.map((n) => n.id));
    const internal = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const degree = new Map(nodes.map((n) => [n.id, 0]));
    for (const e of internal) {
      degree.set(e.from, degree.get(e.from) + 1);
      degree.set(e.to, degree.get(e.to) + 1);
    }
    const ordered = [...nodes].sort(
      (a, b) => degree.get(b.id) - degree.get(a.id) || a.id.localeCompare(b.id),
    );
    const points = ordered.map((node, i) => {
      const angle =
        ((i - 1) * Math.PI * 2) / Math.max(1, ordered.length - 1) - Math.PI / 2;
      const x =
        ordered.length > 10
          ? 555 + (i % 3) * 340
          : i === 0
            ? 910
            : 910 + 365 * Math.cos(angle);
      const y =
        ordered.length > 10
          ? 145 + Math.floor(i / 3) * 150
          : i === 0
            ? height / 2
            : height / 2 + (height / 2 - 125) * Math.sin(angle);
      return { ...node, x, y, initialX: x, initialY: y, vx: 0, vy: 0 };
    });
    const byId = new Map(points.map((p) => [p.id, p]));
    const constrain = (p) => {
      p.x = Math.max(525, Math.min(1295, p.x));
      p.y = Math.max(115, Math.min(height - 80, p.y));
    };
    const separate = () => {
      for (let i = 0; i < points.length; i++)
        for (let j = i + 1; j < points.length; j++) {
          const a = points[i],
            b = points[j],
            dx = b.x - a.x,
            dy = b.y - a.y;
          const ox = 306 - Math.abs(dx),
            oy = 122 - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          if (ox / 306 < oy / 122) {
            const move = Math.sign(dx || 1) * (ox / 2 + 0.5);
            a.x -= move;
            b.x += move;
          } else {
            const move = Math.sign(dy || 1) * (oy / 2 + 0.5);
            a.y -= move;
            b.y += move;
          }
          constrain(a);
          constrain(b);
        }
    };
    for (let tick = 0; tick < 220; tick++) {
      for (const p of points) {
        p.vx += (p.initialX - p.x) * 0.018;
        p.vy += (p.initialY - p.y) * 0.018;
      }
      for (const e of internal) {
        const a = byId.get(e.from),
          b = byId.get(e.to),
          dx = b.x - a.x,
          dy = b.y - a.y,
          distance = Math.hypot(dx, dy) || 1;
        const force = ((distance - 310) * 0.006) / distance;
        a.vx += dx * force;
        a.vy += dy * force;
        b.vx -= dx * force;
        b.vy -= dy * force;
      }
      for (const p of points) {
        p.vx *= 0.65;
        p.vy *= 0.65;
        p.x += p.vx;
        p.y += p.vy;
        constrain(p);
      }
      separate();
    }
    for (let i = 0; i < 100; i++) separate();
    return points.map((p) => ({ ...p, x: p.x - 135, y: p.y - 39 }));
  }
  function render({
    nodes,
    edges,
    columns,
    label = "加工流程图",
    direct = false,
    network = false,
    layout = null,
  }) {
    const width = layout?.width ?? (network ? 1850 : 1260),
      nodeWidth = 270,
      nodeHeight = 78;
    const lanes = [0, 1, 2].map((lane) => nodes.filter((n) => n.lane === lane));
    const height =
      layout?.height ??
      Math.max(
        network ? 760 : 420,
        Math.max(
          ...lanes
            .filter((_, i) => !network || i !== 1)
            .map((rows) => rows.length),
        ) *
          96 +
          84,
        network ? Math.ceil(lanes[1].length / 3) * 150 + 190 : 0,
      );
    const columnX = network ? [24, 390, 1556] : [24, 495, 966];
    const internalNodes = network
      ? networkPositions(lanes[1], edges, height)
      : [];
    const placed = layout
      ? nodes
      : lanes.flatMap((rows, lane) =>
          network && lane === 1
            ? internalNodes
            : rows.map((n, i) => ({
                ...n,
                x: columnX[lane],
                y: 60 + (height - 84 - rows.length * 96) / 2 + i * 96,
              })),
        );
    const byId = new Map(placed.map((n) => [n.id, n]));
    const paths = edges
      .map((edge, index) => {
        const a = byId.get(edge.from),
          b = byId.get(edge.to);
        if (!a || !b || a.id === b.id) return "";
        const sameLane = !layout && a.lane === b.lane;
        const forward = b.x > a.x;
        const sx = a.x + (sameLane || forward ? nodeWidth : 0),
          sy = a.y + nodeHeight / 2;
        const tx = b.x + (sameLane ? nodeWidth : forward ? 0 : nodeWidth),
          ty = b.y + nodeHeight / 2;
        const bend = sameLane
          ? 65 + (index % 4) * 16
          : Math.abs(tx - sx) * 0.48;
        const c1 = sameLane ? sx + bend : sx + (forward ? bend : -bend);
        const c2 = sameLane ? tx + bend : tx - (forward ? bend : -bend);
        const lx = sameLane ? sx + bend * 0.75 : (sx + tx) / 2;
        const ly = (sy + ty) / 2;
        let path = `M${sx},${sy} C${c1},${sy} ${c2},${ty} ${tx},${ty}`,
          labelX = lx,
          labelY = ly;
        if (network || layout) {
          const ax = a.x + nodeWidth / 2,
            ay = a.y + nodeHeight / 2,
            bx = b.x + nodeWidth / 2,
            by = b.y + nodeHeight / 2;
          const dx = bx - ax,
            dy = by - ay;
          const ratio =
            0.5 / Math.max(Math.abs(dx) / nodeWidth, Math.abs(dy) / nodeHeight);
          const x1 = ax + dx * ratio,
            y1 = ay + dy * ratio,
            x2 = bx - dx * ratio,
            y2 = by - dy * ratio;
          const length = Math.hypot(dx, dy),
            bend = sameLane ? 40 : 12;
          const mx = (x1 + x2) / 2 - (dy / length) * bend,
            my = (y1 + y2) / 2 + (dx / length) * bend;
          path = `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
          labelX = (x1 + 2 * mx + x2) / 4;
          labelY = (y1 + 2 * my + y2) / 4;
        }
        const badge = layout ? edge.caption || "加工" : String(edge.ids.length);
        const badgeWidth = layout
          ? Math.max(70, [...badge].length * 13 + 16)
          : 38;
        const title = `${a.title} → ${b.title} · ${edge.caption || `${edge.ids.length} 个相关任务`}`;
        return `<g class="graph-edge ${sameLane ? "internal-edge" : ""} ${edge.boundary ? "boundary-edge" : ""}" data-from="${esc(a.id)}" data-to="${esc(b.id)}" ${action(edge)} role="button" tabindex="0" aria-label="${esc(title)}"><title>${esc(title)}</title><path class="edge-hit" d="${path}"/><path class="edge-stroke" d="${path}" marker-end="url(#flow-arrow)"/><g class="edge-count" transform="translate(${labelX},${labelY})"><rect x="${-badgeWidth / 2}" y="-12" width="${badgeWidth}" height="24" rx="5"/><text text-anchor="middle" y="5">${esc(badge)}</text></g></g>`;
      })
      .join("");
    return `<section class="flow-graph ${layout ? "reading-graph" : ""} ${network ? "network-graph network-focused" : ""}" aria-label="${esc(label)}"><div class="graph-toolbar"><span><i class="graph-key"></i>${layout ? (edges.length ? "已读加工与消费 · 悬停连线看含义，点击查看依据" : "成员位置索引 · 分组不表示依赖") : network ? "内部关联网络 · 箭头表示读写方向" : direct ? "表与任务的读写关系" : "连线数字：相关任务数 · 同任务读写关联"}<small>悬停看上下游，点击节点展开</small></span><div>${network ? '<button data-graph-action="context">显示来源与去向</button>' : ""}<button data-graph-action="out" aria-label="缩小流程图">−</button><output class="graph-scale"></output><button data-graph-action="in" aria-label="放大流程图">＋</button><button data-graph-action="fit">适配</button><button data-graph-action="fullscreen">全屏</button></div></div><div class="graph-viewport" ${layout ? `style="aspect-ratio:${width}/${height}"` : ""}><svg class="flow-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" data-width="${width}" data-height="${height}" role="group" aria-label="${esc(label)}"><defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#6c9ba8"/></marker></defs><g class="graph-scene">${columns.map((name, i) => `<g data-column="${i}"><text class="graph-column" x="${columnX[i]}" y="29">${esc(name)}</text><line class="graph-column-rule" x1="${columnX[i]}" x2="${columnX[i] + 270}" y1="40" y2="40"/></g>`).join("")}${paths}${placed
      .map((node) => {
        const lines = wrap(node.title, 32);
        return `<g class="graph-node ${node.boundary ? "boundary-node" : ""}" data-node="${esc(node.id)}" data-lane="${node.lane}" ${action(node)} role="button" tabindex="0" aria-label="${esc(`${node.title} · ${node.meta}`)}" style="--node-color:${esc(node.color || "#699cac")}" transform="translate(${node.x},${node.y})"><title>${esc(`${node.title}\n${node.detail || node.meta}`)}</title><rect class="node-box" width="${nodeWidth}" height="${nodeHeight}" rx="5"/><rect class="node-accent" width="3" height="${nodeHeight - 20}" x="0" y="10" rx="1"/>${lines.map((line, i) => `<text class="node-title" x="17" y="${25 + i * 19}">${esc(line)}</text>`).join("")}<text class="node-meta" x="17" y="64">${esc(wrap(node.meta, 42, 1)[0])}</text><text class="node-open" x="246" y="24">↗</text></g>`;
      })
      .join(
        "",
      )}${lanes.map((rows, i) => (layout || rows.length ? "" : `<text class="graph-empty" x="${[24, 495, 966][i]}" y="${height / 2}">${columns[i].includes("写入") ? "本批未见写入任务" : columns[i].includes("读取任务") ? "本批未见读取任务" : "本批未记录相关成员"}</text>`)).join("")}</g></svg></div><div class="graph-foot"><span>${layout ? "仅展示已读说明支持的选定连接；虚线的版本或边界限制见详情。" : direct ? "表与任务之间分别连接读取、写入关系。" : "虚线：同层关联或本批未见生产者的边界；分支顺序不表示执行先后。"}</span><span>拖动画布 · Ctrl + 滚轮缩放</span></div></section>`;
  }
  function mount(root, savedViews = [], exclude = null) {
    const captures = [];
    for (const [index, panel] of [
      ...[...root.querySelectorAll(".flow-graph")].filter(
        (panel) => !exclude || !panel.closest(exclude),
      ),
    ].entries()) {
      const saved = savedViews[index];
      const svg = panel.querySelector("svg"),
        width = Number(svg.dataset.width),
        height = Number(svg.dataset.height);
      const network = panel.classList.contains("network-graph");
      let external = saved?.external ?? false;
      const fitBox = () =>
        network && !external
          ? { x: 360, y: 0, w: 1100, h: height }
          : { x: 0, y: 0, w: width, h: height };
      let box = saved?.box ? { ...saved.box } : fitBox(),
        drag = null,
        suppressClick = false;
      const viewport = panel.querySelector(".graph-viewport");
      const context = panel.querySelector('[data-graph-action="context"]');
      const contextStyle = () => {
        panel.classList.toggle("network-focused", network && !external);
        if (context)
          context.textContent = external ? "只看内部关系" : "显示来源与去向";
      };
      contextStyle();
      viewport.scrollLeft = saved?.left ?? 0;
      viewport.scrollTop = saved?.top ?? 0;
      if (saved?.expanded) {
        panel.classList.add("graph-expanded");
        panel.querySelector('[data-graph-action="fullscreen"]').textContent =
          "退出全屏";
      }
      if (saved?.origin) {
        for (const item of panel.querySelectorAll(".graph-node,.graph-edge")) {
          if (
            saved.origin.node
              ? item.dataset.node === saved.origin.node
              : item.dataset.from === saved.origin.from &&
                item.dataset.to === saved.origin.to
          )
            item.classList.add("graph-origin");
        }
        const note = document.createElement("span");
        note.className = "graph-return-note";
        note.textContent = "已恢复原视图 · 金色标记是刚才的入口";
        panel.querySelector(".graph-foot").prepend(note);
      }
      captures.push(() => {
        const origin = panel.querySelector(".graph-origin");
        return {
          box: { ...box },
          external,
          expanded: panel.classList.contains("graph-expanded"),
          left: viewport.scrollLeft,
          top: viewport.scrollTop,
          origin: origin
            ? {
                node: origin.dataset.node,
                from: origin.dataset.from,
                to: origin.dataset.to,
              }
            : null,
        };
      });
      const draw = () => {
        svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
        panel.querySelector(".graph-scale").textContent =
          `${Math.round((fitBox().w / box.w) * 100)}%`;
      };
      const zoom = (factor) => {
        const next = Math.max(
          fitBox().w / 4,
          Math.min(fitBox().w * 2, box.w * factor),
        );
        const ratio = next / box.w;
        box = {
          x: box.x + (box.w * (1 - ratio)) / 2,
          y: box.y + (box.h * (1 - ratio)) / 2,
          w: next,
          h: box.h * ratio,
        };
        draw();
      };
      panel.addEventListener("click", (event) => {
        const control = event.target.closest("[data-graph-action]");
        if (!control) return;
        const type = control.dataset.graphAction;
        if (type === "fit") {
          box = fitBox();
          draw();
        } else if (type === "context") {
          external = !external;
          contextStyle();
          box = fitBox();
          draw();
        } else if (type === "in" || type === "out")
          zoom(type === "in" ? 0.8 : 1.25);
        else if (type === "fullscreen") {
          panel.classList.toggle("graph-expanded");
          control.textContent = panel.classList.contains("graph-expanded")
            ? "退出全屏"
            : "全屏";
        }
      });
      panel.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          panel.classList.remove("graph-expanded");
          panel.querySelector('[data-graph-action="fullscreen"]').textContent =
            "全屏";
        }
      });
      svg.addEventListener("keydown", (event) => {
        if (
          (event.key === "Enter" || event.key === " ") &&
          event.target.matches(".graph-node,.graph-edge")
        ) {
          event.preventDefault();
          event.target.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          );
        }
      });
      const highlight = (target) => {
        const node = target.closest(".graph-node"),
          edge = target.closest(".graph-edge");
        const active = new Set(
          node
            ? [node.dataset.node]
            : edge
              ? [edge.dataset.from, edge.dataset.to]
              : [],
        );
        const linked = new Set(active);
        for (const line of svg.querySelectorAll(".graph-edge")) {
          const on = node
            ? line.dataset.from === node.dataset.node ||
              line.dataset.to === node.dataset.node
            : line === edge;
          line.classList.toggle("highlighted", on);
          if (on) {
            linked.add(line.dataset.from);
            linked.add(line.dataset.to);
          }
        }
        svg.classList.toggle("has-highlight", active.size > 0);
        for (const item of svg.querySelectorAll(".graph-node"))
          item.classList.toggle("highlighted", linked.has(item.dataset.node));
      };
      svg.addEventListener("pointerover", (event) => {
        if (!drag) highlight(event.target);
      });
      svg.addEventListener("focusin", (event) => highlight(event.target));
      svg.addEventListener("pointerleave", () => highlight(svg));
      svg.addEventListener("focusout", () => highlight(svg));
      svg.addEventListener(
        "wheel",
        (event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          zoom(event.deltaY < 0 ? 0.9 : 1.1);
        },
        { passive: false },
      );
      svg.addEventListener("pointerdown", (event) => {
        if (
          event.button !== 0 ||
          event.target.closest(".graph-node,.graph-edge")
        )
          return;
        drag = { x: event.clientX, y: event.clientY, box: { ...box } };
        suppressClick = false;
        svg.setPointerCapture(event.pointerId);
      });
      svg.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const rect = svg.getBoundingClientRect(),
          scale = Math.min(rect.width / box.w, rect.height / box.h);
        const dx = event.clientX - drag.x,
          dy = event.clientY - drag.y;
        suppressClick = Math.abs(dx) + Math.abs(dy) > 5;
        box = {
          ...drag.box,
          x: drag.box.x - dx / scale,
          y: drag.box.y - dy / scale,
        };
        draw();
      });
      const stop = () => {
        drag = null;
      };
      svg.addEventListener("pointerup", stop);
      svg.addEventListener("pointercancel", stop);
      svg.addEventListener(
        "click",
        (event) => {
          if (suppressClick) {
            event.stopPropagation();
            suppressClick = false;
          }
        },
        true,
      );
      draw();
    }
    return () => captures.map((capture) => capture());
  }
  return { render, mount };
})();
