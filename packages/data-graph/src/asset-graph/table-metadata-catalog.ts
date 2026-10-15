import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TABLE_METADATA_CATALOG_SCHEMA_VERSION = "1.0.0" as const;

export function defaultTableMetadataCatalogRoot(evidenceRoot: string): string {
  const root = resolve(evidenceRoot);
  const leaf = basename(root).toLowerCase();
  if (leaf === "tasks-sqlite") return join(root, "table-metadata-catalog");
  if (leaf === "schedule-evidence")
    return join(root, "tasks-sqlite", "table-metadata-catalog");
  return join(
    root,
    "schedule-evidence",
    "tasks-sqlite",
    "table-metadata-catalog",
  );
}

export type MetadataStatus =
  | "AVAILABLE"
  | "ANNOTATION_NOT_RECORDED"
  | "METADATA_UNAVAILABLE"
  | "METADATA_READ_FAILED";

export interface MetadataIdentity {
  readonly platform?: string;
  readonly dataSource?: string;
  readonly qualifiedName?: string;
  readonly stableTableId?: string;
  readonly identityStatus?: string;
}

export interface MetadataSearchIdentity {
  readonly platform: string;
  readonly dataSource: string;
  readonly qualifiedName: string;
}

export interface MetadataValue {
  readonly status: MetadataStatus;
  readonly reason?: string;
  readonly description?: string;
  readonly comment?: string;
  readonly name?: string;
  readonly ordinal?: number;
  readonly rawType?: string;
  readonly partition?: boolean;
}

export interface MetadataCatalogState {
  readonly status: "READY" | "MISSING" | "UNREADABLE" | "INCOMPATIBLE";
  readonly reason?: string;
  readonly version?: string;
  readonly builtAt?: string;
  readonly parserVersion?: string;
}

export interface TableMetadata {
  readonly table: MetadataValue;
  readonly field?: MetadataValue;
  readonly identity?: {
    readonly platform: string;
    readonly dataSource: string;
    readonly qualifiedName: string;
    readonly stableTableId: string;
  };
  readonly tableName?: string;
  readonly objectType?: string;
  readonly source?: string;
  readonly sourcePath?: string;
  readonly sourceHash?: string;
  readonly ddlHash?: string;
  readonly collectedAt?: string;
  readonly updatedAt?: string;
  readonly contentHash?: string;
  readonly parseStatus?: "PARSED" | "UNSUPPORTED" | "INVALID";
  readonly metadataCatalog: MetadataCatalogState;
  /** Input Packs are live material, while graph versions are published snapshots. */
  readonly versionRelation?: "RUNTIME_INPUT_PACK_NOT_GRAPH_VERSION";
}

export interface CatalogField {
  readonly name: string;
  readonly ordinal: number;
  readonly rawType: string;
  readonly comment?: string;
  readonly partition: boolean;
  readonly status: MetadataStatus;
  readonly reason?: string;
}

interface CatalogManifest {
  readonly schemaVersion: string;
  readonly version: string;
  readonly file: string;
  readonly builtAt: string;
  readonly parserVersion: string;
  readonly catalogHash: string;
}

interface TableRow {
  readonly id: number;
  readonly stable_table_id: string;
  readonly platform: string;
  readonly data_source: string;
  readonly qualified_name: string;
  readonly table_name: string;
  readonly description: string;
  readonly object_type: string;
  readonly source: string;
  readonly source_path: string;
  readonly source_hash: string;
  readonly ddl_hash: string;
  readonly content_hash: string;
  readonly collected_at: string;
  readonly updated_at: string;
  readonly parse_status: "PARSED" | "UNSUPPORTED" | "INVALID";
}

interface FieldRow {
  readonly table_id?: number;
  readonly name: string;
  readonly ordinal: number;
  readonly raw_type: string;
  readonly comment: string;
  readonly is_partition: number;
}

interface IssueRow {
  readonly reason: string;
}

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const normalized = (value: unknown) => text(value).toLowerCase();

function unavailable(
  reason: string,
  fieldRequested: boolean,
  metadataCatalog: MetadataCatalogState,
): TableMetadata {
  const value: MetadataValue = { status: "METADATA_UNAVAILABLE", reason };
  return {
    table: value,
    ...(fieldRequested ? { field: value } : {}),
    metadataCatalog,
  };
}

function failed(
  reason: string,
  fieldRequested: boolean,
  metadataCatalog: MetadataCatalogState,
): TableMetadata {
  const value: MetadataValue = { status: "METADATA_READ_FAILED", reason };
  return {
    table: value,
    ...(fieldRequested ? { field: value } : {}),
    metadataCatalog,
  };
}

/**
 * Read-only metadata catalog shared by HTTP enrichment and agent queries.
 * It reopens only when the tiny current.json pointer changes; it never scans
 * Table Input Packs and it never parses DDL in the request path.
 */
export class TableMetadataCatalog {
  private database: DatabaseSync | undefined;
  private manifestSignature = "";
  private manifest: CatalogManifest | undefined;

  constructor(private readonly catalogRoot: string) {}

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.manifest = undefined;
    this.manifestSignature = "";
  }

  private state(status: MetadataCatalogState["status"], reason?: string) {
    return {
      status,
      ...(reason ? { reason } : {}),
      ...(this.manifest
        ? {
            version: this.manifest.version,
            builtAt: this.manifest.builtAt,
            parserVersion: this.manifest.parserVersion,
          }
        : {}),
    } satisfies MetadataCatalogState;
  }

  private ensureOpen(): MetadataCatalogState {
    const manifestPath = join(this.catalogRoot, "current.json");
    if (!existsSync(manifestPath)) {
      this.close();
      return this.state("MISSING", "METADATA_CATALOG_MISSING");
    }
    let signature: string;
    let parsed: CatalogManifest;
    try {
      const source = readFileSync(manifestPath, "utf8");
      signature = source;
      if (
        this.database &&
        this.manifest &&
        signature === this.manifestSignature
      )
        return this.state("READY");
      parsed = JSON.parse(source) as CatalogManifest;
    } catch {
      this.close();
      return this.state("UNREADABLE", "METADATA_CATALOG_UNREADABLE");
    }
    if (parsed.schemaVersion !== TABLE_METADATA_CATALOG_SCHEMA_VERSION) {
      this.close();
      return this.state("INCOMPATIBLE", "METADATA_CATALOG_VERSION_UNSUPPORTED");
    }
    if (
      !text(parsed.version) ||
      !text(parsed.file) ||
      !text(parsed.builtAt) ||
      !text(parsed.parserVersion) ||
      !text(parsed.catalogHash)
    ) {
      this.close();
      return this.state("UNREADABLE", "METADATA_CATALOG_MANIFEST_INVALID");
    }
    const databasePath = resolve(this.catalogRoot, parsed.file);
    try {
      const next = new DatabaseSync(databasePath, { readOnly: true });
      const schema = next
        .prepare("SELECT value FROM catalog_meta WHERE key='schema_version'")
        .get() as { value?: unknown } | undefined;
      if (schema?.value !== TABLE_METADATA_CATALOG_SCHEMA_VERSION) {
        next.close();
        this.close();
        return this.state(
          "INCOMPATIBLE",
          "METADATA_CATALOG_VERSION_UNSUPPORTED",
        );
      }
      const prior = this.database;
      this.database = next;
      this.manifest = parsed;
      this.manifestSignature = signature;
      prior?.close();
      return this.state("READY");
    } catch {
      this.close();
      return this.state("UNREADABLE", "METADATA_CATALOG_UNREADABLE");
    }
  }

  status(): MetadataCatalogState {
    return this.ensureOpen();
  }

  private tableRows(identity: MetadataIdentity): readonly TableRow[] {
    const stable = text(identity.stableTableId);
    return this.database!.prepare(
      `SELECT * FROM tables
         WHERE platform=? AND data_source=? AND qualified_name=?
           AND (?='' OR stable_table_id=?)
         ORDER BY source_path LIMIT 2`,
    ).all(
      normalized(identity.platform),
      normalized(identity.dataSource),
      normalized(identity.qualifiedName),
      stable,
      stable,
    ) as unknown as readonly TableRow[];
  }

  private identityKey(identity: MetadataIdentity): string {
    return [
      normalized(identity.platform),
      normalized(identity.dataSource),
      normalized(identity.qualifiedName),
    ].join("\u0000");
  }

  private batchTableRows(
    identities: readonly MetadataIdentity[],
  ): ReadonlyMap<string, readonly TableRow[]> {
    const keys = new Map<string, readonly [string, string, string]>();
    for (const identity of identities) {
      const values = [
        normalized(identity.platform),
        normalized(identity.dataSource),
        normalized(identity.qualifiedName),
      ] as const;
      if (values.every(Boolean)) keys.set(values.join("\u0000"), values);
    }
    const result = new Map<string, TableRow[]>();
    const entries = [...keys.entries()];
    for (let start = 0; start < entries.length; start += 100) {
      const chunk = entries.slice(start, start + 100);
      const rows = this.database!.prepare(
        `SELECT * FROM tables WHERE ${chunk
          .map(() => "(platform=? AND data_source=? AND qualified_name=?)")
          .join(" OR ")} ORDER BY source_path`,
      ).all(...chunk.flatMap(([, values]) => values)) as unknown as TableRow[];
      for (const row of rows) {
        const key = [row.platform, row.data_source, row.qualified_name].join(
          "\u0000",
        );
        const selected = result.get(key) ?? [];
        selected.push(row);
        result.set(key, selected);
      }
    }
    return result;
  }

  private matchingRows(
    identity: MetadataIdentity,
    batchRows?: ReadonlyMap<string, readonly TableRow[]>,
  ): readonly TableRow[] {
    if (!batchRows) return this.tableRows(identity);
    const stable = text(identity.stableTableId);
    return (batchRows.get(this.identityKey(identity)) ?? []).filter(
      (row) => !stable || row.stable_table_id === stable,
    );
  }

  private batchFieldRows(
    requests: readonly {
      readonly identity: MetadataIdentity | undefined;
      readonly column?: string;
    }[],
    tableRows: ReadonlyMap<string, readonly TableRow[]>,
  ): ReadonlyMap<string, readonly FieldRow[]> {
    const keys = new Map<string, readonly [number, string]>();
    for (const { identity, column } of requests) {
      if (!identity || !normalized(column)) continue;
      const rows = this.matchingRows(identity, tableRows);
      if (rows.length !== 1 || rows[0]!.parse_status !== "PARSED") continue;
      const key = `${rows[0]!.id}\0${normalized(column)}`;
      keys.set(key, [rows[0]!.id, normalized(column)]);
    }
    const result = new Map<string, FieldRow[]>();
    const values = [...keys.values()];
    for (let offset = 0; offset < values.length; offset += 150) {
      const chunk = values.slice(offset, offset + 150);
      const fields = this.database!.prepare(
        `SELECT table_id,name,ordinal,raw_type,comment,is_partition FROM fields
           WHERE ${chunk.map(() => "(table_id=? AND normalized_name=?)").join(" OR ")}
           ORDER BY table_id,ordinal`,
      ).all(...chunk.flat()) as unknown as readonly FieldRow[];
      for (const field of fields) {
        const key = `${field.table_id}\0${normalized(field.name)}`;
        const matches = result.get(key) ?? [];
        matches.push(field);
        result.set(key, matches);
      }
    }
    return result;
  }

  async resolve(
    identity: MetadataIdentity | undefined,
    column?: string,
  ): Promise<TableMetadata> {
    return this.resolveWithState(identity, column, this.ensureOpen());
  }

  private async resolveWithState(
    identity: MetadataIdentity | undefined,
    column: string | undefined,
    catalogState: MetadataCatalogState,
    batchRows?: ReadonlyMap<string, readonly TableRow[]>,
    batchFields?: ReadonlyMap<string, readonly FieldRow[]>,
  ): Promise<TableMetadata> {
    const fieldRequested = Boolean(text(column));
    if (catalogState.status !== "READY")
      return unavailable(
        catalogState.reason ?? "METADATA_CATALOG_UNAVAILABLE",
        fieldRequested,
        catalogState,
      );
    if (
      !identity ||
      (identity.identityStatus !== undefined &&
        identity.identityStatus !== "CONFIRMED")
    )
      return unavailable(
        "PHYSICAL_IDENTITY_UNAVAILABLE",
        fieldRequested,
        catalogState,
      );
    if (
      !normalized(identity.platform) ||
      !normalized(identity.dataSource) ||
      !normalized(identity.qualifiedName)
    )
      return unavailable(
        "PHYSICAL_IDENTITY_INSUFFICIENT",
        fieldRequested,
        catalogState,
      );
    const stable = text(identity.stableTableId);
    const rows = this.matchingRows(identity, batchRows);
    if (rows.length > 1)
      return unavailable(
        "TABLE_PACK_IDENTITY_AMBIGUOUS",
        fieldRequested,
        catalogState,
      );
    if (!rows.length) {
      if (stable) {
        const issue = this.database!.prepare(
          `SELECT reason FROM import_issues
             WHERE platform=? AND stable_table_id=?
             ORDER BY source_path LIMIT 1`,
        ).get(normalized(identity.platform), stable) as IssueRow | undefined;
        if (issue) return failed(issue.reason, fieldRequested, catalogState);
      }
      return unavailable("TABLE_PACK_NOT_FOUND", fieldRequested, catalogState);
    }
    const row = rows[0]!;
    const table: MetadataValue = row.description
      ? { status: "AVAILABLE", description: row.description }
      : {
          status: "ANNOTATION_NOT_RECORDED",
          reason: "TABLE_DESCRIPTION_NOT_RECORDED",
        };
    let field: MetadataValue | undefined;
    if (fieldRequested) {
      if (row.parse_status === "UNSUPPORTED")
        field = {
          status: "METADATA_UNAVAILABLE",
          reason: "TABLE_DDL_UNSUPPORTED",
        };
      else if (row.parse_status === "INVALID")
        field = {
          status: "METADATA_READ_FAILED",
          reason: "TABLE_DDL_INVALID",
        };
      else {
        const fields = batchFields
          ? (batchFields.get(`${row.id}\0${normalized(column)}`) ?? [])
          : (this.database!.prepare(
              `SELECT name,ordinal,raw_type,comment,is_partition FROM fields
                 WHERE table_id=? AND normalized_name=? ORDER BY ordinal LIMIT 2`,
            ).all(
              row.id,
              normalized(column),
            ) as unknown as readonly FieldRow[]);
        if (fields.length > 1)
          field = {
            status: "METADATA_UNAVAILABLE",
            reason: "FIELD_IDENTITY_AMBIGUOUS",
          };
        else if (!fields.length)
          field = {
            status: "METADATA_UNAVAILABLE",
            reason: "FIELD_NOT_FOUND",
          };
        else {
          const value = fields[0]!;
          field = {
            status: value.comment ? "AVAILABLE" : "ANNOTATION_NOT_RECORDED",
            ...(!value.comment
              ? { reason: "FIELD_COMMENT_NOT_RECORDED" }
              : { comment: value.comment }),
            name: value.name,
            ordinal: value.ordinal,
            rawType: value.raw_type,
            partition: value.is_partition === 1,
          };
        }
      }
    }
    return {
      table,
      ...(field ? { field } : {}),
      identity: {
        platform: row.platform,
        dataSource: row.data_source,
        qualifiedName: row.qualified_name,
        stableTableId: row.stable_table_id,
      },
      tableName: row.table_name,
      objectType: row.object_type,
      source: row.source,
      sourcePath: row.source_path,
      sourceHash: row.source_hash,
      ddlHash: row.ddl_hash,
      collectedAt: row.collected_at,
      updatedAt: row.updated_at,
      contentHash: row.content_hash,
      parseStatus: row.parse_status,
      metadataCatalog: catalogState,
      versionRelation: "RUNTIME_INPUT_PACK_NOT_GRAPH_VERSION",
    };
  }

  async resolveMany(
    requests: readonly {
      readonly identity: MetadataIdentity | undefined;
      readonly column?: string;
    }[],
  ): Promise<readonly TableMetadata[]> {
    const catalogState = this.ensureOpen();
    const batchRows =
      catalogState.status === "READY"
        ? this.batchTableRows(
            requests
              .map(({ identity }) => identity)
              .filter((identity): identity is MetadataIdentity =>
                Boolean(identity),
              ),
          )
        : undefined;
    const batchFields =
      batchRows === undefined
        ? undefined
        : this.batchFieldRows(requests, batchRows);
    return Promise.all(
      requests.map(({ identity, column }) =>
        this.resolveWithState(
          identity,
          column,
          catalogState,
          batchRows,
          batchFields,
        ),
      ),
    );
  }

  async listFields(
    identity: MetadataIdentity,
    options: { readonly limit?: number; readonly offset?: number } = {},
  ): Promise<{
    readonly metadata: TableMetadata;
    readonly fields: readonly CatalogField[];
    readonly pagination: {
      readonly limit: number;
      readonly offset: number;
      readonly nextOffset: number | null;
    };
  }> {
    const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const metadata = await this.resolve(identity);
    if (metadata.metadataCatalog.status !== "READY")
      return {
        metadata,
        fields: [],
        pagination: { limit, offset, nextOffset: null },
      };
    const rows = this.tableRows(identity);
    if (rows.length !== 1 || rows[0]!.parse_status !== "PARSED")
      return {
        metadata,
        fields: [],
        pagination: { limit, offset, nextOffset: null },
      };
    const fields = this.database!.prepare(
      `SELECT name,ordinal,raw_type,comment,is_partition FROM fields
         WHERE table_id=? ORDER BY ordinal LIMIT ? OFFSET ?`,
    ).all(rows[0]!.id, limit + 1, offset) as unknown as readonly FieldRow[];
    const page = fields.slice(0, limit).map((field) => ({
      name: field.name,
      ordinal: field.ordinal,
      rawType: field.raw_type,
      ...(field.comment ? { comment: field.comment } : {}),
      partition: field.is_partition === 1,
      status: field.comment ? "AVAILABLE" : "ANNOTATION_NOT_RECORDED",
      ...(!field.comment ? { reason: "FIELD_COMMENT_NOT_RECORDED" } : {}),
    })) satisfies CatalogField[];
    return {
      metadata,
      fields: page,
      pagination: {
        limit,
        offset,
        nextOffset: fields.length > limit ? offset + limit : null,
      },
    };
  }

  async searchDescription(
    value: string,
    options: { readonly limit?: number; readonly offset?: number } = {},
  ): Promise<readonly MetadataSearchIdentity[]> {
    const needle = normalized(value);
    if (!needle || this.ensureOpen().status !== "READY") return [];
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 30)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    return this.database!.prepare(
      `SELECT DISTINCT platform,data_source,qualified_name FROM tables
         WHERE description_normalized LIKE ? ESCAPE '\\'
         ORDER BY platform,data_source,qualified_name LIMIT ? OFFSET ?`,
    )
      .all(
        `%${needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
        limit,
        offset,
      )
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          platform: String(value.platform),
          dataSource: String(value.data_source),
          qualifiedName: String(value.qualified_name),
        };
      });
  }
}
