import { normalizeName } from "./machine-facts-contract.ts";

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? null : trimmed;
}

/**
 * Field-lineage occurrence identity: strip slot#ordinal / ordinal prefixes and
 * the `task:…:relation:` globalization, then compare the local relation tail.
 * UNION branches (`setop.b0` vs `setop.b1`) stay distinct.
 *
 * `(child)` / `(child-N)` is a synthetic frame the plan adapter inserts for a
 * scope it reaches outside the FROM chain (a CTE body, for example). The
 * read-occurrence resolver names the same read without it, so the frame is
 * dropped here rather than teaching every consumer about both spellings.
 */
export function canonicalRelationIdentity(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  const withoutQueryPrefix = raw
    .replace(/^[a-z_]+#[^:]+:/i, "")
    .replace(/^\d+:/, "");
  const marker = withoutQueryPrefix.lastIndexOf(":relation:");
  const local =
    marker >= 0 ? withoutQueryPrefix.slice(marker + ":relation:".length) : withoutQueryPrefix;
  return normalizeName(local.replace(/\.\(child(?:-\d+)?\)/gi, ""));
}

export function sameRelationIdentity(left: unknown, right: unknown): boolean {
  const leftIdentity = canonicalRelationIdentity(left);
  const rightIdentity = canonicalRelationIdentity(right);
  return leftIdentity !== null && leftIdentity === rightIdentity;
}

/** Slot identity from a statement id. Never use a read occurrence token here. */
export function canonicalPlanSlotId(value: string): string {
  const match = value.trim().match(/^(.*?):statement:\d+(?::|$)/i);
  return match?.[1] ?? value.trim();
}

export function isPlaceholderSqlSourceId(value: string): boolean {
  return /^[a-z_]+#\d+/i.test(value.trim());
}

/** Real plan slot, or null. query# / create# occurrence tokens are not slots. */
export function planSlotSqlSourceId(value: string | null | undefined): string | null {
  const raw = nonEmpty(value);
  if (!raw || isPlaceholderSqlSourceId(raw)) return null;
  const canonical = canonicalPlanSlotId(raw);
  return isPlaceholderSqlSourceId(canonical) ? null : canonical;
}
