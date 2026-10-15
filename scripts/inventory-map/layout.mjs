// Stable, bounded layouts. Coordinates are derived from order and topology only.
export function stageLayout(stages, regions) {
  const active = stages
    .filter((s) => s.taskCount > 0)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const width = 220,
    gap = 30;
  return active.map((s, i) => ({
    id: s.id,
    stageId: s.id,
    label: s.label,
    color: s.color,
    taskCount: s.taskCount,
    regionCount: regions.filter((r) => r.stageId === s.id).length,
    regions: regions
      .filter((r) => r.stageId === s.id)
      .sort((a, b) => b.taskCount - a.taskCount || a.id.localeCompare(b.id))
      .slice(0, 4),
    x: 34 + i * (width + gap),
    y: 90 + (i % 2) * 30,
    width,
    height: 292,
  }));
}

export function neighborhoodLayout(nodes, edges, rootId) {
  const level = new Map([[rootId, 0]]);
  // Prioritize downstream, then upstream; each real object has one visual identity.
  for (const sign of [1, -1]) {
    const queue = [rootId];
    const seen = new Set(queue);
    for (let at = 0; at < queue.length; at++) {
      const id = queue[at];
      for (const e of edges) {
        const next =
          sign === 1
            ? e.source === id
              ? e.target
              : null
            : e.target === id
              ? e.source
              : null;
        if (!next || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
        if (!level.has(next))
          level.set(next, sign * (Math.abs(level.get(id) ?? 0) + 1));
      }
    }
  }
  const columns = new Map();
  for (const n of nodes) {
    const rank = level.get(n.id) ?? 1;
    if (!columns.has(rank)) columns.set(rank, []);
    columns.get(rank).push(n);
  }
  const ranks = [...columns.keys()].sort((a, b) => a - b);
  // Fan-out is wrapped into short columns, keeping a 17-neighbor topic readable.
  const rowLimit = 4;
  const chunks = ranks.flatMap((rank) => {
    const values = columns
      .get(rank)
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    return Array.from({ length: Math.ceil(values.length / rowLimit) }, (_, i) =>
      values.slice(i * rowLimit, (i + 1) * rowLimit),
    );
  });
  const maxRows = Math.max(1, ...chunks.map((c) => c.length));
  return chunks.flatMap((list, col) =>
    list.map((n, row) => ({
      ...n,
      x: 32 + col * 266,
      y: 40 + ((maxRows - list.length) / 2 + row) * 108,
      width: 226,
      height: 88,
      root: n.id === rootId,
    })),
  );
}
