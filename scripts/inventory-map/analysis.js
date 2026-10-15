const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const format = (value) => Number(value ?? 0).toLocaleString('zh-CN');
const kindNames = { schema: 'Schema', table: '表', view: '视图', task: '任务', field: '字段' };
const kindName = (kind) => kindNames[kind] || '对象';
const objectTypeName = (type, kind) => ({ PHYSICAL_DATASET: '物理对象', hive_table: '表目录记录', hive_view: '视图目录记录', hive_table_definition: '建表定义', hive_view_definition: '视图定义', TABLE: '表', VIEW: '视图' })[type] || kindName(kind);
const MAX_EXPANDED = 12;
const MAX_NODES = 80;
const SVG_NS = 'http://www.w3.org/2000/svg';
const measureContext = document.createElement('canvas').getContext('2d');
measureContext.font = '600 14px "Segoe UI", "Microsoft YaHei", sans-serif';

let current = { mode: 'map', id: null, focus: null, expanded: [], label: '销售基础表案例', tab: 'fields', camera: null };
let graph = null, camera = { x: 0, y: 0, scale: 1 }, pending = 0;
let viewSequence = 0, searchSequence = 0, fieldsSequence = 0, sqlSequence = 0;
let fields = null, sql = { id: null, start: 1, data: null }, activeTab = 'fields';
let searchItems = [], searchNext = null, drag = null, lastDragAt = 0;
let timeline = [], position = -1, localLimit = false;
const session = `analysis-${Date.now()}`;

function textValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('\n');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${textValue(item)}`).join('\n');
  return String(value);
}
function safeAction(action) {
  return (...args) => Promise.resolve().then(() => action(...args)).catch(showError);
}
function showError(error) {
  $('error-banner').textContent = error.message || String(error);
  $('error-banner').hidden = false;
}
function clearError() { $('error-banner').hidden = true; }
function bind(selector, action, root = document) {
  root.querySelectorAll(selector).forEach((element) => element.addEventListener('click', safeAction(() => action(element))));
}
async function api(command, params = {}) {
  pending++;
  $('busy').hidden = false;
  try {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== null && value !== undefined && value !== ''));
    const response = await fetch(`/api/${command}?${query}`);
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.error?.message || '当前证据暂时无法读取，请重试。');
    return body.ok === true ? body.data : body;
  } finally {
    pending--;
    $('busy').hidden = pending === 0;
  }
}

function routeHash(entry) {
  const params = new URLSearchParams();
  if (entry.mode === 'search') {
    for (const key of ['q', 'kind', 'schema']) if (entry[key]) params.set(key, entry[key]);
  } else {
    if (entry.id) params.set('id', entry.id);
    if (entry.focus) params.set('focus', entry.focus);
    if (entry.expanded?.length) params.set('expanded', JSON.stringify(entry.expanded));
  }
  return `#${entry.mode}${params.size ? `?${params}` : ''}`;
}
function parseRoute() {
  const raw = location.hash.slice(1), split = raw.indexOf('?');
  const mode = (split < 0 ? raw : raw.slice(0, split)) === 'search' ? 'search' : 'map';
  const params = new URLSearchParams(split < 0 ? '' : raw.slice(split + 1));
  if (mode === 'search') return { mode, q: params.get('q') || '', kind: params.get('kind') || '', schema: params.get('schema') || '', label: params.get('kind') === 'schema' ? 'Schema 探索' : '对象搜索' };
  let expanded = [];
  try { const parsed = JSON.parse(params.get('expanded') || '[]'); if (Array.isArray(parsed)) expanded = [...new Set(parsed.filter((id) => typeof id === 'string'))].slice(0, MAX_EXPANDED); } catch { /* A malformed optional expansion list starts with the selected root only. */ }
  return { mode, id: params.get('id'), focus: params.get('focus'), expanded, tab: 'fields', label: '加工关系', camera: null };
}
function saveCurrent() {
  if (position < 0) return;
  const saved = { ...current, camera: current.mode === 'map' ? { ...camera } : null, tab: activeTab };
  timeline[position] = saved;
  history.replaceState({ session, position, entry: saved }, '', routeHash(saved));
}
function remember(entry, push) {
  if (push) {
    timeline = timeline.slice(0, position + 1);
    timeline.push({ ...entry });
    position = timeline.length - 1;
    history.pushState({ session, position, entry }, '', routeHash(entry));
  } else {
    if (position < 0) { position = 0; timeline = [{ ...entry }]; }
    else timeline[position] = { ...entry };
    history.replaceState({ session, position, entry }, '', routeHash(entry));
  }
  renderBreadcrumbs();
}
function renderBreadcrumbs() {
  $('back').disabled = position <= 0;
  const first = Math.max(0, position - 4);
  $('breadcrumbs').innerHTML = timeline.slice(first, position + 1).map((entry, index) => `<span>/</span><button data-history="${first + index}" class="${first + index === position ? 'current' : ''}" title="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</button>`).join('');
  bind('[data-history]', (button) => { const delta = Number(button.dataset.history) - position; if (delta) { saveCurrent(); history.go(delta); } }, $('breadcrumbs'));
}
async function navigate(entry, { push = true, restore = false, anchor = null } = {}) {
  if (push) saveCurrent();
  if (entry.id !== current.id) localLimit = false;
  clearError();
  const sequence = ++viewSequence;
  fieldsSequence++;
  sqlSequence++;
  if (entry.mode === 'search') {
    current = { ...entry };
    graph = null;
    $('explorer').hidden = false;
    $('map-workspace').hidden = true;
    const schemas = entry.kind === 'schema';
    $('explorer-title').textContent = schemas ? '选择一个 Schema，进入它的加工关系' : '找到一个任务或表，沿关系继续看';
    $('explorer-description').textContent = schemas ? '区域以已有 Schema 身份组织。点击卡片进入主画布。' : '名称、任务 ID 与 Schema 都可以作为入口。结果只来自已经收录的对象。';
    $('object-search').value = entry.q || '';
    $('kind-filter').value = entry.kind || '';
    $('schema-filter').value = entry.schema || '';
    $('schema-filter-label').hidden = schemas;
    $('route-note').textContent = '选择一个对象，进入连续分析';
    remember(current, push);
    await searchObjects(false);
    return;
  }
  const data = await api('analysis-view', { id: entry.id, focus: entry.focus, expanded: JSON.stringify(entry.expanded || []) });
  if (sequence !== viewSequence) return;
  if (!data.focus || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('当前结果缺少对象或关系信息。');
  if (data.nodes.length > MAX_NODES) throw new Error(`当前结果超过 ${MAX_NODES} 个节点，请缩小场景后再展开。`);
  if (data.nodes.some((node) => ![node.x, node.y, node.width ?? 240, node.height ?? 102].every(Number.isFinite))) throw new Error('当前结果缺少有效的自动布局坐标。');
  graph = data;
  current = { ...entry, id: data.sceneRootId || entry.id || data.nodes.find((node) => node.root)?.id || data.focus.id, focus: data.focus.id, expanded: entry.expanded || [], label: data.focus.label || data.focus.qualifiedName || kindName(data.focus.kind) };
  fields = data.fields || { items: [], total: 0, offset: 0, limit: 40, nextOffset: null };
  sql = { id: null, start: 1, data: null };
  $('explorer').hidden = true;
  $('map-workspace').hidden = false;
  $('route-note').textContent = '点击节点原地展开 · 下方阅读当前对象';
  renderMap();
  if (restore && entry.camera) { camera = { ...entry.camera }; applyCamera(); }
  else if (anchor) preserveAnchor(anchor);
  else fitMap(true);
  renderAnalysis();
  activateTab(restore ? entry.tab || 'fields' : data.focus.kind === 'field' ? 'writers' : 'fields', false);
  current.camera = { ...camera };
  remember(current, push);
}
function nodeCenter(node) { return { x: node.x + (node.width || 240) / 2, y: node.y + (node.height || 102) / 2 }; }
function screenAnchor(id) {
  const node = graph?.nodes.find((item) => item.id === id);
  if (!node) return null;
  const center = nodeCenter(node);
  return { id, x: center.x * camera.scale + camera.x, y: center.y * camera.scale + camera.y, scale: camera.scale };
}
function preserveAnchor(anchor) {
  const node = graph.nodes.find((item) => item.id === anchor.id);
  if (!node) return fitMap(true);
  const center = nodeCenter(node);
  camera = { scale: anchor.scale, x: anchor.x - center.x * anchor.scale, y: anchor.y - center.y * anchor.scale };
  applyCamera();
}
async function focusObject(object) {
  if (!object?.id) return;
  if (object.kind === 'schema') {
    localLimit = false;
    return navigate({ mode: 'map', id: object.id, focus: object.id, expanded: [], label: object.label, camera: null });
  }
  const expanded = [...current.expanded];
  localLimit = false;
  if (!expanded.includes(object.id)) {
    if (expanded.length < MAX_EXPANDED) expanded.push(object.id);
    else localLimit = true;
  }
  return navigate({ ...current, focus: object.id, expanded, camera: null }, { anchor: screenAnchor(object.id) || screenAnchor(current.focus) });
}
async function newCenter(id = current.focus) {
  localLimit = false;
  return navigate({ mode: 'map', id, focus: id, expanded: [], camera: null });
}

function svg(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function interactive(element, label, action) {
  element.setAttribute('role', 'button');
  element.setAttribute('tabindex', '0');
  element.setAttribute('aria-label', label);
  element.addEventListener('click', safeAction((event) => { event.stopPropagation(); if (performance.now() - lastDragAt > 100) return action(); }));
  element.addEventListener('keydown', safeAction((event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); return action(); } }));
}
function labelLines(text, width, count = 2) {
  const chars = [...String(text || '')], lines = [];
  while (chars.length && lines.length < count) {
    let line = '';
    while (chars.length && measureContext.measureText(line + chars[0]).width < width) line += chars.shift();
    if (!line && chars.length) line = chars.shift();
    if (lines.length === count - 1 && chars.length) {
      while (line && measureContext.measureText(`${line}…`).width > width) line = [...line].slice(0, -1).join('');
      line += '…';
    }
    lines.push(line);
  }
  return lines.length ? lines : ['未命名对象'];
}
function edgeCurve(source, target, index) {
  const a = nodeCenter(source), b = nodeCenter(target), aw = source.width || 240, bw = target.width || 240;
  if (source.id === target.id) return `M ${a.x + aw / 2} ${a.y - 16} C ${a.x + aw / 2 + 60} ${a.y - 75}, ${a.x + aw / 2 + 60} ${a.y + 75}, ${a.x + aw / 2} ${a.y + 16}`;
  const forward = b.x >= a.x, start = a.x + (forward ? aw / 2 : -aw / 2), end = b.x + (forward ? -bw / 2 : bw / 2);
  if (Math.abs(a.x - b.x) < 20) {
    const offset = Math.max(50, Math.abs(b.y - a.y) * .25) + (index % 3) * 12;
    return `M ${a.x + aw / 2} ${a.y} C ${a.x + aw / 2 + offset} ${a.y}, ${b.x + bw / 2 + offset} ${b.y}, ${b.x + bw / 2} ${b.y}`;
  }
  const bend = Math.max(40, Math.abs(end - start) * .45), sign = forward ? 1 : -1;
  return `M ${start} ${a.y} C ${start + sign * bend} ${a.y}, ${end - sign * bend} ${b.y}, ${end} ${b.y}`;
}
function renderMap() {
  const focus = graph.focus;
  $('browse-current-schema').hidden = focus.kind !== 'schema';
  $('map-kicker').textContent = `${kindName(focus.kind)} / ${focus.kind === 'schema' ? '区域探索' : '连续加工分析'}`;
  $('map-title').textContent = focus.label || focus.qualifiedName || focus.id;
  $('map-description').textContent = focus.description || (focus.kind === 'schema' ? '点击表或任务，在这张画布中展开相邻关系。' : '点击相邻对象继续展开；场景中的其他关系保持可见。下方随当前对象更新证据。');
  const scene = $('scene');
  scene.replaceChildren();
  const index = new Map(graph.nodes.map((node) => [node.id, node]));
  graph.edges.forEach((edge, at) => {
    const source = index.get(edge.source), target = index.get(edge.target);
    if (!source || !target) return;
    const kind = String(edge.kind || '').toLowerCase();
    const group = svg('g', { class: `edge ${kind.includes('schedule') ? 'schedule' : kind.includes('contain') ? 'containment' : ''}`, 'data-edge-id': edge.id || `${edge.source}-${edge.target}` });
    const d = edgeCurve(source, target, at), path = svg('path', { d, class: 'visible' });
    group.append(path, svg('path', { d, class: 'hit' }));
    scene.append(group);
    if (edge.label) {
      const point = path.getPointAtLength(path.getTotalLength() * .5);
      group.append(svg('text', { x: point.x, y: point.y - 6, 'text-anchor': 'middle' }, edge.label));
    }
    interactive(group, `${source.label} → ${target.label}，${edge.label || edge.kind || '查看关系'}`, () => showEdge(edge, source, target));
  });
  graph.nodes.forEach((node, at) => {
    const width = node.width || 240, height = node.height || 102, kind = kindNames[node.kind] ? node.kind : 'table';
    const group = svg('g', { class: `node kind-${kind} ${node.id === focus.id ? 'focused' : ''}`, transform: `translate(${node.x},${node.y})`, 'data-node-id': node.id });
    group.append(svg('title', {}, [node.label, node.subtitle, node.description].filter(Boolean).join('\n')));
    group.append(svg('rect', { class: 'card', width, height }));
    const clip = svg('clipPath', { id: `node-clip-${at}` });
    clip.append(svg('rect', { x: 13, y: 4, width: width - 26, height: height - 8 }));
    group.append(clip);
    const content = svg('g', { 'clip-path': `url(#node-clip-${at})` });
    content.append(svg('text', { x: 14, y: 20, class: 'node-kind' }, `${kindName(node.kind)}${node.id === focus.id ? ' · 当前分析' : node.root ? ' · 场景起点' : ''}`));
    labelLines(node.label || node.id, width - 30, height >= 98 ? 2 : 1).forEach((line, i) => content.append(svg('text', { x: 14, y: 43 + i * 18, class: 'node-label' }, line)));
    if (node.subtitle) content.append(svg('text', { x: 14, y: height - 15, class: 'node-subtitle' }, labelLines(node.subtitle, width - 50, 1)[0]));
    group.append(content);
    if (node.expandable !== false) {
      group.append(svg('circle', { cx: width - 16, cy: height - 17, r: 8, class: 'expand-glyph' }));
      group.append(svg('text', { x: width - 16, y: height - 12, 'text-anchor': 'middle', class: 'expand-text' }, current.expanded.includes(node.id) ? '·' : '+'));
    }
    interactive(group, `${kindName(node.kind)} ${node.label || node.id}，${node.kind === 'schema' ? '进入区域' : '展开并阅读'}`, () => focusObject(node));
    scene.append(group);
  });
  $('canvas-empty').hidden = graph.nodes.length > 0;
  $('view-size').textContent = `当前场景 ${format(graph.nodes.length)} 个对象 · ${format(graph.edges.length)} 条关系`;
  const reasons = { NODE_LIMIT: '已到节点上限', EDGE_LIMIT: '已到关系上限', EXPANDED_LIMIT: '已到展开对象上限', DEPTH_LIMIT: '已到当前展开层数', MISSING_EVIDENCE: '部分对象缺少加工证据', NEIGHBOR_LIMIT: '已到相邻对象展示上限', SCHEMA_PAGE: '当前仅显示本页区域对象', INPUT_IDENTITY_UNRESOLVED: '部分输入的物理身份尚未确认' };
  const stopped = (graph.stoppedBy || []).map((reason) => reasons[reason] || reason);
  const limited = graph.truncated || localLimit;
  $('map-boundary').classList.toggle('limited', Boolean(limited));
  $('map-boundary').textContent = limited ? `当前保留有界结果${stopped.length ? `：${stopped.join('；')}` : ''}。${localLimit ? `本场景已展开 ${MAX_EXPANDED} 个对象。` : ''}需要继续时，可选“以此为中心”开启新场景。` : '实线按已有加工证据连接；虚线调度依赖仅表示执行配置关系。点击节点继续展开，拖动画布保留上下文。';
}
function applyCamera() {
  $('scene').setAttribute('transform', `translate(${camera.x},${camera.y}) scale(${camera.scale})`);
  $('zoom-value').value = `${Math.round(camera.scale * 100)}%`;
}
function fitMap(readable = false) {
  if (!graph?.nodes.length || $('map-workspace').hidden) return;
  const box = $('scene').getBBox(), area = $('canvas').getBoundingClientRect();
  if (!box.width || !area.width) return;
  const scale = Math.min(1.15, (area.width - 60) / (box.width + 16), (area.height - 85) / (box.height + 16));
  camera.scale = Math.max(readable ? (area.width < 600 ? .7 : .82) : .15, scale);
  camera.x = (area.width - box.width * camera.scale) / 2 - box.x * camera.scale;
  camera.y = (area.height - 45 - box.height * camera.scale) / 2 - box.y * camera.scale;
  if (readable && scale < camera.scale) locateFocus(false);
  else applyCamera();
}
function locateFocus(save = true) {
  const node = graph?.nodes.find((item) => item.id === current.focus) || graph?.nodes.find((item) => item.root);
  if (!node) return;
  const center = nodeCenter(node), rect = $('canvas').getBoundingClientRect();
  camera.x = rect.width / 2 - center.x * camera.scale;
  camera.y = (rect.height - 35) / 2 - center.y * camera.scale;
  applyCamera();
  if (save) saveCurrent();
}
function zoom(factor) {
  const area = $('canvas').getBoundingClientRect(), next = Math.min(2.5, Math.max(.15, camera.scale * factor)), ratio = next / camera.scale;
  camera = { x: area.width / 2 - (area.width / 2 - camera.x) * ratio, y: area.height / 2 - (area.height / 2 - camera.y) * ratio, scale: next };
  applyCamera();
}
function showEdge(edge, source, target) {
  const isSchedule = String(edge.kind || '').toLowerCase().includes('schedule');
  $('edge-insight').hidden = false;
  $('edge-insight').innerHTML = `<p class="eyebrow">当前关系 · ${escapeHtml(edge.label || edge.kind || '已收录关系')}</p><h3>${escapeHtml(source.label)} → ${escapeHtml(target.label)}</h3>${isSchedule ? '<p>这条边是调度依赖，不能直接解释为 SQL 字段值来源。</p>' : ''}<div class="action-row"><button data-edge-object="${escapeHtml(source.id)}">阅读来源对象</button><button data-edge-object="${escapeHtml(target.id)}">阅读目标对象</button><button id="dismiss-edge" class="quiet">收起关系说明</button></div>`;
  bind('[data-edge-object]', (button) => focusObject(graph.nodes.find((node) => node.id === button.dataset.edgeObject)), $('edge-insight'));
  $('dismiss-edge').onclick = () => { $('edge-insight').hidden = true; };
  $('analysis').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function emptyState(title, text) { return `<div class="empty-state"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`; }
function renderAnalysis() {
  const focus = graph.focus;
  $('analysis-kicker').textContent = '当前对象 / 加工与证据';
  $('analysis-title').textContent = focus.label || focus.id;
  $('analysis-qualified').textContent = focus.qualifiedName || (focus.kind === 'task' ? focus.id : focus.schemaName || '');
  $('analysis-description').textContent = focus.description || '此对象暂未收录业务说明，以下只展示已有结构与证据。';
  $('focus-kind').textContent = objectTypeName(focus.objectType, focus.kind);
  $('edge-insight').hidden = true;
  $('observations').innerHTML = (graph.observations || []).map((item) => `<article class="observation"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.text)}</p>${item.basis ? `<p class="basis">依据：${escapeHtml(textValue(item.basis))}</p>` : ''}</article>`).join('');
  $('observations').hidden = !(graph.observations || []).length;
  const questions = graph.questions || [];
  $('questions').hidden = !questions.length;
  $('questions').innerHTML = '<span>继续阅读</span>' + questions.map((item) => `<button data-question="${escapeHtml(item.id)}">${escapeHtml(item.label)} ↗</button>`).join('');
  bind('[data-question]', (button) => {
    const id = button.dataset.question;
    const object = graph.nodes.find((node) => node.id === id);
    if (object) return focusObject(object);
    if (id.startsWith('field:') || id.startsWith('task:')) return focusObject({ id, kind: id.startsWith('field:') ? 'field' : 'task' });
    return newCenter(id);
  }, $('questions'));
  $('fields-count').textContent = fields.total ? format(fields.total) : '';
  $('writers-count').textContent = graph.writers?.length ? format(graph.writers.length) : '';
  $('coverage-text').textContent = graph.coverage?.text || '仅使用本机已有证据。';
  $('version-text').textContent = graph.coverage?.version ? `证据版本 ${graph.coverage.version}` : '';
  renderFields();
  renderWriters();
  renderKnowledge();
  renderSql();
}
function pagination(data, prefix) {
  const count = data.items?.length || 0;
  return `<div class="pagination"><span>${count ? format((data.offset || 0) + 1) : '0'}–${format((data.offset || 0) + count)} / ${format(data.total)} 个字段</span><div><button id="${prefix}-prev" ${(data.offset || 0) === 0 ? 'disabled' : ''}>上一页</button><button id="${prefix}-next" ${data.nextOffset == null ? 'disabled' : ''}>下一页</button></div></div>`;
}
function renderFields() {
  const items = fields.items || [];
  const definitions = renderDefinitionCandidates();
  if (graph.focus.kind === 'schema') {
    $('panel-fields').innerHTML = `<div class="empty-state"><h3>从具体表或任务进入加工分析</h3><p>当前画布展示 ${format(graph.members?.items?.length || 0)} 个区域对象。${graph.members?.total ? `目录中共有 ${format(graph.members.total)} 个匹配对象，可继续分页浏览。` : ''}</p><button id="browse-schema-members" class="primary">继续浏览此 Schema ↗</button></div>`;
    $('browse-schema-members').onclick = safeAction(browseCurrentSchema);
    return;
  }
  if (!items.length) {
    const reason = graph.focus.kind === 'task' ? '可以查看写入分支、表达式与 SQL。任务身份本身不等于一张表的字段结构。' : graph.focus.id.startsWith('catalog:hive-core:') ? '此原信息仅收录对象清单，没有提供列结构。下方如有同名定义候选，也不能补作此实例已确认的字段。' : fields.reason || '已有材料未提供字段结构。可以继续沿画布读取相邻任务或查看其他证据。';
    $('panel-fields').innerHTML = emptyState('当前对象没有可展示的字段清单', reason) + definitions;
    bindDefinitionActions();
    return;
  }
  $('panel-fields').innerHTML = `<div class="table-scroll"><table class="field-table"><thead><tr><th>序号</th><th>字段</th><th>类型</th><th>已有注释 / 口径</th></tr></thead><tbody>${items.map((field, index) => `<tr><td class="field-ordinal">${escapeHtml(field.ordinal ?? (fields.offset || 0) + index + 1)}</td><td class="field-name">${field.id ? `<button class="field-link" data-field="${escapeHtml(field.id)}" title="展开字段加工与写入表达式">${escapeHtml(field.name)} ↗</button>` : escapeHtml(field.name)}</td><td class="field-type">${escapeHtml(field.type || '未记录')}</td><td>${escapeHtml(field.comment || '未收录注释')}</td></tr>`).join('')}</tbody></table></div>${pagination(fields, 'fields')}${definitions}`;
  bind('[data-field]', (button) => focusObject({ id: button.dataset.field, kind: 'field', label: button.textContent }), $('panel-fields'));
  $('fields-prev').onclick = safeAction(() => loadFields(Math.max(0, (fields.offset || 0) - (fields.limit || 40))));
  $('fields-next').onclick = safeAction(() => loadFields(fields.nextOffset));
  bindDefinitionActions();
}
function bindDefinitionActions() {
  bind('[data-definition-sql]', (button) => openSql(button.dataset.definitionSql, 1), $('panel-fields'));
}
function renderDefinitionCandidates() {
  const candidates = graph.definitionCandidates || [];
  if (!candidates.length) return '';
  return `<details class="definition-candidates"><summary>已有定义记录与候选 · ${format(candidates.length)} 份</summary><p class="definition-boundary">同名定义候选只用于对照，不能据此认定为同一物理实例。只有 CATALOG_IDENTITY 对应当前目录记录自身的定义。</p>${candidates.map((candidate) => `<article class="definition-record"><h3>${escapeHtml(candidate.description || candidate.objectType || '定义记录')}</h3><p class="definition-match">${candidate.match === 'CATALOG_IDENTITY' ? '目录身份对应 · 当前记录自身定义' : '同名候选 · 非同实例认定'} <code>${escapeHtml(candidate.match)}</code> · ${escapeHtml(candidate.parseStatus)}</p>${candidate.fields?.length ? `<div class="table-scroll"><table class="field-table"><thead><tr><th>定义中的字段</th><th>类型</th><th>定义注释</th></tr></thead><tbody>${candidate.fields.map((field) => `<tr><td class="field-name">${escapeHtml(field.name)}${field.partition ? ' · 分区字段' : ''}</td><td class="field-type">${escapeHtml(field.type || '未记录')}</td><td>${escapeHtml(field.comment || '未收录注释')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">这份定义没有可展示的字段。</p>'}<div class="action-row definition-actions"><button data-definition-sql="${escapeHtml(candidate.id)}" class="primary">读取完整定义 ↗</button>${candidate.totalLines ? `<span class="muted">定义共 ${format(candidate.totalLines)} 行</span>` : ""}</div>${candidate.sqlPreview ? `<details class="definition-preview"><summary>定义 SQL 预览${candidate.previewTruncated ? "（已截断）" : ""}</summary><pre>${escapeHtml(candidate.sqlPreview)}</pre></details>` : ''}<p class="sql-hash">记录 ${escapeHtml(candidate.id)}<br>哈希 ${escapeHtml(candidate.hash)}</p></article>`).join('')}</details>`;
}
async function loadFields(offset) {
  const id = current.focus, sequence = ++fieldsSequence;
  const result = await api('analysis-fields', { id, offset, limit: 40 });
  if (sequence !== fieldsSequence || id !== current.focus) return;
  fields = result;
  renderFields();
}
function renderWriters() {
  const writers = graph.writers || [];
  if (!writers.length) {
    $('panel-writers').innerHTML = emptyState('当前范围没有可展示的写入表达式', '这不表示对象没有加工逻辑；当前材料尚未提供可对应到此对象的写入分支。已有 SQL 和公共知识可以分别阅读。');
    return;
  }
  $('panel-writers').innerHTML = writers.map((writer) => `<details class="writer-card" data-writer-id="${escapeHtml(writer.id)}" open><summary><div><h3>${escapeHtml(writer.label || writer.id)}</h3><p>${escapeHtml(writer.id)} · ${format(writer.expressions?.length)} 个已有表达式</p></div></summary><div class="writer-body"><div class="action-row"><button class="primary" data-writer-sql="${escapeHtml(writer.id)}">读取此任务 SQL ↗</button><button data-writer-focus="${escapeHtml(writer.id)}">在画布继续展开 ↗</button></div>${textValue(writer.packPartition ?? writer.partition) ? `<p class="branch-partition">配置分区：${escapeHtml(textValue(writer.packPartition ?? writer.partition))}<small>来自配置快照，不认定实际运行的写入范围。</small></p>` : ''}${(writer.expressions || []).map((expression) => `<article class="expression"><div class="expression-heading"><h4>${escapeHtml(expression.outputName || '未命名输出')}</h4>${Number.isInteger(expression.sourceLine) && expression.sourceLine > 0 ? `<button class="source-lines quiet" data-writer-sql="${escapeHtml(writer.id)}" data-line="${expression.sourceLine}" data-slot="${escapeHtml(expression.sqlSlot)}">SQL 第 ${expression.sourceLine}${Number.isInteger(expression.sourceEndLine) ? `–${expression.sourceEndLine}` : ''} 行 ↗</button>` : ''}</div><pre>${escapeHtml(expression.text || '当前记录没有表达式正文')}</pre>${expression.inputs?.length ? `<p class="input-label">记录的输入字段与读取发生次</p><div class="input-fields">${expression.inputs.map((input) => `<div class="input-occurrence"><span>${escapeHtml([input.table, input.column].filter(Boolean).join('.'))}</span><small class="occurrence-status ${input.occurrenceStatus === 'AMBIGUOUS' ? 'ambiguous' : ''}">发生次状态：${escapeHtml(input.occurrenceStatus || '未记录')}</small>${input.readOccurrenceId ? `<small class="occurrence-id">${escapeHtml(input.readOccurrenceId)}</small>` : ''}${input.occurrenceReason ? `<small>${escapeHtml(textValue(input.occurrenceReason))}</small>` : ''}</div>`).join('')}</div>` : '<p class="input-label">未记录可定位的输入字段。</p>'}</article>`).join('')}${writer.evidence ? `<details class="evidence-note"><summary>查看这条分支的证据记录</summary><p>${escapeHtml(textValue(writer.evidence))}</p></details>` : ''}</div></details>`).join('');
  $('panel-writers').querySelectorAll('.writer-card').forEach((card, index) => {
    card.querySelectorAll('.expression').forEach((element, expressionIndex) => {
      const status = document.createElement('span');
      status.className = 'binding-status';
      status.textContent = `绑定状态：${writers[index].expressions[expressionIndex].bindingStatus || '未记录'}`;
      element.querySelector('.expression-heading').append(status);
    });
  });
  bind('[data-writer-sql]', (button) => {
    const writer = graph.writers.find((item) => item.id === button.dataset.writerSql);
    const expression = writer?.expressions?.find((item) => item.sourceLine === Number(button.dataset.line));
    return openSql(button.dataset.writerSql, Number(button.dataset.line || 1), button.dataset.slot || expression?.sqlSlot || writer?.expressions?.[0]?.sqlSlot);
  }, $('panel-writers'));
  bind('[data-writer-focus]', (button) => focusObject({ id: button.dataset.writerFocus, kind: 'task' }), $('panel-writers'));
}
function knowledgeBlocks(body) {
  return textValue(body).split(/\n\s*\n/).filter(Boolean).map((block) => {
    if (/^#{1,6}\s/.test(block) && !block.includes('\n')) return `<h3>${escapeHtml(block.replace(/^#{1,6}\s+/, ''))}</h3>`;
    const lines = block.split('\n');
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return `<ul>${lines.map((line) => `<li>${escapeHtml(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    return `<p>${escapeHtml(block)}</p>`;
  }).join('');
}
function renderKnowledge() {
  const knowledge = graph.knowledge;
  if (!knowledge || (!knowledge.body && !knowledge.summary)) {
    $('panel-knowledge').innerHTML = emptyState('当前对象还没有公共知识稿', '这里保留已写明的业务解释，不根据对象名称补写含义。结构、表达式和 SQL 可以独立阅读。');
    return;
  }
  $('panel-knowledge').innerHTML = `<div class="knowledge"><h3>${escapeHtml(knowledge.title || '公共知识')}</h3><div class="knowledge-boundary">${escapeHtml(knowledge.boundary || '已有知识稿用于解释业务背景；不代表本次查询已验证业务口径或运行结果。')}</div>${knowledge.summary ? `<p class="knowledge-summary">${escapeHtml(textValue(knowledge.summary))}</p>` : ''}${knowledgeBlocks(knowledge.body)}</div>`;
}
function sqlSources() {
  const sources = [];
  if (graph.focus.kind === 'task') sources.push({ id: graph.focus.id, label: graph.focus.label || graph.focus.id });
  for (const writer of graph.writers || []) if (!sources.some((item) => item.id === writer.id)) sources.push({ id: writer.id, label: writer.label || writer.id });
  if (sql.id && !sources.some((item) => item.id === sql.id)) sources.push({ id: sql.id, label: sql.id.startsWith('definition:') ? '元数据定义原文' : sql.id });
  return sources;
}
function renderSql() {
  const sources = sqlSources();
  if (!sources.length) {
    $('panel-sql').innerHTML = emptyState('当前对象没有可定位的任务 SQL', '可以在画布中选择一个任务，或从写入分支进入对应 SQL。');
    return;
  }
  const selected = sql.id || sources[0].id, data = sql.data;
  let content = emptyState('按任务读取已有 SQL', 'SQL 正文按段读取；保留来源和证据哈希。');
  if (data) {
    content = data.available ? `<p class="sql-meta">${escapeHtml(data.source?.kind === "CATALOG_DEFINITION" ? "元数据定义原文 · 固定快照" : textValue(data.source) || "已有 SQL 证据")} · 共 ${format(data.totalLines)} 行。静态 SQL 不代表实际运行结果。</p><pre class="sql-code"><code>${String(data.sql || '').split('\n').map((line, index) => `<span class="sql-line"><span class="sql-line-number">${Number(data.lineStart || sql.start) + index}</span>${escapeHtml(line)}</span>`).join('')}</code></pre><div class="pagination"><span>从第 ${format(data.lineStart || sql.start)} 行读取</span><div><button id="sql-prev" ${sql.start <= 1 ? 'disabled' : ''}>上一段</button><button id="sql-next" ${data.nextLine == null ? 'disabled' : ''}>下一段</button></div></div>${data.contentSha256 ? `<p class="sql-hash">证据哈希 ${escapeHtml(data.contentSha256)}</p>` : ''}` : emptyState('SQL 当前不可用', data.reason || '当前证据未提供可读取的 SQL 正文。');
  }
  $('panel-sql').innerHTML = `<div class="sql-toolbar"><label><span class="label-text">${selected.startsWith("definition:") ? "元数据定义原文" : "任务 SQL"}</span><select id="sql-source" aria-label="选择 SQL 任务">${sources.map((source) => `<option value="${escapeHtml(source.id)}" ${source.id === selected ? 'selected' : ''}>${escapeHtml(source.label)} · ${escapeHtml(source.id)}</option>`).join('')}</select></label><button id="sql-read" class="primary">读取 SQL ↗</button></div>${content}`;
  $('sql-read').onclick = safeAction(() => openSql($('sql-source').value));
  $('sql-source').onchange = safeAction(() => openSql($('sql-source').value));
  if ($('sql-prev')) $('sql-prev').onclick = safeAction(() => openSql(sql.id, Math.max(1, sql.start - 100), sql.slot));
  if ($('sql-next')) $('sql-next').onclick = safeAction(() => openSql(sql.id, data.nextLine, sql.slot));
}
async function openSql(id, start = 1, slot) {
  if (!id) return;
  const focus = current.focus, sequence = ++sqlSequence;
  sql = { id, start: Math.max(1, Number(start) || 1), slot: slot || null, data: null };
  activateTab('sql', false);
  renderSql();
  const result = await api('analysis-sql', { id, lineStart: sql.start, lineCount: 100, slot: sql.slot });
  if (sequence !== sqlSequence || focus !== current.focus) return;
  sql.data = result;
  renderSql();
}
function activateTab(name, load = true) {
  if (!['fields', 'writers', 'sql', 'knowledge'].includes(name)) name = 'fields';
  activeTab = name;
  for (const tab of ['fields', 'writers', 'sql', 'knowledge']) {
    $(`tab-${tab}`).setAttribute('aria-selected', String(tab === name));
    $(`tab-${tab}`).tabIndex = tab === name ? 0 : -1;
    $(`panel-${tab}`).hidden = tab !== name;
  }
  if (load && name === 'sql' && !sql.data && sqlSources().length) safeAction(() => openSql(sql.id || sqlSources()[0].id))();
}

async function openExplorer(kind = '') {
  return navigate({ mode: 'search', q: '', kind, schema: '', label: kind === 'schema' ? 'Schema 探索' : '对象搜索' });
}
async function browseCurrentSchema() {
  return navigate({ mode: 'search', q: '', kind: '', schema: graph.focus.schemaName || graph.focus.label, label: `${graph.focus.schemaName || graph.focus.label} · 对象目录` });
}
async function searchObjects(append = false) {
  const sequence = ++searchSequence;
  const params = { q: $('object-search').value.trim(), kind: $('kind-filter').value, schema: $('schema-filter').value.trim(), offset: append ? searchNext || 0 : 0, limit: 24 };
  $('schema-filter-label').hidden = params.kind === 'schema';
  if (params.kind === 'schema') params.schema = '';
  const data = await api('analysis-search', params);
  if (sequence !== searchSequence || current.mode !== 'search') return;
  searchItems = append ? [...searchItems, ...(data.items || [])] : data.items || [];
  searchNext = data.nextOffset ?? null;
  current = { ...current, ...params };
  saveCurrent();
  $('search-summary').textContent = data.total == null ? `当前展示 ${format(searchItems.length)} 个对象` : `${format(data.total)} 个匹配对象 · 当前展示 ${format(searchItems.length)} 个`;
  $('search-more').hidden = searchNext === null;
  $('search-results').innerHTML = searchItems.length ? searchItems.map((item) => `<button class="object-card" data-result="${escapeHtml(item.id)}"><span class="card-type">${escapeHtml(objectTypeName(item.objectType, item.kind))} / 进入分析</span><strong>${escapeHtml(item.label || item.id)}</strong><p>${escapeHtml(item.description || '暂无业务说明，可进入查看已有关系与证据。')}</p><span class="card-schema">${escapeHtml(item.schemaName || item.id)} ↗</span></button>`).join('') : emptyState('没有匹配的对象', '试试更短的名称、准确任务 ID，或清除 Schema 和类型限制。');
  bind('[data-result]', (button) => newCenter(button.dataset.result), $('search-results'));
}

$('brand-home').onclick = (event) => { event.preventDefault(); safeAction(() => navigate({ mode: 'map', id: null, focus: null, expanded: [], label: '销售基础表案例' }))(); };
$('home').onclick = safeAction(() => navigate({ mode: 'map', id: null, focus: null, expanded: [], label: '销售基础表案例' }));
$('back').onclick = () => { if (position > 0) { saveCurrent(); history.back(); } };
$('browse-schemas').onclick = safeAction(() => openExplorer('schema'));
$('open-search').onclick = safeAction(() => openExplorer());
$('center-focus').onclick = safeAction(() => newCenter());
$('browse-current-schema').onclick = safeAction(browseCurrentSchema);
$('read-focus').onclick = () => $('analysis').scrollIntoView({ behavior: 'smooth', block: 'start' });
$('zoom-in').onclick = () => zoom(1.2);
$('zoom-out').onclick = () => zoom(1 / 1.2);
$('fit').onclick = () => { fitMap(false); saveCurrent(); };
$('locate-focus').onclick = () => locateFocus();
$('search-form').onsubmit = (event) => { event.preventDefault(); safeAction(() => searchObjects(false))(); };
$('kind-filter').onchange = safeAction(() => searchObjects(false));
$('search-more').onclick = safeAction(() => searchObjects(true));
$('search-clear').onclick = safeAction(() => { $('object-search').value = ''; $('schema-filter').value = ''; return searchObjects(false); });
bind('[data-tab]', (button) => activateTab(button.dataset.tab));
document.querySelector('.evidence-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = ['fields', 'writers', 'sql', 'knowledge'], index = tabs.indexOf(activeTab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); activateTab(tabs[next]); $(`tab-${tabs[next]}`).focus();
});
$('canvas').addEventListener('pointerdown', (event) => { if (event.button === 0) drag = { x: event.clientX, y: event.clientY, camera: { ...camera }, moved: false }; });
window.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
  if (drag.moved) { camera.x = drag.camera.x + dx; camera.y = drag.camera.y + dy; $('canvas').classList.add('dragging'); applyCamera(); }
});
window.addEventListener('pointerup', () => { if (drag?.moved) { lastDragAt = performance.now(); saveCurrent(); } drag = null; $('canvas').classList.remove('dragging'); });
window.addEventListener('pointercancel', () => { drag = null; $('canvas').classList.remove('dragging'); });
$('canvas').addEventListener('wheel', (event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.08 : 1 / 1.08); }, { passive: false });
$('canvas').addEventListener('keydown', (event) => {
  if (event.target !== $('canvas')) return;
  const directions = { ArrowLeft: [45, 0], ArrowRight: [-45, 0], ArrowUp: [0, 45], ArrowDown: [0, -45] };
  if (directions[event.key]) { event.preventDefault(); camera.x += directions[event.key][0]; camera.y += directions[event.key][1]; applyCamera(); }
});
window.addEventListener('popstate', safeAction(async (event) => {
  localLimit = false;
  if (event.state?.session === session) { position = event.state.position; await navigate(event.state.entry, { push: false, restore: true }); }
  else { position = -1; timeline = []; await navigate(parseRoute(), { push: false }); }
}));
let previousWidth = 0;
new ResizeObserver(() => {
  const width = $('canvas').clientWidth;
  if (graph && width && width !== previousWidth && !$('map-workspace').hidden) { previousWidth = width; fitMap(true); }
}).observe($('canvas'));
await safeAction(() => navigate(parseRoute(), { push: false }))();
