import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { Driver } from "neo4j-driver";

/** Shared bounded connection boundary for data-graph Neo4j consumers. */

export type Neo4jPasswordSource =
  | {
      readonly kind: "ENVIRONMENT";
      readonly variable: string;
    }
  | {
      readonly kind: "FILE";
      readonly path: string;
    };

export interface Neo4jQueryIndexConnectionInput {
  readonly uri: string;
  readonly username: string;
  readonly database: string;
  readonly passwordSource: Neo4jPasswordSource;
  readonly targetAlias?: string;
}

export interface Neo4jQueryIndexConnectionConfig {
  readonly uri: string;
  readonly username: string;
  readonly database: string;
  readonly password: string;
  readonly targetAlias: string | null;
}

type Neo4jDriverModule = typeof import("neo4j-driver");

export function resolveNeo4jQueryIndexConnection(
  input: Neo4jQueryIndexConnectionInput,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Neo4jQueryIndexConnectionConfig {
  validateUri(input.uri);
  const username = boundedText(input.username, "USERNAME", 256);
  const database = databaseName(input.database);
  const targetAlias =
    input.targetAlias === undefined
      ? null
      : boundedText(input.targetAlias, "TARGET_ALIAS", 128);
  const password = resolvePassword(input.passwordSource, environment);
  return { uri: input.uri, username, database, password, targetAlias };
}

/** The driver package is imported only when this explicit Phase 3 factory runs. */
export async function openNeo4jQueryIndexDriver(
  input: Neo4jQueryIndexConnectionInput,
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly importer?: () => Promise<Neo4jDriverModule>;
  } = {},
): Promise<{
  readonly driver: Driver;
  readonly database: string;
  readonly targetAlias: string | null;
}> {
  const config = resolveNeo4jQueryIndexConnection(
    input,
    options.environment ?? process.env,
  );
  try {
    const neo4j = await (options.importer ?? (() => import("neo4j-driver")))();
    const driver = neo4j.driver(
      config.uri,
      neo4j.auth.basic(config.username, config.password),
      {
        disableLosslessIntegers: false,
      },
    );
    return {
      driver,
      database: config.database,
      targetAlias: config.targetAlias,
    };
  } catch (error) {
    throw boundedNeo4jConnectionError("OPEN", error);
  }
}

export function boundedNeo4jConnectionError(
  operation: string,
  error: unknown,
): Error {
  const code = safeErrorCode(error);
  return new Error(
    `QUERY_INDEX_NEO4J_${safeOperation(operation)}_FAILED${code === null ? "" : `:${code}`}`,
  );
}

function resolvePassword(
  source: Neo4jPasswordSource,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (source.kind === "ENVIRONMENT") {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(source.variable))
      throw new Error("QUERY_INDEX_NEO4J_PASSWORD_ENV_INVALID");
    const value = environment[source.variable];
    if (value === undefined || value.length === 0)
      throw new Error("QUERY_INDEX_NEO4J_PASSWORD_ENV_MISSING");
    return value;
  }
  const path = resolve(source.path);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error("QUERY_INDEX_NEO4J_PASSWORD_FILE_UNREADABLE");
  }
  if (size < 1 || size > 16 * 1024)
    throw new Error("QUERY_INDEX_NEO4J_PASSWORD_FILE_SIZE_INVALID");
  let value: string;
  try {
    value = readFileSync(path, "utf8").replace(/[\r\n]+$/u, "");
  } catch {
    throw new Error("QUERY_INDEX_NEO4J_PASSWORD_FILE_UNREADABLE");
  }
  if (value.length === 0)
    throw new Error("QUERY_INDEX_NEO4J_PASSWORD_FILE_EMPTY");
  return value;
}

function validateUri(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("QUERY_INDEX_NEO4J_URI_INVALID");
  }
  if (
    ![
      "neo4j:",
      "neo4j+s:",
      "neo4j+ssc:",
      "bolt:",
      "bolt+s:",
      "bolt+ssc:",
    ].includes(parsed.protocol)
  )
    throw new Error("QUERY_INDEX_NEO4J_URI_SCHEME_INVALID");
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  )
    throw new Error("QUERY_INDEX_NEO4J_URI_COMPONENT_INVALID");
}

function databaseName(value: string): string {
  const name = boundedText(value, "DATABASE", 63);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))
    throw new Error("QUERY_INDEX_NEO4J_DATABASE_INVALID");
  return name;
}

function boundedText(value: string, label: string, maxLength: number): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\r\n\0]/u.test(value)
  )
    throw new Error(`QUERY_INDEX_NEO4J_${label}_INVALID`);
  return value;
}

function safeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  const value = String(error.code).replace(/[^A-Za-z0-9._-]/gu, "_");
  return value.slice(0, 96) || null;
}

function safeOperation(value: string): string {
  return value.replace(/[^A-Z0-9_]/giu, "_").slice(0, 48) || "OPERATION";
}
