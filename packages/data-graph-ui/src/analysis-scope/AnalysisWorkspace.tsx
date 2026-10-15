import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  useNodesInitialized,
} from "@xyflow/react";
import { api } from "../api";
import {
  adaptTrace,
  INPUT_EDGE_COLOR,
  OUTPUT_EDGE_COLOR,
} from "../graph-adapter";
import { createGraphHighlighter } from "../graph-highlight";
import { DraggableLineageCanvas } from "../components/DraggableLineageCanvas";
import { LineageNode } from "../components/LineageNode";
import { TaskNode } from "../components/TaskNode";
import { NodeAnalysisToolbar } from "../components/NodeAnalysisToolbar";
import { DetailPanel } from "../components/DetailPanel";
import { ResizableWorkspace } from "../components/ResizableWorkspace";
import { FieldSelector, selectedTaskFields } from "../components/FieldSelector";
import { ClusterFilter } from "../components/ClusterFilter";
import {
  collectMultiFieldTrace,
  loadAllFieldPages,
} from "../multi-field-trace";
import type { GraphEdge, GraphNode, TaskDetail, TraceResult } from "../types";
import { loadScope, expandScope, collapseScope } from "./client";
import { layoutTableTrace } from "./layout";
import {
  addRefs,
  graphMembers,
  identityKey,
  memberAllowsNode,
  parseBatch,
  projectScope,
  refKey,
  restoreScopes,
  KIND_LABELS,
  saveScope,
  STORAGE_KEY,
  type LoadedScope,
  type SavedScope,
  type ScopeRef,
  type ScopeExpansion,
} from "./model";
import { PRESETS, analysisScopeUrl, type ScopePreset } from "./presets";
import { projectTableDisplay } from "./table-display";
import { TableRelationsPanel } from "./TableRelationsPanel";
import { loadPhysicalTableAnalysis } from "./physical-analysis";
import "./style.css";

const nodeTypes = { lineage: LineageNode, processingTask: TaskNode };

interface PreviousScope {
  name: string;
  refs: ScopeRef[];
  loaded: LoadedScope;
  savedId?: string;
  preset?: ScopePreset;
  selectedId?: string;
}

export function AnalysisWorkspace({
  onExit,
  clusters,
  setClusters,
  initialPreset,
}: {
  onExit: () => void;
  clusters: string[];
  setClusters: (values: string[]) => void;
  initialPreset?: ScopePreset;
}) {
  const flow = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const lastFitted = useRef<TraceResult | undefined>(undefined);
  const [name, setName] = useState(initialPreset?.name ?? "新分析范围");
  const [activePreset, setActivePreset] = useState<ScopePreset | undefined>(
    initialPreset,
  );
  const [refs, setRefs] = useState<ScopeRef[]>([]);
  const [loaded, setLoaded] = useState<LoadedScope>();
  const [saved, setSaved] = useState<SavedScope[]>([]);
  const [savedId, setSavedId] = useState<string>();
  const [previousScopes, setPreviousScopes] = useState<PreviousScope[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [batch, setBatch] = useState("");
  const [progress, setProgress] = useState("");
  const [search, setSearch] = useState("");
  const [searchRows, setSearchRows] = useState<GraphNode[]>([]);
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchMore, setSearchMore] = useState(false);
  const [selected, setSelected] = useState<GraphNode>();
  const [inspected, setInspected] = useState<GraphNode>();
  const [inspectedRelation, setInspectedRelation] = useState<GraphEdge>();
  const [fieldAnchor, setFieldAnchor] = useState<GraphNode>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [detailBusy, setDetailBusy] = useState(false);
  const [fields, setFields] = useState<GraphNode[]>([]);
  const [fieldIds, setFieldIds] = useState<string[]>([]);
  const [fieldTaskId, setFieldTaskId] = useState("");
  const [fieldTrace, setFieldTrace] = useState<TraceResult>();
  const [traceRootIds, setTraceRootIds] = useState<string[]>([]);
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [depth, setDepth] = useState(2);
  const [highlight, setHighlight] = useState<string[]>();
  const sequence = useRef(0);
  const detailSequence = useRef(0);
  const searchSequence = useRef(0);
  const mounted = useRef(false);
  const storageHealthy = useRef(true);

  async function apply(
    next = refs,
    nextName = name,
    previousVersion?: string,
    restoredExpansions: ScopeExpansion[] = [],
    selectedClusters = clusters,
  ) {
    const request = ++sequence.current;
    ++detailSequence.current;
    setBusy(true);
    setError("");
    setNotice("");
    setProgress("准备读取范围…");
    setFieldTrace(undefined);
    setFields([]);
    setFieldIds([]);
    setFieldTaskId("");
    setSelected(undefined);
    setInspected(undefined);
    setFieldAnchor(undefined);
    setDetail(undefined);
    setDetailBusy(false);
    setHighlight(undefined);
    try {
      let result = await loadScope(
        next,
        () => request === sequence.current,
        api,
        (message) => {
          if (request === sequence.current) setProgress(message);
        },
        selectedClusters,
      );
      for (const [index, step] of restoredExpansions.entries()) {
        if (request === sequence.current)
          setProgress(
            "恢复展开 " + (index + 1) + "/" + restoredExpansions.length,
          );
        result = await expandScope(
          result,
          step.nodeId,
          step.direction,
          () => request === sequence.current,
        );
      }
      if (request !== sequence.current) return;
      setLoaded(result);
      setRefs(
        result.members.map(({ node, ...ref }) => ({ ...ref, id: node.id })),
      );
      setName(nextName);
      setDirty(false);
      setNotice(
        previousVersion && previousVersion !== result.trace.version
          ? "图谱版本已变化，已按保存的对象身份重新查询。"
          : "已加载起点及其直接上下游。点击任意表或调度可继续展开。",
      );
    } catch (e) {
      if (request === sequence.current) {
        setDirty(true);
        setError(e instanceof Error ? e.message : "范围读取失败");
      }
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    try {
      const entries = restoreScopes(localStorage.getItem(STORAGE_KEY));
      setSaved(entries);
      const last = entries.at(-1);
      if (initialPreset) {
        openPreset(initialPreset);
      } else if (last) {
        setSavedId(last.id);
        setName(last.name);
        setRefs(last.members);
        void apply(
          last.members,
          last.name,
          last.version,
          last.expansions,
          clusters,
        );
      }
    } catch (e) {
      storageHealthy.current = false;
      setError(e instanceof Error ? e.message : "浏览器存储不可用");
    }
    return () => {
      mounted.current = false;
      ++sequence.current;
      ++detailSequence.current;
      ++searchSequence.current;
    };
  }, []);

  function setScopeLocation(presetId?: string) {
    window.history.replaceState(
      null,
      "",
      analysisScopeUrl(window.location.href, presetId),
    );
  }

  function openPreset(preset: ScopePreset) {
    setSavedId(undefined);
    setActivePreset(preset);
    setRefs(preset.members);
    setName(preset.name);
    setScopeLocation(preset.id);
    void apply(preset.members, preset.name);
  }

  function edit(next: ScopeRef[]) {
    ++sequence.current;
    setBusy(false);
    setRefs(next);
    setActivePreset(undefined);
    setScopeLocation();
    setDirty(true);
    setError("");
  }

  function add(items: ScopeRef[]) {
    try {
      edit(addRefs(refs, items));
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法加入清单");
    }
  }

  function persist() {
    if (!loaded || dirty) return;
    try {
      if (!storageHealthy.current)
        throw new Error(
          "浏览器原有范围记录无法读取，暂不覆盖；可继续使用当前范围。",
        );
      const entry = {
        ...saveScope(savedId ?? crypto.randomUUID(), name, loaded),
      };
      const entries = [...saved.filter((s) => s.id !== entry.id), entry];
      if (entries.length > 40) throw new Error("最多保存 40 个范围。");
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 2, entries }),
      );
      setSaved(entries);
      setSavedId(entry.id);
      setScopeLocation();
      setNotice("已保存到当前浏览器；刷新后会重新读取此范围。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  }

  async function find(append = false) {
    const request = ++searchSequence.current;
    const offset = append ? searchOffset : 0;
    try {
      const rows = await api.search(search.trim(), offset, 31, clusters);
      if (!mounted.current || request !== searchSequence.current) return;
      setSearchRows((existing) =>
        append ? [...existing, ...rows.slice(0, 30)] : rows.slice(0, 30),
      );
      setSearchOffset(offset + 30);
      setSearchMore(rows.length > 30);
    } catch (e) {
      if (request === searchSequence.current)
        setError(e instanceof Error ? e.message : "搜索失败");
    }
  }

  function addNode(node: GraphNode) {
    if (node.kind !== "TASK" && node.kind !== "PHYSICAL_DATASET") return;
    add([
      {
        id: node.id,
        kind: node.kind,
        value:
          node.kind === "TASK"
            ? node.taskId || node.id.replace(/^task:/, "")
            : node.table!,
        enabled: true,
      },
    ]);
  }

  async function inspect(node: GraphNode, relation?: GraphEdge) {
    const request = ++detailSequence.current;
    setInspected(node);
    setInspectedRelation(relation);
    setDetail(undefined);
    setDetailBusy(false);
    const taskId =
      node.taskId ||
      (node.kind === "TASK" ? node.id.replace(/^task:/, "") : undefined);
    if (!taskId) return;
    setDetailBusy(true);
    try {
      const result = await api.task(taskId, {
        column: node.column,
        writeId: node.writeId,
      });
      if (request !== detailSequence.current) return;
      if (result.version !== loaded?.trace.version)
        throw new Error("图谱已换版，请重新应用范围后查看证据。");
      setDetail({
        ...result,
        requestedColumn: node.column,
        requestedWriteId: node.writeId,
      });
    } catch (e) {
      if (request === detailSequence.current)
        setError(e instanceof Error ? e.message : "证据读取失败");
    } finally {
      if (request === detailSequence.current) setDetailBusy(false);
    }
  }

  function clearAnalysis() {
    ++detailSequence.current;
    setFieldTrace(undefined);
    setTraceRootIds([]);
    setFields([]);
    setFieldIds([]);
    setFieldTaskId("");
    setFieldAnchor(undefined);
    setInspected(undefined);
    setInspectedRelation(undefined);
    setDetail(undefined);
    setDetailBusy(false);
    setHighlight(undefined);
  }

  async function analyzePhysicalTable(node: GraphNode, source: LoadedScope) {
    const request = ++sequence.current;
    setBusy(true);
    setError("");
    setProgress("正在以物理表重新开始分析…");
    try {
      const result = await loadPhysicalTableAnalysis(node, clusters,
        () => request === sequence.current, api,
        message => { if (request === sequence.current) setProgress(message); });
      if (request !== sequence.current) return;
      setPreviousScopes(items => [...items.slice(-19), {
        name, refs, loaded: source, savedId, preset: activePreset, selectedId: node.id,
      }]);
      clearAnalysis();
      setLoaded(result.scope);
      setRefs(result.scope.members.map(({ node: root, ...ref }) => ({ ...ref, id: root.id })));
      const root = projectTableDisplay(result.scope.trace).nodes.find(n => n.id === result.scope.members[0]!.id)
        ?? result.scope.members[0]!.node;
      setSelected(root);
      setInspected(root);
      setFieldAnchor(root);
      setFields(result.fields);
      setName(`分析表 · ${root.table ?? root.label ?? root.id}`);
      setSavedId(undefined);
      setActivePreset(undefined);
      setScopeLocation();
      setDirty(false);
      setNotice(`已以此物理表重新开始分析，退出原任务范围；${clusters.length ? "保留集群筛选，" : ""}已加载直接读写关系和 ${result.fields.length} 个输出字段。可返回上一分析范围。`);
    } catch (e) {
      if (request === sequence.current) setError(e instanceof Error ? e.message : "表分析加载失败，已保留原范围。");
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }

  async function backToPreviousScope() {
    const previous = previousScopes.at(-1);
    if (!previous || busy) return;
    const request = ++sequence.current;
    setBusy(true);
    setError("");
    setProgress("正在恢复上一分析范围…");
    try {
      const version = String((await api.status()).version ?? "");
      if (request !== sequence.current) return;
      let result = previous.loaded;
      if (version !== result.trace.version) {
        result = await loadScope(previous.refs, () => request === sequence.current,
          api, undefined, previous.loaded.clusters ?? []);
        for (const step of previous.loaded.expansions ?? [])
          result = await expandScope(result, step.nodeId, step.direction, () => request === sequence.current);
      }
      if (request !== sequence.current) return;
      clearAnalysis();
      setLoaded(result);
      setRefs(result.members.map(({ node, ...ref }) => ({ ...ref, id: node.id })));
      setName(previous.name);
      setSavedId(previous.savedId);
      setActivePreset(previous.preset);
      setScopeLocation(previous.preset?.id);
      setClusters(result.clusters ?? []);
      ++searchSequence.current;
      setSearchRows([]);
      setSearchMore(false);
      setSelected(projectTableDisplay(result.trace).nodes.find(n => n.id === previous.selectedId));
      setDirty(false);
      setPreviousScopes(items => items.slice(0, -1));
      setNotice(version === previous.loaded.trace.version
        ? "已返回上一分析范围，并恢复其集群筛选和已展开关系。"
        : "图谱已换版，已按上一范围的起点和展开步骤重新查询。");
    } catch (e) {
      if (request === sequence.current) setError(e instanceof Error ? e.message : "恢复失败，已保留当前范围。");
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }

  async function chooseFields() {
    if (!selected || !loaded || dirty || busy) return;
    if (selected.kind === "PHYSICAL_DATASET") {
      await analyzePhysicalTable(selected, loaded);
      return;
    }
    void inspect(selected);
    setFieldTrace(undefined);
    setFieldAnchor(selected);
    setFieldTaskId(
      selected.kind === "TASK"
        ? selected.taskId || selected.id.replace(/^task:/, "")
        : "",
    );
    const request = ++sequence.current;
    setBusy(true);
    setError("");
    setFieldIds([]);
    setFields([]);
    const anchor =
      selected.kind === "TASK"
        ? {
            taskId: selected.taskId || selected.id.replace(/^task:/, ""),
            label: selected.label ?? selected.id,
          }
        : { nodeId: selected.id, label: selected.table ?? selected.id };
    try {
      const result = await loadAllFieldPages({
        fetchPage: (offset, limit) => api.fields(anchor, offset, limit),
        readVersion: async () => {
          const version = String((await api.status()).version ?? "");
          if (version !== loaded.trace.version)
            throw new Error("图谱已换版，请重新应用范围。");
          return version;
        },
        isCurrent: () => request === sequence.current,
      });
      if (request !== sequence.current) return;
      const allowed = result.filter(
        (n) =>
          memberAllowsNode(graphMembers(loaded.trace), n) &&
          !/^temp\./i.test(n.table ?? ""),
      );
      setFields(allowed);
      setNotice(
        allowed.length
          ? `已加载 ${allowed.length} 个范围内输出字段，请选择后展开。`
          : "当前已展开关系中没有此对象的可选输出字段，可先展开相关加工调度。",
      );
    } catch (e) {
      if (request === sequence.current)
        setError(e instanceof Error ? e.message : "字段加载失败");
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }

  async function expandFields() {
    if (!loaded || dirty) return;
    const request = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const roots = selectedTaskFields(fields, fieldIds, fieldTaskId);
      if (!roots.length) throw new Error("请先选择当前调度筛选内的字段。");
      const value = await collectMultiFieldTrace({
        roots,
        isCurrent: () => request === sequence.current,
        fetchTrace: async (root) => {
          const result = await api.trace({
            nodeId: root.id,
            label: root.column ?? root.id,
            layer: "field",
            direction,
            depth,
            includeCandidates: true,
          });
          if (result.version !== loaded.trace.version)
            throw new Error("图谱已换版，请重新应用范围。");
          return result;
        },
      });
      if (request !== sequence.current) return;
      setFieldTrace(value);
      setTraceRootIds(roots.map((n) => n.id));
      setHighlight(undefined);
    } catch (e) {
      if (request === sequence.current)
        setError(e instanceof Error ? e.message : "字段查询失败");
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }

  async function expandTable(direction: "up" | "down") {
    if (!loaded || !selected || busy || dirty) return;
    const request = ++sequence.current;
    setBusy(true);
    setError("");
    setProgress(
      "正在展开 " +
        (selected.table || selected.taskId || selected.id) +
        (direction === "up" ? " 的上游…" : " 的下游…"),
    );
    try {
      const result = await expandScope(
        loaded,
        selected.id,
        direction,
        () => request === sequence.current,
      );
      if (request !== sequence.current) return;
      const added = result.trace.nodes.length - loaded.trace.nodes.length;
      setLoaded(result);
      setFieldTrace(undefined);
      setHighlight(undefined);
      setNotice(
        added
          ? "本次新增 " + added + " 个节点，可以继续选择任意节点展开。"
          : "本次未发现新的节点，已保留查询到的关系；这不代表源系统没有更上游。",
      );
    } catch (e) {
      if (request === sequence.current)
        setError(e instanceof Error ? e.message : "展开失败");
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }

  function cancelLoad() {
    ++sequence.current;
    setBusy(false);
    setProgress("");
    setNotice("已取消本次读取，保留上次已完成的图。");
    setDirty(true);
  }

  const projection = useMemo(
    () =>
      loaded
        ? fieldTrace
          ? projectScope(fieldTrace, graphMembers(loaded.trace), traceRootIds)
          : { trace: loaded.trace, boundary: [], omittedNodes: 0 }
        : undefined,
    [loaded, fieldTrace, traceRootIds],
  );
  const displayTrace = useMemo(
    () =>
      projection
        ? fieldTrace
          ? projection.trace
          : layoutTableTrace(projectTableDisplay(projection.trace))
        : undefined,
    [projection, fieldTrace],
  );
  const baseGraph = useMemo(() => {
    if (!projection) return { nodes: [], edges: [] };
    return adaptTrace(
      displayTrace!,
      (node) => {
        setSelected(node);
        setHighlight((current) =>
          current?.length === 1 && current[0] === node.id
            ? undefined
            : [node.id],
        );
      },
      undefined,
    );
  }, [projection, displayTrace]);
  const inspectedRelations =
    !fieldTrace && inspected?.kind === "PHYSICAL_DATASET"
      ? inspectedRelation
        ? [inspectedRelation]
        : (displayTrace?.edges.filter(
            (edge) => edge.from === inspected.id || edge.to === inspected.id,
          ) ?? [])
      : [];
  const highlightGraph = useMemo(
    () =>
      displayTrace
        ? createGraphHighlighter(displayTrace, baseGraph)
        : undefined,
    [displayTrace, baseGraph],
  );
  const graph = useMemo(
    () => highlightGraph?.(highlight) ?? baseGraph,
    [highlightGraph, highlight, baseGraph],
  );

  const actionNode =
    selected && ["TASK", "PHYSICAL_DATASET"].includes(selected.kind)
      ? graph.nodes.find(
          (node) =>
            node.data.raw?.id === selected.id ||
            (identityKey(selected) &&
              node.data.members?.some(
                (member) => identityKey(member) === identityKey(selected),
              )),
        )
      : undefined;

  function centerGraph() {
    return flow.fitView({
      padding: 0.15,
      minZoom: 0.1,
      maxZoom: 1,
      duration: 180,
    });
  }
  useEffect(() => {
    if (
      !nodesInitialized ||
      !projection ||
      !graph.nodes.length ||
      lastFitted.current === projection.trace
    )
      return;
    if (
      !graph.nodes.every((node) => {
        const measured = flow.getInternalNode(node.id)?.measured;
        return measured?.width && measured.height;
      })
    )
      return;
    // Only acknowledge a fit that succeeded with measured nodes from this graph.
    const fittedTrace = projection.trace;
    void centerGraph().then((success) => {
      if (success) lastFitted.current = fittedTrace;
    });
  }, [nodesInitialized, projection, graph.nodes.length, flow]);

  const boundary = [
    ...new Map(
      [
        ...(fieldTrace
          ? (projection?.boundary.flatMap((n): GraphNode[] => {
              if (
                n.taskId &&
                !loaded?.members.some(
                  (m) => m.enabled && m.kind === "TASK" && m.value === n.taskId,
                )
              )
                return [
                  {
                    id: `task:${n.taskId}`,
                    kind: "TASK",
                    taskId: n.taskId,
                    label:
                      fieldTrace.taskLabels?.[n.taskId] ?? `调度 ${n.taskId}`,
                  },
                ];
              const physical = loaded?.trace.nodes.find(
                (p) =>
                  p.kind === "PHYSICAL_DATASET" &&
                  identityKey(p) &&
                  identityKey(p) === identityKey(n),
              );
              return physical ? [physical] : [];
            }) ?? [])
          : []),
      ].map((n) => [n.id, n]),
    ).values(),
  ];
  const selectedCount = refs.filter((r) => r.enabled).length;
  return (
    <div className="app analysis-app">
      <header>
        <div>
          <p className="kicker">DATA GRAPH · 分析范围</p>
          <h1>{name || "未命名范围"}</h1>
          <p>选择物理表、调度或二者混选，沿真实关系逐步展开上下游。</p>
        </div>
        <div className="analysis-navigation">
          {!!previousScopes.length && <button className="analysis-exit" disabled={busy} onClick={() => void backToPreviousScope()}>返回上一分析范围</button>}
          <button className="analysis-exit" onClick={onExit}>返回自由探索</button>
        </div>
      </header>
      <ResizableWorkspace>
        <aside className="search-panel panel analysis-panel">
          <h2>分析范围</h2>
          <ClusterFilter
            selected={clusters}
            description="集群筛选持续作用于起点、上下游展开和字段路径；跨集群处停止。"
            onApply={(values) => {
              setClusters(values);
              ++searchSequence.current;
              setSearchRows([]);
              setSearchMore(false);
              if (refs.some((r) => r.enabled))
                void apply(refs, name, undefined, [], values);
            }}
          />
          <label>
            范围名称
            <input
              aria-label="范围名称"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="analysis-presets">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                disabled={busy}
                onClick={() => openPreset(p)}
              >
                {p.label ?? p.name}
              </button>
            ))}
          </div>
          <button
            disabled={busy}
            onClick={() => {
              edit([]);
              ++detailSequence.current;
              setSavedId(undefined);
              setName("新分析范围");
              setLoaded(undefined);
              setFields([]);
              setFieldIds([]);
              setFieldTrace(undefined);
              setSelected(undefined);
              setInspected(undefined);
              setFieldAnchor(undefined);
              setDetail(undefined);
              setDetailBusy(false);
              setNotice("");
            }}
          >
            新建空范围
          </button>
          {saved.length > 0 && (
            <label>
              已保存范围
              <select
                aria-label="已保存范围"
                value={savedId ?? ""}
                onChange={(e) => {
                  const entry = saved.find((s) => s.id === e.target.value);
                  if (entry) {
                    setActivePreset(undefined);
                    setScopeLocation();
                    setSavedId(entry.id);
                    setRefs(entry.members);
                    setName(entry.name);
                    void apply(
                      entry.members,
                      entry.name,
                      entry.version,
                      entry.expansions,
                      clusters,
                    );
                  }
                }}
              >
                <option value="">选择范围</option>
                {saved.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="analysis-actions">
            <button
              className="primary"
              disabled={busy || !selectedCount}
              onClick={() => void apply()}
            >
              {busy ? "读取中…" : "打开所选对象"}
            </button>
            <button disabled={!loaded || dirty || busy} onClick={persist}>
              保存范围
            </button>
          </div>
          <small>保存起点和展开步骤到当前浏览器，打开时重新查询。</small>
          <details className="analysis-import">
            <summary>批量加入 / 搜索对象</summary>
            <textarea
              aria-label="批量对象清单"
              value={batch}
              onChange={(e) => setBatch(e.target.value)}
              placeholder={
                "schema.table\n76984\n表名和调度 ID 可以混合，每行一个"
              }
              rows={4}
            />
            <button
              onClick={() => {
                try {
                  add(parseBatch(batch));
                  setBatch("");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "清单格式错误");
                }
              }}
            >
              加入清单
            </button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void find();
              }}
            >
              <input
                aria-label="搜索范围对象"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  ++searchSequence.current;
                  setSearchRows([]);
                  setSearchMore(false);
                }}
                placeholder="表名、说明或任务 ID"
              />
              <button disabled={!search.trim()}>搜索</button>
            </form>
            {searchRows.map((n) => (
              <div className="analysis-search-row" key={n.id}>
                <span title={n.id}>
                  {n.table || n.label || n.id}
                  <small>
                    {n.metadata?.table.description ||
                      (n.kind === "TASK"
                        ? `调度 ${n.taskId || n.id.replace(/^task:/, "")}`
                        : `物理身份 ${n.id.slice(-10)}`)}
                  </small>
                </span>
                <button onClick={() => addNode(n)}>加入</button>
              </div>
            ))}
            {searchMore && (
              <button onClick={() => void find(true)}>更多结果</button>
            )}
          </details>
          <div className="analysis-list-title">
            分析起点 · 已选 {selectedCount}/{refs.length}
            {dirty && <b>待应用</b>}
          </div>
          {selectedCount < refs.length && (
            <button onClick={() => edit(refs.filter((m) => m.enabled))}>
              移除未选对象（{refs.length - selectedCount}）
            </button>
          )}
          {(["PHYSICAL_DATASET", "TASK"] as const).map((r) => {
            const group = refs.filter((m) => m.kind === r);
            if (!group.length) return null;
            return (
              <details className="analysis-group" key={r} open>
                <summary>
                  {KIND_LABELS[r]} · {group.filter((m) => m.enabled).length}/
                  {group.length}
                </summary>
                <label className="analysis-check">
                  <input
                    type="checkbox"
                    aria-label={`全选${KIND_LABELS[r]}`}
                    checked={group.every((m) => m.enabled)}
                    onChange={(e) =>
                      edit(
                        refs.map((m) =>
                          m.kind === r
                            ? { ...m, enabled: e.target.checked }
                            : m,
                        ),
                      )
                    }
                  />
                  全选本组
                </label>
                {group.map((m) => (
                  <label
                    className="analysis-check"
                    key={refKey(m)}
                    title={m.value}
                  >
                    <input
                      type="checkbox"
                      aria-label={m.value}
                      checked={m.enabled}
                      onChange={(e) =>
                        edit(
                          refs.map((x) =>
                            x === m ? { ...x, enabled: e.target.checked } : x,
                          ),
                        )
                      }
                    />
                    <span>
                      {m.kind === "TASK" ? `调度 ${m.value}` : m.value}
                      {loaded?.excludedIds?.includes(m.id ?? "") && (
                        <small>未命中当前集群筛选</small>
                      )}
                      <small>
                        {
                          loaded?.members.find((x) => x.node.id === m.id)?.node
                            .metadata?.table.description
                        }
                      </small>
                    </span>
                  </label>
                ))}
              </details>
            );
          })}
        </aside>
        <main className="canvas panel">
          <div className="canvas-head analysis-toolbar">
            <div>
              <b>{fieldTrace ? "范围内字段路径" : "范围内表与任务关系"}</b>
              {loaded && (
                <small>
                  {" "}
                  · {graph.nodes.length} 个节点 / {graph.edges.length} 条关系
                </small>
              )}
            </div>
            <div className="analysis-actions">
              <button disabled={!graph.nodes.length} onClick={centerGraph}>
                重新居中
              </button>
              {highlight && (
                <button onClick={() => setHighlight(undefined)}>
                  取消高亮
                </button>
              )}
              {loaded && !fieldTrace && (
                <>
                  <label className="analysis-focus">
                    当前对象
                    <select
                      aria-label="选择图中对象"
                      value={selected?.id ?? ""}
                      disabled={busy || dirty}
                      onChange={(e) => {
                        const node = displayTrace?.nodes.find(
                          (n) => n.id === e.target.value,
                        );
                        if (node) {
                          setHighlight([node.id]);
                          setSelected(node);
                        } else {
                          setHighlight(undefined);
                          setSelected(undefined);
                        }
                      }}
                    >
                      <option value="">点击图中节点，或在此选择</option>
                      {displayTrace?.nodes
                        .filter((n) =>
                          ["TASK", "PHYSICAL_DATASET"].includes(n.kind),
                        )
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.kind === "TASK"
                              ? "调度 " +
                                (n.taskId || n.id.replace(/^task:/, ""))
                              : n.table || n.id}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    disabled={!selected || busy || dirty}
                    onClick={() => void expandTable("up")}
                  >
                    向上展开一层
                  </button>
                  <button
                    disabled={!selected || busy || dirty}
                    onClick={() => void expandTable("down")}
                  >
                    向下展开一层
                  </button>
                  <button
                    disabled={!loaded.history?.length || busy || dirty}
                    onClick={() => {
                      setLoaded(collapseScope(loaded));
                      setHighlight(undefined);
                      setSelected(undefined);
                      setInspected(undefined);
                      setFields([]);
                      setFieldIds([]);
                      setFieldAnchor(undefined);
                      ++detailSequence.current;
                      setDetail(undefined);
                      setDetailBusy(false);
                      setNotice("已收起上次展开，其余关系保留。");
                    }}
                  >
                    收起上次展开
                  </button>
                </>
              )}
              <button
                disabled={!fieldTrace}
                onClick={() => {
                  ++sequence.current;
                  setBusy(false);
                  setFieldTrace(undefined);
                  setHighlight(undefined);
                }}
              >
                返回表与任务关系
              </button>
              <button
                disabled={
                  !selected ||
                  busy ||
                  dirty ||
                  !["TASK", "PHYSICAL_DATASET"].includes(selected.kind)
                }
                onClick={() => void chooseFields()}
              >
                {selected?.kind === "TASK" ? "分析此调度" : "分析此表"}
              </button>
              <button
                disabled={!selected || busy || dirty}
                onClick={() => selected && void inspect(selected)}
              >
                查看加工证据
              </button>
            </div>
          </div>
          {activePreset?.description && (
            <details className="analysis-boundary">
              <summary>{activePreset.name} · 范围说明</summary>
              <p>{activePreset.description}</p>
            </details>
          )}
          {busy && (
            <div className="notice neutral" role="status">
              {progress || "正在读取…"}{" "}
              <button onClick={cancelLoad}>取消读取</button>
            </div>
          )}
          {fields.length > 0 && (
            <div className="toolbar analysis-field-toolbar">
              <span>
                字段分析对象：
                {fieldAnchor?.table ||
                  fieldAnchor?.label ||
                  fieldAnchor?.taskId}
              </span>
              <FieldSelector
                fields={fields}
                selectedIds={fieldIds}
                hasMore={false}
                onChange={setFieldIds}
                onLoadMore={() => {}}
                taskId={fieldTaskId}
                onTaskChange={setFieldTaskId}
              />
              <select
                aria-label="范围字段方向"
                value={direction}
                onChange={(e) => setDirection(e.target.value as "up" | "down")}
              >
                <option value="up">向上追溯</option>
                <option value="down">向下影响</option>
              </select>
              <select
                aria-label="范围字段深度"
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
              >
                {[1, 2, 4].map((n) => (
                  <option key={n} value={n}>
                    {n} 层
                  </option>
                ))}
              </select>
              <button
                disabled={
                  !selectedTaskFields(fields, fieldIds, fieldTaskId).length ||
                  busy ||
                  dirty
                }
                onClick={() => void expandFields()}
              >
                展开所选字段
              </button>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="notice neutral" role="status">
              {notice}
            </div>
          )}
          {dirty && loaded && (
            <div className="notice">
              清单已修改，画布仍是上次应用的范围。点击“打开所选对象”更新。
            </div>
          )}
          {loaded?.warnings.map((w, i) => (
            <div className="notice" key={i}>
              {w}
            </div>
          ))}
          {!!loaded?.clusters?.length && (
            <div className="notice neutral">
              当前集群：
              {loaded.clusters.map((value) => value || "未收录").join("、")}
              。表、调度和字段展开均遵守此范围，跨集群处停止。
            </div>
          )}
          {fieldTrace?.truncated && (
            <div className="notice">
              字段查询达到关系上限，当前路径不完整。请减少字段或层数。
            </div>
          )}
          {fieldTrace && projection && projection.omittedNodes > 0 && (
            <div className="notice neutral">
              本次字段查询有 {projection.omittedNodes}{" "}
              个当前已展开表与调度之外的节点未显示。可以返回表与任务关系，继续展开上游或下游。
            </div>
          )}
          {boundary.length > 0 && (
            <details className="analysis-boundary">
              <summary>
                字段范围外连接 · {boundary.length}{" "}
                个对象（点击查看，加入后才会展开）
              </summary>
              <div className="analysis-boundary-list">
                {boundary.map((n) => (
                  <div key={n.id}>
                    <span>{n.table || n.label || n.id}</span>
                    {loaded?.clusters?.length &&
                    n.taskId &&
                    !loaded.clusters.includes(
                      fieldTrace?.taskClusters?.[n.taskId] ?? "",
                    ) ? (
                      <small>当前集群之外，请先调整集群筛选</small>
                    ) : (
                      <button onClick={() => addNode(n)}>加入范围</button>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
          <div className="flow-wrap">
            {projection && graph.nodes.length ? (
              <DraggableLineageCanvas
                nodes={graph.nodes}
                scope={projection?.trace}
                edges={graph.edges}
                nodeTypes={nodeTypes}
                onEdgeClick={(_, edge) => {
                  if (busy || dirty || fieldTrace) return;
                  const relation = edge.data?.raw as GraphEdge | undefined;
                  if (
                    !relation ||
                    !["READS_TABLE", "WRITES_TABLE"].includes(relation.kind)
                  )
                    return;
                  const table = displayTrace?.nodes.find(
                    (node) =>
                      node.kind === "PHYSICAL_DATASET" &&
                      (node.id === relation.from || node.id === relation.to),
                  );
                  if (table) {
                    setSelected(table);
                    void inspect(table, relation);
                  }
                }}
                onNodeClick={(_, n) => {
                  if (busy) return;
                  const raw = n.data.raw as GraphNode | undefined;
                  const members =
                    (n.data.members as GraphNode[] | undefined) ?? [];
                  const key = members[0] && identityKey(members[0]);
                  const table =
                    key &&
                    loaded?.trace.nodes.find(
                      (node) =>
                        node.kind === "PHYSICAL_DATASET" &&
                        identityKey(node) === key,
                    );
                  const target = raw || table || members[0];
                  const ids = raw ? [raw.id] : members.map((node) => node.id);
                  if (target) {
                    setSelected(target);
                    setHighlight((current) =>
                      current?.length === ids.length &&
                      ids.every((id) => current.includes(id))
                        ? undefined
                        : ids,
                    );
                  }
                }}
                onPaneClick={() => {
                  setHighlight(undefined);
                  setSelected(undefined);
                }}
                minZoom={0.1}
                maxZoom={1.5}
                nodesDraggable
                nodesConnectable={false}
              >
                <Background gap={24} color="#c8d8d5" />
                <MiniMap pannable zoomable />
                <Controls />
                {actionNode && selected && (
                  <NodeAnalysisToolbar
                    nodeId={actionNode.id}
                    node={selected}
                    disabled={busy || dirty}
                    onAnalyze={() => void chooseFields()}
                    onEvidence={() => void inspect(selected)}
                  />
                )}
              </DraggableLineageCanvas>
            ) : (
              <div className="welcome">
                <h2>
                  {busy
                    ? "正在读取所选范围…"
                    : loaded
                      ? "当前筛选没有可展示的节点"
                      : "先选一个分析范围"}
                </h2>
                <p>可以选一个表、一个调度，或混合多个对象作为起点。</p>
              </div>
            )}
          </div>
          <footer>
            {!fieldTrace && (
              <div className="legend">
                <span>
                  <i style={{ borderColor: INPUT_EDGE_COLOR }} />
                  输入
                </span>
                <span>
                  <i style={{ borderColor: OUTPUT_EDGE_COLOR }} />
                  输出
                </span>
                <span>拖动节点可调整位置</span>
              </div>
            )}
            {!fieldTrace && (
              <p>
                单击节点只选中并高亮上下游；上下游展开保留任务上下文。
                “分析此表”以物理表重新开始，保留集群筛选；“分析此调度”在当前范围选择字段。
                点击“查看加工证据”查看详情，点击连线查看读写记录。
              </p>
            )}
            <p>
              {fieldTrace
                ? "字段路径保留原始取值与接续证据。"
                : "表级关系表示任务的实际读写；不把同任务的所有输入、输出配对为字段因果。"}
            </p>
          </footer>
        </main>
        <DetailPanel
          key={`${inspected?.id ?? "none"}:${detail?.version ?? ""}`}
          node={inspected}
          detail={detail}
          loading={detailBusy}
        >
          {!!inspectedRelations.length && loaded && (
            <TableRelationsPanel
              edges={inspectedRelations}
              nodes={loaded.trace.nodes}
              onInspect={(node) => void inspect(node)}
            />
          )}
        </DetailPanel>
      </ResizableWorkspace>
    </div>
  );
}
