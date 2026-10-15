import { fingerprint, sanitize } from './common.mjs';
import { normalizePilot, definitionOf, PILOT } from './pilot.mjs';
import { validateResult } from './model.mjs';

export const revision = state => state.db.prepare('SELECT revision FROM pilot_meta WHERE id=1').get().revision;
export function revalidatePilot(state) {
  const changed = [];
  for (const item of state.items().filter(i => i.current && i.pilot && i.status === 'invalid' && i.result)) {
    const attempt = state.attempt(item.attemptId);
    if (!attempt.charged) continue;
    const result = normalizePilot(item.result, state.pack(item.hash));
    const errors = validateResult(result, state.pack(item.hash));
    if (errors.length) { changed.push({ id: item.id, status: 'invalid', errors }); continue; }
    state.db.exec('BEGIN IMMEDIATE');
    try {
      state.db.prepare('INSERT INTO validation_history(attempt_id,old_status,old_result,old_error,new_result,created) VALUES(?,?,?,?,?,?)').run(attempt.id, attempt.status, attempt.result_json, attempt.error, JSON.stringify(result), new Date().toISOString());
      state.finish(attempt.id, { status: 'success', usage: JSON.parse(attempt.usage_json), result });
      state.db.exec('COMMIT');
      changed.push({ id: item.id, status: 'success', offlineValidationOnly: true });
    } catch (e) { state.db.exec('ROLLBACK'); throw e; }
  }
  return changed;
}
export function reviews(state, attemptId) {
  return state.db.prepare('SELECT * FROM pilot_reviews WHERE attempt_id=?').all(attemptId).map(r => ({ ...r, body: JSON.parse(r.body) }));
}
export function reviewedResult(state, item) {
  const result = structuredClone(item.result);
  if (!result || !item.pilot) return result;
  for (const r of reviews(state, item.attemptId)) {
    const collection = r.kind === 'entity' ? 'entities' : 'relations';
    result[collection] = result[collection].map(v => v.id === r.item_id ? r.body.item : v);
    const mappingKey = r.kind === 'entity' ? 'mappings' : 'relationMappings';
    const idKey = r.kind === 'entity' ? 'entityId' : 'relationId';
    result[mappingKey] = [...result[mappingKey].filter(m => m[idKey] !== r.item_id), ...r.body.mappings];
  }
  return result;
}
export function sharedContext(state, pack) {
  const confirmed = [], candidates = [];
  for (const item of state.items().filter(i => i.current && i.pilot && i.status === 'success' && i.id !== pack.id)) {
    const result = reviewedResult(state, item), saved = reviews(state, item.attemptId);
    for (const r of saved.filter(r => r.status === 'accepted')) confirmed.push({ source: item.id, product: item.pilot.product, ...r.body });
    // Only earlier pilot steps; old generic extraction is never an input to the CDM workflow.
    if (item.pilot.order < pack.pilot.order) candidates.push({ source: item.id, product: item.pilot.product, status: 'UNCONFIRMED', entities: result.entities.map(e => ({ id: e.id, standardRef: e.standardRef, questions: e.questions })), mappings: result.mappings, relationMappings: result.relationMappings, unmappedRelations: result.unmappedRelations });
  }
  return { policy: 'CDM_NATIVE_ONLY', confirmed, candidates };
}

export function saveItemReview(state, input) {
  if (!input || !['entity', 'relation'].includes(input.kind) || !['draft', 'accepted', 'needs_evidence'].includes(input.status)) throw Error('INVALID_ITEM_REVIEW');
  if (typeof input.reason !== 'string' || input.reason.length > 3000) throw Error('INVALID_REVIEW_REASON');
  const attempt = state.attempt(input.attemptId);
  const current = state.items().find(i => i.current && i.attemptId === input.attemptId);
  if (!attempt || attempt.status !== 'success' || !current?.pilot) throw Error('CURRENT_PILOT_RESULT_REQUIRED');
  const pack = state.pack(attempt.pack_hash), result = reviewedResult(state, current);
  const collection = input.kind === 'entity' ? 'entities' : 'relations';
  const old = result[collection].find(i => i.id === input.item?.id);
  if (!old || old.standardRef !== input.item.standardRef || !Array.isArray(input.mappings)) throw Error('CDM_DEFINITION_IS_READ_ONLY');
  const mappingKey = input.kind === 'entity' ? 'mappings' : 'relationMappings';
  const idKey = input.kind === 'entity' ? 'entityId' : 'relationId';
  if (input.mappings.some(m => m?.[idKey] !== old.id)) throw Error('MAPPING_ITEM_MISMATCH');
  result[collection] = result[collection].map(i => i.id === old.id ? sanitize(input.item) : i);
  result[mappingKey] = [...result[mappingKey].filter(m => m[idKey] !== old.id), ...sanitize(input.mappings)];
  const normalized = normalizePilot(result, pack);
  const errors = validateResult(normalized, pack);
  if (errors.length) throw Error(`INVALID_MAPPING:${errors.join('; ')}`);
  const item = normalized[collection].find(i => i.id === old.id);
  const mappings = normalized[mappingKey].filter(m => m[idKey] === old.id);
  if (input.status === 'accepted') {
    if (!mappings.length || item.evidenceStatus !== 'supported' || item.questions.length || item.decision === 'conflict') throw Error('RESOLVE_EVIDENCE_QUESTIONS_BEFORE_ACCEPTING');
    if (mappings.some(m => !m.scope.trim() || pack.assets.find(a => a.id === m.assetId)?.identityStatus !== 'unique_metadata_match_not_graph_verified')) throw Error('MAPPING_SCOPE_OR_ASSET_UNRESOLVED');
    if (input.kind === 'entity' && mappings.some(m => !m.fields.length)) throw Error('FIELD_MAPPING_REQUIRED');
    if (input.kind === 'relation') {
      const accepted = new Set(reviews(state, input.attemptId).filter(r => r.kind === 'entity' && r.status === 'accepted').map(r => r.item_id));
      if (!accepted.has(item.from) || !accepted.has(item.to)) throw Error('CONFIRM_ENDPOINT_MAPPINGS_FIRST');
    }
  }
  const original = JSON.parse(attempt.result_json);
  const originalBundle = { item: original[collection].find(i => i.id === item.id), mappings: original[mappingKey].filter(m => m[idKey] === item.id) };
  const body = { item, mappings }, modified = Number(fingerprint(body) !== fingerprint(originalBundle));
  if ((modified || input.status === 'needs_evidence') && !input.reason.trim()) throw Error('REVIEW_REASON_REQUIRED');
  const now = new Date().toISOString(), encoded = JSON.stringify(body);
  state.db.exec('BEGIN IMMEDIATE');
  try {
    if (input.revision !== revision(state)) throw Error('REVIEW_CHANGED_REFRESH_REQUIRED');
    state.db.prepare('INSERT INTO pilot_reviews VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id,kind,item_id) DO UPDATE SET status=excluded.status,body=excluded.body,reason=excluded.reason,modified=excluded.modified,updated=excluded.updated')
      .run(input.attemptId, input.kind, item.id, input.status, encoded, input.reason, modified, now);
    state.db.prepare('INSERT INTO pilot_review_history(attempt_id,kind,item_id,status,body,reason,modified,updated) VALUES(?,?,?,?,?,?,?,?)')
      .run(input.attemptId, input.kind, item.id, input.status, encoded, input.reason, modified, now);
    // Endpoint edits withdraw dependent relationship approval; they are never silently carried forward.
    if (input.kind === 'entity') {
      const affected = state.db.prepare("SELECT * FROM pilot_reviews WHERE attempt_id=? AND kind='relation' AND status='accepted' AND (json_extract(body,'$.item.from')=? OR json_extract(body,'$.item.to')=?)").all(input.attemptId, item.id, item.id);
      for (const r of affected) {
        const reason = `系统撤回：端点 ${item.id} 的审核记录发生变化，需要复核关系映射`;
        state.db.prepare("UPDATE pilot_reviews SET status='draft',reason=?,updated=? WHERE attempt_id=? AND kind='relation' AND item_id=?").run(reason, now, input.attemptId, r.item_id);
        state.db.prepare('INSERT INTO pilot_review_history(attempt_id,kind,item_id,status,body,reason,modified,updated) VALUES(?,?,?,?,?,?,?,?)').run(input.attemptId, 'relation', r.item_id, 'draft', r.body, reason, r.modified, now);
      }
    }
    state.db.prepare('UPDATE pilot_meta SET revision=revision+1 WHERE id=1').run();
    state.db.exec('COMMIT');
  } catch (e) { state.db.exec('ROLLBACK'); throw e; }
  return { revision: revision(state) };
}

export function pilotReport(state) {
  const items = state.items().filter(i => i.current && i.pilot).map(i => ({ ...i, result: reviewedResult(state, i), reviews: reviews(state, i.attemptId),
    blockingAttempt: state.unresolvedPilot(i.id)[0] ?? null }));
  const accepted = items.flatMap(i => i.reviews.filter(r => r.status === 'accepted').map(r => ({ ...r, source: i.id, product: i.pilot.product })));
  const registry = new Map();
  for (const r of accepted) {
    const id = r.body.item.canonicalId;
    if (!registry.has(id)) registry.set(id, { id, ...definitionOf(r.kind, r.body.item), bindings: [] });
    registry.get(id).bindings.push({ source: r.source, product: r.product, attemptId: r.attempt_id, alignment: r.body.item.alignment, evidenceStatus: r.body.item.evidenceStatus, mappings: r.body.mappings });
  }
  const allReviews = items.flatMap(i => i.reviews);
  return { mode: 'CDM_NATIVE_ONLY', revision: revision(state), manifest: PILOT, items, registry: [...registry.values()],
    summary: { prepared: items.length, completed: items.filter(i => i.status === 'success').length, accepted: accepted.length,
      acceptedUnchanged: accepted.filter(r => !r.modified).length, acceptedEdited: accepted.filter(r => r.modified).length,
      returned: allReviews.filter(r => r.status === 'needs_evidence').length, drafts: allReviews.filter(r => r.status === 'draft').length,
      reusedAcrossProducts: [...registry.values()].filter(d => d.bindings.some(b => b.product === '期权') && d.bindings.some(b => b.product === '互换')).length,
      unmappedRelations: items.reduce((n, i) => n + (i.result?.unmappedRelations?.length ?? 0), 0),
      rejectedCandidates: items.reduce((n, i) => n + (i.result?.rejectedCandidates?.length ?? 0), 0),
      evidence: items.map(i => { const p = state.pack(i.hash); return { id: i.id, graphTasks: p.evidence.filter(e => e.kind === 'graph_bindings').length, sqlTasks: p.evidence.filter(e => e.kind === 'sql_excerpt').length, gaps: p.gaps, coverage: p.coverage }; }),
      reviewReasons: allReviews.filter(r => r.reason).map(r => ({ status: r.status, item: r.item_id, reason: r.reason })),
      businessAccuracy: 'not_measured_until_human_review', instanceValidation: 'not_performed' } };
}
