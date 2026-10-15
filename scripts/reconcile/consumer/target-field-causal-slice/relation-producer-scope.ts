/**
 * A table-level producer bridge is occurrence-safe only when every resolved
 * output binding belongs to one producer write.  Multiple output fields from
 * that write are valid witnesses; scopes from sibling writes are ambiguous.
 */
export function selectSingleWriteProducerScopes<
  T extends {
    readonly localRootCriterion: {
      readonly rootWriteObservationId: string;
    };
  },
>(
  scopes: readonly T[],
  expectedBindingCount: number,
): readonly T[] | null {
  if (expectedBindingCount <= 0 || scopes.length !== expectedBindingCount)
    return null;
  const writeObservationIds = new Set(
    scopes.map(
      (scope) => scope.localRootCriterion.rootWriteObservationId,
    ),
  );
  return writeObservationIds.size === 1 ? scopes : null;
}

type EvidenceRow = Readonly<Record<string, unknown>>;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalized(value: unknown): string {
  return text(value)?.toLowerCase() ?? "";
}

/**
 * Resolve a table-level bridge from the complete producer WRITE set.  Looking
 * only at RESOLVED bindings is unsafe: a sibling write can itself be missing a
 * binding and would otherwise disappear from the ambiguity check.
 */
export function resolveUnambiguousRelationProducerScopes<
  T extends {
    readonly localRootCriterion: {
      readonly rootWriteObservationId: string;
    };
  },
>(input: {
  readonly producerTaskId: string;
  readonly targetTable: string;
  readonly datasetWrites: readonly EvidenceRow[];
  readonly outputBindings: readonly EvidenceRow[];
  readonly resolveBinding: (binding: EvidenceRow) => readonly T[];
}): readonly T[] | null {
  const targetTable = normalized(input.targetTable);
  const writes = input.datasetWrites.filter(
    (row) =>
      text(row.task_id) === input.producerTaskId &&
      normalized(row.direction) === "write" &&
      normalized(row.physical_dataset) === targetTable,
  );
  if (writes.length !== 1) return null;
  const writeObservationId = text(writes[0]!.write_observation_id);
  if (!writeObservationId) return null;

  const bindings = input.outputBindings.filter(
    (binding) =>
      text(binding.task_id) === input.producerTaskId &&
      normalized(binding.target_dataset) === targetTable &&
      normalized(binding.binding_status) === "resolved",
  );
  if (
    bindings.length === 0 ||
    bindings.some(
      (binding) =>
        text(binding.write_observation_id) !== writeObservationId,
    )
  ) return null;

  const scopes: T[] = [];
  for (const binding of bindings) {
    const resolved = input.resolveBinding(binding);
    if (
      resolved.length !== 1 ||
      resolved[0]!.localRootCriterion.rootWriteObservationId !==
        writeObservationId
    ) return null;
    scopes.push(resolved[0]!);
  }
  return selectSingleWriteProducerScopes(scopes, bindings.length);
}
