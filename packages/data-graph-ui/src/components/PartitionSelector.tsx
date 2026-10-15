import {useEffect, useState} from "react";
import type {PartitionCatalog, PartitionSelection} from "../../../data-graph/src/asset-graph/partition-selection";
import "./partition-selector.css";

export function PartitionSelector({catalog, selection, clusters, disabled, onApply}: {
  catalog?: PartitionCatalog & {taskClusters: Record<string, string>}; selection?: PartitionSelection;
  clusters: string[]; disabled: boolean; onApply: (value?: PartitionSelection) => void;
}) {
  const [draft, setDraft] = useState<string[]>(selection?.optionIds ?? []);
  useEffect(() => setDraft(selection?.optionIds ?? []), [selection]);
  if (!catalog) return <span className="muted">正在读取分区范围…</span>;
  if (!catalog.options.length) return <span className="muted">当前表没有可用的写入分区证据</span>;
  const options = catalog.options.map(option => ({...option, count: option.writes.filter(w => !clusters.length || clusters.includes(catalog.taskClusters[w.taskId] ?? "")).length}));
  return <details className="partition-selector">
    <summary>分区范围 · {selection ? `已选 ${selection.optionIds.length} 组` : "全表（未限定）"}</summary>
    <div className="partition-options">
      <p>选择本次分析的分区组合；表血缘和字段血缘共用。</p>
      {catalog.ignoredDateColumns.length > 0 && <p className="muted">日度维度 {catalog.ignoredDateColumns.join("、")} 不单独选择，底层日期证据仍保留。</p>}
      {options.map(option => <label key={option.id}>
        <input type="checkbox" disabled={disabled || !option.count} checked={draft.includes(option.id)} onChange={event => setDraft(ids => event.target.checked ? [...ids, option.id] : ids.filter(id => id !== option.id))}/>
        <span>{option.label} <small>· 当前集群 {option.count} 次写入{option.unknown ? " · 证据待确认" : ""}</small></span>
      </label>)}
      <div className="partition-buttons">
        <button disabled={disabled} onClick={() => setDraft(options.filter(o => o.count && !o.unknown).map(o => o.id))}>全选已知范围</button>
        <button className="primary" disabled={disabled || !draft.length} onClick={() => onApply({datasetId: catalog.datasetId, version: catalog.version, optionIds: draft})}>应用分区</button>
        <button disabled={disabled || !selection} onClick={() => onApply(undefined)}>取消分区限定</button>
      </div>
    </div>
  </details>;
}
