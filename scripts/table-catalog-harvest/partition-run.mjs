import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {PortalTransport,sleep} from './transport.mjs';
import {summarizeValues} from './partition-values.mjs';
import {partitionBusinessErrorCode,runPartitionTable} from './partition-errors.mjs';

const root=resolve('outputs/partition-filter-harvest-20260912');
mkdirSync(root,{recursive:true});
const dbPath=join(root,'partition-filters.sqlite');
if(process.argv.includes('--status')) {
  const db=new DatabaseSync(dbPath,{readOnly:true});
  console.log(JSON.stringify({run:db.prepare('SELECT * FROM run').get(),states:db.prepare('SELECT state,count(*) n FROM tasks GROUP BY state').all(),fields:db.prepare('SELECT count(*) n FROM filters').get()},null,2));
  db.close();process.exit(0);
}
const lock=join(root,'run.lock.json');
if(existsSync(lock)) {
  const previous=JSON.parse(readFileSync(lock));
  try {process.kill(previous.pid,0);throw Error('ALREADY_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}
  unlinkSync(lock);
}
const fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid}));closeSync(fd);
let db;
const now=()=>new Date().toISOString();
try {
  db=new DatabaseSync(dbPath);db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tasks(guid TEXT PRIMARY KEY,name TEXT,database_name TEXT,qualified_name TEXT,type TEXT,state TEXT DEFAULT 'PENDING',keys_json TEXT,updated_at TEXT,error_code TEXT);
    CREATE TABLE IF NOT EXISTS filters(guid TEXT REFERENCES tasks(guid),field TEXT,ordinal INTEGER,summary_json TEXT,collected_at TEXT,PRIMARY KEY(guid,field));
    CREATE TABLE IF NOT EXISTS run(id INTEGER PRIMARY KEY CHECK(id=1),status TEXT,updated_at TEXT,requests INTEGER,error_code TEXT);
    CREATE TABLE IF NOT EXISTS events(at TEXT,kind TEXT,detail TEXT);
    CREATE TABLE IF NOT EXISTS graph_priority(guid TEXT PRIMARY KEY REFERENCES tasks(guid),publication_version TEXT,node_id TEXT);`);
  if(!db.prepare('SELECT 1 FROM run').get()) {
    const source=new DatabaseSync(resolve('outputs/table-catalog-union-20260911/catalog.sqlite'),{readOnly:true});
    const rows=source.prepare('SELECT guid,name,database_name,qualified_name,raw_json FROM assets').all();
    db.exec('BEGIN');
    try {
      const insert=db.prepare('INSERT INTO tasks(guid,name,database_name,qualified_name,type,state) VALUES(?,?,?,?,?,?)');
      for(const row of rows){const type=JSON.parse(row.raw_json).typeName;insert.run(row.guid,row.name,row.database_name,row.qualified_name,type,type==='kafka_topic'?'NOT_APPLICABLE':'PENDING');}
      db.prepare('INSERT INTO run VALUES(1,?,?,0,NULL)').run('CREATED',now());db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}finally{source.close();}
  }
  let stopping=false;process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
  const stopped=()=>stopping||existsSync(join(root,'stop.requested'));
  const t=new PortalTransport('partition-filter-harvest',{businessErrorCode:partitionBusinessErrorCode});
  let requests=db.prepare('SELECT requests FROM run').get().requests;
  const report=(status,error=null)=>{
    db.prepare('UPDATE run SET status=?,updated_at=?,requests=?,error_code=? WHERE id=1').run(status,now(),requests,error);
    const summary={status,updatedAt:now(),requests,error,states:db.prepare('SELECT state,count(*) n FROM tasks GROUP BY state').all(),fields:db.prepare('SELECT count(*) n FROM filters').get().n};
    writeFileSync(join(root,'status.tmp'),JSON.stringify(summary,null,2));renameSync(join(root,'status.tmp'),join(root,'status.json'));console.log(JSON.stringify(summary));
  };
  const request=async(path,args)=>{
    if(stopped())throw Error('USER_STOP');
    requests++;
    try{
      const method=path==='queryPartitionValues.json'?'postPortalJson':'postPortalFormObject';
      return await t.portal[method](t.page,'/metaservice/metadataSearch/'+path,args);
    }
    finally{await sleep(1000+Math.floor(Math.random()*501));}
  };
  let active=null,completed=0;
  const limit=process.argv.includes('--pilot')?5:Infinity;
  try {
    if(stopped()){report('PAUSED_USER');}
    else {
      report('STARTING');await t.open();
      while(!stopped()&&completed<limit){
        active=db.prepare("SELECT * FROM tasks WHERE state IN ('PENDING','COLLECTING') ORDER BY CASE WHEN EXISTS(SELECT 1 FROM graph_priority p WHERE p.guid=tasks.guid) THEN 0 ELSE 1 END,CASE WHEN guid='687b993b-085a-4890-bab4-71d3aa716d93' THEN 0 WHEN database_name='pdata_n' THEN 1 WHEN type='hive_table' THEN 2 ELSE 3 END,guid LIMIT 1").get();
        if(!active)break;
        await runPartitionTable(async()=>{
        let keys=active.keys_json?JSON.parse(active.keys_json):await request('getPartitionKeys.json',{guid:active.guid});
        if(!Array.isArray(keys)||keys.some(x=>typeof x!=='string'||!x)||new Set(keys).size!==keys.length)throw Error('INVALID_PARTITION_KEYS');
        db.prepare("UPDATE tasks SET state='COLLECTING',keys_json=?,updated_at=?,error_code=NULL WHERE guid=?").run(JSON.stringify(keys),now(),active.guid);
        for(const [ordinal,key] of keys.entries()){
          if(db.prepare('SELECT 1 FROM filters WHERE guid=? AND field=?').get(active.guid,key))continue;
          const rows=await request('queryPartitionValues.json',{tableName:active.name,dbName:active.database_name,columnValue:'',columnName:key,typeName:active.type,tableGuid:active.guid});
          if(!Array.isArray(rows)||rows.some(x=>typeof x?.columnValue!=='string'))throw Error('INVALID_PARTITION_VALUES');
          const summary=summarizeValues(key,rows.map(x=>x.columnValue));
          db.prepare('INSERT INTO filters VALUES(?,?,?,?,?)').run(active.guid,key,ordinal,JSON.stringify(summary),now());
        }
        db.prepare('UPDATE tasks SET state=?,updated_at=? WHERE guid=?').run(keys.length?'CAPTURED_UNVERIFIED':'NO_KEYS_RETURNED',now(),active.guid);
        },(code)=>{
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare("UPDATE tasks SET state='BLOCKED',error_code=?,updated_at=? WHERE guid=?").run(code,now(),active.guid);
            db.prepare('INSERT INTO events VALUES(?,?,?)').run(now(),'TASK_QUARANTINED',JSON.stringify({guid:active.guid,code,...(code==='SOURCE_PARTITION_QUERY_NULL'?{message:'查询异常null',cause:'UNVERIFIED'}:{})}));
            db.exec('COMMIT');
          }catch(error){db.exec('ROLLBACK');throw error;}
        });
        completed++;active=null;report('RUNNING');
      }
      const pending=db.prepare("SELECT count(*) n FROM tasks WHERE state IN ('PENDING','COLLECTING')").get().n;
      const blocked=db.prepare("SELECT count(*) n FROM tasks WHERE state='BLOCKED'").get().n;
      report(stopped()?'PAUSED_USER':pending?'PILOT_COMPLETE':blocked?'FINISHED_PARTIAL':'FINISHED_WITH_UNVERIFIED_COMPLETENESS');
    }
  }catch(e){
    const code=/^[A-Z0-9_]+$/.test(e.message)?e.message:'UNEXPECTED_ERROR';
    if(active)db.prepare('UPDATE tasks SET error_code=?,updated_at=? WHERE guid=?').run(code,now(),active.guid);
    db.prepare('INSERT INTO events VALUES(?,?,?)').run(now(),'PAUSED',JSON.stringify({guid:active?.guid,code}));
    report(code==='USER_STOP'?'PAUSED_USER':'PAUSED_ERROR',code);process.exitCode=code==='USER_STOP'?0:1;
  }
}finally{db?.close();if(existsSync(lock))unlinkSync(lock);}
