import { createHash } from "node:crypto";

export const MACHINE_FACTS_CONTRACT_VERSION = "1.3.0";
export const MACHINE_FACTS_STATUS_VERSION = "1.0.0";
export const MACHINE_FACTS_ADAPTER_VERSION = "1.3.20";

/** Canonical evidence kind for a Pack-declared query output write. */
export const PACK_DECLARED_QUERY_OUTPUT = "PACK_DECLARED_QUERY_OUTPUT" as const;
/** Legacy value retained so already-published bundles remain readable. */
export const LEGACY_PLATFORM_TARGET_QUERY_OUTPUT = "PLATFORM_TARGET_QUERY_OUTPUT" as const;
export type PlatformTargetQueryOutputKind =
	| typeof PACK_DECLARED_QUERY_OUTPUT
	| typeof LEGACY_PLATFORM_TARGET_QUERY_OUTPUT;
export type OutputEvidenceKind = "SQL_EXPLICIT_WRITE" | PlatformTargetQueryOutputKind;

export function isPlatformTargetQueryOutputKind(value: unknown): value is PlatformTargetQueryOutputKind {
	return value === PACK_DECLARED_QUERY_OUTPUT || value === LEGACY_PLATFORM_TARGET_QUERY_OUTPUT;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type OutcomeClass = "UNKNOWN" | "NOT_EVALUABLE" | "NOT_APPLICABLE" | "FAILURE";
export type AnalysisState = "ANALYZING" | "SUCCESS" | "FAILED";
export type InputDependencyStatus = "PHYSICAL" | "DERIVED_OUTPUT" | "SQL_CANDIDATE" | "PARTIAL" | "UNRESOLVED" | "NO_PHYSICAL_INPUT";

export interface FailureOutcome {
	readonly outcome_class: OutcomeClass;
	readonly reason_code: string;
	readonly message: string;
	readonly subject?: string;
	readonly source_locator?: { readonly file?: string; readonly statement_id?: string; readonly start?: number; readonly end?: number };
}

export interface AnalysisStatus {
	readonly schema_version: typeof MACHINE_FACTS_STATUS_VERSION;
	readonly task_id: string;
	readonly logical_source_id: string;
	readonly state: AnalysisState;
	readonly requested: {
		readonly sql_sha256: string;
		readonly schema_bundle_sha256: string;
		readonly analysis_config_sha256: string;
		readonly dialect: string;
	};
	readonly current_manifest_sha256: string | null;
	readonly failure?: FailureOutcome;
}

export interface OutputRecord {
	readonly path: string;
	readonly schema_version: string;
	readonly row_count: number;
	readonly content_sha256: string;
}

export interface MachineFactsManifest {
	readonly schema_version: typeof MACHINE_FACTS_CONTRACT_VERSION;
	readonly task_id: string;
	readonly logical_source_id: string;
	readonly status: "SUCCESS";
	readonly inputs: {
		readonly sql_sha256: string;
		readonly sql_snapshot: string;
		readonly schema_bundle_sha256: string;
		readonly schema_snapshot: string;
		readonly analysis_config_sha256: string;
		readonly input_pack?: InputPackProvenance;
	};
	readonly method: {
		readonly dialect: string;
		readonly parser: { readonly engine: string; readonly version: string };
		readonly adapter: { readonly name: "machine-facts-writer"; readonly version: string };
		readonly plan_adapter: { readonly name: "plan-adapter"; readonly version: string };
	};
	readonly outputs: readonly OutputRecord[];
	readonly counts: {
		readonly statements: number;
		readonly schema_refs: number;
		readonly dataset_io: number;
		readonly relation_nodes: number;
		readonly relation_edges: number;
		readonly field_expression_nodes: number;
		readonly column_lineage_edges: number;
		readonly lineage_hop_roots: number;
		readonly lineage_hop_nodes: number;
		readonly lineage_hop_edges: number;
		readonly lineage_hop_projected_roots: number;
		readonly lineage_hop_partial_roots: number;
		readonly lineage_hop_not_evaluable_roots: number;
		readonly output_field_bindings: number;
		readonly task_local_materializations: number;
		readonly unknowns: number;
		readonly unknowns_by_outcome: Readonly<Record<OutcomeClass, number>>;
	};
	readonly gates: Readonly<Record<string, boolean>>;
	readonly boundaries: {
		readonly business_logic_correctness: "NOT_EVALUATED";
		readonly runtime_execution: "NOT_EVALUATED";
		readonly business_rows_read: false;
		readonly external_model_calls: 0;
		readonly cross_task_field_stitching: "NOT_GENERATED";
	};
}

export interface StatementRecord { readonly statement_id: string; readonly task_id: string; readonly statement_index: number; readonly statement_type: string; readonly span: { readonly start: number; readonly end: number }; readonly raw_sql: string; readonly parse_status: string; readonly [key: string]: unknown; }
export interface SchemaReferenceRecord {
	readonly schema_ref_id: string;
	readonly logical_source_id: string;
	readonly qualified_name: string | null;
	readonly guid: string | null;
	readonly status: string;
	readonly source: string | null;
	readonly metadata_qualified_name: string | null;
	readonly ddl_sha256: string | null;
	readonly table_status: string | null;
	readonly required_for_star: boolean;
	readonly physical_columns: readonly unknown[];
	readonly partition_columns: readonly string[];
	readonly [key: string]: unknown;
}
export interface DatasetIoRecord {
	readonly task_id: string;
	readonly direction: string;
	readonly dataset_id: string;
	readonly physical_dataset: string;
	readonly provenance: string;
	readonly resolution_status: string;
	readonly write_kind?: string;
	readonly write_observation_id?: string;
	readonly write_statement_id?: string;
	readonly query_producer_statement_id?: string | null;
	readonly source_sql_sha256?: string;
	readonly target_resolution_method?: PlatformTargetQueryOutput["target_resolution_method"];
	readonly query_output_binding_contract?: QueryOutputBindingContract;
	readonly partition_status?: PlatformTargetQueryOutput["partition_status"];
	readonly partition_binding_status?: PartitionBindingStatus;
	readonly partition_mode?: PartitionBindingMode;
	readonly partition_columns?: readonly string[];
	readonly partition_assignments?: readonly PlatformPartitionAssignment[];
	readonly static_partition_columns?: readonly string[];
	readonly dynamic_partition_columns?: readonly string[];
	readonly read_occurrences?: readonly unknown[];
	readonly [key: string]: unknown;
}
export interface TaskLocalControlReadRef {
	readonly relation_id: string;
	readonly read_relation_id: string | null;
	readonly read_occurrence_id: string | null;
	readonly resolution_status: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED";
	readonly reason_code?: string;
}
export interface TaskLocalMaterializationRecord {
	readonly bridge_id: string;
	readonly task_id: string;
	readonly logical_source_id: string;
	readonly physical_dataset: string;
	readonly column: string;
	readonly write_observation_id: string | null;
	readonly write_observation_ids?: readonly string[];
	readonly write_statement_id: string | null;
	readonly write_statement_ids?: readonly string[];
	readonly read_statement_id: string;
	readonly write_statement_index: number;
	readonly write_statement_indexes?: readonly number[];
	readonly read_statement_index: number;
	readonly output_binding_id: string | null;
	readonly output_binding_ids?: readonly string[];
	readonly producer_kind?: "OUTPUT_BINDING" | "STATIC_PARTITION_ASSIGNMENT";
	readonly read_expression_ids: readonly string[];
	/** Control-only consumers never populate read_expression_ids. Each reference
	 * retains its FILTER/JOIN relation and independently proven physical read. */
	readonly read_control_refs?: readonly TaskLocalControlReadRef[];
	readonly status: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED";
	readonly provenance: "SAME_TASK_SQL_WRITE_READ";
	readonly evidence_refs: readonly string[];
	readonly [key: string]: unknown;
}
export interface RelationNodeRecord { readonly relation_id: string; readonly task_id: string; readonly statement_id: string; readonly relation_type: string; readonly source_span: unknown; readonly provenance: string; readonly relation: unknown; readonly [key: string]: unknown; }
export interface RelationEdgeRecord { readonly edge_id: string; readonly task_id: string; readonly statement_id: string; readonly from_relation_id: string; readonly to_relation_id: string; readonly edge_type: string; readonly provenance: string; readonly source_span: unknown; readonly [key: string]: unknown; }
export type WindowInputRole = "VALUE" | "WINDOW_PARTITION" | "WINDOW_ORDER";
export interface ExpressionRoleBindingRecord {
	readonly operator: "CASE" | "IF" | "COALESCE";
	readonly role: "BRANCH_SELECTOR" | "RESULT_VALUE" | "COALESCE_ARGUMENT";
	readonly effects: readonly ("VALUE_CONTRIBUTION" | "BRANCH_SELECTION")[];
	readonly path: string;
	readonly branch_ordinal?: number;
	readonly ordinal: number;
	readonly expression_text: string;
	readonly display_text: string;
	readonly source_span: unknown;
	readonly input_fields: readonly unknown[];
	readonly candidate_input_fields?: readonly unknown[];
	readonly unresolved_input_columns: readonly unknown[];
	readonly input_dependency_status: InputDependencyStatus;
}
export interface WindowInputBindingRecord {
	readonly role: WindowInputRole;
	readonly ordinal: number;
	readonly expression_text: string;
	readonly display_text: string;
	readonly source_span: unknown;
	readonly input_fields: readonly unknown[];
	readonly candidate_input_fields?: readonly unknown[];
	readonly unresolved_input_columns: readonly unknown[];
	readonly input_dependency_status: InputDependencyStatus;
	readonly direction?: "ASC" | "DESC";
	readonly nulls?: "FIRST" | "LAST" | "UNSPECIFIED";
}
export interface WindowSpecRecord {
	readonly expression_text: string;
	readonly display_text: string;
	readonly source_span: unknown;
	readonly input_bindings: readonly WindowInputBindingRecord[];
	readonly frame?: {
		readonly status: "EXTRACTED" | "UNKNOWN";
		readonly expression_text: string | null;
		readonly display_text: string | null;
		readonly source_span: unknown;
		readonly input_fields: readonly unknown[];
		readonly unresolved_input_columns: readonly unknown[];
		readonly input_dependency_status: InputDependencyStatus;
		readonly reason?: string;
	};
}
export interface FieldExpressionRecord { readonly expression_id: string; readonly task_id: string; readonly statement_id: string; readonly relation_id: string; readonly role: string; readonly ordinal: number; readonly output_name?: string; readonly output_name_status?: string; readonly expression_text: string; /** New bundles emit display_text; legacy bundles may omit it. */ readonly display_text?: string; readonly source_span: unknown; readonly input_fields: readonly unknown[]; readonly candidate_input_fields?: readonly unknown[]; readonly unresolved_input_columns: readonly unknown[]; readonly input_dependency_status: InputDependencyStatus; readonly expression_roles?: readonly ExpressionRoleBindingRecord[]; readonly window_spec?: WindowSpecRecord; readonly artifact_id?: string; readonly [key: string]: unknown; }
export interface ColumnLineageRecord { readonly edge_id: string; readonly task_id: string; readonly statement_id: string; readonly from_field_id: string; readonly to_expression_id: string; readonly method: string; readonly resolution_provenance: string; readonly [key: string]: unknown; }
export type HopCoverageState = "FULL_HOP" | "FLAT_ORIGIN_ONLY" | "UNKNOWN_COVERAGE" | "NOT_EVALUABLE";
export type HopProjectionStatus = "PROJECTED" | "PARTIAL_NATIVE" | "NOT_EVALUABLE";
export type HopEdgeType = "PHYSICAL_FIELD_TO_HOP" | "HOP_TO_HOP";
export interface LineageHopRootRecord {
	readonly root_id: string;
	readonly task_id: string;
	readonly statement_id: string;
	readonly root_expression_id: string;
	readonly head_hop_id: string | null;
	readonly coverage_state: HopCoverageState;
	readonly projection_status: HopProjectionStatus;
	readonly reason_code?: string;
	readonly reason?: string;
	readonly flow_kind: "VALUE_LINEAGE";
	readonly physical_input_field_ids: readonly string[];
	readonly candidate_input_field_ids: readonly string[];
	readonly [key: string]: unknown;
}
export interface LineageHopNodeRecord {
	readonly hop_id: string;
	readonly task_id: string;
	readonly statement_id: string;
	readonly scope_relation_id: string;
	readonly expression_id: string | null;
	readonly expr_kind: string;
	readonly expression_text: string;
	readonly source_span: unknown;
	readonly terminal_field_ids: readonly string[];
	readonly terminal: "PRESENT" | "NONE" | "UNRESOLVED";
	readonly has_downstream: boolean;
	readonly via_relation_ids: readonly { relation_id: string; kind: "rename" | "expand" }[];
	readonly flow_kind: "VALUE_LINEAGE";
	readonly [key: string]: unknown;
}
export interface LineageHopEdgeRecord {
	readonly edge_id: string;
	readonly task_id: string;
	readonly statement_id: string;
	readonly edge_type: HopEdgeType;
	readonly from_field_id: string | null;
	readonly from_hop_id: string | null;
	readonly to_hop_id: string;
	readonly branch_relation_id: string | null;
	readonly branch_ordinal: number | null;
	readonly flow_kind: "VALUE_LINEAGE";
	readonly [key: string]: unknown;
}
export interface OutputFieldBindingRecord {
	readonly binding_id: string;
	readonly task_id: string;
	readonly write_observation_id: string;
	readonly write_kind: string;
	readonly write_statement_id: string;
	readonly query_producer_statement_id: string | null;
	readonly statement_id: string;
	readonly expression_id: string;
	readonly target_dataset_id: string;
	readonly target_field_id: string;
	readonly target_dataset: string;
	readonly target_field: string;
	readonly source_ordinal: number;
	readonly target_ordinal: number;
	readonly binding_method: "EXPLICIT_TARGET_COLUMN_LIST" | "SQL_CREATE_POSITIONAL" | "TARGET_SCHEMA_POSITIONAL";
	readonly binding_status: "RESOLVED";
	readonly target_schema_status: "MATCH" | "DRIFT_EXTRA_TARGET_COLUMNS" | "NOT_AVAILABLE";
	readonly static_partition_columns: readonly string[];
	readonly dynamic_partition_columns?: readonly string[];
	readonly evidence_refs: readonly string[];
	readonly evidence_kind?: OutputEvidenceKind;
	readonly source_sql_sha256?: string;
	readonly [key: string]: unknown;
}
export interface UnknownOutcomeRecord { readonly outcome_class: OutcomeClass; readonly reason_code: string; readonly message: string; readonly [key: string]: unknown; }
export interface SourceArtifactRecord { readonly schema_version: string; readonly task_id: string; readonly logical_source_id: string; readonly sql_snapshot: string; readonly sql_sha256: string; readonly byte_length: number; readonly encoding: string; readonly sql_slot?: string; readonly [key: string]: unknown; }
export interface TaskFactIndexRecord { readonly task_id: string; readonly logical_source_id: string; readonly sql_sha256: string; readonly manifest_sha256: string; readonly bundle_path: string; readonly status: "SUCCESS"; readonly [key: string]: unknown; }
export type MachineFactRecord = StatementRecord | SchemaReferenceRecord | DatasetIoRecord | TaskLocalMaterializationRecord | RelationNodeRecord | RelationEdgeRecord | FieldExpressionRecord | ColumnLineageRecord | LineageHopRootRecord | LineageHopNodeRecord | LineageHopEdgeRecord | OutputFieldBindingRecord | UnknownOutcomeRecord | SourceArtifactRecord | TaskFactIndexRecord;

export interface GenericTaskProfile {
  /** Source semantics that differ from the shared parser dialect. */
  readonly source_sql_family?: "oracle";
  readonly standardized_input?: import("../input/shared/standardized-sql.ts").StandardizedInput;
	readonly task_id: string;
	readonly sql_snapshot: string;
	readonly default_schema?: string;
	readonly writes?: string | readonly string[];
	readonly sql_slot?: string;
	readonly sql_segments?: readonly { readonly slot: string; readonly start: number; readonly end: number }[];
	readonly input_pack_provenance?: InputPackProvenance;
	readonly platform_target_query_output?: PlatformTargetQueryOutput;
	readonly write_partition_evidence?: WritePartitionEvidence;
	readonly sql_write_partition_evidence?: readonly SqlWritePartitionEvidence[];
}

export interface InputPackProvenance {
	readonly schema_version: "machine-facts-input-pack-provenance-v1";
	readonly data_root: string;
	readonly task_locator: string;
	readonly task_content_hash: string;
	readonly sql_slot: string;
	readonly sql_locator: string;
	readonly sql_sha256: string;
	readonly sql_sources?: readonly { readonly slot: string; readonly locator: string; readonly sha256: string }[];
	readonly analysis_sql_sha256?: string;
	readonly table_locator: string;
	readonly table_content_hash: string;
	readonly ddl_locator: string;
	readonly ddl_sha256: string;
}

export type PartitionBindingMode = "STATIC" | "DYNAMIC" | "MIXED" | "NONE" | "UNKNOWN";
export type PartitionBindingStatus = "NOT_PARTITIONED" | "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | "CONFLICT";
export type QueryOutputBindingContract = "SPARKINDEX_FULL_WIDTH_POSITIONAL" | "PLATFORM_TARGET_SCHEMA_POSITIONAL";

export interface PlatformPartitionAssignment {
	readonly field: string;
	readonly status: "CONFIRMED" | "RUNTIME_EXPRESSION" | "UNKNOWN" | "CONFLICT";
	readonly mapping_method:
		| "STATIC_SQL_ASSIGNMENT"
		| "DYNAMIC_PARTITION_OUTPUT_ORDINAL"
		| "SCHEDULER_EXPLICIT_FIELD_VALUE"
		| "UNKNOWN"
		| "CONFLICT";
	readonly evidence_refs: readonly string[];
	readonly reason?: string;
}

export interface PlatformTargetQueryOutput {
  readonly target_columns?: readonly string[];
	readonly target: string;
	readonly target_resolution_method?: "DIRECT_PLATFORM_TARGET" | "SPARKINDEX_TASK_TARGET";
	readonly query_output_slot?: string;
	readonly query_output_binding_contract?: QueryOutputBindingContract;
	readonly partition_status: "NOT_PARTITIONED" | "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | "CONFLICT";
	readonly partition_columns: readonly string[];
	readonly partition_mode?: PartitionBindingMode;
	readonly partition_assignments?: readonly PlatformPartitionAssignment[];
	readonly evidence_refs: readonly string[];
}

export interface WritePartitionEvidence {
	readonly status: "NOT_PARTITIONED" | "COMPLETE" | "INCOMPLETE" | "UNKNOWN" | "CONFLICT";
	readonly partition_columns: readonly string[];
	readonly evidence_refs: readonly string[];
}

export interface SqlWritePartitionEvidence extends WritePartitionEvidence {
	readonly target: string;
	readonly sql_slot?: string;
	readonly statement_ordinal?: number;
	/** Zero-based character offsets within the source SQL slot. */
	readonly statement_start?: number;
	readonly statement_end?: number;
}

export interface GenericAnalysisProfile {
	readonly schema_version: string;
	readonly dialect: string;
	readonly logical_source_id?: string;
	readonly schema_evidence?: string | readonly string[];
	readonly tasks: readonly GenericTaskProfile[];
}

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
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

export function canonicalJson(value: unknown): string {
	return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function canonicalJsonl(records: readonly unknown[]): string {
	return records.map((record) => JSON.stringify(canonicalValue(record))).join("\n") + (records.length ? "\n" : "");
}

export function safeSegment(value: string, label: string): string {
	const reserved = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) || /[. ]$/.test(value) || reserved.test(value)) {
		throw new Error(`${label} must be a safe path segment`);
	}
	return value;
}

export function normalizeName(value: string): string {
	return value.replace(/[`"\[\]]/g, "").replace(/\s+/g, "").toLowerCase();
}

export function datasetId(logicalSourceId: string, name: string): string {
	return `dataset:${safeSegment(logicalSourceId, "logical_source_id")}:${normalizeName(name)}`;
}

export function fieldId(logicalSourceId: string, table: string, column: string): string {
	return `field:${safeSegment(logicalSourceId, "logical_source_id")}:${normalizeName(table)}.${normalizeName(column)}`;
}

export function stripVolatile(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripVolatile);
	if (!isPlainObject(value)) return value;
	const volatile = new Set(["captured_at", "capture_path", "source_path", "captured_path", "output_path", "generated_at"]);
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !volatile.has(key))
			.map(([key, item]) => [key, stripVolatile(item)]),
	);
}

export function stableRecords(records: readonly Record<string, unknown>[], key: (record: Record<string, unknown>) => string): Record<string, unknown>[] {
	return [...records].sort((left, right) => key(left).localeCompare(key(right)));
}
