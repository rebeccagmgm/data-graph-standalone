import type { TaskFieldExplanation, TaskProcessingStage } from "../types";

/** Presentation slice of recorded field dependencies; never infers a SQL relationship. */
export function valuePresentation(explanation: TaskFieldExplanation) {
  const stages = new Map(explanation.stages.map(stage => [stage.id, stage]));
  const anchor = explanation.stages.find(stage => stage.kind === "WRITE" && stage.writeId === explanation.anchor.writeId);
  const columns = new Map<string, Set<string>>();
  const edgeIds = new Set<string>();
  const pending: Array<[string, string]> = anchor ? [[anchor.id, explanation.anchor.column.toLowerCase()]] : [];
  for (let i = 0; i < pending.length; i++) {
    const [id, column] = pending[i]!;
    const seen = columns.get(id) ?? new Set<string>();
    if (seen.has(column)) continue;
    seen.add(column);
    columns.set(id, seen);
    const stage = stages.get(id);
    for (const edge of explanation.edges) {
      if (edge.to !== id || !["VALUE", "MATERIALIZATION"].includes(edge.kind)) continue;
      const expressions = stage?.expressions.filter(expression => edge.expressionIds?.includes(expression.id)) ?? [];
      // A known expression for a different output belongs to another field's chain.
      if (column !== "*" && expressions.length && !expressions.some(expression => expression.column.toLowerCase() === column)) continue;
      edgeIds.add(edge.id);
      const inputs = edge.columns?.length ? edge.columns : ["*"];
      for (const input of inputs) pending.push([edge.from, input.toLowerCase()]);
    }
  }
  return {
    stages: explanation.stages.filter(stage => columns.has(stage.id)),
    edges: explanation.edges.filter(edge => edgeIds.has(edge.id)),
    columns,
  };
}

export function visibleExpressions(stage: TaskProcessingStage, columns?: Set<string>) {
  return stage.expressions.filter(expression => !columns || columns.has("*") || columns.has(expression.column.toLowerCase()));
}

export function operationLabel(text: string) {
  const value = text.trim().replace(/\s+as\s+[`"\w]+\s*$/i, "").trim();
  if (/^('[^']*'|[-+]?\d+(\.\d+)?|null|true|false)$/i.test(value)) return "固定值或参数";
  if (/^(?:[`"\w]+\.)?[`"a-z_]\w*[`"]?$/i.test(value)) return "原值传递";
  if (/^concat\s*\(/i.test(value)) return "拼接";
  if (/^case\b/i.test(value)) return "按条件取值";
  if (/^(coalesce|nvl|ifnull)\s*\(/i.test(value)) return "空值回退";
  if (/^union_output\s*\(/i.test(value)) return "合并分支取值";
  return "表达式取值";
}

export function writeLabel(stage: TaskProcessingStage) {
  return stage.statementIndex === undefined ? "写入步骤（序号未收录）" : `第 ${stage.statementIndex + 1} 条 SQL 写入`;
}

export function gapLabel(gap: TaskFieldExplanation["gaps"][number]) {
  if (gap.code === "CONTROL_SIDE_UNRESOLVED") return "关联或过滤条件的部分字段来源尚未确认";
  if (/^(task:|\[|write-observation:)/.test(gap.message)) return "部分加工依据尚未确认，展开技术详情查看原始记录";
  return gap.message;
}
