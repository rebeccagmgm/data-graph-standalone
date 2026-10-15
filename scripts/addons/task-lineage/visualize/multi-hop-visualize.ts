import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMultiHopVizModel,
  type MultiHopVizModel,
} from "./multi-hop-viz-model";

type JsonRecord = Record<string, unknown>;

export interface MultiHopArtifact {
  readonly artifactType: "TABLE_MULTI_HOP_RECONCILIATION";
  readonly rootTaskId: string;
  readonly generatedAt: string;
  readonly taskNodes: readonly JsonRecord[];
  readonly tableNodes: readonly JsonRecord[];
  readonly readEdges: readonly JsonRecord[];
  readonly writeEdges: readonly JsonRecord[];
  readonly producerBridges: readonly JsonRecord[];
  readonly scheduleEdges: readonly JsonRecord[];
  readonly terminals: readonly JsonRecord[];
  readonly coverage: JsonRecord;
  readonly limits: JsonRecord;
  readonly counts: JsonRecord;
  readonly boundaries: JsonRecord;
  readonly contentHash: string;
}

export interface MultiHopVisualizationOptions {
  readonly taskId: string;
  readonly artifactPath?: string;
  readonly artifactDir?: string;
  readonly outputPath?: string;
  readonly vizModelPath?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function requireArtifact(value: unknown, source: string): MultiHopArtifact {
  const artifact = record(value);
  if (
    artifact.artifactType !== "TABLE_MULTI_HOP_RECONCILIATION" ||
    typeof artifact.rootTaskId !== "string" ||
    !Array.isArray(artifact.taskNodes) ||
    !Array.isArray(artifact.tableNodes) ||
    !Array.isArray(artifact.readEdges) ||
    !Array.isArray(artifact.writeEdges) ||
    !Array.isArray(artifact.producerBridges) ||
    !Array.isArray(artifact.scheduleEdges) ||
    !Array.isArray(artifact.terminals)
  )
    throw new Error(`MULTI_HOP_ARTIFACT_INVALID:${source}`);
  return artifact as unknown as MultiHopArtifact;
}

function artifactCandidates(taskId: string, artifactDir: string): string[] {
  return [
    join(artifactDir, `reconcile-multi-${taskId}.json`),
    join(artifactDir, `${taskId}.json`),
  ];
}

export function resolveMultiHopArtifactPath(
  options: Pick<MultiHopVisualizationOptions, "taskId" | "artifactPath" | "artifactDir">,
): string {
  if (options.artifactPath) {
    const path = resolve(options.artifactPath);
    if (!existsSync(path)) throw new Error(`MULTI_HOP_ARTIFACT_NOT_FOUND:${path}`);
    return path;
  }
  if (!options.artifactDir)
    throw new Error("MULTI_HOP_ARTIFACT_DIR_OR_PATH_REQUIRED");
  const candidates = artifactCandidates(options.taskId, resolve(options.artifactDir));
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path)
    throw new Error(`MULTI_HOP_ARTIFACT_NOT_FOUND:${candidates.join(",")}`);
  return path;
}

function readArtifact(path: string): MultiHopArtifact {
  return requireArtifact(JSON.parse(readFileSync(path, "utf8")), path);
}

function serializedModel(model: MultiHopVizModel): string {
  return JSON.stringify(model).replaceAll("<", "\\u003c");
}

export function renderMultiHopHtml(artifact: MultiHopArtifact): string {
  return renderMultiHopHtmlFromModel(
    buildMultiHopVizModel(artifact as unknown as JsonRecord),
  );
}

export function renderMultiHopHtmlFromModel(model: MultiHopVizModel): string {
  const data = serializedModel(model);
  const escapeHtml = (value: unknown): string =>
    text(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const title = `Multi-hop ${escapeHtml(model.meta.rootTaskId)}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light;--bg:#f4f6f8;--surface:#fff;--text:#1f2933;--muted:#667482;--node:#edf6f1;--node-line:#70a58a;--warn:#fff2dc;--warn-line:#d69a3a;--edge:#769184;--shadow:0 6px 20px rgba(38,55,72,.08)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Microsoft YaHei",sans-serif}header{padding:20px 26px 14px;background:var(--surface);border-bottom:1px solid #dbe2e9}h1{margin:0 0 3px;font-size:23px;font-weight:600}header p{margin:0;color:var(--muted)}main{padding:16px 20px}.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}.toolbar label{color:var(--muted)}.toolbar input{width:min(420px,100%);padding:8px 10px;border:1px solid #c8d2dc;border-radius:7px;background:var(--surface);color:var(--text)}.stats{color:var(--muted);font-size:12px}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:14px;align-items:start}.graph-shell{overflow:auto;background:var(--surface);border:1px solid #dbe2e9;border-radius:10px;box-shadow:var(--shadow);min-height:610px}.graph{display:block;min-width:880px}.detail{background:var(--surface);border:1px solid #dbe2e9;border-radius:10px;box-shadow:var(--shadow);padding:14px;position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto}.detail h2{margin:0 0 5px;font-size:17px}.detail p{margin:5px 0;color:var(--muted)}.detail-row{padding:8px 0;border-top:1px solid #e5e9ed}.detail-row strong{display:block}.detail-row small{display:block;color:var(--muted);margin-top:2px}.node{cursor:pointer}.node rect{stroke-width:1.3}.node text{pointer-events:none}.node.dim,.edge.dim{opacity:.12}.node.selected rect{stroke:#315d6e;stroke-width:2.5}.edge{fill:none;stroke:var(--edge);stroke-width:1.5;opacity:.72}.column-label{fill:var(--muted);font-size:12px;font-weight:600}.node-title{font-size:13px;font-weight:650;fill:var(--text)}.node-subtitle{font-size:11px;fill:var(--muted)}.node-status{font-size:10px;fill:var(--muted)}.legend{color:var(--muted);font-size:12px}.swatch{width:11px;height:11px;border-radius:3px;display:inline-block;background:var(--node);border:1px solid var(--node-line);margin-right:5px;vertical-align:-1px}@media(max-width:940px){.workspace{grid-template-columns:1fr}.detail{position:static;max-height:none}}
</style>
</head>
<body>
<header><h1>${title} · 血缘图</h1><p>每个节点 = 物理表 + 调度 ID + 对应分区 · 上游 → 目标 · ${escapeHtml(model.meta.contentHash).slice(0, 16)}…</p></header>
<main>
<div class="toolbar"><label for="search">搜索调度 ID / 表名</label><input id="search" type="search" placeholder="例如：181058、pdata_n.t98、121573" autocomplete="off"><div class="stats" id="stats"></div></div>
<div class="toolbar"><div class="legend"><i class="swatch"></i>血缘节点；同一物理表的多个调度合并在节点内，分区按调度分别列出。</div></div>
<div class="workspace"><section class="graph-shell" aria-label="multi-hop graph"><svg id="graph" class="graph" role="img" aria-label="从上游到目标的 multi-hop lineage graph"></svg></section><aside id="detail" class="detail" aria-live="polite"><h2>选择节点</h2><p>点击节点查看完整的表名、调度 ID 和分区。</p></aside></div>
</main>
<script>
const DATA=${data};
const svg=document.getElementById("graph"),detail=document.getElementById("detail"),search=document.getElementById("search"),stats=document.getElementById("stats"),NS="http://www.w3.org/2000/svg";
const nodeMap=new Map(),positions=new Map(),edgeGroups=[];
const el=(name,attrs={})=>{const n=document.createElementNS(NS,name);for(const [key,value] of Object.entries(attrs))n.setAttribute(key,String(value));return n};
const text=(value)=>String(value??""),uniqueText=(values)=>[...new Set(values)],taskKey=(id)=>"task:"+id,tableKey=(id)=>"table:"+id,taskId=(item)=>text(item.taskId),tableId=(item)=>text(item.id),tableName=(item)=>text(item.qualifiedName),terminalFor=(id)=>DATA.terminals.filter((item)=>taskId(item)===id),taskById=(id)=>DATA.tasks.find((item)=>taskId(item)===id),tableById=(id)=>DATA.tables.find((item)=>tableId(item)===id);
function short(value,max){const valueText=text(value);return valueText.length>max?valueText.slice(0,max-1)+"…":valueText}function addText(parent,x,y,className,value){const node=el("text",{x,y,class:className});node.textContent=value;parent.append(node)}
function detailTitle(title,subtitle){detail.replaceChildren();const h=document.createElement("h2");h.textContent=title;detail.append(h);if(subtitle){const p=document.createElement("p");p.textContent=subtitle;detail.append(p)}}function detailRow(title,subtitle){const row=document.createElement("div");row.className="detail-row";const strong=document.createElement("strong");strong.textContent=title;row.append(strong);if(subtitle){const small=document.createElement("small");small.textContent=subtitle;row.append(small)}detail.append(row)}
function showTask(item){const terms=terminalFor(taskId(item)),decision=item.upstreamDecision??{},outputs=item.outputTables??[],inputs=item.inputTables??[];detailTitle("调度 "+taskId(item),"深度 "+text(item.minDepth)+" · "+text(item.expansionStatus));detailRow("状态",terms.length?terms.map((term)=>text(term.reason)).join(" / "):"已展开");if(outputs.length){const heading=document.createElement("h3");heading.textContent="产出表与分区";detail.append(heading);for(const output of outputs){const partitions=(output.partitions??[]).map((part)=>text(part.display)).join("；")||"无确认分区";detailRow(text(output.table?.qualifiedName),partitions)}}if(inputs.length){const heading=document.createElement("h3");heading.textContent="依赖表";detail.append(heading);for(const input of inputs)detailRow(text(input.table?.qualifiedName),text(input.recursionStatus)||"已观察") }if(!outputs.length&&!inputs.length)detailRow("关联表","无已确认表关系");detailRow("递归入口","primary "+(decision.primary??[]).length+" · additional "+(decision.additional??[]).length+" · unknown "+(decision.unknown??[]).length);if((decision.primary??[]).length)detailRow("primary 调度",(decision.primary??[]).join(" / "))}
function showTable(item){const terminalReasons=item.terminalReasons??[];detailTitle(tableName(item),text(item.platform)+" · "+text(item.dataSource)+" · "+text(item.role));if(item.terminalBoundary==="REFERENCE_CONFIG")detailRow("血缘边界","定义/参考表，已停止继续溯源");else if(terminalReasons.length)detailRow("血缘边界",terminalReasons.join(" / "));detailRow("关系","生产任务 "+text(item.producerCount)+" 个 · 消费任务 "+text(item.consumerCount)+" 个 · 桥接证据 "+text(item.bridgeCount)+" 条");const ph=document.createElement("h3");ph.textContent="生产任务与分区";detail.append(ph);for(const group of item.producerGroups??[]){const partitions=(group.partitions??[]).map((part)=>text(part.display)).join("；")||"无确认分区";detailRow("调度 "+text(group.taskId),partitions)}if(!(item.producerGroups??[]).length)detailRow(item.terminalBoundary==="REFERENCE_CONFIG"?"无需查询生产任务":"无确认生产任务",item.terminalBoundary==="REFERENCE_CONFIG"?"配置表边界，不代表 producer 缺失":"该表仅作为输入，或生产任务未知");const ch=document.createElement("h3");ch.textContent="消费任务";detail.append(ch);for(const group of item.consumerGroups??[])detailRow("调度 "+text(group.taskId),(group.recursionStatuses??[]).join(" / ")||"已观察")}
function showEdge(edge){const isProduction=edge.kind==="WRITE";detailTitle(isProduction?"生产关系":"消费关系",text(edge.tableName));detailRow("方向",isProduction?"调度 → 表":"表 → 调度");detailRow("调度",text(edge.taskId));if(edge.partitionCount!==undefined)detailRow("分区证据",text(edge.partitionCount)+" 条");if(edge.readCount!==undefined)detailRow("依赖证据",text(edge.readCount)+" 条")}
function selectNode(key){for(const group of nodeMap.values())group.classList.remove("selected");const group=nodeMap.get(key);if(group)group.classList.add("selected");const parts=key.split(":"),kind=parts.shift(),id=parts.join(":");if(kind==="task"){const item=taskById(id);if(item)showTask(item)}else{const item=tableById(id);if(item)showTable(item)}}
function renderNode(item,key,x,y){const isTask=key.startsWith("task:"),label=isTask?"调度 "+taskId(item):tableName(item),taskTables=[...(item.outputTables??[]),...(item.inputTables??[])],hasTaskTables=isTask&&taskTables.length>0,tableHeight=118,cardHeight=isTask?(hasTaskTables?142:96):tableHeight,group=el("g",{class:"node",transform:"translate("+x+" "+y+")","data-key":key,"data-label":(label+" "+(isTask?taskTables.map((entry)=>text(entry.table?.qualifiedName)).join(" "):(item.producerTaskIds??[]).join(" ")+" "+(item.consumerTaskIds??[]).join(" "))).toLowerCase(),role:"button","aria-label":label});const terminal=isTask&&terminalFor(taskId(item)).length>0,terminalBoundary=!isTask&&item.terminalBoundary==="REFERENCE_CONFIG",rect=el("rect",{width:290,height:cardHeight,rx:10,fill:isTask?(terminal?"var(--warn)":"var(--task)"):"var(--table)",stroke:isTask?(terminal?"var(--warn-line)":"var(--task-line)"):"var(--table-line)"});group.append(rect);addText(group,15,24,"node-title",isTask?label:short(label,42));if(isTask){addText(group,15,46,"node-subtitle","深度 "+text(item.minDepth)+" · "+text(item.expansionStatus));const reasons=terminalFor(taskId(item)).map((term)=>text(term.reason));const tableNames=uniqueText(taskTables.map((entry)=>text(entry.table?.qualifiedName)).filter(Boolean));const outputPartitions=uniqueText((item.outputTables??[]).flatMap((entry)=>entry.partitions??[]).map((part)=>text(part.display)).filter(Boolean));addText(group,15,70,"node-status",reasons.length?"终止/证据："+short(reasons[0],31):item.hasTableEvidence?"已关联表":"无已确认表关系");if(hasTaskTables){addText(group,15,92,"node-subtitle","表："+short(tableNames.join(" / "),35));addText(group,15,114,"node-status",outputPartitions.length?"分区："+short(outputPartitions.join("；"),35):"分区：无确认分区")}}else{const producers=(item.producerTaskIds??[]).join(" / ")||"无确认 producer",consumers=(item.consumerTaskIds??[]).join(" / ")||"无确认 consumer",partitionRows=(item.producerGroups??[]).flatMap((group)=>group.partitions??[]),partitions=uniqueText(partitionRows.map((part)=>text(part.display)).filter(Boolean));addText(group,15,46,"node-subtitle","生产任务 "+short(producers,30));addText(group,15,66,"node-subtitle","消费任务 "+short(consumers,30));addText(group,15,88,"node-status",terminalBoundary?"定义/参考表 · 已停止溯源":partitions.length?"分区："+short(partitions.join("；"),36):"分区：无确认 WRITE 分区")}group.addEventListener("click",()=>selectNode(key));svg.append(group);nodeMap.set(key,group)}
function pathFor(from,to){const startX=from.x+from.w,startY=from.y+from.h/2,endX=to.x,endY=to.y+to.h/2,bend=Math.max(42,Math.abs(endX-startX)*.35);return "M "+startX+" "+startY+" C "+(startX+bend)+" "+startY+", "+(endX-bend)+" "+endY+", "+endX+" "+endY}
function drawEdge(fromKey,toKey,kind,edge){const from=positions.get(fromKey),to=positions.get(toKey);if(!from||!to)return;const label=kind+" "+text(edge.taskId)+" "+text(edge.tableName),path=el("path",{d:pathFor(from,to),class:"edge "+kind.toLowerCase(),"marker-end":"url(#arrow)","data-label":label.toLowerCase(),"data-from":fromKey,"data-to":toKey});path.addEventListener("click",()=>showEdge(edge));svg.insertBefore(path,svg.children[1]??null);edgeGroups.push(path)}
 function draw(){svg.replaceChildren();nodeMap.clear();positions.clear();edgeGroups.length=0;const items=[...DATA.tasks,...DATA.tables].sort((a,b)=>Number(a.layoutColumn??0)-Number(b.layoutColumn??0)||text(a.qualifiedName??a.taskId).localeCompare(text(b.qualifiedName??b.taskId),"zh-Hans",{numeric:true})),columns=new Map(),addColumn=(column,item,key)=>{const list=columns.get(column)??[];list.push({item,key});columns.set(column,list)};for(const item of items)addColumn(Number(item.layoutColumn??0),item,item.kind==="TABLE"?tableKey(tableId(item)):taskKey(taskId(item)));let maxColumn=0,maxRows=1;for(const [column,list] of columns){maxColumn=Math.max(maxColumn,column);maxRows=Math.max(maxRows,list.length)}const width=Math.max(980,(maxColumn+1)*350+90),height=Math.max(640,maxRows*165+100);svg.setAttribute("viewBox","0 0 "+width+" "+height);svg.setAttribute("width",width);svg.setAttribute("height",height);const defs=el("defs"),marker=el("marker",{id:"arrow",markerWidth:8,markerHeight:8,refX:7,refY:4,orient:"auto"});marker.append(el("path",{d:"M0,0 L8,4 L0,8 z",fill:"currentColor"}));defs.append(marker);svg.append(defs);for(const [column,list] of [...columns.entries()].sort((a,b)=>a[0]-b[0])){const label=el("text",{x:column*350+55,y:24,class:"column-label"});label.textContent=column===0?"上游":column===maxColumn?"目标":"血缘节点";svg.append(label);list.forEach(({item,key},index)=>{const x=column*350+35,y=42+index*165;const h=item.kind==="TABLE"?118:((item.outputTables??[]).length+(item.inputTables??[]).length>0?142:96);positions.set(key,{x,y,w:290,h});renderNode(item,key,x,y)})}for(const edge of DATA.producerEdges)drawEdge(taskKey(text(edge.fromTaskId)),tableKey(text(edge.toTableId)),"WRITE",edge);for(const edge of DATA.consumerEdges)drawEdge(tableKey(text(edge.fromTableId)),taskKey(text(edge.toTaskId)),"READ",edge)}
const lineageNodeById=(id)=>DATA.lineageNodes.find((item)=>text(item.id)===id);
function partitionsForNode(group){return uniqueText((group.partitions??[]).map((part)=>text(part.display)).filter(Boolean))}
function showLineageNode(item){detailTitle(text(item.qualifiedName),text(item.platform)+" · "+text(item.dataSource));const groups=item.producerGroups??[];if(groups.length){for(const group of groups){const partitions=partitionsForNode(group);detailRow("调度 "+text(group.taskId),partitions.length?partitions.join("；"):"无确认分区")}}else if(item.terminalBoundary==="REFERENCE_CONFIG")detailRow("血缘边界","定义/参考表，已停止继续溯源");else detailRow("调度未确认","当前静态证据仅确认该物理表");if((item.terminalReasons??[]).length)detailRow("终止语义",item.terminalReasons.join(" / "));if(item.evidenceBoundary)detailRow("证据边界",text(item.evidenceBoundary))}
function showLineageEdge(edge){detailTitle("上游依赖","经调度 "+text(edge.viaTaskId));detailRow("上游节点",text(lineageNodeById(text(edge.fromNodeId))?.qualifiedName));detailRow("下游节点",text(lineageNodeById(text(edge.toNodeId))?.qualifiedName));if(edge.isCycle)detailRow("状态","CYCLE")}
function selectLineageNode(key){for(const group of nodeMap.values())group.classList.remove("selected");const group=nodeMap.get(key);if(group)group.classList.add("selected");const item=lineageNodeById(key);if(item)showLineageNode(item)}
function splitFull(value,max){const lines=[];let rest=text(value);if(!rest)return [""];while(rest.length>max){let cut=Math.max(rest.lastIndexOf("_",max),rest.lastIndexOf(".",max),rest.lastIndexOf(" ",max));if(cut<Math.floor(max*.55))cut=max;else cut+=1;lines.push(rest.slice(0,cut));rest=rest.slice(cut)}lines.push(rest);return lines}
function lineageNodeMetrics(item){const groups=item.producerGroups??[],taskIds=(item.producerTaskIds??[]).map((id)=>text(id)),nameLines=splitFull(item.qualifiedName,48),taskLines=splitFull("调度："+(taskIds.join(" / ")||"未确认"),48),partitionLines=[];if(groups.length){for(const group of groups){const partitions=partitionsForNode(group),value="分区："+text(group.taskId)+" · "+(partitions.length?partitions.join("；"):"无确认分区");partitionLines.push(...splitFull(value,52))}}else partitionLines.push(item.terminalBoundary==="REFERENCE_CONFIG"?"边界：定义/参考表 · 已停止溯源":"分区：无确认分区");return {nameLines,taskLines,partitionLines,height:22+nameLines.length*18+taskLines.length*17+partitionLines.length*17+14}}
function renderLineageNode(item,x,y,metrics){const key=text(item.id),taskIds=(item.producerTaskIds??[]).map((id)=>text(id)),warning=item.nodeType==="UNKNOWN_OUTPUT"||(item.terminalReasons??[]).length>0,group=el("g",{class:"node",transform:"translate("+x+" "+y+")","data-key":key,"data-label":(text(item.qualifiedName)+" "+taskIds.join(" ")+" "+metrics.partitionLines.join(" ")).toLowerCase(),role:"button","aria-label":text(item.qualifiedName)+" "+taskIds.join(" ")});group.append(el("rect",{width:360,height:metrics.height,rx:10,fill:warning?"var(--warn)":"var(--node)",stroke:warning?"var(--warn-line)":"var(--node-line)"}));let lineY=25;for(const line of metrics.nameLines){addText(group,15,lineY,"node-title",line);lineY+=18}for(const line of metrics.taskLines){addText(group,15,lineY,"node-subtitle",line);lineY+=17}for(const line of metrics.partitionLines){addText(group,15,lineY,"node-status",line);lineY+=17}group.addEventListener("click",()=>selectLineageNode(key));svg.append(group);nodeMap.set(key,group)}
function lineagePath(from,to,isCycle){if(isCycle)return "M "+(from.x+from.w)+" "+(from.y+from.h*.3)+" C "+(from.x+from.w+62)+" "+(from.y+8)+", "+(from.x+from.w+62)+" "+(from.y+from.h-8)+", "+(from.x+from.w)+" "+(from.y+from.h*.7);const startX=from.x+from.w,startY=from.y+from.h/2,endX=to.x,endY=to.y+to.h/2,bend=Math.max(42,Math.abs(endX-startX)*.35);return "M "+startX+" "+startY+" C "+(startX+bend)+" "+startY+", "+(endX-bend)+" "+endY+", "+endX+" "+endY}
function drawLineageEdge(edge){const from=positions.get(text(edge.fromNodeId)),to=positions.get(text(edge.toNodeId));if(!from||!to)return;const path=el("path",{d:lineagePath(from,to,Boolean(edge.isCycle)),class:"edge","marker-end":"url(#arrow)","data-label":("经调度 "+text(edge.viaTaskId)).toLowerCase(),"data-from":text(edge.fromNodeId),"data-to":text(edge.toNodeId)});path.addEventListener("click",()=>showLineageEdge(edge));svg.insertBefore(path,svg.children[1]??null);edgeGroups.push(path)}
function drawLineage(){svg.replaceChildren();nodeMap.clear();positions.clear();edgeGroups.length=0;const rawColumns=uniqueText(DATA.lineageNodes.map((item)=>Number(item.layoutColumn??0))).sort((a,b)=>a-b),columnIndex=new Map(rawColumns.map((value,index)=>[value,index])),columns=new Map();for(const item of DATA.lineageNodes){const column=columnIndex.get(Number(item.layoutColumn??0))??0,list=columns.get(column)??[];list.push(item);columns.set(column,list)}const maxColumn=Math.max(0,rawColumns.length-1),width=Math.max(980,(maxColumn+1)*430+80);let height=640;const defs=el("defs"),marker=el("marker",{id:"arrow",markerWidth:8,markerHeight:8,refX:7,refY:4,orient:"auto"});marker.append(el("path",{d:"M0,0 L8,4 L0,8 z",fill:"var(--edge)"}));defs.append(marker);svg.append(defs);for(const [column,list] of [...columns.entries()].sort((a,b)=>a[0]-b[0])){list.sort((a,b)=>text(a.qualifiedName).localeCompare(text(b.qualifiedName),"zh-Hans",{numeric:true}));const label=el("text",{x:column*430+48,y:23,class:"column-label"});label.textContent=column===0?"上游":column===maxColumn?"目标":"第 "+column+" 层";svg.append(label);let y=40;for(const item of list){const metrics=lineageNodeMetrics(item),x=column*430+35;positions.set(text(item.id),{x,y,w:360,h:metrics.height});renderLineageNode(item,x,y,metrics);y+=metrics.height+24}height=Math.max(height,y+40)}svg.setAttribute("viewBox","0 0 "+width+" "+height);svg.setAttribute("width",width);svg.setAttribute("height",height);for(const edge of DATA.lineageEdges)drawLineageEdge(edge)}
stats.textContent="血缘节点 "+DATA.lineageNodes.length+" · 依赖关系 "+DATA.lineageEdges.length+" · 同表多调度已合并";search.addEventListener("input",()=>{const query=search.value.trim().toLowerCase(),visible=new Set();for(const [key,group] of nodeMap){const match=!query||group.dataset.label.includes(query);group.classList.toggle("dim",!match);if(match)visible.add(key)}for(const edge of edgeGroups){const match=!query||edge.dataset.label.includes(query)||visible.has(edge.dataset.from)||visible.has(edge.dataset.to);edge.classList.toggle("dim",!match)}});drawLineage();
</script>
</body>
</html>
`;
}

export function visualizeMultiHop(options: MultiHopVisualizationOptions): string {
  const artifactPath = resolveMultiHopArtifactPath(options);
  const artifact = readArtifact(artifactPath);
  const model = buildMultiHopVizModel(artifact as unknown as JsonRecord);
  if (artifact.rootTaskId !== options.taskId)
    throw new Error(`MULTI_HOP_TASK_ID_MISMATCH:${artifact.rootTaskId}`);
  const outputPath = resolve(
    options.outputPath ?? join(dirname(artifactPath), `multi-hop-${options.taskId}.html`),
  );
  const vizModelPath = resolve(
    options.vizModelPath ?? join(dirname(outputPath), `viz-model-${options.taskId}.json`),
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(vizModelPath), { recursive: true });
  writeFileSync(vizModelPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
  writeFileSync(outputPath, renderMultiHopHtmlFromModel(model), "utf8");
  return outputPath;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function main(): void {
  const argv = process.argv.slice(2);
  const taskId = option(argv, "--task-id");
  if (!taskId) throw new Error("TASK_ID_REQUIRED");
  const outputPath = visualizeMultiHop({
    taskId,
    artifactPath: option(argv, "--artifact"),
    artifactDir: option(argv, "--artifact-dir"),
    outputPath: option(argv, "--output"),
    vizModelPath: option(argv, "--viz-model"),
  });
  process.stdout.write(`${JSON.stringify({ taskId, output: outputPath })}\n`);
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) main();
