import { snapshotVersion } from "./content.mjs";

const unique = (items) => [...new Set(items)].sort();
const schemaOf = (name) => name.split(".")[0];
const inRegion = (name) => schemaOf(name) === "pdata_n";
const collect = (map, key, taskId, name) => {
  if (!map.has(key))
    map.set(key, { schema: key, taskIds: new Set(), tables: new Set() });
  map.get(key).taskIds.add(taskId);
  map.get(key).tables.add(name);
};
const finish = (map) =>
  [...map.values()]
    .map((x) => ({
      ...x,
      taskIds: unique(x.taskIds),
      tables: unique(x.tables),
    }))
    .sort(
      (a, b) =>
        b.taskIds.length - a.taskIds.length || a.schema.localeCompare(b.schema),
    );

export function buildRegion(network, definitions) {
  if (network.version !== snapshotVersion)
    throw new Error(
      "PDATA_SNAPSHOT_CHANGED: review the authored content first",
    );
  const owner = new Map();
  for (const branch of definitions)
    for (const part of branch.parts)
      for (const name of part.tables) {
        if (owner.get(name)?.some((m) => m.branchId === branch.id))
          throw new Error(`DUPLICATE_PDATA_MEMBERSHIP: ${name}`);
        if (!owner.has(name)) owner.set(name, []);
        owner.get(name).push({ branchId: branch.id, partId: part.id });
      }
  const tableRows = network.tables.map((t) => ({
    id: t.id,
    name: t.table,
    readers: unique(t.readers),
    writers: unique(t.writers),
    branchId: null,
    partId: null,
    scope: !inRegion(t.table)
      ? "outside-region"
      : t.writers.length
        ? "output"
        : t.readers.length
          ? "read-only"
          : "unlinked",
    ...(t.writers.length && inRegion(t.table) ? owner.get(t.table)?.[0] : {}),
    memberships:
      t.writers.length && inRegion(t.table) ? (owner.get(t.table) ?? []) : [],
  }));
  const byName = new Map(tableRows.map((t) => [t.name, t]));
  const local = tableRows.filter((t) => inRegion(t.name));
  const outputs = local.filter((t) => t.writers.length);
  const outputNames = new Set(outputs.map((t) => t.name));
  const writers = network.tasks.filter((t) =>
    t.outputs.some((x) => inRegion(x.table)),
  );
  const writerIds = new Set(writers.map((t) => t.taskId));
  const readers = network.tasks.filter((t) =>
    t.inputs.some((x) => inRegion(x.table)),
  );
  const tasks = network.tasks.map((t) => ({
    id: t.taskId,
    name: t.name,
    category: t.category,
    coverage: t.coverage,
    inputs: unique(t.inputs.map((x) => x.table)),
    outputs: unique(t.outputs.map((x) => x.table)),
  }));
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const unassigned = outputs
    .filter((t) => !owner.has(t.name))
    .map((t) => t.name);
  const unknownDeclared = [...owner.keys()].filter(
    (name) => !outputNames.has(name),
  );
  if (unknownDeclared.length)
    throw new Error(`PDATA_MEMBER_NOT_OUTPUT: ${unknownDeclared.join(", ")}`);
  if (unassigned.length)
    throw new Error(`PDATA_OUTPUT_NOT_ASSIGNED: ${unassigned.join(", ")}`);
  const branches = definitions.map((branch) => {
    const names = branch.parts.flatMap((p) => p.tables);
    const taskIds = unique(names.flatMap((name) => byName.get(name).writers));
    const readerIds = unique(names.flatMap((name) => byName.get(name).readers));
    const inputs = new Map(),
      inputBranches = new Map(),
      downstream = new Map();
    for (const id of taskIds)
      for (const name of byTask.get(id).inputs) {
        const source = byName.get(name);
        for (const membership of source?.memberships ?? [])
          if (membership.branchId !== branch.id)
            collect(inputBranches, membership.branchId, id, name);
        if (!source?.branchId) collect(inputs, schemaOf(name), id, name);
      }
    for (const id of readerIds)
      for (const name of byTask.get(id).outputs) {
        if (!inRegion(name)) collect(downstream, schemaOf(name), id, name);
      }
    return {
      ...branch,
      tables: names,
      taskIds,
      readerIds,
      inputs: finish(inputs),
      inputBranches: finish(inputBranches),
      downstream: finish(downstream),
      parts: branch.parts.map((p) => ({
        ...p,
        taskIds: unique(p.tables.flatMap((name) => byName.get(name).writers)),
      })),
    };
  });
  const downstreamMap = new Map();
  for (const t of readers)
    for (const out of t.outputs.filter((x) => !inRegion(x.table)))
      collect(downstreamMap, schemaOf(out.table), t.taskId, out.table);
  const downstream = finish(downstreamMap).map((row) => ({
    ...row,
    fromOutputs: row.taskIds.filter((id) =>
      byTask.get(id).inputs.some((name) => outputNames.has(name)),
    ),
    boundaryOnly: row.taskIds.filter(
      (id) => !byTask.get(id).inputs.some((name) => outputNames.has(name)),
    ),
  }));
  const incoming = new Map();
  for (const t of writers)
    for (const input of t.inputs.filter((x) => !inRegion(x.table)))
      collect(incoming, schemaOf(input.table), t.taskId, input.table);
  return {
    version: network.version,
    publishedAt: network.publishedAt,
    exportedAt: network.exportedAt,
    counts: {
      tasks: network.tasks.length,
      tables: local.length,
      outputs: outputs.length,
      writers: writers.length,
      readers: readers.length,
      readOnly: local.filter((t) => t.scope === "read-only").length,
      unlinked: local.filter((t) => t.scope === "unlinked").length,
      both: outputs.filter((t) => t.readers.length).length,
      writeOnly: outputs.filter((t) => !t.readers.length).length,
      internal: readers.filter((t) => writerIds.has(t.taskId)).length,
      ingress: writers.filter((t) =>
        t.inputs.some((x) => schemaOf(x.table) === "odata_n_tit"),
      ).length,
    },
    branches,
    tables: local,
    allTables: tableRows,
    tasks,
    writerIds: unique(writerIds),
    incoming: finish(incoming),
    downstream,
    unassigned,
  };
}
