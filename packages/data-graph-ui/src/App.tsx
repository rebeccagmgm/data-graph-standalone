import { continuationRoots } from "./field-object";
import { ClusterFilter } from "./components/ClusterFilter";
import { readGlobalClusters, restrictTraceClusters } from "./trace-clusters";
import { UPSTREAM_SCOPE_ENABLED, UpstreamScopePanel, UpstreamScopeStatus, scopedOverview, scopedRegion } from "./experimental-upstream-scope";
import { RegionTopics } from "./region-topics/RegionTopics";
import { GlobalVisibility, useGlobalVisibility } from "./node-visibility/GlobalVisibility";
import { hideTableCards } from "./node-visibility/global";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  getViewportForBounds,
  useReactFlow,
  type NodeMouseHandler,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { edgeTouchesHiddenField } from "./field-viewport";
import { NodeVisibility } from "./node-visibility/NodeVisibility";
import { api } from "./api";
import { TRACE_EDGE_LIMIT } from "./graph-limits";
import { adaptTrace, INPUT_EDGE_COLOR, OUTPUT_EDGE_COLOR, type FieldSelectionContext } from "./graph-adapter";
import { DetailPanel } from "./components/DetailPanel";
import { DraggableLineageCanvas } from "./components/DraggableLineageCanvas";
import { expandTableCard, physicalTableAnchor, tableCardAnchor, traceTableAnchor } from "./table-navigation";
import { projectTableDisplay } from "./analysis-scope/table-display";
import { layoutTableTrace } from "./analysis-scope/layout";
import { TableRelationsPanel } from "./analysis-scope/TableRelationsPanel";
import { createGraphHighlighter } from "./graph-highlight";
import { ResizableWorkspace } from "./components/ResizableWorkspace";
import { LineageNode } from "./components/LineageNode";
import { TaskNode } from "./components/TaskNode";
import { NodeAnalysisToolbar } from "./components/NodeAnalysisToolbar";
import { FieldSelector, selectedTaskFields } from "./components/FieldSelector";
import { PartitionSelector } from "./components/PartitionSelector";
import { partitionFields } from "./partition-fields";
import { collectPerformanceSnapshot, recordAction } from "./performance-log";
import { ExplorationPanel } from "./components/ExplorationPanel";
import { isSameGraphVersion, normalizeRegionItems } from "./contract";
import {
  assessExplorationAnchor,
  assessExplorationRestore,
  createExplorationEntry,
  deleteExplorationEntry,
  explorationMember,
  readExplorationEntries,
  updateExplorationEntry,
  withoutExplorationMember,
  withExplorationMember,
  writeExplorationEntries,
  type ExplorationEntry,
  type ExplorationState,
} from "./exploration-entries";
import {
  collectMultiFieldTrace,
  loadAllFieldPages,
  shouldFallbackToDepthOne,
} from "./multi-field-trace";
import { collectMultiTableTrace, mergeTableTraceContext } from "./multi-table-trace";
import type {
  Anchor,
  Direction,
  GraphLayer,
  GraphEdge,
  GraphNode,
  OverviewResult,
  TaskDetail,
  TerminalNode,
  TraceResult,
} from "./types";
import "./styles.css";
import { presetFromSearch } from "./analysis-scope/presets";
type Hist = {
  anchor: Anchor;
  tableAnchors: Anchor[];
  layer: GraphLayer;
  direction: Direction;
  depth: number;
  candidates: boolean;
  selectedFieldIds: string[];
  fieldTaskId: string;
  fields: GraphNode[];
  fieldsMore: boolean;
  fieldsVersion?: string;
  viewport: Viewport;
};
const OverviewCanvas = lazy(() => import("./overview-canvas/OverviewCanvas").then(module => ({ default: module.OverviewCanvas })));
const AnalysisWorkspace = lazy(() => import("./analysis-scope/AnalysisWorkspace").then(module => ({ default: module.AnalysisWorkspace })));

function Explorer({ onOpenAnalysis, clusters, setClusters }: { onOpenAnalysis: () => void; clusters: string[]; setClusters: (values: string[]) => void }) {
  const clusterRules = useRef(clusters);
  clusterRules.current = clusters;
  const [upstreamPatterns, setUpstreamPatterns] = useState<string[]>([]);
  const upstreamRules = useRef(upstreamPatterns);
  upstreamRules.current = upstreamPatterns;
  const globalVisibility = useGlobalVisibility();
  const visibilityRules = useRef(globalVisibility.tables);
  visibilityRules.current = globalVisibility.tables;
  const flow = useReactFlow();
  const flowWrap = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<GraphNode[]>([]),
    [searchMore, setSearchMore] = useState(false),
    [searching, setSearching] = useState(false),
    [selectedRoots, setSelectedRoots] = useState<GraphNode[]>([]),
    [anchor, setAnchor] = useState<Anchor>(),
    [tableAnchors, setTableAnchors] = useState<Anchor[]>([]),
    [fields, setFields] = useState<GraphNode[]>([]),
    [fieldsMore, setFieldsMore] = useState(false),
    [selectedFieldIds, setSelectedFieldIds] = useState<string[]>([]),
    [fieldTaskId, setFieldTaskId] = useState(""),
    [layer, setLayer] = useState<GraphLayer>("table"),
    [direction, setDirection] = useState<Direction>("up"),
    [depth, setDepth] = useState(2),
    [candidates, setCandidates] = useState(true),
    [trace, setTrace] = useState<TraceResult>(),
    [loading, setLoading] = useState(false),
    [loadingAllFields, setLoadingAllFields] = useState(false),
    [autoDepthNotice, setAutoDepthNotice] = useState(""),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<GraphNode>(),
    [selectedTableRelation, setSelectedTableRelation] = useState<GraphEdge>(),
    [selectedMembers, setSelectedMembers] = useState<GraphNode[]>([]),
    [selectedFieldContext, setSelectedFieldContext] = useState<{ nodeId: string; context: FieldSelectionContext }>(),
    [highlightedFieldId, setHighlightedFieldId] = useState<string[]>(),
    [highlightedTaskId, setHighlightedTaskId] = useState<string>(),
    [expandedCandidates, setExpandedCandidates] = useState<Set<string>>(
      new Set(),
    ),
    [terminal, setTerminal] = useState<TerminalNode>(),
    [details, setDetails] = useState<TaskDetail[]>([]),
    [detailLoading, setDetailLoading] = useState(false),
    [history, setHistory] = useState<Hist[]>([]),
    [status, setStatus] = useState<Record<string, unknown>>();
  const detail = details[0];
  const [partitionCatalog, setPartitionCatalog] = useState<Awaited<ReturnType<typeof api.partitions>>>();
  const [partitionError, setPartitionError] = useState("");
  const [performanceSnapshot, setPerformanceSnapshot] = useState<Awaited<ReturnType<typeof collectPerformanceSnapshot>>>();
  useEffect(() => {
    let current = true;
    setPartitionCatalog(undefined); setPartitionError("");
    if (tableAnchors.length > 1) return () => { current = false; };
    if (anchor?.nodeId?.startsWith("dataset:")) void api.partitions(anchor.nodeId).then(value => {
      if (current) setPartitionCatalog(value);
    }).catch(error => { if (current) setPartitionError(`分区范围加载失败：${error.message}`); });
    return () => { current = false; };
  }, [anchor?.nodeId, tableAnchors.length]);
  const scopedFields = useMemo(() => partitionFields(fields, anchor?.partitionSelection).filter(field =>
    !anchor?.partitionSelection || !clusters.length || !partitionCatalog || clusters.includes(partitionCatalog.taskClusters[field.taskId ?? ""] ?? "")
  ), [fields, anchor?.partitionSelection, clusters, partitionCatalog]);
  const [canvasFocus, setCanvasFocus] = useState<{ nodeId: string; node: GraphNode; trace?: TraceResult }>();
  const [canvasScope, setCanvasScope] = useState<object>({});
  const [branchPlacement, setBranchPlacement] = useState<{anchorId: string; direction: Direction}>();
  const [branchNotice, setBranchNotice] = useState("");
  const [explorationEntries, setExplorationEntries] = useState<
      ExplorationEntry[]
    >([]),
    [activeExplorationId, setActiveExplorationId] = useState<string>(),
    [explorationNotice, setExplorationNotice] = useState("");
  const [mode, setMode] = useState<"overview" | "lineage">("overview"),
    [overview, setOverview] = useState<OverviewResult>(),
    [regionName, setRegionName] = useState(""),
    [regionMore, setRegionMore] = useState(false);
  const restore = useRef<Viewport | undefined>(undefined),
    requestSequence = useRef(0),
    navigationSequence = useRef(0),
    detailSequence = useRef(0),
    activeVersion = useRef<string | undefined>(undefined),
    fieldListVersion = useRef<string | undefined>(undefined),
    pendingFit = useRef(false),
    nodeTypes = useMemo(
      () => ({ lineage: LineageNode, processingTask: TaskNode }),
      [],
    );
  const clearDetail = useCallback(() => {
    // Invalidate in-flight evidence before unmounting its SQL and processing views.
    ++detailSequence.current;
    setSelected(undefined);
    setSelectedTableRelation(undefined);
    setSelectedMembers([]);
    setSelectedFieldContext(undefined);
    setTerminal(undefined);
    setDetails([]);
    setDetailLoading(false);
  }, []);
  const loadDetail = useCallback(async (
    node: GraphNode,
    t?: TerminalNode,
    context?: FieldSelectionContext,
    relation?: GraphEdge,
  ) => {
    const sequence = ++detailSequence.current;
    const rawMembers = context?.rawMembers?.length
      ? context.rawMembers
      : [node];
    setSelected(node);
    setSelectedTableRelation(relation);
    setSelectedFieldContext(context ? { nodeId: node.id, context } : undefined);
    setSelectedMembers(rawMembers);
    setTerminal(t);
    setDetails([]);
    const requests = new Map<
      string,
      { taskId: string; column?: string; writeId?: string }
    >();
    const nodeTaskId = node.taskId ??
      (node.kind === "TASK" ? node.id.replace(/^task:/, "") : undefined);
    if (nodeTaskId)
      requests.set(`${nodeTaskId}|${node.writeId ?? ""}`, {
        taskId: nodeTaskId,
        column: node.column,
        writeId: node.writeId,
      });
    for (const ref of context?.writeRefs ?? [])
      requests.set(`${ref.taskId}|${ref.writeId}`, {
        taskId: ref.taskId,
        column: node.column,
        writeId: ref.writeId,
      });
    if (!requests.size) {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    try {
      const requestList = [...requests.values()].slice(0, 20);
      const settled = await Promise.allSettled(
        requestList.map((request) =>
          api.task(request.taskId, {
            column: request.column,
            writeId: request.writeId,
          }),
        ),
      );
      if (sequence !== detailSequence.current) return;
      const values = settled.flatMap((result, index) => {
        if (result.status !== "fulfilled") return [];
        const request = requestList[index]!;
        return [
          {
            ...result.value,
            requestedColumn: request.column,
            requestedWriteId: request.writeId,
          },
        ];
      });
      const failedCount = settled.length - values.length;
      const omittedCount = Math.max(0, requests.size - requestList.length);
      if (failedCount || omittedCount)
        setError(
          `加工证据仅展示 ${values.length}/${requests.size} 组：${failedCount} 组读取失败${omittedCount ? `，${omittedCount} 组超过 20 组有界上限` : ""}。`,
        );
      if (
        values.some(
          (value) =>
            !isSameGraphVersion(activeVersion.current, value.version),
        )
      ) {
        setDetails([]);
        setError("图谱版本已更新，当前证据与画布版本不一致，请重新展开。");
        return;
      }
      setDetails(values);
    } catch {
      if (sequence === detailSequence.current) setDetails([]);
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }, []);
  const clusterView = useMemo(() => trace ? restrictTraceClusters(trace, clusters) : undefined, [trace, clusters]);
  const displayTrace = useMemo(() => clusterView
    ? clusterView.trace.layer === "table"
      ? layoutTableTrace(projectTableDisplay(clusterView.trace))
      : clusterView.trace
    : undefined, [clusterView]);
  const inspectedRelations = displayTrace?.layer === "table" && selected?.kind === "PHYSICAL_DATASET"
    ? selectedTableRelation ? [selectedTableRelation]
      : displayTrace.edges.filter(edge => edge.from === selected.id || edge.to === selected.id)
    : [];
  const baseGraph = useMemo(
    () =>
      trace
        ? adaptTrace(
            displayTrace!,
            (raw, terminalNode, context) => {
              setHighlightedTaskId(undefined);
              const rawIds = (context?.rawMembers ?? [raw])
                .map(({ id }) => id)
                .sort();
              setHighlightedFieldId((current) =>
                current?.join("|") === rawIds.join("|") ? undefined : rawIds,
              );
              void loadDetail(raw, terminalNode, context);
            },
            undefined,
            {
              expandedCandidates,
              onToggleCandidates: (key: string) => {
                pendingFit.current = true;
                setExpandedCandidates((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
              },
            },
          )
        : { nodes: [], edges: [] },
    [
      trace,
      displayTrace,
      loadDetail,
      expandedCandidates,
    ],
  );
  const highlightGraph = useMemo(() => displayTrace ? createGraphHighlighter(displayTrace, baseGraph) : undefined, [displayTrace, baseGraph]);
  const graph = useMemo(() => highlightGraph?.(highlightedFieldId, highlightedTaskId) ?? baseGraph, [highlightGraph, highlightedFieldId, highlightedTaskId, baseGraph]);
  const [hiddenFieldsByCard, setHiddenFieldsByCard] = useState<Record<string, string[]>>({});
  const pendingHiddenFields = useRef(new Map<string, string[]>());
  const hiddenFieldsFrame = useRef<number | undefined>(undefined);
  const onHiddenFieldsChange = useCallback((nodeId: string, ids: string[]) => {
    pendingHiddenFields.current.set(nodeId, ids);
    if (hiddenFieldsFrame.current !== undefined) return;
    hiddenFieldsFrame.current = requestAnimationFrame(() => {
      hiddenFieldsFrame.current = undefined;
      const updates = new Map(pendingHiddenFields.current);
      pendingHiddenFields.current.clear();
      setHiddenFieldsByCard(current => {
        let next = current;
        for (const [id, hidden] of updates) {
          if ((current[id] ?? []).join("|") === hidden.join("|")) continue;
          if (next === current) next = {...current};
          if (hidden.length) next[id] = hidden;
          else delete next[id];
        }
        return next;
      });
    });
  }, []);
  useEffect(() => () => {
    if (hiddenFieldsFrame.current !== undefined) cancelAnimationFrame(hiddenFieldsFrame.current);
  }, []);
  const decorateNode = useMemo(() => {
    const cache = new WeakMap<(typeof graph.nodes)[number], (typeof graph.nodes)[number]>();
    return (node: (typeof graph.nodes)[number]) => {
      let decorated = cache.get(node);
      if (!decorated) { decorated = {...node, data:{...node.data, onHiddenFieldsChange}}; cache.set(node, decorated); }
      return decorated;
    };
  }, [onHiddenFieldsChange]);
  const visibleNodes = useMemo(() => graph.nodes.map(decorateNode), [graph.nodes, decorateNode]);
  const visibleEdges = useMemo(() => {
    const hidden = new Set(graph.nodes.flatMap(node => hiddenFieldsByCard[node.id] ?? []));
    return graph.edges.map(edge => {
      const nextHidden = edgeTouchesHiddenField(edge, hidden);
      return Boolean(edge.hidden) === nextHidden ? edge : {...edge, hidden:nextHidden};
    });
  }, [graph.nodes, graph.edges, hiddenFieldsByCard]);
  const globalGraph = useMemo(() => hideTableCards(visibleNodes, visibleEdges, globalVisibility.tables), [visibleNodes, visibleEdges, globalVisibility.tables]);
  const foldedEdgeCount = visibleEdges.filter(edge => edge.hidden).length;
  const traceController = useRef<AbortController | undefined>(undefined);
  const cancelTrace = useCallback(() => {
    ++requestSequence.current;
    traceController.current?.abort();
    setLoading(false);
  }, []);
  useEffect(() => () => traceController.current?.abort(), []);
  useEffect(() => {
    if (mode !== "lineage") { ++requestSequence.current; traceController.current?.abort(); setLoading(false); }
  }, [mode]);
  const runTrace = useCallback(
    async (
      nextAnchor = anchor,
      nextLayer = layer,
      fit = true,
      fieldOverride?: GraphNode | GraphNode[],
      settings?: {
        direction: Direction;
        depth: number;
        candidates: boolean;
        expandedCandidateIds?: string[];
        tableAnchors?: Anchor[];
      },
    ) => {
      if (!nextAnchor) return;
      const selectedFields = partitionFields(
        nextLayer === "field"
          ? fieldOverride
            ? Array.isArray(fieldOverride)
              ? fieldOverride
              : [fieldOverride]
            : selectedTaskFields(scopedFields, selectedFieldIds, fieldTaskId)
          : [], nextAnchor.partitionSelection);
      if (nextLayer === "field" && !selectedFields.length) {
        setError("请至少选择一个符合起点调度筛选的字段。");
        return;
      }
      setLoading(true);
      setError("");
      const sequence = ++requestSequence.current;
      traceController.current?.abort();
      const controller = new AbortController();
      traceController.current = controller;
      const expectedFieldsVersion = fieldListVersion.current;
      try {
        const querySettings = {
          layer: nextLayer,
          direction: settings?.direction ?? direction,
          depth: settings?.depth ?? depth,
          includeCandidates: settings?.candidates ?? candidates,
          clusters: clusterRules.current,
          partitionSelection: nextAnchor.partitionSelection,
        };
        const collectFieldsAtDepth = (queryDepth: number) =>
          collectMultiFieldTrace({
            roots: selectedFields,
            isCurrent: () => sequence === requestSequence.current,
            fetchTrace: async (field) => {
              const result = await api.trace({
                nodeId: field.id,
                label: `${field.table}.${field.column}`,
                ...querySettings,
                depth: queryDepth,
              }, controller.signal);
              if (
                expectedFieldsVersion &&
                result.version !== expectedFieldsVersion
              )
                throw new Error("图谱已换版，请重新进入字段血缘加载全部字段。");
              return result;
            },
          });
        const roots = settings?.tableAnchors ??
          (nextAnchor === anchor && tableAnchors.length ? tableAnchors : [nextAnchor]);
        let value = nextLayer === "field"
          ? await collectFieldsAtDepth(querySettings.depth)
          : roots.length === 1
            ? await traceTableAnchor({ ...roots[0]!, ...querySettings },
                query => api.trace(query, controller.signal), () => sequence === requestSequence.current)
            : await collectMultiTableTrace({
                roots: roots.map((root) => ({
                  id: root.nodeId ?? (root.taskId ? `task:${root.taskId}` : ""),
                  label: root.label ?? root.table ?? root.taskId ?? root.nodeId ?? "未命名起点",
                  anchor: root,
                })),
                isCurrent: () => sequence === requestSequence.current,
                fetchTrace: async root => {
                  const isCurrent = () => sequence === requestSequence.current;
                  const fetchTrace = (query: Parameters<typeof api.trace>[0]) => api.trace(query, controller.signal);
                  const primary = await traceTableAnchor(
                    { ...root.anchor, ...querySettings }, fetchTrace, isCurrent,
                  );
                  if (querySettings.direction !== "up" || !root.anchor.taskId) return primary;
                  const writes = await traceTableAnchor(
                    { ...root.anchor, ...querySettings, direction: "down", depth: 1 },
                    fetchTrace,
                    isCurrent,
                  );
                  return mergeTableTraceContext(primary, writes);
                },
              });
        if (
          nextLayer === "field" &&
          shouldFallbackToDepthOne(value, querySettings.depth)
        ) {
          value = await collectFieldsAtDepth(1);
          if (sequence !== requestSequence.current) return;
          setDepth(1);
          setAutoDepthNotice(
            `关系达到 ${TRACE_EDGE_LIMIT} 条上限，已自动改为 1 层。`,
          );
        } else if (nextLayer === "field" && value.truncated) {
          setAutoDepthNotice(
            `字段路径达到 ${value.edgeLimit} 条关系上限；已查询 ${selectedFields.length - (value.unqueriedRootNodeIds?.length ?? 0)}/${selectedFields.length} 个已选字段，保留当前边界。`,
          );
        } else {
          setAutoDepthNotice("");
        }
        if (sequence !== requestSequence.current) return;
        activeVersion.current = value.version;
        setStatus((current) => ({
          ...(current ?? {}),
          version: value.version,
        }));
        setHighlightedFieldId(undefined);
        setHighlightedTaskId(undefined);
        setExpandedCandidates(
          new Set(settings?.expandedCandidateIds ?? []),
        );
        setTrace(value);
        setSelectedTableRelation(undefined);
        setExplorationNotice(current => current.startsWith("分区范围已更新") ? "" : current);
        setCanvasScope({});
        setHiddenFieldsByCard({});
        setBranchPlacement(undefined);
        setBranchNotice("");
        pendingFit.current = fit;
        if (selectedFields.length === 1)
          void loadDetail(
            selectedFields[0]!,
            value.terminalNodes.find((x) => x.nodeId === selectedFields[0]!.id),
          );
        else if (selectedFields.length > 1) {
          setSelected(undefined);
          setSelectedMembers([]);
          setTerminal(undefined);
          setDetails([]);
        }
        return value;
      } catch (e) {
        if (sequence === requestSequence.current)
          setError(e instanceof Error ? e.message : "查询失败");
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [
      anchor,
      candidates,
      depth,
      direction,
      selectedFieldIds,
      fieldTaskId,
      fields,
      scopedFields,
      flow,
      layer,
      loadDetail,
      tableAnchors,
    ],
  );
  const choose = useCallback(
    async (
      node: GraphNode,
      push = false,
      restored?: {
        entry: ExplorationEntry;
        anchor: Anchor;
        state: ExplorationState;
      },
      fieldAnalysis = false,
    ) => {
      let next: Anchor;
      try {
        next = restored?.anchor ?? (node.kind === "TASK"
          ? { taskId: node.taskId || node.id.replace(/^task:/, ""), label: node.label ?? node.id }
          : physicalTableAnchor(node));
        // An explicit partition choice for this same table remains in effect.
        if (!restored && next.nodeId && next.nodeId === anchor?.nodeId)
          next = { ...next, partitionSelection: anchor.partitionSelection };
      } catch (e) {
        setError(e instanceof Error ? e.message : "无法确定表的物理身份。");
        return;
      }
      recordAction(node.kind === "TASK" ? "open-task" : "open-table");
      cancelTrace();
      clearDetail();
      const navigation = ++navigationSequence.current;
      setLoadingAllFields(fieldAnalysis);
      if (fieldAnalysis) {
        ++requestSequence.current;
        setLoading(false);
        setFields([]);
        setSelectedFieldIds([]);
        setTrace(undefined);
      }
      if (push && anchor)
        setHistory((items) => [
          ...items,
          {
            anchor,
            tableAnchors,
            layer,
            direction,
            depth,
            candidates,
            selectedFieldIds,
            fieldTaskId,
            fields,
            fieldsMore,
            fieldsVersion: fieldListVersion.current,
            viewport: flow.getViewport(),
          },
        ]);
      const nextLayer = fieldAnalysis ? "field" : restored?.state.layer ?? "table";
      const nextDirection = restored?.state.direction ?? direction;
      const nextDepth = restored?.state.depth ?? depth;
      const nextCandidates = restored?.state.candidates ?? candidates;
      setAnchor(next);
      setTableAnchors([next]);
      setMode("lineage");
      if (restored) setTrace(undefined);
      setLayer(nextLayer);
      setDirection(nextDirection);
      setDepth(nextDepth);
      setCandidates(nextCandidates);
      setSelected(node);
      setSelectedMembers([node]);
      setSelectedFieldContext(undefined);
      setTerminal(undefined);
      setDetails([]);
      try {
        let listedVersion: string | undefined;
        const page =
          nextLayer === "field"
            ? await loadAllFieldPages({
                readVersion: async () => {
                  const current = await api.status();
                  if (typeof current.version !== "string" || !current.version)
                    throw new Error("图谱版本不可用，请稍后重试。");
                  if (
                    activeVersion.current &&
                    current.version !== activeVersion.current
                  )
                    throw new Error("图谱已换版，请重新打开此专题。");
                  listedVersion = current.version;
                  return current.version;
                },
                isCurrent: () => navigation === navigationSequence.current,
                fetchPage: (offset, limit) => api.fields(next, offset, limit),
              })
            : await api.fields(next);
        if (navigation !== navigationSequence.current) return;
        const fs = nextLayer === "field" ? page : page.slice(0, 100);
        setFieldsMore(nextLayer === "field" ? false : page.length > 100);
        setFields(fs);
        fieldListVersion.current = listedVersion;
        if (fieldAnalysis) {
          setFieldTaskId(node.kind === "TASK" ? node.taskId || node.id.replace(/^task:/, "") : "");
          setExplorationNotice(`已进入 ${next.label} 的字段分析，请选择字段后点击“展开”。`);
          return;
        }
        const restoreAssessment = restored
          ? assessExplorationRestore(
              restored.entry,
              activeVersion.current ?? restored.entry.graphVersion,
              fs.map((field) => field.id),
            )
          : undefined;
        const restoredFields = restoreAssessment
          ? fs.filter((field) =>
              restoreAssessment.selectedFieldIds.includes(field.id),
            )
          : [];
        const nextSelectedIds = restored
          ? restoredFields.map((field) => field.id)
          : fs[0]
            ? [fs[0].id]
            : [];
        setSelectedFieldIds(nextSelectedIds);
        setFieldTaskId("");
        if (restored) restore.current = restored.state.viewport;
        let restoredTrace: TraceResult | undefined;
        if (restored?.state.layer === "field" && !restoredFields.length) {
          setLayer("table");
          setExplorationNotice(
            "专题保存的字段在当前图谱中不存在或已变更；已保留原始起点，请从表血缘继续选择字段。",
          );
            restoredTrace = await runTrace(next, "table", false, undefined, {
              direction: nextDirection,
              depth: nextDepth,
              candidates: nextCandidates,
              expandedCandidateIds: restored.state.expandedCandidateIds,
              tableAnchors: [next],
            });
        } else {
          restoredTrace = await runTrace(
            next,
            nextLayer,
            !restored,
            restoredFields,
            {
              direction: nextDirection,
              depth: nextDepth,
              candidates: nextCandidates,
              expandedCandidateIds: restored?.state.expandedCandidateIds,
              tableAnchors: [next],
            },
          );
        }
        if (navigation !== navigationSequence.current) return;
        const anchorAssessment = restored
          ? assessExplorationAnchor(
              next,
              restoredTrace?.nodes.map((item) => item.id) ?? [],
            )
          : undefined;
        if (restored && !anchorAssessment?.present) {
          setTrace(undefined);
          setError(
            `专题起点“${next.label}”在当前图谱中不存在；未按同名对象替换，请从搜索结果选择新的起点。`,
          );
          return;
        }
        if (node.kind === "TASK") void loadDetail(node);
      } catch (e) {
        if (navigation === navigationSequence.current)
          setError(
            restored
              ? `专题起点“${next.label}”无法按原始身份恢复：${e instanceof Error ? e.message : "读取失败"}`
              : e instanceof Error
                ? e.message
                : "读取失败",
          );
      } finally {
        if (navigation === navigationSequence.current && fieldAnalysis) setLoadingAllFields(false);
      }
    },
    [
      anchor,
      candidates,
      depth,
      direction,
      selectedFieldIds,
      fieldTaskId,
      fields,
      fieldsMore,
      flow,
      layer,
      loadDetail,
      runTrace,
      clearDetail,
      tableAnchors,
    ],
  );
  async function chooseMany() {
    if (!selectedRoots.length) return;
    cancelTrace();
    clearDetail();
    ++navigationSequence.current;
    setLoadingAllFields(false);
    setFields([]);
    setFieldsMore(false);
    setSelectedFieldIds([]);
    setFieldTaskId("");
    fieldListVersion.current = undefined;
    setLayer("table");
    setMode("lineage");
    setTrace(undefined);
    setCanvasFocus(undefined);
    setHighlightedFieldId(undefined);
    setHighlightedTaskId(undefined);
    setExpandedCandidates(new Set());
    const roots = selectedRoots.map((node): Anchor => node.kind === "TASK"
      ? { taskId: node.taskId ?? node.id.replace(/^task:/, ""), label: node.label ?? node.id }
      : tableCardAnchor(node));
    const next = {
      ...roots[0]!,
      label: roots.length === 1 ? roots[0]!.label : `已选 ${roots.length} 个起点`,
    };
    setAnchor(next);
    setTableAnchors(roots);
    setSelected(undefined);
    setSelectedMembers([]);
    setTerminal(undefined);
    setDetails([]);
    await runTrace(next, "table", true, undefined, {
      direction,
      depth,
      candidates,
      tableAnchors: roots,
    });
  }
  function toggleRoot(node: GraphNode) {
    setSelectedRoots((current) => current.some((item) => item.id === node.id)
      ? current.filter((item) => item.id !== node.id)
      : [...current, node]);
  }
  function clearRoots() {
    cancelTrace();
    ++navigationSequence.current;
    clearDetail();
    setSelectedRoots([]);
    setTableAnchors([]);
    setAnchor(undefined);
    setTrace(undefined);
    setCanvasFocus(undefined);
    setHistory([]);
    setMode("overview");
  }
  const searchController = useRef<AbortController | undefined>(undefined);
  const searchedTerm = useRef("");
  useEffect(() => {
    searchController.current?.abort();
    searchController.current = undefined;
    setSearching(false);
    return () => searchController.current?.abort();
  }, [clusters]);
  async function search(append = false) {
    const term = query.trim();
    if (!term || searchController.current || (append && searchedTerm.current !== term)) return;
    recordAction("search");
    const controller = new AbortController();
    searchController.current = controller;
    setSearching(true);
    setError("");
    try {
      setRegionName("");
      const selectedClusters = clusterRules.current;
      const page = await api.search(term, append ? results.length : 0, 31, selectedClusters, controller.signal);
      if (controller.signal.aborted || controller !== searchController.current || selectedClusters !== clusterRules.current) return;
      searchedTerm.current = term;
      setResults(current => append ? [...current, ...page.slice(0, 30)] : page.slice(0, 30));
      setSearchMore(page.length > 30);
      setError(!append && page.length === 0 ? "当前已发布图谱中未找到匹配的任务或表，请检查名称或缩短关键词。" : "");
    } catch (e) {
      if (controller.signal.aborted || controller !== searchController.current) return;
      setError(e instanceof Error ? e.message : "搜索失败");
    } finally {
      if (controller === searchController.current) {searchController.current = undefined; setSearching(false);}
    }
  }
  const onNodeClick: NodeMouseHandler = (_, v) => {
    recordAction("canvas");
    const raw = v.data.raw as GraphNode | undefined;
    if (!raw || loading) return;
    setCanvasFocus({ nodeId: v.id, node: raw, trace });
    if (v.type === "processingTask") {
      if (trace?.layer === "field") void loadDetail(raw);
      setHighlightedFieldId(undefined);
      setHighlightedTaskId((current) => (current === v.id ? undefined : v.id));
      return;
    }
    setHighlightedTaskId(undefined);
    setHighlightedFieldId(current => current?.length === 1 && current[0] === raw.id ? undefined : [raw.id]);
  };
  async function back() {
    const navigation = ++navigationSequence.current;
    const p = history.at(-1);
    if (!p) return;
    setHistory((x) => x.slice(0, -1));
    setAnchor(p.anchor);
    setTableAnchors(p.tableAnchors);
    setLayer(p.layer);
    setDirection(p.direction);
    setDepth(p.depth);
    setCandidates(p.candidates);
    setSelectedFieldIds(p.selectedFieldIds);
    setFieldTaskId(p.fieldTaskId);
    restore.current = p.viewport;
    const fs = p.fields;
    fieldListVersion.current = p.fieldsVersion;
    setFieldsMore(p.fieldsMore);
    setFields(fs);
    const restoredFields = fs.filter((field) =>
      p.selectedFieldIds.includes(field.id) && (!p.fieldTaskId.trim() || field.taskId === p.fieldTaskId.trim()),
    );
    setTimeout(
      () =>
        void runTrace(p.anchor, p.layer, false, restoredFields, {
          direction: p.direction,
          depth: p.depth,
          candidates: p.candidates,
          tableAnchors: p.tableAnchors,
        }),
      0,
    );
  }
  useEffect(() => {
    void api
      .status()
      .then(setStatus)
      .catch((e) =>
        setError(e instanceof Error ? e.message : "图谱服务未就绪"),
      );
  }, []);
  useEffect(() => {
    if (mode !== "overview") return;
    let cancelled = false;
    const controller = new AbortController();
    setOverview(undefined);
    setRegionName("");
    setRegionMore(false);
    setResults([]);
    setError("");
    void (upstreamPatterns.length ? scopedOverview(upstreamPatterns, globalVisibility.tables, clusters, controller.signal) : api.overview(globalVisibility.tables, clusters, controller.signal))
      .then((value) => {
        if (cancelled) return;
        setOverview(value);
        activeVersion.current = value.version;
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "全貌读取失败"); });
    return () => { cancelled = true; controller.abort(); };
  }, [mode, globalVisibility.tables, upstreamPatterns, clusters]);
  useEffect(() => {
    const storage = (() => {
      try {
        return window.localStorage;
      } catch {
        return undefined;
      }
    })();
    const loaded = readExplorationEntries(storage);
    setExplorationEntries(loaded.entries);
    if (loaded.warning) setExplorationNotice(loaded.warning);
  }, []);
  useEffect(() => {
    if (!trace || mode !== "lineage") return;
    const first = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (restore.current) {
          void flow.setViewport(restore.current);
          restore.current = undefined;
          pendingFit.current = false;
        } else if (pendingFit.current) {
          const viewportElement = flowWrap.current;
          if (!viewportElement || !graph.nodes.length) return;
          const boxes = graph.nodes.map((node) => {
            const members = Array.isArray(node.data.members)
              ? node.data.members.length
              : 0;
            return {
              x: node.position.x,
              y: node.position.y,
              width: Number(node.data.displayWidth ?? (members ? 300 : 260)),
              height: Number(
                node.data.displayHeight ??
                  (members ? 92 + Math.min(members * 38, 280) : 96),
              ),
            };
          });
          const minX = Math.min(...boxes.map((box) => box.x));
          const minY = Math.min(...boxes.map((box) => box.y));
          const maxX = Math.max(...boxes.map((box) => box.x + box.width));
          const maxY = Math.max(...boxes.map((box) => box.y + box.height));
          const viewport = getViewportForBounds(
            { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
            viewportElement.clientWidth,
            viewportElement.clientHeight,
            0.1,
            1.05,
            0.08,
          );
          void flow.setViewport(viewport, { duration: 300 });
          pendingFit.current = false;
        }
      });
    });
    return () => cancelAnimationFrame(first);
  }, [flow, graph.nodes, mode, trace]);
  async function loadMoreSearch() {
    await search(true);
  }
  async function loadMoreFields() {
    if (!anchor) return;
    const page = await api.fields(anchor, fields.length);
    setFields((current) => [...current, ...page.slice(0, 100)]);
    setFieldsMore(page.length > 100);
  }
  async function enterFieldLayer() {
    if (!anchor || loadingAllFields) return;
    clearDetail();
    setCanvasFocus(undefined);
    setTrace(undefined);
    const navigation = ++navigationSequence.current;
    ++requestSequence.current;
    setLoadingAllFields(true);
    setError("");
    setLoading(false);
    try {
      let listedVersion: string | undefined;
      const all = await loadAllFieldPages({
        readVersion: async () => {
          const current = await api.status();
          if (typeof current.version !== "string" || !current.version)
            throw new Error("图谱版本不可用，请稍后重试。");
          listedVersion = current.version;
          return current.version;
        },
        isCurrent: () => navigation === navigationSequence.current,
        fetchPage: (offset, limit) => api.fields(anchor, offset, limit),
      });
      if (navigation !== navigationSequence.current) return;
      fieldListVersion.current = listedVersion;
      setFields(all);
      setFieldsMore(false);
      setSelectedFieldIds([]);
      setHighlightedFieldId(undefined);
      setHighlightedTaskId(undefined);
      setExpandedCandidates(new Set());
      setLayer("field");
    } catch (cause) {
      if (navigation === navigationSequence.current)
        setError(cause instanceof Error ? cause.message : "全部字段读取失败");
    } finally {
      if (navigation === navigationSequence.current) setLoadingAllFields(false);
    }
  }
  async function openRegion(schema: string, append = false) {
    const offset = append ? results.length : 0;
    const rules = visibilityRules.current;
    const scopeRules = upstreamRules.current;
    const selectedClusters = clusterRules.current;
    const page = scopeRules.length ? await scopedRegion(scopeRules, rules, schema, offset, selectedClusters) : await api.region(schema, offset, 50, rules, selectedClusters);
    if (rules !== visibilityRules.current || scopeRules !== upstreamRules.current || selectedClusters !== clusterRules.current) return;
    if (!isSameGraphVersion(activeVersion.current, page.version)) {
      setError("图谱版本已更新，请重新载入加工全貌。");
      return;
    }
    setRegionName(schema);
    setSearchMore(false);
    const items = normalizeRegionItems(page.items);
    setResults((current) =>
      append ? [...current, ...items.slice(0, 50)] : items.slice(0, 50),
    );
    setRegionMore(page.pagination.nextOffset !== null);
  }
  async function expandBranch(node: GraphNode, branchDirection: Direction) {
    if (!trace || trace.layer !== "table" || loading) return;
    const base = trace;
    const chosenClusters = clusterRules.current;
    const sequence = ++requestSequence.current;
    traceController.current?.abort();
    const controller = new AbortController();
    traceController.current = controller;
    setLoading(true);
    setError("");
    setBranchNotice("正在展开所选分支的一层关系…");
    try {
      const result = await expandTableCard({
        base, nodeId: node.id, direction: branchDirection, includeCandidates: candidates,
        clusters: chosenClusters,
        fetchTrace: query => api.trace(query, controller.signal),
        isCurrent: () => sequence === requestSequence.current && chosenClusters === clusterRules.current,
      });
      if (sequence !== requestSequence.current || chosenClusters !== clusterRules.current) return;
      const current = await api.status();
      if (sequence !== requestSequence.current || chosenClusters !== clusterRules.current) return;
      if (current.version !== base.version) throw new Error("图谱版本已变化，请重新展开当前图。");
      setBranchNotice(`${result.addedNodes || result.addedEdges ? `已加入新的分支，新增 ${result.addedEdges} 条读写记录` : "当前筛选下没有新的关系"}${result.omittedTasks ? `；${result.omittedTasks} 个其他集群调度已过滤` : ""}${result.trace.truncated ? "；查询达到上限，关系不完整" : ""}。`);
      pendingFit.current = false;
      setBranchPlacement({anchorId: node.id, direction: "down"});
      setTrace(result.trace);
      setSelectedTableRelation(undefined);
      setCanvasFocus(undefined);
      setHighlightedFieldId(undefined);
      setHighlightedTaskId(undefined);
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : "分支展开失败，已保留原图。");
        setBranchNotice("");
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }
  async function continueFromSelected() {
    if (!selected) return;
    const terminalIds = new Set(
      trace?.terminalNodes.map(({ nodeId }) => nodeId) ?? [],
    );
    const continuable = continuationRoots(
      selectedMembers.length ? selectedMembers : [selected], direction, trace?.edges ?? [],
    ).filter((member) => !terminalIds.has(member.id));
    if (!continuable.length) return;
    if (anchor)
      setHistory((items) => [
        ...items,
        {
          anchor,
          tableAnchors,
          layer,
          direction,
          depth,
          candidates,
          selectedFieldIds,
          fieldTaskId,
          fields,
          fieldsMore,
          fieldsVersion: fieldListVersion.current,
          viewport: flow.getViewport(),
        },
      ]);
    const next: Anchor = {
      nodeId: continuable[0]!.id,
      memberNodeIds: continuable.map(({ id }) => id),
      label: `${selected.table ?? ""}.${selected.column ?? selected.label ?? selected.id}`,
    };
    setAnchor(next);
    setLayer("field");
    setFields(continuable);
    fieldListVersion.current = activeVersion.current;
    setSelectedFieldIds(continuable.map(({ id }) => id));
    setFieldTaskId("");
    setFieldsMore(false);
    await runTrace(next, "field", true, continuable);
  }
  function localExplorationStorage(): Storage | undefined {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  }
  function replaceExplorationEntries(next: ExplorationEntry[]) {
    setExplorationEntries(next);
    const result = writeExplorationEntries(localExplorationStorage(), next);
    if (result.warning) setExplorationNotice(result.warning);
  }
  function currentGraphVersion(): string | undefined {
    if (activeVersion.current) return activeVersion.current;
    return typeof status?.version === "string" ? status.version : undefined;
  }
  function snapshotExplorationState(memberId: string): ExplorationState {
    return {
      activeMemberId: memberId,
      layer,
      direction,
      depth,
      candidates,
      selectedFieldIds: selectedTaskFields(fields, selectedFieldIds, fieldTaskId).map(field => field.id),
      expandedCandidateIds: [...expandedCandidates],
      viewport: flow.getViewport(),
    };
  }
  function newExplorationId(): string {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function createExploration(name: string, description: string) {
    if (!anchor) return;
    const graphVersion = currentGraphVersion();
    if (!graphVersion) {
      setError("图谱版本尚未就绪，暂时不能保存探索入口。");
      return;
    }
    try {
      const member = explorationMember(anchor);
      const entry = createExplorationEntry({
        id: newExplorationId(),
        name,
        description,
        graphVersion,
        member,
        state: snapshotExplorationState(member.id),
        now: new Date().toISOString(),
      });
      replaceExplorationEntries([...explorationEntries, entry]);
      setActiveExplorationId(entry.id);
      setExplorationNotice("已保存到当前浏览器。之后打开会按当前已发布图谱重新查询。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建专题失败");
    }
  }
  function updateExploration(
    entry: ExplorationEntry,
    name: string,
    description: string,
  ) {
    try {
      const updated = updateExplorationEntry(
        entry,
        {
          name,
          description,
          graphVersion: entry.graphVersion,
          state: entry.state,
        },
        new Date().toISOString(),
      );
      replaceExplorationEntries(
        explorationEntries.map((item) => (item.id === entry.id ? updated : item)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "修改专题失败");
    }
  }
  function saveExplorationState(entry: ExplorationEntry) {
    if (!anchor) return;
    const graphVersion = currentGraphVersion();
    const member = explorationMember(anchor);
    if (!graphVersion) {
      setError("图谱版本尚未就绪，暂时不能更新专题。");
      return;
    }
    if (!entry.members.some((item) => item.id === member.id)) {
      setError("当前起点尚未加入此专题，请先加入后再更新状态。");
      return;
    }
    try {
      const updated = updateExplorationEntry(
        {...entry, members: entry.members.map(item => item.id === member.id ? member : item)},
        {
          name: entry.name,
          description: entry.description,
          graphVersion,
          state: snapshotExplorationState(member.id),
        },
        new Date().toISOString(),
      );
      replaceExplorationEntries(
        explorationEntries.map((item) => (item.id === entry.id ? updated : item)),
      );
      setExplorationNotice("已更新此专题的当前查询与展示状态。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新专题失败");
    }
  }
  function addCurrentExplorationMember(entry: ExplorationEntry) {
    if (!anchor) return;
    const graphVersion = currentGraphVersion();
    if (!graphVersion) {
      setError("图谱版本尚未就绪，暂时不能加入起点。");
      return;
    }
    const member = explorationMember(anchor);
    const updated = {
      ...withExplorationMember(
        entry,
        member,
        snapshotExplorationState(member.id),
        new Date().toISOString(),
      ),
      graphVersion,
    };
    replaceExplorationEntries(
      explorationEntries.map((item) => (item.id === entry.id ? updated : item)),
    );
    setActiveExplorationId(entry.id);
    setExplorationNotice("已将当前原始身份的起点加入专题。");
  }
  function removeExplorationMember(
    entry: ExplorationEntry,
    member: ReturnType<typeof explorationMember>,
  ) {
    const updated = withoutExplorationMember(
      entry,
      member.id,
      new Date().toISOString(),
    );
    if (!updated) {
      replaceExplorationEntries(
        deleteExplorationEntry(explorationEntries, entry.id),
      );
      setActiveExplorationId(undefined);
      setExplorationNotice("专题已移除最后一个起点，因此一并删除。 ");
      return;
    }
    replaceExplorationEntries(
      explorationEntries.map((item) => (item.id === entry.id ? updated : item)),
    );
  }
  async function openExplorationMember(
    entry: ExplorationEntry,
    memberId: string,
  ) {
    const member = entry.members.find((item) => item.id === memberId);
    if (!member) return;
    const prepared: ExplorationEntry = {
      ...entry,
      state: { ...entry.state, activeMemberId: member.id },
      updatedAt: new Date().toISOString(),
    };
    replaceExplorationEntries(
      explorationEntries.map((item) => (item.id === entry.id ? prepared : item)),
    );
    setActiveExplorationId(entry.id);
    try {
      const current = await api.status();
      if (typeof current.version !== "string" || !current.version)
        throw new Error("当前已发布图谱版本不可用。");
      const changed = assessExplorationRestore(entry, current.version, [])
        .graphVersionChanged;
      activeVersion.current = current.version;
      setStatus(current);
      setError("");
      setExplorationNotice(
        changed
          ? `专题保存于图谱 ${entry.graphVersion.slice(0, 10)}，当前为 ${current.version.slice(0, 10)}；已丢弃旧画布并按当前版本重新查询。`
          : "已按当前已发布图谱重新查询此专题。",
      );
      const raw: GraphNode = {
        id:
          member.anchor.nodeId ??
          (member.anchor.taskId ? `task:${member.anchor.taskId}` : member.id),
        kind: member.kind,
        table: member.anchor.table,
        taskId: member.anchor.taskId,
        label: member.label,
      };
      await choose(raw, false, {
        entry: prepared,
        anchor: member.anchor,
        state: prepared.state,
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "无法打开保存的探索入口。",
      );
    }
  }
  return (
    <div className="app">
      <header>
        <div>
          <p className="kicker">DATA GRAPH · 按需探索</p>
          <h1>数据加工图谱</h1>
          <p>从任务和表进入，只读取当前需要的局部关系。</p>
        </div>
        <div
          className={`service ${status ? "ready" : ""}`}
          title={status ? String(status.version ?? "") : undefined}
        >
          <i />
          {status
            ? `已连接 · ${String(status.version ?? "").slice(0, 10)}`
            : "等待图谱服务"}
        </div>
      </header>
      <ResizableWorkspace>
        <aside className="search-panel panel">
          <button className="analysis-open overview-button" onClick={onOpenAnalysis}>分析范围 · 只看所选表和任务</button>
          <ClusterFilter selected={clusters} onApply={values => { setClusters(values); setSearchMore(false); setResults([]); setSelectedRoots([]); setRegionName(""); setSelected(undefined); ++detailSequence.current; setDetails([]); setHighlightedFieldId(undefined); }} />
          <GlobalVisibility {...globalVisibility} />
          {UPSTREAM_SCOPE_ENABLED && <UpstreamScopePanel patterns={upstreamPatterns} onApply={patterns => { setUpstreamPatterns(patterns); setMode("overview"); void flow.setViewport({ x: 0, y: 0, zoom: 0.65 }); }} onExit={() => { setUpstreamPatterns([]); setMode("overview"); }} />}
          <ExplorationPanel
            entries={explorationEntries}
            activeEntryId={activeExplorationId}
            currentAnchor={tableAnchors.length > 1 ? undefined : anchor}
            onCreate={createExploration}
            onOpen={(entry) =>
              void openExplorationMember(entry, entry.state.activeMemberId)
            }
            onOpenMember={(entry, memberId) =>
              void openExplorationMember(entry, memberId)
            }
            onUpdate={updateExploration}
            onDelete={(entry) => {
              replaceExplorationEntries(
                deleteExplorationEntry(explorationEntries, entry.id),
              );
              if (activeExplorationId === entry.id)
                setActiveExplorationId(undefined);
              setExplorationNotice("已从当前浏览器删除此探索入口。");
            }}
            onAddCurrent={addCurrentExplorationMember}
            onRemoveMember={removeExplorationMember}
            onSaveCurrent={saveExplorationState}
          />
          {explorationNotice && (
            <div className="exploration-notice">{explorationNotice}</div>
          )}
          <button
            className="overview-button"
            onClick={() => {
              setMode("overview");
              setRegionName("");
              setResults([]);
              void flow.setViewport({ x: 0, y: 0, zoom: 0.65 });
            }}
          >
            {upstreamPatterns.length ? "上游范围骨架" : "全域加工骨架"}
          </button>
          <h2>定位任务或表</h2>
          <details className="performance-log-control">
            <summary>性能记录</summary>
            <p>自动保留最近 200 条请求和卡顿记录；刷新后保留。不含搜索内容、表名或 SQL。</p>
            <button onClick={() => void collectPerformanceSnapshot().then(setPerformanceSnapshot)}>导出性能日志</button>
            {performanceSnapshot && <><a download="graph-performance.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(performanceSnapshot, null, 2))}`}>下载 JSON</a><details><summary>查看本次日志内容</summary><pre aria-label="性能日志内容" style={{maxHeight:280,overflow:"auto",fontSize:11}}>{JSON.stringify(performanceSnapshot, null, 2)}</pre></details></>}
          </details>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input
              value={query}
              onChange={(e) => {
                searchController.current?.abort(); searchController.current = undefined;
                setSearching(false); setSearchMore(false); setQuery(e.target.value);
              }}
              placeholder="技术表名、中文表说明、任务名或 ID"
            />
            <button disabled={searching || !query.trim()}>{searching ? "查找中…" : "查找"}</button>
          </form>
          {selectedRoots.length > 0 && (
            <div className="multi-root-actions" role="group" aria-label="已选溯源起点">
              <span>已选 {selectedRoots.length} 个起点</span>
              <button className="primary" disabled={loading || loadingAllFields} onClick={() => void chooseMany()}>
                {loading ? "读取中" : "一起溯源"}
              </button>
              <button disabled={loadingAllFields} onClick={clearRoots}>清空起点</button>
            </div>
          )}
          <div className="results">
            {regionName && <h3>{regionName} · 区域成员</h3>}
            {regionName && <RegionTopics clusters={clusters} key={regionName} schema={regionName} patterns={upstreamPatterns} hiddenTables={globalVisibility.tables} version={overview?.version} />}
            {results.map((n) => {
              const checked = selectedRoots.some((item) => item.id === n.id);
              return (
              <button className={checked ? "selected-root" : undefined} aria-pressed={checked} key={n.id} onClick={() => toggleRoot(n)}>
                <span className="result-check" aria-hidden="true">{checked ? "✓" : ""}</span>
                <b>{n.label}</b>
                <small>
                  {n.kind === "TASK"
                    ? `任务 ${n.id.replace(/^task:/, "")}`
                    : n.table}
                </small>
                {n.metadata?.table.description && (
                  <small className="search-description">
                    {n.metadata.table.description}
                  </small>
                )}
              </button>
            );})}
            {searchMore && (
              <button
                className="load-more"
                disabled={searching}
                onClick={() => void loadMoreSearch()}
              >
                加载更多结果
              </button>
            )}
            {regionName && regionMore && (
              <button
                className="load-more"
                onClick={() => void openRegion(regionName, true).catch(e => setError(e instanceof Error ? e.message : "区域读取失败"))}
              >
                加载更多区域成员
              </button>
            )}
          </div>
          <div className="scope-note">
            <b>查询边界</b>
            <p>
              不预加载全图。每次最多读取 {TRACE_EDGE_LIMIT} 条关系；字段列表按每页 100
              项继续加载。
            </p>
          </div>
        </aside>
        <main className="canvas panel">
          <div className="canvas-head">
            <div>
              <button
                className="back"
                disabled={!history.length}
                onClick={() => void back()}
              >
                ← 返回
              </button>
              <span className="crumb">
                {mode === "overview"
                  ? (upstreamPatterns.length ? "上游范围骨架 · 实验" : "全域加工骨架")
                  : (anchor?.label ?? "请选择任务或表")}
              </span>
            </div>
            {mode === "lineage" ? (
              <div className="toolbar">
                <select
                  value={layer}
                  onChange={(e) => {
                    cancelTrace();
                    const next = e.target.value as GraphLayer;
                    if (next === "field") void enterFieldLayer();
                    else {
                      setLayer(next);
                      setTimeout(() => void runTrace(anchor, next), 0);
                    }
                  }}
                  disabled={loadingAllFields}
                >
                  <option value="table">表血缘</option>
                  <option value="field" disabled={tableAnchors.length > 1}>字段血缘</option>
                </select>
                {layer === "field" && (
                  <FieldSelector
                    taskId={fieldTaskId}
                    onTaskChange={setFieldTaskId}
                    fields={scopedFields}
                    selectedIds={selectedFieldIds}
                    hasMore={fieldsMore}
                    onChange={setSelectedFieldIds}
                    onLoadMore={() => void loadMoreFields()}
                  />
                )}
                {tableAnchors.length <= 1 && anchor?.nodeId?.startsWith("dataset:") && (partitionError ? <span role="alert">{partitionError}</span> : <PartitionSelector
                  catalog={partitionCatalog} selection={anchor.partitionSelection} clusters={clusters} disabled={loading || loadingAllFields}
                  onApply={partitionSelection => {
                    recordAction("apply-partitions");
                    const next = {...anchor, partitionSelection};
                    ++requestSequence.current;
                    setAnchor(next); setCanvasFocus(undefined);
                    setSelectedFieldIds([]); setError("");
                    if (layer === "field") { setTrace(undefined); setExplorationNotice("分区范围已更新，请重新选择范围内的字段后展开。"); }
                    else void runTrace(next, "table").then(value => { if (!value) setAnchor(anchor); });
                  }}
                />)}
                <select
                  value={direction}
                  onChange={(e) => { cancelTrace(); setDirection(e.target.value as Direction); }}
                >
                  <option value="up">向上追溯</option>
                  <option value="down">向下影响</option>
                </select>
                <select
                  value={depth}
                  aria-label="表间层数"
                  title="1 层表示一次表到表加工，中间调度任务不另计层"
                  onChange={(e) => { cancelTrace(); setDepth(Number(e.target.value)); }}
                >
                  {[1, 2, 4, 6, 10].map((n) => (
                    <option key={n} value={n}>
                      {n} 层
                    </option>
                  ))}
                </select>
                {layer === "table" && (
                  <span
                    className="edge-width-legend"
                    title="线宽表示当前画布内去重后的静态读写关系记录数，不代表任务运行或调用次数"
                  >
                    <span>线宽＝关系记录</span>
                    <i className="thin" aria-hidden="true" />1
                    <i className="medium" aria-hidden="true" />2–3
                    <i className="wide" aria-hidden="true" />4–7
                    <i className="widest" aria-hidden="true" />≥8
                    <small>非运行次数</small>
                  </span>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={candidates}
                    onChange={(e) => { cancelTrace(); setCandidates(e.target.checked); }}
                  />{" "}
                  包含候选接续
                </label>
                <button
                  className="primary"
                  disabled={!anchor || loading || loadingAllFields}
                  onClick={() => void runTrace()}
                >
                  {loadingAllFields
                    ? "正在加载全部字段"
                    : loading
                      ? "读取中"
                      : "展开"}
                </button>
              </div>
            ) : (
              <div className="toolbar">
                <span className="muted">
                  区域与跨区关系来自 TABLE_IO 聚合；点击区域查看真实物理表。
                </span>
              </div>
            )}
            {mode === "lineage" && (
              <div className="node-analysis-actions" role="toolbar" aria-label="节点分析操作">
                <span>单击节点仅高亮；当前选中：<b>{canvasFocus?.trace === trace && canvasFocus ? canvasFocus.node.table || canvasFocus.node.label || `调度 ${canvasFocus.node.taskId}` : "请先单击一个表或调度"}</b></span>
                <button
                  disabled={!canvasFocus || canvasFocus.trace !== trace || loading || loadingAllFields || !["TASK", "PHYSICAL_DATASET"].includes(canvasFocus.node.kind)}
                  onClick={() => canvasFocus && void choose(canvasFocus.node, true, undefined, canvasFocus.node.kind === "TASK")}
                >{canvasFocus?.trace === trace && canvasFocus?.node.kind === "TASK" ? "分析此调度" : "分析此表"}</button>
                <button
                  disabled={!canvasFocus || canvasFocus.trace !== trace || loading || loadingAllFields}
                  onClick={() => canvasFocus && void loadDetail(canvasFocus.node, displayTrace?.terminalNodes.find(node => node.nodeId === canvasFocus.node.id))}
                >查看加工证据</button>
              </div>
            )}
          </div>
          {error && <div className="error">{error}</div>}
          {mode === "overview" && <UpstreamScopeStatus overview={overview} />}
          {mode === "lineage" && upstreamPatterns.length > 0 && (
            <div className="notice neutral">当前为独立血缘探索；实验范围仅约束“上游范围骨架”及其区域成员。</div>
          )}
          {mode === "lineage" && autoDepthNotice && (
            <div className="notice">{autoDepthNotice}</div>
          )}
          {mode === "lineage" && tableAnchors.length > 1 && (
            <div className="notice neutral">当前为 {tableAnchors.length} 个表/调度起点的合并表血缘；字段分析、分区范围和专题保存仍需先选择单个节点。</div>
          )}
          {mode === "lineage" && branchNotice && <div className="notice">{branchNotice}</div>}
          {mode === "lineage" && trace?.scopeWarnings?.map(warning => <div className="notice" key={warning}>{warning}</div>)}
          {mode === "lineage" && !!clusters.length && (
            <div className="notice">集群范围：{clusters.map(value => value || "未收录").join("、")}。已过滤 {clusterView?.omittedTaskIds.length ?? 0} 个其他集群或未收录调度，跨集群路径在此停止。</div>
          )}
          {mode === "overview" &&
            overview &&
            (overview.truncated.regions ||
              overview.truncated.flows ||
              overview.excluded.unqualifiedDatasets > 0) && (
              <div className="notice neutral">
                {upstreamPatterns.length ? "范围内聚合返回" : "当前聚合返回"} {overview.regions.length} 个区域、
                {overview.flows.length} 条区域关系
                {overview.truncated.regions || overview.truncated.flows
                  ? "，已达到查询上限"
                  : ""}
                ；另有 {overview.excluded.unqualifiedDatasets} 个无完整
                schema.table 身份的数据集未纳入。
              </div>
            )}
          {mode === "lineage" && trace?.truncated && !trace.multiRootSummary && (
            <div className="notice">
              已达到 {trace.edgeLimit} 条关系上限，请缩小范围。
              {!!trace.unqueriedRootNodeIds?.length && ` 另有 ${trace.unqueriedRootNodeIds.length} 个已选字段尚未查询，未画作孤立字段。`}
            </div>
          )}
          {mode === "lineage" && trace?.multiRootSummary && (
            <div className={trace.truncated ? "notice" : "notice neutral"}>
              多起点查询完成 {trace.multiRootSummary.completed}/{trace.multiRootSummary.requested} 个起点。
              {!!trace.multiRootSummary.failed.length && ` 失败：${trace.multiRootSummary.failed.map((item) => `${item.label}（${item.message}）`).join("；")}。`}
              {!!trace.multiRootSummary.truncatedRootIds.length && ` ${trace.multiRootSummary.truncatedRootIds.length} 个起点的返回被截断。`}
              {!!trace.unqueriedRootNodeIds?.length && ` ${trace.unqueriedRootNodeIds.length} 个起点因合图关系上限尚未查询。`}
              {trace.truncated && " 当前画布不是完整结果。"}
            </div>
          )}
          {mode === "lineage" && trace?.stoppedBy === "DEPTH_LIMIT" && (
            <div className="notice neutral">
              已到 {trace.depthLimit} 层边界，前沿仍可继续展开。
            </div>
          )}
          {mode === "lineage" && layer === "field" && foldedEdgeCount > 0 && (
            <div className="notice neutral">{foldedEdgeCount} 条连线因端点字段不在卡片可视范围内暂时收起；滚动查看，或点击字段定位关联字段。</div>
          )}
          <div className="flow-wrap" ref={flowWrap}>
            {mode === "overview" && overview ? (
              <Suspense fallback={<div className="welcome">正在加载骨架画布…</div>}><OverviewCanvas clusters={clusters} overview={overview} patterns={upstreamPatterns} hiddenTables={globalVisibility.tables} onOpenRegion={schema => { void openRegion(schema).catch(e => setError(e instanceof Error ? e.message : "区域读取失败")); }} /></Suspense>
            ) : mode === "overview" ? <div className="welcome">{error ? "范围读取未完成，请重新应用或退出范围。" : "正在读取加工骨架…"}</div> : anchor ? (
              <NodeVisibility nodes={globalGraph.nodes} edges={globalGraph.edges} scope={canvasScope}>
                {(displayGraph) => (
              <DraggableLineageCanvas
                scope={canvasScope}
                placement={branchPlacement}
                nodes={displayGraph.nodes}
                edges={displayGraph.edges}
                nodeTypes={nodeTypes}
                onNodeClick={onNodeClick}
                onEdgeClick={(_, edge) => {
                  if (loading || layer !== "table") return;
                  const relation = edge.data?.raw as GraphEdge | undefined;
                  if (!relation || !["READS_TABLE", "WRITES_TABLE"].includes(relation.kind)) return;
                  const table = displayTrace?.nodes.find(node => node.kind === "PHYSICAL_DATASET" &&
                    (node.id === relation.from || node.id === relation.to));
                  if (table) void loadDetail(table, undefined, undefined, relation);
                }}
                onPaneClick={() => {
                  setCanvasFocus(undefined);
                  setHighlightedFieldId(undefined);
                  setHighlightedTaskId(undefined);
                }}
                minZoom={0.1}
                nodesDraggable
                nodesConnectable={false}
                attributionPosition="bottom-left"
              >
                <Background color="#c8d8d5" gap={24} />
                {layer === "table" && <MiniMap pannable zoomable />}
                <Controls />
                {canvasFocus?.trace === trace && canvasFocus &&
                  ["TASK", "PHYSICAL_DATASET"].includes(canvasFocus.node.kind) &&
                  displayGraph.nodes.some(node => node.id === canvasFocus.nodeId) &&
                  <NodeAnalysisToolbar
                    nodeId={canvasFocus.nodeId}
                    node={canvasFocus.node}
                    disabled={loading || loadingAllFields}
                    onAnalyze={() => void choose(canvasFocus.node, true, undefined, canvasFocus.node.kind === "TASK")}
                    onEvidence={() => void loadDetail(canvasFocus.node, displayTrace?.terminalNodes.find(node => node.nodeId === canvasFocus.node.id))}
                    onExpandUp={layer === "table" ? () => void expandBranch(canvasFocus.node, "up") : undefined}
                    onExpandDown={layer === "table" ? () => void expandBranch(canvasFocus.node, "down") : undefined}
                  />}
              </DraggableLineageCanvas>
                )}
              </NodeVisibility>
            ) : (
              <div className="welcome">
                <span>01</span>
                <h2>先定位一个任务或表</h2>
                <p>再在同一画布切换表血缘与字段血缘。</p>
              </div>
            )}
          </div>
          <footer>
            {mode === "lineage" && (
              <div className="legend">
                {layer === "table" && <><span><i style={{borderColor: INPUT_EDGE_COLOR}} />输入</span><span><i style={{borderColor: OUTPUT_EDGE_COLOR}} />输出</span><span>拖动节点标题可调整位置</span></>}
                <span>
                  <i className="solid confirmed" />
                  CONFIRMED
                </span>
                <span>
                  <i className="solid" />
                  其他直接关系
                </span>
                <span>
                  <i className="candidate" />
                  CANDIDATE
                </span>
              </div>
            )}
            {mode === "lineage" && trace && (
              <p>
                当前显示 {graph.nodes.length} 个节点 · {graph.edges.length}{" "}
                条连线 · {trace.elapsedMs} ms
              </p>
            )}
          </footer>
        </main>
        <DetailPanel
          key={`${selected?.id ?? "none"}:${details.map((item) => `${item.taskId}:${item.requestedWriteId ?? ""}:${item.version}`).join("|") || "none"}`}
          node={selected}
          fieldContext={selectedFieldContext?.nodeId === selected?.id ? selectedFieldContext?.context : undefined}
          terminal={terminal}
          detail={detail}
          details={details}
          loading={detailLoading}
          onContinue={() => void continueFromSelected()}
          onNavigateTask={taskId => void choose({id: `task:${taskId}`, kind: "TASK", taskId, label: `调度 ${taskId}`})}
        >
          {inspectedRelations.length > 0 && <TableRelationsPanel
            edges={inspectedRelations} nodes={clusterView?.trace.nodes ?? []}
            onInspect={node => void loadDetail(node)} />}
        </DetailPanel>
      </ResizableWorkspace>
    </div>
  );
}
export default function App() {
  const initialPreset = presetFromSearch(window.location.search);
  const [clusters, updateClusters] = useState<string[]>(() => {
    try { return readGlobalClusters(window.localStorage); } catch { return []; }
  });
  function setClusters(values: string[]) {
    updateClusters(values);
    try { window.localStorage.setItem("data-graph:clusters", JSON.stringify(values)); } catch { /* Keep session state when storage is unavailable. */ }
  }
  const [analysis, setAnalysis] = useState(() => new URLSearchParams(window.location.search).get("analysis") === "1" || Boolean(initialPreset));
  function changeMode(enabled: boolean) {
    const url = new URL(window.location.href);
    if (enabled) url.searchParams.set("analysis", "1");
    else {
      url.searchParams.delete("analysis");
      url.searchParams.delete("scope");
      url.searchParams.delete("topic");
      url.searchParams.delete("view");
    }
    window.history.replaceState(null, "", url);
    setAnalysis(enabled);
  }
  return (
    <ReactFlowProvider>
      <Suspense fallback={<div className="welcome">正在加载分析范围…</div>}>
        {analysis ? <AnalysisWorkspace initialPreset={initialPreset} clusters={clusters} setClusters={setClusters} onExit={() => changeMode(false)} /> : <Explorer clusters={clusters} setClusters={setClusters} onOpenAnalysis={() => changeMode(true)} />}
      </Suspense>
    </ReactFlowProvider>
  );
}
