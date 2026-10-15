import { compareText, sortedUnique } from "../../contracts/ordering.ts";
import { canonicalJson, safeSegment, sha256 } from "../../contracts/runtime.ts";

export { compareText, sortedUnique } from "../../contracts/ordering.ts";

export const PROJECT_TOPOLOGY_SCHEMA_VERSION = "1.0.0" as const;
export const PROJECT_TOPOLOGY_PROJECTION_VERSION = "1.0.0" as const;
export const PROJECT_TOPOLOGY_SNAPSHOT_TYPE =
  "PROJECT_TOPOLOGY_SNAPSHOT" as const;
export const PROJECT_TOPOLOGY_MANIFEST_TYPE =
  "PROJECT_TOPOLOGY_PROJECTION_MANIFEST" as const;

/**
 * Topology snapshot source modes are mutually exclusive per snapshot.
 * `DIRECT_PROJECT_EVIDENCE` is reserved for a future change (not implemented here).
 */
export type ProjectTopologySourceMode =
  "LEGACY_ARTIFACT_PAIRS" | "TASK_LOCAL_UNION";

export type ProjectTopologyCoverageStatus = "COMPLETE" | "PARTIAL";
export type ProjectTopologyQueryStatus =
  "ok" | "partial" | "not_found" | "ambiguous" | "error";

export type ProjectTopologyNodeType =
  "PROJECT_SNAPSHOT" | "TASK" | "PHYSICAL_DATASET" | "BOUNDARY";

export type ProjectTopologyEdgeType =
  | "HAS_ENTRY_TASK"
  | "ROOT_REACHES_TASK"
  | "READS"
  | "WRITES"
  | "PRODUCER_BRIDGE"
  | "SCHEDULE_DEPENDS_ON"
  | "HAS_BOUNDARY";

export type ProjectTopologyRelationLayer =
  "PROJECT" | "PROJECTION_SCOPE" | "DATA_PRODUCTION" | "SCHEDULE" | "BOUNDARY";

export interface ProjectTopologyArtifactRef {
  readonly refId: string;
  readonly contract:
    "OneHopReconciliationResult" | "MultiHopReconciliationResult";
  readonly artifactType:
    "TABLE_MULTI_HOP_RECONCILIATION" | "PROJECT_ROOT_TRAVERSAL_VIEW" | null;
  readonly schemaVersion: string;
  readonly rootTaskId: string;
  readonly contentSha256: string;
  readonly declaredContentHash: string | null;
  readonly logicalLocator: string;
}

export interface ProjectTopologyRootSource {
  readonly rootTaskId: string;
  /** Missing means a pre-source-mode legacy snapshot. */
  readonly sourceMode?: ProjectTopologySourceMode;
  readonly oneHop: ProjectTopologyArtifactRef;
  readonly multiHop: ProjectTopologyArtifactRef;
  readonly producerIndex: {
    readonly contentHash: string;
    readonly inputFingerprint: string;
    readonly status: "VALID_SUCCESS" | "VALID_PARTIAL";
  };
  readonly coverage: Readonly<Record<string, unknown>>;
  readonly limits: Readonly<Record<string, unknown>>;
  readonly sourceIssues: readonly string[];
  readonly sourceBoundaries: Readonly<Record<string, unknown>>;
}

export interface ProjectTopologySnapshotV1 {
  readonly schemaVersion: typeof PROJECT_TOPOLOGY_SCHEMA_VERSION;
  readonly artifactType: typeof PROJECT_TOPOLOGY_SNAPSHOT_TYPE;
  readonly projectionVersion: typeof PROJECT_TOPOLOGY_PROJECTION_VERSION;
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly rootTaskIds: readonly string[];
  readonly sources: readonly ProjectTopologyRootSource[];
  readonly coverageStatus: ProjectTopologyCoverageStatus;
  readonly contentHash: string;
}

export interface ProjectTopologyEvidenceRef {
  readonly source: string;
  readonly provider: string;
  readonly locator: string;
  readonly observedAt: string | null;
  readonly contentHash: string | null;
  readonly detail?: unknown;
}

export interface ProjectTopologyNodeRecord {
  readonly schemaVersion: typeof PROJECT_TOPOLOGY_SCHEMA_VERSION;
  readonly recordType: "NODE";
  readonly nodeId: string;
  readonly nodeType: ProjectTopologyNodeType;
  readonly sourceRootTaskIds: readonly string[];
  readonly sourceArtifactRefIds: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface ProjectTopologyEdgeRecord {
  readonly schemaVersion: typeof PROJECT_TOPOLOGY_SCHEMA_VERSION;
  readonly recordType: "EDGE";
  readonly edgeId: string;
  readonly edgeType: ProjectTopologyEdgeType;
  readonly relationLayer: ProjectTopologyRelationLayer;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly sourceRootTaskIds: readonly string[];
  readonly sourceArtifactRefIds: readonly string[];
  readonly evidenceRefs: readonly ProjectTopologyEvidenceRef[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface ProjectTopologyProjectionV1 {
  readonly snapshot: ProjectTopologySnapshotV1;
  readonly nodes: readonly ProjectTopologyNodeRecord[];
  readonly edges: readonly ProjectTopologyEdgeRecord[];
}

export interface ProjectTopologyProjectionManifestV1 {
  readonly schemaVersion: typeof PROJECT_TOPOLOGY_SCHEMA_VERSION;
  readonly artifactType: typeof PROJECT_TOPOLOGY_MANIFEST_TYPE;
  readonly projectionVersion: typeof PROJECT_TOPOLOGY_PROJECTION_VERSION;
  readonly snapshotId: string;
  readonly projectKey: string;
  readonly rootTaskIds: readonly string[];
  readonly snapshotContentHash: string;
  readonly coverageStatus: ProjectTopologyCoverageStatus;
  readonly counts: {
    readonly nodes: number;
    readonly edges: number;
    readonly boundaries: number;
  };
  readonly files: {
    readonly snapshot: ProjectTopologyPublishedFile;
    readonly nodes: ProjectTopologyPublishedFile;
    readonly edges: ProjectTopologyPublishedFile;
  };
  readonly contentHash: string;
}

export interface ProjectTopologyPublishedFile {
  readonly fileName: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly recordCount: number | null;
}

export interface ProjectTopologyQueryEnvelope<T> {
  readonly schemaVersion: typeof PROJECT_TOPOLOGY_SCHEMA_VERSION;
  readonly query:
    "get_project_topology" | "trace_project_upstream" | "explain_topology_edge";
  readonly status: ProjectTopologyQueryStatus;
  readonly snapshotId: string;
  readonly result: T;
  readonly warnings: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}

export function projectKeySegment(projectKey: string): string {
  return safeSegment(projectKey, "projectKey");
}

export function taskNodeId(taskId: string): string {
  return `task:${safeSegment(taskId, "taskId")}`;
}

export function physicalDatasetIdentity(input: {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string;
}): Readonly<Record<string, string | null>> {
  return {
    platform: input.platform?.trim().toLowerCase() ?? null,
    dataSource: input.dataSource?.trim().toLowerCase() ?? null,
    qualifiedName: input.qualifiedName.trim().toLowerCase(),
  };
}

export function physicalDatasetNodeId(input: {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly qualifiedName: string;
}): string {
  return stableId("dataset", physicalDatasetIdentity(input));
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${sha256(canonicalJson(value))}`;
}

export function projectSnapshotId(input: {
  readonly projectKey: string;
  readonly rootTaskIds: readonly string[];
  readonly sources: readonly ProjectTopologyRootSource[];
}): string {
  projectKeySegment(input.projectKey);
  const contentHash = sha256(
    canonicalJson({
      projectKey: input.projectKey,
      projectionVersion: PROJECT_TOPOLOGY_PROJECTION_VERSION,
      rootTaskIds: sortedUnique(input.rootTaskIds),
      sources: [...input.sources]
        .sort((left, right) => compareText(left.rootTaskId, right.rootTaskId))
        .map((source) => ({
          rootTaskId: source.rootTaskId,
          ...(source.sourceMode === undefined
            ? {}
            : { sourceMode: source.sourceMode }),
          oneHop: source.oneHop,
          multiHop: source.multiHop,
        })),
    }),
  );
  return `project-snapshot-${contentHash}`;
}

export function projectedEdgeId(input: {
  readonly edgeType: ProjectTopologyEdgeType;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly semanticKey?: unknown;
}): string {
  return stableId("edge", input);
}

export function snapshotContentHash(
  snapshot: Omit<ProjectTopologySnapshotV1, "contentHash">,
): string {
  return sha256(canonicalJson(snapshot));
}

export function manifestContentHash(
  manifest: Omit<ProjectTopologyProjectionManifestV1, "contentHash">,
): string {
  return sha256(canonicalJson(manifest));
}

export function validateProjectTopologyProjection(
  projection: ProjectTopologyProjectionV1,
): void {
  const { snapshot, nodes, edges } = projection;
  if (
    snapshot.schemaVersion !== PROJECT_TOPOLOGY_SCHEMA_VERSION ||
    snapshot.artifactType !== PROJECT_TOPOLOGY_SNAPSHOT_TYPE ||
    snapshot.projectionVersion !== PROJECT_TOPOLOGY_PROJECTION_VERSION
  )
    throw new Error("PROJECT_TOPOLOGY_SNAPSHOT_CONTRACT_INVALID");
  projectKeySegment(snapshot.projectKey);
  if (
    snapshot.rootTaskIds.length === 0 ||
    JSON.stringify(snapshot.rootTaskIds) !==
      JSON.stringify(sortedUnique(snapshot.rootTaskIds))
  )
    throw new Error("PROJECT_TOPOLOGY_ROOTS_INVALID");
  if (snapshot.sources.length !== snapshot.rootTaskIds.length)
    throw new Error("PROJECT_TOPOLOGY_SOURCES_INVALID");
  const sourceRoots = sortedUnique(
    snapshot.sources.map((source) => source.rootTaskId),
  );
  if (JSON.stringify(sourceRoots) !== JSON.stringify(snapshot.rootTaskIds))
    throw new Error("PROJECT_TOPOLOGY_SOURCE_ROOTS_INVALID");
  validateSourceModes(snapshot);
  if (
    projectSnapshotId({
      projectKey: snapshot.projectKey,
      rootTaskIds: snapshot.rootTaskIds,
      sources: snapshot.sources,
    }) !== snapshot.snapshotId
  )
    throw new Error("PROJECT_TOPOLOGY_SNAPSHOT_ID_INVALID");
  const { contentHash: _contentHash, ...snapshotBody } = snapshot;
  if (snapshotContentHash(snapshotBody) !== snapshot.contentHash)
    throw new Error("PROJECT_TOPOLOGY_SNAPSHOT_HASH_INVALID");

  assertSortedUniqueRecords(nodes, "nodeId", "PROJECT_TOPOLOGY_NODES");
  assertSortedUniqueRecords(edges, "edgeId", "PROJECT_TOPOLOGY_EDGES");
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  if (!nodeIds.has(snapshot.snapshotId))
    throw new Error("PROJECT_TOPOLOGY_PROJECT_NODE_MISSING");
  for (const node of nodes) {
    if (
      node.schemaVersion !== PROJECT_TOPOLOGY_SCHEMA_VERSION ||
      node.recordType !== "NODE"
    )
      throw new Error("PROJECT_TOPOLOGY_NODE_CONTRACT_INVALID");
    assertSortedUnique(node.sourceRootTaskIds, "NODE_SOURCE_ROOTS");
    assertSortedUnique(node.sourceArtifactRefIds, "NODE_SOURCE_ARTIFACTS");
  }
  for (const edge of edges) {
    if (
      edge.schemaVersion !== PROJECT_TOPOLOGY_SCHEMA_VERSION ||
      edge.recordType !== "EDGE"
    )
      throw new Error("PROJECT_TOPOLOGY_EDGE_CONTRACT_INVALID");
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))
      throw new Error(`PROJECT_TOPOLOGY_EDGE_ENDPOINT_MISSING:${edge.edgeId}`);
    assertSortedUnique(edge.sourceRootTaskIds, "EDGE_SOURCE_ROOTS");
    assertSortedUnique(edge.sourceArtifactRefIds, "EDGE_SOURCE_ARTIFACTS");
  }
}

function validateSourceModes(snapshot: ProjectTopologySnapshotV1): void {
  const modes = new Set(
    snapshot.sources.map(
      (source) => source.sourceMode ?? "LEGACY_ARTIFACT_PAIRS",
    ),
  );
  // Legacy projection path: only LEGACY_ARTIFACT_PAIRS. TASK_LOCAL_UNION uses
  // validateTaskLocalUnionSnapshot and must never appear in root sources[].
  if (modes.size !== 1 || !modes.has("LEGACY_ARTIFACT_PAIRS"))
    throw new Error("PROJECT_TOPOLOGY_SOURCE_MODE_INVALID");
  const producerIdentities = new Set(
    snapshot.sources.map(
      (source) =>
        `${source.producerIndex.inputFingerprint}\u0000${source.producerIndex.contentHash}`,
    ),
  );
  if (producerIdentities.size !== 1)
    throw new Error("PROJECT_TOPOLOGY_SOURCE_IDENTITY_MIXED");
}

function assertSortedUnique(values: readonly string[], label: string): void {
  if (JSON.stringify(values) !== JSON.stringify(sortedUnique(values)))
    throw new Error(`${label}_INVALID`);
}

function assertSortedUniqueRecords<
  T extends Record<K, string>,
  K extends keyof T,
>(values: readonly T[], key: K, label: string): void {
  const actual = values.map((value) => value[key]);
  if (JSON.stringify(actual) !== JSON.stringify(sortedUnique(actual)))
    throw new Error(`${label}_ORDER_OR_DUPLICATE_INVALID`);
}
