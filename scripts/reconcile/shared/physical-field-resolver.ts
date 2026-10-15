import {
	type PhysicalTableCatalog,
	type PhysicalTableCatalogEntry,
} from "../../machine-facts/input-pack-machine-facts.ts";
import { normalizeName } from "../../machine-facts/machine-facts-contract.ts";
import { type JsonRecord } from "../../query/current-task-bundle.ts";
import {
	qualifyBareTableName,
	type TaskDefaultSchema,
} from "./task-default-schema.ts";

import {
	physicalFieldKey,
	type PhysicalFieldIdentity,
} from "./physical-field.ts";

export type PhysicalFieldResolutionFailure =
	| "TABLE_PACK_MISSING"
	| "TABLE_IDENTITY_AMBIGUOUS"
	| "FIELD_NOT_IN_SCHEMA";

export type PhysicalFieldResolution =
	| {
			readonly status: "RESOLVED";
			readonly field: PhysicalFieldIdentity;
	  }
	| {
			readonly status: "UNRESOLVED";
			readonly table: string;
			readonly column: string;
			readonly reason: PhysicalFieldResolutionFailure;
	  };

export interface PhysicalFieldResolutionContext {
	readonly catalog: PhysicalTableCatalog;
	readonly taskId: string;
	readonly defaultSchema: TaskDefaultSchema | null;
	readonly fallbackTable: Pick<
		PhysicalTableCatalogEntry,
		"platform" | "dataSource"
	>;
	readonly schemaRefs: readonly JsonRecord[];
}

export function physicalFieldForTable(
	table: PhysicalTableCatalogEntry,
	columnInput: string,
): PhysicalFieldIdentity | null {
	const column = normalizeName(columnInput);
	if (!table.columns.some((candidate) => normalizeName(candidate) === column))
		return null;
	return {
		platform: table.platform,
		dataSource: table.dataSource,
		stableTableId: table.stableTableId,
		qualifiedName: table.qualifiedName,
		column,
		identityStatus: "SCHEMA_BACKED",
	};
}

function isTaskLocalSchemaSource(source: unknown, taskId: string): boolean {
	const value = String(source ?? "");
	return (
		value.startsWith(`input-pack-task-local-ctas:${taskId}:`) ||
		value.startsWith(`input-pack-task-local-ddl:${taskId}:`) ||
		value.startsWith(`input-pack-task-local-write:${taskId}:`)
	);
}

function taskLocalResolution(
	context: PhysicalFieldResolutionContext,
	rawTable: string,
	qualifiedTable: string,
	column: string,
): PhysicalFieldResolution | null {
	const names = new Set([rawTable, qualifiedTable].map(normalizeName));
	const matches = context.schemaRefs.filter(
		(record) =>
			names.has(normalizeName(String(record.qualified_name ?? ""))) &&
			isTaskLocalSchemaSource(record.source, context.taskId) &&
			Array.isArray(record.physical_columns) &&
			record.physical_columns
				.map((value) => normalizeName(String(value)))
				.includes(column),
	);
	if (matches.length === 0) return null;
	if (matches.length > 1)
		return {
			status: "UNRESOLVED",
			table: qualifiedTable,
			column,
			reason: "TABLE_IDENTITY_AMBIGUOUS",
		};
	const localTableName = normalizeName(
		String(matches[0]?.qualified_name ?? qualifiedTable),
	);
	return {
		status: "RESOLVED",
		field: {
			platform: context.fallbackTable.platform,
			dataSource: context.fallbackTable.dataSource,
			stableTableId: `task-local:${context.taskId}:${localTableName}`,
			qualifiedName: localTableName,
			column,
			identityStatus: "TASK_LOCAL_SCHEMA_BACKED",
		},
	};
}

export function resolvePhysicalInputField(
	context: PhysicalFieldResolutionContext,
	reference: { readonly table: string; readonly column: string },
): PhysicalFieldResolution {
	const rawTable = normalizeName(reference.table);
	const column = normalizeName(reference.column);
	const qualifiedTable = qualifyBareTableName(rawTable, context.defaultSchema);
	const local = taskLocalResolution(
		context,
		rawTable,
		qualifiedTable,
		column,
	);
	if (local) return local;
	const exact = context.catalog.byQualifiedName.get(qualifiedTable) ?? [];
	const tailMatches =
		rawTable.includes(".") || context.defaultSchema !== null
			? []
			: context.catalog.entries.filter(
					(entry) =>
						normalizeName(entry.qualifiedName).split(".").at(-1) ===
						rawTable,
				);
	const tables =
		exact.length > 0 ? exact : tailMatches.length === 1 ? tailMatches : [];

	if (tables.length === 1) {
		const field = physicalFieldForTable(tables[0]!, column);
		return field
			? { status: "RESOLVED", field }
			: {
					status: "UNRESOLVED",
					table: qualifiedTable,
					column,
					reason: "FIELD_NOT_IN_SCHEMA",
				};
	}

	return {
		status: "UNRESOLVED",
		table: qualifiedTable,
		column,
		reason:
			exact.length > 1 || tailMatches.length > 1
				? "TABLE_IDENTITY_AMBIGUOUS"
				: "TABLE_PACK_MISSING",
	};
}

export function resolvedPhysicalFields(
	resolutions: readonly PhysicalFieldResolution[],
): PhysicalFieldIdentity[] {
	const fields = new Map<string, PhysicalFieldIdentity>();
	for (const resolution of resolutions)
		if (resolution.status === "RESOLVED")
			fields.set(physicalFieldKey(resolution.field), resolution.field);
	return [...fields.values()].sort((left, right) =>
		physicalFieldKey(left).localeCompare(physicalFieldKey(right)),
	);
}
