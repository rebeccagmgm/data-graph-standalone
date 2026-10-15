import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, digest } from './store.mjs';
import { PortalTransport } from './transport.mjs';

const args=process.argv.slice(2);
const outputIndex=args.indexOf('--output');
if(outputIndex>=0 && (!args[outputIndex+1] || args[outputIndex+1].startsWith('--'))) throw new Error('OUTPUT_PATH_REQUIRED');
const output=resolve(outputIndex>=0 ? args[outputIndex+1] : 'outputs/table-catalog-union-20260911');
const json=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const now=()=>new Date().toISOString();
const errorCode=error=>/^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'UNEXPECTED_LOCAL_ERROR';
mkdirSync(output,{recursive:true});
const sqlite=join(output,'catalog.sqlite');

if (args.includes('--status')) {
  if(!existsSync(sqlite)) throw new Error('CATALOG_NOT_CREATED');
  const db=new DatabaseSync(sqlite,{readOnly:true});
  const run=db.prepare('SELECT status,updated_at,error_code FROM run WHERE id=1').get();
  console.log(JSON.stringify({...run,uniqueTables:db.prepare('SELECT count(*) n FROM assets').get().n,
    savedPages:db.prepare('SELECT count(*) n FROM pages').get().n,
    active:db.prepare("SELECT name,state,total,next_page,error_code FROM groups WHERE state IN ('COLLECTING','VERIFYING')").all(),
    states:db.prepare('SELECT state,count(*) count FROM groups GROUP BY state').all()},null,2));
  db.close();
  process.exit(0);
}

const configPath=join(output,'config.json');
if (!existsSync(configPath)) {
  const runtime=json('.evidence-cache/full-catalog-recon-20260911/collector-runtime-evidence.json');
  if(runtime.systems?.length!==1 || runtime.type!=='003000' || runtime.keyword!=='' || runtime.labels.length) throw new Error('INVALID_SCOPE_EVIDENCE');
  const root='.evidence-cache/classification-taxonomies-20260911';
  const taxonomyNames=['数仓建模-数据分类','按客户模型分类','资讯股票指标目录','报表分类','按元数据分类',
    '按个人信息分类','业务目录','资讯综合分类','按数据服务场景','指标标签目录','资讯自助服务','按重要数据目录分类','按资讯模型分类'];
  const taxonomies=taxonomyNames.map(name=>{
    const evidence=json(join(root,name+(existsSync(join(root,name+'.page.json'))?'.page.json':'.state.json')));
    const virtual=runtime.virtual.find(x=>x.classificationName==='分类_'+name);
    return {id:'taxonomy:'+digest(name).slice(0,16),name,path:'分类_'+name,
      extraDatabaseId:virtual?.database || '',children:(evidence.tree || []).map(x=>({name:x.name,path:x.path}))};
  });
  writeFileSync(configPath,JSON.stringify({version:1,session:'catalog-union-20260911',scope:'classification directories UNION big data platform',
    businessSystem:runtime.systems,taxonomies,pageSize:100,resultWindow:10000,
    delayMs:[1000,1500],includeTemporary:false,includeInactive:false,sourceSemantics:'live crawl; not a transactionally isolated snapshot'},null,2));
}
const config=json(configPath);
const lock=join(output,'run.lock.json');
if(existsSync(lock)) {
  const previous=json(lock);
  try { process.kill(previous.pid,0); throw new Error('COLLECTOR_ALREADY_RUNNING'); }
  catch(error) { if(error.code!=='ESRCH') throw error; }
  unlinkSync(lock);
}
const fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:now()}));closeSync(fd);
const store=new Store(sqlite,config);
const transport=new PortalTransport(config.session);
let stopping=false;
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
const stopped=()=>stopping || existsSync(join(output,'stop.requested'));

function report() {
  const summary={pid:process.pid,...store.summary(),requestsThisProcess:transport.requestCount};
  writeFileSync(join(output,'status.tmp'),JSON.stringify(summary,null,2));
  renameSync(join(output,'status.tmp'),join(output,'status.json'));
  console.log(JSON.stringify({at:now(),status:summary.status,tables:summary.uniqueTables,pages:summary.savedPages,
    active:summary.active.map(x=>({name:x.name,page:x.next_page,state:x.state}))}));
}
function seed() {
  for(const tax of config.taxonomies) {
    store.addGroup({id:tax.id,scope:tax.id,name:tax.name,kind:'ROOT',priority:tax.name==='按元数据分类'?40:10,
      query:{classifications:[tax.path],...(tax.extraDatabaseId?{extraDatabaseId:tax.extraDatabaseId}:{})}});
  }
  store.addGroup({id:'inventory:platform',scope:'inventory:platform',name:'大数据平台数据库目录',kind:'INVENTORY',priority:20,
    query:{type:'002000',businessSystem:config.businessSystem}});
  store.addGroup({id:'platform',scope:'platform',name:'大数据平台',kind:'ROOT',priority:60,query:{businessSystem:config.businessSystem}});
}
function split(group) {
  if(group.kind!=='ROOT') {store.updateGroup(group.id,'BLOCKED','RESULT_WINDOW_NEEDS_SUBDIVISION');return;}
  if(group.id==='platform') {
    if(store.getGroup('inventory:platform').state!=='COMPLETE') {store.updateGroup(group.id,'BLOCKED','DATABASE_INVENTORY_INCOMPLETE');return;}
    const databases=store.db.prepare('SELECT guid,name,qualified_name FROM databases ORDER BY guid').all();
    for(const db of databases) {
      const id='platform-db:'+db.guid;
      store.addGroup({id,scope:group.id,name:'大数据平台 / '+db.name,
        kind:'LEAF',priority:61,query:{businessSystem:config.businessSystem,dataBaseIds:[db.qualified_name]}});
      if(!db.qualified_name) store.updateGroup(id,'BLOCKED','DATABASE_FILTER_ID_MISSING');
    }
  } else {
    const tax=config.taxonomies.find(x=>x.id===group.id);
    const children=tax?.children.filter(x=>x.path && x.path!==tax.path && x.path.startsWith(tax.path+'_')) || [];
    if(!children.length || tax.extraDatabaseId) {store.updateGroup(group.id,'BLOCKED','NO_VERIFIED_SUBDIVISION');return;}
    for(const child of children) store.addGroup({id:group.id+':'+digest(child.path).slice(0,16),scope:group.id,
      name:tax.name+' / '+child.name,kind:'LEAF',priority:41,query:{classifications:[child.path]}});
  }
  store.updateGroup(group.id,'AGGREGATE');
}
function fatal(code) {
  return /^(HTTP_|OPENCLI_|PORTAL_|UNEXPECTED_LOCAL_ERROR)/.test(code);
}
async function step(group) {
  const query=JSON.parse(group.query_json);
  if(group.state==='VERIFYING') {
    const data=await transport.query(query,1,config.pageSize);
    store.verifyGroup(group,data,config.pageSize);
    store.event('GROUP_VERIFIED',{name:group.name,total:group.total});
    return;
  }
  const data=await transport.query(query,group.next_page,config.pageSize);
  store.savePage(group,data,group.next_page,config.pageSize);
  if(data.totalResultNum>config.resultWindow) split(store.getGroup(group.id));
}
async function reconcile() {
  const roots=store.db.prepare("SELECT * FROM groups WHERE kind='ROOT' AND state='AGGREGATE'").all();
  for(const group of roots) {
    if(stopped()) return;
    const data=await transport.query(JSON.parse(group.query_json),1,config.pageSize);
    const count=store.scopeCount(group.id);
    const incomplete=store.db.prepare("SELECT count(*) n FROM groups WHERE scope=? AND id<>? AND state<>'COMPLETE'").get(group.id,group.id).n;
    const code=data.totalResultNum!==group.total?'ROOT_TOTAL_CHANGED':
      incomplete?'CHILD_GROUPS_INCOMPLETE':count!==data.totalResultNum?'SCOPE_COVERAGE_GAP':null;
    store.updateGroup(group.id,code?'PARTIAL':'COMPLETE',code);
    store.event('SCOPE_RECONCILIATION',{name:group.name,expected:group.total,currentTotal:data.totalResultNum,uniqueCount:count,error:code});
    report();
  }
}
try {
  seed();
  if(stopped()) {store.setRun('PAUSED_USER');report();}
  else {
    store.setRun('STARTING');report();
    await transport.open();
    store.setRun('RUNNING');
    const pilot=config.taxonomies.find(x=>x.name==='按客户模型分类');
    while(!stopped()) {
      const group=args.includes('--pilot')?store.getGroup(pilot.id):store.nextGroup();
      if(!group || (args.includes('--pilot') && group.state==='COMPLETE')) break;
      if(args.includes('--pilot') && !['PENDING','COLLECTING','VERIFYING'].includes(group.state)) throw new Error('PILOT_INCOMPLETE');
      try {await step(group);}
      catch(error) {
        const code=errorCode(error);store.event('GROUP_ERROR',{name:group.name,code});
        if(fatal(code)) throw error;
        store.updateGroup(group.id,'BLOCKED',code);
      }
      store.setRun('RUNNING');report();
    }
    if(stopped()) store.setRun('PAUSED_USER');
    else if(args.includes('--pilot')) store.setRun('PILOT_COMPLETE');
    else {
      await reconcile();
      const unresolved=store.db.prepare("SELECT count(*) n FROM groups WHERE state<>'COMPLETE'").get().n;
      store.setRun(stopped()?'PAUSED_USER':unresolved?'PARTIAL':'COMPLETE');
    }
    report();
  }
} catch(error) {
  const code=errorCode(error);store.setRun('PAUSED_ERROR',code);store.event('RUN_ERROR',{code});report();process.exitCode=1;
} finally {
  store.close();
  if(existsSync(lock) && json(lock).pid===process.pid) unlinkSync(lock);
}
