import { canonicalJson, sha256 } from "../../../machine-facts/machine-facts-contract.ts";
import {
  qualifyBareTableName,
  type TaskDefaultSchema,
} from "../../shared/task-default-schema.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

export const IMPACT_CHANNELS = [
  "FIELD_VALUE",
  "EXPRESSION_CONTROL",
  "ROW_MEMBERSHIP",
  "MULTIPLICITY",
  "GROUPING",
  "SET_MEMBERSHIP",
  "ORDER_SELECTION",
  "WINDOW_EFFECT",
  "RELATION_EXISTENCE",
] as const;
export type ImpactChannel = (typeof IMPACT_CHANNELS)[number];

export const LOCAL_TRANSFER_KINDS = [
  "RELATION_OPERATOR",
  "VALUE_FLOW",
  "CONTROL_FIELD_DEMAND",
  "MULTIPLICITY_FIELD_DEMAND",
] as const;
export type LocalTransferKind = (typeof LOCAL_TRANSFER_KINDS)[number];

export interface ReadImpact {
  readonly readOccurrenceId: string;
  readonly impactChannels: readonly ImpactChannel[];
  readonly localTransferKinds?: readonly LocalTransferKind[];
  /** Fields demanded by a downstream control/multiplicity operator. */
  readonly demandedFieldNames?: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly gaps: readonly string[];
}

export interface TaskRelationSummary {
  readonly taskId: string;
  /** Canonical SQL source/slot identity; never omit it from a summary key. */
  readonly sqlSourceId: string;
  readonly statementIndex: number;
  readonly rootRelationId: string | null;
  readonly digest: string;
  readonly complete: boolean;
  readonly readImpacts: readonly ReadImpact[];
  readonly relationCount: number;
  readonly readCount: number;
  readonly edgeCount: number;
  readonly gaps: readonly string[];
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function records(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value)
    ? value.map(record)
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function canonicalSqlSourceId(value: string): string {
  const normalized = value.trim();
  const statement = normalized.match(/^(.*?):statement:\d+(?::|$)/i);
  if (statement?.[1]) return statement[1];
  const relation = normalized.match(/^(.*?):relation:/i);
  if (relation?.[1]) return relation[1];
  const query = normalized.match(/^(query#\d+)(?::|$)/i);
  return query?.[1] ?? normalized;
}

export function relationSummaryKey(
  taskId: string,
  sqlSourceId: string,
  statementIndex: number,
  rootRelationId?: string | null,
): string {
  const root = rootRelationId ? `|root:${rootRelationId}` : "";
  return `${taskId}|source:${canonicalSqlSourceId(sqlSourceId)}|statement:${statementIndex}${root}`;
}

export function summaryForOccurrence(
  summaries: ReadonlyMap<string, TaskRelationSummary>,
  taskId: string | null,
  sqlSourceId: string | null,
  statementIndex: number | null,
  rootRelationId?: string | null,
): TaskRelationSummary | undefined {
  if (!taskId || !sqlSourceId || statementIndex === null) return undefined;
  const source = canonicalSqlSourceId(sqlSourceId);
  const scoped = rootRelationId ? summaries.get(relationSummaryKey(taskId, source, statementIndex, rootRelationId)) : undefined;
  if (scoped?.taskId === taskId && scoped.sqlSourceId === source && scoped.statementIndex === statementIndex) return scoped;
  if (rootRelationId) return undefined;
  const summary = summaries.get(relationSummaryKey(taskId, source, statementIndex));
  if (summary?.taskId === taskId && summary.sqlSourceId === source && summary.statementIndex === statementIndex) return summary;
  return undefined;
}

function statementIndexFromId(value: string | null): number | null {
  if (!value) return null;
  const statement = value.match(/(?:^|:)statement:(\d+)(?::|$)/i);
  if (statement) return Number(statement[1]);
  const query = value.match(/^query#(\d+)(?::|$)/i);
  return query ? Number(query[1]) : null;
}

function sourceIdFromId(value: string | null): string | null {
  if (!value) return null;
  return canonicalSqlSourceId(value);
}

function sorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function relationOf(row: JsonRecord): JsonRecord {
  return record(row.relation);
}

function relationId(row: JsonRecord): string | null {
  return text(row.relation_id) ?? text(relationOf(row).id);
}

function relationType(row: JsonRecord): string | null {
  return (text(row.relation_type) ?? text(relationOf(row).type))?.toLowerCase() ?? null;
}

function readOccurrenceId(row: JsonRecord): string | null {
  const relation = relationOf(row);
  return text(relation.read_occurrence_id) ?? text(relation.id) ?? relationId(row);
}

function childRelationIds(row: JsonRecord): readonly string[] {
  const relation = relationOf(row);
  const direct = [relation.source, relation.input, relation.left, relation.right]
    .map(text)
    .filter((value): value is string => value !== null);
  const branches = Array.isArray(relation.branches)
    ? relation.branches.filter((value): value is string => typeof value === "string")
    : [];
  return sorted([...direct, ...branches]);
}

function sourceRelationIds(
  row: JsonRecord,
  incoming: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const id = relationId(row);
  if (!id) return [];
  const direct = childRelationIds(row);
  const linked = incoming.get(id) ?? [];
  return sorted([...direct, ...linked]);
}

function normalizedTable(value: string): string {
  return value.replaceAll("`", "").replaceAll('"', "").trim().toLowerCase();
}

function tableMatches(left: string, right: string): boolean {
  const a = normalizedTable(left);
  const b = normalizedTable(right);
  return a === b;
}

function physicalColumnTables(row: JsonRecord): readonly string[] {
  const relation = relationOf(row);
  const columns = [...records(relation.predicate_columns), ...records(relation.condition_columns)];
  return sorted(columns.flatMap((column) => records(column.physical).map((item) => text(item.table)).filter((value): value is string => value !== null)));
}

function columnNames(columns: readonly JsonRecord[]): readonly string[] {
  return sorted(columns.flatMap((column) => [
    text(column.column),
    text(column.name),
  ].filter((value): value is string => value !== null)));
}

function physicalColumnNames(row: JsonRecord): readonly string[] {
  const relation = relationOf(row);
  return columnNames([
    ...records(relation.predicate_columns),
    ...records(relation.condition_columns),
    ...records(relation.input_columns),
    ...records(relation.output_columns),
  ]);
}

/** Join/filter demand the predicate keys, not every projected output column. */
function operatorDemandColumns(row: JsonRecord): readonly string[] {
  const type = relationType(row);
  const relation = relationOf(row);
  if (type === "join") return columnNames(records(relation.condition_columns));
  if (type === "filter" || type === "having" || type === "qualify") {
    return columnNames(records(relation.predicate_columns));
  }
  return physicalColumnNames(row);
}

function exprText(row: JsonRecord): string {
  const relation = relationOf(row);
  return [
    text(relation.predicate_expr),
    text(relation.condition_expr),
    text(relation.expression),
    text(relation.predicate_display),
    text(relation.condition_display),
    text(row.source_text),
  ].filter((value): value is string => value !== null).join(" ");
}

function hasFunction(row: JsonRecord, names: readonly string[]): boolean {
  const relation = relationOf(row);
  const facts = record(relation.predicate_facts);
  const functionNames = records(facts.functions)
    .map((item) => text(item.name) ?? text(item.function) ?? text(item.text))
    .filter((value): value is string => value !== null)
    .join(" ");
  const haystack = `${exprText(row)} ${functionNames}`.toUpperCase();
  return names.some((name) => new RegExp(`\\b${name}\\s*\\(`, "i").test(haystack));
}

function joinSideChannels(joinType: string): {
  readonly left: readonly ImpactChannel[];
  readonly right: readonly ImpactChannel[];
} {
  const kind = joinType.toUpperCase();
  const membershipAndCard: readonly ImpactChannel[] = [
    "ROW_MEMBERSHIP",
    "MULTIPLICITY",
    "RELATION_EXISTENCE",
  ];
  const membershipOnly: readonly ImpactChannel[] = ["ROW_MEMBERSHIP", "RELATION_EXISTENCE"];
  // OUTER preserved = driving rows. Dropping a driving row drops output rows.
  // OUTER nullable = padding only: can 1-N or null-fill values, does not delete driving rows.
  const outerPreserved: readonly ImpactChannel[] = ["ROW_MEMBERSHIP", "RELATION_EXISTENCE"];
  const outerNullable: readonly ImpactChannel[] = ["MULTIPLICITY", "RELATION_EXISTENCE"];
  if (kind.includes("CROSS")) return { left: membershipAndCard, right: membershipAndCard };
  if (kind.includes("SEMI") || kind.includes("ANTI")) {
    return { left: membershipOnly, right: membershipOnly };
  }
  if (kind.includes("FULL")) return { left: membershipAndCard, right: membershipAndCard };
  if (kind.includes("RIGHT")) return { left: outerNullable, right: outerPreserved };
  if (kind.includes("LEFT")) return { left: outerPreserved, right: outerNullable };
  return { left: membershipAndCard, right: membershipAndCard };
}

function impactChannels(row: JsonRecord): readonly ImpactChannel[] {
  const type = relationType(row);
  const relation = relationOf(row);
  const expression = exprText(row);
  switch (type) {
    case "filter":
      return ["ROW_MEMBERSHIP", "RELATION_EXISTENCE"];
    case "join": {
      const sides = joinSideChannels(text(relation.join_type) ?? "INNER");
      return sorted([...sides.left, ...sides.right]) as ImpactChannel[];
    }
    case "aggregate":
      return hasFunction(row, ["COUNT", "SUM", "AVG", "MIN", "MAX", "COLLECT", "ARRAY_AGG"])
        ? ["GROUPING", "MULTIPLICITY", "RELATION_EXISTENCE", "FIELD_VALUE"]
        : ["GROUPING", "RELATION_EXISTENCE"];
    case "setop":
      return ["SET_MEMBERSHIP", "RELATION_EXISTENCE"];
    case "project":
      if (/\b(?:CASE|IF|COALESCE|NVL|DECODE)\b/i.test(expression)) return ["EXPRESSION_CONTROL"];
      if (/\b(?:COUNT\s*\(\s*\*|EXISTS)\b/i.test(expression)) return ["RELATION_EXISTENCE"];
      if (/^\s*(?:[-+]?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|NULL)(?:\s+AS?\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$/i.test(expression)) return ["RELATION_EXISTENCE"];
      return [];
    case "window":
      return ["WINDOW_EFFECT"];
    case "top_n":
      return ["ORDER_SELECTION", "ROW_MEMBERSHIP"];
    case "qualify":
    case "having":
      return ["ROW_MEMBERSHIP", "RELATION_EXISTENCE"];
    case "read":
      return [];
    default:
      return type === null ? [] : ["RELATION_EXISTENCE"];
  }
}

function localTransferKinds(row: JsonRecord, channels: readonly ImpactChannel[]): readonly LocalTransferKind[] {
  if (channels.length === 0) return [];
  const demanded = operatorDemandColumns(row);
  return [
    "RELATION_OPERATOR",
    ...(demanded.length > 0 && channels.includes("ROW_MEMBERSHIP") ? ["CONTROL_FIELD_DEMAND" as const] : []),
    ...(demanded.length > 0 && channels.includes("MULTIPLICITY") ? ["MULTIPLICITY_FIELD_DEMAND" as const] : []),
  ];
}

function hasUnsupportedShape(row: JsonRecord): boolean {
  const type = relationType(row);
  const relation = relationOf(row);
  // Modeled LATERAL VIEW is type=expand. Field-lineage already binds sibling
  // JOIN columns from Table Pack / default schema; that node must not fail-close
  // every other read in the statement.
  return type === "other" || Boolean(relation.unsupported) || Boolean(relation.dynamic);
}

/** Normalize relation facts once per task; it never parses raw SQL. */
export function summarizeTaskRelations(input: {
  readonly taskId: string;
  readonly sqlSourceId?: string;
  readonly relationRecords: readonly JsonRecord[];
  readonly relationEdgeRecords?: readonly JsonRecord[];
  readonly statementRecords?: readonly JsonRecord[];
  readonly statementIndex?: number;
  readonly rootRelationId?: string;
  readonly defaultSchema?: TaskDefaultSchema | null;
}): TaskRelationSummary {
  const statementIndexes = new Map<string, number>();
  const statementSources = new Map<string, string>();
  for (const statement of input.statementRecords ?? []) {
    const id = text(statement.statement_id);
    const index = integer(statement.statement_index) ?? statementIndexFromId(id);
    const source = canonicalSqlSourceId(
      text(statement.sql_source_id) ?? text(statement.sqlSourceId) ?? text(statement.source_id) ?? id ?? "unknown",
    );
    if (id && index !== null) {
      statementIndexes.set(id, index);
      statementSources.set(id, source);
    }
  }
  const rowStatementIndex = (row: JsonRecord): number | null => {
    const relation = relationOf(row);
    const explicit = integer(row.statement_index) ?? integer(relation.statement_index);
    if (explicit !== null) return explicit;
    const ids = [
      text(row.statement_id),
      text(relation.statement_id),
      relationId(row),
      readOccurrenceId(row),
    ].filter((value): value is string => value !== null);
    for (const id of ids) {
      const fromRecord = statementIndexes.get(id);
      if (fromRecord !== undefined) return fromRecord;
      const fromId = statementIndexFromId(id);
      if (fromId !== null) return fromId;
    }
    return null;
  };
  const rowSourceId = (row: JsonRecord): string => {
    const relation = relationOf(row);
    const candidates = [
      text(row.sql_source_id),
      text(row.sqlSourceId),
      text(relation.sql_source_id),
      text(relation.sqlSourceId),
      text(row.statement_id),
      text(relation.statement_id),
      relationId(row),
      readOccurrenceId(row),
    ].filter((value): value is string => value !== null);
    for (const value of candidates) {
      const mapped = statementSources.get(value);
      if (mapped) return mapped;
      return sourceIdFromId(value) ?? "unknown";
    }
    return "unknown";
  };
  const requestedSourceId = input.sqlSourceId ? canonicalSqlSourceId(input.sqlSourceId) : null;
  const requestedStatementIndex = input.statementIndex ?? null;
  const allRows = input.relationRecords.filter((row) => {
    if (text(row.task_id) !== null && text(row.task_id) !== input.taskId) return false;
    if (requestedStatementIndex !== null && rowStatementIndex(row) !== requestedStatementIndex) return false;
    return requestedSourceId === null || rowSourceId(row) === requestedSourceId;
  });
  const allRowIds = new Set(allRows.map(relationId).filter((value): value is string => value !== null));
  const allEdges = (input.relationEdgeRecords ?? []).filter((edge) => {
    const from = text(edge.from_relation_id);
    const to = text(edge.to_relation_id);
    return from !== null && to !== null && allRowIds.has(from) && allRowIds.has(to);
  });
  const childrenByParent = new Map<string, string[]>();
  for (const edge of allEdges) {
    const to = text(edge.to_relation_id);
    const from = text(edge.from_relation_id);
    if (!to || !from) continue;
    const children = childrenByParent.get(to) ?? [];
    children.push(from);
    childrenByParent.set(to, children);
  }
  const requestedRoot = input.rootRelationId ?? null;
  const selectedRows = requestedRoot === null || allRowIds.has(requestedRoot)
    ? (() => {
        if (requestedRoot === null) return allRows;
        const subtree = new Set<string>();
        const pending = [requestedRoot];
        while (pending.length > 0) {
          const id = pending.pop()!;
          if (subtree.has(id)) continue;
          subtree.add(id);
          pending.push(...(childrenByParent.get(id) ?? []));
        }
        return allRows.filter((row) => {
          const id = relationId(row);
          return id !== null && subtree.has(id);
        });
      })()
    : [];
  const rows = selectedRows;
  const rowIds = new Set(rows.map(relationId).filter((value): value is string => value !== null));
  const edges = allEdges.filter((edge) => {
    const from = text(edge.from_relation_id);
    const to = text(edge.to_relation_id);
    return from !== null && to !== null && rowIds.has(from) && rowIds.has(to);
  });
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const to = text(edge.to_relation_id);
    const from = text(edge.from_relation_id);
    if (!to || !from) continue;
    const values = incoming.get(to) ?? [];
    values.push(from);
    incoming.set(to, values);
  }
  const rowsById = new Map<string, JsonRecord>();
  for (const row of rows) {
    const id = relationId(row);
    if (id) rowsById.set(id, row);
  }
  const descendantReads = (id: string, seen = new Set<string>()): readonly string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const row = rowsById.get(id);
    if (row && relationType(row) === "read") return [readOccurrenceId(row) ?? id];
    return sorted((incoming.get(id) ?? []).flatMap((sourceId) => descendantReads(sourceId, seen)));
  };
  const readTables = new Map<string, string>();
  for (const row of rows) {
    if (relationType(row) !== "read") continue;
    const id = readOccurrenceId(row);
    const table = text(relationOf(row).table);
    if (id && table) {
      readTables.set(id, qualifyBareTableName(table, input.defaultSchema ?? null));
    }
  }
  const readImpacts = new Map<string, { channels: Set<ImpactChannel>; transferKinds: Set<LocalTransferKind>; demandedFields: Set<string>; refs: Set<string>; gaps: Set<string> }>();
  const gaps = new Set<string>();
  const relationIds = rows.map(relationId).filter((value): value is string => value !== null);
  const relationIdsInEdges = new Set(edges.flatMap((edge) => [
    text(edge.from_relation_id),
  ].filter((value): value is string => value !== null)));
  const explicitRoots = relationIds
    .filter((value) => /:relation:root(?:\.project|$)/i.test(value))
    .sort((left, right) => left.localeCompare(right));
  const graphRoots = relationIds
    .filter((value) => !relationIdsInEdges.has(value))
    .filter((value) => {
      const row = rowsById.get(value);
      return row && relationType(row) !== "read";
    })
    .sort((left, right) => left.localeCompare(right));
  const rootRelationId = requestedRoot ?? explicitRoots[0] ?? (graphRoots.length === 1 ? graphRoots[0]! : null);
  if (requestedRoot !== null && !allRowIds.has(requestedRoot)) gaps.add(`relation-summary-gap:${input.taskId}:ROOT_RELATION_NOT_FOUND`);
  let statementIndex = requestedStatementIndex ?? 0;
  const sqlSourceId = requestedSourceId ?? rowSourceId(rows[0] ?? {});
  if (sqlSourceId === "unknown") gaps.add(`relation-summary-gap:${input.taskId}:SQL_SOURCE_ID_UNRESOLVED`);
  for (const row of rows) {
    const id = relationId(row);
    const type = relationType(row);
    if (!id || !type) {
      gaps.add(`relation-summary-gap:${input.taskId}:RELATION_IDENTITY_UNRESOLVED`);
      continue;
    }
    const statementId = text(row.statement_id);
    const match = statementId?.match(/statement:(\d+)/i);
    if (match) statementIndex = Number(match[1]);
    if (type === "read" || childRelationIds(row).length > 0 || incoming.has(id)) {
      const descendants = type === "read" ? [readOccurrenceId(row) ?? id] : descendantReads(id);
      const columnTables = physicalColumnTables(row);
      const shouldRestrictToColumns = type === "filter" || type === "having" || type === "qualify" || type === "join" || type === "project";
      const restrict = (readIds: readonly string[]): readonly string[] =>
        shouldRestrictToColumns && columnTables.length > 0
          ? readIds.filter((readId) => {
              const table = readTables.get(readId);
              return table !== undefined && columnTables.some((columnTable) => tableMatches(table, columnTable));
            })
          : readIds;
      const apply = (
        readIds: readonly string[],
        channels: readonly ImpactChannel[],
        demandedNames: readonly string[] = operatorDemandColumns(row),
      ): void => {
        if (channels.length === 0) return;
        const demanded = demandedNames;
        const transfers = localTransferKinds(row, channels);
        for (const readId of restrict(readIds)) {
          const current = readImpacts.get(readId) ?? { channels: new Set<ImpactChannel>(), transferKinds: new Set<LocalTransferKind>(), demandedFields: new Set<string>(), refs: new Set<string>(), gaps: new Set<string>() };
          for (const channel of channels) current.channels.add(channel);
          for (const transferKind of transfers) current.transferKinds.add(transferKind);
          for (const fieldName of demanded) current.demandedFields.add(fieldName);
          current.refs.add(`machine-facts:${input.taskId}:relation:${id}`);
          if (hasUnsupportedShape(row)) {
            const gap = `relation-summary-gap:${input.taskId}:${id}:UNSUPPORTED_OPERATOR`;
            current.gaps.add(gap);
            gaps.add(gap);
          }
          for (const sourceId of sourceRelationIds(row, incoming)) current.refs.add(`machine-facts:${input.taskId}:relation:${sourceId}`);
          readImpacts.set(readId, current);
        }
      };
      const relation = relationOf(row);
      const leftId = text(relation.left);
      const rightId = text(relation.right);
      if (type === "join" && leftId && rightId) {
        const sides = joinSideChannels(text(relation.join_type) ?? "INNER");
        apply(descendantReads(leftId), sides.left);
        apply(descendantReads(rightId), sides.right);
      } else if (type === "project") {
        apply(descendants, impactChannels(row).filter((channel) => channel !== "EXPRESSION_CONTROL"));
      } else {
        apply(descendants, impactChannels(row));
      }
    }
    if (hasUnsupportedShape(row)) gaps.add(`relation-summary-gap:${input.taskId}:${id}:UNSUPPORTED_OPERATOR`);
  }
  const statementRows = (input.statementRecords ?? []).filter((row) => {
    if (requestedStatementIndex !== null && rowStatementIndex(row) !== requestedStatementIndex) return false;
    return requestedSourceId === null || canonicalSqlSourceId(text(row.sql_source_id) ?? text(row.sqlSourceId) ?? text(row.source_id) ?? text(row.statement_id) ?? "unknown") === requestedSourceId;
  });
  const statementGaps = statementRows.flatMap((row) => {
    const status = text(row.parse_status);
    return status && status !== "SUCCESS"
      ? [`relation-summary-gap:${input.taskId}:PARSE_${status}`]
      : [];
  });
  for (const gap of statementGaps) gaps.add(gap);
  const normalized = [...readImpacts.entries()].map(([readOccurrenceId, value]) => ({
    readOccurrenceId,
    impactChannels: [...value.channels].sort(),
    localTransferKinds: [...value.transferKinds].sort(),
    demandedFieldNames: [...value.demandedFields].sort(),
    evidenceRefs: sorted([...value.refs]),
    gaps: sorted([...value.gaps]),
  })).sort((a, b) => a.readOccurrenceId.localeCompare(b.readOccurrenceId));
  const digestInput = { taskId: input.taskId, sqlSourceId, statementIndex, rootRelationId, normalized, relationCount: rows.length, edgeCount: edges.length };
  return {
    taskId: input.taskId,
    sqlSourceId,
    statementIndex,
    rootRelationId,
    digest: sha256(canonicalJson(digestInput)),
    complete: gaps.size === 0,
    readImpacts: normalized,
    relationCount: rows.length,
    readCount: rows.filter((row) => relationType(row) === "read").length,
    edgeCount: edges.length,
    gaps: sorted([...gaps]),
  };
}
