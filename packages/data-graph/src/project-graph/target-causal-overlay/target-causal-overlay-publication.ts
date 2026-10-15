import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  canonicalJson,
  canonicalJsonl,
  sha256,
} from "../../contracts/runtime.ts";
import { projectKeySegment } from "../contracts/project-topology-contract.ts";
import {
  TARGET_CAUSAL_OVERLAY_MANIFEST_TYPE,
  TARGET_CAUSAL_OVERLAY_PROJECTION_VERSION,
  TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
  targetCausalOverlayManifestContentHash,
  validateTargetCausalOverlayProjection,
  type TargetCausalOverlayEdgeRecord,
  type TargetCausalOverlayNodeRecord,
  type TargetCausalOverlayProjectionManifestV1,
  type TargetCausalOverlayProjectionV1,
  type TargetCausalOverlaySnapshotV1,
  type TargetCausalOverlaySourceFileRef,
} from "./target-causal-overlay-contract.ts";

export const TARGET_CAUSAL_OVERLAY_SNAPSHOT_FILE = "snapshot.json" as const;
export const TARGET_CAUSAL_OVERLAY_NODES_FILE =
  "target-causal.nodes.jsonl" as const;
export const TARGET_CAUSAL_OVERLAY_EDGES_FILE =
  "target-causal.edges.jsonl" as const;
export const TARGET_CAUSAL_OVERLAY_MANIFEST_FILE =
  "projection-manifest.json" as const;

const PUBLISHED_FILES = [
  TARGET_CAUSAL_OVERLAY_SNAPSHOT_FILE,
  TARGET_CAUSAL_OVERLAY_NODES_FILE,
  TARGET_CAUSAL_OVERLAY_EDGES_FILE,
  TARGET_CAUSAL_OVERLAY_MANIFEST_FILE,
] as const;

export interface SerializedTargetCausalOverlay {
  readonly snapshot: string;
  readonly nodes: string;
  readonly edges: string;
  readonly manifest: string;
  readonly manifestDocument: TargetCausalOverlayProjectionManifestV1;
}

export interface LoadedTargetCausalOverlayDirectory {
  readonly directory: string;
  readonly projection: TargetCausalOverlayProjectionV1;
  readonly manifest: TargetCausalOverlayProjectionManifestV1;
}

export interface PublishTargetCausalOverlayResult {
  readonly status: "CREATED" | "REUSED";
  readonly directory: string;
  readonly manifest: TargetCausalOverlayProjectionManifestV1;
}

export function serializeTargetCausalOverlay(
  projection: TargetCausalOverlayProjectionV1,
): SerializedTargetCausalOverlay {
  validateTargetCausalOverlayProjection(projection);
  const snapshot = canonicalJson(projection.snapshot);
  const nodes = canonicalJsonl(projection.nodes);
  const edges = canonicalJsonl(projection.edges);
  const manifestBody = {
    schemaVersion: TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION,
    artifactType: TARGET_CAUSAL_OVERLAY_MANIFEST_TYPE,
    projectionVersion: TARGET_CAUSAL_OVERLAY_PROJECTION_VERSION,
    snapshotId: projection.snapshot.snapshotId,
    projectKey: projection.snapshot.projectKey,
    snapshotContentHash: projection.snapshot.contentHash,
    coverageStatus: projection.snapshot.summary.coverageStatus,
    targetWriteId: projection.snapshot.targetWrite.targetWriteId,
    runtimeRerunDecision: projection.snapshot.runtimeRerunDecision,
    counts: {
      nodes: projection.nodes.length,
      edges: projection.edges.length,
      boundaries: projection.nodes.filter(({ nodeType }) => nodeType === "GAP")
        .length,
    },
    files: {
      snapshot: publishedFile(
        TARGET_CAUSAL_OVERLAY_SNAPSHOT_FILE,
        snapshot,
        null,
      ),
      nodes: publishedFile(
        TARGET_CAUSAL_OVERLAY_NODES_FILE,
        nodes,
        projection.nodes.length,
      ),
      edges: publishedFile(
        TARGET_CAUSAL_OVERLAY_EDGES_FILE,
        edges,
        projection.edges.length,
      ),
    },
  } as const;
  const manifestDocument: TargetCausalOverlayProjectionManifestV1 = {
    ...manifestBody,
    contentHash: targetCausalOverlayManifestContentHash(manifestBody),
  };
  return {
    snapshot,
    nodes,
    edges,
    manifest: canonicalJson(manifestDocument),
    manifestDocument,
  };
}

export function publishTargetCausalOverlay(
  projection: TargetCausalOverlayProjectionV1,
  options: {
    readonly outputRoot: string;
    readonly beforeInstall?: () => void;
  },
): PublishTargetCausalOverlayResult {
  const projectKey = projectKeySegment(projection.snapshot.projectKey);
  const overlayRoot = join(
    resolve(options.outputRoot),
    "projects",
    projectKey,
    "target-causal-overlays",
  );
  const finalDirectory = join(overlayRoot, projection.snapshot.snapshotId);
  const serialized = serializeTargetCausalOverlay(projection);
  mkdirSync(overlayRoot, { recursive: true });
  if (existsSync(finalDirectory)) {
    assertDirectoryMatches(finalDirectory, serialized);
    return {
      status: "REUSED",
      directory: finalDirectory,
      manifest: loadTargetCausalOverlayDirectory(finalDirectory).manifest,
    };
  }
  const staging = mkdtempSync(join(overlayRoot, ".target-causal-staging-"));
  try {
    writeSerialized(staging, serialized);
    loadTargetCausalOverlayDirectory(staging);
    options.beforeInstall?.();
    if (existsSync(finalDirectory)) {
      assertDirectoryMatches(finalDirectory, serialized);
      return {
        status: "REUSED",
        directory: finalDirectory,
        manifest: loadTargetCausalOverlayDirectory(finalDirectory).manifest,
      };
    }
    renameSync(staging, finalDirectory);
    return {
      status: "CREATED",
      directory: finalDirectory,
      manifest: loadTargetCausalOverlayDirectory(finalDirectory).manifest,
    };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

export function loadTargetCausalOverlayDirectory(
  directoryInput: string,
  limits: { readonly maxFileBytes?: number } = {},
): LoadedTargetCausalOverlayDirectory {
  const directory = resolve(directoryInput);
  const maxFileBytes = positiveLimit(limits.maxFileBytes ?? 512 * 1024 * 1024);
  const manifest = parseJson<TargetCausalOverlayProjectionManifestV1>(
    readBounded(
      join(directory, TARGET_CAUSAL_OVERLAY_MANIFEST_FILE),
      maxFileBytes,
    ),
    "MANIFEST",
  );
  validateManifest(manifest);
  const snapshotBytes = readBounded(
    join(directory, manifest.files.snapshot.fileName),
    maxFileBytes,
  );
  const nodeBytes = readBounded(
    join(directory, manifest.files.nodes.fileName),
    maxFileBytes,
  );
  const edgeBytes = readBounded(
    join(directory, manifest.files.edges.fileName),
    maxFileBytes,
  );
  validatePublishedFile(manifest.files.snapshot, snapshotBytes, null);
  validatePublishedFile(manifest.files.nodes, nodeBytes, manifest.counts.nodes);
  validatePublishedFile(manifest.files.edges, edgeBytes, manifest.counts.edges);
  const projection: TargetCausalOverlayProjectionV1 = {
    snapshot: parseJson<TargetCausalOverlaySnapshotV1>(
      snapshotBytes,
      "SNAPSHOT",
    ),
    nodes: parseJsonl<TargetCausalOverlayNodeRecord>(nodeBytes, "NODES"),
    edges: parseJsonl<TargetCausalOverlayEdgeRecord>(edgeBytes, "EDGES"),
  };
  validateTargetCausalOverlayProjection(projection);
  if (
    projection.snapshot.snapshotId !== manifest.snapshotId ||
    projection.snapshot.projectKey !== manifest.projectKey ||
    projection.snapshot.contentHash !== manifest.snapshotContentHash ||
    projection.snapshot.summary.coverageStatus !== manifest.coverageStatus ||
    projection.snapshot.targetWrite.targetWriteId !== manifest.targetWriteId ||
    projection.snapshot.runtimeRerunDecision !==
      manifest.runtimeRerunDecision ||
    projection.nodes.length !== manifest.counts.nodes ||
    projection.edges.length !== manifest.counts.edges ||
    projection.nodes.filter(({ nodeType }) => nodeType === "GAP").length !==
      manifest.counts.boundaries
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_MANIFEST_PROJECTION_MISMATCH");
  return { directory, projection, manifest };
}

function writeSerialized(
  directory: string,
  serialized: SerializedTargetCausalOverlay,
): void {
  writeFileSync(
    join(directory, TARGET_CAUSAL_OVERLAY_SNAPSHOT_FILE),
    serialized.snapshot,
    "utf8",
  );
  writeFileSync(
    join(directory, TARGET_CAUSAL_OVERLAY_NODES_FILE),
    serialized.nodes,
    "utf8",
  );
  writeFileSync(
    join(directory, TARGET_CAUSAL_OVERLAY_EDGES_FILE),
    serialized.edges,
    "utf8",
  );
  writeFileSync(
    join(directory, TARGET_CAUSAL_OVERLAY_MANIFEST_FILE),
    serialized.manifest,
    "utf8",
  );
}

function assertDirectoryMatches(
  directory: string,
  serialized: SerializedTargetCausalOverlay,
): void {
  const expected = new Map<string, string>([
    [TARGET_CAUSAL_OVERLAY_SNAPSHOT_FILE, serialized.snapshot],
    [TARGET_CAUSAL_OVERLAY_NODES_FILE, serialized.nodes],
    [TARGET_CAUSAL_OVERLAY_EDGES_FILE, serialized.edges],
    [TARGET_CAUSAL_OVERLAY_MANIFEST_FILE, serialized.manifest],
  ]);
  for (const fileName of PUBLISHED_FILES) {
    const path = join(directory, fileName);
    if (
      !existsSync(path) ||
      readFileSync(path, "utf8") !== expected.get(fileName)
    )
      throw new Error(`TARGET_CAUSAL_OVERLAY_IMMUTABLE_CONFLICT:${fileName}`);
  }
}

function validateManifest(
  manifest: TargetCausalOverlayProjectionManifestV1,
): void {
  if (
    manifest.schemaVersion !== TARGET_CAUSAL_OVERLAY_SCHEMA_VERSION ||
    manifest.artifactType !== TARGET_CAUSAL_OVERLAY_MANIFEST_TYPE ||
    manifest.projectionVersion !== TARGET_CAUSAL_OVERLAY_PROJECTION_VERSION ||
    manifest.runtimeRerunDecision !== "NOT_EVALUATED"
  )
    throw new Error("TARGET_CAUSAL_OVERLAY_MANIFEST_CONTRACT_INVALID");
  const { contentHash: _contentHash, ...body } = manifest;
  if (targetCausalOverlayManifestContentHash(body) !== manifest.contentHash)
    throw new Error("TARGET_CAUSAL_OVERLAY_MANIFEST_HASH_INVALID");
  projectKeySegment(manifest.projectKey);
  for (const file of Object.values(manifest.files))
    if (
      !PUBLISHED_FILES.includes(
        file.fileName as (typeof PUBLISHED_FILES)[number],
      )
    )
      throw new Error("TARGET_CAUSAL_OVERLAY_MANIFEST_FILE_INVALID");
}

function publishedFile(
  fileName: string,
  contents: string,
  recordCount: number | null,
): TargetCausalOverlaySourceFileRef {
  const bytes = Buffer.from(contents, "utf8");
  return {
    fileName,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    recordCount,
  };
}

function validatePublishedFile(
  file: TargetCausalOverlaySourceFileRef,
  bytes: Buffer,
  expectedRecordCount: number | null,
): void {
  if (
    file.byteLength !== bytes.byteLength ||
    file.sha256 !== sha256(bytes) ||
    file.recordCount !== expectedRecordCount
  )
    throw new Error(
      `TARGET_CAUSAL_OVERLAY_FILE_HASH_OR_COUNT_INVALID:${file.fileName}`,
    );
}

function parseJson<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(`TARGET_CAUSAL_OVERLAY_${label}_JSON_INVALID`);
  }
}

function parseJsonl<T>(bytes: Buffer, label: string): T[] {
  try {
    return bytes
      .toString("utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as T);
  } catch {
    throw new Error(`TARGET_CAUSAL_OVERLAY_${label}_JSONL_INVALID`);
  }
}

function readBounded(path: string, maxBytes: number): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error("TARGET_CAUSAL_OVERLAY_FILE_READ_FAILED");
  }
  if (bytes.byteLength > maxBytes)
    throw new Error("TARGET_CAUSAL_OVERLAY_FILE_LIMIT");
  return bytes;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("TARGET_CAUSAL_OVERLAY_MAX_FILE_BYTES_INVALID");
  return value;
}
