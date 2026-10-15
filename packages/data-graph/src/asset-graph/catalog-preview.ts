import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateTaskLocalProjection,
  type TaskLocalProjection,
} from "../../../../scripts/project-graph/task-local/contract.ts";
import { unpackTaskLocalProjectionEnvelope } from "../continuation/task-local-projection.ts";
import {
  ASSET_CATALOG_COMPILER_VERSION,
  compileCatalogTask,
} from "./compile-catalog.ts";
import type { CompiledTask, FactRecord } from "./compile.ts";

function counts(values: readonly { kind: string }[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values)
    result[value.kind] = (result[value.kind] ?? 0) + 1;
  return result;
}

/** Asset grouping is a catalogue view; it does not establish cross-task value paths. */
export function catalogCoverage(graph: CompiledTask) {
  const mappedPorts = new Set(
    graph.edges
      .filter((edge) => edge.kind === "OBSERVES_COLUMN")
      .map((edge) => edge.from),
  );
  return {
    nodeCounts: counts(graph.nodes),
    edgeCounts: counts(graph.edges),
    unmappedWriteFields: graph.writes
      .filter((port) => !mappedPorts.has(port.id))
      .map((port) => port.id),
    unmappedReadFields: graph.reads
      .filter((port) => !mappedPorts.has(port.id))
      .map((port) => port.id),
    unresolvedReadFields: graph.nodes
      .filter((node) => node.kind === "UNRESOLVED_READ_FIELD")
      .map((node) => node.id),
    catalogueCompleteness: "OBSERVED_FIELDS_ONLY",
    crossTaskContinuation: "NOT_EVALUATED",
    businessEquivalence: "NOT_EVALUATED",
  };
}

export function previewAssetCatalog(input: {
  projectionPath: string;
  bindingsPath?: string;
  outputPath: string;
}) {
  const projectionPath = resolve(input.projectionPath);
  const outputPath = resolve(input.outputPath);
  const bindingsPath = input.bindingsPath
    ? resolve(input.bindingsPath)
    : undefined;
  if (
    [projectionPath, bindingsPath].some(
      (path) => path?.toLowerCase() === outputPath.toLowerCase(),
    )
  ) {
    throw new Error("ASSET_CATALOG_OUTPUT_OVERWRITES_INPUT");
  }
  const raw: unknown = JSON.parse(readFileSync(projectionPath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ASSET_CATALOG_PROJECTION_MUST_BE_OBJECT");
  }
  if ("projection" in raw) {
    unpackTaskLocalProjectionEnvelope({
      envelope: raw,
      // Preview checks the local snapshot, not an external publication manifest.
      manifestTaskContentHash:
        "projectionContentHash" in raw &&
        typeof raw.projectionContentHash === "string"
          ? raw.projectionContentHash
          : "",
    });
  }
  // The union reader returns a reduced body; retain full 1.3 field evidence and gaps.
  const projection = (
    "projection" in raw ? raw.projection : raw
  ) as TaskLocalProjection;
  validateTaskLocalProjection(projection);
  const bindings: FactRecord[] = bindingsPath
    ? JSON.parse(readFileSync(bindingsPath, "utf8"))
    : [];
  if (
    !Array.isArray(bindings) ||
    bindings.some(
      (binding) =>
        !binding || typeof binding !== "object" || Array.isArray(binding),
    )
  ) {
    throw new Error("ASSET_CATALOG_BINDINGS_MUST_BE_RECORD_ARRAY");
  }
  const graph = compileCatalogTask(projection, bindings);
  const summary = catalogCoverage(graph);
  const preview = {
    artifactType: "ASSET_CATALOG_PREVIEW",
    compilerVersion: ASSET_CATALOG_COMPILER_VERSION,
    taskId: projection.taskId,
    sourceProjectionHash: projection.contentHash,
    sourceProjectionSchema: projection.schemaVersion,
    sourceValidation: "LOCAL_PROJECTION_HASH_VERIFIED",
    publicationManifestValidation: "NOT_EVALUATED",
    sourceGaps: projection.gaps ?? [],
    summary,
    graph,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(preview, null, 2)}\n`, "utf8");
  return { taskId: projection.taskId, ...summary };
}

function main(args: string[]): void {
  if (args.includes("--help")) {
    process.stdout.write(
      "catalog-preview --projection <json> [--bindings <json-array>] --output <json>\n",
    );
    return;
  }
  const allowed = new Set(["--projection", "--bindings", "--output"]);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!,
      value = args[i + 1];
    if (
      !allowed.has(name) ||
      options.has(name) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error("ASSET_CATALOG_INVALID_ARGUMENTS");
    }
    options.set(name, value);
  }
  if (!options.has("--projection") || !options.has("--output")) {
    throw new Error("ASSET_CATALOG_PROJECTION_AND_OUTPUT_REQUIRED");
  }
  const result = previewAssetCatalog({
    projectionPath: options.get("--projection")!,
    bindingsPath: options.get("--bindings"),
    outputPath: options.get("--output")!,
  });
  process.stdout.write(
    `${JSON.stringify({
      taskId: result.taskId,
      nodeCounts: result.nodeCounts,
      edgeCounts: result.edgeCounts,
      unmappedReadFieldCount: result.unmappedReadFields.length,
      unmappedWriteFieldCount: result.unmappedWriteFields.length,
      unresolvedReadFieldCount: result.unresolvedReadFields.length,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2));
}
