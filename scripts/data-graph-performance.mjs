import {writeFile, mkdir} from "node:fs/promises";
import {dirname, resolve} from "node:path";

// Bounded local consumption test. Never parses SQL or publishes graphs.
const args = Object.fromEntries(process.argv.slice(2).map(arg => { const i=arg.indexOf("="); return [arg.slice(0,i),arg.slice(i+1)]; }));
const base = new URL(args["--base"] ?? "http://127.0.0.1:8792");
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("LOCAL_GRAPH_ONLY");
const levels = (args["--concurrency"] ?? "1,4").split(",").map(Number);
if (levels.some(n => !Number.isInteger(n) || n < 1 || n > 8)) throw new Error("CONCURRENCY_MUST_BE_1_TO_8");
const out = resolve(args["--out"] ?? "tmp/graph-performance.json");
const clusters = JSON.stringify(["观达(科学城)"]);
const table = "pdata_news_n.t02_fxr_cfets_quot";
async function read(path, params) {
  const response = await fetch(new URL(`/api/${path}?${new URLSearchParams(params)}`,base), {signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}
const found = await read("search",{q:table,limit:"5",clusters});
const dataset = found.find(n => n.kind === "PHYSICAL_DATASET" && n.table === table);
if (!dataset) throw new Error("BENCHMARK_DATASET_MISSING");
const catalog = await read("partitions",{nodeId:dataset.id});
const partitionSelection = JSON.stringify({datasetId:dataset.id,version:catalog.version,optionIds:catalog.options.filter(o=>o.label.includes("src_id=TIT")).map(o=>o.id)});
const trace = {nodeId:dataset.id,partitionSelection,clusters,layer:"table",direction:"down",depthUnit:"table-hop",limit:"400",candidates:"0"};
const cases = [
  ["exact-search","search",{q:table,limit:"31",clusters}],
  ["broad-search","search",{q:"TIT",limit:"31",clusters}],
  ["task-id-search","search",{q:"118174",limit:"31",clusters}],
  ["field-list","fields",{nodeId:dataset.id,offset:"0",limit:"101"}],
  ["partition-options","partitions",{nodeId:dataset.id}],
  ["partition-depth-2","trace",{...trace,depth:"2"}],
  ["partition-depth-4","trace",{...trace,depth:"4"}],
  ["task-evidence","task",{taskId:"118174"}],
];
const observations = [];
const summary = [];
for (const concurrency of levels) {
  const jobs = Array.from({length:3},()=>cases).flat();
  let cursor=0;
  const start=performance.now();
  await Promise.all(Array.from({length:concurrency},async()=>{
    while(cursor<jobs.length){
      const [name,path,params]=jobs[cursor++]; const began=performance.now();
      try {
        const response=await fetch(new URL(`/api/${path}?${new URLSearchParams(params)}`,base),{signal:AbortSignal.timeout(15000)});
        const raw=await response.text(); const value=JSON.parse(raw);
        observations.push({concurrency,name,ms:Math.round(performance.now()-began),status:response.status,bytes:Buffer.byteLength(raw),serverMs:Number(response.headers.get("Server-Timing")?.match(/graph;dur=([\d.]+)/)?.[1]??0),requestId:response.headers.get("X-Graph-Request-Id"),nodes:value.nodes?.length,edges:value.edges?.length,truncated:value.truncated});
      }catch(error){observations.push({concurrency,name,ms:Math.round(performance.now()-began),status:0,error:error.name});}
    }
  }));
  const rows=observations.filter(r=>r.concurrency===concurrency);
  const times=rows.map(r=>r.ms).sort((a,b)=>a-b);
  const line={concurrency,requests:rows.length,elapsedMs:Math.round(performance.now()-start),p50:times[Math.ceil(times.length*.5)-1],p95:times[Math.ceil(times.length*.95)-1],max:times.at(-1),errors:rows.filter(r=>r.status!==200).length};
  summary.push(line); console.log(JSON.stringify(line));
  if(line.errors || line.p95>5000){console.log("Stopped increasing load after slow or failed requests.");break;}
}
const report={generatedAt:new Date().toISOString(),version:catalog.version,scope:"Current local API test, 8 operations repeated 3 times per concurrency; includes first use of the partition index. Browser rendering is measured separately, not a production capacity guarantee.",summary,observations};
await mkdir(dirname(out),{recursive:true}); await writeFile(out,JSON.stringify(report,null,2));
console.log(JSON.stringify({report:out}));
