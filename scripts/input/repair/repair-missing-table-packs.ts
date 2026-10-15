import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadPersistedTableCache,
  tableFromDirectEvidence,
  type TableEvidence,
} from "../mainline/collect-one-task-input-pack.ts";
import { writeTableInput } from "../shared/input-pack.ts";

type ProducerIndexLike = {
  nonConfirmedRelations?: readonly {
    taskCategory?: string | null;
    tableRef?: { qualifiedName?: string | null };
  }[];
  intermediateMaterializations?: readonly {
    taskCategory?: string | null;
    tableRef?: { qualifiedName?: string | null };
  }[];
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value || value.trim() === "")
    throw new Error(`Missing required option ${name}`);
  return value;
}

function qualifiedNamesFrom(
  rows: readonly {
    taskCategory?: string | null;
    tableRef?: { qualifiedName?: string | null };
  }[],
  taskCategory: string,
): string[] {
  return [
    ...new Set(
      rows
        .filter((row) => row.taskCategory === taskCategory)
        .map((row) => row.tableRef?.qualifiedName?.trim())
        .filter((value): value is string => value !== undefined && value !== ""),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

const dataRoot = resolve(requiredOption("--data-root"));
const producerIndexPath = resolve(requiredOption("--producer-index"));
const taskCategory = option("--task-category") ?? "sparkIndex";
const producerIndex = JSON.parse(
  readFileSync(producerIndexPath, "utf8"),
) as ProducerIndexLike;
const qualifiedNames = qualifiedNamesFrom(
  producerIndex.nonConfirmedRelations ?? [],
  taskCategory,
);
const intermediateNames = process.argv.includes("--include-intermediate")
  ? qualifiedNamesFrom(
      producerIndex.intermediateMaterializations ?? [],
      taskCategory,
    )
  : [];
const targets = [...new Set([...qualifiedNames, ...intermediateNames])].sort();

// Reuse the Table Packs already collected locally before calling SZData.
loadPersistedTableCache(dataRoot);

const collected: Array<{
  qualifiedName: string;
  directory: string;
  changed: boolean;
}> = [];
const notFound: string[] = [];
const errors: Array<{ qualifiedName: string; error: string }> = [];

for (const qualifiedName of targets) {
  try {
    const evidence: TableEvidence | undefined =
      tableFromDirectEvidence(qualifiedName, undefined, undefined, {
        preferDirectLookup: true,
        directOnly: true,
        skipDescriptionRefresh: true,
      });
    if (evidence === undefined) {
      notFound.push(qualifiedName);
      continue;
    }
    const result = writeTableInput(dataRoot, evidence);
    collected.push({
      qualifiedName,
      directory: result.directory,
      changed: result.changed,
    });
  } catch (error) {
    errors.push({
      qualifiedName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(
  JSON.stringify({
    dataRoot,
    producerIndex: producerIndexPath,
    taskCategory,
    targetCount: targets.length,
    collectedCount: collected.length,
    notFoundCount: notFound.length,
    errorCount: errors.length,
    collected,
    notFound,
    errors,
  }),
);

if (errors.length > 0) process.exitCode = 1;
