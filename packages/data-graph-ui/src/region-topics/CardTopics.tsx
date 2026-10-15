import { useEffect, useState } from "react";
export type CardTopicData = { topics: Array<{ name: string; label: string; tableCount?: number }>; total: number; incomplete: boolean };
export function useCardTopics(schemas: string[], patterns: string[], hiddenTables: string[], version: string, clusters: string[] = []) {
  const key = JSON.stringify({ schemas, patterns, hiddenTables, version, clusters });
  const [state, setState] = useState<{ key: string; values?: Record<string, CardTopicData>; failed?: boolean }>();
  useEffect(() => {
    if (!schemas.length) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ schemas: JSON.stringify(schemas), patterns: JSON.stringify(patterns), hiddenTables: JSON.stringify(hiddenTables), clusters: JSON.stringify(clusters) });
    void fetch(`/api/region-topics?${query}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("TOPICS_FAILED");
      const body = await response.json() as { version: string; regions: Array<CardTopicData & { schema: string }> };
      if (body.version !== version) throw new Error("VERSION_CHANGED");
      if (!controller.signal.aborted) setState({ key, values: Object.fromEntries(body.regions.map(region => [region.schema.toLowerCase(), region])) });
    }).catch(() => { if (!controller.signal.aborted) setState({ key, failed: true }); });
    return () => controller.abort();
  }, [key]);
  return state?.key === key ? state : undefined;
}
export function CardTopics({ value, failed }: { value?: CardTopicData; failed?: boolean }) {
  return <div className="overview-card-topics">
    {!value ? <span>{failed ? "主题暂不可用" : "主题读取中…"}</span> : <>
      {value.topics.slice(0, 2).map(topic => <div key={topic.name} title={`${topic.label}（${topic.name}）：写入任务覆盖 ${topic.tableCount ?? "未知"} 张表`}>{topic.label}{topic.tableCount !== undefined && ` · ${topic.tableCount} 张表`}</div>)}
      {!value.topics.length && <span>{value.incomplete ? "主题未确认" : "暂无关联主题"}</span>}
      {(value.total > 2 || value.incomplete) && <small>{value.total > 2 ? `另有 ${value.total - 2} 个${value.incomplete ? "以上" : ""}` : "主题信息不完整"}</small>}
    </>}
  </div>;
}
