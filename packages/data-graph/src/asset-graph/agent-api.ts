import {
  readJson,
  type Evidence,
  type PreparedManifest,
} from "./evidence-json.ts";
import type { AssetGraphStore } from "./store.ts";
export async function processingDetail(
  store: AssetGraphStore,
  input: {
    taskId: string;
    text?: string;
    relationId?: string;
    offset?: number;
    limit?: number;
    sql?: boolean;
    slot?: string;
    lineStart?: number;
    lineCount?: number;
  },
) {
  const state = await store.ready(),
    m = readJson<PreparedManifest>(String(state.manifestPath)),
    task = m.tasks.find((t) => t.taskId === input.taskId);
  if (!task) throw new Error("TASK_NOT_IN_PUBLISHED_GRAPH");
  const evidence = readJson<Evidence>(task.evidencePath),
    text = (input.text ?? "").toLowerCase(),
    offset = input.offset ?? 0,
    limit = input.limit ?? 25;
  const relation = input.relationId
    ? evidence.relations.find((r) => r.relation_id === input.relationId)
    : undefined;
  if (input.relationId && !relation)
    throw new Error("RELATION_NOT_IN_TASK_EVIDENCE");
  const expressions = evidence.expressions
    .filter(
      (e) =>
        (!input.relationId || e.relation_id === input.relationId) &&
        (!text ||
          String(e.expression_text ?? "")
            .toLowerCase()
            .includes(text)),
    )
    .map((e) => ({
      expressionId: e.expression_id,
      relationId: e.relation_id,
      outputName: e.output_name,
      expression: e.expression_text,
      role: e.role,
      inputDependencyStatus: e.input_dependency_status ?? null,
      inputFields: e.input_fields ?? [],
      sourceSpan: e.source_span ?? null,
    }));
  const rows = expressions.slice(offset, offset + limit);
  const sources = input.sql
    ? evidence.sqlSources
        .filter((s) => !input.slot || s.slot === input.slot)
        .map((s) => {
          const lines = s.content.split(/\r?\n/),
            start = input.lineStart ?? 1,
            count = input.lineCount ?? 80;
          return {
            slot: s.slot,
            sha256: s.sha256,
            totalLines: lines.length,
            lineStart: start,
            lineEnd: Math.min(lines.length, start + count - 1),
            content: lines.slice(start - 1, start + count - 1).join("\n"),
            nextLine: start + count <= lines.length ? start + count : null,
          };
        })
    : undefined;
  return {
    taskId: task.taskId,
    taskName: task.taskName,
    coverage: task.coverageStatus,
    expressions: rows,
    // Exact task-local relation evidence, not an inferred field causal path.
    relation: relation
      ? {
          relationId: relation.relation_id,
          statementId: relation.statement_id ?? null,
          kind: relation.relation_type,
          provenance: relation.provenance ?? null,
          definition: relation.relation ?? null,
          sourceSpan: relation.source_span ?? null,
          sourceText: relation.source_text ?? null,
        }
      : undefined,
    pagination: {
      offset,
      limit,
      total: expressions.length,
      nextOffset: offset + limit < expressions.length ? offset + limit : null,
    },
    sqlSources: sources,
    evidence: {
      projectionPath: task.path,
      projectionContentHash: task.contentHash,
      detailsPath: task.evidencePath,
      version: state.version,
    },
  };
}
export { CLI_HELP } from "./cli-help.ts";
