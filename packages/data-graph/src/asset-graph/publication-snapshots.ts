import {
  canonicalJson,
  sha256,
} from "../../../../scripts/machine-facts/machine-facts-contract.ts";
import type { TerminalTableConfig } from "../../../../scripts/reconcile/shared/terminal-table-config.ts";
import {
  assertUnionContinuationIndex,
  unionContinuationIndexContentHash,
  type UnionContinuationIndex,
} from "../continuation/continuation-index.ts";
import {
  assertSourceEndpointBoundarySnapshot,
  augmentIndexWithSourceEndpointBoundaries,
  type SourceEndpointBoundarySnapshot,
} from "./source-endpoint-boundary.ts";
import {
  assertTerminalPolicySnapshot,
  buildTerminalPolicySnapshot,
  type TerminalPolicySnapshot,
} from "./terminal-policy.ts";

/** Bind both published snapshots to the final index using the readers' hashes. */
export function buildPublicationSnapshots(input: {
  readonly rawIndex: UnionContinuationIndex;
  readonly terminalConfig: TerminalTableConfig;
  readonly boundarySnapshotDraft: SourceEndpointBoundarySnapshot;
}): {
  index: UnionContinuationIndex;
  terminalPolicy: TerminalPolicySnapshot;
  boundarySnapshot: SourceEndpointBoundarySnapshot;
} {
  const { rawIndex, terminalConfig, boundarySnapshotDraft } = input;
  const { contentHash: _indexHash, ...indexBody } =
    augmentIndexWithSourceEndpointBoundaries(rawIndex, boundarySnapshotDraft);
  const index = {
    ...indexBody,
    contentHash: unionContinuationIndexContentHash(indexBody),
  };
  const { contentHash: _boundaryHash, ...draftBody } = boundarySnapshotDraft;
  const boundaryBody = { ...draftBody, indexContentHash: index.contentHash };
  const boundarySnapshot = {
    ...boundaryBody,
    contentHash: sha256(canonicalJson(boundaryBody)),
  };
  const terminalPolicy = buildTerminalPolicySnapshot(index, terminalConfig);
  assertUnionContinuationIndex(index);
  assertTerminalPolicySnapshot(
    terminalPolicy,
    index.contentHash,
    terminalPolicy.contentHash,
  );
  assertSourceEndpointBoundarySnapshot(
    boundarySnapshot,
    index.contentHash,
    boundarySnapshot.contentHash,
  );
  return { index, terminalPolicy, boundarySnapshot };
}
