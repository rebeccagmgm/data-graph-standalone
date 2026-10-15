import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveWorkspacePaths } from "../../../../scripts/config/workspace-paths.ts";
import { openArcadeDbConnection } from "../arcadedb/connection.ts";

export function assetGraphConfig(
  configPath?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const paths = resolveWorkspacePaths({ configPath, env });
  const workspace = JSON.parse(
    readFileSync(paths.configPath, "utf8").replace(/^\uFEFF/, ""),
  );
  const config = workspace.graphDatabase;
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("GRAPH_DATABASE_CONFIG_INVALID");
  const provider = config.provider;
  if (provider !== "arcadedb")
    throw new Error("GRAPH_DATABASE_PROVIDER_UNSUPPORTED");
  const passwordFile =
    env[String(config.passwordFileEnv)] ||
    (typeof config.passwordFile === "string" && config.passwordFile.trim()
      ? resolve(dirname(paths.configPath), config.passwordFile)
      : undefined);
  if (!passwordFile)
    throw new Error("GRAPH_DATABASE_PASSWORD_FILE_MISSING");
  return {
    paths,
    provider: "arcadedb" as const,
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
  return { ...config, ...(await openArcadeDbConnection(config.connection)) };
}
