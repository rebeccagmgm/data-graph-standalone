/** Shared, serializable selection contract. Dates remain in write evidence. */
export interface PartitionSelection {
  datasetId: string;
  version: string;
  optionIds: string[];
}
export interface PartitionWrite {
  candidate?: boolean;
  taskId: string;
  writeId: string;
  targetId: string;
  datasetId: string;
  partition: unknown[];
}
export interface PartitionOption {
  id: string;
  label: string;
  unknown: boolean;
  writes: PartitionWrite[];
}
export interface PartitionCatalog {
  version: string;
  datasetId: string;
  options: PartitionOption[];
  ignoredDateColumns: string[];
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
// Only conventional day dimensions; month/quarter/year and arbitrary date-like
// strings are intentionally not hidden. This affects labels, never matching.
const dayColumn = /^(busi_date|business_date|data_date|biz_date|business_day|dt|etl_date)$/i;
function businessParts(partition: unknown[]) {
  return partition.map(record).filter(p => !dayColumn.test(String(p.column))).map(p => ({
    column: String(p.column ?? "未识别分区").toLowerCase(),
    values: Array.isArray(p.values) ? p.values.map(String).sort() : [],
    unknown: p.partitionStatus === "UNKNOWN" || p.valueStatus === "UNKNOWN" || !Array.isArray(p.values) || !p.values.length,
    // Correlated alternatives must not be flattened into invented combinations.
    ...(p.alternatives ? { alternatives: p.alternatives } : {}),
  })).sort((a, b) => a.column.localeCompare(b.column));
}
export function partitionOptions(writes: PartitionWrite[]): PartitionOption[] {
  const groups = new Map<string, PartitionOption>();
  for (const write of writes) {
    const parts = businessParts(write.partition);
    const unknown = !write.partition.length || parts.some(p => p.unknown || p.alternatives);
    const id = JSON.stringify({ parts, unknown });
    const label = parts.length ? parts.map(p => `${p.column}=${p.unknown || p.alternatives ? "范围待确认" : p.values.join(" / ")}`).join(" · ") : unknown ? "未记录分区范围" : "仅日度分区";
    const group = groups.get(id) ?? { id, label, unknown: Boolean(unknown), writes: [] };
    if (!group.writes.some(w => w.taskId === write.taskId && w.writeId === write.writeId)) group.writes.push(write);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => Number(a.unknown) - Number(b.unknown) || a.label.localeCompare(b.label));
}
export function dateColumns(writes: PartitionWrite[]) {
  return [...new Set(writes.flatMap(w => w.partition.map(record).map(p => String(p.column)).filter(c => dayColumn.test(c))))].sort();
}
export function selectedPartitionWrites(catalog: PartitionCatalog, selection: PartitionSelection): PartitionWrite[] {
  if (selection.version !== catalog.version) throw new Error("PARTITION_VERSION_CHANGED");
  if (selection.datasetId !== catalog.datasetId) throw new Error("PARTITION_DATASET_MISMATCH");
  if (!selection.optionIds.length || selection.optionIds.some(id => !catalog.options.some(o => o.id === id))) throw new Error("PARTITION_SELECTION_INVALID");
  return catalog.options.filter(o => selection.optionIds.includes(o.id)).flatMap(o => o.writes);
}
export function parsePartitionSelection(raw: string | null): PartitionSelection | undefined {
  if (raw === null) return undefined;
  if (raw.length > 64_000) throw new Error("PARTITION_SELECTION_INVALID");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("PARTITION_SELECTION_INVALID"); }
  const v = record(parsed);
  if (typeof v.datasetId !== "string" || !v.datasetId.startsWith("dataset:") || v.datasetId.length > 200 || typeof v.version !== "string" || !v.version || !Array.isArray(v.optionIds) || !v.optionIds.length || v.optionIds.length > 100 || v.optionIds.some(id => typeof id !== "string" || id.length > 8000)) throw new Error("PARTITION_SELECTION_INVALID");
  return { datasetId: v.datasetId, version: v.version, optionIds: [...new Set(v.optionIds as string[])] };
}
