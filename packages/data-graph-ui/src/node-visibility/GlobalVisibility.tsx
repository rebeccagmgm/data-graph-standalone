import { useState } from "react";
import { normalizeHiddenTables, readHiddenTables, STORAGE_KEY } from "./global";

export function useGlobalVisibility() {
  const [state, setState] = useState(() => {
    try { return { tables: readHiddenTables(), error: "" }; }
    catch { return { tables: [] as string[], error: "隐藏规则读取失败，请重新设置；当前未应用规则。" }; }
  });
  const update = (tables: string[]) => {
    try {
      const normalized = normalizeHiddenTables(tables);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      setState({ tables: normalized, error: "" });
    } catch { setState(s => ({ ...s, error: "保存失败：请使用 schema.table 格式，最多 100 张表，并允许浏览器本地存储。" })); }
  };
  return { ...state, update };
}

export function GlobalVisibility({ tables, error, update }: ReturnType<typeof useGlobalVisibility>) {
  const [input, setInput] = useState("");
  return <section className="global-visibility">
    <h3>全局隐藏表（{tables.length}）</h3>
    <p>按完整表名匹配所有同名来源，隐藏节点及入出边。保存在当前浏览器，适用于全域骨架和血缘画布。</p>
    <form onSubmit={event => { event.preventDefault(); if (input.trim()) { update([...tables, input.trim()]); setInput(""); } }}>
      <input aria-label="全局隐藏表名" placeholder="schema.table" value={input} onChange={event => setInput(event.target.value)} />
      <button type="submit" disabled={!input.trim()}>添加隐藏</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <ul>{tables.map(table => <li key={table}><span>{table}</span><button onClick={() => update(tables.filter(value => value !== table))} aria-label={`取消隐藏 ${table}`}>恢复</button></li>)}</ul>
    <button disabled={!tables.length} onClick={() => update([])}>清空全局规则</button>
  </section>;
}
