import type { Viewport } from "@xyflow/react";
import type { Anchor, Direction, GraphLayer } from "./types";
import {parsePartitionSelection} from "../../data-graph/src/asset-graph/partition-selection";

export const EXPLORATION_STORAGE_KEY =
  "sql-static-lineage:data-graph-ui:exploration-entries";
export const EXPLORATION_STORAGE_VERSION = 1;

export type ExplorationMember = {
  id: string;
  anchor: Anchor;
  kind: "TASK" | "PHYSICAL_DATASET";
  label: string;
};

export type ExplorationState = {
  activeMemberId: string;
  layer: GraphLayer;
  direction: Direction;
  depth: number;
  candidates: boolean;
  selectedFieldIds: string[];
  expandedCandidateIds: string[];
  viewport: Viewport;
};

export type ExplorationEntry = {
  id: string;
  name: string;
  description: string;
  graphVersion: string;
  createdAt: string;
  updatedAt: string;
  members: ExplorationMember[];
  state: ExplorationState;
};

type StoredExplorations = {
  formatVersion: number;
  entries: ExplorationEntry[];
};

export type ExplorationReadResult = {
  entries: ExplorationEntry[];
  warning?: string;
};

export type ExplorationWriteResult = { warning?: string };

export type ExplorationRestoreAssessment = {
  graphVersionChanged: boolean;
  selectedFieldIds: string[];
  missingFieldIds: string[];
};

export type ExplorationAnchorAssessment = {
  expectedNodeId: string;
  present: boolean;
};

type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isViewport(value: unknown): value is Viewport {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.zoom === "number"
  );
}

function isAnchor(value: unknown): value is Anchor {
  if (isRecord(value) && value.tableContextIds !== undefined &&
    (!isStringArray(value.tableContextIds) || !value.tableContextIds.length)) return false;
  if (isRecord(value) && value.partitionSelection !== undefined) {
    try { parsePartitionSelection(JSON.stringify(value.partitionSelection)); }
    catch { return false; }
  }
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    ["taskId", "table", "nodeId"].some((key) => typeof value[key] === "string")
  );
}

function isMember(value: unknown): value is ExplorationMember {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.kind === "TASK" || value.kind === "PHYSICAL_DATASET") &&
    isAnchor(value.anchor)
  );
}

function isState(value: unknown): value is ExplorationState {
  return (
    isRecord(value) &&
    typeof value.activeMemberId === "string" &&
    (value.layer === "table" || value.layer === "field") &&
    (value.direction === "up" || value.direction === "down") &&
    typeof value.depth === "number" &&
    typeof value.candidates === "boolean" &&
    isStringArray(value.selectedFieldIds) &&
    isStringArray(value.expandedCandidateIds) &&
    isViewport(value.viewport)
  );
}

function isEntry(value: unknown): value is ExplorationEntry {
  const state = isRecord(value) ? value.state : undefined;
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.graphVersion === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.members) &&
    value.members.length > 0 &&
    value.members.every(isMember) &&
    isState(state) &&
    value.members.some((member) => member.id === state.activeMemberId)
  );
}

function stableMemberId(anchor: Anchor): string {
  if (anchor.taskId) return `task:${anchor.taskId}`;
  if (anchor.nodeId && anchor.tableContextIds?.length)
    return `node:${anchor.nodeId}:contexts:${JSON.stringify([...new Set(anchor.tableContextIds)].sort())}`;
  if (anchor.nodeId) return `node:${anchor.nodeId}`;
  return `table:${anchor.table ?? anchor.label}`;
}

export function explorationMember(anchor: Anchor): ExplorationMember {
  return {
    id: stableMemberId(anchor),
    anchor: { ...anchor },
    kind: anchor.taskId ? "TASK" : "PHYSICAL_DATASET",
    label: anchor.label,
  };
}

export function readExplorationEntries(
  storage: BrowserStorage | undefined,
): ExplorationReadResult {
  if (!storage) return { entries: [] };
  try {
    const raw = storage.getItem(EXPLORATION_STORAGE_KEY);
    if (!raw) return { entries: [] };
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.formatVersion !== EXPLORATION_STORAGE_VERSION ||
      !Array.isArray(parsed.entries) ||
      !parsed.entries.every(isEntry)
    ) {
      return {
        entries: [],
        warning: "本机保存的探索入口格式无效，已忽略，未改动原记录。",
      };
    }
    return { entries: parsed.entries };
  } catch {
    return {
      entries: [],
      warning: "本机保存的探索入口无法读取，已忽略，未改动原记录。",
    };
  }
}

export function writeExplorationEntries(
  storage: BrowserStorage | undefined,
  entries: ExplorationEntry[],
): ExplorationWriteResult {
  if (!storage) return { warning: "当前浏览器不支持本机保存。" };
  try {
    const value: StoredExplorations = {
      formatVersion: EXPLORATION_STORAGE_VERSION,
      entries,
    };
    storage.setItem(EXPLORATION_STORAGE_KEY, JSON.stringify(value));
    return {};
  } catch {
    return { warning: "探索入口未能写入当前浏览器。" };
  }
}

export function assessExplorationRestore(
  entry: ExplorationEntry,
  currentGraphVersion: string,
  availableFieldIds: string[],
): ExplorationRestoreAssessment {
  const available = new Set(availableFieldIds);
  const selectedFieldIds = entry.state.selectedFieldIds.filter((id) =>
    available.has(id),
  );
  return {
    graphVersionChanged: entry.graphVersion !== currentGraphVersion,
    selectedFieldIds,
    missingFieldIds: entry.state.selectedFieldIds.filter(
      (id) => !available.has(id),
    ),
  };
}

export function assessExplorationAnchor(
  anchor: Anchor,
  returnedNodeIds: string[],
): ExplorationAnchorAssessment {
  const expectedNodeId =
    anchor.nodeId ??
    (anchor.taskId ? `task:${anchor.taskId}` : `table:${anchor.table ?? anchor.label}`);
  return {
    expectedNodeId,
    present: returnedNodeIds.includes(expectedNodeId) ||
      Boolean(anchor.tableContextIds?.some(id => returnedNodeIds.includes(id))),
  };
}

export function createExplorationEntry(input: {
  id: string;
  name: string;
  description: string;
  graphVersion: string;
  member: ExplorationMember;
  state: Omit<ExplorationState, "activeMemberId">;
  now: string;
}): ExplorationEntry {
  const name = input.name.trim();
  if (!name) throw new Error("请填写专题名称。");
  return {
    id: input.id,
    name,
    description: input.description.trim(),
    graphVersion: input.graphVersion,
    createdAt: input.now,
    updatedAt: input.now,
    members: [input.member],
    state: { ...input.state, activeMemberId: input.member.id },
  };
}

export function withExplorationMember(
  entry: ExplorationEntry,
  member: ExplorationMember,
  state: ExplorationState,
  now: string,
): ExplorationEntry {
  const members = entry.members.some((item) => item.id === member.id)
    ? entry.members
    : [...entry.members, member];
  return {
    ...entry,
    members,
    state: { ...state, activeMemberId: member.id },
    updatedAt: now,
  };
}

export function withoutExplorationMember(
  entry: ExplorationEntry,
  memberId: string,
  now: string,
): ExplorationEntry | undefined {
  const members = entry.members.filter((member) => member.id !== memberId);
  if (!members.length) return undefined;
  return {
    ...entry,
    members,
    state: {
      ...entry.state,
      activeMemberId:
        entry.state.activeMemberId === memberId
          ? members[0]!.id
          : entry.state.activeMemberId,
    },
    updatedAt: now,
  };
}

export function deleteExplorationEntry(
  entries: ExplorationEntry[],
  entryId: string,
): ExplorationEntry[] {
  return entries.filter((entry) => entry.id !== entryId);
}

export function updateExplorationEntry(
  entry: ExplorationEntry,
  patch: Pick<ExplorationEntry, "name" | "description" | "graphVersion" | "state">,
  now: string,
): ExplorationEntry {
  const name = patch.name.trim();
  if (!name) throw new Error("请填写专题名称。");
  return {
    ...entry,
    ...patch,
    name,
    description: patch.description.trim(),
    updatedAt: now,
  };
}
