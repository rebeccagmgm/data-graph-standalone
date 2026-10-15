import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { canonicalJson, sha256 } from "../machine-facts/machine-facts-contract.ts";
import { loadMachineFactsIndex } from "../machine-facts/machine-facts-index-reader.ts";
import {
	hashJsonlStore,
	inspectJsonlStore,
	jsonlStoreExists,
	readJsonlRecords,
} from "../machine-facts/jsonl-store.ts";

export type CurrentBundleState = "CURRENT_L1" | "LEGACY_NOT_L1" | "STALE" | "INVALID";
export type JsonRecord = Record<string, any>;

export interface CurrentBundleLoad {
	readonly state: CurrentBundleState;
	readonly factsRoot: string;
	readonly taskId: string;
	readonly bundleDir: string;
	readonly indexPath: string;
	readonly indexRow?: JsonRecord;
	readonly indexSha256?: string;
	readonly statusPath: string;
	readonly status?: JsonRecord;
	readonly manifest?: JsonRecord;
	readonly manifestSha256?: string;
	readonly records: Readonly<Record<string, JsonRecord[]>>;
	readonly evidence: Readonly<Record<string, string>>;
	readonly issues: readonly string[];
}

const REQUIRED_L1_FILES = [
	"statements.jsonl",
	"dataset-io.jsonl",
	"relation-nodes.jsonl",
	"relation-edges.jsonl",
	"field-expression-nodes.jsonl",
	"column-lineage-edges.jsonl",
	"output-field-bindings.jsonl",
	"task-local-materializations.jsonl",
	"unknowns.jsonl",
	"schema-refs.jsonl",
	"capability-summary.json",
];
const L1_CONTRACT_VERSIONS = new Set(["2.0.0"]);
const LEGACY_CONTRACT_VERSIONS = new Set(["1.3.0"]);
const TASK_SCOPED_OUTPUTS = new Set([
	"statements.jsonl",
	"dataset-io.jsonl",
	"relation-nodes.jsonl",
	"relation-edges.jsonl",
	"field-expression-nodes.jsonl",
	"column-lineage-edges.jsonl",
	"output-field-bindings.jsonl",
	"unknowns.jsonl",
]);

function json(path: string): JsonRecord {
	return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

function jsonl(path: string): JsonRecord[] {
	if (!jsonlStoreExists(path)) return [];
	return readJsonlRecords(path);
}

function bundleJsonlExists(bundleDir: string, file: string): boolean {
	return jsonlStoreExists(join(bundleDir, file));
}

function bundleOutputExists(bundleDir: string, file: string): boolean {
	return file.endsWith(".jsonl") ? bundleJsonlExists(bundleDir, file) : existsSync(join(bundleDir, file));
}

function safeTaskId(taskId: string): boolean {
	return (
		/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(taskId) &&
		!/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i.test(taskId)
	);
}

function safeRelativePath(root: string, value: unknown): string | undefined {
	if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("..")) return undefined;
	const resolved = resolve(root, value);
	const actual = relative(root, resolved).replaceAll("\\", "/");
	return actual === value.replaceAll("\\", "/") ? resolved : undefined;
}

function realPathContained(root: string, target: string): boolean {
	try {
		const rootReal = realpathSync.native(root);
		const targetReal = realpathSync.native(target);
		const escaped = relative(rootReal, targetReal);
		return escaped === "" || (!escaped.startsWith("..") && !isAbsolute(escaped));
	} catch {
		return false;
	}
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validSpan(span: unknown, sqlLength: number, statementSpan?: JsonRecord): span is JsonRecord {
	if (!span || typeof span !== "object") return false;
	const start = (span as JsonRecord).start;
	const end = (span as JsonRecord).end;
	return (
		typeof start === "number" &&
		typeof end === "number" &&
		Number.isInteger(start) &&
		Number.isInteger(end) &&
		start >= 0 &&
		end >= start &&
		end <= sqlLength &&
		(!statementSpan || (start >= statementSpan.start && end <= statementSpan.end))
	);
}

function evidenceRef(factsRoot: string, path: string, lineNumber?: number): string {
	const relativePath = relative(factsRoot, path).replaceAll("\\", "/");
	return `machine-facts:${relativePath}${lineNumber === undefined ? "" : `#L${lineNumber}`}`;
}

type IndexSnapshot = {
	readonly byTaskId: ReadonlyMap<string, JsonRecord> | null;
	readonly indexSha256?: string;
	readonly error?: string;
};

type CurrentBundleReadContext = {
	index?: IndexSnapshot;
	readonly loads: Map<string, CurrentBundleLoad>;
	readonly requestedFiles?: ReadonlySet<string>;
	readonly validateOutputHashes: "all" | "requested";
};

export interface CurrentTaskBundleReaderOptions {
	/** Batch publishers reuse the index but release each task's records after use. */
	readonly cacheLoads?: boolean;
	readonly requestedFiles?: readonly string[];
	readonly validateOutputHashes?: "all" | "requested";
}

export interface CurrentTaskBundleReader {
	readonly load: (taskId: string) => CurrentBundleLoad;
}

function readIndexSnapshot(indexPath: string): IndexSnapshot {
	try {
		const snapshot = loadMachineFactsIndex(resolve(indexPath, "..", ".."));
		return { byTaskId: snapshot.byTaskId, indexSha256: snapshot.sha256 };
	} catch (error) {
		return { byTaskId: null, error: `CURRENT_INDEX_INVALID:${error instanceof Error ? error.message : String(error)}` };
	}
}

function issueResult(
	factsRoot: string,
	taskId: string,
	indexPath: string,
	issues: readonly string[],
	state: CurrentBundleState = "INVALID",
	partial: Partial<CurrentBundleLoad> = {},
): CurrentBundleLoad {
	return {
		state,
		factsRoot,
		taskId,
		bundleDir: partial.bundleDir ?? join(factsRoot, "registry", "tasks", taskId, "bundle"),
		indexPath,
		indexRow: partial.indexRow,
		indexSha256: partial.indexSha256,
		statusPath: partial.statusPath ?? join(factsRoot, "registry", "tasks", taskId, "analysis-status.json"),
		status: partial.status,
		manifest: partial.manifest,
		manifestSha256: partial.manifestSha256,
		records: partial.records ?? {},
		evidence: partial.evidence ?? {},
		issues,
	};
}

/**
 * The only reader boundary allowed to expose a task bundle to a Consumer.
 * It validates the Current Index -> status -> manifest -> output hash chain and
 * never discovers tasks by scanning registry directories.
 */
function loadCurrentTaskBundleWithContext(
	factsRootInput: string,
	taskId: string,
	context?: CurrentBundleReadContext,
): CurrentBundleLoad {
	const factsRoot = resolve(factsRootInput);
	const indexPath = join(factsRoot, "indexes", "task-fact-index.jsonl");
	if (!safeTaskId(taskId)) return issueResult(factsRoot, taskId, indexPath, ["UNSAFE_TASK_ID"]);
	if (!existsSync(indexPath)) return issueResult(factsRoot, taskId, indexPath, ["CURRENT_INDEX_MISSING"]);

	const snapshot = context?.index ?? readIndexSnapshot(indexPath);
	if (context && context.index === undefined) context.index = snapshot;
	if (snapshot.byTaskId === null) return issueResult(factsRoot, taskId, indexPath, [snapshot.error ?? "CURRENT_INDEX_INVALID"]);
	const indexRow = snapshot.byTaskId.get(taskId);
	const indexSha256 = snapshot.indexSha256;
	if (!indexRow) return issueResult(factsRoot, taskId, indexPath, ["TASK_NOT_INDEXED"], "STALE", { indexSha256 });
	if (indexRow.status !== "SUCCESS")
		return issueResult(factsRoot, taskId, indexPath, ["INDEX_ROW_NOT_SUCCESS"], "STALE", { indexRow, indexSha256 });
	const expectedBundle = join(factsRoot, "registry", "tasks", taskId, "bundle");
	const bundleDir = safeRelativePath(factsRoot, indexRow.bundle_path);
	if (!bundleDir || resolve(bundleDir) !== resolve(expectedBundle)) {
		return issueResult(factsRoot, taskId, indexPath, ["INDEX_BUNDLE_PATH_UNSAFE_OR_UNEXPECTED"], "INVALID", {
			indexRow,
			indexSha256,
		});
	}
	const statusPath = join(factsRoot, "registry", "tasks", taskId, "analysis-status.json");
	const manifestPath = join(bundleDir, "manifest.json");
	if (
		!existsSync(bundleDir) ||
		!realPathContained(factsRoot, bundleDir) ||
		!existsSync(statusPath) ||
		!realPathContained(factsRoot, statusPath) ||
		!existsSync(manifestPath) ||
		!realPathContained(bundleDir, manifestPath)
	) {
		return issueResult(factsRoot, taskId, indexPath, ["STATUS_OR_MANIFEST_MISSING"], "STALE", {
			indexRow,
			indexSha256,
			bundleDir,
		});
	}

	let status: JsonRecord;
	let manifest: JsonRecord;
	try {
		status = json(statusPath);
		manifest = json(manifestPath);
	} catch (error) {
		return issueResult(
			factsRoot,
			taskId,
			indexPath,
			[`STATUS_OR_MANIFEST_INVALID:${error instanceof Error ? error.message : String(error)}`],
			"INVALID",
			{ indexRow, indexSha256, bundleDir },
		);
	}
	const manifestSha256 = sha256(readFileSync(manifestPath));
	const staleIssues: string[] = [];
	if (status.state !== "SUCCESS") staleIssues.push("ANALYSIS_NOT_SUCCESS");
	if (
		status.task_id !== taskId ||
		manifest.task_id !== taskId ||
		indexRow.logical_source_id !== manifest.logical_source_id ||
		status.logical_source_id !== manifest.logical_source_id
	) {
		staleIssues.push("TASK_IDENTITY_MISMATCH");
	}
	if (indexRow.manifest_sha256 !== manifestSha256 || status.current_manifest_sha256 !== manifestSha256)
		staleIssues.push("MANIFEST_HASH_MISMATCH");
	if (
		indexRow.sql_sha256 !== manifest.inputs?.sql_sha256 ||
		status.requested?.sql_sha256 !== manifest.inputs?.sql_sha256
	)
		staleIssues.push("SQL_HASH_MISMATCH");
	if (status.requested?.schema_bundle_sha256 !== manifest.inputs?.schema_bundle_sha256)
		staleIssues.push("SCHEMA_HASH_MISMATCH");
	if (status.requested?.analysis_config_sha256 !== manifest.inputs?.analysis_config_sha256)
		staleIssues.push("ANALYSIS_CONFIG_HASH_MISMATCH");
	if (status.requested?.dialect !== manifest.method?.dialect) staleIssues.push("DIALECT_MISMATCH");
	if (staleIssues.length > 0)
		return issueResult(factsRoot, taskId, indexPath, staleIssues, "STALE", {
			indexRow,
			indexSha256,
			status,
			manifest,
			manifestSha256,
			bundleDir,
		});

	const contractVersion = String(manifest.schema_version ?? "");
	const isL1 = L1_CONTRACT_VERSIONS.has(contractVersion);
	const isLegacy = LEGACY_CONTRACT_VERSIONS.has(contractVersion);
	const integrityIssues: string[] = [];
	if (!isL1 && !isLegacy) integrityIssues.push(`UNSUPPORTED_CONTRACT_VERSION:${contractVersion || "MISSING"}`);
	if (!isSha256(indexRow.sql_sha256) || !isSha256(indexRow.manifest_sha256))
		integrityIssues.push("INDEX_HASH_INVALID");
	if (
		!isSha256(manifest.inputs?.sql_sha256) ||
		!isSha256(manifest.inputs?.schema_bundle_sha256) ||
		!isSha256(manifest.inputs?.analysis_config_sha256)
	)
		integrityIssues.push("MANIFEST_INPUT_HASH_INVALID");
	if (
		typeof manifest.task_id !== "string" ||
		typeof manifest.logical_source_id !== "string" ||
		typeof manifest.method?.dialect !== "string"
	)
		integrityIssues.push("MANIFEST_IDENTITY_INVALID");
	if (!Array.isArray(manifest.outputs) || manifest.outputs.length === 0)
		integrityIssues.push("MANIFEST_OUTPUTS_INVALID");
	const sqlSnapshotPath = safeRelativePath(factsRoot, manifest.inputs?.sql_snapshot);
	const schemaSnapshotPath = safeRelativePath(factsRoot, manifest.inputs?.schema_snapshot);
	if (!sqlSnapshotPath || !existsSync(sqlSnapshotPath) || !realPathContained(factsRoot, sqlSnapshotPath))
		integrityIssues.push("SQL_SNAPSHOT_MISSING_OR_UNSAFE");
	else if (sha256(readFileSync(sqlSnapshotPath)) !== manifest.inputs?.sql_sha256)
		integrityIssues.push("SQL_SNAPSHOT_HASH_MISMATCH");
	if (!schemaSnapshotPath || !existsSync(schemaSnapshotPath) || !realPathContained(factsRoot, schemaSnapshotPath))
		integrityIssues.push("SCHEMA_SNAPSHOT_MISSING_OR_UNSAFE");
	else if (sha256(readFileSync(schemaSnapshotPath)) !== manifest.inputs?.schema_bundle_sha256)
		integrityIssues.push("SCHEMA_SNAPSHOT_HASH_MISMATCH");
	const outputRecords = Array.isArray(manifest.outputs) ? manifest.outputs : [];
	const requestedFiles = context?.requestedFiles;
	if (requestedFiles) {
		for (const file of requestedFiles) {
			if (!outputRecords.some((output) => output && output.path === file)) integrityIssues.push(`REQUESTED_OUTPUT_NOT_DECLARED:${file}`);
			if (!bundleOutputExists(bundleDir, file)) integrityIssues.push(`REQUESTED_OUTPUT_MISSING:${file}`);
		}
	}
	const outputPaths = new Set<string>();
	for (const output of outputRecords) {
		if (!output || typeof output !== "object" || typeof output.path !== "string" || outputPaths.has(output.path)) {
			integrityIssues.push(`OUTPUT_DESCRIPTOR_INVALID_OR_DUPLICATE:${String(output?.path)}`);
			continue;
		}
		outputPaths.add(output.path);
		if (!isSha256(output.content_sha256) || !Number.isInteger(output.row_count) || output.row_count < 0)
			integrityIssues.push(`OUTPUT_DESCRIPTOR_INVALID:${output.path}`);
	}
	if (isL1)
		for (const required of REQUIRED_L1_FILES) {
			if (!outputPaths.has(required)) integrityIssues.push(`L1_REQUIRED_OUTPUT_NOT_DECLARED:${required}`);
			if (!bundleOutputExists(bundleDir, required)) integrityIssues.push(`L1_REQUIRED_OUTPUT_MISSING:${required}`);
		}
	for (const output of outputRecords) {
		const outputPath = safeRelativePath(bundleDir, output.path);
		if (!outputPath) {
			integrityIssues.push(`OUTPUT_MISSING:${String(output.path)}`);
			continue;
		}
		const fileName = String(output.path);
		if (fileName.endsWith(".jsonl")) {
			const stored = inspectJsonlStore(outputPath);
			if (stored.status === "CONFLICT") {
				integrityIssues.push(`OUTPUT_JSONL_STORE_CONFLICT:${fileName}`);
				continue;
			}
			if (stored.status === "MISSING" || !realPathContained(bundleDir, stored.path)) {
				integrityIssues.push(`OUTPUT_MISSING:${fileName}`);
				continue;
			}
			if (context?.validateOutputHashes !== "requested" || requestedFiles?.has(fileName)) {
				if (hashJsonlStore(outputPath) !== output.content_sha256)
					integrityIssues.push(`OUTPUT_HASH_MISMATCH:${fileName}`);
			}
			continue;
		}
		if (!existsSync(outputPath) || !realPathContained(bundleDir, outputPath)) {
			integrityIssues.push(`OUTPUT_MISSING:${fileName}`);
			continue;
		}
		if (context?.validateOutputHashes !== "requested" || requestedFiles?.has(fileName)) {
			if (sha256(readFileSync(outputPath)) !== output.content_sha256)
				integrityIssues.push(`OUTPUT_HASH_MISMATCH:${fileName}`);
		}
	}
	const sourceArtifactPath = join(bundleDir, "source-artifact.json");
	if (!existsSync(sourceArtifactPath) || !realPathContained(bundleDir, sourceArtifactPath))
		integrityIssues.push("SOURCE_ARTIFACT_MISSING");
	else {
		try {
			const sourceArtifact = json(sourceArtifactPath);
			if (
				sourceArtifact.task_id !== taskId ||
				sourceArtifact.logical_source_id !== manifest.logical_source_id ||
				sourceArtifact.sql_sha256 !== manifest.inputs?.sql_sha256 ||
				sourceArtifact.sql_snapshot !== manifest.inputs?.sql_snapshot
			)
				integrityIssues.push("SOURCE_ARTIFACT_IDENTITY_MISMATCH");
		} catch (error) {
			integrityIssues.push(`SOURCE_ARTIFACT_INVALID:${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const parsedJsonl = new Map<string, JsonRecord[]>();
	for (const output of outputRecords) {
		const outputPath = safeRelativePath(bundleDir, output.path);
		if (
			!outputPath ||
			!String(output.path).endsWith(".jsonl") ||
			(requestedFiles && !requestedFiles.has(String(output.path)))
		)
			continue;
		if (!jsonlStoreExists(outputPath)) continue;
		try {
			const rows = jsonl(outputPath);
			parsedJsonl.set(String(output.path), rows);
			if (Number.isInteger(output.row_count) && rows.length !== output.row_count)
				integrityIssues.push(`OUTPUT_ROW_COUNT_MISMATCH:${String(output.path)}`);
			for (const row of rows) {
				if (TASK_SCOPED_OUTPUTS.has(String(output.path)) && typeof row.task_id !== "string")
					integrityIssues.push(`OUTPUT_TASK_ID_MISSING:${String(output.path)}`);
				else if (typeof row.task_id === "string" && row.task_id !== taskId)
					integrityIssues.push(`OUTPUT_TASK_ID_MISMATCH:${String(output.path)}`);
			}
		} catch (error) {
			integrityIssues.push(
				`OUTPUT_JSONL_INVALID:${String(output.path)}:${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (sqlSnapshotPath && existsSync(sqlSnapshotPath)) {
		const sqlText = readFileSync(sqlSnapshotPath, "utf8");
		const statementSpans = new Map(
			(parsedJsonl.get("statements.jsonl") ?? []).map((statement) => [statement.statement_id, statement.span]),
		);
		for (const statement of parsedJsonl.get("statements.jsonl") ?? []) {
			const span = statement.span;
			if (
				!span ||
				typeof span.start !== "number" ||
				typeof span.end !== "number" ||
				!Number.isInteger(span.start) ||
				!Number.isInteger(span.end) ||
				span.start < 0 ||
				span.end < span.start ||
				span.end > sqlText.length ||
				typeof statement.raw_sql !== "string" ||
				sqlText.slice(span.start, span.end) !== statement.raw_sql
			)
				integrityIssues.push(`STATEMENT_SPAN_UNTRACEABLE:${String(statement.statement_id)}`);
		}
		for (const [file, spanField] of [
			["field-expression-nodes.jsonl", "source_span"],
			["relation-nodes.jsonl", "source_span"],
			["relation-edges.jsonl", "source_span"],
		] as const)
			for (const record of parsedJsonl.get(file) ?? [])
				if (!validSpan(record[spanField], sqlText.length, statementSpans.get(record.statement_id)))
					integrityIssues.push(
						`RECORD_SPAN_UNTRACEABLE:${file}:${String(record.expression_id ?? record.relation_id ?? record.edge_id)}`,
					);
	}
	if (integrityIssues.length > 0)
		return issueResult(factsRoot, taskId, indexPath, integrityIssues, "INVALID", {
			indexRow,
			indexSha256,
			status,
			manifest,
			manifestSha256,
			bundleDir,
		});

	const declaredFiles = outputRecords.map((output) => String(output.path));
	const files = requestedFiles
		? [...requestedFiles]
		: isL1
		? [...new Set([
				...REQUIRED_L1_FILES.filter((file) => file !== "capability-summary.json" || existsSync(join(bundleDir, file))),
				...declaredFiles,
			])]
		: declaredFiles;
	const records: Record<string, JsonRecord[]> = {};
	const evidence: Record<string, string> = {};
	try {
		for (const file of [...new Set(files)].sort()) {
			const path = join(bundleDir, file);
			if (!bundleOutputExists(bundleDir, file)) continue;
			records[file] = file.endsWith(".jsonl")
				? parsedJsonl.get(file) ?? []
				: [json(path)];
			evidence[file] = evidenceRef(factsRoot, path);
		}
	} catch (error) {
		return issueResult(
			factsRoot,
			taskId,
			indexPath,
			[`OUTPUT_CONTENT_INVALID:${error instanceof Error ? error.message : String(error)}`],
			"INVALID",
			{
				indexRow,
				indexSha256,
				status,
				statusPath,
				manifest,
				manifestSha256,
				bundleDir,
			},
		);
	}
	evidence["manifest.json"] = evidenceRef(factsRoot, manifestPath);
	const state: CurrentBundleState = isL1 ? "CURRENT_L1" : "LEGACY_NOT_L1";
	return {
		state,
		factsRoot,
		taskId,
		bundleDir,
		indexPath,
		indexRow,
		indexSha256,
		status,
		statusPath,
		manifest,
		manifestSha256,
		records,
		evidence,
		issues: [],
	};
}

export function createCurrentTaskBundleReader(
	factsRootInput: string,
	options: CurrentTaskBundleReaderOptions = {},
): CurrentTaskBundleReader {
	const factsRoot = resolve(factsRootInput);
	const requestedFiles = options.requestedFiles ? new Set(options.requestedFiles) : undefined;
	const context: CurrentBundleReadContext = {
		loads: new Map(),
		requestedFiles,
		validateOutputHashes: options.validateOutputHashes ?? (requestedFiles ? "requested" : "all"),
	};
	return {
		load: (taskId: string): CurrentBundleLoad => {
			const cached = context.loads.get(taskId);
			if (cached) return cached;
			const loaded = loadCurrentTaskBundleWithContext(factsRoot, taskId, context);
			if (options.cacheLoads !== false) context.loads.set(taskId, loaded);
			return loaded;
		},
	};
}

export function loadCurrentTaskBundle(factsRootInput: string, taskId: string): CurrentBundleLoad {
	return loadCurrentTaskBundleWithContext(factsRootInput, taskId);
}

export function canonicalBundleIdentity(load: CurrentBundleLoad): string {
	return sha256(
		canonicalJson({
			task_id: load.taskId,
			manifest_sha256: load.manifestSha256 ?? null,
			index_sha256: load.indexSha256 ?? null,
			state: load.state,
		}),
	);
}
