/** Share only in-flight reads; completed results are never cached across publications. */
export function createOverviewRequest<T>(read: (hidden: string[], clusters: string[], signal: AbortSignal) => Promise<T>) {
  const pending = new Map<string, {promise: Promise<T>; controller: AbortController; readers: number}>();
  return (hidden: string[], clusters: string[], signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = JSON.stringify([hidden, clusters]);
    let entry = pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created = {controller, readers: 0, promise: undefined as unknown as Promise<T>};
      created.promise = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return read(hidden, clusters, controller.signal);
      }).finally(() => { if (pending.get(key) === created) pending.delete(key); });
      pending.set(key, created);
      entry = created;
    }
    const shared = entry;
    shared.readers++;
    if (!signal) return shared.promise;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const leave = () => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener("abort", abort);
        shared.readers--;
        return true;
      };
      const abort = () => {
        if (!leave()) return;
        if (!shared.readers) {
          if (pending.get(key) === shared) pending.delete(key);
          shared.controller.abort();
        }
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, {once: true});
      shared.promise.then(value => { if (leave()) resolve(value); }, error => { if (leave()) reject(error); });
    });
  };
}
