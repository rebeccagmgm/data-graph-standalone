import {
  existsSync,
  renameSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  buildCompactTaskPartition,
  buildTaskPartitionEvidence,
  isDatabaseSourceToHiveTask,
} from "../shared/task-partition-evidence.ts";
import {
  SQL_SLOTS,
  canonicalHash,
  type JsonValue,
  type SqlSlot,
  type TaskCodeEvidence,
  type TaskPartitionValue,
  type TaskSchedulerEvidence,
  type TaskDocument,
  type TableEvidence,
} from "../shared/input-pack.ts";
import { extractSqlWrites } from "../../evidence/sql-write-evidence.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (value === undefined || value.trim() === "")
    throw new Error(`Missing required option ${name}`);
  return value;
}

function walkNamedFiles(root: string, name: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkNamedFiles(path, name));
    else if (entry.name === name) result.push(path);
  }
  return result;
}

function normalized(value: string): string {
  return value.replaceAll("`", "").replaceAll('"', "").trim().toLowerCase();
}

function tableKey(
  table: Pick<TableEvidence, "platform" | "qualifiedName" | "dataSource">,
): string {
  return `${normalized(table.platform)}|${normalized(table.qualifiedName)}|${normalized(table.dataSource)}`;
}

function readTablePack(path: string): TableEvidence | undefined {
  try {
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    const ddlFile = document.ddlFile as Record<string, unknown> | undefined;
    if (
      typeof document.platform !== "string" ||
      typeof document.qualifiedName !== "string" ||
      typeof document.dataSource !== "string" ||
      typeof document.objectType !== "string" ||
      typeof ddlFile?.path !== "string"
    )
      return undefined;
    const ddlPath = join(dirname(path), ddlFile.path);
    if (!statSync(ddlPath).isFile()) return undefined;
    return {
      guid: typeof document.guid === "string" ? document.guid : undefined,
      platform: document.platform,
      dataSource: document.dataSource,
      qualifiedName: document.qualifiedName,
      schema: typeof document.schema === "string" ? document.schema : undefined,
      name: typeof document.name === "string" ? document.name : undefined,
      description:
        typeof document.description === "string"
          ? document.description
          : undefined,
      objectType: document.objectType,
      status: typeof document.status === "string" ? document.status : undefined,
      primaryKey: Array.isArray(document.primaryKey)
        ? document.primaryKey.map(String)
        : undefined,
      partitionFields: Array.isArray(document.partitionFields)
        ? document.partitionFields.map(String)
        : undefined,
      ddl: readFileSync(ddlPath, "utf8"),
      evidenceProvider:
        typeof document.evidenceProvider === "string"
          ? document.evidenceProvider
          : typeof ddlFile.evidenceProvider === "string"
            ? ddlFile.evidenceProvider
            : "stored:table-pack",
      collectedAt:
        typeof document.collectedAt === "string"
          ? document.collectedAt
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function readTaskPack(path: string):
  | {
      readonly document: TaskDocument;
      readonly sql: Partial<Record<SqlSlot, string>>;
    }
  | undefined {
  try {
    const document = JSON.parse(readFileSync(path, "utf8")) as TaskDocument;
    const sql: Partial<Record<SqlSlot, string>> = {};
    for (const item of document.sqlFiles) {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        typeof item.slot !== "string" ||
        !(SQL_SLOTS as readonly string[]).includes(item.slot) ||
        typeof item.path !== "string"
      )
        continue;
      const sqlPath = join(dirname(path), item.path);
      if (statSync(sqlPath).isFile())
        sql[item.slot as SqlSlot] = readFileSync(sqlPath, "utf8");
    }
    return { document, sql };
  } catch {
    return undefined;
  }
}

function endpointName(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string")
    return value.trim() === "" || value === "-" ? undefined : value;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return typeof value.qualifiedName === "string"
    ? value.qualifiedName
    : undefined;
}

interface TableCatalog {
  /**
   * Keeps the original catalog iteration order for ambiguous qualified names.
   * `tablesForTask` deliberately retains the prior first-match behavior.
   */
  readonly byQualifiedName: ReadonlyMap<string, readonly TableEvidence[]>;
}

function tableCatalog(dataRoot: string): TableCatalog {
  const catalog = new Map<string, TableEvidence>();
  for (const path of walkNamedFiles(join(dataRoot, "tables"), "table.json")) {
    const table = readTablePack(path);
    if (table !== undefined) catalog.set(tableKey(table), table);
  }
  const byQualifiedName = new Map<string, TableEvidence[]>();
  for (const table of catalog.values()) {
    const name = normalized(table.qualifiedName);
    const matches = byQualifiedName.get(name);
    if (matches === undefined) byQualifiedName.set(name, [table]);
    else matches.push(table);
  }
  return { byQualifiedName };
}

function tablesForTask(
  document: TaskDocument,
  sql: Partial<Record<SqlSlot, string>>,
  catalog: TableCatalog,
): TableEvidence[] {
  const target = endpointName(document.target as JsonValue | undefined);
  const names = new Set<string>(target === undefined ? [] : [target]);
  for (const content of Object.values(sql))
    if (content !== undefined)
      for (const write of extractSqlWrites(content))
        names.add(write.qualifiedName);
  const taskPlatform =
    typeof document.target === "object" &&
    document.target !== null &&
    !Array.isArray(document.target) &&
    typeof document.target.platform === "string"
      ? document.target.platform
      : undefined;
  const taskDataSource =
    typeof document.target === "object" &&
    document.target !== null &&
    !Array.isArray(document.target) &&
    typeof document.target.dataSource === "string"
      ? document.target.dataSource
      : undefined;
  const result: TableEvidence[] = [];
  for (const name of names) {
    const exact = catalog.byQualifiedName.get(normalized(name))?.find(
      (table) =>
        (taskDataSource === undefined ||
          normalized(table.dataSource) === normalized(taskDataSource)) &&
        (taskPlatform === undefined ||
          normalized(table.platform) === normalized(taskPlatform)),
    );
    if (
      exact !== undefined &&
      !result.some((table) => tableKey(table) === tableKey(exact))
    )
      result.push(exact);
  }
  return result;
}

export function rewriteStoredTaskPartition(
  path: string,
  document: TaskDocument,
  partition: TaskPartitionValue | null | undefined,
  apply = true,
): boolean {
  const current = (document as Record<string, unknown>).partition;
  if (partition === undefined && current === undefined) return false;
  if (JSON.stringify(current) === JSON.stringify(partition)) return false;
  if (!apply) return true;
  const nextDocument = { ...(document as Record<string, JsonValue>) };
  if (partition === undefined) delete nextDocument.partition;
  else nextDocument.partition = partition as unknown as JsonValue;
  nextDocument.contentHash = canonicalHash(nextDocument, [
    "collectedAt",
    "contentHash",
  ]);
  const stagedPath = `${path}.partition-rebuild-${process.pid}.tmp`;
  writeFileSync(
    stagedPath,
    `${JSON.stringify(nextDocument, null, 2)}\n`,
    "utf8",
  );
  try {
    renameSync(stagedPath, path);
  } finally {
    if (existsSync(stagedPath)) unlinkSync(stagedPath);
  }
  return true;
}

export function main(): void {
  const dataRoot = resolve(requiredOption("--data-root"));
  const selectedIds = option("--task-ids")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const selected = selectedIds === undefined ? undefined : new Set(selectedIds);
  const dryRun = process.argv.includes("--dry-run");
  const includeDetails = process.argv.includes("--details");
  const catalog = tableCatalog(dataRoot);
  const taskPaths = walkNamedFiles(join(dataRoot, "tasks"), "task.json");
  const taskDetails: {
    readonly taskId: string;
    readonly taskCategory: string;
    readonly status: string;
    readonly partition?: TaskPartitionValue | null;
    readonly reasonCodes: readonly string[];
    readonly targets: readonly {
      readonly target: string;
      readonly status: string;
      readonly reasonCodes: readonly string[];
    }[];
  }[] = [];
  const summary = {
    scanned: 0,
    changed: 0,
    unchanged: 0,
    failed: 0,
    statuses: {} as Record<string, number>,
    reasonCodes: {} as Record<string, number>,
    categoryStatuses: {} as Record<string, Record<string, number>>,
  };
  for (const path of taskPaths) {
    const loaded = readTaskPack(path);
    if (
      loaded === undefined ||
      (selected !== undefined && !selected.has(loaded.document.taskId))
    )
      continue;
    summary.scanned += 1;
    try {
      const target = endpointName(
        loaded.document.target as JsonValue | undefined,
      );
      const tables = tablesForTask(loaded.document, loaded.sql, catalog);
      const evidence = buildTaskPartitionEvidence({
        taskTarget: target,
        tables,
        sql: loaded.sql,
        schedulerEvidence: loaded.document.schedulerEvidence as unknown as
          TaskSchedulerEvidence | undefined,
        codeEvidence: loaded.document.codeEvidence as unknown as
          TaskCodeEvidence | undefined,
        allowImplicitQueryOutput: !isDatabaseSourceToHiveTask(
          loaded.document.taskCategory,
        ),
        allowSourceTemporalPartitionDefault: isDatabaseSourceToHiveTask(
          loaded.document.taskCategory,
        ),
        sparkIndexMode: loaded.document.taskCategory === "sparkIndex",
      });
      const partition = buildCompactTaskPartition({
        taskTarget: target,
        tables,
        sql: loaded.sql,
        schedulerEvidence: loaded.document.schedulerEvidence as unknown as
          TaskSchedulerEvidence | undefined,
        allowImplicitQueryOutput: !isDatabaseSourceToHiveTask(
          loaded.document.taskCategory,
        ),
        allowSourceTemporalPartitionDefault: isDatabaseSourceToHiveTask(
          loaded.document.taskCategory,
        ),
        sparkIndexMode: loaded.document.taskCategory === "sparkIndex",
      });
      const status = evidence.status;
      summary.statuses[status] = (summary.statuses[status] ?? 0) + 1;
      for (const reason of evidence.reasonCodes)
        summary.reasonCodes[reason] = (summary.reasonCodes[reason] ?? 0) + 1;
      const category = loaded.document.taskCategory;
      summary.categoryStatuses[category] ??= {};
      summary.categoryStatuses[category]![status] =
        (summary.categoryStatuses[category]![status] ?? 0) + 1;
      if (includeDetails)
        taskDetails.push({
          taskId: loaded.document.taskId,
          taskCategory: category,
          status,
          ...(partition === undefined ? {} : { partition }),
          reasonCodes: evidence.reasonCodes,
          targets: evidence.targets.map((item) => ({
            target: item.target,
            status: item.status,
            reasonCodes: item.reasonCodes,
          })),
        });
      if (rewriteStoredTaskPartition(path, loaded.document, partition, !dryRun))
        summary.changed += 1;
      else summary.unchanged += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(
        JSON.stringify({
          path,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  console.log(
    JSON.stringify({
      mode: dryRun ? "DRY_RUN" : "REBUILT_FROM_STORED_SQL",
      ...summary,
      ...(includeDetails ? { tasks: taskDetails } : {}),
    }),
  );
  if (summary.failed > 0) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  main();
