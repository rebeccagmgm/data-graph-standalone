import { join, resolve } from "node:path";
import { resolveWorkspacePaths } from "../../../../scripts/config/workspace-paths.ts";
import { buildTableMetadataCatalog } from "./table-metadata-catalog-build.ts";
import {
  defaultTableMetadataCatalogRoot,
  TableMetadataCatalog,
} from "./table-metadata-catalog.ts";

const value = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

function integer(
  args: readonly string[],
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = value(args, name);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum)
    throw new Error(`INVALID_ARGUMENT:${name}`);
  return parsed;
}

export async function tableMetadataCatalogMain(
  args = process.argv.slice(2),
): Promise<void> {
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help") {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        commands: ["build", "update", "status", "query", "fields"],
        identity: ["--platform", "--data-source", "--qualified-name"],
        optional: [
          "--stable-table-id",
          "--column",
          "--scope-platform",
          "--limit",
          "--offset",
          "--config",
          "--tables-root",
          "--catalog-root",
        ],
      })}\n`,
    );
    return;
  }
  const configPath = value(args, "--config");
  const paths = resolveWorkspacePaths({ configPath });
  const tablesRoot = resolve(
    value(args, "--tables-root") ?? join(paths.inputPackRoot, "tables"),
  );
  const catalogRoot = resolve(
    value(args, "--catalog-root") ??
      defaultTableMetadataCatalogRoot(paths.evidenceRoot),
  );
  if (command === "build" || command === "update") {
    const scopePlatform = value(args, "--scope-platform");
    const platform = value(args, "--platform");
    const stableTableId = value(args, "--stable-table-id");
    if ((platform && !stableTableId) || (!platform && stableTableId))
      throw new Error("SCOPED_TABLE_REQUIRES_PLATFORM_AND_STABLE_TABLE_ID");
    const scope = scopePlatform
      ? { platforms: [scopePlatform] }
      : platform && stableTableId
        ? { tables: [{ platform, stableTableId }] }
        : undefined;
    const data = buildTableMetadataCatalog({ tablesRoot, catalogRoot, scope });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: "1.0.0", ok: true, command, data })}\n`,
    );
    return;
  }
  const catalog = new TableMetadataCatalog(catalogRoot);
  try {
    if (command === "status") {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: "1.0.0", ok: true, command, data: catalog.status() })}\n`,
      );
      return;
    }
    if (command !== "query" && command !== "fields")
      throw new Error("INVALID_COMMAND");
    const identity = {
      platform: value(args, "--platform"),
      dataSource: value(args, "--data-source"),
      qualifiedName: value(args, "--qualified-name"),
      stableTableId: value(args, "--stable-table-id"),
      identityStatus: "CONFIRMED",
    };
    const data =
      command === "query"
        ? await catalog.resolve(identity, value(args, "--column"))
        : await catalog.listFields(identity, {
            limit: integer(args, "--limit", 100, 1000),
            offset: integer(args, "--offset", 0, 1_000_000),
          });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: "1.0.0", ok: true, command, data })}\n`,
    );
  } finally {
    catalog.close();
  }
}

if (process.argv[1]?.endsWith("table-metadata-catalog-cli.ts")) {
  tableMetadataCatalogMain().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
