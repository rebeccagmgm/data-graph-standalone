import type {
  PhysicalTableCatalog,
  PhysicalTableCatalogEntry,
} from "../../machine-facts/input-pack-machine-facts.ts";
import { normalizeName } from "../../machine-facts/machine-facts-contract.ts";
import type { TaskDefaultSchema } from "../../reconcile/shared/task-default-schema.ts";

export type TaskLocalIdentityStatus = "CONFIRMED" | "CANDIDATE_DATASET" | "UNRESOLVED";
export type TaskLocalQualificationStatus =
  | "CONFIRMED(TASK_TARGET)"
  | "ASSUMED(TASK_NAME_ONLY)"
  | "UNRESOLVED";

export interface TaskLocalTableIdentity {
  readonly platform: string | null;
  readonly dataSource: string | null;
  readonly stableTableId: string | null;
  readonly qualifiedName: string;
  readonly identityStatus: TaskLocalIdentityStatus;
  readonly qualificationStatus: TaskLocalQualificationStatus | null;
  readonly identityReasonCode: string | null;
  readonly originalName: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isDefaultDataSource(value: string): boolean {
  return value.trim().toLowerCase() === "default";
}

function fallbackIdentity(
  fallback: Pick<PhysicalTableCatalogEntry, "platform" | "dataSource">,
): Pick<TaskLocalTableIdentity, "platform" | "dataSource" | "stableTableId"> {
  return {
    platform: text(fallback.platform),
    dataSource: text(fallback.dataSource),
    stableTableId: null,
  };
}

/**
 * Resolve one task-local table reference without catalog-tail or task-name table guesses.
 * The returned qualification status is occurrence-specific; the catalog entry, when present,
 * is still used to keep a stable physical node identity for a candidate occurrence.
 */
export function resolveTaskLocalTableIdentity(input: {
  readonly catalog: PhysicalTableCatalog;
  readonly rawName: string;
  readonly defaultSchema: TaskDefaultSchema | null;
  readonly fallback: Pick<PhysicalTableCatalogEntry, "platform" | "dataSource">;
}): TaskLocalTableIdentity {
  const originalName = input.rawName.trim();
  const normalizedRaw = normalizeName(originalName);
  const bare = !normalizedRaw.includes(".");
  const qualifiedName = bare && input.defaultSchema
    ? `${normalizeName(input.defaultSchema.schema)}.${normalizedRaw}`
    : normalizedRaw;
  const matches = input.catalog.byQualifiedName.get(qualifiedName) ?? [];
  const match = matches.length === 1 ? matches[0]! : null;
  const qualifiedByTarget = bare
    && input.defaultSchema?.evidenceSources.includes("TASK_TARGET") === true;
  const qualifiedByTaskName = bare
    && input.defaultSchema?.evidenceSources.includes("TASK_NAME") === true
    && !qualifiedByTarget;
  const qualificationStatus: TaskLocalQualificationStatus | null = !bare
    ? null
    : qualifiedByTarget
    ? "CONFIRMED(TASK_TARGET)"
    : qualifiedByTaskName
    ? "ASSUMED(TASK_NAME_ONLY)"
    : "UNRESOLVED";

  const physical = match && !isDefaultDataSource(match.dataSource) ? match : null;
  const identity = physical
    ? {
      platform: physical.platform,
      dataSource: physical.dataSource,
      stableTableId: physical.stableTableId,
    }
    : fallbackIdentity(input.fallback);

  let identityStatus: TaskLocalIdentityStatus = "CANDIDATE_DATASET";
  let identityReasonCode: string | null = null;
  if (matches.length === 0) {
    identityReasonCode = bare && qualificationStatus === "UNRESOLVED"
      ? "TABLE_QUALIFICATION_UNRESOLVED"
      : "TABLE_PACK_MISSING";
  } else if (matches.length > 1) {
    identityReasonCode = "TABLE_IDENTITY_AMBIGUOUS";
  } else if (!physical) {
    identityReasonCode = "TABLE_IDENTITY_DEFAULT_SOURCE";
  } else if (!bare || qualifiedByTarget) {
    identityStatus = "CONFIRMED";
  } else {
    identityReasonCode = "TABLE_QUALIFICATION_ASSUMED";
  }

  return {
    ...identity,
    qualifiedName,
    identityStatus,
    qualificationStatus,
    identityReasonCode,
    originalName,
  };
}

export function isTempLikeTableName(value: string): boolean {
  const normalized = normalizeName(value);
  const [schema = "", ...tableParts] = normalized.split(".");
  const tableName = tableParts.join(".");
  const scratchSchema = /^(?:temp(?:_[a-z0-9]+)?|gfstest(?:_[a-z0-9]+)?)$/.test(schema);
  const scratchTable = /(?:^|[._])(?:tmp|temp)(?:[._]|$)/.test(tableName);
  return scratchSchema || scratchTable;
}
