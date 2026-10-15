import type { GraphNode, TraceResult } from "../types";
import { mergeTraceConsumptions } from "../trace-consumption";

export const KIND_LABELS = {
  PHYSICAL_DATASET: "物理表",
  TASK: "调度任务",
};
export const STORAGE_KEY = "sql-static-lineage:analysis-scopes:v1";
export const MAX_MEMBERS = 120;
export interface ScopeRef {
  kind: "TASK" | "PHYSICAL_DATASET";
  value: string;
  id?: string;
  enabled: boolean;
}
export interface ScopeMember extends ScopeRef {
  node: GraphNode;
}
export interface SavedScope {
  id: string;
  name: string;
  version: string;
  members: ScopeRef[];
  expansions?: ScopeExpansion[];
  clusters?: string[];
}
export interface ScopeExpansion {
  nodeId: string;
  direction: "up" | "down";
}
export interface LoadedScope {
  members: ScopeMember[];
  trace: TraceResult;
  warnings: string[];
  clusters?: string[];
  excludedIds?: string[];
  expansions?: ScopeExpansion[];
  history?: Array<{ trace: TraceResult; warnings: string[] }>;
}

export function parseBatch(text: string): ScopeRef[] {
  const values = [
    ...new Set(
      text
        .replace(/\\_/g, "_")
        .split(/[\s,，;；、]+/)
        .filter(Boolean)
        .map((v) => v.toLowerCase()),
    ),
  ];
  if (values.length > MAX_MEMBERS)
    throw new Error(`一次最多加入 ${MAX_MEMBERS} 个对象。`);
  for (const value of values) {
    if (
      !/^\d{1,15}$/.test(value) &&
      !/^[a-z0-9_$]+(?:\.[a-z0-9_$]+)+$/.test(value)
    )
      throw new Error(
        "请填写完整 schema.table 表名或数字调度 ID，可混合输入，不接受通配符。",
      );
  }
  return values.map((value) => ({
    kind: /^\d+$/.test(value) ? "TASK" : "PHYSICAL_DATASET",
    value,
    enabled: true,
  }));
}

export function refKey(ref: ScopeRef) {
  return ref.id ?? `${ref.kind}:${ref.value}`;
}
export function addRefs(existing: ScopeRef[], added: ScopeRef[]): ScopeRef[] {
  const result = [...existing];
  for (const ref of added) {
    const match = result.findIndex(
      (item) =>
        item.kind === ref.kind &&
        (item.id && ref.id ? item.id === ref.id : item.value === ref.value),
    );
    if (match < 0) result.push(ref);
    else result[match] = { ...result[match]!, enabled: true };
  }
  if (result.length > MAX_MEMBERS)
    throw new Error(`范围最多保留 ${MAX_MEMBERS} 个对象，请缩小清单。`);
  return result;
}

export function identityKey(node: GraphNode): string | undefined {
  const identity = node.metadata?.identity ?? node.detail;
  if (node.detail?.identityStatus && node.detail.identityStatus !== "CONFIRMED")
    return undefined;
  if (
    !identity ||
    ![identity.platform, identity.dataSource, identity.qualifiedName].every(
      (v) => typeof v === "string" && v.length,
    )
  )
    return undefined;
  return JSON.stringify(
    [identity.platform, identity.dataSource, identity.qualifiedName].map((v) =>
      String(v).toLowerCase(),
    ),
  );
}

export function memberAllowsNode(
  members: ScopeMember[],
  node: GraphNode,
): boolean {
  const selected = members.filter((m) => m.enabled);
  if (node.kind === "TASK")
    return selected.some((m) => m.kind === "TASK" && m.node.id === node.id);
  if (node.kind === "PHYSICAL_DATASET")
    return selected.some(
      (m) => m.kind === "PHYSICAL_DATASET" && m.node.id === node.id,
    );
  // A field belongs to both a physical table and a processing occurrence.
  // Matching just its table would admit other writers of the same model.
  if (
    !node.taskId ||
    !selected.some((m) => m.kind === "TASK" && m.value === node.taskId)
  )
    return false;
  if (/^temp\./i.test(node.table ?? "")) return true;
  const key = identityKey(node);
  return Boolean(
    key &&
    selected.some(
      (m) => m.kind === "PHYSICAL_DATASET" && identityKey(m.node) === key,
    ),
  );
}

export function projectScope(
  raw: TraceResult,
  members: ScopeMember[],
  rootIds?: string[],
) {
  let nodes = raw.nodes.filter((n) => memberAllowsNode(members, n));
  let ids = new Set(nodes.map((n) => n.id));
  if (rootIds) {
    const neighbors = new Map<string, string[]>();
    for (const edge of raw.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
      neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), edge.to]);
      neighbors.set(edge.to, [...(neighbors.get(edge.to) ?? []), edge.from]);
    }
    const reachable = new Set(rootIds.filter((id) => ids.has(id)));
    const queue = [...reachable];
    for (let i = 0; i < queue.length; i++) {
      for (const next of neighbors.get(queue[i]!) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    ids = reachable;
    nodes = nodes.filter((n) => ids.has(n.id));
  }
  const edges = raw.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const boundaryIds = new Set(
    raw.edges.flatMap((e) =>
      ids.has(e.from) !== ids.has(e.to)
        ? [ids.has(e.from) ? e.to : e.from]
        : [],
    ),
  );
  const edgeIds = new Set(
    edges.flatMap((e) => (e.id ? [e.id] : e.key ? [e.key] : [])),
  );
  const trace: TraceResult = {
    ...raw,
    nodes,
    edges,
    terminalNodes: raw.terminalNodes.filter((n) => ids.has(n.nodeId)),
    frontierNodeIds: raw.frontierNodeIds.filter((id) => ids.has(id)),
    consumption: mergeTraceConsumptions({
      consumptions: raw.consumption ? [raw.consumption] : [],
      allowedNodeIds: ids,
      allowedEdgeIds: edgeIds,
      allRootNodeIds:
        raw.consumption?.rootPaths
          .map((p) => p.rootNodeId)
          .filter((id) => ids.has(id)) ?? [],
    }),
  };
  return {
    trace,
    boundary: raw.nodes.filter((n) => boundaryIds.has(n.id)),
    omittedNodes: raw.nodes.length - nodes.length,
  };
}

/** Field inspection uses all discovered objects, not only the initial seeds. */
export function graphMembers(trace: TraceResult): ScopeMember[] {
  return trace.nodes.flatMap((node): ScopeMember[] =>
    node.kind === "TASK" || node.kind === "PHYSICAL_DATASET"
      ? [
          {
            kind: node.kind,
            value:
              node.kind === "TASK"
                ? node.taskId || node.id.replace(/^task:/, "")
                : node.table || node.id,
            id: node.id,
            enabled: true,
            node,
          },
        ]
      : [],
  );
}
export function restoreScopes(raw: string | null): SavedScope[] {
  if (raw === null) return [];
  if (!raw) return [];
  const store = JSON.parse(raw) as { version?: unknown; entries?: unknown };
  if (
    ![1, 2].includes(Number(store.version)) ||
    !Array.isArray(store.entries) ||
    store.entries.length > 40
  )
    throw new Error("保存的分析范围格式无法读取；原记录未改动。");
  for (const entry of store.entries) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.version !== "string" ||
      !Array.isArray(entry.members) ||
      entry.members.length > MAX_MEMBERS
    )
      throw new Error("保存的分析范围不完整；原记录未改动。");
    for (const m of entry.members) {
      if (
        !m ||
        !["TASK", "PHYSICAL_DATASET"].includes(m.kind) ||
        typeof m.value !== "string" ||
        typeof m.enabled !== "boolean" ||
        typeof m.id !== "string" ||
        !m.id
      )
        throw new Error("保存的对象身份不完整；不会按同名对象替换。");
    }
  }
  return store.entries.map((entry) => {
    if (
      entry.clusters !== undefined &&
      (!Array.isArray(entry.clusters) ||
        entry.clusters.length > 64 ||
        entry.clusters.some((value: unknown) => typeof value !== "string"))
    )
      throw new Error("保存的集群筛选无法读取；原记录未改动。");
    if (
      entry.expansions !== undefined &&
      (!Array.isArray(entry.expansions) ||
        entry.expansions.length > 40 ||
        entry.expansions.some(
          (step: ScopeExpansion) =>
            !step ||
            typeof step.nodeId !== "string" ||
            !["up", "down"].includes(step.direction),
        ))
    )
      throw new Error("保存的展开记录无法读取；原记录未改动。");
    // Migrate old role labels and target-only focus without retaining their filtering.
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      members: entry.members.map((m: ScopeRef) => ({
        kind: m.kind,
        value: m.value,
        id: m.id,
        enabled: m.enabled,
      })),
      expansions: entry.expansions ?? [],
      clusters: entry.clusters ?? [],
    };
  });
}

export function saveScope(
  id: string,
  name: string,
  loaded: LoadedScope,
): SavedScope {
  return {
    id,
    name: name.trim() || "未命名范围",
    version: loaded.trace.version,
    expansions: loaded.expansions ?? [],
    clusters: loaded.clusters ?? [],
    members: loaded.members.map(({ node, ...ref }) => ({
      ...ref,
      id: node.id,
    })),
  };
}
