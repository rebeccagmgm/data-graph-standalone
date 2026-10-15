import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  canonicalJson,
  canonicalJsonl,
  sha256,
} from "../../contracts/runtime.ts";
import {
  PROJECT_TOPOLOGY_MANIFEST_TYPE,
  PROJECT_TOPOLOGY_PROJECTION_VERSION,
  PROJECT_TOPOLOGY_SCHEMA_VERSION,
  compareText,
  manifestContentHash,
  projectKeySegment,
  validateProjectTopologyProjection,
  type ProjectTopologyEdgeRecord,
  type ProjectTopologyNodeRecord,
  type ProjectTopologyProjectionManifestV1,
  type ProjectTopologyProjectionV1,
  type ProjectTopologyPublishedFile,
  type ProjectTopologySnapshotV1,
} from "../contracts/project-topology-contract.ts";

export const PROJECT_TOPOLOGY_SNAPSHOT_FILE = "snapshot.json" as const;
export const PROJECT_TOPOLOGY_NODES_FILE = "topology.nodes.jsonl" as const;
export const PROJECT_TOPOLOGY_EDGES_FILE = "topology.edges.jsonl" as const;
export const PROJECT_TOPOLOGY_MANIFEST_FILE =
  "projection-manifest.json" as const;

const PUBLISHED_FILES = [
  PROJECT_TOPOLOGY_SNAPSHOT_FILE,
  PROJECT_TOPOLOGY_NODES_FILE,
  PROJECT_TOPOLOGY_EDGES_FILE,
  PROJECT_TOPOLOGY_MANIFEST_FILE,
] as const;

export interface SerializedProjectTopology {
  readonly snapshot: string;
  readonly nodes: string;
  readonly edges: string;
  readonly manifest: string;
  readonly manifestDocument: ProjectTopologyProjectionManifestV1;
}

export interface LoadedProjectTopologyDirectory {
  readonly directory: string;
  readonly projection: ProjectTopologyProjectionV1;
  readonly manifest: ProjectTopologyProjectionManifestV1;
}

export interface PublishProjectTopologyOptions {
  readonly outputRoot: string;
  readonly beforeInstall?: () => void;
}

export interface PublishProjectTopologyResult {
  readonly status: "CREATED" | "REUSED";
  readonly directory: string;
  readonly manifest: ProjectTopologyProjectionManifestV1;
}

export function serializeProjectTopology(
  projection: ProjectTopologyProjectionV1,
): SerializedProjectTopology {
  validateProjectTopologyProjection(projection);
  const snapshot = canonicalJson(projection.snapshot);
  const nodes = canonicalJsonl(projection.nodes);
  const edges = canonicalJsonl(projection.edges);
  const manifestBody = {
    schemaVersion: PROJECT_TOPOLOGY_SCHEMA_VERSION,
    artifactType: PROJECT_TOPOLOGY_MANIFEST_TYPE,
    projectionVersion: PROJECT_TOPOLOGY_PROJECTION_VERSION,
    snapshotId: projection.snapshot.snapshotId,
    projectKey: projection.snapshot.projectKey,
    rootTaskIds: [...projection.snapshot.rootTaskIds],
    snapshotContentHash: projection.snapshot.contentHash,
    coverageStatus: projection.snapshot.coverageStatus,
    counts: {
      nodes: projection.nodes.length,
      edges: projection.edges.length,
      boundaries: projection.nodes.filter(
        (node) => node.nodeType === "BOUNDARY",
      ).length,
    },
    files: {
      snapshot: publishedFile(PROJECT_TOPOLOGY_SNAPSHOT_FILE, snapshot, null),
      nodes: publishedFile(
        PROJECT_TOPOLOGY_NODES_FILE,
        nodes,
        projection.nodes.length,
      ),
      edges: publishedFile(
        PROJECT_TOPOLOGY_EDGES_FILE,
        edges,
        projection.edges.length,
      ),
    },
  } as const;
  const manifestDocument: ProjectTopologyProjectionManifestV1 = {
    ...manifestBody,
    contentHash: manifestContentHash(manifestBody),
  };
  return {
    snapshot,
    nodes,
    edges,
    manifest: canonicalJson(manifestDocument),
    manifestDocument,
  };
}

export function publishProjectTopology(
  projection: ProjectTopologyProjectionV1,
  options: PublishProjectTopologyOptions,
): PublishProjectTopologyResult {
  const projectKey = projectKeySegment(projection.snapshot.projectKey);
  const outputRoot = resolve(options.outputRoot);
  const snapshotsRoot = join(outputRoot, "projects", projectKey, "snapshots");
  const finalDirectory = join(snapshotsRoot, projection.snapshot.snapshotId);
  const serialized = serializeProjectTopology(projection);
  mkdirSync(snapshotsRoot, { recursive: true });

  if (existsSync(finalDirectory)) {
    assertDirectoryMatches(finalDirectory, serialized);
    const loaded = loadProjectTopologyDirectory(finalDirectory);
    return {
      status: "REUSED",
      directory: finalDirectory,
      manifest: loaded.manifest,
    };
  }

  const staging = mkdtempSync(
    join(snapshotsRoot, ".project-topology-staging-"),
  );
  try {
    writeSerialized(staging, serialized);
    loadProjectTopologyDirectory(staging);
    options.beforeInstall?.();
    if (existsSync(finalDirectory)) {
      assertDirectoryMatches(finalDirectory, serialized);
      return {
        status: "REUSED",
        directory: finalDirectory,
        manifest: loadProjectTopologyDirectory(finalDirectory).manifest,
      };
    }
    renameSync(staging, finalDirectory);
    const loaded = loadProjectTopologyDirectory(finalDirectory);
    return {
      status: "CREATED",
      directory: finalDirectory,
      manifest: loaded.manifest,
    };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

export function loadProjectTopologyDirectory(
  directoryInput: string,
  limits: { readonly maxFileBytes?: number } = {},
): LoadedProjectTopologyDirectory {
  const directory = resolve(directoryInput);
  const maxFileBytes = positiveLimit(
    limits.maxFileBytes ?? 512 * 1024 * 1024,
    "MAX_FILE_BYTES",
  );
  const manifest = parseJsonFile<ProjectTopologyProjectionManifestV1>(
    join(directory, PROJECT_TOPOLOGY_MANIFEST_FILE),
    maxFileBytes,
  );
  validateManifestContract(manifest);
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
  const snapshot = parseJsonBytes<ProjectTopologySnapshotV1>(
    snapshotBytes,
    "SNAPSHOT",
  );
  const nodes = parseJsonl<ProjectTopologyNodeRecord>(nodeBytes, "NODES");
  const edges = parseJsonl<ProjectTopologyEdgeRecord>(edgeBytes, "EDGES");
  const projection: ProjectTopologyProjectionV1 = { snapshot, nodes, edges };
  validateProjectTopologyProjection(projection);
  if (
    snapshot.snapshotId !== manifest.snapshotId ||
    snapshot.projectKey !== manifest.projectKey ||
    snapshot.contentHash !== manifest.snapshotContentHash ||
    snapshot.coverageStatus !== manifest.coverageStatus ||
    JSON.stringify(snapshot.rootTaskIds) !==
      JSON.stringify(manifest.rootTaskIds) ||
    nodes.length !== manifest.counts.nodes ||
    edges.length !== manifest.counts.edges ||
    nodes.filter((node) => node.nodeType === "BOUNDARY").length !==
      manifest.counts.boundaries
  )
    throw new Error("PROJECT_TOPOLOGY_MANIFEST_PROJECTION_MISMATCH");
  return { directory, projection, manifest };
}

function writeSerialized(
  directory: string,
  serialized: SerializedProjectTopology,
): void {
  writeFileSync(
    join(directory, PROJECT_TOPOLOGY_SNAPSHOT_FILE),
    serialized.snapshot,
    "utf8",
  );
  writeFileSync(
    join(directory, PROJECT_TOPOLOGY_NODES_FILE),
    serialized.nodes,
    "utf8",
  );
  writeFileSync(
    join(directory, PROJECT_TOPOLOGY_EDGES_FILE),
    serialized.edges,
    "utf8",
  );
  writeFileSync(
    join(directory, PROJECT_TOPOLOGY_MANIFEST_FILE),
    serialized.manifest,
    "utf8",
  );
}

function assertDirectoryMatches(
  directory: string,
  serialized: SerializedProjectTopology,
): void {
  const expected = new Map<string, string>([
    [PROJECT_TOPOLOGY_SNAPSHOT_FILE, serialized.snapshot],
    [PROJECT_TOPOLOGY_NODES_FILE, serialized.nodes],
    [PROJECT_TOPOLOGY_EDGES_FILE, serialized.edges],
    [PROJECT_TOPOLOGY_MANIFEST_FILE, serialized.manifest],
  ]);
  for (const fileName of PUBLISHED_FILES) {
    const path = join(directory, fileName);
    if (
      !existsSync(path) ||
      readFileSync(path, "utf8") !== expected.get(fileName)
    )
      throw new Error(`PROJECT_TOPOLOGY_IMMUTABLE_CONFLICT:${fileName}`);
  }
}

function validateManifestContract(
  manifest: ProjectTopologyProjectionManifestV1,
): void {
  if (
    manifest.schemaVersion !== PROJECT_TOPOLOGY_SCHEMA_VERSION ||
    manifest.artifactType !== PROJECT_TOPOLOGY_MANIFEST_TYPE ||
    manifest.projectionVersion !== PROJECT_TOPOLOGY_PROJECTION_VERSION
  )
    throw new Error("PROJECT_TOPOLOGY_MANIFEST_CONTRACT_INVALID");
  const { contentHash: _contentHash, ...body } = manifest;
  if (manifestContentHash(body) !== manifest.contentHash)
    throw new Error("PROJECT_TOPOLOGY_MANIFEST_HASH_INVALID");
  projectKeySegment(manifest.projectKey);
  for (const file of Object.values(manifest.files)) {
    if (
      !PUBLISHED_FILES.includes(
        file.fileName as (typeof PUBLISHED_FILES)[number],
      )
    )
      throw new Error("PROJECT_TOPOLOGY_MANIFEST_FILE_INVALID");
  }
}

function publishedFile(
  fileName: string,
  contents: string,
  recordCount: number | null,
): ProjectTopologyPublishedFile {
  const bytes = Buffer.from(contents, "utf8");
  return {
    fileName,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    recordCount,
  };
}

function validatePublishedFile(
  file: ProjectTopologyPublishedFile,
  bytes: Buffer,
  expectedRecordCount: number | null,
): void {
  if (
    file.byteLength !== bytes.byteLength ||
    file.sha256 !== sha256(bytes) ||
    file.recordCount !== expectedRecordCount
  )
    throw new Error(
      `PROJECT_TOPOLOGY_FILE_HASH_OR_COUNT_INVALID:${file.fileName}`,
    );
}

function parseJsonFile<T>(path: string, maxBytes: number): T {
  return parseJsonBytes<T>(readBounded(path, maxBytes), "JSON");
}

function parseJsonBytes<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(`PROJECT_TOPOLOGY_${label}_INVALID`);
  }
}

function parseJsonl<T>(bytes: Buffer, label: string): T[] {
  const lines = bytes
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "");
  try {
    return lines.map((line) => JSON.parse(line) as T);
  } catch {
    throw new Error(`PROJECT_TOPOLOGY_${label}_JSONL_INVALID`);
  }
}

function readBounded(path: string, maxBytes: number): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(
      `PROJECT_TOPOLOGY_FILE_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (bytes.byteLength > maxBytes)
    throw new Error("PROJECT_TOPOLOGY_FILE_LIMIT");
  return bytes;
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${label}_INVALID`);
  return value;
}
