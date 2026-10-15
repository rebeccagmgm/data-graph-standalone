import { basename, resolve } from "node:path";

import { safeSegment } from "../contracts/runtime.ts";
import { buildProjectTopology } from "./topology/project-topology-projector.ts";
import { publishProjectTopology } from "./topology/project-topology-publication.ts";
import {
  loadProjectTopologySources,
  type ProjectTopologyRootInput,
} from "./topology/project-topology-source.ts";

interface CliOptions {
  readonly projectKey: string;
  readonly outputRoot: string;
  readonly roots: readonly ProjectTopologyRootInput[];
  readonly maxRoots: number;
  readonly maxSourceBytesPerFile: number;
  readonly maxTotalSourceBytes: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
}

export function parseProjectTopologyCli(args: readonly string[]): CliOptions {
  let projectKey: string | null = null;
  let outputRoot: string | null = null;
  let maxRoots = 32;
  let maxSourceBytesPerFile = 256 * 1024 * 1024;
  let maxTotalSourceBytes = 1024 * 1024 * 1024;
  let maxNodes = 100_000;
  let maxEdges = 250_000;
  const roots: Array<{
    rootTaskId: string;
    oneHopPath?: string;
    multiHopPath?: string;
  }> = [];
  let current: (typeof roots)[number] | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = (): string => {
      const next = args[index + 1];
      if (!next) throw new Error(`OPTION_VALUE_MISSING:${arg}`);
      index += 1;
      return next;
    };
    if (arg === "--project-key") projectKey = value();
    else if (arg === "--output-root") outputRoot = value();
    else if (arg === "--root-task-id") {
      current = { rootTaskId: safeSegment(value(), "rootTaskId") };
      roots.push(current);
    } else if (arg === "--one-hop") {
      if (!current) throw new Error("ONE_HOP_WITHOUT_ROOT");
      current.oneHopPath = resolve(value());
    } else if (arg === "--multi-hop") {
      if (!current) throw new Error("MULTI_HOP_WITHOUT_ROOT");
      current.multiHopPath = resolve(value());
    } else if (arg === "--max-roots") maxRoots = integer(value(), arg);
    else if (arg === "--max-source-bytes-per-file")
      maxSourceBytesPerFile = integer(value(), arg);
    else if (arg === "--max-total-source-bytes")
      maxTotalSourceBytes = integer(value(), arg);
    else if (arg === "--max-nodes") maxNodes = integer(value(), arg);
    else if (arg === "--max-edges") maxEdges = integer(value(), arg);
    else throw new Error(`UNKNOWN_OPTION:${arg}`);
  }
  if (!projectKey || !outputRoot || roots.length === 0)
    throw new Error(usage());
  return {
    projectKey: safeSegment(projectKey, "projectKey"),
    outputRoot: resolve(outputRoot),
    roots: roots.map((root) => {
      if (!root.oneHopPath || !root.multiHopPath)
        throw new Error(`ROOT_ARTIFACT_PAIR_INCOMPLETE:${root.rootTaskId}`);
      return {
        rootTaskId: root.rootTaskId,
        oneHopPath: root.oneHopPath,
        multiHopPath: root.multiHopPath,
      };
    }),
    maxRoots,
    maxSourceBytesPerFile,
    maxTotalSourceBytes,
    maxNodes,
    maxEdges,
  };
}

export function runProjectTopologyCli(args: readonly string[]): void {
  const options = parseProjectTopologyCli(args);
  const roots = loadProjectTopologySources(options.roots, {
    maxRoots: options.maxRoots,
    maxSourceBytesPerFile: options.maxSourceBytesPerFile,
    maxTotalSourceBytes: options.maxTotalSourceBytes,
  });
  const projection = buildProjectTopology({
    projectKey: options.projectKey,
    roots,
    maxNodes: options.maxNodes,
    maxEdges: options.maxEdges,
  });
  const published = publishProjectTopology(projection, {
    outputRoot: options.outputRoot,
  });
  process.stdout.write(
    `${JSON.stringify({
      status: published.status,
      snapshotId: published.manifest.snapshotId,
      directory: published.directory,
      counts: published.manifest.counts,
      coverageStatus: published.manifest.coverageStatus,
    })}\n`,
  );
}

function integer(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`OPTION_INVALID:${option}`);
  return parsed;
}

function usage(): string {
  return "usage: project-topology --project-key <key> --output-root <dir> --root-task-id <id> --one-hop <one-hop.json> --multi-hop <multi-hop.json> [repeat root triple] [--max-roots N] [--max-source-bytes-per-file N] [--max-total-source-bytes N] [--max-nodes N] [--max-edges N]";
}

if (process.argv[1] && basename(process.argv[1]) === "project-topology-cli.ts")
  runProjectTopologyCli(process.argv.slice(2));
