import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { cacheTaskCategory } from "../shared/cache-task-evidence.ts";
import {
  defaultManualTaskIdsFile,
  excludeManualTaskIds,
  readManualTaskIds,
} from "../shared/manual-task-exclusion.ts";

/** Gold example: schedule-evidence/tasks/144127 — all four present. */
export const SPARKINDEX_QUALIFIED_CACHE_FILES = [
  "horae-task-type.json",
  "szdata-schedule-detail.json",
  "horae-relation-up-depth-1.json",
  "horae-relation-down-depth-1.json",
] as const;

export type SparkIndexQualifiedSkipReason =
  | "missingHoraeTaskType"
  | "missingSzdataScheduleDetail"
  | "missingHoraeRelationUp"
  | "missingHoraeRelationDown"
  | "unreadable"
  | "notSparkIndex"
  | "manual";

export interface SparkIndexQualifiedSelection {
  readonly scanned: number;
  readonly selected: readonly string[];
  readonly skip: Readonly<Record<SparkIndexQualifiedSkipReason, number>>;
  readonly rule: string;
}

const cacheTasksDir =
  process.env.CACHE_TASKS_DIR ??
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-cache/schedule-evidence/tasks";
const outDir =
  process.env.OUT_DIR ??
  "E:/02_area/股衍数据-数据cookbook/sql-static-lineage-data/tmp/from-cache-full/partial-analysis/sparkindex-regen-both-evidence";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(
  detail: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (detail === undefined) return undefined;
  for (const key of keys) {
    const value = detail[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function readDetail(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const root = asRecord(parsed);
    return asRecord(root?.detail) ?? root;
  } catch {
    return undefined;
  }
}

function missingSkipReason(
  fileName: (typeof SPARKINDEX_QUALIFIED_CACHE_FILES)[number],
): SparkIndexQualifiedSkipReason {
  switch (fileName) {
    case "horae-task-type.json":
      return "missingHoraeTaskType";
    case "szdata-schedule-detail.json":
      return "missingSzdataScheduleDetail";
    case "horae-relation-up-depth-1.json":
      return "missingHoraeRelationUp";
    case "horae-relation-down-depth-1.json":
      return "missingHoraeRelationDown";
  }
}

/**
 * Non-manual sparkIndex tasks whose cache dir has all four gold files
 * (same set as tasks/144127).
 */
export function selectSparkIndexQualifiedTaskIds(options: {
  readonly cacheTasksDir: string;
  readonly manualTaskIds?: ReadonlySet<string>;
}): SparkIndexQualifiedSelection {
  const skip: Record<SparkIndexQualifiedSkipReason, number> = {
    missingHoraeTaskType: 0,
    missingSzdataScheduleDetail: 0,
    missingHoraeRelationUp: 0,
    missingHoraeRelationDown: 0,
    unreadable: 0,
    notSparkIndex: 0,
    manual: 0,
  };
  const ids: string[] = [];
  let scanned = 0;

  if (!existsSync(options.cacheTasksDir)) {
    return {
      scanned: 0,
      selected: [],
      skip,
      rule: "non-manual sparkIndex AND four cache files present (144127-style)",
    };
  }

  for (const ent of readdirSync(options.cacheTasksDir, {
    withFileTypes: true,
  })) {
    if (!ent.isDirectory()) continue;
    scanned += 1;
    const taskId = ent.name;
    const taskDir = join(options.cacheTasksDir, taskId);

    let missing: (typeof SPARKINDEX_QUALIFIED_CACHE_FILES)[number] | undefined;
    for (const fileName of SPARKINDEX_QUALIFIED_CACHE_FILES) {
      if (!existsSync(join(taskDir, fileName))) {
        missing = fileName;
        break;
      }
    }
    if (missing !== undefined) {
      skip[missingSkipReason(missing)] += 1;
      continue;
    }

    const horae = readDetail(join(taskDir, "horae-task-type.json"));
    const schedule = readDetail(join(taskDir, "szdata-schedule-detail.json"));
    if (horae === undefined || schedule === undefined) {
      skip.unreadable += 1;
      continue;
    }
    const category = cacheTaskCategory(
      firstString(horae, ["taskType", "task_type"]),
      firstString(schedule, ["taskType", "task_type"]),
    );
    if (category !== "sparkIndex") {
      skip.notSparkIndex += 1;
      continue;
    }
    if (options.manualTaskIds?.has(taskId)) {
      skip.manual += 1;
      continue;
    }
    ids.push(taskId);
  }

  ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return {
    scanned,
    selected: options.manualTaskIds
      ? excludeManualTaskIds(ids, options.manualTaskIds)
      : ids,
    skip,
    rule: "non-manual sparkIndex AND four cache files present (144127-style)",
  };
}

function main(): void {
  mkdirSync(outDir, { recursive: true });
  const cacheRoot = join(cacheTasksDir, "..");
  const manualTaskIds = readManualTaskIds(
    cacheRoot,
    defaultManualTaskIdsFile(cacheRoot),
  );
  const selection = selectSparkIndexQualifiedTaskIds({
    cacheTasksDir,
    manualTaskIds,
  });

  writeFileSync(
    join(outDir, "ids-sparkindex-four-evidence.txt"),
    `${selection.selected.join("\n")}${selection.selected.length > 0 ? "\n" : ""}`,
    "utf8",
  );
  // Keep legacy filename as an alias for existing regen scripts.
  writeFileSync(
    join(outDir, "ids-sparkindex-both-horae-and-schedule.txt"),
    `${selection.selected.join("\n")}${selection.selected.length > 0 ? "\n" : ""}`,
    "utf8",
  );
  writeFileSync(
    join(outDir, "summary.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        rule: selection.rule,
        requiredFiles: SPARKINDEX_QUALIFIED_CACHE_FILES,
        goldExample: "144127",
        scanned: selection.scanned,
        selected: selection.selected.length,
        manualExcluded: selection.skip.manual,
        skip: selection.skip,
        sample: selection.selected.slice(0, 30),
        outDir,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        scanned: selection.scanned,
        selected: selection.selected.length,
        skip: selection.skip,
        sample: selection.selected.slice(0, 20),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1]?.endsWith("select-sparkindex-both-evidence.ts")) {
  main();
}
