import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson, safeSegment, sha256 } from "../../contracts/runtime.ts";
import { compareText } from "../contracts/project-topology-contract.ts";
import type {
  FieldEvidenceProjectionV1,
  FieldEvidenceTargetIdentity,
} from "../field-evidence/field-evidence-contract.ts";
import { loadFieldEvidenceDirectory } from "../field-evidence/field-evidence-publication.ts";

const FIELD_VIEW_SCHEMA_VERSION = "1.0.0" as const;
const FIELD_VIEW_VERSION = "1.0.0" as const;
const FIELD_CATALOG_TYPE = "PROJECT_FIELD_DRILLDOWN_CATALOG" as const;
const FIELD_BUNDLE_TYPE = "PROJECT_FIELD_DRILLDOWN_BUNDLE" as const;
const DEFAULT_MAX_FIELD_EVIDENCE_BYTES = 512 * 1024 * 1024;

export const FIELD_CATALOG_FILE = "field-catalog.json" as const;
export const FIELD_CLIENT_FILE = "field-drilldown.js" as const;
export const TOPOLOGY_VIEW_FILE = "topology.html" as const;

export interface ProjectFieldCatalogEntry {
  readonly taskId: string;
  readonly taskLabel: string;
  readonly taskName: string | null;
  readonly taskDisplayStatus: string;
  readonly snapshotId: string;
  readonly sourceCoverage: string;
  readonly sliceCoverage: string;
  readonly target: FieldEvidenceTargetIdentity;
  readonly writeObservationId: string;
  readonly fields: readonly {
    readonly name: string;
    readonly stateId: string;
  }[];
  readonly bundleFile: string;
  readonly counts: {
    readonly nodes: number;
    readonly edges: number;
    readonly boundaries: number;
    readonly gaps: number;
    readonly candidates: number;
    readonly controls: number;
  };
}

export interface ProjectFieldDrilldownCatalog {
  readonly schemaVersion: typeof FIELD_VIEW_SCHEMA_VERSION;
  readonly artifactType: typeof FIELD_CATALOG_TYPE;
  readonly viewVersion: typeof FIELD_VIEW_VERSION;
  readonly projectKey: string;
  readonly projectSnapshotId: string;
  readonly totalFields: number;
  readonly tasks: readonly ProjectFieldCatalogEntry[];
}

export interface ProjectFieldDrilldownBundle {
  readonly schemaVersion: typeof FIELD_VIEW_SCHEMA_VERSION;
  readonly artifactType: typeof FIELD_BUNDLE_TYPE;
  readonly viewVersion: typeof FIELD_VIEW_VERSION;
  readonly projectKey: string;
  readonly projectSnapshotId: string;
  readonly taskId: string;
  readonly fieldEvidenceSnapshotId: string;
  readonly fieldEvidenceContentHash: string;
  readonly selection: FieldEvidenceProjectionV1["snapshot"]["selection"];
  readonly slice: FieldEvidenceProjectionV1["snapshot"]["slice"];
  readonly nodes: FieldEvidenceProjectionV1["nodes"];
  readonly edges: FieldEvidenceProjectionV1["edges"];
}

export interface ProjectFieldDrilldownFile {
  readonly fileName: string;
  readonly contents: string;
}

export interface ProjectFieldDrilldownAssets {
  readonly catalog: ProjectFieldDrilldownCatalog;
  readonly html: string;
  readonly files: readonly ProjectFieldDrilldownFile[];
  readonly sources: readonly {
    readonly taskId: string;
    readonly snapshotId: string;
    readonly snapshotContentHash: string;
    readonly manifestContentHash: string;
  }[];
}

export function buildProjectFieldDrilldownAssets(options: {
  readonly projectKey: string;
  readonly projectSnapshotId: string;
  readonly rootTaskIds: readonly string[];
  readonly taskLabels: readonly {
    readonly taskId: string;
    readonly taskName: string | null;
    readonly status: string;
  }[];
  readonly fieldEvidenceDirectories: readonly string[];
  readonly maxFieldEvidenceBytes?: number;
}): ProjectFieldDrilldownAssets {
  const maxFileBytes = positiveInteger(
    options.maxFieldEvidenceBytes ?? DEFAULT_MAX_FIELD_EVIDENCE_BYTES,
    "MAX_FIELD_EVIDENCE_BYTES",
  );
  const labels = new Map(
    options.taskLabels.map((label) => [label.taskId, label]),
  );
  const rootTaskIds = new Set(options.rootTaskIds);
  const seenTasks = new Set<string>();
  const entries: ProjectFieldCatalogEntry[] = [];
  const bundles: {
    readonly entry: ProjectFieldCatalogEntry;
    readonly bundle: ProjectFieldDrilldownBundle;
  }[] = [];
  const sources: ProjectFieldDrilldownAssets["sources"][number][] = [];

  for (const directory of options.fieldEvidenceDirectories) {
    const loaded = loadFieldEvidenceDirectory(directory, { maxFileBytes });
    const snapshot = loaded.projection.snapshot;
    const taskId = safeSegment(snapshot.selection.rootTaskId, "rootTaskId");
    if (snapshot.projectKey !== options.projectKey)
      throw new Error(`PROJECT_FIELD_DRILLDOWN_PROJECT_KEY_MISMATCH:${taskId}`);
    if (snapshot.projectSource.snapshotId !== options.projectSnapshotId)
      throw new Error(
        `PROJECT_FIELD_DRILLDOWN_PROJECT_SNAPSHOT_MISMATCH:${taskId}`,
      );
    if (!rootTaskIds.has(taskId))
      throw new Error(`PROJECT_FIELD_DRILLDOWN_ROOT_TASK_MISSING:${taskId}`);
    if (seenTasks.has(taskId))
      throw new Error(`PROJECT_FIELD_DRILLDOWN_TASK_DUPLICATE:${taskId}`);
    seenTasks.add(taskId);

    const nodeById = new Map(
      loaded.projection.nodes.map((node) => [node.nodeId, node]),
    );
    const fields = snapshot.selection.rootFields.map((name) => {
      const stateId = snapshot.selection.rootStateIds[name];
      const node = stateId ? nodeById.get(stateId) : undefined;
      if (!stateId || node?.nodeType !== "FIELD_BINDING_STATE")
        throw new Error(
          `PROJECT_FIELD_DRILLDOWN_ROOT_STATE_INVALID:${taskId}:${name}`,
        );
      return { name, stateId };
    });
    if (fields.length === 0)
      throw new Error(`PROJECT_FIELD_DRILLDOWN_FIELDS_EMPTY:${taskId}`);
    const bundleFile = `field-data/${safeSegment(taskId, "taskId")}-${snapshot.snapshotId}.json`;
    const label = labels.get(taskId);
    const entry: ProjectFieldCatalogEntry = {
      taskId,
      taskLabel: label?.taskName ? `${label.taskName} (${taskId})` : taskId,
      taskName: label?.taskName ?? null,
      taskDisplayStatus: label?.status ?? "MISSING",
      snapshotId: snapshot.snapshotId,
      sourceCoverage: snapshot.slice.sourceOverallStatus,
      sliceCoverage: snapshot.slice.coverageStatus,
      target: snapshot.selection.target,
      writeObservationId: snapshot.selection.writeObservationId,
      fields,
      bundleFile,
      counts: {
        nodes: loaded.manifest.counts.nodes,
        edges: loaded.manifest.counts.edges,
        boundaries: loaded.manifest.counts.boundaries,
        gaps: snapshot.slice.gaps,
        candidates: snapshot.slice.candidates,
        controls: snapshot.slice.controls,
      },
    };
    const bundle: ProjectFieldDrilldownBundle = {
      schemaVersion: FIELD_VIEW_SCHEMA_VERSION,
      artifactType: FIELD_BUNDLE_TYPE,
      viewVersion: FIELD_VIEW_VERSION,
      projectKey: options.projectKey,
      projectSnapshotId: options.projectSnapshotId,
      taskId,
      fieldEvidenceSnapshotId: snapshot.snapshotId,
      fieldEvidenceContentHash: snapshot.contentHash,
      selection: snapshot.selection,
      slice: snapshot.slice,
      nodes: loaded.projection.nodes,
      edges: loaded.projection.edges,
    };
    entries.push(entry);
    bundles.push({ entry, bundle });
    sources.push({
      taskId,
      snapshotId: snapshot.snapshotId,
      snapshotContentHash: snapshot.contentHash,
      manifestContentHash: loaded.manifest.contentHash,
    });
  }

  entries.sort((left, right) => compareText(left.taskId, right.taskId));
  bundles.sort((left, right) =>
    compareText(left.entry.taskId, right.entry.taskId),
  );
  sources.sort((left, right) => compareText(left.taskId, right.taskId));
  const catalog: ProjectFieldDrilldownCatalog = {
    schemaVersion: FIELD_VIEW_SCHEMA_VERSION,
    artifactType: FIELD_CATALOG_TYPE,
    viewVersion: FIELD_VIEW_VERSION,
    projectKey: options.projectKey,
    projectSnapshotId: options.projectSnapshotId,
    totalFields: entries.reduce(
      (total, entry) => total + entry.fields.length,
      0,
    ),
    tasks: entries,
  };
  const clientSource = readFileSync(
    fileURLToPath(new URL("./field-drilldown-client.mjs", import.meta.url)),
    "utf8",
  );
  return {
    catalog,
    html: renderProjectFieldDrilldownHtml(
      catalog,
      sha256(Buffer.from(clientSource, "utf8")).slice(0, 16),
    ),
    files: [
      { fileName: FIELD_CATALOG_FILE, contents: `${canonicalJson(catalog)}\n` },
      {
        fileName: FIELD_CLIENT_FILE,
        contents: clientSource.endsWith("\n")
          ? clientSource
          : `${clientSource}\n`,
      },
      ...bundles.map(({ entry, bundle }) => ({
        fileName: entry.bundleFile,
        contents: `${canonicalJson(bundle)}\n`,
      })),
    ].sort((left, right) => compareText(left.fileName, right.fileName)),
    sources,
  };
}

export function renderProjectFieldDrilldownHtml(
  catalog: ProjectFieldDrilldownCatalog,
  clientVersion: string = FIELD_VIEW_VERSION,
): string {
  const title = escapeHtml(`字段证据地图 · ${catalog.projectKey}`);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:light-dark(#f4f7f8,#0e1418);--surface:light-dark(#fff,#182127);--surface2:light-dark(#eef4f6,#202c33);--text:light-dark(#1b2830,#edf3f5);--muted:light-dark(#65757f,#a9b8c1);--line:light-dark(#d6e0e4,#35434c);--blue:light-dark(#176d9a,#6ec0eb);--green:light-dark(#207454,#6dd0a3);--orange:light-dark(#9a6019,#e9af69);--red:light-dark(#a43d43,#ef8e95);--purple:light-dark(#6b4e92,#baa0dd)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Microsoft YaHei",sans-serif}button,input,select{font:inherit}button{cursor:pointer}header{padding:18px 22px 14px;background:var(--surface);border-bottom:1px solid var(--line)}h1,h2,p{margin:0}h1{font-size:22px;font-weight:650}h2{font-size:16px}.meta{margin-top:5px;color:var(--muted);font-size:12px}.nav{margin-top:10px}.nav a{color:var(--blue);text-decoration:none;margin-right:16px}.nav a[aria-current="page"]{font-weight:650}main{max-width:1800px;margin:0 auto;padding:16px 18px 28px}.summary{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:9px;margin-bottom:14px}.summary-card{padding:11px 12px;background:var(--surface);border:1px solid var(--line);border-radius:8px}.summary-card strong{display:block;font-size:21px}.summary-card span{display:block;color:var(--muted);margin-top:2px}.toolbar{display:flex;gap:9px;align-items:end;flex-wrap:wrap;margin-bottom:12px}.field-control{display:grid;gap:4px;color:var(--muted);font-size:12px}.field-control input,.field-control select{min-width:230px;padding:8px 9px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text)}.workspace{display:grid;grid-template-columns:310px minmax(640px,1fr) 350px;gap:12px;align-items:start}.panel{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:9px}.panel-title{padding:11px 12px;border-bottom:1px solid var(--line);font-weight:650}.result-meta,.annotation-summary{padding:8px 11px;color:var(--muted);font-size:12px;border-bottom:1px solid var(--line)}.field-results{max-height:740px;overflow:auto}.field-result,.annotation{display:block;width:100%;padding:9px 11px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);text-align:left}.field-result:hover,.annotation:hover{background:var(--surface2)}.field-result strong,.annotation strong{display:block;font-weight:550;overflow-wrap:anywhere}.field-result small,.annotation small{display:block;color:var(--muted);margin-top:2px;overflow-wrap:anywhere}.annotation.danger strong,.warning{color:var(--red)}.annotation.caution strong{color:var(--orange)}.graph-shell{overflow:auto;min-height:740px}.field-graph{display:block;min-width:920px}.field-node{cursor:pointer}.field-node rect{fill:var(--surface2);stroke:var(--line);stroke-width:1.2}.field-node.selected rect{stroke:var(--blue);stroke-width:2.6}.field-node-title{fill:var(--text);font-size:12px;font-weight:650}.field-node-sub,.svg-empty{fill:var(--muted);font-size:10px}.field-edge{fill:none;stroke:var(--muted);stroke-width:1.5;opacity:.78;cursor:pointer}.field-edge:hover{stroke:var(--blue);stroke-width:3}.field-edge+*{}marker path{fill:var(--muted)}.right-column{display:grid;gap:12px;position:sticky;top:10px;max-height:calc(100vh - 20px);overflow:auto}.detail{padding:12px}.detail-subtitle{margin-top:5px;color:var(--muted);overflow-wrap:anywhere}.detail-row{padding:8px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}.detail-row strong{display:block;font-weight:550}.detail-row small{display:block;color:var(--muted);margin-top:2px;white-space:pre-wrap;overflow-wrap:anywhere}.annotations{max-height:430px;overflow:auto}.empty{padding:18px;color:var(--muted)}@media(max-width:1220px){.workspace{grid-template-columns:290px minmax(560px,1fr)}.right-column{grid-column:1/-1;position:static;max-height:none;grid-template-columns:1fr 1fr}}@media(max-width:760px){main{padding:12px}.summary{grid-template-columns:1fr 1fr}.workspace{grid-template-columns:1fr}.right-column{grid-column:auto;grid-template-columns:1fr}.field-control{width:100%}.field-control input,.field-control select{width:100%}.field-results{max-height:380px}.graph-shell{min-height:520px}}
.conclusion{margin-bottom:12px;padding:14px 16px;background:light-dark(#edf7fb,#172a34);border:1px solid light-dark(#b9dcea,#31566a);border-radius:9px}.conclusion.warning-box{background:light-dark(#fff7eb,#342617);border-color:light-dark(#ebc98e,#7a572a)}.conclusion-content strong{display:block;font-size:17px}.conclusion-content p{margin-top:4px;font-size:15px}.conclusion-content small{display:block;margin-top:5px;color:var(--muted)}.field-result.selected{background:light-dark(#e8f4f9,#203743);box-shadow:inset 4px 0 var(--blue)}.graph-header{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line)}.graph-heading strong{display:block}.graph-heading small{display:block;margin-top:2px;color:var(--muted)}.mode-switch{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.mode-button{padding:6px 9px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text)}.mode-button.active{border-color:var(--blue);background:light-dark(#e4f2f8,#203b48);color:var(--blue);font-weight:650}.graph-shell{min-height:620px}.task-node{cursor:pointer}.task-node rect{fill:var(--surface2);stroke:var(--line);stroke-width:1.4}.task-node.target rect{fill:light-dark(#e5f4fa,#1d3946);stroke:var(--blue);stroke-width:2.5}.task-node:hover rect{stroke:var(--blue)}.task-node-title{fill:var(--text);font-size:13px;font-weight:650}.task-node-meta,.task-field-label,.task-edge-label,.task-direction{fill:var(--muted);font-size:10px}.task-field-label{fill:var(--text)}.task-edge{stroke:var(--blue);stroke-width:2}.task-edge-label{font-weight:650;fill:var(--blue)}.evidence-details>summary{cursor:pointer;list-style-position:inside}.evidence-details[open]>summary{color:var(--blue)}@media(max-width:760px){.graph-header{align-items:flex-start;flex-direction:column}.mode-switch{justify-content:flex-start}.conclusion-content p{font-size:14px}}
</style>
</head>
<body>
<header><h1>${title}</h1><p class="meta">搜索目标字段后，默认先看按任务折叠的上游链；需要核验时再打开精确绑定图和证据详情。</p><p class="meta">静态证据不等于调度运行、数据到达或业务正确性。项目快照 ${escapeHtml(catalog.projectSnapshotId)}</p><nav class="nav"><a href="./index.html" aria-current="page">字段下钻</a><a href="./${TOPOLOGY_VIEW_FILE}">联合拓扑</a></nav></header>
<main data-field-drilldown data-catalog="./${FIELD_CATALOG_FILE}">
<section id="fieldSummary" class="summary" aria-label="字段规模"></section>
<div class="toolbar"><label class="field-control">字段搜索<input id="fieldSearch" type="search" placeholder="字段名、任务名称、ID、目标表" autocomplete="off"></label><label class="field-control">根任务<select id="fieldTask"></select></label></div>
<section id="fieldConclusion" class="conclusion" aria-live="polite"></section>
<div class="workspace"><section class="panel"><div class="panel-title">1. 选择目标字段</div><div id="fieldResultMeta" class="result-meta"></div><div id="fieldResults" class="field-results"></div></section><section class="panel"><div class="graph-header"><div class="graph-heading"><strong id="fieldGraphTitle">2. 查看上游任务链</strong><small>左边更上游，右边是目标；箭头只表示确认的值流。</small></div><div class="mode-switch" aria-label="图显示模式"><button id="fieldTaskMode" class="mode-button active" type="button" aria-pressed="true">任务链</button><button id="fieldExactMode" class="mode-button" type="button" aria-pressed="false">精确绑定图</button></div></div><div class="graph-shell"><svg id="fieldGraph" class="field-graph" role="img" aria-label="所选字段的局部上游图"></svg></div></section><div class="right-column"><aside id="fieldDetail" class="panel detail" aria-live="polite"><h2>3. 当前目标</h2><div class="empty">请选择一个字段。</div></aside><details class="panel evidence-details"><summary id="fieldAnnotationTitle" class="panel-title">证据详情（选择字段后显示）</summary><div id="fieldAnnotations" class="annotations"><div class="empty">选择字段后显示。</div></div></details></div></div>
</main>
<script type="module" src="./${FIELD_CLIENT_FILE}?v=${escapeHtml(clientVersion)}"></script>
</body>
</html>
`;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label}_INVALID`);
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
