import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveWorkspacePaths } from "../../../../scripts/config/workspace-paths.ts";
import { openNeo4jQueryIndexDriver } from "../neo4j/connection.ts";

export function assetGraphConfig(
  configPath?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const paths = resolveWorkspacePaths({ configPath, env });
  const workspace = JSON.parse(
    readFileSync(paths.configPath, "utf8").replace(/^\uFEFF/, ""),
  );
  const legacy = !Object.hasOwn(workspace, "graphDatabase");
  const config = legacy ? workspace.neo4j : workspace.graphDatabase;
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error(
      legacy
        ? "WORKSPACE_NEO4J_CONFIG_MISSING"
        : "GRAPH_DATABASE_CONFIG_INVALID",
    );
  const provider = legacy ? "neo4j" : config.provider;
  if (provider !== "neo4j" && provider !== "arcadedb")
    throw new Error("GRAPH_DATABASE_PROVIDER_UNSUPPORTED");
  const passwordFile =
    env[String(config.passwordFileEnv)] ||
    (typeof config.passwordFile === "string" && config.passwordFile.trim()
      ? resolve(dirname(paths.configPath), config.passwordFile)
      : undefined);
  if (!passwordFile)
    throw new Error(
      legacy
        ? "NEO4J_PASSWORD_FILE_ENV_MISSING"
        : "GRAPH_DATABASE_PASSWORD_FILE_MISSING",
    );
  return {
    paths,
    provider: provider as "neo4j" | "arcadedb",
    graphId: String(config.graphId),
    connection: {
      uri: String(config.uri),
      username: String(config.username),
      database: String(config.database),
      passwordSource: { kind: "FILE" as const, path: passwordFile },
    },
  };
}
export async function openAssetGraph(configPath?: string) {
  const config = assetGraphConfig(configPath);
  return { ...config, ...(await openNeo4jQueryIndexDriver(config.connection)) };
}
