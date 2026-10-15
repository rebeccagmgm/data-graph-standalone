/** Query/display identity only; the published physical dataset remains unchanged. */
export interface TaskTableContext {
  taskNodeId: string;
  datasetId: string;
  role: "READ" | "WRITE";
}
const prefix = "task-table:";
export function taskTableId(context: TaskTableContext): string {
  return (
    prefix +
    encodeURIComponent(
      JSON.stringify([context.taskNodeId, context.datasetId, context.role]),
    )
  );
}
export function parseTaskTableId(id: string): TaskTableContext | undefined {
  if (!id.startsWith(prefix)) return undefined;
  try {
    const v: unknown = JSON.parse(decodeURIComponent(id.slice(prefix.length)));
    if (
      id.length > 4096 ||
      !Array.isArray(v) ||
      v.length !== 3 ||
      typeof v[0] !== "string" ||
      !/^task:[A-Za-z0-9_-]+$/.test(v[0]) ||
      typeof v[1] !== "string" ||
      !/^dataset:[A-Za-z0-9_-]+$/.test(v[1]) ||
      (v[2] !== "READ" && v[2] !== "WRITE")
    )
      throw new Error();
    const context: TaskTableContext = {
      taskNodeId: v[0],
      datasetId: v[1],
      role: v[2],
    };
    if (taskTableId(context) !== id) throw new Error();
    return context;
  } catch {
    throw new Error("TASK_TABLE_CONTEXT_INVALID");
  }
}
export function physicalTableNodeId(id: string): string {
  return parseTaskTableId(id)?.datasetId ?? id;
}
