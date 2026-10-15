import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export async function resolveKnowledgeDataRoot(
  configPath = process.env.LINEAGE_CONFIG ||
    resolve(repositoryRoot, "config/workspace-paths.json"),
) {
  const absoluteConfig = resolve(configPath);
  const config = JSON.parse(
    (await readFile(absoluteConfig, "utf8")).replace(/^\uFEFF/, ""),
  );
  if (typeof config.dataRoot !== "string" || !config.dataRoot.trim())
    throw new Error("Knowledge: workspace config requires dataRoot");
  return resolve(dirname(absoluteConfig), config.dataRoot.trim());
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => {
  throw new Error(`Knowledge: ${message}`);
};
const requireText = (value, name) => {
  if (typeof value !== "string" || !value.trim()) fail(`missing ${name}`);
};

// Loading authored knowledge deliberately does not require a graph or evidence file.
export async function loadTaskKnowledge(taskId, { root } = {}) {
  if (typeof taskId !== "string" || !/^\d+$/.test(taskId))
    fail("task ID must contain digits only");
  root ??= await resolveKnowledgeDataRoot();
  const source = `knowledge/tasks/${taskId}.json`;
  let jsonText, markdown;
  try {
    [jsonText, markdown] = await Promise.all([
      readFile(resolve(root, source), "utf8"),
      readFile(resolve(root, `knowledge/tasks/${taskId}.md`), "utf8"),
    ]);
  } catch (error) {
    if (error.code === "ENOENT") fail(`missing knowledge for task ${taskId}`);
    throw error;
  }
  let authored;
  try {
    authored = JSON.parse(jsonText);
  } catch {
    fail(`invalid JSON for task ${taskId}`);
  }
  if (authored.schemaVersion !== 1 || authored.taskId !== taskId)
    fail(`schema or task identity mismatch: ${taskId}`);
  for (const key of ["title", "summary", "boundary"])
    requireText(authored[key], key);
  for (const key of ["topics", "duties"])
    if (
      !Array.isArray(authored.tags?.[key]) ||
      authored.tags[key].some((tag) => typeof tag !== "string" || !tag.trim())
    )
      fail(`invalid tags.${key}: ${taskId}`);
  if (
    authored.review?.origin !== "agent_curated" ||
    authored.review?.status !== "sql_reviewed_business_unconfirmed"
  )
    fail(`unsupported review status: ${taskId}`);
  requireText(authored.evidence?.path, "evidence.path");
  if (
    authored.evidence.slot !== "query" ||
    ![undefined, "published_evidence", "retained_excerpt"].includes(
      authored.evidence.kind,
    ) ||
    !/^[a-f0-9]{64}$/.test(authored.evidence.querySha256)
  )
    fail(`invalid query evidence binding: ${taskId}`);
  if (!Array.isArray(authored.observations))
    fail(`missing observations: ${taskId}`);
  for (const observation of authored.observations) {
    if (!["expression", "relation"].includes(observation.kind))
      fail(`unsupported observation kind: ${taskId}`);
    requireText(observation.id, "observation.id");
    requireText(observation.label, "observation.label");
  }
  return {
    ...authored,
    knowledgeId: `task:${taskId}`,
    knowledgeRevision: digest(JSON.stringify([jsonText, markdown])),
    source,
    markdown,
    evidenceCheck: { status: "not_checked" },
  };
}

// Verify only the evidence actually cited by the authored explanation.
// This does not establish business correctness or full publication equivalence.
export async function verifyTaskKnowledge(record, { root } = {}) {
  root ??= await resolveKnowledgeDataRoot();
  let raw;
  try {
    raw = JSON.parse(
      await readFile(resolve(root, record.evidence.path), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT")
      fail(
        `missing evidence for task ${record.taskId}; knowledge remains readable without verification`,
      );
    throw error;
  }
  if (String(raw.taskId) !== record.taskId)
    fail(`evidence task identity mismatch: ${record.taskId}`);
  const retained = record.evidence.kind === "retained_excerpt";
  if (retained && raw.kind !== "retained_task_evidence_v1")
    fail(`invalid retained evidence kind: ${record.taskId}`);
  const sources = retained ? [raw.query] : (raw.sqlSources ?? []);
  const queries = sources.filter((source) => source?.slot === "query");
  if (queries.length !== 1 || typeof queries[0].content !== "string")
    fail(`expected one query slot: ${record.taskId}`);
  const query = queries[0];
  const sqlSha256 = digest(query.content);
  if (sqlSha256 !== query.sha256 || sqlSha256 !== record.evidence.querySha256)
    fail(`SQL digest mismatch; review knowledge for task ${record.taskId}`);
  const observations = record.observations.map((reference) => {
    const expression = reference.kind === "expression";
    const rows = retained
      ? (raw.observations ?? [])
      : (raw[expression ? "expressions" : "relations"] ?? []);
    const matches = rows.filter((row) =>
      retained
        ? row.kind === reference.kind && row.id === reference.id
        : row[expression ? "expression_id" : "relation_id"] === reference.id,
    );
    if (matches.length !== 1)
      fail(`missing or ambiguous observation: ${reference.id}`);
    const row = matches[0];
    if (
      !retained &&
      !row.statement_id?.startsWith(
        `task:${record.taskId}:slot:query:statement:`,
      )
    )
      fail(`observation query identity mismatch: ${reference.id}`);
    const { start, end } = (retained ? row.sourceSpan : row.source_span) ?? {};
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > query.content.length
    )
      fail(`invalid observation span: ${reference.id}`);
    const text = query.content.slice(start, end);
    if (
      text !==
      (retained
        ? row.text
        : row[expression ? "expression_text" : "source_text"])
    )
      fail(`observation span does not match query text: ${reference.id}`);
    return {
      ...reference,
      text,
      sourceSpan: { start, end },
      startLine: query.content.slice(0, start).split("\n").length,
      endLine: query.content.slice(0, end - 1).split("\n").length,
    };
  });
  return {
    ...record,
    observations,
    evidenceCheck: {
      status: "matched",
      sqlSha256,
      sourceKind: retained ? "retained_excerpt" : "published_evidence",
    },
  };
}
