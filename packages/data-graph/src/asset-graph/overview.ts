import { clusterParams, clusterTablePredicate, clusterTaskPredicate } from "./cluster-filter.ts";
import { normalizeHiddenTables, tableVisibilityPredicate } from "./node-visibility.ts";
import type { AssetGraphStore } from "./store.ts";

export const PROCESSING_STAGES = [
  "SOURCE",
  "ODATA",
  "PDATA",
  "DM",
  "DELIVERY",
] as const;

export type ProcessingStage = (typeof PROCESSING_STAGES)[number];
export type RegionStage = ProcessingStage | "UNCLASSIFIED";

type OverviewStore = Pick<AssetGraphStore, "ready" | "run">;

const bounded = (
  value: number | undefined,
  fallback: number,
  maximum: number,
) => Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));

const numberValue = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (
    value &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof value.toNumber === "function"
  )
    return value.toNumber();
  return Number(value);
};

/** Schema names alone only establish the three explicitly named warehouse stages. */
export function classifyRegion(schema: string): RegionStage {
  const normalized = schema.toLowerCase();
  if (/^odata(?:_|$)/.test(normalized)) return "ODATA";
  if (/^pdata(?:_|$)/.test(normalized)) return "PDATA";
  if (/^dm(?:_|$)/.test(normalized)) return "DM";
  return "UNCLASSIFIED";
}

const requireStableReadyVersion = (
  initial: Record<string, unknown>,
  final: Record<string, unknown>,
) => {
  if (final.version !== initial.version)
    throw new Error("ASSET_GRAPH_CHANGED_DURING_QUERY");
};

export async function getAssetGraphOverview(
  store: OverviewStore,
  input: { regionLimit?: number; flowLimit?: number; hiddenTables?: string[]; clusterTaskIds?: string[] } = {},
) {
  const hiddenTables = normalizeHiddenTables(input.hiddenTables ?? []);
  const initial = await store.ready();
  const regionLimit = bounded(input.regionLimit, 100, 100);
  const flowLimit = bounded(input.flowLimit, 150, 150);
  // Seek selected tasks by their unique key, then deduplicate adjacent datasets.
  // The unfiltered path keeps the direct dataset scan.
  const datasetMatch = input.clusterTaskIds === undefined
    ? "MATCH (n:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'}) WHERE "
    : "UNWIND $clusterTaskIds AS taskId WITH $graphId+'|'+taskId AS taskKey MATCH (task:SLAssetNode {key:taskKey}) MATCH (task)-[r:SL_ASSET_EDGE]-(n:SLAssetNode) WHERE task.graphId=$graphId AND task.kind='TASK' AND r.graphId=$graphId AND r.kind IN ['READS_TABLE','WRITES_TABLE'] AND n.graphId=$graphId AND n.kind='PHYSICAL_DATASET' WITH DISTINCT n WHERE ";
  const excludedResult = await store.run(
    `${datasetMatch}(size(split(coalesce(n.table,''),'.')) < 2 OR split(coalesce(n.table,''),'.')[0] = '' OR split(coalesce(n.table,''),'.')[1] = ''  ) RETURN count(*) AS datasetCount`,
    clusterParams(input.clusterTaskIds),
  );
  const regionResult = await store.run(
    `${datasetMatch}${tableVisibilityPredicate("n")} AND size(split(coalesce(n.table,''),'.')) >= 2 AND split(coalesce(n.table,''),'.')[0] <> '' AND split(coalesce(n.table,''),'.')[1] <> '' WITH split(n.table,'.')[0] AS schema,count(*) AS datasetCount RETURN schema,datasetCount ORDER BY datasetCount DESC,schema LIMIT $limit`,
    { limit: regionLimit + 1, hiddenTables, ...clusterParams(input.clusterTaskIds) },
  );
  const regionRows = regionResult.records.slice(0, regionLimit);
  const regions = regionRows.map((record) => {
    const schema = String(record.get("schema"));
    return {
      schema,
      stage: classifyRegion(schema),
      datasetCount: numberValue(record.get("datasetCount")),
    };
  });
  const schemas = regions.map((region) => region.schema);
  const flowResult = schemas.length
    ? await store.run(
        `MATCH (source:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'})-[:SL_ASSET_EDGE {graphId:$graphId,kind:'READS_TABLE'}]->(task:SLAssetNode {graphId:$graphId,kind:'TASK'}) WHERE ${clusterTaskPredicate("task")} AND ${tableVisibilityPredicate("source")} AND size(split(coalesce(source.table,''),'.')) >= 2 AND split(coalesce(source.table,''),'.')[0] <> '' AND split(coalesce(source.table,''),'.')[1] <> '' WITH task,collect(DISTINCT split(source.table,'.')[0]) AS fromSchemas MATCH (task)-[:SL_ASSET_EDGE {graphId:$graphId,kind:'WRITES_TABLE'}]->(target:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'}) WHERE ${tableVisibilityPredicate("target")} AND size(split(coalesce(target.table,''),'.')) >= 2 AND split(coalesce(target.table,''),'.')[0] <> '' AND split(coalesce(target.table,''),'.')[1] <> '' WITH task,fromSchemas,collect(DISTINCT split(target.table,'.')[0]) AS toSchemas UNWIND fromSchemas AS fromSchema UNWIND toSchemas AS toSchema WITH fromSchema,toSchema,task WHERE fromSchema IN $schemas AND toSchema IN $schemas AND fromSchema <> toSchema RETURN fromSchema,toSchema,count(DISTINCT task.id) AS taskCount ORDER BY taskCount DESC,fromSchema,toSchema LIMIT $limit`,
        { schemas, limit: flowLimit + 1, hiddenTables, ...clusterParams(input.clusterTaskIds) },
      )
    : { records: [] };
  const flows = flowResult.records.slice(0, flowLimit).map((record) => {
    const fromSchema = String(record.get("fromSchema"));
    const toSchema = String(record.get("toSchema"));
    return {
      fromSchema,
      toSchema,
      fromStage: classifyRegion(fromSchema),
      toStage: classifyRegion(toSchema),
      taskCount: numberValue(record.get("taskCount")),
      evidenceKind: "TABLE_IO" as const,
    };
  });
  const final = await store.ready();
  requireStableReadyVersion(initial, final);
  return {
    version: String(initial.version),
    stages: PROCESSING_STAGES,
    excluded: {
      unqualifiedDatasets: numberValue(
        excludedResult.records[0]?.get("datasetCount") ?? 0,
      ),
    },
    regions,
    flows,
    limits: { regions: regionLimit, flows: flowLimit },
    truncated: {
      regions: regionResult.records.length > regionLimit,
      flows: flowResult.records.length > flowLimit,
    },
  };
}

const SCHEMA_PATTERN = /^[A-Za-z0-9_]+$/;

export async function listAssetGraphRegionDatasets(
  store: OverviewStore,
  input: { schema: string; limit?: number; offset?: number; hiddenTables?: string[]; clusterTaskIds?: string[] },
) {
  if (!SCHEMA_PATTERN.test(input.schema))
    throw new Error("INVALID_GRAPH_SCHEMA");
  const schema = input.schema.toLowerCase();
  const limit = bounded(input.limit, 50, 100);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  if (!Number.isSafeInteger(offset)) throw new Error("INVALID_QUERY_LIMIT");
  const hiddenTables = normalizeHiddenTables(input.hiddenTables ?? []);
  const initial = await store.ready();
  const result = await store.run(
    `MATCH (n:SLAssetNode {graphId:$graphId,kind:'PHYSICAL_DATASET'}) WHERE ${clusterTablePredicate("n")} AND ${tableVisibilityPredicate("n")} AND size(split(coalesce(n.table,''),'.')) >= 2 AND split(n.table,'.')[0]=$schema AND split(n.table,'.')[1] <> '' RETURN n.id AS id,n.table AS table,n.label AS label ORDER BY n.table,n.id SKIP $offset LIMIT $limit`,
    { schema, offset, limit: limit + 1, hiddenTables, ...clusterParams(input.clusterTaskIds) },
  );
  const items = result.records.slice(0, limit).map((record) => ({
    id: String(record.get("id")),
    table: String(record.get("table")),
    label: String(record.get("label")),
  }));
  const truncated = result.records.length > limit;
  const final = await store.ready();
  requireStableReadyVersion(initial, final);
  return {
    version: String(initial.version),
    schema,
    items,
    pagination: {
      offset,
      limit,
      nextOffset: truncated ? offset + limit : null,
    },
    truncated,
  };
}
