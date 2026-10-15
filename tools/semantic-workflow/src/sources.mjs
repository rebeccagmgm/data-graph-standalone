import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, basename } from 'node:path';
import { readJson, fingerprint, sanitize, fetchJson, within } from './common.mjs';
import { focusField, selectFields, sqlWindows, loadStandards } from './pilot.mjs';

const pick = (value, keys) => Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
export function tableNames(value) {
  const strings = [];
  function collect(v) { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === 'object') Object.values(v).forEach(collect); }
  collect(value);
  return [...new Set(strings.flatMap(s => s.match(/\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/gi) ?? []).map(s => s.toLowerCase()))];
}
const taskIds = value => [...new Set(JSON.stringify(value).match(/\b\d{5,7}\b/g) ?? [])];

export function readSeeds(cfg) {
  const seeds = [];
  for (const source of cfg.sources) {
    const data = readJson(resolve(cfg.repositoryRoot, source.path));
    if (!['models', 'interfaces'].includes(source.kind)) throw Error('UNKNOWN_SEED_SOURCE');
    const rows = source.kind === 'models' ? data.main : data.interfaces;
    if (!Array.isArray(rows)) throw Error('INVALID_SEED_ROWS');
    for (const row of rows) {
      const model = source.kind === 'models';
      const content = pick(row, model ? ['id', 'topic', 'category', 'nature', 'content', 'system', 'native', 'landing', 'model', 'partition', 'process', 'tasks', 'note'] : ['id', 'table', 'name', 'theme', 'inputs', 'producerIds', 'pushIds', 'targets', 'sourceTags', 'processing', 'label', 'infoScope', 'traceStatus', 'comment']);
      seeds.push({
        id: `${source.kind}:${row.id}`, sourceId: row.id, title: String(model ? row.content : row.name),
        group: String(model ? row.category : row.theme), kind: source.kind, content,
        tableNames: tableNames(model ? [row.model, row.landing] : [row.table, row.targets, row.inputs]),
        taskIds: taskIds(model ? row.tasks : [row.producerIds?.[0], row.pushIds?.[0], row.producerIds, row.pushIds]),
        source: source.path,
      });
    }
  }
  return seeds;
}

export function selectSeeds(seeds, { ids = [], limit = 20, query = '' } = {}) {
  let selected = seeds.filter(s => (!ids.length || ids.includes(s.id) || ids.includes(s.sourceId)) && (!query || JSON.stringify(s.content).toLowerCase().includes(query.toLowerCase())));
  if (ids.length) {
    const missing = ids.filter(id => !selected.some(s => s.id === id || s.sourceId === id));
    if (missing.length) throw Error(`SEED_NOT_FOUND:${missing.join(',')}`);
  }
  // Rotate across business groups instead of taking the first N records.
  const groups = new Map();
  for (const s of selected) { const key = `${s.kind}:${s.group}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(s); }
  selected = [];
  while (selected.length < limit && [...groups.values()].some(g => g.length)) {
    for (const group of groups.values()) if (group.length && selected.length < limit) selected.push(group.shift());
  }
  return selected;
}

function documents(roots) {
  const files = [];
  function visit(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !['his', '证据', 'node_modules'].includes(entry.name)) visit(join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '未命名.md') {
        const path = join(dir, entry.name), text = readFileSync(path, 'utf8');
        for (const [index, part] of text.split(/(?=^#{1,3} )/m).entries()) if (part.trim()) files.push({ path, index, text: part });
      }
    }
  }
  roots.forEach(visit); return files;
}

function readOnly(path) { const db = new DatabaseSync(path, { readOnly: true }); db.exec('PRAGMA query_only=ON'); return db; }
export class Sources {
  constructor(cfg, { graph = true } = {}) {
    this.cfg = cfg; this.useGraph = graph; this.graphVersion = null; this.graphGap = null;
    this.docs = documents(cfg.documentRoots.map(p => resolve(cfg.repositoryRoot, p)));
    const root = resolve(cfg.repositoryRoot, cfg.metadataDirectory), current = readJson(join(root, 'current.json'));
    const dbPath = resolve(root, current.file);
    if (!within(root, dbPath)) throw Error('INVALID_METADATA_POINTER');
    this.metadataVersion = current.version;
    this.metadata = readOnly(dbPath);
    this.dictionary = readOnly(resolve(cfg.repositoryRoot, cfg.dictionaryDatabase));
    this.sql = readOnly(resolve(cfg.repositoryRoot, cfg.sqlDatabase));
    this.assetCache = new Map();
    this.cache = join(cfg.outputDirectory, 'graph-cache'); mkdirSync(this.cache, { recursive: true });
  }
  close() { this.metadata.close(); this.dictionary.close(); this.sql.close(); }
  async status() {
    if (!this.useGraph) { this.graphGap = '图谱查询未启用'; return; }
    try {
      const status = await fetchJson(new URL('/api/status', this.cfg.graphUrl));
      if (status.state !== 'READY' || !status.version) throw Error('GRAPH_NOT_READY');
      this.graphVersion = status.version;
    } catch { this.graphGap = '图谱不可用；本批仅使用离线快照，未获得当前图谱证据'; }
  }
  async verifyVersion() {
    if (!this.graphVersion) return;
    const status = await fetchJson(new URL('/api/status', this.cfg.graphUrl));
    if (status.version !== this.graphVersion || status.state !== 'READY') throw Error('GRAPH_CHANGED_DURING_PREPARE');
  }
  assets(name, focused = false) {
    const cacheKey = `${name}:${focused}`;
    if (this.assetCache.has(cacheKey)) return structuredClone(this.assetCache.get(cacheKey));
    const rows = this.metadata.prepare('SELECT id,stable_table_id,platform,data_source,qualified_name,description,collected_at,content_hash FROM tables WHERE lower(qualified_name)=? LIMIT 8').all(name);
    const assets = rows.map(r => {
      const count = this.metadata.prepare('SELECT count(*) n FROM fields WHERE table_id=?').get(r.id).n;
      const available = this.metadata.prepare('SELECT name,raw_type type,comment,is_partition partition FROM fields WHERE table_id=? ORDER BY ordinal').all(r.id);
      const fields = (focused ? selectFields(available, this.cfg.limits.fieldsPerAsset) : available.slice(0, this.cfg.limits.fieldsPerAsset)).map(f => ({ ...f, comment: f.comment?.slice(0, 180), commentTruncated: (f.comment?.length ?? 0) > 180 }));
      return {
        id: `asset-${fingerprint([r.platform, r.data_source, r.qualified_name]).slice(0, 16)}`,
        table: r.qualified_name, description: r.description, platform: r.platform,
        identityStatus: rows.length === 1 ? 'unique_metadata_match_not_graph_verified' : 'ambiguous_metadata_candidate',
        metadataVersion: this.metadataVersion, collectedAt: r.collected_at, sourceHash: r.content_hash,
        fields, omittedFields: count - fields.length,
      };
    });
    if (!assets.length) assets.push({ id: `asset-${fingerprint(name).slice(0, 16)}`, table: name, identityStatus: 'unresolved', fields: [], omittedFields: 0 });
    this.assetCache.set(cacheKey, assets); return structuredClone(assets);
  }
  async graphTask(id, focused = false) {
    const path = join(this.cache, `${fingerprint(['compact-v3', focused, this.graphVersion, this.metadataVersion, id, this.cfg.limits.graphBindingsPerTask])}.json`);
    if (existsSync(path)) return readJson(path);
    const url = new URL('/api/task', this.cfg.graphUrl); url.searchParams.set('taskId', id);
    const detail = await fetchJson(url);
    if (detail.version !== this.graphVersion) throw Error('GRAPH_VERSION_MISMATCH');
    const bindings = [...(detail.bindings ?? [])];
    if (focused) bindings.sort((a, b) => Number(focusField(b.column ?? '')) - Number(focusField(a.column ?? '')));
    const bindingLimit = focused ? 48 : this.cfg.limits.graphBindingsPerTask;
    const data = sanitize({ taskId: id, version: detail.version, coverage: detail.coverage, failureReason: detail.failureReason,
      bindings: bindings.slice(0, bindingLimit).map(b => ({
        ...pick(b, ['table', 'column', 'writeId', 'outputScope', 'sourceSpan']),
        expression: String(b.expression ?? '').slice(0, 350),
        expressionTruncated: (b.expression?.length ?? 0) > 350,
        inputFields: (b.inputFields ?? []).slice(0, 6).map(f => pick(f, ['table', 'column'])),
        omittedInputs: Math.max(0, (b.inputFields?.length ?? 0) - 6),
      })),
      omittedBindings: Math.max(0, bindings.length - bindingLimit),
      controls: (detail.controls ?? []).slice(0, focused ? 12 : 3),
      omittedControls: Math.max(0, (detail.controls?.length ?? 0) - (focused ? 12 : 3)),
    });
    writeFileSync(path, JSON.stringify(data)); return data;
  }
  async pack(seed, pilot = null) {
    const limits = this.cfg.limits;
    const gaps = [];
    const assetLimit = pilot ? 8 : 4, taskLimit = pilot ? 8 : limits.tasksPerPack;
    const assets = seed.tableNames.slice(0, assetLimit).flatMap(name => this.assets(name, !!pilot));
    if (seed.tableNames.length > assetLimit) gaps.push(`仅纳入 ${assetLimit} 个关联表名，另有 ${seed.tableNames.length - assetLimit} 个待补`);
    const evidence = [];
    const add = (kind, source, content, status = 'reference') => {
      const data = sanitize(content), hash = fingerprint(data);
      evidence.push({ id: `ev-${fingerprint([kind, source, hash]).slice(0, 16)}`, kind, source, content: data, status, hash });
    };
    add('curated_seed', `${seed.source}#${seed.sourceId}`, seed.content, 'authored_snapshot');
    for (const a of assets) {
      add('metadata', `${a.table}@${this.metadataVersion}`, { assetId: a.id, description: a.description, identityStatus: a.identityStatus, sourceHash: a.sourceHash, collectedAt: a.collectedAt, omittedFields: a.omittedFields }, 'offline_snapshot');
      if (a.identityStatus !== 'unique_metadata_match_not_graph_verified') gaps.push(`${a.table}: ${a.identityStatus}`);
      if (a.omittedFields) gaps.push(`${a.table}: ${a.omittedFields} 个字段未纳入`);
    }
    const domains = new Set();
    for (const a of assets) for (const f of a.fields) {
      for (const code of `${f.comment ?? ''} ${a.description ?? ''}`.match(/\bCD\d{3,5}\b/gi) ?? []) domains.add(code.toUpperCase());
    }
    const mentionedCodes = [...new Set(JSON.stringify(seed.content).match(/\b[A-Z]\d{2,4}\b/g) ?? [])];
    for (const domain of [...domains].slice(0, 3)) {
      const selectedCodes = mentionedCodes.length ? this.dictionary.prepare(`SELECT code_id,code_value,value_description,remark,source_table,business_date FROM code_values WHERE code_id=? AND code_value IN (${mentionedCodes.map(() => '?').join(',')}) LIMIT 12`).all(domain, ...mentionedCodes) : [];
      const rows = selectedCodes.length ? selectedCodes : this.dictionary.prepare('SELECT code_id,code_value,value_description,remark,source_table,business_date FROM code_values WHERE code_id=? ORDER BY code_value LIMIT 9').all(domain);
      add('dictionary', domain, { entries: rows.slice(0, 8), selection: selectedCodes.length ? 'codes_mentioned_in_seed' : 'bounded_sample_not_exhaustive', truncated: rows.length > 8 }, 'UNVERIFIED_SNAPSHOT');
    }
    const docTerms = seed.tableNames.map(t => t.split('.').at(-1));
    const chosenDocs = this.docs.map(d => ({ ...d, score: (docTerms.reduce((s, term, i) => s + (d.text.toLowerCase().includes(term) ? i === 0 ? 5 : 1 : 0), 0) + (pilot && d.path.includes(pilot.topic) ? 3 : 0)) / Math.sqrt(1 + d.text.length / 1000) * (/索引|去向|README|全貌/.test(basename(d.path)) ? 0.2 : 1) })).filter(d => d.score > 0).sort((a, b) => b.score - a.score).slice(0, pilot ? 4 : limits.documentsPerPack);
    for (const doc of chosenDocs) {
      const match = docTerms.map(term => doc.text.toLowerCase().indexOf(term)).find(index => index >= 0) ?? 0;
      const start = Math.max(0, match - 450);
      add('document', `${relative(this.cfg.repositoryRoot, doc.path).replaceAll('\\', '/')}#section-${doc.index}`, { startCharacter: start, excerpt: doc.text.slice(start, start + limits.documentChars), truncated: start > 0 || doc.text.length > limits.documentChars }, 'authored_snapshot');
    }
    if (this.graphGap) gaps.push(this.graphGap);
    for (const id of seed.taskIds.slice(0, taskLimit)) {
      if (this.graphVersion) {
        try {
          const graph = await this.graphTask(id, !!pilot);
          add('graph_bindings', `task:${id}@${this.graphVersion}`, graph, 'static_graph');
          if (pilot) {
            if (graph.omittedBindings || graph.omittedControls) gaps.push(`任务 ${id}: 图谱字段绑定或控制条件有省略`);
            // One hop only: supplement metadata for qualified direct field sources, never infer a business edge.
            const direct = [...new Set(graph.bindings.flatMap(b => b.inputFields.map(f => typeof f.table === 'string' ? f.table.toLowerCase() : '')).filter(t => /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/i.test(t)))];
            for (const table of direct) if (!assets.some(a => a.table.toLowerCase() === table)) {
              if (assets.length >= 12) { gaps.push(`直接来源元数据待补：${table}`); continue; }
              const extra = this.assets(table, true); assets.push(...extra);
              for (const a of extra) add('metadata', `${a.table}@${this.metadataVersion}`, { assetId: a.id, identityStatus: a.identityStatus, sourceHash: a.sourceHash, collectedAt: a.collectedAt, omittedFields: a.omittedFields, selection: 'one_hop_graph_input' }, 'offline_snapshot');
            }
          }
        }
        catch (e) { if (e.message === 'GRAPH_VERSION_MISMATCH') throw e; gaps.push(`任务 ${id} 图谱详情未取得`); }
      }
      const row = this.sql.prepare("SELECT evidence_type,payload_text,observed_at FROM evidence WHERE task_id=? AND format='sql' AND direction='' AND depth=0 ORDER BY evidence_type LIMIT 1").get(id);
      if (row?.payload_text) {
        const lines = row.payload_text.split(/\r?\n/);
        const first = Math.max(0, lines.findIndex(line => /^\s*(select|insert|with|create|merge|update)\b/i.test(line)));
        const sql = lines.slice(first).join('\n');
        const selected = pilot ? sqlWindows(row.payload_text, 10000, ['agt_id', 'rela_agt_id', 'key_otc_trade_id', 'key_capital_acct_id', 'pty_id', 'rela_type', 'business_date', 'seller']) : { lineStart: first + 1, excerpt: sql.slice(0, limits.sqlCharsPerTask), truncated: sql.length > limits.sqlCharsPerTask };
        add('sql_excerpt', `task:${id}/${row.evidence_type}`, { ...selected, sqlHash: fingerprint(row.payload_text), observedAt: row.observed_at, graphVersionAlignment: 'not_verified_against_graph_sql_hash' }, 'offline_snapshot');
        if (pilot && selected.truncated) gaps.push(`任务 ${id}: SQL 按关键字段选取窗口，条件完整性仍待核对`);
      } else gaps.push(`任务 ${id} 的本地 SQL 未收录`);
    }
    if (seed.taskIds.length > taskLimit) gaps.push(`还有 ${seed.taskIds.length - taskLimit} 个关联任务未纳入本包`);
    const pack = sanitize({ id: seed.id, title: pilot ? `${pilot.product} · ${pilot.topic}` : seed.title, sourceId: seed.sourceId, kind: seed.kind, group: seed.group, graphVersion: this.graphVersion, assets, evidence, gaps,
      ...(pilot ? { pilot, standards: loadStandards(this.cfg.repositoryRoot), coverage: { requestedTasks: seed.taskIds, includedTasks: seed.taskIds.slice(0, taskLimit), fieldSelection: 'identity_role_scope_first', followupDepth: 1, sqlGraphAlignment: 'unverified', instanceValidation: 'not_performed' } } : {}) });
    // Remove whole optional evidence records, never silently cut JSON or split a SQL claim.
    while (JSON.stringify(pack).length > (pilot ? limits.pilotMaxPackChars ?? limits.maxPackChars : limits.maxPackChars)) {
      // Pilot essentials must not be silently stripped. A larger packet requires an explicit local limit.
      if (pilot) throw Error(`PILOT_PACK_TOO_LARGE:${seed.id}:${JSON.stringify(pack).length}`);
      // Prefer one example of each kind over repeated large descriptions. Preserve graph evidence.
      const optional = ['document', 'sql_excerpt', 'dictionary', 'graph_bindings'];
      let index = -1;
      for (const kind of optional) {
        if (pack.evidence.filter(e => e.kind === kind).length > 1) { index = pack.evidence.findLastIndex(e => e.kind === kind); break; }
      }
      if (index < 0) index = pack.evidence.findLastIndex(e => e.kind === 'document');
      if (index < 0) index = pack.evidence.findLastIndex(e => e.kind === 'dictionary' && e.content.selection === 'bounded_sample_not_exhaustive');
      if (index < 0) {
        const asset = pack.assets.find(a => a.fields.length > 12);
        if (!asset) throw Error(`PACK_TOO_LARGE:${seed.id}`);
        const removed = asset.fields.splice(12); asset.omittedFields += removed.length;
        pack.gaps.push(`${asset.table}: 为控制输入额外省略 ${removed.length} 个字段`);
      } else {
        const [removed] = pack.evidence.splice(index, 1);
        pack.gaps.push(`输入上限：未纳入 ${removed.kind} ${removed.source}`);
      }
    }
    return { ...pack, hash: fingerprint(pack) };
  }
}
