import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGateBUnionL1Set } from "./gate-b-union.ts";

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`GATE_B_UNION_ARGUMENT_MISSING:${key}`);
  return value;
}

export function parseGateBUnionArgs(argv: readonly string[]): {
  readonly closureArtifact: string;
  readonly continuationIndex: string;
  readonly output: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`GATE_B_UNION_ARGUMENT_MISSING:${key.slice(2)}`);
    }
    values.set(key.slice(2), value);
    index += 1;
  }
  return {
    closureArtifact: required(values, "closure-artifact"),
    continuationIndex: required(values, "continuation-index"),
    output: required(values, "output"),
  };
}

export function main(argv = process.argv.slice(2)): void {
  const options = parseGateBUnionArgs(argv);
  const artifact = createGateBUnionL1Set({
    closureArtifactPath: options.closureArtifact,
    continuationIndexPath: options.continuationIndex,
  });
  const output = resolve(options.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      artifactType: artifact.artifactType,
      taskId: artifact.targetWrite.taskId,
      l1Count: artifact.members.length,
      contentHash: artifact.contentHash,
      output,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
