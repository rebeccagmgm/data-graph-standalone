import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import type { LineageNodeData } from "../graph-adapter";
import type {
  ConsumptionScope,
  ConsumptionWriteRef,
  FieldValueOrigin,
  GraphNode,
  TableMetadata,
  TerminalNode,
} from "../types";
import { fieldHandleVisible } from "../field-viewport";
import { TaskNode } from "./TaskNode";

const names: Record<string, string> = {
  TASK: "任务",
  PHYSICAL_DATASET: "物理表",
  PHYSICAL_FIELD: "物理字段",
  READ_FIELD: "物理表",
  WRITE_FIELD: "物理表",
  READ_OCCURRENCE: "表读取",
  TARGET_WRITE: "表写入",
};

function TableDescription({ description }: { description?: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!description) return null;
  return (
    <div className="table-description">
      <p data-expanded={expanded}>{description}</p>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
      >
        {expanded ? "收起说明" : "展开说明"}
      </button>
    </div>
  );
}

export function SchemaDescription({
  schema,
}: {
  schema?: TableMetadata["schema"];
}) {
  if (!schema?.displayName && !schema?.description) return null;
  return (
    <div className="schema-description">
      {schema.displayName && <b>{schema.displayName}</b>}
      {schema.description && (
        <span>
          {schema.displayName ? " · " : ""}
          {schema.description}
        </span>
      )}
    </div>
  );
}

function terminalCopy(terminal: TerminalNode) {
  const boundary =
    terminal.role === "REFERENCE_CONFIG"
      ? "定义/参数边界"
      : terminal.role === "SOURCE_ENDPOINT"
        ? "源端点边界"
        : "追溯边界";
  return `${boundary} · ${terminal.reason}`;
}

function FieldRow({
  member,
  terminal,
  onFieldClick,
  highlightActive = false,
  active = true,
  aliases = [],
  scope,
  writeRefs = [],
  connectedFieldIds = [],
}: {
  member: GraphNode;
  terminal?: TerminalNode;
  onFieldClick?: LineageNodeData["onFieldClick"];
  highlightActive?: boolean;
  active?: boolean;
  aliases?: GraphNode[];
  scope?: ConsumptionScope;
  writeRefs?: ConsumptionWriteRef[];
  connectedFieldIds?: string[];
}) {
  const handleNodes = [member, ...aliases].filter(
    (alias, index, all) =>
      all.findIndex((candidate) => candidate.id === alias.id) === index,
  );
  // A read can represent a merged row, while origin metadata belongs to writes.
  const writes = handleNodes.filter((node) => node.kind === "WRITE_FIELD");
  const originNodes = writes.length ? writes : handleNodes;
  const origins = new Map<string, FieldValueOrigin>();
  for (const node of originNodes) {
    const origin = node.valueOrigin;
    if (origin) {
      origins.set(
        JSON.stringify([origin.kind, origin.label, origin.expression]),
        origin,
      );
    }
  }
  const partialOrigin =
    origins.size > 1 ||
    originNodes.some((node) => !node.valueOrigin) ||
    writeRefs.some((ref) =>
      !writes.some((node) =>
        node.taskId === ref.taskId &&
        node.writeId === ref.writeId &&
        node.valueOrigin,
      ),
    );
  const hasConnectedSource = handleNodes.some(node => connectedFieldIds.includes(node.id));
  const originValues = [...origins.values()].filter(origin =>
    ![...origins.values()].some(other => other !== origin &&
      other.label.split("；").some(part => part === `部分分支：${origin.label}`)));
  const unresolved = originValues.some(origin => origin.kind === "UNRESOLVED");
  const mixed = originValues.filter(origin => origin.kind === "UNRESOLVED" && origin.expression);
  const labels = hasConnectedSource && unresolved
    ? ["部分来源已追到，另有来源未定位", ...originValues.filter(origin => origin.kind !== "UNRESOLVED").map(origin => origin.label)]
    : mixed.length
      ? [...new Set([...mixed, ...originValues.filter(origin => origin.kind !== "UNRESOLVED")].map(origin => origin.label))]
      : originValues.map(origin => `${partialOrigin && origin.kind !== "UNRESOLVED" && !origin.label.startsWith("部分分支：") ? "部分来源：" : ""}${origin.label}`);
  return (
    <button
      data-field-id={member.id}
      className={`field-row ${terminal ? "terminal" : ""}`}
      data-highlight={highlightActive ? (active ? "active" : "dimmed") : "none"}
      style={{
        position: "relative",
        opacity: highlightActive && !active ? 0.28 : 1,
        background: highlightActive && active ? "#d8f1e8" : undefined,
        boxShadow:
          highlightActive && active ? "inset 0 0 0 1px #26746d" : undefined,
      }}
      title={terminal?.reason ?? member.id}
      onClick={(event) => {
        event.stopPropagation();
        onFieldClick?.(member, terminal, {
          rawMembers: handleNodes,
          writeRefs,
          scope,
        });
      }}
    >
      {handleNodes.map((alias) => (
        <Handle
          key={`in:${alias.id}`}
          id={alias.id}
          type="target"
          position={Position.Left}
        />
      ))}
      <span className="field-row-copy">
        <b>{member.column ?? member.label ?? member.id}</b>
        {member.metadata?.field?.comment && (
          <small className="field-comment">
            {member.metadata.field.comment}
          </small>
        )}
        {labels.length > 0 && (
          <small
            className="value-origin-badge"
            data-kind={unresolved ? "UNRESOLVED" : originValues[0]?.kind}
            title={originValues.map(origin => origin.expression).filter(Boolean).join("\n")}
          >
            {[...new Set(labels)].join("；")}
          </small>
        )}
      </span>
      {terminal && <small>{terminalCopy(terminal)}</small>}
      {handleNodes.map((alias) => (
        <Handle
          key={`out:${alias.id}`}
          id={alias.id}
          type="source"
          position={Position.Right}
        />
      ))}
    </button>
  );
}

export const LineageNode = memo(function LineageNode(props: NodeProps) {
  const { data } = props;
  const updateNodeInternals = useUpdateNodeInternals();
  const fieldListRef = useRef<HTMLDivElement | null>(null);
  const nodeData = data as LineageNodeData;
  const reportHidden = nodeData.onHiddenFieldsChange;
  const pendingMeasure = useRef<number | undefined>(undefined);
  const lastGeometry = useRef("");
  const lastHidden = useRef("");
  const updateFieldViewport = useCallback(() => {
    const list = fieldListRef.current;
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    const scale = list.offsetHeight ? bounds.height / list.offsetHeight : 1;
    const hidden: string[] = [];
    const geometry = [list.clientWidth, list.clientHeight, list.scrollTop];
    for (const row of list.querySelectorAll<HTMLElement>(".field-row")) {
      const rect = row.getBoundingClientRect();
      geometry.push(Math.round((rect.top - bounds.top) / scale), Math.round(rect.height / scale));
      const visible = fieldHandleVisible(
        rect.top,
        rect.bottom,
        bounds.top,
        bounds.top + list.clientHeight * scale,
      );
      if (!visible) {
        for (const handle of row.querySelectorAll<HTMLElement>(
          ".react-flow__handle",
        )) {
          if (handle.dataset.handleid) hidden.push(handle.dataset.handleid);
        }
      }
    }
    const ids = [...new Set(hidden)].sort();
    const hiddenSignature = ids.join("|");
    if (lastHidden.current !== hiddenSignature) {
      lastHidden.current = hiddenSignature;
      reportHidden?.(props.id, ids);
    }
    const geometrySignature = geometry.join("|");
    if (lastGeometry.current !== geometrySignature) {
      lastGeometry.current = geometrySignature;
      updateNodeInternals(props.id);
    }
  }, [props.id, reportHidden, updateNodeInternals]);
  const scheduleFieldViewport = useCallback(() => {
    if (pendingMeasure.current !== undefined) return;
    pendingMeasure.current = requestAnimationFrame(() => {
      pendingMeasure.current = undefined;
      updateFieldViewport();
    });
  }, [updateFieldViewport]);
  useEffect(() => {
    lastGeometry.current = "";
    scheduleFieldViewport();
    const observer = new ResizeObserver(scheduleFieldViewport);
    if (fieldListRef.current) {
      observer.observe(fieldListRef.current);
      for (const row of fieldListRef.current.children) observer.observe(row);
    }
    return () => {
      if (pendingMeasure.current !== undefined) cancelAnimationFrame(pendingMeasure.current);
      pendingMeasure.current = undefined;
      observer.disconnect();
    };
  }, [scheduleFieldViewport, nodeData.members]);
  useEffect(() => () => { reportHidden?.(props.id, []); }, [reportHidden, props.id]);
  const activeSignature = nodeData.highlightActive
    ? JSON.stringify(nodeData.activeFieldIds ?? [])
    : "";
  useEffect(() => {
    const list = fieldListRef.current;
    if (!list || !activeSignature) return;
    const active = new Set<string>(JSON.parse(activeSignature));
    const row = [...list.querySelectorAll<HTMLElement>(".field-row")].find(
      (row) =>
        [...row.querySelectorAll<HTMLElement>(".react-flow__handle")].some(
          (handle) => active.has(handle.dataset.handleid ?? ""),
        ),
    );
    if (row) {
      const rowBounds = row.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      const scale = list.offsetHeight ? bounds.height / list.offsetHeight : 1;
      if (
        rowBounds.top < bounds.top ||
        rowBounds.bottom > bounds.top + list.clientHeight * scale
      )
        list.scrollTop +=
          (rowBounds.top - bounds.top) / scale -
          list.clientHeight / 2 +
          row.offsetHeight / 2;
    }
    scheduleFieldViewport();
  }, [activeSignature, scheduleFieldViewport]);
  const fieldAliases =
    (
      nodeData as LineageNodeData & {
        fieldAliases?: Record<string, GraphNode[]>;
      }
    ).fieldAliases ?? {};
  const fieldWriteRefs = nodeData.fieldWriteRefs ?? {};
  const { raw, members, terminal, memberTerminals = {}, isAnchor } = nodeData;
  if (raw?.kind === "TASK") return <TaskNode {...props} />;
  if (members?.length) {
    const first = members[0]!;
    return (
      <div
        className={`lineage-node grouped ${nodeData.compactRead ? "compact-read" : ""} ${isAnchor ? "anchor" : ""} ${Object.keys(memberTerminals).length ? "terminal" : ""}`}
        title={first.table}
      >
        <div className="node-topline"><span>物理表</span></div>
        <strong>{first.table ?? first.label ?? first.id}</strong>
        <SchemaDescription schema={first.metadata?.schema} />
        <TableDescription description={first.metadata?.table.description} />
        <small>
          {members.length} 个字段
          {" · 点击字段查看依据"}
        </small>
        <div
          className="field-rows"
          ref={fieldListRef}
          onScroll={scheduleFieldViewport}
        >
          {members.map((member) => (
            <FieldRow
              key={member.id}
              member={member}
              terminal={memberTerminals[member.id]}
              onFieldClick={nodeData.onFieldClick}
              highlightActive={nodeData.highlightActive}
              active={
                nodeData.activeFieldIds?.includes(member.id) ||
                (fieldAliases[member.id] ?? []).some((alias) =>
                  nodeData.activeFieldIds?.includes(alias.id),
                )
              }
              aliases={fieldAliases[member.id] ?? []}
              connectedFieldIds={nodeData.connectedFieldIds}
              scope={nodeData.scope}
              writeRefs={fieldWriteRefs[member.id] ?? nodeData.writeRefs ?? []}
            />
          ))}
        </div>
        {!!nodeData.candidateCount && nodeData.onExpandCandidates && (
          <button
            type="button"
            className="table-candidate-badge"
            aria-expanded={nodeData.candidatesExpanded}
            onClick={(event) => {
              event.stopPropagation();
              nodeData.onExpandCandidates?.();
            }}
          >
            候选生产任务 {nodeData.candidateCount} ·{" "}
            {nodeData.candidatesExpanded ? "收起" : "展开"}
          </button>
        )}
      </div>
    );
  }

  if (!raw) return null;
  if (raw.kind.includes("FIELD"))
    return (
      <div
        className={`lineage-node ${isAnchor ? "anchor" : ""} ${terminal ? "terminal" : ""}`}
      >
        <div className="node-topline">
          <span>{names[raw.kind] ?? raw.kind}</span>
        </div>
        <strong>{raw.table ?? raw.label ?? raw.id}</strong>
        <FieldRow
          member={raw}
          terminal={terminal}
          onFieldClick={nodeData.onFieldClick}
          highlightActive={nodeData.highlightActive}
          active={nodeData.activeFieldIds?.includes(raw.id)}
          aliases={fieldAliases[raw.id] ?? []}
          connectedFieldIds={nodeData.connectedFieldIds}
          scope={nodeData.scope}
          writeRefs={fieldWriteRefs[raw.id] ?? nodeData.writeRefs ?? []}
        />
      </div>
    );

  const title = raw.label || raw.table || raw.id;
  const context =
    raw.kind === "TASK"
      ? `任务 ${raw.taskId ?? raw.id.replace(/^task:/, "")}`
      : raw.table;
  return (
    <div
      className={`lineage-node ${isAnchor ? "anchor" : ""} ${terminal ? "terminal" : ""}`}
      title={raw.id}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-topline">
        <span>{names[raw.kind] ?? raw.kind}</span>
        {raw.writeId && <span>{raw.writeId}</span>}
      </div>
      <strong>{title}</strong>
      <SchemaDescription schema={raw.metadata?.schema} />
      <TableDescription description={raw.metadata?.table.description} />
      <small>{context}</small>
      {terminal && (
        <span className="terminal-copy">{terminalCopy(terminal)}</span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}, (previous, next) => previous.id === next.id && previous.data === next.data && previous.selected === next.selected);
