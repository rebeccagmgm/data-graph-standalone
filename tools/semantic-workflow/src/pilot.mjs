import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Order is intentional: option candidates precede TRS comparisons. No candidate is auto-adopted.
export const PILOT = [
  { sourceId: 'T03-038', product: '期权', topic: '合约', question: '合约身份、持有人来源和业务日范围是什么？' },
  { sourceId: 'T03-017', product: '期权', topic: '参与方', question: '参与方编号与关系角色是什么？A/B、买卖方不能混同。' },
  { sourceId: 'T03-021', product: '期权', topic: '账户', question: '合约怎样关联资金账户？保留关系类型 A18 及两端修饰符。', relationCode: 'A18' },
  { sourceId: 'T03-033', product: '公共', topic: '账户', question: '资金账户如何标识？内部账户键与账号是否不同？' },
  { sourceId: 'T03-039', product: '互换', topic: '合约', question: '普通收益互换合约身份、持有人来源是什么？与期权比较。' },
  { sourceId: 'T03-018', product: '互换', topic: '参与方', question: '普通互换交易对手与账簿持有人如何区别？与期权比较。' },
  { sourceId: 'T03-022', product: '互换', topic: '账户', question: '普通互换怎样关联资金账户？保留关系类型 A17 及两端修饰符。', relationCode: 'A17' },
].map((p, order) => ({ ...p, order, id: `models:${p.sourceId}` }));

export const focusField = name => /(^|_)(id|key|code|type|role|date|party|pty|agt|acct|account|book|seller|buyer|counterparty|src|source|mod|modifier|name)(_|$)|business_date|rela_type/i.test(name);

export function selectFields(fields, limit) {
  return fields.map((field, order) => ({ field, order, score: (focusField(field.name) ? 2 : 0) + (field.partition ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(x => x.field);
}

export function sqlWindows(sql, maxChars, terms = []) {
  const lines = sql.split(/\r?\n/);
  if (sql.length <= maxChars) return { windows: [{ lineStart: 1, lineEnd: lines.length, excerpt: sql }], truncated: false };
  const matches = lines.map((line, i) => ({ i, score: terms.reduce((n, t) => n + Number(line.toLowerCase().includes(t.toLowerCase())), 0) + Number(/\b(where|join|insert|partition)\b/i.test(line)) }))
    .filter(x => x.score).sort((a, b) => b.score - a.score || a.i - b.i);
  const selected = new Set(); let size = 0;
  for (const { i } of matches) for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 7); j++) {
    if (!selected.has(j) && size + lines[j].length + 1 <= maxChars) { selected.add(j); size += lines[j].length + 1; }
  }
  const windows = [];
  for (const i of [...selected].sort((a, b) => a - b)) {
    const last = windows.at(-1);
    if (last && last.lineEnd === i) { last.lineEnd = i + 1; last.excerpt += `\n${lines[i]}`; }
    else windows.push({ lineStart: i + 1, lineEnd: i + 1, excerpt: lines[i] });
  }
  return { windows, truncated: true, warning: '按关键字段选取上下文；窗口可能不含完整 SQL 语句，不能据此认定条件已完整。' };
}

// A deliberately selected, source-verified view, not a general Rune parser or CDM runtime.
export function loadStandards(repositoryRoot) {
  const root = join(repositoryRoot, 'cdm-reference/upstream/cdm-7.0.0');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (manifest.tag !== '7.0.0' || manifest.commit !== 'a6ffe777bc12ef3d289579cb3a86d1cbffea63d2') throw Error('CDM_VERSION_MISMATCH');
  const selection = {
    'event-common-type.rosetta': ['Trade'],
    'product-template-type.rosetta': ['TradableProduct'],
    'base-staticdata-party-type.rosetta': ['Party', 'Counterparty', 'Account'],
  };
  const entries = [];
  for (const [file, types] of Object.entries(selection)) {
    const relative = `cdm-reference/upstream/cdm-7.0.0/rosetta-source/src/main/rosetta/${file}`;
    const bytes = readFileSync(join(repositoryRoot, relative));
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    if (manifest.files.find(f => f.path === `rosetta-source/src/main/rosetta/${file}`)?.sha256 !== sourceHash) throw Error(`CDM_SOURCE_HASH_MISMATCH:${file}`);
    const source = bytes.toString('utf8');
    const lines = source.split(/\r?\n/);
    for (const type of types) {
      const start = lines.findIndex(line => line.startsWith(`type ${type}:`) || line.startsWith(`type ${type} extends `));
      if (start < 0) throw Error(`CDM_DECLARATION_MISSING:${type}`);
      const next = lines.findIndex((line, i) => i > start && /^(type|enum|func|choice) /.test(line));
      const block = lines.slice(start, next < 0 ? lines.length : next);
      const fields = [];
      block.forEach((line, i) => {
        const match = /^    (\w+) (\w+) \((\d+)\.\.(\d+|\*)\)/.exec(line);
        if (match) fields.push({ id: `${type}.${match[1]}`, owner: type, name: match[1], type: match[2], cardinality: `${match[3]}..${match[4]}`, reference: /^\s+\[metadata reference\]/.test(block[i + 1] ?? ''), line: start + i + 1, declaration: line.trim() });
      });
      entries.push({ id: type, version: '7.0.0', parent: / extends (\w+)/.exec(block[0])?.[1] ?? null, source: relative, sourceHash, line: start + 1, declaration: block[0], fields });
    }
  }
  return { version: '7.0.0', entries, notes: ['仅供定义与原生属性参照，不验证完整 CDM 实例。', 'Trade 继承 TradableProduct；属性引用保留声明所属类型。', 'Party.account 的基数限于合同或法律文档上下文，不是全局一方一个账户。', '合约关联资金账户不自动等于付款账户；内部账户主键不自动等于 accountNumber。'] };
}

export function definitionOf(kind, item) {
  // Shared identity is exclusively CDM identity; local scopes and field coverage stay in bindings.
  return { kind, standardRef: item.standardRef, version: '7.0.0' };
}

export function propertiesOf(standards, type) {
  const entry = standards.entries.find(e => e.id === type);
  return entry ? [...entry.fields, ...(entry.parent ? propertiesOf(standards, entry.parent) : [])] : [];
}

function scopeMatches(mapping, pack) {
  const expected = pack.pilot.relationCode;
  if (!expected) return true;
  const asset = pack.assets.find(a => a.id === mapping?.assetId);
  const codes = String(mapping?.scope ?? '').match(/\bA1[78]\b/g) ?? [];
  return !(asset?.table.toLowerCase().endsWith('.t03_agt_rela_h') && !codes.includes(expected)) && codes.every(c => c === expected);
}

export function normalizePilot(result, pack) {
  if (!pack.pilot || !result || !Array.isArray(result.entities) || !Array.isArray(result.relations)) return result;
  const value = structuredClone(result);
  const validEvidence = new Set(pack.evidence.map(e => e.id));
  const labels = { Trade: '交易合约', Party: '参与方', Counterparty: '交易对手角色', Account: '账户', TradableProduct: '可交易产品' };
  for (const e of value.entities) {
    const standard = pack.standards.entries.find(s => s.id === e?.standardRef);
    if (!standard) continue;
    // An entity's evidence is the union of its own property/mapping evidence when the
    // provider omits only this redundant summary. Never repair an explicitly invalid ref.
    if (e.evidenceIds === undefined) {
      const refs = [...(Array.isArray(e.properties) ? e.properties.flatMap(p => p?.evidenceIds ?? []) : []),
        ...(Array.isArray(value.mappings) ? value.mappings.filter(m => m?.entityId === e.id).flatMap(m => m.evidenceIds ?? []) : [])];
      if (refs.length && refs.every(id => validEvidence.has(id))) e.evidenceIds = [...new Set(refs)];
    }
    e.id = standard.id; e.canonicalId = `cdm:7.0.0:${standard.id}`;
    e.name = `${labels[standard.id]} · ${standard.id}`; e.definition = standard.declaration;
    for (const p of e.properties ?? []) {
      const property = propertiesOf(pack.standards, standard.id).find(f => f.name === p.name);
      if (property) p.type = property.type;
    }
  }
  for (const r of value.relations) {
    const property = pack.standards.entries.flatMap(e => e.fields).find(f => f.id === r?.standardRef);
    if (!property) continue;
    r.id = property.id; r.canonicalId = `cdm:7.0.0:${property.id}`;
    r.name = property.id; r.meaning = property.declaration;
  }
  // A real CDM property may point outside this deliberately selected type set.
  // Keep that proposal intact for inspection, but never admit it as an active relation.
  const selectedTypes = new Set(pack.standards.entries.map(e => e.id));
  const outside = value.relations.filter(r => {
    if (value.relations.filter(other => other?.id === r?.id).length !== 1) return false;
    const p = pack.standards.entries.flatMap(e => e.fields).find(f => f.id === r?.standardRef);
    const from = value.entities.find(e => e.id === r?.from);
    const validRefs = ids => Array.isArray(ids) && ids.length > 0 && ids.every(id => validEvidence.has(id));
    if (!p || !/^[A-Z]/.test(p.type) || selectedTypes.has(p.type) || r.to !== p.type || !from || !propertiesOf(pack.standards, from.standardRef).some(f => f.id === p.id) || !validRefs(r.evidenceIds)) return false;
    if (!['new', 'reuse', 'conflict'].includes(r.decision) || !['pending', 'aligned'].includes(r.alignment) || !['supported', 'needs_evidence'].includes(r.evidenceStatus) || typeof r.role !== 'string' || !r.role.trim() || !Array.isArray(r.questions) || r.questions.some(q => typeof q !== 'string')) return false;
    return (value.relationMappings ?? []).filter(m => m?.relationId === r.id).every(m => {
      const asset = pack.assets.find(a => a.id === m.assetId);
      return asset && ['fromField', 'toField'].every(k => typeof m[k] === 'string' && asset.fields.some(f => f.name.toLowerCase() === m[k].toLowerCase())) && validRefs(m.evidenceIds) && typeof m.scope === 'string' && m.scope.trim() && scopeMatches(m, pack);
    });
  });
  if (outside.length) {
    value.rejectedCandidates = [...(value.rejectedCandidates ?? []), ...outside.map(r => ({ kind: 'relation', item: r, mappings: (value.relationMappings ?? []).filter(m => m.relationId === r.id), reason: 'CDM 属性的目标类型不在本轮选定模型内；保留原建议，不能作为正式关系确认。' }))];
    const rejectedIds = new Set(outside.map(r => r.id));
    value.relations = value.relations.filter(r => !rejectedIds.has(r.id));
    if (Array.isArray(value.relationMappings)) value.relationMappings = value.relationMappings.filter(m => !rejectedIds.has(m.relationId));
  }
  value.validationDisposition = value.rejectedCandidates?.length ? 'partial_with_rejected_candidates' : 'structurally_valid_candidate';
  return value;
}

export function validatePilot(result, pack) {
  const errors = [];
  const refs = new Map(pack.standards.entries.flatMap(e => [[e.id, 'entity'], ...e.fields.map(f => [f.id, 'relation'])]));
  const ids = new Set();
  const scopeErrors = mapping => {
    if (!scopeMatches(mapping, pack)) errors.push('pilot: missing or mixed relationship type scope');
  };
  for (const [kind, items] of [['entity', result.entities], ['relation', result.relations]]) for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (!/^[a-zA-Z0-9_.:/-]{1,150}$/.test(item.canonicalId ?? '')) errors.push('pilot: stable canonicalId required');
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(item.id ?? '') || ids.has(`${kind}:${item.id}`)) errors.push('pilot: duplicate or missing item id');
    ids.add(`${kind}:${item.id}`);
    if (!['new', 'reuse', 'conflict'].includes(item.decision)) errors.push('pilot: invalid definition decision');
    if (!['pending', 'aligned'].includes(item.alignment)) errors.push('pilot: invalid CDM alignment');
    if (typeof item.standardRef !== 'string' || !item.standardRef || refs.get(item.standardRef) !== kind) errors.push('pilot: only CDM native types/properties are allowed');
    if (item.id !== item.standardRef || item.canonicalId !== `cdm:7.0.0:${item.standardRef}`) errors.push('pilot: identity must be the CDM identity');
    if (item.alignment === 'aligned' && !item.standardRef) errors.push('pilot: aligned requires CDM reference');
    if (!['supported', 'needs_evidence'].includes(item.evidenceStatus)) errors.push('pilot: evidence status required');
    if (!Array.isArray(item.questions) || item.questions.some(q => typeof q !== 'string')) errors.push('pilot: questions required');
    if (kind === 'relation' && (typeof item.role !== 'string' || !item.role.trim())) errors.push('pilot: relationship role required');
    if (kind === 'entity') {
      const fields = propertiesOf(pack.standards, item.standardRef);
      for (const property of item.properties ?? []) if (!fields.some(f => f.name === property?.name)) errors.push('pilot: property must exist in selected CDM type');
    } else {
      const property = pack.standards.entries.flatMap(e => e.fields).find(f => f.id === item.standardRef);
      const from = result.entities.find(e => e.id === item.from), to = result.entities.find(e => e.id === item.to);
      if (!property || !from || !to || !propertiesOf(pack.standards, from.standardRef).some(f => f.id === property.id) || to.standardRef !== property.type) errors.push('pilot: relation endpoints must match CDM property owner and target');
    }
  }
  if (!Array.isArray(result.relationMappings)) return [...errors, 'pilot: relationMappings required'];
  for (const m of result.mappings) {
    scopeErrors(m);
    if (m?.coverage !== 'partial') errors.push('pilot: only partial field mappings are supported without CDM instance validation');
    if (typeof m?.note !== 'string') errors.push('pilot: mapping note required');
  }
  for (const m of result.relationMappings) {
    scopeErrors(m);
    const asset = pack.assets.find(a => a.id === m?.assetId);
    const relation = result.relations.find(r => r?.id === m?.relationId);
    const fields = new Set(asset?.fields.map(f => f.name.toLowerCase()));
    if (!asset || !relation || !fields.has(m?.fromField?.toLowerCase()) || !fields.has(m?.toField?.toLowerCase())) errors.push('pilot: unknown relation mapping endpoint field');
    if (typeof m?.scope !== 'string' || !m.scope.trim()) errors.push('pilot: relation scope required');
    if (!Array.isArray(m?.evidenceIds) || !m.evidenceIds.length || m.evidenceIds.some(id => !pack.evidence.some(e => e.id === id))) errors.push('pilot: invalid relation mapping evidence');
  }
  if (!Array.isArray(result.unmappedRelations)) errors.push('pilot: unmappedRelations required');
  for (const m of result.unmappedRelations ?? []) {
    scopeErrors(m);
    const asset = pack.assets.find(a => a.id === m?.assetId);
    if (!m || typeof m.id !== 'string' || typeof m.reason !== 'string' || !m.reason.trim() || !asset || !['fromField', 'toField'].every(k => typeof m[k] === 'string' && asset.fields.some(f => f.name.toLowerCase() === m[k].toLowerCase()))) errors.push('pilot: invalid unmapped evidence');
    if (!Array.isArray(m?.evidenceIds) || !m.evidenceIds.length || m.evidenceIds.some(id => !pack.evidence.some(e => e.id === id))) errors.push('pilot: unmapped evidence references required');
    if (typeof m?.scope !== 'string' || !m.scope.trim()) errors.push('pilot: unmapped evidence scope required');
  }
  return errors;
}
