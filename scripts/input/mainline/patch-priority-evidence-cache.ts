import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  readSzdataScheduleDetailCache,
  writeSzdataScheduleDetailCache,
} from "./szdata-schedule-detail-cache.ts";
import {
  DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT,
  writeTaskPartitionBindingsCache,
} from "../../evidence/schedule-evidence-cache.ts";
import { DEFAULT_HIVE_DDL_JSONL_PATH } from "../shared/offline-table-resolver.ts";

const DEFAULT_DATA_ROOT =
  "E:\\02_area\\股衍数据-数据cookbook\\sql-static-lineage-data";
const DEFAULT_OFFICIAL_DATA_ROOT = DEFAULT_DATA_ROOT;

const HIVE_TABLE_PACKS = [
  {
    qualifiedName: "odata_n_uip.q_md_institution",
    stableTableId: "odata_n_uip.q_md_institution__gfhive",
    guid: "cd47666f-573f-44df-a106-b60fb73096e2",
    taskId: "62190",
  },
  {
    qualifiedName: "dm_otc_n.trd_sso_exch_scr_mtch_day",
    stableTableId: "dm_otc_n.trd_sso_exch_scr_mtch_day__gfhive",
    guid: "b970d82c-d550-4823-bab0-3d11acaadbc7",
    taskId: "180065",
  },
  {
    qualifiedName: "dm_index_n.grp_def",
    stableTableId: "dm_index_n.grp_def__gfhive",
    guid: "55d6fc07-5264-4c11-97e9-1c99694312b4",
    taskId: "100931",
  },
  {
    qualifiedName: "pdata_n.t01_pty_rat",
    stableTableId: "pdata_n.t01_pty_rat__gfhive",
    guid: "ecdeeb56-43e7-45bb-ad9a-b9e597f5e77c",
    taskId: "100931",
  },
  {
    qualifiedName: "pdata_n.ref_cd_cvt_map",
    stableTableId: "pdata_n.ref_cd_cvt_map__gfhive",
    guid: "f4ae366f-bb60-4c5c-9cca-b928da4f1452",
    taskId: "100078",
  },
] as const;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else copyFileSync(from, to);
  }
}

function hiveDdlHasCreate(jsonlPath: string, qualifiedName: string): boolean {
  if (!existsSync(jsonlPath)) return false;
  const needle = qualifiedName.toLowerCase();
  for (const line of readFileSync(jsonlPath, "utf8").split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    if (!line.toLowerCase().includes(needle)) continue;
    if (/create\s+table/iu.test(line)) return true;
  }
  return false;
}

function appendHiveCreateDdl(
  jsonlPath: string,
  pack: (typeof HIVE_TABLE_PACKS)[number],
  ddl: string,
): boolean {
  const createLine = ddl.trim();
  if (!/^create\s+table/iu.test(createLine)) return false;
  if (hiveDdlHasCreate(jsonlPath, pack.qualifiedName)) return false;
  const querytext = createLine.endsWith(";") ? createLine : `${createLine};`;
  const payload = {
    guid: pack.guid,
    qualifiedname: `${pack.qualifiedName}@gfhive:${Date.now()}`,
    querytext,
    querytext_char_len: [...querytext].length,
    querytext_byte_len: Buffer.byteLength(querytext, "utf8"),
    querytext_md5: createHash("md5").update(querytext, "utf8").digest("hex"),
  };
  writeFileSync(jsonlPath, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
  return true;
}

function patch180065QuerySql(cacheRoot: string, officialDataRoot: string): void {
  const taskId = "180065";
  const queryPath = join(
    officialDataRoot,
    "tasks",
    "hive2oracle",
    taskId,
    "sql",
    "query.sql",
  );
  if (!existsSync(queryPath))
    throw new Error(`OFFICIAL_QUERY_SQL_MISSING:${queryPath}`);
  const querySql = readFileSync(queryPath, "utf8");
  const cached = readSzdataScheduleDetailCache(taskId, cacheRoot);
  if (cached.status !== "HIT")
    throw new Error(`SZDATA_CACHE_MISS:${taskId}:${cached.status}`);
  writeSzdataScheduleDetailCache(
    taskId,
    nowIso(),
    { ...cached.detail, querySql },
    cacheRoot,
  );
}

function syncHiveTablePacks(
  dataRoot: string,
  officialDataRoot: string,
  hiveDdlJsonl: string,
): string[] {
  const actions: string[] = [];
  for (const pack of HIVE_TABLE_PACKS) {
    const source = join(officialDataRoot, "tables", "hive", pack.stableTableId);
    const destination = join(dataRoot, "tables", "hive", pack.stableTableId);
    if (!existsSync(source))
      throw new Error(`OFFICIAL_TABLE_PACK_MISSING:${source}`);
    copyDirectory(source, destination);
    actions.push(`copied table pack ${pack.stableTableId}`);
    const ddl = readFileSync(join(source, "ddl.sql"), "utf8");
    if (appendHiveCreateDdl(hiveDdlJsonl, pack, ddl))
      actions.push(`appended CREATE ddl jsonl ${pack.qualifiedName}`);
  }
  return actions;
}

function patch100078PartitionBindings(cacheRoot: string): void {
  writeTaskPartitionBindingsCache(
    "100078",
    nowIso(),
    {
      src_tbl: "ODATA_N_HBM.H_CUX_ADJ_DOCUMENT",
    },
    cacheRoot,
  );
}

function main(): void {
  const cacheRoot = option("--cache-root") ?? DEFAULT_SCHEDULE_EVIDENCE_CACHE_ROOT;
  const dataRoot = resolve(option("--data-root") ?? DEFAULT_DATA_ROOT);
  const officialDataRoot = resolve(
    option("--official-data-root") ?? DEFAULT_OFFICIAL_DATA_ROOT,
  );
  const hiveDdlJsonl = resolve(option("--hive-ddl-jsonl") ?? DEFAULT_HIVE_DDL_JSONL_PATH);
  const manifestDir = join(
    resolve(cacheRoot),
    "schedule-evidence",
    "priority-evidence",
  );
  mkdirSync(manifestDir, { recursive: true });

  const summary = {
    patchedAt: nowIso(),
    cacheRoot: resolve(cacheRoot),
    dataRoot,
    officialDataRoot,
    hiveDdlJsonl,
    actions: [] as string[],
  };

  patch180065QuerySql(cacheRoot, officialDataRoot);
  summary.actions.push("180065 szdata-schedule-detail.detail.querySql");

  summary.actions.push(...syncHiveTablePacks(dataRoot, officialDataRoot, hiveDdlJsonl));

  patch100078PartitionBindings(cacheRoot);
  summary.actions.push("100078 task-partition-bindings.src_tbl");

  const manifestPath = join(manifestDir, "patch-priority-evidence.json");
  writeFileSync(manifestPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
