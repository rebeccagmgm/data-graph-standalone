import { resolveWorkspacePaths } from "../config/workspace-paths.ts";
import { verifiedWriteColumns } from "../input/shared/write-column-evidence.ts";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { Schema, SqlSession, type SchemaMapping } from "sqllens";

import {
	sha256File,
	validateTableDocument,
	validateTaskDocument,
	type SqlSlot,
	type TableEvidence,
	type TableDocument,
	type TaskPartitionAssignment,
	type TaskPartitionEvidence,
	type TaskPartitionEvidenceRef,
	type TaskDocument,
	type TaskSchedulerEvidence,
} from "../input/shared/input-pack.ts";
import { buildTaskPartitionEvidence } from "../input/shared/task-partition-evidence.ts";
import { extractSqlWrites } from "../evidence/sql-write-evidence.ts";
import { createTableLikeSource, parseDdlSchema, readCreateTableHeader } from "../plans/ddl-schema.ts";
import { buildPlanFacts } from "../plans/plan-adapter.ts";
import { taskSqlDialect } from "../plans/task-sql-dialect.ts";
import { loadStandardizedInput } from "../input/shared/standardized-sql.ts";
import { normalizeRepeatedSqlForAnalysis } from "../input/shared/sql-analysis-normalization.ts";
import { extractSqlReadTableNames } from "../input/shared/sql-table-references.ts";
import { controlledTaskEndpointPlatform } from "../input/shared/task-endpoints.ts";
import {
	canonicalJson,
	normalizeName,
	safeSegment,
	sha256,
	type GenericAnalysisProfile,
	type GenericTaskProfile,
	type InputPackProvenance,
	type PlatformPartitionAssignment,
	type PlatformTargetQueryOutput,
	type SqlWritePartitionEvidence,
} from "./machine-facts-contract.ts";
import {
	refreshMachineFactsIndex,
	runTask,
	type MachineFactsIndexMode,
	type ProfileRunResult,
	type TaskRunResult,
} from "./machine-facts.ts";
import {
	defaultWriterCatalogPath,
	openWriterCatalog,
	syncWriterCatalogAfterMachineFacts,
} from "../query/writer-catalog.ts";
import {
	inferTaskDefaultSchema,
	qualifyBareTableName,
	type TaskDefaultSchema,
} from "../reconcile/shared/task-default-schema.ts";

type JsonRecord = Record<string, unknown>;

export interface PhysicalTableCatalogEntry {
	readonly platform: string;
	readonly dataSource: string;
	readonly stableTableId: string;
	readonly qualifiedName: string;
	readonly guid: string | null;
	readonly partitionFields: readonly string[] | null;
	readonly columns: readonly string[];
	readonly tablePath: string;
	readonly ddlPath: string;
	readonly tableContentHash: string;
	readonly ddlSha256: string;
}

export interface PhysicalTableCatalog {
	readonly entries: readonly PhysicalTableCatalogEntry[];
	readonly issues: readonly string[];
	readonly byPhysicalKey: ReadonlyMap<string, PhysicalTableCatalogEntry>;
	readonly byQualifiedName: ReadonlyMap<string, readonly PhysicalTableCatalogEntry[]>;
	readonly byNameTail: ReadonlyMap<string, readonly PhysicalTableCatalogEntry[]>;
}

export interface PhysicalTableCatalogOptions {
	readonly lazyDdl?: boolean;
	readonly references?: PhysicalTableCatalogReferences;
}

export interface PhysicalTableCatalogReferences {
	readonly physicalKeys?: readonly string[];
	readonly qualifiedNames?: readonly string[];
	readonly nameTails?: readonly string[];
}

export interface SelectedLineageSql {
	readonly slot: string;
	readonly path: string;
	readonly locator: string;
	readonly sha256: string;
	readonly content: string;
	readonly analysisContent: string;
	readonly analysisSha256: string;
	readonly evidenceProvider: string;
}

export interface PreparedInputPackTask {
	readonly standardizedArtifact?: { readonly bytes: string; readonly sha256: string };
	readonly taskId: string;
	readonly taskName: string | null;
	readonly taskCategory: string;
	readonly taskPath: string;
	readonly task: TaskDocument & JsonRecord;
	readonly target: PhysicalTableCatalogEntry;
	readonly sql: SelectedLineageSql;
	readonly sqlSources: readonly SelectedLineageSql[];
	readonly sqlSegments: readonly { readonly slot: string; readonly start: number; readonly end: number }[];
	readonly dialect: "databricks" | "duckdb";
	readonly logicalSourceId: string;
	readonly schemaBundle: JsonRecord;
	readonly schemaBundleHash: string;
	readonly profileTask: GenericTaskProfile;
	readonly provenance: InputPackProvenance;
	readonly inputHashes: ReadonlyMap<string, string>;
}

export interface PrepareInputPackTaskOptions {
  readonly standardizedInput?: boolean;
	readonly dataRoot: string;
	readonly taskId: string;
	readonly taskPath?: string;
	readonly tableCatalog?: PhysicalTableCatalog;
	readonly ddlCache?: Map<string, string>;
	readonly beforeFinalVerification?: () => void;
}

export interface RunInputPackMachineFactsOptions {
  readonly standardizedInput?: boolean;
	readonly dataRoot: string;
	readonly taskIds: readonly string[];
	readonly outputRoot: string;
	readonly tableCatalog?: PhysicalTableCatalog;
	readonly taskPathIndex?: ReadonlyMap<string, readonly string[]>;
	/** Defaults to auto: incrementally refresh a healthy index, otherwise rebuild once. */
	readonly indexMode?: MachineFactsIndexMode;
	readonly beforeFinalVerification?: (taskId: string) => void;
	/** SQLite writer catalog path; defaults to sibling of data root. Pass null to disable. */
	readonly writerCatalogPath?: string | null;
	readonly noWriterCatalog?: boolean;
}

export interface InputPackMachineFactsRunResult {
	readonly output_root: string;
	readonly tasks: readonly TaskRunResult[];
	readonly index: ProfileRunResult["index"];
	readonly timings: {
		readonly index_ms: number;
		readonly index_mode: "full" | "incremental";
		readonly index_requested_mode: MachineFactsIndexMode;
		readonly index_verification_scope: "FULL" | "STRUCTURAL_ONLY";
		readonly index_fallback_reason?: "INDEX_MISSING" | "INDEX_UNREADABLE" | "INDEX_INVALID";
	};
	readonly prepared: readonly {
		readonly taskId: string;
		readonly sqlSlot: string;
		readonly target: string;
		readonly taskContentHash: string;
		readonly tableContentHash: string;
	}[];
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function asRecord(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function nonEmpty(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" || trimmed === "-" ? null : trimmed;
}

function normalizeToken(value: string): string {
	return value.trim().toLowerCase();
}

export function physicalTableKey(value: Pick<PhysicalTableCatalogEntry, "platform" | "dataSource" | "qualifiedName">): string {
	return `${normalizeToken(value.platform)}|${normalizeToken(value.dataSource)}|${normalizeName(value.qualifiedName)}`;
}

function relativeLocator(dataRoot: string, path: string): string {
	return relative(dataRoot, path).replaceAll("\\", "/");
}

function isWithin(root: string, path: string): boolean {
	const relation = relative(resolve(root), resolve(path));
	return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function discoverNamedFiles(root: string, name: string): string[] {
	if (!existsSync(root)) return [];
	const result: string[] = [];
	const visit = (directory: string): void => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			// Parent listing can race with deletes / missing dirs on large trees.
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name === name) result.push(path);
		}
	};
	visit(resolve(root));
	return result.sort(compareText);
}

const taskInputPackIndexCache = new Map<string, ReadonlyMap<string, readonly string[]>>();

export function indexTaskInputPacks(dataRootInput: string): ReadonlyMap<string, readonly string[]> {
	const dataRoot = resolve(dataRootInput);
	const cached = taskInputPackIndexCache.get(dataRoot);
	if (cached) return cached;
	const grouped = new Map<string, string[]>();
	for (const taskPath of discoverNamedFiles(join(dataRoot, "tasks"), "task.json")) {
		const taskId = basename(dirname(taskPath));
		const paths = grouped.get(taskId) ?? [];
		paths.push(taskPath);
		grouped.set(taskId, paths);
	}
	const indexed = new Map(
		[...grouped.entries()].map(([taskId, paths]) => [taskId, [...paths].sort(compareText)] as const),
	);
	taskInputPackIndexCache.set(dataRoot, indexed);
	return indexed;
}

export function locateTaskInputPacks(
	dataRootInput: string,
	taskIds: readonly string[],
): ReadonlyMap<string, readonly string[]> {
	const dataRoot = resolve(dataRootInput);
	const requested = [...new Set(taskIds.map((taskId) => taskId.trim()).filter(Boolean))].sort(compareText);
	const grouped = new Map<string, string[]>();
	for (const taskId of requested) grouped.set(taskId, []);
	const tasksRoot = join(dataRoot, "tasks");
	if (!existsSync(tasksRoot)) return grouped;
	const categories = readdirSync(tasksRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
		.map((entry) => entry.name)
		.sort(compareText);
	for (const category of categories) {
		for (const taskId of requested) {
			const taskPath = join(tasksRoot, category, taskId, "task.json");
			if (existsSync(taskPath)) grouped.get(taskId)?.push(taskPath);
		}
	}
	return new Map(
		[...grouped.entries()].map(([taskId, paths]) => [taskId, [...paths].sort(compareText)] as const),
	);
}

function collectTableReferencesFromSql(
	references: PhysicalTableCatalogReferences,
	qualifiedName: string,
): void {
	const normalized = normalizeName(qualifiedName);
	if (!normalized) return;
	(references.qualifiedNames as string[]).push(normalized);
	(references.nameTails as string[]).push(normalized.split(".").at(-1) ?? normalized);
}

function collectTableReferencesFromEndpoint(
	references: PhysicalTableCatalogReferences,
	endpoint: unknown,
): void {
	const record = asRecord(endpoint);
	const platform = nonEmpty(record?.platform);
	const dataSource = nonEmpty(record?.dataSource);
	const qualifiedName = nonEmpty(record?.qualifiedName);
	if (platform && dataSource && qualifiedName) {
		const normalizedQualified = normalizeName(qualifiedName);
		(references.physicalKeys as string[]).push(
			physicalTableKey({ platform, dataSource, qualifiedName: normalizedQualified }),
		);
		collectTableReferencesFromSql(references, normalizedQualified);
		return;
	}
	if (typeof endpoint === "string" && endpoint.trim()) collectTableReferencesFromSql(references, endpoint);
}

export function collectTaskTableReferences(
	dataRootInput: string,
	taskPaths: readonly string[],
): PhysicalTableCatalogReferences {
	const dataRoot = resolve(dataRootInput);
	const references: PhysicalTableCatalogReferences = {
		physicalKeys: [],
		qualifiedNames: [],
		nameTails: [],
	};
	for (const taskPath of taskPaths) {
		try {
			const taskRaw: unknown = JSON.parse(readFileSync(taskPath, "utf8"));
			validateTaskDocument(taskRaw);
			const task = taskRaw as TaskDocument & JsonRecord;
			collectTableReferencesFromEndpoint(references, task.source);
			collectTableReferencesFromEndpoint(references, task.target);
			try {
				const selected = selectLineageSql(dataRoot, taskPath, task);
				for (const source of selected.sources) {
					for (const name of extractSqlReadTableNames(source.analysisContent))
						collectTableReferencesFromSql(references, name);
					for (const write of extractSqlWrites(source.content))
						collectTableReferencesFromSql(references, write.qualifiedName);
					try {
						const session = SqlSession.create(source.analysisContent, taskSqlDialect(String(task.taskCategory)));
						for (const [statementIndex, cell] of session.doc.statements.entries()) {
							const plan = buildPlanFacts(cell, source.analysisContent, {
								statement_index: statementIndex,
								dialect: taskSqlDialect(String(task.taskCategory)),
								include_expression_dependencies: false,
							});
							for (const name of plan.physical_inputs) collectTableReferencesFromSql(references, name);
						}
					} catch {
						// Keep conservative text references when a source cannot be parsed.
					}
				}
			} catch {
				// Keep direct endpoint references even when SQL selection later fails.
			}
		} catch {
			// Preparation will fail later with the authoritative error.
		}
	}
	return {
		physicalKeys: [...new Set(references.physicalKeys ?? [])].sort(compareText),
		qualifiedNames: [...new Set(references.qualifiedNames ?? [])].sort(compareText),
		nameTails: [...new Set(references.nameTails ?? [])].sort(compareText),
	};
}

function verifiedFile(path: string, expectedHash: string, reason: string): Buffer {
	if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${reason}_MISSING:${path}`);
	const bytes = readFileSync(path);
	const actual = sha256(bytes);
	if (actual !== expectedHash) throw new Error(`${reason}_HASH_MISMATCH:${path}:expected=${expectedHash}:actual=${actual}`);
	return bytes;
}

function samePlatformToken(left: string, right: string): boolean {
	const a = normalizeToken(left);
	const b = normalizeToken(right);
	return a === b || ((a === "postgre" || a === "postgres") && (b === "postgre" || b === "postgres"));
}

function logicalSourceIdFor(platform: string, dataSource: string): string {
	const raw = `${normalizeToken(platform)}-${normalizeToken(dataSource)}`;
	const sanitized = raw.replace(/[^a-z0-9_.-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	if (!sanitized) throw new Error(`LOGICAL_SOURCE_ID_UNSAFE:${raw}`);
	return safeSegment(sanitized, "logical_source_id");
}

function resolveNamedTarget(
	task: TaskDocument & JsonRecord,
	catalog: PhysicalTableCatalog,
	name: string,
): { platform: string; dataSource: string; qualifiedName: string } {
	const qualified = normalizeName(name);
	const tail = normalizeName(name.split(".").at(-1) ?? name);
	const byQualified = catalog.byQualifiedName.get(qualified) ?? [];
	const byTail = catalog.byNameTail.get(tail) ?? [];
	const seen = new Map<string, PhysicalTableCatalogEntry>();
	for (const entry of [...byQualified, ...byTail]) {
		seen.set(physicalTableKey(entry), entry);
	}
	let candidates = [...seen.values()];
	const wantPlatform = controlledTaskEndpointPlatform(String(task.taskCategory ?? ""), "target");
	if (wantPlatform) {
		const filtered = candidates.filter((entry) => samePlatformToken(entry.platform, wantPlatform));
		if (filtered.length > 0) candidates = filtered;
	}
	const sourceName = nonEmpty(asRecord(task.source)?.qualifiedName);
	if (sourceName) {
		const notSource = candidates.filter(
			(entry) => normalizeName(entry.qualifiedName) !== normalizeName(sourceName),
		);
		if (notSource.length > 0) candidates = notSource;
	}
	if (candidates.length === 1) {
		const entry = candidates[0]!;
		return {
			platform: entry.platform,
			dataSource: entry.dataSource,
			qualifiedName: entry.qualifiedName,
		};
	}
	if (candidates.length === 0) {
		throw new Error(`TARGET_TABLE_PACK_MISSING:${task.taskId}:${name}`);
	}
	throw new Error(`TASK_TARGET_AMBIGUOUS:${task.taskId}:${name}`);
}

function targetRecord(
	task: TaskDocument & JsonRecord,
	catalog: PhysicalTableCatalog,
	sources: readonly SelectedLineageSql[],
	defaultSchema: TaskDefaultSchema | null,
): { platform: string; dataSource: string; qualifiedName: string } {
	const target = asRecord(task.target);
	const platform = nonEmpty(target?.platform);
	const dataSource = nonEmpty(target?.dataSource);
	const qualifiedName = nonEmpty(target?.qualifiedName);
	if (platform && dataSource && qualifiedName) {
		return { platform, dataSource, qualifiedName: normalizeName(qualifiedName) };
	}
	const name = typeof task.target === "string" ? task.target.trim() : qualifiedName;
	if (!name) return inferredSqlWriteAnchor(task, catalog, sources, defaultSchema);
	return resolveNamedTarget(task, catalog, name);
}

/**
 * Some scheduler task types have no target endpoint even though their SQL
 * contains physical writes.  The selected entry is only a schema anchor:
 * all SQL writes are still enumerated from the statements below.
 */
function inferredSqlWriteAnchor(
	task: TaskDocument & JsonRecord,
	catalog: PhysicalTableCatalog,
	sources: readonly SelectedLineageSql[],
	defaultSchema: TaskDefaultSchema | null,
): { platform: string; dataSource: string; qualifiedName: string } {
	const candidates = new Map<string, PhysicalTableCatalogEntry>();
	for (const source of sources) {
		for (const write of extractSqlWrites(source.content)) {
			const qualified = qualifyBareTableName(write.qualifiedName, defaultSchema);
			for (const entry of catalog.byQualifiedName.get(qualified) ?? [])
				candidates.set(physicalTableKey(entry), entry);
		}
	}
	if (candidates.size === 0) {
		for (const source of sources) {
			for (const name of createTableNames(source.content)) {
				const qualified = qualifyBareTableName(name, defaultSchema);
				for (const entry of catalog.byQualifiedName.get(qualified) ?? [])
					candidates.set(physicalTableKey(entry), entry);
			}
		}
	}
	let values = [...candidates.values()];
	const wantPlatform = controlledTaskEndpointPlatform(String(task.taskCategory ?? ""), "target");
	if (wantPlatform)
		values = values.filter((entry) => samePlatformToken(entry.platform, wantPlatform));
	// A missing scheduler target can be recovered only from one physical SQL
	// write identity.  Task-name similarity is not physical-identity evidence:
	// choosing among multiple writes could attach an unrelated target schema.
	if (values.length !== 1)
		throw new Error(`TASK_TARGET_PHYSICAL_IDENTITY_UNRESOLVED:${task.taskId}`);
	const entry = values[0]!;
	return {
		platform: entry.platform,
		dataSource: entry.dataSource,
		qualifiedName: entry.qualifiedName,
	};
}

function createTableNames(sql: string): readonly string[] {
	const names = new Set<string>();
	const pattern = /\bcreate\s+(?:(?:or\s+replace|external|temporary|temp)\s+)*table\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_$`".\[\]-]+)/gi;
	for (const match of sql.matchAll(pattern)) {
		if (match[1]) names.add(normalizeName(match[1].replaceAll("`", "").replaceAll('"', "").replaceAll("[", "").replaceAll("]", "")));
	}
	return [...names].sort(compareText);
}

function fieldProducingSql(sql: string): boolean {
	const normalized = sql.replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
	return (
		/^\s*(?:select|with)\b/i.test(normalized) ||
		/\binsert\s+(?:overwrite|into)\b[\s\S]*\bselect\b/i.test(normalized) ||
		/\bcreate\s+(?:(?:or\s+replace|external|temporary|temp)\s+)*table\b[\s\S]*\bas\s+(?:select|with)\b/i.test(normalized)
	);
}

export function selectLineageSql(
	dataRoot: string,
	taskPath: string,
	task: TaskDocument & JsonRecord,
): { selected: SelectedLineageSql; sources: readonly SelectedLineageSql[]; hashes: ReadonlyMap<string, string> } {
	const taskDirectory = dirname(taskPath);
	const sqlEntries = Array.isArray(task.sqlFiles) ? task.sqlFiles.map(asRecord).filter((item): item is JsonRecord => item !== null) : [];
	const loaded: SelectedLineageSql[] = [];
	const hashes = new Map<string, string>([[taskPath, sha256File(taskPath)]]);
	for (const entry of sqlEntries) {
		const slot = nonEmpty(entry.slot);
		const relativePath = nonEmpty(entry.path);
		const expectedHash = nonEmpty(entry.sha256);
		const evidenceProvider = nonEmpty(entry.evidenceProvider);
		if (!slot || !relativePath || !expectedHash || !evidenceProvider) throw new Error(`TASK_SQL_INDEX_INVALID:${task.taskId}`);
		const path = resolve(taskDirectory, relativePath);
		if (!isWithin(taskDirectory, path)) throw new Error(`TASK_SQL_PATH_UNSAFE:${relativePath}`);
		const bytes = verifiedFile(path, expectedHash, "TASK_SQL");
		hashes.set(path, expectedHash);
		const content = bytes.toString("utf8");
		const analysisContent = normalizeRepeatedSqlForAnalysis(content);
		loaded.push({
			slot,
			path,
			locator: relativeLocator(dataRoot, path),
			sha256: expectedHash,
			content,
			analysisContent,
			analysisSha256: sha256(Buffer.from(analysisContent, "utf8")),
			evidenceProvider,
		});
	}
	const query = loaded.filter((item) => item.slot === "query");
	if (query.length === 1) return { selected: query[0]!, sources: loaded, hashes };
	const candidates = loaded.filter((item) => fieldProducingSql(item.content));
	if (candidates.length === 0) {
		const ddl = loaded.filter((item) => createTableNames(item.content).length > 0);
		if (ddl.length === 1) return { selected: ddl[0]!, sources: loaded, hashes };
	}
	if (candidates.length !== 1)
		throw new Error(`SQL_SLOT_SELECTION_AMBIGUOUS:${task.taskId}:candidates=${candidates.map((item) => item.slot).sort(compareText).join(",") || "NONE"}`);
	return { selected: candidates[0]!, sources: loaded, hashes };
}

function qualifyCreateTableLikeSource(targetQualifiedName: string, likeSource: string): string {
	const source = normalizeName(likeSource);
	if (source.includes(".")) return source;
	const schema = targetQualifiedName.split(".").slice(0, -1).join(".");
	return schema ? `${schema}.${source}` : source;
}

function pickCreateTableLikeSource(
	target: PhysicalTableCatalogEntry,
	sourceQualifiedName: string,
	grouped: Map<string, PhysicalTableCatalogEntry[]>,
): PhysicalTableCatalogEntry | undefined {
	const candidates = grouped.get(normalizeName(sourceQualifiedName)) ?? [];
	const samePhysical = candidates.filter(
		(candidate) =>
			normalizeToken(candidate.platform) === normalizeToken(target.platform) &&
			normalizeToken(candidate.dataSource) === normalizeToken(target.dataSource),
	);
	return samePhysical.length === 1 ? samePhysical[0] : undefined;
}

function createLikeColumnResolver(
	columnAssigners: Map<PhysicalTableCatalogEntry, (columns: readonly string[]) => void>,
	grouped: Map<string, PhysicalTableCatalogEntry[]>,
	issues: string[],
): (entry: PhysicalTableCatalogEntry) => readonly string[] {
	const visiting = new Set<string>();
	const resolve = (entry: PhysicalTableCatalogEntry): readonly string[] => {
		const key = physicalTableKey(entry);
		if (visiting.has(key)) return [];
		visiting.add(key);
		try {
			const like = createTableLikeSource(verifiedFile(entry.ddlPath, entry.ddlSha256, "DDL").toString("utf8"));
			if (!like) return [];
			const source = pickCreateTableLikeSource(
				entry,
				qualifyCreateTableLikeSource(entry.qualifiedName, like),
				grouped,
			);
			if (!source || source === entry) {
				issues.push(`CREATE_TABLE_LIKE_SOURCE_UNRESOLVED:${entry.qualifiedName}:${like}`);
				return [];
			}
			const columns = source.columns;
			if (columns.length > 0) columnAssigners.get(entry)?.(columns);
			else issues.push(`CREATE_TABLE_LIKE_SOURCE_EMPTY:${entry.qualifiedName}:${source.qualifiedName}`);
			return columns;
		} finally {
			visiting.delete(key);
		}
	};
	return resolve;
}

export function loadPhysicalTableCatalog(
	dataRootInput: string,
	options: PhysicalTableCatalogOptions = {},
): PhysicalTableCatalog {
	const dataRoot = resolve(dataRootInput);
	const entries: PhysicalTableCatalogEntry[] = [];
	const issues: string[] = [];
	const columnAssigners = new Map<PhysicalTableCatalogEntry, (columns: readonly string[]) => void>();
	let likeResolve: (entry: PhysicalTableCatalogEntry) => readonly string[] = () => [];
	const referenceFilter = options.references;
	const requestedPhysicalKeys = new Set((referenceFilter?.physicalKeys ?? []).map((key) => normalizeToken(key)));
	const requestedQualifiedNames = new Set((referenceFilter?.qualifiedNames ?? []).map((name) => normalizeName(name)));
	const requestedNameTails = new Set((referenceFilter?.nameTails ?? []).map((name) => normalizeName(name)));
	const shouldIncludeTable = (
		platform: string,
		directoryName: string,
	): boolean => {
		if (
			referenceFilter === undefined ||
			(requestedPhysicalKeys.size === 0 &&
				requestedQualifiedNames.size === 0 &&
				requestedNameTails.size === 0)
		) {
			return true;
		}
		const separator = directoryName.lastIndexOf("__");
		if (separator <= 0 || separator >= directoryName.length - 2) return false;
		const qualifiedName = normalizeName(directoryName.slice(0, separator));
		const dataSource = directoryName.slice(separator + 2);
		if (requestedQualifiedNames.has(qualifiedName)) return true;
		const tail = normalizeName(qualifiedName.split(".").at(-1) ?? qualifiedName);
		if (requestedNameTails.has(tail)) return true;
		return requestedPhysicalKeys.has(
			normalizeToken(physicalTableKey({ platform, dataSource, qualifiedName })),
		);
	};
	const tablePaths =
		referenceFilter === undefined
			? discoverNamedFiles(join(dataRoot, "tables"), "table.json")
			: readdirSync(join(dataRoot, "tables"), { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
				.map((entry) => entry.name)
				.sort(compareText)
				.flatMap((platform) =>
					readdirSync(join(dataRoot, "tables", platform), { withFileTypes: true })
						.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
						.map((entry) => entry.name)
						.sort(compareText)
						.filter((directoryName) => shouldIncludeTable(platform, directoryName))
						.map((directoryName) =>
							join(dataRoot, "tables", platform, directoryName, "table.json"),
						),
				);
	const queuedPaths = new Set(tablePaths);
	for (const tablePath of tablePaths) {
		try {
			const raw: unknown = JSON.parse(readFileSync(tablePath, "utf8"));
			validateTableDocument(raw);
			const document = raw as TableDocument & JsonRecord;
			const ddlFile = asRecord(document.ddlFile);
			const ddlRelative = nonEmpty(ddlFile?.path);
			const ddlHash = nonEmpty(ddlFile?.sha256);
			if (!ddlRelative || !ddlHash) throw new Error("DDL_INDEX_INVALID");
			const ddlPath = resolve(dirname(tablePath), ddlRelative);
			if (!isWithin(dirname(tablePath), ddlPath)) throw new Error("DDL_PATH_UNSAFE");
			let loadedColumns: readonly string[] | undefined;
			let attemptedColumns = false;
			const getColumns = (): readonly string[] => {
				if (attemptedColumns) return loadedColumns ?? [];
				attemptedColumns = true;
				try {
					const ddl = verifiedFile(ddlPath, ddlHash, "DDL").toString("utf8");
					const parsed = parseDdlSchema(ddl);
					const columns = parsed.columns.map((column) => normalizeName(column.name));
					if (columns.length === 0 && !createTableLikeSource(ddl)) {
						throw new Error(`DDL_COLUMNS_UNAVAILABLE:${parsed.warnings.join(",")}`);
					}
					loadedColumns = columns;
				} catch (error) {
					if (!options.lazyDdl) throw error;
					issues.push(`${relativeLocator(dataRoot, tablePath)}:${error instanceof Error ? error.message : String(error)}`);
					loadedColumns = [];
				}
				return loadedColumns;
			};
			const columns = options.lazyDdl ? undefined : getColumns();
			if (!options.lazyDdl && columns?.length === 0 && !createTableLikeSource(verifiedFile(ddlPath, ddlHash, "DDL").toString("utf8"))) {
				throw new Error(`DDL_COLUMNS_UNAVAILABLE:${ddlPath}`);
			}
			const entry: PhysicalTableCatalogEntry = {
				platform: String(document.platform),
				dataSource: String(document.dataSource),
				stableTableId: String(document.stableTableId),
				qualifiedName: normalizeName(String(document.qualifiedName)),
				guid: nonEmpty(document.guid),
				partitionFields: Array.isArray(document.partitionFields)
					? document.partitionFields.map((field) => normalizeName(String(field)))
					: null,
				get columns() {
					const current = loadedColumns ?? columns ?? getColumns();
					if (current.length > 0) return current;
					return likeResolve(entry);
				},
				tablePath,
				ddlPath,
				tableContentHash: String(document.contentHash),
				ddlSha256: ddlHash,
			};
			columnAssigners.set(entry, (resolved) => {
				loadedColumns = resolved;
				attemptedColumns = true;
			});
			entries.push(entry);
			// LIKE sources are schema dependencies even when SQL never reads them.
			// Only enqueue the exact physical source; the path set also bounds cycles.
			if (referenceFilter !== undefined) {
				const like = createTableLikeSource(verifiedFile(ddlPath, ddlHash, "DDL").toString("utf8"));
				if (like) {
					const sourceName = qualifyCreateTableLikeSource(entry.qualifiedName, like);
					const sourcePath = join(dataRoot, "tables", entry.platform, `${sourceName}__${entry.dataSource}`, "table.json");
					if (isWithin(join(dataRoot, "tables", entry.platform), sourcePath) && existsSync(sourcePath) && !queuedPaths.has(sourcePath)) {
						queuedPaths.add(sourcePath);
						tablePaths.push(sourcePath);
					}
				}
			}
		} catch (error) {
			issues.push(`${relativeLocator(dataRoot, tablePath)}:${error instanceof Error ? error.message : String(error)}`);
		}
	}
	entries.sort((left, right) => compareText(physicalTableKey(left), physicalTableKey(right)));
	const grouped = new Map<string, PhysicalTableCatalogEntry[]>();
	for (const entry of entries) {
		const names = grouped.get(normalizeName(entry.qualifiedName)) ?? [];
		names.push(entry);
		grouped.set(normalizeName(entry.qualifiedName), names);
	}
	const tailGrouped = new Map<string, PhysicalTableCatalogEntry[]>();
	for (const entry of entries) {
		const tail = normalizeName(entry.qualifiedName.split(".").at(-1) ?? entry.qualifiedName);
		const names = tailGrouped.get(tail) ?? [];
		names.push(entry);
		tailGrouped.set(tail, names);
	}
	const byPhysicalKey = new Map<string, PhysicalTableCatalogEntry>();
	for (const entry of entries) {
		const key = physicalTableKey(entry);
		if (byPhysicalKey.has(key)) issues.push(`DUPLICATE_PHYSICAL_TABLE:${key}`);
		else byPhysicalKey.set(key, entry);
	}
	likeResolve = createLikeColumnResolver(columnAssigners, grouped, issues);
	return {
		entries,
		issues: issues.sort(compareText),
		byPhysicalKey,
		byQualifiedName: new Map([...grouped.entries()].map(([key, values]) => [key, [...values].sort((a, b) => compareText(physicalTableKey(a), physicalTableKey(b)))])),
		byNameTail: new Map([...tailGrouped.entries()].map(([key, values]) => [key, [...values].sort((a, b) => compareText(physicalTableKey(a), physicalTableKey(b)))])),
	};
}

function partitionStatus(
	task: TaskDocument & JsonRecord,
	target: PhysicalTableCatalogEntry,
): Pick<PlatformTargetQueryOutput, "partition_status" | "partition_columns"> {
	const columns = target.partitionFields;
	if (columns === null) return { partition_status: "UNKNOWN", partition_columns: [] };
	if (columns.length === 0) return { partition_status: "NOT_PARTITIONED", partition_columns: [] };
	if (task.partition === null) return { partition_status: "CONFLICT", partition_columns: columns };
	if (task.partition === undefined) return { partition_status: "UNKNOWN", partition_columns: columns };
	const variants = Array.isArray(task.partition) ? task.partition : [task.partition];
	const complete = variants.length > 0 && variants.every((variant) => {
		const record = asRecord(variant);
		return record !== null && columns.every((column) => partitionFieldValue(record, column) !== null);
	});
	return { partition_status: complete ? "COMPLETE" : "INCOMPLETE", partition_columns: columns };
}

function partitionFieldValue(record: JsonRecord, field: string): string | null {
	const key = Object.keys(record).find((candidate) => normalizeName(candidate) === normalizeName(field));
	return key === undefined ? null : nonEmpty(record[key]);
}

function platformTargetResolutionMethod(
	task: TaskDocument & JsonRecord,
): PlatformTargetQueryOutput["target_resolution_method"] | null {
	if (task.targetEvidenceKind === "DIRECT_PLATFORM_TARGET") return "DIRECT_PLATFORM_TARGET";
	if (task.targetEvidenceKind === undefined && String(task.taskCategory).trim().toLowerCase() === "sparkindex") {
		return "SPARKINDEX_TASK_TARGET";
	}
	return null;
}

function queryOutputBindingContract(
	task: TaskDocument & JsonRecord,
): NonNullable<PlatformTargetQueryOutput["query_output_binding_contract"]> {
	return String(task.taskCategory).trim().toLowerCase() === "sparkindex"
		? "SPARKINDEX_FULL_WIDTH_POSITIONAL"
		: "PLATFORM_TARGET_SCHEMA_POSITIONAL";
}

function sameTableReference(left: string, right: string): boolean {
	const normalize = (value: string): string => normalizeName(value);
	const normalizedLeft = normalize(left);
	const normalizedRight = normalize(right);
	return (
		normalizedLeft === normalizedRight ||
		normalizedLeft.split(".").at(-1) === normalizedRight.split(".").at(-1)
	);
}

function partitionEvidenceRef(item: TaskPartitionEvidenceRef): string {
	return `${item.source}:${item.locator}${item.detail ? `#${item.detail}` : ""}`;
}

function taskPartitionEvidence(
	task: TaskDocument & JsonRecord,
	taskTarget: PhysicalTableCatalogEntry,
	schemaEntries: readonly PhysicalTableCatalogEntry[],
	sources: readonly SelectedLineageSql[],
	ddlCache?: Map<string, string>,
	taskLocalSchemas: readonly JsonRecord[] = [],
): TaskPartitionEvidence {
	const taskLocalNames = new Set(
		taskLocalSchemas.map((record) => normalizeName(String(record.qualified_name))),
	);
	const tables: TableEvidence[] = schemaEntries
		.filter((entry) => !taskLocalNames.has(normalizeName(entry.qualifiedName)))
		.map((entry) => ({
		platform: entry.platform,
		dataSource: entry.dataSource,
		qualifiedName: entry.qualifiedName,
		objectType: "TABLE",
		partitionFields: entry.partitionFields,
		ddl: (() => {
			const cached = ddlCache?.get(entry.ddlPath);
			if (cached !== undefined) return cached;
			const ddl = verifiedFile(entry.ddlPath, entry.ddlSha256, "DDL").toString("utf8");
			ddlCache?.set(entry.ddlPath, ddl);
			return ddl;
		})(),
		evidenceProvider: `input-pack:${entry.tableContentHash}`,
	}));
	for (const record of taskLocalSchemas) {
		const columns = Array.isArray(record.columns)
			? record.columns.map(asRecord).filter((column): column is JsonRecord => column !== null)
			: [];
		tables.push({
			platform: taskTarget.platform,
			dataSource: taskTarget.dataSource,
			qualifiedName: normalizeName(String(record.qualified_name)),
			objectType: "TASK_LOCAL_TABLE",
			partitionFields: columns
				.filter((column) => column.partition === true)
				.map((column) => normalizeName(String(column.name)))
				.filter(Boolean),
			ddl: "",
			evidenceProvider: String(record.source ?? `input-pack-task-local:${task.taskId}`),
		});
	}
	const sql = Object.fromEntries(sources.map((source) => [source.slot, source.content])) as Partial<Record<SqlSlot, string>>;
	return buildTaskPartitionEvidence({
		taskTarget: taskTarget.qualifiedName,
		tables,
		sql,
		schedulerEvidence: task.schedulerEvidence as unknown as TaskSchedulerEvidence | undefined,
		sparkIndexMode: String(task.taskCategory).trim().toLowerCase() === "sparkindex",
	});
}

function packPartitionValues(
	task: TaskDocument & JsonRecord,
	field: string,
): readonly string[] | null {
	if (task.partition === null || task.partition === undefined) return null;
	const variants = Array.isArray(task.partition) ? task.partition : [task.partition];
	const values = variants.map((variant) => {
		const record = asRecord(variant);
		return record === null ? null : partitionFieldValue(record, field);
	});
	return values.length === 0 || values.some((value) => value === null)
		? null
		: values as string[];
}

function runtimePartitionValue(value: string): boolean {
	return value === "*" || /\$\{|\{\{|\{%|<%/u.test(value);
}

function packPartitionAssignmentStatus(
	task: TaskDocument & JsonRecord,
	field: string,
): PlatformPartitionAssignment["status"] {
	if (task.partition === null) return "CONFLICT";
	const values = packPartitionValues(task, field);
	if (values === null) return "UNKNOWN";
	return values.some(runtimePartitionValue)
		? "RUNTIME_EXPRESSION"
		: "CONFIRMED";
}

function sourceAssignmentsForField(
	write: TaskPartitionEvidence["targets"][number]["writes"][number],
	field: string,
): readonly TaskPartitionAssignment[] {
	const key = normalizeName(field);
	const candidates = [
		write.assignments.find((assignment) => normalizeName(assignment.field) === key),
		...(write.assignmentVariants ?? []).map((variant) =>
			variant.find((assignment) => normalizeName(assignment.field) === key),
		),
	].filter((assignment): assignment is TaskPartitionAssignment => assignment !== undefined);
	const seen = new Set<string>();
	return candidates.filter((assignment) => {
		const signature = `${assignment.status}\u0000${assignment.value ?? ""}\u0000${assignment.expression ?? ""}`;
		if (seen.has(signature)) return false;
		seen.add(signature);
		return true;
	});
}

function partitionLiteralConflict(
	task: TaskDocument & JsonRecord,
	field: string,
	sources: readonly TaskPartitionAssignment[],
): boolean {
	if (sources.some((assignment) => assignment.status === "CONFLICT")) return true;
	const packValues = packPartitionValues(task, field);
	if (packValues === null || packValues.some(runtimePartitionValue)) return false;
	if (
		sources.length === 0 ||
		sources.some((assignment) => assignment.status !== "CONFIRMED" || assignment.value === null)
	) return false;
	const expected = [...new Set(packValues.map((value) => value.trim()))].sort(compareText);
	const observed = [...new Set(sources.map((assignment) => assignment.value!.trim()))].sort(compareText);
	return expected.length !== observed.length || expected.some((value, index) => value !== observed[index]);
}

function platformPartitionBinding(
	task: TaskDocument & JsonRecord,
	evidence: TaskPartitionEvidence,
	target: PhysicalTableCatalogEntry,
): Pick<PlatformTargetQueryOutput, "partition_mode" | "partition_assignments"> {
	const targets = evidence.targets.filter((candidate) => sameTableReference(candidate.target, target.qualifiedName));
	if (targets.length !== 1) {
		return {
			partition_mode: "UNKNOWN",
			partition_assignments: [],
		};
	}
	const directWrites = targets[0]!.writes.filter((write) => write.statementOrdinal === null);
	if (directWrites.length !== 1) {
		return {
			partition_mode: "UNKNOWN",
			partition_assignments: [],
		};
	}
	const write = directWrites[0]!;
	const assignments: PlatformPartitionAssignment[] = write.mode === "DYNAMIC"
		? targets[0]!.fields.map((field) => {
				const sources = sourceAssignmentsForField(write, field);
				const conflict = partitionLiteralConflict(task, field, sources);
				return {
					field: normalizeName(field),
					status: conflict ? "CONFLICT" as const : packPartitionAssignmentStatus(task, field),
					mapping_method: conflict ? "CONFLICT" as const : "DYNAMIC_PARTITION_OUTPUT_ORDINAL" as const,
					evidence_refs: [
						...new Set([
							...write.evidence.map(partitionEvidenceRef),
							...sources.flatMap((source) => source.evidence.map(partitionEvidenceRef)),
							`TASK_PACK:task.partition#field=${normalizeName(field)}`,
						]),
					].sort(compareText),
					...(conflict ? { reason: "PACK_SQL_PARTITION_LITERAL_CONFLICT" } : {}),
				};
			})
		: write.assignments.map((assignment) => ({
				field: normalizeName(assignment.field),
				status: assignment.status,
				mapping_method: assignment.mappingMethod,
				evidence_refs: [...new Set(assignment.evidence.map(partitionEvidenceRef))].sort(compareText),
				...(assignment.reason === undefined ? {} : { reason: assignment.reason }),
			}));
	return {
		partition_mode: write.mode,
		partition_assignments: assignments,
	};
}

function sqlWritePartitionEvidence(
	dataRoot: string,
	catalog: PhysicalTableCatalog,
	sources: readonly SelectedLineageSql[],
	evidence: TaskPartitionEvidence,
	defaultSchema: TaskDefaultSchema | null,
	taskLocalNames: ReadonlySet<string>,
): readonly SqlWritePartitionEvidence[] {
	return evidence.targets
		.filter((target) => target.writes.length > 0)
		.flatMap((target) => {
			const qualifiedTarget = qualifyBareTableName(target.target, defaultSchema);
			const tableEntry = uniquePhysicalTableForReference(catalog, qualifiedTarget);
			return target.writes.map((write) => {
				const source = write.sqlSlot === null
					? undefined
					: sources.find((candidate) => candidate.slot === write.sqlSlot);
				const sqlWrite = source === undefined
					? undefined
					: extractSqlWrites(source.content).find(
							(candidate) =>
								sameTableReference(candidate.qualifiedName, target.target) &&
								candidate.statementOrdinal === write.statementOrdinal,
						);
				const evidenceRefs = [
					...write.evidence.map((item) => `${item.source}:${item.locator}`),
					...(tableEntry && !taskLocalNames.has(qualifiedTarget)
						? [
							`TABLE_PACK:${relativeLocator(dataRoot, tableEntry.tablePath)}`,
							`DDL:${relativeLocator(dataRoot, tableEntry.ddlPath)}`,
						]
						: []),
				];
				return {
					target: qualifiedTarget,
					...(write.sqlSlot === null ? {} : { sql_slot: write.sqlSlot }),
					statement_ordinal: write.statementOrdinal === null ? undefined : write.statementOrdinal - 1,
					...(sqlWrite === undefined
						? {}
						: {
								statement_start: sqlWrite.statementSpan.start,
								statement_end: sqlWrite.statementSpan.end,
							}),
					status:
						tableEntry === undefined && !taskLocalNames.has(qualifiedTarget)
							? "UNKNOWN"
							: write.status,
					partition_columns:
						tableEntry === undefined && !taskLocalNames.has(qualifiedTarget)
							? []
							: target.fields,
					evidence_refs: [...new Set(evidenceRefs)].sort(compareText),
				};
			});
		});
}

function schemaBundle(
	catalog: PhysicalTableCatalog,
	logicalSourceId: string,
	entries: readonly PhysicalTableCatalogEntry[] = catalog.entries,
): JsonRecord {
	const tailCounts = new Map<string, number>();
	for (const entry of catalog.entries) {
		const tail = entry.qualifiedName.split(".").at(-1)!;
		tailCounts.set(tail, (tailCounts.get(tail) ?? 0) + 1);
	}
	return {
		schema_version: "machine-facts-schema-bundle-v1",
		logical_source_id: logicalSourceId,
		records: entries.map((entry) => ({
			qualified_name: entry.qualifiedName,
			guid: entry.guid,
			status: "SUCCESS",
			source: `input-pack:${entry.tableContentHash}`,
			metadata_qualified_name: entry.qualifiedName,
			ddl_sha256: entry.ddlSha256,
			table_status: "AVAILABLE",
			required_for_star: false,
			columns: entry.columns.map((name) => ({ name, partition: entry.partitionFields?.includes(name) === true })),
			aliases: tailCounts.get(entry.qualifiedName.split(".").at(-1)!) === 1
				? [entry.qualifiedName.split(".").at(-1)!]
				: [],
		})),
	};
}

function addSchemaMapping(mapping: SchemaMapping, qualifiedName: string, columns: readonly string[]): void {
	const parts = normalizeName(qualifiedName).split(".").filter(Boolean);
	if (parts.length === 0) return;
	let current = mapping;
	for (const part of parts.slice(0, -1)) {
		const existing = current[part];
		if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[part] = {};
		current = current[part] as SchemaMapping;
	}
	current[parts.at(-1)!] = Object.fromEntries(columns.map((column) => [normalizeName(column), "unknown"]));
}

function taskLocalWriteTarget(sql: string, create: ReturnType<typeof readCreateTableHeader>): string | null {
	if (create?.asQuery) return normalizeName(create.target);
	const insert = /\binsert\s+(?:overwrite|into)\s+(?:table\s+)?([A-Za-z0-9_$`".\[\]-]+)/i.exec(sql);
	const raw = insert?.[1];
	if (!raw) return null;
	return normalizeName(raw.replaceAll("`", "").replaceAll('"', "").replaceAll("[", "").replaceAll("]", ""));
}

function taskLocalCreateSchema(sql: string, create: ReturnType<typeof readCreateTableHeader>): {
	readonly target: string;
	readonly columns: readonly string[];
	readonly partitionColumns: ReadonlySet<string>;
} | null {
	if (!create || create.asQuery) return null;
	const parsed = parseDdlSchema(sql);
	const columns = parsed.columns.map((column) => normalizeName(column.name)).filter(Boolean);
	if (columns.length === 0 || new Set(columns).size !== columns.length) return null;
	return {
		target: normalizeName(create.target),
		columns,
		partitionColumns: new Set(parsed.partition_columns.map(normalizeName)),
	};
}

function taskLocalCreateLike(sql: string): {
	readonly target: string;
	readonly source: string;
} | null {
	const match = /\bcreate\s+(?:(?:or\s+replace|external|temporary|temp)\s+)*table\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_$`".\[\]-]+)\s+like\s+([A-Za-z0-9_$`".\[\]-]+)/i.exec(sql);
	if (!match?.[1] || !match[2]) return null;
	const normalizeTable = (value: string): string =>
		normalizeName(value.replaceAll("`", "").replaceAll('"', "").replaceAll("[", "").replaceAll("]", ""));
	return { target: normalizeTable(match[1]), source: normalizeTable(match[2]) };
}

function uniquePhysicalTableForReference(
	catalog: PhysicalTableCatalog,
	target: string,
): PhysicalTableCatalogEntry | undefined {
	const normalized = normalizeName(target);
	const exact = catalog.byQualifiedName.get(normalized) ?? [];
	if (exact.length === 1) return exact[0];
	if (normalized.includes(".")) return undefined;
	const tail = normalized.split(".").at(-1) ?? normalized;
	const matches = catalog.entries.filter(
		(entry) =>
			normalizeName(entry.qualifiedName.split(".").at(-1) ?? entry.qualifiedName) ===
			tail,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function taskSchemaEntries(
	catalog: PhysicalTableCatalog,
	target: PhysicalTableCatalogEntry,
	sources: readonly SelectedLineageSql[],
	defaultSchema: TaskDefaultSchema | null,
	dialect: "databricks" | "duckdb",
): readonly PhysicalTableCatalogEntry[] {
	const references = new Set<string>([target.qualifiedName]);
	for (const source of sources) {
		for (const name of extractSqlReadTableNames(source.analysisContent)) references.add(name);
		for (const write of extractSqlWrites(source.content)) references.add(write.qualifiedName);
		try {
			const session = SqlSession.create(source.analysisContent, dialect);
			for (const [statementIndex, cell] of session.doc.statements.entries()) {
				const plan = buildPlanFacts(cell, source.analysisContent, {
					statement_index: statementIndex,
					dialect,
					include_expression_dependencies: false,
				});
				for (const name of plan.physical_inputs) references.add(name);
			}
		} catch {
			// Keep the conservative text discovery above when a source cannot be parsed.
		}
	}
	const selected = new Set<PhysicalTableCatalogEntry>([target]);
	for (const reference of references) {
		const normalized = qualifyBareTableName(reference, defaultSchema);
		const exact = catalog.byQualifiedName.get(normalized) ?? [];
		if (exact.length > 0) {
			for (const entry of exact) selected.add(entry);
			continue;
		}
		if (normalized.includes(".")) continue;
		const tail = normalized;
		const suffixMatches = catalog.byNameTail.get(tail) ?? [];
		if (suffixMatches.length === 1) selected.add(suffixMatches[0]!);
	}
	return catalog.entries.filter((entry) => selected.has(entry));
}

function deriveTaskLocalSchemas(
	catalog: PhysicalTableCatalog,
	schemaEntries: readonly PhysicalTableCatalogEntry[],
	sources: readonly SelectedLineageSql[],
	taskId: string,
	declaredTarget: string,
	defaultSchema: TaskDefaultSchema | null,
	dialect: "databricks" | "duckdb",
): JsonRecord[] {
	const normalizedDeclaredTarget = normalizeName(declaredTarget);
	const mapping: SchemaMapping = {};
	for (const entry of schemaEntries) addSchemaMapping(mapping, entry.qualifiedName, entry.columns);
	const records = new Map<string, JsonRecord>();
	const localTargetsByTail = new Map<string, Set<string>>();
	const addTaskLocalMapping = (target: string, columns: readonly string[]): void => {
		addSchemaMapping(mapping, target, columns);
		const tail = target.split(".").at(-1) ?? target;
		const targets = localTargetsByTail.get(tail) ?? new Set<string>();
		targets.add(target);
		localTargetsByTail.set(tail, targets);
		if (targets.size === 1) addSchemaMapping(mapping, tail, columns);
		else delete mapping[tail];
	};
	const rank = new Map(["create", "prepare", "query"].map((slot, index) => [slot, index]));
	const orderedSources = [...sources].sort((left, right) => {
		return (rank.get(left.slot) ?? 100) - (rank.get(right.slot) ?? 100) || compareText(left.slot, right.slot);
	});
	for (const source of orderedSources) {
		const split = SqlSession.create(source.analysisContent, dialect, { schema: new Schema(mapping) });
		for (const cell of split.doc.statements) {
			const rawSql = source.analysisContent.slice(cell.span.start, cell.span.end);
			const createHeader = readCreateTableHeader(rawSql);
			const createLike = taskLocalCreateLike(rawSql);
			if (createLike) {
				const createTarget = qualifyBareTableName(createLike.target, defaultSchema);
				const likeSource = qualifyBareTableName(createLike.source, defaultSchema);
				const inherited = uniquePhysicalTableForReference(catalog, likeSource);
				if (
					createTarget !== normalizedDeclaredTarget &&
					inherited &&
					inherited.columns.length > 0
				) {
					const partitionColumns = new Set(
						(inherited.partitionFields ?? []).map(normalizeName),
					);
					addTaskLocalMapping(createTarget, inherited.columns);
					records.set(createTarget, {
						qualified_name: createTarget,
						guid: null,
						status: "SUCCESS",
						source: `input-pack-task-local-like:${taskId}:${source.slot}`,
						metadata_qualified_name: createTarget,
						ddl_sha256: sha256(Buffer.from(rawSql, "utf8")),
						table_status: "TASK_LOCAL",
						required_for_star: true,
						columns: inherited.columns.map((name) => ({
							name,
							partition: partitionColumns.has(normalizeName(name)),
						})),
						aliases: [],
						like_source: inherited.qualifiedName,
					});
					continue;
				}
			}
			const createSchema = taskLocalCreateSchema(rawSql, createHeader);
			const createTarget = createSchema
				? qualifyBareTableName(createSchema.target, defaultSchema)
				: null;
			if (
				createSchema &&
				createTarget &&
				createTarget !== normalizedDeclaredTarget
			) {
				addTaskLocalMapping(createTarget, createSchema.columns);
				records.set(createTarget, {
					qualified_name: createTarget,
					guid: null,
					status: "SUCCESS",
					source: `input-pack-task-local-ddl:${taskId}:${source.slot}`,
					metadata_qualified_name: createTarget,
					ddl_sha256: sha256(Buffer.from(rawSql, "utf8")),
					table_status: "TASK_LOCAL",
					required_for_star: true,
					columns: createSchema.columns.map((name) => ({
						name,
						partition: createSchema.partitionColumns.has(name),
					})),
					aliases: [],
				});
			}
			const rawTarget = taskLocalWriteTarget(rawSql, createHeader);
			const target = rawTarget
				? qualifyBareTableName(rawTarget, defaultSchema)
				: null;
			if (
				!target ||
				target === normalizedDeclaredTarget ||
				records.has(target)
			) continue;
			const physicalSchema = uniquePhysicalTableForReference(catalog, target);
			const isCtas = createHeader?.asQuery === true;
			if (!isCtas && (physicalSchema?.columns.length ?? 0) > 0) continue;
			const session = SqlSession.create(rawSql, dialect, { schema: new Schema(mapping) });
			const statement = session.doc.statements[0];
			if (!statement) continue;
			const plan = buildPlanFacts(statement, rawSql, {
				statement_index: 0,
				dialect,
				schema: new Schema(mapping),
				include_expression_dependencies: true,
			});
			const roots = (plan.relations as unknown as JsonRecord[]).filter((relation) => plan.roots.includes(String(relation.id)));
			const rootColumns = roots.length === 1 && Array.isArray(roots[0]?.output_columns)
				? roots[0]!.output_columns.map((column) => normalizeName(String(column))).filter((column) => column && column !== "*")
				: [];
			if (rootColumns.length === 0 || new Set(rootColumns).size !== rootColumns.length) continue;
			addTaskLocalMapping(target, rootColumns);
			records.set(target, {
				qualified_name: target,
				guid: null,
				status: "SUCCESS",
				source: `input-pack-task-local-write:${taskId}:${source.slot}`,
				metadata_qualified_name: target,
				ddl_sha256: null,
				table_status: "TASK_LOCAL",
				required_for_star: true,
				columns: rootColumns.map((name) => ({ name, partition: false })),
				aliases: [],
			});
		}
	}
	const tailCounts = new Map<string, number>();
	for (const entry of schemaEntries) {
		const tail = normalizeName(entry.qualifiedName.split(".").at(-1) ?? entry.qualifiedName);
		tailCounts.set(tail, (tailCounts.get(tail) ?? 0) + 1);
	}
	for (const target of records.keys()) {
		const tail = target.split(".").at(-1) ?? target;
		tailCounts.set(tail, (tailCounts.get(tail) ?? 0) + 1);
	}
	return [...records.entries()]
		.sort(([left], [right]) => compareText(left, right))
		.map(([target, record]) => {
			const tail = target.split(".").at(-1) ?? target;
			const targetSchema = target.split(".").slice(0, -1).join(".");
			const defaultSchemaMatch = defaultSchema?.schema === targetSchema;
			return {
				...record,
				aliases: defaultSchemaMatch || tailCounts.get(tail) === 1 ? [tail] : [],
			};
		});
}

function combinedLineageSql(
	allSources: readonly SelectedLineageSql[],
	selected: SelectedLineageSql,
): { sql: SelectedLineageSql; sources: readonly SelectedLineageSql[]; segments: readonly { slot: string; start: number; end: number }[] } {
	const rank = new Map(["create", "prepare", "query"].map((slot, index) => [slot, index]));
	const candidates = allSources
		.filter((source) => fieldProducingSql(source.analysisContent) || source.slot === selected.slot)
		.sort((left, right) => (rank.get(left.slot) ?? 100) - (rank.get(right.slot) ?? 100) || compareText(left.slot, right.slot));
	const sources = candidates.length > 0 ? candidates : [selected];
	let content = "";
	const segments: { slot: string; start: number; end: number }[] = [];
	for (const source of sources) {
		if (content.length > 0) {
			const trimmedEnd = content.trimEnd().length;
			if (!content.slice(0, trimmedEnd).endsWith(";")) {
				// Keep the derived terminator inside the preceding segment so its parser span
				// remains attributable to the original slot.
				content += ";";
				segments[segments.length - 1]!.end = content.length;
			}
			if (!content.endsWith("\n")) content += "\n";
		}
		const start = content.length;
		content += source.analysisContent;
		segments.push({ slot: source.slot, start, end: content.length });
	}
	const digest = sha256(Buffer.from(content, "utf8"));
	return {
			sql: {
				slot: sources.length === 1 ? sources[0]!.slot : "multi",
				path: selected.path,
				locator: sources.length === 1 ? sources[0]!.locator : `derived:task-sql-slots:${sources.map((source) => source.slot).join(",")}`,
				sha256: digest,
				content,
				analysisContent: content,
				analysisSha256: digest,
				evidenceProvider: [...new Set(sources.map((source) => source.evidenceProvider))].sort(compareText).join(","),
		},
		sources,
		segments,
	};
}

function verifyStableInputs(hashes: ReadonlyMap<string, string>): void {
	for (const [path, expected] of hashes) {
		if (!existsSync(path) || sha256File(path) !== expected) throw new Error(`INPUT_CHANGED_DURING_PREPARATION:${path}`);
	}
}

export function prepareInputPackTask(options: PrepareInputPackTaskOptions): PreparedInputPackTask {
	const dataRoot = resolve(options.dataRoot);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.taskId)) throw new Error("TASK_ID_INVALID");
	const taskPaths = options.taskPath === undefined
		? discoverNamedFiles(join(dataRoot, "tasks"), "task.json").filter((path) => basename(dirname(path)) === options.taskId)
		: [resolve(options.taskPath)];
	if (taskPaths.length === 0) throw new Error(`TASK_INPUT_PACK_MISSING:${options.taskId}`);
	if (taskPaths.length !== 1) throw new Error(`TASK_INPUT_PACK_AMBIGUOUS:${options.taskId}`);
	const taskPath = taskPaths[0]!;
	if (basename(dirname(taskPath)) !== options.taskId) throw new Error(`TASK_INPUT_PACK_PATH_MISMATCH:${options.taskId}`);
	if (!isWithin(join(dataRoot, "tasks"), taskPath)) throw new Error(`TASK_INPUT_PACK_PATH_UNSAFE:${options.taskId}`);
	const taskRaw: unknown = JSON.parse(readFileSync(taskPath, "utf8"));
	validateTaskDocument(taskRaw);
	const task = taskRaw as TaskDocument & JsonRecord;
	if (task.taskId !== options.taskId) throw new Error(`TASK_IDENTITY_MISMATCH:${options.taskId}`);
	const selected = selectLineageSql(dataRoot, taskPath, task);
	const combined = combinedLineageSql(selected.sources, selected.selected);
	const catalog = options.tableCatalog ?? loadPhysicalTableCatalog(dataRoot, { lazyDdl: true });
	const defaultSchema = inferTaskDefaultSchema(task);
	const targetRef = targetRecord(task, catalog, selected.sources, defaultSchema);
	const target = catalog.byPhysicalKey.get(physicalTableKey(targetRef));
	if (!target) throw new Error(`TARGET_TABLE_PACK_MISSING:${physicalTableKey(targetRef)}`);
	const logicalSourceId = logicalSourceIdFor(target.platform, target.dataSource);
	const dialect = taskSqlDialect(String(task.taskCategory));
	const schemaEntries = taskSchemaEntries(
		catalog,
		target,
		combined.sources,
		defaultSchema,
		dialect,
	);
	if (target.columns.length === 0) throw new Error(`TARGET_SCHEMA_NOT_PROVABLE:${target.qualifiedName}`);
	const baseBundle = schemaBundle(catalog, logicalSourceId, schemaEntries);
	const taskLocalSchemas = deriveTaskLocalSchemas(
		catalog,
		schemaEntries,
		selected.sources,
		options.taskId,
		target.qualifiedName,
		defaultSchema,
		dialect,
	);
	const taskLocalNames = new Set(
		taskLocalSchemas.map((record) => normalizeName(String(record.qualified_name))),
	);
	const bundle = {
		...baseBundle,
		records: [
			...((baseBundle.records as JsonRecord[]) ?? []).filter(
				(record) =>
					!taskLocalNames.has(normalizeName(String(record.qualified_name))),
			),
			...taskLocalSchemas,
		],
	};
	const bundleHash = sha256(canonicalJson(bundle));
	const inputHashes = new Map(selected.hashes);
	for (const entry of schemaEntries) {
		inputHashes.set(entry.tablePath, sha256File(entry.tablePath));
		inputHashes.set(entry.ddlPath, entry.ddlSha256);
	}
	const provenance: InputPackProvenance = {
		schema_version: "machine-facts-input-pack-provenance-v1",
		data_root: realpathSync.native(dataRoot),
		task_locator: relativeLocator(dataRoot, taskPath),
		task_content_hash: String(task.contentHash),
		sql_slot: selected.selected.slot,
		sql_locator: selected.selected.locator,
		sql_sha256: selected.selected.sha256,
		sql_sources: combined.sources.map((source) => ({ slot: source.slot, locator: source.locator, sha256: source.sha256 })),
		analysis_sql_sha256: combined.sql.sha256,
		table_locator: relativeLocator(dataRoot, target.tablePath),
		table_content_hash: target.tableContentHash,
		ddl_locator: relativeLocator(dataRoot, target.ddlPath),
		ddl_sha256: target.ddlSha256,
	};
	const declaredPartition = partitionStatus(task, target);
	const detailedPartition = taskPartitionEvidence(
		task,
		target,
		schemaEntries,
		selected.sources,
		options.ddlCache,
		taskLocalSchemas,
	);
	const platformPartition = taskPartitionEvidence(
		task,
		target,
		schemaEntries,
		selected.sources.filter((source) => source.slot === selected.selected.slot),
		options.ddlCache,
	);
	const targetResolutionMethod = platformTargetResolutionMethod(task);
	const writeColumns = task.writeColumnEvidence === undefined ? undefined : verifiedWriteColumns(
		task.writeColumnEvidence, selected.selected.content, task.target);
	if (writeColumns && targetResolutionMethod !== "DIRECT_PLATFORM_TARGET") throw new Error("WRITE_COLUMNS_TARGET_NOT_DIRECT");
	const outputBindingContract = queryOutputBindingContract(task);
	const observedPlatformPartition = platformPartitionBinding(task, platformPartition, target);
	const explicitSchedulerPartition = observedPlatformPartition.partition_mode === "STATIC" &&
		(observedPlatformPartition.partition_assignments?.length ?? 0) > 0 &&
		observedPlatformPartition.partition_assignments!.every(assignment =>
			assignment.mapping_method === "SCHEDULER_EXPLICIT_FIELD_VALUE" &&
			(assignment.status === "CONFIRMED" || assignment.status === "RUNTIME_EXPRESSION"));
	const platformPartitionShape = outputBindingContract === "SPARKINDEX_FULL_WIDTH_POSITIONAL" || explicitSchedulerPartition
		? observedPlatformPartition
		: target.partitionFields?.length === 0
			? { partition_mode: "NONE" as const, partition_assignments: [] }
			: { partition_mode: "UNKNOWN" as const, partition_assignments: [] };
	const platformOutput = targetResolutionMethod !== null
		? {
				target: target.qualifiedName,
				target_columns: writeColumns?.columns,
				target_resolution_method: targetResolutionMethod,
				query_output_slot: selected.selected.slot,
				query_output_binding_contract: outputBindingContract,
				...declaredPartition,
				...platformPartitionShape,
				evidence_refs: [provenance.task_locator, provenance.table_locator, provenance.ddl_locator,
					...(writeColumns ? [`${writeColumns.source}#sha256=${writeColumns.sourceSha256}`] : [])],
			} satisfies PlatformTargetQueryOutput
		: undefined;
	const explicitWritePartitionEvidence = sqlWritePartitionEvidence(
		dataRoot,
		catalog,
		selected.sources,
		detailedPartition,
		defaultSchema,
		taskLocalNames,
	);
	const standardized = options.standardizedInput ? loadStandardizedInput(taskPath, task, dialect, combined.sql.content) : undefined;
	if (standardized) inputHashes.set(standardized.manifestPath, standardized.profile.artifactSha256);
	const profileTask: GenericTaskProfile = {
		...(String(task.taskCategory).trim().toLowerCase().startsWith("oracle2")
			? { source_sql_family: "oracle" as const } : {}),
		...(standardized ? { standardized_input: standardized.profile } : {}),
		task_id: options.taskId,
		sql_snapshot: combined.sql.path,
		...(defaultSchema ? { default_schema: defaultSchema.schema } : {}),
		writes: target.qualifiedName,
		...(combined.sources.length === 1 ? { sql_slot: combined.sources[0]!.slot } : { sql_segments: combined.segments }),
		input_pack_provenance: provenance,
		write_partition_evidence: {
			status: declaredPartition.partition_status,
			partition_columns: declaredPartition.partition_columns,
			evidence_refs: [provenance.task_locator, provenance.table_locator, provenance.ddl_locator],
		},
		...(explicitWritePartitionEvidence.length > 0 ? { sql_write_partition_evidence: explicitWritePartitionEvidence } : {}),
		...(platformOutput ? { platform_target_query_output: platformOutput } : {}),
	};
	options.beforeFinalVerification?.();
	verifyStableInputs(inputHashes);
	return {
		taskId: options.taskId,
		taskName: nonEmpty(task.taskName),
		taskCategory: String(task.taskCategory),
		taskPath,
		task,
		target,
		sql: combined.sql,
		sqlSources: combined.sources,
		sqlSegments: combined.segments,
		dialect,
		logicalSourceId,
		schemaBundle: bundle,
		schemaBundleHash: bundleHash,
		profileTask,
		...(standardized ? { standardizedArtifact: { bytes: standardized.bytes, sha256: standardized.profile.artifactSha256 } } : {}),
		provenance,
		inputHashes,
	};
}

function frozenSqlPath(outputRoot: string, prepared: PreparedInputPackTask): string {
	const directory = join(outputRoot, "input-pack-sources", prepared.taskId);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${prepared.sql.slot}-${prepared.sql.sha256}.sql`);
	if (existsSync(path)) {
		if (sha256File(path) !== prepared.sql.sha256) throw new Error(`INPUT_PACK_SOURCE_HASH_COLLISION:${path}`);
	} else writeFileSync(path, prepared.sql.content, "utf8");
	return path;
}

function freezeRawSqlSources(outputRoot: string, prepared: PreparedInputPackTask): void {
	const directory = join(outputRoot, "input-pack-sources", prepared.taskId);
	mkdirSync(directory, { recursive: true });
	if (prepared.standardizedArtifact) {
		const artifact = prepared.standardizedArtifact;
		const path = join(directory, `standardized-${artifact.sha256}.json`);
		if (existsSync(path)) {
			if (sha256File(path) !== artifact.sha256) throw new Error("STANDARDIZED_ARTIFACT_HASH_COLLISION");
		} else writeFileSync(path, artifact.bytes, "utf8");
	}
	for (const source of prepared.sqlSources) {
		const path = join(directory, `${source.slot}-${source.sha256}.sql`);
		if (existsSync(path)) {
			if (sha256File(path) !== source.sha256) throw new Error(`INPUT_PACK_SOURCE_HASH_COLLISION:${path}`);
		} else writeFileSync(path, source.content, "utf8");
	}
}

export function runInputPackMachineFacts(options: RunInputPackMachineFactsOptions): InputPackMachineFactsRunResult {
	if (options.taskIds.length === 0) throw new Error("TASK_ID_REQUIRED");
	const outputRoot = resolve(options.outputRoot);
	mkdirSync(outputRoot, { recursive: true });
	const requestedTaskIds = [...new Set(options.taskIds)].sort(compareText);
	const taskPathIndex = options.taskPathIndex ?? locateTaskInputPacks(options.dataRoot, requestedTaskIds);
	const catalog = options.tableCatalog ?? loadPhysicalTableCatalog(options.dataRoot, {
		lazyDdl: true,
		references: collectTaskTableReferences(
			options.dataRoot,
			requestedTaskIds.flatMap((taskId) => taskPathIndex.get(taskId) ?? []),
		),
	});
	const ddlCache = new Map<string, string>();
	const tasks: TaskRunResult[] = [];
	const preparedByTaskId = new Map<string, {
		taskCategory: string;
		taskContentHash: string;
	}>();
	const preparedSummary: InputPackMachineFactsRunResult["prepared"][number][] = [];
	const writerCatalogEnabled = options.noWriterCatalog !== true && options.writerCatalogPath !== null;
	const writerCatalogPath = writerCatalogEnabled
		? resolve(options.writerCatalogPath ?? defaultWriterCatalogPath(options.dataRoot))
		: null;
	for (const taskId of requestedTaskIds) {
		const taskPaths = taskPathIndex.get(taskId) ?? [];
		try {
			if (taskPaths.length === 0) throw new Error(`TASK_INPUT_PACK_MISSING:${taskId}`);
			if (taskPaths.length !== 1) throw new Error(`TASK_INPUT_PACK_AMBIGUOUS:${taskId}`);
			const prepared = prepareInputPackTask({
				standardizedInput: options.standardizedInput,
				dataRoot: options.dataRoot,
				taskId,
				taskPath: taskPaths[0],
				tableCatalog: catalog,
				ddlCache,
				beforeFinalVerification: options.beforeFinalVerification ? () => options.beforeFinalVerification!(taskId) : undefined,
			});
			freezeRawSqlSources(outputRoot, prepared);
			const frozenPath = frozenSqlPath(outputRoot, prepared);
			const profileTask: GenericTaskProfile = { ...prepared.profileTask, sql_snapshot: frozenPath };
			const profile: GenericAnalysisProfile = {
				schema_version: "input-pack-machine-facts-v1",
				dialect: prepared.dialect,
				logical_source_id: prepared.logicalSourceId,
				tasks: [profileTask],
			};
			tasks.push(runTask(profileTask, profile, prepared.logicalSourceId, outputRoot, prepared.schemaBundle, prepared.schemaBundleHash));
			preparedByTaskId.set(taskId, {
				taskCategory: prepared.taskCategory,
				taskContentHash: String(prepared.task.contentHash),
			});
			preparedSummary.push({
				taskId,
				sqlSlot: prepared.sql.slot,
				target: prepared.target.qualifiedName,
				taskContentHash: String(prepared.task.contentHash),
				tableContentHash: prepared.target.tableContentHash,
			});
		} catch (error) {
			tasks.push({
				task_id: taskId,
				state: "FAILED",
				status: "FAILED",
				failures: [{
					outcome_class: "FAILURE",
					reason_code: "INPUT_PACK_PREPARATION_FAILED",
					message: error instanceof Error ? error.message : String(error),
				}],
			});
		}
	}
	if (writerCatalogPath) {
		const catalogHandle = openWriterCatalog(writerCatalogPath);
		for (const task of tasks) {
			const prepared = preparedByTaskId.get(task.task_id);
			syncWriterCatalogAfterMachineFacts({
				handle: catalogHandle,
				factsRoot: outputRoot,
				taskId: task.task_id,
				taskCategory: prepared?.taskCategory ?? "",
				taskContentHash: prepared?.taskContentHash ?? "",
				taskResult: task,
			});
		}
	}
	const indexMode = options.indexMode ?? "auto";
	const indexStarted = performance.now();
	const indexRefresh = refreshMachineFactsIndex(outputRoot, {
		taskResults: tasks,
		mode: indexMode,
	});
	return {
		output_root: outputRoot,
		tasks,
		index: indexRefresh.index,
		timings: {
			index_ms: performance.now() - indexStarted,
			index_mode: indexRefresh.appliedMode,
			index_requested_mode: indexRefresh.requestedMode,
			index_verification_scope: indexRefresh.verificationScope,
			...(indexRefresh.fallbackReason ? { index_fallback_reason: indexRefresh.fallbackReason } : {}),
		},
		prepared: preparedSummary,
	};
}

function option(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function parseIndexMode(value: string | undefined): MachineFactsIndexMode {
	if (!value) return "auto";
	if (value === "auto" || value === "full" || value === "incremental") return value;
	throw new Error(`INVALID_INDEX_MODE:${value}`);
}

export function parseInputPackMachineFactsCli(args: readonly string[]): RunInputPackMachineFactsOptions {
	const paths = resolveWorkspacePaths({
		configPath: option(args, "--config"),
		profile: option(args, "--profile"),
		overrides: {
			inputPackRoot: option(args, "--data-root") ?? option(args, "--input-pack-root"),
			factsRoot: option(args, "--output"),
			writerCatalogPath: option(args, "--writer-catalog"),
		},
	});
	const dataRoot = paths.inputPackRoot;
	const outputRoot = paths.factsRoot;
	const taskIds = args
		.flatMap((value, index) => (value === "--task-id" && args[index + 1] ? args[index + 1]!.split(",") : []))
		.map((value) => value.trim())
		.filter(Boolean);
	if (!dataRoot || !outputRoot || taskIds.length === 0)
		throw new Error("usage: input-pack-machine-facts --task-id <id[,id]> [--config <json>] [--data-root <packs>] [--output <facts>] [--index-mode <auto|incremental|full>] [--writer-catalog <sqlite>] [--no-writer-catalog]");
	return {
		dataRoot,
		outputRoot,
		taskIds,
		indexMode: parseIndexMode(option(args, "--index-mode")),
		writerCatalogPath: paths.writerCatalogPath,
		...(args.includes("--no-writer-catalog") ? { noWriterCatalog: true } : {}),
		...(args.includes("--standardized-input") ? { standardizedInput: true } : {}),
	};
}

if (process.argv[1] && basename(process.argv[1]).startsWith("input-pack-machine-facts")) {
	const result = runInputPackMachineFacts(parseInputPackMachineFactsCli(process.argv.slice(2)));
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
