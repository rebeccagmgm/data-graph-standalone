import { resolve } from "node:path";

import { expandAnchorUpstreamTaskIds } from "../project-graph/task-local/anchor-upstream-expansion.ts";

const DEFAULT_ANCHORS = ["181058", "176827", "209119", "155015"] as const;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function csvOption(args: readonly string[], name: string): string[] {
  return (option(args, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function main(argv: readonly string[]): void {
  const args = argv.slice(2);
  const dataRoot = option(args, "--data-root");
  if (!dataRoot) {
    throw new Error(
      "usage: preflight-upstream-expansion --data-root <path> [--anchor-task-ids 181058,176827] [--writer-catalog <sqlite>] [--producer-index-root <path>]",
    );
  }
  const anchorTaskIds = csvOption(args, "--anchor-task-ids");
  const result = expandAnchorUpstreamTaskIds({
    dataRoot: resolve(dataRoot),
    anchorTaskIds: anchorTaskIds.length > 0 ? anchorTaskIds : [...DEFAULT_ANCHORS],
    writerCatalogPath: option(args, "--writer-catalog")
      ? resolve(option(args, "--writer-catalog")!)
      : undefined,
    producerIndexRoot: option(args, "--producer-index-root")
      ? resolve(option(args, "--producer-index-root")!)
      : undefined,
    maxDepth: option(args, "--max-upstream-depth")
      ? Number(option(args, "--max-upstream-depth"))
      : undefined,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    anchorTaskIds: result.anchorTaskIds,
    taskCount: result.taskIds.length,
    taskIds: result.taskIds,
    discoveredCount: result.discoveredTaskIds.length,
    status: result.status,
    issueCount: result.issues.length,
    issues: result.issues,
    counters: result.counters,
  }, null, 2)}\n`);
}

main(process.argv);
