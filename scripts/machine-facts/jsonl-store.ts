import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { canonicalJsonl, sha256 } from "./machine-facts-contract.ts";

export type JsonRecord = Record<string, unknown>;

export type JsonlStoreResolution =
	| { readonly status: "MISSING" }
	| { readonly status: "LEGACY_PLAIN"; readonly path: string }
	| { readonly status: "GZIP"; readonly path: string }
	| { readonly status: "CONFLICT"; readonly plain: string; readonly gzip: string };

const GZIP_MAGIC0 = 0x1f;
const GZIP_MAGIC1 = 0x8b;

export function gzipJsonlPath(logicalPath: string): string {
	return logicalPath.endsWith(".gz") ? logicalPath : `${logicalPath}.gz`;
}

export function inspectJsonlStore(logicalPath: string): JsonlStoreResolution {
	const gzipPath = gzipJsonlPath(logicalPath);
	const plain = existsSync(logicalPath);
	const gzip = existsSync(gzipPath);
	if (plain && gzip) return { status: "CONFLICT", plain: logicalPath, gzip: gzipPath };
	if (plain) return { status: "LEGACY_PLAIN", path: logicalPath };
	if (gzip) return { status: "GZIP", path: gzipPath };
	return { status: "MISSING" };
}

export function jsonlStoreExists(logicalPath: string): boolean {
	return inspectJsonlStore(logicalPath).status === "GZIP";
}

export function gzipCanonicalBytes(bytes: string | Uint8Array): Buffer {
	const gz = gzipSync(bytes, { level: 9 });
	gz[4] = 0;
	gz[5] = 0;
	gz[6] = 0;
	gz[7] = 0;
	gz[9] = 255;
	return gz;
}

function isGzipBuffer(bytes: Buffer): boolean {
	return bytes.length >= 2 && bytes[0] === GZIP_MAGIC0 && bytes[1] === GZIP_MAGIC1;
}

export function decodeJsonlStoreBytes(bytes: Buffer): string {
	if (bytes.length === 0) return "";
	const uncompressed = isGzipBuffer(bytes) ? gunzipSync(bytes) : bytes;
	return uncompressed.toString("utf8");
}

export function readJsonlText(logicalPath: string): string {
	const resolution = inspectJsonlStore(logicalPath);
	if (resolution.status === "MISSING") return "";
	if (resolution.status === "CONFLICT") {
		throw new Error(`JSONL_STORE_CONFLICT:${logicalPath}`);
	}
	if (resolution.status === "LEGACY_PLAIN") {
		throw new Error(`JSONL_STORE_LEGACY_PLAIN:${logicalPath}`);
	}
	return decodeJsonlStoreBytes(readFileSync(resolution.path));
}

export function readJsonlRecords(logicalPath: string): JsonRecord[] {
	const text = readJsonlText(logicalPath).trim();
	if (!text) return [];
	return text.split(/\r?\n/).map((line) => JSON.parse(line) as JsonRecord);
}

export function hashJsonlStore(logicalPath: string): string {
	const resolution = inspectJsonlStore(logicalPath);
	if (resolution.status === "MISSING") throw new Error(`JSONL_STORE_MISSING:${logicalPath}`);
	if (resolution.status === "CONFLICT") throw new Error(`JSONL_STORE_CONFLICT:${logicalPath}`);
	if (resolution.status === "LEGACY_PLAIN") throw new Error(`JSONL_STORE_LEGACY_PLAIN:${logicalPath}`);
	return sha256(decodeJsonlStoreBytes(readFileSync(resolution.path)));
}

export function writeCanonicalJsonl(
	path: string,
	records: readonly unknown[],
): { row_count: number; content_sha256: string } {
	const bytes = canonicalJsonl(records);
	mkdirSync(dirname(path), { recursive: true });
	const gzipPath = gzipJsonlPath(path);
	writeFileSync(gzipPath, gzipCanonicalBytes(bytes));
	if (existsSync(path) && path !== gzipPath) rmSync(path, { force: true });
	return { row_count: records.length, content_sha256: sha256(bytes) };
}
