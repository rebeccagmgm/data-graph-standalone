import { useState } from "react";
import type { OverviewResult, RegionResult } from "../types";
import { compileScopePatterns } from "../../../data-graph/src/asset-graph/experimental-upstream-scope/pattern";
import "./style.css";

// One switch disables the experiment; normal overview APIs remain unchanged.
export const UPSTREAM_SCOPE_ENABLED = true;
export type ScopedOverview = OverviewResult & {
  scope: { status: "COMPLETE"; rootCount: number; tableCount: number; visibleTableCount: number; relationCount: number; visibleRelationCount: number };
};
const errors: Record<string, string> = {
  INVALID_SCOPE_PATTERNS: "请填写有效表名或 LIKE 模式，每行一条，最多 25 条。",
  UPSTREAM_SCOPE_ROOT_LIMIT: "匹配起点超过 1000 张表，请缩小匹配范围；未显示部分结果。",
  UPSTREAM_SCOPE_SIZE_LIMIT: "上游范围超过实验容量，请缩小起点范围；未显示部分结果。",
  UPSTREAM_SCOPE_TIME_LIMIT: "本次未完成全部上游计算，请缩小起点范围；未显示部分结果。",
  ASSET_GRAPH_CHANGED_DURING_QUERY: "图谱版本发生变化，请重新应用范围。",
};
async function requestScope<T>(patterns: string[], hiddenTables: string[], schema?: string, offset = 0, clusters: string[] = [], signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams({ patterns: JSON.stringify(patterns), hiddenTables: JSON.stringify(hiddenTables), clusters: JSON.stringify(clusters) });
  if (schema !== undefined) { query.set("schema", schema); query.set("offset", String(offset)); }
  const response = await fetch(`/api/experimental/upstream-scope?${query}`, {signal});
  const body = await response.json();
  if (!response.ok) throw new Error(errors[body.error] ?? "实验范围读取失败，请检查图谱服务后重试。");
  return body as T;
}
export const scopedOverview = (patterns: string[], hidden: string[], clusters: string[] = [], signal?: AbortSignal) => requestScope<ScopedOverview>(patterns, hidden, undefined, 0, clusters, signal);
export const scopedRegion = (patterns: string[], hidden: string[], schema: string, offset: number, clusters: string[] = []) => requestScope<RegionResult>(patterns, hidden, schema, offset, clusters);

export function UpstreamScopePanel({ patterns, onApply, onExit }: { patterns: string[]; onApply: (patterns: string[]) => void; onExit: () => void }) {
  const [draft, setDraft] = useState("%t01\\_%");
  const [error, setError] = useState("");
  return <section className="upstream-scope-panel">
    <h3>上游范围 · 实验</h3>
    <p>指定起点表，展示它们与所有表级上游的区域骨架。支持多行 LIKE 模式：% 为任意字符，_ 为单个字符，\_ 为下划线。</p>
    <form onSubmit={event => {
      event.preventDefault();
      try {
        const values = compileScopePatterns(draft.split(/\r?\n/).map(line => line.trim()).filter(Boolean)).map(p => p.pattern);
        setError(""); onApply(values);
      } catch { setError(errors.INVALID_SCOPE_PATTERNS); }
    }}>
      <textarea aria-label="上游起点表或 LIKE 模式" rows={3} value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="submit">应用范围</button>
      <button type="button" disabled={!patterns.length} onClick={onExit}>退出范围</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <p>{patterns.length ? `当前范围：${patterns.join("、")}` : "当前未启用范围筛选"}</p>
    <small>无 schema 时匹配短表名；按表级读写关系溯源，不代表字段或分区因果。刷新后退出实验范围。</small>
  </section>;
}

export function UpstreamScopeStatus({ overview }: { overview: OverviewResult | undefined }) {
  if (!overview || !("scope" in overview)) return null;
  const { scope } = overview as ScopedOverview;
  return <div className="notice neutral" role="status">
    {scope.rootCount === 0 ? "没有匹配的起点表，请调整模式。" : `已完成上游范围计算：${scope.rootCount} 张起点表，共 ${scope.tableCount} 张表；应用隐藏规则后 ${scope.visibleTableCount} 张表、${scope.visibleRelationCount} 条表级读写组合。`}
    {(overview.truncated.regions || overview.truncated.flows) && " 范围已算完，但区域画布只展示限额内的部分结果。"}
  </div>;
}
