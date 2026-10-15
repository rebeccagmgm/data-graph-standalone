import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { importDatasourceAliases } from "./aliases.ts";

import {
  buildDatasourceCatalog,
  catalogStatus,
  queryDatasourceRecords,
  queryDatasourceAliases,
  querySchemaMatches,
  querySchemas,
  type DatasourceQueryOptions,
  type SchemaQueryOptions,
} from "./catalog.ts";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const originalInformationRoot = resolve(
  repositoryRoot,
  "..",
  "数综基础信息",
  "原信息",
);

export const DEFAULT_HORAE_DIR = join(
  originalInformationRoot,
  "horae-datasource",
);
export const DEFAULT_SZDATA_DIR = join(
  originalInformationRoot,
  "szdata-datasource",
);
export const DEFAULT_DATABASE_PATH = resolve(
  repositoryRoot,
  "artifacts",
  "datasource-catalog",
  "datasource-catalog.sqlite",
);
export const DEFAULT_ANNOTATIONS_PATH = resolve(
  repositoryRoot,
  "config",
  "schema-annotations.json",
);

const COMMANDS = new Set([
  "build",
  "status",
  "datasources",
  "schemas",
  "schema-match",
  "import-aliases",
  "aliases",
]);
const OPTIONS = new Set([
  "source",
  "horae-dir",
  "szdata-dir",
  "database",
  "annotations",
  "q",
  "identifier",
  "db-type",
  "match-status",
  "schema",
  "name",
  "limit",
  "offset",
]);

interface ParsedArgs {
  readonly command: string;
  readonly values: ReadonlyMap<string, string>;
}

function failure(code: string, detail = ""): Error {
  return new Error(detail === "" ? code : `${code}:${detail}`);
}

export function parseDatasourceCatalogArgs(
  argv: readonly string[],
): ParsedArgs {
  const args = [...argv];
  const command = args.shift() ?? "status";
  if (!COMMANDS.has(command)) throw failure("UNKNOWN_COMMAND", command);
  const values = new Map<string, string>();
  while (args.length > 0) {
    const flag = args.shift()!;
    if (!flag.startsWith("--")) throw failure("INVALID_ARGUMENT", flag);
    const name = flag.slice(2);
    if (!OPTIONS.has(name)) throw failure("UNKNOWN_OPTION", flag);
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) {
      throw failure("OPTION_VALUE_REQUIRED", flag);
    }
    values.set(name, value);
  }
  return { command, values };
}

function optionalInteger(
  values: ReadonlyMap<string, string>,
  name: string,
): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw)) throw failure("INVALID_INTEGER", name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw failure("INVALID_INTEGER", name);
  return value;
}

function queryOptions(
  values: ReadonlyMap<string, string>,
): DatasourceQueryOptions {
  const matchStatus = values.get("match-status");
  if (
    matchStatus !== undefined &&
    !["CONFIRMED", "CANDIDATE", "UNRESOLVED"].includes(matchStatus)
  ) {
    throw failure("INVALID_MATCH_STATUS", matchStatus);
  }
  return {
    q: values.get("q"),
    identifier: values.get("identifier"),
    dbType: values.get("db-type"),
    matchStatus: matchStatus as DatasourceQueryOptions["matchStatus"],
    schema: values.get("schema"),
    limit: optionalInteger(values, "limit"),
    offset: optionalInteger(values, "offset"),
  };
}

function schemaOptions(
  values: ReadonlyMap<string, string>,
): SchemaQueryOptions {
  const matchStatus = values.get("match-status");
  if (
    matchStatus !== undefined &&
    !["CONFIRMED", "CANDIDATE", "UNRESOLVED"].includes(matchStatus)
  ) {
    throw failure("INVALID_MATCH_STATUS", matchStatus);
  }
  return {
    q: values.get("q"),
    name: values.get("name"),
    identifier: values.get("identifier"),
    matchStatus: matchStatus as SchemaQueryOptions["matchStatus"],
    limit: optionalInteger(values, "limit"),
    offset: optionalInteger(values, "offset"),
  };
}

export function datasourceCatalogHelp(): unknown {
  return {
    commands: ["build", "status", "datasources", "schemas", "schema-match", "import-aliases", "aliases"],
    examples: [
      "npm run --silent datasource-catalog:build",
      "npm run --silent datasource-catalog:query -- status",
      "npm run --silent datasource-catalog:query -- datasources --schema public --limit 20",
      "npm run --silent datasource-catalog:query -- schema-match --name public --limit 20",
    ],
    matchStatuses: ["CONFIRMED", "CANDIDATE", "UNRESOLVED"],
    limits: { pageSize: 100, offset: 10_000_000 },
  };
}

export function runDatasourceCatalogCommand(parsed: ParsedArgs): unknown {
  const databasePath = resolve(
    parsed.values.get("database") ?? DEFAULT_DATABASE_PATH,
  );
  if (parsed.command === "import-aliases") {
    const source = parsed.values.get("source");
    if (!source) throw failure("OPTION_VALUE_REQUIRED", "--source");
    return importDatasourceAliases(resolve(source), databasePath);
  }
  if (parsed.command === "build") {
    return buildDatasourceCatalog({
      horaeDir: resolve(parsed.values.get("horae-dir") ?? DEFAULT_HORAE_DIR),
      szdataDir: resolve(parsed.values.get("szdata-dir") ?? DEFAULT_SZDATA_DIR),
      databasePath,
      annotationsPath: resolve(
        parsed.values.get("annotations") ?? DEFAULT_ANNOTATIONS_PATH,
      ),
    });
  }
  if (!existsSync(databasePath))
    throw failure("CATALOG_NOT_READY", databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (parsed.command === "status") return catalogStatus(database);
    if (parsed.command === "aliases") return queryDatasourceAliases(database, queryOptions(parsed.values));
    if (parsed.command === "datasources") {
      return queryDatasourceRecords(database, queryOptions(parsed.values));
    }
    if (parsed.command === "schemas") {
      return querySchemas(database, schemaOptions(parsed.values));
    }
    return querySchemaMatches(database, schemaOptions(parsed.values));
  } finally {
    database.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv[2] === "help") {
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: datasourceCatalogHelp() })}\n`,
    );
    return;
  }
  try {
    const parsed = parseDatasourceCatalogArgs(process.argv.slice(2));
    const data = runDatasourceCatalogCommand(parsed);
    process.stdout.write(
      `${JSON.stringify({ ok: true, command: parsed.command, data })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: message.split(":", 1)[0],
          message,
        },
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
