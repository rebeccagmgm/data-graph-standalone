import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalJson, sha256 } from "../../../contracts/runtime.ts";
import {
  assertUnionContinuationIndex,
  assertV2LoadedInputs,
  buildUnionContinuationIndex,
  type UnionContinuationIndex,
} from "../../../continuation/continuation-index.ts";
import { mergeTaskLocalUnion } from "./task-local-union-merge.ts";
import { loadProducerIndex } from "./task-local-union-producer-index.ts";
import { loadTaskLocalUnionSources } from "./task-local-union-source.ts";

export type UnionContinuationIndexCliOptions =
  | { readonly command: "help" }
  | {
      readonly command: "run";
      readonly projectGraphRoot: string;
      readonly manifestPath: string;
      readonly producerIndexPath: string;
      readonly consumerTaskIds: readonly string[];
      readonly outputDir: string;
    };

export interface UnionContinuationIndexManifest {
  readonly schemaVersion: "1.0.0";
  readonly artifactType: "UNION_CONTINUATION_INDEX_MANIFEST";
  readonly generatedAt: string;
  readonly sourceMode: "TASK_LOCAL_UNION";
  readonly indexFile: string;
  readonly indexContentHash: string;
  readonly consumerTaskIds: readonly string[];
  readonly projectedTaskCount: number;
  readonly readOccurrenceCount: number;
  readonly contentHash: string;
}

export interface RunUnionContinuationIndexCliDependencies {
  readonly now?: () => string;
  readonly write?: (text: string) => void;
}

export function parseUnionContinuationIndexCli(
  args: readonly string[],
): UnionContinuationIndexCliOptions {
  if (args.length === 0 || args[0] === "--help" || args[0] === "help")
    return { command: "help" };

  const values = new Map<string, string[]>();
  const known = new Set([
    "--batch-dir",
    "--batch-manifest",
    "--producer-index",
    "--consumer-task-id",
    "--output-dir",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option || !known.has(option))
      throw new Error(`UNION_CONTINUATION_INDEX_OPTION_UNKNOWN:${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(
        `UNION_CONTINUATION_INDEX_OPTION_VALUE_MISSING:${option}`,
      );
    index += 1;
    const existing = values.get(option) ?? [];
    if (existing.length > 0 && option !== "--consumer-task-id")
      throw new Error(`UNION_CONTINUATION_INDEX_OPTION_DUPLICATE:${option}`);
    values.set(option, [...existing, value]);
  }

  const batchDir = optionalOne(values, "--batch-dir");
  const explicitManifest = optionalOne(values, "--batch-manifest");
  if (!batchDir && !explicitManifest) throw new Error(usage());
  const manifestPath = resolve(
    explicitManifest ?? join(batchDir!, "batch-manifest.json"),
  );
  return {
    command: "run",
    projectGraphRoot: resolve(batchDir ?? dirname(manifestPath)),
    manifestPath,
    producerIndexPath: resolve(requiredOne(values, "--producer-index")),
    consumerTaskIds: [...(values.get("--consumer-task-id") ?? [])],
    outputDir: resolve(requiredOne(values, "--output-dir")),
  };
}

export function runUnionContinuationIndexCli(
  args: readonly string[],
  dependencies: RunUnionContinuationIndexCliDependencies = {},
): void {
  const options = parseUnionContinuationIndexCli(args);
  const write =
    dependencies.write ?? ((text: string) => process.stdout.write(text));
  if (options.command === "help") {
    write(`${usage()}\n`);
    return;
  }

  // Loading and building happen before the output directory is created. The
  // v2 preflight in buildUnionContinuationIndex therefore cannot leave a
  // consumable partial index behind when a PROJECTED input is not 1.2.0.
  const loaded = loadTaskLocalUnionSources({
    manifestPath: options.manifestPath,
    projectGraphRoot: options.projectGraphRoot,
    producerIndexPath: options.producerIndexPath,
  });
  assertV2LoadedInputs(loaded);
  const producerIndex = loadProducerIndex(options.producerIndexPath);
  const merge = mergeTaskLocalUnion(loaded);
  const generatedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const index = buildUnionContinuationIndex({
    merge,
    producerIndexWriters: producerIndex.writers,
    generatedAt,
    ...(options.consumerTaskIds.length > 0
      ? { consumerTaskIds: options.consumerTaskIds }
      : {}),
  });

  const outputDir = options.outputDir;
  const indexFile = "union-continuation-index.json";
  const indexPath = join(outputDir, indexFile);
  const manifestPath = join(outputDir, "manifest.json");
  if (existsSync(indexPath) || existsSync(manifestPath))
    throw new Error(`UNION_CONTINUATION_INDEX_OUTPUT_EXISTS:${outputDir}`);
  mkdirSync(outputDir, { recursive: true });

  writeFileSync(indexPath, canonicalJson(index), "utf8");
  const writtenIndex = JSON.parse(
    readFileSync(indexPath, "utf8"),
  ) as UnionContinuationIndex;
  assertUnionContinuationIndex(writtenIndex);

  const consumerTaskIds =
    options.consumerTaskIds.length > 0
      ? [...new Set(options.consumerTaskIds)].sort()
      : merge.taskEvidence
          .filter((evidence) => evidence.coverageStatus === "PROJECTED")
          .map((evidence) => evidence.taskId)
          .sort();
  const manifestBody: Omit<UnionContinuationIndexManifest, "contentHash"> = {
    schemaVersion: "1.0.0",
    artifactType: "UNION_CONTINUATION_INDEX_MANIFEST",
    generatedAt,
    sourceMode: "TASK_LOCAL_UNION",
    indexFile,
    indexContentHash: writtenIndex.contentHash,
    consumerTaskIds,
    projectedTaskCount: writtenIndex.input.taskProjections.length,
    readOccurrenceCount: writtenIndex.entries.length,
  };
  const manifest: UnionContinuationIndexManifest = {
    ...manifestBody,
    contentHash: manifestContentHash(manifestBody),
  };
  writeFileSync(manifestPath, canonicalJson(manifest), "utf8");
  const writtenManifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as UnionContinuationIndexManifest;
  assertUnionContinuationIndexManifest(writtenManifest);
  write(
    `${JSON.stringify({
      status: "SUCCESS",
      outputDir,
      index: indexPath,
      manifest: manifestPath,
      consumerTaskIds,
      projectedTaskCount: manifest.projectedTaskCount,
      readOccurrenceCount: manifest.readOccurrenceCount,
      contentHash: writtenIndex.contentHash,
    })}\n`,
  );
}

export function assertUnionContinuationIndexManifest(
  manifest: UnionContinuationIndexManifest,
): void {
  if (
    manifest.schemaVersion !== "1.0.0" ||
    manifest.artifactType !== "UNION_CONTINUATION_INDEX_MANIFEST"
  ) {
    throw new Error("UNION_CONTINUATION_INDEX_MANIFEST_CONTRACT_INVALID");
  }
  const { contentHash: _contentHash, ...body } = manifest;
  if (manifestContentHash(body) !== manifest.contentHash)
    throw new Error("UNION_CONTINUATION_INDEX_MANIFEST_HASH_MISMATCH");
}

function manifestContentHash(
  manifest: Omit<UnionContinuationIndexManifest, "contentHash">,
): string {
  const { generatedAt: _generatedAt, ...stable } = manifest;
  return sha256(canonicalJson(stable));
}

function optionalOne(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
): string | undefined {
  const found = values.get(option);
  if (!found) return undefined;
  if (found.length !== 1)
    throw new Error(`UNION_CONTINUATION_INDEX_OPTION_DUPLICATE:${option}`);
  return found[0];
}

function requiredOne(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
): string {
  const value = optionalOne(values, option);
  if (!value)
    throw new Error(`UNION_CONTINUATION_INDEX_OPTION_REQUIRED:${option}`);
  return value;
}

function usage(): string {
  return [
    "usage: union-continuation-index --batch-dir <batch-dir> [--batch-manifest <batch-manifest.json>] --producer-index <producer-index.json> --output-dir <dir> [--consumer-task-id <taskId>]",
    "example: npm --prefix packages/data-graph run union-continuation-index -- --batch-dir <published-task-local-batch-dir> --producer-index <producer-index.json> --consumer-task-id 119044 --output-dir tmp/wp8-continuation-index",
    "default: index every PROJECTED task in the batch; every PROJECTED projection must be schema 1.2.0 or 1.3.0",
  ].join("\n");
}

if (
  process.argv[1] &&
  basename(process.argv[1]) === "union-continuation-index-cli.ts"
)
  runUnionContinuationIndexCli(process.argv.slice(2));
