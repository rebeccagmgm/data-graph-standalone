import { basename, resolve } from "node:path";

import { buildFieldEvidenceProjection } from "./field-evidence-projector.ts";
import { publishFieldEvidence } from "./field-evidence-publication.ts";
import {
  DEFAULT_FIELD_EVIDENCE_LIMITS,
  loadFieldEvidenceSource,
} from "./field-evidence-source.ts";

export interface FieldEvidenceCliOptions {
  readonly projectTopologyDirectory: string;
  readonly fieldLineagePath: string;
  readonly outputRoot: string;
  readonly rootTaskId: string;
  readonly writeObservationId: string;
  readonly target: {
    readonly platform: string;
    readonly dataSource: string;
    readonly stableTableId: string;
    readonly qualifiedName: string;
  };
  readonly rootFields: readonly string[];
  readonly maxSourceBytes: number;
  readonly limits: typeof DEFAULT_FIELD_EVIDENCE_LIMITS;
}

export function parseFieldEvidenceCli(
  args: readonly string[],
): FieldEvidenceCliOptions {
  const values = new Map<string, string>();
  const fields: string[] = [];
  const known = new Set([
    "--project-topology",
    "--field-lineage",
    "--output-root",
    "--root-task-id",
    "--write-observation-id",
    "--target-platform",
    "--target-data-source",
    "--target-stable-table-id",
    "--target-qualified-name",
    "--root-field",
    "--max-source-bytes",
    "--max-nodes",
    "--max-edges",
    "--max-paths",
    "--max-controls",
    "--max-candidates",
    "--max-gaps",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!known.has(arg)) throw new Error(`UNKNOWN_OPTION:${arg}`);
    const value = args[index + 1];
    if (!value) throw new Error(`OPTION_VALUE_MISSING:${arg}`);
    index += 1;
    if (arg === "--root-field") {
      fields.push(
        ...value
          .split(",")
          .map((field) => field.trim())
          .filter((field) => field !== ""),
      );
    } else values.set(arg, value);
  }
  const required = (option: string): string => {
    const value = values.get(option);
    if (!value) throw new Error(usage());
    return value;
  };
  if (fields.length === 0) throw new Error(usage());
  return {
    projectTopologyDirectory: resolve(required("--project-topology")),
    fieldLineagePath: resolve(required("--field-lineage")),
    outputRoot: resolve(required("--output-root")),
    rootTaskId: required("--root-task-id"),
    writeObservationId: required("--write-observation-id"),
    target: {
      platform: required("--target-platform"),
      dataSource: required("--target-data-source"),
      stableTableId: required("--target-stable-table-id"),
      qualifiedName: required("--target-qualified-name"),
    },
    rootFields: [...new Set(fields.map((field) => field.toLowerCase()))].sort(),
    maxSourceBytes: optionInteger(
      values,
      "--max-source-bytes",
      512 * 1024 * 1024,
    ),
    limits: {
      maxNodes: optionInteger(
        values,
        "--max-nodes",
        DEFAULT_FIELD_EVIDENCE_LIMITS.maxNodes,
      ),
      maxEdges: optionInteger(
        values,
        "--max-edges",
        DEFAULT_FIELD_EVIDENCE_LIMITS.maxEdges,
      ),
      maxPaths: optionInteger(
        values,
        "--max-paths",
        DEFAULT_FIELD_EVIDENCE_LIMITS.maxPaths,
      ),
      maxControls: optionInteger(
        values,
        "--max-controls",
        DEFAULT_FIELD_EVIDENCE_LIMITS.maxControls,
      ),
      maxCandidates: optionInteger(
        values,
        "--max-candidates",
        DEFAULT_FIELD_EVIDENCE_LIMITS.maxCandidates,
      ),
      maxGaps: optionInteger(
        values,
        "--max-gaps",
        DEFAULT_FIELD_EVIDENCE_LIMITS.maxGaps,
      ),
    },
  };
}

export function runFieldEvidenceCli(args: readonly string[]): void {
  const options = parseFieldEvidenceCli(args);
  const source = loadFieldEvidenceSource({
    projectTopologyDirectory: options.projectTopologyDirectory,
    fieldLineagePath: options.fieldLineagePath,
    rootTaskId: options.rootTaskId,
    writeObservationId: options.writeObservationId,
    target: options.target,
    rootFields: options.rootFields,
    limits: options.limits,
    maxSourceBytes: options.maxSourceBytes,
  });
  const projection = buildFieldEvidenceProjection(source);
  const published = publishFieldEvidence(projection, {
    outputRoot: options.outputRoot,
  });
  process.stdout.write(
    `${JSON.stringify({
      status: published.status,
      snapshotId: published.manifest.snapshotId,
      directory: published.directory,
      coverageStatus: published.manifest.coverageStatus,
      counts: published.manifest.counts,
      selection: published.manifest.selection,
    })}\n`,
  );
}

function optionInteger(
  values: ReadonlyMap<string, string>,
  option: string,
  fallback: number,
): number {
  const value = values.get(option);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`OPTION_INVALID:${option}`);
  return parsed;
}

function usage(): string {
  return "usage: field-evidence-graph --project-topology <snapshot-dir> --field-lineage <field-lineage.json> --output-root <dir> --root-task-id <id> --write-observation-id <id> --target-platform <platform> --target-data-source <source> --target-stable-table-id <id> --target-qualified-name <name> --root-field <field[,field]> [--root-field <field>] [hard limits]";
}

if (process.argv[1] && basename(process.argv[1]) === "field-evidence-cli.ts")
  runFieldEvidenceCli(process.argv.slice(2));
