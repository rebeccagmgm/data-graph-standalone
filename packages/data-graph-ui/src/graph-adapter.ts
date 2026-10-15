import { physicalTableKey } from "./field-object";
import {
  tableRelationLabel,
  tableRelationStrokeWidth,
} from "./table-relations";
import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";
import { consumptionScopeIdentity } from "../../data-graph/src/asset-graph/consumption-scope";
import { mergeTraceConsumptions } from "./trace-consumption";
import type {
  ConsumptionGroup,
  ConsumptionScope,
  ConsumptionWriteRef,
  GraphEdge,
  GraphNode,
  TerminalNode,
  TraceResult,
} from "./types";

export function valueOutputLabel(edge: GraphEdge): string {
  const bridges = edge.detail?.materializationBridgeIds;
  return edge.detail?.materializationFolded === true && Array.isArray(bridges) && bridges.length
    ? `产出 · 经 ${new Set(bridges).size} 个中间步骤`
    : "产出";
}

export interface FieldSelectionContext {
  rawMembers: GraphNode[];
  writeRefs: ConsumptionWriteRef[];
  scope?: ConsumptionScope;
}

export interface LineageNodeData extends Record<string, unknown> {
  raw?: GraphNode;
  members?: GraphNode[];
  terminal?: TerminalNode;
  memberTerminals?: Record<string, TerminalNode>;
  isAnchor: boolean;
  highlightActive: boolean;
  activeFieldIds: string[];
  fieldAliases?: Record<string, GraphNode[]>;
  connectedFieldIds?: string[];
  fieldWriteRefs?: Record<string, ConsumptionWriteRef[]>;
  scope?: ConsumptionScope;
  writeRefs?: ConsumptionWriteRef[];
  compactRead?: boolean;
  consumerTaskIds?: string[];
  taskPorts?: Array<{
    id: string;
    label: string;
    direction: "input" | "output";
    fieldNodeId: string;
  }>;
  candidateCount?: number;
  candidatesExpanded?: boolean;
  onExpandCandidates?: () => void;
  displayWidth?: number;
  displayHeight?: number;
  onHiddenFieldsChange?: (nodeId: string, fieldIds: string[]) => void;
  onFieldClick?: (
    node: GraphNode,
    terminal?: TerminalNode,
    context?: FieldSelectionContext,
  ) => void;
}

interface DisplayGroup {
  id: string;
  depth: number;
  raw?: GraphNode;
  members?: GraphNode[];
  consumption?: ConsumptionGroup;
}

export interface AdaptTraceOptions {
  expandedCandidates?: Set<string>;
  onToggleCandidates?: (key: string) => void;
  highlightedTaskId?: string;
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const taskRaw = (trace: TraceResult, taskId: string): GraphNode => {
  const cluster = text(trace.taskClusters?.[taskId]);
  const taskName = text(trace.taskLabels?.[taskId]);
  const topicName = text(trace.taskTopics?.[taskId]);
  const topicDescription = topicName ? text(trace.taskTopicDescriptions?.[taskId]) : undefined;
  return {
    id: `task:${taskId}`,
    kind: "TASK",
    taskId,
    ...(taskName ? { label: taskName } : {}),
    detail: {
      ...(cluster ? { cluster } : {}),
      ...(taskName ? { taskName } : {}),
      ...(topicName ? { topicName } : {}),
      ...(topicDescription ? { topicDescription } : {}),
    },
  };
};

const withSchedulerTaskName = (trace: TraceResult, node: GraphNode): GraphNode => {
  if (node.kind !== "TASK") return node;
  const taskId = text(node.taskId) ?? text(node.id)?.replace(/^task:/, "");
  const cluster = taskId ? text(trace.taskClusters?.[taskId]) : undefined;
  const taskName = taskId ? text(trace.taskLabels?.[taskId]) : undefined;
  const topicName = taskId ? text(trace.taskTopics?.[taskId]) : undefined;
  const topicDescription = taskId && topicName ? text(trace.taskTopicDescriptions?.[taskId]) : undefined;
  const { cluster: ignoredCluster, taskName: ignoredTaskName, topicName: ignoredTopicName, topicDescription: ignoredTopicDescription, ...detail } = node.detail ?? {};
  return {
    ...node,
    label: taskName,
    detail: {
      ...detail,
      ...(cluster ? { cluster } : {}),
      ...(taskName ? { taskName } : {}),
      ...(topicName ? { topicName } : {}),
      ...(topicDescription ? { topicDescription } : {}),
    },
  };
};

const taskCardWidth = 210;
export const INPUT_EDGE_COLOR = "#2878b5";
export const OUTPUT_EDGE_COLOR = "#9b4f96";
const taskCardHeight = 108;

function displayGroupKey(raw: GraphNode): string | undefined {
  const depth = Number(raw.depth ?? 0);
  if (raw.kind === "WRITE_FIELD") {
    const taskId = text(raw.taskId);
    const writeId = text(raw.writeId);
    const table = text(raw.table)?.toLowerCase();
    if (!taskId || !writeId || !table) return undefined;
    return `write-field:${depth}:${taskId}:${writeId}:${table}`;
  }
  if (raw.kind === "READ_FIELD") {
    const occurrenceId = text(raw.detail?.occurrenceId);
    const physicalIdentity =
      text(raw.detail?.stableTableId)?.toLowerCase() ??
      text(raw.table)?.toLowerCase();
    if (!occurrenceId || !physicalIdentity) return undefined;
    return `read-field:${depth}:${text(raw.taskId) ?? ""}:${occurrenceId}:${physicalIdentity}`;
  }
  return undefined;
}

const groupId = (key: string) => `group:${encodeURIComponent(key)}`;

function buildGroups(
  nodes: GraphNode[],
  edges: TraceResult["edges"],
  consumption?: TraceResult["consumption"],
): DisplayGroup[] {
  if (consumption) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const assigned = new Set<string>();
    const projected = consumption.groups.flatMap((group): DisplayGroup[] => {
      const members = group.rawNodeIds
        .map((id) => byId.get(id))
        .filter((node): node is GraphNode => Boolean(node))
        .sort((a, b) => (a.column ?? a.id).localeCompare(b.column ?? b.id));
      if (!members.length) return [];
      members.forEach((member) => assigned.add(member.id));
      if (members.length === 1 && group.role === "OTHER")
        return [
          {
            id: group.id,
            depth: group.depth,
            raw: members[0],
            consumption: group,
          },
        ];
      return [
        {
          id: group.id,
          depth: group.depth,
          members,
          consumption: group,
        },
      ];
    });
    const unique = new Map<string, DisplayGroup>();
    for (const group of projected) {
      const source = group.consumption!;
      // A write can be split into field subsets by downstream consumers or
      // per-field requests. Those subsets belong to the same display card;
      // raw field ids and edges still determine the individual connections.
      const writes = source.rawNodeIds.map(id => byId.get(id));
      const eligible = source.role === "WRITE" && source.scope.status === "EXPLICIT" &&
        Boolean(source.physicalIdentity) && writes.length > 0 &&
        writes.every(node => node?.kind === "WRITE_FIELD" && text(node.taskId) && text(node.writeId));
      const key = eligible ? JSON.stringify([
        source.physicalIdentity, consumptionScopeIdentity(source.scope),
        [...new Set(writes.map(node => JSON.stringify([node!.taskId, node!.writeId])))].sort(),
      ]) : source.id;
      const existing = unique.get(key);
      if (!existing) { unique.set(key, group); continue; }
      const merged = mergeTraceConsumptions({
        consumptions: [{ schemaVersion: "1.0.0", groups: [existing.consumption!, {...source, id: existing.id}], branches: [], rootPaths: [] }],
        allowedNodeIds: new Set(nodes.map(node => node.id)),
        allowedEdgeIds: new Set(edges.map(rawEdgeId)),
        allRootNodeIds: [...new Set([...existing.consumption!.rootNodeIds, ...source.rootNodeIds])],
      });
      const members = [...new Map([...(existing.members ?? []), ...(group.members ?? [])]
        .map(member => [member.id, member])).values()]
        .sort((a, b) => (a.column ?? a.id).localeCompare(b.column ?? b.id));
      const combined = merged!.groups[0]!;
      const proven = existing.consumption!.scopeEquivalence === "PROVEN" && source.scopeEquivalence === "PROVEN";
      unique.set(key, {...existing, depth: Math.min(existing.depth, group.depth), members, consumption: {
        ...combined,
        presentation: proven ? combined.presentation : "EVIDENCE_CONTAINER",
        scopeEquivalence: proven ? "PROVEN" : "NOT_ASSERTED",
      }});
    }
    return [
      ...unique.values(),
      ...nodes
        .filter((node) => !assigned.has(node.id))
        .map((raw) => ({
          id: raw.id,
          depth: Number(raw.depth ?? 0),
          raw,
        })),
    ];
  }
  const groups = new Map<string, DisplayGroup>();
  for (const raw of nodes) {
    const key = displayGroupKey(raw);
    if (!key) {
      groups.set(`node:${raw.id}`, {
        id: raw.id,
        depth: Number(raw.depth ?? 0),
        raw,
      });
      continue;
    }
    const existing = groups.get(key);
    if (existing) existing.members!.push(raw);
    else
      groups.set(key, {
        id: groupId(key),
        depth: Number(raw.depth ?? 0),
        members: [raw],
      });
  }
  for (const group of groups.values())
    group.members?.sort((a, b) =>
      (a.column ?? a.id).localeCompare(b.column ?? b.id),
    );
  const groupFor = (nodeId: string) =>
    [...groups.values()].find((group) =>
      (group.members ?? (group.raw ? [group.raw] : [])).some(
        (member) => member.id === nodeId,
      ),
    );
  for (const edge of edges) {
    if (edge.kind !== "CONTINUES" || edge.status !== "CONFIRMED") continue;
    const write = nodes.find((node) => node.id === edge.from);
    const read = nodes.find((node) => node.id === edge.to);
    const stableTableId = text(read?.detail?.stableTableId);
    if (
      write?.kind !== "WRITE_FIELD" ||
      read?.kind !== "READ_FIELD" ||
      read.detail?.identityStatus !== "CONFIRMED" ||
      !stableTableId ||
      text(write.table)?.toLowerCase() !== text(read.table)?.toLowerCase()
    )
      continue;
    const left = groupFor(write.id);
    const right = groupFor(read.id);
    if (!left || !right || left === right) continue;
    const combinedIds = new Set(
      [left, right].flatMap((group) =>
        (group.members ?? (group.raw ? [group.raw] : [])).map(({ id }) => id),
      ),
    );
    if (
      edges.some(
        (candidate) =>
          candidate.kind === "VALUE" &&
          combinedIds.has(candidate.from) &&
          combinedIds.has(candidate.to),
      )
    )
      continue;
    const merged = [
      ...(right.members ?? (right.raw ? [right.raw] : [])),
      ...(left.members ?? (left.raw ? [left.raw] : [])),
    ];
    right.id = `table:${encodeURIComponent(stableTableId.toLowerCase())}:${
      merged.map(({ id }) => id).sort()[0]
    }`;
    right.raw = undefined;
    right.members = merged;
    for (const [key, group] of groups) if (group === left) groups.delete(key);
  }
  return [...groups.values()];
}

/** Collapse only a fully witnessed read boundary into its single write card.
 * Keep all raw identities: this is a display alias, never a new lineage edge.
 */
function coalescePublishedContinuations(groups: DisplayGroup[], trace: TraceResult): DisplayGroup[] {
  const active = new Set(groups);
  const groupByRawId = new Map(groups.flatMap(group =>
    (group.members ?? (group.raw ? [group.raw] : [])).map(node => [node.id, group] as const),
  ));
  const nodes = new Map(trace.nodes.map(node => [node.id, node]));
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of trace.edges) {
    if (!["CONTINUES", "CANDIDATE"].includes(edge.kind)) continue;
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }
  const allowedNodeIds = new Set(groupByRawId.keys());
  const allowedEdgeIds = new Set(trace.edges.map(rawEdgeId));
  for (const readGroup of groups) {
    if (!active.has(readGroup) || readGroup.consumption?.role !== "READ") continue;
    const reads = readGroup.members ?? [];
    if (!reads.length || reads.some(read => read.kind !== "READ_FIELD" ||
      read.detail?.identityStatus !== "CONFIRMED" || !text(read.detail?.stableTableId))) continue;
    const bridges = reads.flatMap(read => incoming.get(read.id) ?? []);
    // Consult the full result, including collapsed candidates, before merging.
    if (reads.some(read => !(incoming.get(read.id)?.length)) || bridges.some(edge =>
      edge.kind !== "CONTINUES" || edge.status !== "CONFIRMED")) continue;
    const sources = new Set(bridges.map(edge => groupByRawId.get(edge.from)));
    if (sources.size !== 1) continue;
    const writeGroup = [...sources][0];
    if (!writeGroup || writeGroup === readGroup || writeGroup.consumption?.role !== "WRITE") continue;
    const writes = (writeGroup.members ?? []).filter(node => node.kind === "WRITE_FIELD");
    if (!writes.length || writes.some(node => !text(node.taskId) || !text(node.writeId)) ||
      new Set(writes.map(node => JSON.stringify([node.taskId, node.writeId]))).size !== 1) continue;
    if (bridges.some(edge => {
      const write = nodes.get(edge.from), read = nodes.get(edge.to);
      return write?.kind !== "WRITE_FIELD" || write.taskId === read?.taskId ||
        !text(write.table) || text(write.table)?.toLowerCase() !== text(read?.table)?.toLowerCase() ||
        !text(write.column) || text(write.column)?.toLowerCase() !== text(read?.column)?.toLowerCase() ||
        (text(write.detail?.stableTableId) && write.detail?.stableTableId !== read?.detail?.stableTableId);
    })) continue;
    const leftScope = writeGroup.consumption.scope, rightScope = readGroup.consumption.scope;
    const known = (scope: ConsumptionScope) => scope.status === "EXPLICIT" ||
      (scope.status === "TABLE_LEVEL" && scope.nonPartitioned === true);
    if (!known(leftScope) || !known(rightScope) ||
      consumptionScopeIdentity(leftScope) !== consumptionScopeIdentity(rightScope)) continue;
    const members = [...new Map([...(writeGroup.members ?? []), ...reads].map(n => [n.id, n])).values()];
    const ids = new Set(members.map(n => n.id));
    if (trace.edges.some(edge => edge.kind === "VALUE" && ids.has(edge.from) && ids.has(edge.to))) continue;
    const combined = mergeTraceConsumptions({
      consumptions: [{schemaVersion:"1.0.0", groups:[
        {...readGroup.consumption, id:writeGroup.id}, writeGroup.consumption,
      ], branches:[], rootPaths:[]}],
      allowedNodeIds, allowedEdgeIds,
      allRootNodeIds: [...new Set([...readGroup.consumption.rootNodeIds, ...writeGroup.consumption.rootNodeIds])],
    })!.groups[0]!;
    writeGroup.members = members;
    writeGroup.depth = Math.min(writeGroup.depth, readGroup.depth);
    writeGroup.consumption = combined;
    members.forEach(node => groupByRawId.set(node.id, writeGroup));
    active.delete(readGroup);
  }
  return [...active];
}

/** One display owner per physical field; raw read/write nodes remain the edge endpoints. */
function projectFieldObjects(groups: DisplayGroup[], trace: TraceResult): DisplayGroup[] {
  const buckets = new Map<string, {group: DisplayGroup; sources: Set<ConsumptionGroup>}>();
  const owners = new Map<string, string>();
  const others: DisplayGroup[] = [];
  for (const source of groups) {
    const members = source.members ?? (source.raw ? [source.raw] : []);
    if (!members.length || members.some(node => !node.kind.includes("FIELD")) ||
      (source.raw && !physicalTableKey(source.raw))) {
      others.push(source);
      continue;
    }
    for (const member of members) {
      const physical = physicalTableKey(member);
      const key = owners.get(member.id) ?? (physical ? `physical-table:${encodeURIComponent(physical)}` : source.id);
      owners.set(member.id, key);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {group:{id:key, depth:Number(member.depth ?? source.depth),members:[]}, sources:new Set()};
        buckets.set(key,bucket);
      }
      if (!bucket.group.members!.some(node => node.id === member.id)) bucket.group.members!.push(member);
      bucket.group.depth = Math.min(bucket.group.depth, Number(member.depth ?? source.depth));
      if (source.consumption) bucket.sources.add(source.consumption);
    }
  }
  for (const {group,sources} of buckets.values()) {
    if (!sources.size) continue;
    const members = group.members!;
    group.consumption = mergeTraceConsumptions({
      consumptions:[{schemaVersion:"1.0.0",groups:[...sources].map(source=>({...source,id:group.id})),branches:[],rootPaths:[]}],
      allowedNodeIds:new Set(members.map(node=>node.id)),
      allowedEdgeIds:new Set(trace.edges.map(rawEdgeId)),
      allRootNodeIds:trace.nodes.filter(node=>node.depth===0).map(node=>node.id),
    })?.groups[0];
    if (group.consumption) group.consumption = {...group.consumption,depth:group.depth};
  }
  return [...others,...[...buckets.values()].map(bucket=>bucket.group)];
}

const candidateKey = (node: GraphNode | undefined) =>
  `candidate:${text(node?.detail?.stableTableId) ?? text(node?.detail?.occurrenceId) ?? node?.id ?? "unknown"}`;

const rawEdgeId = (edge: TraceResult["edges"][number], index: number) =>
  edge.id ??
  edge.key ??
  `${edge.from}|${edge.to}|${edge.kind}|${edge.status ?? ""}|${index}`;

const isUnconfirmedBoundary = (edge: TraceResult["edges"][number]) =>
  edge.kind === "CANDIDATE" ||
  ["CANDIDATE", "ASSUMED", "UNKNOWN"].includes(edge.status ?? "");

function visibleRawIds(trace: TraceResult, options: AdaptTraceOptions) {
  // Table IO is already bounded by the API. Candidate output qualification
  // must not hide the task's returned reads or downstream consumers.
  // Field views retain their separate unconfirmed-causality boundaries below.
  if (trace.layer === "table") return new Set(trace.nodes.map(node => node.id));
  const nodes = new Map(trace.nodes.map((node) => [node.id, node]));
  const roots = trace.nodes.filter((node) => Number(node.depth ?? 0) === 0);
  const visible = new Set(roots.map(({ id }) => id));
  const pending = [...visible];
  const expanded = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (expanded.has(current)) continue;
    expanded.add(current);
    for (const edge of trace.edges) {
      const follows =
        trace.direction === "up" ? edge.to === current : edge.from === current;
      if (!follows) continue;
      if (
        edge.kind === "CANDIDATE" &&
        !options.expandedCandidates?.has(candidateKey(nodes.get(edge.to)))
      )
        continue;
      const next = trace.direction === "up" ? edge.from : edge.to;
      visible.add(next);
      if (isUnconfirmedBoundary(edge)) continue;
      if (!expanded.has(next)) pending.push(next);
    }
  }
  return visible;
}

export function relatedLineageHighlight(
  trace: TraceResult,
  fieldIds?: string | string[],
) {
  const roots = (Array.isArray(fieldIds) ? fieldIds : [fieldIds]).filter(
    (id): id is string =>
      Boolean(id) && trace.nodes.some((node) => node.id === id),
  );
  if (!roots.length) return null;
  const matchingPaths = trace.consumption?.rootPaths.filter((path) =>
    roots.some((root) => path.rawNodeIds.includes(root)),
  );
  const allowedEdgeIds = matchingPaths?.length
    ? new Set(matchingPaths.flatMap((path) => path.rawEdgeIds))
    : undefined;
  const allowedNodeIds = matchingPaths?.length
    ? new Set(matchingPaths.flatMap((path) => path.rawNodeIds))
    : undefined;
  const outgoing = new Map<
    string,
    Array<{ id: string; next: string; boundary: boolean }>
  >();
  const incoming = new Map<
    string,
    Array<{ id: string; next: string; boundary: boolean }>
  >();
  trace.edges.forEach((edge, index) => {
    const id = rawEdgeId(edge, index);
    if (allowedEdgeIds && !allowedEdgeIds.has(id)) return;
    if (
      allowedNodeIds &&
      (!allowedNodeIds.has(edge.from) || !allowedNodeIds.has(edge.to))
    )
      return;
    const nextOutgoing = outgoing.get(edge.from) ?? [];
    nextOutgoing.push({ id, next: edge.to, boundary: isUnconfirmedBoundary(edge) });
    outgoing.set(edge.from, nextOutgoing);
    const nextIncoming = incoming.get(edge.to) ?? [];
    nextIncoming.push({ id, next: edge.from, boundary: isUnconfirmedBoundary(edge) });
    incoming.set(edge.to, nextIncoming);
  });
  const nodeIds = new Set(roots);
  const edgeIds = new Set<string>();
  const walk = (
    adjacency: Map<string, Array<{ id: string; next: string; boundary: boolean }>>,
  ) => {
    const visited = new Set(roots);
    const pending = [...roots];
    while (pending.length) {
      const current = pending.pop()!;
      for (const edge of adjacency.get(current) ?? []) {
        edgeIds.add(edge.id);
        nodeIds.add(edge.next);
        if (edge.boundary || trace.layer === "table") continue;
        if (visited.has(edge.next)) continue;
        visited.add(edge.next);
        pending.push(edge.next);
      }
    }
  };
  walk(incoming);
  walk(outgoing);
  return { nodeIds, edgeIds };
}

export function adaptTrace(
  trace: TraceResult,
  onFieldClick?: LineageNodeData["onFieldClick"],
  highlightedFieldId?: string | string[],
  options: AdaptTraceOptions = {},
): { nodes: Node<LineageNodeData>[]; edges: Edge[] } {
  const highlight = relatedLineageHighlight(trace, highlightedFieldId);
  const edgeIdentities = new Map(trace.edges.map((edge, index) => [edge, rawEdgeId(edge, index)]));
  const visibleIds = visibleRawIds(trace, options);
  const namedNodes = trace.nodes.map((node) => withSchedulerTaskName(trace, node));
  const visibleNodes = namedNodes.filter((node) => visibleIds.has(node.id));
  const visibleEdges = trace.edges.filter(
    (edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to),
  );
  const grouped = buildGroups(visibleNodes, visibleEdges, trace.consumption);
  const displayGroups = trace.layer === "field"
    ? projectFieldObjects(trace.consumption ? coalescePublishedContinuations(grouped, trace) : grouped, trace)
    : grouped;
  const depths = new Map<number, DisplayGroup[]>();
  for (const group of displayGroups) {
    const bucket = depths.get(group.depth) ?? [];
    bucket.push(group);
    depths.set(group.depth, bucket);
  }
  for (const bucket of depths.values())
    bucket.sort((a, b) => {
      const left = `${a.consumption?.scope.label ?? ""}|${a.consumption?.taskId ?? ""}|${a.id}`;
      const right = `${b.consumption?.scope.label ?? ""}|${b.consumption?.taskId ?? ""}|${b.id}`;
      return left.localeCompare(right);
    });

  const terminals = new Map(
    trace.terminalNodes.map((terminal) => [terminal.nodeId, terminal]),
  );
  const traceNodeById = new Map(namedNodes.map((node) => [node.id, node]));
  const displayNodeByRawId = new Map<string, string>();
  for (const group of displayGroups)
    for (const member of group.members ?? (group.raw ? [group.raw] : []))
      displayNodeByRawId.set(member.id, group.id);

  const maxDepth = Math.max(0, ...depths.keys());
  const columnX = new Map<number, number>();
  let nextX = 48;
  const orderedDepths = [...depths.keys()].sort((a, b) =>
    trace.direction === "up" ? b - a : a - b,
  );
  for (const depth of orderedDepths) {
    columnX.set(depth, nextX);
    const width = Math.max(
      ...depths
        .get(depth)!
        .map((group) =>
          group.raw?.kind === "TASK" ? taskCardWidth : group.members ? 300 : 260,
        ),
    );
    nextX += width + 32;
  }
  const nodes: Node<LineageNodeData>[] = [];
  for (const [depth, bucket] of depths) {
    let y = 42;
    for (const group of bucket) {
      const allMembers = group.members;
      const rawNodes = allMembers ?? (group.raw ? [group.raw] : []);
      const aliasesByColumn = new Map<string, GraphNode[]>();
      for (const member of allMembers ?? []) {
        const column = text(member.column)?.toLowerCase() ?? member.id;
        const aliases = aliasesByColumn.get(column) ?? [];
        aliases.push(member);
        aliasesByColumn.set(column, aliases);
      }
      const members = allMembers
        ? [...aliasesByColumn.values()].map(
            (aliases) =>
              aliases.find((alias) => Number(alias.depth ?? 0) === 0) ??
              aliases.find((alias) => alias.kind === "READ_FIELD") ??
              aliases[0]!,
          )
        : undefined;
      const fieldAliases = Object.fromEntries(
        (members ?? []).map((member) => [
          member.id,
          (
            aliasesByColumn.get(
              text(member.column)?.toLowerCase() ?? member.id,
            ) ?? []
          ).filter((alias) => alias.id !== member.id),
        ]),
      );
      const fieldWriteRefs = Object.fromEntries(
        (members ?? []).map((member) => {
          const field = group.consumption?.fields.find((candidate) =>
            candidate.rawNodeIds.includes(member.id),
          );
          return [member.id, field?.writeRefs ?? []];
        }),
      );
      const activeFieldIds = highlight
        ? rawNodes
            .filter(
              (node) =>
                node.kind.includes("FIELD") && highlight.nodeIds.has(node.id),
            )
            .map((node) => node.id).sort()
        : [];
      const cardActive =
        !highlight || rawNodes.some((node) => highlight.nodeIds.has(node.id));
      const rawIds = new Set(rawNodes.map(({ id }) => id));
      const consumerTaskIds = [...new Set(visibleEdges
        .filter(edge => edge.kind === "CONTINUES" && edge.status === "CONFIRMED" && rawIds.has(edge.from) && !rawIds.has(edge.to))
        .map(edge => traceNodeById.get(edge.to))
        .filter(node => node?.kind === "READ_FIELD")
        .map(node => text(node?.taskId))
        .filter((id): id is string => Boolean(id)))].sort((a, b) => a.localeCompare(b, "en", {numeric: true}));
      const candidateEdges = trace.edges.filter(
        (edge) => edge.kind === "CANDIDATE" && rawIds.has(edge.to),
      );
      const candidateTaskIds = new Set(
        candidateEdges.map(
          (edge) =>
            text(edge.detail?.producerTaskId) ??
            text(traceNodeById.get(edge.from)?.taskId) ??
            edge.from,
        ),
      );
      const expansionKey = candidateEdges.length
        ? candidateKey(traceNodeById.get(candidateEdges[0]!.to))
        : undefined;
      const memberTerminals = Object.fromEntries(
        rawNodes
          .map((member) => [member.id, terminals.get(member.id)] as const)
          .filter((entry): entry is readonly [string, TerminalNode] =>
            Boolean(entry[1]),
          ),
      );
      const compactRead =
        group.consumption?.role === "READ" &&
        (trace.consumption?.branches.filter(
          (branch) =>
            branch.toGroupId === group.id &&
            ["CONTINUES", "CANDIDATE"].includes(branch.kind),
        ).length ?? 0) > 1;
      const displayHeight =
        group.raw?.kind === "TASK"
          ? taskCardHeight
          : compactRead
            ? 120 + Math.min(120, (members?.length ?? 0) * 38)
            : members
              ? 112 + (consumerTaskIds.length ? 28 : 0) +
                (rawNodes.some(n => n.kind === "READ_FIELD") && rawNodes.some(n => n.kind === "WRITE_FIELD") ? 16 : 0) +
                Math.min(280, members.length * 38) +
                (candidateTaskIds.size ? 32 : 0)
              : terminals.has(group.raw?.id ?? "")
                ? 148
                : 118;
      nodes.push({
        id: group.id,
        type: group.raw?.kind === "TASK" ? "processingTask" : "lineage",
        position: {
          x:
            trace.layer === "table"
              ? columnX.get(depth)!
              : (trace.direction === "up" ? maxDepth - depth : depth) * (trace.layer === "field" ? 660 : 420) +
                48,
          y,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: { opacity: cardActive ? 1 : 0.22 },
        data: {
          raw: group.raw,
          members,
          fieldAliases,
          connectedFieldIds: trace.edges.filter(edge => edge.kind === "VALUE" && rawIds.has(edge.to)).map(edge => edge.to),
          fieldWriteRefs,
          scope: group.consumption?.scope,
          writeRefs: group.consumption?.writeRefs,
          compactRead,
          consumerTaskIds,
          terminal: group.raw ? terminals.get(group.raw.id) : undefined,
          memberTerminals,
          highlightActive: Boolean(highlight),
          activeFieldIds,
          isAnchor:
            depth === 0 ||
            Boolean(members?.some((member) => Number(member.depth ?? 0) === 0)),
          onFieldClick,
          displayWidth:
            group.raw?.kind === "TASK"
              ? taskCardWidth
              : compactRead
                ? 260
                : members
                  ? 300
                  : 260,
          displayHeight,
          candidateCount: candidateTaskIds.size,
          candidatesExpanded: expansionKey
            ? options.expandedCandidates?.has(expansionKey)
            : false,
          onExpandCandidates:
            expansionKey && options.onToggleCandidates
              ? () => options.onToggleCandidates!(expansionKey)
              : undefined,
        },
      });
      y += displayHeight + 28;
    }
  }

  const nodeById = new Map(visibleNodes.map((node) => [node.id, node]));
  const taskNodeById = new Map<string, Node<LineageNodeData>>();
  const compactTaskY = (x: number, preferredY: number) => {
    let y = preferredY;
    const occupied = [...taskNodeById.values()]
      .filter((task) => Math.abs(task.position.x - x) < 20)
      .map((task) => task.position.y);
    while (occupied.some((current) => Math.abs(current - y) < taskCardHeight + 28))
      y += taskCardHeight + 28;
    return y;
  };
  const constantEdges: Edge[] = [];
  for (const edge of visibleEdges.filter(
    ({ kind }) => kind === "VALUE",
  )) {
    const target = nodeById.get(edge.to);
    const taskId = text(target?.taskId);
    if (!taskId) continue;
    const id = `task:${taskId}`;
    let task = taskNodeById.get(id);
    if (!task) {
      const output = nodes.find(
        (candidate) => candidate.id === displayNodeByRawId.get(edge.to),
      );
      const input = nodes.find(
        (candidate) => candidate.id === displayNodeByRawId.get(edge.from),
      );
      const left = Math.min(input?.position.x ?? 0, output?.position.x ?? 0);
      const right = Math.max(input?.position.x ?? 0, output?.position.x ?? 0);
      const taskX = trace.layer === "field"
        ? (input?.id === output?.id ? right + (output?.data.displayWidth ?? 300) + 72 : right - taskCardWidth - 72)
        : left +
        300 +
        Math.max(24, (right - left - 300 - taskCardWidth) / 2);
      task = {
        id,
        type: "processingTask",
        position: {
          x: taskX,
          y: compactTaskY(taskX, output?.position.y ?? input?.position.y ?? 42),
        },
        data: {
          raw: taskRaw(trace, taskId),
          isAnchor: false,
          highlightActive: Boolean(highlight),
          activeFieldIds: [],
          taskPorts: [],
          displayWidth: taskCardWidth,
          displayHeight: taskCardHeight,
        },
      };
      taskNodeById.set(id, task);
      nodes.push(task);
    }
    const mappingId = edgeIdentities.get(edge)!;
    task.data.taskPorts!.push(
      {
        id: `${mappingId}:input`,
        label: nodeById.get(edge.from)?.column ?? edge.from,
        direction: "input",
        fieldNodeId: edge.from,
      },
      {
        id: `${mappingId}:output`,
        label: target?.column ?? edge.to,
        direction: "output",
        fieldNodeId: edge.to,
      },
    );
  }
  const valueTargets = new Set(
    visibleEdges.filter(({ kind }) => kind === "VALUE").map(({ to }) => to),
  );
  for (const write of visibleNodes.filter(
    (node) =>
      (trace.layer !== "field" || node.valueOrigin?.kind === "CONSTANT") &&
      node.kind === "WRITE_FIELD" &&
      !valueTargets.has(node.id),
  )) {
    const taskId = text(write.taskId);
    const tableNodeId = displayNodeByRawId.get(write.id);
    const tableNode = nodes.find(({ id }) => id === tableNodeId);
    if (!taskId || !tableNodeId || !tableNode) continue;
    const taskIdNode = `task:${taskId}`;
    let task = taskNodeById.get(taskIdNode);
    if (!task) {
      task = {
        id: taskIdNode,
        type: "processingTask",
        position: {
          x: tableNode.position.x - (trace.layer === "field" ? 260 : 166),
          y: compactTaskY(tableNode.position.x - (trace.layer === "field" ? 260 : 166), tableNode.position.y),
        },
        data: {
          raw: {
            ...taskRaw(trace, taskId),
          },
          isAnchor: false,
          highlightActive: Boolean(highlight),
          activeFieldIds: [],
          taskPorts: [],
          displayWidth: taskCardWidth,
          displayHeight: taskCardHeight,
        },
      };
      taskNodeById.set(taskIdNode, task);
      nodes.push(task);
    }
    const portId = `constant:${write.id}:output`;
    task.data.taskPorts!.push({
      id: portId,
      label: write.column ?? write.id,
      direction: "output",
      fieldNodeId: write.id,
    });
    const active = !highlight || highlight.nodeIds.has(write.id);
    constantEdges.push({
      id: `constant:${write.id}`,
      source: taskIdNode,
      target: tableNodeId,
      sourceHandle: portId,
      targetHandle: write.id,
      type: "smoothstep",
      label: highlight?.nodeIds.has(write.id) ? "生成字段" : undefined,
      style: {
        stroke: OUTPUT_EDGE_COLOR,
        strokeWidth: 1.5,
        opacity: active ? 1 : 0.14,
      },
      labelStyle: { opacity: active ? 1 : 0.14 },
      labelBgStyle: { opacity: active ? 1 : 0.14 },
      markerEnd: { type: MarkerType.ArrowClosed, color: OUTPUT_EDGE_COLOR },
      data: { rawNode: write },
    });
  }
  for (const task of taskNodeById.values()) {
    const fieldIds = task.data.taskPorts!.map(({ fieldNodeId }) => fieldNodeId);
    const active =
      !highlight || fieldIds.some((id) => highlight.nodeIds.has(id));
    task.style = { opacity: active ? 1 : 0.22 };
    task.data.activeFieldIds = highlight
      ? fieldIds.filter((id) => highlight.nodeIds.has(id)).sort()
      : [];
  }
  const laneCounts = new Map<string, number>();
  for (const task of [...taskNodeById.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const key = `${Math.round(task.position.x)}:${Math.round(task.position.y)}`;
    const lane = laneCounts.get(key) ?? 0;
    task.position.y += lane * 120;
    laneCounts.set(key, lane + 1);
  }

  const edges = visibleEdges.flatMap<Edge>((raw) => {
    const edgeId = edgeIdentities.get(raw)!;
    const candidate = raw.kind === "CANDIDATE" || raw.status === "CANDIDATE";
    const confirmed = raw.status === "CONFIRMED";
    const color = candidate ? "#b07a3b" : raw.kind === "READS_TABLE" ? INPUT_EDGE_COLOR : raw.kind === "WRITES_TABLE" ? OUTPUT_EDGE_COLOR : confirmed ? "#26746d" : "#6f8f8b";
    const sourceIsField =
      nodeById.get(raw.from)?.kind.includes("FIELD") ?? false;
    const targetIsField = nodeById.get(raw.to)?.kind.includes("FIELD") ?? false;
    const visual = {
      id: edgeId,
      source: displayNodeByRawId.get(raw.from) ?? raw.from,
      target: displayNodeByRawId.get(raw.to) ?? raw.to,
      sourceHandle: sourceIsField ? raw.from : undefined,
      targetHandle: targetIsField ? raw.to : undefined,
      type: "smoothstep",
      labelStyle: {
        opacity: !highlight || highlight.edgeIds.has(edgeId) ? 1 : 0.14,
      },
      labelBgStyle: {
        opacity: !highlight || highlight.edgeIds.has(edgeId) ? 1 : 0.14,
      },
      label:
        raw.kind === "CONTINUES" || raw.kind === "CANDIDATE"
          ? raw.kind === "CANDIDATE" || candidate
            ? "候选接续"
            : highlight?.edgeIds.has(edgeId)
              ? "跨任务接续"
              : undefined
          : raw.kind === "VALUE" && !highlight?.edgeIds.has(edgeId)
            ? undefined
            : ((
              {
                VALUE: raw.detail?.materializationFolded === true &&
                  Array.isArray(raw.detail.materializationBridgeIds) && raw.detail.materializationBridgeIds.length
                    ? `取值 · 经 ${new Set(raw.detail.materializationBridgeIds).size} 个中间步骤`
                    : "取值",
                READS_TABLE: raw.kind === "READS_TABLE" ? tableRelationLabel(raw) : "输入",
                WRITES_TABLE: raw.kind === "WRITES_TABLE" ? tableRelationLabel(raw) : "产出",
              } as Record<string, string>
            )[raw.kind] ?? raw.kind),
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
      },
      style: {
        stroke: color,
        strokeWidth: ["READS_TABLE", "WRITES_TABLE"].includes(raw.kind)
          ? tableRelationStrokeWidth(raw)
          : confirmed
            ? 2
            : 1.5,
        strokeDasharray: candidate ? "6 5" : undefined,
        opacity: !highlight || highlight.edgeIds.has(edgeId) ? 1 : 0.14,
      },
      data: { raw },
    } satisfies Edge;
    if (raw.kind !== "VALUE")
      return visual.source === visual.target ? [] : [visual];
    const taskId = text(nodeById.get(raw.to)?.taskId);
    if (!taskId) return [visual];
    return [
      {
        ...visual,
        id: `${edgeId}:input`,
        style: {...visual.style, stroke: candidate ? color : INPUT_EDGE_COLOR},
        markerEnd: {...visual.markerEnd, color: candidate ? color : INPUT_EDGE_COLOR},
        target: `task:${taskId}`,
        targetHandle: `${edgeId}:input`,
        label: highlight?.edgeIds.has(edgeId) ? "输入" : undefined,
      },
      {
        ...visual,
        id: `${edgeId}:output`,
        style: {...visual.style, stroke: candidate ? color : OUTPUT_EDGE_COLOR},
        markerEnd: {...visual.markerEnd, color: candidate ? color : OUTPUT_EDGE_COLOR},
        source: `task:${taskId}`,
        sourceHandle: `${edgeId}:output`,
        label: highlight?.edgeIds.has(edgeId) ? valueOutputLabel(raw) : undefined,
      },
    ];
  });
  return applyDirectTaskHighlight(
    { nodes, edges: [...edges, ...constantEdges] },
    options.highlightedTaskId,
  );
}

export function applyDirectTaskHighlight(
  graph: { nodes: Node<LineageNodeData>[]; edges: Edge[] },
  taskId?: string,
): { nodes: Node<LineageNodeData>[]; edges: Edge[] } {
  if (!taskId || !graph.nodes.some((node) => node.id === taskId)) return graph;
  const incident = graph.edges.filter(
    (edge) => edge.source === taskId || edge.target === taskId,
  );
  const activeEdges = new Set(incident.map(({ id }) => id));
  const activeNodes = new Set<string>([taskId]);
  const activeHandles = new Map<string, Set<string>>();
  const addHandle = (nodeId: string, handle: string | null | undefined) => {
    if (!handle) return;
    const handles = activeHandles.get(nodeId) ?? new Set<string>();
    handles.add(handle);
    activeHandles.set(nodeId, handles);
  };
  for (const edge of incident) {
    activeNodes.add(edge.source);
    activeNodes.add(edge.target);
    addHandle(edge.source, edge.sourceHandle);
    addHandle(edge.target, edge.targetHandle);
  }
  return {
    nodes: graph.nodes
      .filter((node) => activeNodes.has(node.id))
      .map((node) => {
        const handles = activeHandles.get(node.id) ?? new Set<string>();
        const fieldIds = node.data.taskPorts
          ?.filter((port) => handles.has(port.id))
          .map((port) => port.fieldNodeId);
        return {
          ...node,
          style: { ...node.style, opacity: 1 },
          data: {
            ...node.data,
            highlightActive: true,
            activeFieldIds: fieldIds?.length ? fieldIds : [...handles],
          },
        };
      }),
    edges: graph.edges.filter((edge) => activeEdges.has(edge.id)),
  };
}
