import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { failure, queryMap, taskDto } from "./query.mjs";
import { neighborhoodLayout } from "./layout.mjs";
import { redact, readKnowledge, readSql } from "./evidence.mjs";
import {
  readTaskAnalysis,
  readTaskSql,
  parseDefinition,
} from "./analysis-evidence.mjs";

const DEFAULT_TABLE = "pdata_n.t98_otc_deri_comp_sale_info";
const MAX_NODES = 70;
const MAX_EDGES = 120;
const json = (value, fallback = {}) => (value ? JSON.parse(value) : fallback);
const safe = (value) => redact(value ?? "");
function string(value, max = 600) {
  if (value === undefined || value === "") return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  )
    throw failure("分析参数格式不正确");
  return value.trim();
}
function int(value, fallback, max) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) > max)
    throw failure("分析分页参数超出范围");
  return Number(value);
}
function paging(p) {
  const limit = int(p.limit, 24, 60);
  if (!limit) throw failure("分页大小必须大于零");
  return { limit, offset: int(p.offset, 0, 10000000) };
}
function page(items, total, p) {
  return {
    items,
    total,
    ...p,
    nextOffset:
      p.offset + items.length < total ? p.offset + items.length : null,
  };
}
function fieldId(tableId, column) {
  return `field:${Buffer.from(JSON.stringify([tableId, column])).toString("base64url")}`;
}
function decodeField(id) {
  try {
    const value = JSON.parse(Buffer.from(id.slice(6), "base64url").toString());
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value.some((x) => typeof x !== "string" || !x)
    )
      throw new Error();
    return value;
  } catch {
    throw failure("字段身份无效");
  }
}
function open(ctx) {
  if (ctx.analysis) return ctx.analysis;
  const root = resolve(ctx.outputRoot, "analysis");
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(resolve(root, "CURRENT.json"), "utf8"));
  } catch {
    throw failure(
      "加工分析索引尚未构建，请运行 inventory-map:analysis-build",
      "NOT_READY",
    );
  }
  const path = resolve(root, pointer.database);
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw failure("分析快照路径无效", "INVALID_SNAPSHOT");
  const db = new DatabaseSync(path, { readOnly: true });
  const oldClose = ctx.close;
  ctx.close = () => {
    db.close();
    oldClose();
  };
  ctx.analysis = { db, version: pointer.version, root };
  return ctx.analysis;
}
function dto(row) {
  if (!row) return null;
  const props = json(row.properties_json);
  const isView = ["VIEW", "hive_view_definition"].includes(row.object_type);
  return {
    id: row.id,
    kind: isView ? "view" : row.kind === "catalog" ? "table" : row.kind,
    label: safe(row.label || row.qualified_name || row.id),
    qualifiedName: row.qualified_name || "",
    schemaName: row.schema_name || "",
    description: safe(row.description),
    objectType: isView ? "VIEW" : row.object_type || "UNKNOWN",
    catalogOnly: row.kind === "catalog",
    ...(row.kind === "task"
      ? { subtitle: `任务 ${row.id.replace(/^task:/, "")}` }
      : {}),
    identityStatus: props.identityStatus || "",
    expandable: true,
  };
}
function object(ctx, id) {
  const { db } = open(ctx);
  if (id.startsWith("schema:")) {
    const schema = id.slice(7);
    if (
      !db
        .prepare("SELECT 1 FROM objects WHERE schema_name=? LIMIT 1")
        .get(schema)
    )
      throw failure("未找到这个 schema", "NOT_FOUND");
    return {
      id,
      kind: "schema",
      label: schema,
      schemaName: schema,
      description: "从具体表进入，沿写入任务和来源继续分析。",
      expandable: true,
    };
  }
  if (id.startsWith("field:")) {
    const [tableId, column] = decodeField(id),
      parent = object(ctx, tableId);
    if (!["table", "view"].includes(parent.kind))
      throw failure("字段必须属于表或视图");
    return {
      id,
      kind: "field",
      label: column,
      qualifiedName: `${parent.qualifiedName}.${column}`,
      tableId,
      column,
      schemaName: parent.schemaName,
      description: "按每个写入分支保留表达式与物理来源。",
      expandable: true,
    };
  }
  const found = db.prepare("SELECT * FROM objects WHERE id=?").get(id);
  if (found) return dto(found);
  if (/^task:\d+$/.test(id)) {
    const row = ctx.db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(id.slice(5));
    if (row) {
      const task = taskDto(row);
      return {
        id,
        kind: "task",
        label: safe(task.name),
        description: "可查调度库存；加工证据按实际覆盖展示。",
        schemaName: task.schemaName,
        inventory: true,
        expandable: true,
      };
    }
  }
  throw failure("对象不在当前分析索引中", "NOT_FOUND");
}
function artifact(ctx, task) {
  return open(ctx)
    .db.prepare("SELECT * FROM task_artifacts WHERE task_id=?")
    .get(task.replace(/^task:/, ""));
}
function taskAnalysis(ctx, id, params = {}) {
  const key = JSON.stringify([id, params]);
  if (ctx.readCache?.has(key)) return ctx.readCache.get(key);
  const ref = artifact(ctx, id);
  const covered =
    ref &&
    !["SCHEDULE_ONLY", "COLLECTION_FAILED"].includes(ref.coverage_status);
  const result = covered
    ? readTaskAnalysis(ref, { limit: 300, ...params })
    : {
        available: false,
        reason:
          "该任务尚无已索引的加工证据。可阅读缓存 SQL，但不能用调度关系补作 SQL 血缘。",
        outputs: [],
      };
  ctx.readCache?.set(key, result);
  return result;
}
function tableRelations(ctx, id) {
  return open(ctx)
    .db.prepare(
      "SELECT * FROM relations WHERE source=? OR target=? ORDER BY kind,task_id,id",
    )
    .all(id, id);
}
function writers(ctx, table, column) {
  const refs = open(ctx)
    .db.prepare(
      "SELECT DISTINCT task_id FROM relations WHERE target=? AND kind='WRITES' ORDER BY task_id LIMIT 21",
    )
    .all(table.id);
  return refs.slice(0, 20).map((ref) => {
    const id = `task:${ref.task_id}`,
      task = object(ctx, id);
    const detail = taskAnalysis(ctx, id, {
      outputTable: table.qualifiedName,
      ...(column ? { outputColumn: column } : {}),
    });
    const outputs = (detail.outputs || []).filter(
      (out) => out.table?.toLowerCase() === table.qualifiedName?.toLowerCase(),
    );
    return {
      id,
      label: task.label,
      available: detail.available,
      reason: detail.reason,
      partition: outputs.map((out) => out.partition).filter(Boolean),
      outputs,
      expressions: outputs.flatMap((out) =>
        (out.fields || []).map((f) => ({
          outputName: f.name,
          text: f.text || "",
          inputs: f.inputs || [],
          bindingStatus: f.bindingStatus,
          writeObservationId: out.writeObservationId,
          sourceStart: f.sourceStart,
          sourceEnd: f.sourceEnd,
          sourceLine: f.sourceLine,
          sourceEndLine: f.sourceEndLine,
          sqlSlot: f.sqlSlot,
        })),
      ),
      evidence: detail.source || {},
    };
  });
}
function definitions(ctx, item) {
  return open(ctx)
    .db.prepare(
      "SELECT * FROM definitions WHERE qualified_name=? ORDER BY id LIMIT 13",
    )
    .all(item.qualifiedName.toLowerCase());
}
function fields(ctx, id, p = {}) {
  const item = object(ctx, id),
    pg = paging(p);
  if (item.kind === "field") return fields(ctx, item.tableId, p);
  const found = new Map();
  let sources = [],
    available = true;
  if (item.kind === "task") {
    const detail = taskAnalysis(ctx, id);
    available = detail.available;
    for (const out of detail.outputs || [])
      for (const f of out.fields || []) {
        const candidates = open(ctx)
          .db.prepare(
            "SELECT o.id FROM relations r JOIN objects o ON o.id=r.target WHERE r.source=? AND r.kind='WRITES' AND o.qualified_name=? GROUP BY o.id",
          )
          .all(id, out.table.toLowerCase());
        const target = candidates.length === 1 ? candidates[0].id : null;
        found.set(`${out.table}:${f.name}`, {
          name: f.name,
          type: f.type || "",
          comment: f.comment || "",
          id: target ? fieldId(target, f.name) : undefined,
          table: out.table,
          bindingStatus: f.bindingStatus,
          basis: "写入绑定",
          ordinal: found.size + 1,
        });
      }
    sources = detail.source ? [detail.source] : [];
  } else if (["table", "view"].includes(item.kind)) {
    for (const writer of writers(ctx, item))
      for (const out of writer.outputs)
        for (const f of out.fields || []) {
          const key = f.name.toLowerCase();
          if (!found.has(key))
            found.set(key, {
              id: fieldId(id, f.name),
              name: f.name,
              type: f.type || "",
              comment: f.comment || "",
              basis: "已索引写入字段",
              ordinal: found.size + 1,
            });
        }
    const candidates = definitions(ctx, item);
    // Same name alone does not establish that a metadata definition belongs to this physical dataset.
    // Catalogue definitions are shown separately; their fields must not be silently attached to SQL identity.
    if (item.catalogOnly) {
      const exact = candidates.filter((d) => d.object_id === item.id);
      if (exact.length === 1) {
        const parsed = parseDefinition(exact[0].sql);
        for (const f of parsed.fields || [])
          found.set(f.name.toLowerCase(), {
            ...f,
            basis: "目录定义",
            id: undefined,
          });
        sources = [
          {
            kind: "CATALOG_DEFINITION",
            hash: exact[0].source_hash,
            parseStatus: parsed.parseStatus,
          },
        ];
      }
    }
  }
  let values = [...found.values()];
  const q = string(p.q, 160).toLowerCase();
  if (q)
    values = values.filter((f) =>
      `${f.name} ${f.comment}`.toLowerCase().includes(q),
    );
  return {
    ...page(values.slice(pg.offset, pg.offset + pg.limit), values.length, pg),
    available,
    sources,
  };
}
function search(ctx, p) {
  const { db } = open(ctx),
    pg = paging(p),
    q = string(p.q, 160),
    schema = string(p.schema, 160).toLowerCase();
  let kind = string(p.kind, 30);
  if (!kind && /^\d+$/.test(q)) kind = "task";
  if (kind && !["schema", "table", "view", "task", "all"].includes(kind))
    throw failure("不支持这个对象类型");
  if (kind === "task") {
    const result = queryMap(ctx, "tasks", {
      q,
      ...(schema ? { schema } : {}),
      ...pg,
    });
    return {
      ...result,
      items: result.items.map((t) => ({
        id: `task:${t.id}`,
        kind: "task",
        label: safe(t.name),
        schemaName: t.schemaName,
        description: t.topic,
      })),
    };
  }
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  if (kind === "schema") {
    const from =
      "FROM (SELECT DISTINCT schema_name FROM objects WHERE schema_name <> '' AND kind <> 'task') WHERE schema_name LIKE ? ESCAPE '\\'";
    const total = db.prepare(`SELECT count(*) n ${from}`).get(like).n;
    const items = db
      .prepare(
        `SELECT schema_name ${from} ORDER BY schema_name LIMIT ? OFFSET ?`,
      )
      .all(like, pg.limit, pg.offset)
      .map((r) => ({
        id: `schema:${r.schema_name}`,
        kind: "schema",
        label: r.schema_name,
        schemaName: r.schema_name,
        description: "进入表与视图，沿加工关系分析",
      }));
    return page(items, total, pg);
  }
  const clauses = ["kind <> 'task'"],
    args = [];
  if (schema) {
    clauses.push("schema_name=?");
    args.push(schema);
  }
  if (q) {
    clauses.push(
      "(qualified_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')",
    );
    args.push(like, like);
  }
  if (kind === "view")
    clauses.push("object_type IN ('VIEW','hive_view_definition')");
  const where = clauses.join(" AND ");
  const total = db
    .prepare(`SELECT count(*) n FROM objects WHERE ${where}`)
    .get(...args).n;
  const lookup = db.prepare(
    `SELECT * FROM objects WHERE ${where} ORDER BY CASE kind WHEN 'table' THEN 0 ELSE 1 END,qualified_name,id LIMIT ? OFFSET ?`,
  );
  if (kind === "table" || kind === "view")
    return page(lookup.all(...args, pg.limit, pg.offset).map(dto), total, pg);
  // Interleave the two indexed catalogues, with a stable page boundary and no bulk loading.
  const taskParams = { q, ...(schema ? { schema } : {}) };
  const taskTotal = queryMap(ctx, "tasks", { ...taskParams, limit: 1 }).total;
  const paired = Math.min(total, taskTotal),
    combined = total + taskTotal;
  const positions = Array.from(
    { length: Math.min(pg.limit, Math.max(0, combined - pg.offset)) },
    (_, at) => {
      const index = at + pg.offset;
      return index < paired * 2
        ? { kind: index % 2 ? "task" : "object", offset: Math.floor(index / 2) }
        : {
            kind: total > taskTotal ? "object" : "task",
            offset: index - paired,
          };
    },
  );
  const values = new Map();
  for (const source of ["object", "task"]) {
    const selected = positions.filter((position) => position.kind === source);
    if (!selected.length) continue;
    const offset = selected[0].offset,
      limit = selected.length;
    const items =
      source === "object"
        ? lookup.all(...args, limit, offset).map(dto)
        : queryMap(ctx, "tasks", { ...taskParams, limit, offset }).items.map(
            (task) => ({
              id: `task:${task.id}`,
              kind: "task",
              label: safe(task.name),
              schemaName: task.schemaName,
              description: safe(task.topic),
            }),
          );
    items.forEach((item, at) => values.set(`${source}:${offset + at}`, item));
  }
  return page(
    positions.map((position) =>
      values.get(`${position.kind}:${position.offset}`),
    ),
    combined,
    pg,
  );
}

async function view(ctx, p) {
  const { db, version } = open(ctx);
  let rootId = string(p.id);
  if (!rootId) {
    const defaults = db
      .prepare(
        "SELECT id FROM objects WHERE kind='table' AND qualified_name=? ORDER BY id",
      )
      .all(DEFAULT_TABLE);
    if (defaults.length !== 1)
      throw failure(
        "默认案例不能唯一定位，请按 schema 或名称选择对象",
        "NOT_FOUND",
      );
    rootId = defaults[0].id;
  }
  const root = object(ctx, rootId),
    focusId = string(p.focus) || rootId,
    focus = object(ctx, focusId);
  let expanded = [];
  if (p.expanded) {
    try {
      expanded = JSON.parse(string(p.expanded, 10000));
    } catch {
      throw failure("展开状态无效");
    }
    if (
      !Array.isArray(expanded) ||
      expanded.length > 12 ||
      expanded.some((x) => typeof x !== "string" || x.length > 600)
    )
      throw failure("单个场景最多展开 12 个对象");
  }
  const nodes = new Map(),
    edges = new Map(),
    stopped = new Set();
  function addNode(item) {
    if (nodes.has(item.id)) return true;
    if (nodes.size >= MAX_NODES) {
      stopped.add("NODE_LIMIT");
      return false;
    }
    nodes.set(item.id, item);
    return true;
  }
  function addEdge(from, to, kind, label, key = "") {
    if (!nodes.has(from) || !nodes.has(to)) return;
    const id = `${from}>${kind}>${to}:${key}`;
    if (edges.has(id)) {
      const edge = edges.get(id);
      const labels = new Set(edge.labels || [edge.label]);
      labels.add(label);
      edge.labels = [...labels];
      edge.label = edge.labels.join(" / ");
      return;
    }
    if (edges.size >= MAX_EDGES) {
      stopped.add("EDGE_LIMIT");
      return;
    }
    edges.set(id, { id, source: from, target: to, kind, label });
  }
  addNode(root);
  addNode(focus);
  let fieldWriters;
  function expandTable(item) {
    const relations = tableRelations(ctx, item.id);
    const grouped = new Map();
    // Alternate writers and consumers so a high-fanout consumer list cannot hide the write branches.
    const ordered = [
      relations.filter((r) => r.kind === "WRITES"),
      relations.filter((r) => r.kind === "READS"),
    ];
    for (let i = 0; i < Math.max(...ordered.map((a) => a.length), 0); i++)
      for (const list of ordered) {
        const rel = list[i];
        if (!rel) continue;
        const key = `${rel.source}>${rel.kind}>${rel.target}`;
        if (!grouped.has(key)) grouped.set(key, rel);
      }
    const selected = [...grouped.values()];
    if (selected.length > 24) stopped.add("NEIGHBOR_LIMIT");
    for (const rel of selected.slice(0, 24)) {
      const other = object(
        ctx,
        rel.source === item.id ? rel.target : rel.source,
      );
      if (addNode(other)) {
        const props = json(rel.properties_json);
        addEdge(
          rel.source,
          rel.target,
          rel.kind,
          rel.kind === "READS"
            ? "读取"
            : props.writeEvidenceKind === "PLATFORM_TARGET_DECLARATION"
              ? "配置目标"
              : "写入观察",
        );
      }
    }
    if (item.catalogOnly) {
      for (const candidate of db
        .prepare(
          "SELECT * FROM objects WHERE kind='table' AND qualified_name=? LIMIT 5",
        )
        .all(item.qualifiedName)) {
        if (addNode(dto(candidate)))
          addEdge(item.id, candidate.id, "NAME_CANDIDATE", "同名加工对象候选");
      }
    }
  }
  function expandTask(item) {
    const relations = tableRelations(ctx, item.id);
    if (relations.length > 50) stopped.add("NEIGHBOR_LIMIT");
    for (const rel of relations.slice(0, 50)) {
      const target = rel.source === item.id ? rel.target : rel.source;
      if (addNode(object(ctx, target))) {
        const props = json(rel.properties_json);
        addEdge(
          rel.source,
          rel.target,
          rel.kind,
          rel.kind === "READS"
            ? "读取"
            : props.writeEvidenceKind === "PLATFORM_TARGET_DECLARATION"
              ? "配置目标"
              : "写入观察",
        );
      }
    }
    if (item.id === focusId) {
      for (const f of fields(ctx, item.id, { limit: 8 }).items)
        if (f.id && addNode(object(ctx, f.id)))
          addEdge(item.id, f.id, "OUTPUT_FIELD", "输出字段");
    }
  }
  function expandField(item) {
    const parent = object(ctx, item.tableId);
    addNode(parent);
    addEdge(parent.id, item.id, "HAS_FIELD", "字段");
    const branches = writers(ctx, parent, item.column);
    if (item.id === focusId) fieldWriters = branches;
    for (const branch of branches) {
      if (!addNode(object(ctx, branch.id))) continue;
      for (const expression of branch.expressions) {
        const status = expression.bindingStatus || "UNKNOWN";
        addEdge(branch.id, item.id, "FIELD_VALUE", `字段绑定 · ${status}`);
        for (const input of expression.inputs) {
          if (!input.table || !input.column) continue;
          const candidates = db
            .prepare(
              "SELECT DISTINCT o.* FROM relations r JOIN objects o ON o.id=r.source WHERE r.target=? AND r.kind='READS' AND o.qualified_name=?",
            )
            .all(branch.id, input.table.toLowerCase());
          if (candidates.length !== 1) {
            stopped.add("INPUT_IDENTITY_UNRESOLVED");
            continue;
          }
          const table = dto(candidates[0]),
            sourceId = fieldId(table.id, input.column);
          if (
            addNode({ ...object(ctx, sourceId), subtitle: table.qualifiedName })
          )
            addEdge(
              sourceId,
              branch.id,
              "FIELD_INPUT",
              `表达式输入 · ${input.occurrenceStatus || input.status || "UNKNOWN"}`,
            );
        }
      }
    }
  }
  function expandSchema(item) {
    const pg = paging(p);
    const result = search(ctx, {
      kind: "table",
      schema: item.schemaName,
      limit: Math.min(pg.limit, 24),
      offset: pg.offset,
      q: p.q,
    });
    for (const child of result.items)
      if (addNode(child)) addEdge(item.id, child.id, "CONTAINS", "对象");
    if (result.nextOffset !== null) stopped.add("SCHEMA_PAGE");
    return result;
  }
  let members;
  for (const id of new Set([rootId, ...expanded, focusId])) {
    const item = object(ctx, id);
    addNode(item);
    if (item.kind === "schema") members = expandSchema(item);
    else if (item.kind === "task") expandTask(item);
    else if (item.kind === "field") expandField(item);
    else expandTable(item);
  }
  const observations = [],
    questions = [];
  let branches = [],
    knowledge;
  if (["table", "view", "field"].includes(focus.kind)) {
    const table = focus.kind === "field" ? object(ctx, focus.tableId) : focus;
    branches = fieldWriters || writers(ctx, table, focus.column);
    if (focus.kind === "field") {
      observations.push({
        title: `比较 ${focus.column} 的写入分支`,
        text: "每个分支保留自己的写入观察、字段绑定和原始表达式。相同字段名不等于相同口径；输入字段与控制条件分别阅读。",
        basis: "当前固定版本的输出字段绑定",
      });
      const expressions = branches.flatMap((branch) =>
        branch.expressions.map((expression) => ({ branch, expression })),
      );
      if (
        new Set(expressions.map(({ expression }) => expression.text.trim()))
          .size > 1
      )
        observations.push({
          title: "同名字段使用了不同的表达式",
          text: expressions
            .map(
              ({ branch, expression }) =>
                `任务 ${branch.id.slice(5)}：${expression.text.replace(/\s+/g, " ")}`,
            )
            .join("；"),
          basis:
            "各写入分支的绑定表达式原文；可继续点击对应 SQL 行核对内层加工。",
        });
    } else if (branches.length > 1) {
      observations.push({
        title: "这张表有多个写入入口",
        text: "先比较各任务的写入范围和同名字段表达式，再判断它们是否能合并使用。点击字段可将分支公式与物理来源展开到图中。",
        basis: branches.map((b) => b.label).join("；"),
      });
    } else if (branches.length === 1) {
      observations.push({
        title: "沿写入任务解释表的形成",
        text: `点击 ${branches[0].label} 展开来源与输出字段，继续追到表达式和同版本 SQL。`,
        basis: "任务局部投影的最终写入观察",
      });
    } else
      observations.push({
        title: "此处保留了对象，尚未取得加工解释",
        text: "目录存在不代表已解析加工关系。可读已有定义候选；不会以调度邻居或名称相似补出血缘。",
        basis: "元数据目录与加工证据分开覆盖",
      });
    for (const b of branches)
      if (!b.available)
        observations.push({
          title: "写入证据当前不可读",
          text: b.reason || "请重建索引以对齐证据版本",
          basis: b.id,
        });
    const fieldPage = fields(ctx, table.id, { limit: 60 });
    for (const f of fieldPage.items
      .filter((f) =>
        /init_nom_prin|agt_id|accrued_date|busi_date/i.test(f.name),
      )
      .slice(0, 4))
      if (f.id) questions.push({ label: `穿透字段 ${f.name}`, id: f.id });
    const consumers = db
      .prepare(
        "SELECT DISTINCT o.* FROM relations r JOIN objects o ON o.id=r.target WHERE r.source=? AND r.kind='READS' ORDER BY o.id LIMIT 3",
      )
      .all(table.id);
    for (const consumer of consumers)
      questions.push({
        label: `继续看 ${safe(consumer.label)}`,
        id: consumer.id,
      });
  }
  if (focus.kind === "task") {
    const detail = taskAnalysis(ctx, focus.id);
    observations.push({
      title: detail.available
        ? "把输入、输出和处理条件分开读"
        : "该任务的加工证据存在缺口",
      text: detail.available
        ? "图上的来源与目标来自该任务的固定投影；字段区保留每个输出绑定。读取某张表并不表示它贡献了所有输出字段。"
        : detail.reason,
      basis: detail.source ? `投影 ${detail.cacheKey || ""}` : "任务库存",
    });
    branches = [
      {
        id: focus.id,
        label: focus.label,
        available: detail.available,
        outputs: detail.outputs || [],
        expressions: (detail.outputs || []).flatMap((o) =>
          (o.fields || []).map((f) => ({
            ...f,
            outputName: f.name,
            writeObservationId: o.writeObservationId,
          })),
        ),
        partition: (detail.outputs || [])
          .map((o) => o.partition)
          .filter(Boolean),
        evidence: detail.source || {},
      },
    ];
    try {
      const k = await readKnowledge(ctx, { id: focus.id.slice(5) });
      if (k.available) knowledge = { ...k, body: k.content };
    } catch {
      /* Shared knowledge is optional, not a substitute for missing processing evidence. */
    }
  }
  if (focus.kind === "schema")
    observations.push({
      title: "从一个真实对象继续深入",
      text: "这里按物理 schema 组织表和定义目录，不沿用调度主题充当 schema。选择对象后，继续看写入分支、来源字段与 SQL。",
      basis: "原信息 Hive 元信息 + 当前任务局部投影",
    });
  const defTable = focus.kind === "field" ? object(ctx, focus.tableId) : focus;
  for (const branch of branches) {
    const node = nodes.get(branch.id);
    if (!node) continue;
    const partition = branch.partition?.find(
      (value) =>
        value && typeof value === "object" && value.grp_id !== undefined,
    );
    node.subtitle = `任务 ${branch.id.slice(5)}${partition ? ` · 配置 grp_id=${partition.grp_id}` : ""}`;
  }
  const definitionCandidates = ["table", "view"].includes(defTable.kind)
    ? definitions(ctx, defTable)
        .slice(0, 12)
        .map((d) => {
          const parsed = parseDefinition(d.sql);
          return {
            id: d.id,
            hash: d.source_hash,
            objectType: parsed.objectType,
            description: safe(parsed.description),
            fields: parsed.fields?.slice(0, 40) || [],
            match:
              d.object_id === defTable.id
                ? "CATALOG_IDENTITY"
                : "NAME_ONLY_CANDIDATE",
            parseStatus: parsed.parseStatus,
            sqlPreview: safe(d.sql).split(/\r?\n/).slice(0, 80).join("\n"),
            totalLines: d.sql.split(/\r?\n/).length,
            previewTruncated: d.sql.split(/\r?\n/).length > 80,
          };
        })
    : [];
  return {
    sceneRootId: rootId,
    focus,
    nodes: neighborhoodLayout(
      [...nodes.values()],
      [...edges.values()],
      rootId,
    ).map((node) => ({
      ...node,
      x: node.x * 1.13,
      y: node.y * 1.19,
      width: 260,
      height: 106,
    })),
    edges: [...edges.values()],
    observations,
    writers: branches,
    fields: fields(ctx, focusId, { limit: 40 }),
    knowledge,
    questions,
    definitionCandidates,
    members,
    coverage: {
      version,
      text: "加工关系来自已保存的任务局部投影；schema 与定义来自原信息 Hive 快照。11 万任务可搜索，尚未解析的任务保留缺口。元数据同名候选不自动认作同一物理实例。",
    },
    truncated: stopped.size > 0,
    stoppedBy: [...stopped],
  };
}

export async function queryAnalysis(ctx, command, p = {}) {
  open(ctx);
  ctx = Object.assign(Object.create(ctx), { readCache: new Map() });
  if (command === "analysis-search") return search(ctx, p);
  if (command === "analysis-fields") return fields(ctx, string(p.id), p);
  if (command === "analysis-view") return view(ctx, p);
  if (command === "analysis-sql") {
    const id = string(p.id);
    const lineStart = int(p.lineStart, 1, 1000000),
      lineCount = int(p.lineCount, 100, 300);
    if (!lineStart || !lineCount) throw failure("SQL 行范围必须大于零");
    if (/^definition:[a-f0-9]{64}$/.test(id)) {
      const row = open(ctx)
        .db.prepare("SELECT * FROM definitions WHERE id=?")
        .get(id);
      if (!row) throw failure("定义不在当前快照中", "NOT_FOUND");
      const lines = safe(row.sql).split(/\r?\n/);
      return {
        available: true,
        sql: lines.slice(lineStart - 1, lineStart - 1 + lineCount).join("\n"),
        lineStart,
        lineCount: Math.max(
          0,
          Math.min(lineCount, lines.length - lineStart + 1),
        ),
        totalLines: lines.length,
        nextLine:
          lineStart - 1 + lineCount < lines.length
            ? lineStart + lineCount
            : null,
        contentSha256: row.source_hash,
        source: {
          kind: "CATALOG_DEFINITION",
          qualifiedName: row.qualified_name,
          match: "独立元数据定义记录，不等于已确认与同名加工对象属于同一实例",
        },
      };
    }
    if (!/^task:\d+$/.test(id))
      throw failure("请选择一个写入或读取任务查看 SQL");
    const ref = artifact(ctx, id);
    if (ref)
      return readTaskSql(ref, {
        lineStart,
        lineCount,
        slot: p.slot,
      });
    const result = readSql(ctx, {
      ...p,
      lineStart,
      lineCount,
      id: id.slice(5),
    });
    return { ...result, source: "调度证据库留存 SQL（尚未对应加工投影）" };
  }
  throw failure("未知分析命令");
}
