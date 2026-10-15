import type { AssetGraphStore } from "../store.ts";
import { compileScopePatterns } from "./pattern.ts";

export type ScopeStore = Pick<AssetGraphStore, "ready" | "run">;
export type ScopeTable = { id: string; table: string; label: string };
export type ScopeLink = { source: string; target: string; task: string };
export type UpstreamClosure = {
  version: string; patterns: string[]; roots: string[];
  tables: ScopeTable[]; links: ScopeLink[];
};
export const SCOPE_LIMITS = { roots: 1000, tables: 20000, links: 100000, milliseconds: 30000 };

/** Enumerate table-IO ancestors only. No task siblings or schedule traversal. */
export async function collectUpstreamScope(store: ScopeStore, input: unknown): Promise<UpstreamClosure> {
  const patterns = compileScopePatterns(input);
  const start = Date.now();
  const initial = await store.ready();
  const roots = await store.run(
    "MATCH (n:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'}) WHERE any(p IN $patterns WHERE (CASE WHEN p.qualified THEN toLower(coalesce(n.table,'')) ELSE toLower(last(split(coalesce(n.table,''),'.'))) END) =~ p.regex) RETURN n.id AS id,n.table AS table,n.label AS label ORDER BY n.id LIMIT $limit",
    { patterns, limit: SCOPE_LIMITS.roots + 1 },
  );
  if (roots.records.length > SCOPE_LIMITS.roots) throw new Error("UPSTREAM_SCOPE_ROOT_LIMIT");
  const tables = new Map<string, ScopeTable>(roots.records.map(row => {
    const id = String(row.get("id"));
    return [id, { id, table: String(row.get("table") ?? ""), label: String(row.get("label") ?? row.get("table") ?? id) }];
  }));
  const rootIds = [...tables.keys()];
  const pending = [...rootIds];
  const links = new Map<string, ScopeLink>();
  let cursor = 0;
  while (cursor < pending.length) {
    if (Date.now() - start > SCOPE_LIMITS.milliseconds) throw new Error("UPSTREAM_SCOPE_TIME_LIMIT");
    const frontier = pending.slice(cursor, cursor + 100);
    cursor += frontier.length;
    const result = await store.run(
      "MATCH (source:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'})-[:SL_ASSET_EDGE {graphId:$graphId,kind:'READS_TABLE'}]->(task:SLAssetNode {graphId:$graphId,kind:'TASK'})-[:SL_ASSET_EDGE {graphId:$graphId,kind:'WRITES_TABLE'}]->(target:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'}) WHERE target.id IN $frontier RETURN DISTINCT source.id AS sourceId,source.table AS sourceTable,source.label AS sourceLabel,task.id AS taskId,target.id AS targetId ORDER BY targetId,taskId,sourceId LIMIT $limit",
      { frontier, limit: SCOPE_LIMITS.links - links.size + 1 },
    );
    for (const row of result.records) {
      const source = String(row.get("sourceId"));
      const target = String(row.get("targetId"));
      const task = String(row.get("taskId"));
      if (!tables.has(source)) {
        tables.set(source, { id: source, table: String(row.get("sourceTable") ?? ""), label: String(row.get("sourceLabel") ?? row.get("sourceTable") ?? source) });
        pending.push(source);
      }
      links.set(JSON.stringify([source, task, target]), { source, task, target });
      if (tables.size > SCOPE_LIMITS.tables || links.size > SCOPE_LIMITS.links) throw new Error("UPSTREAM_SCOPE_SIZE_LIMIT");
    }
  }
  if (Date.now() - start > SCOPE_LIMITS.milliseconds) throw new Error("UPSTREAM_SCOPE_TIME_LIMIT");
  const final = await store.ready();
  if (final.version !== initial.version) throw new Error("ASSET_GRAPH_CHANGED_DURING_QUERY");
  return { version: String(initial.version), patterns: patterns.map(p => p.pattern), roots: rootIds, tables: [...tables.values()], links: [...links.values()] };
}
