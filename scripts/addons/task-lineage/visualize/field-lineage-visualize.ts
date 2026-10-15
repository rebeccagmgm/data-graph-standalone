import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonlRecords } from "../../../machine-facts/jsonl-store.ts";
import {
  validateFieldLineageArtifact,
  type FieldLineageArtifact,
  type FieldLineageEdge,
  type FieldLineageNode,
} from "../reconcile/consumer/field-lineage/field-lineage-contract.ts";

type FieldLineageVisualizationArtifact = Omit<
  FieldLineageArtifact,
  "schemaVersion" | "request"
> & {
  readonly schemaVersion: string;
  readonly request: Omit<
    FieldLineageArtifact["request"],
    "rootWriteObservationIds"
  > & {
    readonly rootWriteObservationIds?: readonly string[];
  };
};

export interface FieldLineageImpactTask {
  readonly taskId: string;
  readonly taskName: string | null;
  readonly fieldCount: number;
}

export interface FieldLineageImpactEdge {
  readonly fromTaskId: string;
  readonly toTaskId: string;
}

export interface FieldLineageImpactGraph {
  readonly fieldCount: number;
  readonly unresolvedFieldCount: number;
  readonly tasks: readonly FieldLineageImpactTask[];
  readonly edges: readonly FieldLineageImpactEdge[];
  readonly truncated: boolean;
}

export interface FieldLineageCodeFlowStep {
  readonly stepId: string;
  readonly taskId: string;
  readonly taskName: string | null;
  readonly stage: string;
  readonly title: string;
  readonly relationType: string | null;
  readonly relationId: string | null;
  readonly statementId: string | null;
  readonly sourceSpan: { readonly start: number; readonly end: number } | null;
  readonly sourceText: string;
  readonly evidenceMode: "FACTS_BACKED" | "EXPRESSION_ONLY";
  /** Fields explicitly projected or read by this facts-backed step. */
  readonly inputFields: readonly string[];
  readonly outputFields: readonly string[];
  readonly relationObject: string | null;
}

export interface FieldLineageCodeFlowField {
  readonly stepIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly status: "FACTS_BACKED" | "EXPRESSION_ONLY" | "UNAVAILABLE";
  readonly note: string;
}

export interface FieldLineageCodeFlowData {
  readonly steps: readonly FieldLineageCodeFlowStep[];
  readonly fields: Readonly<Record<string, FieldLineageCodeFlowField>>;
  readonly factsTasks: readonly string[];
  readonly missingTasks: readonly string[];
}

function impactFieldName(node: FieldLineageNode): string {
  return `${node.field.qualifiedName}.${node.field.column}`;
}

function effectiveNode(node: FieldLineageNode | undefined): node is FieldLineageNode {
  return node !== undefined && node.evidenceStatus !== "UNRESOLVED";
}

export function buildFieldLineageImpactGraph(
  artifact: FieldLineageVisualizationArtifact,
): FieldLineageImpactGraph {
  const nodeById = new Map(artifact.nodes.map((node) => [node.nodeId, node]));
  const incomingByNode = new Map<string, FieldLineageEdge[]>();
  artifact.edges.forEach((edge) => {
    const incoming = incomingByNode.get(edge.toNodeId) ?? [];
    incoming.push(edge);
    incomingByNode.set(edge.toNodeId, incoming);
  });

  const fieldsByNode = new Map<string, Set<string>>();
  const reachableEdgeIds = new Set<string>();
  const requestedFields = new Set(artifact.request.rootFields);
  const rootNodes = artifact.rootNodeIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is FieldLineageNode =>
      effectiveNode(node) && requestedFields.has(node.field.column),
    );

  for (const root of rootNodes) {
    const fieldName = impactFieldName(root);
    const seen = new Set<string>();
    const queue = [root.nodeId];
    while (queue.length > 0) {
      const nodeId = queue.pop();
      if (!nodeId || seen.has(nodeId)) continue;
      const node = nodeById.get(nodeId);
      if (!effectiveNode(node)) continue;
      seen.add(nodeId);
      const nodeFields = fieldsByNode.get(nodeId) ?? new Set<string>();
      nodeFields.add(fieldName);
      fieldsByNode.set(nodeId, nodeFields);

      for (const edge of incomingByNode.get(nodeId) ?? []) {
        if (edge.evidenceStatus === "UNRESOLVED") continue;
        const parent = nodeById.get(edge.fromNodeId);
        if (!effectiveNode(parent)) continue;
        reachableEdgeIds.add(edge.edgeId);
        if (!seen.has(edge.fromNodeId)) queue.push(edge.fromNodeId);
      }
    }
  }

  const taskMap = new Map<
    string,
    {
      taskId: string;
      taskName: string | null;
      fieldNames: Set<string>;
    }
  >();
  for (const [nodeId, fieldNames] of fieldsByNode) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const task =
      taskMap.get(node.taskId) ??
      {
        taskId: node.taskId,
        taskName: node.taskName,
        fieldNames: new Set<string>(),
      };
    if (!task.taskName && node.taskName) task.taskName = node.taskName;
    fieldNames.forEach((fieldName) => task.fieldNames.add(fieldName));
    taskMap.set(node.taskId, task);
  }

  const edgeMap = new Map<
    string,
    { fromTaskId: string; toTaskId: string }
  >();
  for (const edge of artifact.edges) {
    if (!reachableEdgeIds.has(edge.edgeId)) continue;
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    if (!from || !to || from.taskId === to.taskId) continue;
    const key = `${from.taskId}|${to.taskId}`;
    const taskEdge =
      edgeMap.get(key) ??
      { fromTaskId: from.taskId, toTaskId: to.taskId };
    edgeMap.set(key, taskEdge);
  }

  const fieldNames = new Set(
    [...fieldsByNode.values()].flatMap((items) => [...items]),
  );
  const tasks = [...taskMap.values()]
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
    .map((task) => ({
      taskId: task.taskId,
      taskName: task.taskName,
      fieldCount: task.fieldNames.size,
    }));
  const edges = [...edgeMap.values()]
    .sort((left, right) =>
      `${left.fromTaskId}|${left.toTaskId}`.localeCompare(`${right.fromTaskId}|${right.toTaskId}`),
    )
    .map((edge) => ({
      fromTaskId: edge.fromTaskId,
      toTaskId: edge.toTaskId,
    }));
  return {
    fieldCount: fieldNames.size,
    unresolvedFieldCount: [...requestedFields].filter(
      (field) => ![...fieldNames].some((name) => name.endsWith(`.${field}`)),
    ).length,
    tasks,
    edges,
    truncated: artifact.limits.truncated,
  };
}

export function renderFieldLineageImpactTree(
  graph: FieldLineageImpactGraph,
): string {
  const taskById = new Map(graph.tasks.map((task) => [task.taskId, task]));
  const upstreamByTask = new Map<string, string[]>();
  const downstreamTasks = new Set<string>();
  graph.edges.forEach((edge) => {
    const upstream = upstreamByTask.get(edge.toTaskId) ?? [];
    upstream.push(edge.fromTaskId);
    upstreamByTask.set(edge.toTaskId, upstream);
    downstreamTasks.add(edge.fromTaskId);
  });
  const label = (taskId: string, shared = false): string => {
    const task = taskById.get(taskId);
    if (!task) return taskId;
    const name = task.taskName ? `:${task.taskName}` : "";
    return `${task.taskId}${name}（影响最终字段 ${task.fieldCount} 个）${shared ? "（共享节点）" : ""}`;
  };
  const roots = graph.tasks
    .filter((task) => !downstreamTasks.has(task.taskId))
    .map((task) => task.taskId)
    .sort();
  const lines: string[] = [];
  const renderChildren = (
    taskId: string,
    prefix: string,
    path: ReadonlySet<string>,
    rendered: Set<string>,
  ): void => {
    const children = [...new Set(upstreamByTask.get(taskId) ?? [])].sort();
    children.forEach((childId, index) => {
      const last = index === children.length - 1;
      const branch = last ? "└── " : "├── ";
      const cycle = path.has(childId);
      const shared = rendered.has(childId);
      lines.push(prefix + branch + label(childId, shared || cycle));
      if (cycle || shared) return;
      rendered.add(childId);
      renderChildren(childId, prefix + (last ? "    " : "│   "), new Set([...path, childId]), rendered);
    });
  };
  roots.forEach((rootId, index) => {
    if (index > 0) lines.push("");
    lines.push(label(rootId));
    renderChildren(rootId, "", new Set([rootId]), new Set([rootId]));
  });
  return lines.join("\n");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function escapeHtml(value: unknown): string {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serialized(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readArtifact(path: string): FieldLineageVisualizationArtifact {
  if (!existsSync(path))
    throw new Error(`FIELD_LINEAGE_ARTIFACT_NOT_FOUND:${path}`);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateFieldLineageArtifact(value);
  const legacySchema = isRecord(value) && value.schemaVersion === "1.0.0";
  if (!legacySchema && errors.length > 0)
    throw new Error(`FIELD_LINEAGE_ARTIFACT_INVALID:${errors.join(";")}`);
  if (
    !isRecord(value) ||
    value.artifactType !== "FIELD_MULTI_HOP_RECONCILIATION" ||
    !isRecord(value.request) ||
    typeof value.request.rootTaskId !== "string" ||
    typeof value.request.rootTable !== "string" ||
    !Array.isArray(value.request.rootFields) ||
    value.request.rootFields.length === 0 ||
    !Array.isArray(value.rootNodeIds) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    (!legacySchema && !Array.isArray(value.datasetControls)) ||
    (!legacySchema && !Array.isArray(value.fieldConditionals)) ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.tableEdges) ||
    !isRecord(value.counts) ||
    !isRecord(value.limits)
  )
    throw new Error(
      `FIELD_LINEAGE_ARTIFACT_INVALID:visualization fields are incomplete`,
    );
  return {
    ...(value as unknown as FieldLineageVisualizationArtifact),
    datasetControls: Array.isArray(value.datasetControls)
      ? value.datasetControls
      : [],
    fieldConditionals: Array.isArray(value.fieldConditionals)
      ? value.fieldConditionals
      : [],
  } as FieldLineageVisualizationArtifact;
}

type JsonRecord = Record<string, unknown>;

interface CodeFactBundle {
  readonly expressions: readonly JsonRecord[];
  readonly relations: readonly JsonRecord[];
  readonly relationEdges: readonly JsonRecord[];
  readonly outputBindings: readonly JsonRecord[];
}

interface CodeRelationCandidate {
  readonly record: JsonRecord;
  readonly relationId: string;
  readonly relationType: string;
  readonly statementId: string | null;
  readonly sourceSpan: { readonly start: number; readonly end: number } | null;
  readonly sourceText: string;
  readonly distance: number;
}

function recordString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordSpan(
  record: JsonRecord,
  key = "source_span",
): { readonly start: number; readonly end: number } | null {
  const value = record[key];
  if (!isRecord(value)) return null;
  const start = value.start;
  const end = value.end;
  return typeof start === "number" && typeof end === "number" && start >= 0 && end >= start
    ? { start, end }
    : null;
}

function loadCodeFacts(
  factsRoot: string | undefined,
  taskId: string,
): CodeFactBundle | null {
  if (!factsRoot || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(taskId)) return null;
  const bundleDir = join(resolve(factsRoot), "registry", "tasks", taskId, "bundle");
  if (!existsSync(bundleDir)) return null;
  return {
    expressions: readJsonlRecords(join(bundleDir, "field-expression-nodes.jsonl")),
    relations: readJsonlRecords(join(bundleDir, "relation-nodes.jsonl")),
    relationEdges: readJsonlRecords(join(bundleDir, "relation-edges.jsonl")),
    outputBindings: readJsonlRecords(join(bundleDir, "output-field-bindings.jsonl")),
  };
}

function fieldRefs(value: unknown): readonly { readonly table: string; readonly column: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const table = typeof item.table === "string" ? item.table : "";
    const column = typeof item.column === "string" ? item.column : "";
    return table || column ? [{ table, column }] : [];
  });
}

function fieldRefName(ref: { readonly table: string; readonly column: string }): string {
  return ref.table && ref.column ? `${ref.table}.${ref.column}` : ref.column || ref.table;
}

function uniqueFieldNames(
  refs: readonly { readonly table: string; readonly column: string }[],
): readonly string[] {
  return [...new Set(refs.map(fieldRefName).filter((value) => value.length > 0))];
}

function physicalFieldRefs(value: unknown): readonly { readonly table: string; readonly column: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const physical = fieldRefs(item.physical);
    if (physical.length > 0) return physical;
    const table = typeof item.table === "string" ? item.table : "";
    const column = typeof item.column === "string" ? item.column : "";
    return table || column ? [{ table, column }] : [];
  });
}

function relationRecord(record: JsonRecord): JsonRecord {
  return isRecord(record.relation) ? record.relation : {};
}

function relationObjectName(record: JsonRecord): string | null {
  return recordString(relationRecord(record), "table");
}

function relationOutputFields(record: JsonRecord): readonly string[] {
  const relation = relationRecord(record);
  if (Array.isArray(relation.output_columns)) {
    return relation.output_columns.filter((value): value is string => typeof value === "string");
  }
  if (!Array.isArray(relation.expressions)) return [];
  return relation.expressions
    .filter(isRecord)
    .map((expression) => recordString(expression, "output") ?? recordString(expression, "output_name"))
    .filter((value): value is string => value !== null);
}

function relationInputFields(record: JsonRecord): readonly string[] {
  const relation = relationRecord(record);
  if (!Array.isArray(relation.expressions)) return [];
  return uniqueFieldNames(
    relation.expressions.flatMap((expression) =>
      isRecord(expression) ? physicalFieldRefs(expression.input_columns) : [],
    ),
  );
}

function downstreamRelationInputFields(
  relationId: string,
  relationById: ReadonlyMap<string, JsonRecord>,
  outgoingByRelation: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const queue = [...(outgoingByRelation.get(relationId) ?? [])];
  const visited = new Set<string>();
  const fields: { table: string; column: string }[] = [];
  while (queue.length > 0) {
    const nextId = queue.shift();
    if (!nextId || visited.has(nextId)) continue;
    visited.add(nextId);
    const next = relationById.get(nextId);
    if (!next) continue;
    const nextFields = relationInputFields(next);
    if (nextFields.length > 0) {
      nextFields.forEach((value) => {
        const separator = value.lastIndexOf(".");
        fields.push(
          separator < 0
            ? { table: "", column: value }
            : { table: value.slice(0, separator), column: value.slice(separator + 1) },
        );
      });
      continue;
    }
    queue.push(...(outgoingByRelation.get(nextId) ?? []));
  }
  return [...new Set(fields.map(fieldRefName).filter((value) => value.length > 0))];
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsSqlToken(source: string, token: string): boolean {
  if (!token || token.length < 3) return false;
  if (token.includes(".")) return source.toLocaleLowerCase().includes(token.toLocaleLowerCase());
  return new RegExp(`(^|[^A-Za-z0-9_])${regexEscape(token)}(?=$|[^A-Za-z0-9_])`, "i").test(source);
}

function relationTitle(relationType: string, relationId: string): string {
  if (relationId.endsWith("root.project")) return "目标字段投影";
  if (relationId.includes(".(child)")) return "CTE / 子查询";
  switch (relationType.toLowerCase()) {
    case "read":
      return "读取输入";
    case "filter":
      return "过滤条件";
    case "join":
      return "JOIN 关联";
    case "aggregate":
      return "聚合 / 分组";
    case "setop":
      return "UNION 分支汇聚";
    case "project":
      return "字段投影";
    default:
      return relationType || "SQL 关系";
  }
}

function selectedFieldNodes(
  artifact: FieldLineageVisualizationArtifact,
  field: string,
): { readonly nodeIds: readonly string[]; readonly taskIds: readonly string[] } {
  const nodeById = new Map(artifact.nodes.map((node) => [node.nodeId, node]));
  const incomingByNode = new Map<string, FieldLineageEdge[]>();
  artifact.edges.forEach((edge) => {
    const incoming = incomingByNode.get(edge.toNodeId) ?? [];
    incoming.push(edge);
    incomingByNode.set(edge.toNodeId, incoming);
  });
  const roots = artifact.rootNodeIds
    .map((nodeId) => nodeById.get(nodeId))
    .filter((node): node is FieldLineageNode =>
      effectiveNode(node) && node.field.column === field,
    );
  const seen = new Set<string>();
  const taskIds: string[] = [];
  const seenTasks = new Set<string>();
  const queue = roots.map((node) => node.nodeId);
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || seen.has(nodeId)) continue;
    const node = nodeById.get(nodeId);
    if (!effectiveNode(node)) continue;
    seen.add(nodeId);
    if (!seenTasks.has(node.taskId)) {
      seenTasks.add(node.taskId);
      taskIds.push(node.taskId);
    }
    for (const edge of incomingByNode.get(nodeId) ?? []) {
      if (edge.evidenceStatus === "UNRESOLVED") continue;
      const parent = nodeById.get(edge.fromNodeId);
      if (effectiveNode(parent) && !seen.has(parent.nodeId)) queue.push(parent.nodeId);
    }
  }
  return { nodeIds: [...seen], taskIds };
}

function codeFlowForField(
  artifact: FieldLineageVisualizationArtifact,
  field: string,
  factsByTask: ReadonlyMap<string, CodeFactBundle | null>,
  stepById: Map<string, FieldLineageCodeFlowStep>,
): FieldLineageCodeFlowField {
  const nodeById = new Map(artifact.nodes.map((node) => [node.nodeId, node]));
  const selected = selectedFieldNodes(artifact, field);
  const selectedNodeIds = new Set(selected.nodeIds);
  const boundaryNodeIds = new Set(
    artifact.rootNodeIds.filter((nodeId) => selectedNodeIds.has(nodeId)),
  );
  artifact.edges.forEach((edge) => {
    if (!selectedNodeIds.has(edge.fromNodeId) || !selectedNodeIds.has(edge.toNodeId)) return;
    const from = nodeById.get(edge.fromNodeId);
    const to = nodeById.get(edge.toNodeId);
    if (from && to && from.taskId !== to.taskId) boundaryNodeIds.add(edge.fromNodeId);
  });
  const nodesByTask = new Map<string, FieldLineageNode[]>();
  [...boundaryNodeIds].forEach((nodeId) => {
    const node = nodeById.get(nodeId);
    if (!node) return;
    const nodes = nodesByTask.get(node.taskId) ?? [];
    nodes.push(node);
    nodesByTask.set(node.taskId, nodes);
  });
  selected.taskIds.forEach((taskId) => {
    if (nodesByTask.has(taskId)) return;
    const fallback = selected.nodeIds
      .map((nodeId) => nodeById.get(nodeId))
      .find((node) => node?.taskId === taskId);
    if (fallback) nodesByTask.set(taskId, [fallback]);
  });

  const stepIds: string[] = [];
  const stepIdSet = new Set<string>();
  const appendStep = (step: FieldLineageCodeFlowStep): void => {
    if (stepIdSet.has(step.stepId)) return;
    stepIdSet.add(step.stepId);
    stepById.set(step.stepId, stepById.get(step.stepId) ?? step);
    stepIds.push(step.stepId);
  };
  let factsBacked = false;
  const missingTasks: string[] = [];

  selected.taskIds.forEach((taskId) => {
    const nodes = nodesByTask.get(taskId) ?? [];
    const facts = factsByTask.get(taskId) ?? null;
    if (!facts) {
      missingTasks.push(taskId);
      nodes.forEach((node) => {
        if (!node.expressionText) return;
        appendStep({
          stepId: `expression-only:${node.nodeId}`,
          taskId: node.taskId,
          taskName: node.taskName,
          stage: "expression",
          title: "字段表达式（仅字段产物）",
          relationType: null,
          relationId: null,
          statementId: null,
          sourceSpan: null,
          sourceText: node.expressionText,
          evidenceMode: "EXPRESSION_ONLY",
          inputFields: [],
          outputFields: [node.field.column],
          relationObject: null,
        });
      });
      return;
    }

    const nodeExpressionIds = new Set(
      nodes
        .map((node) => node.expressionId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    const relevantColumns = new Set(nodes.map((node) => node.field.column));
    const relevantTables = new Set(nodes.map((node) => node.field.qualifiedName));
    const outputBindingExpressionIds = new Set(
      facts.outputBindings
        .filter((binding) => {
          const targetField = recordString(binding, "target_field");
          return targetField !== null && relevantColumns.has(targetField);
        })
        .map((binding) => recordString(binding, "expression_id"))
        .filter((value): value is string => value !== null),
    );
    outputBindingExpressionIds.forEach((value) => nodeExpressionIds.add(value));

    const expressions = facts.expressions
      .filter((expression) => {
        const expressionId = recordString(expression, "expression_id");
        const outputName = recordString(expression, "output_name");
        return (
          (expressionId !== null && nodeExpressionIds.has(expressionId)) ||
          (outputName !== null && relevantColumns.has(outputName))
        );
      })
      .sort((left, right) => (recordSpan(left)?.start ?? 0) - (recordSpan(right)?.start ?? 0));
    const selectedInputFields = uniqueFieldNames(
      expressions.flatMap((expression) => fieldRefs(expression.input_fields)),
    );

    const seedRelationIds = new Set<string>();
    expressions.forEach((expression) => {
      const relationId = recordString(expression, "relation_id");
      if (relationId) seedRelationIds.add(relationId);
      fieldRefs(expression.input_fields).forEach((input) => {
        if (input.column) relevantColumns.add(input.column);
        if (input.table) relevantTables.add(input.table);
      });
    });
    expressions.forEach((expression) => {
      const expressionId = recordString(expression, "expression_id");
      const expressionText = recordString(expression, "expression_text");
      if (!expressionId || !expressionText) return;
      const outputName = recordString(expression, "output_name") ?? field;
      const span = recordSpan(expression);
      const expressionInputFields = uniqueFieldNames(fieldRefs(expression.input_fields));
      const stepId = `expression:${taskId}:${expressionId}`;
      appendStep({
        stepId,
        taskId,
        taskName: nodes[0]?.taskName ?? null,
        stage: "expression",
        title: `字段表达式 · ${outputName}`,
        relationType: null,
        relationId: recordString(expression, "relation_id"),
        statementId: recordString(expression, "statement_id"),
        sourceSpan: span,
        sourceText: expressionText,
        evidenceMode: "FACTS_BACKED",
        inputFields: expressionInputFields,
        outputFields: [outputName],
        relationObject: null,
      });
      factsBacked = true;
    });

    const relationById = new Map<string, JsonRecord>();
    facts.relations.forEach((relation) => {
      const relationId = recordString(relation, "relation_id");
      if (relationId) relationById.set(relationId, relation);
    });
    const incomingByRelation = new Map<string, string[]>();
    const outgoingByRelation = new Map<string, string[]>();
    facts.relationEdges.forEach((edge) => {
      const from = recordString(edge, "from_relation_id");
      const to = recordString(edge, "to_relation_id");
      if (!from || !to) return;
      const incoming = incomingByRelation.get(to) ?? [];
      incoming.push(from);
      incomingByRelation.set(to, incoming);
      const outgoing = outgoingByRelation.get(from) ?? [];
      outgoing.push(to);
      outgoingByRelation.set(from, outgoing);
    });
    const distanceByRelation = new Map<string, number>();
    const relationQueue = [...seedRelationIds];
    seedRelationIds.forEach((relationId) => distanceByRelation.set(relationId, 0));
    while (relationQueue.length > 0) {
      const relationId = relationQueue.shift();
      if (!relationId) continue;
      const distance = distanceByRelation.get(relationId) ?? 0;
      for (const parentId of incomingByRelation.get(relationId) ?? []) {
        if (distanceByRelation.has(parentId)) continue;
        distanceByRelation.set(parentId, distance + 1);
        relationQueue.push(parentId);
      }
    }
    const candidates: CodeRelationCandidate[] = [];
    for (const [relationId, distance] of distanceByRelation) {
      const relation = relationById.get(relationId);
      if (!relation) continue;
      const sourceText = recordString(relation, "source_text");
      if (!sourceText) continue;
      candidates.push({
        record: relation,
        relationId,
        relationType: recordString(relation, "relation_type") ?? "relation",
        statementId: recordString(relation, "statement_id"),
        sourceSpan: recordSpan(relation),
        sourceText,
        distance,
      });
    }
    const extraRelations = facts.relations
      .map((relation) => {
        const relationId = recordString(relation, "relation_id");
        const sourceText = recordString(relation, "source_text");
        if (!relationId || !sourceText || distanceByRelation.has(relationId)) return null;
        if (!relationId.includes(".(child)")) return null;
        const relevant = [...relevantColumns, ...relevantTables].some((token) =>
          containsSqlToken(sourceText, token),
        );
        if (!relevant) return null;
        return {
          record: relation,
          relationId,
          relationType: recordString(relation, "relation_type") ?? "relation",
          statementId: recordString(relation, "statement_id"),
          sourceSpan: recordSpan(relation),
          sourceText,
          distance: (Math.max(...distanceByRelation.values(), 0) + 1),
        } satisfies CodeRelationCandidate;
      })
      .filter((value): value is CodeRelationCandidate => value !== null);
    candidates.push(...extraRelations);

    if (candidates.length === 0) {
      facts.relations
        .map((relation) => {
          const relationId = recordString(relation, "relation_id");
          const sourceText = recordString(relation, "source_text");
          if (!relationId || !sourceText) return null;
          const relevant = [...relevantColumns, ...relevantTables].some((token) =>
            containsSqlToken(sourceText, token),
          );
          if (!relevant) return null;
          return {
            record: relation,
            relationId,
            relationType: recordString(relation, "relation_type") ?? "relation",
            statementId: recordString(relation, "statement_id"),
            sourceSpan: recordSpan(relation),
            sourceText,
            distance: 0,
          } satisfies CodeRelationCandidate;
        })
        .filter((value): value is CodeRelationCandidate => value !== null)
        .sort((left, right) => (right.sourceText.length - left.sourceText.length))
        .slice(0, 4)
        .forEach((candidate) => candidates.push(candidate));
    }

    const relationCandidates = new Map<string, CodeRelationCandidate>();
    candidates.forEach((candidate) => {
      const span = candidate.sourceSpan;
      const key = `${candidate.relationType}|${span?.start ?? candidate.relationId}|${span?.end ?? candidate.sourceText}`;
      const previous = relationCandidates.get(key);
      if (!previous || candidate.sourceText.length > previous.sourceText.length) {
        relationCandidates.set(key, candidate);
      }
    });
    [...relationCandidates.values()]
      .sort((left, right) => {
        if (left.distance !== right.distance) return left.distance - right.distance;
        return (left.sourceSpan?.start ?? 0) - (right.sourceSpan?.start ?? 0);
      })
      .slice(0, 32)
      .forEach((candidate) => {
        const downstreamInputs =
          candidate.relationType.toLowerCase() === "read"
            ? downstreamRelationInputFields(candidate.relationId, relationById, outgoingByRelation)
            : [];
        const inputFields =
          candidate.relationType.toLowerCase() === "read"
            ? downstreamInputs.length > 0
              ? downstreamInputs
              : selectedInputFields
            : relationInputFields(candidate.record);
        const stepId = `relation:${taskId}:${candidate.relationType}:${candidate.sourceSpan?.start ?? candidate.relationId}:${candidate.sourceSpan?.end ?? ""}`;
        appendStep({
          stepId,
          taskId,
          taskName: nodes[0]?.taskName ?? null,
          stage: candidate.relationType,
          title: relationTitle(candidate.relationType, candidate.relationId),
          relationType: candidate.relationType,
          relationId: candidate.relationId,
          statementId: candidate.statementId,
          sourceSpan: candidate.sourceSpan,
          sourceText: candidate.sourceText,
          evidenceMode: "FACTS_BACKED",
          inputFields,
          outputFields: relationOutputFields(candidate.record),
          relationObject: relationObjectName(candidate.record),
        });
        factsBacked = true;
      });
    if (expressions.length === 0 && candidates.length === 0) {
      nodes.forEach((node) => {
        if (!node.expressionText) return;
        appendStep({
          stepId: `expression-only:${node.nodeId}`,
          taskId: node.taskId,
          taskName: node.taskName,
          stage: "expression",
          title: "字段表达式（仅字段产物）",
          relationType: null,
          relationId: null,
          statementId: null,
          sourceSpan: null,
          sourceText: node.expressionText,
          evidenceMode: "EXPRESSION_ONLY",
          inputFields: [],
          outputFields: [node.field.column],
          relationObject: null,
        });
      });
    }
  });

  const status = factsBacked
    ? "FACTS_BACKED"
    : stepIds.length > 0
      ? "EXPRESSION_ONLY"
      : "UNAVAILABLE";
  const note =
    status === "UNAVAILABLE"
      ? "当前字段没有可展示的代码证据。"
      : factsBacked
        ? missingTasks.length > 0
          ? `已展开 facts SQL；缺少 ${missingTasks.length} 个 Task 的当前 facts：${missingTasks.join("、")}`
          : "已按目标字段的 Task 顺序展开原始 SQL 片段；点击步骤可查看代码。"
        : "未加载可用 facts，当前仅展示字段产物中的表达式；不会推断缺失 SQL。";
  return {
    stepIds,
    taskIds: selected.taskIds,
    status,
    note,
  };
}

export function buildFieldLineageCodeFlowData(
  artifact: FieldLineageVisualizationArtifact,
  factsRoot?: string,
): FieldLineageCodeFlowData {
  const taskIds = [
    ...new Set(
      artifact.nodes
        .filter((node) => effectiveNode(node))
        .map((node) => node.taskId),
    ),
  ];
  const factsByTask = new Map<string, CodeFactBundle | null>();
  taskIds.forEach((taskId) => factsByTask.set(taskId, loadCodeFacts(factsRoot, taskId)));
  const factsTasks = factsRoot
    ? taskIds.filter((taskId) => factsByTask.get(taskId) !== null)
    : [];
  const missingTasks = factsRoot
    ? taskIds.filter((taskId) => factsByTask.get(taskId) === null)
    : [];
  const stepByKey = new Map<string, FieldLineageCodeFlowStep>();
  const fields: Record<string, FieldLineageCodeFlowField> = {};
  [...new Set(artifact.request.rootFields)].forEach((field) => {
    fields[field] = codeFlowForField(artifact, field, factsByTask, stepByKey);
  });
  return {
    steps: [...stepByKey.values()],
    fields,
    factsTasks,
    missingTasks,
  };
}

export function renderFieldLineageHtml(
  artifact: FieldLineageVisualizationArtifact,
  factsRoot?: string,
): string {
  const rootTaskId = escapeHtml(artifact.request.rootTaskId);
  const rootTable = escapeHtml(artifact.request.rootTable);
  const data = serialized(artifact);
  const impactData = serialized(buildFieldLineageImpactGraph(artifact));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Field lineage ${rootTaskId}</title>
<style>
:root{color-scheme:light dark;--bg:light-dark(#f4f6f8,#11171d);--surface:light-dark(#fff,#182128);--surface-2:light-dark(#f8fafb,#202b34);--text:light-dark(#1f2933,#e6edf2);--muted:light-dark(#667482,#aab9c5);--line:light-dark(#dbe2e9,#35434e);--flow:light-dark(#237a58,#69d6a0);--candidate:light-dark(#9a6517,#e8bc6d);--danger:light-dark(#a33a3a,#f08b8b)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Microsoft YaHei",sans-serif}header{padding:20px 24px 16px;background:var(--surface);border-bottom:1px solid var(--line)}h1,h2,h3,p{margin:0}h1{font-size:23px;font-weight:500}h2{font-size:16px;font-weight:500;margin-bottom:10px}h3{font-size:14px;font-weight:500;margin:18px 0 8px}.subtitle,.meta,.note{color:var(--muted)}.subtitle{margin-top:4px}.meta{margin-top:8px;font-size:12px}.layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:18px;max-width:1400px;margin:0 auto;padding:18px 22px}.panel{min-width:0}.field-list{display:grid;gap:2px}.field{display:block;width:100%;padding:6px 8px;border:0;border-left:2px solid transparent;background:transparent;color:var(--text);text-align:left;cursor:pointer;font:inherit;overflow-wrap:anywhere}.field:hover,.field[aria-pressed="true"]{color:var(--flow);border-left-color:var(--flow)}.badge{display:inline-block;color:var(--muted);font-size:12px}.route-list{display:grid;gap:12px}.route{padding:12px;background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--flow);border-radius:6px;overflow:auto}.route-label{display:flex;align-items:baseline;gap:12px;color:var(--muted);font-size:12px;margin-bottom:10px}.task-chain{color:var(--text);font-weight:500}.route-nodes{display:flex;align-items:stretch;gap:9px;min-width:max-content}.task-group{min-width:230px;max-width:330px;padding:10px;background:var(--surface-2);border:1px solid var(--line);border-radius:6px}.task-group-title{font-weight:600;margin-bottom:7px}.task-group-name{display:block;color:var(--muted);font-size:11px;font-weight:400;overflow-wrap:anywhere}.task-field{padding:7px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}.task-field:first-child{border-top:0;padding-top:0}.task-field-name{display:block;font-weight:500}.task-field small{display:block;margin-top:3px;color:var(--muted);overflow-wrap:anywhere}.field-link{padding:4px 0;color:var(--flow);font-size:11px;overflow-wrap:anywhere}.task-bridge{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:3px;min-width:105px;color:var(--flow);text-align:center}.task-bridge strong{font-size:19px;font-weight:400}.task-bridge small{color:var(--muted);font-size:11px;max-width:140px;overflow-wrap:anywhere}.empty{padding:16px;background:var(--surface);border:1px solid var(--line);border-radius:6px;color:var(--muted)}.detail{margin-top:18px;padding:13px 0;border-top:1px solid var(--line)}.detail-line{margin-top:5px;overflow-wrap:anywhere}.status strong{color:var(--flow);font-weight:500}.candidate-list,.control-list,.table-list{display:grid;gap:0}.candidate,.control,.table-edge{padding:7px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}.candidate{color:var(--candidate)}.candidate small,.control small,.table-edge small{display:block;color:var(--muted);margin-top:2px}.control,.table-edge{color:var(--text)}.section{margin-top:20px}.section:first-child{margin-top:0}.counts{display:grid;grid-template-columns:repeat(5,minmax(72px,1fr));gap:8px;margin-bottom:18px}.count{padding:9px;background:var(--surface);border:1px solid var(--line);border-radius:5px}.count strong{display:block;font-size:18px;font-weight:500}.count span{display:block;color:var(--muted);font-size:11px;margin-top:2px}.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-top:12px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:4px}.legend .flow{background:var(--flow)}.legend .candidate-mark{background:var(--candidate)}.legend .control-mark{background:var(--muted)}@media(max-width:720px){.layout{grid-template-columns:1fr;padding:14px}.field-list{grid-template-columns:repeat(2,minmax(0,1fr))}.counts{grid-template-columns:repeat(3,minmax(72px,1fr))}.route-nodes{min-width:0;display:grid;grid-template-columns:1fr;gap:5px}.task-group{max-width:none}.task-bridge{min-width:0;flex-direction:row}.task-bridge strong{transform:rotate(90deg)}.task-bridge small{max-width:none}.route-label{display:block}.task-chain{display:block;margin-top:3px}}
.route-summary{margin:8px 0 12px;color:var(--muted);font-size:12px}.evidence-list{display:grid;gap:7px;margin-top:12px}.evidence{border:1px solid var(--line);border-radius:5px;background:var(--surface-2);overflow:hidden}.evidence summary{padding:9px 11px;cursor:pointer;color:var(--text);font-weight:500}.evidence summary::marker{color:var(--flow)}.evidence-body{padding:0 11px 11px}.evidence-meta{color:var(--muted);font-size:12px;margin-bottom:8px;overflow-wrap:anywhere}.evidence-step,.evidence-edge{padding:6px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}.evidence-step strong,.evidence-edge strong{font-weight:500}.evidence-step small,.evidence-edge small{display:block;color:var(--muted);margin-top:3px;overflow-wrap:anywhere}.evidence-edge{color:var(--flow)}
.semantic-list{display:grid;gap:9px;margin-top:12px}.semantic-branch{padding:11px;background:var(--surface-2);border:1px solid var(--line);border-radius:6px}.semantic-title{font-weight:600}.semantic-flow{margin-top:7px;color:var(--flow);font-weight:500;overflow-wrap:anywhere}.semantic-meta{margin-top:6px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.technical-evidence{margin-top:9px;border-top:1px solid var(--line);padding-top:7px}.technical-evidence summary{color:var(--muted);font-size:12px;cursor:pointer}
.semantic-list{gap:14px}.semantic-branch{padding:15px 16px;background:var(--surface);box-shadow:0 2px 8px rgba(31,41,51,.05)}.semantic-title{font-size:15px}.flow-cards{display:flex;align-items:stretch;gap:8px;margin-top:13px;overflow-x:auto;padding:2px 2px 6px}.flow-card{flex:0 1 250px;min-width:210px;padding:11px 12px;background:var(--surface-2);border:1px solid var(--line);border-radius:7px}.flow-card-source{border-top:3px solid var(--flow)}.flow-card-middle{border-top:3px solid var(--candidate)}.flow-card-target{border-top:3px solid var(--flow)}.flow-card-label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.flow-card-task{margin-top:4px;font-weight:600}.flow-card-table{margin-top:6px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.flow-card-column{margin-top:3px;font-size:14px;font-weight:500;overflow-wrap:anywhere}.flow-card-op{margin-top:7px;padding-top:7px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;overflow-wrap:anywhere}.flow-arrow{display:flex;align-items:center;justify-content:center;min-width:44px;color:var(--flow);font-size:22px}.flow-arrow small{display:block;margin-left:3px;color:var(--muted);font-size:10px;overflow-wrap:anywhere}.branch-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.branch-tag{padding:3px 7px;border-radius:999px;background:var(--surface-2);color:var(--muted);font-size:11px}.route-summary{font-size:13px}.panel:first-child{align-self:start;padding:14px;background:var(--surface);border:1px solid var(--line);border-radius:8px;position:sticky;top:14px}.panel:first-child h2{font-size:15px}.counts{gap:10px}.count{padding:11px 12px}.count strong{font-size:20px}
.task-flow{gap:12px;align-items:stretch;min-width:max-content;padding:3px 2px 8px}.task-flow .task-group{min-width:285px;max-width:365px;padding:14px 15px;box-shadow:0 2px 7px rgba(31,41,51,.06)}.task-flow .task-group-title{font-size:16px}.task-flow .task-group-name{font-size:12px}.task-flow .task-bridge{min-width:125px;max-width:155px}.task-flow .task-bridge small{max-width:155px;line-height:1.35}.task-field-name{font-size:13px;line-height:1.35}.task-field small{white-space:pre-line;line-height:1.4}.field-link{padding:8px 0;line-height:1.35;white-space:normal}
.lineage-overview{display:grid;gap:12px;padding:14px;background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:0 2px 8px rgba(31,41,51,.05)}.overview-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:12px;border-bottom:1px solid var(--line)}.overview-kicker{color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase}.overview-title{margin-top:3px;font-size:18px;font-weight:600;overflow-wrap:anywhere}.overview-target{margin-top:5px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.overview-summary{color:var(--muted);font-size:12px;text-align:right;white-space:nowrap}.branch-list{display:grid;gap:8px}.branch-detail{border:1px solid var(--line);border-radius:7px;overflow:hidden;background:var(--surface-2)}.branch-detail>summary{list-style:none;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:11px 12px;cursor:pointer}.branch-detail>summary::-webkit-details-marker{display:none}.branch-detail>summary::before{content:"›";color:var(--flow);font-size:18px;transition:transform .15s ease}.branch-detail[open]>summary::before{transform:rotate(90deg)}.branch-detail>summary:hover{background:var(--surface)}.branch-summary-index{color:var(--muted);font-size:12px;white-space:nowrap}.branch-summary-chain{min-width:0;overflow-wrap:anywhere;font-weight:500}.branch-summary-meta{color:var(--muted);font-size:12px;white-space:nowrap}.branch-detail-body{padding:0 10px 10px;border-top:1px solid var(--line)}.branch-detail-body .route{padding:10px;background:transparent;border:0;overflow:visible}.branch-detail-body .route-summary{display:none}.branch-detail-body .task-flow{margin-top:0}@media(max-width:720px){.overview-header{display:block}.overview-summary{text-align:left;margin-top:8px;white-space:normal}.branch-detail>summary{grid-template-columns:auto minmax(0,1fr)}.branch-summary-meta{grid-column:2;white-space:normal}}
.panel:first-child{display:flex;flex-direction:column;max-height:calc(100vh - 28px);overflow:hidden}.panel:first-child .section:first-child{display:flex;flex:1 1 auto;flex-direction:column;min-height:0}.panel:first-child .field-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:4px}@media(max-width:720px){.panel:first-child{display:block;max-height:none;overflow:visible}.panel:first-child .section:first-child{display:block}.panel:first-child .field-list{overflow:visible;padding-right:0}}
.lineage-section{display:grid;gap:8px}.lineage-section-title{font-size:13px;font-weight:600}.provisional-section{border:1px solid var(--candidate);border-radius:7px;background:color-mix(in srgb,var(--candidate) 6%,var(--surface));overflow:hidden}.provisional-section>summary{padding:11px 12px;color:var(--candidate);font-weight:600;cursor:pointer}.provisional-section>.branch-list{padding:0 10px 10px}.provisional-note{padding:0 12px 10px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.branch-detail.provisional{border-color:color-mix(in srgb,var(--candidate) 55%,var(--line))}.branch-detail.provisional>summary::before{color:var(--candidate)}
.view-tabs{display:flex;gap:2px;margin-top:16px;padding:0 22px;background:var(--surface);border-bottom:1px solid var(--line)}.view-tab{padding:10px 18px;border:0;border-bottom:3px solid transparent;background:transparent;color:var(--muted);font:inherit;cursor:pointer}.view-tab:hover{color:var(--text)}.view-tab[aria-selected="true"]{border-bottom-color:var(--flow);color:var(--flow);font-weight:600}.view-hidden{display:none!important}.impact-layout{max-width:1400px;margin:0 auto;padding:14px 18px}.impact-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:10px}.impact-title{font-size:17px;font-weight:600}.impact-subtitle{margin-top:3px;color:var(--muted);font-size:12px}.impact-summary{color:var(--muted);font-size:12px;text-align:right;white-space:nowrap}.impact-graph-shell{overflow:auto;padding:2px 2px 10px;background:var(--surface);border:1px solid var(--line);border-radius:8px}.impact-graph{position:relative;min-width:640px;min-height:220px}.impact-svg{position:absolute;inset:0;overflow:visible;pointer-events:none}.impact-svg path{fill:none;stroke:var(--flow);stroke-width:1.25;opacity:.7}.impact-svg text{fill:var(--muted);font-size:10px}.impact-card{position:absolute;width:210px;height:96px;padding:8px 10px;background:var(--surface-2);border:1px solid var(--line);border-top:3px solid var(--flow);border-radius:7px;box-shadow:0 1px 4px rgba(31,41,51,.05);overflow:hidden;text-align:left;color:var(--text);font:inherit}.impact-card-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.impact-card-name{margin-top:2px;color:var(--muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.impact-card-summary{margin-top:8px;color:var(--flow);font-size:12px}.impact-note{margin:8px 2px 0;color:var(--muted);font-size:11px}.impact-unresolved{color:var(--candidate)}.impact-empty{padding:18px;color:var(--muted);text-align:center}@media(max-width:720px){.view-tabs{padding:0 14px}.impact-layout{padding:12px}.impact-header{display:block}.impact-summary{text-align:left;margin-top:6px;white-space:normal}.impact-card{width:190px}}
.task-flow{min-width:0;max-width:100%;width:100%;overflow-x:auto}.branch-detail-body{min-width:0;overflow:hidden}
.impact-tree-shell{margin-bottom:10px;padding:10px 12px;background:var(--surface);border:1px solid var(--line);border-radius:8px}.impact-tree-title{margin:0 0 6px;font-size:13px;font-weight:600}.impact-tree-stats{width:100%;margin:0 0 10px;border-collapse:collapse;font-size:12px}.impact-tree-stats th,.impact-tree-stats td{padding:6px 8px;border:1px solid var(--line);text-align:left}.impact-tree-stats th{width:42%;color:var(--muted);font-weight:500;background:var(--surface-2)}.impact-tree-stats td{font-variant-numeric:tabular-nums;font-weight:600}.impact-tree{margin:0;max-height:260px;overflow:auto;color:var(--text);font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,"Microsoft YaHei",monospace;white-space:pre}.impact-tree-note{margin-top:6px;color:var(--muted);font-size:11px}
</style>
</head>
<body>
<header><h1>字段血缘 · ${rootTaskId}</h1><p class="subtitle">目标表：${rootTable}</p><p class="meta">页面由 FIELD_MULTI_HOP_RECONCILIATION 产物驱动；只展示静态证据，不代表调度运行或数据正确性。</p><nav class="view-tabs" aria-label="血缘视图"><button type="button" class="view-tab" data-view="field" aria-selected="true">字段血缘</button><button type="button" class="view-tab" data-view="impact" aria-selected="false">影响范围</button></nav></header>
<div id="field-lineage-app" class="layout">
  <aside class="panel"><section class="section"><h2>目标字段</h2><div class="field-list" id="field-list"></div></section><div class="legend"><span><i class="flow"></i>CONFIRMED</span><span><i class="candidate-mark"></i>PROVISIONAL / CANDIDATE</span></div></aside>
  <main class="panel">
    <div class="counts" id="counts"></div>
    <section class="section"><h2>当前字段的多分支汇聚</h2><div id="routes" class="route-list" aria-live="polite"></div></section>
    <section class="detail" aria-live="polite"><h2>字段详情</h2><p id="status" class="status"></p><p id="detail-source" class="detail-line"></p><p id="detail-evidence" class="detail-line"></p></section>
    <section class="section"><h2>DATASET_CONTROL</h2><p class="note">数据集控制按 relation 收集，不计入字段值流上游表。</p><div id="dataset-controls" class="control-list"></div></section>
    <section class="section"><h2>候选 producer</h2><p class="note">候选关系不进入确认的 VALUE_FLOW 主路径。</p><div id="candidates" class="candidate-list"></div></section>
    <section class="section"><h2>表级关系（未做字段确认）</h2><div id="table-edges" class="table-list"></div></section>
  </main>
</div>
<section id="impact-view" class="impact-layout view-hidden" aria-labelledby="impact-title">
  <div class="impact-header"><div><h2 id="impact-title" class="impact-title">调度影响范围</h2><p class="impact-subtitle">每张卡片代表一个调度，数字表示它影响的最终表字段数量。</p></div></div>
  <section class="impact-tree-shell" aria-labelledby="impact-tree-title"><h3 id="impact-tree-title" class="impact-tree-title">链路总览</h3><table id="impact-tree-stats" class="impact-tree-stats" aria-label="链路总览统计"><tbody></tbody></table><pre id="impact-tree" class="impact-tree"></pre><p class="impact-tree-note">箭头方向为上游 → 下游；树状文字从最终调度向上游展开。</p></section>
  <div class="impact-graph-shell"><div id="impact-graph" class="impact-graph"><svg id="impact-svg" class="impact-svg" aria-hidden="true"><defs><marker id="impact-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"></path></marker></defs></svg><div id="impact-cards"></div></div></div>
  <p id="impact-note" class="impact-note"></p>
</section>
<script>
const DATA=${data};
const IMPACT=${impactData};
const IMPACT_TREE=${serialized(renderFieldLineageImpactTree(buildFieldLineageImpactGraph(artifact)))};
const app=document.getElementById("field-lineage-app");
const impactView=document.getElementById("impact-view"),impactTreeStats=document.getElementById("impact-tree-stats"),impactTree=document.getElementById("impact-tree"),impactGraph=document.getElementById("impact-graph"),impactSvg=document.getElementById("impact-svg"),impactCards=document.getElementById("impact-cards"),impactNote=document.getElementById("impact-note");
const nodeById=new Map(DATA.nodes.map((node)=>[node.nodeId,node]));
const edgesByTo=new Map();
for(const edge of DATA.edges){const list=edgesByTo.get(edge.toNodeId)||[];list.push(edge);edgesByTo.set(edge.toNodeId,list)}
const rootIds=new Set(DATA.rootNodeIds);
const fieldList=document.getElementById("field-list"),routes=document.getElementById("routes"),counts=document.getElementById("counts"),status=document.getElementById("status"),detailSource=document.getElementById("detail-source"),detailEvidence=document.getElementById("detail-evidence"),candidateBox=document.getElementById("candidates"),datasetControlBox=document.getElementById("dataset-controls"),tableBox=document.getElementById("table-edges");
const esc=(value)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const nodeLabel=(node)=>node?{task:node.taskId,table:node.field.qualifiedName,column:node.field.column}:null;
const fields=[...new Set(DATA.request.rootFields)].sort();
function impactLayers(){
  const taskIds=IMPACT.tasks.map((task)=>task.taskId),taskSet=new Set(taskIds),indegree=new Map(taskIds.map((taskId)=>[taskId,0])),outgoing=new Map(taskIds.map((taskId)=>[taskId,[]]));
  IMPACT.edges.forEach((edge)=>{if(!taskSet.has(edge.fromTaskId)||!taskSet.has(edge.toTaskId))return;outgoing.get(edge.fromTaskId).push(edge.toTaskId);indegree.set(edge.toTaskId,indegree.get(edge.toTaskId)+1)});
  const remaining=new Set(taskIds),layers=[];
  while(remaining.size){
    const ready=[...remaining].filter((taskId)=>indegree.get(taskId)===0).sort();
    const current=ready.length?ready:[...remaining].sort();
    layers.push(current);current.forEach((taskId)=>remaining.delete(taskId));
    current.forEach((taskId)=>{for(const next of outgoing.get(taskId)||[]){indegree.set(next,indegree.get(next)-1)}});
  }
  return layers;
}
function impactCardHtml(task){
  const taskName=task.taskName||"调度名称未提供";
  return '<div class="impact-card" data-task-id="'+esc(task.taskId)+'"><div class="impact-card-title">调度 '+esc(task.taskId)+'</div><div class="impact-card-name" title="'+esc(taskName)+'">'+esc(taskName)+'</div><div class="impact-card-summary"><span>影响最终字段 '+task.fieldCount+' 个</span></div></div>';
}
function impactTreeStatsRows(){
  const upstreamTaskCount=IMPACT.tasks.filter((task)=>task.taskId!==DATA.request.rootTaskId).length;
  const rows=[
    ['调度任务（含根）',IMPACT.tasks.length],
    ['上游调度',upstreamTaskCount],
    ['调度边（上游 → 下游）',IMPACT.edges.length],
    ['影响最终字段',IMPACT.fieldCount],
  ];
  if(IMPACT.unresolvedFieldCount)rows.push(['未纳入确认统计的最终字段',IMPACT.unresolvedFieldCount]);
  if(IMPACT.truncated)rows.push(['原始血缘截断','是']);
  return rows;
}
function renderImpactGraph(){
  impactTreeStats.querySelector('tbody').innerHTML=impactTreeStatsRows().map(([label,value])=>'<tr><th scope="row">'+esc(label)+'</th><td>'+esc(value)+'</td></tr>').join('');
  impactTree.textContent=IMPACT_TREE;
  const notes=['统计基于 root 可达且非 UNRESOLVED 的 VALUE_FLOW；同一字段经过同一节点只计一次。'];
  if(IMPACT.unresolvedFieldCount)notes.push('未纳入确认统计：'+IMPACT.unresolvedFieldCount+' 个最终字段');
  if(IMPACT.truncated)notes.push('原始血缘存在截断，影响范围可能不完整。');
  impactNote.textContent=notes.join(' ');
  if(!IMPACT.tasks.length){
    impactGraph.style.width='100%';impactGraph.style.height='auto';impactCards.innerHTML='<div class="impact-empty">没有可展示的有效字段影响范围。</div>';return;
  }
  const layers=impactLayers(),cardWidth=210,columnWidth=250,rowHeight=120,padding=16;
  const positions=new Map(),maxRows=Math.max(...layers.map((layer)=>layer.length));
  layers.forEach((layer,layerIndex)=>layer.forEach((taskId,rowIndex)=>positions.set(taskId,{x:padding+layerIndex*columnWidth,y:padding+rowIndex*rowHeight})));
  const width=Math.max(720,padding*2+Math.max(1,layers.length)*columnWidth),height=Math.max(300,padding*2+maxRows*rowHeight);
  impactGraph.style.width=width+'px';impactGraph.style.height=height+'px';impactSvg.setAttribute('width',String(width));impactSvg.setAttribute('height',String(height));
  impactCards.innerHTML=IMPACT.tasks.map(impactCardHtml).join("");
  impactCards.querySelectorAll(".impact-card").forEach((card)=>{const position=positions.get(card.dataset.taskId);card.style.left=position.x+'px';card.style.top=position.y+'px'});
  impactSvg.querySelectorAll(".impact-edge").forEach((edge)=>edge.remove());
  IMPACT.edges.forEach((edge)=>{
    const from=positions.get(edge.fromTaskId),to=positions.get(edge.toTaskId);if(!from||!to)return;
    const group=document.createElementNS("http://www.w3.org/2000/svg","g");group.setAttribute("class","impact-edge");
    const path=document.createElementNS("http://www.w3.org/2000/svg","path"),startX=from.x+cardWidth,startY=from.y+48,endX=to.x,endY=to.y+48,curve=Math.max(24,(endX-startX)/2);
    path.setAttribute("d","M"+startX+" "+startY+" C"+(startX+curve)+" "+startY+" "+(endX-curve)+" "+endY+" "+endX+" "+endY);path.setAttribute("marker-end","url(#impact-arrow)");group.appendChild(path);
    impactSvg.appendChild(group);
  });
}
function switchView(view){
  const isImpact=view==='impact';app.classList.toggle('view-hidden',isImpact);impactView.classList.toggle('view-hidden',!isImpact);document.querySelectorAll('.view-tab').forEach((tab)=>tab.setAttribute('aria-selected',String(tab.dataset.view===view)));if(isImpact)renderImpactGraph();
}
document.querySelectorAll('.view-tab').forEach((tab)=>tab.addEventListener('click',()=>switchView(tab.dataset.view)));
function pathsFrom(rootId,limit=32){
  const result=[];
  let truncated=false;
  const walk=(nodeId,path,edgePath,active)=>{
    if(result.length>=limit){truncated=true;return}
    const incoming=edgesByTo.get(nodeId)||[];
    if(incoming.length===0){result.push({nodes:path,edges:edgePath,cycle:false});return}
    let expanded=false;
    for(const edge of incoming){
      if(result.length>=limit)break;
      const next=edge.fromNodeId;
      if(active.has(next)){
        result.push({nodes:[...path,next],edges:[...edgePath,edge],cycle:true});
        continue;
      }
      if(!nodeById.has(next))continue;
      expanded=true;walk(next,[...path,next],[...edgePath,edge],new Set([...active,next]));
    }
    if(!expanded&&incoming.length>0)result.push({nodes:path,edges:edgePath,cycle:false});
  };
  walk(rootId,[rootId],[],new Set([rootId]));
  return {paths:result,truncated};
}
function renderCounts(){
  const items=[[DATA.counts.nodes,"节点"],[DATA.counts.edges,"值流边"],[DATA.counts.datasetControls,"数据集控制"],[DATA.counts.candidates,"候选"],[DATA.counts.gaps,"缺口"]];
  counts.innerHTML=items.map(([value,label])=>'<div class="count"><strong>'+esc(value)+'</strong><span>'+label+'</span></div>').join("");
}
function renderFields(selected){
  fieldList.innerHTML=fields.map((field)=>'<button type="button" class="field" data-field="'+esc(field)+'" aria-pressed="'+(field===selected)+'">'+esc(field)+'</button>').join("");
  fieldList.querySelectorAll("button").forEach((button)=>button.addEventListener("click",()=>render(selected=button.dataset.field)));
}
function pathTaskGroups(path){
  const groups=[];
  path.nodes.forEach((id,nodeIndex)=>{
    const node=nodeById.get(id);if(!node)return;
    const last=groups[groups.length-1];
    const item={node,nodeIndex};
    if(last&&last.taskId===node.taskId)last.nodes.push(item);
    else groups.push({taskId:node.taskId,taskName:node.taskName,nodes:[item]});
  });
  return groups;
}
function pathTaskChain(path){
  return pathTaskGroups(path).slice().reverse().map((group)=>group.taskId).join(" → ");
}
function humanPathNodes(path){
  const result=[];
  path.nodes.map((id)=>nodeById.get(id)).filter(Boolean).reverse().forEach((node)=>{
    const key=node.taskId+'|'+node.field.qualifiedName+'|'+node.field.column;
    const last=result[result.length-1];
    if(!last||last.key!==key)result.push({key,node});
  });
  return result.map((item)=>item.node);
}
function semanticPathKey(path){
  const nodes=humanPathNodes(path).map((node)=>node.taskId+'|'+node.field.qualifiedName+'|'+node.field.column).join(' -> ');
  const mappings=path.edges.slice().reverse().map((edge)=>edge.mapping).join(' | ');
  return nodes+' || '+mappings;
}
function groupPathsBySemantic(paths){
  const groups=new Map();
  paths.forEach((path)=>{
    const key=semanticPathKey(path);
    const group=groups.get(key)||{key,paths:[]};
    group.paths.push(path);groups.set(key,group);
  });
  return [...groups.values()];
}
function routeGroupTitle(group){
  const first=group.paths[0];
  if(!first)return "Task 链";
  return pathTaskChain(first);
}
function formatExpression(value){
  return String(value??"")
    .replace(/\\s+WHEN\\s+/gi,"\\nWHEN ")
    .replace(/\\s+ELSE\\s+/gi,"\\nELSE ")
    .replace(/\\s+END\\b/gi,"\\nEND")
    .replace(/\\s+THEN\\s+/gi," THEN ")
    .trim();
}
function operationLabel(value){
  const text=String(value??"");
  if(/^UNION_OUTPUT/i.test(text))return "UNION 输出";
  if(/^CASE WHEN/i.test(text))return "CASE 条件映射";
  return text.length>42?"字段表达式":text;
}
function branchStatus(paths){
  const edgeStatuses=[...new Set(paths.flatMap((path)=>path.edges.map((edge)=>edge.evidenceStatus)))];
  if(edgeStatuses.length)return edgeStatuses.join('、');
  const inputStatuses=[...new Set(paths.flatMap((path)=>path.nodes.map((id)=>nodeById.get(id)).filter(Boolean).map((node)=>node.inputDependencyStatus).filter(Boolean)))];
  if(inputStatuses.includes('NO_PHYSICAL_INPUT'))return 'NO_PHYSICAL_INPUT（常量/无上游输入）';
  if(inputStatuses.includes('DERIVED_OUTPUT')&&paths.every((path)=>path.edges.length===0))return 'NO_PHYSICAL_INPUT（常量/系统值，无上游字段）';
  if(inputStatuses.length)return inputStatuses.join('、');
  const nodeStatuses=[...new Set(paths.flatMap((path)=>path.nodes.map((id)=>nodeById.get(id)).filter(Boolean).map((node)=>node.evidenceStatus)))];
  return nodeStatuses.join('、')||'UNRESOLVED';
}
function pathEvidenceStatus(path){
  const statuses=[...path.nodes.map((id)=>nodeById.get(id)?.evidenceStatus),...path.edges.map((edge)=>edge.evidenceStatus)].filter(Boolean);
  if(statuses.includes('UNRESOLVED'))return 'UNRESOLVED';
  if(statuses.includes('PROVISIONAL_LEGACY'))return 'PROVISIONAL_LEGACY';
  return statuses.length?'CONFIRMED':'UNRESOLVED';
}
function confirmedPath(path){return pathEvidenceStatus(path)==='CONFIRMED'}
function nodeEvidence(node){
  const source=String(node.bindingId||node.nodeId||"");
  const match=source.match(/slot:([^:]+):statement:(\d+):(\d+)/);
  const location=match?"slot "+match[1]+" · statement "+match[2]+" · ordinal "+match[3]:"binding位置未解析";
  const tags=[];
  if(node.field.identityStatus==="TASK_LOCAL_SCHEMA_BACKED")tags.push("TASK_LOCAL");
  if(node.expressionText&&node.expressionText!=="字段绑定")tags.push(node.expressionText);
  return location+(tags.length?" · "+tags.join(" · "):"");
}
function mergeTaskGroups(paths){
  const first=pathTaskGroups(paths[0]);
  return first.map((group,groupIndex)=>{
    const nodes=[];
    const seen=new Set();
    paths.forEach((path)=>{
      const pathGroup=pathTaskGroups(path)[groupIndex];
      pathGroup?.nodes.forEach((item)=>{
        if(seen.has(item.node.nodeId))return;
        seen.add(item.node.nodeId);
        nodes.push({...item,path});
      });
    });
    return {...group,nodes};
  });
}
function taskGroupHtml(group,field){
  const nodes=group.nodes.slice().reverse();
  const fields=[];
  const mappings=new Set();
  nodes.forEach((item,displayIndex)=>{
    const label=nodeLabel(item.node);
    const edge=item.path.edges[item.nodeIndex];
    if(displayIndex>0&&edge?.mapping&&!mappings.has(edge.mapping)){
      mappings.add(edge.mapping);
      fields.push('<div class="field-link">'+esc(edge.mapping)+'</div>');
    }
    fields.push('<div class="task-field"><span class="task-field-name">'+esc(label.table)+'.'+esc(label.column)+'</span><small>'+esc(formatExpression(item.node.expressionText||"字段绑定"))+'</small></div>');
  });
  return '<div class="task-group"><div class="task-group-title">Task '+esc(group.taskId)+'</div>'+(group.taskName?'<span class="task-group-name">'+esc(group.taskName)+'</span>':'')+fields.join('')+'</div>';
}
function evidenceBranchHtml(path,index){
  const nodes=path.nodes.map((id)=>nodeById.get(id)).filter(Boolean).reverse();
  const edges=path.edges.slice().reverse();
  const hasTaskLocal=nodes.some((node)=>node.field.identityStatus==="TASK_LOCAL_SCHEMA_BACKED");
  const nodeLines=nodes.map((node,nodeIndex)=>'<div class="evidence-step"><strong>步骤 '+(nodeIndex+1)+' · Task '+esc(node.taskId)+'</strong><small>'+esc(node.field.qualifiedName)+'.'+esc(node.field.column)+' · '+esc(nodeEvidence(node))+'</small></div>').join('');
  const edgeLines=edges.map((edge,edgeIndex)=>'<div class="evidence-edge"><strong>边 '+(edgeIndex+1)+' · '+esc(edge.mapping)+'</strong><small>'+esc(edge.evidenceStatus)+' · '+(edge.evidenceRefs?.length||0)+' 个证据引用</small></div>').join('');
  const title='证据分支 '+(index+1)+' · '+edges.length+' 条 VALUE_FLOW 边'+(hasTaskLocal?' · 含 TASK_LOCAL':'');
  return '<details class="evidence"><summary>'+title+'</summary><div class="evidence-body"><div class="evidence-meta">节点操作顺序：上游 → 下游</div>'+nodeLines+edgeLines+'</div></details>';
}
function flowCardHtml(node,index,total){
  const label=index===0?'来源':index===total-1?'目标':'处理/读取';
  const className=index===0?'flow-card-source':index===total-1?'flow-card-target':'flow-card-middle';
  const operation=node.expressionText&&node.expressionText!=="字段绑定"?node.expressionText:node.field.identityStatus==="TASK_LOCAL_SCHEMA_BACKED"?'临时表字段':'字段绑定';
  return '<div class="flow-card '+className+'"><div class="flow-card-label">'+label+'</div><div class="flow-card-task">Task '+esc(node.taskId)+'</div><div class="flow-card-table">'+esc(node.field.qualifiedName)+'</div><div class="flow-card-column">'+esc(node.field.column)+'</div><div class="flow-card-op">'+esc(operation)+'</div></div>';
}
function taskFlowHtml(paths,field){
  const groups=mergeTaskGroups(paths).slice().reverse();
  const pieces=[];
  groups.forEach((group,groupIndex)=>{
    pieces.push(taskGroupHtml(group,field));
    if(groupIndex<groups.length-1){
      const currentIds=new Set(group.nodes.map((item)=>item.node.nodeId));
      const downstream=groups[groupIndex+1];
      const downstreamIds=new Set(downstream.nodes.map((item)=>item.node.nodeId));
      const mappings=[...new Set(paths.flatMap((path)=>path.edges.filter((edge)=>currentIds.has(edge.fromNodeId)&&downstreamIds.has(edge.toNodeId)).map((edge)=>edge.mapping).filter(Boolean)))];
      pieces.push('<div class="task-bridge" aria-label="跨 Task 字段桥接"><strong>→</strong><small>跨 Task<br>'+(mappings.length?mappings.map((mapping)=>esc(mapping)).join('<br>'):'字段桥接')+'</small></div>');
    }
  });
  return pieces.join('');
}
function semanticBranchHtml(group,index,field){
  const first=group.paths[0];
  const flow=taskFlowHtml(group.paths,field);
  const operations=[...new Set(group.paths.flatMap((path)=>path.nodes.map((id)=>nodeById.get(id)).filter(Boolean).flatMap((node)=>{
    const values=[];
    if(node.field.identityStatus==="TASK_LOCAL_SCHEMA_BACKED")values.push('临时表物化');
    if(node.expressionText&&node.expressionText!=="字段绑定")values.push(node.expressionText);
    return values;
  })))];
  const statusText=branchStatus(group.paths);
  const tags=operations.length?operations.map((operation)=>'<span class="branch-tag">'+esc(operationLabel(operation))+'</span>').join(''):'<span class="branch-tag">字段直传</span>';
  return '<div class="semantic-branch"><div class="semantic-title">来源分支 '+(index+1)+' · '+group.paths.length+' 条原始证据</div><div class="flow-cards task-flow">'+flow+'</div><div class="branch-tags">'+tags+'</div><div class="semantic-meta">证据状态：'+esc(statusText)+' · 原始证据保留在下方技术详情</div><details class="technical-evidence"><summary>查看技术证据</summary><div class="evidence-list">'+group.paths.map(evidenceBranchHtml).join('')+'</div></details></div>';
}
function routeGroupHtml(group,index,field,provisional){
  const statusText=branchStatus(group.paths);
  const operations=[...new Set(group.paths.flatMap((path)=>path.nodes.map((id)=>nodeById.get(id)).filter(Boolean).flatMap((node)=>{
    const values=[];
    if(node.field.identityStatus==="TASK_LOCAL_SCHEMA_BACKED")values.push('临时表物化');
    if(node.expressionText&&node.expressionText!=="字段绑定")values.push(node.expressionText);
    return values;
  })))];
  const tags=operations.length?operations.map((operation)=>'<span class="branch-tag">'+esc(operationLabel(operation))+'</span>').join(''):'<span class="branch-tag">字段直传</span>';
  const className=provisional?'branch-detail provisional':'branch-detail';
  const label=provisional?'临时证据 ':'确认分支 ';
  return '<details class="'+className+'"><summary><span class="branch-summary-index">'+label+(index+1)+'</span><span class="branch-summary-chain">'+esc(routeGroupTitle(group))+'</span><span class="branch-summary-meta">'+group.paths.length+' 条证据 · '+esc(statusText)+'</span></summary><div class="branch-detail-body"><div class="route"><div class="route-summary">同一语义路径合并展示 · '+group.paths.length+' 条原始证据</div><div class="flow-cards task-flow">'+taskFlowHtml(group.paths,field)+'</div><div class="branch-tags">'+tags+'</div><div class="semantic-meta">证据状态：'+esc(statusText)+' · 原始证据保留在下方技术详情</div><details class="technical-evidence"><summary>查看技术证据（'+group.paths.length+' 条）</summary><div class="evidence-list">'+group.paths.map(evidenceBranchHtml).join('')+'</div></details></div></div></details>';
}
function multiBranchOverviewHtml(field,root,confirmedGroups,provisionalGroups,confirmedPathCount,provisionalPathCount){
  const target=root?root.field.qualifiedName+'.'+root.field.column:field;
  const confirmed = confirmedGroups.length
    ? '<div class="lineage-section"><div class="lineage-section-title">已确认值流 · '+confirmedGroups.length+' 条分支</div><div class="branch-list">'+confirmedGroups.map((group,index)=>routeGroupHtml(group,index,field,false)).join('')+'</div></div>'
    : '<div class="empty">暂无 CONFIRMED 主路径。临时/历史证据不会冒充已确认值流。</div>';
  const provisional = provisionalGroups.length
    ? '<details class="provisional-section" open><summary>临时 / 历史证据 · '+provisionalGroups.length+' 条分支 · '+provisionalPathCount+' 条路径</summary><div class="provisional-note">这些路径来自 legacy 或非完整证据，只用于审阅候选来源，不计入已确认主路径。</div><div class="branch-list">'+provisionalGroups.map((group,index)=>routeGroupHtml(group,index,field,true)).join('')+'</div></details>'
    : '';
  return '<div class="lineage-overview"><div class="overview-header"><div><div class="overview-kicker">多分支汇聚</div><div class="overview-title">'+esc(field)+'</div><div class="overview-target">目标绑定：'+esc(target)+'</div></div><div class="overview-summary">'+confirmedGroups.length+' 条确认分支<br>'+provisionalGroups.length+' 条临时证据分支<br>'+String(confirmedPathCount+provisionalPathCount)+' 条原始证据</div></div>'+confirmed+provisional+'</div>';
}
function renderCandidates(field){
  const items=DATA.candidates.filter((candidate)=>!candidate.field||candidate.field.column===field);
  candidateBox.innerHTML=items.length?items.map((candidate)=>'<div class="candidate">'+esc(candidate.consumerTaskId)+' ← '+esc(candidate.producerTaskId)+' · '+esc(candidate.field?.qualifiedName||"物理字段未解析")+'.'+esc(candidate.field?.column||'')+'<small>'+esc(candidate.reasonCode)+'</small></div>').join(""):'<div class="empty">当前字段没有候选 producer</div>';
}
function renderDatasetControls(){
  const items=DATA.datasetControls||[];
  datasetControlBox.innerHTML=items.length?items.map((control)=>{
    const field=control.field?esc(control.field.qualifiedName)+'.'+esc(control.field.column):'控制字段未解析';
    return '<div class="control">'+esc(control.taskId)+' · '+esc(control.subtype)+' · '+field+'<small>grain='+esc(control.grain)+(control.grainReason?' / '+esc(control.grainReason):'')+' · '+esc(control.evidenceStatus)+(control.reasonCode?' / '+esc(control.reasonCode):'')+'</small></div>';
  }).join(""):'<div class="empty">没有可证明数据集控制</div>';
}
function renderTableEdges(pathNodeIds){
  const reachableTasks=new Set([...pathNodeIds].map((id)=>nodeById.get(id)?.taskId).filter(Boolean));
  const items=DATA.tableEdges.filter((edge)=>reachableTasks.has(edge.consumerTaskId)&&reachableTasks.has(edge.producerTaskId));
  tableBox.innerHTML=items.length?items.map((edge)=>'<div class="table-edge">'+esc(edge.consumerTaskId)+' ← '+esc(edge.producerTaskId)+'<small>'+esc(edge.classification)+'</small></div>').join(""):'<div class="empty">没有表级关系</div>';
}
function render(field){
  const roots=DATA.rootNodeIds.map((id)=>nodeById.get(id)).filter((node)=>node&&node.field.column===field);
  const pathResults=roots.map((node)=>pathsFrom(node.nodeId));
  const paths=pathResults.flatMap((result)=>result.paths);
  const confirmedPaths=paths.filter(confirmedPath);
  const provisionalPaths=paths.filter((path)=>!confirmedPath(path));
  const confirmedGroups=groupPathsBySemantic(confirmedPaths);
  const provisionalGroups=groupPathsBySemantic(provisionalPaths);
  const root=roots[0];
  renderFields(field);renderCandidates(field);renderDatasetControls();
  const pathNodeIds=new Set(paths.flatMap((path)=>path.nodes));renderTableEdges(pathNodeIds);
  const pathNote=pathResults.some((result)=>result.truncated)?'<div class="note">当前页面只显示每个根绑定最多 32 条路径；完整路径仍保留在 JSON 产物中。</div>':'';
  routes.innerHTML=pathNote+(paths.length?multiBranchOverviewHtml(field,root,confirmedGroups,provisionalGroups,confirmedPaths.length,provisionalPaths.length):'<div class="empty">当前字段没有可展示的 VALUE_FLOW 路径</div>');
  bindCodeSteps(routes);
  status.innerHTML='当前字段：<strong>'+esc(field)+'</strong> · '+confirmedGroups.length+' 条已确认值流 · '+provisionalGroups.length+' 条临时证据 · '+paths.length+' 条证据路径';
  detailSource.textContent=root?'目标绑定：Task '+root.taskId+' · '+root.field.qualifiedName+'.'+root.field.column:"目标字段绑定未找到";
  detailEvidence.textContent='证据状态：'+(root?.evidenceStatus||"UNRESOLVED")+' · gaps='+DATA.counts.gaps+(DATA.limits.truncated?' · 截断：'+DATA.limits.reasons.join("、"):"");
}
renderCounts();render(fields[0]||"");
</script>
</body>
</html>
`;
}

export interface FieldLineageVisualizationOptions {
  readonly artifactPath: string;
  readonly outputPath: string;
  /** Optional existing Machine Facts root used to enrich the static HTML view. */
  readonly factsRoot?: string;
}

export function visualizeFieldLineage(
  options: FieldLineageVisualizationOptions,
): string {
  const artifactPath = resolve(options.artifactPath);
  const outputPath = resolve(options.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    renderFieldLineageHtml(readArtifact(artifactPath), options.factsRoot),
    "utf8",
  );
  return outputPath;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function main(): void {
  const argv = process.argv.slice(2);
  const artifactPath = option(argv, "--artifact");
  const outputPath = option(argv, "--output");
  const factsRoot = option(argv, "--facts-root");
  if (!artifactPath || !outputPath)
    throw new Error(
      "usage: field-lineage-visualize --artifact <field-lineage.json> --output <field-lineage.html> [--facts-root <field-facts>]",
    );
  process.stdout.write(
    `${JSON.stringify({ output: visualizeFieldLineage({ artifactPath, outputPath, factsRoot }) })}\n`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) main();
