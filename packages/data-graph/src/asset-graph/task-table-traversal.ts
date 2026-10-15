import {
  parseTaskTableId,
  taskTableId,
  type TaskTableContext,
} from "./task-table-context.ts";

export interface TableNode extends Record<string, unknown> {
  id: string;
  kind: string;
  detail?: Record<string, unknown>;
}
export interface TableEdge extends Record<string, unknown> {
  id: string;
  from: string;
  to: string;
  kind: string;
  detail?: Record<string, unknown>;
}
type Direction = "up" | "down";
export interface TableTraversalReader {
  node(id: string): Promise<TableNode | undefined>;
  /** Filter allowed task IDs before LIMIT, so unrelated public-table readers cannot crowd out valid edges. */
  adjacent(
    id: string,
    direction: Direction,
    layer: "table" | "schedule",
    limit: number,
    allowedTaskIds?: string[],
  ): Promise<Array<{ node: TableNode; edge: TableEdge }>>;
}

/** Task navigation constrained at every table crossing; schedule edges never become data edges. */
export async function traverseTaskTables(
  reader: TableTraversalReader,
  input: {
    nodeId: string;
    direction: Direction;
    depth: number;
    depthUnit?: "edge" | "table-hop";
    limit: number;
    includeCandidates: boolean;
  },
) {
  const nodes = new Map<string, TableNode>();
  const edges = new Map<string, TableEdge>();
  const frontier = new Set<string>();
  const terminals = new Map<
    string,
    { nodeId: string; role: string; reason: string; ruleRef: string }
  >();
  const schedules = new Map<string, string[]>();
  const scheduleReferences: Array<{
    taskId: string;
    direction: Direction;
    neighborTaskIds: string[];
  }> = [];
  const neighbors = async (id: string) => {
    if (!schedules.has(id)) {
      const rows = await reader.adjacent(id, input.direction, "schedule", 1001);
      if (rows.length > 1000) throw new Error("TASK_SCHEDULE_NEIGHBOR_LIMIT");
      const ids = [
        ...new Set(
          rows.filter((r) => r.node.kind === "TASK").map((r) => r.node.id),
        ),
      ];
      schedules.set(id, ids);
      scheduleReferences.push({
        taskId: id.replace(/^task:/, ""),
        direction: input.direction,
        neighborTaskIds: ids.map((value) => value.replace(/^task:/, "")),
      });
    }
    return schedules.get(id)!;
  };
  const contextual = (
    node: TableNode,
    context: TaskTableContext,
  ): TableNode => ({
    ...node,
    id: taskTableId(context),
    physicalNodeId: node.id,
    detail: { ...node.detail, taskTableContext: context },
  });
  const startContext = parseTaskTableId(input.nodeId);
  const rawStart = await reader.node(startContext?.datasetId ?? input.nodeId);
  if (!rawStart) throw new Error("TASK_TABLE_ANCHOR_MISSING");
  if (startContext) {
    // A persisted context is a reference, not permission to invent a task/table attachment.
    const attached = await reader.adjacent(
      startContext.datasetId,
      startContext.role === "WRITE" ? "up" : "down",
      "table",
      1,
      [startContext.taskNodeId],
    );
    if (!attached.length || rawStart.kind !== "PHYSICAL_DATASET")
      throw new Error("TASK_TABLE_CONTEXT_MISSING");
  } else if (rawStart.kind !== "TASK")
    throw new Error("TASK_TABLE_ANCHOR_INVALID");
  const start = startContext ? contextual(rawStart, startContext) : rawStart;
  nodes.set(start.id, { ...start, depth: 0, lineageDepth: 0 });
  const queue = [{ node: start, depth: 0, cost: 0 }];
  const visited = new Set<string>();
  let truncated = false;
  const stop = (node: TableNode) => {
    if (input.direction !== "up") return false;
    const d = node.detail ?? {};
    if (
      d.continuationDisposition !== "SOURCE_ENDPOINT_BOUNDARY" &&
      !(
        d.continuationDisposition === "POLICY_TERMINAL" &&
        d.boundaryRole === "REFERENCE_CONFIG"
      )
    )
      return false;
    terminals.set(node.id, {
      nodeId: node.id,
      role: String(d.boundaryRole ?? ""),
      reason: String(d.terminalReason ?? "已到发布图谱的源端或参数边界"),
      ruleRef: String(d.terminalRuleRef ?? "PUBLISHED_BOUNDARY"),
    });
    return true;
  };
  while (queue.length && !truncated) {
    const current = queue.shift()!;
    if (visited.has(current.node.id)) continue;
    visited.add(current.node.id);
    if (stop(current.node)) continue;
    if (current.cost >= input.depth) {
      frontier.add(current.node.id);
      continue;
    }
    const context = parseTaskTableId(current.node.id);
    let allowed: string[] | undefined;
    if (context) {
      const crosses =
        (context.role === "WRITE") === (input.direction === "down");
      allowed = crosses
        ? await neighbors(context.taskNodeId)
        : [context.taskNodeId];
      if (!allowed.length) continue;
    } else await neighbors(current.node.id);
    const rows = await reader.adjacent(
      context?.datasetId ?? current.node.id,
      input.direction,
      "table",
      input.limit + 1,
      allowed,
    );
    for (const row of rows) {
      if (
        !input.includeCandidates &&
        (row.edge.status === "CANDIDATE" || row.edge.kind === "CANDIDATE")
      )
        continue;
      if (row.edge.detail?.partitionMatchStatus === "DISJOINT") continue;
      const expectedKind = context
        ? input.direction === "down"
          ? "READS_TABLE"
          : "WRITES_TABLE"
        : input.direction === "down"
          ? "WRITES_TABLE"
          : "READS_TABLE";
      if (
        row.edge.kind !== expectedKind ||
        row.node.kind !== (context ? "TASK" : "PHYSICAL_DATASET")
      )
        continue;
      const next = context
        ? row.node
        : contextual(row.node, {
            taskNodeId: current.node.id,
            datasetId: row.node.id,
            role: input.direction === "down" ? "WRITE" : "READ",
          });
      const from = input.direction === "down" ? current.node.id : next.id;
      const to = input.direction === "down" ? next.id : current.node.id;
      const id = JSON.stringify([row.edge.id, from, to]);
      if (!edges.has(id) && edges.size >= input.limit) {
        truncated = true;
        frontier.add(current.node.id);
        break;
      }
      edges.set(id, {
        ...row.edge,
        id,
        from,
        to,
        detail: { ...row.edge.detail, physicalEdgeId: row.edge.id },
      });
      const cost =
        current.cost +
        (input.depthUnit === "table-hop" ? (context ? 0 : 1) : 1);
      if (!nodes.has(next.id)) {
        nodes.set(next.id, {
          ...next,
          depth: current.depth + 1,
          lineageDepth: cost,
        });
        queue.push({ node: next, depth: current.depth + 1, cost });
      }
    }
    if (rows.length > input.limit) {
      truncated = true;
      frontier.add(current.node.id);
    }
  }
  if (truncated) for (const item of queue) frontier.add(item.node.id);
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    frontierNodeIds: [...frontier],
    terminalNodes: [...terminals.values()],
    scheduleReferences,
    traversalScope: "TASK_SCHEDULE" as const,
    truncated,
    stoppedBy: truncated
      ? ("EDGE_LIMIT" as const)
      : frontier.size
        ? ("DEPTH_LIMIT" as const)
        : null,
  };
}
