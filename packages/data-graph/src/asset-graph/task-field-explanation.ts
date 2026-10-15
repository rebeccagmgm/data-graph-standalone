import type { Evidence } from "./evidence-json.ts";
import { classifyExpressionInputRoles } from "../../../../scripts/project-graph/task-local/expression-input-roles.ts";
import { buildFieldEvidenceIndexes } from "../../../../scripts/project-graph/task-local/field-evidence/field-evidence-emission.ts";
import { expandSetopBranchExpressions, resolveSourceReadOccurrence } from "../../../../scripts/project-graph/task-local/field-evidence/source-read-occurrence.ts";
import { relationSubtree } from "../../../../scripts/project-graph/task-local/field-evidence/relation-tree.ts";

type Row = Record<string, unknown>;
type Location = { slot: string; lineStart: number; lineEnd: number };
type DependencyKind = "VALUE" | "CONDITION" | "CONTROL";
export interface ProcessingStage {
  id: string;
  kind: "SOURCE" | "WRITE" | "BRANCH";
  table: string;
  writeId?: string;
  readOccurrenceId?: string;
  statementId?: string;
  statementIndex?: number;
  slot?: string;
  role: "FINAL" | "INTERMEDIATE" | "SOURCE";
  label?: string;
  expressions: { id: string; column: string; text: string; roles?: string[]; sourceLocation?: Location }[];
  controls: { id: string; kind: string; text: string; sourceLocation?: Location }[];
}
export interface TaskFieldExplanation {
  schemaVersion: "1.0.0";
  version: string;
  taskId: string;
  anchor: { writeId: string; column: string };
  status: "COMPLETE" | "PARTIAL" | "TRUNCATED";
  stages: ProcessingStage[];
  edges: { id: string; from: string; to: string; kind: DependencyKind | "MATERIALIZATION"; status: "RESOLVED" | "UNRESOLVED"; columns: string[]; expressionIds: string[]; label?: string }[];
  gaps: { code: string; message: string; stageId?: string }[];
  limits: { maxDepth: number; maxNodes: number; maxEdges: number };
  frontierStageIds: string[];
  stoppedBy: string[];
}
const text = (value: unknown): string => typeof value === "string" ? value : "";
const name = (value: unknown): string => text(value).trim().toLowerCase();
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
const key = (...values: string[]): string => JSON.stringify(values);

/** A bounded, read-only view of the exact frozen evidence; no SQL reparsing or
 * selection of a producer by table name. Write and read occurrence identities
 * survive presentation, including repeated writes and individual UNION arms. */
export function explainTaskField(
  evidence: Evidence,
  anchor: { taskId: string; writeId: string; column: string; version: string },
  options: Partial<TaskFieldExplanation["limits"]> = {},
  publishedProjectionGaps: readonly Readonly<Row>[] = [],
  publishedReadIdentities: ReadonlyMap<string, string> = new Map(),
): TaskFieldExplanation {
  if (!anchor.taskId.trim()) throw new Error("TASK_ID_REQUIRED");
  if (!anchor.writeId.trim()) throw new Error("WRITE_ID_REQUIRED");
  if (!anchor.column.trim()) throw new Error("COLUMN_REQUIRED");
  const limits = { maxDepth: 32, maxNodes: 500, maxEdges: 1000, ...options };
  for (const [k, max] of [["maxDepth", 64], ["maxNodes", 2000], ["maxEdges", 4000]] as const) {
    if (!Number.isSafeInteger(limits[k]) || limits[k] < 1 || limits[k] > max) throw new Error(`INVALID_EXPLANATION_LIMIT:${k}`);
  }
  const result: TaskFieldExplanation = {
    schemaVersion: "1.0.0", version: anchor.version, taskId: anchor.taskId,
    anchor: { writeId: anchor.writeId, column: anchor.column }, status: "COMPLETE",
    stages: [], edges: [], gaps: [], limits, frontierStageIds: [], stoppedBy: [],
  };
  const relationEdges = evidence.relations.flatMap(relation => {
    const body = row(relation.relation);
    return [text(body.source), text(body.left), text(body.right), ...strings(body.branches)].filter(Boolean)
      .map(source => ({ from_relation_id: source, to_relation_id: text(relation.relation_id) }));
  });
  const indexes = buildFieldEvidenceIndexes({ taskId: anchor.taskId, expressions: evidence.expressions, relationNodes: evidence.relations, relationEdges, datasetIoReads: evidence.datasetIo });
  const expressions = new Map(evidence.expressions.map(e => [text(e.expression_id), e]));
  const bindings = new Map(evidence.bindings.map(b => [text(b.binding_id), b]));
  const relations = new Map(evidence.relations.map(r => [text(r.relation_id), r]));
  const statements = new Map(evidence.statements.map(s => [text(s.statement_id), s]));
  const stages = new Map<string, ProcessingStage>();
  const edges = new Map<string, TaskFieldExplanation["edges"][number]>();
  const visited = new Set<string>();
  const active = new Set<string>();
  const controlSeen = new Set<string>();
  const representedReads = new Set<string>();
  const gapSeen = new Set<string>();
  const gap = (code: string, message: string, stageId?: string): void => {
    const id = key(code, message, stageId ?? "");
    if (gapSeen.has(id)) return;
    gapSeen.add(id); result.gaps.push({ code, message, stageId });
  };
  const stop = (code: string, stageId?: string): void => {
    if (!result.stoppedBy.includes(code)) result.stoppedBy.push(code);
    if (stageId && !result.frontierStageIds.includes(stageId)) result.frontierStageIds.push(stageId);
  };
  const addStage = (stage: ProcessingStage, frontier?: string): ProcessingStage | undefined => {
    const existing = stages.get(stage.id);
    if (existing) return existing;
    if (stages.size >= limits.maxNodes) { stop("MAX_NODES", frontier); return; }
    stages.set(stage.id, stage); return stage;
  };
  const addEdge = (from: string, to: string, kind: TaskFieldExplanation["edges"][number]["kind"], column: string, expressionId: string, label?: string): void => {
    if (!stages.has(from) || !stages.has(to)) return;
    const id = key(from, to, kind, expressionId);
    const old = edges.get(id);
    if (old) { if (column && !old.columns.includes(column)) old.columns.push(column); return; }
    if (edges.size >= limits.maxEdges) { stop("MAX_EDGES", to); return; }
    edges.set(id, { id, from, to, kind, status: "RESOLVED", columns: column ? [column] : [], expressionIds: expressionId ? [expressionId] : [], ...(label ? { label } : {}) });
  };
  const location = (statementId: string, fragment: string): Location | undefined => {
    // Offsets in normalized SQL are not offsets in raw createSql/querySql. Only
    // attach a line range if the exact frozen text has a unique occurrence.
    const slot = statementId.match(/:slot:([^:]+):/)?.[1];
    const source = evidence.sqlSources.find(s => s.slot === slot);
    if (!source || !fragment) return;
    const statementText = text(statements.get(statementId)?.raw_sql);
    const statementAt = statementText ? source.content.indexOf(statementText) : -1;
    const scoped = statementAt >= 0 && source.content.indexOf(statementText, statementAt + 1) < 0;
    const content = scoped ? statementText : source.content;
    const fragmentAt = content.indexOf(fragment);
    if (fragmentAt < 0 || content.indexOf(fragment, fragmentAt + 1) >= 0) return;
    const at = fragmentAt + (scoped ? statementAt : 0);
    return { slot: source.slot, lineStart: source.content.slice(0, at).split("\n").length, lineEnd: source.content.slice(0, at + fragment.length).split("\n").length };
  };
  const writeStage = (binding: Row, frontier?: string): ProcessingStage | undefined => {
    const writeId = text(binding.write_observation_id);
    if (!writeId) { gap("WRITE_ID_MISSING", text(binding.binding_id), frontier); return; }
    const statementId = text(binding.write_statement_id || binding.statement_id);
    const statement = statements.get(statementId);
    return addStage({ id: key("write", writeId), kind: "WRITE", table: text(binding.target_dataset), writeId,
      statementId, statementIndex: typeof statement?.statement_index === "number" ? statement.statement_index : undefined,
      slot: statementId.match(/:slot:([^:]+):/)?.[1], role: writeId === anchor.writeId ? "FINAL" : "INTERMEDIATE", expressions: [], controls: [] }, frontier);
  };
  const relationBody = (relationId: unknown): Row => row(relations.get(text(relationId))?.relation);

  const followInput = (input: Row, expression: Row, stage: ProcessingStage, kind: DependencyKind, depth: number, control?: Row): void => {
    const table = name(input.table ?? input.physical_dataset), column = name(input.column ?? input.name);
    if (!table || !column) { gap("PHYSICAL_INPUT_UNRESOLVED", text(expression.expression_id), stage.id); return; }
    const expressionId = text(expression.expression_id);
    const source = resolveSourceReadOccurrence({ taskId: anchor.taskId, expressionId, sourceTable: table, sourceColumn: column,
      inputField: input, expressionText: text(expression.expression_text), referenceQualifier: text(input.qualifier) || undefined,
      leafRelationId: text(control?.relation_id ?? expression.relation_id) || null,
      index: indexes.relationTree, readOccurrenceByRelationId: indexes.readOccurrenceByRelationId, bindingByReadRelation: indexes.bindingByReadRelation });
    // Read lookup and diagnostics stay in the raw SQL namespace. Only an exact,
    // confirmed published occurrence may translate it for bridge comparison.
    const bridgeTable = source.sourceReadOccurrenceStatus === "RESOLVED" && source.sourceReadOccurrenceId
      ? name(publishedReadIdentities.get(source.sourceReadOccurrenceId)) || table : table;
    const candidates = (evidence.materializations ?? []).filter(m => name(m.physical_dataset) === bridgeTable && name(m.column) === column && (
      control ? rows(m.read_control_refs).some(ref => ref.relation_id === control.relation_id &&
        (ref.resolution_status !== "RESOLVED" || ref.read_occurrence_id === source.sourceReadOccurrenceId))
        : strings(m.read_expression_ids).includes(expressionId)));
    if (candidates.length) {
      if (candidates.length !== 1 || candidates[0]!.status !== "RESOLVED") {
        gap(`MATERIALIZATION_${candidates.length !== 1 ? "AMBIGUOUS" : text(candidates[0]!.status) || "UNRESOLVED"}`, `${table}.${column}`, stage.id); return;
      }
      const bridge = candidates[0]!;
      if (control && !rows(bridge.read_control_refs).some(ref => ref.relation_id === control.relation_id && ref.resolution_status === "RESOLVED" && ref.read_occurrence_id === source.sourceReadOccurrenceId)) {
        gap("CONTROL_READ_OCCURRENCE_UNRESOLVED", `${table}.${column}`, stage.id); return;
      }
      if (bridge.producer_kind === "STATIC_PARTITION_ASSIGNMENT") {
        const writes = evidence.datasetIo.filter(io => io.direction === "WRITE" && io.write_observation_id === bridge.write_observation_id);
        const write = writes.length === 1 ? writes[0] : undefined;
        if (!write || write.resolution_status !== "RESOLVED" || name(write.physical_dataset) !== name(bridge.physical_dataset)) {
          gap("STATIC_PARTITION_WRITE_UNRESOLVED", text(bridge.bridge_id), stage.id); return;
        }
        const predecessor = writeStage({ ...write, target_dataset: bridge.physical_dataset }, stage.id);
        if (!predecessor) return;
        addEdge(predecessor.id, stage.id, kind, column, expressionId || text(control?.relation_id));
        if (source.sourceReadOccurrenceId) representedReads.add(key(stage.id, source.sourceReadOccurrenceId));
        const statement = statements.get(text(write.write_statement_id || write.statement_id));
        const assignmentText = text(statement?.raw_sql);
        if (!predecessor.expressions.some(e => e.id === bridge.bridge_id)) predecessor.expressions.push({ id: text(bridge.bridge_id), column, text: assignmentText || "静态分区赋值（原始语句缺失）", roles: ["STATIC_PARTITION_ASSIGNMENT"],
          sourceLocation: location(text(write.write_statement_id || write.statement_id), assignmentText) });
        if (!assignmentText) gap("STATIC_PARTITION_SQL_MISSING", text(bridge.bridge_id), predecessor.id);
        return;
      }
      const bindingIds = [...new Set([text(bridge.output_binding_id), ...strings(bridge.output_binding_ids)].filter(Boolean))];
      const writeIds = new Set([text(bridge.write_observation_id), ...strings(bridge.write_observation_ids)].filter(Boolean));
      const producers = bindingIds.map(id => bindings.get(id));
      if (!producers.length || producers.some(producer => !producer || producer.binding_status !== "RESOLVED" || !writeIds.has(text(producer.write_observation_id))
        || name(producer.target_dataset) !== name(bridge.physical_dataset) || name(producer.target_field) !== column)
        || writeIds.size !== new Set(producers.map(producer => text(producer?.write_observation_id))).size) {
        gap("MATERIALIZATION_PRODUCER_UNRESOLVED", text(bridge.bridge_id), stage.id); return;
      }
      for (const producer of producers as Row[]) {
        const predecessor = writeStage(producer, stage.id);
        if (!predecessor) continue;
        if (active.has(text(producer.binding_id))) { gap("MATERIALIZATION_CYCLE", text(bridge.bridge_id), stage.id); continue; }
        addEdge(predecessor.id, stage.id, kind, column, expressionId || text(control?.relation_id));
        if (source.sourceReadOccurrenceId) representedReads.add(key(stage.id, source.sourceReadOccurrenceId));
        visitBinding(producer, depth + 1, predecessor);
      }
      return;
    }
    if (source.sourceReadOccurrenceStatus !== "RESOLVED" || !source.sourceReadOccurrenceId) {
      gap(`READ_OCCURRENCE_${source.sourceReadOccurrenceStatus}`, `${table}.${column}`, stage.id); return;
    }
    // A missing local bridge is not proof of an external source. An explicit
    // read before any write (including reading the old target) remains a source.
    const readStatement = statements.get(text(expression.statement_id));
    const readIndex = readStatement?.statement_index;
    const priorLocalWrite = evidence.bindings.some(b => name(b.target_dataset) === bridgeTable && b.write_observation_id !== stage.writeId &&
      typeof readIndex === "number" && Number(statements.get(text(b.write_statement_id || b.statement_id))?.statement_index) < readIndex);
    if (priorLocalWrite) { gap("MATERIALIZATION_MISSING", `${table}.${column}`, stage.id); return; }
    if (depth >= limits.maxDepth) { stop("MAX_DEPTH", stage.id); return; }
    const sourceStage = addStage({ id: key("read", source.sourceReadOccurrenceId), kind: "SOURCE", table,
      readOccurrenceId: source.sourceReadOccurrenceId, statementId: text(expression.statement_id), role: "SOURCE", expressions: [], controls: [] }, stage.id);
    if (sourceStage) {
      addEdge(sourceStage.id, stage.id, kind, column, expressionId || text(control?.relation_id));
      representedReads.add(key(stage.id, source.sourceReadOccurrenceId));
    }
  };
  const addControls = (expression: Row, stage: ProcessingStage, depth: number): void => {
    for (const relationId of relationSubtree(indexes.relationTree, text(expression.relation_id))) {
      const relation = relations.get(relationId);
      if (!relation) { gap("RELATION_EVIDENCE_MISSING", relationId, stage.id); continue; }
      const kind = name(relation.relation_type), body = row(relation.relation);
      if (!["filter", "join", "aggregate", "window", "sort", "limit", "setop"].includes(kind)) continue;
      const id = key(stage.id, relationId);
      if (controlSeen.has(id)) continue;
      controlSeen.add(id);
      const controlText = text(body.predicate_display ?? body.condition_display ?? body.predicate_text ?? body.condition_text ?? body.display_text)
        || text(relation.source_text) || text(body.join_type ?? body.setop) || kind;
      stage.controls.push({ id: relationId, kind: kind.toUpperCase(), text: controlText,
        sourceLocation: location(text(relation.statement_id), controlText) });
      if (stage.kind === "BRANCH" && kind === "filter") stage.label = `UNION 分支 · ${controlText}`;
      if (kind !== "filter" && kind !== "join") continue;
      const inputs = rows(kind === "filter" ? body.predicate_columns : body.condition_columns);
      for (const input of inputs) {
        const physical = rows(input.physical);
        if (input.resolution !== "PHYSICAL" || !physical.length) { gap("CONTROL_INPUT_UNRESOLVED", relationId, stage.id); continue; }
        for (const field of physical) followInput({ ...field, qualifier: input.qualifier }, { ...expression, expression_id: "", expression_text: controlText }, stage, "CONTROL", depth, relation);
      }
    }
  };
  const addRowsetInputs = (expression: Row, stage: ProcessingStage, depth: number): void => {
    for (const relationId of relationSubtree(indexes.relationTree, text(expression.relation_id))) {
      const relation = indexes.relationTree.relations.get(relationId);
      if (relation?.relationType !== "read" || relation.sourceRelationId) continue;
      const occurrenceId = indexes.readOccurrenceByRelationId.get(relationId);
      if (occurrenceId && representedReads.has(key(stage.id, occurrenceId))) continue;
      const reads = evidence.datasetIo.filter(io => io.direction === "READ" && rows(io.read_occurrences).some(o => o.relation_id === relationId && o.occurrence_id === occurrenceId));
      if (!occurrenceId || reads.length !== 1 || reads[0]!.resolution_status !== "RESOLVED" || !relation.physicalDataset) {
        gap("ROWSET_READ_UNRESOLVED", relationId, stage.id); continue;
      }
      const readIndex = statements.get(text(expression.statement_id))?.statement_index;
      const bridgeTable = name(publishedReadIdentities.get(occurrenceId)) || name(reads[0]!.physical_dataset);
      const priorWrite = evidence.bindings.some(b => name(b.target_dataset) === bridgeTable && typeof readIndex === "number" && Number(statements.get(text(b.write_statement_id || b.statement_id))?.statement_index) < readIndex);
      if (priorWrite) {
        // A column bridge proves that column's producer, not the complete row
        // population consumed by COUNT(*) or a constant SELECT.
        gap("ROWSET_MATERIALIZATION_UNRESOLVED", relationId, stage.id); continue;
      }
      if (depth >= limits.maxDepth) { stop("MAX_DEPTH", stage.id); continue; }
      const source = addStage({ id: key("read", occurrenceId), kind: "SOURCE", table: text(reads[0]!.physical_dataset), readOccurrenceId: occurrenceId,
        statementId: text(expression.statement_id), role: "SOURCE", expressions: [], controls: [] }, stage.id);
      if (source) addEdge(source.id, stage.id, "CONTROL", "", text(expression.expression_id), "行集合");
    }
  };
  const visitExpression = (expression: Row, stage: ProcessingStage, depth: number): void => {
    if (edges.size >= limits.maxEdges) { stop("MAX_EDGES", stage.id); return; }
    const expressionId = text(expression.expression_id), body = relationBody(expression.relation_id);
    if (expression.role === "SETOP_OUTPUT") {
      const setops = [...relationSubtree(indexes.relationTree, text(expression.relation_id))]
        .map(id => relations.get(id)).filter((r): r is Row => !!r && name(r.relation_type) === "setop");
      if (!setops.length || setops.some(r => name(row(r.relation).setop) !== "union" || row(r.relation).all !== body.all)) {
        gap("SETOP_PROCESSING_UNSUPPORTED", expressionId, stage.id); return;
      }
      const operator = body.all === true ? "UNION ALL" : "UNION";
      if (!stage.expressions.some(e => e.id === expressionId)) stage.expressions.push({ id: expressionId, column: text(expression.output_name), text: text(expression.expression_text || expression.display_text), roles: ["SETOP_OUTPUT"] });
      stage.controls.push({ id: text(expression.relation_id), kind: "SETOP", text: operator });
      const branches = expandSetopBranchExpressions({ expression, expressionsByRelation: indexes.expressionsByRelation, index: indexes.relationTree });
      if (!branches.length || branches.every(b => b.expressionId === expressionId)) { gap("SETOP_BRANCH_UNRESOLVED", expressionId, stage.id); return; }
      for (const branch of branches) {
        const child = addStage({ ...stage, id: key("branch", stage.writeId ?? "", branch.relationId ?? branch.expressionId), kind: "BRANCH", role: "INTERMEDIATE", label: "UNION 分支", expressions: [], controls: [] }, stage.id);
        if (!child) continue;
        addEdge(child.id, stage.id, "MATERIALIZATION", text(expression.output_name), branch.expressionId, operator);
        visitExpression(branch.expression, child, depth);
      }
      return;
    }
    const roles = classifyExpressionInputRoles(expression, body);
    if (!stage.expressions.some(e => e.id === expressionId)) {
      const expressionText = text(expression.expression_text || expression.display_text);
      stage.expressions.push({ id: expressionId, column: text(expression.output_name), text: expressionText,
        roles: [...(roles.valueInputs.length ? ["VALUE"] : []), ...(roles.conditionalInputs.length ? ["CONDITION"] : []), ...(roles.terminalKind ? [roles.terminalKind] : [])],
        sourceLocation: location(text(expression.statement_id), expressionText) });
    }
    if (!roles.complete || roles.terminalKind === "UNKNOWN") gap(roles.reasonCode || "EXPRESSION_DEPENDENCY_UNRESOLVED", expressionId, stage.id);
    for (const input of roles.valueInputs) followInput(input, expression, stage, "VALUE", depth);
    for (const input of roles.conditionalInputs) followInput(input, expression, stage, "CONDITION", depth);
    addControls(expression, stage, depth);
    addRowsetInputs(expression, stage, depth);
  };
  function visitBinding(binding: Row, depth: number, stage: ProcessingStage): void {
    const id = text(binding.binding_id);
    if (depth > limits.maxDepth) { stop("MAX_DEPTH", stage.id); return; }
    if (visited.has(id)) return;
    visited.add(id); active.add(id);
    if (binding.binding_status !== "RESOLVED") gap("OUTPUT_BINDING_UNRESOLVED", id, stage.id);
    else {
      const expression = expressions.get(text(binding.expression_id));
      if (!expression) gap("EXPRESSION_MISSING", id, stage.id);
      else visitExpression(expression, stage, depth);
    }
    active.delete(id);
  }
  const roots = evidence.bindings.filter(b => b.write_observation_id === anchor.writeId && name(b.target_field) === name(anchor.column));
  if (roots.length !== 1) gap(roots.length ? "OUTPUT_BINDING_AMBIGUOUS" : "OUTPUT_BINDING_MISSING", `${anchor.writeId}.${anchor.column}`);
  else {
    const stage = writeStage(roots[0]!);
    if (stage) visitBinding(roots[0]!, 0, stage);
  }
  result.stages = [...stages.values()]; result.edges = [...edges.values()];
  // Frozen SQL names describe the processing path; the published projection
  // remains authoritative about physical identity. Carry only gaps whose exact
  // expression/control is in this slice, never all gaps from the task.
  for (const publishedGap of publishedProjectionGaps) {
    const details = row(publishedGap.details);
    const expressionId = text(details.expressionId), relationId = text(details.relationId);
    const affectedStages = result.stages.filter(stage =>
      (expressionId && stage.expressions.some(expression => expression.id === expressionId)) ||
      (relationId && stage.controls.some(control => control.id === relationId)));
    if (!affectedStages.length) continue;
    const unresolved = rows(details.unresolved);
    const message = unresolved.length ? unresolved.map(input => `${text(input.table)}.${text(input.column)}: ${text(input.reason)}`).join("; ")
      : text(details.reason) || relationId || expressionId;
    for (const stage of affectedStages) gap(text(publishedGap.reasonCode) || "PUBLISHED_EVIDENCE_UNRESOLVED", message, stage.id);
    for (const edge of result.edges) {
      if (!expressionId || !edge.expressionIds.includes(expressionId)) continue;
      const sourceStage = stages.get(edge.from);
      if (unresolved.some(input => name(input.table) === name(sourceStage?.table) && edge.columns.some(column => name(column) === name(input.column)))) edge.status = "UNRESOLVED";
    }
  }
  result.status = result.stoppedBy.length ? "TRUNCATED" : result.gaps.length ? "PARTIAL" : "COMPLETE";
  return result;
}
