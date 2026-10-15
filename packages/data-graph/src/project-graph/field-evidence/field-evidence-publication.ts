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
  FIELD_EVIDENCE_MANIFEST_TYPE,
  FIELD_EVIDENCE_PROJECTION_VERSION,
  FIELD_EVIDENCE_SCHEMA_VERSION,
  fieldEvidenceManifestContentHash,
  validateFieldEvidenceProjection,
  type FieldEvidenceEdgeRecord,
  type FieldEvidenceNodeRecord,
  type FieldEvidenceProjectionManifestV1,
  type FieldEvidenceProjectionV1,
  type FieldEvidencePublishedFile,
  type FieldEvidenceSnapshotV1,
} from "./field-evidence-contract.ts";

export const FIELD_EVIDENCE_SNAPSHOT_FILE = "snapshot.json" as const;
export const FIELD_EVIDENCE_NODES_FILE = "field-evidence.nodes.jsonl" as const;
export const FIELD_EVIDENCE_EDGES_FILE = "field-evidence.edges.jsonl" as const;
export const FIELD_EVIDENCE_MANIFEST_FILE = "projection-manifest.json" as const;

const PUBLISHED_FILES = [
  FIELD_EVIDENCE_SNAPSHOT_FILE,
  FIELD_EVIDENCE_NODES_FILE,
  FIELD_EVIDENCE_EDGES_FILE,
  FIELD_EVIDENCE_MANIFEST_FILE,
] as const;

export interface SerializedFieldEvidence {
  readonly snapshot: string;
  readonly nodes: string;
  readonly edges: string;
  readonly manifest: string;
  readonly manifestDocument: FieldEvidenceProjectionManifestV1;
}

export interface LoadedFieldEvidenceDirectory {
  readonly directory: string;
  readonly projection: FieldEvidenceProjectionV1;
  readonly manifest: FieldEvidenceProjectionManifestV1;
}

export interface PublishFieldEvidenceOptions {
  readonly outputRoot: string;
  readonly beforeInstall?: () => void;
}

export interface PublishFieldEvidenceResult {
  readonly status: "CREATED" | "REUSED";
  readonly directory: string;
  readonly manifest: FieldEvidenceProjectionManifestV1;
}

export function serializeFieldEvidence(
  projection: FieldEvidenceProjectionV1,
): SerializedFieldEvidence {
  validateFieldEvidenceProjection(projection);
  const snapshot = canonicalJson(projection.snapshot);
  const nodes = canonicalJsonl(projection.nodes);
  const edges = canonicalJsonl(projection.edges);
  const manifestBody = {
    schemaVersion: FIELD_EVIDENCE_SCHEMA_VERSION,
    artifactType: FIELD_EVIDENCE_MANIFEST_TYPE,
    projectionVersion: FIELD_EVIDENCE_PROJECTION_VERSION,
    snapshotId: projection.snapshot.snapshotId,
    projectKey: projection.snapshot.projectKey,
    snapshotContentHash: projection.snapshot.contentHash,
    coverageStatus: projection.snapshot.slice.coverageStatus,
    selection: projection.snapshot.selection,
    limits: projection.snapshot.limits,
    counts: {
      nodes: projection.nodes.length,
      edges: projection.edges.length,
      boundaries: projection.nodes.filter(
        (node) => node.nodeType === "BOUNDARY",
      ).length,
    },
    files: {
      snapshot: publishedFile(FIELD_EVIDENCE_SNAPSHOT_FILE, snapshot, null),
      nodes: publishedFile(
        FIELD_EVIDENCE_NODES_FILE,
        nodes,
        projection.nodes.length,
      ),
      edges: publishedFile(
        FIELD_EVIDENCE_EDGES_FILE,
        edges,
        projection.edges.length,
      ),
    },
  } as const;
  const manifestDocument: FieldEvidenceProjectionManifestV1 = {
    ...manifestBody,
    contentHash: fieldEvidenceManifestContentHash(manifestBody),
  };
  return {
    snapshot,
    nodes,
    edges,
    manifest: canonicalJson(manifestDocument),
    manifestDocument,
  };
}

export function publishFieldEvidence(
  projection: FieldEvidenceProjectionV1,
  options: PublishFieldEvidenceOptions,
): PublishFieldEvidenceResult {
  const projectKey = projectKeySegment(projection.snapshot.projectKey);
  const outputRoot = resolve(options.outputRoot);
  const fieldEvidenceRoot = join(
    outputRoot,
    "projects",
    projectKey,
    "field-evidence",
  );
  const finalDirectory = join(
    fieldEvidenceRoot,
    projection.snapshot.snapshotId,
  );
  const serialized = serializeFieldEvidence(projection);
  mkdirSync(fieldEvidenceRoot, { recursive: true });

  if (existsSync(finalDirectory)) {
    assertDirectoryMatches(finalDirectory, serialized);
    return {
      status: "REUSED",
      directory: finalDirectory,
      manifest: loadFieldEvidenceDirectory(finalDirectory).manifest,
    };
  }

  const staging = mkdtempSync(
    join(fieldEvidenceRoot, ".field-evidence-staging-"),
  );
  try {
    writeSerialized(staging, serialized);
    loadFieldEvidenceDirectory(staging);
    options.beforeInstall?.();
    if (existsSync(finalDirectory)) {
      assertDirectoryMatches(finalDirectory, serialized);
      return {
        status: "REUSED",
        directory: finalDirectory,
        manifest: loadFieldEvidenceDirectory(finalDirectory).manifest,
      };
    }
    renameSync(staging, finalDirectory);
    return {
      status: "CREATED",
      directory: finalDirectory,
      manifest: loadFieldEvidenceDirectory(finalDirectory).manifest,
    };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

export function loadFieldEvidenceDirectory(
  directoryInput: string,
  limits: { readonly maxFileBytes?: number } = {},
): LoadedFieldEvidenceDirectory {
  const directory = resolve(directoryInput);
  const maxFileBytes = positiveLimit(
    limits.maxFileBytes ?? 512 * 1024 * 1024,
    "MAX_FILE_BYTES",
  );
  const manifest = parseJsonFile<FieldEvidenceProjectionManifestV1>(
    join(directory, FIELD_EVIDENCE_MANIFEST_FILE),
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
  const snapshot = parseJsonBytes<FieldEvidenceSnapshotV1>(
    snapshotBytes,
    "SNAPSHOT",
  );
  const nodes = parseJsonl<FieldEvidenceNodeRecord>(nodeBytes, "NODES");
  const edges = parseJsonl<FieldEvidenceEdgeRecord>(edgeBytes, "EDGES");
  const projection: FieldEvidenceProjectionV1 = { snapshot, nodes, edges };
  validateFieldEvidenceProjection(projection);
  if (
    snapshot.snapshotId !== manifest.snapshotId ||
    snapshot.projectKey !== manifest.projectKey ||
    snapshot.contentHash !== manifest.snapshotContentHash ||
    snapshot.slice.coverageStatus !== manifest.coverageStatus ||
    canonicalJson(snapshot.selection) !== canonicalJson(manifest.selection) ||
    canonicalJson(snapshot.limits) !== canonicalJson(manifest.limits) ||
    nodes.length !== manifest.counts.nodes ||
    edges.length !== manifest.counts.edges ||
    nodes.filter((node) => node.nodeType === "BOUNDARY").length !==
      manifest.counts.boundaries
  )
    throw new Error("FIELD_EVIDENCE_MANIFEST_PROJECTION_MISMATCH");
  return { directory, projection, manifest };
}

function writeSerialized(
  directory: string,
  serialized: SerializedFieldEvidence,
): void {
  writeFileSync(
    join(directory, FIELD_EVIDENCE_SNAPSHOT_FILE),
    serialized.snapshot,
    "utf8",
  );
  writeFileSync(
    join(directory, FIELD_EVIDENCE_NODES_FILE),
    serialized.nodes,
    "utf8",
  );
  writeFileSync(
    join(directory, FIELD_EVIDENCE_EDGES_FILE),
    serialized.edges,
    "utf8",
  );
  writeFileSync(
    join(directory, FIELD_EVIDENCE_MANIFEST_FILE),
    serialized.manifest,
    "utf8",
  );
}

function assertDirectoryMatches(
  directory: string,
  serialized: SerializedFieldEvidence,
): void {
  const expected = new Map<string, string>([
    [FIELD_EVIDENCE_SNAPSHOT_FILE, serialized.snapshot],
    [FIELD_EVIDENCE_NODES_FILE, serialized.nodes],
    [FIELD_EVIDENCE_EDGES_FILE, serialized.edges],
    [FIELD_EVIDENCE_MANIFEST_FILE, serialized.manifest],
  ]);
  for (const fileName of PUBLISHED_FILES) {
    const path = join(directory, fileName);
    if (
      !existsSync(path) ||
      readFileSync(path, "utf8") !== expected.get(fileName)
    )
      throw new Error(`FIELD_EVIDENCE_IMMUTABLE_CONFLICT:${fileName}`);
  }
}

function validateManifestContract(
  manifest: FieldEvidenceProjectionManifestV1,
): void {
  if (
    manifest.schemaVersion !== FIELD_EVIDENCE_SCHEMA_VERSION ||
    manifest.artifactType !== FIELD_EVIDENCE_MANIFEST_TYPE ||
    manifest.projectionVersion !== FIELD_EVIDENCE_PROJECTION_VERSION
  )
    throw new Error("FIELD_EVIDENCE_MANIFEST_CONTRACT_INVALID");
  const { contentHash: _contentHash, ...body } = manifest;
  if (fieldEvidenceManifestContentHash(body) !== manifest.contentHash)
    throw new Error("FIELD_EVIDENCE_MANIFEST_HASH_INVALID");
  projectKeySegment(manifest.projectKey);
  for (const file of Object.values(manifest.files)) {
    if (
      !PUBLISHED_FILES.includes(
        file.fileName as (typeof PUBLISHED_FILES)[number],
      )
    )
      throw new Error("FIELD_EVIDENCE_MANIFEST_FILE_INVALID");
  }
}

function publishedFile(
  fileName: string,
  contents: string,
  recordCount: number | null,
): FieldEvidencePublishedFile {
  const bytes = Buffer.from(contents, "utf8");
  return {
    fileName,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    recordCount,
  };
}

function validatePublishedFile(
  file: FieldEvidencePublishedFile,
  bytes: Buffer,
  expectedRecordCount: number | null,
): void {
  if (
    file.byteLength !== bytes.byteLength ||
    file.sha256 !== sha256(bytes) ||
    file.recordCount !== expectedRecordCount
  )
    throw new Error(
      `FIELD_EVIDENCE_FILE_HASH_OR_COUNT_INVALID:${file.fileName}`,
    );
}

function parseJsonFile<T>(path: string, maxBytes: number): T {
  return parseJsonBytes<T>(readBounded(path, maxBytes), "JSON");
}

function parseJsonBytes<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(`FIELD_EVIDENCE_${label}_INVALID`);
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
    throw new Error(`FIELD_EVIDENCE_${label}_JSONL_INVALID`);
  }
}

function readBounded(path: string, maxBytes: number): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(
      `FIELD_EVIDENCE_FILE_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (bytes.byteLength > maxBytes) throw new Error("FIELD_EVIDENCE_FILE_LIMIT");
  return bytes;
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`FIELD_EVIDENCE_${label}_INVALID`);
  return value;
}
