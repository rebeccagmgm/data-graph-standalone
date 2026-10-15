import {
	canonicalJson,
	sha256,
	type InputDependencyStatus,
} from "../../../../../machine-facts/machine-facts-contract.ts";
import {
	physicalFieldKey,
	type PhysicalFieldIdentity,
} from "../../../../../reconcile/shared/physical-field.ts";
import type {
	DatasetControlAnnotation,
	DatasetControlGrain,
	DatasetControlGrainReason,
	FieldConditionalAnnotation,
	OpenLineageIndirectSubtype,
} from "../../../../../reconcile/shared/field-control-contract.ts";

export { physicalFieldKey } from "../../../../../reconcile/shared/physical-field.ts";
export type { PhysicalFieldIdentity } from "../../../../../reconcile/shared/physical-field.ts";
export type {
	DatasetControlAnnotation,
	DatasetControlGrain,
	DatasetControlGrainReason,
	DatasetControlJoinType,
	DatasetControlSide,
	FieldConditionalAnnotation,
	OpenLineageIndirectSubtype,
} from "../../../../../reconcile/shared/field-control-contract.ts";

export const FIELD_LINEAGE_SCHEMA_VERSION = "1.2.0" as const;
export const FIELD_LINEAGE_ARTIFACT_TYPE = "FIELD_MULTI_HOP_RECONCILIATION" as const;

export type FieldEvidenceStatus =
	| "CONFIRMED"
	| "PROVISIONAL_LEGACY"
	| "CANDIDATE"
	| "UNRESOLVED";
export type FieldLineageOverallStatus = "COMPLETE" | "PARTIAL" | "BLOCKED";
export type FactsPolicy = "current-only" | "allow-legacy-partial";

export interface PhysicalTableIdentity {
	readonly platform: string;
	readonly dataSource: string;
	readonly stableTableId: string;
	readonly qualifiedName: string;
}

export interface FieldLineageRequest {
	readonly rootTaskId: string;
	readonly rootTable: string;
	/** Selected Write Observations for this root target. */
	readonly rootWriteObservationIds: readonly string[];
	readonly rootFields: readonly string[];
	readonly rootFieldSelection?: "EXPLICIT" | "ALL_TARGET_COLUMNS";
	readonly factsPolicy: FactsPolicy;
}

export interface FieldLineageNode {
	readonly nodeId: string;
	readonly taskId: string;
	readonly taskName: string | null;
	readonly depth: number;
	readonly field: PhysicalFieldIdentity;
	readonly bindingId: string | null;
	readonly expressionId: string | null;
	readonly expressionText: string | null;
	/** Machine Facts classification for the output expression's physical inputs. */
	readonly inputDependencyStatus?: InputDependencyStatus;
	readonly evidenceStatus: Exclude<FieldEvidenceStatus, "CANDIDATE">;
}

export interface FieldLineageEdge {
	readonly edgeId: string;
	readonly fromNodeId: string;
	readonly toNodeId: string;
	readonly consumerTaskId: string;
	readonly producerTaskId: string | null;
	readonly kind: "VALUE_FLOW";
	readonly mapping: string;
	readonly evidenceStatus: "CONFIRMED" | "PROVISIONAL_LEGACY" | "UNRESOLVED";
	readonly evidenceRefs: readonly string[];
}

export type OpenLineageDirectSubtype = "IDENTITY" | "TRANSFORMATION" | "AGGREGATION";

export interface FieldProducerCandidate {
	readonly candidateId: string;
	readonly consumerTaskId: string;
	readonly producerTaskId: string;
	readonly field: PhysicalFieldIdentity | null;
	readonly evidenceStatus: "CANDIDATE";
	readonly reasonCode: string;
}

export interface FieldLineageGap {
	readonly gapId: string;
	readonly taskId: string;
	readonly nodeId: string | null;
	readonly field: PhysicalFieldIdentity | null;
	readonly reasonCode: string;
	readonly message: string;
	readonly evidenceStatus: "UNRESOLVED";
	readonly evidenceRefs: readonly string[];
}

export interface FieldLineageTableEdge {
	readonly consumerTaskId: string;
	readonly producerTaskId: string;
	readonly classification: "PRIMARY" | "ADDITIONAL" | "UNKNOWN";
}

export interface FieldLineageLimits {
	readonly maxDepth: number;
	readonly maxStates: number;
	readonly maxPaths: number;
	readonly truncated: boolean;
	readonly reasons: readonly ("MAX_DEPTH_REACHED" | "MAX_STATES_REACHED" | "MAX_PATHS_REACHED")[];
}

export interface FieldLineageArtifact {
	readonly schemaVersion: typeof FIELD_LINEAGE_SCHEMA_VERSION;
	readonly artifactType: typeof FIELD_LINEAGE_ARTIFACT_TYPE;
	readonly generatedAt: string;
	readonly request: FieldLineageRequest;
	readonly overallStatus: FieldLineageOverallStatus;
	readonly rootNodeIds: readonly string[];
	readonly nodes: readonly FieldLineageNode[];
	readonly edges: readonly FieldLineageEdge[];
	readonly datasetControls: readonly DatasetControlAnnotation[];
	readonly fieldConditionals: readonly FieldConditionalAnnotation[];
	readonly candidates: readonly FieldProducerCandidate[];
	readonly gaps: readonly FieldLineageGap[];
	readonly tableEdges: readonly FieldLineageTableEdge[];
	readonly limits: FieldLineageLimits;
	readonly counts: {
		readonly nodes: number;
		readonly edges: number;
		readonly datasetControls: number;
		readonly fieldConditionals: number;
		readonly candidates: number;
		readonly gaps: number;
	};
	readonly boundaries: {
		readonly staticSqlOnly: true;
		readonly runtimeExecution: "NOT_EVALUATED";
		readonly dataCorrectness: "NOT_EVALUATED";
		readonly businessAcceptance: "NOT_EVALUATED";
	};
	readonly contentHash: string;
}

type ArtifactInput = Omit<FieldLineageArtifact, "counts" | "contentHash">;

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T>(items: readonly T[], key: (item: T) => string): T[] {
	const byKey = new Map<string, T>();
	for (const item of items) byKey.set(key(item), item);
	return [...byKey.values()].sort((left, right) => compareText(key(left), key(right)));
}

function hashProjection(artifact: Omit<FieldLineageArtifact, "contentHash">): string {
	const { generatedAt: _generatedAt, ...stable } = artifact;
	return sha256(canonicalJson(stable));
}

export function canonicalizeFieldLineageArtifact(input: ArtifactInput): FieldLineageArtifact {
	const rootFields = [...new Set(input.request.rootFields.map((field) => field.trim().toLowerCase()))].sort(compareText);
	const rootNodeIds = [...new Set(input.rootNodeIds)].sort(compareText);
	const nodes = sortedUnique(input.nodes, (item) => item.nodeId);
	const edges = sortedUnique(input.edges, (item) => item.edgeId).map((item) => ({
		...item,
		evidenceRefs: [...new Set(item.evidenceRefs)].sort(compareText),
	}));
	const datasetControls = sortedUnique(input.datasetControls, (item) => item.controlId).map((item) => ({
		...item,
		evidenceRefs: [...new Set(item.evidenceRefs)].sort(compareText),
	}));
	const fieldConditionals = sortedUnique(input.fieldConditionals, (item) => item.conditionalId).map((item) => ({
		...item,
		fields: sortedUnique(item.fields, physicalFieldKey),
		evidenceRefs: [...new Set(item.evidenceRefs)].sort(compareText),
	}));
	const candidates = sortedUnique(input.candidates, (item) => item.candidateId);
	const gaps = sortedUnique(input.gaps, (item) => item.gapId).map((item) => ({
		...item,
		evidenceRefs: [...new Set(item.evidenceRefs)].sort(compareText),
	}));
	const tableEdges = sortedUnique(
		input.tableEdges,
		(item) => `${item.consumerTaskId}|${item.classification}|${item.producerTaskId}`,
	);
	const limits: FieldLineageLimits = {
		...input.limits,
		reasons: [...new Set(input.limits.reasons)].sort(compareText),
	};
	const withoutHash: Omit<FieldLineageArtifact, "contentHash"> = {
		...input,
		request: { ...input.request, rootFields },
		rootNodeIds,
		nodes,
		edges,
		datasetControls,
		fieldConditionals,
		candidates,
		gaps,
		tableEdges,
		limits,
		counts: {
			nodes: nodes.length,
			edges: edges.length,
			datasetControls: datasetControls.length,
			fieldConditionals: fieldConditionals.length,
			candidates: candidates.length,
			gaps: gaps.length,
		},
	};
	const artifact: FieldLineageArtifact = {
		...withoutHash,
		contentHash: hashProjection(withoutHash),
	};
	const errors = validateFieldLineageArtifact(artifact);
	if (errors.length > 0) throw new Error(`FIELD_LINEAGE_ARTIFACT_INVALID: ${errors.join("; ")}`);
	return artifact;
}

function ordered(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 || compareText(values[index - 1]!, value) <= 0);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

const INDIRECT_SUBTYPES = new Set<OpenLineageIndirectSubtype>([
	"JOIN",
	"GROUP_BY",
	"FILTER",
	"SORT",
	"WINDOW",
	"CONDITIONAL",
]);
const GRAINS = new Set<DatasetControlGrain>(["REDUCE", "PRESERVE", "EXPAND_RISK", "UNKNOWN"]);
const GRAIN_REASONS = new Set<DatasetControlGrainReason>([
	"GRAIN_JOIN_CARDINALITY_UNPROVEN",
	"GRAIN_JOIN_NULLABLE_SIDE_MAY_EXPAND",
	"GRAIN_GROUPING_REDUCES_ROWS",
	"GRAIN_SETOP_REDUCES_ROWS",
	"GRAIN_FILTER_MAY_DROP_ROWS",
	"GRAIN_WINDOW_CARDINALITY_UNPROVEN",
]);

function recordHas(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

export function validateFieldLineageArtifact(value: unknown): string[] {
	const errors: string[] = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return ["artifact must be an object"];
	const raw = value as Record<string, unknown>;
	if (recordHas(raw, "rowsetControls")) errors.push("rowsetControls is not allowed");
	if (recordHas(raw, "affectedRootFields")) errors.push("affectedRootFields is not allowed");
	if (Array.isArray(raw.datasetControls)) {
		for (const control of raw.datasetControls) {
			if (typeof control !== "object" || control === null) continue;
			if (recordHas(control, "nodeId")) errors.push("datasetControls must not include nodeId");
			if (recordHas(control, "affectedRootFields")) errors.push("affectedRootFields is not allowed");
		}
	}
	const artifact = value as FieldLineageArtifact;
	if (artifact.schemaVersion !== FIELD_LINEAGE_SCHEMA_VERSION) errors.push("schemaVersion is unsupported");
	if (artifact.artifactType !== FIELD_LINEAGE_ARTIFACT_TYPE) errors.push("artifactType is invalid");
	if (!nonEmpty(artifact.generatedAt)) errors.push("generatedAt is required");
	if (!artifact.request || !nonEmpty(artifact.request.rootTaskId) || !nonEmpty(artifact.request.rootTable))
		errors.push("request root identity is incomplete");
	if (
		!Array.isArray(artifact.request?.rootWriteObservationIds) ||
		artifact.request.rootWriteObservationIds.length === 0 ||
		artifact.request.rootWriteObservationIds.some((id) => !nonEmpty(id)) ||
		new Set(artifact.request.rootWriteObservationIds).size !== artifact.request.rootWriteObservationIds.length
	)
		errors.push("request root Write Observations are incomplete");
	if (!Array.isArray(artifact.request?.rootFields) || artifact.request.rootFields.length === 0)
		errors.push("at least one explicit root field is required");
	if (!["current-only", "allow-legacy-partial"].includes(artifact.request?.factsPolicy))
		errors.push("factsPolicy is invalid");
	if (!["COMPLETE", "PARTIAL", "BLOCKED"].includes(artifact.overallStatus)) errors.push("overallStatus is invalid");
	for (const field of artifact.nodes?.map((node) => node.field) ?? []) {
		if (
			!field ||
			!["SCHEMA_BACKED", "TASK_LOCAL_SCHEMA_BACKED"].includes(field.identityStatus) ||
			![field.platform, field.dataSource, field.stableTableId, field.qualifiedName, field.column].every(nonEmpty)
		)
			errors.push("all node fields must have a complete Schema-backed identity");
	}
	const nodeIds = artifact.nodes?.map((node) => node.nodeId) ?? [];
	if (new Set(nodeIds).size !== nodeIds.length) errors.push("nodeId values must be unique");
	if (!ordered(nodeIds)) errors.push("nodes must be sorted by nodeId");
	const edgeIds = artifact.edges?.map((edge) => edge.edgeId) ?? [];
	if (new Set(edgeIds).size !== edgeIds.length) errors.push("edgeId values must be unique");
	if (!ordered(edgeIds)) errors.push("edges must be sorted by edgeId");
	const nodeSet = new Set(nodeIds);
	for (const edge of artifact.edges ?? []) {
		if (edge.kind !== "VALUE_FLOW") errors.push(`edge ${edge.edgeId} is not VALUE_FLOW`);
		if (!nodeSet.has(edge.fromNodeId) || !nodeSet.has(edge.toNodeId)) errors.push(`edge ${edge.edgeId} has a missing endpoint`);
	}
	for (const rootId of artifact.rootNodeIds ?? []) if (!nodeSet.has(rootId)) errors.push(`root node ${rootId} is missing`);
	if (!ordered(artifact.rootNodeIds ?? [])) errors.push("rootNodeIds must be sorted");
	const controlIds = artifact.datasetControls?.map((control) => control.controlId) ?? [];
	if (new Set(controlIds).size !== controlIds.length) errors.push("controlId values must be unique");
	if (!ordered(controlIds)) errors.push("datasetControls must be sorted by controlId");
	for (const control of artifact.datasetControls ?? []) {
		if (!INDIRECT_SUBTYPES.has(control.subtype)) errors.push(`dataset control ${control.controlId} has an invalid subtype`);
		if (!GRAINS.has(control.grain)) errors.push(`dataset control ${control.controlId} has an invalid grain`);
		if (control.grain !== "PRESERVE") {
			if (!nonEmpty(control.grainReason))
				errors.push(`dataset control ${control.controlId} is missing grainReason`);
			else if (!GRAIN_REASONS.has(control.grainReason))
				errors.push(`dataset control ${control.controlId} has an invalid grainReason`);
		} else if (control.grainReason !== null && !GRAIN_REASONS.has(control.grainReason))
			errors.push(`dataset control ${control.controlId} has an invalid grainReason`);
		if (typeof control.masking !== "boolean") errors.push(`dataset control ${control.controlId} masking must be boolean`);
	}
	const conditionalIds = artifact.fieldConditionals?.map((item) => item.conditionalId) ?? [];
	if (new Set(conditionalIds).size !== conditionalIds.length) errors.push("conditionalId values must be unique");
	if (!ordered(conditionalIds)) errors.push("fieldConditionals must be sorted by conditionalId");
	if (artifact.counts) {
		if (artifact.counts.nodes !== (artifact.nodes?.length ?? 0)) errors.push("counts.nodes does not match");
		if (artifact.counts.edges !== (artifact.edges?.length ?? 0)) errors.push("counts.edges does not match");
		if (artifact.counts.datasetControls !== (artifact.datasetControls?.length ?? 0))
			errors.push("counts.datasetControls does not match");
		if (artifact.counts.fieldConditionals !== (artifact.fieldConditionals?.length ?? 0))
			errors.push("counts.fieldConditionals does not match");
		if (artifact.counts.candidates !== (artifact.candidates?.length ?? 0)) errors.push("counts.candidates does not match");
		if (artifact.counts.gaps !== (artifact.gaps?.length ?? 0)) errors.push("counts.gaps does not match");
	} else errors.push("counts are required");
	if (artifact.overallStatus === "COMPLETE") {
		if ((artifact.gaps?.length ?? 0) > 0) errors.push("COMPLETE cannot contain gaps");
		if (artifact.limits?.truncated) errors.push("COMPLETE cannot be truncated");
		if (
			(artifact.nodes ?? []).some((node) => node.evidenceStatus !== "CONFIRMED") ||
			(artifact.edges ?? []).some((edge) => edge.evidenceStatus !== "CONFIRMED") ||
			(artifact.datasetControls ?? []).some((control) => control.evidenceStatus !== "CONFIRMED") ||
			(artifact.fieldConditionals ?? []).some((item) => item.evidenceStatus !== "CONFIRMED")
		)
			errors.push("COMPLETE cannot contain legacy or unresolved evidence");
	}
	if (artifact.request?.factsPolicy === "current-only") {
		if (
			(artifact.nodes ?? []).some((node) => node.evidenceStatus === "PROVISIONAL_LEGACY") ||
			(artifact.edges ?? []).some((edge) => edge.evidenceStatus === "PROVISIONAL_LEGACY")
		)
			errors.push("current-only cannot contain legacy value-flow evidence");
	}
	if (!artifact.boundaries?.staticSqlOnly) errors.push("staticSqlOnly boundary is required");
	if (nonEmpty(artifact.contentHash)) {
		const { contentHash: _contentHash, ...withoutHash } = artifact;
		if (hashProjection(withoutHash) !== artifact.contentHash) errors.push("contentHash does not match canonical artifact");
	} else errors.push("contentHash is required");
	return errors;
}
