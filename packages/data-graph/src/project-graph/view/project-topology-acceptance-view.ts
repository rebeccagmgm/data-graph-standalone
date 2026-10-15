import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { canonicalJson, safeSegment, sha256 } from "../../contracts/runtime.ts";
import {
  compareText,
  projectKeySegment,
  sortedUnique,
  type ProjectTopologyEdgeRecord,
  type ProjectTopologyEvidenceRef,
  type ProjectTopologyNodeRecord,
  type ProjectTopologyProjectionV1,
} from "../contracts/project-topology-contract.ts";
import { loadProjectTopologyDirectory } from "../topology/project-topology-publication.ts";
import {
  TOPOLOGY_VIEW_FILE,
  buildProjectFieldDrilldownAssets,
} from "./project-field-drilldown.ts";

const VIEW_SCHEMA_VERSION = "1.0.0" as const;
const VIEW_VERSION = "1.1.0" as const;
const VIEW_ARTIFACT_TYPE = "PROJECT_TOPOLOGY_ACCEPTANCE_VIEW" as const;
const VIEW_HTML_FILE = "index.html" as const;
const VIEW_MANIFEST_FILE = "view-manifest.json" as const;
const MAX_ROOTS = 8;
const DEFAULT_MAX_TASK_PACK_BYTES = 16 * 1024 * 1024;
const MAX_EDGE_EVIDENCE_REFS = 8;
const MAX_EDGE_OBSERVATIONS = 12;

type JsonRecord = Record<string, unknown>;

export type TaskDisplayStatus =
  | "VERIFIED"
  | "UNVERIFIED"
  | "MISSING"
  | "AMBIGUOUS"
  | "HASH_MISMATCH"
  | "INVALID";

export interface TaskDisplayLabel {
  readonly taskId: string;
  readonly status: TaskDisplayStatus;
  readonly taskName: string | null;
  readonly taskType: string | null;
  readonly topicName: string | null;
  readonly logicalLocator: string | null;
  readonly contentHash: string | null;
  readonly expectedContentHashes: readonly string[];
  readonly candidateCount: number;
}

export interface ProjectTopologyViewNode {
  readonly id: string;
  readonly type: ProjectTopologyNodeRecord["nodeType"];
  readonly label: string;
  readonly secondary: string;
  readonly roots: readonly string[];
  readonly groupKey: string;
  readonly properties: Readonly<Record<string, string | number | null>>;
  readonly taskDisplayStatus: TaskDisplayStatus | null;
}

export interface ProjectTopologyViewEdge {
  readonly id: string;
  readonly type: ProjectTopologyEdgeRecord["edgeType"];
  readonly layer: ProjectTopologyEdgeRecord["relationLayer"];
  readonly from: string;
  readonly to: string;
  readonly roots: readonly string[];
  readonly sourceArtifactRoots: readonly string[];
  readonly observationSummaries: readonly string[];
  readonly observationCount: number;
  readonly evidenceRefs: readonly ProjectTopologyEvidenceRef[];
  readonly evidenceCount: number;
  readonly evidenceTruncated: boolean;
}

export interface ProjectTopologyViewGroup {
  readonly key: string;
  readonly roots: readonly string[];
  readonly label: string;
  readonly tasks: number;
  readonly datasets: number;
  readonly boundaries: number;
}

export interface ProjectTopologyAcceptanceViewModel {
  readonly schemaVersion: typeof VIEW_SCHEMA_VERSION;
  readonly artifactType: typeof VIEW_ARTIFACT_TYPE;
  readonly viewVersion: typeof VIEW_VERSION;
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly projectKey: string;
  readonly coverageStatus: string;
  readonly roots: readonly {
    readonly taskId: string;
    readonly label: string;
    readonly taskName: string | null;
    readonly taskDisplayStatus: TaskDisplayStatus;
    readonly tasks: number;
    readonly datasets: number;
    readonly boundaries: number;
  }[];
  readonly groups: readonly ProjectTopologyViewGroup[];
  readonly nodes: readonly ProjectTopologyViewNode[];
  readonly edges: readonly ProjectTopologyViewEdge[];
  readonly relationCounts: Readonly<Record<string, number>>;
  readonly boundaryCounts: Readonly<Record<string, number>>;
  readonly taskDisplayCounts: Readonly<Record<TaskDisplayStatus, number>>;
  readonly taskLabels: readonly TaskDisplayLabel[];
}

export interface ProjectTopologyViewManifest {
  readonly schemaVersion: typeof VIEW_SCHEMA_VERSION;
  readonly artifactType: typeof VIEW_ARTIFACT_TYPE;
  readonly viewVersion: typeof VIEW_VERSION;
  readonly viewId: string;
  readonly projectKey: string;
  readonly snapshotId: string;
  readonly snapshotContentHash: string;
  readonly rootTaskIds: readonly string[];
  readonly modelContentHash: string;
  readonly counts: {
    readonly nodes: number;
    readonly edges: number;
    readonly boundaries: number;
    readonly fieldTasks: number;
    readonly fields: number;
    readonly taskLabels: Readonly<Record<TaskDisplayStatus, number>>;
  };
  readonly sourceTaskPacks: readonly {
    readonly taskId: string;
    readonly status: TaskDisplayStatus;
    readonly logicalLocator: string | null;
    readonly contentHash: string | null;
  }[];
  readonly sourceFieldEvidence: readonly {
    readonly taskId: string;
    readonly snapshotId: string;
    readonly snapshotContentHash: string;
    readonly manifestContentHash: string;
  }[];
  readonly files: {
    readonly html: {
      readonly fileName: string;
      readonly sha256: string;
      readonly byteLength: number;
    };
    readonly supporting: readonly {
      readonly fileName: string;
      readonly sha256: string;
      readonly byteLength: number;
    }[];
  };
  readonly contentHash: string;
}

export interface PublishProjectTopologyAcceptanceViewOptions {
  readonly projectTopologyDirectory: string;
  readonly dataRoot: string;
  readonly outputRoot: string;
  readonly maxTaskPackBytes?: number;
  readonly fieldEvidenceDirectories?: readonly string[];
  readonly maxFieldEvidenceBytes?: number;
}

export interface PublishProjectTopologyAcceptanceViewResult {
  readonly status: "CREATED" | "REUSED";
  readonly directory: string;
  readonly htmlPath: string;
  readonly manifestPath: string;
  readonly manifest: ProjectTopologyViewManifest;
}

export function buildProjectTopologyAcceptanceViewModel(options: {
  readonly projectTopologyDirectory: string;
  readonly dataRoot: string;
  readonly maxTaskPackBytes?: number;
}): ProjectTopologyAcceptanceViewModel {
  const loaded = loadProjectTopologyDirectory(options.projectTopologyDirectory);
  const projection = loaded.projection;
  if (projection.snapshot.rootTaskIds.length > MAX_ROOTS)
    throw new Error(`PROJECT_TOPOLOGY_VIEW_ROOT_LIMIT:${MAX_ROOTS}`);
  const taskLabels = resolveTaskDisplayLabels(projection, options.dataRoot, {
    maxTaskPackBytes: options.maxTaskPackBytes ?? DEFAULT_MAX_TASK_PACK_BYTES,
  });
  const labelByTaskId = new Map(
    taskLabels.map((label) => [label.taskId, label]),
  );
  const nodes = projection.nodes.map((node) =>
    viewNode(node, labelByTaskId, projection.snapshot.projectKey),
  );
  const groups = buildGroups(nodes, projection.snapshot.rootTaskIds);
  const artifactRootByRefId = new Map<string, string>();
  for (const source of projection.snapshot.sources) {
    artifactRootByRefId.set(source.oneHop.refId, source.rootTaskId);
    artifactRootByRefId.set(source.multiHop.refId, source.rootTaskId);
  }
  const edges = projection.edges.map((edge) =>
    viewEdge(edge, artifactRootByRefId),
  );
  const taskDisplayCounts = taskLabelCounts(taskLabels);
  const relationCounts = countBy(projection.edges.map((edge) => edge.edgeType));
  const boundaryCounts = countBy(
    projection.nodes
      .filter((node) => node.nodeType === "BOUNDARY")
      .map((node) => text(node.properties.reason) || "UNKNOWN"),
  );
  const roots = projection.snapshot.rootTaskIds.map((taskId) => {
    const label = labelByTaskId.get(taskId) ?? missingTaskLabel(taskId);
    return {
      taskId,
      label: taskLabelText(label),
      taskName: label.taskName,
      taskDisplayStatus: label.status,
      tasks: nodes.filter(
        (node) => node.type === "TASK" && node.roots.includes(taskId),
      ).length,
      datasets: nodes.filter(
        (node) =>
          node.type === "PHYSICAL_DATASET" && node.roots.includes(taskId),
      ).length,
      boundaries: nodes.filter(
        (node) => node.type === "BOUNDARY" && node.roots.includes(taskId),
      ).length,
    };
  });
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    artifactType: VIEW_ARTIFACT_TYPE,
    viewVersion: VIEW_VERSION,
    snapshotId: projection.snapshot.snapshotId,
    snapshotContentHash: projection.snapshot.contentHash,
    projectKey: projection.snapshot.projectKey,
    coverageStatus: projection.snapshot.coverageStatus,
    roots,
    groups,
    nodes,
    edges,
    relationCounts,
    boundaryCounts,
    taskDisplayCounts,
    taskLabels,
  };
}

export function resolveTaskDisplayLabels(
  projection: ProjectTopologyProjectionV1,
  dataRootInput: string,
  limits: { readonly maxTaskPackBytes?: number } = {},
): TaskDisplayLabel[] {
  const dataRoot = resolve(dataRootInput);
  const tasksRoot = join(dataRoot, "tasks");
  const maxTaskPackBytes = positiveInteger(
    limits.maxTaskPackBytes ?? DEFAULT_MAX_TASK_PACK_BYTES,
    "MAX_TASK_PACK_BYTES",
  );
  const categories = existsSync(tasksRoot)
    ? readdirSync(tasksRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareText)
    : [];
  const taskNodes = projection.nodes.filter((node) => node.nodeType === "TASK");
  const reachByTaskId = new Map<string, ProjectTopologyEdgeRecord[]>();
  for (const edge of projection.edges) {
    if (
      edge.edgeType !== "ROOT_REACHES_TASK" ||
      !edge.toNodeId.startsWith("task:")
    )
      continue;
    const taskId = edge.toNodeId.slice("task:".length);
    const values = reachByTaskId.get(taskId) ?? [];
    values.push(edge);
    reachByTaskId.set(taskId, values);
  }
  return taskNodes
    .map((node) => {
      const taskId = safeSegment(text(node.properties.taskId), "taskId");
      const reachEdges = reachByTaskId.get(taskId) ?? [];
      const expectedContentHashes = sortedUnique(
        reachEdges.flatMap((edge) =>
          observations(edge)
            .filter((observation) => text(observation.taskId) === taskId)
            .map((observation) => text(observation.taskContentHash))
            .filter(Boolean),
        ),
      );
      const candidatePaths = new Set<string>();
      for (const edge of reachEdges)
        for (const evidence of edge.evidenceRefs) {
          const path = taskPackPathFromLocator(dataRoot, evidence.locator);
          if (path && existsSync(path)) candidatePaths.add(path);
        }
      for (const category of categories) {
        const candidate = join(tasksRoot, category, taskId, "task.json");
        if (existsSync(candidate)) candidatePaths.add(candidate);
      }
      const candidates = [...candidatePaths]
        .sort(compareText)
        .map((path) => readTaskPack(path, dataRoot, taskId, maxTaskPackBytes));
      const valid = candidates.filter(
        (candidate): candidate is ResolvedTaskPack => candidate.valid,
      );
      if (candidatePaths.size === 0)
        return { ...missingTaskLabel(taskId), expectedContentHashes };
      if (valid.length === 0)
        return {
          ...missingTaskLabel(taskId),
          status: "INVALID" as const,
          expectedContentHashes,
          candidateCount: candidatePaths.size,
        };
      const matching =
        expectedContentHashes.length === 0
          ? valid
          : valid.filter(
              (candidate) =>
                candidate.contentHash !== null &&
                expectedContentHashes.includes(candidate.contentHash),
            );
      if (matching.length === 0)
        return {
          ...missingTaskLabel(taskId),
          status: "HASH_MISMATCH" as const,
          expectedContentHashes,
          candidateCount: valid.length,
        };
      const identities = sortedUnique(
        matching.map((candidate) =>
          canonicalJson({
            taskName: candidate.taskName,
            taskType: candidate.taskType,
            topicName: candidate.topicName,
            contentHash: candidate.contentHash,
          }),
        ),
      );
      if (identities.length !== 1)
        return {
          ...missingTaskLabel(taskId),
          status: "AMBIGUOUS" as const,
          expectedContentHashes,
          candidateCount: matching.length,
        };
      const selected = matching[0]!;
      return {
        taskId,
        status:
          expectedContentHashes.length > 0
            ? ("VERIFIED" as const)
            : ("UNVERIFIED" as const),
        taskName: selected.taskName,
        taskType: selected.taskType,
        topicName: selected.topicName,
        logicalLocator: selected.logicalLocator,
        contentHash: selected.contentHash,
        expectedContentHashes,
        candidateCount: matching.length,
      };
    })
    .sort((left, right) => compareText(left.taskId, right.taskId));
}

interface ResolvedTaskPack {
  readonly valid: true;
  readonly taskName: string | null;
  readonly taskType: string | null;
  readonly topicName: string | null;
  readonly contentHash: string | null;
  readonly logicalLocator: string;
}

interface InvalidTaskPack {
  readonly valid: false;
}

function readTaskPack(
  path: string,
  dataRoot: string,
  taskId: string,
  maxBytes: number,
): ResolvedTaskPack | InvalidTaskPack {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { valid: false };
  }
  if (bytes.byteLength > maxBytes) return { valid: false };
  let parsed: JsonRecord;
  try {
    parsed = record(JSON.parse(bytes.toString("utf8")));
  } catch {
    return { valid: false };
  }
  if (text(parsed.taskId) !== taskId) return { valid: false };
  return {
    valid: true,
    taskName: nullableText(parsed.taskName),
    taskType: nullableText(parsed.taskType),
    topicName: nullableText(parsed.topicName),
    contentHash: nullableText(parsed.contentHash),
    logicalLocator: relative(dataRoot, path).split(sep).join("/"),
  };
}

function taskPackPathFromLocator(
  dataRoot: string,
  locator: string,
): string | null {
  const normalized = locator.replaceAll("\\", "/");
  if (!normalized.startsWith("tasks/") || !normalized.endsWith("/task.json"))
    return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    return null;
  const path = resolve(dataRoot, ...parts);
  const relativePath = relative(dataRoot, path);
  if (relativePath.startsWith("..") || resolve(path) === resolve(dataRoot))
    return null;
  return path;
}

function missingTaskLabel(taskId: string): TaskDisplayLabel {
  return {
    taskId,
    status: "MISSING",
    taskName: null,
    taskType: null,
    topicName: null,
    logicalLocator: null,
    contentHash: null,
    expectedContentHashes: [],
    candidateCount: 0,
  };
}

function viewNode(
  node: ProjectTopologyNodeRecord,
  labels: ReadonlyMap<string, TaskDisplayLabel>,
  projectKey: string,
): ProjectTopologyViewNode {
  const roots = [...node.sourceRootTaskIds];
  if (node.nodeType === "TASK") {
    const taskId = text(node.properties.taskId);
    const display = labels.get(taskId) ?? missingTaskLabel(taskId);
    return {
      id: node.nodeId,
      type: node.nodeType,
      label: taskLabelText(display),
      secondary:
        [display.topicName, display.taskType && `类型 ${display.taskType}`]
          .filter(Boolean)
          .join(" · ") || display.status,
      roots,
      groupKey: roots.join("+"),
      properties: {
        taskId,
        taskName: display.taskName,
        taskType: display.taskType,
        topicName: display.topicName,
        displayStatus: display.status,
        taskPack: display.logicalLocator,
        taskContentHash: display.contentHash,
      },
      taskDisplayStatus: display.status,
    };
  }
  if (node.nodeType === "PHYSICAL_DATASET") {
    const qualifiedName = text(node.properties.qualifiedName);
    return {
      id: node.nodeId,
      type: node.nodeType,
      label: qualifiedName || node.nodeId,
      secondary: [
        text(node.properties.platform),
        text(node.properties.dataSource),
      ]
        .filter(Boolean)
        .join(" · "),
      roots,
      groupKey: roots.join("+"),
      properties: {
        qualifiedName: qualifiedName || null,
        platform: nullableText(node.properties.platform),
        dataSource: nullableText(node.properties.dataSource),
      },
      taskDisplayStatus: null,
    };
  }
  if (node.nodeType === "BOUNDARY") {
    const reason = text(node.properties.reason) || "UNKNOWN";
    const taskId = nullableText(node.properties.taskId);
    return {
      id: node.nodeId,
      type: node.nodeType,
      label: `${reason}${taskId ? ` · ${taskId}` : ""}`,
      secondary: `深度 ${text(node.properties.depth) || "?"}`,
      roots,
      groupKey: roots.join("+"),
      properties: {
        reason,
        rootTaskId: nullableText(node.properties.rootTaskId),
        taskId,
        depth: finiteNumber(node.properties.depth),
        physicalDatasetNodeId: nullableText(
          node.properties.physicalDatasetNodeId,
        ),
        detail: compactJson(node.properties.detail),
      },
      taskDisplayStatus: null,
    };
  }
  return {
    id: node.nodeId,
    type: node.nodeType,
    label: projectKey,
    secondary: "项目快照",
    roots,
    groupKey: roots.join("+"),
    properties: { projectKey },
    taskDisplayStatus: null,
  };
}

function taskLabelText(label: TaskDisplayLabel): string {
  return label.taskName ? `${label.taskName} (${label.taskId})` : label.taskId;
}

function buildGroups(
  nodes: readonly ProjectTopologyViewNode[],
  allRoots: readonly string[],
): ProjectTopologyViewGroup[] {
  const byKey = new Map<string, ProjectTopologyViewNode[]>();
  for (const node of nodes) {
    if (node.type === "PROJECT_SNAPSHOT" || node.roots.length === 0) continue;
    const values = byKey.get(node.groupKey) ?? [];
    values.push(node);
    byKey.set(node.groupKey, values);
  }
  return [...byKey]
    .map(([key, values]) => {
      const roots = key.split("+").filter(Boolean);
      return {
        key,
        roots,
        label:
          roots.length === allRoots.length
            ? "全部根共享"
            : roots.length === 1
              ? `仅 ${roots[0]}`
              : `共享 ${roots.join(" + ")}`,
        tasks: values.filter((node) => node.type === "TASK").length,
        datasets: values.filter((node) => node.type === "PHYSICAL_DATASET")
          .length,
        boundaries: values.filter((node) => node.type === "BOUNDARY").length,
      };
    })
    .sort(
      (left, right) =>
        right.roots.length - left.roots.length ||
        compareText(left.key, right.key),
    );
}

function viewEdge(
  edge: ProjectTopologyEdgeRecord,
  artifactRootByRefId: ReadonlyMap<string, string>,
): ProjectTopologyViewEdge {
  const edgeObservations = observations(edge);
  const evidenceRefs = uniqueEvidence(edge.evidenceRefs);
  return {
    id: edge.edgeId,
    type: edge.edgeType,
    layer: edge.relationLayer,
    from: edge.fromNodeId,
    to: edge.toNodeId,
    roots: [...edge.sourceRootTaskIds],
    sourceArtifactRoots: sortedUnique(
      edge.sourceArtifactRefIds
        .map((refId) => artifactRootByRefId.get(refId) ?? "")
        .filter(Boolean),
    ),
    observationSummaries: edgeObservations
      .slice(0, MAX_EDGE_OBSERVATIONS)
      .map(summarizeObservation),
    observationCount: edgeObservations.length,
    evidenceRefs: evidenceRefs.slice(0, MAX_EDGE_EVIDENCE_REFS),
    evidenceCount: evidenceRefs.length,
    evidenceTruncated: evidenceRefs.length > MAX_EDGE_EVIDENCE_REFS,
  };
}

function observations(edge: ProjectTopologyEdgeRecord): JsonRecord[] {
  const value = edge.properties.observations;
  return Array.isArray(value) ? value.map(record) : [];
}

function summarizeObservation(observation: JsonRecord): string {
  const values = [
    nullableText(observation.rootTaskId),
    nullableText(observation.taskId) &&
      `任务 ${nullableText(observation.taskId)}`,
    nullableText(observation.producerRole) &&
      `生产者 ${nullableText(observation.producerRole)}`,
    nullableText(observation.recursionStatus) &&
      `递归 ${nullableText(observation.recursionStatus)}`,
    observation.minDepth !== undefined && `深度 ${text(observation.minDepth)}`,
    observation.producerDepth !== undefined &&
      `生产深度 ${text(observation.producerDepth)}`,
    nullableText(observation.reason) &&
      `边界 ${nullableText(observation.reason)}`,
  ].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  return values.join(" · ") || "已记录观察";
}

function uniqueEvidence(
  evidenceRefs: readonly ProjectTopologyEvidenceRef[],
): ProjectTopologyEvidenceRef[] {
  const result = new Map<string, ProjectTopologyEvidenceRef>();
  for (const evidence of evidenceRefs) {
    const compact: ProjectTopologyEvidenceRef = {
      source: evidence.source,
      provider: evidence.provider,
      locator: evidence.locator,
      observedAt: evidence.observedAt,
      contentHash: evidence.contentHash,
    };
    result.set(canonicalJson(compact), compact);
  }
  return [...result.values()].sort((left, right) =>
    compareText(
      `${left.source}|${left.provider}|${left.locator}`,
      `${right.source}|${right.provider}|${right.locator}`,
    ),
  );
}

function taskLabelCounts(
  labels: readonly TaskDisplayLabel[],
): Record<TaskDisplayStatus, number> {
  const counts: Record<TaskDisplayStatus, number> = {
    VERIFIED: 0,
    UNVERIFIED: 0,
    MISSING: 0,
    AMBIGUOUS: 0,
    HASH_MISMATCH: 0,
    INVALID: 0,
  };
  for (const label of labels) counts[label.status] += 1;
  return counts;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => compareText(left, right)),
  );
}

export function renderProjectTopologyAcceptanceViewHtml(
  model: ProjectTopologyAcceptanceViewModel,
): string {
  const data = JSON.stringify(model).replaceAll("<", "\\u003c");
  const title = escapeHtml(`联合拓扑验收 · ${model.projectKey}`);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:light-dark(#f5f7f8,#0f1418);--surface:light-dark(#fff,#182027);--surface2:light-dark(#f1f5f7,#202a32);--text:light-dark(#1d2830,#edf2f5);--muted:light-dark(#63727d,#aab8c2);--line:light-dark(#d8e0e5,#35424c);--blue:light-dark(#286f9b,#70b9e5);--orange:light-dark(#a96719,#edb66f);--green:light-dark(#267655,#6fd1a5);--red:light-dark(#a73d3d,#ef8f8f);--purple:light-dark(#72529a,#b99be0)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Microsoft YaHei",sans-serif}button,input,select{font:inherit}button{cursor:pointer}header{padding:18px 22px 14px;background:var(--surface);border-bottom:1px solid var(--line)}h1,h2,h3,p{margin:0}h1{font-size:22px;font-weight:600}h2{font-size:16px;font-weight:600;margin-bottom:10px}h3{font-size:14px;font-weight:600;margin:14px 0 8px}.meta{margin-top:5px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}main{max-width:1680px;margin:0 auto;padding:16px 18px 26px}.stats,.roots,.groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:9px;margin-bottom:14px}.stat,.root,.group{padding:11px 12px;background:var(--surface);border:1px solid var(--line);border-radius:8px}.stat strong{display:block;font-size:21px}.stat span,.root small,.group small{display:block;color:var(--muted);margin-top:2px}.root,.group{text-align:left;color:var(--text)}.root:hover,.group:hover,.root[aria-pressed="true"],.group[aria-pressed="true"]{border-color:var(--blue);background:var(--surface2)}.root strong,.group strong{display:block;font-weight:600;overflow-wrap:anywhere}.toolbar{display:flex;gap:9px;align-items:end;flex-wrap:wrap;margin:14px 0}.field{display:grid;gap:4px;color:var(--muted);font-size:12px}.field input,.field select{min-width:190px;padding:8px 9px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text)}.workspace{display:grid;grid-template-columns:300px minmax(560px,1fr) 340px;gap:12px;align-items:start}.panel{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:9px}.panel-title{padding:11px 12px;border-bottom:1px solid var(--line);font-weight:600}.result-meta{padding:8px 11px;color:var(--muted);font-size:12px;border-bottom:1px solid var(--line)}.node-list{max-height:690px;overflow:auto}.node-row{display:block;width:100%;padding:9px 11px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);text-align:left}.node-row:hover,.node-row[aria-pressed="true"]{background:var(--surface2)}.node-row strong{display:block;font-weight:500;overflow-wrap:anywhere}.node-row small{display:block;color:var(--muted);margin-top:2px;overflow-wrap:anywhere}.type{display:inline-block;margin-right:5px;color:var(--purple);font-size:11px}.graph-shell{overflow:auto;min-height:690px}.graph{display:block;min-width:900px}.g-node{cursor:pointer}.g-node rect{fill:var(--surface2);stroke:var(--line);stroke-width:1.2}.g-node.selected rect{stroke:var(--blue);stroke-width:2.5}.g-node.boundary rect{stroke:var(--red)}.g-title{fill:var(--text);font-size:12px;font-weight:600}.g-sub{fill:var(--muted);font-size:10px}.g-edge{fill:none;stroke:var(--muted);stroke-width:1.5;opacity:.78;cursor:pointer}.g-edge:hover{stroke:var(--blue);stroke-width:3}.g-edge-hit{fill:none;stroke:transparent;stroke-width:14;cursor:pointer}.g-edge-label{fill:var(--muted);font-size:9px;pointer-events:none}.detail{padding:12px;position:sticky;top:10px;max-height:calc(100vh - 20px);overflow:auto}.detail p{margin-top:5px;color:var(--muted);overflow-wrap:anywhere}.detail-row{padding:8px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}.detail-row strong{display:block;font-weight:500}.detail-row small{display:block;color:var(--muted);margin-top:2px;overflow-wrap:anywhere}.badge{display:inline-block;padding:2px 6px;margin:3px 4px 0 0;border-radius:999px;background:var(--surface2);color:var(--muted);font-size:11px}.warning{color:var(--red)}.empty{padding:18px;color:var(--muted)}@media(max-width:1180px){.workspace{grid-template-columns:270px minmax(520px,1fr)}.detail{grid-column:1/-1;position:static;max-height:none}}@media(max-width:760px){main{padding:12px}.workspace{grid-template-columns:1fr}.graph-shell{min-height:540px}.detail{grid-column:auto}.field{width:100%}.field input,.field select{width:100%}.node-list{max-height:420px}}
</style>
</head>
<body>
<header><h1>${title}</h1><p class="meta">静态证据投影 · 快照 ${escapeHtml(model.snapshotId)} · 覆盖 ${escapeHtml(model.coverageStatus)}</p><p class="meta">共享范围按稳定 Task / 表身份归并；边界保留各根任务的停止作用域，不跨根合并。节点图只展示当前关系层的一跳。</p></header>
<main>
<section id="stats" class="stats" aria-label="图规模"></section>
<h2>根任务</h2><section id="roots" class="roots"></section>
<h2>共享范围</h2><section id="groups" class="groups"></section>
<div class="toolbar"><label class="field">搜索<input id="search" type="search" placeholder="任务名称、ID、表名" autocomplete="off"></label><label class="field">节点类型<select id="nodeType"><option value="ALL">全部</option><option value="TASK">任务</option><option value="PHYSICAL_DATASET">表</option><option value="BOUNDARY">边界</option></select></label><label class="field">邻接关系<select id="layer"><option value="DATA_PRODUCTION">数据生产</option><option value="SCHEDULE">调度关系</option><option value="BOUNDARY">边界</option><option value="PROJECTION_SCOPE">根可达范围</option><option value="ALL">全部关系</option></select></label></div>
<div class="workspace"><section class="panel"><div class="panel-title">节点</div><div id="resultMeta" class="result-meta"></div><div id="nodeList" class="node-list"></div></section><section class="panel"><div class="panel-title">所选节点的一跳关系</div><div class="graph-shell"><svg id="graph" class="graph" role="img" aria-label="联合拓扑所选节点的一跳关系"></svg></div></section><aside id="detail" class="panel detail" aria-live="polite"></aside></div>
</main>
<script>
const DATA=${data};
const roots=document.getElementById("roots"),groups=document.getElementById("groups"),stats=document.getElementById("stats"),search=document.getElementById("search"),nodeType=document.getElementById("nodeType"),layer=document.getElementById("layer"),nodeList=document.getElementById("nodeList"),resultMeta=document.getElementById("resultMeta"),graph=document.getElementById("graph"),detail=document.getElementById("detail"),NS="http://www.w3.org/2000/svg";
const nodeById=new Map(DATA.nodes.map(node=>[node.id,node])),edgeById=new Map(DATA.edges.map(edge=>[edge.id,edge]));let scope="ALL",selectedId=DATA.roots[0]?"task:"+DATA.roots[0].taskId:DATA.nodes[0]?.id,selectedEdgeIds=[];
const text=value=>String(value??""),short=(value,max)=>{const v=text(value);return v.length>max?v.slice(0,max-1)+"…":v},el=(tag,className)=>{const n=document.createElement(tag);if(className)n.className=className;return n},svgEl=(tag,attrs={})=>{const n=document.createElementNS(NS,tag);for(const [key,value] of Object.entries(attrs))n.setAttribute(key,text(value));return n};
function stat(label,value,note){const box=el("div","stat"),strong=el("strong"),span=el("span");strong.textContent=text(value);span.textContent=label+(note?" · "+note:"");box.append(strong,span);return box}
function renderStats(){stats.replaceChildren(stat("任务",DATA.nodes.filter(n=>n.type==="TASK").length,"名称已核验 "+(DATA.taskDisplayCounts.VERIFIED??0)),stat("物理表",DATA.nodes.filter(n=>n.type==="PHYSICAL_DATASET").length),stat("关系",DATA.edges.length,"数据与调度分层"),stat("边界",DATA.nodes.filter(n=>n.type==="BOUNDARY").length,"不等于错误"))}
function scopeButton(container,label,sub,value,className){const button=el("button",className);button.type="button";button.dataset.scope=value;button.setAttribute("aria-pressed",String(scope===value));const strong=el("strong"),small=el("small");strong.textContent=label;small.textContent=sub;button.append(strong,small);button.addEventListener("click",()=>{scope=value;renderScopes();renderList()});container.append(button)}
function renderScopes(){roots.replaceChildren();for(const root of DATA.roots)scopeButton(roots,root.label,"任务 "+root.tasks+" · 表 "+root.datasets+" · 边界 "+root.boundaries,"ROOT:"+root.taskId,"root");groups.replaceChildren();for(const group of DATA.groups)scopeButton(groups,group.label,"任务 "+group.tasks+" · 表 "+group.datasets+(group.boundaries?" · 边界 "+group.boundaries:""),"GROUP:"+group.key,"group")}
function inScope(node){if(scope==="ALL")return true;if(scope.startsWith("ROOT:"))return node.roots.includes(scope.slice(5));if(scope.startsWith("GROUP:"))return node.groupKey===scope.slice(6);return true}
function filteredNodes(){const q=search.value.trim().toLowerCase(),type=nodeType.value;return DATA.nodes.filter(node=>node.type!=="PROJECT_SNAPSHOT"&&inScope(node)&&(type==="ALL"||node.type===type)&&(!q||(node.label+" "+node.secondary+" "+node.id).toLowerCase().includes(q))).sort((a,b)=>a.type.localeCompare(b.type)||a.label.localeCompare(b.label,"zh-Hans",{numeric:true}))}
function typeName(type){return {TASK:"任务",PHYSICAL_DATASET:"表",BOUNDARY:"边界",PROJECT_SNAPSHOT:"项目"}[type]??type}
function rootsText(values){return values.length?values.join(" + "):"无根归属"}
function renderList(){const values=filteredNodes(),visible=values.slice(0,180);resultMeta.textContent="显示 "+visible.length+" / "+values.length;nodeList.replaceChildren();if(!visible.length){nodeList.append(el("div","empty"));nodeList.firstChild.textContent="当前筛选没有节点";return}for(const node of visible){const button=el("button","node-row");button.type="button";button.setAttribute("aria-pressed",String(node.id===selectedId));const strong=el("strong"),small=el("small"),kind=el("span","type");kind.textContent=typeName(node.type);strong.append(kind,document.createTextNode(node.label));small.textContent=(node.secondary?node.secondary+" · ":"")+rootsText(node.roots);button.append(strong,small);button.addEventListener("click",()=>selectNode(node.id));nodeList.append(button)}}
function detailTitle(title,subtitle){detail.replaceChildren();const h=el("h2"),p=el("p");h.textContent=title;p.textContent=subtitle;detail.append(h,p)}
function detailRow(label,value,warning=false){const row=el("div","detail-row"),strong=el("strong"),small=el("small"+(warning?" warning":""));strong.textContent=label;small.textContent=text(value)||"—";row.append(strong,small);detail.append(row)}
function showNode(node){detailTitle(node.label,typeName(node.type)+" · "+rootsText(node.roots));for(const [key,value] of Object.entries(node.properties))detailRow(key,value,node.taskDisplayStatus&&node.taskDisplayStatus!=="VERIFIED"&&key==="displayStatus");const incident=DATA.edges.filter(edge=>edge.from===node.id||edge.to===node.id);detailRow("全部邻接关系",incident.length+" 条")}
function showEdges(edgeIds){const edges=edgeIds.map(id=>edgeById.get(id)).filter(Boolean);if(!edges.length)return;const first=edges[0];detailTitle(edges.length===1?first.type:edges.map(edge=>edge.type).filter((v,i,a)=>a.indexOf(v)===i).join(" / "),first.layer+" · "+rootsText(first.roots));for(const edge of edges){detailRow("关系",nodeById.get(edge.from)?.label+" → "+nodeById.get(edge.to)?.label);if(edge.observationSummaries.length)detailRow("根作用域观察",edge.observationSummaries.join("；")+(edge.observationCount>edge.observationSummaries.length?"；另有 "+(edge.observationCount-edge.observationSummaries.length)+" 条":""));for(const evidence of edge.evidenceRefs)detailRow(evidence.source,evidence.provider+" · "+evidence.locator);if(edge.evidenceTruncated)detailRow("证据",edge.evidenceCount+" 条，仅展示前 "+edge.evidenceRefs.length+" 条")}}
function selectNode(id){selectedId=id;selectedEdgeIds=[];renderList();renderGraph();const node=nodeById.get(id);if(node)showNode(node)}
function layerMatches(edge){return layer.value==="ALL"||edge.layer===layer.value}
function connections(){const map=new Map();for(const edge of DATA.edges){if(!layerMatches(edge)||(edge.from!==selectedId&&edge.to!==selectedId))continue;const outgoing=edge.from===selectedId,neighbor=outgoing?edge.to:edge.from,key=(outgoing?"R:":"L:")+neighbor,entry=map.get(key)??{neighbor,outgoing,edges:[]};entry.edges.push(edge);map.set(key,entry)}return [...map.values()].sort((a,b)=>nodeById.get(a.neighbor)?.label.localeCompare(nodeById.get(b.neighbor)?.label??"","zh-Hans",{numeric:true})??0).slice(0,48)}
function path(from,to){const sx=from.x+(from.side==="left"?from.w:0),sy=from.y+from.h/2,tx=to.x+(to.side==="right"?0:to.w),ty=to.y+to.h/2,bend=Math.max(45,Math.abs(tx-sx)*.38);return "M "+sx+" "+sy+" C "+(sx+bend)+" "+sy+", "+(tx-bend)+" "+ty+", "+tx+" "+ty}
function graphNode(node,pos,selected=false){const group=svgEl("g",{class:"g-node "+(node.type==="BOUNDARY"?"boundary ":"")+(selected?"selected":""),transform:"translate("+pos.x+" "+pos.y+")",role:"button","aria-label":node.label});const rect=svgEl("rect",{width:pos.w,height:pos.h,rx:7}),title=svgEl("text",{x:10,y:22,class:"g-title"}),sub=svgEl("text",{x:10,y:42,class:"g-sub"});title.textContent=short(node.label,36);sub.textContent=short(typeName(node.type)+" · "+rootsText(node.roots),40);group.append(rect,title,sub);group.addEventListener("click",()=>selectNode(node.id));graph.append(group)}
function renderGraph(){graph.replaceChildren();const selected=nodeById.get(selectedId);if(!selected){graph.setAttribute("viewBox","0 0 900 500");return}const links=connections(),left=links.filter(link=>!link.outgoing),right=links.filter(link=>link.outgoing),rows=Math.max(left.length,right.length,1),height=Math.max(620,rows*76+70),width=1040,positions=new Map(),center={x:395,y:Math.max(50,height/2-30),w:250,h:60,side:"center"};positions.set(selected.id,center);left.forEach((link,index)=>positions.set(link.neighbor,{x:25,y:35+index*76,w:250,h:60,side:"left"}));right.forEach((link,index)=>positions.set(link.neighbor,{x:765,y:35+index*76,w:250,h:60,side:"right"}));graph.setAttribute("viewBox","0 0 "+width+" "+height);graph.setAttribute("width",width);graph.setAttribute("height",height);const defs=svgEl("defs"),marker=svgEl("marker",{id:"arrow",markerWidth:8,markerHeight:8,refX:7,refY:4,orient:"auto"});marker.append(svgEl("path",{d:"M0,0 L8,4 L0,8 z",fill:"currentColor"}));defs.append(marker);graph.append(defs);for(const link of links){const neighborPos=positions.get(link.neighbor),from=link.outgoing?center:neighborPos,to=link.outgoing?neighborPos:center,d=path(from,to),visible=svgEl("path",{d,class:"g-edge","marker-end":"url(#arrow)"}),hit=svgEl("path",{d,class:"g-edge-hit"}),label=svgEl("text",{x:(from.x+to.x+250)/2,y:(from.y+to.y)/2+26,class:"g-edge-label"});label.textContent=[...new Set(link.edges.map(edge=>edge.type))].join(" / ");const ids=link.edges.map(edge=>edge.id);visible.addEventListener("click",()=>showEdges(ids));hit.addEventListener("click",()=>showEdges(ids));graph.append(visible,hit,label)}for(const link of links){const node=nodeById.get(link.neighbor),pos=positions.get(link.neighbor);if(node&&pos)graphNode(node,pos)}graphNode(selected,center,true);if(!links.length){const label=svgEl("text",{x:395,y:center.y+100,class:"g-sub"});label.textContent="当前关系层没有一跳邻接节点";graph.append(label)}}
function initial(){renderStats();renderScopes();renderList();if(selectedId&&nodeById.has(selectedId)){renderGraph();showNode(nodeById.get(selectedId))}else detailTitle("选择节点","从左侧选择任务、表或边界")}
search.addEventListener("input",renderList);nodeType.addEventListener("change",renderList);layer.addEventListener("change",renderGraph);initial();
</script>
</body>
</html>
`;
}

export function publishProjectTopologyAcceptanceView(
  options: PublishProjectTopologyAcceptanceViewOptions,
): PublishProjectTopologyAcceptanceViewResult {
  const model = buildProjectTopologyAcceptanceViewModel(options);
  const topologyHtml = renderProjectTopologyAcceptanceViewHtml(model);
  const fieldDirectories = options.fieldEvidenceDirectories ?? [];
  const fieldAssets =
    fieldDirectories.length > 0
      ? buildProjectFieldDrilldownAssets({
          projectKey: model.projectKey,
          projectSnapshotId: model.snapshotId,
          rootTaskIds: model.roots.map((root) => root.taskId),
          taskLabels: model.taskLabels,
          fieldEvidenceDirectories: fieldDirectories,
          maxFieldEvidenceBytes: options.maxFieldEvidenceBytes,
        })
      : null;
  const html = fieldAssets?.html ?? topologyHtml;
  const serializedFiles = new Map<string, string>([[VIEW_HTML_FILE, html]]);
  if (fieldAssets) {
    serializedFiles.set(TOPOLOGY_VIEW_FILE, topologyHtml);
    for (const file of fieldAssets.files) {
      if (serializedFiles.has(file.fileName))
        throw new Error(
          `PROJECT_TOPOLOGY_VIEW_FILE_DUPLICATE:${file.fileName}`,
        );
      serializedFiles.set(file.fileName, file.contents);
    }
  }
  const modelContentHash = sha256(canonicalJson(model));
  const publishedFiles = [...serializedFiles]
    .map(([fileName, contents]) => ({
      fileName,
      sha256: sha256(Buffer.from(contents, "utf8")),
      byteLength: Buffer.byteLength(contents, "utf8"),
    }))
    .sort((left, right) => compareText(left.fileName, right.fileName));
  const htmlFile = publishedFiles.find(
    (file) => file.fileName === VIEW_HTML_FILE,
  )!;
  const supportingFiles = publishedFiles.filter(
    (file) => file.fileName !== VIEW_HTML_FILE,
  );
  const viewId = `project-topology-view-${sha256(
    canonicalJson({
      viewVersion: VIEW_VERSION,
      snapshotId: model.snapshotId,
      modelContentHash,
      htmlContentHash: htmlFile.sha256,
      ...(supportingFiles.length > 0 ? { supportingFiles } : {}),
    }),
  )}`;
  const manifestBody = {
    schemaVersion: VIEW_SCHEMA_VERSION,
    artifactType: VIEW_ARTIFACT_TYPE,
    viewVersion: VIEW_VERSION,
    viewId,
    projectKey: model.projectKey,
    snapshotId: model.snapshotId,
    snapshotContentHash: model.snapshotContentHash,
    rootTaskIds: model.roots.map((root) => root.taskId),
    modelContentHash,
    counts: {
      nodes: model.nodes.length,
      edges: model.edges.length,
      boundaries: model.nodes.filter((node) => node.type === "BOUNDARY").length,
      fieldTasks: fieldAssets?.catalog.tasks.length ?? 0,
      fields: fieldAssets?.catalog.totalFields ?? 0,
      taskLabels: model.taskDisplayCounts,
    },
    sourceTaskPacks: model.taskLabels.map((label) => ({
      taskId: label.taskId,
      status: label.status,
      logicalLocator: label.logicalLocator,
      contentHash: label.contentHash,
    })),
    sourceFieldEvidence: fieldAssets?.sources ?? [],
    files: {
      html: htmlFile,
      supporting: supportingFiles,
    },
  } as const;
  const manifest: ProjectTopologyViewManifest = {
    ...manifestBody,
    contentHash: sha256(canonicalJson(manifestBody)),
  };
  const outputRoot = resolve(options.outputRoot);
  const snapshotRoot = join(
    outputRoot,
    "projects",
    projectKeySegment(model.projectKey),
    model.snapshotId,
  );
  const directory = join(snapshotRoot, viewId);
  const manifestText = `${canonicalJson(manifest)}\n`;
  if (existsSync(directory)) {
    assertViewDirectory(directory, serializedFiles, manifestText);
    return result("REUSED", directory, manifest);
  }
  mkdirSync(snapshotRoot, { recursive: true });
  const staging = mkdtempSync(join(snapshotRoot, ".view-staging-"));
  try {
    for (const [fileName, contents] of serializedFiles) {
      const path = join(staging, fileName);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, "utf8");
    }
    writeFileSync(join(staging, VIEW_MANIFEST_FILE), manifestText, "utf8");
    if (existsSync(directory)) {
      assertViewDirectory(directory, serializedFiles, manifestText);
      return result("REUSED", directory, manifest);
    }
    renameSync(staging, directory);
    assertViewDirectory(directory, serializedFiles, manifestText);
    return result("CREATED", directory, manifest);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

function result(
  status: "CREATED" | "REUSED",
  directory: string,
  manifest: ProjectTopologyViewManifest,
): PublishProjectTopologyAcceptanceViewResult {
  return {
    status,
    directory,
    htmlPath: join(directory, VIEW_HTML_FILE),
    manifestPath: join(directory, VIEW_MANIFEST_FILE),
    manifest,
  };
}

function assertViewDirectory(
  directory: string,
  files: ReadonlyMap<string, string>,
  manifest: string,
): void {
  const expected = [...files, [VIEW_MANIFEST_FILE, manifest] as const];
  for (const [fileName, contents] of expected) {
    const path = join(directory, fileName);
    if (!existsSync(path) || readFileSync(path, "utf8") !== contents)
      throw new Error(`PROJECT_TOPOLOGY_VIEW_IMMUTABLE_CONFLICT:${fileName}`);
  }
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function nullableText(value: unknown): string | null {
  const valueText = text(value).trim();
  return valueText === "" ? null : valueText;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const serialized = JSON.stringify(value);
  return serialized.length <= 600 ? serialized : `${serialized.slice(0, 599)}…`;
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
