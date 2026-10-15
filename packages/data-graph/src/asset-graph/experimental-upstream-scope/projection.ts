import { classifyRegion, PROCESSING_STAGES } from "../overview.ts";
import { normalizeHiddenTables } from "../node-visibility.ts";
import type { UpstreamClosure } from "./closure.ts";

/** Hiding is applied after closure: hidden intermediates do not stop ancestry. */
export function projectUpstreamScope(closure: UpstreamClosure, hiddenInput: unknown = []) {
  const hidden = new Set(normalizeHiddenTables(hiddenInput));
  const tables = closure.tables.filter(table => !hidden.has(table.table.toLowerCase()));
  const ids = new Set(tables.map(table => table.id));
  const schema = (name: string) => name.includes(".") && name.split(".")[0] && name.split(".")[1] ? name.split(".")[0] : undefined;
  const schemas = new Map(tables.map(table => [table.id, schema(table.table)]));
  const regions = new Map<string, number>();
  for (const table of tables) {
    const name = schemas.get(table.id);
    if (name) regions.set(name, (regions.get(name) ?? 0) + 1);
  }
  const flows = new Map<string, { fromSchema: string; toSchema: string; tasks: Set<string> }>();
  const links = closure.links.filter(link => ids.has(link.source) && ids.has(link.target));
  for (const link of links) {
    const fromSchema = schemas.get(link.source), toSchema = schemas.get(link.target);
    if (!fromSchema || !toSchema || fromSchema === toSchema) continue;
    const key = JSON.stringify([fromSchema, toSchema]);
    const entry = flows.get(key) ?? { fromSchema, toSchema, tasks: new Set<string>() };
    entry.tasks.add(link.task);
    flows.set(key, entry);
  }
  const allRegions = [...regions].map(([schema, datasetCount]) => ({ schema, datasetCount, stage: classifyRegion(schema) }))
    .sort((a, b) => b.datasetCount - a.datasetCount || a.schema.localeCompare(b.schema));
  const displayedRegions = allRegions.slice(0, 100);
  const displayedSchemas = new Set(displayedRegions.map(region => region.schema));
  const allFlows = [...flows.values()].filter(flow => displayedSchemas.has(flow.fromSchema) && displayedSchemas.has(flow.toSchema))
    .map(flow => ({ fromSchema: flow.fromSchema, toSchema: flow.toSchema, fromStage: classifyRegion(flow.fromSchema), toStage: classifyRegion(flow.toSchema), taskCount: flow.tasks.size, evidenceKind: "TABLE_IO" as const }))
    .sort((a, b) => b.taskCount - a.taskCount || a.fromSchema.localeCompare(b.fromSchema) || a.toSchema.localeCompare(b.toSchema));
  return {
    tables,
    overview: {
      version: closure.version, stages: PROCESSING_STAGES,
      regions: displayedRegions, flows: allFlows.slice(0, 150),
      limits: { regions: 100, flows: 150 },
      truncated: { regions: allRegions.length > 100, flows: allFlows.length > 150 },
      excluded: { unqualifiedDatasets: tables.filter(table => !schemas.get(table.id)).length },
      scope: { status: "COMPLETE" as const, patterns: closure.patterns, rootCount: closure.roots.length, tableCount: closure.tables.length, visibleTableCount: tables.length, relationCount: closure.links.length, visibleRelationCount: links.length },
    },
  };
}
