/**
 * Inventory: cache-complete task IDs vs official Input Packs.
 *
 * Does not write packs. Classifies each ID so you can see what a no-force
 * from-cache run would create vs skip, and which packs could gain SQL slots
 * only with --force.
 *
 * Usage:
 *   npm run input-pack:from-cache:diff -- \
 *     --data-root "E:\...\sql-static-lineage-data" \
 *     --task-ids-file "E:\...\tmp\from-cache-full\task-ids-cache-complete-all.txt" \
 *     --out-dir "E:\...\tmp\from-cache-full\diff"
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  assembleCacheTaskEvidence,
  sqlSlotCount,
} from "../shared/cache-task-evidence.ts";
import {
  sha256File,
  validateTaskDocument,
  type TaskDocument,
} from "../shared/input-pack.ts";
import { DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT } from "../../evidence/schedule-evidence-cache.ts";

export type DiffAction =
  | "NEED_CREATE"
  | "ALREADY_PRESENT"
  | "REFRESH_CANDIDATE"
  | "ASSEMBLE_SKIP"
  | "ASSEMBLE_FAILED"
  | "ASSEMBLE_EXCLUDED";

export type DiffRow = {
  readonly taskId: string;
  readonly action: DiffAction;
  readonly taskCategory?: string;
  readonly packDirectory?: string;
  readonly packSqlSlots?: number;
  readonly cacheSqlSlots?: number;
  readonly reason?: string;
};

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(argv: readonly string[], name: string): string {
  const value = optionValue(argv, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function readTaskIdsFile(path: string): readonly string[] {
  return [
    ...new Set(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line)),
    ),
  ];
}

function findExistingValidTaskPack(
  dataRoot: string,
  taskId: string,
):
  | {
      readonly category: string;
      readonly directory: string;
      readonly sqlSlotCount: number;
      readonly contentHash: string;
    }
  | undefined {
  const tasksRoot = join(dataRoot, "tasks");
  if (!existsSync(tasksRoot) || taskId.includes("/") || taskId.includes("\\"))
    return undefined;
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(tasksRoot, entry.name, taskId);
    const taskPath = join(directory, "task.json");
    if (!existsSync(taskPath)) continue;
    try {
      const document = JSON.parse(readFileSync(taskPath, "utf8")) as TaskDocument;
      validateTaskDocument(document);
      if (document.taskId !== taskId) continue;
      for (const sqlFile of document.sqlFiles) {
        const file = sqlFile as { path: string; sha256: string };
        if (sha256File(join(directory, file.path)) !== file.sha256)
          return undefined;
      }
      return {
        category: document.taskCategory,
        directory,
        sqlSlotCount: document.sqlFiles.length,
        contentHash: document.contentHash,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function indexOfficialTaskIds(dataRoot: string): ReadonlyMap<string, string> {
  const tasksRoot = join(dataRoot, "tasks");
  const map = new Map<string, string>();
  if (!existsSync(tasksRoot)) return map;
  for (const category of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = join(tasksRoot, category.name);
    for (const task of readdirSync(categoryDir, { withFileTypes: true })) {
      if (!task.isDirectory()) continue;
      if (!existsSync(join(categoryDir, task.name, "task.json"))) continue;
      if (!map.has(task.name)) map.set(task.name, category.name);
    }
  }
  return map;
}

export function diffInputPackFromCache(options: {
  readonly dataRoot: string;
  readonly taskIds: readonly string[];
  readonly cacheRoot?: string;
  readonly outDir: string;
}): {
  readonly counts: Record<DiffAction, number>;
  readonly rows: readonly DiffRow[];
  readonly officialOnlyCount: number;
} {
  const dataRoot = resolve(options.dataRoot);
  const cacheRoot = resolve(
    options.cacheRoot ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  );
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });

  const officialIndex = indexOfficialTaskIds(dataRoot);
  const rows: DiffRow[] = [];
  const counts: Record<DiffAction, number> = {
    NEED_CREATE: 0,
    ALREADY_PRESENT: 0,
    REFRESH_CANDIDATE: 0,
    ASSEMBLE_SKIP: 0,
    ASSEMBLE_FAILED: 0,
    ASSEMBLE_EXCLUDED: 0,
  };

  for (const taskId of options.taskIds) {
    let assembled: ReturnType<typeof assembleCacheTaskEvidence>;
    try {
      assembled = assembleCacheTaskEvidence(taskId, cacheRoot);
    } catch (error) {
      rows.push({
        taskId,
        action: "ASSEMBLE_FAILED",
        reason: error instanceof Error ? error.message : String(error),
      });
      counts.ASSEMBLE_FAILED += 1;
      continue;
    }
    if (assembled.kind === "NOT_FOUND" || assembled.kind === "MANUAL_OR_FROZEN") {
      const row: DiffRow = {
        taskId,
        action: "ASSEMBLE_EXCLUDED",
        reason:
          assembled.kind === "NOT_FOUND"
            ? "HORAE_TASK_NOT_FOUND"
            : "MANUAL_OR_FROZEN",
      };
      rows.push(row);
      counts.ASSEMBLE_EXCLUDED += 1;
      continue;
    }
    if (assembled.kind === "SKIPPED") {
      rows.push({
        taskId,
        action: "ASSEMBLE_SKIP",
        taskCategory: assembled.taskCategory,
        reason: assembled.reason,
      });
      counts.ASSEMBLE_SKIP += 1;
      continue;
    }
    if (assembled.kind === "FAILED") {
      rows.push({
        taskId,
        action: "ASSEMBLE_FAILED",
        reason: assembled.reason,
      });
      counts.ASSEMBLE_FAILED += 1;
      continue;
    }

    const cacheSlots = sqlSlotCount(assembled.evidence);
    const existing = findExistingValidTaskPack(dataRoot, taskId);
    if (existing === undefined) {
      rows.push({
        taskId,
        action: "NEED_CREATE",
        taskCategory: assembled.evidence.taskCategory,
        cacheSqlSlots: cacheSlots,
      });
      counts.NEED_CREATE += 1;
      continue;
    }
    if (cacheSlots > existing.sqlSlotCount) {
      rows.push({
        taskId,
        action: "REFRESH_CANDIDATE",
        taskCategory: existing.category,
        packDirectory: existing.directory,
        packSqlSlots: existing.sqlSlotCount,
        cacheSqlSlots: cacheSlots,
        reason: "CACHE_HAS_MORE_SQL_SLOTS",
      });
      counts.REFRESH_CANDIDATE += 1;
      continue;
    }
    rows.push({
      taskId,
      action: "ALREADY_PRESENT",
      taskCategory: existing.category,
      packDirectory: existing.directory,
      packSqlSlots: existing.sqlSlotCount,
      cacheSqlSlots: cacheSlots,
      reason: "EXISTING_VALID_PACK",
    });
    counts.ALREADY_PRESENT += 1;
  }

  const completeSet = new Set(options.taskIds);
  const officialOnly = [...officialIndex.entries()]
    .filter(([taskId]) => !completeSet.has(taskId))
    .map(([taskId, category]) => ({ taskId, category }))
    .sort((a, b) => Number(a.taskId) - Number(b.taskId));

  const writeIdList = (name: string, action: DiffAction): void => {
    const ids = rows
      .filter((row) => row.action === action)
      .map((row) => row.taskId);
    writeFileSync(join(outDir, name), `${ids.join("\n")}${ids.length ? "\n" : ""}`, "utf8");
  };
  writeIdList("need-create.txt", "NEED_CREATE");
  writeIdList("already-present.txt", "ALREADY_PRESENT");
  writeIdList("refresh-candidate.txt", "REFRESH_CANDIDATE");
  writeIdList("assemble-failed.txt", "ASSEMBLE_FAILED");
  writeIdList("assemble-excluded.txt", "ASSEMBLE_EXCLUDED");

  writeFileSync(
    join(outDir, "official-only.txt"),
    `${officialOnly.map((item) => item.taskId).join("\n")}${
      officialOnly.length ? "\n" : ""
    }`,
    "utf8",
  );
  writeFileSync(
    join(outDir, "rows.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}${rows.length ? "\n" : ""}`,
    "utf8",
  );
  const summary = {
    generatedAt: new Date().toISOString(),
    dataRoot,
    cacheRoot,
    cacheCompleteCount: options.taskIds.length,
    officialPackCount: officialIndex.size,
    officialOnlyCount: officialOnly.length,
    counts,
    outDir,
    legend: {
      NEED_CREATE: "cache-complete, no valid pack → no-force run will write",
      ALREADY_PRESENT: "valid pack exists → no-force run SKIPPED",
      REFRESH_CANDIDATE:
        "pack exists but cache has more SQL slots → needs --force to upgrade",
      ASSEMBLE_FAILED: "cache present but evidence assemble failed",
      ASSEMBLE_EXCLUDED: "manual/frozen or not found",
      ASSEMBLE_SKIP: "assemble skipped (rare)",
      officialOnly:
        "official pack exists but id not in cache-complete list (left alone)",
    },
  };
  writeFileSync(
    join(outDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  return {
    counts,
    rows,
    officialOnlyCount: officialOnly.length,
  };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry?.endsWith("diff-input-pack-from-cache.ts") ?? false;
}

if (isDirectExecution()) {
  try {
    const argv = process.argv;
    const taskIdsFile = requiredOption(argv, "--task-ids-file");
    const result = diffInputPackFromCache({
      dataRoot: requiredOption(argv, "--data-root"),
      taskIds: readTaskIdsFile(taskIdsFile),
      cacheRoot: optionValue(argv, "--cache-root"),
      outDir: requiredOption(argv, "--out-dir"),
    });
    process.stderr.write(
      `diff done ${JSON.stringify({
        counts: result.counts,
        officialOnlyCount: result.officialOnlyCount,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
