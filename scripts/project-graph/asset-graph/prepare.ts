import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { resolveWorkspacePaths } from "../../config/workspace-paths.ts";
import { createCurrentTaskBundleReader } from "../../query/current-task-bundle.ts";
import { indexTaskInputPacks } from "../../machine-facts/input-pack-machine-facts.ts";
import {
  canonicalJson,
  sha256,
} from "../../machine-facts/machine-facts-contract.ts";
import { projectTaskLocalBatch } from "../task-local/project-task-local-batch.ts";
import { taskLocalProjectionVersionPath } from "../task-local/projection-cache.ts";
import { readTaskCategoryFromScheduleCache } from "../task-local/schedule-context.ts";
import { summarizeCoverageDispositions } from "../task-local/coverage-disposition.ts";

export function prepareAssetGraph(input: {
  scopePath: string;
  configPath?: string;
  limit?: number;
}) {
  const paths = resolveWorkspacePaths({ configPath: input.configPath });
  const scopeBytes = readFileSync(resolve(input.scopePath));
  const taskIds = [
    ...new Set(
      scopeBytes
        .toString("utf8")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ].slice(0, input.limit);
  const root = paths.graphOutputRoot;
  mkdirSync(root, { recursive: true });
  const started = Date.now(),
    generatedAt = new Date().toISOString();
  const reader = createCurrentTaskBundleReader(paths.factsRoot, {
    cacheLoads: false,
  });
  const packs = indexTaskInputPacks(paths.inputPackRoot);
  const tasks: Record<string, unknown>[] = [];
  const counts: Record<string, number> = {};
  let hits = 0,
    misses = 0,
    nodes = 0,
    edges = 0,
    bytes = 0,
    peakRss = 0;
  const progress = (state: string) => {
    const value = {
      state,
      generatedAt,
      total: taskIds.length,
      completed: tasks.length,
      hits,
      misses,
      counts,
      nodes,
      edges,
      bytes,
      elapsedMs: Date.now() - started,
      peakRss,
    };
    writeFileSync(
      join(root, "prepare-progress.json"),
      JSON.stringify(value, null, 2),
    );
    process.stdout.write(JSON.stringify(value) + "\n");
  };
  progress("PREPARING");
  for (const taskId of taskIds) {
    const currentBundle = reader.load(taskId);
    const batch = projectTaskLocalBatch({
      taskIds: [taskId],
      dataRoot: paths.inputPackRoot,
      factsRoot: paths.factsRoot,
      scheduleCacheRoot: paths.evidenceRoot,
      outputRoot: paths.projectionRoot,
      bundleReader: { load: () => currentBundle },
      generatedAt,
    });
    const result = batch.results[0]!,
      p = result.projection;
    const packPaths = packs.get(taskId) ?? [];
    const packPath = packPaths.length === 1 ? packPaths[0] : null;
    const pack = packPath ? JSON.parse(readFileSync(packPath, "utf8")) : null;
    const evidencePath = join(
      paths.projectionRoot,
      "tasks",
      taskId,
      "versions",
      `${result.cacheKey}.evidence-v4.json`,
    );
    const sqlSources: { slot: string; content: string; sha256: string }[] = [];
    for (const raw of pack?.sqlFiles ?? []) {
      const slot = String(raw.slot);
      const spec = raw as Record<string, unknown>;
      const locator = spec.path ?? spec.file ?? spec.locator;
      if (typeof locator !== "string" || !packPath) continue;
      const path = resolve(dirname(packPath), locator);
      const content = readFileSync(path, "utf8");
      sqlSources.push({ slot, content, sha256: sha256(content) });
    }
    if (!existsSync(evidencePath))
      writeFileSync(
        evidencePath,
        JSON.stringify({
          taskId,
          taskName: pack?.taskName,
          taskCategory: pack?.taskCategory,
          coverage: p.coverageStatus,
          issues: currentBundle.issues,
          sqlSources,
          packPartition: pack?.partition ?? null,
          packTarget: pack?.target ?? null,
          expressions:
            currentBundle.records["field-expression-nodes.jsonl"] ?? [],
          bindings: currentBundle.records["output-field-bindings.jsonl"] ?? [],
          statements: currentBundle.records["statements.jsonl"] ?? [],
          datasetIo: currentBundle.records["dataset-io.jsonl"] ?? [],
          relations: currentBundle.records["relation-nodes.jsonl"] ?? [],
          materializations: currentBundle.records["task-local-materializations.jsonl"] ?? [],
        }),
      );
    const path = taskLocalProjectionVersionPath(
      paths.projectionRoot,
      taskId,
      result.cacheKey,
    );
    const taskCategory =
      pack?.taskCategory
      ?? readTaskCategoryFromScheduleCache(taskId, paths.evidenceRoot)
      ?? "MISSING_PACK";
    tasks.push({
      taskId,
      coverageStatus: p.coverageStatus,
      coverageDisposition: p.coverageDisposition,
      failureReasonCode: p.failureReasonCode,
      contentHash: p.contentHash,
      cacheHit: result.cacheHit,
      cacheKey: result.cacheKey,
      path,
      evidencePath,
      taskCategory,
      taskName: pack?.taskName ?? null,
      target: pack?.target ?? null,
      factsState: currentBundle.state,
      issues: currentBundle.issues,
    });
    counts[p.coverageStatus] = (counts[p.coverageStatus] ?? 0) + 1;
    hits += batch.cache.hits;
    misses += batch.cache.misses;
    nodes += p.nodes.length;
    edges += p.edges.length;
    bytes += Buffer.byteLength(canonicalJson(p));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (tasks.length % 25 === 0) progress("PREPARING");
  }
  const manifest = {
    schemaVersion: "1.0.0",
    artifactType: "TASK_LOCAL_BATCH_MANIFEST",
    generatedAt,
    scopeSha256: sha256(scopeBytes),
    taskIds,
    tasks,
    summary: {
      ...counts,
      coverageDisposition: summarizeCoverageDispositions(
        tasks.map((task) => ({
          coverageStatus: task.coverageStatus as "PROJECTED" | "SCHEDULE_ONLY" | "COLLECTION_FAILED",
          coverageDisposition: task.coverageDisposition as import("../task-local/coverage-disposition.ts").CoverageDisposition,
        })),
      ),
    },
    cache: { hits, misses },
  };
  const version = sha256(
    canonicalJson(
      tasks.map(({ taskId, cacheKey, evidencePath }) => ({
        taskId,
        cacheKey,
        evidencePath,
      })),
    ),
  );
  const manifestPath = join(root, "batches", version, "batch-manifest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  if (!existsSync(manifestPath))
    writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(
    join(root, "prepared.json.tmp"),
    JSON.stringify({ manifestPath, version, generatedAt }),
  );
  renameSync(join(root, "prepared.json.tmp"), join(root, "prepared.json"));
  progress("PREPARED");
  return { manifestPath, version };
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/prepare.ts")) {
  const args = process.argv.slice(2),
    value = (key: string) => {
      const i = args.indexOf(key);
      return i < 0 ? undefined : args[i + 1];
    };
  const scopePath = value("--scope");
  if (!scopePath) throw new Error("Pass --scope task-ids.txt");
  prepareAssetGraph({
    scopePath,
    configPath: value("--config"),
    limit: value("--limit") ? Number(value("--limit")) : undefined,
  });
}
