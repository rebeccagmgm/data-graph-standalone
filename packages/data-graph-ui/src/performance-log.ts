import {PerformanceHistory, names, type Entry} from "../../data-graph/src/asset-graph/performance-events";
export {PerformanceHistory} from "../../data-graph/src/asset-graph/performance-events";
const storageKey = "data-graph:performance:v1";

function restore() { try { return typeof localStorage === "undefined" ? [] : JSON.parse(localStorage.getItem(storageKey) ?? "[]"); } catch { return []; } }
const history = new PerformanceHistory(200, restore());
let clientId: string | undefined;
let syncing = false;
let sent = "";
let sentAt = 0;
async function syncPerformanceLog() {
  if (syncing) return;
  try {
    clientId ??= sessionStorage.getItem("data-graph:performance-client") ?? crypto.randomUUID();
    sessionStorage.setItem("data-graph:performance-client",clientId);
    const ua = navigator.userAgent;
    const browserFamily = /Edg\//.test(ua) ? "edge" : /Chrome\//.test(ua) ? "chromium" : /Firefox\//.test(ua) ? "firefox" : /Safari\//.test(ua) ? "safari" : "unknown";
    const payload = JSON.stringify({clientId,browserFamily,events:history.snapshot()});
    if (payload === sent && Date.now() - sentAt < 60000) return;
    syncing = true;
    const response = await fetch("/api/diagnostics/browser",{method:"POST",headers:{"Content-Type":"application/json"},body:payload,keepalive:true,signal:AbortSignal.timeout(4000)});
    if (response.ok) { sent = payload; sentAt = Date.now(); }
  } catch { /* Diagnostics must never block graph operations; retry next interval. */ }
  finally { syncing = false; }
}
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let action = "unknown";
function persist() { persistTimer = undefined; try { localStorage.setItem(storageKey, JSON.stringify(history.snapshot())); } catch { /* Storage is optional. */ } }
export function recordPerformance(entry: Entry) {
  history.add(entry);
  if (typeof window !== "undefined" && !persistTimer) persistTimer = setTimeout(persist, 2000);
}
export function recordAction(name: string) { action = name; recordPerformance({kind:"action", name}); }
export function startPerformanceRecording() {
  void syncPerformanceLog();
  const syncTimer = setInterval(() => void syncPerformanceLog(), 5000);
  const observers: PerformanceObserver[] = [];
  for (const type of ["longtask", "event"]) {
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes.includes(type)) continue;
    const observer = new PerformanceObserver(list => {
      for (const item of list.getEntries()) {
        if (document.visibilityState !== "visible" || item.duration < 100) continue;
        recordPerformance({kind:type === "longtask" ? "long-task" : "interaction", name:type === "longtask" ? action : names.has(item.name) ? item.name : "unknown", durationMs:item.duration});
      }
    });
    observer.observe({type, buffered:false, ...(type === "event" ? {durationThreshold:104} : {})});
    observers.push(observer);
  }
  let previous = performance.now();
  let visible = document.visibilityState === "visible";
  const timer = setInterval(() => {
    const now = performance.now();
    const currentVisible = document.visibilityState === "visible";
    if (visible && currentVisible && now - previous > 1400) recordPerformance({kind:"event-loop", name:action, durationMs:now - previous - 1000});
    previous = now; visible = currentVisible;
  }, 1000);
  const onVisibility = () => { previous = performance.now(); visible = document.visibilityState === "visible"; if (!visible) persist(); };
  document.addEventListener("visibilitychange", onVisibility);
  const onPageHide = () => { persist(); void syncPerformanceLog(); };
  window.addEventListener("pagehide", onPageHide);
  return () => {
    observers.forEach(observer => observer.disconnect()); clearInterval(timer); clearInterval(syncTimer);
    document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pagehide", onPageHide);
    if (persistTimer) clearTimeout(persistTimer); persist();
  };
}
export async function collectPerformanceSnapshot() {
  let server: unknown;
  try { const response = await fetch("/api/diagnostics", {signal:AbortSignal.timeout(3000)}); if (response.ok) server = await response.json(); } catch { server = {unavailable:true}; }
  const data = {formatVersion:1, exportedAt:new Date().toISOString(), browser:history.snapshot(), server};
  return data;
}
// Keep existing open development tabs compatible during a hot update.
export const downloadPerformanceLog = collectPerformanceSnapshot;
