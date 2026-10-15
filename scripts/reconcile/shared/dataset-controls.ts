import { normalizeName } from "../../machine-facts/machine-facts-contract.ts";
import type {
  PhysicalTableCatalog,
  PhysicalTableCatalogEntry,
} from "../../machine-facts/input-pack-machine-facts.ts";
import type { CurrentBundleLoad, JsonRecord } from "../../query/current-task-bundle.ts";
import {
  buildRelationTreeIndex,
  controlSideForJoin,
  normalizeJoinType,
  withIncomingRelations,
} from "../../project-graph/task-local/field-evidence/relation-tree.ts";
import { resolvePhysicalInputField } from "./physical-field-resolver.ts";
import { physicalFieldKey, type PhysicalFieldIdentity } from "./physical-field.ts";
import {
  type DatasetControlAnnotation,
  type DatasetControlGrain,
  type OpenLineageIndirectSubtype,
} from "./field-control-contract.ts";
import type { TaskDefaultSchema } from "./task-default-schema.ts";

export const DATASET_CONTROL_RELATION_TYPES = new Set([
  "filter",
  "join",
  "aggregate",
  "setop",
  "window",
  "distinct",
]);

export type DatasetControlIndexes = {
  readonly controlsByStatement: ReadonlyMap<string, readonly JsonRecord[]>;
  readonly relationTree: ReturnType<typeof withIncomingRelations>;
  readonly readRelationByField: ReadonlyMap<string, string>;
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? null : trimmed;
}

export function collectPhysicalPairs(
  value: unknown,
  output: { table: string; column: string }[] = [],
): { table: string; column: string }[] {
  if (Array.isArray(value)) {
    for (const item of value) collectPhysicalPairs(item, output);
    return output;
  }
  const record = asRecord(value);
  if (!record) return output;
  if (nonEmpty(record.table) && nonEmpty(record.column))
    output.push({
      table: normalizeName(String(record.table)),
      column: normalizeName(String(record.column)),
    });
  for (const child of Object.values(record))
    collectPhysicalPairs(child, output);
  return output;
}

function relationBody(relation: JsonRecord): JsonRecord {
  return asRecord(relation.relation) ?? relation;
}

export function joinGrain(joinType: string): {
  grain: DatasetControlGrain;
  grainReason: NonNullable<DatasetControlAnnotation["grainReason"]>;
} {
  const kind = joinType.toUpperCase();
  if (kind.includes("SEMI") || kind.includes("ANTI")) return {grain: "REDUCE", grainReason: "GRAIN_FILTER_MAY_DROP_ROWS"};
  if (
    kind.includes("LEFT")
    || kind.includes("RIGHT")
    || kind.includes("FULL")
    || kind.includes("CROSS")
  ) {
    return {
      grain: "EXPAND_RISK",
      grainReason: "GRAIN_JOIN_NULLABLE_SIDE_MAY_EXPAND",
    };
  }
  return {
    grain: "EXPAND_RISK",
    grainReason: "GRAIN_JOIN_CARDINALITY_UNPROVEN",
  };
}

export function datasetControlMapping(
  relation: JsonRecord,
): {
  subtype: OpenLineageIndirectSubtype;
  grain: DatasetControlGrain;
  grainReason: NonNullable<DatasetControlAnnotation["grainReason"]>;
} | null {
  const type = String(relation.relation_type ?? "").toLowerCase();
  const body = relationBody(relation);
  switch (type) {
    case "join":
      return { subtype: "JOIN", ...joinGrain(String(body.join_type ?? "")) };
    case "filter":
      return {
        subtype: "FILTER",
        grain: "REDUCE",
        grainReason: "GRAIN_FILTER_MAY_DROP_ROWS",
      };
    case "aggregate":
      return {
        subtype: "GROUP_BY",
        grain: "REDUCE",
        grainReason: "GRAIN_GROUPING_REDUCES_ROWS",
      };
    case "window":
      return {
        subtype: "WINDOW",
        grain: "UNKNOWN",
        grainReason: "GRAIN_WINDOW_CARDINALITY_UNPROVEN",
      };
    case "distinct":
      return {
        subtype: "GROUP_BY",
        grain: "REDUCE",
        grainReason: "GRAIN_GROUPING_REDUCES_ROWS",
      };
    case "setop": {
      const op = String(body.setop ?? "").toUpperCase();
      const all = body.all === true;
      if (op === "UNION" && all) return null;
      if (op === "UNION") {
        return {
          subtype: "GROUP_BY",
          grain: "REDUCE",
          grainReason: "GRAIN_GROUPING_REDUCES_ROWS",
        };
      }
      if (op === "EXCEPT" || op === "INTERSECT") {
        return {
          subtype: "FILTER",
          grain: "REDUCE",
          grainReason: "GRAIN_SETOP_REDUCES_ROWS",
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function buildReadRelationByField(
  relations: ReadonlyMap<string, JsonRecord>,
): Map<string, string> {
  const output = new Map<string, string>();
  for (const relation of relations.values()) {
    if (String(relation.relation_type ?? "").toLowerCase() !== "read") continue;
    const relationId = nonEmpty(relation.relation_id);
    const physicalDataset = nonEmpty(relation.physical_dataset)
      ?? nonEmpty(relationBody(relation).table);
    if (!relationId || !physicalDataset) continue;
    for (const pair of collectPhysicalPairs(relation.relation)) {
      output.set(
        `${normalizeName(physicalDataset)}\u0000${normalizeName(pair.column)}`,
        relationId,
      );
    }
  }
  return output;
}

export function buildControlsByStatement(
  relations: ReadonlyMap<string, JsonRecord>,
): Map<string, JsonRecord[]> {
  const controlsByStatement = new Map<string, JsonRecord[]>();
  for (const relation of relations.values()) {
    if (!DATASET_CONTROL_RELATION_TYPES.has(String(relation.relation_type).toLowerCase())) continue;
    const statementId = String(relation.statement_id ?? "");
    if (!statementId) continue;
    const values = controlsByStatement.get(statementId) ?? [];
    values.push(relation);
    controlsByStatement.set(statementId, values);
  }
  return controlsByStatement;
}

const bundleControlIndexesCache = new WeakMap<object, DatasetControlIndexes>();

export function bundleControlIndexesFor(load: CurrentBundleLoad): DatasetControlIndexes {
  const cached = bundleControlIndexesCache.get(load);
  if (cached) return cached;
  const relations = new Map<string, JsonRecord>();
  for (const relation of load.records["relation-nodes.jsonl"] ?? []) {
    const relationId = String(relation.relation_id ?? "");
    if (relationId && !relations.has(relationId)) relations.set(relationId, relation);
  }
  const relationNodes = [...relations.values()];
  const indexes: DatasetControlIndexes = {
    controlsByStatement: buildControlsByStatement(relations),
    relationTree: withIncomingRelations(
      buildRelationTreeIndex(relationNodes),
      load.records["relation-edges.jsonl"] ?? [],
    ),
    readRelationByField: buildReadRelationByField(relations),
  };
  bundleControlIndexesCache.set(load, indexes);
  return indexes;
}

export function datasetControlsForStatement(
  load: CurrentBundleLoad,
  taskId: string,
  statementId: string,
  catalog: PhysicalTableCatalog,
  defaultSchema: TaskDefaultSchema | null,
  fallbackTable: Pick<PhysicalTableCatalogEntry, "platform" | "dataSource">,
  status: "CONFIRMED" | "PROVISIONAL_LEGACY",
  indexes: DatasetControlIndexes = bundleControlIndexesFor(load),
): DatasetControlAnnotation[] {
  const allControls = indexes.controlsByStatement.get(statementId) ?? [];
  const output: DatasetControlAnnotation[] = [];
  for (const relation of allControls) {
    const mapping = datasetControlMapping(relation);
    if (!mapping) continue;
    const relationId = nonEmpty(relation.relation_id);
    const fields = new Map<string, PhysicalFieldIdentity>();
    let unresolved = false;
    for (const pair of collectPhysicalPairs(relation.relation)) {
      const resolution = resolvePhysicalInputField(
        {
          catalog,
          taskId,
          defaultSchema,
          fallbackTable,
          schemaRefs: load.records["schema-refs.jsonl"] ?? [],
        },
        pair,
      );
      if (resolution.status === "RESOLVED")
        fields.set(physicalFieldKey(resolution.field), resolution.field);
      else unresolved = true;
    }
    const evidenceRefs = [
      load.evidence["relation-nodes.jsonl"] ?? "machine-facts:relation-nodes.jsonl",
    ];
    const sourceText = nonEmpty(relation.source_text);
    const joinRelation = relationId
      ? indexes.relationTree.relations.get(relationId)
      : undefined;
    const joinType = mapping.subtype === "JOIN"
      ? normalizeJoinType(joinRelation?.joinType ?? String(relationBody(relation).join_type ?? ""))
      : "N/A";
    const leftRelationId = mapping.subtype === "JOIN"
      ? (joinRelation?.leftRelationId ?? nonEmpty(relationBody(relation).left))
      : null;
    const rightRelationId = mapping.subtype === "JOIN"
      ? (joinRelation?.rightRelationId ?? nonEmpty(relationBody(relation).right))
      : null;
    const pushControl = (
      field: PhysicalFieldIdentity | null,
      evidenceStatus: DatasetControlAnnotation["evidenceStatus"],
      reasonCode: string | null,
      controlSide: DatasetControlAnnotation["controlSide"] = "N/A",
    ): void => {
      const fieldKey = field ? physicalFieldKey(field) : "unresolved";
      output.push({
        controlId: `dataset-control:${taskId}:${relationId ?? "unresolved"}:${fieldKey}`,
        taskId,
        statementId,
        relationId,
        subtype: mapping.subtype,
        masking: false,
        grain: mapping.grain,
        grainReason: mapping.grain === "PRESERVE" ? null : mapping.grainReason,
        field,
        sourceText,
        evidenceStatus,
        reasonCode,
        evidenceRefs,
        joinType,
        leftRelationId,
        rightRelationId,
        controlSide,
      });
    };
    if (fields.size === 0) {
      pushControl(
        null,
        unresolved || !relationId ? "UNRESOLVED" : status,
        unresolved
          ? "ROWSET_FIELD_IDENTITY_UNRESOLVED"
          : relationId
            ? null
            : "ROWSET_SCOPE_UNRESOLVED",
      );
      continue;
    }
    for (const field of fields.values()) {
      const controlSide = mapping.subtype === "JOIN" && joinRelation
        ? controlSideForJoin({
          index: indexes.relationTree,
          joinRelation,
          controlReadRelationId:
            indexes.readRelationByField.get(
              `${normalizeName(field.qualifiedName)}\u0000${normalizeName(field.column)}`,
            ) ?? null,
        })
        : "N/A";
      pushControl(field, status, null, controlSide);
    }
    if (unresolved)
      pushControl(null, "UNRESOLVED", "ROWSET_FIELD_IDENTITY_UNRESOLVED");
  }
  return output;
}
