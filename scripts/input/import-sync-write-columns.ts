import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { canonicalHash, validateTaskDocument } from "./shared/input-pack.ts";
import { evidenceHash, writeColumnsFromSyncLog } from "./shared/write-column-evidence.ts";
import { loadHoraeDatasourceIndex } from "./shared/horae-datasource-cache.ts";

// Read the existing schedule-mcp-run-logs JSON from stdin. Raw logs are never
// persisted in the Pack; only the verified mapping and its provenance are saved.
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes("--task-path") || !args.includes("--data-date")) throw new Error("usage: import-sync-write-columns --task-path <task.json> --data-date <yyyy-MM-dd> [--apply]");
const taskPath = resolve(option("--task-path")!);
const original = readFileSync(taskPath, "utf8");
const task = JSON.parse(original);
validateTaskDocument(task);
if (!["hive2mysql", "hive2oracle", "hive2postgre", "hive2starrocks"].includes(task.taskCategory) || task.targetEvidenceKind !== "DIRECT_PLATFORM_TARGET")
  throw new Error("WRITE_COLUMNS_TASK_TYPE_UNSUPPORTED");
const query = (task.sqlFiles as {slot:string;path:string;sha256:string}[]).filter(s => s.slot === "query");
if (query.length !== 1) throw new Error("WRITE_COLUMNS_QUERY_AMBIGUOUS");
const queryPath = resolve(dirname(taskPath), query[0].path);
const rel = relative(dirname(taskPath), queryPath);
if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("WRITE_COLUMNS_QUERY_PATH_UNSAFE");
const sql = readFileSync(queryPath, "utf8");
if (evidenceHash(sql) !== query[0].sha256) throw new Error("WRITE_COLUMNS_QUERY_HASH_MISMATCH");
const rows = JSON.parse(readFileSync(0, "utf8").replace(/^\uFEFF/, ""));
if (!Array.isArray(rows) || rows.length !== 1 || String(rows[0].taskId) !== task.taskId ||
  String(rows[0].dataDate).slice(0,10) !== option("--data-date") || rows[0].logAvailable !== "Y" ||
  typeof rows[0].fullLogPreview !== "string" || rows[0].fullLogPreview.length !== Number(rows[0].fullLogChars))
  throw new Error("WRITE_COLUMNS_LOG_INCOMPLETE_OR_WRONG_TASK");
const evidence = writeColumnsFromSyncLog({taskId:task.taskId, target:task.target, query:sql,
  log:rows[0].fullLogPreview, dataDate:option("--data-date")!, observedAt:new Date().toISOString(),
  datasources:loadHoraeDatasourceIndex()});
const next = {...task, writeColumnEvidence:evidence};
next.contentHash = canonicalHash(next as unknown as Parameters<typeof canonicalHash>[0], ["collectedAt", "contentHash"]);
validateTaskDocument(next);
if (args.includes("--apply")) {
  if (readFileSync(taskPath,"utf8") !== original || readFileSync(queryPath,"utf8") !== sql) throw new Error("WRITE_COLUMNS_INPUT_CHANGED");
  const staged = taskPath + ".write-columns.tmp";
  writeFileSync(staged, JSON.stringify(next,null,2)+"\n", {flag:"wx"});
  renameSync(staged,taskPath);
}
console.log(JSON.stringify({taskId:task.taskId,applied:args.includes("--apply"),columns:evidence.columns,source:evidence.source,querySha256:evidence.querySha256}));
