import type { AssetGraphStore } from "./store.ts";
import type { SchedulerTaskNameResolver } from "./scheduler-task-names.ts";

// Empty selection means all clusters; the empty string represents missing metadata.
export function parseClusters(raw: string | null): string[] {
  const value: unknown = JSON.parse(raw ?? "[]");
  if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== "string" || v.length > 200))
    throw new Error("INVALID_CLUSTER_FILTER");
  return [...new Set(value as string[])];
}

export const clusterParams = (ids?: readonly string[]) => ({ clusterFiltered: ids !== undefined, clusterTaskIds: ids ?? [] });
export const clusterTaskPredicate = (alias: string) => `($clusterFiltered=false OR ${alias}.id IN $clusterTaskIds)`;
export const clusterTablePredicate = (alias: string) => `($clusterFiltered=false OR EXISTS { MATCH (${alias})-[clusterEdge:SL_ASSET_EDGE {graphId:$graphId}]-(clusterTask:SLAssetNode {graphId:$graphId,kind:'TASK'}) WHERE clusterEdge.kind IN ['READS_TABLE','WRITES_TABLE'] AND clusterTask.id IN $clusterTaskIds })`;

export class ClusterCatalog {
  private cached?: { version: string; expires: number; tasks: Array<{ id: string; cluster: string }> };
  constructor(private store: Pick<AssetGraphStore, "ready" | "run">, private resolver: Pick<SchedulerTaskNameResolver, "resolveClusters">) {}
  async read() {
    const version = String((await this.store.ready()).version);
    if (!this.cached || this.cached.version !== version || this.cached.expires < Date.now()) {
      // Published membership is immutable within a version; only local labels
      // need the periodic refresh. Avoid a full graph scan on that refresh.
      let ids: string[];
      if (this.cached?.version === version) {
        ids = this.cached.tasks.map(task => task.id);
      } else {
        const result = await this.store.run("MATCH (n:SLAssetNode {graphId:$graphId,kind:'TASK'}) RETURN n.id AS id ORDER BY n.id LIMIT $limit", { limit: 50001 });
        if (result.records.length > 50000) throw new Error("CLUSTER_CATALOG_LIMIT");
        ids = result.records.map(r => String(r.get("id")));
      }
      const clusters = this.resolver.resolveClusters(ids.map(id => id.replace(/^task:/, "")));
      if (String((await this.store.ready()).version) !== version) throw new Error("ASSET_GRAPH_CHANGED_DURING_QUERY");
      this.cached = { version, expires: Date.now() + 30000, tasks: ids.map(id => ({ id, cluster: clusters[id.replace(/^task:/, "")] ?? "" })) };
    }
    const counts = new Map<string, number>();
    for (const task of this.cached.tasks) counts.set(task.cluster, (counts.get(task.cluster) ?? 0) + 1);
    return { version, tasks: this.cached.tasks, clusters: [...counts].map(([value, taskCount]) => ({ value, label: value || "未收录", taskCount })).sort((a, b) => b.taskCount - a.taskCount || a.value.localeCompare(b.value)) };
  }
  async select(clusters: string[]) {
    if (!clusters.length) return undefined;
    const catalog = await this.read();
    return catalog.tasks.filter(task => clusters.includes(task.cluster)).map(task => task.id);
  }
}
