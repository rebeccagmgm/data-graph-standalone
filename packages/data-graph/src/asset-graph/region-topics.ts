import { clusterParams, clusterTaskPredicate } from "./cluster-filter.ts";
import type { AssetGraphStore } from "./store.ts";
import type { SchedulerTaskNameResolver } from "./scheduler-task-names.ts";
import { normalizeHiddenTables } from "./node-visibility.ts";
import { compileScopePatterns } from "./experimental-upstream-scope/pattern.ts";
import { cachedUpstreamScope } from "./experimental-upstream-scope/endpoint.ts";

export async function regionTopics(store: Pick<AssetGraphStore, "ready" | "run">, resolver: Pick<SchedulerTaskNameResolver, "resolveTopics" | "resolveTopicDescriptions">, query: URLSearchParams, clusterTaskIds?: string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const schema = query.get("schema") ?? "";
  const batch = query.has("schemas");
  const schemaInput: unknown = batch ? JSON.parse(query.get("schemas")!) : [schema];
  if (!Array.isArray(schemaInput) || !schemaInput.length || schemaInput.length > 100 || schemaInput.some(value => typeof value !== "string" || !value.trim() || value.length > 200)) throw new Error("INVALID_GRAPH_SCHEMA");
  if (!batch && !/^[A-Za-z0-9_]+$/.test(schema)) throw new Error("INVALID_GRAPH_SCHEMA");
  const schemas = [...new Set((schemaInput as string[]).map(value => value.toLowerCase()))];
  const hiddenTables = normalizeHiddenTables(JSON.parse(query.get("hiddenTables") ?? "[]"));
  const rawPatterns: unknown = JSON.parse(query.get("patterns") ?? "[]");
  if (!Array.isArray(rawPatterns)) throw new Error("INVALID_SCOPE_PATTERNS");
  const patterns = rawPatterns.length ? compileScopePatterns(rawPatterns).map(p => p.pattern) : [];
  const initial = await store.ready();
  signal?.throwIfAborted();
  const scope = patterns.length ? await cachedUpstreamScope(store, patterns) : undefined;
  signal?.throwIfAborted();
  if (scope && scope.version !== String(initial.version)) throw new Error("ASSET_GRAPH_CHANGED_DURING_QUERY");
  const result = await store.run(
    `MATCH (task:SLAssetNode {graphId:$graphId,kind:'TASK'})-[:SL_ASSET_EDGE {graphId:$graphId,kind:'WRITES_TABLE'}]->(n:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'}) WHERE ${clusterTaskPredicate("task")} AND toLower(split(coalesce(n.table,''),'.')[0]) IN $schemas AND NOT toLower(coalesce(n.table,'')) IN $hiddenTables AND ($scoped=false OR n.id IN $scopeIds) RETURN DISTINCT task.id AS taskId,toLower(split(n.table,'.')[0]) AS schema,collect(DISTINCT n.id) AS tableIds ORDER BY schema,taskId LIMIT $limit`,
    { ...clusterParams(clusterTaskIds), schemas, hiddenTables, scoped: Boolean(scope), scopeIds: scope?.tables.map(table => table.id) ?? [], limit: batch ? 20001 : 5001 },
  );
  const limit = batch ? 20000 : 5000;
  signal?.throwIfAborted();
  const rows = result.records.slice(0, limit).map(row => ({ id: String(row.get("taskId")).replace(/^task:/, ""), schema: batch ? String(row.get("schema")) : schema.toLowerCase(), tableIds: row.get("tableIds") as string[] }));
  const ids = [...new Set(rows.map(row => row.id))];
  const topics = resolver.resolveTopics(ids), descriptions = resolver.resolveTopicDescriptions(ids);
  const regions = schemas.map(name => {
    const members = rows.filter(row => row.schema === name);
    const values = new Map<string, { label: string; tables: Set<string> }>();
    for (const row of members) {
      const topic = topics[row.id];
      if (!topic) continue;
      const value = values.get(topic) ?? { label: descriptions[row.id] || topic, tables: new Set<string>() };
      for (const tableId of row.tableIds) value.tables.add(tableId);
      values.set(topic, value);
    }
    const allTopics = [...values].map(([name, value]) => ({ name, label: value.label, tableCount: value.tables.size }))
      .sort((a, b) => b.tableCount - a.tableCount || a.name.localeCompare(b.name));
    return { schema: name, topics: allTopics.slice(0, batch ? 2 : 100), total: allTopics.length, incomplete: values.size > (batch ? 20000 : 100) || result.records.length > limit || members.some(row => !topics[row.id]) };
  });
  if (String((await store.ready()).version) !== String(initial.version)) throw new Error("ASSET_GRAPH_CHANGED_DURING_QUERY");
  return batch ? { version: String(initial.version), regions } : { version: String(initial.version), ...regions[0] };
}
