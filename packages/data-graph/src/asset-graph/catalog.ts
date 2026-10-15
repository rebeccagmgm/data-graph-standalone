import type {
  TaskLocalNode,
  TaskLocalProjection,
} from "../../../../scripts/project-graph/task-local/contract.ts";
import {
  physicalDatasetIdentity,
  stableId,
} from "../../../../scripts/project-graph/task-local/ids.ts";
import type {
  AssetEdge,
  AssetNode,
  CompiledTask,
  FactRecord,
} from "./compile.ts";

interface DatasetIdentity {
  platform: string;
  dataSource: string;
  qualifiedName: string;
}

interface ColumnReference {
  columnId: string;
  datasetId: string;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const normalize = (value: unknown): string => text(value).toLowerCase();
const detail = (node: AssetNode | AssetEdge): FactRecord =>
  JSON.parse(node.detail) as FactRecord;

function confirmedIdentity(
  properties: Readonly<FactRecord>,
): DatasetIdentity | null {
  const platform = normalize(properties.platform);
  const dataSource = normalize(properties.dataSource);
  const qualifiedName = normalize(properties.qualifiedName);
  return properties.identityStatus === "CONFIRMED" &&
    platform &&
    dataSource &&
    qualifiedName
    ? { platform, dataSource, qualifiedName }
    : null;
}

const identityKey = (identity: DatasetIdentity): string =>
  JSON.stringify(physicalDatasetIdentity(identity));

/** Catalogue identity follows the confirmed dataset tuple; it is not a Facts field ID. */
export function assetColumnNodeId(
  identity: DatasetIdentity & { column: string },
): string {
  return stableId("asset-column", {
    ...physicalDatasetIdentity(identity),
    column: normalize(identity.column),
  });
}

function appendToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

/** Add asset associations without changing occurrence identities or continuation rules. */
export function addAssetCatalog(
  projection: TaskLocalProjection,
  graph: CompiledTask,
): CompiledTask {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const projectionNodes = new Map(
    projection.nodes.map((node) => [node.nodeId, node]),
  );
  const datasetsByIdentity = new Map<string, TaskLocalNode[]>();
  const readsByOccurrence = new Map<string, TaskLocalNode[]>();
  const readDatasets = new Map<string, Set<string>>();
  const writeDatasets = new Map<string, Set<string>>();
  const writeParents = new Map<string, Set<string>>();
  const physicalSources = new Map<string, string[]>();

  const associate = (
    map: Map<string, Set<string>>,
    from: string,
    to: string,
  ): void => {
    const current = map.get(from) ?? new Set<string>();
    current.add(to);
    map.set(from, current);
  };
  const single = (
    values: ReadonlySet<string> | undefined,
  ): string | undefined =>
    values?.size === 1 ? values.values().next().value : undefined;

  for (const node of projection.nodes) {
    const identity = confirmedIdentity(node.properties);
    if (
      node.nodeType === "PHYSICAL_DATASET" &&
      identity &&
      nodes.has(node.nodeId)
    ) {
      appendToMap(datasetsByIdentity, identityKey(identity), node);
    }
    if (node.nodeType === "READ_OCCURRENCE") {
      const occurrence = text(node.properties.occurrenceId);
      if (occurrence) appendToMap(readsByOccurrence, occurrence, node);
    }
  }
  for (const edge of projection.edges) {
    if (projectionNodes.get(edge.toNodeId)?.nodeType !== "PHYSICAL_DATASET")
      continue;
    const parentType = projectionNodes.get(edge.fromNodeId)?.nodeType;
    if (edge.edgeType === "READS" && parentType === "READ_OCCURRENCE") {
      associate(readDatasets, edge.fromNodeId, edge.toNodeId);
    }
    if (edge.edgeType === "WRITES" && parentType === "TARGET_WRITE") {
      associate(writeDatasets, edge.fromNodeId, edge.toNodeId);
    }
  }
  for (const write of projection.localClosure?.finalWrites ?? []) {
    if (
      projectionNodes.get(write.targetWriteNodeId)?.nodeType ===
        "TARGET_WRITE" &&
      projectionNodes.get(write.datasetNodeId)?.nodeType === "PHYSICAL_DATASET"
    ) {
      associate(writeDatasets, write.targetWriteNodeId, write.datasetNodeId);
    }
  }
  for (const edge of graph.edges) {
    if (
      edge.kind === "HAS_FIELD" &&
      projectionNodes.get(edge.from)?.nodeType === "TARGET_WRITE" &&
      nodes.get(edge.to)?.kind === "WRITE_FIELD"
    ) {
      associate(writeParents, edge.to, edge.from);
    }
    if (
      edge.kind === "OBSERVED_FIELD" &&
      nodes.get(edge.from)?.kind === "PHYSICAL_FIELD"
    ) {
      appendToMap(physicalSources, edge.to, edge.from);
    }
  }

  const addEdge = (
    from: string,
    to: string,
    kind: string,
    properties: FactRecord,
    layer = "catalog",
    status = "OBSERVED",
    sourceEdgeId?: string,
  ): void => {
    const id = stableId("asset-catalog-edge", {
      taskId: graph.taskId,
      from,
      to,
      kind,
      sourceEdgeId: sourceEdgeId ?? null,
    });
    if (!edges.has(id))
      edges.set(id, {
        id,
        from,
        to,
        kind,
        layer,
        owner: graph.taskId,
        status,
        detail: JSON.stringify(properties),
      });
  };

  const columnFor = (
    datasetId: string,
    rawColumn: string,
  ): ColumnReference | null => {
    const dataset = projectionNodes.get(datasetId);
    const identity =
      dataset?.nodeType === "PHYSICAL_DATASET"
        ? confirmedIdentity(dataset.properties)
        : null;
    const column = normalize(rawColumn);
    if (!identity || !column || !nodes.has(datasetId)) return null;
    const columnId = assetColumnNodeId({ ...identity, column });
    if (!nodes.has(columnId))
      nodes.set(columnId, {
        id: columnId,
        kind: "COLUMN",
        taskId: "",
        table: identity.qualifiedName,
        column,
        writeId: "",
        label: `${identity.qualifiedName}.${column}`,
        detail: JSON.stringify({
          ...identity,
          column,
          identityStatus: "CONFIRMED",
          identityScope: "DATASET_COLUMN",
        }),
      });
    addEdge(datasetId, columnId, "HAS_COLUMN", {
      datasetNodeId: datasetId,
      identityStatus: "CONFIRMED",
    });
    return { columnId, datasetId };
  };

  const physicalColumns = new Map<string, ColumnReference>();
  for (const field of projection.nodes) {
    if (field.nodeType !== "PHYSICAL_FIELD" || !nodes.has(field.nodeId))
      continue;
    const identity = confirmedIdentity(field.properties);
    const datasets = identity
      ? (datasetsByIdentity.get(identityKey(identity)) ?? [])
      : [];
    if (datasets.length !== 1) continue;
    const column = columnFor(
      datasets[0]!.nodeId,
      text(field.properties.column),
    );
    if (!column) continue;
    physicalColumns.set(field.nodeId, column);
    addEdge(field.nodeId, column.columnId, "IDENTIFIES_COLUMN", {
      sourceFieldNodeId: field.nodeId,
      sourceFieldIdentity: field.properties,
    });
  }

  const readColumns = new Map<string, ColumnReference>();
  const readOccurrences = new Map<string, string>();
  for (const read of graph.reads) {
    if (nodes.get(read.id)?.kind !== "READ_FIELD") continue;
    const occurrences = readsByOccurrence.get(read.occurrence) ?? [];
    if (occurrences.length !== 1) continue;
    const occurrence = occurrences[0]!;
    if (!nodes.has(occurrence.nodeId)) continue;
    addEdge(occurrence.nodeId, read.id, "HAS_FIELD", {
      sourceReadOccurrenceId: read.occurrence,
    });
    const datasetId = single(readDatasets.get(occurrence.nodeId));
    if (!datasetId || occurrence.properties.identityStatus !== "CONFIRMED")
      continue;
    const columns = (physicalSources.get(read.id) ?? [])
      .map((id) => physicalColumns.get(id))
      .filter(
        (column): column is ColumnReference => column?.datasetId === datasetId,
      );
    const columnIds = new Set(columns.map((column) => column.columnId));
    if (columnIds.size !== 1) continue;
    const column = columns[0]!;
    readColumns.set(read.id, column);
    readOccurrences.set(read.id, read.occurrence);
    addEdge(read.id, column.columnId, "OBSERVES_COLUMN", {
      sourceReadOccurrenceId: read.occurrence,
    });
  }

  const writeColumns = new Map<string, ColumnReference>();
  const writeObservations = new Map<string, string>();
  for (const write of graph.writes) {
    const targetId = single(writeParents.get(write.id));
    const target = targetId ? projectionNodes.get(targetId) : undefined;
    const writeObservationId = text(target?.properties.writeObservationId);
    if (
      !targetId ||
      !writeObservationId ||
      write.writeId !== writeObservationId
    )
      continue;
    const datasetId = single(writeDatasets.get(targetId));
    const column = datasetId ? columnFor(datasetId, write.column) : null;
    if (!column) continue;
    writeColumns.set(write.id, column);
    writeObservations.set(write.id, writeObservationId);
    addEdge(write.id, column.columnId, "OBSERVES_COLUMN", {
      writeObservationId,
      targetWriteNodeId: targetId,
    });
  }

  // Asset summaries explain local evidence. They are never occurrence continuation edges.
  for (const edge of graph.edges) {
    if (
      edge.layer !== "field" ||
      (edge.kind !== "VALUE" && edge.kind !== "CONDITION")
    )
      continue;
    const source = readColumns.get(edge.from);
    const target = writeColumns.get(edge.to);
    const properties = detail(edge);
    const occurrence = readOccurrences.get(edge.from);
    if (
      !source ||
      !target ||
      properties.sourceReadOccurrenceStatus !== "RESOLVED" ||
      properties.sourceReadOccurrenceId !== occurrence
    )
      continue;
    addEdge(
      target.columnId,
      source.columnId,
      edge.kind === "VALUE" ? "DERIVED_FROM" : "CONDITIONED_BY",
      {
        ...properties,
        sourceEdgeId: edge.id,
        dependencyKind: edge.kind,
        writeObservationId: writeObservations.get(edge.to),
        sourceReadOccurrenceId: occurrence,
        sourceReadFieldNodeId: edge.from,
        targetWriteFieldNodeId: edge.to,
        projectionContentHash: projection.contentHash,
      },
      "asset",
      edge.status,
      edge.id,
    );
  }

  return { ...graph, nodes: [...nodes.values()], edges: [...edges.values()] };
}
