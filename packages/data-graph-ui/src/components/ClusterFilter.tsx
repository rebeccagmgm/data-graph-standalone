import { useEffect, useState, useTransition } from "react";

type ClusterOption = { value: string; label: string; taskCount: number };
export function ClusterFilter({ selected, onApply, description = "全局作用于总览、查找和血缘画布；跨集群路径在此停止。" }: { selected: string[]; onApply: (values: string[]) => void; description?: string }) {
  const [options, setOptions] = useState<ClusterOption[]>();
  const [draft, setDraft] = useState(selected);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();
  const unchanged = draft.length === selected.length && draft.every(value => selected.includes(value));
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void fetch("/api/clusters", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("集群列表读取失败");
      const body = await response.json() as { clusters: ClusterOption[] };
      if (!Array.isArray(body.clusters)) throw new Error("集群列表读取失败");
      if (!controller.signal.aborted) setOptions(body.clusters);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取失败"); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => setDraft(selected), [selected]);
  return <details className="cluster-filter" open>
    <summary>集群筛选 · {selected.length ? `已选 ${selected.length} 项` : "全部集群"}</summary>
    <p>{description}</p>
    {error ? <div role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>重试</button></div> : !options ? <p role="status">读取集群…</p> : <>
      <div className="cluster-options">
        {options.map(option => <label key={option.value}>
          <input type="checkbox" checked={draft.includes(option.value)} onChange={event => setDraft(values => event.target.checked ? [...values, option.value] : values.filter(value => value !== option.value))} />
          <span>{option.label}</span><small>{option.taskCount} 个任务</small>
        </label>)}
      </div>
      <div className="cluster-actions">
        <button disabled={!draft.length || unchanged || pending} onClick={() => startTransition(() => onApply(draft))}>{pending ? "正在应用…" : "应用所选"}</button>
        <button disabled={pending || !selected.length} onClick={() => { setDraft([]); startTransition(() => onApply([])); }}>全部集群</button>
      </div>
      <small>任务数来自当前已发布图谱。表按所选集群任务的读写关系纳入。</small>
    </>}
  </details>;
}
