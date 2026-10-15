import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { stageLayout, neighborhoodLayout } from "./layout.mjs";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const defaultOutput = resolve(repositoryRoot, "artifacts/inventory-map");
export function failure(message, code = "INVALID_ARGUMENT") {
  const error = new Error(message);
  error.code = code;
  return error;
}
function integer(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(String(value))) throw failure("参数必须为整数");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw failure(`参数超出允许范围 ${min}–${max}`);
  return n;
}
function text(value, max = 200) {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  )
    throw failure("文本参数无效");
  return value.trim();
}
function taskId(value) {
  const id = text(value, 24);
  if (!/^\d+$/.test(id)) throw failure("任务 ID 必须为数字");
  return id;
}
export function openMap(outputRoot = defaultOutput) {
  const root = resolve(outputRoot);
  if (!existsSync(resolve(root, "CURRENT.json")))
    throw failure("地图尚未构建，请先运行构建命令", "NOT_READY");
  const pointer = JSON.parse(
    readFileSync(resolve(root, "CURRENT.json"), "utf8"),
  );
  const path = resolve(root, pointer.database);
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw failure("快照路径越界", "INVALID_SNAPSHOT");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const summary = JSON.parse(
      db.prepare("SELECT value FROM meta WHERE key = 'summary'").get().value,
    );
    if (summary.version !== pointer.version)
      throw failure("快照版本不一致", "INVALID_SNAPSHOT");
    return { db, summary, outputRoot: root, close: () => db.close() };
  } catch (e) {
    db.close();
    throw e;
  }
}
export function taskDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || `任务 ${row.id}`,
    topic: row.topic,
    schemaName: row.schema_name,
    type: row.type,
    status: row.status,
    cycle: row.cycle,
    regionId: row.region_id,
    stageId: row.stage_id,
    metadataSource: row.metadata_source,
    metadataObservedAt: row.metadata_observed_at,
    hasDetail: !!row.has_detail,
    hasUp: !!row.has_up,
    hasDown: !!row.has_down,
    hasSql: !!row.has_sql,
    inInventory: !!row.in_inventory,
    inDegree: row.in_degree,
    outDegree: row.out_degree,
  };
}
function budgets(ctx) {
  const source = ctx.summary.limits || {};
  return {
    nodes: Math.min(150, source.maxNodes ?? 150),
    edges: Math.min(400, source.maxEdges ?? 400),
    depth: Math.min(4, source.maxDepth ?? 4),
    page: Math.min(100, source.maxPageSize ?? 100),
  };
}
function page(ctx, params) {
  const max = budgets(ctx).page;
  return {
    limit: integer(params.limit, Math.min(30, max), 1, max),
    offset: integer(params.offset, 0, 0, 10000000),
  };
}
function paginated(items, total, paging) {
  return {
    items,
    total,
    ...paging,
    nextOffset:
      paging.offset + items.length < total
        ? paging.offset + items.length
        : null,
  };
}
function taskConditions(p) {
  const clauses = ["t.in_inventory = 1"],
    values = [];
  for (const [param, column] of [
    ["region", "region_id"],
    ["stage", "stage_id"],
    ["schema", "schema_name"],
  ]) {
    const value = text(p[param]);
    if (value) {
      clauses.push(`t.${column} = ? COLLATE NOCASE`);
      values.push(value);
    }
  }
  const q = text(p.q);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    clauses.push(
      "(t.id = ? OR t.name LIKE ? ESCAPE '\\' OR t.topic LIKE ? ESCAPE '\\')",
    );
    values.push(q, like, like);
  }
  return { where: clauses.join(" AND "), values };
}
function listFlows(ctx, p) {
  const paging = page(ctx, p),
    values = [],
    clauses = [];
  for (const [param, column] of [
    ["sourceRegion", "s.region_id"],
    ["targetRegion", "t.region_id"],
    ["sourceStage", "s.stage_id"],
    ["targetStage", "t.stage_id"],
  ]) {
    const value = text(p[param]);
    if (value) {
      clauses.push(`${column} = ?`);
      values.push(value);
    }
  }
  const region = text(p.region);
  if (region) {
    clauses.push("(s.region_id = ? OR t.region_id = ?)");
    values.push(region, region);
  }
  const from =
    "FROM edges e JOIN tasks s ON s.id=e.source JOIN tasks t ON t.id=e.target" +
    (clauses.length ? " WHERE " + clauses.join(" AND ") : "");
  const total = ctx.db.prepare(`SELECT count(*) AS n ${from}`).get(...values).n;
  const items = ctx.db
    .prepare(
      `SELECT e.source,e.target,s.name AS sourceName,t.name AS targetName,s.region_id AS sourceRegion,t.region_id AS targetRegion,e.seen_up AS seenUp,e.seen_down AS seenDown,e.observed_min AS observedMin,e.observed_max AS observedMax ${from} ORDER BY e.source,e.target LIMIT ? OFFSET ?`,
    )
    .all(...values, paging.limit, paging.offset);
  return paginated(
    items.map((e) => ({ ...e, seenUp: !!e.seenUp, seenDown: !!e.seenDown })),
    total,
    paging,
  );
}
function neighbors(ctx, p) {
  const id = taskId(p.id),
    direction = text(p.direction) || "both";
  if (!["up", "down", "both"].includes(direction))
    throw failure("direction 必须为 up、down 或 both");
  const allowed = budgets(ctx);
  const depth = integer(p.depth, 1, 1, allowed.depth),
    limit = integer(p.limit, Math.min(45, allowed.nodes), 1, allowed.nodes),
    edgeLimit = integer(
      p.edgeLimit,
      Math.min(120, allowed.edges),
      1,
      allowed.edges,
    );
  const getTask = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?");
  const root = getTask.get(id);
  if (!root) throw failure("任务不在此快照中", "NOT_FOUND");
  const where =
    direction === "up"
      ? "target = ?"
      : direction === "down"
        ? "source = ?"
        : "(source = ? OR target = ?)";
  const lookup = ctx.db.prepare(
    `SELECT source,target,seen_up AS seenUp,seen_down AS seenDown FROM edges WHERE ${where} ORDER BY source,target LIMIT ?`,
  );
  const seen = new Set([id]),
    nodes = [taskDto(root)],
    edges = [],
    edgeSeen = new Set(),
    queue = [{ id, depth: 0 }],
    stopped = new Set();
  for (let at = 0; at < queue.length; at++) {
    const item = queue[at];
    const found = lookup.all(
      ...(direction === "both" ? [item.id, item.id] : [item.id]),
      edgeLimit + 1,
    );
    if (item.depth === depth) {
      if (
        found.some((e) => !seen.has(e.source) || !seen.has(e.target)) ||
        found.length > edgeLimit
      )
        stopped.add("DEPTH_LIMIT");
      continue;
    }
    if (found.length > edgeLimit) stopped.add("EDGE_LIMIT");
    for (const edge of found) {
      const key = `${edge.source}>${edge.target}`;
      if (edgeSeen.has(key)) continue;
      if (edges.length >= edgeLimit) {
        stopped.add("EDGE_LIMIT");
        break;
      }
      const next = edge.source === item.id ? edge.target : edge.source;
      if (!seen.has(next)) {
        if (seen.size >= limit) {
          stopped.add("NODE_LIMIT");
          continue;
        }
        const node = getTask.get(next);
        if (!node) {
          stopped.add("MISSING_TASK");
          continue;
        }
        seen.add(next);
        nodes.push(taskDto(node));
        queue.push({ id: next, depth: item.depth + 1 });
      }
      edgeSeen.add(key);
      edges.push({ ...edge, seenUp: !!edge.seenUp, seenDown: !!edge.seenDown });
    }
  }
  // A displayed local map includes all dependencies between selected tasks,
  // including sibling links at the depth boundary, within the same edge budget.
  const selected = JSON.stringify([...seen]);
  const induced = ctx.db
    .prepare(
      "SELECT source,target,seen_up AS seenUp,seen_down AS seenDown FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?)) ORDER BY source,target LIMIT ?",
    )
    .all(selected, selected, edgeLimit + 1);
  for (const edge of induced) {
    const key = `${edge.source}>${edge.target}`;
    if (edgeSeen.has(key)) continue;
    if (edges.length >= edgeLimit) {
      stopped.add("EDGE_LIMIT");
      break;
    }
    edgeSeen.add(key);
    edges.push({ ...edge, seenUp: !!edge.seenUp, seenDown: !!edge.seenDown });
  }
  return {
    rootId: id,
    direction,
    depth,
    nodes: neighborhoodLayout(nodes, edges, id),
    edges,
    truncated: stopped.size > 0,
    stoppedBy: [...stopped],
    edgeScope: "INDUCED_SELECTED_TASKS",
    limits: { nodes: limit, edges: edgeLimit },
  };
}
function overview(ctx, p) {
  const summary = ctx.summary,
    region = text(p.region);
  if (!region) {
    const nodes = stageLayout(summary.stages, summary.regions);
    const allowed = budgets(ctx);
    if (nodes.length > allowed.nodes)
      throw failure("阶段数量超过本快照的节点预算，请调整规则后重建");
    const candidates = summary.stageFlows
      .filter((e) => e.source !== e.target)
      .sort((a, b) => b.edgeCount - a.edgeCount);
    const edges = candidates.slice(0, Math.min(8, allowed.edges));
    return {
      scope: "stages",
      version: summary.version,
      counts: summary.counts,
      nodes,
      edges,
      stages: summary.stages,
      totalFlows: candidates.length,
      truncated: edges.length < candidates.length,
      stoppedBy: edges.length < candidates.length ? ["MAJOR_FLOWS_ONLY"] : [],
    };
  }
  const root = summary.regions.find((r) => r.id === region);
  if (!root) throw failure("主题不在此快照中", "NOT_FOUND");
  const pairs = ctx.db
    .prepare(
      `SELECT s.region_id AS source,t.region_id AS target,count(*) AS edgeCount FROM edges e JOIN tasks s ON s.id=e.source JOIN tasks t ON t.id=e.target WHERE (s.region_id = ? OR t.region_id = ?) AND s.region_id != t.region_id GROUP BY s.region_id,t.region_id ORDER BY edgeCount DESC,source,target`,
    )
    .all(region, region);
  const allowed = budgets(ctx),
    chosen = [],
    ids = new Set([region]);
  for (const edge of pairs) {
    const next = new Set([...ids, edge.source, edge.target]);
    if (
      next.size > allowed.nodes ||
      chosen.length >= Math.min(18, allowed.edges)
    )
      continue;
    chosen.push(edge);
    ids.add(edge.source);
    ids.add(edge.target);
  }
  const nodes = summary.regions
    .filter((r) => ids.has(r.id))
    .map((r) => ({ ...r, name: r.label }));
  return {
    scope: "region",
    rootId: region,
    version: summary.version,
    nodes: neighborhoodLayout(nodes, chosen, region),
    edges: chosen,
    stages: summary.stages,
    totalFlows: pairs.length,
    shownFlows: chosen.length,
    internalEdges: root.internalEdges,
    taskCount: root.taskCount,
    truncated: pairs.length > chosen.length,
    stoppedBy: pairs.length > chosen.length ? ["FLOW_LIMIT"] : [],
  };
}
export function queryMap(ctx, command, params = {}) {
  const p = params;
  if (command === "summary") return ctx.summary;
  if (command === "overview") return overview(ctx, p);
  if (command === "regions") {
    const paging = page(ctx, p),
      q = text(p.q).toLowerCase(),
      stage = text(p.stage);
    const all = ctx.summary.regions
      .filter(
        (r) =>
          (!q || r.label.toLowerCase().includes(q)) &&
          (!stage || r.stageId === stage),
      )
      .sort((a, b) => b.taskCount - a.taskCount || a.id.localeCompare(b.id));
    return paginated(
      all.slice(paging.offset, paging.offset + paging.limit),
      all.length,
      paging,
    );
  }
  if (command === "tasks") {
    const paging = page(ctx, p),
      { where, values } = taskConditions(p);
    const total = ctx.db
      .prepare(`SELECT count(*) AS n FROM tasks t WHERE ${where}`)
      .get(...values).n;
    const rows = ctx.db
      .prepare(
        `SELECT t.* FROM tasks t WHERE ${where} ORDER BY t.out_degree DESC,t.in_degree DESC,t.id LIMIT ? OFFSET ?`,
      )
      .all(...values, paging.limit, paging.offset);
    return paginated(rows.map(taskDto), total, paging);
  }
  if (command === "task") {
    const id = taskId(p.id),
      row = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!row) throw failure("任务不在此快照中", "NOT_FOUND");
    const evidence = ctx.db
      .prepare(
        "SELECT evidence_type AS evidenceType,direction,depth,observed_at AS observedAt,content_sha256 AS contentSha256 FROM evidence_refs WHERE task_id = ? ORDER BY evidence_type,direction",
      )
      .all(id);
    return { task: taskDto(row), evidence };
  }
  if (command === "flows") return listFlows(ctx, p);
  if (command === "neighbors") return neighbors(ctx, p);
  throw failure("未知查询命令");
}
