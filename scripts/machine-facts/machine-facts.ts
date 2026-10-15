import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolveWorkspacePaths } from "../config/workspace-paths.ts";

import { Schema, SqlSession, type SchemaMapping } from "sqllens";
import { describeStandardizedSql } from "../input/shared/standardized-sql.ts";
import { extractSqlWrites } from "../evidence/sql-write-evidence.ts";
import { buildPlanFacts, EXPRESSION_DEPENDENCY_ADAPTER_VERSION } from "../plans/plan-adapter.ts";
import { applySourceSemantics } from "../plans/source-semantics.ts";
import type { PlanFacts } from "../plans/plan-contract.ts";
import { maskWithInsertTargetForParser, sanitizeSqlForParser } from "../plans/parser-sql-input.ts";
import { deriveOutputFieldBindings, type WriteOutputContext } from "./output-field-bindings.ts";
import { qualifyBareTableName } from "../reconcile/shared/task-default-schema.ts";
import { readCreateTableHeader } from "../plans/ddl-schema.ts";
import { globalRelationId } from "./plan-occurrence-id.ts";
import { globalizePlanScopeBindings } from "./plan-scope-bindings.ts";
import {
	fileHash as runtimeFileHash,
	publishArtifactBundle,
	recoverArtifactState,
	writeCanonical as runtimeWriteCanonical,
	writeCanonicalJsonl,
} from "./machine-facts-runtime.ts";
import { hashJsonlStore, inspectJsonlStore, jsonlStoreExists, readJsonlRecords } from "./jsonl-store.ts";
import { loadMachineFactsIndex } from "./machine-facts-index-reader.ts";
import {
	MACHINE_FACTS_ADAPTER_VERSION,
	MACHINE_FACTS_CONTRACT_VERSION,
	MACHINE_FACTS_STATUS_VERSION,
	PACK_DECLARED_QUERY_OUTPUT,
	canonicalJson,
	canonicalJsonl,
	datasetId,
	fieldId,
	normalizeName,
	safeSegment,
	sha256,
	stableRecords,
	stripVolatile,
	type AnalysisStatus,
	type FailureOutcome,
	type GenericAnalysisProfile,
	type GenericTaskProfile,
	type MachineFactsManifest,
	type OutcomeClass,
	type StatementRecord,
	type SchemaReferenceRecord,
	type DatasetIoRecord,
	type TaskLocalMaterializationRecord,
	type TaskLocalControlReadRef,
	type RelationNodeRecord,
	type RelationEdgeRecord,
	type FieldExpressionRecord,
	type InputDependencyStatus,
	type ColumnLineageRecord,
	type OutputFieldBindingRecord,
	type UnknownOutcomeRecord,
	type SourceArtifactRecord,
	type TaskFactIndexRecord,
} from "./machine-facts-contract.ts";

type JsonRecord = Record<string, any>;
type SourceSpan = { start: number; end: number };
type SchemaAvailability = ReadonlySet<string> | Pick<Schema, "columnsFor">;

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function equivalentQueryOutputSignature(
	expressions: readonly FieldExpressionRecord[],
): string {
	return canonicalJson(
		expressions
			.map((expression) => ({
				ordinal: expression.ordinal,
				output_name: expression.output_name ?? null,
				output_name_status: expression.output_name_status ?? null,
				expression_text: expression.expression_text,
				input_fields: expression.input_fields,
				candidate_input_fields: expression.candidate_input_fields ?? [],
				unresolved_input_columns: expression.unresolved_input_columns,
			}))
			.sort((left, right) => left.ordinal - right.ordinal),
	);
}

function dedupeEquivalentQueryOutputs<T extends {
	readonly statementIndex: number;
	readonly expressions: readonly FieldExpressionRecord[];
}>(candidates: readonly T[]): T[] {
	const seen = new Set<string>();
	return [...candidates]
		.sort((left, right) => left.statementIndex - right.statementIndex)
		.filter((candidate) => {
			const signature = equivalentQueryOutputSignature(candidate.expressions);
			if (seen.has(signature)) return false;
			seen.add(signature);
			return true;
		});
}

function hasSchemaTable(table: string, available: SchemaAvailability, dialect: string): boolean {
	const provider = available as Partial<Pick<Schema, "columnsFor">>;
	if (typeof provider.columnsFor === "function") {
		const columns = provider.columnsFor.call(available, normalizeName(table).split("."), dialect);
		return Array.isArray(columns) && columns.length > 0;
	}
	return (available as ReadonlySet<string>).has(normalizeName(table));
}

export interface TaskRunResult {
	task_id: string;
	state: "SUCCESS" | "FAILED";
	status: "CREATED" | "REUSED" | "REPLACED" | "FAILED";
	manifest_sha256?: string;
	failures: FailureOutcome[];
}

export interface ProfileRunResult {
	output_root: string;
	tasks: TaskRunResult[];
	index: { path: string; count: number; failures: string[] };
}

/**
 * `auto` is the operational default: preserve a structurally readable index
 * and update the Tasks in the current batch. Full reconstruction is reserved
 * for recovery and explicit integrity sweeps.
 */
export type MachineFactsIndexMode = "auto" | "full" | "incremental";

export interface IncrementalIndexOptions {
	readonly taskResults: readonly TaskRunResult[];
}

export interface MachineFactsIndexRefreshResult {
	readonly index: ProfileRunResult["index"];
	readonly requestedMode: MachineFactsIndexMode;
	readonly appliedMode: "full" | "incremental";
	/** Full validates every bundle; incremental validates the index rows it reuses. */
	readonly verificationScope: "FULL" | "STRUCTURAL_ONLY";
	readonly fallbackReason?: "INDEX_MISSING" | "INDEX_UNREADABLE" | "INDEX_INVALID";
}

const REQUIRED_DATASETS = [
	"statements.jsonl",
	"schema-refs.jsonl",
	"dataset-io.jsonl",
	"relation-nodes.jsonl",
	"relation-edges.jsonl",
	"field-expression-nodes.jsonl",
	"column-lineage-edges.jsonl",
	"lineage-hop-roots.jsonl",
	"lineage-hop-nodes.jsonl",
	"lineage-hop-edges.jsonl",
	"output-field-bindings.jsonl",
	"unknowns.jsonl",
] as const;

const workspace = resolve(import.meta.dirname, "../..");

function json<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeCanonical(path: string, value: unknown): void {
	runtimeWriteCanonical(path, value);
}

function writeJsonl(path: string, records: readonly unknown[]): { row_count: number; content_sha256: string } {
	return writeCanonicalJsonl(path, records);
}

function fileHash(path: string): string {
	return runtimeFileHash(path);
}

function rootForBundle(bundleDir: string): string {
	return resolve(bundleDir, "../../../..");
}

function relativeRoot(root: string, path: string): string {
	return relative(root, path).replace(/\\/g, "/");
}

function safeTask(task: GenericTaskProfile): void {
	safeSegment(task.task_id, "task_id");
	if (!task.sql_snapshot || typeof task.sql_snapshot !== "string") throw new Error(`task ${task.task_id} has no SQL snapshot`);
}

function normalizeWrites(task: GenericTaskProfile): string[] {
	if (!task.writes) return [];
	return (Array.isArray(task.writes) ? [...task.writes] : [task.writes]).filter(Boolean).map(normalizeName);
}

function sameTableReference(left: string, right: string): boolean {
	const normalizedLeft = normalizeName(left);
	const normalizedRight = normalizeName(right);
	return normalizedLeft === normalizedRight ||
		normalizedLeft.split(".").at(-1) === normalizedRight.split(".").at(-1);
}

function skipLeadingSqlTrivia(text: string): string {
	let index = 0;
	while (index < text.length) {
		const char = text[index]!;
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (text.startsWith("--", index)) {
			const newline = text.indexOf("\n", index);
			index = newline < 0 ? text.length : newline + 1;
			continue;
		}
		if (text.startsWith("/*", index)) {
			const end = text.indexOf("*/", index + 2);
			index = end < 0 ? text.length : end + 2;
			continue;
		}
		break;
	}
	return text.slice(index);
}

function classifyStatement(text: string): string {
	const normalized = skipLeadingSqlTrivia(text).toUpperCase();
	if (/^CREATE\s+(?:(?:OR\s+REPLACE|EXTERNAL|TEMPORARY|TEMP)\s+)*TABLE\b/.test(normalized)) return "CREATE_TABLE";
	const extractedWrite = extractSqlWrites(text)[0];
	if (extractedWrite?.writeKind === "INSERT_OVERWRITE") return "INSERT_OVERWRITE";
	if (extractedWrite?.writeKind === "INSERT_INTO") return "INSERT_INTO";
	if (extractedWrite?.writeKind === "MERGE_INTO") return "MERGE_INTO";
	if (normalized.startsWith("WITH")) return "WITH_QUERY";
	if (normalized.startsWith("SELECT")) return "SELECT";
	return "OTHER";
}

function parseSqlWrite(text: string): string | null {
	const match = text.match(
		/^\s*(?:CREATE\s+(?:(?:OR\s+REPLACE|EXTERNAL|TEMPORARY|TEMP)\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|INSERT\s+(?:OVERWRITE|INTO)\s+(?:TABLE\s+)?|MERGE\s+INTO\s+)([A-Za-z0-9_`".\-]+)/i,
	);
	if (match?.[1]) return normalizeName(match[1]);
	// Use the comment/string-aware extractor for DML that is preceded by a CTE.
	// This keeps a literal or comment containing INSERT from becoming a write.
	return extractSqlWrites(text).find((write) => write.writeKind !== "CTAS")?.qualifiedName ?? null;
}

function resolveDeclaredWriteTarget(task: GenericTaskProfile, target: string): string {
	const normalizedTarget = normalizeName(target);
	const declared = normalizeWrites(task);
	const exact = declared.filter((candidate) => candidate === normalizedTarget);
	if (exact.length === 1) return exact[0]!;
	// A bare SQL target is resolved to the task's physical target only when the
	// declaration supplies one unambiguous same-tail identity. Qualified SQL
	// names remain untouched unless they match exactly.
	if (normalizedTarget.split(".").length === 1) {
		const sameTail = declared.filter((candidate) => sameTableReference(candidate, normalizedTarget));
		if (sameTail.length === 1) return sameTail[0]!;
		const defaultSchema = normalizeName(task.default_schema ?? "");
		if (defaultSchema) return `${defaultSchema}.${normalizedTarget}`;
	}
	return normalizedTarget;
}

function resolveBareReadTarget(task: GenericTaskProfile, logicalSourceId: string, table: string): string {
	const normalized = normalizeName(table);
	const defaultSchema = normalizeName(task.default_schema ?? "");
	if (!normalized || !defaultSchema || !logicalSourceId.toLowerCase().startsWith("hive-"))
		return normalized;
	return qualifyBareTableName(normalized, {
		schema: defaultSchema,
		evidenceSources: ["TASK_NAME"],
	});
}

function spanValid(span: unknown, text: string): span is SourceSpan {
	return (
		typeof span === "object" && span !== null &&
		Number.isInteger((span as SourceSpan).start) && Number.isInteger((span as SourceSpan).end) &&
		(span as SourceSpan).start >= 0 && (span as SourceSpan).end >= (span as SourceSpan).start &&
		(span as SourceSpan).end <= text.length
	);
}

function globalizeRelation(taskId: string, statementIndex: number, relation: JsonRecord): JsonRecord {
	const mapId = (id: string): string => globalRelationId(taskId, statementIndex, id);
	const converted = stripVolatile(relation) as JsonRecord;
	converted.id = mapId(relation.id);
	if (relation.type === "read") {
		converted.read_occurrence_id = mapId(String(relation.read_occurrence_id ?? relation.id));
		if (converted.read_occurrence && typeof converted.read_occurrence === "object") {
			const occurrence = converted.read_occurrence as JsonRecord;
			occurrence.occurrence_id = converted.read_occurrence_id;
			occurrence.relation_id = converted.id;
		}
	}
	if (relation.source) converted.source = mapId(relation.source);
	if (relation.left) converted.left = mapId(relation.left);
	if (relation.right) converted.right = mapId(relation.right);
	if (relation.branches) converted.branches = relation.branches.map(mapId);
	return converted;
}

function schemaRecordQuality(record: JsonRecord): [number, number, number, string] {
	return [
		record.status === "SUCCESS" ? 1 : 0,
		Array.isArray(record.columns) ? record.columns.length : 0,
		typeof record.ddl === "string" && record.ddl.length > 0 ? 1 : 0,
		canonicalJson(record),
	];
}

function isBetterSchemaRecord(candidate: JsonRecord, current: JsonRecord | undefined): boolean {
	if (!current) return true;
	const left = schemaRecordQuality(candidate);
	const right = schemaRecordQuality(current);
	for (let i = 0; i < left.length - 1; i++) {
		if (left[i] !== right[i]) return left[i] > right[i];
	}
	return left[left.length - 1] < right[right.length - 1];
}

export function mergeSchemaEvidence(raws: readonly JsonRecord[], logicalSourceId: string): JsonRecord {
	const byQualifiedName = new Map<string, JsonRecord>();
	for (const raw of raws) {
		const records = Array.isArray(raw.records) ? raw.records : [];
		for (const record of records) {
			if (!record || typeof record !== "object") continue;
			const candidate = stripVolatile(record) as JsonRecord;
			const qualifiedName = String(candidate.qualified_name ?? `${candidate.db ?? ""}.${candidate.table ?? ""}`).trim();
			if (!qualifiedName || qualifiedName === ".") continue;
			const key = normalizeName(qualifiedName);
			if (isBetterSchemaRecord(candidate, byQualifiedName.get(key))) byQualifiedName.set(key, candidate);
		}
	}
	return {
		schema_version: "machine-facts-schema-bundle-v1",
		logical_source_id: logicalSourceId,
		records: stableRecords([...byQualifiedName.values()], (record) => normalizeName(String(record.qualified_name ?? `${record.db ?? ""}.${record.table ?? ""}`))),
	};
}

function schemaProjection(raw: JsonRecord, logicalSourceId: string): JsonRecord {
	return mergeSchemaEvidence([raw], logicalSourceId);
}

/**
 * Schema evidence is task-scoped. A batch-level evidence file is an input
 * catalog, not proof that every task reads every table in that catalog.
 * Discover the physical inputs without a schema so missing evidence remains
 * visible instead of being hidden by an unrelated global snapshot.
 */
function taskSchemaNames(task: GenericTaskProfile, profile: GenericAnalysisProfile): Set<string> | null {
	try {
		const sql = readFileSync(resolve(workspace, task.sql_snapshot), "utf8");
		const parserSql = sanitizeSqlForParser(sql);
		const planSql = sanitizeSqlForParser(maskWithInsertTargetForParser(parserSql.sql));
		const session = SqlSession.create(parserSql.sql, profile.dialect as any);
		const planSession = SqlSession.create(planSql.sql, profile.dialect as any);
		const names = new Set(normalizeWrites(task));
		for (const [statementIndex, cell] of session.doc.statements.entries()) {
			const rawSql = sql.slice(cell.span.start, cell.span.end);
			const write = parseSqlWrite(rawSql);
			if (write) names.add(write);
			const plan = parserSql.restore(
				buildPlanFacts(planSession.doc.statements[statementIndex] ?? cell, planSql.sql, {
					statement_index: statementIndex,
					dialect: profile.dialect,
					include_expression_dependencies: true,
				}),
			);
			for (const table of plan.physical_inputs) names.add(normalizeName(table));
		}
		return names;
	} catch {
		// A schema-free discovery failure must not narrow evidence and create
		// artificial Unknowns. The normal task analysis will retain its own
		// parser/failure evidence.
		return null;
	}
}

function schemaBundleForTask(
	globalSchemaBundle: JsonRecord,
	task: GenericTaskProfile,
	profile: GenericAnalysisProfile,
): JsonRecord {
	const names = taskSchemaNames(task, profile);
	if (names === null) return globalSchemaBundle;
	const records = (globalSchemaBundle.records as JsonRecord[]).filter((record) => {
		const qualifiedName = String(record.qualified_name ?? `${record.db ?? ""}.${record.table ?? ""}`).trim();
		return names.has(normalizeName(qualifiedName));
	});
	return mergeSchemaEvidence([{ records }], String(globalSchemaBundle.logical_source_id));
}

function schemaProvider(schemaBundle: JsonRecord): Schema {
	const mapping: SchemaMapping = {};
	const addTable = (qualifiedName: string, table: SchemaMapping): void => {
		const parts = qualifiedName.split(".").filter(Boolean);
		if (parts.length === 0) return;
		let namespace = mapping;
		for (const part of parts.slice(0, -1)) {
			const current = namespace[part];
			if (typeof current !== "object" || current === null || "nullable" in current) namespace[part] = {};
			namespace = namespace[part] as SchemaMapping;
		}
		namespace[parts[parts.length - 1]!] = table;
	};
	for (const record of schemaBundle.records as JsonRecord[]) {
		if (record.status !== "SUCCESS" || !Array.isArray(record.columns) || !record.qualified_name) continue;
		const table: SchemaMapping = Object.fromEntries(
			record.columns.map((column: JsonRecord) => [String(column.name), "unknown"]),
		);
		addTable(String(record.qualified_name), table);
		for (const alias of Array.isArray(record.aliases) ? record.aliases : []) addTable(String(alias), table);
	}
	return new Schema(mapping);
}

function outputColumns(relation: JsonRecord): JsonRecord[] {
	if (relation.type === "project") return Array.isArray(relation.expressions) ? relation.expressions : [];
	if (relation.type === "aggregate") return Array.isArray(relation.measures) ? relation.measures : [];
	return [];
}

export function inputDependencyStatus(expression: JsonRecord): InputDependencyStatus {
	const inputs = Array.isArray(expression.input_columns) ? expression.input_columns as JsonRecord[] : [];
	const hasPhysical = inputs.some((input) => input.resolution === "PHYSICAL" && Array.isArray(input.physical) && input.physical.length > 0);
	const hasDerived = inputs.some((input) => input.resolution === "DERIVED_OUTPUT");
	const hasSqlCandidate = inputs.some((input) => input.resolution === "SQL_CANDIDATE" && Array.isArray(input.sql_candidate) && input.sql_candidate.length > 0);
	const hasUnresolved = inputs.some((input) => input.resolution !== "PHYSICAL" && input.resolution !== "DERIVED_OUTPUT" && input.resolution !== "SQL_CANDIDATE");
	if (hasPhysical && (hasUnresolved || hasDerived || hasSqlCandidate)) return "PARTIAL";
	if (hasPhysical) return "PHYSICAL";
	if (hasSqlCandidate && !hasUnresolved && !hasDerived) return "SQL_CANDIDATE";
	if (hasSqlCandidate) return "PARTIAL";
	if (hasDerived && hasUnresolved) return "PARTIAL";
	if (hasDerived) return "DERIVED_OUTPUT";
	if (inputs.length > 0) return "UNRESOLVED";
	return "NO_PHYSICAL_INPUT";
}

function physicalTablesIn(value: unknown, result = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) physicalTablesIn(item, result);
		return result;
	}
	if (!value || typeof value !== "object") return result;
	const object = value as JsonRecord;
	if (Array.isArray(object.physical)) {
		for (const physical of object.physical as JsonRecord[]) {
			if (physical && typeof physical.table === "string") result.add(normalizeName(physical.table));
		}
	}
	if (object.type === "read" && typeof object.table === "string") result.add(normalizeName(object.table));
	for (const [key, child] of Object.entries(object)) if (key !== "physical") physicalTablesIn(child, result);
	return result;
}

function unresolvedInputColumns(expression: JsonRecord): JsonRecord[] {
	const inputs = Array.isArray(expression.input_columns) ? expression.input_columns as JsonRecord[] : [];
	return inputs
		.filter((input) => input.resolution !== "PHYSICAL" && input.resolution !== "DERIVED_OUTPUT" && input.resolution !== "SQL_CANDIDATE")
		.map((input) => ({
			name: input.name ?? null,
			qualifier: input.qualifier ?? null,
			resolution: input.resolution ?? "UNRESOLVED",
		}));
}

function fieldInputsForRefs(logicalSourceId: string, refs: readonly JsonRecord[]): { inputFields: JsonRecord[]; candidateFields: JsonRecord[] } {
	const physical: JsonRecord[] = [];
	const candidates: JsonRecord[] = [];
	for (const input of refs) {
		for (const origin of input.physical ?? []) {
			if (input.resolution !== "PHYSICAL") continue;
			physical.push({
				field_id: fieldId(logicalSourceId, origin.table, origin.column),
				table: normalizeName(origin.table),
				column: normalizeName(origin.column),
			});
		}
		for (const candidate of input.sql_candidate ?? []) {
			candidates.push({
				field_id: fieldId(logicalSourceId, candidate.table, candidate.column),
				table: normalizeName(candidate.table),
				column: normalizeName(candidate.column),
				binding_status: "UNVERIFIED_SCHEMA",
			});
		}
	}
	return {
		inputFields: [...new Map(physical.map((item) => [item.field_id, item])).values()],
		candidateFields: [...new Map(candidates.map((item) => [item.field_id, item])).values()],
	};
}

function windowSpecRecord(logicalSourceId: string, expression: JsonRecord): JsonRecord | undefined {
	const spec = expression.window_spec as JsonRecord | undefined;
	if (!spec || !Array.isArray(spec.input_bindings)) return undefined;
	const frame = spec.frame as JsonRecord | undefined;
	return {
		expression_text: spec.expression_text ?? "",
		display_text: spec.display_text ?? "",
		source_span: spec.source_span ?? null,
		input_bindings: (spec.input_bindings as JsonRecord[]).map((binding) => {
			const refs = Array.isArray(binding.input_columns) ? binding.input_columns : [];
			const fields = fieldInputsForRefs(logicalSourceId, refs);
			return {
				role: binding.role,
				ordinal: binding.ordinal,
				expression_text: binding.expression_text ?? "",
				display_text: binding.display_text ?? "",
				source_span: binding.span ?? null,
				input_fields: fields.inputFields,
				candidate_input_fields: fields.candidateFields,
				unresolved_input_columns: unresolvedInputColumns({ input_columns: refs }),
				input_dependency_status: inputDependencyStatus({ input_columns: refs }),
				...(binding.role === "WINDOW_ORDER"
					? { direction: binding.direction ?? "ASC", nulls: binding.nulls ?? "UNSPECIFIED" }
					: {}),
			};
		}),
		...(frame
			? {
				frame: {
					status: frame.status ?? "UNKNOWN",
					expression_text: frame.expression_text ?? null,
					display_text: frame.display_text ?? null,
					source_span: frame.span ?? null,
					input_fields: fieldInputsForRefs(logicalSourceId, Array.isArray(frame.input_columns) ? frame.input_columns : []).inputFields,
					unresolved_input_columns: unresolvedInputColumns({ input_columns: Array.isArray(frame.input_columns) ? frame.input_columns : [] }),
					input_dependency_status: inputDependencyStatus({ input_columns: Array.isArray(frame.input_columns) ? frame.input_columns : [] }),
					...(frame.reason ? { reason: frame.reason } : {}),
				},
			}
			: {}),
	};
}

export function relationNeedsMissingSchema(
	nodeId: string,
	relations: readonly JsonRecord[],
	availableSchemaNames: SchemaAvailability,
	visiting = new Set<string>(),
	dialect = "databricks",
): boolean {
	if (visiting.has(nodeId)) return true;
	const relation = relations.find((candidate) => candidate.id === nodeId);
	if (!relation) return true;
	if (relation.type === "read") {
		if (relation.is_cte) return false;
		return !hasSchemaTable(String(relation.table ?? ""), availableSchemaNames, dialect);
	}
	const nextVisiting = new Set(visiting).add(nodeId);
	const inputs = [relation.source, relation.left, relation.right, ...(Array.isArray(relation.branches) ? relation.branches : [])].filter(Boolean) as string[];
	return inputs.some((input) => relationNeedsMissingSchema(input, relations, availableSchemaNames, nextVisiting, dialect));
}

function classifyPlanUnknown(
	item: JsonRecord,
	relation: JsonRecord | undefined,
	statementType: string,
	availableSchemaNames: SchemaAvailability,
	relations: readonly JsonRecord[],
	dialect: string,
): { outcome_class: OutcomeClass; reason_code: string } {
	const expressions = outputColumns(relation ?? {});
	const schemaAvailable = relation ? !relationNeedsMissingSchema(String(relation.id), relations, availableSchemaNames, new Set<string>(), dialect) : false;
	if (item.field === "physical") {
		if (String(item.reason ?? "").includes("schema 快照缺少字段证据")) {
			return { outcome_class: "NOT_EVALUABLE", reason_code: "SCHEMA_BINDING_NOT_EVALUABLE" };
		}
		if (String(item.reason ?? "").includes("followColumn 无来源")) {
			return { outcome_class: "UNKNOWN", reason_code: "PHYSICAL_FIELD_UNRESOLVED" };
		}
		return schemaAvailable
			? { outcome_class: "UNKNOWN", reason_code: "PHYSICAL_FIELD_UNRESOLVED" }
			: { outcome_class: "NOT_EVALUABLE", reason_code: "SCHEMA_BINDING_NOT_EVALUABLE" };
	}
	if (item.field === "output_columns") {
		if (statementType === "CREATE_TABLE" && expressions.length === 0) {
			return { outcome_class: "NOT_APPLICABLE", reason_code: "NON_QUERY_OUTPUT_NOT_APPLICABLE" };
		}
		if (!schemaAvailable) {
			return { outcome_class: "NOT_EVALUABLE", reason_code: "SCHEMA_BINDING_NOT_EVALUABLE" };
		}
		if (expressions.some((expression) => expression.output === "*" || expression.output_name_status === "STAR_EXPANSION")) {
			return { outcome_class: "UNKNOWN", reason_code: "STAR_EXPANSION_UNRESOLVED" };
		}
		if (expressions.some((expression) => expression.output === "?" || expression.output_name_status === "ANONYMOUS_EXPRESSION")) {
			return { outcome_class: "UNKNOWN", reason_code: "ANONYMOUS_OUTPUT_NAME_UNRESOLVED" };
		}
	}
	return { outcome_class: "UNKNOWN", reason_code: "PLAN_FACT_UNRESOLVED" };
}

const SQL_CANDIDATE_SAFE_RESOLUTIONS = new Set(["PHYSICAL", "SQL_CANDIDATE", "DERIVED_OUTPUT"]);

/**
 * A missing table schema does not by itself make a SQL dependency unevaluable.
 * If every column-bearing part of the plan is already bound physically or by
 * an unambiguous SQL candidate, the writer can preserve the dependency as
 * UNVERIFIED_SCHEMA. Keep the schema gap as NOT_EVALUABLE when a star or an
 * unresolved predicate/condition prevents that representation.
 */
function canRepresentMissingSchemaAsSqlCandidate(
	missingTables: readonly string[],
	relations: readonly JsonRecord[],
): boolean {
	const missing = new Set(missingTables.map((table) => normalizeName(table)));
	const candidateTables = new Set<string>();
	let safe = true;

	const visit = (value: unknown): void => {
		if (!safe || value === null || value === undefined) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object") return;
		const object = value as JsonRecord;
		if (object.output === "*" || object.output_name_status === "STAR_EXPANSION") safe = false;
		if (typeof object.resolution === "string") {
			if (!SQL_CANDIDATE_SAFE_RESOLUTIONS.has(object.resolution)) safe = false;
			if (object.resolution === "SQL_CANDIDATE" && Array.isArray(object.sql_candidate)) {
				for (const candidate of object.sql_candidate as JsonRecord[]) {
					if (typeof candidate.table === "string") candidateTables.add(normalizeName(candidate.table));
				}
			}
		}
		for (const child of Object.values(object)) visit(child);
	};

	for (const relation of relations) visit(relation);
	return safe && missing.size > 0 && [...missing].every((table) => candidateTables.has(table));
}

function makeFailure(outcome_class: OutcomeClass, reason_code: string, message: string, subject?: string): FailureOutcome {
	return { outcome_class, reason_code, message, ...(subject ? { subject } : {}) };
}

function contextHash(task: GenericTaskProfile, profile: GenericAnalysisProfile, logicalSourceId: string): string {
	return sha256(canonicalJson({
		contract_version: MACHINE_FACTS_CONTRACT_VERSION,
		adapter_version: MACHINE_FACTS_ADAPTER_VERSION,
		plan_adapter_version: EXPRESSION_DEPENDENCY_ADAPTER_VERSION,
		logical_source_id: logicalSourceId,
		dialect: profile.dialect,
		declared_outputs: normalizeWrites(task),
		sql_slot: task.sql_slot ?? null,
		input_pack_provenance: task.input_pack_provenance ?? null,
		...(task.source_sql_family ? { source_sql_family: task.source_sql_family } : {}),
		...(task.standardized_input ? { standardized_input: task.standardized_input } : {}),
		platform_target_query_output: task.platform_target_query_output ?? null,
		write_partition_evidence: task.write_partition_evidence ?? null,
		sql_write_partition_evidence: task.sql_write_partition_evidence ?? null,
		include_expression_dependencies: true,
	}));
}

function writeStatus(taskRoot: string, status: AnalysisStatus): void {
	const path = join(taskRoot, "analysis-status.json");
	const temp = `${path}.tmp`;
	const backup = `${path}.bak`;
	if (existsSync(backup)) throw new Error("RECOVERY_REQUIRED: stale analysis-status backup exists");
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

function readStatus(taskRoot: string): AnalysisStatus | null {
	const path = join(taskRoot, "analysis-status.json");
	return existsSync(path) ? json<AnalysisStatus>(path) : null;
}

function readCurrentManifestHash(taskRoot: string): string | null {
	try {
		return readStatus(taskRoot)?.current_manifest_sha256 ?? null;
	} catch {
		return null;
	}
}

function recoverTaskState(taskRoot: string): void {
	recoverArtifactState(taskRoot, validateBundle);
}

function snapshot(root: string, kind: "sql" | "schema", hash: string, bytes: Buffer): string {
	const path = join(root, "snapshots", kind, `${hash}.${kind === "sql" ? "sql" : "json"}`);
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) {
		if (fileHash(path) !== hash) throw new Error(`snapshot hash collision: ${relativeRoot(root, path)}`);
	} else {
		writeFileSync(path, bytes);
	}
	return relativeRoot(root, path);
}

function planRecords(
	task: GenericTaskProfile,
	logicalSourceId: string,
	sql: string,
	plan: PlanFacts,
	statementId: string,
	statementIndex: number,
	statementType: string,
	availableSchemaNames: SchemaAvailability,
	dialect: string,
	artifactId: string,
): {
	relations: RelationNodeRecord[];
	relationEdges: RelationEdgeRecord[];
	fields: FieldExpressionRecord[];
	lineage: ColumnLineageRecord[];
	unknowns: UnknownOutcomeRecord[];
	reads: DatasetIoRecord[];
} {
	const relations: JsonRecord[] = [];
	const relationEdges: JsonRecord[] = [];
	const fields: JsonRecord[] = [];
	const lineage: JsonRecord[] = [];
	const unknowns: JsonRecord[] = [];
	const reads: JsonRecord[] = [];
	const planRelations = plan.relations as JsonRecord[];
	const planScopeBindings = globalizePlanScopeBindings(plan, task.task_id, statementIndex);
	const relationIds = new Set(plan.relations.map((relation) => globalRelationId(task.task_id, statementIndex, relation.id)));

	for (const table of plan.physical_inputs) {
		const physicalDataset = resolveBareReadTarget(task, logicalSourceId, table);
		const readOccurrences = planRelations
			.filter((relation) => relation.type === "read" && relation.is_cte !== true && normalizeName(String(relation.table ?? "")) === normalizeName(table))
			.map((relation) => ({
				occurrence_id: globalRelationId(task.task_id, statementIndex, String(relation.read_occurrence_id ?? relation.id)),
				relation_id: globalRelationId(task.task_id, statementIndex, String(relation.id)),
				scope_id: relation.scope_id ?? null,
				source_span: relation.read_occurrence?.source_span ?? relation.span ?? null,
			}));
		reads.push({
			task_id: task.task_id,
			statement_id: statementId,
			direction: "READ",
			dataset_id: datasetId(logicalSourceId, physicalDataset),
			physical_dataset: physicalDataset,
			provenance: "SQL_PLAN",
			resolution_status: "RESOLVED",
			read_occurrences: readOccurrences,
		});
	}

	for (const item of plan.unknowns) {
		const relation = planRelations.find((candidate) => candidate.id === item.node_id);
		const classification = classifyPlanUnknown(item as JsonRecord, relation, statementType, availableSchemaNames, planRelations, dialect);
		unknowns.push({
			unknown_id: `unknown:${task.task_id}:${statementIndex}:${unknowns.length}`,
			task_id: task.task_id,
			statement_id: statementId,
			subject: item.node_id,
			outcome_class: classification.outcome_class,
			reason_code: classification.reason_code,
			message: item.reason,
			source_locator: item.span ?? null,
			artifact_id: artifactId,
		});
	}

	const explicitPhysicalUnknowns = new Set(
		(plan.unknowns as JsonRecord[])
			.filter((item) => item.field === "physical")
			.map((item) => String(item.node_id)),
	);
	for (const relation of planRelations) {
		const missingTables = [...physicalTablesIn(relation)].filter((table) => !hasSchemaTable(table, availableSchemaNames, dialect));
		const explicitPhysicalUnknown = explicitPhysicalUnknowns.has(String(relation.id));
		const candidateBinding = missingTables.length > 0 && !explicitPhysicalUnknown && canRepresentMissingSchemaAsSqlCandidate(missingTables, planRelations);
		if (missingTables.length > 0 && !candidateBinding && !explicitPhysicalUnknown) {
			unknowns.push({
				unknown_id: `unknown:${task.task_id}:${statementIndex}:${unknowns.length}`,
				task_id: task.task_id,
				statement_id: statementId,
				subject: relation.id,
				outcome_class: "NOT_EVALUABLE",
				reason_code: "SCHEMA_BINDING_NOT_EVALUABLE",
				message: `physical references lack schema evidence: ${missingTables.join(", ")}`,
				source_locator: relation.span ?? null,
				artifact_id: artifactId,
			});
		}
	}

	for (const localRelation of plan.relations as JsonRecord[]) {
		const relation = globalizeRelation(task.task_id, statementIndex, localRelation);
		const scopeBindings = planScopeBindings.get(localRelation.id);
		if (scopeBindings?.length) relation.scope_bindings = scopeBindings;
		const relationId = relation.id as string;
		const sourceSpan = relation.span as SourceSpan;
		const node: JsonRecord = {
			relation_id: relationId,
			task_id: task.task_id,
			statement_id: statementId,
			relation_type: relation.type,
			source_span: sourceSpan,
			source_text: spanValid(sourceSpan, sql) ? sql.slice(sourceSpan.start, sourceSpan.end) : null,
			provenance: relation.provenance === "extracted" ? "SQL_PLAN" : "PARTIAL_SQL_PLAN",
			relation,
		};
		relations.push(node);
		const refs = [relation.source, relation.left, relation.right, ...(relation.branches ?? [])].filter(Boolean) as string[];
		for (const ref of refs) {
			relationEdges.push({
				edge_id: `relation-edge:${ref}:${relationId}`,
				task_id: task.task_id,
				statement_id: statementId,
				from_relation_id: ref,
				to_relation_id: relationId,
				edge_type: "RELATION_INPUT",
				provenance: "SQL_PLAN",
				source_span: relation.span,
			});
			if (!relationIds.has(ref)) {
				unknowns.push(makeFailure("FAILURE", "RELATION_ENDPOINT_MISSING", `relation endpoint ${ref} is missing`, relationId));
			}
		}

		for (const [role, expressions] of [["PROJECT_EXPRESSION", relation.type === "project" ? outputColumns(relation) : []], ["AGGREGATE_MEASURE", relation.type === "aggregate" ? outputColumns(relation) : []]] as const) {
			for (const [ordinal, expression] of expressions.entries()) {
				const expressionId = `${relationId}:expression:${role.toLowerCase()}:${ordinal}`;
				const expressionSpan = expression.span as SourceSpan;
				const effectiveInputRefs = [...(expression.input_columns ?? [])];
				const fieldsForExpression = fieldInputsForRefs(logicalSourceId, effectiveInputRefs);
				const uniqueInputs = fieldsForExpression.inputFields;
				const uniqueCandidates = fieldsForExpression.candidateFields;
				const planInputIds = new Set(fieldInputsForRefs(logicalSourceId, expression.input_columns ?? []).inputFields.map((input) => input.field_id));
				fields.push({
					expression_id: expressionId,
					task_id: task.task_id,
					statement_id: statementId,
					relation_id: relationId,
					role,
					ordinal,
					output_name: expression.output,
					output_name_status: expression.output_name_status ?? "UNKNOWN",
					expression_text: expression.expr_text,
					display_text: expression.display_text ?? expression.expr_text,
					source_span: expressionSpan,
					input_fields: uniqueInputs,
					candidate_input_fields: uniqueCandidates,
					unresolved_input_columns: unresolvedInputColumns(expression),
					input_dependency_status: inputDependencyStatus({ input_columns: effectiveInputRefs }),
					expression_roles: (expression.expression_roles as JsonRecord[] | undefined)?.map((role) => {
						const roleRefs = Array.isArray(role.input_columns) ? role.input_columns : [];
						const roleFields = fieldInputsForRefs(logicalSourceId, roleRefs);
						return {
							operator: role.operator,
							role: role.role,
							effects: role.effects ?? [],
							path: role.path,
							...(role.branch_ordinal === undefined ? {} : { branch_ordinal: role.branch_ordinal }),
							ordinal: role.ordinal,
							expression_text: role.expression_text,
							display_text: role.display_text ?? role.expression_text,
							source_span: role.span,
							input_fields: roleFields.inputFields,
							candidate_input_fields: roleFields.candidateFields,
							unresolved_input_columns: unresolvedInputColumns({ input_columns: roleRefs }),
							input_dependency_status: inputDependencyStatus({ input_columns: roleRefs }),
						};
					}),
					window_spec: windowSpecRecord(logicalSourceId, expression),
					artifact_id: artifactId,
				});
				for (const input of uniqueInputs) {
					lineage.push({
						edge_id: `lineage:${input.field_id}:${expressionId}`,
						task_id: task.task_id,
						statement_id: statementId,
						from_field_id: input.field_id,
						to_expression_id: expressionId,
						method: "SQL_PLAN_LINEAGE",
						resolution_provenance: "SCHEMA_BOUND",
					});
				}
				for (const input of uniqueCandidates) {
					lineage.push({
						edge_id: `lineage-candidate:${input.field_id}:${expressionId}`,
						task_id: task.task_id,
						statement_id: statementId,
						from_field_id: input.field_id,
						to_expression_id: expressionId,
						method: "SQL_SINGLE_SOURCE_BINDING",
						resolution_provenance: "SQL_SYNTAX_NO_SCHEMA",
						resolution_status: "UNVERIFIED_SCHEMA",
					});
				}
			}
		}
	}

	// A set operation owns the output ordinal consumed by INSERT/CTAS even
	// though the parser records concrete expressions on its leaf branches.
	// Project the union of each branch ordinal's physical origins onto a stable
	// SETOP_OUTPUT expression without pretending that one branch is primary.
	const relationNodeById = new Map(relations.map((node) => [String(node.relation_id), node]));
	const leafRelationIds = (relationId: string, active = new Set<string>()): string[] => {
		if (active.has(relationId)) return [];
		const node = relationNodeById.get(relationId);
		if (!node || node.relation_type !== "setop") return [relationId];
		const nextActive = new Set([...active, relationId]);
		return (Array.isArray(node.relation?.branches) ? node.relation.branches : [])
			.flatMap((branch: string) => leafRelationIds(String(branch), nextActive));
	};
	for (const node of relations.filter((candidate) => candidate.relation_type === "setop")) {
		const outputNames = Array.isArray(node.relation?.output_columns) ? node.relation.output_columns.map(String) : [];
		const leaves = new Set(leafRelationIds(String(node.relation_id)));
		for (const [ordinal, outputName] of outputNames.entries()) {
			const branchExpressions = fields.filter((field) => leaves.has(String(field.relation_id)) && field.ordinal === ordinal);
			if (branchExpressions.length === 0) continue;
			const inputFields = [...new Map(branchExpressions.flatMap((field) => field.input_fields ?? []).map((field: JsonRecord) => [String(field.field_id), field])).values()];
			const candidateFields = [...new Map(branchExpressions.flatMap((field) => field.candidate_input_fields ?? []).map((field: JsonRecord) => [String(field.field_id), field])).values()];
			const unresolvedColumns = branchExpressions.flatMap((field) => field.unresolved_input_columns ?? []);
			const expressionId = `${String(node.relation_id)}:expression:setop_output:${ordinal}`;
			const dependencyStatus: InputDependencyStatus = inputFields.length > 0
				? candidateFields.length > 0 || unresolvedColumns.length > 0 ? "PARTIAL" : "PHYSICAL"
				: candidateFields.length > 0 ? "SQL_CANDIDATE"
					: unresolvedColumns.length > 0 ? "UNRESOLVED" : "NO_PHYSICAL_INPUT";
			fields.push({
				expression_id: expressionId,
				task_id: task.task_id,
				statement_id: statementId,
				relation_id: node.relation_id,
				role: "SETOP_OUTPUT",
				ordinal,
				output_name: outputName,
				output_name_status: "EXPLICIT",
				expression_text: `${String(node.relation?.setop ?? "setop").toUpperCase()}_OUTPUT(${outputName})`,
				display_text: `${String(node.relation?.setop ?? "setop").toUpperCase()}_OUTPUT(${outputName})`,
				source_span: node.source_span,
				input_fields: inputFields,
				candidate_input_fields: candidateFields,
				unresolved_input_columns: unresolvedColumns,
				input_dependency_status: dependencyStatus,
				artifact_id: artifactId,
			});
			for (const input of inputFields)
				lineage.push({
					edge_id: `lineage:${String(input.field_id)}:${expressionId}`,
					task_id: task.task_id,
					statement_id: statementId,
					from_field_id: input.field_id,
					to_expression_id: expressionId,
					method: "SQL_SETOP_BRANCH_LINEAGE",
					resolution_provenance: "SCHEMA_BOUND",
				});
		}
	}

	return {
		relations: relations as RelationNodeRecord[],
		relationEdges: relationEdges as RelationEdgeRecord[],
		fields: fields as FieldExpressionRecord[],
		lineage: lineage as ColumnLineageRecord[],
		unknowns: unknowns as UnknownOutcomeRecord[],
		reads: reads as DatasetIoRecord[],
	};
}

function validateJsonSchema(value: unknown, schema: JsonRecord, path = "$", errors: string[] = []): string[] {
	const type = schema.type as string | string[] | undefined;
	const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
	const matchesType = (expected: string): boolean => expected === "integer" ? actual === "number" && Number.isInteger(value) : actual === expected;
	if (type && (Array.isArray(type) ? !type.some(matchesType) : !matchesType(type))) {
		errors.push(`${path}: expected ${Array.isArray(type) ? type.join("|") : type}, got ${actual}`);
		return errors;
	}
	if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected const ${String(schema.const)}`);
	if (schema.pattern && typeof value === "string" && !(new RegExp(String(schema.pattern))).test(value)) errors.push(`${path}: pattern mismatch`);
	if (Array.isArray(value)) {
		if (schema.items) value.forEach((item, index) => validateJsonSchema(item, schema.items as JsonRecord, `${path}[${index}]`, errors));
		return errors;
	}
	if (actual !== "object" || value === null) return errors;
	const object = value as JsonRecord;
	for (const required of (schema.required ?? []) as string[]) if (!(required in object)) errors.push(`${path}: missing required property ${required}`);
	const properties = (schema.properties ?? {}) as JsonRecord;
	for (const [key, childSchema] of Object.entries(properties)) if (key in object) validateJsonSchema(object[key], childSchema as JsonRecord, `${path}.${key}`, errors);
	return errors;
}

function manifestContext(manifest: MachineFactsManifest): JsonRecord {
	return { schema_version: manifest.schema_version, task_id: manifest.task_id, logical_source_id: manifest.logical_source_id, inputs: manifest.inputs, method: manifest.method };
}

function outputPath(bundleDir: string, path: string): string | null {
	const resolved = resolve(bundleDir, path);
	const relativePath = relative(bundleDir, resolved).replace(/\\/g, "/");
	return relativePath === path && !path.startsWith("/") && !path.includes("..") ? resolved : null;
}

function snapshotReference(root: string, reference: string, kind: "sql" | "schema", hash: string): string | null {
	const extension = kind === "sql" ? "sql" : "json";
	const expected = `snapshots/${kind}/${hash}.${extension}`;
	if (reference !== expected || !/^[a-f0-9]{64}$/.test(hash)) return null;
	const resolved = resolve(root, reference);
	return relative(root, resolved).replace(/\\/g, "/") === reference ? resolved : null;
}

export function validateBundle(bundleDir: string): string[] {
	const errors: string[] = [];
	const manifestPath = join(bundleDir, "manifest.json");
	if (!existsSync(manifestPath)) return ["manifest.json is missing"];
	let manifest: MachineFactsManifest;
	try {
		manifest = json<MachineFactsManifest>(manifestPath);
	} catch (error) {
		return [`manifest.json is invalid: ${error instanceof Error ? error.message : String(error)}`];
	}
	if (!manifest.inputs || typeof manifest.inputs !== "object" || !manifest.method || typeof manifest.method !== "object" || !Array.isArray(manifest.outputs)) {
		errors.push("manifest structural fields are invalid");
		return [...new Set(errors)];
	}
	try {
		const schemaPath = join(workspace, "schemas", "machine-facts.schema.json");
		const schemaErrors = validateJsonSchema(manifest, json<JsonRecord>(schemaPath));
		for (const error of schemaErrors) errors.push(`manifest schema: ${error}`);
	} catch (error) {
		errors.push(`manifest schema validation failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	let recordSchemas: JsonRecord = {};
	try {
		recordSchemas = (json<JsonRecord>(join(workspace, "schemas", "machine-facts-records.schema.json")).properties ?? {}) as JsonRecord;
	} catch (error) {
		errors.push(`record schema validation failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (manifest.schema_version !== MACHINE_FACTS_CONTRACT_VERSION) errors.push("unsupported manifest schema_version");
	if (manifest.status !== "SUCCESS") errors.push("manifest status is not SUCCESS");
	for (const output of manifest.outputs ?? []) {
		if (!output || typeof output !== "object" || typeof output.path !== "string" || typeof output.content_sha256 !== "string" || !Number.isInteger(output.row_count)) {
			errors.push("manifest output record is structurally invalid");
			continue;
		}
		const path = outputPath(bundleDir, output.path);
		if (!path) {
			errors.push(`unsafe output path ${output.path}`);
			continue;
		}
		const stored = inspectJsonlStore(path);
		if (stored.status === "CONFLICT") {
			errors.push(`jsonl store conflict ${output.path}`);
			continue;
		}
		if (stored.status === "MISSING") {
			errors.push(`missing output ${output.path}`);
			continue;
		}
		if (hashJsonlStore(path) !== output.content_sha256) errors.push(`hash mismatch ${output.path}`);
		try {
			const rows = readJsonlRecords(path);
			if (rows.length !== output.row_count) errors.push(`row count mismatch ${output.path}`);
			const recordSchema = recordSchemas[output.path] as JsonRecord | undefined;
			if (!recordSchema) errors.push(`record schema missing ${output.path}`);
			else rows.forEach((row, index) => validateJsonSchema(row, recordSchema, `${output.path}[${index}]`, errors));
		} catch (error) {
			errors.push(`invalid JSONL ${output.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const required of REQUIRED_DATASETS) {
		if (!(manifest.outputs ?? []).some((output) => output && typeof output === "object" && output.path === required)) errors.push(`required output not declared ${required}`);
	}
	const root = rootForBundle(bundleDir);
	const sqlPath = snapshotReference(root, manifest.inputs.sql_snapshot, "sql", manifest.inputs.sql_sha256);
	if (!sqlPath || !existsSync(sqlPath) || fileHash(sqlPath) !== manifest.inputs.sql_sha256) errors.push("SQL snapshot is missing, unsafe, or hash-mismatched");
	const schemaPath = snapshotReference(root, manifest.inputs.schema_snapshot, "schema", manifest.inputs.schema_bundle_sha256);
	if (!schemaPath || !existsSync(schemaPath) || fileHash(schemaPath) !== manifest.inputs.schema_bundle_sha256) errors.push("Schema snapshot is missing, unsafe, or hash-mismatched");
	const sourceArtifactPath = join(bundleDir, "source-artifact.json");
	if (!existsSync(sourceArtifactPath)) errors.push("source-artifact.json is missing");
	else {
		try {
			const sourceArtifact = json<JsonRecord>(sourceArtifactPath);
			const sourceSchema = recordSchemas["source-artifact.json"] as JsonRecord | undefined;
			if (sourceSchema) for (const error of validateJsonSchema(sourceArtifact, sourceSchema, "source-artifact.json")) errors.push(error);
			if (sourceArtifact.task_id !== manifest.task_id || sourceArtifact.logical_source_id !== manifest.logical_source_id || sourceArtifact.sql_sha256 !== manifest.inputs.sql_sha256 || sourceArtifact.sql_snapshot !== manifest.inputs.sql_snapshot) errors.push("source-artifact does not match manifest");
		} catch (error) {
			errors.push(`source-artifact.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const sql = sqlPath && existsSync(sqlPath) ? readFileSync(sqlPath, "utf8") : "";
	const statements = readJsonlForValidation(join(bundleDir, "statements.jsonl"), errors);
	const statementIds = new Set(statements.map((statement) => statement.statement_id));
	for (const statement of statements) {
		if (statement.task_id !== manifest.task_id) errors.push(`statement task isolation failed ${statement.statement_id}`);
	}
	for (const statement of statements) {
		if (!spanValid(statement.span, sql) || sql.slice(statement.span.start, statement.span.end) !== statement.raw_sql) {
			errors.push(`statement span roundtrip failed ${statement.statement_id}`);
		}
	}
	const relationNodes = readJsonlForValidation(join(bundleDir, "relation-nodes.jsonl"), errors);
	const relationIds = new Set(relationNodes.map((node) => node.relation_id));
	for (const edge of readJsonlForValidation(join(bundleDir, "relation-edges.jsonl"), errors)) {
		if (!relationIds.has(edge.from_relation_id) || !relationIds.has(edge.to_relation_id)) errors.push(`relation endpoint missing ${edge.edge_id}`);
	}
	const expressions = readJsonlForValidation(join(bundleDir, "field-expression-nodes.jsonl"), errors);
	const expressionIds = new Set(expressions.map((node) => node.expression_id));
	const fieldIds = new Set<string>();
	for (const expression of expressions) {
		for (const field of [...(expression.input_fields ?? []), ...(expression.candidate_input_fields ?? [])]) {
			if (field && typeof field.field_id === "string") fieldIds.add(field.field_id);
		}
	}
	for (const expression of expressions) if (!relationIds.has(expression.relation_id)) errors.push(`expression owner missing ${expression.expression_id}`);
	const columnLineage = readJsonlForValidation(join(bundleDir, "column-lineage-edges.jsonl"), errors);
	for (const edge of columnLineage) {
		if (!expressionIds.has(edge.to_expression_id)) errors.push(`lineage expression endpoint missing ${edge.edge_id}`);
	}
	const datasetIo = readJsonlForValidation(join(bundleDir, "dataset-io.jsonl"), errors);
	const unknownRecords = readJsonlForValidation(join(bundleDir, "unknowns.jsonl"), errors);
	const writeObservations = new Map(datasetIo.filter((record) => record.direction === "WRITE" && typeof record.write_observation_id === "string").map((record) => [record.write_observation_id, record]));
	const expectedInputPackSqlSha256 = typeof manifest.inputs.input_pack?.sql_sha256 === "string"
		? manifest.inputs.input_pack.sql_sha256
		: manifest.inputs.sql_sha256;
	for (const write of writeObservations.values()) {
		if (write.write_kind !== PACK_DECLARED_QUERY_OUTPUT) continue;
		if (write.provenance !== "PLATFORM_TARGET") errors.push(`pack-declared write provenance is invalid ${write.write_observation_id}`);
		if (typeof write.source_sql_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(write.source_sql_sha256)) {
			errors.push(`pack-declared write source SQL hash is invalid ${write.write_observation_id}`);
		} else if (write.source_sql_sha256 !== expectedInputPackSqlSha256) {
			errors.push(`pack-declared write source SQL hash does not match manifest ${write.write_observation_id}`);
		}
	}
	const bindingOrdinals = new Set<string>();
	const bindings = readJsonlForValidation(join(bundleDir, "output-field-bindings.jsonl"), errors);
	const materializationsPath = join(bundleDir, "task-local-materializations.jsonl");
	if (jsonlStoreExists(materializationsPath)) {
		const nodesById = new Map(relationNodes.map(node => [String(node.relation_id), node]));
		// Recover normalization only from paired relation/occurrence evidence, so
		// validation handles a task's qualified bare reads without tail matching.
		const provenReadTables = new Map<string, Set<string>>();
		for (const io of datasetIo.filter(record => record.direction === "READ")) {
			for (const occurrence of Array.isArray(io.read_occurrences) ? io.read_occurrences : []) {
				const read = nodesById.get(String(occurrence?.relation_id));
				if (!read || read.statement_id !== io.statement_id || read.relation?.read_occurrence_id !== occurrence?.occurrence_id) continue;
				const rawTable = normalizeName(String(read.relation?.table ?? ""));
				const identities = provenReadTables.get(rawTable) ?? new Set<string>();
				identities.add(normalizeName(String(io.physical_dataset)));
				provenReadTables.set(rawTable, identities);
			}
		}
		const qualifiedControlTable = (value: unknown): string => {
			const normalized = normalizeName(String(value ?? ""));
			const identities = provenReadTables.get(normalized);
			return identities?.size === 1 ? [...identities][0]! : normalized;
		};
		const provenControlUses = new Set(collectTaskLocalControlReads(relationNodes as RelationNodeRecord[], datasetIo as DatasetIoRecord[], qualifiedControlTable)
			.filter(use => use.ref.resolution_status === "RESOLVED")
			.map(use => `${use.statementId}\u0000${use.table}\u0000${use.column}\u0000${canonicalJson(use.ref)}`));
		for (const bridge of readJsonlForValidation(materializationsPath, errors)) {
			if (bridge.read_control_refs === undefined) continue; // Legacy bundles remain valid.
			if (!Array.isArray(bridge.read_control_refs)) continue; // Record schema reports this.
			const seenControlRefs = new Set<string>();
			for (const rawRef of bridge.read_control_refs) {
				if (rawRef === null || typeof rawRef !== "object") continue;
				const ref = rawRef as JsonRecord;
				const key = canonicalJson(ref);
				if (seenControlRefs.has(key)) errors.push(`duplicate materialization control reference ${bridge.bridge_id}`);
				seenControlRefs.add(key);
				const control = nodesById.get(String(ref.relation_id));
				if (!control || !["filter", "join"].includes(String(control.relation_type).toLowerCase()) || control.task_id !== bridge.task_id || control.statement_id !== bridge.read_statement_id) {
					errors.push(`materialization control owner mismatch ${bridge.bridge_id}`);
					continue;
				}
				if (ref.resolution_status !== "RESOLVED") {
					if (ref.read_relation_id !== null || ref.read_occurrence_id !== null || typeof ref.reason_code !== "string" || !ref.reason_code.trim()) errors.push(`unresolved materialization control must retain reason and null endpoints ${bridge.bridge_id}`);
					continue;
				}
				const read = nodesById.get(String(ref.read_relation_id));
				const reachable = scopedControlReadNodes(control as RelationNodeRecord, nodesById as Map<string, RelationNodeRecord>);
				const occurrences = datasetIo.filter(io => io.direction === "READ" && io.task_id === bridge.task_id && io.statement_id === bridge.read_statement_id && io.resolution_status === "RESOLVED" && normalizeName(String(io.physical_dataset)) === normalizeName(String(bridge.physical_dataset)))
					.flatMap(io => Array.isArray(io.read_occurrences) ? io.read_occurrences : [])
					.filter(occurrence => occurrence?.relation_id === ref.read_relation_id && occurrence?.occurrence_id === ref.read_occurrence_id);
				const useKey = `${bridge.read_statement_id}\u0000${normalizeName(String(bridge.physical_dataset))}\u0000${normalizeName(String(bridge.column))}\u0000${canonicalJson(ref)}`;
				if (!read || !reachable.some(node => node.relation_id === ref.read_relation_id) || read.relation?.read_occurrence_id !== ref.read_occurrence_id || typeof ref.read_occurrence_id !== "string" || !ref.read_occurrence_id || occurrences.length !== 1 || !provenControlUses.has(useKey)) {
					errors.push(`materialization control read occurrence not proven ${bridge.bridge_id}`);
				}
			}
		}
	}
	for (const binding of bindings) {
		if (!expressionIds.has(binding.expression_id)) errors.push(`output binding expression endpoint missing ${binding.binding_id}`);
		if (binding.binding_status !== "RESOLVED") errors.push(`output binding must be resolved ${binding.binding_id}`);
		if (!Number.isInteger(binding.source_ordinal) || !Number.isInteger(binding.target_ordinal)) errors.push(`output binding ordinal is invalid ${binding.binding_id}`);
		const write = writeObservations.get(binding.write_observation_id);
		if (!write) errors.push(`output binding write observation endpoint missing ${binding.binding_id}`);
		else {
			if (binding.task_id !== manifest.task_id || write.task_id !== manifest.task_id) errors.push(`output binding task isolation failed ${binding.binding_id}`);
			if (binding.write_kind !== write.write_kind || binding.write_statement_id !== write.write_statement_id || binding.statement_id !== write.statement_id || binding.query_producer_statement_id !== (write.query_producer_statement_id ?? null)) errors.push(`output binding write identity mismatch ${binding.binding_id}`);
			if (binding.evidence_kind === PACK_DECLARED_QUERY_OUTPUT) {
				if (typeof binding.source_sql_sha256 !== "string" || binding.source_sql_sha256 !== write.source_sql_sha256 || binding.source_sql_sha256 !== expectedInputPackSqlSha256) {
					errors.push(`pack-declared binding source SQL hash mismatch ${binding.binding_id}`);
				}
			}
			const ordinalKey = `${binding.write_observation_id}:${binding.source_ordinal}`;
			if (bindingOrdinals.has(ordinalKey)) errors.push(`duplicate output binding producer ordinal ${ordinalKey}`);
			bindingOrdinals.add(ordinalKey);
		}
	}
	for (const write of writeObservations.values()) {
		if (write.write_kind !== PACK_DECLARED_QUERY_OUTPUT) continue;
		const partitionColumns = Array.isArray(write.partition_columns)
			? write.partition_columns.map((column: unknown) => normalizeName(String(column)))
			: [];
		const staticPartitionColumns = Array.isArray(write.static_partition_columns)
			? write.static_partition_columns.map((column: unknown) => normalizeName(String(column)))
			: [];
		const dynamicPartitionColumns = Array.isArray(write.dynamic_partition_columns)
			? write.dynamic_partition_columns.map((column: unknown) => normalizeName(String(column)))
			: [];
		const assignmentFields = Array.isArray(write.partition_assignments)
			? write.partition_assignments.map((assignment: unknown) =>
				normalizeName(String(assignment && typeof assignment === "object" ? (assignment as JsonRecord).field ?? "" : "")),
			)
			: [];
		const writeBindings = bindings.filter((binding) => binding.write_observation_id === write.write_observation_id);
		const producerOrdinals = Array.isArray(write.producer_ordinals)
			? write.producer_ordinals.filter((ordinal: unknown): ordinal is number => Number.isInteger(ordinal))
			: [];
		const fullyBound = producerOrdinals.length > 0 && writeBindings.length === producerOrdinals.length;
		if (write.target_resolution_method !== "DIRECT_PLATFORM_TARGET" && write.target_resolution_method !== "SPARKINDEX_TASK_TARGET") {
			errors.push(`pack-declared target resolution method is invalid ${write.write_observation_id}`);
		}
		if (write.query_output_binding_contract !== "SPARKINDEX_FULL_WIDTH_POSITIONAL" && write.query_output_binding_contract !== "PLATFORM_TARGET_SCHEMA_POSITIONAL") {
			errors.push(`pack-declared query output binding contract is invalid ${write.write_observation_id}`);
		}
		if (!["STATIC", "DYNAMIC", "MIXED", "NONE", "UNKNOWN"].includes(write.partition_mode)) {
			errors.push(`pack-declared partition mode is invalid ${write.write_observation_id}`);
		}
		if (!["NOT_PARTITIONED", "COMPLETE", "INCOMPLETE", "UNKNOWN", "CONFLICT"].includes(write.partition_status)) {
			errors.push(`pack-declared partition status is invalid ${write.write_observation_id}`);
		}
		if (!["NOT_PARTITIONED", "COMPLETE", "INCOMPLETE", "UNKNOWN", "CONFLICT"].includes(write.partition_binding_status)) {
			errors.push(`pack-declared partition binding status is invalid ${write.write_observation_id}`);
		}
		if (write.partition_mode === "NONE") {
			if (partitionColumns.length > 0 || staticPartitionColumns.length > 0 || dynamicPartitionColumns.length > 0 || assignmentFields.length > 0) {
				errors.push(`non-partitioned pack-declared write carries partition columns ${write.write_observation_id}`);
			}
			if (write.partition_status !== "NOT_PARTITIONED" || write.partition_binding_status !== "NOT_PARTITIONED") {
				errors.push(`non-partitioned pack-declared write has inconsistent status ${write.write_observation_id}`);
			}
			continue;
		}
		if (write.partition_mode === "DYNAMIC" || write.partition_mode === "STATIC" || write.partition_mode === "MIXED") {
			if (
				(write.query_output_binding_contract === "SPARKINDEX_FULL_WIDTH_POSITIONAL" || assignmentFields.length > 0) &&
				JSON.stringify(assignmentFields) !== JSON.stringify(partitionColumns)
			) {
				errors.push(`pack-declared partition assignments do not match declared columns ${write.write_observation_id}`);
			}
			const classified = new Set([...staticPartitionColumns, ...dynamicPartitionColumns]);
			if (
				classified.size !== partitionColumns.length ||
				partitionColumns.some((column: string) => !classified.has(column)) ||
				staticPartitionColumns.some((column: string) => dynamicPartitionColumns.includes(column))
			) {
				errors.push(`pack-declared partition classification is inconsistent ${write.write_observation_id}`);
			}
			if (write.partition_mode === "DYNAMIC" && staticPartitionColumns.length > 0) errors.push(`dynamic pack-declared write carries static partitions ${write.write_observation_id}`);
			if (write.partition_mode === "STATIC" && dynamicPartitionColumns.length > 0) errors.push(`static pack-declared write carries dynamic partitions ${write.write_observation_id}`);
			if (write.partition_mode === "MIXED" && (staticPartitionColumns.length === 0 || dynamicPartitionColumns.length === 0)) errors.push(`mixed pack-declared write lacks both partition classes ${write.write_observation_id}`);
		}
		if (partitionColumns.length > 0 && fullyBound && write.partition_binding_status !== "COMPLETE") {
			errors.push(`fully bound pack-declared partition write is not COMPLETE ${write.write_observation_id}`);
		}
		const schedulerPartitionProven = write.partition_mode === "STATIC" &&
			JSON.stringify(assignmentFields) === JSON.stringify(partitionColumns) &&
			Array.isArray(write.partition_assignments) && write.partition_assignments.every((assignment: JsonRecord) =>
				assignment.mapping_method === "SCHEDULER_EXPLICIT_FIELD_VALUE" &&
				(assignment.status === "CONFIRMED" || assignment.status === "RUNTIME_EXPRESSION"));
		if (partitionColumns.length > 0 && !fullyBound && !schedulerPartitionProven && write.partition_binding_status === "COMPLETE") {
			errors.push(`unbound pack-declared partition write is incorrectly COMPLETE ${write.write_observation_id}`);
		}
	}
	for (const write of writeObservations.values()) {
		if (write.field_producing !== true) continue;
		const producerOrdinals = Array.isArray(write.producer_ordinals) ? write.producer_ordinals.filter((ordinal: unknown): ordinal is number => Number.isInteger(ordinal)) : [];
		const writeBindings = bindings.filter((binding) => binding.write_observation_id === write.write_observation_id);
		const writeGaps = unknownRecords.filter((unknown) => unknown.write_observation_id === write.write_observation_id && Array.isArray(unknown.uncovered_ordinals));
		const expected = new Set<number>();
		const dispositions = new Map<number, number>();
		for (const ordinal of producerOrdinals) {
			if (expected.has(ordinal)) errors.push(`duplicate producer ordinal ${write.write_observation_id}:${ordinal}`);
			expected.add(ordinal);
		}
		const addDisposition = (ordinal: number, source: string): void => {
			if (!expected.has(ordinal)) {
				errors.push(`disposition references unknown producer ordinal ${write.write_observation_id}:${ordinal}`);
				return;
			}
			dispositions.set(ordinal, (dispositions.get(ordinal) ?? 0) + 1);
			if ((dispositions.get(ordinal) ?? 0) > 1) errors.push(`producer ordinal has multiple dispositions ${write.write_observation_id}:${ordinal} (${source})`);
		};
		for (const binding of writeBindings) addDisposition(binding.source_ordinal, `binding:${binding.binding_id}`);
		for (const gap of writeGaps) for (const ordinal of gap.uncovered_ordinals as unknown[]) if (typeof ordinal === "number" && Number.isInteger(ordinal)) addDisposition(ordinal, `gap:${gap.unknown_id}`);
		for (const ordinal of expected) if ((dispositions.get(ordinal) ?? 0) !== 1) errors.push(`producer ordinal does not have exactly one disposition ${write.write_observation_id}:${ordinal}`);
		if (write.producer_enumeration_status === "NOT_EVALUABLE" && !unknownRecords.some((unknown) => unknown.write_observation_id === write.write_observation_id && unknown.reason_code === "PRODUCER_OUTPUT_ENUMERATION_NOT_EVALUABLE")) {
			errors.push(`field-producing Write lacks producer enumeration gap ${write.write_observation_id}`);
		}
	}
	return [...new Set(errors)];
}

function readJsonl(path: string): JsonRecord[] {
	if (!jsonlStoreExists(path)) return [];
	return readJsonlRecords(path);
}

function readJsonlForValidation(path: string, errors: string[]): JsonRecord[] {
	try {
		const stored = inspectJsonlStore(path);
		if (stored.status === "CONFLICT") {
			errors.push(`jsonl store conflict ${basename(path)}`);
			return [];
		}
		return readJsonl(path);
	} catch (error) {
		errors.push(`invalid JSONL ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function publishBundle(taskRoot: string, staging: string, manifest: MachineFactsManifest): { status: "CREATED" | "REUSED" | "REPLACED"; manifest_sha256: string } {
	const bundle = join(taskRoot, "bundle");
	return publishArtifactBundle({
		root: taskRoot,
		staging,
		bundle,
		manifest,
		validateBundle,
		manifestContext: (value) => manifestContext(value as MachineFactsManifest),
	});
}

function reusableTaskResult(
	taskRoot: string,
	taskId: string,
	logicalSourceId: string,
	requested: AnalysisStatus["requested"],
): TaskRunResult | null {
	const status = readStatus(taskRoot);
	if (
		status === null ||
		status.state !== "SUCCESS" ||
		status.task_id !== taskId ||
		status.logical_source_id !== logicalSourceId ||
		status.current_manifest_sha256 === null
	) return null;
	if (
		status.requested.sql_sha256 !== requested.sql_sha256 ||
		status.requested.schema_bundle_sha256 !== requested.schema_bundle_sha256 ||
		status.requested.analysis_config_sha256 !== requested.analysis_config_sha256 ||
		status.requested.dialect !== requested.dialect
	) return null;
	const bundle = join(taskRoot, "bundle");
	const manifestPath = join(bundle, "manifest.json");
	if (!existsSync(manifestPath)) return null;
	let manifest: MachineFactsManifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MachineFactsManifest;
	} catch {
		return null;
	}
	if (
		validateBundle(bundle).length > 0 ||
		manifest.task_id !== taskId ||
		manifest.logical_source_id !== logicalSourceId ||
		manifest.inputs.sql_sha256 !== requested.sql_sha256 ||
		manifest.inputs.schema_bundle_sha256 !== requested.schema_bundle_sha256 ||
		manifest.inputs.analysis_config_sha256 !== requested.analysis_config_sha256 ||
		manifest.method.dialect !== requested.dialect
	) return null;
	const manifestHash = sha256(canonicalJson(manifest));
	if (manifestHash !== status.current_manifest_sha256) return null;
	return { task_id: taskId, state: "SUCCESS", status: "REUSED", manifest_sha256: manifestHash, failures: [] };
}

function buildTaskBundle(
	task: GenericTaskProfile,
	profile: GenericAnalysisProfile,
	logicalSourceId: string,
	root: string,
	schemaBundle: JsonRecord,
	schemaBundleHash: string,
): { staging: string; manifest: MachineFactsManifest } {
	safeTask(task);
	const sqlPath = resolve(workspace, task.sql_snapshot);
	const sqlBytes = readFileSync(sqlPath);
	const sql = sqlBytes.toString("utf8");
	const sqlHash = sha256(sqlBytes);
	const sourceSqlSha256 = task.input_pack_provenance?.sql_sha256 ?? sqlHash;
	const sqlSnapshot = snapshot(root, "sql", sqlHash, sqlBytes);
	const schemaBytes = Buffer.from(canonicalJson(schemaBundle), "utf8");
	const schemaSnapshot = snapshot(root, "schema", schemaBundleHash, schemaBytes);
	const staging = join(root, "registry", "tasks", task.task_id, `.staging-${process.pid}-${Date.now()}`);
	mkdirSync(staging, { recursive: true });
	const schema = schemaProvider(schemaBundle);
	const sourceArtifact: SourceArtifactRecord = {
		schema_version: "machine-facts-source-artifact-v1",
		task_id: task.task_id,
		logical_source_id: logicalSourceId,
		sql_snapshot: sqlSnapshot,
		sql_sha256: sqlHash,
		byte_length: sqlBytes.length,
		encoding: "UTF-8",
		...(task.sql_slot ? { sql_slot: task.sql_slot } : {}),
		...(task.sql_segments ? { sql_segments: task.sql_segments } : {}),
	};
	writeCanonical(join(staging, "source-artifact.json"), sourceArtifact);

	const statements: StatementRecord[] = [];
	const datasetIo: DatasetIoRecord[] = [];
	const relations: RelationNodeRecord[] = [];
	const relationEdges: RelationEdgeRecord[] = [];
	const expressions: FieldExpressionRecord[] = [];
	const lineage: ColumnLineageRecord[] = [];
	const hopRoots: JsonRecord[] = [];
	const hopNodes: JsonRecord[] = [];
	const hopEdges: JsonRecord[] = [];
	const outputBindings: OutputFieldBindingRecord[] = [];
	const unknowns: UnknownOutcomeRecord[] = [];
	const writeContexts: WriteOutputContext[] = [];
	const queryOutputCandidates: Array<{
		readonly statementId: string;
		readonly statementIndex: number;
		readonly statementSlot?: string;
		readonly statementType: string;
		readonly rawSql: string;
		readonly expressions: readonly FieldExpressionRecord[];
	}> = [];
	const schemaRefs: SchemaReferenceRecord[] = (schemaBundle.records as JsonRecord[]).map((record, index) => ({
		schema_ref_id: `schema-ref:${logicalSourceId}:${index}`,
		logical_source_id: logicalSourceId,
		qualified_name: record.qualified_name ?? null,
		guid: record.guid ?? null,
		status: record.status ?? "UNKNOWN",
		source: record.source ?? null,
		metadata_qualified_name: record.metadata_qualified_name ?? null,
		ddl_sha256: record.ddl_sha256 ?? null,
		table_status: record.table_status ?? null,
		required_for_star: record.required_for_star === true,
		physical_columns: Array.isArray(record.columns) ? record.columns.map((column: JsonRecord) => column.name).filter(Boolean) : [],
		partition_columns: Array.isArray(record.columns)
			? record.columns.filter((column: JsonRecord) => column.partition === true).map((column: JsonRecord) => String(column.name)).filter(Boolean)
			: [],
	}));
	let parserVersion = "unknown";
	let planAdapterVersion = "unknown";
	const parserSql = sanitizeSqlForParser(sql);
	const planSql = sanitizeSqlForParser(maskWithInsertTargetForParser(parserSql.sql));
	const session = SqlSession.create(parserSql.sql, profile.dialect as any, { schema });
	const planSession = SqlSession.create(planSql.sql, profile.dialect as any, { schema });
	const segmentOrdinals = new Map<string, number>();
	for (const [statementIndex, cell] of session.doc.statements.entries()) {
		const span = { start: cell.span.start, end: cell.span.end };
		const rawSql = sql.slice(span.start, span.end);
		if (rawSql.trim().length === 0) continue;
		let significantStart = span.start;
		while (significantStart < span.end && /\s/.test(sql[significantStart] ?? "")) significantStart += 1;
		const segment = task.sql_segments?.find((candidate) => significantStart >= candidate.start && span.end <= candidate.end);
		const localOrdinal = segment ? (segmentOrdinals.get(segment.slot) ?? 0) : statementIndex;
		if (segment) segmentOrdinals.set(segment.slot, localOrdinal + 1);
		if (/^DROP\s+TABLE\b/i.test(rawSql.trimStart())) continue;
		const statementSlot = segment?.slot ?? task.sql_slot;
		const statementId = statementSlot
			? `task:${task.task_id}:slot:${statementSlot}:statement:${localOrdinal}`
			: `task:${task.task_id}:statement:${statementIndex}`;
		const configuration = task.standardized_input?.configurations.find(item => item.ordinal === statementIndex);
		if (configuration) {
			const verified = profile.dialect === "databricks" ? describeStandardizedSql(rawSql, "databricks")[0]?.configuration : null;
			if (!verified || verified.key !== configuration.key || verified.value !== configuration.value) throw new Error("STANDARDIZED_CONFIGURATION_INVALID");
			if (cell.errors > 0 || configuration.start !== span.start || configuration.end !== span.end ||
				sha256(rawSql.replace(/\r\n?/g, "\n").trim()) !== configuration.statementSha256) throw new Error("STANDARDIZED_STATEMENT_MISMATCH");
			statements.push({ statement_id: statementId, task_id: task.task_id, statement_index: statementIndex,
				statement_type: "SET_CONFIGURATION", span, raw_sql: rawSql, parse_status: "SUCCESS", diagnostic: cell.diagnostics,
				field_analysis: "NOT_APPLICABLE", configuration: { key: configuration.key, value: configuration.value },
				standardized_input_sha256: task.standardized_input!.artifactSha256 });
			continue;
		}
		const statementWrites = extractSqlWrites(rawSql);
		if (statementWrites.length > 1) {
			throw new Error(
				`MULTI_WRITE_STATEMENT_UNSUPPORTED:${task.task_id}:${statementId}:${statementWrites
					.map((write) => write.qualifiedName)
					.join(",")}`,
			);
		}
		const parsedWrite = parseSqlWrite(rawSql);
		const extractedWrite = parsedWrite === null
			? undefined
			: extractSqlWrites(rawSql).find((write) => sameTableReference(write.qualifiedName, parsedWrite));
		const writeTarget = parsedWrite === null ? null : resolveDeclaredWriteTarget(task, parsedWrite);
		const statementType = classifyStatement(rawSql);
		const plan: PlanFacts = parserSql.restore(buildPlanFacts(applySourceSemantics(planSession.doc.statements[statementIndex] ?? cell, task.source_sql_family, statementSlot), planSql.sql, {
			statement_index: statementIndex,
			dialect: profile.dialect,
			schema,
			include_expression_dependencies: true,
		}));
		const hasActionableUnknown = plan.unknowns.some((item) => {
			const relation = (plan.relations as JsonRecord[]).find((candidate) => candidate.id === item.node_id);
			return classifyPlanUnknown(item as JsonRecord, relation, statementType, schema, plan.relations as JsonRecord[], profile.dialect).outcome_class !== "NOT_APPLICABLE";
		});
		parserVersion = plan.meta.parser.version;
		planAdapterVersion = plan.meta.adapter_version;
		statements.push({
			statement_id: statementId,
			task_id: task.task_id,
			statement_index: statementIndex,
			statement_type: statementType,
			span,
			raw_sql: rawSql,
			parse_status: cell.errors > 0 || hasActionableUnknown ? "PARTIAL" : "SUCCESS",
			diagnostic: cell.diagnostics,
		});
		const records = planRecords(task, logicalSourceId, sql, plan, statementId, statementIndex, statementType, schema, profile.dialect, `sql:${task.task_id}:${sqlHash}`);
		relations.push(...records.relations);
		relationEdges.push(...records.relationEdges);
		expressions.push(...records.fields);
		lineage.push(...records.lineage);
		unknowns.push(...records.unknowns);
		datasetIo.push(...records.reads);
		const rootRelationIds = new Set(plan.roots.map((rootId) => globalRelationId(task.task_id, statementIndex, rootId)));
		const producerExpressions = records.fields.filter((expression) => rootRelationIds.has(expression.relation_id));
		const producerOrdinals = producerExpressions.map((expression) => expression.ordinal).sort((left, right) => left - right);
		const producerComplete = producerOrdinals.length > 0 && producerOrdinals.every((ordinal, index) => ordinal === index);
		if (!parsedWrite && (statementType === "SELECT" || statementType === "WITH_QUERY") && producerComplete) {
			queryOutputCandidates.push({ statementId, statementIndex, statementSlot, statementType, rawSql, expressions: producerExpressions });
		}
		if (parsedWrite) {
			const sourceStatementBase = segment === undefined ? span.start : span.start - segment.start;
			const sourceStatementStart = extractedWrite === undefined
				? segment === undefined ? significantStart : significantStart - segment.start
				: sourceStatementBase + extractedWrite.statementSpan.start;
			const sourceStatementEnd = extractedWrite === undefined
				? undefined
				: sourceStatementBase + extractedWrite.statementSpan.end;
			const partitionEvidence = task.sql_write_partition_evidence?.find((item) =>
				writeTarget !== null && sameTableReference(item.target, writeTarget) &&
				(item.sql_slot === undefined || item.sql_slot === statementSlot) &&
				(item.statement_start !== undefined
					? item.statement_start === sourceStatementStart &&
						(item.statement_end === undefined || item.statement_end === sourceStatementEnd)
					: item.statement_ordinal === undefined || item.statement_ordinal === localOrdinal),
			);
			const hasCtasBoundary = statementType === "CREATE_TABLE" && readCreateTableHeader(rawSql)?.asQuery === true;
			const writeKind = statementType === "CREATE_TABLE" ? (hasCtasBoundary ? "CTAS" : "CREATE_TABLE") : statementType;
			const fieldProducing = hasCtasBoundary || statementType === "INSERT_OVERWRITE" || statementType === "INSERT_INTO";
			const producerEnumerationStatus = fieldProducing && producerComplete ? "COMPLETE" : fieldProducing ? "NOT_EVALUABLE" : "NOT_APPLICABLE";
			const writeObservationId = `write-observation:${task.task_id}:${statementIndex}`;
			datasetIo.push({
				task_id: task.task_id,
				statement_id: statementId,
				direction: "WRITE",
				dataset_id: datasetId(logicalSourceId, writeTarget!),
				physical_dataset: writeTarget!,
				provenance: "SQL_PARSE",
				resolution_status: "RESOLVED",
				write_observation_id: writeObservationId,
				write_kind: writeKind,
				write_statement_id: statementId,
				query_producer_statement_id: fieldProducing ? statementId : null,
				producer_ordinals: producerOrdinals,
				producer_enumeration_status: producerEnumerationStatus,
				field_producing: fieldProducing,
				...(partitionEvidence
					? {
						partition_status: partitionEvidence.status,
						partition_columns: partitionEvidence.partition_columns.map(normalizeName),
					}
					: {}),
				source_as_boundary: { proven: hasCtasBoundary, statement_span: span },
			});
			writeContexts.push({
				writeObservationId,
				statementId,
				statementSlot,
				statementType,
				writeKind,
				rawSql,
				target: writeTarget!,
				queryProducerStatementId: fieldProducing ? statementId : null,
				queryBoundaryProven: hasCtasBoundary,
				producerEnumerationStatus,
				expressions: producerExpressions,
				evidenceKind: "SQL_EXPLICIT_WRITE",
				partitionStatus: partitionEvidence?.status,
				partitionColumns: partitionEvidence?.partition_columns,
				evidenceRefs: partitionEvidence?.evidence_refs,
			});
		}
		if (cell.errors > 0) {
			for (const diagnostic of cell.diagnostics) {
				unknowns.push({ task_id: task.task_id, statement_id: statementId, outcome_class: "UNKNOWN", reason_code: "SYNTAX_DIAGNOSTIC", message: diagnostic.message, source_locator: { start: diagnostic.offset ?? span.start, end: (diagnostic.offset ?? span.start) + diagnostic.length } });
			}
		}
	}
	const platformTargetName = task.platform_target_query_output ? normalizeName(task.platform_target_query_output.target) : null;
	const platformQueryOutputSlot = task.platform_target_query_output?.query_output_slot ?? task.input_pack_provenance?.sql_slot ?? task.sql_slot;
	const platformQueryOutputCandidates = queryOutputCandidates.filter(
		(candidate) => platformQueryOutputSlot === undefined || candidate.statementSlot === platformQueryOutputSlot,
	);
	const hasExplicitPlatformTargetWrite = platformTargetName !== null && writeContexts.some((write) =>
		normalizeName(write.target) === platformTargetName &&
		(platformQueryOutputSlot === undefined || write.statementSlot === platformQueryOutputSlot),
	);
	if (task.platform_target_query_output && !hasExplicitPlatformTargetWrite) {
		const target = normalizeName(task.platform_target_query_output.target);
		const uniqueQueryOutputCandidates = dedupeEquivalentQueryOutputs(platformQueryOutputCandidates);
		if (uniqueQueryOutputCandidates.length === 1 && /^[a-f0-9]{64}$/.test(sourceSqlSha256)) {
			const candidate = uniqueQueryOutputCandidates[0]!;
			const writeObservationId = `write-observation:${task.task_id}:platform-target:${candidate.statementIndex}`;
			const partitionAssignments = task.platform_target_query_output.partition_assignments ?? [];
			const partitionMode = task.platform_target_query_output.partition_mode ?? "UNKNOWN";
			const partitionColumns = task.platform_target_query_output.partition_columns.map(normalizeName);
			const dynamicPartitionColumns = partitionMode === "DYNAMIC"
				? partitionColumns
				: partitionAssignments
					.filter((assignment) => assignment.mapping_method === "DYNAMIC_PARTITION_OUTPUT_ORDINAL")
					.map((assignment) => normalizeName(assignment.field));
			const staticPartitionColumns = partitionMode === "STATIC"
				? partitionColumns
				: partitionAssignments
					.filter(
						(assignment) =>
							assignment.mapping_method === "STATIC_SQL_ASSIGNMENT" ||
							assignment.mapping_method === "SCHEDULER_EXPLICIT_FIELD_VALUE",
					)
					.map((assignment) => normalizeName(assignment.field));
			datasetIo.push({
				task_id: task.task_id,
				statement_id: candidate.statementId,
				direction: "WRITE",
				dataset_id: datasetId(logicalSourceId, target),
				physical_dataset: target,
				provenance: "PLATFORM_TARGET",
				resolution_status: "RESOLVED",
				write_observation_id: writeObservationId,
				write_kind: PACK_DECLARED_QUERY_OUTPUT,
				write_statement_id: candidate.statementId,
				query_producer_statement_id: candidate.statementId,
				source_sql_sha256: sourceSqlSha256,
				producer_ordinals: candidate.expressions.map((expression) => expression.ordinal),
				producer_enumeration_status: "COMPLETE",
				field_producing: true,
				target_resolution_method: task.platform_target_query_output.target_resolution_method,
				query_output_binding_contract: task.platform_target_query_output.query_output_binding_contract,
				partition_status: task.platform_target_query_output.partition_status,
				partition_mode: partitionMode,
				partition_columns: partitionColumns,
				partition_assignments: partitionAssignments,
				static_partition_columns: staticPartitionColumns,
				dynamic_partition_columns: dynamicPartitionColumns,
				source_as_boundary: { proven: true, statement_span: statements.find((statement) => statement.statement_id === candidate.statementId)?.span ?? null },
			});
			writeContexts.push({
				writeObservationId,
				statementId: candidate.statementId,
				statementSlot: candidate.statementSlot,
				statementType: "PLATFORM_TARGET_QUERY",
				writeKind: PACK_DECLARED_QUERY_OUTPUT,
				rawSql: candidate.rawSql,
				target,
				queryProducerStatementId: candidate.statementId,
				queryBoundaryProven: true,
				producerEnumerationStatus: "COMPLETE",
				expressions: candidate.expressions,
				evidenceKind: PACK_DECLARED_QUERY_OUTPUT,
				sourceSqlSha256,
				partitionStatus: task.platform_target_query_output.partition_status,
				partitionColumns: task.platform_target_query_output.partition_columns,
				partitionMode: task.platform_target_query_output.partition_mode,
				partitionAssignments: task.platform_target_query_output.partition_assignments,
				queryOutputBindingContract: task.platform_target_query_output.query_output_binding_contract,
				targetColumns: task.platform_target_query_output.target_columns,
				evidenceRefs: task.platform_target_query_output.evidence_refs,
			});
		} else if (uniqueQueryOutputCandidates.length === 1 && !/^[a-f0-9]{64}$/.test(sourceSqlSha256)) {
			unknowns.push({
				unknown_id: `unknown:platform-target:${task.task_id}:sql-hash`,
				task_id: task.task_id,
				outcome_class: "NOT_EVALUABLE",
				reason_code: "PLATFORM_TARGET_SQL_HASH_NOT_PROVABLE",
				message: "platform target requires a valid original Input Pack SQL SHA-256",
				subject: target,
			});
		} else {
			unknowns.push({
				unknown_id: `unknown:platform-target:${task.task_id}:query-boundary`,
				task_id: task.task_id,
				outcome_class: "NOT_EVALUABLE",
				reason_code: "PLATFORM_TARGET_QUERY_BOUNDARY_NOT_PROVABLE",
				message: `platform target requires exactly one enumerable query producer in slot ${platformQueryOutputSlot ?? "UNKNOWN"}; observed ${uniqueQueryOutputCandidates.length} distinct outputs from ${platformQueryOutputCandidates.length} candidates`,
				subject: target,
			});
		}
	}
	const outputBindingResult = deriveOutputFieldBindings({
		taskId: task.task_id,
		logicalSourceId,
		statements,
		writes: writeContexts,
		schemaRefs,
		declaredWrites: normalizeWrites(task),
	});
	outputBindings.push(...outputBindingResult.bindings);
	unknowns.push(...outputBindingResult.unknowns);
	const writeContextByObservation = new Map(
		writeContexts.map((context) => [context.writeObservationId, context]),
	);
	for (const [index, record] of datasetIo.entries()) {
		if (typeof record.write_observation_id !== "string" || record.field_producing !== true) continue;
		const writeContext = writeContextByObservation.get(record.write_observation_id);
		const producerCount = Array.isArray(record.producer_ordinals) ? record.producer_ordinals.length : 0;
		const writeBindings = outputBindings.filter(
			(binding) => binding.write_observation_id === record.write_observation_id,
		);
		const fullyBound = producerCount > 0 && writeBindings.length === producerCount;
		const boundStaticColumns = [...new Set(writeBindings.flatMap((binding) => binding.static_partition_columns).map(normalizeName))];
		const boundDynamicColumns = [...new Set(writeBindings.flatMap((binding) => binding.dynamic_partition_columns ?? []).map(normalizeName))];
		const targetSchemas = schemaRefs.filter(ref => ref.status === "SUCCESS" &&
			normalizeName(String(ref.qualified_name)) === normalizeName(record.physical_dataset));
		const sqlWrites = record.provenance === "SQL_PARSE" && writeContext
			? extractSqlWrites(writeContext.rawSql).filter(write => sameTableReference(write.qualifiedName, record.physical_dataset))
			: [];
		const explicitNonPartitioned = record.partition_status === undefined && writeContext?.partitionStatus === undefined &&
			targetSchemas.length === 1 && targetSchemas[0]!.physical_columns.length > 0 &&
			targetSchemas[0]!.partition_columns.length === 0 && sqlWrites.length === 1 && sqlWrites[0]!.partitionMode === "NONE";
		if (
			record.write_kind !== PACK_DECLARED_QUERY_OUTPUT &&
			writeContext?.partitionStatus === undefined &&
			boundStaticColumns.length === 0 &&
			boundDynamicColumns.length === 0 && !explicitNonPartitioned
		) continue;
		let partitionStatus =
			record.partition_status ??
			writeContext?.partitionStatus ??
			(explicitNonPartitioned ? "NOT_PARTITIONED" : boundStaticColumns.length > 0 || boundDynamicColumns.length > 0 ? "COMPLETE" : undefined);
		const declaredPartitionColumns = (
			record.partition_columns ?? writeContext?.partitionColumns ?? []
		).map(normalizeName);
		const partitionColumns = declaredPartitionColumns.length > 0
			? declaredPartitionColumns
			: [...boundStaticColumns, ...boundDynamicColumns];
		let partitionMode = record.partition_mode ?? writeContext?.partitionMode ?? (explicitNonPartitioned ? "NONE" : undefined);
		let staticPartitionColumns = record.static_partition_columns;
		let dynamicPartitionColumns = record.dynamic_partition_columns;
		if (fullyBound) {
			staticPartitionColumns = boundStaticColumns;
			dynamicPartitionColumns = boundDynamicColumns;
			partitionMode = boundStaticColumns.length > 0 && boundDynamicColumns.length > 0
				? "MIXED"
				: boundStaticColumns.length > 0
					? "STATIC"
					: boundDynamicColumns.length > 0
						? "DYNAMIC"
						: partitionStatus === "NOT_PARTITIONED" && partitionColumns.length === 0
							? "NONE"
							: partitionMode ?? "UNKNOWN";
		}
		const assignmentConflict = Array.isArray(record.partition_assignments) && record.partition_assignments.some(
			(assignment: unknown) => assignment !== null && typeof assignment === "object" && (assignment as JsonRecord).status === "CONFLICT",
		);
		const classifiedColumns = new Set([
			...(staticPartitionColumns ?? []).map(normalizeName),
			...(dynamicPartitionColumns ?? []).map(normalizeName),
		]);
		const partitionColumnsFullyClassified =
			partitionColumns.length > 0 &&
			classifiedColumns.size === partitionColumns.length &&
			partitionColumns.every((column) => classifiedColumns.has(column));
		// Explicit scheduler partition evidence is independent of whether the
		// business SELECT columns can be bound to the target schema.
		const schedulerAssignments = record.partition_assignments ?? [];
		const explicitSchedulerPartition = partitionMode === "STATIC" &&
			partitionColumnsFullyClassified &&
			schedulerAssignments.length === partitionColumns.length &&
			partitionColumns.every(column => schedulerAssignments.some(assignment =>
				normalizeName(assignment.field) === column &&
				assignment.mapping_method === "SCHEDULER_EXPLICIT_FIELD_VALUE" &&
				(assignment.status === "CONFIRMED" || assignment.status === "RUNTIME_EXPRESSION")));
		if (
			partitionStatus !== "CONFLICT" &&
			!assignmentConflict &&
			fullyBound &&
			partitionColumnsFullyClassified
		) partitionStatus = "COMPLETE";
		let partitionBindingStatus: DatasetIoRecord["partition_binding_status"];
		if (partitionStatus === "CONFLICT" || assignmentConflict) partitionBindingStatus = "CONFLICT";
		else if (partitionMode === "NONE" && partitionStatus === "NOT_PARTITIONED") {
			partitionBindingStatus = "NOT_PARTITIONED";
		} else if ((fullyBound && partitionColumnsFullyClassified) || explicitSchedulerPartition) partitionBindingStatus = "COMPLETE";
		else if (partitionStatus === "UNKNOWN" || partitionMode === "UNKNOWN") {
			partitionBindingStatus = "UNKNOWN";
		} else partitionBindingStatus = "INCOMPLETE";
		// SQL writes must expose the same assignment contract as Pack-declared
		// writes. A resolved output binding proves an ordinal, not its runtime value.
		let partitionAssignments = record.partition_assignments;
		if ((record.provenance === "SQL_PARSE" || record.write_kind === PACK_DECLARED_QUERY_OUTPUT) && !assignmentConflict &&
			(!Array.isArray(partitionAssignments) || partitionAssignments.length === 0)) {
			if (partitionMode === "NONE") partitionAssignments = [];
			else if (partitionBindingStatus === "COMPLETE") {
				partitionAssignments = partitionColumns.map(field => {
					const matches = writeBindings.filter(binding => normalizeName(binding.target_field) === field);
					const dynamic = (dynamicPartitionColumns ?? []).map(normalizeName).includes(field);
					const sqlAssignment = sqlWrites.length === 1 ? sqlWrites[0]!.partition.find(part => normalizeName(part.field) === field) : undefined;
					const provenDynamic = dynamic && matches.length === 1 && matches[0]!.binding_status === "RESOLVED";
					const provenStatic = !dynamic && sqlAssignment !== undefined && sqlAssignment.valueStatus !== "UNKNOWN";
					return {
						field,
						status: provenDynamic || (provenStatic && sqlAssignment!.valueStatus === "OBSERVED_RENDERED_VALUE")
							? "CONFIRMED" as const : provenStatic ? "RUNTIME_EXPRESSION" as const : "UNKNOWN" as const,
						mapping_method: provenDynamic ? "DYNAMIC_PARTITION_OUTPUT_ORDINAL" as const
							: provenStatic ? "STATIC_SQL_ASSIGNMENT" as const : "UNKNOWN" as const,
						evidence_refs: [...new Set([record.write_statement_id, ...matches.flatMap(binding => [binding.binding_id, binding.expression_id, ...binding.evidence_refs])].filter((ref): ref is string => typeof ref === "string"))].sort(),
					};
				});
				if (partitionAssignments?.some(assignment => assignment.status === "UNKNOWN")) partitionBindingStatus = "INCOMPLETE";
			}
		}
		datasetIo[index] = {
			...record,
			partition_status: partitionStatus,
			partition_columns: partitionColumns,
			partition_binding_status: partitionBindingStatus,
			partition_mode: partitionMode ?? "UNKNOWN",
			static_partition_columns: staticPartitionColumns,
			dynamic_partition_columns: dynamicPartitionColumns,
			...(partitionAssignments === undefined ? {} : { partition_assignments: partitionAssignments }),
		};
	}
	const taskLocalMaterializations = deriveTaskLocalMaterializations(
		task.task_id,
		logicalSourceId,
		task.default_schema,
		statements,
		datasetIo,
		expressions,
		outputBindings,
		schemaRefs,
		relations,
	);
	const dedupedUnknowns = new Set<string>();
	const retainedUnknowns = unknowns.filter((item) => {
		if (item.reason_code !== "SCHEMA_BINDING_NOT_EVALUABLE" || !item.message.startsWith("physical references lack schema evidence:")) return true;
		const key = `${item.task_id}|${item.statement_id ?? ""}|${item.message}`;
		if (dedupedUnknowns.has(key)) return false;
		dedupedUnknowns.add(key);
		return true;
	});
	unknowns.splice(0, unknowns.length, ...retainedUnknowns);
	for (const write of normalizeWrites(task)) {
		datasetIo.push({ task_id: task.task_id, direction: "WRITE", dataset_id: datasetId(logicalSourceId, write), physical_dataset: write, provenance: "PROFILE_DECLARED", resolution_status: "DECLARED" });
	}
	const fieldProducingDatasets = new Set(
		datasetIo
			.filter((record) => record.direction === "WRITE" && record.field_producing === true)
			.map((record) => normalizeName(record.physical_dataset)),
	);
	const declaredWritesWithoutBindings = normalizeWrites(task).filter((write) =>
		fieldProducingDatasets.has(write) &&
		!outputBindings.some((binding) => normalizeName(binding.target_dataset) === write),
	);
	if (declaredWritesWithoutBindings.length > 0) {
		unknowns.push({
			task_id: task.task_id,
			outcome_class: "NOT_EVALUABLE",
			reason_code: "OUTPUT_BINDING_NOT_PROVABLE",
			message: "Profile declared output has no unambiguous SQL output field binding",
			subject: declaredWritesWithoutBindings.join(","),
		});
	}
	const unknownsByOutcome = Object.fromEntries(
		(["UNKNOWN", "NOT_EVALUABLE", "NOT_APPLICABLE", "FAILURE"] as const).map((outcome) => [outcome, unknowns.filter((item) => item.outcome_class === outcome).length]),
	) as Record<OutcomeClass, number>;
	const files: Array<{ path: string; schema_version: string; row_count: number; content_sha256: string }> = [];
	for (const [name, records, schemaVersion] of [
		["statements.jsonl", statements, "machine-facts-statements-v1"],
		["schema-refs.jsonl", schemaRefs, "machine-facts-schema-refs-v1"],
		["dataset-io.jsonl", stableRecords(datasetIo, (record) => JSON.stringify(record)), "machine-facts-dataset-io-v1"],
		["relation-nodes.jsonl", relations, "machine-facts-relation-nodes-v1"],
		["relation-edges.jsonl", relationEdges, "machine-facts-relation-edges-v1"],
		["field-expression-nodes.jsonl", expressions, "machine-facts-field-expressions-v2"],
		["column-lineage-edges.jsonl", lineage, "machine-facts-column-lineage-v1"],
		["lineage-hop-roots.jsonl", [], "machine-facts-lineage-hop-roots-v1"],
		["lineage-hop-nodes.jsonl", [], "machine-facts-lineage-hop-nodes-v1"],
		["lineage-hop-edges.jsonl", [], "machine-facts-lineage-hop-edges-v1"],
		["output-field-bindings.jsonl", outputBindings, "machine-facts-output-field-bindings-v1"],
		["task-local-materializations.jsonl", taskLocalMaterializations, "machine-facts-task-local-materializations-v1"],
		["unknowns.jsonl", unknowns, "machine-facts-unknowns-v1"],
	] as const) {
		const result = writeJsonl(join(staging, name), records);
		files.push({ path: name, schema_version: schemaVersion, ...result });
	}
	const manifest: MachineFactsManifest = {
		schema_version: MACHINE_FACTS_CONTRACT_VERSION,
		task_id: task.task_id,
		logical_source_id: logicalSourceId,
		status: "SUCCESS",
		inputs: {
			sql_sha256: sqlHash,
			sql_snapshot: sqlSnapshot,
			schema_bundle_sha256: schemaBundleHash,
			schema_snapshot: schemaSnapshot,
			analysis_config_sha256: contextHash(task, profile, logicalSourceId),
			...(task.input_pack_provenance ? { input_pack: task.input_pack_provenance } : {}),
		},
		method: {
			dialect: profile.dialect,
			parser: { engine: "sql-static-lineage", version: parserVersion },
			adapter: { name: "machine-facts-writer", version: MACHINE_FACTS_ADAPTER_VERSION },
			plan_adapter: { name: "plan-adapter", version: planAdapterVersion },
		},
		outputs: files,
		counts: {
			statements: statements.length,
			schema_refs: schemaRefs.length,
			dataset_io: datasetIo.length,
			relation_nodes: relations.length,
			relation_edges: relationEdges.length,
			field_expression_nodes: expressions.length,
			column_lineage_edges: lineage.length,
			lineage_hop_roots: hopRoots.length,
			lineage_hop_nodes: hopNodes.length,
			lineage_hop_edges: hopEdges.length,
			lineage_hop_projected_roots: hopRoots.filter((root) => root.projection_status === "PROJECTED").length,
			lineage_hop_partial_roots: hopRoots.filter((root) => root.projection_status === "PARTIAL_NATIVE").length,
			lineage_hop_not_evaluable_roots: hopRoots.filter((root) => root.projection_status === "NOT_EVALUABLE").length,
			output_field_bindings: outputBindings.length,
			task_local_materializations: taskLocalMaterializations.length,
			unknowns: unknowns.length,
			unknowns_by_outcome: unknownsByOutcome,
		},
		gates: { required_files: true, hash_integrity: true, span_roundtrip: true, relation_endpoints: true, lineage_endpoints: true, output_binding_endpoints: true, lineage_hop_endpoints: false, lineage_hop_acyclic: false, lineage_hop_status_truth_table: false, lineage_hop_origin_conservation: false },
		boundaries: { business_logic_correctness: "NOT_EVALUATED", runtime_execution: "NOT_EVALUATED", business_rows_read: false, external_model_calls: 0, cross_task_field_stitching: "NOT_GENERATED" },
	};
	writeCanonical(join(staging, "manifest.json"), manifest);
	return { staging, manifest };
}

export function runTask(
	task: GenericTaskProfile,
	profile: GenericAnalysisProfile,
	logicalSourceId: string,
	root: string,
	schemaBundle: JsonRecord,
	schemaBundleHash: string,
): TaskRunResult {
	safeTask(task);
	const taskRoot = join(root, "registry", "tasks", task.task_id);
	mkdirSync(taskRoot, { recursive: true });
	let sqlHash = "";
	try {
		sqlHash = sha256(readFileSync(resolve(workspace, task.sql_snapshot)));
	} catch {
		// The typed task failure below retains an empty hash when the source itself is unavailable.
	}
	try {
		recoverTaskState(taskRoot);
	} catch (error) {
		const failure = makeFailure("FAILURE", "RECOVERY_REQUIRED", error instanceof Error ? error.message : String(error));
		writeStatus(taskRoot, { schema_version: MACHINE_FACTS_STATUS_VERSION, task_id: task.task_id, logical_source_id: logicalSourceId, state: "FAILED", requested: { sql_sha256: sqlHash, schema_bundle_sha256: schemaBundleHash, analysis_config_sha256: contextHash(task, profile, logicalSourceId), dialect: profile.dialect }, current_manifest_sha256: readCurrentManifestHash(taskRoot), failure });
		return { task_id: task.task_id, state: "FAILED", status: "FAILED", failures: [failure] };
	}
	const requested = { sql_sha256: sqlHash, schema_bundle_sha256: schemaBundleHash, analysis_config_sha256: contextHash(task, profile, logicalSourceId), dialect: profile.dialect };
	const reusable = reusableTaskResult(taskRoot, task.task_id, logicalSourceId, requested);
	if (reusable !== null) return reusable;
	writeStatus(taskRoot, { schema_version: MACHINE_FACTS_STATUS_VERSION, task_id: task.task_id, logical_source_id: logicalSourceId, state: "ANALYZING", requested, current_manifest_sha256: readStatus(taskRoot)?.current_manifest_sha256 ?? null });
	let staging: string | null = null;
	try {
		const built = buildTaskBundle(task, profile, logicalSourceId, root, schemaBundle, schemaBundleHash);
		staging = built.staging;
		const errors = validateBundle(staging);
		if (errors.length) throw new Error(errors.join("; "));
		const published = publishBundle(taskRoot, staging, built.manifest);
		staging = null;
		writeStatus(taskRoot, { schema_version: MACHINE_FACTS_STATUS_VERSION, task_id: task.task_id, logical_source_id: logicalSourceId, state: "SUCCESS", requested, current_manifest_sha256: published.manifest_sha256 });
		return { task_id: task.task_id, state: "SUCCESS", status: published.status, manifest_sha256: published.manifest_sha256, failures: [] };
	} catch (error) {
		if (staging && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
		const message = error instanceof Error ? error.message : String(error);
		const reasonCode = message.includes("NON_DETERMINISTIC_OUTPUT") ? "NON_DETERMINISTIC_OUTPUT" : message.includes("RECOVERY") ? "RECOVERY_REQUIRED" : "TASK_ANALYSIS_FAILED";
		const failure = makeFailure("FAILURE", reasonCode, message);
		writeStatus(taskRoot, { schema_version: MACHINE_FACTS_STATUS_VERSION, task_id: task.task_id, logical_source_id: logicalSourceId, state: "FAILED", requested, current_manifest_sha256: readCurrentManifestHash(taskRoot), failure });
		return { task_id: task.task_id, state: "FAILED", status: "FAILED", failures: [failure] };
	}
}

function readTaskFactIndexSchema(): { schema: JsonRecord | null; failure?: string } {
	try {
		return {
			schema: (json<JsonRecord>(join(workspace, "schemas", "machine-facts-records.schema.json")).properties as JsonRecord)["task-fact-index.jsonl"] as JsonRecord,
		};
	} catch (error) {
		return { schema: null, failure: `task-fact-index schema unavailable: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function taskFactIndexRecord(
	root: string,
	taskId: string,
	): { record?: TaskFactIndexRecord; failure?: string } {
	const taskRoot = join(root, "registry", "tasks", taskId);
	let status: AnalysisStatus | null;
	try {
		status = readStatus(taskRoot);
	} catch (error) {
		return { failure: `${taskId}: invalid analysis-status.json (${error instanceof Error ? error.message : String(error)})` };
	}
	if (!status || status.state !== "SUCCESS")
		return { failure: status?.state === "FAILED" ? `${taskId}: ${status.failure?.reason_code ?? "FAILED"}` : undefined };
	const manifestPath = join(taskRoot, "bundle", "manifest.json");
	if (!existsSync(manifestPath)) return { failure: `${taskId}: manifest missing` };
	let manifest: MachineFactsManifest;
	try {
		manifest = json<MachineFactsManifest>(manifestPath);
	} catch (error) {
		return { failure: `${taskId}: invalid manifest (${error instanceof Error ? error.message : String(error)})` };
	}
	const manifestHash = sha256(canonicalJson(manifest));
	if (
		status.task_id !== taskId ||
		status.task_id !== manifest.task_id ||
		status.logical_source_id !== manifest.logical_source_id ||
		status.current_manifest_sha256 !== manifestHash
	)
		return { failure: `${taskId}: status/manifest identity or hash mismatch` };
	return {
		record: {
			task_id: taskId,
			logical_source_id: manifest.logical_source_id,
			sql_sha256: manifest.inputs.sql_sha256,
			manifest_sha256: manifestHash,
			bundle_path: relativeRoot(root, join(taskRoot, "bundle")),
			status: "SUCCESS",
		},
	};
}

function indexLockPath(root: string): string {
	return join(root, "indexes", "task-fact-index.lock");
}

/**
 * The Facts bundles have their own recovery protocol. The shared index needs
 * a separate, short-lived single-writer guard so simultaneous refreshes cannot
 * lose each other's rows. A leftover lock is deliberately fail-closed: it
 * indicates an interrupted writer and must be inspected before removal.
 */
function acquireIndexWriteLock(root: string): () => void {
	const lockPath = indexLockPath(root);
	mkdirSync(dirname(lockPath), { recursive: true });
	let descriptor: number | undefined;
	try {
		descriptor = openSync(lockPath, "wx");
		writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, "utf8");
	} catch (error) {
		if (descriptor !== undefined) {
			closeSync(descriptor);
			if (existsSync(lockPath)) unlinkSync(lockPath);
		}
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new Error(`MACHINE_FACTS_INDEX_LOCKED:${lockPath}`);
		throw error;
	}
	return () => {
		closeSync(descriptor!);
		if (existsSync(lockPath)) unlinkSync(lockPath);
	};
}

function writeIndexAtomically(path: string, records: readonly JsonRecord[]): void {
	const temp = `${path}.tmp`;
	writeFileSync(temp, canonicalJsonl(records), "utf8");
	try {
		// rename replaces an existing file on the supported local filesystems.
		// That keeps readers on either the previous complete index or the new one;
		// a temp file is never observed as the canonical path.
		renameSync(temp, path);
	} catch (error) {
		if (existsSync(temp)) rmSync(temp, { force: true });
		throw error;
	}
}

function rebuildIndexUnlocked(root: string): ProfileRunResult["index"] {
	const indexDir = join(root, "indexes");
	mkdirSync(indexDir, { recursive: true });
	const records: JsonRecord[] = [];
	const failures: string[] = [];
	const indexSchemaResult = readTaskFactIndexSchema();
	const indexSchema = indexSchemaResult.schema;
	if (indexSchemaResult.failure) failures.push(indexSchemaResult.failure);
	const tasksRoot = join(root, "registry", "tasks");
	if (existsSync(tasksRoot)) {
		for (const taskId of readdirSync(tasksRoot)) {
			const taskRoot = join(tasksRoot, taskId);
			if (!statSync(taskRoot).isDirectory()) continue;
			let status: AnalysisStatus | null;
			try {
				status = readStatus(taskRoot);
			} catch (error) {
				failures.push(`${taskId}: invalid analysis-status.json (${error instanceof Error ? error.message : String(error)})`);
				continue;
			}
			if (!status || status.state !== "SUCCESS") {
				if (status?.state === "FAILED") failures.push(`${taskId}: ${status.failure?.reason_code ?? "FAILED"}`);
				continue;
			}
			const bundle = join(taskRoot, "bundle");
			const errors = validateBundle(bundle);
			const manifestPath = join(bundle, "manifest.json");
			if (!existsSync(manifestPath) || errors.length) {
				failures.push(`${taskId}: ${errors.join("; ") || "manifest missing"}`);
				continue;
			}
			const manifest = json<MachineFactsManifest>(manifestPath);
			const requestedStatus = status.requested as AnalysisStatus["requested"] | undefined;
			const statusMatchesManifest = typeof status.task_id === "string" && typeof status.logical_source_id === "string" && requestedStatus !== undefined &&
				status.task_id === taskId && status.task_id === manifest.task_id && status.logical_source_id === manifest.logical_source_id &&
				requestedStatus.sql_sha256 === manifest.inputs.sql_sha256 && requestedStatus.schema_bundle_sha256 === manifest.inputs.schema_bundle_sha256 &&
				requestedStatus.analysis_config_sha256 === manifest.inputs.analysis_config_sha256 && requestedStatus.dialect === manifest.method.dialect;
			if (!statusMatchesManifest || sha256(canonicalJson(manifest)) !== status.current_manifest_sha256) {
				failures.push(`${taskId}: status/manifest identity or hash mismatch`);
				continue;
			}
			const candidate: TaskFactIndexRecord = { task_id: taskId, logical_source_id: manifest.logical_source_id, sql_sha256: manifest.inputs.sql_sha256, manifest_sha256: status.current_manifest_sha256, bundle_path: relativeRoot(root, bundle), status: "SUCCESS" };
			const indexErrors = indexSchema ? validateJsonSchema(candidate, indexSchema, `task-fact-index.jsonl[${records.length}]`) : ["task-fact-index schema unavailable"];
			if (indexErrors.length) {
				failures.push(`${taskId}: ${indexErrors.join("; ")}`);
				continue;
			}
			records.push(candidate);
		}
	}
	const path = join(indexDir, "task-fact-index.jsonl");
	writeIndexAtomically(path, stableRecords(records, (record) => String(record.task_id)));
	return { path, count: records.length, failures };
}

export function rebuildIndex(rootInput: string): ProfileRunResult["index"] {
	const root = resolve(rootInput);
	const release = acquireIndexWriteLock(root);
	try {
		return rebuildIndexUnlocked(root);
	} finally {
		release();
	}
}

/**
 * Carry forward the last full index and replace only Tasks processed by the
 * current batch. The runner has already validated newly built or reused
 * bundles; rebuildIndex remains the explicit full integrity sweep.
 */
export function updateIndexIncrementally(
	rootInput: string,
	options: IncrementalIndexOptions,
): MachineFactsIndexRefreshResult {
	const root = resolve(rootInput);
	const release = acquireIndexWriteLock(root);
	try {
		return updateIndexIncrementallyUnlocked(root, options);
	} finally {
		release();
	}
}

function updateIndexIncrementallyUnlocked(
	root: string,
	options: IncrementalIndexOptions,
): MachineFactsIndexRefreshResult {
	const indexDir = join(root, "indexes");
	const path = join(indexDir, "task-fact-index.jsonl");
	let records: Map<string, TaskFactIndexRecord>;
	try {
		records = new Map(loadMachineFactsIndex(root).byTaskId);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const fallbackReason = message.startsWith("MACHINE_FACTS_INDEX_MISSING:")
			? "INDEX_MISSING"
			: message.startsWith("MACHINE_FACTS_INDEX_INVALID_ROW:") || message.startsWith("MACHINE_FACTS_INDEX_DUPLICATE_TASK:")
				? "INDEX_INVALID"
				: "INDEX_UNREADABLE";
		return {
			index: rebuildIndexUnlocked(root),
			requestedMode: "incremental",
			appliedMode: "full",
			verificationScope: "FULL",
			fallbackReason,
		};
	}

	const indexSchemaResult = readTaskFactIndexSchema();
	const failures = indexSchemaResult.failure ? [indexSchemaResult.failure] : [];
	for (const result of options.taskResults) {
		if (result.state !== "SUCCESS") {
			records.delete(result.task_id);
			if (result.failures.length > 0) failures.push(`${result.task_id}: ${result.failures.map((failure) => failure.message).join("; ")}`);
			continue;
		}
		const candidate = taskFactIndexRecord(root, result.task_id);
		if (!candidate.record) {
			if (candidate.failure) failures.push(candidate.failure);
			continue;
		}
		if (result.manifest_sha256 && result.manifest_sha256 !== candidate.record.manifest_sha256) {
			failures.push(`${result.task_id}: result/manifest hash mismatch`);
			continue;
		}
		const indexErrors = indexSchemaResult.schema
			? validateJsonSchema(candidate.record, indexSchemaResult.schema, `task-fact-index.jsonl[${records.size}]`)
			: ["task-fact-index schema unavailable"];
		if (indexErrors.length > 0) {
			failures.push(`${result.task_id}: ${indexErrors.join("; ")}`);
			continue;
		}
		records.set(result.task_id, candidate.record);
	}
	mkdirSync(indexDir, { recursive: true });
	writeIndexAtomically(path, stableRecords([...records.values()], (record) => String(record.task_id)));
	return {
		index: { path, count: records.size, failures },
		requestedMode: "incremental",
		appliedMode: "incremental",
		verificationScope: "STRUCTURAL_ONLY",
	};
}

/** The only policy boundary for operational Facts index refreshes. */
export function refreshMachineFactsIndex(
	rootInput: string,
	options: IncrementalIndexOptions & { readonly mode?: MachineFactsIndexMode },
): MachineFactsIndexRefreshResult {
	const requestedMode = options.mode ?? "auto";
	if (requestedMode === "full") {
		return {
			index: rebuildIndex(rootInput),
			requestedMode,
			appliedMode: "full",
			verificationScope: "FULL",
		};
	}
	const refreshed = updateIndexIncrementally(rootInput, options);
	return { ...refreshed, requestedMode };
}

export function processProfile(
	profilePath: string,
	outputRoot: string,
	sourceIdOverride?: string,
	indexMode: MachineFactsIndexMode = "auto",
): ProfileRunResult {
	const profile = json<GenericAnalysisProfile>(resolve(workspace, profilePath));
	if (!profile.dialect || !Array.isArray(profile.tasks) || profile.tasks.length === 0) throw new Error("profile must contain dialect and tasks");
	if (!sourceIdOverride && !profile.logical_source_id) throw new Error("logical_source_id is required");
	const logicalSourceId = safeSegment(sourceIdOverride ?? profile.logical_source_id!, "logical_source_id");
	const taskIds = profile.tasks.map((task) => task.task_id);
	if (new Set(taskIds).size !== taskIds.length) throw new Error("profile task_id values must be unique");
	const root = resolve(workspace, outputRoot);
	mkdirSync(root, { recursive: true });
	const configuredEvidence = Array.isArray(profile.schema_evidence)
		? [...profile.schema_evidence]
		: profile.schema_evidence ? [profile.schema_evidence] : [];
	const evidencePaths = configuredEvidence.map((path) => resolve(workspace, path));
	if (evidencePaths.length === 0 || evidencePaths.some((path) => !existsSync(path))) throw new Error("schema_evidence is required and must exist");
	const schemaBundle = mergeSchemaEvidence(evidencePaths.map((path) => json<JsonRecord>(path)), logicalSourceId);
	const schemaBytes = Buffer.from(canonicalJson(schemaBundle), "utf8");
	const schemaBundleHash = sha256(schemaBytes);
	snapshot(root, "schema", schemaBundleHash, schemaBytes);
	const tasks = profile.tasks.map((task) => {
		const taskBundle = schemaBundleForTask(schemaBundle, task, profile);
		const taskBytes = Buffer.from(canonicalJson(taskBundle), "utf8");
		const taskHash = sha256(taskBytes);
		snapshot(root, "schema", taskHash, taskBytes);
		return runTask(task, profile, logicalSourceId, root, taskBundle, taskHash);
	});
	return {
		output_root: root,
		tasks,
		index: refreshMachineFactsIndex(root, { taskResults: tasks, mode: indexMode }).index,
	};
}

function parseIndexMode(value: string | undefined): MachineFactsIndexMode {
	if (!value) return "auto";
	if (value === "auto" || value === "full" || value === "incremental") return value;
	throw new Error(`INVALID_INDEX_MODE:${value}`);
}

function parseArgs(args: string[]): { profile: string; output: string; sourceId?: string; indexMode: MachineFactsIndexMode } {
	const value = (name: string, fallback: string): string => {
		const index = args.indexOf(name);
		return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
	};
	return {
		profile: value("--profile", "cases/indicator-journey-rgstcomp-mthend/processing-graph-profile.json"),
		output: resolveWorkspacePaths({ configPath: value("--config", "") || undefined, overrides: { factsRoot: value("--output", "") || undefined } }).factsRoot,
		sourceId: args.includes("--source-id") ? value("--source-id", "") : undefined,
		indexMode: parseIndexMode(args.includes("--index-mode") ? value("--index-mode", "") : undefined),
	};
}

function scopedControlReadNodes(
	control: RelationNodeRecord,
	byId: ReadonlyMap<string, RelationNodeRecord>,
): RelationNodeRecord[] {
	const body = control.relation as JsonRecord | null;
	if (!body || typeof body !== "object") return [];
	const reachableReads: RelationNodeRecord[] = [];
	const visited = new Set<string>();
	const pending = [body.source, body.left, body.right].filter((id): id is string => typeof id === "string");
	while (pending.length > 0) {
		const id = pending.pop()!;
		if (visited.has(id)) continue;
		visited.add(id);
		const node = byId.get(id);
		const relation = node?.relation as JsonRecord | null;
		if (!node || !relation || node.statement_id !== control.statement_id || node.task_id !== control.task_id || !body.scope_id || relation.scope_id !== body.scope_id) continue;
		if (node.relation_type === "read") {
			if (relation.is_cte !== true) reachableReads.push(node);
			continue;
		}
		for (const child of [relation.source, relation.left, relation.right, ...(Array.isArray(relation.branches) ? relation.branches : [])]) {
			if (typeof child === "string") pending.push(child);
		}
	}
	return reachableReads;
}

function collectTaskLocalControlReads(
	relations: readonly RelationNodeRecord[],
	datasetIo: readonly DatasetIoRecord[],
	qualifyTable: (value: unknown) => string,
): { statementId: string; table: string; column: string; ref: TaskLocalControlReadRef }[] {
	const byId = new Map(relations.map(relation => [relation.relation_id, relation]));
	const asRecord = (value: unknown): JsonRecord | null =>
		typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
	const output: { statementId: string; table: string; column: string; ref: TaskLocalControlReadRef }[] = [];
	for (const control of relations) {
		const type = control.relation_type.toLowerCase();
		if (type !== "filter" && type !== "join") continue;
		const body = asRecord(control.relation);
		if (!body) continue;
		const columns: unknown[] = type === "filter" ? body.predicate_columns : body.condition_columns;
		if (!Array.isArray(columns)) continue;
		// Follow explicit child relation IDs, never relation-name prefixes. Stopping
		// at another scope prevents a derived/CTE alias being guessed as a read.
		const reachableReads = scopedControlReadNodes(control, byId);
		for (const raw of columns) {
			const input = asRecord(raw);
			if (!input || !Array.isArray(input.physical)) continue;
			for (const physical of input.physical) {
				const pair = asRecord(physical);
				const table = qualifyTable(pair?.table);
				const column = normalizeName(String(pair?.column ?? ""));
				if (!table || !column) continue;
				const qualifier = normalizeName(String(input.qualifier ?? ""));
				const candidates = reachableReads.filter(node => {
					const read = asRecord(node.relation)!;
					return qualifyTable(read.table) === table && (!qualifier || normalizeName(String(read.binding ?? "")) === qualifier);
				});
				let ref: TaskLocalControlReadRef = {
					relation_id: control.relation_id, read_relation_id: null, read_occurrence_id: null,
					resolution_status: candidates.length > 1 ? "AMBIGUOUS" : "UNRESOLVED",
					reason_code: candidates.length > 1 ? "CONTROL_READ_OCCURRENCE_AMBIGUOUS" : "CONTROL_READ_SCOPE_NOT_PROVEN",
				};
				if (input.resolution !== "PHYSICAL") {
					ref = { ...ref, resolution_status: "UNRESOLVED", reason_code: "CONTROL_FIELD_NOT_RESOLVED" };
				} else if (candidates.length === 1) {
					const read = candidates[0]!;
					const occurrenceId = asRecord(read.relation)?.read_occurrence_id;
					const proofs = datasetIo.filter(io => io.direction === "READ" && io.task_id === control.task_id && io.statement_id === control.statement_id && io.resolution_status === "RESOLVED" && qualifyTable(io.physical_dataset) === table)
						.flatMap(io => Array.isArray(io.read_occurrences) ? io.read_occurrences : [])
						.map(asRecord).filter(occurrence => occurrence !== null && occurrence.relation_id === read.relation_id && occurrence.occurrence_id === occurrenceId);
					if (typeof occurrenceId === "string" && occurrenceId.length > 0 && proofs.length === 1) {
						ref = { relation_id: control.relation_id, read_relation_id: read.relation_id, read_occurrence_id: occurrenceId, resolution_status: "RESOLVED" };
					} else {
						ref = { ...ref, reason_code: "CONTROL_READ_OCCURRENCE_NOT_PROVEN" };
					}
				}
				output.push({ statementId: control.statement_id, table, column, ref });
			}
		}
	}
	return output;
}

export function deriveTaskLocalMaterializations(
	taskId: string,
	logicalSourceId: string,
	taskDefaultSchema: string | undefined,
	statements: readonly StatementRecord[],
	datasetIo: readonly DatasetIoRecord[],
	expressions: readonly FieldExpressionRecord[],
	outputBindings: readonly OutputFieldBindingRecord[],
	schemaRefs: readonly SchemaReferenceRecord[],
	relations: readonly RelationNodeRecord[] = [],
): TaskLocalMaterializationRecord[] {
	const defaultSchema = normalizeName(taskDefaultSchema ?? "");
	const qualifyTaskTable = (value: unknown): string => {
		const normalized = normalizeName(String(value ?? ""));
		if (!defaultSchema) return normalized;
		return qualifyBareTableName(normalized, {
			schema: defaultSchema,
			evidenceSources: ["TASK_NAME"],
		});
	};
	const statementIndexes = new Map(statements.map((statement) => [statement.statement_id, statement.statement_index]));
	const writes = datasetIo.filter((record) =>
		record.direction === "WRITE" &&
		record.field_producing === true &&
		typeof record.write_observation_id === "string"
	);
	const writeByObservation = new Map(writes.map((write) => [String(write.write_observation_id), write]));
	const bindingsByObservation = new Map<string, OutputFieldBindingRecord[]>();
	for (const binding of outputBindings) {
		const values = bindingsByObservation.get(binding.write_observation_id) ?? [];
		values.push(binding);
		bindingsByObservation.set(binding.write_observation_id, values);
	}
	type FieldUse = { readonly table: string; readonly column: string; readonly expressionIds: Set<string>; readonly controlRefs: Map<string, TaskLocalControlReadRef> };
	const fieldsByStatement = new Map<string, Map<string, FieldUse>>();
	for (const expression of expressions) {
		const fields = fieldsByStatement.get(expression.statement_id) ?? new Map();
		for (const raw of expression.input_fields) {
			const input = typeof raw === "object" && raw !== null ? raw as JsonRecord : null;
			const table = qualifyTaskTable(input?.table);
			const column = normalizeName(String(input?.column ?? ""));
			if (!table || !column) continue;
			const key = `${table}\u0000${column}`;
			const current: FieldUse = fields.get(key) ?? { table, column, expressionIds: new Set<string>(), controlRefs: new Map() };
			current.expressionIds.add(expression.expression_id);
			fields.set(key, current);
		}
		fieldsByStatement.set(expression.statement_id, fields);
	}
	for (const use of collectTaskLocalControlReads(relations, datasetIo, qualifyTaskTable)) {
		const fields = fieldsByStatement.get(use.statementId) ?? new Map<string, FieldUse>();
		const key = `${use.table}\u0000${use.column}`;
		const current = fields.get(key) ?? { table: use.table, column: use.column, expressionIds: new Set<string>(), controlRefs: new Map<string, TaskLocalControlReadRef>() };
		current.controlRefs.set(canonicalJson(use.ref), use.ref);
		fields.set(key, current);
		fieldsByStatement.set(use.statementId, fields);
	}
	const records: TaskLocalMaterializationRecord[] = [];
	const reads = datasetIo.filter((record) => record.direction === "READ");
	const isSchemaOnlyCreateTable = (write: DatasetIoRecord): boolean =>
		String(write.write_kind ?? "").toUpperCase() === "CREATE_TABLE"
			&& write.field_producing === false
			&& String(write.producer_enumeration_status ?? "").toUpperCase() === "NOT_APPLICABLE"
			&& (write.query_producer_statement_id ?? null) === null
			&& (bindingsByObservation.get(String(write.write_observation_id))?.length ?? 0) === 0;
	for (const read of reads) {
		const readStatementId = String(read.statement_id ?? "");
		const readStatementIndex = statementIndexes.get(readStatementId);
		const physicalDataset = qualifyTaskTable(read.physical_dataset);
		if (!readStatementId || readStatementIndex === undefined || !physicalDataset) continue;
		const fields = [...(fieldsByStatement.get(readStatementId)?.values() ?? [])]
			.filter((field) => field.table === physicalDataset)
			.sort((left, right) => compareText(`${left.table}.${left.column}`, `${right.table}.${right.column}`));
		if (fields.length === 0) continue;
		const priorWrites = writes
			.filter((write) => {
				if (isSchemaOnlyCreateTable(write)) return false;
				const writeStatementId = String(write.write_statement_id ?? write.statement_id ?? "");
				const writeStatementIndex = statementIndexes.get(writeStatementId);
				return qualifyTaskTable(write.physical_dataset) === physicalDataset && writeStatementIndex !== undefined && writeStatementIndex < readStatementIndex;
			})
			.sort((left, right) => (statementIndexes.get(String(left.write_statement_id ?? left.statement_id ?? "")) ?? 0) - (statementIndexes.get(String(right.write_statement_id ?? right.statement_id ?? "")) ?? 0) || compareText(String(left.write_observation_id), String(right.write_observation_id)));
		if (priorWrites.length === 0) continue;
		const matchingSchemas = schemaRefs.filter((schemaRef) =>
			schemaRef.status === "SUCCESS" &&
			qualifyTaskTable(schemaRef.qualified_name) === physicalDataset
		);
		const nonPartitioned =
			matchingSchemas.length === 1 &&
			matchingSchemas[0]!.partition_columns.length === 0;
		let lastOverwrite = -1;
		if (nonPartitioned) {
			for (const [index, write] of priorWrites.entries()) {
				if (String(write.write_kind).toUpperCase() === "INSERT_OVERWRITE") lastOverwrite = index;
			}
		}
		const effectiveWrites = lastOverwrite >= 0
			? priorWrites.slice(lastOverwrite)
			: priorWrites;
		const accumulatedWritesProven =
			effectiveWrites.length > 1 &&
			String(effectiveWrites[0]!.write_kind).toUpperCase() === "INSERT_OVERWRITE" &&
			effectiveWrites.slice(1).every((write) => String(write.write_kind).toUpperCase() === "INSERT_INTO");
		for (const field of fields) {
			const candidatesByWrite = effectiveWrites.map((write) =>
				(bindingsByObservation.get(String(write.write_observation_id)) ?? []).filter((binding) =>
					qualifyTaskTable(binding.target_dataset) === physicalDataset && normalizeName(binding.target_field) === field.column,
				),
			);
			const candidates = candidatesByWrite.flat();
			const bridgeId = `task-local-materialization:${taskId}:${readStatementId}:${physicalDataset}:${field.column}`;
			const controlRefs = [...field.controlRefs.values()].sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
			const controlConsumption = controlRefs.length === 0 ? {} : { read_control_refs: controlRefs };
			const evidenceRefs = ["statements.jsonl", "dataset-io.jsonl", "field-expression-nodes.jsonl", "output-field-bindings.jsonl", ...(controlRefs.length === 0 ? [] : ["relation-nodes.jsonl"])];
			const producerProven = (write: DatasetIoRecord): boolean => write.resolution_status === "RESOLVED" && write.producer_enumeration_status === "COMPLETE";
			if (effectiveWrites.length === 1 && candidates.length === 1 && candidates[0]!.binding_status === "RESOLVED" && producerProven(effectiveWrites[0]!)) {
				const binding = candidates[0]!;
				const write = writeByObservation.get(binding.write_observation_id);
				const writeStatementId = String(write?.write_statement_id ?? write?.statement_id ?? binding.write_statement_id);
				const writeStatementIndex = statementIndexes.get(writeStatementId);
				if (write && writeStatementIndex !== undefined) {
					records.push({
						bridge_id: bridgeId,
						task_id: taskId,
						logical_source_id: logicalSourceId,
						physical_dataset: physicalDataset,
						column: field.column,
						write_observation_id: binding.write_observation_id,
						write_statement_id: writeStatementId,
						read_statement_id: readStatementId,
						write_statement_index: writeStatementIndex,
						read_statement_index: readStatementIndex,
						output_binding_id: binding.binding_id,
						read_expression_ids: [...field.expressionIds].sort(compareText),
						...controlConsumption,
						status: "RESOLVED",
						provenance: "SAME_TASK_SQL_WRITE_READ",
						evidence_refs: evidenceRefs,
					});
					continue;
				}
			}
			if (effectiveWrites.length === 1 && candidates.length === 0) {
				const write = effectiveWrites[0]!;
				const writeStatementId = String(write.write_statement_id ?? write.statement_id ?? "");
				const writeStatementIndex = statementIndexes.get(writeStatementId);
				const classifiedStaticPartitionColumns = new Set(
					(write.static_partition_columns ?? []).map((column) => normalizeName(column)),
				);
				const staticPartitionProvenByWrite =
					write.partition_binding_status === "COMPLETE" &&
					(write.partition_mode === "STATIC" || write.partition_mode === "MIXED") &&
					classifiedStaticPartitionColumns.has(field.column);
				const writeBindings = bindingsByObservation.get(String(write.write_observation_id)) ?? [];
				const producerOrdinals = Array.isArray(write.producer_ordinals)
					? write.producer_ordinals
					: [];
				const schemaPartitionColumns = matchingSchemas.length === 1
					? new Set(matchingSchemas[0]!.partition_columns.map(normalizeName))
					: new Set<string>();
				const staticPartitionProvenByBindings =
					producerOrdinals.length > 0 &&
					writeBindings.length === producerOrdinals.length &&
					writeBindings.every(
						(binding) =>
							binding.binding_status === "RESOLVED" &&
							binding.static_partition_columns.map(normalizeName).includes(field.column),
					) &&
					schemaPartitionColumns.has(field.column);
				const staticPartitionProducerProven =
					staticPartitionProvenByWrite || staticPartitionProvenByBindings;
				if (writeStatementIndex !== undefined && staticPartitionProducerProven && producerProven(write)) {
					records.push({
						bridge_id: bridgeId,
						task_id: taskId,
						logical_source_id: logicalSourceId,
						physical_dataset: physicalDataset,
						column: field.column,
						write_observation_id: String(write.write_observation_id),
						write_statement_id: writeStatementId,
						read_statement_id: readStatementId,
						write_statement_index: writeStatementIndex,
						read_statement_index: readStatementIndex,
						output_binding_id: null,
						producer_kind: "STATIC_PARTITION_ASSIGNMENT",
						read_expression_ids: [...field.expressionIds].sort(compareText),
						...controlConsumption,
						status: "RESOLVED",
						provenance: "SAME_TASK_SQL_WRITE_READ",
						evidence_refs: evidenceRefs,
					});
					continue;
				}
			}
			if (accumulatedWritesProven && effectiveWrites.every(producerProven) && candidatesByWrite.every((values) => values.length === 1 && values[0]!.binding_status === "RESOLVED")) {
				const bindings = candidatesByWrite.map((values) => values[0]!);
				const contributingWrites = bindings.map((binding) => writeByObservation.get(binding.write_observation_id));
				if (contributingWrites.every((write): write is DatasetIoRecord => write !== undefined)) {
					const writeStatementIds = contributingWrites.map((write) =>
						String(write.write_statement_id ?? write.statement_id),
					);
					const writeStatementIndexes = writeStatementIds.map((statementId) => statementIndexes.get(statementId));
					if (writeStatementIndexes.every((index): index is number => index !== undefined)) {
						records.push({
							bridge_id: bridgeId,
							task_id: taskId,
							logical_source_id: logicalSourceId,
							physical_dataset: physicalDataset,
							column: field.column,
							write_observation_id: null,
							write_observation_ids: bindings.map((binding) => binding.write_observation_id),
							write_statement_id: null,
							write_statement_ids: writeStatementIds,
							read_statement_id: readStatementId,
							write_statement_index: -1,
							write_statement_indexes: writeStatementIndexes,
							read_statement_index: readStatementIndex,
							output_binding_id: null,
							output_binding_ids: bindings.map((binding) => binding.binding_id),
							read_expression_ids: [...field.expressionIds].sort(compareText),
							...controlConsumption,
							status: "RESOLVED",
							provenance: "SAME_TASK_SQL_WRITE_READ",
							evidence_refs: evidenceRefs,
						});
						continue;
					}
				}
			}
			records.push({
				bridge_id: bridgeId,
				task_id: taskId,
				logical_source_id: logicalSourceId,
				physical_dataset: physicalDataset,
				column: field.column,
				write_observation_id: null,
				write_statement_id: null,
				read_statement_id: readStatementId,
				write_statement_index: effectiveWrites.length === 1
					? statementIndexes.get(String(effectiveWrites[0]!.write_statement_id ?? effectiveWrites[0]!.statement_id ?? "")) ?? -1
					: -1,
				read_statement_index: readStatementIndex,
				output_binding_id: null,
				read_expression_ids: [...field.expressionIds].sort(compareText),
				...controlConsumption,
				status: candidates.length > 1 || effectiveWrites.length > 1 ? "AMBIGUOUS" : "UNRESOLVED",
				provenance: "SAME_TASK_SQL_WRITE_READ",
				evidence_refs: evidenceRefs,
			});
		}
	}
	return [...records].sort((left, right) => compareText(left.bridge_id, right.bridge_id));
}

if (process.argv[1] && basename(process.argv[1]).startsWith("machine-facts")) {
	const args = parseArgs(process.argv.slice(2));
	const run = async (): Promise<void> => {
		const result = processProfile(args.profile, args.output, args.sourceId, args.indexMode);
		console.log(JSON.stringify({ output: result.output_root, tasks: result.tasks, index: result.index }, null, 2));
	};
	await run();
}
