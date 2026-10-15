import { createHash } from "node:crypto";

export const MACHINE_FACTS_CONTRACT_VERSION = "1.3.0" as const;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

/** Stable JSON used by the published artifact contracts. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function canonicalJsonl(records: readonly unknown[]): string {
  return records.length
    ? `${records.map((record) => JSON.stringify(canonicalValue(record))).join("\n")}\n`
    : "";
}

/** Canonical artifact hash with volatile top-level fields excluded. */
export function canonicalHash(
  value: JsonValue,
  excludedFields: readonly string[] = [],
): string {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("canonicalHash requires a JSON object");
  const excluded = new Set(excludedFields);
  const filtered = Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.has(key)),
  );
  return sha256(canonicalJson(filtered));
}

export function safeSegment(value: string, label: string): string {
  const reserved = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) ||
    /[. ]$/.test(value) ||
    reserved.test(value)
  )
    throw new Error(`${label} must be a safe path segment`);
  return value;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}
