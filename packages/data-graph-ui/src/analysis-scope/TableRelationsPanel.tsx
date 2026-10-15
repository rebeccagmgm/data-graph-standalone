import { tableRelationRecords } from "../table-relations";
import type { GraphEdge, GraphNode } from "../types";
import "./table-relations.css";

const evidenceKeys = [
  "writeObservationId",
  "readOccurrenceId",
  "partition",
  "partitionStatus",
  "partitionPredicates",
  "partitionPredicateStatus",
  "partitionMatchStatus",
  "outputQualification",
  "continuationDisposition",
  "terminalReason",
] as const;

/** Display existing IO evidence only; selecting a write reuses task inspection. */
export function TableRelationsPanel({
  edges,
  nodes,
  onInspect,
}: {
  edges: GraphEdge[];
  nodes: GraphNode[];
  onInspect: (node: GraphNode) => void;
}) {
  const records = tableRelationRecords(edges);
  return (
    <section className="table-relations" aria-label="范围内读写记录">
      <h3>范围内读写记录（{records.length}）</h3>
      {records.map((edge, index) => {
        const writes = edge.kind === "WRITES_TABLE";
        const taskNodeId = writes ? edge.from : edge.to;
        const taskId = taskNodeId.startsWith("task:")
          ? taskNodeId.slice(5)
          : undefined;
        const table = nodes.find(
          (node) => node.id === (writes ? edge.to : edge.from),
        );
        const detail = edge.detail ?? {};
        const writeId =
          typeof detail.writeObservationId === "string"
            ? detail.writeObservationId
            : undefined;
        const occurrenceId = writes ? writeId : detail.readOccurrenceId;
        const evidence = Object.fromEntries(
          evidenceKeys
            .filter((key) => detail[key] !== undefined)
            .map((key) => [key, detail[key]]),
        );
        const status =
          edge.status === "CANDIDATE"
            ? "候选"
            : edge.status === "CONFIRMED"
              ? "已确认读写关系"
              : edge.status === "OBSERVED"
                ? "已记录"
                : (edge.status ?? "状态未收录");
        return (
          <section
            className="table-relation-record"
            key={`${edge.id ?? edge.key ?? "relation"}:${index}`}
          >
            <b>
              {writes ? "写入" : "读取"} · 调度 {taskId ?? "未收录"}
            </b>
            <p>{table?.table}</p>
            <p className="muted">{status}</p>
            {typeof occurrenceId === "string" && (
              <code className="identity">{occurrenceId}</code>
            )}
            {!detail.partition && !detail.partitionPredicates && (
              <p className="muted">本次关系未返回分区条件。</p>
            )}
            {Object.keys(evidence).length > 0 && (
              <details>
                <summary>查看此记录的依据</summary>
                <pre>{JSON.stringify(evidence, null, 2)}</pre>
              </details>
            )}
            <button
              disabled={!taskId || (writes && !writeId)}
              onClick={() => {
                if (!taskId || (writes && !writeId)) return;
                onInspect({
                  ...(nodes.find((node) => node.id === taskNodeId) ?? {
                    id: taskNodeId,
                    kind: "TASK",
                    taskId,
                  }),
                  writeId: writes ? writeId : undefined,
                });
              }}
            >
              {writes ? "查看此写入加工" : "查看读取任务"}
            </button>
          </section>
        );
      })}
    </section>
  );
}
