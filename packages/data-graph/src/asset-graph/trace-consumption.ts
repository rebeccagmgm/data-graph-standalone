import { createHash } from "node:crypto";
import {
  consumptionScopeFromDetail,
  consumptionScopeIdentity,
  mergeConsumptionScopes,
  type ConsumptionScope,
} from "./consumption-scope.ts";

export type {
  ConsumptionScope,
  ConsumptionScopeItem,
} from "./consumption-scope.ts";

export interface TraceConsumptionNode {
  readonly id: string;
  readonly kind: string;
  readonly table?: string;
  readonly column?: string;
  readonly taskId?: string;
  readonly writeId?: string;
  readonly depth?: number;
  readonly detail?: Record<string, unknown>;
  readonly metadataIdentity?: Record<string, unknown>;
}

export interface TraceConsumptionEdge {
  readonly id?: string;
  readonly key?: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly status?: string;
  readonly detail?: Record<string, unknown>;
}

export interface ConsumptionWriteRef {
  readonly taskId: string;
  readonly writeId: string;
  readonly rawNodeIds: string[];
  readonly rawEdgeIds: string[];
  readonly scope: ConsumptionScope;
}

export interface ConsumptionField {
  readonly column: string;
  readonly rawNodeIds: string[];
  readonly rawEdgeIds: string[];
  readonly writeRefs: ConsumptionWriteRef[];
}

export interface ConsumptionGroup {
  readonly id: string;
  readonly role: "READ" | "WRITE" | "OTHER";
  /** EVIDENCE_CONTAINER groups display aliases without asserting scope equality. */
  readonly presentation: "FIELD_GROUP" | "EVIDENCE_CONTAINER" | "RAW_NODE";
  readonly scopeEquivalence: "PROVEN" | "NOT_ASSERTED";
  readonly depth: number;
  readonly table?: string;
  readonly taskId?: string;
  readonly physicalIdentity?: string;
  readonly scope: ConsumptionScope;
  readonly rawNodeIds: string[];
  readonly rawEdgeIds: string[];
  readonly rootNodeIds: string[];
  readonly fields: ConsumptionField[];
  readonly writeRefs: ConsumptionWriteRef[];
}

export interface ConsumptionFieldMapping {
  readonly sourceColumn?: string;
  readonly targetColumn?: string;
  readonly sourceNodeIds: string[];
  readonly targetNodeIds: string[];
  readonly rawEdgeIds: string[];
}

export interface ConsumptionBranch {
  readonly id: string;
  readonly fromGroupId: string;
  readonly toGroupId: string;
  readonly kind: string;
  readonly status?: string;
  readonly scope: ConsumptionScope;
  readonly rawEdgeIds: string[];
  readonly rootNodeIds: string[];
  readonly fieldMappings: ConsumptionFieldMapping[];
}

export interface ConsumptionRootPath {
  readonly rootNodeId: string;
  readonly rawNodeIds: string[];
  readonly rawEdgeIds: string[];
  readonly groupIds: string[];
  readonly branchIds: string[];
}

export interface TraceConsumption {
  readonly schemaVersion: "1.0.0";
  readonly groups: ConsumptionGroup[];
  readonly branches: ConsumptionBranch[];
  readonly rootPaths: ConsumptionRootPath[];
}

interface MutableGroup {
  id: string;
  role: ConsumptionGroup["role"];
  presentation: ConsumptionGroup["presentation"];
  scopeEquivalence: ConsumptionGroup["scopeEquivalence"];
  depth: number;
  table?: string;
  taskId?: string;
  physicalIdentity?: string;
  scope: ConsumptionScope;
  rawNodeIds: Set<string>;
  rawEdgeIds: Set<string>;
  rootNodeIds: Set<string>;
  fields: Map<string, {
    column: string;
    rawNodeIds: Set<string>;
    rawEdgeIds: Set<string>;
    writeRefs: Map<string, ConsumptionWriteRef>;
  }>;
  writeRefs: Map<string, ConsumptionWriteRef>;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const edgeId = (edge: TraceConsumptionEdge, index: number) =>
  edge.id ?? edge.key ?? `${edge.from}|${edge.to}|${edge.kind}|${edge.status ?? ""}|${index}`;

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

function physicalIdentity(node: TraceConsumptionNode) {
  const identity = node.metadataIdentity ?? node.detail;
  const platform = text(identity?.platform);
  const dataSource = text(identity?.dataSource);
  const qualifiedName = text(identity?.qualifiedName);
  const identityStatus = text(identity?.identityStatus);
  if (
    !platform ||
    !dataSource ||
    !qualifiedName ||
    (identityStatus && identityStatus !== "CONFIRMED")
  )
    return undefined;
  const stable = text(identity?.stableTableId);
  return `${platform}:${dataSource}:${qualifiedName}:${stable ?? ""}`.toLowerCase();
}

const shortId = (prefix: string, key: string) =>
  `${prefix}:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;

function role(node: TraceConsumptionNode): ConsumptionGroup["role"] {
  if (node.kind === "READ_FIELD") return "READ";
  if (node.kind === "WRITE_FIELD") return "WRITE";
  return "OTHER";
}

function reachable(
  rootNodeId: string,
  direction: "up" | "down",
  edges: readonly TraceConsumptionEdge[],
  ids: readonly string[],
) {
  const nodeIds = new Set([rootNodeId]);
  const rawEdgeIds = new Set<string>();
  const pending = [rootNodeId];
  const expanded = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (expanded.has(current)) continue;
    expanded.add(current);
    edges.forEach((edge, index) => {
      const follows = direction === "up" ? edge.to === current : edge.from === current;
      if (!follows) return;
      const next = direction === "up" ? edge.from : edge.to;
      rawEdgeIds.add(ids[index]!);
      nodeIds.add(next);
      if (
        edge.kind === "CANDIDATE" ||
        ["CANDIDATE", "ASSUMED", "UNKNOWN"].includes(edge.status ?? "")
      )
        return;
      if (!expanded.has(next)) pending.push(next);
    });
  }
  return { nodeIds, rawEdgeIds };
}

/**
 * Builds a read-only consumer projection over a bounded raw traversal. It never
 * creates lineage: every display group, branch and path points back to raw ids.
 */
export function buildTraceConsumption(input: {
  readonly nodes: readonly TraceConsumptionNode[];
  readonly edges: readonly TraceConsumptionEdge[];
  readonly direction: "up" | "down";
}): TraceConsumption {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const edgeIds = input.edges.map(edgeId);
  const scopesByNode = new Map<string, ConsumptionScope[]>();
  input.edges.forEach((edge) => {
    if (!['CONTINUES', 'CANDIDATE'].includes(edge.kind)) return;
    const scope = consumptionScopeFromDetail(edge.detail);
    for (const nodeId of [edge.from, edge.to]) {
      const scopes = scopesByNode.get(nodeId) ?? [];
      scopes.push(scope);
      scopesByNode.set(nodeId, scopes);
    }
  });

  const roots = input.nodes.filter((node) => Number(node.depth ?? 0) === 0);
  const rootReachability = new Map(
    roots.map((root) => [root.id, reachable(root.id, input.direction, input.edges, edgeIds)]),
  );
  const nodeRoots = new Map<string, Set<string>>();
  const edgeRoots = new Map<string, Set<string>>();
  for (const [rootId, path] of rootReachability) {
    for (const nodeId of path.nodeIds) {
      const values = nodeRoots.get(nodeId) ?? new Set<string>();
      values.add(rootId);
      nodeRoots.set(nodeId, values);
    }
    for (const rawEdgeId of path.rawEdgeIds) {
      const values = edgeRoots.get(rawEdgeId) ?? new Set<string>();
      values.add(rootId);
      edgeRoots.set(rawEdgeId, values);
    }
  }

  const keyByNode = new Map<string, string>();
  const identityForNode = (node: TraceConsumptionNode) => {
    const direct = physicalIdentity(node);
    if (direct) return direct;
    if (node.kind !== "WRITE_FIELD") return undefined;
    const alignedReads = input.edges
      .filter(
        (edge) =>
          edge.from === node.id &&
          edge.kind === "CONTINUES" &&
          edge.status === "CONFIRMED",
      )
      .map((edge) => nodesById.get(edge.to))
      .filter((candidate): candidate is TraceConsumptionNode =>
        Boolean(candidate),
      )
      .map(physicalIdentity)
      .filter((identity): identity is string => Boolean(identity));
    return sorted(alignedReads).length === 1 ? sorted(alignedReads)[0] : undefined;
  };
  const readKey = (node: TraceConsumptionNode) =>
    `read:${text(node.taskId) ?? ""}:${text(node.detail?.occurrenceId) ?? node.id}:${identityForNode(node) ?? node.id}`;
  const sharedWriteKey = (node: TraceConsumptionNode, identity: string | undefined) => {
    if (!identity || Number(node.depth ?? 0) === 0) return undefined;
    const outgoing = input.edges.filter(edge => edge.from === node.id);
    if (!outgoing.length || outgoing.some(edge => edge.kind !== "CONTINUES" || edge.status !== "CONFIRMED"))
      return undefined;
    const scopes = outgoing.map(edge => consumptionScopeFromDetail(edge.detail));
    const scopeKeys = sorted(scopes.map(consumptionScopeIdentity));
    if (scopeKeys.length !== 1 || scopes.some(scope => scope.status !== "EXPLICIT")) return undefined;
    const consumers = outgoing.map(edge => nodesById.get(edge.to));
    if (consumers.some(consumer => consumer?.kind !== "READ_FIELD" || !physicalIdentity(consumer))) return undefined;
    // Merge display aliases only for the same consumers at the same depth.
    // Raw task/write ids and root paths remain independent evidence.
    return `shared-write:${JSON.stringify([identity, Number(node.depth), scopeKeys[0], sorted(consumers.map(consumer => readKey(consumer!)))])}`;
  };
  for (const node of input.nodes) {
    const nodeRole = role(node);
    const depth = Number(node.depth ?? 0);
    if (nodeRole === "READ") {
      keyByNode.set(
        node.id,
        readKey(node),
      );
      continue;
    }
    if (nodeRole === "WRITE") {
      const scopes = scopesByNode.get(node.id) ?? [];
      const explicitKeys = sorted(
        scopes
          .filter((scope) => scope.status === "EXPLICIT")
          .map(consumptionScopeIdentity),
      );
      const identity = identityForNode(node);
      const safeBranch = explicitKeys.length
        ? `scope:${explicitKeys.join("+")}`
        : identity && text(node.taskId)
          ? "exact-identity-evidence-container"
        : `write:${text(node.writeId) ?? node.id}`;
      keyByNode.set(
        node.id,
        sharedWriteKey(node, identity) ?? `write:${text(node.taskId) ?? ""}:${identity ?? node.id}:${safeBranch}`,
      );
      continue;
    }
    keyByNode.set(node.id, `node:${node.id}`);
  }

  const groups = new Map<string, MutableGroup>();
  for (const node of input.nodes) {
    const key = keyByNode.get(node.id)!;
    const groupId = shortId("consumption-group", key);
    const incident = input.edges
      .map((edge, index) => ({ edge, id: edgeIds[index]! }))
      .filter(({ edge }) => edge.from === node.id || edge.to === node.id);
    const scopes = scopesByNode.get(node.id) ?? [];
    const nodeScope = scopes.length
      ? mergeConsumptionScopes(scopes)
      : consumptionScopeFromDetail(node.detail);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: groupId,
        role: role(node),
        presentation:
          role(node) === "OTHER"
            ? "RAW_NODE"
            : role(node) === "WRITE" && key.includes("exact-identity-evidence-container")
              ? "EVIDENCE_CONTAINER"
              : "FIELD_GROUP",
        scopeEquivalence:
          key.includes("exact-identity-evidence-container")
            ? "NOT_ASSERTED"
            : "PROVEN",
        depth: Number(node.depth ?? 0),
        ...(text(node.table) ? { table: text(node.table) } : {}),
        ...(text(node.taskId) ? { taskId: text(node.taskId) } : {}),
        ...(identityForNode(node)
          ? { physicalIdentity: identityForNode(node) }
          : {}),
        scope: nodeScope,
        rawNodeIds: new Set(),
        rawEdgeIds: new Set(),
        rootNodeIds: new Set(),
        fields: new Map(),
        writeRefs: new Map(),
      };
      groups.set(key, group);
    } else {
      group.scope = mergeConsumptionScopes([group.scope, nodeScope]);
      group.depth = Math.min(group.depth, Number(node.depth ?? 0));
      if (group.taskId !== text(node.taskId)) delete group.taskId;
    }
    group.rawNodeIds.add(node.id);
    incident.forEach(({ id }) => group!.rawEdgeIds.add(id));
    for (const rootId of nodeRoots.get(node.id) ?? []) group.rootNodeIds.add(rootId);
    const column = text(node.column);
    const fieldKey = column?.toLowerCase() ?? node.id;
    let field = group.fields.get(fieldKey);
    if (!field) {
      field = { column: column ?? node.id, rawNodeIds: new Set(), rawEdgeIds: new Set(), writeRefs: new Map() };
      group.fields.set(fieldKey, field);
    }
    field.rawNodeIds.add(node.id);
    incident.forEach(({ id }) => field!.rawEdgeIds.add(id));

    const writeNodes = node.kind === "WRITE_FIELD"
      ? [node]
      : incident
          .map(({ edge }) => nodesById.get(edge.from))
          .filter((candidate): candidate is TraceConsumptionNode => candidate?.kind === "WRITE_FIELD");
    for (const write of writeNodes) {
      const writeId = text(write.writeId) ?? text(write.detail?.writeObservationId);
      const taskId = text(write.taskId);
      if (!writeId || !taskId) continue;
      const writeEdges = input.edges
        .map((edge, index) => ({ edge, id: edgeIds[index]! }))
        .filter(
          ({ edge }) =>
            edge.from === write.id &&
            ["CONTINUES", "CANDIDATE"].includes(edge.kind) &&
            (node.kind === "WRITE_FIELD" || edge.to === node.id),
        );
      const scope = mergeConsumptionScopes(
        writeEdges.length ? writeEdges.map(({ edge }) => consumptionScopeFromDetail(edge.detail))
          : [consumptionScopeFromDetail(write.detail)],
      );
      const ref: ConsumptionWriteRef = {
        taskId,
        writeId,
        rawNodeIds: [write.id],
        rawEdgeIds: sorted(writeEdges.map(({ id }) => id)),
        scope,
      };
      const refKey = `${taskId}|${writeId}|${consumptionScopeIdentity(scope)}`;
      const existingGroupRef = group.writeRefs.get(refKey);
      group.writeRefs.set(refKey, {
        ...ref,
        rawNodeIds: sorted([
          ...(existingGroupRef?.rawNodeIds ?? []),
          ...ref.rawNodeIds,
        ]),
        rawEdgeIds: sorted([
          ...(existingGroupRef?.rawEdgeIds ?? []),
          ...ref.rawEdgeIds,
        ]),
      });
      const existingFieldRef = field.writeRefs.get(refKey);
      field.writeRefs.set(refKey, {
        ...ref,
        rawNodeIds: sorted([
          ...(existingFieldRef?.rawNodeIds ?? []),
          ...ref.rawNodeIds,
        ]),
        rawEdgeIds: sorted([
          ...(existingFieldRef?.rawEdgeIds ?? []),
          ...ref.rawEdgeIds,
        ]),
      });
    }
  }

  const groupByNode = new Map<string, string>();
  for (const group of groups.values())
    for (const nodeId of group.rawNodeIds) groupByNode.set(nodeId, group.id);

  const branches = new Map<string, {
    id: string;
    fromGroupId: string;
    toGroupId: string;
    kind: string;
    status?: string;
    scope: ConsumptionScope;
    rawEdgeIds: Set<string>;
    rootNodeIds: Set<string>;
    fieldMappings: Map<string, ConsumptionFieldMapping>;
  }>();
  input.edges.forEach((edge, index) => {
    const rawEdgeId = edgeIds[index]!;
    const fromGroupId = groupByNode.get(edge.from);
    const toGroupId = groupByNode.get(edge.to);
    if (!fromGroupId || !toGroupId || fromGroupId === toGroupId) return;
    const scope = consumptionScopeFromDetail(edge.detail);
    const key = `${fromGroupId}|${toGroupId}|${edge.kind}|${edge.status ?? ""}|${consumptionScopeIdentity(scope)}`;
    let branch = branches.get(key);
    if (!branch) {
      branch = {
        id: shortId("consumption-branch", key),
        fromGroupId,
        toGroupId,
        kind: edge.kind,
        ...(edge.status ? { status: edge.status } : {}),
        scope,
        rawEdgeIds: new Set(),
        rootNodeIds: new Set(),
        fieldMappings: new Map(),
      };
      branches.set(key, branch);
    }
    branch.rawEdgeIds.add(rawEdgeId);
    for (const rootId of edgeRoots.get(rawEdgeId) ?? []) branch.rootNodeIds.add(rootId);
    const source = nodesById.get(edge.from);
    const target = nodesById.get(edge.to);
    const mappingKey = `${text(source?.column)?.toLowerCase() ?? ""}|${text(target?.column)?.toLowerCase() ?? ""}`;
    const existing = branch.fieldMappings.get(mappingKey);
    branch.fieldMappings.set(mappingKey, {
      ...(text(source?.column) ? { sourceColumn: text(source?.column) } : {}),
      ...(text(target?.column) ? { targetColumn: text(target?.column) } : {}),
      sourceNodeIds: sorted([...(existing?.sourceNodeIds ?? []), edge.from]),
      targetNodeIds: sorted([...(existing?.targetNodeIds ?? []), edge.to]),
      rawEdgeIds: sorted([...(existing?.rawEdgeIds ?? []), rawEdgeId]),
    });
  });

  const finalGroups: ConsumptionGroup[] = [...groups.values()]
    .map((group) => ({
      id: group.id,
      role: group.role,
      presentation: group.presentation,
      scopeEquivalence: group.scopeEquivalence,
      depth: group.depth,
      ...(group.table ? { table: group.table } : {}),
      ...(group.taskId ? { taskId: group.taskId } : {}),
      ...(group.physicalIdentity ? { physicalIdentity: group.physicalIdentity } : {}),
      scope: group.scope,
      rawNodeIds: sorted(group.rawNodeIds),
      rawEdgeIds: sorted(group.rawEdgeIds),
      rootNodeIds: sorted(group.rootNodeIds),
      fields: [...group.fields.values()]
        .map((field) => ({
          column: field.column,
          rawNodeIds: sorted(field.rawNodeIds),
          rawEdgeIds: sorted(field.rawEdgeIds),
          writeRefs: [...field.writeRefs.values()].sort((a, b) => `${a.taskId}|${a.writeId}`.localeCompare(`${b.taskId}|${b.writeId}`)),
        }))
        .sort((a, b) => a.column.localeCompare(b.column)),
      writeRefs: [...group.writeRefs.values()].sort((a, b) => `${a.taskId}|${a.writeId}`.localeCompare(`${b.taskId}|${b.writeId}`)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const finalBranches: ConsumptionBranch[] = [...branches.values()]
    .map((branch) => ({
      id: branch.id,
      fromGroupId: branch.fromGroupId,
      toGroupId: branch.toGroupId,
      kind: branch.kind,
      ...(branch.status ? { status: branch.status } : {}),
      scope: branch.scope,
      rawEdgeIds: sorted(branch.rawEdgeIds),
      rootNodeIds: sorted(branch.rootNodeIds),
      fieldMappings: [...branch.fieldMappings.values()].sort((a, b) =>
        `${a.sourceColumn ?? ""}|${a.targetColumn ?? ""}`.localeCompare(`${b.sourceColumn ?? ""}|${b.targetColumn ?? ""}`),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const branchByEdge = new Map<string, string>();
  for (const branch of finalBranches)
    for (const rawEdgeId of branch.rawEdgeIds) branchByEdge.set(rawEdgeId, branch.id);
  const rootPaths = [...rootReachability.entries()].map(([rootNodeId, path]) => ({
    rootNodeId,
    rawNodeIds: sorted(path.nodeIds),
    rawEdgeIds: sorted(path.rawEdgeIds),
    groupIds: sorted([...path.nodeIds].map((nodeId) => groupByNode.get(nodeId)).filter((id): id is string => Boolean(id))),
    branchIds: sorted([...path.rawEdgeIds].map((id) => branchByEdge.get(id)).filter((id): id is string => Boolean(id))),
  }));
  return { schemaVersion: "1.0.0", groups: finalGroups, branches: finalBranches, rootPaths };
}

/** Validate the loose store transport shape before projecting it. */
export function buildTraceConsumptionFromRecords(input: {
  readonly nodes: readonly Record<string, unknown>[];
  readonly edges: readonly Record<string, unknown>[];
  readonly direction: "up" | "down";
}): TraceConsumption {
  const nodes = input.nodes.flatMap((node): TraceConsumptionNode[] => {
    const id = text(node.id);
    const kind = text(node.kind);
    if (!id || !kind) return [];
    return [{ ...node, id, kind } as TraceConsumptionNode];
  });
  const edges = input.edges.flatMap((edge): TraceConsumptionEdge[] => {
    const from = text(edge.from);
    const to = text(edge.to);
    const kind = text(edge.kind);
    if (!from || !to || !kind) return [];
    return [{ ...edge, from, to, kind } as TraceConsumptionEdge];
  });
  return buildTraceConsumption({ nodes, edges, direction: input.direction });
}
