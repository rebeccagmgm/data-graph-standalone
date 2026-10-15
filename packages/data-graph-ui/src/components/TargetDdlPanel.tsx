import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isSameGraphVersion } from "../contract";
import type { TaskDetail } from "../types";
import { SqlCode } from "./SqlCode";

export function TargetDdlPanel({ detail, column, writeId }: {
  detail: TaskDetail; column?: string; writeId?: string;
}) {
  const sequence = useRef(0);
  const [items, setItems] = useState<TaskDetail["targetDdls"]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => { sequence.current += 1; }, []);
  async function load() {
    if (items || loading) return;
    const request = ++sequence.current;
    setLoading(true); setError("");
    try {
      const value = await api.task(detail.taskId, { column, writeId, ddl: true });
      if (sequence.current !== request) return;
      if (!isSameGraphVersion(detail.version, value.version)) {
        setError("图谱版本已更新，请重新选择任务后读取 DDL。");
        return;
      }
      setItems(value.targetDdls ?? []);
    } catch {
      if (sequence.current === request) setError("目标表 DDL 读取失败，请重试。");
    } finally {
      if (sequence.current === request) setLoading(false);
    }
  }
  return <details onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary>目标表 DDL</summary>
    {loading && <p className="muted">正在读取…</p>}
    {error && <p className="warning">{error} <button onClick={() => void load()}>重试</button></p>}
    {items?.length === 0 && <p className="muted">目标表 DDL 未收录，或目标表身份尚未明确。</p>}
    {items?.map((item, index) => <section key={index}>
      <h4>{item.table}</h4>
      {item.writeId && <small>写入：{item.writeId}</small>}
      {item.status === "AVAILABLE" && item.content !== undefined ? <>
        <p className="muted">来源：{item.source} · 采集时间：{item.collectedAt || "未收录"}</p>
        <SqlCode source={item.content} label="目标表 DDL" />
      </> : <p className="muted">{item.status === "CHANGED"
        ? "DDL 材料与当前元数据目录不一致，请更新元数据目录后重新加载。"
        : "目标表 DDL 未收录或不可读取，或物理身份尚未明确。"}</p>}
    </section>)}
  </details>;
}
