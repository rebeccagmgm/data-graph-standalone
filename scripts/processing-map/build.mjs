import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import {
  views,
  taskNotes,
  snapshotVersion,
  saleTable,
  sharedKnowledge,
  sourceTopicDefinitions,
} from "./content.mjs";
import { verifyTaskKnowledge, resolveKnowledgeDataRoot } from "../knowledge/task-knowledge.mjs";
import { renderReading } from "./reading.mjs";
import { buildSourceTopicAnalysis } from "./source-analysis.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const json = async (path) => JSON.parse(await read(path));
const fixedSql = await json("docs/processing-map/fixed-sql.json");
if (
  fixedSql.kind !== "retained_map_sql_v1" ||
  fixedSql.snapshotVersion !== snapshotVersion
)
  throw new Error("Fixed SQL bindings do not match the authored snapshot");
const [network, flows, schemas, writers] = await Promise.all([
  json("tmp/processing-skeleton/table-network.json"),
  json("tmp/processing-skeleton/schema-flows.json"),
  json("tmp/processing-skeleton/schema-summary.json"),
  json("tmp/otc-principal-value-case/four-writer-evidence.json"),
]);
if (network.version !== snapshotVersion)
  throw new Error(
    "Snapshot changed: review the authored explanations before rebuilding.",
  );
const taskIndex = new Map(network.tasks.map((t) => [t.taskId, t]));
const flowIndex = new Map(flows.map((f) => [`${f.from}>${f.to}`, f]));
const sourceTopics = sourceTopicDefinitions.map((definition) =>
  buildSourceTopicAnalysis({ definition, flows, schemas }),
);
const sourceTopicIndex = new Map(sourceTopics.map((topic) => [topic.id, topic]));
for (const f of flows) {
  if (
    new Set(f.taskIds).size !== f.tasks ||
    f.taskIds.some((id) => !taskIndex.has(id))
  )
    throw new Error(`Invalid flow membership: ${f.from} > ${f.to}`);
  for (const id of f.taskIds) {
    const t = taskIndex.get(id);
    if (
      !t.inputs.some((x) => x.table.split(".")[0] === f.from) ||
      !t.outputs.some((x) => x.table.split(".")[0] === f.to)
    )
      throw new Error(`Flow does not match task ${id}`);
  }
}
for (const view of Object.values(views)) {
  const ids = new Set(view.nodes.map((n) => n.id));
  if (ids.size !== view.nodes.length)
    throw new Error("Duplicate node identity");
  for (const n of view.nodes) {
    if (n.view && !views[n.view]) throw new Error(`Unknown view: ${n.view}`);
    if (n.sourceTopic && !sourceTopicIndex.has(n.sourceTopic))
      throw new Error(`Unknown source topic: ${n.sourceTopic}`);
    for (const id of n.tasks ?? [])
      if (!taskIndex.has(id)) throw new Error(`Unknown task: ${id}`);
  }
  for (const e of view.edges) {
    if (!ids.has(e.from) || !ids.has(e.to))
      throw new Error("Unknown edge endpoint");
    for (const [a, b] of e.pairs ?? [])
      if (!flowIndex.has(`${a}>${b}`))
        throw new Error(`Missing authored flow: ${a} > ${b}`);
  }
}

// Remove environment addresses from reader-facing text; keep line count for SQL references.
const clean = (text) =>
  String(text ?? "")
    .replace(
      /(?:https?:\/\/|jdbc:|hdfs:\/\/)[^\s"'<>`，）)]+/gi,
      "[环境地址已省略]",
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[环境地址已省略]")
    .replace(/[A-Z]:[\\/][^\r\n"'<>`)]+/gi, "[本地证据文件]");
const notReviewed = new Set(["230202", "231146", "229121", "149048"]);
const evidence = {};
for (const id of Object.keys(taskNotes)) {
  if (notReviewed.has(id)) continue;
  if (!taskIndex.has(id)) throw new Error(`Missing representative task: ${id}`);
  const binding = fixedSql.tasks[id];
  if (
    !binding ||
    binding.redacted !== false ||
    typeof binding.sql !== "string" ||
    createHash("sha256").update(binding.sql).digest("hex") !==
      binding.querySha256
  )
    throw new Error(`Retained SQL digest mismatch: ${id}`);
  evidence[id] = {
    slot: "query",
    sha256: binding.querySha256,
    sql: clean(binding.sql),
    partition: binding.partition,
    redacted: clean(binding.sql) !== binding.sql,
    binding: "retained-fixed-sql",
  };
}
const knowledge = {};
for (const [id, record] of Object.entries(sharedKnowledge)) {
  knowledge[id] = await verifyTaskKnowledge(record);
  if (knowledge[id].evidenceCheck.sqlSha256 !== evidence[id]?.sha256)
    throw new Error(`Knowledge and map query mismatch: ${id}`);
}
for (const w of writers) {
  const t = taskIndex.get(w.taskId);
  if (w.evidencePath !== t?.evidencePath)
    throw new Error(`Principal evidence version mismatch: ${w.taskId}`);
}
const documents = {};
for (const [key, path] of Object.entries({
  skeleton: "docs/processing-skeleton-v0.md",
  principal: "docs/value-case-otc-principal.md",
  inventory: "docs/processing-skeleton-inventory.md",
})) {
  documents[key] = { path, text: clean(await read(path)) };
}
const knowledgeRoot = await resolveKnowledgeDataRoot();
const readingLinks = {
  "../evidence/sales-contract-to-income.md": "salesEvidence",
  "../scenarios/sales-contract-to-income.md": "salesIncome",
  "../../../sql-static-lineage/docs/value-case-otc-principal.md": "principal",
  "../../../sql-static-lineage/docs/processing-skeleton-v0.md": "skeleton",
  "../../../sql-static-lineage/docs/processing-map/fixed-sql.json": "fixedSql",
  "107491.json": "task:107491",
};
for (const [key, path] of Object.entries({
  salesIncome: "knowledge/scenarios/sales-contract-to-income.md",
  salesEvidence: "knowledge/evidence/sales-contract-to-income.md",
})) {
  const original = await readFile(resolve(knowledgeRoot, path), "utf8");
  documents[key] = {
    path, text: clean(original), html: renderReading(clean(original), readingLinks),
    revision: createHash("sha256").update(original).digest("hex"),
  };
}
for (const doc of [documents.salesIncome, documents.salesEvidence]) {
  for (const match of doc.html.matchAll(/data-reading="([^"]+)" data-anchor="([^"]+)"/g)) {
    if (!documents[match[1]]?.html?.includes(`id="reading-${match[2]}"`))
      throw new Error(`Missing reading anchor: ${match[1]}#${match[2]}`);
  }
}
const data = {
  version: network.version,
  publishedAt: network.publishedAt,
  exportedAt: network.exportedAt,
  counts: network.counts,
  coverage: network.coverage,
  views,
  sourceTopics,
  taskNotes,
  knowledge,
  saleTable,
  flows,
  schemas,
  evidence,
  documents,
  tasks: network.tasks.map((t) => ({
    id: t.taskId,
    name: clean(t.name),
    category: t.category,
    coverage: t.coverage,
    inputs: t.inputs,
    outputs: t.outputs,
  })),
  tables: network.tables.map((t) => ({
    id: t.id,
    name: t.table,
    readers: t.readers,
    writers: t.writers,
  })),
  writers: writers.map((w) => ({
    id: w.taskId,
    partition: w.partition,
    expressions: w.expressions.map((e) => ({
      name: e.output_name,
      role: e.role,
      text: e.expression_text,
      inputs: e.input_fields?.map((i) => ({
        table: i.table,
        column: i.column,
      })),
      span: e.source_span,
    })),
  })),
};
const [template, style, script] = await Promise.all(
  ["template.html", "view.css", "view.js"].map((name) =>
    readFile(resolve(here, name), "utf8"),
  ),
);
const serialized = JSON.stringify(data)
  .replaceAll("<", "\\u003c")
  .replaceAll("\u2028", "\\u2028")
  .replaceAll("\u2029", "\\u2029");
if (!/\/\*__DATA__\*\/\s*null/.test(template)) {
  throw new Error("Template data placeholder is missing");
}
const html = template
  .replace("/*__STYLE__*/", () => style)
  .replace(/\/\*__DATA__\*\/\s*null/, () => serialized)
  .replace("/*__SCRIPT__*/", () => script);
const output = resolve(root, "docs/processing-map.html");
// Build the full-page OData drilldown before updating its overview entry.
await import("./odata/build.mjs");
await writeFile(output, html, "utf8");
console.log(
  JSON.stringify({
    output,
    bytes: Buffer.byteLength(html),
    views: Object.keys(views).length,
    tasks: data.tasks.length,
    flows: flows.length,
    fixedSqlSamples: Object.keys(evidence).length,
  }),
);
