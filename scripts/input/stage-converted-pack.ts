import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalHash, sha256Text, validateTaskDocument, type JsonValue } from "./shared/input-pack.ts";
import { convertSqlInput } from "./convert-sql-input.ts";
import { taskSqlDialect } from "../plans/task-sql-dialect.ts";
import { buildStandardizedSql } from "./shared/standardized-sql.ts";

/** Stage one task into a new isolated data root; never overwrite a source Pack. */
export function stageConvertedPack(taskFile: string, outputRoot: string, parameters: Record<string, string> = {}) {
  const rawDocument = readFileSync(taskFile, "utf8");
  const document = JSON.parse(rawDocument);
  validateTaskDocument(document);
  if (canonicalHash(document as unknown as JsonValue, ["collectedAt", "contentHash"]) !== document.contentHash) throw new Error("TASK_HASH_MISMATCH");
  const conversions = document.sqlFiles.map(value => {
    const file = value as { slot: string; path: string; sha256: string; evidenceProvider: string };
    const sql = readFileSync(join(dirname(taskFile), file.path), "utf8");
    if (sha256Text(sql) !== file.sha256) throw new Error(`SQL_HASH_MISMATCH:${file.slot}`);
    return { file, conversion: convertSqlInput(sql, taskSqlDialect(String(document.taskCategory)), parameters) };
  });
  const fatal = conversions.flatMap(c => c.conversion.gaps.filter(g => g !== "SYMBOLIC_PARAMETERS_RETAINED"));
  if (fatal.length) throw new Error(`CONVERSION_BLOCKED:${[...new Set(fatal)].join(",")}`);
  // Existing write-scoped partition evidence contains source coordinates and values.
  // Rebinding that evidence needs a separate validated adapter.
  if (conversions.some(c => c.conversion.sourceSha256 !== c.conversion.convertedSha256) && document.partition !== null) {
    throw new Error("PARTITION_EVIDENCE_REBIND_REQUIRED");
  }
  const next = { ...document, sqlFiles: conversions.map(({ file, conversion }) => ({ ...file,
    sha256: conversion.convertedSha256,
    evidenceProvider: conversion.sourceSha256 === conversion.convertedSha256 ? file.evidenceProvider : `local:sql-input-conversion-v1:${file.sha256}` })) };
  next.contentHash = canonicalHash(next as unknown as JsonValue, ["collectedAt", "contentHash"]);
  validateTaskDocument(next);
  // Exclusive root creation prevents partial overwrites and accidental in-place use.
  mkdirSync(outputRoot);
  const target = join(outputRoot, "tasks", String(document.taskCategory), String(document.taskId));
  mkdirSync(join(target, "sql"), { recursive: true });
  mkdirSync(join(outputRoot, "conversion-evidence"));
  writeFileSync(join(target, "task.json"), JSON.stringify(next, null, 2) + "\n", { flag: "wx" });
  const standardized = buildStandardizedSql(String(next.taskId), next.contentHash, taskSqlDialect(String(next.taskCategory)),
    conversions.map(({file, conversion}) => ({ slot: file.slot, content: conversion.convertedSql })));
  writeFileSync(join(target, "standardized-sql.json"), JSON.stringify(standardized, null, 2) + "\n", { flag: "wx" });
  writeFileSync(join(outputRoot, "conversion-evidence", "original-task.json"), rawDocument, { flag: "wx" });
  for (const { file, conversion } of conversions) {
    writeFileSync(join(target, file.path), conversion.convertedSql, { flag: "wx" });
    writeFileSync(join(outputRoot, "conversion-evidence", `${file.slot}.json`), JSON.stringify(conversion, null, 2) + "\n", { flag: "wx" });
  }
  return { taskId: document.taskId, outputRoot: resolve(outputRoot), sourceHash: document.contentHash,
    convertedHash: next.contentHash, changed: next.contentHash !== document.contentHash,
    slots: conversions.map(({ file, conversion }) => ({ slot: file.slot, status: conversion.status,
      gaps: conversion.gaps, roles: conversion.statements.map(s => s.role) })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [taskFile, outputRoot, parameterFile, ...extra] = process.argv.slice(2);
  if (!taskFile || !outputRoot || extra.length) throw new Error("Usage: stage-converted-pack.ts TASK_JSON NEW_DATA_ROOT [PARAMETERS_JSON]");
  const parameters = parameterFile ? JSON.parse(readFileSync(parameterFile, "utf8")) : {};
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("INVALID_PARAMETER_MAP");
  console.log(JSON.stringify(stageConvertedPack(taskFile, outputRoot, parameters)));
}
