import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const VERSION = 3;
const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => value == null || value === '-' ? null : String(value);

// Strict CSV state machine: quoted newlines and empty/leading-zero values survive.
export function parseCsv(input) {
  const rows = []; let row = []; let cell = ''; let quoted = false; let closed = false;
  input = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') { rows.push(row); row = []; if(c === '\r' && input[i+1] === '\n') i++; }
    } else if (c === '"' && !cell && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error('Invalid CSV quote'); cell += c; }
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  return rows;
}

function collect(config) {
  const files = [];
  for (const [kind, root] of [['indicator',config.indicatorDir],['tag',config.tagDir]]) {
    const required = kind === 'indicator' ? ['indicators.jsonl','indicator-sources.jsonl','catalog-tree.json'] : ['tag-dimensions.jsonl','dimension-details.jsonl','tag-values.jsonl','tag-value-dimension-links.jsonl','object-sources.jsonl','catalog-tree.json'];
    for (const name of new Set([...required.filter(n=>n!=='catalog-tree.json' || existsSync(join(root,n))), ...readdirSync(root).filter(n=>n.endsWith('manifest.json'))])) {
      const path = resolve(root,name); const bytes = readFileSync(path);
      files.push({kind,name,path,bytes,sha256:hash(bytes)});
    }
    if (!files.some(f=>f.kind===kind && f.name==='manifest.json')) throw new Error(`Missing ${kind} manifest`);
  }
  const bytes = readFileSync(config.codeCsv);
  files.push({kind:'code',name:basename(config.codeCsv),path:resolve(config.codeCsv),bytes,sha256:hash(bytes)});
  if (config.dataElementCsv) {
    const dataElementBytes = readFileSync(config.dataElementCsv);
    files.push({kind:'data_element',name:basename(config.dataElementCsv),path:resolve(config.dataElementCsv),bytes:dataElementBytes,sha256:hash(dataElementBytes)});
  }
  if (config.grpTypeCsv) {
    const grpTypeBytes = readFileSync(config.grpTypeCsv);
    files.push({kind:'grp_type_info',name:basename(config.grpTypeCsv),path:resolve(config.grpTypeCsv),bytes:grpTypeBytes,sha256:hash(grpTypeBytes)});
  }
  // Include SQL bytes in the identity, even when detail hashes disagree.
  for(const name of readdirSync(join(config.tagDir,'dimension-sql')).filter(n=>n.endsWith('.sql')).sort()) {
    const path = resolve(config.tagDir,'dimension-sql',name); const bytes = readFileSync(path);
    files.push({kind:'tag',name:`dimension-sql/${name}`,path,bytes,sha256:hash(bytes)});
  }
  files.sort((a,b)=>a.path.localeCompare(b.path));
  return files;
}

const schema = `
CREATE TABLE import_runs (input_hash TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, imported_at TEXT NOT NULL, report_json TEXT);
CREATE TABLE snapshots (kind TEXT PRIMARY KEY, snapshot_label TEXT, status TEXT NOT NULL, manifest_json TEXT NOT NULL);
CREATE TABLE source_files (id INTEGER PRIMARY KEY, kind TEXT NOT NULL REFERENCES snapshots(kind), path TEXT UNIQUE NOT NULL, sha256 TEXT NOT NULL, byte_count INTEGER NOT NULL, raw_sql_bytes BLOB);
CREATE TABLE records (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES source_files(id), source_row INTEGER NOT NULL, record_kind TEXT NOT NULL, object_id TEXT, raw_json TEXT NOT NULL CHECK(json_valid(raw_json)), UNIQUE(source_id,source_row));
CREATE INDEX records_object ON records(record_kind,object_id);
CREATE TABLE indicators (record_id INTEGER PRIMARY KEY REFERENCES records(id), indicator_id TEXT NOT NULL, name TEXT, english_name TEXT, definition TEXT, status TEXT, database_name TEXT, table_name TEXT, catalog_json TEXT);
CREATE INDEX indicators_id ON indicators(indicator_id);
CREATE INDEX indicators_name ON indicators(name);
CREATE TABLE tag_dimensions (record_id INTEGER PRIMARY KEY REFERENCES records(id), dimension_id TEXT NOT NULL, name TEXT, english_name TEXT, description TEXT, status TEXT, catalog_path TEXT);
CREATE INDEX dimensions_id ON tag_dimensions(dimension_id);
CREATE TABLE tag_dimension_details (record_id INTEGER PRIMARY KEY REFERENCES records(id), dimension_id TEXT NOT NULL, name TEXT, description TEXT, database_name TEXT, table_name TEXT, detail_status TEXT);
CREATE INDEX details_id ON tag_dimension_details(dimension_id);
CREATE TABLE tag_values (record_id INTEGER PRIMARY KEY REFERENCES records(id), tag_id TEXT NOT NULL, name TEXT, status TEXT, catalog_path TEXT, generation_condition TEXT);
CREATE INDEX tags_id ON tag_values(tag_id);
CREATE INDEX tags_name ON tag_values(name);
CREATE TABLE tag_links (record_id INTEGER PRIMARY KEY REFERENCES records(id), tag_id TEXT NOT NULL, dimension_id TEXT NOT NULL, source_status TEXT, tag_present INTEGER NOT NULL, dimension_present INTEGER NOT NULL);
CREATE INDEX links_tag ON tag_links(tag_id);
CREATE INDEX links_dimension ON tag_links(dimension_id);
CREATE TABLE task_links (record_id INTEGER NOT NULL REFERENCES records(id), asset_kind TEXT NOT NULL, asset_id TEXT NOT NULL, relation_kind TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(record_id,relation_kind,task_id));
CREATE INDEX tasks_id ON task_links(task_id);
CREATE TABLE tag_sql (record_id INTEGER PRIMARY KEY REFERENCES tag_dimension_details(record_id), dimension_id TEXT NOT NULL, source_id INTEGER REFERENCES source_files(id), source_status TEXT, status TEXT NOT NULL, expected_sha256 TEXT, actual_sha256 TEXT, sql_text TEXT);
CREATE TABLE code_values (record_id INTEGER PRIMARY KEY REFERENCES records(id), code_id TEXT, chinese_name TEXT, code_value TEXT, value_description TEXT, encoding_mode TEXT, maintenance TEXT, remark TEXT, source TEXT, business_date TEXT, english_name TEXT, source_table TEXT);
CREATE INDEX code_lookup ON code_values(code_id,code_value,source_table,source,business_date);
CREATE INDEX code_name ON code_values(chinese_name);
CREATE TABLE ref_dw_cd_list (record_id INTEGER PRIMARY KEY REFERENCES records(id), dw_cd_id TEXT NOT NULL, dw_cd_eng_name TEXT NOT NULL, dw_cd_chn_name TEXT NOT NULL, encd_mode TEXT, data_std_id TEXT, crt_date TEXT NOT NULL, matn TEXT NOT NULL, dc_dict_entry TEXT, src_dict_tbl TEXT, remark TEXT);
CREATE UNIQUE INDEX ref_dw_cd_list_id ON ref_dw_cd_list(dw_cd_id);
CREATE INDEX ref_dw_cd_list_eng_name ON ref_dw_cd_list(dw_cd_eng_name);
CREATE INDEX ref_dw_cd_list_chn_name ON ref_dw_cd_list(dw_cd_chn_name);
CREATE INDEX ref_dw_cd_list_source ON ref_dw_cd_list(src_dict_tbl);
CREATE TABLE grp_type_info (record_id INTEGER PRIMARY KEY REFERENCES records(id), grp_type_id TEXT NOT NULL, grp_type_code TEXT NOT NULL, grp_type_name TEXT NOT NULL, sys_code TEXT, grp_attr_table_name TEXT, grp_attr_table_pk TEXT, tag_dim_id TEXT, grp_def_sql TEXT NOT NULL, data_time TEXT NOT NULL, modify_operator TEXT NOT NULL, modify_time TEXT NOT NULL, status TEXT NOT NULL);
CREATE UNIQUE INDEX grp_type_info_id ON grp_type_info(grp_type_id);
CREATE INDEX grp_type_info_code ON grp_type_info(grp_type_code);
CREATE INDEX grp_type_info_name ON grp_type_info(grp_type_name);
CREATE INDEX grp_type_info_system ON grp_type_info(sys_code);
CREATE INDEX grp_type_info_table ON grp_type_info(grp_attr_table_name);
CREATE INDEX grp_type_info_tag ON grp_type_info(tag_dim_id);
`;

export function buildCatalog(config) {
  for (const key of ['indicatorDir','tagDir','codeCsv','outputDir']) if(typeof config[key] !== 'string' || !config[key]) throw new Error(`Missing ${key}`);
  const files = collect(config);
  const inputHash = hash(JSON.stringify({version:VERSION,files:files.map(f=>[f.path,f.sha256])}));
  const database = resolve(config.outputDir,'asset-catalog.sqlite');
  if (existsSync(database)) {
    const old = new DatabaseSync(database,{readOnly:true});
    try {
      const run = old.prepare('SELECT * FROM import_runs WHERE input_hash=? AND schema_version=?').get(inputHash,VERSION);
      if(!run) throw new Error('Existing catalog has different inputs; choose a new output directory to retain the previous snapshot');
      if(old.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Existing catalog integrity check failed');
      const report = JSON.parse(run.report_json);
      writeFileSync(join(config.outputDir,`import-manifest-${inputHash}.json`),JSON.stringify(report,null,2)+'\n');
      return {...report,status:'UNCHANGED',database};
    } finally { old.close(); }
  }
  mkdirSync(config.outputDir,{recursive:true});
  const temp = `${database}.${randomUUID()}.tmp`;
  const db = new DatabaseSync(temp); let closed = false;
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    db.exec(schema);
    db.prepare('INSERT INTO import_runs VALUES (?,?,?,NULL)').run(inputHash,VERSION,new Date().toISOString());
    const snapshotKinds = ['indicator','tag','code'];
    if (files.some(file => file.kind === 'data_element')) snapshotKinds.push('data_element');
    if (files.some(file => file.kind === 'grp_type_info')) snapshotKinds.push('grp_type_info');
    for(const kind of snapshotKinds) {
      const manifest = files.find(f=>f.kind===kind && f.name==='manifest.json');
      const data = manifest ? JSON.parse(manifest.bytes.toString('utf8').replace(/^\uFEFF/,'')) : {};
      db.prepare('INSERT INTO snapshots VALUES (?,?,?,?)').run(kind,kind==='code'?null:basename(kind==='tag'?config.tagDir:config.indicatorDir),data.status || 'UNVERIFIED',JSON.stringify(data));
    }
    const insert = (table,values) => {
      let statement = statements.get(table);
      if(!statement) { statement=db.prepare(`INSERT INTO ${table} VALUES (${values.map(()=>'?').join(',')})`); statements.set(table,statement); }
      return statement.run(...values);
    };
    const statements = new Map();
    for(const file of files) file.id = Number(insert('source_files',[null,file.kind,file.path,file.sha256,file.bytes.length,file.name.endsWith('.sql')?file.bytes:null]).lastInsertRowid);
    const taskLinks = (id,kind,asset,relation,value) => {
      if(value == null || value === '' || value === '-') return;
      const ids = String(value).split(/[,;\s]+/).filter(Boolean);
      if(ids.some(task=>!/^\d+$/.test(task))) { taskWarnings++; return; }
      for(const task of new Set(ids)) insert('task_links',[id,kind,asset,relation,task]);
    };
    let taskWarnings = 0;
    const kinds = {'indicators.jsonl':'indicator','tag-dimensions.jsonl':'tag_dimension','dimension-details.jsonl':'tag_dimension_detail','tag-values.jsonl':'tag_value','tag-value-dimension-links.jsonl':'tag_link'};
    for(const file of files.filter(f=>f.name.endsWith('.jsonl'))) {
      let line = 0;
      for(const raw of file.bytes.toString('utf8').replace(/^\uFEFF/,'').split(/\r?\n/)) {
        line++; if(!raw.trim()) continue;
        const r = JSON.parse(raw); const kind = kinds[file.name] || file.name;
        const object = r.indexId ?? r.tagId ?? r.tagDimId ?? r.objectId;
        if(kinds[file.name] && (typeof object !== 'string' || !object)) throw new Error(`Missing object ID in ${file.name}:${line}`);
        const id = Number(insert('records',[null,file.id,line,kind,text(object),JSON.stringify(r)]).lastInsertRowid);
        if(kind==='indicator') {
          insert('indicators',[id,r.indexId,text(r.chineseName),text(r.englishName),text(r.businessDefinition),text(r.status),text(r.dbName),text(r.engTblName),JSON.stringify(r.catalog??null)]);
          taskLinks(id,kind,r.indexId,'horaeTaskId',r.horaeTaskId);
        } else if(kind==='tag_dimension') {
          insert('tag_dimensions',[id,r.tagDimId,text(r.tagDimName),text(r.tagDimEnglishName),text(r.description),text(r.statusCode),text(r.catalogPath)]);
        } else if(kind==='tag_dimension_detail') {
          insert('tag_dimension_details',[id,r.tagDimId,text(r.tagDimName),text(r.description),text(r.resultDatabase),text(r.resultTable),text(r.detailEvidenceStatus)]);
          const sql = files.find(f=>f.kind==='tag' && f.name===`dimension-sql/${r.tagDimId}.sql`);
          let status = 'MISSING'; let body = null;
          if(sql) {
            status = !r.sqlSha256 ? 'UNVERIFIED' : sql.sha256 !== r.sqlSha256 ? 'HASH_MISMATCH' : r.sqlEvidenceStatus === 'FOUND' ? 'VERIFIED' : 'SOURCE_STATUS_UNVERIFIED';
            if(status==='VERIFIED') body=sql.bytes.toString('utf8');
          }
          insert('tag_sql',[id,r.tagDimId,sql?.id??null,text(r.sqlEvidenceStatus),status,text(r.sqlSha256),sql?.sha256??null,body]);
        } else if(kind==='tag_value') insert('tag_values',[id,r.tagId,text(r.tagName),text(r.statusCode),text(r.catalogPath),text(r.generationCondition)]);
        else if(kind==='tag_link') {
          if(typeof r.tagDimId!=='string' || !r.tagDimId) throw new Error(`Missing dimension ID at link ${line}`);
          insert('tag_links',[id,r.tagId,r.tagDimId,text(r.dimensionEvidenceStatus),0,0]);
        }
        if(kind==='tag_dimension' || kind==='tag_dimension_detail') {
          taskLinks(id,kind,r.tagDimId,'markingTaskIds',r.markingTaskIds);
          taskLinks(id,kind,r.tagDimId,'systemTagTaskIds',r.systemTagTaskIds);
        }
      }
    }
    // Catalog trees and manifests remain queryable without dependence on external files.
    for(const file of files.filter(f=>f.name.endsWith('.json'))) insert('records',[null,file.id,1,file.name,null,JSON.stringify(JSON.parse(file.bytes.toString('utf8').replace(/^\uFEFF/,'')))]);
    const codeFile = files.find(f=>f.kind==='code');
    const [headers,...rows] = parseCsv(codeFile.bytes.toString('utf8'));
    if(new Set(headers).size !== headers.length || !headers.includes('dw_cd_id') || !headers.includes('dw_cd_val')) throw new Error('Invalid code CSV headers');
    let rowNumber = 1;
    for(const row of rows) {
      rowNumber++; if(row.length!==headers.length) throw new Error(`Code CSV width mismatch at record ${rowNumber}`);
      const r = Object.fromEntries(headers.map((h,i)=>[h,row[i]]));
      const id=Number(insert('records',[null,codeFile.id,rowNumber,'code_value',r.dw_cd_id,JSON.stringify(r)]).lastInsertRowid);
      insert('code_values',[id,...['dw_cd_id','dw_cd_chn_name','dw_cd_val','dw_cd_val_desc','encd_mode','matn','remark','src','busi_date','dw_cd_eng_name','src_tbl'].map(k=>r[k]??null)]);
    }
    const dataElementFile = files.find(f=>f.kind==='data_element');
    if (dataElementFile) {
      const [dataElementHeaders,...dataElementRows] = parseCsv(dataElementFile.bytes.toString('utf8'));
      const expectedHeaders = ['dw_cd_id','dw_cd_eng_name','dw_cd_chn_name','encd_mode','data_std_id','crt_date','matn','dc_dict_entry','src_dict_tbl','remark'];
      if (dataElementHeaders.length !== expectedHeaders.length || dataElementHeaders.some((header,index)=>header !== expectedHeaders[index])) throw new Error('Invalid data element CSV headers');
      const seenIds = new Set();
      let dataElementRowNumber = 1;
      for (const row of dataElementRows) {
        dataElementRowNumber++; if (row.length !== dataElementHeaders.length) throw new Error(`Data element CSV width mismatch at record ${dataElementRowNumber}`);
        const r = Object.fromEntries(dataElementHeaders.map((h,i)=>[h,row[i]]));
        if (!r.dw_cd_id || !r.dw_cd_eng_name || !r.dw_cd_chn_name || !r.crt_date || !r.matn) throw new Error(`Missing required data element field at record ${dataElementRowNumber}`);
        if (seenIds.has(r.dw_cd_id)) throw new Error(`Duplicate data element ID at record ${dataElementRowNumber}: ${r.dw_cd_id}`);
        seenIds.add(r.dw_cd_id);
        const id = Number(insert('records',[null,dataElementFile.id,dataElementRowNumber,'ref_dw_cd_list',r.dw_cd_id,JSON.stringify(r)]).lastInsertRowid);
        insert('ref_dw_cd_list',[id,...expectedHeaders.slice(0).map(key=>r[key] ?? null)]);
      }
    }
    const grpTypeFile = files.find(f=>f.kind==='grp_type_info');
    if (grpTypeFile) {
      const [grpTypeHeaders,...grpTypeRows] = parseCsv(grpTypeFile.bytes.toString('utf8'));
      const expectedHeaders = ['grp_type_id','grp_type_code','grp_type_name','sys_code','grp_attr_table_name','grp_attr_table_pk','tag_dim_id','grp_def_sql','data_time','modify_operator','modify_time','status'];
      if (grpTypeHeaders.length !== expectedHeaders.length || grpTypeHeaders.some((header,index)=>header !== expectedHeaders[index])) throw new Error('Invalid grp type CSV headers');
      const seenIds = new Set();
      let grpTypeRowNumber = 1;
      for (const row of grpTypeRows) {
        grpTypeRowNumber++; if (row.length !== grpTypeHeaders.length) throw new Error(`Grp type CSV width mismatch at record ${grpTypeRowNumber}`);
        const r = Object.fromEntries(grpTypeHeaders.map((h,i)=>[h,row[i]]));
        if (!r.grp_type_id || !r.grp_type_code || !r.grp_type_name || !r.grp_def_sql || !r.data_time || !r.modify_operator || !r.modify_time || !r.status) throw new Error(`Missing required grp type field at record ${grpTypeRowNumber}`);
        if (seenIds.has(r.grp_type_id)) throw new Error(`Duplicate grp type ID at record ${grpTypeRowNumber}: ${r.grp_type_id}`);
        seenIds.add(r.grp_type_id);
        const id = Number(insert('records',[null,grpTypeFile.id,grpTypeRowNumber,'grp_type_info',r.grp_type_id,JSON.stringify(r)]).lastInsertRowid);
        insert('grp_type_info',[id,...expectedHeaders.map(key=>r[key] ?? null)]);
      }
    }
    db.exec(`UPDATE tag_links SET tag_present=EXISTS(SELECT 1 FROM tag_values v WHERE v.tag_id=tag_links.tag_id), dimension_present=EXISTS(SELECT 1 FROM tag_dimensions d WHERE d.dimension_id=tag_links.dimension_id) OR EXISTS(SELECT 1 FROM tag_dimension_details d WHERE d.dimension_id=tag_links.dimension_id);`);
    const counts = {};
    for(const table of ['indicators','tag_dimensions','tag_dimension_details','tag_values','tag_links','task_links','tag_sql','code_values','ref_dw_cd_list','grp_type_info','source_files','records']) counts[table]=db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    const duplicateKeys = {};
    for(const [table,key] of [['indicators','indicator_id'],['tag_dimensions','dimension_id'],['tag_dimension_details','dimension_id'],['tag_values','tag_id'],['ref_dw_cd_list','dw_cd_id']]) duplicateKeys[table]=db.prepare(`SELECT count(*) AS n FROM (SELECT ${key} FROM ${table} GROUP BY ${key} HAVING count(*)>1)`).get().n;
    const report = {status:'IMPORTED',schemaVersion:VERSION,database,inputHash,counts,duplicateKeys,taskLinkParseWarnings:taskWarnings,sqlStatuses:db.prepare('SELECT status,count(*) AS count FROM tag_sql GROUP BY status').all(),unresolvedTagLinks:db.prepare('SELECT count(*) AS n FROM tag_links WHERE tag_present=0 OR dimension_present=0').get().n,sourceStatuses:db.prepare('SELECT kind,status FROM snapshots').all()};
    if(db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key check failed');
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('Integrity check failed');
    // Detect source changes during the build before publishing.
    for(const file of files) if(hash(readFileSync(file.path))!==file.sha256) throw new Error('Source changed during import');
    db.prepare('UPDATE import_runs SET report_json=? WHERE input_hash=?').run(JSON.stringify(report),inputHash);
    db.exec('COMMIT;'); db.close(); closed=true;
    // Exclusive hard-link publication cannot overwrite another process's database.
    linkSync(temp,database); unlinkSync(temp);
    writeFileSync(join(config.outputDir,`import-manifest-${inputHash}.json`),JSON.stringify(report,null,2)+'\n');
    return report;
  } finally {
    if(!closed) db.close();
    if(existsSync(temp)) unlinkSync(temp);
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if(process.argv.length!==3) throw new Error('Usage: node scripts/asset-catalog/import.mjs <config.json>');
    console.log(JSON.stringify(buildCatalog(JSON.parse(readFileSync(process.argv[2],'utf8'))),null,2));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
