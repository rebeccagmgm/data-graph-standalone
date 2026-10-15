import { statSync } from "node:fs";
import {
  readJson,
  type Evidence,
  type PreparedManifest,
} from "./evidence-json.ts";

type RecordValue = Record<string, unknown>;
export interface FieldValueOrigin {
  kind: "CONSTANT" | "EXPRESSION" | "UNRESOLVED";
  label: string;
  expression: string;
}
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export function expressionValueOrigin(
  expression?: RecordValue,
): FieldValueOrigin | undefined {
  if (!expression) return;
  if (
    expression.input_dependency_status === "SQL_CANDIDATE" &&
    Array.isArray(expression.input_fields) &&
    expression.input_fields.length === 0 &&
    Array.isArray(expression.candidate_input_fields) &&
    expression.candidate_input_fields.length > 0
  ) {
    const source =
      text(expression.expression_text) || text(expression.display_text);
    if (source)
      return {
        kind: "UNRESOLVED",
        label: "来源待确认（候选字段输入）",
        expression: source,
      };
  }
  if (expression.input_dependency_status !== "NO_PHYSICAL_INPUT") return;
  // Absence of visible graph edges is never evidence of a constant.
  for (const key of [
    "input_fields",
    "candidate_input_fields",
    "unresolved_input_columns",
  ])
    if (!Array.isArray(expression[key]) || expression[key].length) return;
  const source =
    text(expression.expression_text) || text(expression.display_text);
  if (!source) return;
  let value = text(expression.display_text) || source;
  const output = text(expression.output_name);
  if (output) {
    const aliases = [
      output,
      `"${output.replaceAll('"', '""')}"`,
      `\`${output.replaceAll("\`", "\`\`")}\``,
    ];
    for (const alias of aliases) {
      const suffix = ` AS ${alias}`;
      if (value.toLowerCase().endsWith(suffix.toLowerCase())) {
        value = value.slice(0, -suffix.length).trim();
        break;
      }
    }
  }
  // Conservative literal display, not SQL evaluation. Functions and casts
  // retain the more general expression-generated reason.
  const literal =
    /^(?:NULL|TRUE|FALSE|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|'(?:[^'\\]|''|\\.)*')$/is.test(
      value,
    );
  const runtimeTemplate = /\$\{|#\{|\{\{/.test(value);
  if (runtimeTemplate && literal)
    return {
      kind: "EXPRESSION",
      label: `参数赋值：${value.slice(1, -1)}`,
      expression: source,
    };
  return literal && !runtimeTemplate
    ? {
        kind: "CONSTANT",
        label: `常量：${value === "''" ? "空字符串" : value}`,
        expression: source,
      }
    : {
        kind: "EXPRESSION",
        label: "表达式生成（无物理字段输入）",
        expression: source,
      };
}

export function bindingKey(writeId: unknown, column: unknown): string {
  return JSON.stringify([text(writeId), text(column).toLowerCase()]);
}
export function evidenceOrigins(
  evidence: Evidence,
): Map<string, FieldValueOrigin> {
  const expressions = new Map(
    evidence.expressions.map((e) => [e.expression_id, e]),
  );
  const relations = new Map(
    (evidence.relations ?? []).map((r) => [
      r.relation_id,
      r.relation as RecordValue,
    ]),
  );
  const bindings = new Map(evidence.bindings.map((b) => [b.binding_id, b]));
  const physicalInput = (expr: RecordValue, input: RecordValue, unchanged = false): string => {
    const table = text(input.table).toLowerCase();
    if (table.includes(".") && !unchanged) return table;
    // Resolve an unqualified name only through this expression's own read
    // occurrence and the published IO identity, never a task-wide name match.
    const pending = [expr.relation_id];
    const seen = new Set<unknown>();
    const matches: RecordValue[] = [];
    while (pending.length && seen.size < 64) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const relation = relations.get(id);
      if (!relation) return "";
      if (relation.type === "read") {
        const readTable = text(relation.table).toLowerCase();
        if (readTable !== table && readTable !== table.split(".").at(-1)) continue;
        const ioMatches = (evidence.datasetIo ?? []).filter(io =>
          io.direction === "READ" && io.resolution_status === "RESOLVED" &&
          io.statement_id === expr.statement_id && Array.isArray(io.read_occurrences) &&
          io.read_occurrences.some(r => (r as RecordValue).occurrence_id === relation.read_occurrence_id));
        if (ioMatches.length !== 1) return "";
        if (table.includes(".") && text(ioMatches[0]!.physical_dataset).toLowerCase() !== table) return "";
        matches.push(ioMatches[0]!);
      } else if (relation.type === "join") {
        pending.push(relation.left, relation.right);
      } else if (relation.type === "project" || relation.type === "filter") {
        if (unchanged && relation.type === "project" && id !== expr.relation_id) {
          const projected = at(id, undefined, text(input.column));
          if (!projected || !/^(?:[a-z_][\w$]*\.)?[a-z_][\w$]*(?:\s+AS\s+[a-z_][\w$]*)?$/i.test(
            text(projected.display_text) || text(projected.expression_text))) return "";
        }
        pending.push(relation.source);
      } else return "";
    }
    return !pending.length && matches.length === 1 ? text(matches[0]!.physical_dataset).toLowerCase() : "";
  };
  const unknown: FieldValueOrigin = {
    kind: "UNRESOLVED",
    label: "字段来源未定位，追溯到此停止",
    expression: "",
  };
  const branches = new WeakMap<FieldValueOrigin, FieldValueOrigin[]>();
  const fieldSource: FieldValueOrigin = { kind: "EXPRESSION", label: "", expression: "" };
  const merge = (values: FieldValueOrigin[]): FieldValueOrigin => {
    const leaves = values.flatMap((v) => branches.get(v) ?? [v]);
    const unique = [
      ...new Map(
        leaves.map((v) => [JSON.stringify([v.kind, v.label]), v]),
      ).values(),
    ];
    if (unique.length === 1) return unique[0]!;
    const known = unique.filter((v) => v.kind !== "UNRESOLVED");
    const unresolved = unique.some((v) => v.kind === "UNRESOLVED");
    const merged: FieldValueOrigin = {
      kind: unresolved ? "UNRESOLVED" : "EXPRESSION",
      label: [
        ...known.filter(v => v.label).map((v) => `部分分支：${v.label}`),
        ...(unresolved ? ["其余字段来源未定位，追溯停止"] : []),
      ].join("；"),
      expression: unique
        .map((v) => v.expression)
        .filter(Boolean)
        .join("\n"),
    };
    branches.set(merged, unique);
    return merged;
  };
  const at = (
    relationId: unknown,
    ordinal: unknown,
    name?: string,
  ): RecordValue | undefined => {
    const matches = evidence.expressions.filter(
      (e) =>
        e.relation_id === relationId &&
        (name !== undefined
          ? text(e.output_name).toLowerCase() === name.toLowerCase()
          : e.ordinal === ordinal),
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  // Follow only explicit relation links and resolved same-task materializations.
  // Never search the whole task for a matching column or infer from an absent edge.
  let remaining = 0;
  let targetDataset = "";
  let targetColumn = "";
  const resolve = (
    expr: RecordValue | undefined,
    seen: Set<unknown>,
  ): FieldValueOrigin => {
    if (
      !expr ||
      remaining-- <= 0 ||
      seen.has(expr.expression_id) ||
      seen.size >= 64
    )
      return unknown;
    const next = new Set(seen).add(expr.expression_id);
    const relation = relations.get(expr.relation_id);
    if (expr.role === "SETOP_OUTPUT") {
      if (
        relation?.setop !== "union" ||
        !Array.isArray(relation.branches) ||
        !relation.branches.length
      )
        return unknown;
      return merge(
        relation.branches.map((id) => resolve(at(id, expr.ordinal), next)),
      );
    }
    const direct = expressionValueOrigin(expr);
    if (direct) return direct;
    const source = text(expr.display_text) || text(expr.expression_text);
    // Only a plain column pass-through can inherit its input's value unchanged.
    const column = source.match(
      /^(?:[a-z_][\w$]*\.)?([a-z_][\w$]*)(?:\s+AS\s+[a-z_][\w$]*)?$/i,
    )?.[1];
    if (!column) return unknown;
    if (expr.input_dependency_status === "DERIVED_OUTPUT" && relation?.source) {
      return resolve(at(relation.source, undefined, column), next);
    }
    const inputs = expr.input_fields;
    if (
      expr.input_dependency_status !== "PHYSICAL" ||
      !Array.isArray(inputs) ||
      inputs.length !== 1
    )
      return unknown;
    const input = inputs[0] as RecordValue;
    const inputTable = physicalInput(expr, input);
    // A same-name table read alone is insufficient: the expression must be an
    // unchanged, fully resolved read of the exact target column. Follow any
    // explicit earlier write first so calculated intermediate values stay visible.
    const bridges = (evidence.materializations ?? []).filter(
      (m) =>
        m.status === "RESOLVED" &&
        Array.isArray(m.read_expression_ids) &&
        m.read_expression_ids.includes(expr.expression_id) &&
        text(m.column).toLowerCase() === text(input.column).toLowerCase() &&
        text(m.physical_dataset).toLowerCase() ===
          inputTable,
    );
    if (bridges.length === 0 && targetDataset && targetColumn &&
        inputTable === targetDataset && physicalInput(expr, input, true) === targetDataset &&
        text(input.column).toLowerCase() === targetColumn &&
        column.toLowerCase() === targetColumn &&
        Array.isArray(expr.candidate_input_fields) && expr.candidate_input_fields.length === 0 &&
        Array.isArray(expr.unresolved_input_columns) && expr.unresolved_input_columns.length === 0 &&
        !(evidence.materializations ?? []).some(m =>
          Array.isArray(m.read_expression_ids) && m.read_expression_ids.includes(expr.expression_id))) {
      return { kind: "EXPRESSION", label: "沿用本表原值", expression: source };
    }
    if (bridges.length === 0 && inputTable &&
        (evidence.datasetIo ?? []).some(io => io.direction === "READ" &&
          io.resolution_status === "RESOLVED" && text(io.physical_dataset).toLowerCase() === inputTable) &&
        !(evidence.datasetIo ?? []).some(io => io.direction === "WRITE" &&
          text(io.physical_dataset).toLowerCase() === inputTable) &&
        !(evidence.materializations ?? []).some(m => Array.isArray(m.read_expression_ids) &&
          m.read_expression_ids.includes(expr.expression_id))) return fieldSource;
    if (bridges.length !== 1) return unknown;
    const binding = bindings.get(bridges[0]!.output_binding_id);
    return binding?.binding_status === "RESOLVED"
      ? resolve(expressions.get(binding.expression_id), next)
      : unknown;
  };
  const counts = new Map<string, number>();
  const result = new Map<string, FieldValueOrigin>();
  for (const binding of evidence.bindings) {
    const key = bindingKey(binding.write_observation_id, binding.target_field);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (
      binding.binding_status !== "RESOLVED" ||
      !text(binding.write_observation_id) ||
      !text(binding.target_field)
    )
      continue;
    remaining = 512;
    targetDataset = text(binding.target_dataset).toLowerCase();
    targetColumn = text(binding.target_field).toLowerCase();
    const origin = resolve(expressions.get(binding.expression_id), new Set());
    // Unknown labels are attached only to stopped trace fields, not every field.
    if (origin !== unknown && origin !== fieldSource && origin.label) result.set(key, origin);
  }
  for (const [key, count] of counts) if (count !== 1) result.delete(key);
  return result;
}

/** Optional display metadata from the exact evidence snapshot published with the graph. */
export class PublishedFieldOrigins {
  private manifestSignature = "";
  private tasks = new Map<string, string>();
  private cache = new Map<
    string,
    { signature: string; origins: Map<string, FieldValueOrigin> }
  >();

  annotate(
    nodes: readonly RecordValue[],
    manifestPath: string,
    stoppedNodeIds: ReadonlySet<string> = new Set(),
  ): RecordValue[] {
    try {
      const stat = statSync(manifestPath);
      const signature = `${manifestPath}:${stat.size}:${stat.mtimeMs}`;
      if (signature !== this.manifestSignature) {
        const manifest = readJson<PreparedManifest>(manifestPath);
        this.tasks = new Map(
          manifest.tasks.map((task) => [task.taskId, task.evidencePath]),
        );
        this.cache.clear();
        this.manifestSignature = signature;
      }
    } catch {
      return [...nodes];
    }
    const loaded = new Map<string, Map<string, FieldValueOrigin>>();
    return nodes.map((node) => {
      if (node.kind !== "WRITE_FIELD") return node;
      const taskId = text(node.taskId),
        path = this.tasks.get(taskId);
      if (!path) return node;
      try {
        if (!loaded.has(taskId)) {
          const stat = statSync(path),
            signature = `${stat.size}:${stat.mtimeMs}`;
          let cached = this.cache.get(path);
          if (!cached || cached.signature !== signature) {
            cached = {
              signature,
              origins: evidenceOrigins(readJson<Evidence>(path)),
            };
            if (this.cache.size >= 64)
              this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(path, cached);
          }
          loaded.set(taskId, cached.origins);
        }
        const origin = loaded
          .get(taskId)!
          .get(bindingKey(node.writeId, node.column));
        if (origin) return { ...node, valueOrigin: origin };
        return stoppedNodeIds.has(text(node.id))
          ? {
              ...node,
              valueOrigin: {
                kind: "UNRESOLVED",
                label: "字段来源未定位，追溯到此停止",
                expression: "",
              },
            }
          : node;
      } catch {
        return node;
      }
    });
  }
}
