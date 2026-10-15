import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";

export const JSONL_OFFSET_INDEX_SCHEMA_VERSION = "1.1.0" as const;

type JsonRecord = Record<string, unknown>;

export type KeyOffset = number | "AMBIGUOUS";

export interface JsonlOffsetIndex {
  readonly sourcePath: string;
  readonly sourceSize: number;
  readonly sourceMtimeMs: number;
  readonly keyOffsets: ReadonlyMap<string, KeyOffset>;
}

export type JsonlKeyLookup =
  | { readonly status: "HIT"; readonly offset: number; readonly record: JsonRecord }
  | { readonly status: "MISS" }
  | { readonly status: "AMBIGUOUS" };

const FORBIDDEN_CATALOG = /\.(xlsx|csv|sqlite)$|_partial/i;

export function assertJsonlCatalogPath(path: string): void {
  const name = basename(path);
  if (FORBIDDEN_CATALOG.test(name) || !name.toLowerCase().endsWith(".jsonl"))
    throw new Error(`FORBIDDEN_CATALOG_INPUT:${path}`);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export type JsonlRecordKeyFn = (
  record: JsonRecord,
) => string | readonly string[] | undefined;

export type JsonlSameRecordFn = (
  left: JsonRecord,
  right: JsonRecord,
) => boolean;

function forEachJsonlLine(
  path: string,
  onLine: (offset: number, line: string) => void,
): void {
  const fd = openSync(path, "r");
  try {
    const chunkSize = 1024 * 1024;
    const chunk = Buffer.alloc(chunkSize);
    let carry = Buffer.alloc(0);
    let filePos = 0;
    while (true) {
      const n = readSync(fd, chunk, 0, chunkSize, filePos);
      if (n === 0) break;
      const data = Buffer.concat([carry, chunk.subarray(0, n)]);
      let lineStart = 0;
      const baseOffset = filePos - carry.length;
      for (let i = 0; i < data.length; i += 1) {
        if (data[i] !== 0x0a) continue;
        const raw = data.subarray(lineStart, i);
        const line =
          raw.length > 0 && raw[raw.length - 1] === 0x0d
            ? raw.subarray(0, raw.length - 1).toString("utf8")
            : raw.toString("utf8");
        onLine(baseOffset + lineStart, line);
        lineStart = i + 1;
      }
      carry = data.subarray(lineStart);
      filePos += n;
    }
    if (carry.length > 0) {
      const line =
        carry[carry.length - 1] === 0x0d
          ? carry.subarray(0, carry.length - 1).toString("utf8")
          : carry.toString("utf8");
      onLine(filePos - carry.length, line);
    }
  } finally {
    closeSync(fd);
  }
}

export function readJsonlLineAt(path: string, offset: number): string {
  const fd = openSync(path, "r");
  try {
    const parts: Buffer[] = [];
    let pos = offset;
    const buf = Buffer.alloc(4096);
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(0x0a);
      if (nl >= 0) {
        const line = slice.subarray(0, nl);
        parts.push(
          line.length > 0 && line[line.length - 1] === 0x0d
            ? line.subarray(0, line.length - 1)
            : line,
        );
        break;
      }
      parts.push(Buffer.from(slice));
      pos += n;
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readRecordAt(path: string, offset: number): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(readJsonlLineAt(path, offset)));
  } catch {
    return undefined;
  }
}

function fingerprint(record: JsonRecord): string {
  const queryMd5 = record.querytext_md5;
  if (typeof queryMd5 === "string" && queryMd5.trim() !== "")
    return `querytext_md5:${queryMd5}`;
  const ddlMd5 = record.ddl_md5;
  if (typeof ddlMd5 === "string" && ddlMd5.trim() !== "")
    return `ddl_md5:${ddlMd5}`;
  const querytext = record.querytext;
  if (typeof querytext === "string") return `querytext:${querytext}`;
  const ddl = record.ddl;
  if (typeof ddl === "string") return `ddl:${ddl}`;
  return `json:${JSON.stringify(record)}`;
}

function sameContent(
  path: string,
  leftOffset: number,
  rightRecord: JsonRecord,
): boolean {
  const left = readRecordAt(path, leftOffset);
  if (left === undefined) return false;
  return fingerprint(left) === fingerprint(rightRecord);
}

export function buildJsonlOffsetIndex(
  jsonlPath: string,
  keyOf: JsonlRecordKeyFn,
  options?: { readonly sameRecord?: JsonlSameRecordFn },
): JsonlOffsetIndex {
  assertJsonlCatalogPath(jsonlPath);
  const stat = statSync(jsonlPath);
  if (!stat.isFile()) throw new Error(`JSONL_NOT_A_FILE:${jsonlPath}`);
  const keyOffsets = new Map<string, KeyOffset>();
  const sameRecord = options?.sameRecord;
  forEachJsonlLine(jsonlPath, (offset, line) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const record = asRecord(parsed);
    if (record === undefined) return;
    const keys = keyOf(record);
    if (keys === undefined) return;
    for (const rawKey of typeof keys === "string" ? [keys] : keys) {
      const key = rawKey.trim().toLowerCase();
      if (key === "") continue;
      const existing = keyOffsets.get(key);
      if (existing === undefined) {
        keyOffsets.set(key, offset);
        continue;
      }
      if (existing === "AMBIGUOUS" || existing === offset) continue;
      if (sameContent(jsonlPath, existing, record)) continue;
      if (sameRecord !== undefined) {
        const left = readRecordAt(jsonlPath, existing);
        if (left !== undefined && sameRecord(left, record)) continue;
      }
      keyOffsets.set(key, "AMBIGUOUS");
    }
  });
  return {
    sourcePath: jsonlPath,
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
    keyOffsets,
  };
}

interface PersistedJsonlOffsetIndex {
  readonly schemaVersion: typeof JSONL_OFFSET_INDEX_SCHEMA_VERSION;
  readonly sourcePath: string;
  readonly sourceSize: number;
  readonly sourceMtimeMs: number;
  readonly keyOffsets: Record<string, number>;
  readonly ambiguousKeys: readonly string[];
}

function toPersisted(index: JsonlOffsetIndex): PersistedJsonlOffsetIndex {
  const keyOffsets: Record<string, number> = {};
  const ambiguousKeys: string[] = [];
  for (const [key, offset] of index.keyOffsets) {
    if (offset === "AMBIGUOUS") ambiguousKeys.push(key);
    else keyOffsets[key] = offset;
  }
  return {
    schemaVersion: JSONL_OFFSET_INDEX_SCHEMA_VERSION,
    sourcePath: index.sourcePath,
    sourceSize: index.sourceSize,
    sourceMtimeMs: index.sourceMtimeMs,
    keyOffsets,
    ambiguousKeys,
  };
}

function fromPersisted(document: PersistedJsonlOffsetIndex): JsonlOffsetIndex {
  const keyOffsets = new Map<string, KeyOffset>();
  for (const [key, offset] of Object.entries(document.keyOffsets))
    keyOffsets.set(key, offset);
  for (const key of document.ambiguousKeys) keyOffsets.set(key, "AMBIGUOUS");
  return {
    sourcePath: document.sourcePath,
    sourceSize: document.sourceSize,
    sourceMtimeMs: document.sourceMtimeMs,
    keyOffsets,
  };
}

function persistMatchesSource(
  document: PersistedJsonlOffsetIndex,
  jsonlPath: string,
): boolean {
  if (document.schemaVersion !== JSONL_OFFSET_INDEX_SCHEMA_VERSION) return false;
  if (document.sourcePath !== jsonlPath) return false;
  try {
    const stat = statSync(jsonlPath);
    return (
      stat.size === document.sourceSize && stat.mtimeMs === document.sourceMtimeMs
    );
  } catch {
    return false;
  }
}

export function persistJsonlOffsetIndex(
  index: JsonlOffsetIndex,
  persistPath: string,
): void {
  mkdirSync(dirname(persistPath), { recursive: true });
  writeFileSync(persistPath, `${JSON.stringify(toPersisted(index))}\n`, "utf8");
}

export function loadPersistedJsonlOffsetIndex(
  persistPath: string,
  jsonlPath: string,
): JsonlOffsetIndex | undefined {
  if (!existsSync(persistPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(persistPath, "utf8"));
    const document = parsed as PersistedJsonlOffsetIndex;
    if (!persistMatchesSource(document, jsonlPath)) return undefined;
    return fromPersisted(document);
  } catch {
    return undefined;
  }
}

export function loadJsonlOffsetIndex(
  jsonlPath: string,
  options: {
    readonly persistPath?: string;
    readonly keyOf: JsonlRecordKeyFn;
    readonly sameRecord?: JsonlSameRecordFn;
  },
): JsonlOffsetIndex {
  assertJsonlCatalogPath(jsonlPath);
  if (options.persistPath !== undefined) {
    const persisted = loadPersistedJsonlOffsetIndex(
      options.persistPath,
      jsonlPath,
    );
    if (persisted !== undefined) return persisted;
  }
  const index = buildJsonlOffsetIndex(jsonlPath, options.keyOf, {
    sameRecord: options.sameRecord,
  });
  if (options.persistPath !== undefined) {
    try {
      persistJsonlOffsetIndex(index, options.persistPath);
    } catch {
      // Keep the in-process index when persist is not writable.
    }
  }
  return index;
}

export function lookupJsonlByKey(
  index: JsonlOffsetIndex,
  key: string,
): JsonlKeyLookup {
  const offset = index.keyOffsets.get(key.trim().toLowerCase());
  if (offset === undefined) return { status: "MISS" };
  if (offset === "AMBIGUOUS") return { status: "AMBIGUOUS" };
  const record = readRecordAt(index.sourcePath, offset);
  if (record === undefined) return { status: "MISS" };
  return { status: "HIT", offset, record };
}
