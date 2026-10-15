import { useEffect, useState } from "react";

type TopicResult = { version: string; topics: Array<{ name: string; label: string }>; incomplete: boolean };
export function RegionTopics({ schema, patterns, hiddenTables, version, clusters = [] }: { schema: string; patterns: string[]; hiddenTables: string[]; version?: string; clusters?: string[] }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<TopicResult>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResult(undefined); setError("");
    const query = new URLSearchParams({ schema, patterns: JSON.stringify(patterns), hiddenTables: JSON.stringify(hiddenTables), clusters: JSON.stringify(clusters) });
    void fetch(`/api/region-topics?${query}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("调度主题读取失败，请稍后重试。");
      const data = await response.json() as TopicResult;
      if (version && data.version !== version) throw new Error("图谱版本已变化，请重新打开区域。");
      if (!controller.signal.aborted) setResult(data);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取失败"); });
    return () => controller.abort();
  }, [open, schema, patterns, hiddenTables, version, clusters]);
  return <details className="region-topics" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>关联加工主题</summary>
    {open && <div style={{ padding: "8px 0", fontSize: 12 }}>
      <p>写入本区域表的任务所属调度主题，不代表表的业务归属；按当前范围及隐藏规则统计。</p>
      {error ? <p role="alert">{error}</p> : !result ? <p role="status">读取中…</p> : <>
        {result.topics.length ? <ul style={{ paddingLeft: 18, maxHeight: 240, overflow: "auto" }}>{result.topics.map(topic => <li key={topic.name} title={topic.name} style={{ marginBottom: 6, overflowWrap: "anywhere" }}>{topic.label}</li>)}</ul> : <p>暂无可确认的关联主题。</p>}
        {result.incomplete && <p>部分任务主题缺失或已达到查询上限，列表可能不完整。</p>}
      </>}
    </div>}
  </details>;
}
