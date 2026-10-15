const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_LIMITS = Object.freeze({
  maxHops: 25,
  maxNodes: 5_000,
  maxEdges: 10_000,
  maxPaths: 10_000,
});

export function traceFieldBundle(bundle, rootField, limits = {}) {
  const selectedLimits = {
    maxHops: positive(limits.maxHops ?? DEFAULT_LIMITS.maxHops),
    maxNodes: positive(limits.maxNodes ?? DEFAULT_LIMITS.maxNodes),
    maxEdges: positive(limits.maxEdges ?? DEFAULT_LIMITS.maxEdges),
    maxPaths: positive(limits.maxPaths ?? DEFAULT_LIMITS.maxPaths),
  };
  const normalizedField = String(rootField ?? "")
    .trim()
    .toLowerCase();
  const startStateId =
    bundle?.selection?.rootStateIds?.[normalizedField] ?? null;
  const nodes = Array.isArray(bundle?.nodes) ? bundle.nodes : [];
  const edges = Array.isArray(bundle?.edges) ? bundle.edges : [];
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  if (!startStateId || !nodeById.has(startStateId)) {
    return {
      status: "not_found",
      startStateId,
      states: [],
      valueEdges: [],
      annotationNodes: [],
      annotationEdges: [],
      exploredPaths: 0,
      truncated: false,
      warnings: ["START_STATE_NOT_FOUND"],
      limits: selectedLimits,
    };
  }

  const incoming = new Map();
  for (const edge of edges) {
    if (edge.edgeType !== "VALUE_FLOW") continue;
    const values = incoming.get(edge.toNodeId) ?? [];
    values.push(edge);
    incoming.set(edge.toNodeId, values);
  }
  for (const values of incoming.values())
    values.sort((left, right) => left.edgeId.localeCompare(right.edgeId));

  const seenNodes = new Set();
  const seenEdges = new Set();
  const frontier = [{ nodeId: startStateId, depth: 0 }];
  const queued = new Set([startStateId]);
  let exploredPaths = 0;
  let truncated = false;
  while (frontier.length > 0) {
    const current = frontier.shift();
    queued.delete(current.nodeId);
    if (seenNodes.has(current.nodeId)) continue;
    if (seenNodes.size >= selectedLimits.maxNodes) {
      truncated = true;
      break;
    }
    seenNodes.add(current.nodeId);
    const parents = incoming.get(current.nodeId) ?? [];
    if (parents.length > 0 && current.depth >= selectedLimits.maxHops) {
      truncated = true;
      continue;
    }
    for (const edge of parents) {
      if (
        exploredPaths >= selectedLimits.maxPaths ||
        seenEdges.size >= selectedLimits.maxEdges
      ) {
        truncated = true;
        break;
      }
      const addsParent =
        !seenNodes.has(edge.fromNodeId) && !queued.has(edge.fromNodeId);
      if (
        addsParent &&
        seenNodes.size + queued.size >= selectedLimits.maxNodes
      ) {
        truncated = true;
        continue;
      }
      exploredPaths += 1;
      seenEdges.add(edge.edgeId);
      if (addsParent) {
        frontier.push({ nodeId: edge.fromNodeId, depth: current.depth + 1 });
        frontier.sort(
          (left, right) =>
            left.depth - right.depth || left.nodeId.localeCompare(right.nodeId),
        );
        queued.add(edge.fromNodeId);
      }
    }
  }

  const valueEdges = edges.filter((edge) => seenEdges.has(edge.edgeId));
  const annotationCandidates = edges
    .filter(
      (edge) =>
        edge.edgeType !== "VALUE_FLOW" &&
        (seenNodes.has(edge.fromNodeId) ||
          seenNodes.has(edge.toNodeId) ||
          (typeof edge.properties?.valueEdgeId === "string" &&
            seenEdges.has(edge.properties.valueEdgeId))),
    )
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const annotationNodeIds = new Set();
  const annotationEdges = [];
  for (const edge of annotationCandidates) {
    if (valueEdges.length + annotationEdges.length >= selectedLimits.maxEdges) {
      truncated = true;
      break;
    }
    const requiredNodeIds = [...new Set([edge.fromNodeId, edge.toNodeId])]
      .sort()
      .filter(
        (nodeId) => !seenNodes.has(nodeId) && !annotationNodeIds.has(nodeId),
      );
    if (
      seenNodes.size + annotationNodeIds.size + requiredNodeIds.length >
      selectedLimits.maxNodes
    ) {
      truncated = true;
      continue;
    }
    annotationEdges.push(edge);
    for (const nodeId of requiredNodeIds) annotationNodeIds.add(nodeId);
  }
  const sourcePartial = bundle?.slice?.coverageStatus !== "COMPLETE";
  return {
    status: sourcePartial || truncated ? "partial" : "ok",
    startStateId,
    states: nodes.filter((node) => seenNodes.has(node.nodeId)),
    valueEdges,
    annotationNodes: nodes.filter((node) => annotationNodeIds.has(node.nodeId)),
    annotationEdges,
    exploredPaths,
    truncated,
    warnings: [
      ...(sourcePartial ? ["SOURCE_OR_SLICE_PARTIAL"] : []),
      ...(truncated ? ["QUERY_LIMIT_REACHED"] : []),
    ],
    limits: selectedLimits,
  };
}

export function summarizeFieldTrace(trace) {
  const groupsByTask = new Map();
  const taskIdByState = new Map();
  const stateById = new Map(trace.states.map((state) => [state.nodeId, state]));

  for (const state of trace.states) {
    const taskId = normalizedTaskId(state);
    const depth = finite(state.properties?.depth);
    taskIdByState.set(state.nodeId, taskId);
    let group = groupsByTask.get(taskId);
    if (!group) {
      group = {
        taskId,
        taskName: optionalText(state.properties?.taskName),
        minDepth: depth,
        maxDepth: depth,
        stateCount: 0,
        internalValueFlowCount: 0,
        target: false,
        fieldsByKey: new Map(),
      };
      groupsByTask.set(taskId, group);
    }
    group.stateCount += 1;
    group.minDepth = Math.min(group.minDepth, depth);
    group.maxDepth = Math.max(group.maxDepth, depth);
    if (!group.taskName)
      group.taskName = optionalText(state.properties?.taskName);
    const field = summarizedField(state);
    if (!group.fieldsByKey.has(field.key))
      group.fieldsByKey.set(field.key, field);
  }

  const targetTaskId = trace.startStateId
    ? (taskIdByState.get(trace.startStateId) ?? null)
    : null;
  if (targetTaskId && groupsByTask.has(targetTaskId))
    groupsByTask.get(targetTaskId).target = true;

  const linksByTaskPair = new Map();
  for (const edge of trace.valueEdges) {
    const fromTaskId = taskIdByState.get(edge.fromNodeId);
    const toTaskId = taskIdByState.get(edge.toNodeId);
    if (!fromTaskId || !toTaskId) continue;
    if (fromTaskId === toTaskId) {
      groupsByTask.get(fromTaskId).internalValueFlowCount += 1;
      continue;
    }
    const key = `${fromTaskId}\u0000${toTaskId}`;
    let link = linksByTaskPair.get(key);
    if (!link) {
      link = {
        fromTaskId,
        toTaskId,
        valueFlowCount: 0,
        transitionLabels: new Set(),
        edgeIds: [],
      };
      linksByTaskPair.set(key, link);
    }
    link.valueFlowCount += 1;
    link.edgeIds.push(edge.edgeId);
    const fromState = stateById.get(edge.fromNodeId);
    const toState = stateById.get(edge.toNodeId);
    link.transitionLabels.add(
      `${stateTitle(fromState)} → ${stateTitle(toState)}`,
    );
  }

  const groups = [...groupsByTask.values()]
    .map((group) => ({
      taskId: group.taskId,
      taskName: group.taskName,
      depth: group.maxDepth,
      minDepth: group.minDepth,
      maxDepth: group.maxDepth,
      stateCount: group.stateCount,
      internalValueFlowCount: group.internalValueFlowCount,
      target: group.target,
      fields: [...group.fieldsByKey.values()].sort((left, right) =>
        left.displayName.localeCompare(right.displayName, "zh-Hans", {
          numeric: true,
        }),
      ),
    }))
    .sort(
      (left, right) =>
        right.depth - left.depth ||
        taskDisplayName(left).localeCompare(taskDisplayName(right), "zh-Hans", {
          numeric: true,
        }),
    );
  const links = [...linksByTaskPair.values()]
    .map((link) => ({
      fromTaskId: link.fromTaskId,
      toTaskId: link.toTaskId,
      valueFlowCount: link.valueFlowCount,
      transitionLabels: [...link.transitionLabels].sort((left, right) =>
        left.localeCompare(right, "zh-Hans", { numeric: true }),
      ),
      edgeIds: [...link.edgeIds].sort(),
    }))
    .sort(
      (left, right) =>
        (groupsByTask.get(right.fromTaskId)?.maxDepth ?? 0) -
          (groupsByTask.get(left.fromTaskId)?.maxDepth ?? 0) ||
        left.fromTaskId.localeCompare(right.fromTaskId, "zh-Hans", {
          numeric: true,
        }) ||
        left.toTaskId.localeCompare(right.toTaskId, "zh-Hans", {
          numeric: true,
        }),
    );
  const incomingTaskIds = new Set(links.map((link) => link.toTaskId));
  const sourceTaskIds = groups
    .filter(
      (group) =>
        !incomingTaskIds.has(group.taskId) && group.taskId !== targetTaskId,
    )
    .map((group) => group.taskId);
  return { targetTaskId, sourceTaskIds, groups, links };
}

export async function initializeFieldDrilldown(root = document) {
  const app = root.querySelector("[data-field-drilldown]");
  if (!app) return;
  const catalogUrl = app.dataset.catalog;
  if (!catalogUrl) throw new Error("FIELD_CATALOG_URL_MISSING");
  const elements = collectElements(root);
  try {
    const catalog = await fetchJson(catalogUrl);
    const bundles = new Map();
    let selectedFieldKey = null;
    let graphMode = "task";
    let currentSelection = null;
    const fields = catalog.tasks.flatMap((task) =>
      task.fields.map((field) => ({ ...field, task })),
    );
    renderTaskOptions(elements.task, catalog.tasks);
    renderCatalogSummary(elements, catalog);

    const renderResults = () => {
      const query = elements.search.value.trim().toLowerCase();
      const taskId = elements.task.value;
      const matches = fields.filter(
        (field) =>
          (taskId === "ALL" || field.task.taskId === taskId) &&
          (!query || searchableField(field).includes(query)),
      );
      elements.resultMeta.textContent = `显示 ${Math.min(matches.length, 200)} / ${matches.length}，共 ${fields.length} 个字段`;
      elements.results.replaceChildren();
      let selectedResult = null;
      for (const field of matches.slice(0, 200)) {
        const selected = fieldSelectionKey(field) === selectedFieldKey;
        const button = htmlElement(
          "button",
          `field-result${selected ? " selected" : ""}`,
        );
        button.type = "button";
        button.setAttribute("aria-pressed", String(selected));
        const strong = htmlElement("strong");
        strong.textContent = field.name;
        const small = htmlElement("small");
        small.textContent = `${field.task.taskLabel} · ${field.task.target.qualifiedName}`;
        button.append(strong, small);
        button.addEventListener("click", () => void selectField(field));
        elements.results.append(button);
        if (selected) selectedResult = button;
      }
      if (matches.length === 0) {
        const empty = htmlElement("div", "empty");
        empty.textContent = "没有匹配字段";
        elements.results.append(empty);
      }
      selectedResult?.scrollIntoView({ block: "center" });
    };

    const selectField = async (field) => {
      setLoading(elements, `${field.task.taskLabel} · ${field.name}`);
      try {
        let bundle = bundles.get(field.task.taskId);
        if (!bundle) {
          bundle = await fetchJson(field.task.bundleFile);
          bundles.set(field.task.taskId, bundle);
        }
        const trace = traceFieldBundle(bundle, field.name);
        const taskFlow = summarizeFieldTrace(trace);
        selectedFieldKey = fieldSelectionKey(field);
        currentSelection = { field, bundle, trace, taskFlow };
        renderSelection(elements, field, bundle, trace, taskFlow);
        renderResults();
        renderSelectedGraph(elements, currentSelection, graphMode);
        const url = new URL(window.location.href);
        url.searchParams.set("task", field.task.taskId);
        url.searchParams.set("field", field.name);
        history.replaceState(null, "", url);
      } catch (error) {
        showError(elements, error);
      }
    };

    elements.taskMode.addEventListener("click", () => {
      graphMode = "task";
      if (currentSelection)
        renderSelectedGraph(elements, currentSelection, graphMode);
    });
    elements.exactMode.addEventListener("click", () => {
      graphMode = "exact";
      if (currentSelection)
        renderSelectedGraph(elements, currentSelection, graphMode);
    });
    elements.search.addEventListener("input", renderResults);
    elements.task.addEventListener("change", renderResults);
    renderResults();
    const requestedTask = new URL(window.location.href).searchParams.get(
      "task",
    );
    const requestedField = new URL(window.location.href).searchParams.get(
      "field",
    );
    if (requestedTask && requestedField) {
      if (
        [...elements.task.options].some(
          (option) => option.value === requestedTask,
        )
      ) {
        elements.task.value = requestedTask;
        renderResults();
      }
      const selected = fields.find(
        (field) =>
          field.task.taskId === requestedTask &&
          field.name.toLowerCase() === requestedField.toLowerCase(),
      );
      if (selected) await selectField(selected);
    }
  } catch (error) {
    showError(elements, error);
  }
}

function collectElements(root) {
  const ids = [
    "fieldSearch",
    "fieldTask",
    "fieldResults",
    "fieldResultMeta",
    "fieldSummary",
    "fieldConclusion",
    "fieldGraph",
    "fieldGraphTitle",
    "fieldTaskMode",
    "fieldExactMode",
    "fieldDetail",
    "fieldAnnotationTitle",
    "fieldAnnotations",
  ];
  const values = Object.fromEntries(
    ids.map((id) => {
      const element = root.getElementById(id);
      if (!element) throw new Error(`FIELD_VIEW_ELEMENT_MISSING:${id}`);
      return [id, element];
    }),
  );
  return {
    search: values.fieldSearch,
    task: values.fieldTask,
    results: values.fieldResults,
    resultMeta: values.fieldResultMeta,
    summary: values.fieldSummary,
    conclusion: values.fieldConclusion,
    graph: values.fieldGraph,
    graphTitle: values.fieldGraphTitle,
    taskMode: values.fieldTaskMode,
    exactMode: values.fieldExactMode,
    detail: values.fieldDetail,
    annotationTitle: values.fieldAnnotationTitle,
    annotations: values.fieldAnnotations,
  };
}

function renderTaskOptions(select, tasks) {
  const all = document.createElement("option");
  all.value = "ALL";
  all.textContent = `全部任务（${tasks.reduce((sum, task) => sum + task.fields.length, 0)}）`;
  select.append(all);
  for (const task of tasks) {
    const option = document.createElement("option");
    option.value = task.taskId;
    option.textContent = `${task.taskLabel}（${task.fields.length}）`;
    select.append(option);
  }
}

function renderCatalogSummary(elements, catalog) {
  elements.summary.replaceChildren(
    summaryCard("目标字段", catalog.totalFields, "全部可检索"),
    summaryCard("根任务", catalog.tasks.length, "独立证据快照"),
    summaryCard(
      "完整快照",
      catalog.tasks.filter((task) => task.sliceCoverage === "COMPLETE").length,
      `其余 ${catalog.tasks.filter((task) => task.sliceCoverage !== "COMPLETE").length} 个保留 PARTIAL`,
    ),
    summaryCard("当前画布", "0", "选择字段后有界加载"),
  );
  elements.conclusion.replaceChildren(
    conclusionContent(
      "先选一个目标字段",
      "默认只展示按任务折叠后的上游链；精确绑定状态和控制证据需要时再展开。",
    ),
  );
}

function summaryCard(label, value, note) {
  const card = htmlElement("div", "summary-card");
  const strong = htmlElement("strong");
  strong.textContent = String(value);
  const span = htmlElement("span");
  span.textContent = `${label} · ${note}`;
  card.append(strong, span);
  return card;
}

function setLoading(elements, label) {
  elements.summary.lastElementChild.querySelector("strong").textContent = "…";
  elements.summary.lastElementChild.querySelector("span").textContent =
    `正在读取 · ${label}`;
  elements.graph.replaceChildren();
  elements.conclusion.replaceChildren(
    conclusionContent("正在读取字段证据…", label),
  );
  elements.detail.replaceChildren(message("正在加载字段证据…"));
  elements.annotations.replaceChildren(message("等待局部查询…"));
}

function renderSelection(elements, field, bundle, trace, taskFlow) {
  const evidenceAnnotations = relevantAnnotations(trace.annotationNodes);
  const upstreamTasks = Math.max(0, taskFlow.groups.length - 1);
  const crossTaskFlows = taskFlow.links.reduce(
    (total, link) => total + link.valueFlowCount,
    0,
  );
  elements.summary.replaceChildren(
    summaryCard(
      "证据范围",
      trace.status === "ok" ? "完整" : "部分",
      trace.status === "ok" ? "局部路径可完整读取" : "未覆盖处不做推断",
    ),
    summaryCard(
      "上游任务",
      upstreamTasks,
      `加目标任务共 ${taskFlow.groups.length} 个`,
    ),
    summaryCard(
      "任务间连接",
      taskFlow.links.length,
      `承载 ${crossTaskFlows} 条确认值流`,
    ),
    summaryCard(
      "精确绑定",
      trace.states.length,
      `${trace.valueEdges.length} 条 VALUE_FLOW · 按需展开`,
    ),
  );
  renderConclusion(elements, field, trace, taskFlow);
  renderAnnotations(elements, trace);
  showFieldDetail(elements.detail, field, bundle, trace);
  elements.annotationTitle.textContent = evidenceAnnotations.length
    ? `证据详情（${annotationCountText(evidenceAnnotations)}）`
    : "证据详情（无附加控制或缺口）";
}

function renderSelectedGraph(elements, selection, mode) {
  const exact = mode === "exact";
  elements.taskMode.classList.toggle("active", !exact);
  elements.taskMode.setAttribute("aria-pressed", String(!exact));
  elements.exactMode.classList.toggle("active", exact);
  elements.exactMode.setAttribute("aria-pressed", String(exact));
  elements.taskMode.textContent = `任务链（${selection.taskFlow.groups.length}）`;
  elements.exactMode.textContent = `精确绑定图（${selection.trace.states.length}）`;
  elements.graphTitle.textContent = exact
    ? "精确绑定证据图"
    : "按任务折叠的上游链";
  if (exact) renderGraph(elements, selection.trace);
  else renderTaskGraph(elements, selection.taskFlow);
}

function renderConclusion(elements, field, trace, taskFlow) {
  const upstreamTasks = Math.max(0, taskFlow.groups.length - 1);
  const sourceCount = taskFlow.sourceTaskIds.length;
  const internalFlows = taskFlow.groups.reduce(
    (total, group) => total + group.internalValueFlowCount,
    0,
  );
  let result;
  if (trace.status === "not_found") {
    result = "没有找到这个目标字段的根状态。";
  } else if (taskFlow.links.length === 0) {
    result = `${field.name} 目前只追到目标任务内部的值转换。`;
  } else {
    result = `${field.name} 的值从 ${sourceCount} 个最上游任务起点出发，共涉及 ${upstreamTasks} 个上游任务，最终汇入 ${field.task.taskId}。`;
  }
  const coverage =
    trace.status === "ok"
      ? "本次局部静态证据完整。"
      : "当前只有部分静态证据；缺口之外不做推断。";
  const folded = `下图已把 ${trace.states.length} 个绑定状态折叠为 ${taskFlow.groups.length} 个任务；${internalFlows} 条任务内部值转换已收进卡片。`;
  elements.conclusion.classList.toggle("warning-box", trace.status !== "ok");
  elements.conclusion.replaceChildren(
    conclusionContent(`正在看：${field.name}`, `${result}${coverage}`, folded),
  );
}

function conclusionContent(titleText, bodyText, noteText = "") {
  const content = htmlElement("div", "conclusion-content");
  const title = htmlElement("strong");
  title.textContent = titleText;
  const body = htmlElement("p");
  body.textContent = bodyText;
  content.append(title, body);
  if (noteText) {
    const note = htmlElement("small");
    note.textContent = noteText;
    content.append(note);
  }
  return content;
}

function renderTaskGraph(elements, taskFlow) {
  const svg = elements.graph;
  svg.replaceChildren();
  if (taskFlow.groups.length === 0) {
    svg.setAttribute("viewBox", "0 0 900 420");
    const label = svgElement("text", { x: 30, y: 55, class: "svg-empty" });
    label.textContent = "没有可展示的任务链";
    svg.append(label);
    return;
  }
  const byDepth = new Map();
  for (const group of taskFlow.groups) {
    const values = byDepth.get(group.depth) ?? [];
    values.push(group);
    byDepth.set(group.depth, values);
  }
  for (const values of byDepth.values())
    values.sort((left, right) =>
      taskDisplayName(left).localeCompare(taskDisplayName(right), "zh-Hans", {
        numeric: true,
      }),
    );
  const depths = [...byDepth.keys()].sort((left, right) => right - left);
  const positions = new Map();
  const nodeWidth = 250;
  const nodeHeight = 108;
  const columnGap = 36;
  const rowGap = 42;
  const maxColumns = Math.max(
    ...[...byDepth.values()].map((values) => values.length),
  );
  const width = Math.max(
    560,
    50 + maxColumns * nodeWidth + (maxColumns - 1) * columnGap,
  );
  const height = Math.max(
    560,
    58 + depths.length * nodeHeight + (depths.length - 1) * rowGap,
  );
  depths.forEach((depth, row) => {
    const values = byDepth.get(depth);
    const rowWidth =
      values.length * nodeWidth + (values.length - 1) * columnGap;
    const rowOffset = (width - rowWidth) / 2;
    values.forEach((group, column) =>
      positions.set(group.taskId, {
        x: rowOffset + column * (nodeWidth + columnGap),
        y: 48 + row * (nodeHeight + rowGap),
        width: nodeWidth,
        height: nodeHeight,
      }),
    );
  });
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", String(height));
  svg.style.minWidth = "0";
  const direction = svgElement("text", {
    x: width / 2,
    y: 24,
    class: "task-direction",
    "text-anchor": "middle",
  });
  direction.textContent =
    "上方更上游  ↓  下方是目标任务（箭头表示确认的跨任务值流）";
  svg.append(direction);
  const defs = svgElement("defs");
  const marker = svgElement("marker", {
    id: "taskArrow",
    markerWidth: 8,
    markerHeight: 8,
    refX: 7,
    refY: 4,
    orient: "auto",
  });
  marker.append(svgElement("path", { d: "M0,0 L8,4 L0,8 z" }));
  defs.append(marker);
  svg.append(defs);
  for (const link of taskFlow.links) {
    const from = positions.get(link.fromTaskId);
    const to = positions.get(link.toTaskId);
    if (!from || !to) continue;
    const path = svgElement("path", {
      d: taskEdgePath(from, to),
      class: "field-edge task-edge",
      "marker-end": "url(#taskArrow)",
      tabindex: 0,
    });
    path.addEventListener("click", () =>
      showTaskLinkDetail(elements.detail, link),
    );
    svg.append(path);
    const label = svgElement("text", {
      x: (from.x + from.width / 2 + to.x + to.width / 2) / 2 + 7,
      y: (from.y + from.height + to.y) / 2,
      class: "task-edge-label",
    });
    label.textContent = `${link.valueFlowCount} 条`;
    svg.append(label);
  }
  for (const group of taskFlow.groups) {
    const position = positions.get(group.taskId);
    const node = svgElement("g", {
      class: `task-node${group.target ? " target" : ""}`,
      transform: `translate(${position.x} ${position.y})`,
      tabindex: 0,
      role: "button",
    });
    const title = svgElement("title");
    title.textContent = taskDisplayName(group);
    const rect = svgElement("rect", {
      width: position.width,
      height: position.height,
      rx: 9,
    });
    const name = svgElement("text", {
      x: 12,
      y: 24,
      class: "task-node-title",
    });
    name.textContent = `${group.target ? "目标任务" : "任务"} ${group.taskId}`;
    const meta = svgElement("text", {
      x: 12,
      y: 44,
      class: "task-node-meta",
    });
    meta.textContent = shorten(group.taskName ?? "未提供任务名称", 38);
    node.append(title, rect, name, meta);
    const fieldLabel = svgElement("text", {
      x: 12,
      y: 70,
      class: "task-field-label",
    });
    fieldLabel.textContent = `字段：${shorten(
      group.fields.map((field) => field.column).join("、") || "—",
      34,
    )}`;
    const counts = svgElement("text", {
      x: 12,
      y: 94,
      class: "task-node-meta",
    });
    counts.textContent = `${group.fields.length} 个字段 · ${group.stateCount} 个绑定状态`;
    node.append(fieldLabel, counts);
    node.addEventListener("click", () =>
      showTaskGroupDetail(elements.detail, group),
    );
    svg.append(node);
  }
}

function renderGraph(elements, trace) {
  const svg = elements.graph;
  svg.replaceChildren();
  svg.style.minWidth = "920px";
  if (trace.status === "not_found" || trace.states.length === 0) {
    svg.setAttribute("viewBox", "0 0 900 420");
    const label = svgElement("text", { x: 30, y: 55, class: "svg-empty" });
    label.textContent = "字段根状态未找到";
    svg.append(label);
    return;
  }
  const byDepth = new Map();
  for (const state of trace.states) {
    const depth = finite(state.properties?.depth);
    const values = byDepth.get(depth) ?? [];
    values.push(state);
    byDepth.set(depth, values);
  }
  for (const values of byDepth.values())
    values.sort((left, right) =>
      stateTitle(left).localeCompare(stateTitle(right), "zh-Hans", {
        numeric: true,
      }),
    );
  const depths = [...byDepth.keys()].sort((left, right) => right - left);
  const positions = new Map();
  const nodeWidth = 230;
  const nodeHeight = 58;
  const columnGap = 64;
  const rowGap = 18;
  const maxRows = Math.max(
    ...[...byDepth.values()].map((values) => values.length),
  );
  const width = Math.max(940, 40 + depths.length * (nodeWidth + columnGap));
  const height = Math.max(560, 50 + maxRows * (nodeHeight + rowGap));
  depths.forEach((depth, column) => {
    const values = byDepth.get(depth);
    values.forEach((state, row) =>
      positions.set(state.nodeId, {
        x: 24 + column * (nodeWidth + columnGap),
        y: 24 + row * (nodeHeight + rowGap),
        width: nodeWidth,
        height: nodeHeight,
      }),
    );
  });
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const defs = svgElement("defs");
  const marker = svgElement("marker", {
    id: "fieldArrow",
    markerWidth: 8,
    markerHeight: 8,
    refX: 7,
    refY: 4,
    orient: "auto",
  });
  marker.append(svgElement("path", { d: "M0,0 L8,4 L0,8 z" }));
  defs.append(marker);
  svg.append(defs);
  for (const edge of trace.valueEdges) {
    const from = positions.get(edge.fromNodeId);
    const to = positions.get(edge.toNodeId);
    if (!from || !to) continue;
    const path = svgElement("path", {
      d: edgePath(from, to),
      class: "field-edge",
      "marker-end": "url(#fieldArrow)",
      tabindex: 0,
    });
    path.addEventListener("click", () =>
      showRecord(elements.detail, edge, "VALUE_FLOW"),
    );
    svg.append(path);
  }
  for (const state of trace.states) {
    const position = positions.get(state.nodeId);
    const group = svgElement("g", {
      class: `field-node${state.nodeId === trace.startStateId ? " selected" : ""}`,
      transform: `translate(${position.x} ${position.y})`,
      tabindex: 0,
      role: "button",
    });
    const rect = svgElement("rect", {
      width: position.width,
      height: position.height,
      rx: 7,
    });
    const title = svgElement("text", {
      x: 10,
      y: 22,
      class: "field-node-title",
    });
    title.textContent = shorten(stateTitle(state), 34);
    const sub = svgElement("text", { x: 10, y: 43, class: "field-node-sub" });
    sub.textContent = shorten(stateSubtitle(state), 38);
    group.append(rect, title, sub);
    group.addEventListener("click", () =>
      showRecord(elements.detail, state, "字段状态"),
    );
    svg.append(group);
  }
}

function renderAnnotations(elements, trace) {
  const evidenceAnnotations = relevantAnnotations(trace.annotationNodes);
  const counts = countBy(evidenceAnnotations.map((node) => node.nodeType));
  elements.annotations.replaceChildren();
  const heading = htmlElement("div", "annotation-summary");
  heading.textContent =
    Object.entries(counts)
      .map(([type, count]) => `${annotationName(type)} ${count}`)
      .join(" · ") || "当前路径没有附加注释";
  elements.annotations.append(heading);
  const order = { GAP: 0, BOUNDARY: 1, CANDIDATE: 2, ROWSET_CONTROL: 3 };
  const nodes = [...evidenceAnnotations].sort(
    (left, right) =>
      (order[left.nodeType] ?? 9) - (order[right.nodeType] ?? 9) ||
      left.nodeId.localeCompare(right.nodeId),
  );
  for (const node of nodes.slice(0, 120)) {
    const button = htmlElement(
      "button",
      `annotation ${annotationClass(node.nodeType)}`,
    );
    button.type = "button";
    const strong = htmlElement("strong");
    strong.textContent = annotationName(node.nodeType);
    const small = htmlElement("small");
    small.textContent = annotationText(node);
    button.append(strong, small);
    button.addEventListener("click", () =>
      showRecord(elements.detail, node, annotationName(node.nodeType)),
    );
    elements.annotations.append(button);
  }
  if (nodes.length > 120) {
    const note = message(
      `仅展示前 120 / ${nodes.length} 条注释；源记录仍保留在字段快照中。`,
    );
    note.classList.add("warning");
    elements.annotations.append(note);
  }
}

function showFieldDetail(container, field, bundle, trace) {
  container.replaceChildren();
  detailHeader(
    container,
    field.name,
    `${field.task.taskLabel} · ${field.task.target.qualifiedName}`,
  );
  detailRow(
    container,
    "公开状态",
    trace.status.toUpperCase(),
    trace.status !== "ok",
  );
  detailRow(
    container,
    "源 / 切片覆盖",
    `${bundle.slice.sourceOverallStatus} / ${bundle.slice.coverageStatus}`,
    bundle.slice.coverageStatus !== "COMPLETE",
  );
  detailRow(container, "目标写入", bundle.selection.writeObservationId);
  detailRow(
    container,
    "局部范围",
    `${trace.states.length} 个字段状态 · ${trace.valueEdges.length} 条 VALUE_FLOW`,
  );
  detailRow(
    container,
    "任务快照缺口",
    `${field.task.counts.gaps} 个${field.task.sliceCoverage === "COMPLETE" ? "" : " · 保留 PARTIAL"}`,
    field.task.counts.gaps > 0 || field.task.sliceCoverage !== "COMPLETE",
  );
  if (trace.warnings.length)
    detailRow(container, "边界", trace.warnings.join(" · "), true);
  detailRow(
    container,
    "说明",
    "静态字段证据；不证明调度运行、数据到达或业务正确性。",
  );
}

function showTaskGroupDetail(container, group) {
  container.replaceChildren();
  detailHeader(
    container,
    group.taskName ?? group.taskId,
    `${group.target ? "目标任务" : "上游任务"} · ${group.taskId}`,
  );
  detailRow(
    container,
    "本次路径涉及字段",
    group.fields.map((field) => field.displayName).join("\n") || "—",
  );
  detailRow(container, "精确绑定状态", `${group.stateCount} 个`);
  detailRow(
    container,
    "任务内部确认值流",
    `${group.internalValueFlowCount} 条（默认已折叠）`,
  );
  detailRow(
    container,
    "上游深度",
    group.minDepth === group.maxDepth
      ? String(group.depth)
      : `${group.minDepth}–${group.maxDepth}`,
  );
}

function showTaskLinkDetail(container, link) {
  container.replaceChildren();
  detailHeader(
    container,
    "跨任务确认值流",
    `${link.fromTaskId} → ${link.toTaskId}`,
  );
  detailRow(container, "VALUE_FLOW", `${link.valueFlowCount} 条`);
  detailRow(container, "字段衔接", link.transitionLabels.join("\n") || "—");
  detailRow(container, "精确边 ID", link.edgeIds.join("\n") || "—");
}

function showRecord(container, record, label) {
  container.replaceChildren();
  detailHeader(container, label, record.nodeId ?? record.edgeId ?? "记录");
  if (record.edgeType) {
    detailRow(container, "关系", `${record.fromNodeId} → ${record.toNodeId}`);
    detailRow(container, "证据引用", record.evidenceRefs?.join("\n") || "—");
  }
  for (const [key, value] of Object.entries(record.properties ?? {}))
    detailRow(container, key, printable(value));
}

function showError(elements, error) {
  const detail = error instanceof Error ? error.message : String(error);
  elements.summary.replaceChildren(summaryCard("加载失败", "!", detail));
  elements.detail.replaceChildren(message(`无法读取字段证据：${detail}`));
}

function searchableField(field) {
  return [
    field.name,
    field.task.taskId,
    field.task.taskLabel,
    field.task.target.qualifiedName,
  ]
    .join(" ")
    .toLowerCase();
}

function fieldSelectionKey(field) {
  return `${field.task.taskId}\u0000${field.name.toLowerCase()}`;
}

function normalizedTaskId(state) {
  return optionalText(state.properties?.taskId) ?? `未知任务@${state.nodeId}`;
}

function optionalText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function summarizedField(state) {
  const field = state.properties?.field ?? {};
  const column = String(field.column ?? "未知字段");
  const qualifiedName = String(field.qualifiedName ?? "未知对象");
  const stableTableId = String(
    field.stableTableId ?? `${field.dataSource ?? "?"}:${qualifiedName}`,
  );
  return {
    key: `${stableTableId}\u0000${column}`,
    column,
    qualifiedName,
    displayName:
      qualifiedName === "未知对象" ? column : `${qualifiedName}.${column}`,
  };
}

function taskDisplayName(group) {
  return group.taskName ? `${group.taskName} (${group.taskId})` : group.taskId;
}

function stateTitle(state) {
  const field = state?.properties?.field ?? {};
  return String(field.column ?? field.qualifiedName ?? state?.nodeId ?? "?");
}

function stateSubtitle(state) {
  const taskName = state.properties?.taskName;
  const taskId = state.properties?.taskId;
  const depth = finite(state.properties?.depth);
  return `${taskName ? `${taskName} · ` : ""}${taskId ?? "?"} · 深度 ${depth}`;
}

function annotationText(node) {
  const properties = node.properties ?? {};
  return shorten(
    String(
      properties.reason ??
        properties.kind ??
        properties.field?.column ??
        properties.expressionText ??
        properties.sourceText ??
        node.nodeId,
    ),
    160,
  );
}

function annotationName(type) {
  return (
    {
      GAP: "缺口",
      BOUNDARY: "边界",
      CANDIDATE: "候选",
      ROWSET_CONTROL: "行集控制",
      READ_OCCURRENCE: "读取发生点",
      WRITE_OBSERVATION: "写入观察",
      EXPRESSION: "表达式",
      PHYSICAL_FIELD: "物理字段",
      TASK_REF: "任务引用",
    }[type] ?? type
  );
}

function annotationCountText(nodes) {
  const counts = countBy(nodes.map((node) => node.nodeType));
  const order = ["GAP", "BOUNDARY", "CANDIDATE", "ROWSET_CONTROL"];
  return order
    .filter((type) => counts[type])
    .map((type) => `${annotationName(type)} ${counts[type]}`)
    .join(" · ");
}

function annotationClass(type) {
  return type === "GAP" || type === "BOUNDARY"
    ? "danger"
    : type === "CANDIDATE"
      ? "caution"
      : "";
}

function relevantAnnotations(nodes) {
  const types = new Set(["ROWSET_CONTROL", "CANDIDATE", "GAP", "BOUNDARY"]);
  return nodes.filter((node) => types.has(node.nodeType));
}

function detailHeader(container, titleText, subtitleText) {
  const title = htmlElement("h2");
  title.textContent = titleText;
  const subtitle = htmlElement("p", "detail-subtitle");
  subtitle.textContent = subtitleText;
  container.append(title, subtitle);
}

function detailRow(container, label, value, warning = false) {
  const row = htmlElement("div", `detail-row${warning ? " warning" : ""}`);
  const strong = htmlElement("strong");
  strong.textContent = label;
  const small = htmlElement("small");
  small.textContent = String(value ?? "—");
  row.append(strong, small);
  container.append(row);
}

function edgePath(from, to) {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const bend = Math.max(36, Math.abs(endX - startX) * 0.42);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

function taskEdgePath(from, to) {
  if (to.x > from.x) return edgePath(from, to);
  const downward = to.y >= from.y;
  const startX = from.x + from.width / 2;
  const startY = downward ? from.y + from.height : from.y;
  const endX = to.x + to.width / 2;
  const endY = downward ? to.y : to.y + to.height;
  const bend = Math.max(38, Math.abs(endY - startY) * 0.42);
  return `M ${startX} ${startY} C ${startX} ${startY + (downward ? bend : -bend)}, ${endX} ${endY + (downward ? -bend : bend)}, ${endX} ${endY}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP_${response.status}:${url}`);
  return response.json();
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positive(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("FIELD_TRACE_LIMIT_INVALID");
  return number;
}

function printable(value) {
  if (value === null || value === undefined) return "—";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  const serialized = JSON.stringify(value);
  return shorten(serialized, 1_500);
}

function shorten(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function htmlElement(tag, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));
  return element;
}

function message(text) {
  const element = htmlElement("div", "empty");
  element.textContent = text;
  return element;
}

if (typeof document !== "undefined")
  void initializeFieldDrilldown().catch((error) => console.error(error));
