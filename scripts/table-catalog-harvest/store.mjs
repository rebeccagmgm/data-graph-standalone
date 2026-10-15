import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const clean = value => String(value ?? '').replace(/<[^>]+>/g, '');
export function parentDatabase(qualifiedName) {
  if(typeof qualifiedName!=='string') return null;
  const at=qualifiedName.lastIndexOf('@');
  const dot=qualifiedName.lastIndexOf('.',at>=0?at:qualifiedName.length);
  return dot>=0 ? qualifiedName.slice(0,dot)+(at>=0?qualifiedName.slice(at):'') : null;
}

export function validatePage(data, page, size) {
  if (!data || !Array.isArray(data.records) || !Number.isSafeInteger(data.totalResultNum)
      || data.totalResultNum < 0 || data.pageNo !== page || data.pageSize !== size) {
    throw new Error('INVALID_PAGE_ENVELOPE');
  }
  if (page * size > 10000) throw new Error('RESULT_WINDOW_EXCEEDED');
  const expected = Math.min(size, Math.max(0, data.totalResultNum - (page - 1) * size));
  if (data.records.length !== expected) throw new Error('PAGE_LENGTH_MISMATCH');
  const ids = data.records.map(row => row.guid);
  if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('INVALID_OR_DUPLICATE_GUID');
  }
  return digest(ids);
}

export class Store {
  constructor(path, config) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS run (id INTEGER PRIMARY KEY CHECK(id=1), config_hash TEXT, config_json TEXT,
        status TEXT NOT NULL, started_at TEXT, updated_at TEXT, error_code TEXT);
      CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL, query_json TEXT NOT NULL, priority INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'PENDING',
        total INTEGER, next_page INTEGER NOT NULL DEFAULT 1, first_hash TEXT, error_code TEXT, verified_at TEXT);
      CREATE TABLE IF NOT EXISTS pages (group_id TEXT REFERENCES groups(id), page INTEGER, received_at TEXT,
        row_count INTEGER, ids_hash TEXT, response_json TEXT NOT NULL, PRIMARY KEY(group_id,page));
      CREATE TABLE IF NOT EXISTS assets (guid TEXT PRIMARY KEY, name TEXT, database_name TEXT, qualified_name TEXT,
        metadata_type TEXT, first_seen TEXT, last_seen TEXT, raw_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (group_id TEXT REFERENCES groups(id), guid TEXT REFERENCES assets(guid),
        page INTEGER, PRIMARY KEY(group_id,guid));
      CREATE TABLE IF NOT EXISTS observed_classifications (guid TEXT REFERENCES assets(guid), path TEXT,
        category TEXT, first_seen TEXT, last_seen TEXT, PRIMARY KEY(guid,path));
      CREATE TABLE IF NOT EXISTS databases (guid TEXT PRIMARY KEY, name TEXT, qualified_name TEXT, raw_json TEXT);
      CREATE TABLE IF NOT EXISTS database_memberships (group_id TEXT REFERENCES groups(id), guid TEXT REFERENCES databases(guid),
        page INTEGER, PRIMARY KEY(group_id,guid));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, detail_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memberships_guid ON memberships(guid);
      CREATE INDEX IF NOT EXISTS groups_scope ON groups(scope);
      CREATE INDEX IF NOT EXISTS classification_path ON observed_classifications(path);
      CREATE VIEW IF NOT EXISTS union_tables AS SELECT * FROM assets;
      CREATE VIEW IF NOT EXISTS table_sources AS SELECT DISTINCT m.guid,g.scope FROM memberships m JOIN groups g ON g.id=m.group_id;`);
    const prior = this.db.prepare('SELECT * FROM run WHERE id=1').get();
    if (prior && prior.config_hash !== digest(config)) throw new Error('CONFIG_CHANGED_USE_NEW_OUTPUT');
    if (!prior) this.db.prepare('INSERT INTO run VALUES(1,?,?,?, ?,?,NULL)').run(
      digest(config), JSON.stringify(config), 'CREATED', new Date().toISOString(), new Date().toISOString());
  }
  close() { this.db.close(); }
  event(kind, detail) {
    this.db.prepare('INSERT INTO events(at,kind,detail_json) VALUES(?,?,?)').run(new Date().toISOString(), kind, JSON.stringify(detail));
  }
  setRun(status, error = null) {
    this.db.prepare('UPDATE run SET status=?,error_code=?,updated_at=? WHERE id=1').run(status, error, new Date().toISOString());
  }
  addGroup(group) {
    this.db.prepare('INSERT OR IGNORE INTO groups(id,scope,name,kind,query_json,priority) VALUES(?,?,?,?,?,?)')
      .run(group.id, group.scope, group.name, group.kind, JSON.stringify(group.query), group.priority);
  }
  getGroup(id) { return this.db.prepare('SELECT * FROM groups WHERE id=?').get(id); }
  updateGroup(id, state, error = null) {
    this.db.prepare('UPDATE groups SET state=?,error_code=? WHERE id=?').run(state, error, id);
  }
  nextGroup() { return this.db.prepare("SELECT * FROM groups WHERE state IN ('PENDING','COLLECTING','VERIFYING') ORDER BY priority,id LIMIT 1").get(); }
  scopeCount(scope) {
    return this.db.prepare('SELECT count(DISTINCT m.guid) n FROM memberships m JOIN groups g ON g.id=m.group_id WHERE g.scope=?').get(scope).n;
  }
  groupCount(group) {
    const table = group.kind === 'INVENTORY' ? 'database_memberships' : 'memberships';
    return this.db.prepare(`SELECT count(*) n FROM ${table} WHERE group_id=?`).get(group.id).n;
  }
  savePage(group, data, page, size) {
    const idsHash = validatePage(data, page, size);
    const current = this.getGroup(group.id);
    if (current.total !== null && current.total !== data.totalResultNum) throw new Error('TOTAL_CHANGED_DURING_GROUP');
    const inventory = group.kind === 'INVENTORY';
    const membershipTable = inventory ? 'database_memberships' : 'memberships';
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of data.records) {
        if (this.db.prepare(`SELECT 1 FROM ${membershipTable} WHERE group_id=? AND guid=?`).get(group.id,row.guid)) {
          throw new Error('DUPLICATE_ACROSS_PAGES');
        }
        if (row.metadataType !== (inventory ? '002000' : '003000')) throw new Error('ASSET_TYPE_MISMATCH');
        if (!inventory) {
          const query = JSON.parse(group.query_json);
          if(query.dataBaseIds?.length && !query.dataBaseIds.includes(row.parentQualifiedName || parentDatabase(row.qualifiedName))) {
            throw new Error('DATABASE_SCOPE_MISMATCH');
          }
          const paths = query.classifications || [];
          if (!query.extraDatabaseId && paths.length && !paths.some(path =>
            (row.classificationList || []).some(tag => tag === path || tag.startsWith(path + '_')))) {
            throw new Error('CLASSIFICATION_SCOPE_MISMATCH');
          }
          const previous = this.db.prepare('SELECT qualified_name FROM assets WHERE guid=?').get(row.guid);
          if (previous?.qualified_name && row.qualifiedName && previous.qualified_name !== row.qualifiedName) {
            throw new Error('GUID_PHYSICAL_IDENTITY_CHANGED');
          }
          this.db.prepare(`INSERT INTO assets VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(guid) DO UPDATE SET
            name=excluded.name,database_name=excluded.database_name,last_seen=excluded.last_seen,raw_json=excluded.raw_json`)
            .run(row.guid,clean(row.name),clean(row.dbName),row.qualifiedName || '',row.metadataType,now,now,JSON.stringify(row));
          for (const path of row.classificationList || []) {
            if (typeof path !== 'string' || !path) throw new Error('INVALID_CLASSIFICATION');
            this.db.prepare(`INSERT INTO observed_classifications VALUES(?,?,?,?,?) ON CONFLICT(guid,path) DO UPDATE SET last_seen=excluded.last_seen`)
              .run(row.guid,path,path.split('_')[0],now,now);
          }
        } else {
          this.db.prepare('INSERT OR REPLACE INTO databases VALUES(?,?,?,?)')
            .run(row.guid,clean(row.name),row.qualifiedName || '',JSON.stringify(row));
        }
        this.db.prepare(`INSERT INTO ${membershipTable} VALUES(?,?,?)`).run(group.id,row.guid,page);
      }
      this.db.prepare('INSERT INTO pages VALUES(?,?,?,?,?,?)').run(group.id,page,now,data.records.length,idsHash,JSON.stringify(data));
      const done = page * size >= data.totalResultNum;
      this.db.prepare('UPDATE groups SET total=?,next_page=?,first_hash=coalesce(first_hash,?),state=? WHERE id=?')
        .run(data.totalResultNum,page+1,idsHash,done ? 'VERIFYING' : 'COLLECTING',group.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return idsHash;
  }
  verifyGroup(group, data, size) {
    const hash = validatePage(data,1,size);
    if (data.totalResultNum !== group.total || hash !== group.first_hash) throw new Error('FIRST_PAGE_OR_TOTAL_CHANGED');
    if (this.groupCount(group) !== group.total) throw new Error('UNIQUE_COUNT_MISMATCH');
    this.db.prepare("UPDATE groups SET state='COMPLETE',verified_at=? WHERE id=?").run(new Date().toISOString(),group.id);
  }
  summary() {
    const run = this.db.prepare('SELECT status,started_at,updated_at,error_code FROM run WHERE id=1').get();
    return {...run, uniqueTables:this.db.prepare('SELECT count(*) n FROM assets').get().n,
      databaseObjects:this.db.prepare('SELECT count(*) n FROM databases').get().n,
      classificationLinks:this.db.prepare('SELECT count(*) n FROM observed_classifications').get().n,
      savedPages:this.db.prepare('SELECT count(*) n FROM pages').get().n,
      groupStates:this.db.prepare('SELECT state,count(*) count FROM groups GROUP BY state').all(),
      active:this.db.prepare("SELECT name,state,total,next_page,error_code FROM groups WHERE state IN ('COLLECTING','VERIFYING') LIMIT 3").all(),
      scopes:this.db.prepare("SELECT id,name,state,total,error_code FROM groups WHERE kind='ROOT' ORDER BY priority,id").all().map(g=>({...g,uniqueTables:this.scopeCount(g.id)}))};
  }
}
