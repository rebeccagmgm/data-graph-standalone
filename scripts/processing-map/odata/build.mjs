import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegion, verifySql, redact } from "./model.mjs";
import { groups, methods, observations } from "./content.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const networkRaw = await readFile(
  resolve(root, "tmp/processing-skeleton/table-network.json"),
);
const network = JSON.parse(networkRaw.toString("utf8"));
const analysis = await readJson(
  resolve(root, "docs/processing-map/odata-region-analysis-evidence.json"),
);
if (
  createHash("sha256").update(networkRaw).digest("hex") !==
  analysis.scope.networkSha256
)
  throw new Error("ANALYZED_NETWORK_CHANGED");
const config = await readJson(resolve(root, "config/workspace-paths.json"));
const dataRoot = resolve(root, "config", config.dataRoot);
const preliminary = buildRegion({ network, analysis, groups });
const wanted = new Set(
  preliminary.tasks.flatMap((t) => [...t.inputs, ...t.outputs]),
);
const tableRoot = resolve(dataRoot, "tables/hive");
const directories = (await readdir(tableRoot, { withFileTypes: true })).filter(
  (e) => e.isDirectory() && wanted.has(e.name.split("__")[0]),
);
const candidates = new Map();
for (let i = 0; i < directories.length; i += 40) {
  const records = await Promise.all(
    directories.slice(i, i + 40).map(async (entry) => {
      try {
        return await readJson(resolve(tableRoot, entry.name, "table.json"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }),
  );
  for (const record of records) {
    if (!record?.description) continue;
    const text = redact(record.description)
      .replace(/<[^>]*>/g, "")
      .replace(/【AI】/g, "")
      .trim();
    if (text) {
      const list = candidates.get(record.qualifiedName) ?? [];
      list.push({ text, ai: record.description.includes("【AI】") });
      candidates.set(record.qualifiedName, list);
    }
  }
}
const definitions = Object.fromEntries(
  [...candidates]
    .filter(([, entries]) => new Set(entries.map((e) => e.text)).size === 1)
    .map(([name, entries]) => [name, entries[0]]),
);
const region = buildRegion({ network, analysis, groups, definitions });
const bindings = new Map(analysis.sqlEvidence.map((e) => [e.taskId, e.sha256]));
for (const id of Object.keys(observations))
  if (!bindings.has(id))
    throw new Error(`OBSERVATION_WITHOUT_SQL_BINDING: ${id}`);
const evidence = {},
  unavailableSql = [];
for (let i = 0; i < region.tasks.length; i += 35) {
  const records = await Promise.all(
    region.tasks.slice(i, i + 35).map(async (task) => {
      try {
        const raw = await readFile(
          resolve(dataRoot, "tasks", task.category, task.id, "sql/query.sql"),
        );
        const sha256 = verifySql(task.id, raw, bindings.get(task.id));
        const original = raw.toString("utf8").replace(/^\uFEFF/, "");
        return [
          task.id,
          { sha256, sql: redact(original), reviewed: bindings.has(task.id) },
        ];
      } catch (error) {
        if (error.code === "ENOENT" && !bindings.has(task.id))
          return [task.id, null];
        throw error;
      }
    }),
  );
  for (const [id, record] of records) {
    if (record) evidence[id] = record;
    else unavailableSql.push(id);
  }
}
const data = {
  ...region,
  methods: region.methods.map((m) => ({ ...m, ...methods[m.id] })),
  observations,
  evidence,
  unavailableSql,
  analyzedAt: analysis.analysisDate,
};
const [template, css, js] = await Promise.all(
  ["template.html", "style.css", "view.js"].map((name) =>
    readFile(resolve(here, name), "utf8"),
  ),
);
const payload = JSON.stringify(data)
  .replaceAll("<", "\\u003c")
  .replaceAll("\u2028", "\\u2028")
  .replaceAll("\u2029", "\\u2029");
const html = template
  .replace("/*__STYLE__*/", () => css)
  .replace("/*__DATA__*/ null", () => payload)
  .replace("/*__SCRIPT__*/", () => js);
const output = resolve(root, "docs/processing-map-odata.html");
await writeFile(output, html, "utf8");
const summary = {
  output,
  counts: region.counts,
  groups: region.groups.map((g) => ({
    id: g.id,
    tables: g.tableNames.length,
    families: g.familyIds.length,
  })),
  sqlAvailable: Object.keys(evidence).length,
  reviewedSql: bindings.size,
  missingSql: unavailableSql.length,
  bytes: Buffer.byteLength(html),
};
await mkdir(resolve(root, "tmp/processing-map-odata"), { recursive: true });
await writeFile(
  resolve(root, "tmp/processing-map-odata/build-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary));
