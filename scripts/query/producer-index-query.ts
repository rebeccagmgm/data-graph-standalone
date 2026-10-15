import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import {
  classifyProducerWriteObservation,
  loadTableProducerIndex,
  type ConfirmedProducerEdge,
  type NonConfirmedRelation,
  type ProducerTableIdentity,
  type ProducerWriteObservation,
  type TableProducerIndex,
} from "../reconcile/producer/producer-index.ts";
import type {
  PartitionConstraintTree,
  ReadPartitionScope,
  ReadPartitionValue,
} from "../evidence/sql-read-scope.ts";
import {
  datePartitionValuesCompatible,
  isDatePartitionField,
  isDateRuntimeTemplate,
  isIsoDate,
  normalizePartitionToken,
} from "../evidence/partition-value-normalizer.ts";

export type PartitionQuery = Readonly<Record<string, string>>;

export interface ProducerTableQuery {
  readonly platform?: string;
  readonly dataSource?: string;
  readonly qualifiedName: string;
}

export interface ProducerIndexPartitionQueryOptions {
  readonly table: ProducerTableQuery;
  readonly partition?: PartitionQuery;
}

export interface ProducerIndexPartitionMatch {
  readonly taskId: string;
  readonly taskCategory: string;
  readonly table: ProducerTableIdentity;
  readonly writes: readonly ProducerWriteObservation[];
}

export type ProducerPartitionMatchStatus =
  | "PROVEN_OVERLAP"
  | "POSSIBLE_OVERLAP"
  | "PROVEN_DISJOINT"
  | "UNKNOWN";

export interface ProducerPartitionMatch {
  readonly taskId: string;
  readonly taskCategory: string;
  readonly table: ProducerTableIdentity;
  readonly writes: readonly ProducerWriteObservation[];
  readonly status: ProducerPartitionMatchStatus;
  readonly reasonCodes: readonly string[];
}

export interface ProducerTaskWriteLookup {
  readonly confirmedWrites: readonly ConfirmedProducerEdge[];
  readonly nonConfirmedRelations: readonly NonConfirmedRelation[];
}

interface ProducerIndexPartitionMatchOutput {
  readonly taskId: string;
  readonly taskCategory: string;
  readonly table: ProducerTableIdentity;
  readonly writes: readonly {
    readonly observationKind: ProducerWriteObservation["observationKind"];
    readonly sqlWriteKind: ProducerWriteObservation["sqlWriteKind"];
    readonly partition: ProducerWriteObservation["partition"];
    readonly partitionStatus: ProducerWriteObservation["partitionStatus"];
    readonly operationClass: ProducerWriteObservation["operationClass"];
    readonly dataPathRole: ProducerWriteObservation["dataPathRole"];
  }[];
}

function normalizeRuntimeExpression(value: string): string | null {
  const normalized = normalizePartitionToken(value);
  return normalized === "" || normalized === "unknown" ? null : normalized;
}

function isDateTemplate(value: string): boolean {
  return isDateRuntimeTemplate(value);
}

function tableIdentityKey(table: ProducerTableIdentity): string {
  return [table.platform, table.dataSource, table.qualifiedName]
    .map((value) =>
      String(value)
        .trim()
        .toLowerCase()
        .replaceAll("`", "")
        .replaceAll('"', ""),
    )
    .join("\u0000");
}

function normalizeTableQuery(table: ProducerTableQuery): ProducerTableQuery {
  return {
    qualifiedName: table.qualifiedName.trim().toLowerCase().replaceAll("`", ""),
    ...(table.platform === undefined
      ? {}
      : { platform: table.platform.trim().toLowerCase() }),
    ...(table.dataSource === undefined
      ? {}
      : { dataSource: table.dataSource.trim().toLowerCase() }),
  };
}

function normalizeProducerTable(
  table: ProducerTableIdentity,
): ProducerTableIdentity {
  return {
    platform: table.platform.trim().toLowerCase(),
    dataSource: table.dataSource.trim().toLowerCase(),
    qualifiedName: table.qualifiedName
      .trim()
      .toLowerCase()
      .replaceAll("`", "")
      .replaceAll('"', ""),
  };
}

interface ProducerIndexLookupCache {
  readonly confirmedByTable: ReadonlyMap<
    string,
    readonly ConfirmedProducerEdge[]
  >;
  readonly nonConfirmedByQualifiedName: ReadonlyMap<
    string,
    readonly NonConfirmedRelation[]
  >;
  readonly confirmedByTask: ReadonlyMap<
    string,
    readonly ConfirmedProducerEdge[]
  >;
  readonly nonConfirmedByTask: ReadonlyMap<
    string,
    readonly NonConfirmedRelation[]
  >;
}

const lookupCaches = new WeakMap<TableProducerIndex, ProducerIndexLookupCache>();

function appendToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function lookupCache(index: TableProducerIndex): ProducerIndexLookupCache {
  const cached = lookupCaches.get(index);
  if (cached) return cached;
  const confirmedByTable = new Map<string, ConfirmedProducerEdge[]>();
  const nonConfirmedByQualifiedName = new Map<string, NonConfirmedRelation[]>();
  const confirmedByTask = new Map<string, ConfirmedProducerEdge[]>();
  const nonConfirmedByTask = new Map<string, NonConfirmedRelation[]>();
  for (const edge of index.confirmedProducerEdges) {
    if (
      edge.writes.some(
        (write) =>
          (write.dataPathRole ??
            classifyProducerWriteObservation(write).dataPathRole) ===
          "PRODUCER",
      )
    )
      appendToMap(
        confirmedByTable,
        tableIdentityKey(normalizeProducerTable(edge.table)),
        edge,
      );
    appendToMap(confirmedByTask, edge.taskId, edge);
  }
  for (const relation of index.nonConfirmedRelations) {
    if (relation.tableRef.qualifiedName)
      appendToMap(
        nonConfirmedByQualifiedName,
        relation.tableRef.qualifiedName
          .trim()
          .toLowerCase()
          .replaceAll("`", "")
          .replaceAll('"', ""),
        relation,
      );
    appendToMap(nonConfirmedByTask, relation.taskId, relation);
  }
  const built = {
    confirmedByTable,
    nonConfirmedByQualifiedName,
    confirmedByTask,
    nonConfirmedByTask,
  };
  lookupCaches.set(index, built);
  return built;
}

export function lookupConfirmedProducers(
  index: TableProducerIndex,
  table: ProducerTableIdentity,
): readonly ConfirmedProducerEdge[] {
  const key = tableIdentityKey(normalizeProducerTable(table));
  return lookupCache(index).confirmedByTable.get(key) ?? [];
}

export function lookupNonConfirmedRelations(
  index: TableProducerIndex,
  table: ProducerTableIdentity,
): readonly NonConfirmedRelation[] {
  const normalized = normalizeProducerTable(table);
  return (
    lookupCache(index).nonConfirmedByQualifiedName.get(
      normalized.qualifiedName,
    ) ?? []
  ).filter((relation) => {
    const ref = relation.tableRef;
    return (
      ref.qualifiedName === normalized.qualifiedName &&
      (ref.platform === null || ref.platform === normalized.platform) &&
      (ref.dataSource === null || ref.dataSource === normalized.dataSource)
    );
  });
}

export function lookupProducerWritesByTask(
  index: TableProducerIndex,
  taskId: string,
): ProducerTaskWriteLookup {
  const cache = lookupCache(index);
  return {
    confirmedWrites: cache.confirmedByTask.get(taskId) ?? [],
    nonConfirmedRelations: cache.nonConfirmedByTask.get(taskId) ?? [],
  };
}

function resolveTableCandidates(
  index: TableProducerIndex,
  tableQuery: ProducerTableQuery,
): readonly ProducerTableIdentity[] {
  const query = normalizeTableQuery(tableQuery);
  const candidates = index.confirmedProducerEdges
    .map((edge) => edge.table)
    .filter(
      (table) =>
        table.qualifiedName.toLowerCase() === query.qualifiedName &&
        (query.platform === undefined ||
          table.platform.toLowerCase() === query.platform) &&
        (query.dataSource === undefined ||
          table.dataSource.toLowerCase() === query.dataSource),
    )
    .filter(
      (table, index, all) =>
        all.findIndex(
          (candidate) =>
            tableIdentityKey(candidate) === tableIdentityKey(table),
        ) === index,
    )
    .map((table) => ({
      platform: table.platform,
      dataSource: table.dataSource,
      qualifiedName: table.qualifiedName,
    }));
  return candidates;
}

function valueMatches(
  assignment: ProducerWriteObservation["partition"][number],
  wanted: string,
): boolean {
  const queryValue = wanted.trim();
  if (queryValue === "*") return true;

  const observedValue = assignment.observedValue;
  const expression = assignment.expression.trim();
  if (observedValue === "*" || expression === "*") return true;

  if (isDateTemplate(expression) && isIsoDate(queryValue)) return true;
  if (isDateTemplate(queryValue) && isDateTemplate(expression)) return true;

  if (observedValue !== null)
    return String(observedValue).trim() === queryValue;

  return expression === queryValue;
}

function partitionMatches(
  assignments: ProducerWriteObservation["partition"],
  partition: PartitionQuery | undefined,
): boolean {
  if (partition === undefined) return true;
  const byField = new Map(
    assignments.map((assignment) => [
      assignment.field.toLowerCase(),
      assignment,
    ]),
  );
  return Object.entries(partition).every(([field, wanted]) => {
    const assignment = byField.get(field.toLowerCase());
    return assignment !== undefined && valueMatches(assignment, String(wanted));
  });
}

type WriteMatchStatus = ProducerPartitionMatchStatus;

function compareLiteralValues(
  left: string,
  right: string,
): number | null {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber) &&
    left.trim() !== "" &&
    right.trim() !== ""
  )
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  if (/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/u.test(left) &&
      /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/u.test(right))
    return left === right ? 0 : left < right ? -1 : 1;
  return null;
}

function writeValue(
  assignment: ProducerWriteObservation["partition"][number],
): { readonly value: string; readonly dynamic: boolean } | null {
  const observed = assignment.observedValue;
  if (observed !== null) {
    const normalized = observed.trim();
    if (normalized === "*") return { value: normalized, dynamic: true };
    return { value: normalized, dynamic: false };
  }
  const expression = assignment.expression.trim();
  if (!expression) return null;
  if (expression === "*") return { value: expression, dynamic: true };
  return { value: expression, dynamic: true };
}

function runtimeExpressionsEqual(
  readValue: ReadPartitionValue,
  writeAssignment: ProducerWriteObservation["partition"][number],
): boolean {
  if (readValue.kind !== "RUNTIME_EXPRESSION") return false;
  const readExpression = normalizeRuntimeExpression(readValue.expression);
  const writeExpression = normalizeRuntimeExpression(
    writeAssignment.expression,
  );
  return readExpression !== null && readExpression === writeExpression;
}

function hasRuntimeDatePartition(
  write: ProducerWriteObservation,
): boolean {
  return write.partition.some(
    (assignment) =>
      isDatePartitionField(assignment.field) &&
      assignment.valueStatus === "RUNTIME_EXPRESSION" &&
      isDateTemplate(assignment.expression),
  );
}

function fieldsOfPartitionConstraint(
  tree: PartitionConstraintTree,
): readonly string[] {
  if (tree.kind === "ATOM") return [tree.field];
  return tree.children.flatMap(fieldsOfPartitionConstraint);
}

function readValueIsDynamic(value: ReadPartitionValue): boolean {
  return value.kind !== "LITERAL" || value.observedValue === null;
}

function matchAtom(
  tree: Extract<PartitionConstraintTree, { kind: "ATOM" }>,
  write: ProducerWriteObservation,
): { status: WriteMatchStatus; reasonCodes: readonly string[] } {
  if (
    write.partitionStatus !== undefined &&
    !["COMPLETE", "NOT_PARTITIONED"].includes(write.partitionStatus)
  )
    return {
      status: "UNKNOWN",
      reasonCodes: [
        "WRITE_PARTITION_EVIDENCE_INCOMPLETE",
        ...(write.partitionReasonCodes ?? []),
      ],
    };
  const assignment = write.partition.find(
    (item) => item.field.toLowerCase() === tree.field.toLowerCase(),
  );
  if (!assignment)
    return {
      status: "UNKNOWN",
      reasonCodes: ["WRITE_PARTITION_FIELD_MISSING"],
    };
  const actual = writeValue(assignment);
  if (!actual)
    return {
      status: "UNKNOWN",
      reasonCodes: ["WRITE_PARTITION_VALUE_UNKNOWN"],
    };
  const values = tree.values;
  if (actual.dynamic) {
    if (
      isDatePartitionField(tree.field) &&
      values.length > 0 &&
      values.every((value) => value.kind === "LITERAL" && value.observedValue !== null && isIsoDate(value.observedValue))
    )
      return {
        status: "PROVEN_OVERLAP",
        reasonCodes: ["DATE_PARTITION_DEFAULTED"],
      };
    if (values.length === 1 && runtimeExpressionsEqual(values[0]!, assignment))
      return {
        status: "PROVEN_OVERLAP",
        reasonCodes: ["PARTITION_RUNTIME_TEMPLATE_EQUAL"],
      };
    return {
      status: "POSSIBLE_OVERLAP",
      reasonCodes: ["WRITE_PARTITION_RUNTIME_EXPRESSION"],
    };
  }
  if (values.some(readValueIsDynamic))
    return {
      status: "POSSIBLE_OVERLAP",
      reasonCodes: ["READ_PARTITION_RUNTIME_EXPRESSION"],
    };
  const literals = values.map((value) => value.observedValue!);
  if (tree.operator === "EQ" || tree.operator === "IN") {
    return literals.includes(actual.value)
      ? { status: "PROVEN_OVERLAP", reasonCodes: [] }
      : { status: "PROVEN_DISJOINT", reasonCodes: ["PARTITION_VALUE_DISJOINT"] };
  }
  if (tree.operator === "BETWEEN" && literals.length === 2) {
    const lower = compareLiteralValues(actual.value, literals[0]!);
    const upper = compareLiteralValues(actual.value, literals[1]!);
    if (lower === null || upper === null)
      return {
        status: "UNKNOWN",
        reasonCodes: ["PARTITION_RANGE_COMPARISON_UNSUPPORTED"],
      };
    return lower >= 0 && upper <= 0
      ? { status: "PROVEN_OVERLAP", reasonCodes: [] }
      : { status: "PROVEN_DISJOINT", reasonCodes: ["PARTITION_RANGE_DISJOINT"] };
  }
  if (literals.length !== 1)
    return {
      status: "UNKNOWN",
      reasonCodes: ["PARTITION_PREDICATE_FORM_UNSUPPORTED"],
    };
  const comparison = compareLiteralValues(actual.value, literals[0]!);
  if (comparison === null)
    return {
      status: "UNKNOWN",
      reasonCodes: ["PARTITION_RANGE_COMPARISON_UNSUPPORTED"],
    };
  const proven =
    tree.operator === "LT"
      ? comparison < 0
      : tree.operator === "LTE"
        ? comparison <= 0
        : tree.operator === "GT"
          ? comparison > 0
          : tree.operator === "GTE"
            ? comparison >= 0
            : false;
  return proven
    ? { status: "PROVEN_OVERLAP", reasonCodes: [] }
    : { status: "PROVEN_DISJOINT", reasonCodes: ["PARTITION_RANGE_DISJOINT"] };
}

function combineWriteMatches(
  kind: "AND" | "OR",
  children: readonly { status: WriteMatchStatus; reasonCodes: readonly string[] }[],
): { status: WriteMatchStatus; reasonCodes: readonly string[] } {
  const reasonCodes = [
    ...new Set(children.flatMap((child) => child.reasonCodes)),
  ].sort();
  if (kind === "AND") {
    if (children.some((child) => child.status === "PROVEN_DISJOINT"))
      return { status: "PROVEN_DISJOINT", reasonCodes };
    if (children.some((child) => child.status === "UNKNOWN"))
      return { status: "UNKNOWN", reasonCodes };
    if (children.some((child) => child.status === "POSSIBLE_OVERLAP"))
      return { status: "POSSIBLE_OVERLAP", reasonCodes };
    return { status: "PROVEN_OVERLAP", reasonCodes };
  }
  if (children.some((child) => child.status === "PROVEN_OVERLAP"))
    return { status: "PROVEN_OVERLAP", reasonCodes };
  if (children.every((child) => child.status === "PROVEN_DISJOINT"))
    return { status: "PROVEN_DISJOINT", reasonCodes };
  if (children.some((child) => child.status === "POSSIBLE_OVERLAP"))
    return { status: "POSSIBLE_OVERLAP", reasonCodes };
  return { status: "UNKNOWN", reasonCodes };
}

function combinePartialReadMatches(
  matches: readonly { status: WriteMatchStatus; reasonCodes: readonly string[] }[],
  readReasons: readonly string[],
): { status: WriteMatchStatus; reasonCodes: readonly string[] } {
  const reasonCodes = [
    ...new Set([...readReasons, ...matches.flatMap((match) => match.reasonCodes)]),
  ].sort();
  if (matches.some((match) => match.status === "PROVEN_OVERLAP"))
    return { status: "PROVEN_OVERLAP", reasonCodes };
  if (matches.some((match) => match.status === "POSSIBLE_OVERLAP"))
    return { status: "POSSIBLE_OVERLAP", reasonCodes };
  if (matches.every((match) => match.status === "PROVEN_DISJOINT"))
    return { status: "PROVEN_DISJOINT", reasonCodes };
  return { status: "UNKNOWN", reasonCodes };
}

function retainCandidateOnUncertainMatch(
  match: { status: WriteMatchStatus; reasonCodes: readonly string[] },
): { status: WriteMatchStatus; reasonCodes: readonly string[] } {
  if (match.status === "PROVEN_DISJOINT") return match;
  return match;
}

function matchConstraint(
  tree: PartitionConstraintTree,
  write: ProducerWriteObservation,
): { status: WriteMatchStatus; reasonCodes: readonly string[] } {
  if (tree.kind === "ATOM") return matchAtom(tree, write);
  return combineWriteMatches(
    tree.kind,
    tree.children.map((child) => matchConstraint(child, write)),
  );
}

export function matchProducersByReadScopeFromEdges(
  edges: readonly ConfirmedProducerEdge[],
  readScope: ReadPartitionScope,
): readonly ProducerPartitionMatch[] {
  return edges
    .map((edge) => {
      const producerWrites = edge.writes.filter(
        (write) =>
          (write.dataPathRole ?? classifyProducerWriteObservation(write).dataPathRole) ===
          "PRODUCER",
      );
      if (
        readScope.status === "UNPARTITIONED" ||
        readScope.status === "ALL_PARTITIONS"
      )
        return {
          taskId: edge.taskId,
          taskCategory: edge.taskCategory,
          table: edge.table,
          writes: producerWrites,
          status: "PROVEN_OVERLAP" as const,
          reasonCodes: producerWrites.some(hasRuntimeDatePartition)
            ? ["DATE_PARTITION_DEFAULTED"]
            : [],
        };
      if (readScope.status === "UNKNOWN" && !readScope.predicate)
        return {
          taskId: edge.taskId,
          taskCategory: edge.taskCategory,
          table: edge.table,
          writes: producerWrites,
          status: "UNKNOWN" as const,
          reasonCodes: [...readScope.reasonCodes, "READ_PARTITION_SCOPE_INCOMPLETE"],
        };
      if (
        readScope.status === "CONSTRAINED" &&
        readScope.predicate &&
        producerWrites.some(hasRuntimeDatePartition)
      ) {
        const constrainedFields = new Set(
          fieldsOfPartitionConstraint(readScope.predicate),
        );
        if (![...constrainedFields].some(isDatePartitionField))
          return {
            taskId: edge.taskId,
            taskCategory: edge.taskCategory,
            table: edge.table,
            writes: producerWrites,
            status: "PROVEN_OVERLAP" as const,
            reasonCodes: ["DATE_PARTITION_DEFAULTED"],
          };
      }
      if (!readScope.predicate)
        return {
          taskId: edge.taskId,
          taskCategory: edge.taskCategory,
          table: edge.table,
          writes: producerWrites,
          status: "UNKNOWN" as const,
          reasonCodes: ["READ_PARTITION_PREDICATE_MISSING"],
        };
      const matches = producerWrites.map((write) =>
        matchConstraint(readScope.predicate!, write),
      );
      const combined =
        readScope.status === "PARTIAL"
          ? combinePartialReadMatches(matches, readScope.reasonCodes)
          : combineWriteMatches("OR", matches);
      return {
        taskId: edge.taskId,
        taskCategory: edge.taskCategory,
        table: edge.table,
        writes: producerWrites,
        status: combined.status,
        reasonCodes: combined.reasonCodes,
      };
    })
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

export function matchProducersByReadScope(
  index: TableProducerIndex,
  table: ProducerTableIdentity,
  readScope: ReadPartitionScope,
): readonly ProducerPartitionMatch[] {
  return matchProducersByReadScopeFromEdges(
    lookupConfirmedProducers(index, table),
    readScope,
  );
}

export function lookupProducersByTablePartition(
  index: TableProducerIndex,
  options: ProducerIndexPartitionQueryOptions,
): readonly ProducerIndexPartitionMatch[] {
  const matches: ProducerIndexPartitionMatch[] = [];
  const candidates = resolveTableCandidates(index, options.table);
  if (candidates.length === 0) return matches;
  for (const edge of index.confirmedProducerEdges) {
    if (
      !candidates.some(
        (candidate) =>
          tableIdentityKey(edge.table) === tableIdentityKey(candidate),
      )
    )
      continue;
    const writes = edge.writes.filter((write) =>
      partitionMatches(write.partition, options.partition),
    );
    if (writes.length === 0) continue;
    matches.push({
      taskId: edge.taskId,
      taskCategory: edge.taskCategory,
      table: {
        platform: edge.table.platform,
        dataSource: edge.table.dataSource,
        qualifiedName: edge.table.qualifiedName,
      },
      writes,
    });
  }
  return matches;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`missing required option ${name}`);
  return value;
}

function parsePartition(value: string): PartitionQuery {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("partition must not be empty");

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("partition JSON must be an object");
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([field, item]) => [
        field,
        String(item),
      ]),
    );
  }

  const entries = trimmed.split(",").map((item) => item.trim());
  const partition: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0)
      throw new Error(`invalid partition entry ${entry}; expected field=value`);
    const field = entry.slice(0, separator).trim();
    const fieldValue = entry.slice(separator + 1).trim();
    if (!field || !fieldValue)
      throw new Error(`invalid partition entry ${entry}`);
    partition[field] = fieldValue;
  }
  return partition;
}

function main(): void {
  const args = process.argv.slice(2);
  const indexPath = requiredOption(args, "--index");
  const partitionValue = option(args, "--partition");
  const index = loadTableProducerIndex(
    isAbsolute(indexPath) ? indexPath : resolve(indexPath),
  );
  const options: ProducerIndexPartitionQueryOptions = {
    table: {
      qualifiedName: requiredOption(args, "--table"),
      ...(option(args, "--platform") === undefined
        ? {}
        : { platform: option(args, "--platform") }),
      ...(option(args, "--data-source") === undefined
        ? {}
        : { dataSource: option(args, "--data-source") }),
    },
    ...(partitionValue === undefined
      ? {}
      : { partition: parsePartition(partitionValue) }),
  };
  const matches = lookupProducersByTablePartition(index, options);
  const output: ProducerIndexPartitionMatchOutput[] = matches.map((match) => ({
    taskId: match.taskId,
    taskCategory: match.taskCategory,
    table: match.table,
    writes: match.writes.map((write) => ({
      observationKind: write.observationKind,
      sqlWriteKind: write.sqlWriteKind,
      partition: write.partition,
      partitionStatus: write.partitionStatus,
      operationClass: write.operationClass,
      dataPathRole: write.dataPathRole,
    })),
  }));
  process.stdout.write(
    `${JSON.stringify(
      {
        indexContentHash: index.contentHash,
        table: options.table,
        ...(options.partition === undefined
          ? {}
          : { partition: options.partition }),
        matchCount: matches.length,
        tasks: output,
      },
      null,
      2,
    )}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  main();
