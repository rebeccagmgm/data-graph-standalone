import {PerformanceHistory, type Entry} from "./performance-events.ts";
/** Process-local diagnostics only: no query strings, SQL or node identities. */
export class RequestPerformanceLog {
  private nextId = 0;
  private active = new Map<string, {path: string; start: number; disconnected?:boolean}>();
  private recent: Array<{id:string; path:string; durationMs:number; status:number; aborted:boolean; at:string}> = [];
  private browsers = new Map<string, {clientId:string; browserFamily:string; receivedAt:string; events:Entry[]}>();
  constructor(private capacity = 200, private now = () => performance.now()) {}
  start(url: string) {
    if (url.split("?")[0]?.startsWith("/api/diagnostics")) return "";
    const id = `r${++this.nextId}`;
    const path = url.split("?")[0]!;
    this.active.set(id, {path: /^\/api\/[a-z/-]{1,60}$/.test(path) ? path : "other", start:this.now()});
    return id;
  }
  recordBrowser(raw: unknown) {
    const value = raw && typeof raw === "object" ? raw as Record<string,unknown> : {};
    if (typeof value.clientId !== "string" || !/^[a-f0-9-]{36}$/.test(value.clientId) || !Array.isArray(value.events) || value.events.length > 200) throw new Error("INVALID_BROWSER_DIAGNOSTICS");
    const events = new PerformanceHistory(200, value.events).snapshot();
    this.browsers.delete(value.clientId);
    if (this.browsers.size >= 8) this.browsers.delete(this.browsers.keys().next().value!);
    const browserFamily = ["edge","chromium","firefox","safari"].includes(String(value.browserFamily)) ? String(value.browserFamily) : "unknown";
    this.browsers.set(value.clientId,{clientId:value.clientId,browserFamily,receivedAt:new Date().toISOString(),events});
  }
  elapsed(id: string) { const value = this.active.get(id); return value ? Math.round(this.now() - value.start) : 0; }
  disconnect(id: string) { const value = this.active.get(id); if (value) value.disconnected = true; }
  finish(id: string, status: number, aborted = false) {
    const value = this.active.get(id);
    if (!value) return;
    this.recent.push({id, path:value.path, durationMs:this.elapsed(id), status, aborted:aborted || Boolean(value.disconnected), at:new Date().toISOString()});
    this.active.delete(id);
    if (this.recent.length > this.capacity) this.recent.splice(0, this.recent.length - this.capacity);
  }
  snapshot() {
    return {browsers:[...this.browsers.values()], recent:[...this.recent], pending:[...this.active].slice(-this.capacity).map(([id, value]) => ({id, path:value.path, elapsedMs:this.elapsed(id), ...(value.disconnected ? {clientDisconnected:true} : {})}))};
  }
}
