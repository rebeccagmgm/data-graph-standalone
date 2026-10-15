import { basename, dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalJson, sha256 } from "../../../contracts/runtime.ts";
import {
  assertUnionContinuationEvidenceEnvelope,
  buildUnionContinuationEvidenceEnvelope,
  type UnionContinuationEvidenceEnvelope,
} from "./task-local-union-continuation-envelope.ts";
import {
  traceUnionTaskContinuationV2,
  type TraceUnionTaskContinuationV2Result,
} from "../../../continuation/continuation-v2.ts";
import { mergeTaskLocalUnion } from "./task-local-union-merge.ts";
import { loadProducerIndex } from "./task-local-union-producer-index.ts";
import { loadTaskLocalUnionSources } from "./task-local-union-source.ts";

export type UnionContinuationV2CliOptions =
  | { readonly command: "help" }
  | {
      readonly command: "run";
      readonly projectGraphRoot: string;
      readonly manifestPath: string;
      readonly producerIndexPath: string;
      readonly consumerTaskIds: readonly string[];
      readonly readOccurrenceIds: readonly string[];
      readonly outputDir: string;
    };

export interface UnionContinuationV2EvidenceManifest {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "UNION_CONTINUATION_EVIDENCE_MANIFEST";
  readonly generatedAt: string;
  readonly sourceMode: "TASK_LOCAL_UNION";
  readonly consumerTaskIds: readonly string[];
  readonly readOccurrences: readonly UnionContinuationV2ManifestEntry[];
  readonly contentHash: string;
}

export interface UnionContinuationV2ManifestEntry {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly file: string;
  readonly contentHash: string;
}

export interface RunUnionContinuationV2CliDependencies {
  readonly now?: () => string;
  readonly write?: (text: string) => void;
}

export function parseUnionContinuationV2Cli(
  args: readonly string[],
): UnionContinuationV2CliOptions {
  if (args.length === 0 || args[0] === "--help" || args[0] === "help")
    return { command: "help" };

  const values = new Map<string, string[]>();
  const known = new Set([
    "--batch-dir",
    "--batch-manifest",
    "--producer-index",
    "--consumer-task-id",
    "--read-occurrence-id",
    "--output-dir",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option || !known.has(option))
      throw new Error(`UNION_CONTINUATION_V2_OPTION_UNKNOWN:${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`UNION_CONTINUATION_V2_OPTION_VALUE_MISSING:${option}`);
    index += 1;
    const existing = values.get(option) ?? [];
    if (
      existing.length > 0 &&
      !["--consumer-task-id", "--read-occurrence-id"].includes(option)
    ) {
      throw new Error(`UNION_CONTINUATION_V2_OPTION_DUPLICATE:${option}`);
    }
    values.set(option, [...existing, value]);
  }

  const batchDir = optionalOne(values, "--batch-dir");
  const explicitManifest = optionalOne(values, "--batch-manifest");
  if (!batchDir && !explicitManifest) throw new Error(usage());
  const manifestPath = resolve(
    explicitManifest ?? join(batchDir!, "batch-manifest.json"),
  );
  const projectGraphRoot = resolve(batchDir ?? dirname(manifestPath));
  const producerIndexPath = resolve(requiredOne(values, "--producer-index"));
  const outputDir = resolve(requiredOne(values, "--output-dir"));
  const consumerTaskIds = values.get("--consumer-task-id") ?? ["119044"];
  if (consumerTaskIds.some((taskId) => taskId.trim() === ""))
    throw new Error("UNION_CONTINUATION_V2_CONSUMER_TASK_ID_INVALID");

  return {
    command: "run",
    projectGraphRoot,
    manifestPath,
    producerIndexPath,
    consumerTaskIds: [...new Set(consumerTaskIds)],
    readOccurrenceIds: [...(values.get("--read-occurrence-id") ?? [])],
    outputDir,
  };
}

export function runUnionContinuationV2Cli(
  args: readonly string[],
  dependencies: RunUnionContinuationV2CliDependencies = {},
): void {
  const options = parseUnionContinuationV2Cli(args);
  const write =
    dependencies.write ?? ((text: string) => process.stdout.write(text));
  if (options.command === "help") {
    write(`${usage()}\n`);
    return;
  }

  const loaded = loadTaskLocalUnionSources({
    manifestPath: options.manifestPath,
    projectGraphRoot: options.projectGraphRoot,
    producerIndexPath: options.producerIndexPath,
  });
  const producerIndex = loadProducerIndex(options.producerIndexPath);
  const generatedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const merge = mergeTaskLocalUnion(loaded);
  mkdirSync(options.outputDir, { recursive: true });

  const outputEntries: UnionContinuationV2ManifestEntry[] = [];
  for (const consumerTaskId of options.consumerTaskIds) {
    const taskResult = traceUnionTaskContinuationV2({
      merge,
      consumerTaskId,
      producerIndexWriters: producerIndex.writers,
    });
    const selected = selectReadOccurrences(
      taskResult.readOccurrences,
      options.readOccurrenceIds,
      consumerTaskId,
    );
    for (const result of selected) {
      const envelope = buildUnionContinuationEvidenceEnvelope({
        merge,
        result,
        generatedAt,
      });
      assertUnionContinuationEvidenceEnvelope(envelope);
      const file = evidenceFileName(
        consumerTaskId,
        result.readOccurrence.readOccurrenceId,
      );
      const path = join(options.outputDir, file);
      writeFileSync(path, canonicalJson(envelope), "utf8");
      const written = JSON.parse(
        readFileSync(path, "utf8"),
      ) as UnionContinuationEvidenceEnvelope;
      assertUnionContinuationEvidenceEnvelope(written);
      outputEntries.push({
        consumerTaskId,
        readOccurrenceId: result.readOccurrence.readOccurrenceId,
        file,
        contentHash: written.contentHash,
      });
    }
  }

  const manifestBody: Omit<UnionContinuationV2EvidenceManifest, "contentHash"> =
    {
      schemaVersion: "1.0.0",
      artifactType: "UNION_CONTINUATION_EVIDENCE_MANIFEST",
      generatedAt,
      sourceMode: "TASK_LOCAL_UNION",
      consumerTaskIds: [...options.consumerTaskIds],
      readOccurrences: outputEntries,
    };
  const manifest: UnionContinuationV2EvidenceManifest = {
    ...manifestBody,
    contentHash: manifestContentHash(manifestBody),
  };
  const manifestPath = join(options.outputDir, "manifest.json");
  writeFileSync(manifestPath, canonicalJson(manifest), "utf8");
  write(
    `${JSON.stringify({
      status: "SUCCESS",
      outputDir: options.outputDir,
      manifest: manifestPath,
      consumerTaskIds: manifest.consumerTaskIds,
      readOccurrenceCount: manifest.readOccurrences.length,
      files: manifest.readOccurrences.map((entry) => entry.file),
    })}\n`,
  );
}

function selectReadOccurrences(
  results: TraceUnionTaskContinuationV2Result["readOccurrences"],
  requested: readonly string[],
  consumerTaskId: string,
) {
  if (requested.length === 0) return results;
  const selected = results.filter((result) =>
    requested.includes(result.readOccurrence.readOccurrenceId),
  );
  if (selected.length !== requested.length) {
    const found = new Set(
      selected.map((result) => result.readOccurrence.readOccurrenceId),
    );
    const missing = requested.filter((id) => !found.has(id));
    throw new Error(
      `UNION_CONTINUATION_V2_READ_OCCURRENCE_NOT_FOUND:${consumerTaskId}:${missing.join(",")}`,
    );
  }
  return selected;
}

function manifestContentHash(
  manifest: Omit<UnionContinuationV2EvidenceManifest, "contentHash">,
): string {
  const { generatedAt: _generatedAt, ...stable } = manifest;
  return sha256(canonicalJson(stable));
}

function evidenceFileName(
  consumerTaskId: string,
  readOccurrenceId: string,
): string {
  const summary = slug(readOccurrenceId).slice(0, 96);
  return `task-${slug(consumerTaskId)}-read-${summary}-${sha256(readOccurrenceId).slice(0, 12)}.json`;
}

function slug(value: string): string {
  return (
    value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown"
  );
}

function optionalOne(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
): string | undefined {
  const found = values.get(option);
  if (!found) return undefined;
  if (found.length !== 1)
    throw new Error(`UNION_CONTINUATION_V2_OPTION_DUPLICATE:${option}`);
  return found[0];
}

function requiredOne(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
): string {
  const value = optionalOne(values, option);
  if (!value)
    throw new Error(`UNION_CONTINUATION_V2_OPTION_REQUIRED:${option}`);
  return value;
}

function usage(): string {
  return [
    "usage: union-continuation-v2 --batch-dir <batch-dir> [--batch-manifest <batch-manifest.json>] --producer-index <producer-index.json> --consumer-task-id <taskId> [--consumer-task-id <taskId>] --output-dir <dir> [--read-occurrence-id <readOccurrenceId>]",
    "example: npm --prefix packages/data-graph run union-continuation-v2 -- --batch-dir <published-task-local-batch-dir> --producer-index <producer-index.json> --consumer-task-id 119044 --output-dir tmp/wp8-continuation-evidence",
  ].join("\n");
}

if (
  process.argv[1] &&
  basename(process.argv[1]) === "union-continuation-v2-cli.ts"
)
  runUnionContinuationV2Cli(process.argv.slice(2));
