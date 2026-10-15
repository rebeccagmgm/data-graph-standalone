import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_WORKSPACE_CONFIG_PATH = fileURLToPath(
  new URL("../../config/workspace-paths.json", import.meta.url),
);

const PATH_KEYS = [
  "dataRoot",
  "evidenceRoot",
  "inputPackRoot",
  "factsRoot",
  "projectionRoot",
  "graphRoot",
  "writerCatalogPath",
] as const;
type PathKey = (typeof PATH_KEYS)[number];
type OverrideKey = PathKey | "continuationIndexPath";

export interface WorkspacePaths {
  readonly configPath: string;
  readonly profile: string;
  readonly dataRoot: string;
  readonly evidenceRoot: string;
  readonly inputPackRoot: string;
  readonly factsRoot: string;
  readonly projectionRoot: string;
  readonly graphRoot: string;
  readonly graphOutputRoot: string;
  readonly batchManifestPath: string;
  readonly continuationIndexPath: string;
  readonly writerCatalogPath: string;
}

export interface WorkspacePathOptions {
  readonly configPath?: string;
  readonly profile?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly overrides?: Readonly<Partial<Record<OverrideKey, string>>>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(code);
  return value as Record<string, unknown>;
}

function assertKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key))
      throw new Error(`WORKSPACE_CONFIG_UNKNOWN_KEY:${key}`);
  }
}

/** Resolve paths only. Does not create directories, scan data, or load Facts. */
export function resolveWorkspacePaths(
  options: WorkspacePathOptions = {},
): WorkspacePaths {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configPath = resolve(
    cwd,
    options.configPath ??
      nonEmpty(env.LINEAGE_CONFIG) ??
      DEFAULT_WORKSPACE_CONFIG_PATH,
  );
  let bytes: string;
  try {
    bytes = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`WORKSPACE_CONFIG_UNREADABLE:${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("WORKSPACE_CONFIG_JSON_INVALID");
  }
  const config = object(parsed, "WORKSPACE_CONFIG_INVALID");
  assertKeys(config, [
    "schemaVersion",
    ...PATH_KEYS,
    "activeProfile",
    "graphDatabase",
    "profiles",
  ]);
  if (config.schemaVersion !== "1.0.0")
    throw new Error("WORKSPACE_CONFIG_VERSION_UNSUPPORTED");
  const configuredPath = (key: PathKey): string => {
    const value = nonEmpty(config[key]);
    if (!value) throw new Error(`WORKSPACE_CONFIG_PATH_INVALID:${key}`);
    return value;
  };
  // Validate all configured paths, including values masked by an override.
  for (const key of PATH_KEYS) configuredPath(key);
  const profiles = object(config.profiles, "WORKSPACE_CONFIG_PROFILES_INVALID");
  for (const value of Object.values(profiles)) {
    const entry = object(value, "WORKSPACE_CONFIG_PROFILE_INVALID");
    assertKeys(entry, ["batch", "continuationIndexPath"]);
    if (
      typeof entry.batch !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.batch)
    ) {
      throw new Error("WORKSPACE_CONFIG_BATCH_INVALID");
    }
    if (
      entry.continuationIndexPath !== undefined &&
      !nonEmpty(entry.continuationIndexPath)
    ) {
      throw new Error("WORKSPACE_CONFIG_PATH_INVALID:continuationIndexPath");
    }
  }
  const profile =
    options.profile ??
    nonEmpty(env.LINEAGE_PROFILE) ??
    nonEmpty(config.activeProfile);
  if (!profile || !Object.hasOwn(profiles, profile))
    throw new Error("WORKSPACE_CONFIG_PROFILE_UNKNOWN");
  const selected = profiles[profile] as {
    batch: string;
    continuationIndexPath?: string;
  };
  const envPaths: Partial<Record<OverrideKey, string | undefined>> = {
    dataRoot: env.LINEAGE_DATA_ROOT ?? env.TASK_LOCAL_GOLDEN_DATA_ROOT,
    evidenceRoot:
      env.LINEAGE_EVIDENCE_ROOT ?? env.FIELD_EVIDENCE_SCHEDULE_CACHE_ROOT,
    inputPackRoot:
      env.LINEAGE_INPUT_PACK_ROOT ?? env.TASK_LOCAL_GOLDEN_DATA_ROOT,
    factsRoot: env.LINEAGE_FACTS_ROOT ?? env.TASK_LOCAL_GOLDEN_FACTS_ROOT,
    projectionRoot: env.LINEAGE_PROJECTION_ROOT,
    graphRoot: env.LINEAGE_GRAPH_ROOT,
    writerCatalogPath: env.WRITER_CATALOG_PATH,
    continuationIndexPath: env.FIELD_EVIDENCE_INDEX_PATH,
  };
  const overridden = (key: OverrideKey): string | null => {
    const explicit = options.overrides?.[key];
    if (explicit !== undefined && !nonEmpty(explicit))
      throw new Error(`WORKSPACE_CONFIG_PATH_INVALID:${key}`);
    const value = nonEmpty(explicit) ?? nonEmpty(envPaths[key]);
    return value ? resolve(cwd, value) : null;
  };
  const dataRoot =
    overridden("dataRoot") ??
    resolve(dirname(configPath), configuredPath("dataRoot"));
  const child = (key: PathKey): string =>
    overridden(key) ?? resolve(dataRoot, configuredPath(key));
  const graphRoot = child("graphRoot");
  const graphOutputRoot = resolve(graphRoot, selected.batch);
  return {
    configPath,
    profile,
    dataRoot,
    evidenceRoot:
      overridden("evidenceRoot") ??
      resolve(dirname(configPath), configuredPath("evidenceRoot")),
    inputPackRoot: child("inputPackRoot"),
    factsRoot: child("factsRoot"),
    projectionRoot: child("projectionRoot"),
    graphRoot,
    graphOutputRoot,
    batchManifestPath: resolve(graphOutputRoot, "batch-manifest.json"),
    continuationIndexPath:
      overridden("continuationIndexPath") ??
      (selected.continuationIndexPath
        ? resolve(dataRoot, selected.continuationIndexPath)
        : resolve(graphOutputRoot, "union-continuation-index.json")),
    writerCatalogPath: child("writerCatalogPath"),
  };
}
