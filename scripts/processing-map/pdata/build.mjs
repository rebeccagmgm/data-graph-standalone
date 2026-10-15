import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { observations } from "./content.mjs";
import { parsePlacement } from "./placement.mjs";
import { buildRegion } from "./model.mjs";
import { knowledge } from "./knowledge.mjs";
import { loadUnderstanding } from "./understanding.mjs";
import { reading } from "./reading.mjs";
import { compileNarrative } from "./narrative.mjs";
import {
  loadTaskKnowledge,
  verifyTaskKnowledge,
} from "../../knowledge/task-knowledge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
// Keep source SQL line numbers while omitting environment information.
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
      /((?:password|passwd|secret|token|access[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
      "$1[已省略]",
    );

const network = await json(
  resolve(root, "tmp/processing-skeleton/table-network.json"),
);
const placementText = await readFile(
  resolve(root, "docs/processing-map/pdata-output-placement.md"),
  "utf8",
);
const placement = parsePlacement(placementText, network);
const region = buildRegion(network, placement.branches);
const directInputs = new Set(
  region.tasks
    .filter((t) => region.writerIds.includes(t.id))
    .flatMap((t) => t.inputs),
);
region.counts.directReadOnly = region.tables.filter(
  (t) => t.scope === "read-only" && directInputs.has(t.name),
).length;
region.counts.consumerReadOnly =
  region.counts.readOnly - region.counts.directReadOnly;
const config = await json(resolve(root, "config/workspace-paths.json"));
const dataRoot = resolve(root, "config", config.dataRoot);
const evidence = {},
  definitions = {};
const sqlIssues = [];
for (const id of [...region.writerIds, ...Object.keys(reading.consumers)]) {
  const directory = resolve(
    dataRoot,
    config.projectionRoot ?? "task-projections",
    "tasks",
    id,
  );
  let entry;
  try {
    const files = (await readdir(resolve(directory, "versions"))).filter(
      (name) => /\.evidence-v\d+\.json$/.test(name),
    );
    const reviewedFile = placement.refs[`ev-${id}`]?.split("/").at(-1);
    if (reviewedFile) entry = files.find((name) => name === reviewedFile);
    else if (files.length === 1) entry = files[0];
    else {
      const envelope = await json(
        resolve(directory, "task-local-projection.json"),
      );
      entry = files.find(
        (name) => name === `${envelope.cacheKey}.evidence-v3.json`,
      );
    }
    if (!entry) throw new Error("EVIDENCE_SELECTION_UNAVAILABLE");
    const body = await json(resolve(directory, "versions", entry));
    if (String(body.taskId) !== id) throw new Error("TASK_ID_MISMATCH");
    for (const s of body.sqlSources ?? [])
      if (typeof s.content !== "string" || digest(s.content) !== s.sha256)
        throw new Error("SQL_HASH_MISMATCH");
    const query = body.sqlSources?.find((s) => s.slot === "query");
    const create = body.sqlSources?.find((s) => s.slot === "create");
    const note = observations[id];
    if (note && query?.sha256 !== note.sha256)
      throw new Error("REVIEWED_SQL_CHANGED");
    evidence[id] = {
      sql: query ? redact(query.content) : "",
      ddl: create ? redact(create.content) : "",
      sha256: query?.sha256 ?? null,
      evidenceFile: basename(entry),
      note: note ?? null,
      basis:
        id === "230202"
          ? "补充 v3 SQL；固定网络采用的 v2 留存缺失，两个版本口径是否一致未证。"
          : "定位文档对应的本地任务 SQL 留存；不是运行记录。除已核说明外，未逐条解释加工语义。",
    };
    const comments = [
      ...(create?.content ?? "").matchAll(/\)\s*COMMENT\s+'([^']*)'/gi),
    ].map((m) => m[1]);
    const task = region.tasks.find((t) => t.id === id);
    // Use the final table comment only for a single graph output.
    if (task.outputs.length === 1 && comments.length)
      definitions[task.outputs[0]] ??= redact(comments.at(-1));
  } catch (error) {
    if (observations[id] || reading.consumers[id])
      throw new Error(
        `REVIEWED_EVIDENCE_UNAVAILABLE: ${id}: ${error.code ?? error.message}`,
      );
    sqlIssues.push(id);
  }
}
for (const task of region.tasks) task.name = redact(task.name);
const cookbookRoot = resolve(root, "../../股衍数据-Cookbook");
const knowledgeNotes = await Promise.all(
  knowledge.map(async (note) => {
    const source = await readFile(resolve(cookbookRoot, note.source), "utf8");
    const lines = source.split(/\r?\n/);
    return {
      ...note,
      sourceTitle:
        /^title:\s*(.+)$/m.exec(source)?.[1] ?? basename(note.source, ".md"),
      reviewedAt: /^reviewed_at:\s*(.+)$/m.exec(source)?.[1] ?? "日期未标明",
      maturity: /^maturity:\s*(.+)$/m.exec(source)?.[1] ?? "状态未标明",
      sourceSha256: digest(source),
      excerpts: note.ranges.map(([start, end]) => ({
        start,
        end,
        text: redact(lines.slice(start - 1, end).join("\n")),
      })),
    };
  }),
);
const { records: processingAnalyses, standards } = await loadUnderstanding(
  root,
  region,
  evidence,
);
for (const record of processingAnalyses) {
  if (!record.narrativeFile) continue;
  const markdown = await readFile(resolve(here, record.narrativeFile), "utf8");
  record.narrative = compileNarrative(markdown, record);
}
for (const [id, consumer] of Object.entries(reading.consumers))
  if (consumer.sha256 !== evidence[id]?.sha256)
    throw new Error(`CONSUMER_SQL_CHANGED: ${id}`);
for (const [branchId, guide] of Object.entries(reading.categories)) {
  if (!region.branches.some((b) => b.id === branchId))
    throw new Error(`CATEGORY_UNKNOWN: ${branchId}`);
  for (const connection of guide.connections) {
    const task = region.tasks.find((t) => t.id === connection.id);
    if (
      !task ||
      (connection.inputs === "explained" &&
        !processingAnalyses.some((r) => r.taskId === task.id))
    )
      throw new Error(`CATEGORY_TASK_MISSING: ${connection.id}`);
    if (Array.isArray(connection.inputs))
      for (const name of connection.inputs)
        if (!task.inputs.includes(name))
          throw new Error(`CATEGORY_READ_MISSING: ${task.id}:${name}`);
  }
}
for (const record of processingAnalyses) {
  for (const stage of record.stages)
    for (const parent of stage.parents ?? [])
      if (!record.stages.some((s) => s.id === parent))
        throw new Error(`STAGE_PARENT_MISSING: ${record.taskId}:${parent}`);
}
const sources = {};
for (const name of [
  "pdata-output-placement.md",
  "pdata调研v1.md",
  "pdata调研v2.md",
])
  sources[name] = await readFile(
    resolve(root, "docs/processing-map", name),
    "utf8",
  );
const shared = await verifyTaskKnowledge(
  await loadTaskKnowledge("107491", { root: dataRoot }),
  { root: dataRoot },
);
if (shared.evidenceCheck.sqlSha256 !== evidence["107491"]?.sha256)
  throw new Error("SHARED_KNOWLEDGE_SQL_MISMATCH: 107491");
const data = {
  ...region,
  definitions,
  placement: {
    records: placement.records,
    counts: placement.counts,
    refs: placement.refs,
    questions: placement.questions,
  },
  reading,
  sources,
  evidence,
  knowledgeNotes,
  processingAnalyses,
  standards,
  sharedKnowledge: {
    107491: {
      title: shared.title,
      summary: shared.summary,
      boundary: shared.boundary,
      knowledgeRevision: shared.knowledgeRevision,
      source: shared.source,
    },
  },
  sqlIssues,
  builtAt: new Date().toISOString(),
  scope: {
    source: "用户确认的取数范围",
    ingressSeeds: 870,
    ingressClosure: 4316,
    ingressHops: 11,
    otcSeeds: 992,
    otcClosure: 84147,
    otcHops: 12,
    intersection: 3615,
  },
};
const [template, style, navigation, graph, readingView, categoryView, script] =
  await Promise.all(
    [
      "template.html",
      "style.css",
      "navigation.js",
      "graph.js",
      "reading-view.js",
      "category-view.js",
      "view.js",
    ].map((name) => readFile(resolve(here, name), "utf8")),
  );
const serialized = JSON.stringify(data)
  .replaceAll("<", "\\u003c")
  .replaceAll("\u2028", "\\u2028")
  .replaceAll("\u2029", "\\u2029");
const html = template
  .replace("/*__STYLE__*/", () => style)
  .replace("/*__DATA__*/ null", () => serialized)
  .replace(
    "/*__SCRIPT__*/",
    () => `${navigation}\n${graph}\n${readingView}\n${categoryView}\n${script}`,
  );
const output = resolve(root, "docs/processing-map-pdata.html");
await writeFile(output, html, "utf8");
const summary = {
  output,
  counts: region.counts,
  branches: region.branches.map((b) => ({
    id: b.id,
    tables: b.tables.length,
    tasks: b.taskIds.length,
  })),
  sqlAvailable: Object.keys(evidence).length,
  knowledgeSources: knowledgeNotes.length,
  sqlIssues,
  bytes: Buffer.byteLength(html),
};
await mkdir(resolve(root, "tmp/processing-map-pdata"), { recursive: true });
await writeFile(
  resolve(root, "tmp/processing-map-pdata/build-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary));
