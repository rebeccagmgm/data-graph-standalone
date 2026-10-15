import type { PartitionOverlapStatus } from "./types.ts";
import { CONTINUATION_POLICY_SCHEMA_VERSION } from "./types.ts";

export type HoraeUnavailablePolicy = "FAIL_CLOSED_NO_PRUNE";

export interface ContinuationPolicy {
  readonly schemaVersion: typeof CONTINUATION_POLICY_SCHEMA_VERSION;
  readonly enabledRuleIds: readonly string[];
  readonly horaeUnavailable: HoraeUnavailablePolicy;
  readonly confirmOn: readonly PartitionOverlapStatus[];
  readonly pruneOn: readonly PartitionOverlapStatus[];
}

export const DEFAULT_CONTINUATION_POLICY: ContinuationPolicy = {
  schemaVersion: CONTINUATION_POLICY_SCHEMA_VERSION,
  enabledRuleIds: [
    "PRUNE_DISJOINT",
    "PARTITION_REMATCH",
  ],
  horaeUnavailable: "FAIL_CLOSED_NO_PRUNE",
  confirmOn: ["PROVEN_OVERLAP"],
  pruneOn: ["PROVEN_DISJOINT"],
};

export function isRuleEnabled(
  policy: ContinuationPolicy,
  ruleId: string,
): boolean {
  return policy.enabledRuleIds.includes(ruleId);
}
