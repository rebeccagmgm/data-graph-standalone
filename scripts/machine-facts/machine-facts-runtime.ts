import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJson, sha256 } from "./machine-facts-contract.ts";
export { writeCanonicalJsonl } from "./jsonl-store.ts";

export type BundleValidator = (bundleDir: string) => string[];

export function writeCanonical(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, canonicalJson(value), "utf8");
}

export function fileHash(path: string): string {
	return sha256(readFileSync(path));
}

export function writeStatusFile(path: string, status: unknown): void {
	const temp = `${path}.tmp`;
	const backup = `${path}.bak`;
	if (existsSync(backup)) throw new Error("RECOVERY_REQUIRED: stale status backup exists");
	writeCanonical(temp, status);
	try {
		if (existsSync(path)) renameSync(path, backup);
		renameSync(temp, path);
		if (existsSync(backup)) rmSync(backup, { force: true });
	} catch (error) {
		if (!existsSync(path) && existsSync(backup)) renameSync(backup, path);
		if (existsSync(temp)) rmSync(temp, { force: true });
		throw error;
	}
}

export function recoverArtifactState(root: string, validateBundle: BundleValidator): void {
	const statusPath = join(root, "analysis-status.json");
	const statusBackup = `${statusPath}.bak`;
	if (existsSync(statusBackup)) {
		if (existsSync(statusPath)) throw new Error("RECOVERY_REQUIRED: status and status backup both exist");
		renameSync(statusBackup, statusPath);
	}
	const recovery = join(root, ".recovery");
	const staging = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(".staging-"))
		.map((entry) => join(root, entry.name));
	for (const stagingPath of staging) {
		if (validateBundle(stagingPath).length === 0)
			throw new Error("RECOVERY_REQUIRED: valid staging directory requires inspection");
		rmSync(stagingPath, { recursive: true, force: true });
	}
	if (existsSync(recovery)) {
		const errors = validateBundle(recovery);
		const bundle = join(root, "bundle");
		if (existsSync(bundle) || errors.length > 0)
			throw new Error(`RECOVERY_REQUIRED: recovery directory requires inspection (${errors.join("; ")})`);
		renameSync(recovery, bundle);
	}
	if (existsSync(statusPath)) {
		const status = JSON.parse(readFileSync(statusPath, "utf8")) as { state?: string };
		if (status.state === "ANALYZING") throw new Error("RECOVERY_REQUIRED: previous analysis was interrupted");
	}
}

export function publishArtifactBundle(options: {
	root: string;
	staging: string;
	bundle: string;
	manifest: unknown;
	validateBundle: BundleValidator;
	manifestContext?: (manifest: unknown) => unknown;
}): { status: "CREATED" | "REUSED" | "REPLACED"; manifest_sha256: string } {
	const manifestBytes = canonicalJson(options.manifest);
	const manifestHash = sha256(manifestBytes);
	const hadExisting = existsSync(options.bundle);
	if (hadExisting) {
		const existing = JSON.parse(readFileSync(join(options.bundle, "manifest.json"), "utf8")) as unknown;
		const existingErrors = options.validateBundle(options.bundle);
		if (existingErrors.length === 0 && sha256(canonicalJson(existing)) === sha256(manifestBytes)) {
			rmSync(options.staging, { recursive: true, force: true });
			return { status: "REUSED", manifest_sha256: sha256(canonicalJson(existing)) };
		}
		if (
			existingErrors.length === 0 &&
			options.manifestContext &&
			sha256(canonicalJson(options.manifestContext(existing))) ===
				sha256(canonicalJson(options.manifestContext(options.manifest)))
		) {
			rmSync(options.staging, { recursive: true, force: true });
			throw new Error("NON_DETERMINISTIC_OUTPUT: same analysis context produced different Bundle content");
		}
	}
	const recovery = join(options.root, ".recovery");
	if (existsSync(recovery)) throw new Error("RECOVERY_REQUIRED: recovery directory exists");
	try {
		if (hadExisting) renameSync(options.bundle, recovery);
		renameSync(options.staging, options.bundle);
		const errors = options.validateBundle(options.bundle);
		if (errors.length) throw new Error(`published Bundle failed validation: ${errors.join("; ")}`);
		if (existsSync(recovery)) rmSync(recovery, { recursive: true, force: true });
		return { status: hadExisting ? "REPLACED" : "CREATED", manifest_sha256: manifestHash };
	} catch (error) {
		if (existsSync(options.bundle)) rmSync(options.bundle, { recursive: true, force: true });
		if (existsSync(recovery)) renameSync(recovery, options.bundle);
		throw error;
	}
}
