import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  sha256,
} from "../../../../scripts/machine-facts/machine-facts-contract.ts";
import {
  loadTerminalTableConfig,
  matchingTerminalRole,
  DEFAULT_TERMINAL_TABLE_CONFIG_PATH,
  type TerminalTableConfig,
} from "../../../../scripts/reconcile/shared/terminal-table-config.ts";
import type { UnionContinuationIndex } from "../continuation/continuation-index.ts";

export interface PolicyTerminalRead {
  readonly consumerTaskId: string;
  readonly readOccurrenceId: string;
  readonly qualifiedName: string;
  readonly role: string;
  readonly ruleRef: string;
}

export interface TerminalPolicySnapshot {
  readonly schemaVersion: "1.0.0";
  readonly config: TerminalTableConfig;
  readonly configHash: string;
  readonly indexContentHash: string;
  readonly reads: readonly PolicyTerminalRead[];
  readonly contentHash: string;
}

export function loadGraphTerminalPolicy(): TerminalTableConfig {
  return loadTerminalTableConfig(
    fileURLToPath(
      new URL(
        `../../../../${DEFAULT_TERMINAL_TABLE_CONFIG_PATH}`,
        import.meta.url,
      ),
    ),
  );
}

export const terminalPolicyConfigHash = (config: TerminalTableConfig): string =>
  sha256(canonicalJson(config));

/** This is a traversal policy, never a claim that a producer is absent. */
export function terminalNodeDetails(
  qualifiedName: string,
  config: TerminalTableConfig,
) {
  const role = matchingTerminalRole(config, qualifiedName);
  if (!role) return null;
  const folded = qualifiedName.toLowerCase();
  const rule = config.roles[role]!;
  const exact = rule.qualifiedNameExact?.find(
    (name) => name.toLowerCase() === folded,
  );
  const term = rule.qualifiedNameTerms.find((name) =>
    folded.includes(name.toLowerCase()),
  );
  return {
    continuationDisposition: "POLICY_TERMINAL" as const,
    boundaryRole: role,
    terminalReason: "按定义/参数表规则停止展开",
    terminalRuleRef: `${DEFAULT_TERMINAL_TABLE_CONFIG_PATH}#roles.${role}.${exact ? "qualifiedNameExact" : "qualifiedNameTerms"}=${exact ?? term}`,
    terminalConfigHash: terminalPolicyConfigHash(config),
  };
}

export function buildTerminalPolicySnapshot(
  index: UnionContinuationIndex,
  config: TerminalTableConfig,
): TerminalPolicySnapshot {
  const reads = index.entries
    .flatMap((entry): PolicyTerminalRead[] => {
      if (entry.identityStatus !== "CONFIRMED") return [];
      const terminal = terminalNodeDetails(entry.qualifiedName, config);
      return terminal
        ? [
            {
              consumerTaskId: entry.consumerTaskId,
              readOccurrenceId: entry.readOccurrenceId,
              qualifiedName: entry.qualifiedName,
              role: terminal.boundaryRole,
              ruleRef: terminal.terminalRuleRef,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        a.consumerTaskId.localeCompare(b.consumerTaskId) ||
        a.readOccurrenceId.localeCompare(b.readOccurrenceId),
    );
  const body = {
    schemaVersion: "1.0.0" as const,
    config,
    configHash: terminalPolicyConfigHash(config),
    indexContentHash: index.contentHash,
    reads,
  };
  return { ...body, contentHash: sha256(canonicalJson(body)) };
}

export function assertTerminalPolicySnapshot(
  snapshot: TerminalPolicySnapshot,
  indexHash: string,
  expectedHash: string,
): void {
  if (
    snapshot.schemaVersion !== "1.0.0" ||
    !Array.isArray(snapshot.reads) ||
    snapshot.indexContentHash !== indexHash ||
    snapshot.contentHash !== expectedHash ||
    terminalPolicyConfigHash(snapshot.config) !== snapshot.configHash
  )
    throw new Error("TERMINAL_POLICY_SNAPSHOT_MISMATCH");
  const { contentHash, ...body } = snapshot;
  if (sha256(canonicalJson(body)) !== contentHash)
    throw new Error("TERMINAL_POLICY_CONTENT_HASH_MISMATCH");
}
