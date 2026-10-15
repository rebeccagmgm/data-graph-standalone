import {
  canonicalJson,
  sha256,
} from "../../../machine-facts/machine-facts-contract.ts";
import type {
  PhysicalFieldExpansion,
  PhysicalFieldProducerExpansion,
} from "../../../addons/task-lineage/reconcile/consumer/field-lineage/physical-field-expander.ts";
import type { PhysicalFieldIdentity } from "../../../addons/task-lineage/reconcile/consumer/field-lineage/field-lineage-contract.ts";

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function producerFieldKey(producer: PhysicalFieldProducerExpansion): string {
  const field = producer.producerField;
  return canonicalJson({
    producerTaskId: producer.producerTaskId,
    platform: field?.platform ?? null,
    dataSource: field?.dataSource ?? null,
    qualifiedName: field?.qualifiedName ?? null,
    column: field?.column ?? null,
  });
}

/**
 * The legacy field expander may aggregate several same-table WRITE
 * occurrences.  That behavior is useful to legacy lineage, but the strict
 * causal lane must not treat an unpinned sibling-write set as one confirmed
 * occurrence.
 */
export function guardOccurrenceExactPhysicalExpansion(input: {
  readonly taskId: string;
  readonly sourceNodeId: string;
  readonly field: PhysicalFieldIdentity;
  readonly expansion: PhysicalFieldExpansion;
}): PhysicalFieldExpansion {
  const confirmedByProducerField = new Map<
    string,
    PhysicalFieldProducerExpansion[]
  >();
  for (const producer of input.expansion.producers) {
    if (producer.evidenceStatus !== "CONFIRMED") continue;
    const key = producerFieldKey(producer);
    confirmedByProducerField.set(key, [
      ...(confirmedByProducerField.get(key) ?? []),
      producer,
    ]);
  }

  const conflicts = [...confirmedByProducerField.values()].flatMap(
    (producers) => {
      const writeObservationIds = sortedUnique(
        producers.flatMap((producer) =>
          producer.producerBindings.flatMap((binding) => {
            const id = text(binding.write_observation_id);
            return id ? [id] : [];
          })
        ),
      );
      return writeObservationIds.length > 1
        ? [{ producers, writeObservationIds }]
        : [];
    },
  );
  if (conflicts.length === 0) return input.expansion;

  const producerTaskIds = sortedUnique(
    conflicts.flatMap(({ producers }) =>
      producers.map((producer) => producer.producerTaskId)
    ),
  );
  const writeObservationIds = sortedUnique(
    conflicts.flatMap((conflict) => conflict.writeObservationIds),
  );
  const evidenceRefs = sortedUnique(
    conflicts.flatMap(({ producers }) =>
      producers.flatMap((producer) => [
        ...producer.evidenceRefs,
        ...producer.producerBindings.flatMap((binding) => [
          text(binding.binding_id),
          text(binding.write_observation_id),
        ].filter((value): value is string => value !== null)),
      ])
    ),
  );
  const identity = {
    taskId: input.taskId,
    sourceNodeId: input.sourceNodeId,
    field: input.field,
    producerTaskIds,
    writeObservationIds,
    evidenceRefs,
  };
  return {
    ...input.expansion,
    ambiguous: true,
    producers: [],
    gaps: [
      ...input.expansion.gaps,
      {
        gapId: `field-lineage-gap:${sha256(canonicalJson(identity))}`,
        taskId: input.taskId,
        nodeId: input.sourceNodeId,
        field: input.field,
        reasonCode: "PRODUCER_WRITE_OBSERVATION_AMBIGUOUS",
        message: `strict causal expansion cannot choose one producer write occurrence (${writeObservationIds.join(",")})`,
        evidenceStatus: "UNRESOLVED",
        evidenceRefs,
      },
    ],
  };
}
