import { resolve } from "node:path";
import { loadProjectTopologyDirectory } from "../topology/project-topology-publication.ts";
import { loadFieldEvidenceDirectory } from "../field-evidence/field-evidence-publication.ts";
import { loadTargetCausalOverlayDirectory } from "../target-causal-overlay/target-causal-overlay-publication.ts";
import {
  QUERY_OPTIONS,
  QUERY_OPTIONS_BY_NAME,
  collectOptions,
  requiredOne,
  validateQueryOptions,
  type QueryName,
} from "./query-cli-options.ts";
import { runProjectionQuery } from "./run-projection-query.ts";

export async function runFileQueryCli(
  args: readonly string[],
  dependencies: { readonly write?: (text: string) => void } = {},
): Promise<void> {
  const write =
    dependencies.write ?? ((text: string) => process.stdout.write(text));
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    write(
      `query --directory <published-projection-dir> --query <name> [query options]\nQueries: ${[...QUERY_OPTIONS_BY_NAME].join(", ")}\n`,
    );
    return;
  }
  const values = collectOptions(
    args,
    new Set([...QUERY_OPTIONS, "--directory"]),
  );
  const query = requiredOne(values, "--query") as QueryName;
  if (!QUERY_OPTIONS_BY_NAME.has(query))
    throw new Error(`QUERY_INDEX_QUERY_UNKNOWN:${query}`);
  validateQueryOptions(query, values);
  const directory = resolve(requiredOne(values, "--directory"));
  const result = await runProjectionQuery(
    {
      topology: () => loadProjectTopologyDirectory(directory),
      field: () => loadFieldEvidenceDirectory(directory),
      causal: () => loadTargetCausalOverlayDirectory(directory),
    },
    { query, values },
  );
  write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1]?.endsWith("file-query-cli.ts"))
  runFileQueryCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "FILE_QUERY_CLI_FAILED"}\n`,
    );
    process.exitCode = 1;
  });
