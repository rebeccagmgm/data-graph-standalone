import type { AssetGraphStore } from "./store.ts";
import { readJson, type Evidence, type PreparedManifest } from "./evidence-json.ts";
import { unpackTaskLocalProjectionEnvelope } from "../continuation/task-local-projection.ts";
import type { TaskLocalProjection } from "../../../../scripts/project-graph/task-local/contract.ts";
import { loadPublishedContinuationIndex } from "./continuation-metrics-query.ts";
import type { UnionContinuationIndexEntry, UnionContinuationIndexCandidate } from "../continuation/continuation-index.ts";
import { dateColumns, partitionOptions, selectedPartitionWrites, type PartitionCatalog, type PartitionSelection, type PartitionWrite } from "./partition-selection.ts";

type Node = Record<string, any>;
type Edge = Record<string, any>;
interface PartitionTrace {
  version: string; layer: "table"; direction: "up" | "down"; depthLimit: number; edgeLimit: number;
  truncated: boolean; stoppedBy: "EDGE_LIMIT" | "DEPTH_LIMIT" | null; frontierNodeIds: string[];
  terminalNodes: Node[]; nodes: Node[]; edges: Edge[]; elapsedMs: number; projectionGenerations: number;
  partitionSelection: PartitionSelection; scopeWarnings: string[]; partitionContexts: Record<string, PartitionWrite[]>;
}
const readKey = (task: string, read: string) => `${task}\u0000${read}`;
const writeKey = (w: Pick<PartitionWrite, "taskId" | "writeId">) => `${w.taskId}\u0000${w.writeId}`;
const clean = (n: Node): Node => { const {key, graphId, ...rest} = n; return {...rest, detail: typeof n.detail === "string" ? JSON.parse(n.detail) : n.detail ?? {}}; };

/** The table projection follows published read/write occurrences, not shared
 * dataset adjacency. No new partition matcher or SQL parser is introduced. */
export class PartitionQueries {
  private version = "";
  private manifest!: PreparedManifest;
  private tasks = new Map<string, {projection: TaskLocalProjection; evidence: Evidence}>();
  private index?: ReturnType<typeof loadPublishedContinuationIndex>;
  private reads = new Map<string, UnionContinuationIndexEntry>();
  private consumers = new Map<string, UnionContinuationIndexEntry[]>();
  private terminals = new Set<string>();
  private catalogs = new Map<string, PartitionCatalog>();
  constructor(private store: Pick<AssetGraphStore, "ready" | "run">, private graphOutputRoot: string) {}

  private async ready(expected?: string) {
    const state = await this.store.ready();
    if (expected && state.version !== expected) throw new Error("PARTITION_VERSION_CHANGED");
    if (this.version !== state.version) {
      this.manifest = readJson<PreparedManifest>(String(state.manifestPath));
      this.version = String(state.version);
      this.tasks.clear(); this.reads.clear(); this.consumers.clear(); this.catalogs.clear(); this.terminals.clear(); this.index = undefined;
    }
    return this.version;
  }
  private loadIndex() {
    if (this.index) return;
    this.index = loadPublishedContinuationIndex({graphOutputRoot: this.graphOutputRoot, publicationVersion: this.version});
    for (const e of this.index.index.entries) {
      this.reads.set(readKey(e.consumerTaskId, e.readOccurrenceId), e);
      for (const c of e.candidates) {
        if (c.partitionMatchStatus === "DISJOINT" || !c.targetWriteNodeId) continue;
        const key = writeKey({taskId: c.taskId, writeId: c.writeObservationId});
        const entries = this.consumers.get(key) ?? [];
        entries.push(e); this.consumers.set(key, entries);
      }
    }
    for (const t of [...this.index.policyTerminals, ...(this.index.boundarySnapshot?.reads ?? [])]) this.terminals.add(readKey(t.consumerTaskId, t.readOccurrenceId));
  }
  private task(id: string) {
    const cached = this.tasks.get(id); if (cached) return cached;
    const task = this.manifest.tasks.find(t => t.taskId === id);
    if (!task) throw new Error("PARTITION_TASK_NOT_PUBLISHED");
    const envelope = readJson<{projection: TaskLocalProjection}>(task.path);
    unpackTaskLocalProjectionEnvelope({envelope, manifestTaskContentHash: task.contentHash});
    const value = {projection: envelope.projection, evidence: readJson<Evidence>(task.evidencePath)};
    if (this.tasks.size >= 100) this.tasks.delete(this.tasks.keys().next().value!);
    this.tasks.set(id, value); return value;
  }
  private async nodes(ids: string[]) {
    if (!ids.length) return [];
    const r = await this.store.run("UNWIND $ids AS id WITH $graphId+'|'+id AS k MATCH (n:SLAssetNode {key:k}) RETURN properties(n) AS node LIMIT $limit", {ids: [...new Set(ids)], limit: 1001});
    return r.records.map(r => clean(r.get("node")));
  }
  async catalog(datasetId: string): Promise<PartitionCatalog> {
    const version = await this.ready();
    if (!datasetId.startsWith("dataset:") || datasetId.length > 200) throw new Error("PARTITION_DATASET_REQUIRED");
    const cached = this.catalogs.get(datasetId); if (cached) return cached;
    const r = await this.store.run("UNWIND [$id] AS id WITH $graphId+'|'+id AS k MATCH (d:SLAssetNode {key:k}) WITH d LIMIT 1 MATCH (d)<-[:SL_ASSET_EDGE {graphId:$graphId,kind:'WRITES'}]-(w:SLAssetNode {graphId:$graphId,kind:'TARGET_WRITE'}) RETURN properties(w) AS node ORDER BY w.taskId,w.writeId LIMIT $limit", {id: datasetId, limit: 1001});
    if (r.records.length > 1000) throw new Error("PARTITION_WRITER_LIMIT");
    const writes = r.records.map(r => { const n = clean(r.get("node")); return { taskId: String(n.taskId), writeId: String(n.writeId || n.detail.writeObservationId), targetId: String(n.id), datasetId, partition: Array.isArray(n.detail.partition) ? n.detail.partition : [] }; });
    const catalog = {version, datasetId, options: partitionOptions(writes), ignoredDateColumns: dateColumns(writes)};
    await this.ready(version);
    if (this.catalogs.size >= 100) this.catalogs.delete(this.catalogs.keys().next().value!);
    this.catalogs.set(datasetId, catalog); return catalog;
  }
  async selected(selection: PartitionSelection) {
    await this.ready(selection.version);
    return selectedPartitionWrites(await this.catalog(selection.datasetId), selection);
  }
  /** Exact output binding plus statement reads (including row-count/filter
   * dependencies). A shared multi-insert statement is not assigned wholesale. */
  private dependencies(write: PartitionWrite) {
    const {projection: p, evidence: e} = this.task(write.taskId);
    const statements = new Set(e.datasetIo.filter(io => io.write_observation_id === write.writeId).map(io => String(io.write_statement_id ?? "")).filter(Boolean));
    const shared = new Set(e.datasetIo.filter(io => io.write_observation_id !== write.writeId).map(io => String(io.write_statement_id ?? "")));
    const occurrences = new Set<string>();
    for (const edge of p.edges.filter(edge => edge.toNodeId === write.targetId)) {
      if (edge.properties.sourceReadOccurrenceStatus === "RESOLVED" && typeof edge.properties.sourceReadOccurrenceId === "string") occurrences.add(edge.properties.sourceReadOccurrenceId);
    }
    return (p.localClosure?.externalReads ?? []).filter(read => {
      if (occurrences.has(read.readOccurrenceId)) return true;
      const n = p.nodes.find(n => n.nodeId === read.readOccurrenceNodeId);
      const stmt = String(n?.properties.statementId ?? "");
      return statements.has(stmt) && !shared.has(stmt);
    });
  }
  private fromCandidate(c: UnionContinuationIndexCandidate): PartitionWrite | undefined {
    if (!c.targetWriteNodeId || !c.datasetNodeId) return undefined;
    return {taskId: c.taskId, writeId: c.writeObservationId, targetId: c.targetWriteNodeId, datasetId: c.datasetNodeId, partition: [...c.partition]};
  }
  async validateField(selection: PartitionSelection, nodeId: string) {
    const writes = await this.selected(selection);
    const [node] = await this.nodes([nodeId]);
    if (!node || node.kind !== "WRITE_FIELD" || !writes.some(w => w.taskId === node.taskId && w.writeId === node.writeId)) throw new Error("FIELD_OUTSIDE_PARTITION_SELECTION");
  }
  async trace(selection: PartitionSelection, input: {direction: "up" | "down"; depth: number; limit: number; includeCandidates: boolean; focusNodeId?: string; scopeDepth?: number; scopeDirection?: "up" | "down"; clusterTaskIds?: string[]}, branch?: {seeds: PartitionWrite[]; anchor: Node}): Promise<PartitionTrace> {
    const start = Date.now();
    const initial = await this.selected(selection);
    this.loadIndex();
    if (input.focusNodeId) {
      // Derive focus writes from the original scoped traversal on the server.
      // A reverse-direction click never falls back to all writers of that table.
      const scope = await this.trace(selection, {...input, focusNodeId: undefined, depth: input.scopeDepth ?? 1, direction: input.scopeDirection ?? input.direction});
      const anchor = scope.nodes.find((n: Node) => n.id === input.focusNodeId);
      if (!anchor) throw new Error("PARTITION_FOCUS_OUTSIDE_SCOPE");
      return this.trace(selection, {...input, focusNodeId: undefined, depth: 1}, {seeds: scope.partitionContexts[anchor.id] ?? [], anchor});
    }
    const depth = Math.max(0, Math.min(12, Math.trunc(input.depth)));
    const limit = Math.max(1, Math.min(1000, input.limit));
    const nodes = new Map<string, Node>(); const edges = new Map<string, Edge>();
    const frontier = new Set<string>(); const terminalNodes = new Map<string, Node>(); const warnings = new Set<string>();
    const contexts = new Map<string, Map<string, PartitionWrite>>();
    const context = (w: PartitionWrite, candidate: boolean) => {
      for (const id of [w.datasetId, `task:${w.taskId}`]) {
        const refs = contexts.get(id) ?? new Map<string, PartitionWrite>();
        refs.set(writeKey(w), {...w, candidate: Boolean(candidate || refs.get(writeKey(w))?.candidate)}); contexts.set(id, refs);
      }
    };
    const allowed = (task: string) => !input.clusterTaskIds || input.clusterTaskIds.includes(`task:${task}`);
    const addNode = (n: Node, hop: number) => { if (!nodes.has(n.id)) nodes.set(n.id, {...n, depth: hop * 2, lineageDepth: hop}); };
    const getNode = async (id: string, hop: number) => { if (!nodes.has(id)) { const [n] = await this.nodes([id]); if (n) addNode(n, hop); } };
    if (branch) addNode(branch.anchor, 0); else await getNode(selection.datasetId, 0);
    if (!nodes.has(branch?.anchor.id ?? selection.datasetId)) throw new Error("PARTITION_DATASET_MISSING");
    let truncated = false;
    const addEdge = (from: string, to: string, kind: string, w: PartitionWrite, detail: Node, status = "OBSERVED") => {
      const id = JSON.stringify([kind, from, to, w.writeId, detail.readOccurrenceId]);
      if (edges.size >= limit && !edges.has(id)) { truncated = true; return; }
      edges.set(id, {id, from, to, kind, layer: "table", owner: w.taskId, status, detail: {...detail, writeObservationId: w.writeId, ...(kind === "WRITES_TABLE" ? {partition: w.partition} : {})}});
    };
    const queue = (branch?.seeds ?? initial).filter(w => allowed(w.taskId)).map(write => ({write, hop: 0, candidate: Boolean(write.candidate || partitionOptions([write])[0]?.unknown)}));
    for (const item of queue) context(item.write, item.candidate);
    if (queue.some(q => q.candidate)) warnings.add("选中范围包含分区证据待确认的写入，相关路径按候选展示。");
    const visited = new Set<string>();
    const writeGraph = async (w: PartitionWrite, hop: number, candidate = false) => {
      await getNode(w.datasetId, hop); await getNode(`task:${w.taskId}`, input.direction === "up" ? hop + 0.5 : hop - 0.5);
      addEdge(`task:${w.taskId}`, w.datasetId, "WRITES_TABLE", w, {}, candidate ? "CANDIDATE" : "CONFIRMED");
    };
    while (queue.length && !truncated) {
      const {write: w, hop, candidate} = queue.shift()!;
      if (visited.has(writeKey(w))) continue;
      visited.add(writeKey(w));
      if (visited.size > 200) { truncated = true; break; }
      if (hop >= depth) { frontier.add(w.datasetId); continue; }
      if (input.direction === "up") {
        await writeGraph(w, hop, candidate);
        const dependencies = this.dependencies(w);
        if (!dependencies.length) warnings.add("部分写入未找到可绑定的读取证据，已在该写入处停止。");
        for (const read of dependencies) {
          if (truncated) break;
          await getNode(read.datasetNodeId, hop + 1);
          const entry = this.reads.get(readKey(w.taskId, read.readOccurrenceId));
          const readEvidence = this.task(w.taskId).projection.nodes.find(n => n.nodeId === read.readOccurrenceNodeId)?.properties;
          addEdge(read.datasetNodeId, `task:${w.taskId}`, "READS_TABLE", w, {readOccurrenceId: read.readOccurrenceId, partitionPredicates: readEvidence?.partitionPredicates, partitionPredicateStatus: readEvidence?.partitionPredicateStatus}, candidate ? "CANDIDATE" : "OBSERVED");
          if (this.terminals.has(readKey(w.taskId, read.readOccurrenceId))) {
            terminalNodes.set(read.datasetNodeId, {nodeId: read.datasetNodeId, role: "SOURCE_ENDPOINT", reason: "已到发布图谱的源端或参数边界", ruleRef: "PUBLISHED_CONTINUATION_INDEX"}); continue;
          }
          const producers = entry?.candidates.filter(c => c.partitionMatchStatus !== "DISJOINT" && (input.includeCandidates || c.l1Eligible) && allowed(c.taskId)) ?? [];
          if (!entry) warnings.add("部分读取缺少已发布的分区接续证据，未按同表补连。");
          if (hop + 1 >= depth && producers.length) frontier.add(read.datasetNodeId);
          for (const c of producers) { const write = this.fromCandidate(c); if (write && write.datasetId === read.datasetNodeId) { context(write, candidate || !c.l1Eligible); queue.push({write, hop: hop + 1, candidate: candidate || !c.l1Eligible}); } }
        }
      } else {
        for (const entry of this.consumers.get(writeKey(w)) ?? []) {
          if (truncated) break;
          if (!allowed(entry.consumerTaskId) || this.terminals.has(readKey(entry.consumerTaskId, entry.readOccurrenceId))) continue;
          const candidateLink = entry.candidates.find(c => c.taskId === w.taskId && c.writeObservationId === w.writeId)!;
          if (!input.includeCandidates && !candidateLink.l1Eligible) continue;
          const p = this.task(entry.consumerTaskId).projection;
          for (const final of p.localClosure?.finalWrites ?? []) {
            if (truncated) break;
            const catalog = await this.catalog(final.datasetNodeId);
            const next = catalog.options.flatMap(o => o.writes).find(v => v.taskId === entry.consumerTaskId && v.writeId === final.writeObservationId);
            if (!next || !this.dependencies(next).some(r => r.readOccurrenceId === entry.readOccurrenceId)) continue;
            const uncertain = candidate || !candidateLink.l1Eligible;
            context(next, uncertain);
            await writeGraph(next, hop + 1, uncertain);
            const readEvidence = p.nodes.find(n => n.nodeId === entry.readOccurrenceNodeId)?.properties;
            addEdge(w.datasetId, `task:${next.taskId}`, "READS_TABLE", next, {readOccurrenceId: entry.readOccurrenceId, partitionPredicates: readEvidence?.partitionPredicates, partitionPredicateStatus: readEvidence?.partitionPredicateStatus}, uncertain ? "CANDIDATE" : "OBSERVED");
            queue.push({write: next, hop: hop + 1, candidate: uncertain});
          }
        }
      }
    }
    if (truncated) for (const q of queue) frontier.add(q.write.datasetId);
    if (!edges.size && depth > 0) warnings.add("所选分区在当前集群、方向和候选设置下，没有可展示的已发布接续关系；已保留起点。可切换方向或调整筛选范围。");
    await this.ready(selection.version);
    const resultNodes = [...nodes.values()]; const resultEdges = [...edges.values()];
    const present = new Set(resultNodes.map(n => n.id));
    return {version: selection.version, layer: "table" as const, direction: input.direction, depthLimit: depth, edgeLimit: limit, truncated, stoppedBy: truncated ? "EDGE_LIMIT" : frontier.size ? "DEPTH_LIMIT" : null, frontierNodeIds: [...frontier].filter(id => present.has(id)), terminalNodes: [...terminalNodes.values()].filter(n => present.has(n.nodeId)), nodes: resultNodes, edges: resultEdges, elapsedMs: Date.now() - start, projectionGenerations: 0, partitionSelection: selection, scopeWarnings: [...warnings], partitionContexts: Object.fromEntries([...contexts].map(([id, refs]) => [id, [...refs.values()]]))};
  }
}
