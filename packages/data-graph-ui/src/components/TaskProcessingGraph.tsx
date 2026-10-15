import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type {
  ProcessingSourceLocation,
  TaskDetail,
  TaskFieldExplanation,
  TaskProcessingEdge,
  TaskProcessingStage,
} from "../types";
import { SqlCode } from "./SqlCode";
import { gapLabel, operationLabel, valuePresentation, visibleExpressions, writeLabel } from "./processing-presentation";
import "./task-processing-graph.css";

const CARD_WIDTH = 280;
const CARD_HEIGHT = 206;
const COLUMN_GAP = 36;
const ROW_GAP = 80;
const MARGIN = 24;
const edgeLabels: Record<TaskProcessingEdge["kind"], string> = {
  VALUE: "值来源", CONDITION: "分支选择", CONTROL: "行集控制", MATERIALIZATION: "分支合并",
};
const roleLabels: Record<string, string> = {
  VALUE_CONTRIBUTION: "值贡献", BRANCH_SELECTION: "分支选择",
  RESULT_VALUE: "返回值", BRANCH_SELECTOR: "分支条件", COALESCE_ARGUMENT: "空值回退参数",
  VALUE: "值来源", CONDITION: "分支选择", CONTROL: "行集控制",
};
type Position = { x: number; y: number };

/** Layout only: stage identities and dependencies come exclusively from the API. */
export function layoutProcessingStages(stages: TaskProcessingStage[], edges: TaskProcessingEdge[]) {
  const ids = new Set(stages.map(stage => stage.id));
  const invalidEdgeIds = edges.filter(edge => !ids.has(edge.from) || !ids.has(edge.to)).map(edge => edge.id);
  const successors = new Map<string, Set<string>>();
  const degree = new Map(stages.map(stage => [stage.id, 0]));
  const depth = new Map(stages.map(stage => [stage.id, 0]));
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    const targets = successors.get(edge.from) ?? new Set<string>();
    if (!targets.has(edge.to)) degree.set(edge.to, degree.get(edge.to)! + 1);
    targets.add(edge.to);
    successors.set(edge.from, targets);
  }
  const queue = stages.filter(stage => degree.get(stage.id) === 0).map(stage => stage.id);
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    visited.add(id);
    for (const next of successors.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next)!, depth.get(id)! + 1));
      degree.set(next, degree.get(next)! - 1);
      if (degree.get(next) === 0) queue.push(next);
    }
  }
  const cycleStageIds = stages.filter(stage => !visited.has(stage.id)).map(stage => stage.id);
  const finalDepth = Math.max(0, ...depth.values()) + 1;
  for (const id of cycleStageIds) depth.set(id, finalDepth);
  const layers = new Map<number, TaskProcessingStage[]>();
  for (const stage of stages) {
    const level = depth.get(stage.id)!;
    layers.set(level, [...(layers.get(level) ?? []), stage]);
  }
  const maxColumns = Math.min(5, Math.max(1, ...[...layers.values()].map(layer => layer.length)));
  const width = MARGIN * 2 + maxColumns * CARD_WIDTH + (maxColumns - 1) * COLUMN_GAP;
  const positions = new Map<string, Position>();
  let y = MARGIN;
  for (const [, layer] of [...layers].sort(([a], [b]) => a - b)) {
    for (let start = 0; start < layer.length; start += maxColumns) {
      const row = layer.slice(start, start + maxColumns);
      const rowWidth = row.length * CARD_WIDTH + (row.length - 1) * COLUMN_GAP;
      row.forEach((stage, index) => positions.set(stage.id, {
        x: (width - rowWidth) / 2 + index * (CARD_WIDTH + COLUMN_GAP), y,
      }));
      y += CARD_HEIGHT + ROW_GAP;
    }
  }
  return { positions, width, height: Math.max(CARD_HEIGHT + MARGIN * 2, y - ROW_GAP + MARGIN), cycleStageIds, invalidEdgeIds };
}

function locationLabel(location?: ProcessingSourceLocation, slot?: string) {
  const source = location?.slot ?? slot;
  if (!source) return "SQL 位置未收录";
  if (!location?.lineStart) return `${source} · 行号未收录`;
  const range = location.lineEnd && location.lineEnd !== location.lineStart
    ? `${location.lineStart}–${location.lineEnd}` : String(location.lineStart);
  return `${source} · 第 ${range} 行`;
}

export function ProcessingStageEvidence({ stage, edges, stages, gaps }: {
  stage: TaskProcessingStage;
  edges: TaskProcessingEdge[];
  stages: TaskProcessingStage[];
  gaps: TaskFieldExplanation["gaps"];
}) {
  const incoming = edges.filter(edge => edge.to === stage.id);
  const names = new Map(stages.map(item => [item.id, item.table]));
  const stageGaps = gaps.filter(gap => gap.stageId === stage.id || (gap.id && stage.gapIds?.includes(gap.id)));
  return <section className="processing-stage-evidence" aria-label="选中阶段的加工证据">
    <div className="processing-stage-heading"><h4>{stage.label || (stage.kind === "SOURCE" ? "源表读取" : "阶段加工")}</h4><span>{stage.slot ?? "来源"}</span></div>
    <strong className="processing-table-name">{stage.table || "物理表身份缺失"}</strong>
    {stage.writeId && <p className="processing-identity">{writeLabel(stage)}</p>}
    {incoming.length > 0 && <div className="processing-incoming">
      <h5>进入本阶段</h5>
      {incoming.map(edge => <p key={edge.id}>
        <span className={`processing-dependency-tag kind-${edge.kind}`}>{edgeLabels[edge.kind]}</span>
        {names.get(edge.from) || "来源阶段缺失"}
        {edge.columns?.length ? <small>字段：{edge.columns.join("、")}</small> : null}
        {edge.status === "UNRESOLVED" && <small className="processing-warning">待确认</small>}
      </p>)}
    </div>}
    {stage.expressions.length > 0 && <h5>字段表达式</h5>}
    {stage.expressions.map(expression => <section className="processing-expression" key={expression.id}>
      <b>{expression.column || "表达式"}</b>
      <small className="processing-location">{locationLabel(expression.sourceLocation, stage.slot)}</small>
      {expression.roles?.length ? <div className="processing-role-tags">{[...new Set(expression.roles)].map(role => <span key={role}>{roleLabels[role] ?? role}</span>)}</div> : null}
      <SqlCode source={expression.text} compact />
    </section>)}
    {stage.controls.length > 0 && <details className="processing-conditions"><summary>关联与过滤条件（{stage.controls.length}）</summary>
    {stage.controls.map(control => <section className="processing-expression" key={control.id}>
      <b>{control.kind}</b>
      <small className="processing-location">{locationLabel(control.sourceLocation, stage.slot)}</small>
      <SqlCode source={control.text} compact />
    </section>)}</details>}
    {!stage.expressions.length && !stage.controls.length && <p className="muted">{stage.kind === "SOURCE" ? "此节点保留本任务的源表读取身份。" : "本阶段未提供表达式或条件，不能据此判断没有加工。"}</p>}
    {stageGaps.length > 0 && <details><summary>本步骤有 {stageGaps.length} 项依据待确认</summary>{stageGaps.map((gap, index) => <p className="processing-warning" key={gap.id ?? `${gap.code}-${index}`}>{gapLabel(gap)}</p>)}</details>}
    <details><summary>技术详情</summary><code>{stage.id}</code>{stage.writeId && <code>{stage.writeId}</code>}{stage.statementId && <code>{stage.statementId}</code>}{stage.readOccurrenceId && <code>{stage.readOccurrenceId}</code>}</details>
  </section>;
}

export function TaskProcessingGraphView({ explanation }: { explanation: TaskFieldExplanation }) {
  const [showConditions, setShowConditions] = useState(false);
  const mainline = useMemo(() => valuePresentation(explanation), [explanation]);
  const graph = showConditions ? explanation : mainline;
  const layout = useMemo(() => layoutProcessingStages(graph.stages, graph.edges), [graph.stages, graph.edges]);
  const edgeOffsets = useMemo(() => {
    const groups = new Map<string, TaskProcessingEdge[]>();
    for (const edge of graph.edges) {
      const pair = JSON.stringify([edge.from, edge.to]);
      groups.set(pair, [...(groups.get(pair) ?? []), edge]);
    }
    const offsets = new Map<string, number>();
    for (const group of groups.values()) group.forEach((edge, index) => {
      offsets.set(edge.id, ((index + 1) / (group.length + 1) - 0.5) * CARD_WIDTH * 0.65);
    });
    return offsets;
  }, [graph.edges]);
  const anchorStage = explanation.stages.find(stage => stage.kind === "WRITE" && stage.writeId === explanation.anchor.writeId && stage.role === "FINAL")
    ?? explanation.stages.find(stage => stage.kind === "WRITE" && stage.writeId === explanation.anchor.writeId);
  const [selectedId, setSelectedId] = useState(anchorStage?.id ?? "");
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const markerId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const selected = graph.stages.find(stage => stage.id === selectedId) ?? anchorStage;
  const frontier = new Set(explanation.frontierStageIds);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  function centerStage(id: string, scale = zoom) {
    const position = layout.positions.get(id);
    const element = viewport.current;
    if (!position || !element) return;
    element.scrollTo({
      left: (position.x + CARD_WIDTH / 2) * scale - element.clientWidth / 2,
      top: (position.y + CARD_HEIGHT / 2) * scale - element.clientHeight / 2,
      behavior: "smooth",
    });
  }

  return <section className={`task-processing-graph${expanded ? " is-expanded" : ""}`} aria-label="任务内加工链">
    <div className="processing-header"><div><h3>字段怎么加工</h3><p>从上往下看：源字段 → 中间表字段 → 当前查看字段</p></div>
      <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? "收起画布" : "展开画布"}</button>
    </div>
    <div className="processing-anchor"><b>{anchorStage?.table}.{explanation.anchor.column}</b><small>当前查看终点 · {anchorStage ? writeLabel(anchorStage) : "写入步骤未收录"}（可能是中间表）</small></div>
    <div className={`processing-status status-${explanation.status}`} role="status">
      {explanation.status === "COMPLETE" ? "已展开本字段的已知加工链" : explanation.status === "PARTIAL" ? "部分加工依据待确认，可在下方展开查看" : "达到查询上限，当前只展示已返回阶段"}
      {explanation.stoppedBy.length > 0 && <small>停止原因：{explanation.stoppedBy.join("、")}</small>}
    </div>
    <div className="processing-view-choice"><label><input type="checkbox" checked={showConditions} onChange={event => { setShowConditions(event.target.checked); setSelectedId(anchorStage?.id ?? ""); }} />显示关联与过滤关系</label><small>{showConditions ? "虚线说明条件影响，不能当作字段取值来源。" : `当前显示取值主线 · ${graph.stages.length} 个步骤；关联与过滤条件可点开步骤查看。`}</small></div>
    {showConditions && <div className="processing-legend">{Object.entries(edgeLabels).map(([kind, label]) => <span key={kind} className={`kind-${kind}`}><i />{label}</span>)}</div>}
    <div className="processing-workspace">
      <div className="processing-canvas-column">
        <div className="processing-toolbar">
          <button type="button" aria-label="缩小加工图" onClick={() => setZoom(value => Math.max(0.2, value - 0.15))}>−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="放大加工图" onClick={() => setZoom(value => Math.min(1.6, value + 0.15))}>＋</button>
          <button type="button" onClick={() => {
            const width = viewport.current?.clientWidth ?? layout.width;
            setZoom(Math.max(0.2, Math.min(1, (width - 12) / layout.width)));
            viewport.current?.scrollTo({ left: 0, top: 0 });
          }}>适配宽度</button>
          {selected && <button type="button" onClick={() => centerStage(selected.id)}>定位选中</button>}
        </div>
        <div className="processing-canvas" ref={viewport} tabIndex={0} aria-label="可滚动的任务加工图">
          <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
            <div className="processing-stage-plane" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
              <svg className="processing-connectors" width={layout.width} height={layout.height} aria-label="阶段之间的已记录依赖">
                <defs>{Object.keys(edgeLabels).map(kind => <marker key={kind} id={`${markerId}-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path className={`kind-${kind}`} d="M 0 0 L 10 5 L 0 10 z" /></marker>)}</defs>
                {graph.edges.map(edge => {
                  const from = layout.positions.get(edge.from), to = layout.positions.get(edge.to);
                  if (!from || !to) return null;
                  const offset = edgeOffsets.get(edge.id) ?? 0;
                  const x1 = from.x + CARD_WIDTH / 2 + offset, y1 = from.y + CARD_HEIGHT;
                  const x2 = to.x + CARD_WIDTH / 2 + offset, y2 = to.y;
                  const bend = (y1 + y2) / 2;
                  const label = `${edge.label ?? edgeLabels[edge.kind]}${edge.status === "UNRESOLVED" ? " · 待确认" : ""}`;
                  return <g key={edge.id} data-processing-edge={edge.id} className={`processing-edge kind-${edge.kind}${edge.status === "UNRESOLVED" ? " unresolved" : ""}`}>
                    <path d={`M ${x1} ${y1} C ${x1} ${bend}, ${x2} ${bend}, ${x2} ${y2}`} markerEnd={`url(#${markerId}-${edge.kind})`}><title>{label}{edge.columns?.length ? `：${edge.columns.join("、")}` : ""}</title></path>
                    {(edge.label || edge.status === "UNRESOLVED") && <text x={(x1 + x2) / 2} y={bend - 5} textAnchor="middle">{label}</text>}
                  </g>;
                })}
              </svg>
              {graph.stages.map(stage => {
                const position = layout.positions.get(stage.id)!;
                const expressions = visibleExpressions(stage, showConditions ? undefined : mainline.columns.get(stage.id));
                const sourceFields = showConditions ? graph.edges.filter(edge => edge.from === stage.id).flatMap(edge => edge.columns ?? []) : [...(mainline.columns.get(stage.id) ?? [])];
                const fields = stage.kind === "SOURCE" ? [...new Set(sourceFields)].filter(column => column !== "*") : [...new Set(expressions.map(expression => expression.column))];
                return <button type="button" key={stage.id} data-processing-stage={stage.id} aria-pressed={selectedId === stage.id}
                  className={`processing-stage stage-${stage.kind}${selectedId === stage.id ? " selected" : ""}${stage.id === anchorStage?.id ? " anchor" : ""}`}
                  style={{ left: position.x, top: position.y, width: CARD_WIDTH, height: CARD_HEIGHT }}
                  title={`${stage.table}\n${fields.join("、")}\n${expressions.map(expression => expression.text).join("\n")}`}
                  onClick={() => setSelectedId(stage.id)}>
                  <span className="processing-stage-kind">{stage.id === anchorStage?.id ? "当前查看字段" : stage.kind === "SOURCE" ? "读取源字段" : stage.kind === "BRANCH" ? stage.label || "加工分支" : "中间表写入"}</span>
                  <strong>{stage.table || "物理表身份缺失"}</strong>
                  <span className="processing-field-name">{fields.join("、") || "字段信息未收录"}</span>
                  <span className="processing-operation">{stage.kind === "SOURCE" ? (mainline.columns.has(stage.id) ? "读取原始值" : "参与关联或条件判断") : expressions.length ? [...new Set(expressions.map(expression => operationLabel(expression.text)))].join(" · ") : "加工方式待确认"}</span>
                  {expressions[0] && <span className="processing-expression-preview">{expressions[0].text}</span>}
                  <small>{stage.kind === "SOURCE" ? "点击查看读取依据" : writeLabel(stage)}{stage.controls.length ? ` · ${stage.controls.length} 项条件` : ""}</small>
                  {frontier.has(stage.id) && <span className="processing-stage-frontier">待继续展开</span>}
                </button>;
              })}
            </div>
          </div>
        </div>
        <p className="processing-navigation-hint">箭头表示已记录的字段传递，虚线表示待确认。点击卡片查看完整表达式；同表的不同写入仍分别保留。</p>
      </div>
      <div className="processing-evidence-column">
        <label className="processing-stage-selector">查看阶段<select value={selectedId} onChange={event => { setSelectedId(event.target.value); centerStage(event.target.value); }}>
          <option value="">请选择阶段</option>
          {graph.stages.map(stage => <option key={stage.id} value={stage.id}>{stage.label ? `${stage.label} · ` : ""}{stage.table} · {stage.kind === "SOURCE" ? "读取" : writeLabel(stage)}</option>)}
        </select></label>
        {selected && <ProcessingStageEvidence stage={{...selected, expressions: visibleExpressions(selected, showConditions ? undefined : mainline.columns.get(selected.id))}} edges={graph.edges} stages={explanation.stages} gaps={explanation.gaps} />}
      </div>
    </div>
    {(layout.invalidEdgeIds.length > 0 || layout.cycleStageIds.length > 0) && <p className="processing-warning">部分阶段关系缺少端点或存在循环，所有已知阶段仍保留；当前布局不能证明执行顺序。</p>}
    {explanation.gaps.length > 0 && <details className="processing-gaps"><summary>{explanation.gaps.length} 项加工依据待确认 · 展开查看</summary>{explanation.gaps.map((gap, index) => <div key={gap.id ?? `${gap.code}-${index}`}><p>{gapLabel(gap)}</p><details><summary>技术详情</summary><small>{gap.message}<br />{gap.code}</small></details></div>)}</details>}
  </section>;
}

export function processingAnchors(detail: TaskDetail) {
  const values = detail.bindings.filter(binding => binding.outputScope === "FINAL" && binding.writeId && binding.column)
    .map(binding => ({ writeId: binding.writeId!, column: binding.column, table: binding.table }));
  return [...new Map(values.map(value => [JSON.stringify([value.writeId, value.column]), value])).values()];
}

export function TaskProcessingGraph({ detail }: { detail: TaskDetail }) {
  const anchors = useMemo(() => processingAnchors(detail), [detail]);
  const writeIds = [...new Set(anchors.map(anchor => anchor.writeId))];
  const explicit = detail.requestedWriteId && detail.requestedColumn
    ? { writeId: detail.requestedWriteId, column: detail.requestedColumn }
    : anchors.length === 1 ? anchors[0] : undefined;
  const [chosen, setChosen] = useState("");
  const selected = explicit ?? anchors.find(anchor => JSON.stringify([anchor.writeId, anchor.column]) === chosen);
  const [result, setResult] = useState<TaskFieldExplanation>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const requestSequence = useRef(0);
  const key = JSON.stringify([detail.version, detail.taskId, selected?.writeId, selected?.column]);
  useEffect(() => {
    const sequence = ++requestSequence.current;
    setResult(undefined);
    setError("");
    if (!selected) { setLoading(false); return; }
    setLoading(true);
    void api.explain(detail.taskId, { writeId: selected.writeId, column: selected.column, publicationVersion: detail.version })
      .then(value => {
        if (sequence !== requestSequence.current) return;
        if (value.version !== detail.version || value.taskId !== detail.taskId || value.anchor.writeId !== selected.writeId || value.anchor.column.toLowerCase() !== selected.column.toLowerCase()) {
          throw new Error("加工证据的版本或写入身份发生变化，请重新选择字段后读取。");
        }
        setResult(value);
      })
      .catch(cause => { if (sequence === requestSequence.current) setError(cause instanceof Error ? cause.message : "加工链读取失败"); })
      .finally(() => { if (sequence === requestSequence.current) setLoading(false); });
    return () => { requestSequence.current += 1; };
  }, [key, retry]);
  return <div className="task-processing-section">
    {!explicit && <label className="processing-anchor-selector">选择要查看的写入字段<select value={chosen} onChange={event => setChosen(event.target.value)}>
      <option value="">请选择字段和写入</option>
      {anchors.map(anchor => <option key={JSON.stringify([anchor.writeId, anchor.column])} value={JSON.stringify([anchor.writeId, anchor.column])}>{anchor.table ? `${anchor.table}.` : ""}{anchor.column} · 写入记录 {writeIds.indexOf(anchor.writeId) + 1}</option>)}
    </select></label>}
    {!selected && <p className="muted">{anchors.length ? "选择一次最终写入及其字段，展开该任务内的源表、临时表和加工分支。" : "当前缺少明确的最终写入和字段身份，暂不能展开任务内加工链。"}</p>}
    {loading && <p className="muted" role="status">正在读取任务内加工链…</p>}
    {error && <p className="processing-warning" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button></p>}
    {result && selected && result.version === detail.version && result.taskId === detail.taskId &&
      result.anchor.writeId === selected.writeId && result.anchor.column.toLowerCase() === selected.column.toLowerCase() &&
      <TaskProcessingGraphView key={key} explanation={result} />}
  </div>;
}
