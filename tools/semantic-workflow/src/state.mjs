import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class State {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS packs(hash TEXT PRIMARY KEY,id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS current_packs(id TEXT PRIMARY KEY,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,pack_hash TEXT NOT NULL,status TEXT NOT NULL,reserved INTEGER NOT NULL,charged INTEGER,usage_json TEXT,result_json TEXT,error TEXT,created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempt_request ON attempts(request_hash,created);
      CREATE TABLE IF NOT EXISTS reviews(attempt_id TEXT PRIMARY KEY,status TEXT NOT NULL,body TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_history(id INTEGER PRIMARY KEY,attempt_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pilot_reviews(attempt_id TEXT NOT NULL,kind TEXT NOT NULL,item_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,reason TEXT NOT NULL,modified INTEGER NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(attempt_id,kind,item_id));
      CREATE TABLE IF NOT EXISTS pilot_review_history(id INTEGER PRIMARY KEY,attempt_id TEXT NOT NULL,kind TEXT NOT NULL,item_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,reason TEXT NOT NULL,modified INTEGER NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pilot_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO pilot_meta VALUES(1,0);
      CREATE TABLE IF NOT EXISTS attempt_context(attempt_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempt_retries(original_attempt_id TEXT PRIMARY KEY,replacement_attempt_id TEXT NOT NULL,authorized_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS validation_history(id INTEGER PRIMARY KEY,attempt_id TEXT NOT NULL,old_status TEXT NOT NULL,old_result TEXT,old_error TEXT,new_result TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_repairs(base_request_hash TEXT PRIMARY KEY,repair_request_hash TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  savePack(pack) {
    this.db.prepare('INSERT OR IGNORE INTO packs VALUES(?,?,?,?,?)').run(pack.hash, pack.id, pack.title, JSON.stringify(pack), new Date().toISOString());
    this.db.prepare('INSERT INTO current_packs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash').run(pack.id, pack.hash);
  }
  packs() { return this.db.prepare('SELECT p.body FROM current_packs c JOIN packs p ON c.hash=p.hash ORDER BY p.id').all().map(r => JSON.parse(r.body)); }
  pack(hash) { const row = this.db.prepare('SELECT body FROM packs WHERE hash=?').get(hash); return row && JSON.parse(row.body); }
  cached(hash) { return this.db.prepare('SELECT * FROM attempts WHERE request_hash=? ORDER BY created DESC,rowid DESC LIMIT 1').get(hash); }
  usage() {
    const row = this.db.prepare('SELECT count(*) calls, coalesce(sum(coalesce(charged,reserved)),0) accountedTokens,coalesce(sum(charged),0) reportedTokens,coalesce(sum(CASE WHEN charged IS NULL THEN reserved ELSE 0 END),0) uncertainReservedTokens FROM attempts').get();
    return { ...row, statuses: this.db.prepare('SELECT status,count(*) count FROM attempts GROUP BY status').all() };
  }
  reserve(requestHash, packHash, tokens, limit) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.usage().accountedTokens + tokens > limit) throw Error('BUDGET_LIMIT');
      const id = randomUUID();
      this.db.prepare('INSERT INTO attempts(id,request_hash,pack_hash,status,reserved,created) VALUES(?,?,?,?,?,?)').run(id, requestHash, packHash, 'inflight', tokens, new Date().toISOString());
      this.db.exec('COMMIT'); return id;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  finish(id, { status, usage = null, result = null, error = null }) {
    this.db.prepare('UPDATE attempts SET status=?,charged=?,usage_json=?,result_json=?,error=? WHERE id=?').run(status, usage?.total_tokens ?? null, usage ? JSON.stringify(usage) : null, result ? JSON.stringify(result) : null, error, id);
  }
  attempt(id) { return this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id); }
  unresolvedPilot(id) {
    return this.db.prepare("SELECT a.id,a.status,a.created FROM attempts a JOIN packs p ON p.hash=a.pack_hash LEFT JOIN attempt_retries retry ON retry.original_attempt_id=a.id WHERE p.id=? AND json_extract(p.body,'$.pilot') IS NOT NULL AND a.status IN ('uncertain','inflight') AND retry.original_attempt_id IS NULL ORDER BY a.rowid DESC").all(id);
  }
  review(id, status, result) {
    const a = this.attempt(id);
    if (!a || a.status !== 'success') throw Error('RESULT_NOT_REVIEWABLE');
    if (!['draft', 'accepted', 'rejected'].includes(status)) throw Error('INVALID_REVIEW_STATUS');
    const body = JSON.stringify(result), now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO reviews VALUES(?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET status=excluded.status,body=excluded.body,updated=excluded.updated').run(id, status, body, now);
      this.db.prepare('INSERT INTO review_history(attempt_id,status,body,updated) VALUES(?,?,?,?)').run(id, status, body, now);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  items() {
    return this.db.prepare(`SELECT p.hash,p.id,p.title,p.body pack_body,c.hash current_hash,a.id attempt_id,a.status,a.result_json,a.error,r.status review_status,r.body review_body
      FROM packs p LEFT JOIN current_packs c ON p.id=c.id
      LEFT JOIN attempts a ON a.id=(SELECT b.id FROM attempts b LEFT JOIN reviews br ON br.attempt_id=b.id WHERE b.pack_hash=p.hash ORDER BY (br.attempt_id IS NOT NULL OR EXISTS(SELECT 1 FROM pilot_reviews pr WHERE pr.attempt_id=b.id)) DESC,br.updated DESC,b.rowid DESC LIMIT 1)
      LEFT JOIN reviews r ON r.attempt_id=a.id ORDER BY p.id,p.created DESC`).all().map(r => ({
        id: r.id, hash: r.hash, title: r.title, current: r.current_hash === r.hash,
        attemptId: r.attempt_id, status: r.status ?? 'prepared', error: r.error,
        reviewStatus: r.review_status ?? 'pending',
        pilot: JSON.parse(r.pack_body).pilot ?? null,
        result: r.review_body || r.result_json ? JSON.parse(r.review_body ?? r.result_json) : null,
      }));
  }
}
