import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { failure, queryMap, repositoryRoot } from "./query.mjs";
import { loadTaskKnowledge } from "../knowledge/task-knowledge.mjs";

export function redact(value) {
  return String(value ?? "")
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
}
export function readSql(ctx, params) {
  const result = queryMap(ctx, "task", { id: params.id });
  const candidates = result.evidence.filter((r) =>
    ["hive-task", "run-script"].includes(r.evidenceType),
  );
  if (!candidates.length)
    return {
      available: false,
      reason: "此任务没有已记录的 SQL 证据",
      taskId: params.id,
    };
  const start = Number(params.lineStart ?? 1),
    count = Number(params.lineCount ?? 120);
  if (
    !Number.isInteger(start) ||
    start < 1 ||
    start > 1000000 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 300
  )
    throw failure("SQL 行范围无效");
  const source = JSON.parse(
    ctx.db.prepare("SELECT value FROM meta WHERE key = 'sourcePath'").get()
      .value,
  );
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
  } catch {
    return {
      available: false,
      reason: "原始 SQL 证据库当前不可读取",
      taskId: params.id,
    };
  }
  try {
    for (const ref of candidates) {
      const row = db
        .prepare(
          "SELECT format,payload_text,payload_json,content_sha256 FROM evidence WHERE task_id=? AND evidence_type=? AND direction=? AND depth=?",
        )
        .get(params.id, ref.evidenceType, ref.direction, ref.depth);
      if (!row || row.content_sha256 !== ref.contentSha256) continue;
      let sql = row.format === "sql" ? row.payload_text : null;
      if (!sql && row.payload_json) {
        const body = JSON.parse(row.payload_json);
        sql = typeof body.sql === "string" ? body.sql : null;
      }
      if (typeof sql !== "string") continue;
      if (
        row.format === "sql" &&
        createHash("sha256").update(sql).digest("hex") !== ref.contentSha256
      )
        continue;
      const safe = redact(sql),
        lines = safe.split(/\r?\n/);
      return {
        available: true,
        taskId: params.id,
        evidenceType: ref.evidenceType,
        observedAt: ref.observedAt,
        contentSha256: ref.contentSha256,
        totalLines: lines.length,
        lineStart: start,
        lineCount: Math.max(0, Math.min(count, lines.length - start + 1)),
        sql: lines.slice(start - 1, start - 1 + count).join("\n"),
        hasMore: start - 1 + count < lines.length,
        redacted: safe !== sql,
        boundary:
          "固定证据哈希匹配；静态 SQL，不代表运行结果或业务口径已验证。",
      };
    }
    return {
      available: false,
      taskId: params.id,
      reason: "原始 SQL 已变化或不可匹配本快照；重建后可读取对应版本",
    };
  } finally {
    db.close();
  }
}
export async function readKnowledge(ctx, params) {
  queryMap(ctx, "task", { id: params.id });
  const configPath = resolve(
    process.env.LINEAGE_CONFIG ||
      resolve(repositoryRoot, "config/workspace-paths.json"),
  );
  const config = JSON.parse(
    readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""),
  );
  const root = resolve(dirname(configPath), config.dataRoot);
  try {
    const result = await loadTaskKnowledge(params.id, { root });
    return {
      available: true,
      taskId: params.id,
      title: result.title || result.record?.title || "公共知识",
      content: redact(result.markdown || result.text || ""),
      boundary:
        "公共知识按任务身份关联，独立于调度快照；适用范围和待确认事项以文稿为准。",
    };
  } catch (e) {
    if (/missing knowledge/.test(e.message))
      return {
        available: false,
        taskId: params.id,
        reason: "此任务尚无公共知识稿",
      };
    return {
      available: false,
      taskId: params.id,
      reason: "公共知识稿未通过结构校验",
    };
  }
}
