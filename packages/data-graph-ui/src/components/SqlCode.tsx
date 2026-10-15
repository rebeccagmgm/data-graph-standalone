import { useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/core";
import sql from "highlight.js/lib/languages/sql";
import "highlight.js/styles/github-dark.css";

hljs.registerLanguage("sql", sql);

export function highlightSql(source: string): string {
  return hljs.highlight(source, { language: "sql", ignoreIllegals: true })
    .value;
}

export function SqlCode({
  source,
  label = "SQL",
  compact = false,
}: {
  source: string;
  label?: string;
  compact?: boolean;
}) {
  const [copyState, setCopyState] = useState("");
  useEffect(() => {
    setCopyState("");
  }, [source]);
  const highlighted = useMemo(() => {
    try {
      return highlightSql(source);
    } catch {
      return undefined;
    }
  }, [source]);
  const lines = source.split("\n").length;
  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setCopyState("已复制");
    } catch {
      setCopyState("复制失败，请选中 SQL 手动复制");
    }
  }
  const code =
    highlighted === undefined ? (
      <code>{source}</code>
    ) : (
      <code
        className="hljs language-sql"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    );
  if (compact) return <pre className="sql-fragment">{code}</pre>;
  return (
    <div className="sql-viewer">
      <div className="sql-toolbar">
        <b>{label}</b>
        <span>{lines} 行</span>
        <button type="button" onClick={() => void copy()}>
          复制 SQL
        </button>
      </div>
      {copyState && (
        <p className="sql-copy-status" role="status">
          {copyState}
        </p>
      )}
      <div
        className="sql-code"
        tabIndex={0}
        role="region"
        aria-label={`${label} 查询语句`}
      >
        <pre className="sql-line-numbers" aria-hidden="true">
          {Array.from({ length: lines }, (_, index) => index + 1).join("\n")}
        </pre>
        <pre className="sql-source">{code}</pre>
      </div>
    </div>
  );
}
