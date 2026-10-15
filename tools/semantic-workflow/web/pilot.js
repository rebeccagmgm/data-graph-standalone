const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
let data, topic = new URLSearchParams(location.search).get('topic') || '标准模型', dirty = false, packs = new Map();
const statuses = { accepted: '映射已确认', draft: '草稿', needs_evidence: '退回补证', pending: '待审核', prepared: '待调用', success: '已提取', invalid: '输出需修复', uncertain: '调用待核对', inflight: '调用中' };
function field(label, obj, key, area = false) {
  const box = node('label', label), control = node(area ? 'textarea' : 'input'); control.value = obj[key] ?? '';
  control.addEventListener('input', () => { obj[key] = control.value; dirty = true; }); box.append(control); return box;
}
function select(label, value, choices, change) {
  const box = node('label', label), control = node('select');
  for (const [id, text] of choices) { const opt = node('option', text); opt.value = id; control.append(opt); }
  control.value = value; control.addEventListener('change', () => { change(control.value); dirty = true; }); box.append(control); return box;
}
function button(text, action, cls) { const b = node('button', text, cls); b.addEventListener('click', action); return b; }
function properties(standards, type) { const e = standards.entries.find(x => x.id === type); return e ? [...e.fields, ...(e.parent ? properties(standards, e.parent) : [])] : []; }
function evidence(ids, pack) {
  const panel = node('details'); panel.append(node('summary', `来源证据 · ${ids.length} 项`));
  for (const id of ids) {
    const e = pack.evidence.find(x => x.id === id); if (!e) continue;
    const d = node('details', undefined, 'evidence-box'); d.append(node('summary', `${e.kind} · ${e.source}`), node('pre', JSON.stringify(e.content, null, 2))); panel.append(d);
  }
  return panel;
}
async function load() {
  if (dirty && !confirm('放弃尚未保存的映射修改并刷新？')) return;
  const response = await fetch('/api/pilot'); if (!response.ok) throw Error('读取试点失败');
  data = await response.json();
  await Promise.all(data.items.map(async i => {
    if (!packs.has(i.hash)) { const r = await fetch(`/api/pack?hash=${encodeURIComponent(i.hash)}`); if (!r.ok) throw Error('读取证据失败'); packs.set(i.hash, await r.json()); }
  }));
  dirty = false; render();
}
function render() {
  const s = data.summary; $('summary').replaceChildren();
  for (const [n, label] of [[`${s.completed} / 7`, '真实资料提取'], [s.accepted, '人工确认的映射项'], [s.reusedAcrossProducts, '期权与互换共同采用的 CDM 定义'], [s.unmappedRelations, '待确定 CDM 路径的数据关联']]) {
    const d = node('div', undefined, 'metric'); d.append(node('strong', n), node('span', label)); $('summary').append(d);
  }
  $('topics').replaceChildren();
  for (const t of ['标准模型', '合约', '参与方', '账户', '待映射', '已确认']) $('topics').append(button(t, () => {
    if (dirty && !confirm('有未保存修改，放弃并切换？')) return;
    topic = t; dirty = false; history.replaceState(null, '', `/pilot?topic=${encodeURIComponent(t)}`); render();
  }, `topic${topic === t ? ' active' : ''}`));
  $('jobs').replaceChildren();
  for (const manifest of data.manifest) {
    const i = data.items.find(x => x.id === manifest.id), d = node('div', undefined, 'job');
    const status = i?.blockingAttempt?.status === 'uncertain' ? '历史调用待核对' : statuses[i?.status] ?? '未组包';
    d.append(node('strong', `${manifest.product} · ${manifest.topic}`), node('span', `${manifest.sourceId} / ${status}`)); $('jobs').append(d);
  }
  $('usage').textContent = `累计接口用量 ${data.usage.reportedTokens.toLocaleString()} token · 待核对预留 ${data.usage.uncertainReservedTokens.toLocaleString()} · 结构检查不等于完整 CDM 实例验证。`;
  const content = $('content'); content.replaceChildren();
  if (topic === '标准模型') return renderStandards(content);
  if (topic === '已确认') return renderRegistry(content);
  if (topic === '待映射') return renderUnmapped(content);
  const intro = node('div', undefined, 'intro'); intro.append(node('h2', `${topic} · CDM 定义与数据对应`), node('p', '标准定义只读。逐项核对内部字段与范围；修改时记录原因，确认后会供后续提取复用。')); content.append(intro);
  const items = data.items.filter(i => i.pilot.topic === topic).sort((a, b) => a.pilot.order - b.pilot.order);
  if (!items.length) content.append(node('p', '七组资料尚未准备。', 'empty'));
  for (const i of items) {
    const group = node('div', undefined, 'group'); group.append(node('h2', `${i.pilot.product} · ${i.id}`));
    const pack = packs.get(i.hash);
    if (i.blockingAttempt?.status === 'uncertain') group.append(node('p', '这组资料有一次尚未核清的请求，已暂停重复调用。修复连接后仍需先核实该次请求的状态。', 'warning'));
    if (i.status !== 'success' || !i.result) {
      group.append(node('p', `${statuses[i.status] ?? i.status}。${i.error ? (i.status === 'uncertain' ? '未收到可靠结果或用量；没有自动重试。' : '结果未通过结构检查，不能确认映射。') : ''}`, 'empty'));
      group.append(evidence(pack.evidence.map(e => e.id), pack));
    }
    else {
      for (const kind of ['entity', 'relation']) for (const item of i.result[kind === 'entity' ? 'entities' : 'relations']) group.append(reviewCard(i, kind, item, pack));
      if (!i.result.entities.length) group.append(node('p', '没有足够依据提出 CDM 映射，请查看缺口。', 'empty'));
      if (i.result.unmappedRelations.length) group.append(node('p', `${i.result.unmappedRelations.length} 条内部关联尚未确定 CDM 路径，见“待映射”。`, 'warning'));
      if (i.result.rejectedCandidates?.length) group.append(node('p', `${i.result.rejectedCandidates.length} 项建议超出本轮 CDM 类型范围，已隔离，不能确认。原建议可在“待映射”查看。`, 'warning'));
    }
    const gaps = [...pack.gaps, ...(i.result?.gaps ?? [])];
    const d = node('details'); d.append(node('summary', `本组证据缺口 · ${gaps.length}`)); gaps.forEach(g => d.append(node('p', g, 'muted'))); group.append(d); content.append(group);
  }
}
function reviewCard(source, kind, original, pack) {
  const item = structuredClone(original), isEntity = kind === 'entity';
  const mappings = structuredClone(source.result[isEntity ? 'mappings' : 'relationMappings'].filter(m => m[isEntity ? 'entityId' : 'relationId'] === item.id));
  const saved = source.reviews.find(r => r.kind === kind && r.item_id === item.id);
  const draft = { reason: saved?.reason ?? '' };
  const card = node('article', undefined, 'card'), head = node('div', undefined, 'card-head');
  head.append(node('h2', item.name), node('span', statuses[saved?.status ?? 'pending'], `tag ${saved?.status === 'accepted' ? '' : 'pending'}`)); card.append(head);
  card.append(node('p', `CDM 7.0.0 / ${item.standardRef}`, 'muted'));
  const definition = node('details'); definition.append(node('summary', '查看标准原文（只读）'), node('p', item.definition ?? item.meaning));
  if (!isEntity) definition.append(node('p', `${item.from} → ${item.to}；声明属性 ${item.standardRef}`)); card.append(definition);
  const comparisons = node('div', undefined, 'comparison');
  for (const other of data.items.filter(i => i.status === 'success' && i.result?.[isEntity ? 'entities' : 'relations'].some(e => e.canonicalId === item.canonicalId))) comparisons.append(node('span', `${other.pilot.product} · ${other.pilot.topic}`, 'tag'));
  card.append(comparisons);
  const columns = node('div', undefined, 'columns'), left = node('div', undefined, 'block'), right = node('div', undefined, 'block');
  left.append(node('h3', '数据对应 · 字段和范围'));
  const mappingContainer = node('div'); left.append(mappingContainer);
  function paintMappings() {
    mappingContainer.replaceChildren();
    mappings.forEach((m, index) => {
      const asset = pack.assets.find(a => a.id === m.assetId), block = node('div', undefined, 'mapping');
      block.append(node('strong', asset?.table ?? m.assetId), node('p', asset?.identityStatus ?? '', 'muted'), field('适用范围（保留类型、分区、业务日和编号条件）', m, 'scope', true));
      if (isEntity) {
        const allProps = properties(pack.standards, item.standardRef);
        const rows = node('div');
        for (const [fIndex, f] of m.fields.entries()) {
          const row = node('div', undefined, 'field-row');
          row.append(select('CDM 属性', f.property, allProps.map(p => [p.name, `${p.name} (${p.type})`]), value => {
            f.property = value;
            if (!item.properties.some(p => p.name === value)) item.properties.push({ name: value, type: allProps.find(p => p.name === value).type, evidenceIds: item.evidenceIds });
          }), select('内部字段', f.field, (asset?.fields ?? []).map(f => [f.name, f.name]), v => { f.field = v; }), button('×', () => { m.fields.splice(fIndex, 1); dirty = true; paintMappings(); })); rows.append(row);
        }
        block.append(rows, button('添加字段对应', () => {
          const p = allProps[0], f = asset?.fields[0]; if (!p || !f) return;
          m.fields.push({ property: p.name, field: f.name }); if (!item.properties.some(x => x.name === p.name)) item.properties.push({ name: p.name, type: p.type, evidenceIds: item.evidenceIds }); dirty = true; paintMappings();
        }), field('映射说明 / 尚未覆盖的 CDM 结构', m, 'note', true));
        block.append(node('p', '当前只验证字段与证据引用，不声称构造了完整 CDM 对象。', 'muted'));
      } else for (const key of ['fromField', 'toField']) block.append(select(key === 'fromField' ? '起点字段' : '终点字段', m[key], (asset?.fields ?? []).map(f => [f.name, f.name]), v => { m[key] = v; }));
      block.append(evidence(m.evidenceIds, pack), button('移除此映射', () => { mappings.splice(index, 1); dirty = true; paintMappings(); })); mappingContainer.append(block);
    });
    if (!mappings.length) mappingContainer.append(node('p', '尚无字段映射，不能确认。', 'warning'));
  }
  paintMappings();
  const newMapping = { assetId: pack.assets[0]?.id };
  left.append(select('新增映射使用的表', newMapping.assetId, pack.assets.map(a => [a.id, `${a.table} · ${a.id.slice(-6)}`]), v => { newMapping.assetId = v; }), button('添加表映射', () => {
    const a = pack.assets.find(a => a.id === newMapping.assetId); if (!a) return;
    mappings.push(isEntity ? { entityId: item.id, assetId: a.id, scope: '', fields: [], coverage: 'partial', note: '', evidenceIds: item.evidenceIds } : { relationId: item.id, assetId: a.id, scope: '', fromField: a.fields[0]?.name ?? '', toField: a.fields[0]?.name ?? '', evidenceIds: item.evidenceIds }); dirty = true; paintMappings();
  }));
  right.append(node('h3', '待决定的差异'), select('内部数据与 CDM 的对应', item.alignment, [['pending', '尚待对齐 / 部分对应'], ['aligned', '含义对应已核对']], v => { item.alignment = v; }), select('当前证据', item.evidenceStatus, [['supported', '已有依据，可供审核'], ['needs_evidence', '仍需要补充依据']], v => { item.evidenceStatus = v; }), select('与已有映射的关系', item.decision, [['new', '首次映射到该 CDM 定义'], ['reuse', '复用该 CDM 定义，保留本组范围'], ['conflict', '存在冲突，需要处理']], v => { item.decision = v; }));
  if (!isEntity) right.append(field('内部角色说明', item, 'role', true));
  const questions = node('label', '尚未解决的问题（每行一项；解决后删除并说明原因）'), q = node('textarea'); q.value = item.questions.join('\n'); q.addEventListener('input', () => { item.questions = q.value.split('\n').map(v => v.trim()).filter(Boolean); dirty = true; }); questions.append(q);
  right.append(questions, field('修改 / 补证原因', draft, 'reason', true), evidence(item.evidenceIds, pack));
  columns.append(left, right); card.append(columns);
  const actions = node('div', undefined, 'review-actions');
  for (const [status, label] of [['draft', '保存此项草稿'], ['needs_evidence', '退回补证'], ['accepted', '确认此项映射']]) actions.append(button(label, async () => {
    if (dirty && !confirm('本操作只保存当前卡片；其他卡片尚未保存的修改会在刷新后丢失。继续？')) return;
    card.classList.add('busy');
    try {
      const r = await fetch('/api/pilot/review', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrf }, body: JSON.stringify({ attemptId: source.attemptId, revision: data.revision, kind, status, item, mappings, reason: draft.reason }) });
      const response = await r.json(); if (!r.ok) throw Error(response.error);
      dirty = false; await load(); $('notice').textContent = `已保存 ${item.standardRef}：${statuses[status]}`;
    } catch (e) { $('notice').textContent = `未保存：${e.message}`; card.classList.remove('busy'); $('notice').scrollIntoView({ block: 'center' }); }
  }, status === 'accepted' ? 'primary' : ''));
  card.append(actions); return card;
}
function renderUnmapped(content) {
  content.append(node('h2', '有数据依据，尚未确定 CDM 路径'), node('p', '下面不是新建的正式关系。需要确认角色和上下文后，才能映射到 CDM 原生属性。'));
  let count = 0;
  for (const source of data.items.filter(i => i.status === 'success')) for (const m of source.result.unmappedRelations) {
    count++; const pack = packs.get(source.hash), card = node('article', undefined, 'card');
    card.append(node('span', `${source.pilot.product} · ${source.id}`, 'tag'), node('h2', m.name), node('p', m.reason, 'warning'), node('p', `${pack.assets.find(a => a.id === m.assetId)?.table}: ${m.fromField} → ${m.toField}`), node('p', m.scope), evidence(m.evidenceIds, pack)); content.append(card);
  }
  for (const source of data.items.filter(i => i.status === 'success')) for (const r of source.result.rejectedCandidates ?? []) {
    count++; const card = node('article', undefined, 'card'); card.append(node('span', `${source.pilot.product} · ${source.id}`, 'tag pending'), node('h2', `未纳入正式关系：${r.item.standardRef}`), node('p', r.reason, 'warning'));
    const detail = node('details'); detail.append(node('summary', '查看被隔离的原始建议'), node('pre', JSON.stringify(r, null, 2))); card.append(detail); content.append(card);
  }
  if (!count) content.append(node('p', '尚无待映射关联。', 'empty'));
}
function renderRegistry(content) {
  content.append(node('h2', '人工确认的数据映射'), node('p', '同一个 CDM 定义可绑定多组内部数据；每组保留自己的字段与范围。'));
  if (!data.registry.length) content.append(node('p', '还没有人工确认。这是正常的：真实 API 返回仍然只是候选。', 'empty'));
  for (const d of data.registry) {
    const card = node('article', undefined, 'card'); card.append(node('h2', d.standardRef), node('p', `CDM ${d.version} · ${d.bindings.length} 组映射`, 'muted'));
    for (const b of d.bindings) { const details = node('details'); details.append(node('summary', `${b.product} · ${b.source} · ${b.alignment === 'aligned' ? 'CDM 含义对应已核对' : '内部映射已审核，CDM 对齐仍待完成'}`), node('pre', JSON.stringify(b.mappings, null, 2))); card.append(details); } content.append(card);
  }
}
function renderStandards(content) {
  const standards = packs.values().next().value?.standards;
  content.append(node('h2', '本轮采用的 CDM 原生定义'), node('p', '下方实体、属性、关系来自 CDM 7.0.0 的原始声明；不是从旧候选整理出来的新模型。内部数据映射另行审核。'));
  if (!standards) { content.append(node('p', '需要先准备试点资料，才能读取固定版本的标准定义。', 'empty')); return; }
  const native = node('article', undefined, 'card'); native.append(node('h3', '原生关系与继承'));
  for (const [from, prop, to] of [['Trade', '继承', 'TradableProduct'], ['TradableProduct', 'counterparty (2..2)', 'Counterparty'], ['Counterparty', 'partyReference (1..1)', 'Party'], ['Party', 'account (0..1，合同上下文)', 'Account']]) native.append(node('p', `${from}  →  ${prop}  →  ${to}`));
  native.append(node('p', '这里展示标准结构，不代表内部数据已经满足相应基数、角色或实例约束。', 'warning')); content.append(native);
  for (const entry of standards.entries) {
    const card = node('article', undefined, 'card'); card.append(node('h2', entry.id), node('span', `CDM ${entry.version} · 只读`, 'tag'));
    const desc = node('details'); desc.append(node('summary', '标准定义与来源'), node('p', entry.declaration), node('p', `${entry.source}:${entry.line}`, 'muted'), node('p', `来源指纹 ${entry.sourceHash.slice(0, 16)}`, 'muted')); card.append(desc);
    const fields = node('details'); fields.append(node('summary', `原生属性（含继承） · ${properties(standards, entry.id).length}`));
    const table = node('table'), tr = node('tr'); for (const title of ['声明属性', '类型', '基数', '引用']) tr.append(node('th', title)); table.append(tr);
    for (const p of properties(standards, entry.id)) { const row = node('tr'); [p.id, p.type, p.cardinality, p.reference ? '是' : '否'].forEach(t => row.append(node('td', t))); table.append(row); } fields.append(table); card.append(fields); content.append(card);
  }
}
$('refresh').addEventListener('click', () => load().catch(e => { $('notice').textContent = e.message; }));
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
load().catch(e => { $('notice').textContent = e.message; });
