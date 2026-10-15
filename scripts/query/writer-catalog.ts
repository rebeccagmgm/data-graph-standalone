import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	isPlatformTargetQueryOutputKind,
	normalizeName,
	PACK_DECLARED_QUERY_OUTPUT,
	type DatasetIoRecord,
} from "../machine-facts/machine-facts-contract.ts";
import { readJsonlRecords } from "../machine-facts/jsonl-store.ts";
import { resolveProducerTableIdentity } from "../reconcile/shared/producer-table-identity.ts";
import type { ProducerTableIdentity } from "../reconcile/producer/producer-index.ts";
import { assertOutputOutsideDataRoot } from "../reconcile/producer/producer-index.ts";

export const WRITER_CATALOG_SCHEMA_VERSION = "1.0.0" as const;

export interface WriterHit {
	readonly taskId: string;
	readonly writeObservationId: string;
	readonly table: ProducerTableIdentity;
	readonly writeKind: string | null;
	readonly resolutionStatus: string | null;
	readonly physicalDataset: string;
	readonly partitionJson: string | null;
}

export interface TaskCoverageRow {
	readonly taskId: string;
	readonly taskCategory: string;
	readonly taskContentHash: string;
	readonly factsManifestSha256: string;
	readonly factsStatus: string;
	readonly indexedAt: string;
}

export interface CatalogCoverageCounts {
	readonly tasksIndexed: number;
	readonly tasksFailed: number;
	readonly writerRows: number;
	readonly distinctTables: number;
}

export interface CatalogWriterRow {
	readonly tableKey: string;
	readonly platform: string;
	readonly dataSource: string;
	readonly qualifiedName: string;
	readonly writerTaskId: string;
	readonly writeObservationId: string;
	readonly writeKind: string | null;
	readonly resolutionStatus: string | null;
	readonly physicalDataset: string;
	readonly partitionJson: string | null;
}

export interface UpsertTaskWritersInput {
	readonly taskId: string;
	readonly taskCategory: string;
	readonly taskContentHash: string;
	readonly factsManifestSha256: string;
	readonly factsStatus: "SUCCESS" | "FAILED" | "MISSING";
	readonly writes: readonly CatalogWriterRow[];
}

export interface WriterCatalogHandle {
	readonly db: DatabaseSync;
	readonly path: string;
}

export interface WriterCatalogPort {
	readonly writersForTable: (table: ProducerTableIdentity) => readonly WriterHit[];
	readonly writersForQualifiedName: (qualifiedName: string) => readonly WriterHit[];
	readonly hasConfirmedWriter: (table: ProducerTableIdentity) => boolean;
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function nonEmpty(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function tableKey(table: ProducerTableIdentity): string {
	return [
		table.platform.trim().toLowerCase(),
		table.dataSource.trim().toLowerCase(),
		normalizeName(table.qualifiedName).toLowerCase(),
	].join("\u0000");
}

export function defaultWriterCatalogPath(dataRootInput: string): string {
	const dataRoot = resolve(dataRootInput);
	const catalogRoot = `${dataRoot}.writer-catalog`;
	assertOutputOutsideDataRoot(dataRoot, catalogRoot);
	return join(catalogRoot, "writer-catalog.sqlite");
}

function initializeSchema(database: DatabaseSync): void {
	database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 30000;

    CREATE TABLE IF NOT EXISTS meta (
      schema_version TEXT NOT NULL,
      built_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_coverage (
      task_id TEXT PRIMARY KEY,
      task_category TEXT NOT NULL,
      task_content_hash TEXT NOT NULL,
      facts_manifest_sha256 TEXT NOT NULL,
      facts_status TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS table_writers (
      table_key TEXT NOT NULL,
      platform TEXT NOT NULL,
      data_source TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      writer_task_id TEXT NOT NULL,
      write_observation_id TEXT NOT NULL,
      write_kind TEXT,
      resolution_status TEXT,
      physical_dataset TEXT NOT NULL,
      partition_json TEXT,
      PRIMARY KEY (table_key, writer_task_id, write_observation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_table_writers_table_key ON table_writers(table_key);
    CREATE INDEX IF NOT EXISTS idx_table_writers_writer_task_id ON table_writers(writer_task_id);
  `);
	database
		.prepare(
			`INSERT INTO meta(schema_version, built_at)
       SELECT ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM meta)`,
		)
		.run(WRITER_CATALOG_SCHEMA_VERSION, new Date().toISOString());
}

export function openWriterCatalog(dbPathInput: string): WriterCatalogHandle {
	const path = resolve(dbPathInput);
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	initializeSchema(db);
	return { db, path };
}

export function isCatalogWritableWrite(record: DatasetIoRecord): boolean {
	if (record.direction !== "WRITE") return false;
	const physicalDataset = normalizeName(String(record.physical_dataset ?? ""));
	if (!physicalDataset) return false;
	if (record.resolution_status === "UNRESOLVED") return false;
	if (record.field_producing === false) return false;
	if (nonEmpty(record.write_observation_id)) return true;
	if (record.field_producing === true) return true;
	if (record.provenance === "PLATFORM_TARGET") return true;
	if (
		typeof record.write_kind === "string"
		&& (record.write_kind === PACK_DECLARED_QUERY_OUTPUT
			|| isPlatformTargetQueryOutputKind(record.write_kind))
	) {
		return true;
	}
	return false;
}

function deriveWriteObservationId(
	taskId: string,
	table: ProducerTableIdentity,
	record: DatasetIoRecord,
): string {
	const existing = nonEmpty(record.write_observation_id);
	if (existing) return existing;
	const writeKind = nonEmpty(record.write_kind) ?? "WRITE";
	return `derived:${sha256(`${taskId}\u0000${tableKey(table)}\u0000${writeKind}`)}`;
}

export function catalogWritersFromDatasetIo(input: {
	readonly taskId: string;
	readonly taskCategory: string;
	readonly records: readonly DatasetIoRecord[];
}): CatalogWriterRow[] {
	const rows: CatalogWriterRow[] = [];
	for (const record of input.records) {
		if (!isCatalogWritableWrite(record)) continue;
		const identity = resolveProducerTableIdentity({
			qualifiedName: String(record.physical_dataset ?? ""),
			taskCategory: input.taskCategory,
		});
		if (identity.platform === "unknown" || identity.dataSource === "unknown") continue;
		const key = tableKey(identity);
		rows.push({
			tableKey: key,
			platform: identity.platform,
			dataSource: identity.dataSource,
			qualifiedName: identity.qualifiedName,
			writerTaskId: input.taskId,
			writeObservationId: deriveWriteObservationId(input.taskId, identity, record),
			writeKind: nonEmpty(record.write_kind),
			resolutionStatus: nonEmpty(record.resolution_status),
			physicalDataset: normalizeName(String(record.physical_dataset ?? "")),
			partitionJson: null,
		});
	}
	rows.sort((left, right) =>
		compareText(left.tableKey, right.tableKey)
		|| compareText(left.writeObservationId, right.writeObservationId));
	return rows;
}

function touchMeta(database: DatabaseSync): void {
	database
		.prepare("UPDATE meta SET built_at = ?, schema_version = ?")
		.run(new Date().toISOString(), WRITER_CATALOG_SCHEMA_VERSION);
}

export function upsertTaskWriters(
	handle: WriterCatalogHandle,
	input: UpsertTaskWritersInput,
): void {
	const indexedAt = new Date().toISOString();
	handle.db.exec("BEGIN");
	try {
		handle.db
			.prepare("DELETE FROM table_writers WHERE writer_task_id = ?")
			.run(input.taskId);
		const insertWriter = handle.db.prepare(`
      INSERT INTO table_writers (
        table_key, platform, data_source, qualified_name,
        writer_task_id, write_observation_id, write_kind,
        resolution_status, physical_dataset, partition_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
		for (const row of input.writes) {
			insertWriter.run(
				row.tableKey,
				row.platform,
				row.dataSource,
				row.qualifiedName,
				row.writerTaskId,
				row.writeObservationId,
				row.writeKind,
				row.resolutionStatus,
				row.physicalDataset,
				row.partitionJson,
			);
		}
		handle.db
			.prepare(`
        INSERT INTO task_coverage (
          task_id, task_category, task_content_hash,
          facts_manifest_sha256, facts_status, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          task_category = excluded.task_category,
          task_content_hash = excluded.task_content_hash,
          facts_manifest_sha256 = excluded.facts_manifest_sha256,
          facts_status = excluded.facts_status,
          indexed_at = excluded.indexed_at
      `)
			.run(
				input.taskId,
				input.taskCategory,
				input.taskContentHash,
				input.factsManifestSha256,
				input.factsStatus,
				indexedAt,
			);
		touchMeta(handle.db);
		handle.db.exec("COMMIT");
	} catch (error) {
		handle.db.exec("ROLLBACK");
		throw error;
	}
}

export function removeTaskWriters(
	handle: WriterCatalogHandle,
	taskId: string,
	factsStatus: "FAILED" | "MISSING" = "FAILED",
): void {
	const indexedAt = new Date().toISOString();
	handle.db.exec("BEGIN");
	try {
		handle.db
			.prepare("DELETE FROM table_writers WHERE writer_task_id = ?")
			.run(taskId);
		handle.db
			.prepare(`
        INSERT INTO task_coverage (
          task_id, task_category, task_content_hash,
          facts_manifest_sha256, facts_status, indexed_at
        ) VALUES (?, '', '', '', ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          facts_status = excluded.facts_status,
          indexed_at = excluded.indexed_at
      `)
			.run(taskId, factsStatus, indexedAt);
		touchMeta(handle.db);
		handle.db.exec("COMMIT");
	} catch (error) {
		handle.db.exec("ROLLBACK");
		throw error;
	}
}

function rowToHit(row: Record<string, unknown>): WriterHit {
	return {
		taskId: String(row.writer_task_id),
		writeObservationId: String(row.write_observation_id),
		table: {
			platform: String(row.platform),
			dataSource: String(row.data_source),
			qualifiedName: String(row.qualified_name),
		},
		writeKind: row.write_kind === null || row.write_kind === undefined
			? null
			: String(row.write_kind),
		resolutionStatus: row.resolution_status === null || row.resolution_status === undefined
			? null
			: String(row.resolution_status),
		physicalDataset: String(row.physical_dataset),
		partitionJson: row.partition_json === null || row.partition_json === undefined
			? null
			: String(row.partition_json),
	};
}

function coverageFromRow(row: Record<string, unknown>): TaskCoverageRow {
	return {
		taskId: String(row.task_id),
		taskCategory: String(row.task_category ?? ""),
		taskContentHash: String(row.task_content_hash ?? ""),
		factsManifestSha256: String(row.facts_manifest_sha256 ?? ""),
		factsStatus: String(row.facts_status ?? ""),
		indexedAt: String(row.indexed_at ?? ""),
	};
}

export function writersForTable(
	handle: WriterCatalogHandle,
	table: ProducerTableIdentity,
): WriterHit[] {
	const rows = handle.db
		.prepare(
			`SELECT * FROM table_writers WHERE table_key = ? ORDER BY writer_task_id, write_observation_id`,
		)
		.all(tableKey(table)) as Record<string, unknown>[];
	return rows.map(rowToHit);
}

export function writersForQualifiedName(
	handle: WriterCatalogHandle,
	qualifiedName: string,
): WriterHit[] {
	const normalized = normalizeName(qualifiedName).toLowerCase();
	const rows = handle.db
		.prepare(
			`SELECT * FROM table_writers
       WHERE lower(qualified_name) = ?
       ORDER BY writer_task_id, write_observation_id`,
		)
		.all(normalized) as Record<string, unknown>[];
	return rows.map(rowToHit);
}

export function hasConfirmedWriter(
	handle: WriterCatalogHandle,
	table: ProducerTableIdentity,
): boolean {
	const row = handle.db
		.prepare("SELECT 1 AS present FROM table_writers WHERE table_key = ? LIMIT 1")
		.get(tableKey(table)) as { present: number } | undefined;
	return row?.present === 1;
}

export function writerCatalogPort(handle: WriterCatalogHandle): WriterCatalogPort {
	return {
		writersForTable: (table) => writersForTable(handle, table),
		writersForQualifiedName: (qualifiedName) =>
			writersForQualifiedName(handle, qualifiedName),
		hasConfirmedWriter: (table) => hasConfirmedWriter(handle, table),
	};
}

export function writersForTask(
	handle: WriterCatalogHandle,
	taskId: string,
): WriterHit[] {
	const rows = handle.db
		.prepare(
			`SELECT * FROM table_writers WHERE writer_task_id = ? ORDER BY table_key, write_observation_id`,
		)
		.all(taskId) as Record<string, unknown>[];
	return rows.map(rowToHit);
}

export function taskCoverage(
	handle: WriterCatalogHandle,
	taskId: string,
): TaskCoverageRow | null {
	const row = handle.db
		.prepare("SELECT * FROM task_coverage WHERE task_id = ?")
		.get(taskId) as Record<string, unknown> | undefined;
	return row ? coverageFromRow(row) : null;
}

export function catalogCoverageCounts(
	handle: WriterCatalogHandle,
): CatalogCoverageCounts {
	const tasks = handle.db
		.prepare(
			`SELECT
        COUNT(*) AS indexed,
        SUM(CASE WHEN facts_status != 'SUCCESS' THEN 1 ELSE 0 END) AS failed
       FROM task_coverage`,
		)
		.get() as { indexed: number; failed: number | null };
	const writers = handle.db
		.prepare(
			`SELECT COUNT(*) AS writer_rows, COUNT(DISTINCT table_key) AS distinct_tables
       FROM table_writers`,
		)
		.get() as { writer_rows: number; distinct_tables: number };
	return {
		tasksIndexed: Number(tasks.indexed),
		tasksFailed: Number(tasks.failed ?? 0),
		writerRows: Number(writers.writer_rows),
		distinctTables: Number(writers.distinct_tables),
	};
}

export function catalogFingerprint(handle: WriterCatalogHandle): string {
	const writers = handle.db
		.prepare(
			`SELECT table_key, writer_task_id, write_observation_id, write_kind, physical_dataset
       FROM table_writers
       ORDER BY table_key, writer_task_id, write_observation_id`,
		)
		.all();
	const coverage = handle.db
		.prepare(
			`SELECT task_id, task_content_hash, facts_manifest_sha256, facts_status
       FROM task_coverage
       ORDER BY task_id`,
		)
		.all();
	return sha256(JSON.stringify({ writers, coverage }));
}

export function writerTaskIdsByQualifiedName(
	handle: WriterCatalogHandle,
): Map<string, string[]> {
	const rows = handle.db
		.prepare(
			`SELECT lower(qualified_name) AS qualified_name, writer_task_id
       FROM table_writers
       ORDER BY qualified_name, writer_task_id`,
		)
		.all() as { qualified_name: string; writer_task_id: string }[];
	const result = new Map<string, string[]>();
	for (const row of rows) {
		const key = String(row.qualified_name);
		const taskId = String(row.writer_task_id);
		const existing = result.get(key);
		if (existing) {
			if (!existing.includes(taskId)) existing.push(taskId);
		} else result.set(key, [taskId]);
	}
	return result;
}

function readTaskPackMeta(
	taskPath: string,
): { readonly taskCategory: string; readonly contentHash: string } | null {
	try {
		const document = JSON.parse(readFileSync(taskPath, "utf8")) as {
			readonly taskCategory?: unknown;
			readonly contentHash?: unknown;
		};
		return {
			taskCategory: nonEmpty(document.taskCategory) ?? "",
			contentHash: nonEmpty(document.contentHash) ?? "",
		};
	} catch {
		return null;
	}
}

/** Packs live at `tasks/<category>/<taskId>/task.json` (legacy: `tasks/<taskId>/`). */
function indexTaskPackMeta(
	dataRoot: string,
): ReadonlyMap<string, { readonly taskCategory: string; readonly contentHash: string }> {
	const tasksRoot = join(resolve(dataRoot), "tasks");
	const index = new Map<string, { taskCategory: string; contentHash: string }>();
	if (!existsSync(tasksRoot)) return index;
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name === "task.json") {
				const id = basename(dirname(path));
				if (!id || !SAFE_TASK_ID.test(id)) continue;
				const meta = readTaskPackMeta(path);
				if (meta) index.set(id, meta);
			}
		}
	};
	visit(tasksRoot);
	return index;
}

function manifestTaskContentHash(manifest: Record<string, unknown>): string | null {
	const inputs = manifest.inputs;
	if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs))
		return null;
	const inputPack = (inputs as Record<string, unknown>).input_pack;
	if (typeof inputPack !== "object" || inputPack === null || Array.isArray(inputPack))
		return null;
	return nonEmpty((inputPack as Record<string, unknown>).task_content_hash);
}

function syncTaskFromFactsBundle(input: {
	readonly handle: WriterCatalogHandle;
	readonly packMeta: ReadonlyMap<
		string,
		{ readonly taskCategory: string; readonly contentHash: string }
	>;
	readonly factsRoot: string;
	readonly taskId: string;
}): "SUCCESS" | "FAILED" | "MISSING" {
	const taskRoot = join(resolve(input.factsRoot), "registry", "tasks", input.taskId);
	const bundleDir = join(taskRoot, "bundle");
	const statusPath = join(taskRoot, "status.json");
	if (!existsSync(statusPath)) {
		removeTaskWriters(input.handle, input.taskId, "MISSING");
		return "MISSING";
	}
	let status: Record<string, unknown>;
	try {
		status = JSON.parse(readFileSync(statusPath, "utf8")) as Record<string, unknown>;
	} catch {
		removeTaskWriters(input.handle, input.taskId);
		return "FAILED";
	}
	if (status.state !== "SUCCESS") {
		removeTaskWriters(input.handle, input.taskId);
		return "FAILED";
	}
	const manifestPath = join(bundleDir, "manifest.json");
	if (!existsSync(manifestPath)) {
		removeTaskWriters(input.handle, input.taskId);
		return "FAILED";
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
	const manifestSha256 = sha256(JSON.stringify(manifest));
	const datasetIoPath = join(bundleDir, "dataset-io.jsonl");
	const records = readJsonlRecords(datasetIoPath) as DatasetIoRecord[];
	const pack = input.packMeta.get(input.taskId);
	const taskCategory = pack?.taskCategory ?? "";
	upsertTaskWriters(input.handle, {
		taskId: input.taskId,
		taskCategory,
		taskContentHash:
			manifestTaskContentHash(manifest) ?? pack?.contentHash ?? "",
		factsManifestSha256: manifestSha256,
		factsStatus: "SUCCESS",
		writes: catalogWritersFromDatasetIo({
			taskId: input.taskId,
			taskCategory,
			records,
		}),
	});
	return "SUCCESS";
}

export function backfillWriterCatalogFromFacts(options: {
	readonly dataRoot: string;
	readonly factsRoot: string;
	readonly catalogPath?: string;
}): { tasks: number; writers: number } {
	const catalogPath = resolve(
		options.catalogPath ?? defaultWriterCatalogPath(options.dataRoot),
	);
	assertOutputOutsideDataRoot(resolve(options.dataRoot), catalogPath);
	const handle = openWriterCatalog(catalogPath);
	const packMeta = indexTaskPackMeta(options.dataRoot);
	const tasksRoot = join(resolve(options.factsRoot), "registry", "tasks");
	if (!existsSync(tasksRoot)) {
		return { tasks: 0, writers: 0 };
	}
	let tasks = 0;
	for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !SAFE_TASK_ID.test(entry.name)) continue;
		const outcome = syncTaskFromFactsBundle({
			handle,
			packMeta,
			factsRoot: options.factsRoot,
			taskId: entry.name,
		});
		if (outcome !== "MISSING") tasks += 1;
	}
	const writers = (
		handle.db.prepare("SELECT COUNT(*) AS count FROM table_writers").get() as {
			count: number;
		}
	).count;
	return { tasks, writers };
}

export function resolveWriterCatalogPath(
	dataRoot: string,
	options: {
		readonly writerCatalogPath?: string;
		readonly producerIndexRoot?: string;
	} = {},
): string {
	if (options.writerCatalogPath) return resolve(options.writerCatalogPath);
	if (options.producerIndexRoot) {
		const legacyRoot = resolve(options.producerIndexRoot);
		if (legacyRoot.endsWith(".sqlite")) return legacyRoot;
	}
	return defaultWriterCatalogPath(dataRoot);
}

export function syncWriterCatalogAfterMachineFacts(input: {
	readonly handle: WriterCatalogHandle;
	readonly taskId: string;
	readonly taskCategory: string;
	readonly taskContentHash: string;
	readonly taskResult: {
		readonly state: "SUCCESS" | "FAILED";
		readonly manifest_sha256?: string;
	};
	readonly factsRoot: string;
}): void {
	if (input.taskResult.state !== "SUCCESS") {
		removeTaskWriters(input.handle, input.taskId);
		return;
	}
	const bundleDir = join(
		resolve(input.factsRoot),
		"registry",
		"tasks",
		input.taskId,
		"bundle",
	);
	const records = readJsonlRecords(join(bundleDir, "dataset-io.jsonl")) as DatasetIoRecord[];
	upsertTaskWriters(input.handle, {
		taskId: input.taskId,
		taskCategory: input.taskCategory,
		taskContentHash: input.taskContentHash,
		factsManifestSha256: input.taskResult.manifest_sha256 ?? "",
		factsStatus: "SUCCESS",
		writes: catalogWritersFromDatasetIo({
			taskId: input.taskId,
			taskCategory: input.taskCategory,
			records,
		}),
	});
}
