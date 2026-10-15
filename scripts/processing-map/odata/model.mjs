import { createHash } from "node:crypto";

const unique = (values) => [...new Set(values)];
const sorted = (values) =>
  unique(values).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
const isLocal = (name) => name.startsWith("odata_n_tit.");
// A name-family is a navigation aid only. Processing roles always come from reviewed task membership.
export const familyName = (name) =>
  name
    .split(".")
    .at(-1)
    .replace(/_(?:pb|p)$/, "");
export const redact = (value) =>
  String(value ?? "")
    .replace(
      /(?:https?:\/\/|jdbc:|hdfs:\/\/)[^\s"'<>`，）)]+/gi,
      "[环境地址已省略]",
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[环境地址已省略]")
    .replace(/\b[\w.-]+\.gf\.com\.cn\b/gi, "[环境地址已省略]")
    .replace(/[A-Z]:[\\/][^\r\n"'<>`)]+/gi, "[本地证据文件]")
    .replace(
      /((?:password|passwd|secret|token|access[_-]?key)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;,]+)/gi,
      "$1[已省略]",
    );

export function verifySql(id, raw, expected) {
  const digest = createHash("sha256").update(raw).digest("hex");
  if (expected && digest !== expected)
    throw new Error(`REVIEWED_SQL_CHANGED: ${id}`);
  return digest;
}

export function buildRegion({ network, analysis, groups, definitions = {} }) {
  if (network.version !== analysis.scope.graphVersion)
    throw new Error("GRAPH_VERSION_CHANGED");
  const roles = { ingress: [], internal: [], externalConsumer: [] };
  for (const t of network.tasks) {
    const input = t.inputs.some((x) => isLocal(x.table)),
      output = t.outputs.some((x) => isLocal(x.table));
    if (input && output) roles.internal.push(t.taskId);
    else if (output) roles.ingress.push(t.taskId);
    else if (input) roles.externalConsumer.push(t.taskId);
  }
  for (const key of Object.keys(roles)) {
    if (
      JSON.stringify(sorted(roles[key])) !==
      JSON.stringify(sorted(analysis.taskRoles[key]))
    )
      throw new Error(`ROLE_MEMBERSHIP_CHANGED: ${key}`);
  }
  const methodByTask = new Map();
  for (const b of analysis.branches)
    for (const id of b.taskIds) {
      if (methodByTask.has(id)) throw new Error(`DUPLICATE_METHOD_TASK: ${id}`);
      methodByTask.set(id, b.id);
    }
  if (
    JSON.stringify(sorted([...methodByTask.keys()])) !==
    JSON.stringify(sorted([...roles.ingress, ...roles.internal]))
  )
    throw new Error("METHOD_MEMBERSHIP_INCOMPLETE");
  const owner = new Map();
  for (const g of groups)
    for (const name of g.families) {
      if (owner.has(name)) throw new Error(`DUPLICATE_FAMILY: ${name}`);
      owner.set(name, g.id);
    }
  const relevant = new Set(Object.values(roles).flat());
  const tasks = network.tasks
    .filter((t) => relevant.has(t.taskId))
    .map((t) => ({
      id: t.taskId,
      name: redact(t.name),
      category: t.category,
      inputs: sorted(t.inputs.map((x) => x.table)),
      outputs: sorted(t.outputs.map((x) => x.table)),
      role: Object.keys(roles).find((key) => roles[key].includes(t.taskId)),
      methodId: methodByTask.get(t.taskId) ?? null,
    }));
  const tables = network.tables
    .filter((t) => isLocal(t.table))
    .map((t) => ({
      name: t.table,
      familyId: familyName(t.table),
      groupId: owner.get(familyName(t.table)) ?? "unclassified",
      readers: sorted(t.readers),
      writers: sorted(t.writers),
      methodIds: unique(
        t.writers.map((id) => methodByTask.get(id)).filter(Boolean),
      ),
      definition: definitions[t.table] ?? null,
    }));
  const summarize = (tableNames) => {
    const names = new Set(tableNames);
    const producers = tasks.filter((t) => t.outputs.some((n) => names.has(n)));
    const consumers = tasks.filter(
      (t) =>
        t.role === "externalConsumer" && t.inputs.some((n) => names.has(n)),
    );
    const internal = tasks.filter(
      (t) =>
        t.role === "internal" &&
        [...t.inputs, ...t.outputs].some((n) => names.has(n)),
    );
    const sourceNames = sorted(
      producers.flatMap((t) => t.inputs).filter((n) => !isLocal(n)),
    );
    const destinations = sorted(consumers.flatMap((t) => t.outputs))
      .map((name) => ({
        name,
        taskIds: consumers
          .filter((t) => t.outputs.includes(name))
          .map((t) => t.id),
        definition: definitions[name] ?? null,
      }))
      .sort(
        (a, b) =>
          b.taskIds.length - a.taskIds.length || a.name.localeCompare(b.name),
      );
    return {
      tableNames: sorted(tableNames),
      writerIds: sorted(producers.map((t) => t.id)),
      internalIds: sorted(internal.map((t) => t.id)),
      consumerIds: sorted(consumers.map((t) => t.id)),
      sourceNames,
      destinations,
    };
  };
  const families = sorted(tables.map((t) => t.familyId)).map((id) => {
    const members = tables.filter((t) => t.familyId === id);
    const definition =
      members.find((t) => t.name === `odata_n_tit.${id}`)?.definition ??
      members.find((t) => t.definition?.text)?.definition ??
      null;
    return {
      id,
      groupId: members[0].groupId,
      definition,
      ...summarize(members.map((t) => t.name)),
      methodIds: unique(members.flatMap((t) => t.methodIds)),
    };
  });
  const grouped = [
    ...groups,
    {
      id: "unclassified",
      title: "待定位的对象",
      color: "#8d9da5",
      summary: "保留本区全部表；尚未归入业务导航的对象在这里继续查看。",
      change: "先查看实际读写关系，再确认对象含义。",
      families: [],
    },
  ]
    .map((g) => ({
      ...g,
      familyIds: families.filter((f) => f.groupId === g.id).map((f) => f.id),
      ...summarize(tables.filter((t) => t.groupId === g.id).map((t) => t.name)),
    }))
    .filter((g) => g.tableNames.length);
  const methods = analysis.branches.map((b) => {
    const members = tasks.filter((t) => b.taskIds.includes(t.id));
    return {
      id: b.id,
      title: b.title,
      taskIds: sorted(b.taskIds),
      outputNames: sorted(members.flatMap((t) => t.outputs).filter(isLocal)),
    };
  });
  const processed = new Set(
    methods
      .filter((m) => m.id !== "source_supply")
      .flatMap((m) => m.outputNames),
  );
  const counts = {
    tables: tables.length,
    families: families.length,
    ingress: roles.ingress.length,
    internal: roles.internal.length,
    consumers: roles.externalConsumer.length,
    consumersOfProcessed: tasks.filter(
      (t) =>
        t.role === "externalConsumer" && t.inputs.some((n) => processed.has(n)),
    ).length,
  };
  return {
    version: network.version,
    publishedAt: network.publishedAt,
    counts,
    roles,
    groups: grouped,
    families,
    tables,
    tasks,
    methods,
    definitions,
  };
}
