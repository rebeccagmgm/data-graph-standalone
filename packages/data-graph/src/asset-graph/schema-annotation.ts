import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { MetadataIdentity } from "./table-metadata-catalog.ts";

export interface SchemaAnnotation {
  readonly displayName?: string;
  readonly description?: string;
}

interface AnnotationRow {
  readonly display_name: string;
  readonly description: string;
}

const moduleRoot = dirname(fileURLToPath(import.meta.url));

export function defaultDatasourceCatalogPath(): string {
  return resolve(
    moduleRoot,
    "../../../..",
    "artifacts",
    "datasource-catalog",
    "datasource-catalog.sqlite",
  );
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function schemaName(qualifiedName: unknown): string {
  const parts = normalized(qualifiedName).split(".").filter(Boolean);
  return parts.length < 2 ? "" : parts.at(-2)!;
}

function signature(path: string): string {
  const stat = statSync(path);
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/**
 * Runtime-only schema label enrichment. The physical graph identity remains
 * canonical; this resolver adds no graph node or edge and returns no internal
 * datasource details to the UI.
 */
export class SchemaAnnotationResolver {
  private database: DatabaseSync | undefined;
  private databaseSignature = "";

  constructor(private readonly databasePath = defaultDatasourceCatalogPath()) {}

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.databaseSignature = "";
  }

  private ensureOpen(): DatabaseSync | undefined {
    if (!existsSync(this.databasePath)) {
      this.close();
      return undefined;
    }
    let next: DatabaseSync | undefined;
    let nextSignature = "";
    try {
      nextSignature = signature(this.databasePath);
      if (this.database && nextSignature === this.databaseSignature) {
        return this.database;
      }
      next = new DatabaseSync(this.databasePath, { readOnly: true });
      next.prepare("SELECT 1 FROM schema_annotation LIMIT 1").get();
    } catch {
      try {
        next?.close();
      } catch {
        // Ignore cleanup failures: schema labels are optional enrichment.
      }
      this.close();
      return undefined;
    }
    const previous = this.database;
    this.database = next;
    this.databaseSignature = nextSignature;
    previous?.close();
    return next;
  }

  resolve(
    identity: MetadataIdentity | undefined,
  ): SchemaAnnotation | undefined {
    if (!identity) return undefined;
    const platform = normalized(identity.platform);
    const dataSource = normalized(identity.dataSource);
    const schema = schemaName(identity.qualifiedName);
    if (!platform || !dataSource || !schema) return undefined;
    const database = this.ensureOpen();
    if (!database) return undefined;
    const row = database
      .prepare(
        `SELECT display_name, description FROM schema_annotation
         WHERE platform_norm=? AND data_source_norm=? AND schema_name_norm=?`,
      )
      .get(platform, dataSource, schema) as AnnotationRow | undefined;
    if (!row) return undefined;
    const displayName = row.display_name.trim();
    const description = row.description.trim();
    if (!displayName && !description) return undefined;
    return {
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
    };
  }

  resolveMany(
    identities: readonly (MetadataIdentity | undefined)[],
  ): readonly (SchemaAnnotation | undefined)[] {
    return identities.map((identity) => this.resolve(identity));
  }
}
