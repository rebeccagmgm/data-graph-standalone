type JsonRecord = Record<string, unknown>;

export interface MultiHopVizModel {
  readonly meta: JsonRecord;
  readonly lineageNodes: readonly JsonRecord[];
  readonly lineageEdges: readonly JsonRecord[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function tableOf(value: unknown): JsonRecord {
  return record(value);
}

function tableName(value: unknown): string {
  const table = tableOf(value);
  return text(table.qualifiedName);
}

function physicalKey(value: unknown): string {
  const table = tableOf(value);
  return [text(table.platform), text(table.dataSource), tableName(table)].join("|");
}

function taskId(value: unknown): string {
  return text(record(value).taskId);
}

function numberValue(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-Hans", { numeric: true, sensitivity: "base" }),
  );
}

function deduplicateRecords(values: readonly JsonRecord[]): JsonRecord[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function partitionRows(writes: readonly JsonRecord[]): JsonRecord[] {
  const rows = writes.flatMap((write) => {
    const status = text(write.partitionStatus) || "UNKNOWN";
    const assignments = Array.isArray(write.partition)
      ? write.partition.map((item) => record(item))
      : [];
    const values = assignments.map((assignment) => ({
      field: text(assignment.field),
      value: text(assignment.observedValue) || text(assignment.expression) || "UNKNOWN",
      valueStatus: text(assignment.valueStatus) || "UNKNOWN",
    }));
    const display =
      status === "NOT_PARTITIONED"
        ? "NOT_PARTITIONED"
        : values.length > 0
          ? values.map((item) => `${item.field}=${item.value}`).join(", ")
          : status;
    return [
      {
        status,
        display,
        values,
        reasonCodes: Array.isArray(write.partitionReasonCodes)
          ? write.partitionReasonCodes
          : [],
        operationClass: text(write.sqlWriteKind) || text(write.operationClass),
        evidenceRefs: evidenceRefs(write),
      },
    ];
  });
  const grouped = new Map<string, JsonRecord>();
  for (const row of rows) {
    const key = JSON.stringify({
      status: row.status,
      display: row.display,
      values: row.values,
      reasonCodes: row.reasonCodes,
      operationClass: row.operationClass,
    });
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, row);
      continue;
    }
    grouped.set(key, {
      ...existing,
      evidenceRefs: deduplicateRecords([
        ...(Array.isArray(existing.evidenceRefs) ? existing.evidenceRefs : []),
        ...(Array.isArray(row.evidenceRefs) ? row.evidenceRefs : []),
      ] as JsonRecord[]),
    });
  }
  return [...grouped.values()];
}

function tableRole(producerCount: number, consumerCount: number): string {
  if (producerCount > 0 && consumerCount > 0) return "BRIDGE";
  if (producerCount > 0) return "OUTPUT_ONLY";
  if (consumerCount > 0) return "SOURCE_ONLY";
  return "TABLE_ONLY";
}

function sortTaskIds(values: readonly string[]): string[] {
  return unique(values).sort((a, b) =>
    a.localeCompare(b, "zh-Hans", { numeric: true, sensitivity: "base" }),
  );
}

function evidenceRefs(value: unknown): JsonRecord[] {
  const source = record(value);
  return Array.isArray(source.evidence)
    ? source.evidence.map((item) => {
        const evidence = record(item);
        return {
          source: evidence.source,
          provider: evidence.provider,
          locator: evidence.locator,
          ...(evidence.contentHash === undefined
            ? {}
            : { contentHash: evidence.contentHash }),
          ...(evidence.sha256 === undefined ? {} : { sha256: evidence.sha256 }),
        };
      })
    : [];
}

export function buildMultiHopVizModel(artifact: JsonRecord): MultiHopVizModel {
  const rawTasks = Array.isArray(artifact.taskNodes)
    ? artifact.taskNodes.map((value) => record(value))
    : [];
  const rawTables = Array.isArray(artifact.tableNodes)
    ? artifact.tableNodes.map((value) => record(value))
    : [];
  const rawReads = Array.isArray(artifact.readEdges)
    ? artifact.readEdges.map((value) => record(value))
    : [];
  const rawWrites = Array.isArray(artifact.writeEdges)
    ? artifact.writeEdges.map((value) => record(value))
    : [];
  const rawBridges = Array.isArray(artifact.producerBridges)
    ? artifact.producerBridges.map((value) => record(value))
    : [];
  const rawTerminals = Array.isArray(artifact.terminals)
    ? artifact.terminals.map((value) => record(value))
    : [];

  const maxDepth = rawTasks.reduce(
    (max, task) => Math.max(max, numberValue(task.minDepth, 0)),
    0,
  );
  const taskRanks = new Map(
    rawTasks.map((task) => [taskId(task), maxDepth - numberValue(task.minDepth, 0)]),
  );
  const taskTerminalMap = new Map<string, JsonRecord[]>();
  const tableTerminalMap = new Map<string, JsonRecord[]>();
  for (const terminal of rawTerminals) {
    const list = taskTerminalMap.get(taskId(terminal)) ?? [];
    list.push(terminal);
    taskTerminalMap.set(taskId(terminal), list);
    const tableKey = physicalKey(terminal.table);
    if (tableKey.replace(/\|/g, "")) {
      const tableList = tableTerminalMap.get(tableKey) ?? [];
      tableList.push(terminal);
      tableTerminalMap.set(tableKey, tableList);
    }
  }

  const tableMap = new Map<string, JsonRecord>();
  const readMap = new Map<string, JsonRecord[]>();
  const writeMap = new Map<string, JsonRecord[]>();
  const bridgeMap = new Map<string, JsonRecord[]>();

  const addTable = (value: unknown): string => {
    const source = tableOf(value);
    const key = physicalKey(source);
    if (!tableMap.has(key)) tableMap.set(key, { ...source });
    return key;
  };
  for (const table of rawTables) addTable(table);
  for (const edge of rawReads) {
    const key = addTable(edge.table);
    const list = readMap.get(key) ?? [];
    list.push(edge);
    readMap.set(key, list);
  }
  for (const edge of rawWrites) {
    const key = addTable(edge.table);
    const list = writeMap.get(key) ?? [];
    list.push(edge);
    writeMap.set(key, list);
  }
  for (const bridge of rawBridges) {
    const key = addTable(bridge.table);
    const list = bridgeMap.get(key) ?? [];
    list.push(bridge);
    bridgeMap.set(key, list);
  }

  const tables: JsonRecord[] = [...tableMap.entries()]
    .map(([key, source]) => {
      const reads = readMap.get(key) ?? [];
      const writes = writeMap.get(key) ?? [];
      const bridges = bridgeMap.get(key) ?? [];
      const terminalReasons = unique(
        (tableTerminalMap.get(key) ?? []).map((item) => text(item.reason)),
      );
      const producerTaskIds = sortTaskIds(writes.map((edge) => text(edge.producerTaskId)));
      const consumerTaskIds = sortTaskIds(reads.map((edge) => text(edge.consumerTaskId)));
      const producerRanks = producerTaskIds
        .map((id) => taskRanks.get(id))
        .filter((value): value is number => value !== undefined);
      const consumerRanks = consumerTaskIds
        .map((id) => taskRanks.get(id))
        .filter((value): value is number => value !== undefined);
      const tableRank =
        producerRanks.length > 0 && consumerRanks.length > 0
          ? Math.max(Math.max(...producerRanks), Math.min(...consumerRanks) - 1)
          : consumerRanks.length > 0
            ? Math.max(0, Math.min(...consumerRanks) - 1)
            : producerRanks.length > 0
              ? Math.max(...producerRanks) + 1
              : 0;
      const producerGroups = producerTaskIds.map((id) => {
        const taskWrites = writes.filter((edge) => text(edge.producerTaskId) === id);
        return {
          taskId: id,
          writeCount: taskWrites.length,
          partitions: partitionRows(
            taskWrites.flatMap((edge) =>
              Array.isArray(edge.writes) ? edge.writes.map((value) => record(value)) : [],
            ),
          ),
          evidenceRefs: taskWrites.flatMap((edge) =>
            Array.isArray(edge.writes)
              ? edge.writes.flatMap((value) => evidenceRefs(record(value)))
              : [],
          ),
        };
      });
      const consumerGroups = consumerTaskIds.map((id) => {
        const taskReads = reads.filter((edge) => text(edge.consumerTaskId) === id);
        return {
          taskId: id,
          readCount: taskReads.length,
          recursionStatuses: unique(taskReads.map((edge) => text(edge.recursionStatus))),
          evidenceRefs: taskReads.flatMap((edge) => evidenceRefs(edge)),
        };
      });
      return {
        ...source,
        id: `table:${key}`,
        kind: "TABLE",
        role: tableRole(producerTaskIds.length, consumerTaskIds.length),
        layoutRank: tableRank,
        layoutColumn: tableRank * 2 + 1,
        producerTaskIds,
        consumerTaskIds,
        producerCount: producerTaskIds.length,
        consumerCount: consumerTaskIds.length,
        readCount: reads.length,
        writeCount: writes.length,
        bridgeCount: bridges.length,
        terminalReasons,
        terminalBoundary: terminalReasons.includes("REFERENCE_CONFIG")
          ? "REFERENCE_CONFIG"
          : null,
        producerGroups,
        consumerGroups,
        bridgeEvidence: bridges.map((bridge) => ({
          consumerTaskId: bridge.consumerTaskId,
          producerTaskId: bridge.producerTaskId,
          table: bridge.table,
          producerDepth: bridge.producerDepth,
        })),
      };
    })
    .sort((a, b) =>
      numberValue(a.layoutColumn, 0) - numberValue(b.layoutColumn, 0) ||
      text((a as JsonRecord).qualifiedName).localeCompare(
        text((b as JsonRecord).qualifiedName),
        "zh-Hans",
        {
        numeric: true,
        sensitivity: "base",
        },
      ),
    );

  const outputTableIdsByTask = new Map<string, string[]>();
  for (const write of rawWrites) {
    const id = text(write.producerTaskId);
    const tableId = `table:${physicalKey(write.table)}`;
    outputTableIdsByTask.set(
      id,
      unique([...(outputTableIdsByTask.get(id) ?? []), tableId]),
    );
  }
  const consumerTaskIds = unique([
    ...rawReads.map((edge) => text(edge.consumerTaskId)),
    ...rawBridges.map((edge) => text(edge.consumerTaskId)),
  ]);
  const fallbackTaskIds = consumerTaskIds.filter(
    (id) => (outputTableIdsByTask.get(id) ?? []).length === 0,
  );
  const taskDepths = new Map(
    rawTasks.map((task) => [taskId(task), numberValue(task.minDepth, 0)]),
  );
  const lineageNodes: JsonRecord[] = tables.map((table) => {
    const producers = Array.isArray(table.producerTaskIds)
      ? table.producerTaskIds.map((value) => text(value))
      : [];
    const consumers = Array.isArray(table.consumerTaskIds)
      ? table.consumerTaskIds.map((value) => text(value))
      : [];
    const bridgeConsumers = rawBridges
      .filter((bridge) => `table:${physicalKey(bridge.table)}` === text(table.id))
      .map((bridge) => text(bridge.consumerTaskId));
    const levels = [
      ...producers.map((id) => maxDepth - (taskDepths.get(id) ?? maxDepth) + 1),
      ...[...consumers, ...bridgeConsumers].map(
        (id) => maxDepth - (taskDepths.get(id) ?? maxDepth),
      ),
    ];
    const tableTerminalReasons = Array.isArray(table.terminalReasons)
      ? table.terminalReasons.map((reason) => text(reason))
      : [];
    return {
      id: table.id,
      kind: "LINEAGE_NODE",
      nodeType: "TABLE_TASK",
      qualifiedName: table.qualifiedName,
      platform: table.platform,
      dataSource: table.dataSource,
      layoutColumn: levels.length > 0 ? Math.max(...levels) : 0,
      producerTaskIds: table.producerTaskIds,
      producerGroups: table.producerGroups,
      terminalReasons: unique(
        [
          ...tableTerminalReasons,
          ...producers.flatMap((id) =>
            (taskTerminalMap.get(id) ?? []).map((terminal) => text(terminal.reason)),
          ),
        ],
      ),
      terminalBoundary: table.terminalBoundary,
    };
  });
  for (const id of fallbackTaskIds) {
    lineageNodes.push({
      id: `unknown-output:${id}`,
      kind: "LINEAGE_NODE",
      nodeType: "UNKNOWN_OUTPUT",
      qualifiedName: "产出表未确认",
      platform: "UNKNOWN",
      dataSource: "UNKNOWN",
      layoutColumn: maxDepth - (taskDepths.get(id) ?? 0) + 1,
      producerTaskIds: [id],
      producerGroups: [{ taskId: id, writeCount: 0, partitions: [] }],
      terminalReasons: (taskTerminalMap.get(id) ?? []).map((terminal) =>
        text(terminal.reason),
      ),
      evidenceBoundary: "NO_CONFIRMED_OUTPUT_TABLE",
    });
  }
  lineageNodes.sort(
    (a, b) =>
      numberValue(a.layoutColumn, 0) - numberValue(b.layoutColumn, 0) ||
      text(a.qualifiedName).localeCompare(text(b.qualifiedName), "zh-Hans", {
        numeric: true,
        sensitivity: "base",
      }),
  );

  const lineageEdgeMap = new Map<string, JsonRecord>();
  const addLineageEdge = (
    upstreamTable: unknown,
    consumerTaskId: string,
    evidenceKind: string,
  ): void => {
    const fromNodeId = `table:${physicalKey(upstreamTable)}`;
    const toNodeIds = outputTableIdsByTask.get(consumerTaskId) ?? [
      `unknown-output:${consumerTaskId}`,
    ];
    for (const toNodeId of toNodeIds) {
      const key = `${fromNodeId}|${toNodeId}|${consumerTaskId}`;
      const existing = lineageEdgeMap.get(key);
      lineageEdgeMap.set(key, {
        id: `lineage:${key}`,
        kind: "UPSTREAM_DEPENDENCY",
        fromNodeId,
        toNodeId,
        viaTaskId: consumerTaskId,
        isCycle: fromNodeId === toNodeId,
        evidenceKinds: unique([
          ...(Array.isArray(existing?.evidenceKinds)
            ? existing.evidenceKinds.map((value) => text(value))
            : []),
          evidenceKind,
        ]),
      });
    }
  };
  for (const read of rawReads)
    addLineageEdge(read.table, text(read.consumerTaskId), "TABLE_READ");
  for (const bridge of rawBridges)
    addLineageEdge(
      bridge.table,
      text(bridge.consumerTaskId),
      "PRODUCER_BRIDGE",
    );
  const lineageEdges = [...lineageEdgeMap.values()].sort((a, b) =>
    text(a.id).localeCompare(text(b.id), "zh-Hans", { numeric: true }),
  );

  return {
    meta: {
      artifactType: artifact.artifactType,
      rootTaskId: artifact.rootTaskId,
      generatedAt: artifact.generatedAt,
      coverage: artifact.coverage,
      limits: artifact.limits,
      counts: artifact.counts,
      boundaries: artifact.boundaries,
      contentHash: artifact.contentHash,
      maxDepth,
      direction: "UPSTREAM_TO_ROOT",
    },
    lineageNodes,
    lineageEdges,
  };
}
