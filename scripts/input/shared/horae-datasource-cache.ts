import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  resolveScheduleEvidenceCacheRoot,
} from "../../evidence/schedule-evidence-cache.ts";

export const HORAE_DATASOURCE_DIR_NAME = "horae-datasource" as const;
export const HORAE_DATASOURCE_ROWS_FILE = "rows.jsonl" as const;
export const HORAE_DATASOURCE_SNAPSHOT_FILE = "snapshot.json" as const;

export type HoraeDatasourceEntry = {
  readonly serverTag: string;
  readonly serverType: string;
  readonly service: string;
  readonly serverAlias?: string;
  readonly host?: string;
  readonly port?: number;
};

export type HoraeDatasourceIndex = {
  readonly byServerTag: ReadonlyMap<string, HoraeDatasourceEntry>;
  /** Lower-cased labels whose rows disagree on physical datasource identity. */
  readonly ambiguousServerTags?: ReadonlySet<string>;
};

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? undefined : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function horaeDatasourceDir(
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): string {
  return join(
    resolveScheduleEvidenceCacheRoot(cacheRoot),
    HORAE_DATASOURCE_DIR_NAME,
  );
}

/**
 * Atlas / RDBMS-core dataSource suffix for an Oracle Horae server_tag.
 * Example: service `jyglrac` → `gforacle_jyglrac#jyglrac`
 */
export function oracleAtlasDataSourceFromService(
  service: string,
): string | undefined {
  return atlasDataSourceFromHoraeService("oracle", service);
}

/**
 * Map Horae `server_type` + `service` to the RDBMS-core `@dataSource` hint.
 * Oracle/Postgre/OceanBase use `…#service`; MySQL/StarRocks/GoldenDB have no `#`.
 */
export function atlasDataSourceFromHoraeService(
  serverType: string,
  service: string,
): string | undefined {
  const trimmed = service.trim();
  if (trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();
  switch (serverType.trim().toLowerCase()) {
    case "oracle":
      return `gforacle_${lower}#${lower}`;
    case "postgre":
    case "postgres":
    case "postgresql":
      return `gfpostgre_${lower}#${lower}`;
    case "oceanbase":
      return `gfoceanbase_${lower}#${lower}`;
    case "mysql":
      return `gfmysql_${lower}`;
    case "starrocks":
      return `gfstarrocks_${lower}`;
    case "goldendb":
      return `gfgoldendb_${lower}`;
    default:
      return undefined;
  }
}

/** Concrete Atlas instance used by successful oracle_wande / uip_winddb packs. */
export const ORACLE_UIP_WINDDB_ATLAS_DATASOURCE =
  "gforacle_oracle_uip_winddb#winddb" as const;

/**
 * Canonical Atlas instance for Horae service `jgjdb`.
 *
 * Horae/atlas **service form** is `gforacle_jgjdb#jgjdb`, but RDBMS-core often
 * stores numbered siblings (`gforacle_jgjdb1#jgjdb`, `gforacle_jgjdb2#jgjdb`, …)
 * so `${qn}#jgjdb` stays AMBIGUOUS.
 *
 * Decision process (repo convention when unique physical proof is unavailable):
 * count SUCCESS `tables/oracle` packs by atlas dataSource, then pin the majority.
 * 2026-09-04 census: `gforacle_jgjdb1#jgjdb`=191, `jgjdb2`=0 → prefer jgjdb1
 * (`ORACLE_JGJDB_PREFERRED_ATLAS_DATASOURCE`). Not unique physical proof; change
 * the constant and force affected tasks if the majority shifts.
 */
export const ORACLE_JGJDB_PREFERRED_ATLAS_DATASOURCE =
  "gforacle_jgjdb1#jgjdb" as const;

/**
 * When Horae service is winddb but core has multiple `#winddb` instances,
 * prefer the UIP instance for 万得/UIP tags (and host 10.2.89.132).
 */
export function shouldPreferOracleUipWinddbAtlas(
  entry: Pick<HoraeDatasourceEntry, "serverTag" | "service" | "host">,
): boolean {
  if (entry.service.trim().toLowerCase() !== "winddb") return false;
  const tag = entry.serverTag.trim().toLowerCase();
  if (tag.startsWith("oracle_wande_") || tag.startsWith("oracle_uip_winddb"))
    return true;
  const host = entry.host?.trim();
  return host === "10.2.89.132";
}

/** Horae Oracle service `jgjdb` → prefer numbered prod instance jgjdb1. */
export function shouldPreferOracleJgjdb1Atlas(
  entry: Pick<HoraeDatasourceEntry, "serverType" | "service">,
): boolean {
  return (
    entry.serverType.trim().toLowerCase() === "oracle" &&
    entry.service.trim().toLowerCase() === "jgjdb"
  );
}

function preferredAtlasFromHoraeEntry(
  entry: HoraeDatasourceEntry,
): string | undefined {
  if (
    entry.serverType.toLowerCase() === "oracle" &&
    shouldPreferOracleUipWinddbAtlas(entry)
  )
    return ORACLE_UIP_WINDDB_ATLAS_DATASOURCE;
  if (shouldPreferOracleJgjdb1Atlas(entry))
    return ORACLE_JGJDB_PREFERRED_ATLAS_DATASOURCE;
  return atlasDataSourceFromHoraeService(entry.serverType, entry.service);
}

export function parseHoraeDatasourceRow(
  value: unknown,
): HoraeDatasourceEntry | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const serverTag = nonEmptyString(record.server_tag);
  const serverType = nonEmptyString(record.server_type);
  const service = nonEmptyString(record.service);
  if (serverTag === undefined || serverType === undefined || service === undefined)
    return undefined;
  return {
    serverTag,
    serverType,
    service,
    serverAlias: nonEmptyString(record.server_alias),
    host: nonEmptyString(record.host),
    port: typeof record.port === "number" ? record.port : undefined,
  };
}

function indexEntries(
  rows: readonly unknown[],
): HoraeDatasourceIndex {
  const byServerTag = new Map<string, HoraeDatasourceEntry>();
  const ambiguousServerTags = new Set<string>();
  const keysByLowerTag = new Map<string, string>();
  for (const row of rows) {
    const entry = parseHoraeDatasourceRow(row);
    if (entry === undefined) continue;
    const lowerTag = entry.serverTag.toLowerCase();
    const existingKey = keysByLowerTag.get(lowerTag);
    if (existingKey === undefined) {
      keysByLowerTag.set(lowerTag, entry.serverTag);
      byServerTag.set(entry.serverTag, entry);
      continue;
    }
    const existing = byServerTag.get(existingKey);
    if (
      existing !== undefined &&
      existing.serverType === entry.serverType &&
      existing.service === entry.service &&
      existing.serverAlias === entry.serverAlias &&
      existing.host === entry.host &&
      existing.port === entry.port
    )
      continue;
    ambiguousServerTags.add(lowerTag);
    byServerTag.delete(existingKey);
  }
  return { byServerTag, ambiguousServerTags };
}

export function loadHoraeDatasourceIndex(
  cacheRoot = DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
): HoraeDatasourceIndex | undefined {
  const dir = horaeDatasourceDir(cacheRoot);
  const rowsPath = join(dir, HORAE_DATASOURCE_ROWS_FILE);
  const snapshotPath = join(dir, HORAE_DATASOURCE_SNAPSHOT_FILE);
  if (existsSync(rowsPath)) {
    const rows: unknown[] = [];
    for (const line of readFileSync(rowsPath, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // skip bad lines
      }
    }
    return indexEntries(rows);
  }
  if (existsSync(snapshotPath)) {
    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown;
      const record = asRecord(parsed);
      const rows = record?.rows;
      if (!Array.isArray(rows)) return undefined;
      return indexEntries(rows);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Map task source label (Horae server_tag) to RDBMS-core `@dataSource` key.
 */
export function preferredRdbmsDataSourceFromTaskSource(
  source: unknown,
  index: HoraeDatasourceIndex | undefined,
): string | undefined {
  if (index === undefined) return undefined;
  const tag =
    typeof source === "string"
      ? nonEmptyString(source)
      : nonEmptyString(asRecord(source)?.qualifiedName) ??
        nonEmptyString(asRecord(source)?.dataSource);
  if (tag === undefined) return undefined;
  if (index.ambiguousServerTags?.has(tag.toLowerCase())) return undefined;
  const direct = index.byServerTag.get(tag);
  if (direct !== undefined) return preferredAtlasFromHoraeEntry(direct);
  const lower = tag.toLowerCase();
  for (const [key, value] of index.byServerTag) {
    if (key.toLowerCase() === lower)
      return preferredAtlasFromHoraeEntry(value);
  }
  return undefined;
}

/** True only for a unique exact Horae server_tag; unknown values are not filtered. */
export function isKnownHoraeDatasourceLabel(
  source: unknown,
  index: HoraeDatasourceIndex | undefined,
): boolean {
  if (index === undefined) return false;
  const tag =
    typeof source === "string"
      ? nonEmptyString(source)
      : nonEmptyString(asRecord(source)?.qualifiedName) ??
        nonEmptyString(asRecord(source)?.dataSource);
  if (tag === undefined) return false;
  const lower = tag.toLowerCase();
  if (index.ambiguousServerTags?.has(lower)) return false;
  if (index.byServerTag.has(tag)) return true;
  return [...index.byServerTag.keys()].some(
    (key) => key.toLowerCase() === lower,
  );
}
