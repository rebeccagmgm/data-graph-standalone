import { expandPartitionAlternatives, type PartitionAlternative } from "../../../../scripts/project-graph/task-local/partition-alternatives.ts";

export interface ConsumptionScopeItem {
  readonly mayBeNull?: boolean;
  readonly column: string;
  readonly values: string[];
  readonly valueStatus?: string;
  readonly expression?: string;
  readonly partitionStatus?: string;
}

export interface ConsumptionScope {
  /** TABLE_LEVEL says only that no partition limiter was recorded. */
  readonly status: "EXPLICIT" | "PARTIAL" | "TABLE_LEVEL" | "UNKNOWN";
  readonly label: string;
  readonly items: ConsumptionScopeItem[];
  readonly matchStatus?: string;
  readonly unknownCount?: number;
  /** Canonical alternatives preserve correlations such as (date, grp). */
  readonly ranges?: ConsumptionScopeItem[][];
  /** Unknown alternatives stay separate from known or partially known ranges. */
  readonly unprovenRanges?: ConsumptionScopeItem[][];
  readonly includesTableLevel?: boolean;
  readonly nonPartitioned?: boolean;
  readonly unrestrictedRead?: boolean;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const isKnownItem = (item: ConsumptionScopeItem) =>
  (item.values.length > 0 || Boolean(item.expression)) &&
  item.partitionStatus !== "UNKNOWN" &&
  item.valueStatus !== "UNKNOWN";

const itemIdentity = (item: ConsumptionScopeItem) =>
  JSON.stringify({
    column: item.column.toLowerCase(),
    values: [...item.values].sort(),
    expression: item.expression,
    valueStatus: item.valueStatus,
    partitionStatus: item.partitionStatus,
    ...(item.mayBeNull ? { mayBeNull: true } : {}),
  });

const normalizeItems = (items: readonly ConsumptionScopeItem[]) =>
  [...new Map(items.map((item) => [itemIdentity(item), item])).values()].sort(
    (left, right) => itemIdentity(left).localeCompare(itemIdentity(right)),
  );

const rangeIdentity = (items: readonly ConsumptionScopeItem[]) =>
  JSON.stringify(normalizeItems(items).map((item) => JSON.parse(itemIdentity(item))));

function scopeParts(scope: ConsumptionScope) {
  const ranges = scope.ranges?.length
    ? scope.ranges
    : scope.status === "EXPLICIT" || scope.status === "PARTIAL"
      ? [scope.items]
      : [];
  const unprovenRanges = scope.unprovenRanges?.length
    ? scope.unprovenRanges
    : scope.status === "UNKNOWN"
      ? [scope.items]
      : [];
  return {
    ranges: new Map(
      ranges.map((range) => [rangeIdentity(range), normalizeItems(range)]),
    ),
    unprovenRanges: new Map(
      unprovenRanges.map((range) => [rangeIdentity(range), normalizeItems(range)]),
    ),
    includesTableLevel:
      scope.includesTableLevel === true || scope.status === "TABLE_LEVEL",
    allConfirmed: scope.matchStatus === "CONFIRMED",
  };
}

const knownItemLabel = (item: ConsumptionScopeItem) =>
  `${item.column}=${item.values.length ? item.values.join("/") : item.expression}${item.mayBeNull ? "（可能含 NULL）" : ""}`;

export function consumptionScopeFromDetail(
  detail: Record<string, unknown> | undefined,
): ConsumptionScope {
  const raw = Array.isArray(detail?.partition) ? detail.partition
    : Array.isArray(detail?.partitionPredicates) ? detail.partitionPredicates : [];
  if (raw.some(item => item?.alternatives !== undefined)) {
    const ranges = expandPartitionAlternatives(raw as Array<ConsumptionScopeItem & { alternatives?: PartitionAlternative[] }>);
    if (!ranges) return { status: "UNKNOWN", label: "范围组合无效", items: [], unknownCount: 1 };
    return mergeConsumptionScopes(ranges.map(partition => consumptionScopeFromDetail({ ...detail, partition })));
  }
  const items = normalizeItems(
    raw
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object",
      )
      .map((item): ConsumptionScopeItem | undefined => {
        const column = text(item.column);
        if (!column) return undefined;
        const values = Array.isArray(item.values)
          ? item.values
              .map(String)
              .map((value) => value.trim())
              .filter(Boolean)
              .sort()
          : [];
        return {
          column,
          values,
          ...(item.mayBeNull === true ? { mayBeNull: true } : {}),
          ...(text(item.valueStatus)
            ? { valueStatus: text(item.valueStatus) }
            : {}),
          ...(text(item.expression)
            ? { expression: text(item.expression) }
            : {}),
          ...(text(item.partitionStatus)
            ? { partitionStatus: text(item.partitionStatus) }
            : {}),
        };
      })
      .filter((item): item is ConsumptionScopeItem => Boolean(item)),
  );
  const matchStatus = text(detail?.partitionMatchStatus);
  if (!items.length) {
    if (detail?.partitionPredicateStatus === "NONE") return {
      status: "TABLE_LEVEL", label: "读取未限定分区", items: [], includesTableLevel: true, unrestrictedRead: true,
    };
    if (detail?.partitionStatus === "NON_PARTITIONED") return {
      status: "TABLE_LEVEL", label: "非分区表", items: [], includesTableLevel: true, nonPartitioned: true,
      ...(matchStatus ? { matchStatus } : {}),
    };
    if (matchStatus === "CONFIRMED")
      return {
        status: "TABLE_LEVEL",
        label: "表级接续（未记录分区限定）",
        items: [],
        matchStatus,
        includesTableLevel: true,
      };
    return {
      status: "UNKNOWN",
      label: "范围未证明",
      items: [],
      ...(matchStatus ? { matchStatus } : {}),
      unknownCount: 1,
      unprovenRanges: [[]],
    };
  }
  const knownItems = items.filter(isKnownItem);
  const unknownCount = items.length - knownItems.length;
  if (!knownItems.length)
    return {
      status: "UNKNOWN",
      label: "范围未证明",
      items,
      ...(matchStatus ? { matchStatus } : {}),
      unknownCount: 1,
      unprovenRanges: [items],
    };
  const knownLabel = knownItems.map(knownItemLabel).join(" · ");
  if (unknownCount)
    return {
      status: "PARTIAL",
      label: `${knownLabel} · ${unknownCount} 项未证明`,
      items,
      ...(matchStatus ? { matchStatus } : {}),
      unknownCount,
      ranges: [items],
    };
  return {
    status: "EXPLICIT",
    label: knownLabel,
    items,
    ...(matchStatus ? { matchStatus } : {}),
    ranges: [items],
  };
}

export function consumptionScopeIdentity(scope: ConsumptionScope) {
  const parts = scopeParts(scope);
  return JSON.stringify({
    ranges: [...parts.ranges.keys()].sort(),
    unprovenRanges: [...parts.unprovenRanges.keys()].sort(),
    includesTableLevel: parts.includesTableLevel,
  });
}

export function mergeConsumptionScopes(
  scopes: readonly ConsumptionScope[],
): ConsumptionScope {
  if (!scopes.length) return consumptionScopeFromDetail(undefined);
  const ranges = new Map<string, ConsumptionScopeItem[]>();
  const unprovenRanges = new Map<string, ConsumptionScopeItem[]>();
  let includesTableLevel = false;
  let allConfirmed = true;
  for (const scope of scopes) {
    const parts = scopeParts(scope);
    for (const [key, range] of parts.ranges) ranges.set(key, range);
    for (const [key, range] of parts.unprovenRanges)
      unprovenRanges.set(key, range);
    includesTableLevel ||= parts.includesTableLevel;
    allConfirmed &&= parts.allConfirmed;
  }
  const orderedRanges = [...ranges.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, range]) => range);
  const orderedUnproven = [...unprovenRanges.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, range]) => range);
  const partialItemCount = orderedRanges.reduce(
    (count, range) => count + range.filter((item) => !isKnownItem(item)).length,
    0,
  );
  const unknownCount =
    partialItemCount + orderedUnproven.length + (includesTableLevel ? 1 : 0);
  const items = normalizeItems([
    ...orderedRanges.flat(),
    ...orderedUnproven.flat(),
  ]);
  const common = {
    items,
    ...(orderedRanges.length ? { ranges: orderedRanges } : {}),
    ...(orderedUnproven.length
      ? { unprovenRanges: orderedUnproven }
      : {}),
    ...(includesTableLevel ? { includesTableLevel: true } : {}),
  };
  if (orderedRanges.length && unknownCount)
    return {
      status: "PARTIAL",
      label: `${orderedRanges.length} 个已知或部分已知范围 + ${unknownCount} 项未证明`,
      ...common,
      unknownCount,
    };
  if (orderedRanges.length) {
    const sole = orderedRanges.length === 1 ? orderedRanges[0]! : undefined;
    const label = sole
      ? sole.filter(isKnownItem).map(knownItemLabel).join(" · ")
      : `共同消费 ${orderedRanges.length} 个范围`;
    return {
      status: "EXPLICIT",
      label,
      ...common,
      ...(allConfirmed ? { matchStatus: "CONFIRMED" } : {}),
    };
  }
  if (includesTableLevel && !orderedUnproven.length)
    return {
      status: "TABLE_LEVEL",
      label: scopes.every(scope => scope.nonPartitioned) ? "非分区表"
        : scopes.every(scope => scope.unrestrictedRead) ? "读取未限定分区" : "表级接续（未记录分区限定）",
      ...common,
      ...(scopes.every(scope => scope.nonPartitioned) ? { nonPartitioned: true } : {}),
      ...(scopes.every(scope => scope.unrestrictedRead) ? { unrestrictedRead: true } : {}),
      ...(allConfirmed ? { matchStatus: "CONFIRMED" } : {}),
    };
  return {
    status: "UNKNOWN",
    label: "范围未证明",
    ...common,
    unknownCount: Math.max(1, unknownCount),
  };
}
