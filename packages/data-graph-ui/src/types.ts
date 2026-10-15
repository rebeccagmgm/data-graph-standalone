import type {
  ConsumptionScope,
  ConsumptionScopeItem,
} from "../../data-graph/src/asset-graph/consumption-scope";

export type {
  ConsumptionScope,
  ConsumptionScopeItem,
} from "../../data-graph/src/asset-graph/consumption-scope";

export type GraphLayer = "table" | "field";
export type Direction = "up" | "down";
export type MetadataStatus =
  | "AVAILABLE"
  | "ANNOTATION_NOT_RECORDED"
  | "METADATA_UNAVAILABLE"
  | "METADATA_READ_FAILED";
export interface MetadataValue {
  status: MetadataStatus;
  reason?: string;
  description?: string;
  comment?: string;
  name?: string;
  ordinal?: number;
  rawType?: string;
  partition?: boolean;
}
export interface TableMetadata {
  table: MetadataValue;
  field?: MetadataValue;
  schema?: {
    displayName?: string;
    description?: string;
  };
  identity?: {
    platform: string;
    dataSource: string;
    qualifiedName: string;
    stableTableId: string;
  };
  tableName?: string;
  objectType?: string;
  source?: string;
  sourcePath?: string;
  sourceHash?: string;
  ddlHash?: string;
  collectedAt?: string;
  updatedAt?: string;
  contentHash?: string;
  parseStatus?: "PARSED" | "UNSUPPORTED" | "INVALID";
  metadataCatalog?: {
    status: "READY" | "MISSING" | "UNREADABLE" | "INCOMPATIBLE";
    reason?: string;
    version?: string;
    builtAt?: string;
    parserVersion?: string;
  };
  versionRelation?: "RUNTIME_INPUT_PACK_NOT_GRAPH_VERSION";
}
export interface FieldValueOrigin {
  kind: "CONSTANT" | "EXPRESSION" | "UNRESOLVED";
  label: string;
  expression: string;
}
export interface GraphNode {
  /** View-only members of a merged table card; original query nodes stay intact. */
  tableContexts?: GraphNode[];
  /** Canonical dataset behind a task-scoped display instance. */
  physicalNodeId?: string;
  valueOrigin?: FieldValueOrigin;
  id: string;
  kind: string;
  label?: string;
  table?: string;
  column?: string;
  taskId?: string;
  writeId?: string;
  depth?: number;
  detail?: Record<string, unknown>;
  metadata?: TableMetadata;
  [key: string]: unknown;
}
export interface GraphEdge {
  /** All original table IO edges represented by this display line. */
  tableRelations?: GraphEdge[];
  id?: string;
  key?: string;
  from: string;
  to: string;
  kind: string;
  status?: string;
  detail?: Record<string, unknown>;
}
export interface ConsumptionWriteRef {
  taskId: string;
  writeId: string;
  rawNodeIds: string[];
  rawEdgeIds: string[];
  scope: ConsumptionScope;
}
export interface ConsumptionField {
  column: string;
  rawNodeIds: string[];
  rawEdgeIds: string[];
  writeRefs: ConsumptionWriteRef[];
}
export interface ConsumptionGroup {
  id: string;
  role: "READ" | "WRITE" | "OTHER";
  presentation: "FIELD_GROUP" | "EVIDENCE_CONTAINER" | "RAW_NODE";
  scopeEquivalence: "PROVEN" | "NOT_ASSERTED";
  depth: number;
  table?: string;
  taskId?: string;
  physicalIdentity?: string;
  scope: ConsumptionScope;
  rawNodeIds: string[];
  rawEdgeIds: string[];
  rootNodeIds: string[];
  fields: ConsumptionField[];
  writeRefs: ConsumptionWriteRef[];
}
export interface ConsumptionFieldMapping {
  sourceColumn?: string;
  targetColumn?: string;
  sourceNodeIds: string[];
  targetNodeIds: string[];
  rawEdgeIds: string[];
}
export interface ConsumptionBranch {
  id: string;
  fromGroupId: string;
  toGroupId: string;
  kind: string;
  status?: string;
  scope: ConsumptionScope;
  rawEdgeIds: string[];
  rootNodeIds: string[];
  fieldMappings: ConsumptionFieldMapping[];
}
export interface ConsumptionRootPath {
  rootNodeId: string;
  rawNodeIds: string[];
  rawEdgeIds: string[];
  groupIds: string[];
  branchIds: string[];
}
export interface TraceConsumption {
  schemaVersion: "1.0.0";
  groups: ConsumptionGroup[];
  branches: ConsumptionBranch[];
  rootPaths: ConsumptionRootPath[];
}
export interface TerminalNode {
  nodeId: string;
  role: string;
  reason: string;
  ruleRef: string;
}
export interface TraceResult {
  traversalScope?: "TASK_SCHEDULE";
  scheduleReferences?: Array<{taskId: string; direction: Direction; neighborTaskIds: string[]}>;
  partitionSelection?: import("../../data-graph/src/asset-graph/partition-selection").PartitionSelection;
  scopeWarnings?: string[];
  /** Selected roots not queried because the combined relationship budget was reached. */
  unqueriedRootNodeIds?: string[];
  /** Frontend-only completeness summary when independent table traces share one canvas. */
  multiRootSummary?: {
    requested: number;
    completed: number;
    failed: Array<{ rootId: string; label: string; message: string }>;
    truncatedRootIds: string[];
  };
  version: string;
  layer: GraphLayer;
  direction: Direction;
  depthLimit: number;
  edgeLimit: number;
  truncated: boolean;
  stoppedBy: "EDGE_LIMIT" | "DEPTH_LIMIT" | null;
  frontierNodeIds: string[];
  terminalNodes: TerminalNode[];
  /** Local SQLite scheduler-catalog task names for task cards synthesized by the view. */
  taskLabels?: Record<string, string>;
  taskClusters?: Record<string, string>;
  taskTopics?: Record<string, string>;
  taskTopicDescriptions?: Record<string, string>;
  /** Shared CLI/HTTP consumption organization; raw nodes and edges remain canonical. */
  consumption?: TraceConsumption;
  nodes: GraphNode[];
  edges: GraphEdge[];
  elapsedMs: number;
}
export interface TaskDetail {
  targetDdls?: Array<{
    table: string;
    writeId?: string;
    status: "AVAILABLE" | "UNAVAILABLE" | "CHANGED";
    content?: string;
    source?: string;
    collectedAt?: string;
  }>;
  version: string;
  taskId: string;
  taskName?: string;
  owner?: string;
  cluster?: string;
  /** UI request identity retained for exact follow-up evidence loading. */
  requestedColumn?: string;
  requestedWriteId?: string;
  taskCategory?: string;
  coverage?: string;
  failureReason?: string;
  bindings: Array<{
    column: string;
    table?: string;
    outputScope?: "FINAL" | "OTHER" | "UNKNOWN";
    writeId?: string;
    expression?: string;
    metadata?: TableMetadata;
    valueOrigin?: FieldValueOrigin;
    inputFields?: Array<{ table: string; column: string }>;
  }>;
  controls: Array<{
    kind: string;
    joinType?: string;
    condition?: string;
    groupBy?: unknown;
    window?: unknown;
    sourceText?: string;
  }>;
  sqlSources?: Array<{ slot: string; content: string }>;
}
export interface Anchor {
  partitionSelection?: import("../../data-graph/src/asset-graph/partition-selection").PartitionSelection;
  taskId?: string;
  table?: string;
  nodeId?: string;
  column?: string;
  writeId?: string;
  /** Raw field members used when a visible field row represents several writes. */
  memberNodeIds?: string[];
  /** View-only task-table anchors behind a merged physical table focus. */
  tableContextIds?: string[];
  label: string;
}
export interface ProcessingSourceLocation {
  slot: string;
  lineStart?: number;
  lineEnd?: number;
}
export interface TaskProcessingStage {
  id: string;
  kind: "SOURCE" | "WRITE" | "BRANCH";
  table: string;
  label?: string;
  writeId?: string;
  readOccurrenceId?: string;
  statementId?: string;
  statementIndex?: number;
  slot?: string;
  role?: "FINAL" | "INTERMEDIATE" | "SOURCE";
  expressions: Array<{
    id: string;
    column: string;
    text: string;
    roles?: string[];
    sourceLocation?: ProcessingSourceLocation;
  }>;
  controls: Array<{
    id: string;
    kind: string;
    text: string;
    sourceLocation?: ProcessingSourceLocation;
  }>;
  gapIds?: string[];
}
export interface TaskProcessingEdge {
  id: string;
  from: string;
  to: string;
  kind: "VALUE" | "CONDITION" | "CONTROL" | "MATERIALIZATION";
  label?: string;
  status?: "RESOLVED" | "UNRESOLVED";
  columns?: string[];
  expressionIds?: string[];
}
export interface TaskFieldExplanation {
  version: string;
  taskId: string;
  anchor: { writeId: string; column: string };
  status: "COMPLETE" | "PARTIAL" | "TRUNCATED";
  stages: TaskProcessingStage[];
  edges: TaskProcessingEdge[];
  gaps: Array<{ id?: string; code: string; message: string; stageId?: string }>;
  limits: { maxDepth: number; maxNodes: number; maxEdges: number };
  frontierStageIds: string[];
  stoppedBy: string[];
}
export interface OverviewResult {
  version: string;
  stages: string[];
  regions: Array<{ schema: string; stage: string; datasetCount: number }>;
  flows: Array<{
    fromSchema: string;
    toSchema: string;
    fromStage: string;
    toStage: string;
    taskCount: number;
    evidenceKind: "TABLE_IO";
  }>;
  limits: { regions: number; flows: number };
  truncated: { regions: boolean; flows: boolean };
  excluded: { unqualifiedDatasets: number };
}
export interface RegionResult {
  version: string;
  schema: string;
  items: GraphNode[];
  pagination: { offset: number; limit: number; nextOffset: number | null };
  truncated: boolean;
}
