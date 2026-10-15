import type { AssetGraphStore } from "./store.ts";
import { readJson, type Evidence, type PreparedManifest } from "./evidence-json.ts";
import { explainTaskField, type TaskFieldExplanation } from "./task-field-explanation.ts";
import { unpackTaskLocalProjectionEnvelope } from "../continuation/task-local-projection.ts";
import type { TaskLocalProjection } from "../../../../scripts/project-graph/task-local/contract.ts";

export async function queryTaskFieldExplanation(
  store: Pick<AssetGraphStore, "ready">,
  input: { taskId: string; writeId: string; column: string; publicationVersion?: string } & Partial<TaskFieldExplanation["limits"]>,
): Promise<TaskFieldExplanation> {
  const publication = await store.ready();
  const version = String(publication.version);
  if (input.publicationVersion && input.publicationVersion !== version) throw new Error("PUBLICATION_VERSION_MISMATCH");
  const manifest = readJson<PreparedManifest>(String(publication.manifestPath));
  const task = manifest.tasks.find(t => t.taskId === input.taskId);
  if (!task) throw new Error("TASK_NOT_PUBLISHED");
  const limits: Partial<TaskFieldExplanation["limits"]> = {};
  for (const key of ["maxDepth", "maxNodes", "maxEdges"] as const) if (input[key] !== undefined) limits[key] = input[key];
  const envelope = readJson<{ projection: TaskLocalProjection }>(task.path);
  // The continuation reader validates the envelope but intentionally returns a
  // reduced projection shape. Keep diagnostic gaps from the validated original.
  unpackTaskLocalProjectionEnvelope({ envelope, manifestTaskContentHash: task.contentHash });
  if (envelope.projection.taskId !== input.taskId) throw new Error("PUBLISHED_TASK_ID_MISMATCH");
  const projectionGaps = envelope.projection.gaps;
  const readNodes = new Map<string, typeof envelope.projection.nodes[number][]>();
  for (const node of envelope.projection.nodes) {
    if (node.nodeType !== "READ_OCCURRENCE" || typeof node.properties.occurrenceId !== "string") continue;
    const occurrenceId = node.properties.occurrenceId;
    readNodes.set(occurrenceId, [...(readNodes.get(occurrenceId) ?? []), node]);
  }
  const readIdentities = new Map<string, string>();
  for (const [occurrenceId, reads] of readNodes) {
    if (reads.length === 1 && reads[0]!.properties.identityStatus === "CONFIRMED" && typeof reads[0]!.properties.physicalDataset === "string")
      readIdentities.set(occurrenceId, reads[0]!.properties.physicalDataset);
  }
  const result = explainTaskField(readJson<Evidence>(task.evidencePath), { taskId: input.taskId, writeId: input.writeId, column: input.column, version }, limits,
    projectionGaps ?? [], readIdentities);
  // Use the published occurrence identity, never a second table-name resolver.
  for (const stage of result.stages) {
    if (!stage.readOccurrenceId) continue;
    const table = readIdentities.get(stage.readOccurrenceId);
    if (table) stage.table = table;
  }
  return result;
}
