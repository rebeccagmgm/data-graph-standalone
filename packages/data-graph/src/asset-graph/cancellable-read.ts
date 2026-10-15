/** Stop a disconnected HTTP reader between database stages, without cancelling shared work. */
export async function cancellableRead<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const value = await read();
  signal.throwIfAborted();
  return value;
}
