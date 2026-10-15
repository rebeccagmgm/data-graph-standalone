const $ = id => document.getElementById(id);
let snapshot, current, result, pack, tab = 'entities', dirty = false, selectionRequest = 0;
const labels = { prepared: '已组包', success: '提取完成', invalid: '需修复', uncertain: '调用待核对', inflight: '调用中／中断', pending: '待确认', draft: '草稿', accepted: '已采用', rejected: '暂不采用' };
function node(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
function changed() { dirty = true; $('save-state').textContent = '有未保存的修改'; }
function form(label, object, key, multiline = false) {
  const wrapper = node('label', undefined, 'form-row'); wrapper.append(node('span', label));
  const input = node(multiline ? 'textarea' : 'input'); input.value = object[key] ?? '';
  input.addEventListener('input', () => { object[key] = input.value; changed(); }); wrapper.append(input); return wrapper;
}
function evidenceLine(ids) {
  const button = node('button', `查看 ${ids?.length ?? 0} 条依据`, 'evidence-link');
  button.addEventListener('click', () => {
    tab = 'evidence'; render();
    for (const id of ids ?? []) { const panel = document.getElementById(`evidence-${id}`); if (panel) panel.open = true; }
    document.getElementById(`evidence-${ids?.[0]}`)?.scrollIntoView({ block: 'start' });
  });
  return button;
}
function statusLabel(item) {
  if (item.status === 'success') return item.result?.entities?.length ? `候选 ${item.result.entities.length} 个实体 · ${item.result.relations.length} 条关系` : '未提出实体候选';
  return labels[item.status] ?? item.status;
}
function errorMessage(error) {
  if (!error) return '';
  try { const detail = JSON.parse(error); return `本次结果未通过校验或调用未完成：${(detail.errors ?? [detail.reason]).join('；')}。可查看证据，修复后续跑。`; }
  catch { return error; }
}
function renderList() {
  const term = $('filter').value.toLowerCase(); $('items').replaceChildren();
  const rank = i => i.status === 'success' && i.result?.entities?.length ? 0 : i.status === 'invalid' ? 1 : i.status === 'prepared' ? 3 : 2;
  const list = snapshot.items.filter(i => ($('history').checked || i.current) && JSON.stringify([i.title, i.id, i.result?.entities?.map(e => e.name)]).toLowerCase().includes(term)).sort((a, b) => rank(a) - rank(b));
  list.forEach(item => {
    const button = node('button', item.title, `item${current?.hash === item.hash ? ' active' : ''}`);
    button.append(node('small', `${item.id} · ${statusLabel(item)} · ${labels[item.reviewStatus] ?? item.reviewStatus}${item.current ? '' : ' · 历史'}`));
    button.addEventListener('click', () => select(item).catch(() => { $('message').textContent = '读取条目失败，请刷新后重试'; })); $('items').append(button);
  });
}
async function select(item) {
  if (item.pilot) { location.assign(`/pilot?topic=${encodeURIComponent(item.pilot.topic)}`); return; }
  if (dirty && !confirm('有未保存的修改，确定切换条目？')) return;
  const request = ++selectionRequest;
  current = item; result = null; pack = null; dirty = false;
  ['draft', 'accept', 'reject'].forEach(id => $(id).disabled = true);
  $('content').replaceChildren(node('p', '正在读取证据…', 'empty'));
  const response = await fetch(`/api/pack?hash=${encodeURIComponent(item.hash)}`);
  const selectedPack = await response.json();
  if (request !== selectionRequest) return;
  if (!response.ok) { $('message').textContent = '未读取到输入包'; return; }
  pack = selectedPack; result = item.status === 'success' ? structuredClone(item.result) : null;
  window.history.replaceState(null, '', `/?item=${encodeURIComponent(item.id)}`);
  $('title').textContent = item.title; $('item-state').textContent = `${item.id} · ${labels[item.reviewStatus]}${item.current ? '' : ' · 历史输入版本'}`;
  $('message').textContent = errorMessage(item.error);
  $('save-state').textContent = '确认仅用于业务参考，不表示可自动执行取数。';
  renderList(); render();
}
function render() {
  const target = $('content'); target.replaceChildren();
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['draft', 'accept', 'reject'].forEach(id => $(id).disabled = !result || current?.status !== 'success' || !current?.current);
  if (!current || !pack) return;
  if (tab !== 'evidence' && !result) { target.append(node('p', '尚无有效提取结果。可先查看本条目的证据包。', 'empty')); return; }
  if (tab === 'entities') {
    const grid = node('div', undefined, 'entities');
    for (const entity of result.entities) {
      const card = node('article', undefined, 'entity');
      card.append(form('实体名称', entity, 'name'), form('定义与粒度', entity, 'definition', true));
      entity.canonicalId ??= `${current.id}/${entity.id}`;
      card.append(form('统一实体编号（跨条目合并时使用相同编号）', entity, 'canonicalId'));
      const propertyPanel = node('details'); propertyPanel.open = entity.properties.length <= 8;
      propertyPanel.append(node('summary', `属性（${entity.properties.length}）`));
      const props = node('div', undefined, 'properties');
      entity.properties.forEach(prop => {
        const row = node('div', undefined, 'prop'); const name = node('input'); name.value = prop.name; name.setAttribute('aria-label', '属性名称');
        name.addEventListener('change', () => { const old = prop.name; prop.name = name.value; result.mappings.filter(m => m.entityId === entity.id).forEach(m => m.fields.filter(f => f.property === old).forEach(f => f.property = prop.name)); changed(); });
        const type = node('input'); type.value = prop.type; type.setAttribute('aria-label', '属性类型'); type.addEventListener('input', () => { prop.type = type.value; changed(); }); row.append(name, type); props.append(row);
      }); propertyPanel.append(props); card.append(propertyPanel, evidenceLine(entity.evidenceIds)); grid.append(card);
    }
    target.append(grid); if (!result.entities.length) target.append(node('p', '本包没有足够证据提出实体候选。', 'empty'));
    result.classifications.forEach(c => { const block = node('div', undefined, 'mapping'); block.append(node('h3', `目录：${result.entities.find(e => e.id === c.entityId)?.name ?? c.entityId}`), form('业务品种', c, 'product'), form('数据主题', c, 'topic')); target.append(block); });
  } else if (tab === 'relations') {
    for (const relation of result.relations) {
      const card = node('article', undefined, 'relation'), grid = node('div', undefined, 'relation-grid');
      for (const key of ['from', 'to']) {
        const label = node('label', undefined, 'form-row'); label.append(node('span', key === 'from' ? '起点实体' : '终点实体')); const select = node('select');
        result.entities.forEach(e => { const opt = node('option', e.name); opt.value = e.id; select.append(opt); }); select.value = relation[key]; select.addEventListener('change', () => { relation[key] = select.value; changed(); }); label.append(select); grid.append(label);
      }
      grid.append(form('关系名称', relation, 'name')); card.append(grid, form('关系含义与限制', relation, 'meaning', true), evidenceLine(relation.evidenceIds)); target.append(card);
    }
    if (!result.relations.length) target.append(node('p', '本包未提出有依据的业务关系。', 'empty'));
  } else if (tab === 'mapping') {
    result.mappings.forEach(mapping => {
      const asset = pack.assets.find(a => a.id === mapping.assetId), card = node('article', undefined, 'mapping');
      card.append(node('h2', `${result.entities.find(e => e.id === mapping.entityId)?.name} → ${asset?.table ?? mapping.assetId}`), node('p', `物理身份：${asset?.identityStatus ?? '未确认'}`, 'muted'), form('数据范围', mapping, 'scope', true));
      for (const field of mapping.fields) {
        const label = node('label', undefined, 'form-row'); label.append(node('span', field.property)); const select = node('select');
        (asset?.fields ?? []).forEach(f => { const option = node('option', `${f.name} ${f.comment ?? ''}`); option.value = f.name; select.append(option); });
        select.value = asset?.fields.find(f => f.name.toLowerCase() === field.field.toLowerCase())?.name ?? field.field;
        select.addEventListener('change', () => { field.field = select.value; changed(); }); label.append(select); card.append(label);
      }
      card.append(evidenceLine(mapping.evidenceIds)); target.append(card);
    });
  } else {
    target.append(node('p', `图谱版本：${pack.graphVersion?.slice(0, 12) ?? '未取得'} · 输入包：${pack.hash.slice(0, 12)}`, 'muted'));
    const kinds = { curated_seed: '整理底稿', metadata: '表字段元数据', document: '业务文档', dictionary: '码值字典', graph_bindings: '图谱字段绑定', sql_excerpt: 'SQL 快照' };
    pack.evidence.forEach(e => { const details = node('details'); details.id = `evidence-${e.id}`; details.append(node('summary', `${kinds[e.kind] ?? e.kind} · ${e.source}`), node('p', `${e.id} · ${e.status}`, 'muted'), node('pre', JSON.stringify(e.content, null, 2))); target.append(details); });
    const details = node('details'); details.append(node('summary', '表与字段元数据'), node('pre', JSON.stringify(pack.assets, null, 2))); target.append(details);
  }
  const gaps = [...(pack.gaps ?? []), ...(result?.gaps ?? [])];
  if (gaps.length) { const details = node('details'); details.append(node('summary', `待补信息（${gaps.length}）`)); const ul = node('ul', undefined, 'gaps'); gaps.forEach(g => ul.append(node('li', g))); details.append(ul); target.append(details); }
}
async function load(preserve = true) {
  if (dirty && !confirm('刷新会放弃未保存修改，继续？')) return;
  dirty = false; snapshot = await (await fetch('/api/state')).json();
  const params = new URLSearchParams(location.search);
  if (!params.has('legacy') && !params.has('item') && snapshot.items.some(i => i.current && i.pilot)) { location.replace('/pilot'); return; }
  $('usage').textContent = `API 调用 ${snapshot.usage.calls} 次 · 已报告 ${snapshot.usage.reportedTokens.toLocaleString()} token · 待核对预留 ${snapshot.usage.uncertainReservedTokens.toLocaleString()}`;
  const previous = preserve && current ? snapshot.items.find(i => i.hash === current.hash) : null;
  const linkedId = new URLSearchParams(location.search).get('item');
  renderList(); const chosen = previous ?? snapshot.items.find(i => i.current && i.id === linkedId) ?? snapshot.items.find(i => i.current && i.status === 'success' && i.result?.entities?.length) ?? snapshot.items.find(i => i.current && i.status === 'success') ?? snapshot.items.find(i => i.current);
  if (chosen) await select(chosen);
}
async function save(status) {
  try {
    const response = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': snapshot.csrf }, body: JSON.stringify({ attemptId: current.attemptId, status, result }) });
    const body = await response.json(); if (!response.ok) throw Error((body.errors ?? [body.error]).join('；'));
    dirty = false; await load(); $('message').textContent = `已保存：${labels[status]}`;
  } catch (e) { $('message').textContent = e.message; }
}
$('filter').addEventListener('input', renderList); $('history').addEventListener('change', renderList);
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
$('refresh').addEventListener('click', () => load()); $('draft').addEventListener('click', () => save('draft')); $('accept').addEventListener('click', () => save('accepted')); $('reject').addEventListener('click', () => save('rejected'));
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
load().catch(() => { $('message').textContent = '读取本地工作流失败，请检查服务。'; });
