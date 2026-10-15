import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { openAssetGraph } from "./config.ts";
import { atomicReplaceFile } from "./atomic-file-replace.ts";
import { pruneGraphArtifactHistory } from "./prune-artifacts.ts";
import {
  pruneAllTaskProjectionVersions,
  readActiveProjectionReferences,
} from "../../../../scripts/project-graph/task-local/projection-prune.ts";
import { AssetGraphStore } from "./store.ts";
import {
  compileTask,
  digest,
  type AssetEdge,
  type FactRecord,
} from "./compile.ts";
import { unpackTaskLocalProjectionEnvelope } from "../continuation/task-local-projection.ts";
import type { TaskLocalProjection } from "../../../../scripts/project-graph/task-local/contract.ts";
import type {
  TaskLocalUnionMergeResult,
  TaskLocalUnionTaskEvidence,
  TaskLocalUnionNode,
} from "../continuation/continuation-input.ts";
import {
  buildUnionContinuationIndex,
  unionContinuationIndexContentHash,
  type UnionContinuationIndex,
  type UnionContinuationIndexEntry,
} from "../continuation/continuation-index.ts";
import type { ProducerIndexWriter } from "../continuation/producer-writer.ts";
import { CONTINUATION_MATCH_POLICY_VERSION } from "../continuation/continuation-v2.ts";
import { buildWritePartitionParts } from "../../../../scripts/project-graph/task-local/write-partition-evidence.ts";
import { expandPartitionAlternatives } from "../../../../scripts/project-graph/task-local/partition-alternatives.ts";
import { calculateContinuationMetrics } from "./continuation-metrics.ts";
import {
  loadGraphTerminalPolicy,
  terminalPolicyConfigHash,
} from "./terminal-policy.ts";
import {
  loadGraphSourceEndpointBoundary,
  sourceEndpointBoundaryConfigHash,
  buildSourceEndpointBoundarySnapshot,
  boundaryEvidenceFromSnapshot,
  sourceEndpointBoundaryKey,
} from "./source-endpoint-boundary.ts";
import { buildPublicationSnapshots } from "./publication-snapshots.ts";
import type {
  Evidence,
  PreparedManifest,
  PublishedTask,
} from "./evidence-json.ts";
import { readJson } from "./evidence-json.ts";

export const ASSET_COMPILER_VERSION = "1.0.18";
export type {
  Evidence,
  PreparedManifest,
  PublishedTask,
} from "./evidence-json.ts";
export { readJson } from "./evidence-json.ts";

/** Match explicit writes by the Facts statement, never by ordinal across different SQL slots. */
export function taskWriters(
  p: TaskLocalProjection,
  e: Evidence,
): ProducerIndexWriter[] {
  const statements = new Map(e.statements.map((s) => [s.statement_id, s]));
  const finalWrites = p.localClosure?.finalWrites ?? [];
  return (p.localClosure?.finalWrites ?? []).map((w) => {
    const matchingIo = e.datasetIo.filter(
      (i) => i.write_observation_id === w.writeObservationId,
    );
    const io = matchingIo.length === 1 ? matchingIo[0] : null;
    const stmt = statements.get(io?.write_statement_id ?? io?.statement_id);
    const statementSql = stmt ? String(stmt.raw_sql ?? "") : null;
    const parts = buildWritePartitionParts({
      qualifiedName: w.qualifiedName,
      statementSql,
      packPartition: e.packPartition,
      packTarget: e.packTarget,
      factsWrite: io,
      writeObservationId: w.writeObservationId,
      bindings: e.bindings,
      expressions: e.expressions,
      relations: e.relations,
      materializations: e.materializations,
      targetWriteCount: finalWrites.filter(
        (candidate) =>
          candidate.qualifiedName.toLowerCase() ===
          w.qualifiedName.toLowerCase(),
      ).length,
    });
    if (!expandPartitionAlternatives(parts)) {
      throw new Error(`INVALID_WRITE_PARTITION_ALTERNATIVES:${p.taskId}:${w.writeObservationId}`);
    }
    return {
      taskId: p.taskId,
      writeObservationId: w.writeObservationId,
      datasetNodeId: w.datasetNodeId,
      qualifiedName: w.qualifiedName,
      partition: parts,
      ...(w.outputQualification === undefined
        ? {}
        : { outputQualification: w.outputQualification }),
    };
  });
}
export async function publishAssetGraph(configPath?: string) {
  const connection = await openAssetGraph(configPath);
  const { paths, graphId, driver, database } = connection;
  const store = new AssetGraphStore(driver, database, graphId),
    started = Date.now();
  try {
    const terminalConfig = loadGraphTerminalPolicy();
    const terminalConfigHash = terminalPolicyConfigHash(terminalConfig);
    const boundaryConfig = loadGraphSourceEndpointBoundary();
    const boundaryConfigHash = sourceEndpointBoundaryConfigHash(boundaryConfig);
    const prepared = readJson<{ manifestPath: string; version: string }>(
      join(paths.graphOutputRoot, "prepared.json"),
    );
    const manifest = readJson<PreparedManifest>(prepared.manifestPath),
      version = digest([
        ASSET_COMPILER_VERSION,
        CONTINUATION_MATCH_POLICY_VERSION,
        prepared.version,
        terminalConfigHash,
        boundaryConfigHash,
      ]);
    await store.initialize();
    await store.upgradeOwnerEdgeSources();
    const prior = await store.state();
    if (prior?.state === "READY" && prior.version === version) {
      const result = {
        state: "UNCHANGED",
        version,
        updatedTasks: 0,
        projectionGenerations: 0,
        elapsedMs: Date.now() - started,
      };
      writeFileSync(
        join(paths.graphOutputRoot, "publish-nochange.json"),
        JSON.stringify(result, null, 2),
      );
      return result;
    }
    const ownerHashes = await store.owners(),
      taskEvidence: TaskLocalUnionTaskEvidence[] = [],
      leanNodes = new Map<string, TaskLocalUnionNode>(),
      writers: ProducerIndexWriter[] = [],
      writeFields = new Map<
        string,
        { id: string; writeId: string; column: string; table: string }
      >();
    const taskSet = new Set(manifest.taskIds),
      scheduleEdges = new Map<string, AssetEdge>(),
      changed = new Set<string>();
    const outDir = join(paths.graphOutputRoot, "published", version);
    mkdirSync(outDir, { recursive: true });
    const progress = (state: string, extra: Record<string, unknown> = {}) => {
      const v = { state, version, elapsedMs: Date.now() - started, ...extra };
      writeFileSync(
        join(paths.graphOutputRoot, "publish-progress.json"),
        JSON.stringify(v, null, 2),
      );
      process.stdout.write(JSON.stringify(v) + "\n");
    };
    let oldIndex: UnionContinuationIndex | null = null;
    if (prior?.version) {
      const previous = join(
        paths.graphOutputRoot,
        "published",
        String(prior.version),
        "union-continuation-index.json",
      );
      const previousReport = join(dirname(previous), "publication.json");
      if (existsSync(previous) && existsSync(previousReport) &&
        readJson<{ continuationMatchPolicyVersion?: string }>(previousReport).continuationMatchPolicyVersion === CONTINUATION_MATCH_POLICY_VERSION) oldIndex = readJson(previous);
    }
    await store.begin(version);
    progress("IMPORTING_LOCAL", { total: manifest.tasks.length });
    let imported = 0,
      localPeakRss = process.memoryUsage().rss;
    const localImportStarted = Date.now();
    for (const task of manifest.tasks) {
      const envelope = readJson<Record<string, unknown>>(task.path);
      const unpacked = unpackTaskLocalProjectionEnvelope({
        envelope,
        manifestTaskContentHash: task.contentHash,
      });
      const p = unpacked.projection as TaskLocalProjection;
      const e = readJson<Evidence>(task.evidencePath);
      const taskWriteScopes = p.coverageStatus === "PROJECTED" ? taskWriters(p, e) : [];
      const graph = compileTask(
        p,
        e.bindings ?? [],
        terminalConfig,
        boundaryConfig,
        taskWriteScopes,
      );
      for (const w of graph.writes)
        writeFields.set(`${task.taskId}|${w.writeId}|${w.column}`, w);
      const ownerHash = digest([
        ASSET_COMPILER_VERSION,
        task.cacheKey,
        terminalConfigHash,
        boundaryConfigHash,
      ]);
      if (ownerHashes.get(task.taskId) !== ownerHash) changed.add(task.taskId);
      taskEvidence.push({
        taskId: task.taskId,
        contentHash: p.contentHash,
        packContentHash: unpacked.envelope.cacheKeyParts.packContentHash,
        factsManifestSha256:
          unpacked.envelope.cacheKeyParts.factsManifestSha256,
        projectionSchemaVersion: p.schemaVersion,
        coverageStatus: p.coverageStatus,
        localClosure: p.localClosure ?? null,
      });
      for (const n of p.nodes)
        if (
          n.nodeType === "READ_OCCURRENCE" ||
          n.nodeType === "PHYSICAL_DATASET"
        )
          leanNodes.set(n.nodeId, { ...n, sourceTaskIds: [task.taskId] });
      writers.push(...taskWriteScopes);
      const ref = p.nodes.find((n) => n.nodeType === "TASK")?.properties
        .scheduleReference as
        | { upstreamTaskIds?: string[]; downstreamTaskIds?: string[] }
        | undefined;
      const addSchedule = (a: string, b: string) => {
        if (!taskSet.has(a) || !taskSet.has(b) || a === b) return;
        const id = digest([a, b]);
        scheduleEdges.set(id, {
          id,
          from: `task:${a}`,
          to: `task:${b}`,
          kind: "SCHEDULE",
          layer: "schedule",
          owner: "__schedule__",
          status: "SCHEDULE_REFERENCE_ONLY",
          detail: "{}",
        });
      };
      for (const up of ref?.upstreamTaskIds ?? []) addSchedule(up, task.taskId);
      for (const down of ref?.downstreamTaskIds ?? [])
        addSchedule(task.taskId, down);
      if (changed.has(task.taskId)) {
        await store.replace(task.taskId, ownerHash, graph);
        imported++;
      }
      localPeakRss = Math.max(localPeakRss, process.memoryUsage().rss);
      if (
        (imported > 0 && imported % 100 === 0) ||
        taskEvidence.length % 250 === 0
      )
        progress("IMPORTING_LOCAL", {
          completed: taskEvidence.length,
          total: manifest.tasks.length,
          changed: changed.size,
          imported,
          peakRss: process.memoryUsage().rss,
        });
    }
    const removed = [...ownerHashes.keys()].filter(
      (id) => !id.startsWith("__") && !taskSet.has(id),
    );
    const localImportElapsedMs = Date.now() - localImportStarted;
    const producerIdentity = {
      contentHash: digest(writers),
      inputFingerprint: digest(
        taskEvidence.map((t) => [t.taskId, t.factsManifestSha256]),
      ),
    };
    const merge: TaskLocalUnionMergeResult = {
      sourceMode: "TASK_LOCAL_UNION",
      nodes: [...leanNodes.values()],
      edges: [],
      taskEvidence,
      producerIndex: producerIdentity,
      batchManifestRef: {
        path: prepared.manifestPath,
        contentHash: digest(manifest),
      },
      report: {
        taskCount: manifest.tasks.length,
        projectedCount: taskEvidence.filter(
          (t) => t.coverageStatus === "PROJECTED",
        ).length,
        boundaryOnlyCount: taskEvidence.filter(
          (t) => t.coverageStatus !== "PROJECTED",
        ).length,
        nodeCounts: {
          input: leanNodes.size,
          output: leanNodes.size,
          deduped: 0,
        },
        edgeCounts: { input: 0, output: 0, deduped: 0 },
        gaps: [],
      },
    };
    const changedTables = new Set<string>();
    for (const t of taskEvidence)
      if (changed.has(t.taskId))
        for (const w of t.localClosure?.finalWrites ?? [])
          changedTables.add(w.qualifiedName.toLowerCase());
    // A removed/changed writer may have disappeared from today's finalWrites; recover its old affected tables from the index.
    if (oldIndex)
      for (const entry of oldIndex.entries)
        if (
          entry.candidates.some(
            (c) => changed.has(c.taskId) || removed.includes(c.taskId),
          )
        )
          changedTables.add(entry.qualifiedName.toLowerCase());
    const affected = taskEvidence
      .filter(
        (t) =>
          t.coverageStatus === "PROJECTED" &&
          (!oldIndex ||
            changed.has(t.taskId) ||
            (t.localClosure?.externalReads ?? []).some((r) =>
              changedTables.has(r.qualifiedName.toLowerCase()),
            )),
      )
      .map((t) => t.taskId);
    progress("CONTINUATION", { affectedTasks: affected.length });
    const refreshed = buildUnionContinuationIndex({
      merge,
      producerIndexWriters: writers,
      generatedAt: new Date().toISOString(),
      consumerTaskIds: affected,
    });
    const affectedSet = new Set(affected);
    const entries = [
      ...(oldIndex?.entries ?? []).filter(
        (e) =>
          taskEvidence.some(
            (t) =>
              t.taskId === e.consumerTaskId && t.coverageStatus === "PROJECTED",
          ) && !affectedSet.has(e.consumerTaskId),
      ),
      ...refreshed.entries,
    ];
    const indexBody = { ...refreshed, entries };
    const { contentHash: _indexHash, ...indexWithoutHash } = indexBody;
    const rawIndex = {
      ...indexWithoutHash,
      contentHash: unionContinuationIndexContentHash(indexWithoutHash),
    };
    const taskCategoryFor = (taskId: string) =>
      manifest.tasks.find((task) => task.taskId === taskId)?.taskCategory ??
      null;
    const boundarySnapshotDraft = buildSourceEndpointBoundarySnapshot({
      index: rawIndex,
      config: boundaryConfig,
      taskCategoryFor,
      unionTaskIds: taskSet,
      writerCatalogPath: paths.writerCatalogPath,
    });
    const { index, terminalPolicy, boundarySnapshot } =
      buildPublicationSnapshots({
        rawIndex,
        terminalConfig,
        boundarySnapshotDraft,
      });
    const boundaryEvidence = boundaryEvidenceFromSnapshot(boundarySnapshot);
    const terminalReads = new Set(
      terminalPolicy.reads.map(
        (read) => `${read.consumerTaskId}|${read.readOccurrenceId}`,
      ),
    );
    const boundaryReads = new Set(
      boundarySnapshot.reads.map((read) => sourceEndpointBoundaryKey(read)),
    );
    writeFileSync(
      join(outDir, "terminal-policy.json"),
      JSON.stringify(terminalPolicy),
    );
    writeFileSync(
      join(outDir, "source-endpoint-boundary.json"),
      JSON.stringify(boundarySnapshot),
    );
    writeFileSync(
      join(outDir, "union-continuation-index.json"),
      JSON.stringify(index),
    );
    writeFileSync(
      join(outDir, "writer-observations.json"),
      JSON.stringify(writers),
    );
    const byRead = new Map(
      index.entries.map((e) => [
        `${e.consumerTaskId}|${e.readOccurrenceId}`,
        e,
      ]),
    );
    let continuationCount = 0,
      candidateCount = 0,
      updatedContinuations = 0,
      continuationPeakRss = process.memoryUsage().rss;
    const continuationImportStarted = Date.now();
    for (const task of manifest.tasks) {
      if (!affectedSet.has(task.taskId)) continue;
      const envelope = readJson<Record<string, unknown>>(task.path);
      const unpacked = unpackTaskLocalProjectionEnvelope({
        envelope,
        manifestTaskContentHash: task.contentHash,
      });
      const p = unpacked.projection as TaskLocalProjection;
      const e = readJson<Evidence>(task.evidencePath);
      const g = compileTask(
        p,
        e.bindings ?? [],
        terminalConfig,
        boundaryConfig,
      );
      const taskId = task.taskId;
      const links: AssetEdge[] = [];
      for (const read of g.reads) {
        const readKey = `${taskId}|${read.occurrence}`;
        if (terminalReads.has(readKey)) continue;
        if (boundaryReads.has(`${taskId}\u0000${read.occurrence}`)) continue;
        const entry = byRead.get(`${taskId}|${read.occurrence}`);
        for (const c of entry?.candidates ?? []) {
          if (c.partitionMatchStatus === "DISJOINT" || !c.targetWriteNodeId)
            continue;
          const source = writeFields.get(
            `${c.taskId}|${c.writeObservationId}|${read.column}`,
          );
          if (!source) continue;
          const kind = c.l1Eligible ? "CONTINUES" : "CANDIDATE";
          const id = digest([source.id, read.id]);
          links.push({
            id,
            from: source.id,
            to: read.id,
            kind,
            layer: "field",
            owner: `__continue__${taskId}`,
            status:
              c.outputQualification === "SQL_UNCONSUMED"
                ? "CANDIDATE"
                : c.partitionMatchStatus,
            detail: JSON.stringify({
              consumerTaskId: taskId,
              producerTaskId: c.taskId,
              readOccurrenceId: read.occurrence,
              writeObservationId: c.writeObservationId,
              partition: c.partition,
              partitionMatchStatus: c.partitionMatchStatus,
              l1Eligible: c.l1Eligible,
              ...(c.outputQualification === undefined
                ? {}
                : { outputQualification: c.outputQualification }),
            }),
          });
          if (c.l1Eligible) continuationCount++;
          else candidateCount++;
        }
      }
      const hash = digest(links);
      if (ownerHashes.get(`__continue__${taskId}`) === hash) continue;
      await store.replace(`__continue__${taskId}`, hash, {
        nodes: [],
        edges: links,
      });
      updatedContinuations++;
      continuationPeakRss = Math.max(
        continuationPeakRss,
        process.memoryUsage().rss,
      );
    }
    for (const task of taskEvidence)
      if (
        task.coverageStatus !== "PROJECTED" &&
        ownerHashes.has(`__continue__${task.taskId}`)
      ) {
        await store.replace(`__continue__${task.taskId}`, digest([]), {
          nodes: [],
          edges: [],
        });
        updatedContinuations++;
      }
    for (const taskId of removed) {
      await store.remove(taskId);
      await store.remove(`__continue__${taskId}`);
    }
    const schedule = [...scheduleEdges.values()],
      scheduleHash = digest(schedule);
    if (ownerHashes.get("__schedule__") !== scheduleHash)
      await store.replace("__schedule__", scheduleHash, {
        nodes: [],
        edges: schedule,
      });
    const latestPrepared = readJson<{ manifestPath: string; version: string }>(
      join(paths.graphOutputRoot, "prepared.json"),
    );
    if (
      latestPrepared.manifestPath !== prepared.manifestPath ||
      latestPrepared.version !== prepared.version
    )
      throw new Error("PREPARED_MANIFEST_CHANGED_DURING_PUBLISH");
    const report = {
      version,
      compilerVersion: ASSET_COMPILER_VERSION,
      continuationMatchPolicyVersion: CONTINUATION_MATCH_POLICY_VERSION,
      continuationIndexContentHash: index.contentHash,
      terminalPolicyContentHash: terminalPolicy.contentHash,
      terminalPolicyConfigHash: terminalConfigHash,
      sourceEndpointBoundaryContentHash: boundarySnapshot.contentHash,
      sourceEndpointBoundaryConfigHash: boundaryConfigHash,
      continuationMetrics: calculateContinuationMetrics({
        index,
        boundaryEvidence,
        boundaryReads: boundarySnapshot.reads,
        policyTerminals: terminalPolicy.reads,
        continuationEdgeMetrics: {
          totalContinuationEdges: continuationCount + candidateCount,
          confirmedContinuationEdges: continuationCount,
        },
      }),
      manifestPath: prepared.manifestPath,
      coverage: manifest.summary,
      coverageDisposition: manifest.summary.coverageDisposition ?? null,
      taskCount: manifest.tasks.length,
      updatedTasks: changed.size,
      removedTasks: removed.length,
      affectedContinuationTasks: affected.length,
      updatedContinuations,
      confirmedFieldContinuations: continuationCount,
      candidateFieldContinuations: candidateCount,
      scheduleEdges: schedule.length,
      stages: {
        localImport: { peakRss: localPeakRss, elapsedMs: localImportElapsedMs },
        continuationImport: {
          peakRss: continuationPeakRss,
          elapsedMs: Date.now() - continuationImportStarted,
        },
      },
      counts: await store.counts(),
      elapsedMs: Date.now() - started,
    };
    writeFileSync(
      join(outDir, "publication.json"),
      JSON.stringify(report, null, 2),
    );
    writeFileSync(
      join(paths.graphOutputRoot, "current.json.tmp"),
      JSON.stringify({
        version,
        manifestPath: prepared.manifestPath,
        publicationPath: join(outDir, "publication.json"),
      }),
    );
    atomicReplaceFile(
      join(paths.graphOutputRoot, "current.json.tmp"),
      join(paths.graphOutputRoot, "current.json"),
    );
    const finalizedReport = await store.finish(
      version,
      prepared.manifestPath,
      report,
    );
    writeFileSync(
      join(outDir, "publication.json"),
      JSON.stringify(finalizedReport, null, 2),
    );
    const preparedBeforePrune = readJson<{
      manifestPath: string;
      version: string;
    }>(join(paths.graphOutputRoot, "prepared.json"));
    const pruned =
      preparedBeforePrune.manifestPath !== prepared.manifestPath ||
      preparedBeforePrune.version !== prepared.version
        ? { skipped: "PREPARED_MANIFEST_CHANGED_DURING_PUBLISH" }
        : pruneGraphArtifactHistory(paths.graphOutputRoot, {
            version,
            manifestPath: prepared.manifestPath,
          });
    const activeProjectionReferences = readActiveProjectionReferences(
      paths.graphRoot,
    );
    const prunedProjections =
      activeProjectionReferences === null
        ? { skipped: "ACTIVE_PROJECTION_REFERENCE_UNREADABLE" }
        : pruneAllTaskProjectionVersions(
            paths.projectionRoot,
            activeProjectionReferences,
          );
    progress("READY", { ...finalizedReport, pruned, prunedProjections });
    return { ...finalizedReport, pruned, prunedProjections };
  } finally {
    await driver.close();
  }
}
