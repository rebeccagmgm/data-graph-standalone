import {
  physicalFieldForTable,
  resolvePhysicalInputField,
  resolvedPhysicalFields,
} from "../../shared/physical-field-resolver.ts";
import {
  createPhysicalFieldExpander,
  type PhysicalFieldExpander,
  type PhysicalFieldExpanderContext,
  type PhysicalFieldExpansionRequest,
} from "../../../addons/task-lineage/reconcile/consumer/field-lineage/physical-field-expander.ts";
import type {
  PhysicalFieldResolution,
  PhysicalFieldResolutionContext,
} from "../../shared/physical-field-resolver.ts";

/**
 * Canonical evidence access for the causal consumer.
 *
 * This module is intentionally a read-only facade over the existing physical
 * resolver and expander. It does not collect, mutate, or republish evidence.
 */
export interface CanonicalEvidenceAdapter {
  readonly resolvePhysicalInputField: (
    context: PhysicalFieldResolutionContext,
    reference: { readonly table: string; readonly column: string },
  ) => PhysicalFieldResolution;
  readonly expandPhysicalField: (
    context: PhysicalFieldExpanderContext,
    request: PhysicalFieldExpansionRequest,
  ) => ReturnType<PhysicalFieldExpander["expand"]>;
}

export {
  createPhysicalFieldExpander,
  physicalFieldForTable,
  resolvePhysicalInputField,
  resolvedPhysicalFields,
};

export type {
  PhysicalFieldExpander,
  PhysicalFieldExpanderContext,
  PhysicalFieldExpansion,
  PhysicalFieldExpansionRequest,
  PhysicalFieldExpanderTaskPack,
  PhysicalFieldExpanderTaskPackLookup,
  PhysicalFieldProducerExpansion,
} from "../../../addons/task-lineage/reconcile/consumer/field-lineage/physical-field-expander.ts";
export type {
  PhysicalFieldResolution,
  PhysicalFieldResolutionContext,
  PhysicalFieldResolutionFailure,
} from "../../shared/physical-field-resolver.ts";
export type { PhysicalFieldIdentity } from "../../../addons/task-lineage/reconcile/consumer/field-lineage/field-lineage-contract.ts";

export const canonicalEvidenceAdapter: CanonicalEvidenceAdapter = Object.freeze({
  resolvePhysicalInputField,
  expandPhysicalField: (
    context: PhysicalFieldExpanderContext,
    request: PhysicalFieldExpansionRequest,
  ) =>
    createPhysicalFieldExpander(context, {
      evidenceMode: "STRICT_CAUSAL",
    }).expand(request),
});

export function createCanonicalEvidenceAdapter(): CanonicalEvidenceAdapter {
  return canonicalEvidenceAdapter;
}
