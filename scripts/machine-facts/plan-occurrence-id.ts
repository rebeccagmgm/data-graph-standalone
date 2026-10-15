/** Canonical Machine Facts identity for one Plan relation occurrence. */
export function globalRelationId(
  taskId: string,
  statementIndex: number,
  localId: string,
): string {
  const relationMarker = ":relation:";
  const markerIndex = localId.indexOf(relationMarker);
  const normalizedLocalId = markerIndex >= 0 &&
      (localId.startsWith("sql:") || localId.includes(":statement:sql:"))
    ? localId.slice(markerIndex + relationMarker.length)
    : localId;
  return `task:${taskId}:statement:${statementIndex}:relation:${normalizedLocalId}`;
}

/** Reverse a relation id only when exact globalization roundtrips. */
export function localRelationId(
  taskId: string,
  statementIndex: number,
  globalId: string,
): string | null {
  const prefix = `task:${taskId}:statement:${statementIndex}:relation:`;
  if (!globalId.startsWith(prefix)) return null;
  const localId = globalId.slice(prefix.length);
  return localId && globalRelationId(taskId, statementIndex, localId) === globalId
    ? localId
    : null;
}

/** Canonical Machine Facts identity for one Plan expression occurrence. */
export function globalExpressionId(
  taskId: string,
  statementIndex: number,
  localId: string,
): string {
  const marker = ":expression:";
  const markerIndex = localId.indexOf(marker);
  if (markerIndex < 0)
    return `task:${taskId}:statement:${statementIndex}:expression:${localId}`;
  return `${globalRelationId(
    taskId,
    statementIndex,
    localId.slice(0, markerIndex),
  )}${marker}${localId.slice(markerIndex + marker.length)}`;
}

/** Reverse an expression id only when exact globalization roundtrips. */
export function localExpressionId(
  taskId: string,
  statementIndex: number,
  globalId: string,
): string | null {
  const relationPrefix = `task:${taskId}:statement:${statementIndex}:relation:`;
  const marker = ":expression:";
  if (globalId.startsWith(relationPrefix)) {
    const markerIndex = globalId.indexOf(marker, relationPrefix.length);
    if (markerIndex < 0) return null;
    const globalRelation = globalId.slice(0, markerIndex);
    const localRelation = localRelationId(taskId, statementIndex, globalRelation);
    const suffix = globalId.slice(markerIndex + marker.length);
    if (!localRelation || !suffix) return null;
    const localId = `${localRelation}${marker}${suffix}`;
    return globalExpressionId(taskId, statementIndex, localId) === globalId
      ? localId
      : null;
  }
  const prefix = `task:${taskId}:statement:${statementIndex}:expression:`;
  if (!globalId.startsWith(prefix)) return null;
  const localId = globalId.slice(prefix.length);
  return localId && globalExpressionId(taskId, statementIndex, localId) === globalId
    ? localId
    : null;
}
