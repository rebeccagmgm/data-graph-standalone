import {
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { sha256 } from "./machine-facts-contract.ts";
import { decodeJsonlStoreBytes, gzipCanonicalBytes, gzipJsonlPath, inspectJsonlStore } from "./jsonl-store.ts";

type ManifestOutput = {
	readonly path?: unknown;
	readonly content_sha256?: unknown;
};

export interface JsonlGzipMigrationOptions {
	readonly root: string;
	readonly apply?: boolean;
}

export interface JsonlGzipMigrationResult {
	readonly manifests: number;
	readonly planned: number;
	readonly migrated: number;
	readonly alreadyGzip: number;
	readonly failures: readonly string[];
}

function walkManifests(directory: string, paths: string[]): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) walkManifests(path, paths);
		else if (entry.isFile() && entry.name === "manifest.json") paths.push(path);
	}
}

function safeOutputPath(bundleDir: string, outputPath: unknown): string | undefined {
	if (typeof outputPath !== "string" || !outputPath.endsWith(".jsonl") || outputPath.includes("\\") || outputPath.includes("/")) return undefined;
	const path = resolve(bundleDir, outputPath);
	return dirname(path) === resolve(bundleDir) ? path : undefined;
}

function manifestPaths(root: string): string[] {
	const paths: string[] = [];
	for (const name of ["registry", "staging"]) {
		const directory = join(root, name);
		if (existsSync(directory)) walkManifests(directory, paths);
	}
	return paths.sort();
}

/**
 * Converts only JSONL outputs declared by completed Machine Facts manifests.
 * Index files are intentionally outside this contract and are not visited.
 */
export function migrateMachineFactsJsonl(options: JsonlGzipMigrationOptions): JsonlGzipMigrationResult {
	const root = resolve(options.root);
	const failures: string[] = [];
	let planned = 0;
	let migrated = 0;
	let alreadyGzip = 0;
	const manifests = manifestPaths(root);

	for (const manifestPath of manifests) {
		const bundleDir = dirname(manifestPath);
		let manifest: { outputs?: unknown };
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { outputs?: unknown };
		} catch (error) {
			failures.push(`INVALID_MANIFEST:${relative(root, manifestPath)}:${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!Array.isArray(manifest.outputs)) {
			failures.push(`MANIFEST_OUTPUTS_MISSING:${relative(root, manifestPath)}`);
			continue;
		}
		for (const output of manifest.outputs as ManifestOutput[]) {
			const logicalPath = safeOutputPath(bundleDir, output.path);
			if (!logicalPath) continue;
			const displayPath = relative(root, logicalPath).split(sep).join("/");
			const store = inspectJsonlStore(logicalPath);
			if (store.status === "GZIP") {
				alreadyGzip += 1;
				continue;
			}
			if (store.status !== "LEGACY_PLAIN") {
				failures.push(`${store.status}_OUTPUT:${displayPath}`);
				continue;
			}
			if (typeof output.content_sha256 !== "string") {
				failures.push(`OUTPUT_HASH_MISSING:${displayPath}`);
				continue;
			}
			const plain = readFileSync(logicalPath);
			if (sha256(plain) !== output.content_sha256) {
				failures.push(`OUTPUT_HASH_MISMATCH:${displayPath}`);
				continue;
			}
			planned += 1;
			if (!options.apply) continue;
			const gzipPath = gzipJsonlPath(logicalPath);
			const temporaryPath = `${gzipPath}.migration-tmp`;
			try {
				writeFileSync(temporaryPath, gzipCanonicalBytes(plain));
				const verified = decodeJsonlStoreBytes(readFileSync(temporaryPath));
				if (sha256(verified) !== output.content_sha256) throw new Error("COMPRESSED_HASH_MISMATCH");
				renameSync(temporaryPath, gzipPath);
				unlinkSync(logicalPath);
				migrated += 1;
			} catch (error) {
				if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
				failures.push(`MIGRATION_FAILED:${displayPath}:${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return { manifests: manifests.length, planned, migrated, alreadyGzip, failures };
}

function option(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const root = option(args, "--root");
	if (!root) throw new Error("usage: migrate-machine-facts-jsonl-gzip --root <facts-root> [--apply]");
	console.log(JSON.stringify(migrateMachineFactsJsonl({ root, apply: args.includes("--apply") }), null, 2));
}
