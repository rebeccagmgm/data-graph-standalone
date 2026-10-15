import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { sha256, type TaskFactIndexRecord } from "./machine-facts-contract.ts";

export interface MachineFactsIndexSnapshot {
	readonly path: string;
	readonly sha256: string;
	readonly rows: readonly TaskFactIndexRecord[];
	readonly byTaskId: ReadonlyMap<string, TaskFactIndexRecord>;
}

function validRow(value: unknown): value is TaskFactIndexRecord {
	if (!value || typeof value !== "object") return false;
	const row = value as Partial<TaskFactIndexRecord>;
	return typeof row.task_id === "string" && typeof row.logical_source_id === "string" &&
		typeof row.sql_sha256 === "string" && typeof row.manifest_sha256 === "string" &&
		typeof row.bundle_path === "string" && row.status === "SUCCESS";
}

/** The one read boundary for the canonical, mutable Machine Facts index. */
export function loadMachineFactsIndex(factsRootInput: string, options: { readonly allowMissing?: boolean } = {}): MachineFactsIndexSnapshot {
	const factsRoot = resolve(factsRootInput);
	const path = join(factsRoot, "indexes", "task-fact-index.jsonl");
	if (!existsSync(path)) {
		if (options.allowMissing) return { path, sha256: sha256(""), rows: [], byTaskId: new Map() };
		throw new Error(`MACHINE_FACTS_INDEX_MISSING:${path}`);
	}
	const bytes = readFileSync(path);
	const rows: TaskFactIndexRecord[] = [];
	const byTaskId = new Map<string, TaskFactIndexRecord>();
	for (const [offset, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		let row: unknown;
		try { row = JSON.parse(line); } catch { throw new Error(`MACHINE_FACTS_INDEX_INVALID_JSON:L${offset + 1}`); }
		if (!validRow(row)) throw new Error(`MACHINE_FACTS_INDEX_INVALID_ROW:L${offset + 1}`);
		if (byTaskId.has(row.task_id)) throw new Error(`MACHINE_FACTS_INDEX_DUPLICATE_TASK:${row.task_id}`);
		rows.push(row);
		byTaskId.set(row.task_id, row);
	}
	return { path, sha256: sha256(bytes), rows, byTaskId };
}
