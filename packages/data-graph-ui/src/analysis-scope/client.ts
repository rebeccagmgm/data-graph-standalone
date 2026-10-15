import { api } from "../api";
import type { GraphNode, TraceResult } from "../types";
import { restrictTableClusters, clusterBoundaryWarning } from "./clusters";
import { scopeExpansionNodes } from "./table-display";
import {
  MAX_MEMBERS,
  type LoadedScope,
  type ScopeMember,
  type ScopeRef,
} from "./model";

type Client = Pick<typeof api, "status" | "search" | "trace">;
const MAX_RAW_EDGES = 12000;
type Progress = (message: string) => void;
const ensureCurrent = (current: () => boolean) => {
  if (!current()) throw new Error("SCOPE_QUERY_CANCELLED");
};

async function request<T>(
  operation: Promise<T>,
  current: () => boolean,
  label: string,
): Promise<T> {
  ensureCurrent(current);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}超过 30 秒未返回，请重试。`)),
          30000,
        );
      }),
    ]);
    ensureCurrent(current);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** At most four requests in flight; preserve input order for stable layout. */
async function boundedMap<T, R>(
  items: T[],
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  let failed = false;
  const results: R[] = [];
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await work(items[index]!, index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}

function mergeTraces(
  traces: TraceResult[],
  version: string,
  seeds: GraphNode[] = [],
): TraceResult {
  const template: TraceResult = traces[0] ?? {
    version,
    layer: "table",
    direction: "down",
    depthLimit: 1,
    edgeLimit: MAX_RAW_EDGES,
    truncated: false,
    stoppedBy: null,
    nodes: [],
    edges: [],
    terminalNodes: [],
    frontierNodeIds: [],
    elapsedMs: 0,
  };
  const nodes = new Map(seeds.map((node) => [node.id, node]));
  const edges = new Map<string, TraceResult["edges"][number]>();
  for (const trace of traces) {
    if (trace.version !== version)
      throw new Error("查询期间图谱已换版，请重新打开范围。");
    for (const node of trace.nodes) nodes.set(node.id, node);
    for (const edge of trace.edges)
      edges.set(
        edge.id ??
          edge.key ??
          `${edge.from}|${edge.to}|${edge.kind}|${edge.status ?? ""}`,
        edge,
      );
  }
  if (edges.size > MAX_RAW_EDGES)
    throw new Error("已展开关系超过容量，请减少起点或收起部分展开。");
  const truncated = traces.some((trace) => trace.truncated);
  return {
    ...template,
    version,
    layer: "table",
    direction: "down",
    depthLimit: 1,
    edgeLimit: MAX_RAW_EDGES,
    truncated,
    stoppedBy: truncated ? "EDGE_LIMIT" : null,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    terminalNodes: [
      ...new Map(
        traces
          .flatMap((trace) => trace.terminalNodes)
          .map((node) => [node.nodeId, node]),
      ).values(),
    ],
    frontierNodeIds: [
      ...new Set(traces.flatMap((trace) => trace.frontierNodeIds)),
    ],
    consumption: undefined,
    taskLabels: Object.assign({}, ...traces.map((trace) => trace.taskLabels)),
    taskTopics: Object.assign({}, ...traces.map((trace) => trace.taskTopics)),
    taskTopicDescriptions: Object.assign(
      {},
      ...traces.map((trace) => trace.taskTopicDescriptions),
    ),
    taskClusters: Object.assign(
      {},
      ...traces.map((trace) => trace.taskClusters),
    ),
    elapsedMs: traces.reduce((sum, trace) => sum + trace.elapsedMs, 0),
  };
}

function anchor(node: GraphNode) {
  return node.kind === "TASK"
    ? {
        taskId: node.taskId || node.id.replace(/^task:/, ""),
        label: node.label ?? node.id,
      }
    : { nodeId: node.id, label: node.table ?? node.id };
}

export async function loadScope(
  refs: ScopeRef[],
  current: () => boolean,
  client: Client = api,
  progress: Progress = () => {},
  clusters: string[] = [],
): Promise<LoadedScope> {
  ensureCurrent(current);
  if (!refs.some((r) => r.enabled)) throw new Error("请至少勾选一个表或调度。");
  if (
    refs.length > MAX_MEMBERS ||
    refs.filter((r) => r.kind === "TASK").length > 60
  )
    throw new Error("范围过大，请保留最多 60 个调度、120 个起点。");
  progress("正在检查图谱版本…");
  const version = String(
    (await request(client.status(), current, "读取图谱版本")).version ?? "",
  );
  if (!version) throw new Error("当前图谱版本不可用。");
  const taskInputs = new Map<string, TraceResult>();
  let resolved = 0;
  const members = await boundedMap(refs, async (ref): Promise<ScopeMember> => {
    ensureCurrent(current);
    let found: GraphNode[];
    if (ref.kind === "TASK" && ref.enabled) {
      // A known task ID needs an exact graph read, not a full-text search.
      const input = await request(
        client.trace({
          taskId: ref.value,
          label: ref.value,
          layer: "table",
          direction: "up",
          depth: 1,
          includeCandidates: true,
        }),
        current,
        `读取调度 ${ref.value}`,
      );
      if (input.version !== version)
        throw new Error("查询期间图谱已换版，请重新打开范围。");
      taskInputs.set(ref.value, input);
      found = input.nodes;
    } else {
      found = await request(
        client.search(ref.value, 0, 101),
        current,
        `定位 ${ref.value}`,
      );
    }
    if (!ref.id && ref.kind === "PHYSICAL_DATASET" && found.length >= 101)
      throw new Error(
        `${ref.value}：检索结果过多，请从搜索结果选择具体物理对象。`,
      );
    const exact = found.filter(
      (n) =>
        n.kind === ref.kind &&
        (ref.id
          ? n.id === ref.id
          : ref.kind === "TASK"
            ? (n.taskId || n.id.replace(/^task:/, "")) === ref.value
            : n.table?.toLowerCase() === ref.value.toLowerCase()),
    );
    if (exact.length !== 1)
      throw new Error(
        `${ref.value}：${exact.length > 1 ? "存在多个物理来源，请从搜索结果选择具体对象" : "当前图谱未能唯一定位保存的对象"}。`,
      );
    progress(`定位对象 ${++resolved}/${refs.length} · ${ref.value}`);
    return { ...ref, id: exact[0]!.id, node: exact[0]! };
  });
  const selectedMembers = members.filter((m) => m.enabled);
  let filtered = 0;
  if (clusters.length) progress(`筛选集群 0/${selectedMembers.length}`);
  const included = clusters.length
    ? await boundedMap(selectedMembers, async (member) => {
        ensureCurrent(current);
        const taskInput =
          member.kind === "TASK" ? taskInputs.get(member.value) : undefined;
        if (taskInput?.taskClusters) {
          const hit = clusters.includes(
            taskInput.taskClusters[member.value] ?? "",
          );
          progress(
            `筛选集群 ${++filtered}/${selectedMembers.length} · ${member.value}`,
          );
          return hit;
        }
        const matches = await request(
          client.search(member.value, 0, 101, clusters),
          current,
          `筛选 ${member.value} 的集群`,
        );
        const hit = matches.some((node) => node.id === member.node.id);
        progress(
          `筛选集群 ${++filtered}/${selectedMembers.length} · ${member.value}`,
        );
        if (!hit && matches.length >= 100)
          throw new Error(
            `${member.value}：集群检索结果过多，无法确认起点归属。`,
          );
        return hit;
      })
    : selectedMembers.map(() => true);
  const activeMembers = selectedMembers.filter((_, index) => included[index]);
  const excludedIds = selectedMembers
    .filter((_, index) => !included[index])
    .map((member) => member.node.id);
  const queries = activeMembers.flatMap((member) =>
    (["up", "down"] as const).map((direction) => ({ member, direction })),
  );
  let completed = 0;
  const traces = await boundedMap(queries, async ({ member, direction }) => {
    ensureCurrent(current);
    const cachedInput =
      direction === "up" && member.kind === "TASK"
        ? taskInputs.get(member.value)
        : undefined;
    const result =
      cachedInput ??
      (await request(
        client.trace({
          ...anchor(member.node),
          layer: "table",
          direction,
          depth: 1,
          includeCandidates: true,
        }),
        current,
        `读取 ${member.value} 的${direction === "up" ? "上游" : "下游"}`,
      ));
    progress(`读取关系 ${++completed}/${queries.length} · ${member.value}`);
    return result;
  });
  if (
    String(
      (await request(client.status(), current, "核对图谱版本")).version ?? "",
    ) !== version
  )
    throw new Error("查询期间图谱已换版，请重新打开范围。");
  const warnings = traces.flatMap((trace, i) =>
    trace.truncated
      ? [
          `${queries[i]!.member.value} 的${queries[i]!.direction === "up" ? "上游" : "下游"}达到查询上限，当前关系不完整。`,
        ]
      : [],
  );
  if (excludedIds.length)
    warnings.unshift(
      activeMembers.length
        ? `${excludedIds.length} 个已选起点未命中集群筛选，未用于本次展开；原勾选保留。`
        : "当前集群未命中任何已选起点，请切换集群或搜索其他对象。原勾选保留。",
    );
  const restricted = restrictTableClusters(
    mergeTraces(
      traces,
      version,
      activeMembers.map((m) => m.node),
    ),
    clusters,
    activeMembers.map((m) => m.node.id),
  );
  warnings.push(...clusterBoundaryWarning(restricted.omittedTaskIds));
  return {
    members,
    warnings,
    clusters: [...clusters],
    excludedIds,
    trace: restricted.trace,
    expansions: [],
    history: [],
  };
}

export async function expandScope(
  loaded: LoadedScope,
  nodeId: string,
  direction: "up" | "down",
  current: () => boolean,
  client: Client = api,
): Promise<LoadedScope> {
  ensureCurrent(current);
  const nodes = scopeExpansionNodes(loaded.trace, nodeId, direction).filter(
    (n) => ["TASK", "PHYSICAL_DATASET"].includes(n.kind),
  );
  if (!nodes.length)
    throw new Error("当前图中找不到要展开的表或调度，请重新选择。");
  if (nodes.length > 60)
    throw new Error("此表关联的任务上下文超过 60 个，请选择具体调度展开。");
  if ((loaded.expansions?.length ?? 0) >= 40)
    throw new Error("已展开 40 次，请先收起部分展开。");
  const results = await boundedMap(nodes, (node) =>
    request(
      client.trace({
        ...anchor(node),
        layer: "table",
        direction,
        depth: 1,
        includeCandidates: true,
      }),
      current,
      "展开关系",
    ),
  );
  if (
    String(
      (await request(client.status(), current, "核对图谱版本")).version ?? "",
    ) !== loaded.trace.version
  )
    throw new Error("图谱已换版，请重新打开范围。");
  const restricted = restrictTableClusters(
    mergeTraces([loaded.trace, ...results], loaded.trace.version),
    loaded.clusters ?? [],
    loaded.trace.nodes.map((n) => n.id),
  );
  return {
    ...loaded,
    trace: restricted.trace,
    warnings: [
      ...loaded.warnings,
      ...(results.some((result) => result.truncated)
        ? ["本次展开达到查询上限，关系不完整。"]
        : []),
      ...clusterBoundaryWarning(restricted.omittedTaskIds),
    ],
    expansions: [...(loaded.expansions ?? []), { nodeId, direction }],
    history: [
      ...(loaded.history ?? []),
      { trace: loaded.trace, warnings: loaded.warnings },
    ],
  };
}

export function collapseScope(loaded: LoadedScope): LoadedScope {
  const previous = loaded.history?.at(-1);
  return previous
    ? {
        ...loaded,
        ...previous,
        history: loaded.history!.slice(0, -1),
        expansions: loaded.expansions?.slice(0, -1),
      }
    : loaded;
}
