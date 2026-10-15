import { isAbsolute, resolve } from "node:path";

import type {
  RelationStatus,
  ImpactChannel,
} from "../../contracts/canonical-artifacts.ts";
import { buildTargetCausalOverlayProjection } from "./target-causal-overlay-projector.ts";
import { publishTargetCausalOverlay } from "./target-causal-overlay-publication.ts";
import {
  explainTargetCausalAssessment,
  getTargetCausalOverlay,
  getTargetCausalTaskRollup,
} from "./target-causal-overlay-query.ts";
import { loadTargetCausalOverlaySource } from "./target-causal-overlay-source.ts";

type CliOptions =
  | { readonly command: "help" }
  | {
      readonly command: "publish";
      readonly topology: string;
      readonly field: string;
      readonly causal: string;
      readonly outputRoot: string;
    }
  | {
      readonly command: "get";
      readonly directory: string;
      readonly relationStatuses: readonly RelationStatus[];
      readonly channels: readonly ImpactChannel[];
      readonly taskIds: readonly string[];
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly command: "task";
      readonly directory: string;
      readonly taskId: string;
      readonly maxAssessments?: number;
    }
  | {
      readonly command: "explain";
      readonly directory: string;
      readonly assessmentId: string;
      readonly maxAttachments?: number;
    };

const RELATION_STATUSES = new Set<RelationStatus>([
  "CONFIRMED_RELATED",
  "CONDITIONAL_RELATED",
  "PROVEN_UNRELATED",
  "UNKNOWN",
]);
const CHANNELS = new Set<ImpactChannel>([
  "FIELD_VALUE",
  "EXPRESSION_CONTROL",
  "ROW_MEMBERSHIP",
  "MULTIPLICITY",
  "RELATION_EXISTENCE",
  "GROUPING",
  "SET_MEMBERSHIP",
  "ORDER_SELECTION",
  "WINDOW_EFFECT",
]);

export function parseTargetCausalOverlayCli(
  args: readonly string[],
): CliOptions {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help")
    return { command: "help" };
  const command = args[0];
  if (!new Set(["publish", "get", "task", "explain"]).has(command!))
    throw new Error(`TARGET_CAUSAL_OVERLAY_COMMAND_UNKNOWN:${command}`);
  const allowedByCommand: Readonly<Record<string, readonly string[]>> = {
    publish: ["--topology", "--field", "--causal", "--output-root"],
    get: [
      "--directory",
      "--relation-status",
      "--channel",
      "--task-id",
      "--offset",
      "--limit",
    ],
    task: ["--directory", "--task-id", "--max-assessments"],
    explain: ["--directory", "--assessment-id", "--max-attachments"],
  };
  const values = collect(args.slice(1), new Set(allowedByCommand[command!]!));
  if (command === "publish")
    return {
      command,
      topology: absolute(requiredOne(values, "--topology")),
      field: absolute(requiredOne(values, "--field")),
      causal: absolute(requiredOne(values, "--causal")),
      outputRoot: absolute(requiredOne(values, "--output-root")),
    };
  const directory = absolute(requiredOne(values, "--directory"));
  if (command === "get") {
    const relationStatuses = (values.get("--relation-status") ?? []).map(
      (value) => enumValue(value, RELATION_STATUSES, "RELATION_STATUS"),
    );
    const channels = (values.get("--channel") ?? []).map((value) =>
      enumValue(value, CHANNELS, "CHANNEL"),
    );
    return {
      command,
      directory,
      relationStatuses,
      channels,
      taskIds: values.get("--task-id") ?? [],
      offset: optionalInteger(values, "--offset", 0),
      limit: optionalInteger(values, "--limit", 1),
    };
  }
  if (command === "task")
    return {
      command,
      directory,
      taskId: requiredOne(values, "--task-id"),
      maxAssessments: optionalInteger(values, "--max-assessments", 1),
    };
  return {
    command: "explain",
    directory,
    assessmentId: requiredOne(values, "--assessment-id"),
    maxAttachments: optionalInteger(values, "--max-attachments", 1),
  };
}

export function runTargetCausalOverlayCli(
  args: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): void {
  const options = parseTargetCausalOverlayCli(args);
  if (options.command === "help") {
    write(`${usage()}\n`);
    return;
  }
  if (options.command === "publish") {
    const source = loadTargetCausalOverlaySource({
      projectTopologyDirectory: options.topology,
      fieldEvidenceDirectory: options.field,
      causalArtifactPath: options.causal,
    });
    const published = publishTargetCausalOverlay(
      buildTargetCausalOverlayProjection(source),
      { outputRoot: options.outputRoot },
    );
    writeJson(write, {
      status: published.status,
      directory: published.directory,
      snapshotId: published.manifest.snapshotId,
      coverageStatus: published.manifest.coverageStatus,
      runtimeRerunDecision: published.manifest.runtimeRerunDecision,
      counts: published.manifest.counts,
    });
    return;
  }
  if (options.command === "get") {
    writeJson(
      write,
      getTargetCausalOverlay(options.directory, {
        relationStatuses: options.relationStatuses,
        channels: options.channels,
        taskIds: options.taskIds,
        offset: options.offset,
        limit: options.limit,
      }),
    );
    return;
  }
  if (options.command === "task") {
    writeJson(
      write,
      getTargetCausalTaskRollup(options.directory, options.taskId, {
        maxAssessments: options.maxAssessments,
      }),
    );
    return;
  }
  writeJson(
    write,
    explainTargetCausalAssessment(options.directory, options.assessmentId, {
      maxAttachments: options.maxAttachments,
    }),
  );
}

function collect(
  args: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option || !allowed.has(option))
      throw new Error(`TARGET_CAUSAL_OVERLAY_OPTION_UNKNOWN:${option}`);
    if (!value || value.startsWith("--"))
      throw new Error(`TARGET_CAUSAL_OVERLAY_OPTION_VALUE_MISSING:${option}`);
    result.set(option, [...(result.get(option) ?? []), value]);
  }
  return result;
}

function requiredOne(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
): string {
  const found = values.get(option);
  if (!found || found.length !== 1)
    throw new Error(`TARGET_CAUSAL_OVERLAY_OPTION_REQUIRED:${option}`);
  return found[0]!;
}

function optionalInteger(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
  minimum: number,
): number | undefined {
  const found = values.get(option);
  if (!found) return undefined;
  if (found.length !== 1)
    throw new Error(`TARGET_CAUSAL_OVERLAY_OPTION_DUPLICATE:${option}`);
  const parsed = Number(found[0]);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error(`TARGET_CAUSAL_OVERLAY_OPTION_INTEGER_INVALID:${option}`);
  return parsed;
}

function enumValue<T extends string>(
  value: string,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  if (!allowed.has(value as T))
    throw new Error(`TARGET_CAUSAL_OVERLAY_${label}_INVALID:${value}`);
  return value as T;
}

function absolute(value: string): string {
  if (!isAbsolute(value))
    throw new Error("TARGET_CAUSAL_OVERLAY_PATH_NOT_ABSOLUTE");
  return resolve(value);
}

function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

export function usage(): string {
  return [
    "target-causal-overlay publish --topology <absolute-dir> --field <absolute-dir> --causal <absolute-json> --output-root <absolute-dir>",
    "target-causal-overlay get --directory <absolute-dir> [--relation-status <status>] [--channel <channel>] [--task-id <id>] [--offset <n>] [--limit <n>]",
    "target-causal-overlay task --directory <absolute-dir> --task-id <id> [--max-assessments <n>]",
    "target-causal-overlay explain --directory <absolute-dir> --assessment-id <id> [--max-attachments <n>]",
  ].join("\n");
}

if (process.argv[1]?.endsWith("target-causal-overlay-cli.ts")) {
  try {
    runTargetCausalOverlayCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "TARGET_CAUSAL_OVERLAY_CLI_FAILED"}\n`,
    );
    process.exitCode = 1;
  }
}
