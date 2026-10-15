import { canonicalJson } from "../../../../machine-facts/machine-facts-contract.ts";
import {
  parseProjectTaskLocalCli,
  runProjectTaskLocalCli,
} from "../../../../project-graph/task-local/project-task-local-cli.ts";
import { expandAnchorUpstreamTaskIds } from "./anchor-upstream-expansion.ts";

function main(argv: readonly string[]): void {
  const parsed = parseProjectTaskLocalCli(argv.slice(2));
  const result = runProjectTaskLocalCli(
    { ...parsed, expandUpstream: true },
    { expandAnchorUpstreamTaskIds },
  );
  process.stdout.write(`${canonicalJson({
    ok: true,
    batchManifestPath: result.batchManifestPath,
    taskCount: result.taskIds.length,
    cache: result.cache,
  })}\n`);
}

if (
  process.argv[1]
  && /project-task-local-expand-cli\.(?:ts|js|mjs|cjs)$/u.test(
    process.argv[1].replaceAll("\\", "/"),
  )
) {
  main(process.argv);
}
