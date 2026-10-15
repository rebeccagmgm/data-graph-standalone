import { openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchJson, fingerprint, sanitize } from './common.mjs';
import { requestFor, parseCompletion, validateResult, tokenUsage } from './model.mjs';
import { normalizePilot } from './pilot.mjs';
import { sharedContext, reviews } from './review.mjs';

export function chatEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('INVALID_API_ENDPOINT');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url;
}
export async function run(cfg, state, packs, { limit = 20, retryFailed = false, retryUncertain = false, log = () => {}, transport = fetchJson, env = process.env } = {}) {
  if (retryUncertain && (packs.length !== 1 || !packs[0].pilot)) throw Error('MANUAL_RETRY_REQUIRES_ONE_PILOT_ITEM');
  const endpoint = env[cfg.provider.endpointEnv], key = env[cfg.provider.apiKeyEnv];
  if (!endpoint || !key) throw Error('API_ENV_MISSING');
  const url = chatEndpoint(endpoint);
  const lock = join(cfg.outputDirectory, 'run.lock');
  let fd;
  try { fd = openSync(lock, 'wx'); } catch { throw Error('RUN_ALREADY_LOCKED: verify previous process before removing .local/run.lock'); }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  let dispatched = 0, skipped = 0, stopped = null;
  try {
    for (const pack of packs) {
      if (dispatched >= limit) break;
      const unresolved = pack.pilot ? state.unresolvedPilot(pack.id) : [];
      if (unresolved.length && (!retryUncertain || unresolved.some(a => a.status === 'inflight'))) { stopped = 'uncertain_call_requires_reconciliation'; log({ id: pack.id, event: stopped, attemptId: unresolved[0].id }); break; }
      const prior = pack.pilot && state.items().find(i => i.current && i.hash === pack.hash);
      if (prior?.attemptId && reviews(state, prior.attemptId).length) { skipped++; log({ id: pack.id, event: 'human_review_preserved' }); continue; }
      let context = pack.pilot ? sharedContext(state, pack) : null;
      let request = requestFor(pack, cfg, context), requestHash = fingerprint([url.href, request.hash]);
      const baseRequestHash = requestHash;
      const repair = pack.pilot && state.db.prepare('SELECT repair_request_hash FROM request_repairs WHERE base_request_hash=?').get(baseRequestHash);
      const previous = state.cached(repair?.repair_request_hash ?? requestHash);
      if (previous && !(previous.status === 'invalid' && retryFailed) && !(previous.status === 'uncertain' && retryUncertain)) { skipped++; log({ id: pack.id, event: 'cached_or_previous_attempt', status: previous.status }); continue; }
      if (pack.pilot && previous?.status === 'uncertain' && retryUncertain) {
        const saved = state.db.prepare('SELECT body FROM attempt_context WHERE attempt_id=?').get(previous.id);
        if (saved) {
          context = JSON.parse(saved.body);
          request = requestFor(pack, cfg, context); requestHash = fingerprint([url.href, request.hash]);
        }
      }
      if (pack.pilot && previous?.status === 'invalid' && retryFailed) {
        context = { ...context, correction: { attemptId: previous.id, errors: JSON.parse(previous.error ?? '{}').errors ?? ['invalid output'], result: previous.result_json ? JSON.parse(previous.result_json) : null } };
        request = requestFor(pack, cfg, context); requestHash = fingerprint([url.href, request.hash]);
      }
      let attempt;
      try { attempt = state.reserve(requestHash, pack.hash, request.reserveTokens, cfg.limits.totalTokens); }
      catch (e) { if (e.message === 'BUDGET_LIMIT') { stopped = 'budget'; break; } throw e; }
      if (context) state.db.prepare('INSERT INTO attempt_context VALUES(?,?)').run(attempt, JSON.stringify(context));
      if (context?.correction) state.db.prepare('INSERT INTO request_repairs VALUES(?,?) ON CONFLICT(base_request_hash) DO UPDATE SET repair_request_hash=excluded.repair_request_hash').run(baseRequestHash, requestHash);
      for (const old of unresolved) {
        state.db.prepare('INSERT INTO attempt_retries VALUES(?,?,?)').run(old.id, attempt, new Date().toISOString());
        log({ id: pack.id, event: 'explicit_user_retry', priorAttemptId: old.id, attemptId: attempt, priorReservationRetained: true });
      }
      dispatched++; log({ id: pack.id, event: 'request_started', reservedTokens: request.reserveTokens });
      let response;
      try {
        response = await transport(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(request.body) }, cfg.provider.timeoutMs);
      } catch (e) {
        // A timeout or HTTP error may still be billed. Never auto-replay an uncertain POST.
        const reason = /^HTTP_\d+$/.test(e.message) ? e.message : 'TRANSPORT_OR_RESPONSE_FAILURE';
        const code = e.cause?.code ?? e.code;
        const transportCode = typeof code === 'string' && /^[A-Z_]{3,60}$/.test(code) ? code : null;
        const errorName = ['TimeoutError', 'AbortError', 'TypeError', 'Error'].includes(e.name) ? e.name : 'Error';
        state.finish(attempt, { status: 'uncertain', error: JSON.stringify({ reason, transportCode, errorName, detail: e.providerDetail ?? null }) });
        log({ id: pack.id, event: 'uncertain', reason, transportCode, errorName, detail: e.providerDetail ?? null }); stopped = 'uncertain_call'; break;
      }
      const usage = tokenUsage(response);
      let result = null, errors = [];
      try { result = normalizePilot(sanitize(parseCompletion(response)), pack); errors = validateResult(result, pack); }
      catch (e) { errors = [e.message]; }
      const status = !usage ? 'uncertain' : errors.length ? 'invalid' : 'success';
      state.finish(attempt, { status, usage, result, error: !usage ? 'USAGE_MISSING' : errors.length ? JSON.stringify({ errors, diagnostics: response.diagnostics, outputPreview: sanitize(response.choices?.[0]?.message?.content ?? '').slice(0, 1800) }) : null });
      log({ id: pack.id, event: status, tokens: usage?.total_tokens ?? null, errors, diagnostics: response.diagnostics });
      if (status === 'invalid') { stopped = 'invalid_output'; break; }
      if (!usage || state.usage().accountedTokens >= cfg.limits.totalTokens || (usage && usage.total_tokens > request.reserveTokens)) { stopped = !usage ? 'usage_missing' : 'budget_or_reservation_exceeded'; break; }
    }
    return { dispatched, skipped, stopped, usage: state.usage() };
  } finally { closeSync(fd); unlinkSync(lock); }
}

export function exportModel(state) {
  const entities = new Map(), relations = [], mappings = [], classifications = [], conflicts = [], evidencePacks = [];
  for (const item of state.items().filter(i => i.current && i.reviewStatus === 'accepted' && i.result)) {
    const ids = new Map(), source = { packHash: item.hash, attemptId: item.attemptId };
    const pack = state.pack(item.hash);
    evidencePacks.push({ hash: pack.hash, assets: pack.assets, evidence: pack.evidence, graphVersion: pack.graphVersion, gaps: pack.gaps });
    for (const entity of item.result.entities) {
      const id = entity.canonicalId?.trim() || `${item.id}/${entity.id}`;
      ids.set(entity.id, id);
      const entitySource = { ...source, evidenceIds: entity.evidenceIds };
      const candidate = { ...entity, id, origins: [entitySource] };
      if (entities.has(id)) {
        const existing = entities.get(id);
        const comparable = e => ({ name: e.name, definition: e.definition, properties: e.properties.map(p => ({ name: p.name, type: p.type })) });
        if (fingerprint(comparable(existing)) !== fingerprint(comparable(candidate))) conflicts.push({ canonicalId: id, reason: '同一实体编号的定义或属性不同，需人工统一', origins: [...existing.origins, source] });
        existing.origins.push(entitySource);
      } else entities.set(id, candidate);
    }
    relations.push(...item.result.relations.map(r => ({ ...r, from: ids.get(r.from), to: ids.get(r.to), source })));
    mappings.push(...item.result.mappings.map(m => ({ ...m, entityId: ids.get(m.entityId), source })));
    classifications.push(...item.result.classifications.map(c => ({ ...c, entityId: ids.get(c.entityId), source })));
  }
  return { schemaVersion: 1, status: conflicts.length ? 'conflicts_require_review' : 'human_reviewed_reference', executable: false, entities: [...entities.values()], relations, mappings, classifications, conflicts, evidencePacks };
}
