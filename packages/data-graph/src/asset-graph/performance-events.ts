export type Entry = {kind:string; name:string; at?:string; durationMs?:number; serverMs?:number; requestId?:string; status?:number; nodes?:number; edges?:number};
const kinds = new Set(["api", "long-task", "event-loop", "interaction", "action"]);
export const names = new Set(["unknown", "search", "trace", "fields", "partitions", "task", "status", "clusters", "overview", "regions", "region-topics", "explain", "experimental/upstream-scope", "click", "pointerdown", "keydown", "input", "canvas", "apply-partitions", "expand", "open-table", "open-task", "evidence"]);

export class PerformanceHistory {
  private entries: Entry[] = [];
  constructor(private capacity = 200, restored: unknown = []) {
    if (Array.isArray(restored)) for (const value of restored.slice(-1000)) this.add(value);
  }
  add(value: unknown) {
    if (!value || typeof value !== "object") return;
    const raw = value as Record<string, unknown>;
    if (!kinds.has(String(raw.kind)) || !names.has(String(raw.name))) return;
    const entry: Entry = {kind:String(raw.kind), name:String(raw.name), at:typeof raw.at === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(raw.at) ? raw.at : new Date().toISOString()};
    for (const key of ["durationMs", "serverMs", "status", "nodes", "edges"] as const) {
      if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0) entry[key] = Math.round(raw[key]);
    }
    if (typeof raw.requestId === "string" && /^r\d+$/.test(raw.requestId)) entry.requestId = raw.requestId;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }
  snapshot() { return this.entries.map(entry => ({...entry})); }
}

