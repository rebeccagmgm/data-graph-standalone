import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { SqlCode } from "./SqlCode";
import { TaskProcessingGraph } from "./TaskProcessingGraph";
import { TargetDdlPanel } from "./TargetDdlPanel";
import { isSameGraphVersion } from "../contract";
import type { FieldSelectionContext } from "../graph-adapter";
import type {
  GraphNode,
  MetadataStatus,
  TaskDetail,
  TerminalNode,
} from "../types";
const labels: Record<string, string> = {
  filter: "过滤条件",
  join: "Join",
  aggregate: "分组与聚合",
  window: "窗口",
  setop: "分支合并",
};
const metadataStatus: Record<MetadataStatus, string> = {
  AVAILABLE: "已收录",
  ANNOTATION_NOT_RECORDED: "未收录注释",
  METADATA_UNAVAILABLE: "元数据不可用",
  METADATA_READ_FAILED: "元数据读取失败",
};

function uniformValue(values: Array<string | undefined>): string | undefined {
  if (!values.length || values.some((value) => !value)) return undefined;
  const unique = new Set(values);
  return unique.size === 1 ? values[0] : undefined;
}

function evidenceIdentity(detail: TaskDetail): {
  column?: string;
  writeId?: string;
} {
  return {
    column:
      detail.requestedColumn ??
      uniformValue(detail.bindings.map(({ column }) => column)),
    writeId:
      detail.requestedWriteId ??
      uniformValue(detail.bindings.map(({ writeId }) => writeId)),
  };
}

function TaskEvidence({ detail }: { detail: TaskDetail }) {
  const identity = evidenceIdentity(detail);
  const stateKey = `${detail.version}|${detail.taskId}|${identity.column ?? ""}|${identity.writeId ?? ""}`;
  const requestSequence = useRef(0);
  const [sql, setSql] = useState<TaskDetail["sqlSources"]>(),
    [sqlLoading, setSqlLoading] = useState(false),
    [sqlError, setSqlError] = useState("");

  useEffect(() => {
    requestSequence.current += 1;
    setSql(undefined);
    setSqlLoading(false);
    setSqlError("");
  }, [stateKey]);

  async function loadSql() {
    if (sql || sqlLoading) return;
    const sequence = ++requestSequence.current;
    setSqlLoading(true);
    setSqlError("");
    try {
      const value = await api.task(detail.taskId, {
        column: identity.column,
        writeId: identity.writeId,
        sql: true,
      });
      if (sequence !== requestSequence.current) return;
      if (!isSameGraphVersion(detail.version, value.version)) {
        setSqlError("图谱版本已更新，请重新展开后读取 SQL。");
        return;
      }
      setSql(value.sqlSources ?? []);
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setSqlError(cause instanceof Error ? cause.message : "SQL 读取失败");
    } finally {
      if (sequence === requestSequence.current) setSqlLoading(false);
    }
  }

  const finalBindings = detail.bindings.filter(
    (binding) => binding.outputScope === "FINAL",
  );
  const renderBindings = (bindings: TaskDetail["bindings"]) =>
    bindings.map((binding, index) => {
      const field = binding.metadata?.field;
      const comment =
        field?.status === "AVAILABLE" ? field.comment?.trim() : undefined;
      const status =
        field?.status === "AVAILABLE" && !comment
          ? "ANNOTATION_NOT_RECORDED"
          : (field?.status ?? "METADATA_UNAVAILABLE");
      return (
        <section
          key={`${binding.writeId ?? "unknown-write"}-${binding.column}-${index}`}
          className="evidence"
        >
          <div className="evidence-field-title">
            <b>{binding.column}</b>
            <span
              className="evidence-field-comment"
              data-status={status}
              title="目标字段注释，来自当前元数据目录"
            >
              {!binding.metadata
                ? "注释尚未加载"
                : (comment ?? metadataStatus[status])}
            </span>
          </div>
          {binding.table && <small>目标表：{binding.table}</small>}
          {binding.valueOrigin && (
            <p className="value-origin-detail">{binding.valueOrigin.label}</p>
          )}
          {binding.expression ? (
            <SqlCode source={binding.expression} compact />
          ) : (
            <p className="muted">当前没有字段表达式</p>
          )}
          {binding.writeId && <code>{binding.writeId}</code>}
          {binding.inputFields?.map((field) => (
            <small key={`${field.table}.${field.column}`}>
              {field.table}.{field.column}
            </small>
          ))}
        </section>
      );
    });

  return (
    <section className="task-evidence">
      <h3>{detail.taskName ?? `任务 ${detail.taskId}`}</h3>
      {detail.taskName && (
        <p className="scheduler-task-name">
          <b>调度任务名：</b>
          {detail.taskName}
        </p>
      )}
      <p className="scheduler-task-name">
        <b>负责人：</b>
        {detail.owner
          ?.split(",")
          .map((owner) => owner.trim())
          .filter(Boolean)
          .join("、") || "未收录"}
      </p>
      <p className="scheduler-task-name">
        <b>调度集群：</b>
        {detail.cluster || "未收录"}
      </p>
      <div className="badges">
        <span>任务 {detail.taskId}</span>
        {identity.writeId ? (
          <span>写入 {identity.writeId}</span>
        ) : (
          <span>写入身份未明确</span>
        )}
        {detail.taskCategory && <span>{detail.taskCategory}</span>}
        <span>
          {detail.coverage === "PROJECTED" ? "字段投影已发布" : "材料范围"}
        </span>
      </div>
      {detail.failureReason && (
        <p className="warning">材料缺口：{detail.failureReason}</p>
      )}
      <TaskProcessingGraph detail={detail} />
      {finalBindings.length > 0 && <h3>最终输出字段</h3>}
      <TargetDdlPanel key={stateKey} detail={detail} column={identity.column} writeId={identity.writeId} />
      {!finalBindings.length && detail.bindings.length > 0 && (
        <p className="muted">
          暂未取得最终输出字段，请重新选择任务加载。
        </p>
      )}
      {renderBindings(finalBindings)}
      <h3>加工条件</h3>
      {detail.controls.length ? (
        detail.controls.slice(0, 35).map((control, index) => (
          <section className="control" key={index}>
            <b>
              {labels[control.kind] ?? control.kind} {control.joinType ?? ""}
            </b>
            {control.condition || control.sourceText ? (
              <SqlCode
                source={control.condition || control.sourceText!}
                compact
              />
            ) : (
              <p>
                {JSON.stringify(
                  control.groupBy ?? control.window ?? "详见 SQL",
                )}
              </p>
            )}
          </section>
        ))
      ) : (
        <p className="muted">当前没有独立条件记录。</p>
      )}
      <details
        onToggle={(event) => {
          if (event.currentTarget.open) void loadSql();
        }}
      >
        <summary>读取 SQL 原文</summary>
        {sqlLoading && <p className="muted">正在读取…</p>}
        {sqlError && <p className="warning">{sqlError}</p>}
        {sql?.map((source) => (
          <section key={source.slot}>
            <SqlCode source={source.content} label={source.slot} />
          </section>
        ))}
      </details>
    </section>
  );
}

export function DetailPanel({
  node,
  fieldContext,
  terminal,
  detail,
  details,
  loading,
  onContinue,
  onNavigateTask,
  children,
}: {
  node?: GraphNode;
  fieldContext?: FieldSelectionContext;
  terminal?: TerminalNode;
  detail?: TaskDetail;
  details?: TaskDetail[];
  loading: boolean;
  onContinue?: () => void;
  onNavigateTask?: (taskId: string) => void;
  children?: ReactNode;
}) {
  const evidenceDetails = details?.length ? details : detail ? [detail] : [];
  const reference = node?.detail?.scheduleReference as {upstreamTaskIds?: unknown; downstreamTaskIds?: unknown} | undefined;
  const scheduleIds = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  if (loading)
    return (
      <aside className="detail panel">
        <h2>加工证据</h2>
        <p className="muted">正在读取证据…</p>
      </aside>
    );
  if (!node && !evidenceDetails.length)
    return (
      <aside className="detail panel">
        <h2>加工证据</h2>
        <p className="muted">点击任务或字段，查看公式、加工条件和停止原因。</p>
      </aside>
    );
  return (
    <aside className="detail panel">
      <h2>加工证据</h2>
      {node && (
        <>
          <div className="eyebrow">{node.kind}</div>
          <h3>{node.column || node.label || node.table || node.id}</h3>
          <code className="identity">{node.physicalNodeId ?? node.id}</code>
          {!!fieldContext?.writeRefs.length && <details>
            <summary>来源写入依据（{fieldContext.writeRefs.length} 组）</summary>
            <p className="muted">以下为接续使用的写入与范围证据，不代表 SQL 的读取次数。</p>
            {fieldContext.writeRefs.map((ref, index) => <section key={`${ref.taskId}:${ref.writeId}:${index}`}>
              <b>写入调度 {ref.taskId}</b>
              <code className="identity">{ref.writeId}</code>
              <p>{ref.scope?.label ?? "范围未收录"}</p>
            </section>)}
          </details>}
          {node.kind === "TASK" && reference && <details>
            <summary>配置中的调度上下游</summary>
            <p className="muted">调度依赖供继续查看；是否经过当前表仍以读写证据为准。</p>
            {([['上游', reference.upstreamTaskIds], ['下游', reference.downstreamTaskIds]] as const).map(([label, ids]) => <section key={label}>
              <b>{label}</b>{scheduleIds(ids).length ? scheduleIds(ids).map(id => <button key={id} onClick={() => onNavigateTask?.(id)} disabled={!onNavigateTask}>查看调度 {id}</button>) : <p className="muted">未收录</p>}
            </section>)}
          </details>}
          {node.metadata && (
            <section className="metadata-detail">
              <h3>表说明与字段注释</h3>
              {node.metadata.schema && (
                <p>
                  <b>数据域：</b>
                  {node.metadata.schema.displayName}
                  {node.metadata.schema.displayName &&
                  node.metadata.schema.description
                    ? " · "
                    : ""}
                  {node.metadata.schema.description}
                </p>
              )}
              <p>
                <b>表说明：</b>
                {node.metadata.table.description ??
                  metadataStatus[node.metadata.table.status]}
              </p>
              {node.column && (
                <>
                  <p>
                    <b>字段注释：</b>
                    {node.metadata.field?.comment ??
                      metadataStatus[
                        node.metadata.field?.status ?? "METADATA_UNAVAILABLE"
                      ]}
                  </p>
                  <p>
                    <b>字段类型：</b>
                    {node.metadata.field?.rawType ?? "未收录"}
                  </p>
                  <p>
                    <b>字段顺序：</b>
                    {node.metadata.field?.ordinal === undefined
                      ? "未收录"
                      : node.metadata.field.ordinal + 1}
                    {node.metadata.field?.partition ? " · 分区字段" : ""}
                  </p>
                </>
              )}
              <details>
                <summary>查看元数据来源</summary>
                <p>来源：{node.metadata.source ?? "未提供"}</p>
                {node.metadata.collectedAt && (
                  <p>采集时间：{node.metadata.collectedAt}</p>
                )}
                {node.metadata.contentHash && (
                  <p>内容版本：{node.metadata.contentHash}</p>
                )}
                {node.metadata.sourceHash && (
                  <p>来源文件 hash：{node.metadata.sourceHash}</p>
                )}
                {node.metadata.ddlHash && (
                  <p>DDL hash：{node.metadata.ddlHash}</p>
                )}
                {node.metadata.metadataCatalog?.version && (
                  <p>元数据目录版本：{node.metadata.metadataCatalog.version}</p>
                )}
                {node.metadata.metadataCatalog?.builtAt && (
                  <p>目录更新时间：{node.metadata.metadataCatalog.builtAt}</p>
                )}
                {node.metadata.versionRelation && (
                  <p className="muted">
                    注释来自当前 Table Input
                    Pack，不等同于画布的已发布图谱版本。
                  </p>
                )}
              </details>
            </section>
          )}
        </>
      )}
      {children}
      {terminal && (
        <div className="terminal-box">
          <b>追溯在此停止</b>
          <p>{terminal.reason}</p>
          {terminal.ruleRef && <code>{terminal.ruleRef}</code>}
        </div>
      )}
      {node?.kind?.includes("FIELD") && !terminal && onContinue && (
        <button className="continue-button" onClick={onContinue}>
          以此字段继续追溯
        </button>
      )}
      {evidenceDetails.map((item, index) => {
        const identity = evidenceIdentity(item);
        return (
          <TaskEvidence
            key={`${item.version}|${item.taskId}|${identity.column ?? ""}|${identity.writeId ?? ""}|${index}`}
            detail={item}
          />
        );
      })}
    </aside>
  );
}
