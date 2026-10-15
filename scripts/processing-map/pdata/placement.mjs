// The reviewed Markdown is the single source for membership and explanation status.
const routeStyle = {
  A: ["party", "#8db9d0"],
  B: ["contract", "#88bbb1"],
  S: ["sales", "#c5a1cd"],
  P: ["parameters", "#b6a0cd"],
  R: ["risk", "#d0b178"],
  L: ["lifecycle", "#a8bc82"],
  F: ["reporting", "#d19f88"],
  C: ["support", "#9daeca"],
  W: ["records", "#aeb2bb"],
};
const cells = (line) =>
  line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((x) => x.trim());
const equalSet = (a, b) =>
  a.length === b.length &&
  [...a].sort().every((x, i) => x === [...b].sort()[i]);

export function parsePlacement(markdown, network) {
  if (!markdown.includes(`固定网络版本：\`${network.version}\``))
    throw new Error("PLACEMENT_SNAPSHOT_MISMATCH");
  const refs = Object.fromEntries(
    [...markdown.matchAll(/^\[([^\]]+)\]:\s*(.+)$/gm)].map((m) => [
      m[1],
      m[2].trim(),
    ]),
  );
  const lines = markdown.split(/\r?\n/);
  const groups = [],
    records = [];
  for (const [index, line] of lines.entries()) {
    const row = cells(line);
    if (row[0]?.includes('id="route-')) {
      const [, code, title] = /\*\*([A-Z]) (.+)\*\*/.exec(row[0]) ?? [];
      if (!routeStyle[code])
        throw new Error(`UNKNOWN_PLACEMENT_ROUTE: ${code}`);
      groups.push({
        code,
        id: routeStyle[code][0],
        color: routeStyle[code][1],
        title: `${code} ${title}`,
        summary: row[3],
        result: row[3],
        count: Number(row[1]),
        memberIds: [...row[2].matchAll(/#out-(\d+)/g)].map((m) => m[1]),
      });
    }
    if (row[0]?.includes('id="out-')) {
      if (row.length !== 8)
        throw new Error(`INVALID_PLACEMENT_ROW: ${index + 1}`);
      const [, id, name] = /id="out-(\d+)".*`([^`]+)`/.exec(row[0]) ?? [];
      const routes = [...row[3].matchAll(/#route-([a-z])/g)].map((m) =>
        m[1].toUpperCase(),
      );
      const writers = [
        ...(row[4].split("N 写入：")[1] ?? "").matchAll(/\[\d+\]\[ev-(\d+)\]/g),
      ].map((m) => m[1]);
      if (!["已有依据", "暂定", "仍待解释"].includes(row[6]))
        throw new Error(`INVALID_PLACEMENT_STATUS: ${name}`);
      const explicit = /关键写入已解释：([^；]+)/.exec(row[5]);
      const explainedWrites =
        explicit?.[1].match(/\d+/g) ??
        (/沿用首轮|已核|补读/.test(row[5]) && !row[5].includes("生产写入未展开")
          ? (row[5].match(/\d+/g) ?? []).filter((id) => writers.includes(id))
          : []);
      records.push({
        id,
        name,
        meaning: row[1],
        duty: row[2],
        routes,
        basis: row[4],
        coverage: row[5],
        status: row[6],
        gaps: row[7],
        writers,
        line: index + 1,
        explainedWrites,
      });
    }
  }
  const outputs = network.tables.filter(
    (t) => t.table.startsWith("pdata_n.") && t.writers.length,
  );
  if (
    new Set(records.map((r) => r.id)).size !== records.length ||
    new Set(records.map((r) => r.name)).size !== records.length
  )
    throw new Error("DUPLICATE_PLACEMENT_OUTPUT");
  if (
    !equalSet(
      records.map((r) => r.name),
      outputs.map((t) => t.table),
    )
  )
    throw new Error("PLACEMENT_OUTPUT_SET_MISMATCH");
  for (const record of records) {
    if (
      !record.routes.length ||
      record.routes.some((code) => !groups.some((g) => g.code === code))
    )
      throw new Error(`PLACEMENT_ROUTE_MISSING: ${record.name}`);
    if (
      !equalSet(
        record.writers,
        outputs.find((t) => t.table === record.name).writers,
      )
    )
      throw new Error(`PLACEMENT_WRITERS_MISMATCH: ${record.name}`);
    if (record.explainedWrites.some((id) => !record.writers.includes(id)))
      throw new Error(`EXPLAINED_WRITE_NOT_ASSOCIATED: ${record.name}`);
    for (const id of record.writers)
      if (!refs[`ev-${id}`])
        throw new Error(`PLACEMENT_EVIDENCE_MISSING: ${id}`);
  }
  const branches = groups.map((g) => {
    const members = records.filter((r) => r.routes.includes(g.code));
    if (
      members.length !== g.count ||
      !equalSet(
        members.map((r) => r.id),
        g.memberIds,
      )
    )
      throw new Error(`PLACEMENT_INDEX_MISMATCH: ${g.code}`);
    // Status partitions are navigation only. Shared membership remains the same table identity.
    return {
      ...g,
      change: g.summary,
      boundary:
        "定位有依据不等于所有写入均已解释；共享成员可从多条路线进入同一结果。",
      observations: [...new Set(members.flatMap((r) => r.explainedWrites))],
      parts: ["已有依据", "暂定", "仍待解释"]
        .map((status, i) => ({
          id: `${g.id}-${i}`,
          title: status,
          description: `${g.title} · ${status}；查看逐项定位及解释缺口`,
          tables: members.filter((r) => r.status === status).map((r) => r.name),
        }))
        .filter((p) => p.tables.length),
    };
  });
  const counts = Object.fromEntries(
    ["已有依据", "暂定", "仍待解释"].map((s) => [
      s,
      records.filter((r) => r.status === s).length,
    ]),
  );
  counts.explainedWrites = records.filter(
    (r) => r.explainedWrites.length,
  ).length;
  const questions = Object.fromEntries(
    lines.flatMap((line, i) => {
      const match = /^### (Q\d+)[：:]/.exec(line);
      return match ? [[match[1], i + 1]] : [];
    }),
  );
  return {
    records: Object.fromEntries(records.map((r) => [r.name, r])),
    branches,
    refs,
    counts,
    questions,
  };
}
