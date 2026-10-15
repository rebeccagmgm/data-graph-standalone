import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { memo, useEffect } from "react";
import type { LineageNodeData } from "../graph-adapter";

export interface TaskPort {
  id: string;
  label: string;
  direction: "input" | "output";
  fieldNodeId: string;
}

export type TaskNodeData = LineageNodeData & {
  taskPorts?: TaskPort[];
  candidateCount?: number;
  candidatesExpanded?: boolean;
  onExpandCandidates?: () => void;
};

export const TaskNode = memo(function TaskNode({ id, data: rawData }: NodeProps) {
  const data = rawData as TaskNodeData;
  const taskId = data.raw?.taskId ?? data.raw?.id.replace(/^task:/, "") ?? "—";
  const taskName =
    (typeof data.raw?.detail?.taskName === "string" &&
      data.raw.detail.taskName.trim()) ||
    undefined;
  const cluster = typeof data.raw?.detail?.cluster === "string" ? data.raw.detail.cluster.trim() : "";
  const ports = data.taskPorts ?? [];
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignature = JSON.stringify(ports.map(port => [port.id, port.direction]));
  useEffect(() => { updateNodeInternals(id); }, [id, portSignature, updateNodeInternals]);
  const topicName =
    (typeof data.raw?.detail?.topicName === "string" &&
      data.raw.detail.topicName.trim()) ||
    "未收录";
  const topicDescription =
    (typeof data.raw?.detail?.topicDescription === "string" &&
      data.raw.detail.topicDescription.trim()) || undefined;
  const topicDisplay = topicDescription ? `${topicDescription}（${topicName}）` : topicName;
  const inputs = ports.filter((port) => port.direction === "input");
  const outputs = ports.filter((port) => port.direction === "output");
  const handles = (
    items: TaskPort[],
    type: "target" | "source",
    position: Position,
  ) =>
    items.map((port, index) => (
      <Handle
        key={port.id}
        id={port.id}
        type={type}
        position={position}
        title={`${port.direction === "input" ? "输入" : "输出"} · ${port.label}`}
        style={{
          top: `${24 + ((index + 1) / (items.length + 1)) * 56}%`,
          opacity: data.highlightActive && !data.activeFieldIds?.includes(port.fieldNodeId) ? 0.14 : 1,
        }}
      />
    ));
  return (
    <div
      className={`task-node ${data.isAnchor ? "anchor" : ""}`}
      title={`${taskName ? `${taskName} · ` : ""}调度任务 ${taskId} · ${Math.max(inputs.length, outputs.length)} 条字段映射 · 点击查看加工依据`}
    >
      {ports.length ? (
        handles(inputs, "target", Position.Left)
      ) : (
        <Handle type="target" position={Position.Left} />
      )}
      <strong>调度 {taskId}</strong>
      <small className="task-node-cluster">集群：{cluster || "未收录"}</small>
      {taskName && <small className="task-node-name">{taskName}</small>}
      <small className="task-node-topic" title={`调度主题：${topicDisplay}`}>
        调度主题：{topicDisplay}
      </small>
      {data.candidateCount ? (
        <button
          className="task-candidate-badge"
          type="button"
          disabled={!data.onExpandCandidates}
          onClick={(event) => {
            event.stopPropagation();
            data.onExpandCandidates?.();
          }}
        >
          候选来源 {data.candidateCount} ·{" "}
          {data.candidatesExpanded ? "收起" : "展开"}
        </button>
      ) : null}
      {ports.length ? (
        handles(outputs, "source", Position.Right)
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}, (previous, next) => previous.id === next.id && previous.data === next.data && previous.selected === next.selected);
