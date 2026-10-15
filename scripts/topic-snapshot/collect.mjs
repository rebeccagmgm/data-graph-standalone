import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openAssetGraph } from '../../packages/data-graph/src/asset-graph/config.ts';
import { AssetGraphStore } from '../../packages/data-graph/src/asset-graph/store.ts';
import { processingDetail } from '../../packages/data-graph/src/asset-graph/agent-api.ts';
import { redact } from '../inventory-map/evidence.mjs';

// A bounded, read-only learning snapshot; never prepares or publishes a graph.
const output = resolve('artifacts/topic-snapshots/pdata-t01-20260909');
const connection = await openAssetGraph();
const store = new AssetGraphStore(connection.driver, connection.database, connection.graphId);
const nodeDto = n => ({id:n.id, kind:n.kind, label:redact(n.label), table:n.table, taskId:n.taskId,
  identityStatus:n.detail?.identityStatus ?? null, identityReason:n.detail?.identityReasonCode ?? null});
const edgeDto = e => ({id:e.id, from:e.from, to:e.to, kind:e.kind});
try {
  const initial = await store.ready();
  const seeds = [];
  let exhausted = false;
  for (let offset=0; offset<500; offset+=100) {
    const rows = await store.search('pdata_n.t01_', 100, offset);
    seeds.push(...rows.filter(n=>n.kind==='PHYSICAL_DATASET' && String(n.table).startsWith('pdata_n.t01_')));
    if (rows.length<100) { exhausted=true; break; }
  }
  if (!exhausted || !seeds.length) throw new Error('SEED_SCOPE_NOT_COMPLETE');
  const nodes = new Map(seeds.map(n=>[n.id,nodeDto(n)])), edges = new Map(), views = [];
  for (const seed of seeds) {
    const view = {id:seed.id};
    for (const direction of ['up','down']) {
      const trace = await store.traverse({nodeId:seed.id,layer:'table',direction,depth:1,depthUnit:'table-hop',limit:1000});
      if (trace.version!==initial.version) throw new Error('SNAPSHOT_VERSION_CHANGED');
      trace.nodes.forEach(n=>nodes.set(n.id,nodeDto(n)));
      trace.edges.forEach(e=>edges.set(e.id,edgeDto(e)));
      view[direction]={nodeIds:trace.nodes.map(n=>n.id),edgeIds:trace.edges.map(e=>e.id),
        truncated:trace.truncated,stoppedBy:trace.stoppedBy,frontierNodeIds:trace.frontierNodeIds,
        terminalNodes:trace.terminalNodes};
    }
    views.push(view);
  }
  const writers = new Set();
  for (const view of views) for (const id of view.up.nodeIds) if(nodes.get(id)?.kind==='TASK') writers.add(nodes.get(id).taskId || id.replace(/^task:/,''));
  const evidence = [];
  // Read SQL only for direct writers. Consumer chains remain at their recorded I/O boundary.
  for (const taskId of writers) {
    try {
      const d = await processingDetail(store,{taskId,sql:true,lineStart:1,lineCount:300,limit:25});
      evidence.push({taskId,taskName:redact(d.taskName),coverage:d.coverage,
        expressions:d.expressions.map(e=>({outputName:e.outputName,expression:redact(e.expression),status:e.inputDependencyStatus})),
        expressionsNextOffset:d.pagination.nextOffset,
        sql:d.sqlSources?.map(s=>({...s,content:redact(s.content)})),
        version:d.evidence.version,projectionContentHash:d.evidence.projectionContentHash});
    } catch { evidence.push({taskId,unavailable:true}); }
  }
  const final = await store.ready();
  if(final.version!==initial.version) throw new Error('SNAPSHOT_VERSION_CHANGED');
  const snapshot={schemaVersion:1,title:'当事人 · T01 学习快照',capturedAt:new Date().toISOString(),
    graphId:connection.graphId,version:initial.version,scope:'当前发布图中的 pdata_n.t01_* 物理表；每张表上下游各一个表加工层；每方向最多 1000 条关系',
    seedIds:seeds.map(n=>n.id),nodes:[...nodes.values()],edges:[...edges.values()],views,evidence};
  mkdirSync(output,{recursive:true});
  writeFileSync(resolve(output,'snapshot.json'),JSON.stringify(snapshot,null,2));
  console.log(JSON.stringify({output,version:snapshot.version,seeds:seeds.length,nodes:nodes.size,edges:edges.size,writers:writers.size,
    truncated:views.filter(v=>v.up.truncated||v.down.truncated).length,sampleEdges:snapshot.edges.slice(0,2),
    core:snapshot.nodes.filter(n=>snapshot.seedIds.includes(n.id)).map(n=>n.table)}));
} finally { await connection.driver.close(); }
