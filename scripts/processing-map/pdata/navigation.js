/* Browser entries carry the real traversal, independently of object ownership. */
const PdataNavigation = (() => {
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
  const hash = () => location.hash.slice(1) || "overview";
  const key = () =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  function create({ capture, render }) {
    const views = new Map(),
      visits = new Map();
    let active = null;
    history.scrollRestoration = "manual";
    const step = (entry) => ({
      id: entry.nav.id,
      index: entry.nav.index,
      route: entry.nav.route,
      label: entry.nav.label,
    });
    const steps = () => [...active.nav.trail, step(active)];
    const remember = (write = true) => {
      if (!active) return;
      const view = capture();
      views.set(active.nav.id, view);
      active = { ...active, view };
      if (write && history.state?.nav?.id === active.nav.id)
        history.replaceState(active, "");
    };
    const ensure = () => {
      const state = history.state;
      if (state?.pdata && state.nav?.route === hash()) return state;
      const entry = {
        ...(hash() === "tasks" && state?.ids ? state : {}),
        pdata: true,
        nav: {
          id: key(),
          session: key(),
          index: 0,
          route: hash(),
          label: "",
          trail: [],
        },
      };
      history.replaceState(entry, "");
      return entry;
    };
    const sync = () => {
      if (
        active &&
        active.nav.id === history.state?.nav?.id &&
        active.nav.route === hash()
      )
        return;
      remember(false);
      const entry = ensure();
      if (active && active.nav.session !== entry.nav.session) visits.clear();
      active = entry;
      for (const item of steps()) visits.set(item.index, item);
      render();
    };
    const go = (index) => {
      if (
        !Number.isInteger(index) ||
        !visits.has(index) ||
        index === active.nav.index
      )
        return;
      remember();
      history.go(index - active.nav.index);
    };
    const navigate = (target, payload = {}) => {
      if (target === active.nav.route && target !== "tasks") return;
      remember();
      const index = active.nav.index + 1;
      for (const n of visits.keys()) if (n >= index) visits.delete(n);
      const entry = {
        ...payload,
        pdata: true,
        nav: {
          id: key(),
          session: active.nav.session,
          index,
          route: target,
          label: "",
          trail: steps(),
        },
      };
      history.pushState(entry, "", `#${target}`);
      sync();
    };
    const update = (label) => {
      active = { ...active, nav: { ...active.nav, label } };
      visits.set(active.nav.index, step(active));
      history.replaceState(active, "");
      const trail = steps(),
        previous = trail.at(-2);
      const back = document.getElementById("back"),
        forward = document.getElementById("forward");
      back.disabled = !previous;
      back.textContent = previous ? `← 返回 ${previous.label}` : "← 返回";
      back.title = previous
        ? `返回刚才的 ${previous.label}`
        : "这里是本次浏览的入口";
      back.setAttribute(
        "aria-label",
        previous ? `返回 ${previous.label}` : "返回",
      );
      forward.disabled = !visits.has(active.nav.index + 1);
      const crumb = (item, current, numbered = false) =>
        current
          ? `<span class="current-crumb" aria-current="page" title="${esc(item.label)}">${numbered ? `${item.index + 1}. ` : ""}${esc(item.label)}</span>`
          : `<button class="crumb" data-visit="${item.index}" title="返回 ${esc(item.label)}">${numbered ? `${item.index + 1}. ` : ""}${esc(item.label)}</button>`;
      const breadcrumbs = document.getElementById("breadcrumbs");
      breadcrumbs.innerHTML = trail
        .map(
          (item, i) =>
            `${i ? '<span class="sep">›</span>' : ""}${crumb(item, i === trail.length - 1)}`,
        )
        .join("");
      document.getElementById("journey-count").textContent =
        `完整路径 · ${trail.length} 步`;
      document.getElementById("journey-list").innerHTML = trail
        .map(
          (item, i) => `<li>${crumb(item, i === trail.length - 1, true)}</li>`,
        )
        .join("");
      document.getElementById("journey").open = false;
      document.documentElement.style.setProperty(
        "--navigation-height",
        `${document.querySelector(".navigation").offsetHeight}px`,
      );
      requestAnimationFrame(() => {
        breadcrumbs.scrollLeft = breadcrumbs.scrollWidth;
      });
    };
    const start = () => {
      document
        .getElementById("back")
        .addEventListener("click", () => go(active.nav.index - 1));
      document
        .getElementById("forward")
        .addEventListener("click", () => go(active.nav.index + 1));
      document.getElementById("home").addEventListener("click", () => {
        const root = steps().find((item) => item.route === "overview");
        if (root) go(root.index);
        else navigate("overview");
      });
      document
        .querySelector(".navigation")
        .addEventListener("click", (event) => {
          const target = event.target.closest("[data-visit]");
          if (target) go(Number(target.dataset.visit));
        });
      window.addEventListener("popstate", sync);
      window.addEventListener("hashchange", sync);
      window.addEventListener("pagehide", () => remember());
      new ResizeObserver(() =>
        document.documentElement.style.setProperty(
          "--navigation-height",
          `${document.querySelector(".navigation").offsetHeight}px`,
        ),
      ).observe(document.querySelector(".navigation"));
      sync();
    };
    return {
      navigate,
      update,
      start,
      get view() {
        return views.get(active.nav.id) ?? active.view;
      },
    };
  }
  return { create };
})();
