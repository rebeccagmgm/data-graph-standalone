import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, fieldId, sha256 } from "../machine-facts/machine-facts-contract.ts";
import {
	canonicalBundleIdentity,
	loadCurrentTaskBundle,
	type CurrentBundleLoad,
	type JsonRecord,
} from "./current-task-bundle.ts";

export const TASK_INSPECTION_SCHEMA_VERSION = "machine-facts-task-inspection-v1";
export const TASK_INSPECTION_READER_VERSION = "1.0.0";

export interface QuestionSpec {
	readonly question_id: string;
	readonly question_type: string;
	readonly task_id: string;
	readonly output_field_seed?: readonly string[];
	readonly requested_sections: readonly string[];
	readonly stop_condition: string;
}

export interface TaskInspectionOptions {
	readonly factsRoot: string;
	readonly taskId: string;
	readonly questionSpec: QuestionSpec;
}

function normalize(value: unknown): string {
	return String(value ?? "")
		.replace(/[\`"\[\]]/g, "")
		.replace(/\s+/g, "")
		.toLowerCase();
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function compareText(left: unknown, right: unknown): number {
	const a = String(left ?? "");
	const b = String(right ?? "");
	return a < b ? -1 : a > b ? 1 : 0;
}

function stableRecordKey(record: JsonRecord): string {
	return canonicalJson(record);
}

function recordAt(
	load: CurrentBundleLoad,
	file: string,
	predicate: (record: JsonRecord) => boolean,
): { record: JsonRecord; ref: string } | undefined {
	const records = load.records[file] ?? [];
	const index = records.findIndex(predicate);
	if (index < 0) return undefined;
	return { record: records[index]!, ref: `${load.evidence[file] ?? `machine-facts:${file}`}#L${index + 1}` };
}

function evidenceForField(load: CurrentBundleLoad, file: string, record: JsonRecord): string[] {
	const found = recordAt(
		load,
		file,
		(candidate) => candidate.expression_id === record.expression_id || candidate.binding_id === record.binding_id,
	);
	return found ? [found.ref] : [];
}

function spanOf(record: JsonRecord | undefined): JsonRecord | null {
	const span = record?.source_span ?? record?.span;
	return span && typeof span === "object" ? (span as JsonRecord) : null;
}

function physicalInputFields(expression: JsonRecord | undefined): JsonRecord[] {
	if (!expression) return [];
	if (Array.isArray(expression.input_fields))
		return expression.input_fields.map((field) => ({
			logical_source_id: expression.logical_source_id ?? field.logical_source_id,
			field_id: field.field_id,
			table: field.table,
			column: field.column,
		}));
	const columns = Array.isArray(expression.input_columns) ? expression.input_columns : [];
	return columns.flatMap((column: JsonRecord) =>
		(Array.isArray(column.physical) ? column.physical : []).map((field: JsonRecord) => ({
			logical_source_id: expression.logical_source_id ?? field.logical_source_id,
			field_id: field.field_id,
			table: field.table,
			column: field.column,
		})),
	);
}

function bindingValidationIssues(
	binding: JsonRecord,
	statements: JsonRecord[],
	datasetIo: JsonRecord[],
	expression: JsonRecord | undefined,
	lineageEdges: JsonRecord[],
	logicalSourceId: string | undefined,
	duplicateTargetBindingIds: ReadonlySet<string>,
): string[] {
	const issues: string[] = [];
	const writes = datasetIo.filter((record) => record.direction === "WRITE");
	const write = writes.find((record) => record.write_observation_id === binding.write_observation_id);
	if (!write) issues.push("BINDING_WRITE_NOT_FOUND");
	if (!binding.write_observation_id || !binding.write_statement_id || !binding.query_producer_statement_id)
		issues.push("BINDING_WRITE_IDENTITY_INCOMPLETE");
	if (!Number.isInteger(binding.source_ordinal) || !Number.isInteger(binding.target_ordinal))
		issues.push("BINDING_ORDINAL_INVALID");
	if (!binding.target_field_id || !binding.target_dataset_id) issues.push("BINDING_TARGET_IDENTITY_INCOMPLETE");
	if (!binding.target_field) issues.push("BINDING_TARGET_FIELD_MISSING");
	if (duplicateTargetBindingIds.has(String(binding.binding_id))) issues.push("BINDING_TARGET_ORDINAL_DUPLICATE");
	if (
		logicalSourceId &&
		typeof binding.target_dataset === "string" &&
		typeof binding.target_field === "string" &&
		binding.target_field_id !== fieldId(logicalSourceId, binding.target_dataset, binding.target_field)
	)
		issues.push("BINDING_TARGET_FIELD_ID_MISMATCH");
	if (write) {
		if (
			write.write_kind !== binding.write_kind ||
			write.write_statement_id !== binding.write_statement_id ||
			write.statement_id !== binding.statement_id ||
			(write.query_producer_statement_id ?? null) !== binding.query_producer_statement_id ||
			write.dataset_id !== binding.target_dataset_id
		)
			issues.push("BINDING_WRITE_IDENTITY_MISMATCH");
	}
	const writeStatement = statements.find((record) => record.statement_id === binding.write_statement_id);
	const producerStatement = statements.find((record) => record.statement_id === binding.query_producer_statement_id);
	if (!writeStatement || !producerStatement) issues.push("BINDING_STATEMENT_NOT_FOUND");
	if (expression) {
		if (expression.statement_id !== binding.query_producer_statement_id)
			issues.push("BINDING_PRODUCER_EXPRESSION_MISMATCH");
		if (expression.ordinal !== binding.source_ordinal) issues.push("BINDING_SOURCE_ORDINAL_MISMATCH");
		const sourceFieldIds = physicalInputFields(expression)
			.map((field) => field.field_id)
			.filter(Boolean);
		for (const fieldId of sourceFieldIds)
			if (
				!lineageEdges.some(
					(edge) => edge.to_expression_id === expression.expression_id && edge.from_field_id === fieldId,
				)
			)
				issues.push(`BINDING_LINEAGE_EDGE_MISSING:${String(fieldId)}`);
	} else {
		issues.push("BINDING_EXPRESSION_NOT_FOUND");
	}
	if (!lineageEdges.some((edge) => edge.to_expression_id === binding.expression_id))
		issues.push("BINDING_LINEAGE_EDGE_NOT_FOUND");
	return unique(issues);
}

function gapDomain(record: JsonRecord): string {
	const reason = String(record.reason_code ?? "");
	if (reason.includes("BINDING") || reason.includes("TARGET_SCHEMA") || reason.includes("OUTPUT"))
		return "OUTPUT_BINDING";
	if (reason.includes("STAR") || reason.includes("ORIGIN") || reason.includes("PHYSICAL_FIELD")) return "BASE_ORIGIN";
	if (
		reason.includes("FILTER") ||
		reason.includes("JOIN") ||
		reason.includes("AGGREGATE") ||
		reason.includes("WINDOW") ||
		reason.includes("ROWSET")
	)
		return "ROWSET_CONTROL";
	if (reason.includes("PARSER") || reason.includes("SYNTAX")) return "PARSER";
	return "STRUCTURE";
}

function gapRecord(load: CurrentBundleLoad, record: JsonRecord, index: number): JsonRecord {
	const unknownRef = `${load.evidence["unknowns.jsonl"] ?? "machine-facts:unknowns.jsonl"}#L${index + 1}`;
	return {
		gap_id: record.unknown_id ?? `unknown:${load.taskId}:${index}`,
		gap_domain: gapDomain(record),
		outcome_class: record.outcome_class ?? "UNKNOWN",
		reason_code: record.reason_code ?? "UNKNOWN_REASON",
		message: record.message ?? "No diagnostic message supplied",
		statement_id: record.statement_id ?? null,
		subject: record.subject ?? null,
		source_locator: record.source_locator ?? null,
		evidence_refs: [unknownRef],
		...(typeof record.artifact_id === "string" ? { evidence_ids: [record.artifact_id] } : {}),
	};
}

function capability(
	name: string,
	subjectCount: number,
	load: CurrentBundleLoad,
	raw: JsonRecord | undefined,
): JsonRecord {
	if (load.state !== "CURRENT_L1") {
		return {
			capability: name,
			applicability: subjectCount > 0 ? "APPLICABLE" : "UNKNOWN",
			subject_count: subjectCount,
			resolved_count: 0,
			degraded_count: 0,
			blocked_count: subjectCount > 0 ? subjectCount : 1,
			coverage: "NOT_EVALUABLE",
			reason: load.state,
		};
	}
	const rawSubjectCount = raw?.subject_count;
	const summaryMismatch = rawSubjectCount !== undefined && Number(rawSubjectCount) !== subjectCount;
	return {
		capability: name,
		applicability: raw?.applicability ?? "UNKNOWN",
		subject_count: Number(raw?.subject_count ?? subjectCount),
		resolved_count: Number(raw?.resolved_count ?? 0),
		degraded_count: Number(raw?.degraded_count ?? 0),
		blocked_count: Number(raw?.blocked_count ?? 0),
		coverage: summaryMismatch ? "PARTIAL" : (raw?.coverage ?? "NOT_EVALUABLE"),
		...(summaryMismatch ? { reason: "CAPABILITY_SUMMARY_COUNT_MISMATCH" } : {}),
		...(Array.isArray(raw?.subject_ids) ? { subject_ids: [...raw.subject_ids].sort() } : {}),
	};
}

function capabilities(
	load: CurrentBundleLoad,
	datasetIo: JsonRecord[],
	relations: JsonRecord[],
	expressions: JsonRecord[],
	bindings: JsonRecord[],
): JsonRecord[] {
	const summary = load.records["capability-summary.json"]?.[0];
	const source = (summary?.capabilities ?? summary ?? {}) as JsonRecord;
	const readRaw = (name: string): JsonRecord | undefined =>
		(source[name] ?? source[name.toLowerCase()]) as JsonRecord | undefined;
	return [
		capability("TASK_IO", datasetIo.length, load, readRaw("TASK_IO")),
		capability(
			"RELATION_STRUCTURE",
			relations.filter((record) => record.relation_type !== "read").length,
			load,
			readRaw("RELATION_STRUCTURE"),
		),
		capability(
			"BASE_ORIGIN",
			expressions.filter((record) => record.input_dependency_status !== "NO_PHYSICAL_INPUT").length,
			load,
			readRaw("BASE_ORIGIN"),
		),
		capability("OUTPUT_BINDING", bindings.length, load, readRaw("OUTPUT_BINDING")),
	];
}

function answerStatus(
	load: CurrentBundleLoad,
	outputFields: JsonRecord[],
	rowsetControls: JsonRecord[],
	capabilitiesValue: readonly JsonRecord[],
	gaps: readonly JsonRecord[],
): "READY" | "PARTIAL" | "NOT_EVALUABLE" | "STALE" {
	if (load.state === "STALE") return "STALE";
	if (load.state !== "CURRENT_L1") return "NOT_EVALUABLE";
	const blocking =
		capabilitiesValue.some((item) => item.coverage === "NOT_EVALUABLE") ||
		outputFields.some((field) => field.status === "NOT_EVALUABLE") ||
		gaps.some((gap) =>
			["OUTPUT_BINDING", "BASE_ORIGIN", "ROWSET_CONTROL", "FRESHNESS"].includes(String(gap.gap_domain)),
		);
	const partial =
		capabilitiesValue.some((item) => item.coverage === "PARTIAL" || item.coverage === "PROFILE_ASSISTED") ||
		outputFields.some((field) => field.status === "PARTIAL") ||
		gaps.length > 0;
	const resolved = outputFields.some((field) => field.status === "READY");
	if (
		outputFields.length === 0 &&
		capabilitiesValue.some((item) => item.capability === "OUTPUT_BINDING" && item.coverage === "NOT_EVALUABLE")
	)
		return "NOT_EVALUABLE";
	if (blocking && resolved) return "PARTIAL";
	if (partial && resolved) return "PARTIAL";
	if (blocking || outputFields.length === 0 || rowsetControls.length === 0) return "NOT_EVALUABLE";
	if (partial) return "PARTIAL";
	return "READY";
}

function nextVerification(load: CurrentBundleLoad, gaps: readonly JsonRecord[], question: QuestionSpec): JsonRecord {
	if (load.state === "STALE") {
		return {
			action: "重新校验并重建当前 Bundle",
			artifact_paths: [load.indexPath, `${load.bundleDir}\\manifest.json`, load.statusPath],
			evidence_type: "CURRENT_INDEX_AND_MANIFEST_HASH",
			confirmation_role: "Machine Facts publisher/operator",
			stop_condition: question.stop_condition,
		};
	}
	if (load.state === "LEGACY_NOT_L1") {
		return {
			action: "用 L1 Contract 2.0 publisher 重建该任务，不在旧目录补写字段",
			artifact_paths: [load.indexPath, `${load.bundleDir}\\manifest.json`, `${load.bundleDir}\\statements.jsonl`],
			evidence_type: "L1_BUNDLE_REBUILD_AND_HASH_ATTESTATION",
			confirmation_role: "Machine Facts method owner",
			stop_condition: question.stop_condition,
		};
	}
	const firstGap = gaps[0];
	return {
		action: firstGap ? `核验 ${firstGap.reason_code} 的本地证据` : "无需继续静态推断；转入运行/业务核验",
		artifact_paths: firstGap?.evidence_refs ?? [load.evidence["manifest.json"] ?? "machine-facts:manifest.json"],
		evidence_type: firstGap?.gap_domain ?? "STATIC_BUNDLE_COMPLETENESS",
		confirmation_role: firstGap ? "SQL/Schema evidence reviewer" : "Scheduler or business owner",
		stop_condition: question.stop_condition,
	};
}

export function inspectTask(options: TaskInspectionOptions): JsonRecord {
	if (options.questionSpec.task_id !== options.taskId) throw new Error("QUESTION_TASK_ID_MISMATCH");
	if (
		!options.questionSpec.question_id ||
		!options.questionSpec.question_type ||
		!options.questionSpec.stop_condition
	)
		throw new Error("QUESTION_SPEC_INCOMPLETE");
	const load = loadCurrentTaskBundle(options.factsRoot, options.taskId);
	const questionSpecSha256 = sha256(canonicalJson(options.questionSpec));
	const statements = load.records["statements.jsonl"] ?? [];
	const datasetIo = load.records["dataset-io.jsonl"] ?? [];
	const relations = load.records["relation-nodes.jsonl"] ?? [];
	const expressions = load.records["field-expression-nodes.jsonl"] ?? [];
	const lineageEdges = load.records["column-lineage-edges.jsonl"] ?? [];
	const bindings = load.records["output-field-bindings.jsonl"] ?? [];
	const unknowns = load.records["unknowns.jsonl"] ?? [];
	const expressionById = new Map(expressions.map((record) => [record.expression_id, record]));
	const bindingGaps: JsonRecord[] = [];
	const targetOrdinals = new Map<string, JsonRecord[]>();
	for (const binding of bindings) {
		const key = `${String(binding.write_observation_id)}:${String(binding.target_ordinal)}`;
		targetOrdinals.set(key, [...(targetOrdinals.get(key) ?? []), binding]);
	}
	const duplicateTargetBindingIds = new Set(
		[...targetOrdinals.values()]
			.filter((items) => items.length > 1)
			.flatMap((items) => items.map((item) => String(item.binding_id))),
	);
	const bindingFields = bindings
		.slice()
		.sort(
			(left, right) =>
				Number(left.target_ordinal ?? 0) - Number(right.target_ordinal ?? 0) ||
				compareText(left.target_field, right.target_field) ||
				compareText(left.binding_id, right.binding_id) ||
				compareText(stableRecordKey(left), stableRecordKey(right)),
		)
		.filter((binding) => {
			const seeds = options.questionSpec.output_field_seed ?? [];
			return seeds.length === 0 || seeds.some((seed) => normalize(seed) === normalize(binding.target_field));
		})
		.map((binding) => {
			const expression = expressionById.get(binding.expression_id);
			const validationIssues =
				load.state === "CURRENT_L1"
					? bindingValidationIssues(
							binding,
							statements,
							datasetIo,
							expression,
							lineageEdges,
							load.manifest?.logical_source_id,
							duplicateTargetBindingIds,
						)
					: [];
			if (validationIssues.length > 0)
				bindingGaps.push({
					gap_id: `binding-validation:${String(binding.binding_id ?? binding.expression_id)}`,
					gap_domain: "OUTPUT_BINDING",
					outcome_class: "NOT_EVALUABLE",
					reason_code: "OUTPUT_BINDING_IDENTITY_NOT_CLOSED",
					message: validationIssues.join("; "),
					statement_id: binding.statement_id ?? null,
					subject: binding.write_observation_id ?? null,
					source_locator: spanOf(expression),
					evidence_refs: unique([
						...evidenceForField(load, "field-expression-nodes.jsonl", expression ?? {}),
						...evidenceForField(load, "output-field-bindings.jsonl", binding),
					]),
					evidence_ids: validationIssues,
				});
			const fieldStatus =
				load.state === "CURRENT_L1" &&
				binding.binding_status === "RESOLVED" &&
				expression?.input_dependency_status === "PHYSICAL" &&
				validationIssues.length === 0
					? "READY"
					: "NOT_EVALUABLE";
			return {
				field: binding.target_field,
				target_field_id: binding.target_field_id ?? null,
				expression: expression?.expression_text ?? null,
				source_fields: physicalInputFields(expression),
				binding: {
					write_observation_id: binding.write_observation_id ?? null,
					write_statement_id: binding.write_statement_id ?? null,
					query_producer_statement_id: binding.query_producer_statement_id ?? null,
					binding_method: binding.binding_method ?? null,
					source_ordinal: binding.source_ordinal ?? null,
					target_ordinal: binding.target_ordinal ?? null,
					binding_status: binding.binding_status ?? null,
					target_schema_status: binding.target_schema_status ?? null,
				},
				status: fieldStatus,
				sql_span: spanOf(expression),
				evidence_refs: unique([
					...evidenceForField(load, "field-expression-nodes.jsonl", expression ?? {}),
					...evidenceForField(load, "output-field-bindings.jsonl", binding),
				]),
				evidence_ids: Array.isArray(binding.evidence_refs) ? [...binding.evidence_refs].sort(compareText) : [],
			};
		});
	const rowsetControls = relations
		.filter((record) =>
			["filter", "join", "aggregate", "setop", "window", "distinct"].includes(
				String(record.relation_type).toLowerCase(),
			),
		)
		.sort(
			(left, right) =>
				compareText(left.statement_id, right.statement_id) ||
				Number(spanOf(left)?.start ?? 0) - Number(spanOf(right)?.start ?? 0) ||
				compareText(left.relation_id, right.relation_id) ||
				compareText(stableRecordKey(left), stableRecordKey(right)),
		)
		.map((record) => ({
			relation_id: record.relation_id,
			relation_type: record.relation_type,
			statement_id: record.statement_id,
			detail: record.relation ?? null,
			sql_span: spanOf(record),
			evidence_refs: [
				recordAt(load, "relation-nodes.jsonl", (candidate) => candidate.relation_id === record.relation_id)
					?.ref ??
					load.evidence["relation-nodes.jsonl"] ??
					"machine-facts:relation-nodes.jsonl",
			],
		}));
	const gaps = [
		...unknowns
			.map((record, sourceIndex) => ({ record, sourceIndex }))
			.sort(
				(left, right) =>
					compareText(gapDomain(left.record), gapDomain(right.record)) ||
					compareText(left.record.reason_code, right.record.reason_code) ||
					compareText(left.record.statement_id, right.record.statement_id) ||
					compareText(left.record.unknown_id, right.record.unknown_id) ||
					compareText(stableRecordKey(left.record), stableRecordKey(right.record)),
			)
			.map(({ record, sourceIndex }) => gapRecord(load, record, sourceIndex)),
		...bindingGaps,
	];
	if (load.state === "LEGACY_NOT_L1")
		gaps.unshift({
			gap_id: "bundle:legacy-not-l1",
			gap_domain: "CONTRACT",
			outcome_class: "NOT_EVALUABLE",
			reason_code: "LEGACY_NOT_L1",
			message: `Contract ${String(load.manifest?.schema_version ?? "unknown")} cannot produce an L1 evidence state`,
			statement_id: null,
			subject: null,
			source_locator: null,
			evidence_refs: [load.evidence["manifest.json"] ?? "machine-facts:manifest.json"],
		});
	if (load.state === "STALE" || load.state === "INVALID")
		gaps.unshift({
			gap_id: `bundle:${load.state.toLowerCase()}`,
			gap_domain: "FRESHNESS",
			outcome_class: "NOT_EVALUABLE",
			reason_code: load.issues[0] ?? load.state,
			message: load.issues.join("; ") || "Current Bundle validation failed",
			statement_id: null,
			subject: null,
			source_locator: null,
			evidence_refs: [load.indexPath],
		});
	const groupedGaps = Object.fromEntries(
		[...new Set(gaps.map((gap) => gap.gap_domain))]
			.sort()
			.map((domain) => [domain, gaps.filter((gap) => gap.gap_domain === domain)]),
	);
	const capabilitySummary = capabilities(load, datasetIo, relations, expressions, bindings);
	const card: JsonRecord = {
		schema_version: TASK_INSPECTION_SCHEMA_VERSION,
		reader_version: TASK_INSPECTION_READER_VERSION,
		result_identity_sha256: null,
		question_spec: options.questionSpec,
		question_spec_sha256: questionSpecSha256,
		task: {
			task_id: options.taskId,
			logical_source_id: load.manifest?.logical_source_id ?? load.indexRow?.logical_source_id ?? null,
			bundle_state: load.state,
			bundle_identity_sha256: canonicalBundleIdentity(load),
			contract_version: load.manifest?.schema_version ?? null,
			manifest_sha256: load.manifestSha256 ?? null,
			sql_sha256: load.manifest?.inputs?.sql_sha256 ?? load.indexRow?.sql_sha256 ?? null,
			schema_bundle_sha256: load.manifest?.inputs?.schema_bundle_sha256 ?? null,
		},
		answer: {
			status: answerStatus(load, bindingFields, rowsetControls, capabilitySummary, gaps),
			confirmation_role: load.state === "CURRENT_L1" ? "Static evidence reviewer" : "Machine Facts method owner",
			unknown: load.state === "CURRENT_L1" ? null : "当前 Bundle 不足以形成 L1 当前证据结论",
			stop_condition: options.questionSpec.stop_condition,
		},
		io: {
			reads: datasetIo
				.filter((record) => record.direction === "READ")
				.sort(
					(left, right) =>
						normalize(left.physical_dataset).localeCompare(normalize(right.physical_dataset)) ||
						compareText(left.statement_id, right.statement_id) ||
						compareText(left.dataset_id, right.dataset_id) ||
						compareText(left.provenance, right.provenance) ||
						compareText(stableRecordKey(left), stableRecordKey(right)),
				)
				.map((record) => ({
					...record,
					evidence_refs: [
						recordAt(load, "dataset-io.jsonl", (candidate) => candidate === record)?.ref ??
							load.evidence["dataset-io.jsonl"] ??
							"machine-facts:dataset-io.jsonl",
					],
				})),
			writes: datasetIo
				.filter((record) => record.direction === "WRITE")
				.sort(
					(left, right) =>
						normalize(left.physical_dataset).localeCompare(normalize(right.physical_dataset)) ||
						compareText(left.write_observation_id, right.write_observation_id) ||
						compareText(left.statement_id, right.statement_id) ||
						compareText(left.provenance, right.provenance) ||
						compareText(stableRecordKey(left), stableRecordKey(right)),
				)
				.map((record) => ({
					...record,
					evidence_refs: [
						recordAt(load, "dataset-io.jsonl", (candidate) => candidate === record)?.ref ??
							load.evidence["dataset-io.jsonl"] ??
							"machine-facts:dataset-io.jsonl",
					],
				})),
		},
		output_fields: bindingFields,
		rowset_controls: {
			status: load.state === "CURRENT_L1" && rowsetControls.length > 0 ? "READY" : "NOT_EVALUABLE",
			records: rowsetControls,
		},
		capabilities: capabilitySummary,
		evidence: {
			manifest_ref: load.evidence["manifest.json"] ?? `${load.indexPath}#task=${options.taskId}`,
			statement_refs: statements
				.slice()
				.sort(
					(left, right) =>
						compareText(left.statement_id, right.statement_id) ||
						Number(left.statement_index ?? 0) - Number(right.statement_index ?? 0) ||
						Number(spanOf(left)?.start ?? 0) - Number(spanOf(right)?.start ?? 0) ||
						compareText(stableRecordKey(left), stableRecordKey(right)),
				)
				.map((record) => ({
					statement_id: record.statement_id,
					span: record.span ?? null,
					ref:
						recordAt(
							load,
							"statements.jsonl",
							(candidate) => candidate.statement_id === record.statement_id,
						)?.ref ??
						load.evidence["statements.jsonl"] ??
						"machine-facts:statements.jsonl",
				})),
			bundle_files: Object.fromEntries(
				Object.entries(load.evidence).sort(([left], [right]) => left.localeCompare(right)),
			),
		},
		gaps: { count: gaps.length, grouped: groupedGaps },
		next_verification: nextVerification(load, gaps, options.questionSpec),
		boundaries: {
			static_analysis_only: true,
			runtime_execution: "NOT_EVALUATED",
			business_rows_read: false,
			business_acceptance: "NOT_EVALUATED",
			scheduler_execution: "NOT_EVALUATED",
		},
	};
	card.result_identity_sha256 = sha256(canonicalJson({ ...card, result_identity_sha256: null }));
	return card;
}

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export function renderTaskInspectionHtml(card: JsonRecord): string {
	const fields = Array.isArray(card.output_fields) ? card.output_fields : [];
	const controls = Array.isArray(card.rowset_controls?.records) ? card.rowset_controls.records : [];
	const capabilitiesValue = Array.isArray(card.capabilities) ? card.capabilities : [];
	const gaps = card.gaps?.grouped ?? {};
	const fieldHtml = fields
		.map(
			(field: JsonRecord) =>
				`<details open><summary>${escapeHtml(field.field)} · ${escapeHtml(field.status)}</summary><p><strong>Expression</strong></p><pre>${escapeHtml(field.expression)}</pre><p><strong>Sources</strong></p><pre>${escapeHtml(JSON.stringify(field.source_fields, null, 2))}</pre><p><strong>Span / evidence</strong></p><pre>${escapeHtml(JSON.stringify({ sql_span: field.sql_span, evidence_refs: field.evidence_refs }, null, 2))}</pre></details>`,
		)
		.join("\n");
	const controlHtml = controls
		.map(
			(record: JsonRecord) =>
				`<details><summary>${escapeHtml(record.relation_type)} · ${escapeHtml(record.statement_id)}</summary><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre></details>`,
		)
		.join("\n");
	const gapHtml = Object.entries(gaps)
		.map(
			([domain, records]) =>
				`<details><summary>${escapeHtml(domain)} (${Array.isArray(records) ? records.length : 0})</summary><pre>${escapeHtml(JSON.stringify(records, null, 2))}</pre></details>`,
		)
		.join("\n");
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Task Inspection ${escapeHtml(card.task?.task_id)}</title><style>body{font:14px system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#18202a}header{border-bottom:1px solid #ccd3da;margin-bottom:1rem}section{margin:1.25rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:.75rem;border-radius:6px}details{margin:.5rem 0;border:1px solid #d9dee4;border-radius:6px;padding:.5rem}summary{cursor:pointer;font-weight:600}.status{font-size:1.25rem}</style></head><body><header><h1>Task Inspection: ${escapeHtml(card.task?.task_id)}</h1><p class="status">Answer: <strong>${escapeHtml(card.answer?.status)}</strong> · Bundle: <strong>${escapeHtml(card.task?.bundle_state)}</strong></p><p>${escapeHtml(card.answer?.unknown ?? "当前静态证据可供检查")}</p></header><section><h2>I/O</h2><pre>${escapeHtml(JSON.stringify(card.io, null, 2))}</pre></section><section><h2>Output fields</h2>${fieldHtml || "<p>No output field can be exposed under the current evidence state.</p>"}</section><section><h2>Rowset controls</h2>${controlHtml || "<p>NOT_EVALUABLE</p>"}</section><section><h2>Capabilities</h2><pre>${escapeHtml(JSON.stringify(capabilitiesValue, null, 2))}</pre></section><section><h2>Gaps</h2>${gapHtml || "<p>None recorded.</p>"}</section><section><h2>Next verification / boundaries</h2><pre>${escapeHtml(JSON.stringify({ next_verification: card.next_verification, boundaries: card.boundaries, evidence: card.evidence }, null, 2))}</pre></section></body></html>\n`;
}

export function writeTaskInspection(options: TaskInspectionOptions & { readonly outputDir: string }): JsonRecord {
	const card = inspectTask(options);
	const factsRoot = resolve(options.factsRoot);
	const outputDir = resolve(options.outputDir);
	const relativeOutput = relative(factsRoot, outputDir);
	if (relativeOutput === "" || (!relativeOutput.startsWith("..") && !isAbsolute(relativeOutput)))
		throw new Error("DERIVED_OUTPUT_MUST_NOT_BE_UNDER_FACTS_ROOT");
	const factsRootReal = realpathSync.native(factsRoot);
	let current = outputDir;
	while (true) {
		const stat = lstatSafe(current);
		if (stat) {
			if (stat.isSymbolicLink()) throw new Error("DERIVED_OUTPUT_SYMLINK_PATH");
			const currentReal = realpathSync.native(current);
			const escaped = relative(factsRootReal, currentReal);
			if (escaped === "" || (!escaped.startsWith("..") && !isAbsolute(escaped)))
				throw new Error("DERIVED_OUTPUT_REALPATH_UNDER_FACTS_ROOT");
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const file of [resolve(outputDir, "task-inspection.json"), resolve(outputDir, "index.html")])
		if (lstatSafe(file)?.isSymbolicLink()) throw new Error("DERIVED_OUTPUT_SYMLINK_FILE");
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(resolve(outputDir, "task-inspection.json"), canonicalJson(card), "utf8");
	writeFileSync(resolve(outputDir, "index.html"), renderTaskInspectionHtml(card), "utf8");
	return card;
}

function lstatSafe(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

function option(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function main(): void {
	const args = process.argv.slice(2);
	const factsRoot = option(args, "--facts-root");
	const taskId = option(args, "--task-id");
	const questionPath = option(args, "--question-spec");
	const outputDir = option(args, "--output");
	if (!factsRoot || !taskId || !questionPath || !outputDir)
		throw new Error(
			"usage: task-inspection.ts --facts-root <root> --task-id <id> --question-spec <json> --output <dir>",
		);
	const questionSpec = JSON.parse(readFileSync(resolve(questionPath), "utf8")) as QuestionSpec;
	const card = writeTaskInspection({ factsRoot, taskId, questionSpec, outputDir });
	process.stdout.write(
		`${JSON.stringify({ output: resolve(outputDir), task_id: taskId, answer_status: card.answer.status, bundle_state: card.task.bundle_state, result_identity_sha256: card.result_identity_sha256 })}\n`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
