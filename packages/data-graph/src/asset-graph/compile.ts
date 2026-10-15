import { createHash } from "node:crypto";
import type { TaskLocalProjection } from "../../../../scripts/project-graph/task-local/contract.ts";
import type { TerminalTableConfig } from "../../../../scripts/reconcile/shared/terminal-table-config.ts";
import type { SourceEndpointBoundaryConfig } from "../../../../scripts/reconcile/shared/source-endpoint-boundary-config.ts";
import { terminalNodeDetails } from "./terminal-policy.ts";
import { sourceEndpointBoundaryNodeDetails } from "./source-endpoint-boundary.ts";

export interface AssetNode {
  id: string;
  kind: string;
  taskId: string;
  table: string;
  column: string;
  writeId: string;
  label: string;
  detail: string;
}
export interface AssetEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  layer: string;
  owner: string;
  status: string;
  detail: string;
}
export interface CompiledTask {
  taskId: string;
  nodes: AssetNode[];
  edges: AssetEdge[];
  reads: { id: string; occurrence: string; column: string }[];
  writes: { id: string; writeId: string; column: string; table: string }[];
}
export type FactRecord = Record<string, unknown>;
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const portId = (kind: string, scope: string, column: string) =>
  `${kind}:${digest([scope, column.toLowerCase()])}`;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Preserve write/read occurrences; physical columns are catalogue identities, never traversal junctions. */
export function compileTask(
  p: TaskLocalProjection,
  bindings: readonly FactRecord[] = [],
  terminalConfig?: TerminalTableConfig,
  sourceEndpointBoundaryConfig?: SourceEndpointBoundaryConfig,
  writeScopes: readonly { writeObservationId?: string; qualifiedName?: string; partition?: readonly unknown[] }[] = [],
): CompiledTask {
  const taskId = p.taskId,
    nodes = new Map<string, AssetNode>(),
    edges = new Map<string, AssetEdge>();
  const originals = new Map(p.nodes.map((n) => [n.nodeId, n]));
  const readPropertiesByOccurrence = new Map(p.nodes
    .filter(node => node.nodeType === "READ_OCCURRENCE")
    .map(node => [str(node.properties.occurrenceId), node.properties]));
  const terminalReads = new Map(
    (p.localClosure?.externalReads ?? []).flatMap((read) => {
      if (!terminalConfig || read.identityStatus !== "CONFIRMED") return [];
      const details = terminalNodeDetails(read.qualifiedName, terminalConfig);
      return details ? [[read.readOccurrenceId, details] as const] : [];
    }),
  );
  const boundaryReads = new Map(
    (p.localClosure?.externalReads ?? []).flatMap((read) => {
      if (!sourceEndpointBoundaryConfig || read.identityStatus !== "CONFIRMED")
        return [];
      const details = sourceEndpointBoundaryNodeDetails(
        read.qualifiedName,
        p.taskCategory,
        sourceEndpointBoundaryConfig,
      );
      return details ? [[read.readOccurrenceId, details] as const] : [];
    }),
  );
  const readDisposition = (occurrenceId: string) =>
    terminalReads.get(occurrenceId) ?? boundaryReads.get(occurrenceId);
  const reads: CompiledTask["reads"] = [],
    writes: CompiledTask["writes"] = [];
  const node = (id: string, kind: string, props: FactRecord = {}) => {
    const scope = ["WRITE_FIELD", "TARGET_WRITE"].includes(kind)
      ? writeScopes.find(scope => Boolean(scope.writeObservationId) && scope.writeObservationId === props.writeObservationId &&
        scope.qualifiedName?.toLowerCase() === str(props.qualifiedName).toLowerCase())
      : undefined;
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        kind,
        taskId: ["PHYSICAL_DATASET", "PHYSICAL_FIELD"].includes(kind)
          ? ""
          : taskId,
        table: str(props.qualifiedName ?? props.physicalDataset).toLowerCase(),
        column: str(props.column).toLowerCase(),
        writeId: str(props.writeObservationId),
        label:
          str(
            props.taskName ??
              props.qualifiedName ??
              props.physicalDataset ??
              props.column,
          ) || id,
        detail: JSON.stringify({ ...props, ...(scope?.partition ? {
          partition: scope.partition,
          ...(scope.partition.length === 0 ? { partitionStatus: "NON_PARTITIONED" } : {}),
        } : {}) }),
      });
  };
  const edge = (
    from: string,
    to: string,
    kind: string,
    layer: string,
    props: FactRecord = {},
    id?: string,
  ) => {
    const key = id ?? digest([taskId, from, to, kind, props]);
    edges.set(key, {
      id: key,
      from,
      to,
      kind,
      layer,
      owner: taskId,
      status: str(props.status) || "OBSERVED",
      detail: JSON.stringify(props),
    });
  };
  for (const n of p.nodes) {
    const terminal =
      n.nodeType === "READ_OCCURRENCE"
        ? readDisposition(str(n.properties.occurrenceId))
        : n.nodeType === "PHYSICAL_DATASET" &&
            n.properties.identityStatus === "CONFIRMED"
          ? terminalConfig
            ? terminalNodeDetails(
                str(n.properties.qualifiedName),
                terminalConfig,
              )
            : sourceEndpointBoundaryConfig
              ? sourceEndpointBoundaryNodeDetails(
                  str(n.properties.qualifiedName),
                  p.taskCategory,
                  sourceEndpointBoundaryConfig,
                )
              : null
          : null;
    node(n.nodeId, n.nodeType, { ...n.properties, ...terminal });
  }
  const taskNode = `task:${taskId}`;
  node(taskNode, "TASK", {
    coverageStatus: p.coverageStatus,
    coverageDisposition: p.coverageDisposition,
    taskCategory: p.taskCategory,
    coverageExpectation:
      p.coverageDisposition === "EXPECTED_SCHEDULE_REFERENCE"
        ? "SCHEDULE_REFERENCE_ONLY"
        : p.coverageDisposition === "MATERIAL_GAP"
          ? "MATERIAL_GAP"
          : "DATA_LINEAGE",
  });
  for (const read of p.localClosure?.externalReads ?? [])
    edge(read.datasetNodeId, taskNode, "READS_TABLE", "table", {
      readOccurrenceId: read.readOccurrenceId,
      ...readDisposition(read.readOccurrenceId),
    });
  for (const write of p.localClosure?.finalWrites ?? []) {
    const outputQualification = write.outputQualification;
    edge(taskNode, write.datasetNodeId, "WRITES_TABLE", "table", {
      writeObservationId: write.writeObservationId,
      ...(outputQualification
        ? {
            outputQualification,
            status:
              outputQualification === "PLATFORM_TARGET"
                ? "CONFIRMED"
                : "CANDIDATE",
          }
        : {}),
    });
  }
  const writePort = (target: string, column: string) => {
    const props = originals.get(target)?.properties ?? {};
    const id = portId("write-field", target, column);
    node(id, "WRITE_FIELD", { ...props, column });
    if (!writes.some((w) => w.id === id))
      writes.push({
        id,
        writeId: str(props.writeObservationId),
        column: column.toLowerCase(),
        table: str(props.qualifiedName).toLowerCase(),
      });
    edge(target, id, "HAS_FIELD", "catalog");
    return id;
  };
  for (const binding of bindings) {
    const write = p.localClosure?.finalWrites.find(
      (w) => w.writeObservationId === binding.write_observation_id,
    );
    if (write && str(binding.target_field))
      writePort(write.targetWriteNodeId, str(binding.target_field));
  }
  for (const e of p.edges) {
    if (e.edgeType === "FIELD_DIRECT" || e.edgeType === "FIELD_CONDITIONAL") {
      const source = originals.get(e.fromNodeId),
        column = str(source?.properties.column),
        output = str(e.properties.outputColumn);
      if (!column || !output) continue;
      const target = writePort(e.toNodeId, output);
      const occurrence = str(e.properties.sourceReadOccurrenceId);
      let from = e.fromNodeId;
      if (
        occurrence &&
        e.properties.sourceReadOccurrenceStatus === "RESOLVED"
      ) {
        from = portId("read-field", `${taskId}:${occurrence}`, column);
        const readProperties = readPropertiesByOccurrence.get(occurrence);
        node(from, "READ_FIELD", {
          ...source?.properties,
          occurrenceId: occurrence,
          column,
          ...readDisposition(occurrence),
          ...(readProperties
            ? {
                partitionPredicates: readProperties.partitionPredicates,
                partitionPredicateStatus: readProperties.partitionPredicateStatus,
              }
            : {}),
        });
        if (!reads.some((r) => r.id === from))
          reads.push({ id: from, occurrence, column: column.toLowerCase() });
        edge(e.fromNodeId, from, "OBSERVED_FIELD", "catalog");
      }
      edge(
        from,
        target,
        e.edgeType === "FIELD_DIRECT" ? "VALUE" : "CONDITION",
        "field",
        { ...e.properties, sourceColumn: column },
        e.edgeId,
      );
    } else
      edge(
        e.fromNodeId,
        e.toNodeId,
        e.edgeType,
        e.edgeType === "DATASET_CONTROL" ? "control" : "catalog",
        e.properties,
        e.edgeId,
      );
  }
  return {
    taskId,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    reads,
    writes,
  };
}
