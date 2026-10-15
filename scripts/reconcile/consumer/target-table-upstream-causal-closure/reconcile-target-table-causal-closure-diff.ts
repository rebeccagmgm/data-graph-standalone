import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildTargetTableCausalClosureDiffV0,
  validateTargetTableCausalClosureDiffV0,
} from "./closure-diff.ts";
import type { TargetTableCausalClosureArtifact } from "./artifact-contract.ts";

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`ARGUMENT_MISSING:${key}`);
  return value;
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`ARGUMENT_VALUE_MISSING:${key ?? "unknown"}`);
    }
    values.set(key.slice(2), value);
    index += 1;
  }
  return values;
}

function outputPath(path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

export function main(argv = process.argv.slice(2)): void {
  const values = parseArgs(argv);
  const legacyPath = required(values, "legacy-artifact");
  const unionPath = required(values, "union-artifact");
  const output = required(values, "output");
  const legacy = JSON.parse(
    readFileSync(legacyPath, "utf8"),
  ) as TargetTableCausalClosureArtifact;
  const unionV2 = JSON.parse(
    readFileSync(unionPath, "utf8"),
  ) as TargetTableCausalClosureArtifact;
  const diff = buildTargetTableCausalClosureDiffV0({ legacy, unionV2 });
  validateTargetTableCausalClosureDiffV0(diff);
  outputPath(output);
  writeFileSync(output, `${JSON.stringify(diff, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(diff.summary));
}

if (process.argv[1]?.endsWith("reconcile-target-table-causal-closure-diff.ts"))
  main();
