import { basename, resolve } from "node:path";

import { publishProjectTopologyAcceptanceView } from "./view/project-topology-acceptance-view.ts";

interface ProjectTopologyViewCliOptions {
  readonly projectTopologyDirectory: string;
  readonly dataRoot: string;
  readonly outputRoot: string;
  readonly maxTaskPackBytes?: number;
  readonly fieldEvidenceDirectories?: readonly string[];
  readonly maxFieldEvidenceBytes?: number;
}

export function parseProjectTopologyViewCli(
  args: readonly string[],
): ProjectTopologyViewCliOptions {
  const values = new Map<string, string>();
  const fieldEvidenceDirectories: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !value || !name.startsWith("--")) throw new Error(usage());
    if (
      ![
        "--project-topology",
        "--data-root",
        "--output-root",
        "--max-task-pack-bytes",
        "--field-evidence",
        "--max-field-evidence-bytes",
      ].includes(name)
    )
      throw new Error(`UNKNOWN_OPTION:${name}`);
    if (name === "--field-evidence")
      fieldEvidenceDirectories.push(resolve(value));
    else {
      if (values.has(name)) throw new Error(`OPTION_DUPLICATE:${name}`);
      values.set(name, value);
    }
  }
  const projectTopologyDirectory = values.get("--project-topology");
  const dataRoot = values.get("--data-root");
  const outputRoot = values.get("--output-root");
  if (!projectTopologyDirectory || !dataRoot || !outputRoot)
    throw new Error(usage());
  const maxTaskPackBytes = values.get("--max-task-pack-bytes");
  const maxFieldEvidenceBytes = values.get("--max-field-evidence-bytes");
  return {
    projectTopologyDirectory: resolve(projectTopologyDirectory),
    dataRoot: resolve(dataRoot),
    outputRoot: resolve(outputRoot),
    ...(maxTaskPackBytes
      ? { maxTaskPackBytes: positiveInteger(maxTaskPackBytes) }
      : {}),
    ...(fieldEvidenceDirectories.length > 0
      ? { fieldEvidenceDirectories }
      : {}),
    ...(maxFieldEvidenceBytes
      ? { maxFieldEvidenceBytes: positiveInteger(maxFieldEvidenceBytes) }
      : {}),
  };
}

export function runProjectTopologyViewCli(args: readonly string[]): void {
  const result = publishProjectTopologyAcceptanceView(
    parseProjectTopologyViewCli(args),
  );
  process.stdout.write(
    `${JSON.stringify({
      status: result.status,
      directory: result.directory,
      html: result.htmlPath,
      manifest: result.manifestPath,
      viewId: result.manifest.viewId,
      snapshotId: result.manifest.snapshotId,
      counts: result.manifest.counts,
      fieldEvidence: result.manifest.sourceFieldEvidence,
    })}\n`,
  );
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("OPTION_INVALID:--max-task-pack-bytes");
  return parsed;
}

function usage(): string {
  return "usage: project-topology-view --project-topology <snapshot-dir> --data-root <input-pack-root> --output-root <view-root> [--field-evidence <field-snapshot-dir>]... [--max-task-pack-bytes N] [--max-field-evidence-bytes N]";
}

if (
  process.argv[1] &&
  basename(process.argv[1]) === "project-topology-view-cli.ts"
)
  runProjectTopologyViewCli(process.argv.slice(2));
