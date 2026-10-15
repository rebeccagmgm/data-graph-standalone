import type { GraphEdge } from "./types";

/** Count an observed relation once even when reached through several task paths.
 * The display edge still retains every raw path in tableRelations. */
export function tableRelationRecords(
  input: GraphEdge | GraphEdge[],
): GraphEdge[] {
  const records = (Array.isArray(input) ? input : [input]).flatMap(
    (edge) => edge.tableRelations ?? [edge],
  );
  return [
    ...new Map(
      records.map((record) => [
        JSON.stringify([
          record.kind,
          record.status,
          record.detail?.physicalEdgeId ??
            record.id ??
            record.key ??
            JSON.stringify(record),
        ]),
        record,
      ]),
    ).values(),
  ];
}

export function tableRelationLabel(edge: GraphEdge): string {
  const label = edge.kind === "WRITES_TABLE" ? "产出" : "输入";
  const count = tableRelationRecordCount(edge);
  return count > 1 ? `${label} · ${count} 条记录` : label;
}

export function tableRelationRecordCount(edge: GraphEdge): number {
  return tableRelationRecords(edge).length;
}

/**
 * Encode static table IO record count without implying runtime volume.
 * Bounded buckets keep dense evidence readable without dominating the canvas.
 */
export function tableRelationStrokeWidth(edge: GraphEdge): number {
  const count = tableRelationRecordCount(edge);
  if (count >= 8) return 5;
  if (count >= 4) return 3.5;
  if (count >= 2) return 2.5;
  return 1.5;
}
