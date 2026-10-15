import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
	MACHINE_FACTS_CONTRACT_VERSION,
	canonicalJson,
} from "../../../../../machine-facts/machine-facts-contract.ts";
import {
	indexTaskInputPacks,
	loadPhysicalTableCatalog,
	type PhysicalTableCatalog,
	runInputPackMachineFacts,
} from "../../../../../machine-facts/input-pack-machine-facts.ts";
import { createCurrentTaskBundleReader } from "../../../../../query/current-task-bundle.ts";
import {
	DEFAULT_FIELD_LINEAGE_MAX_PATHS,
	DEFAULT_FIELD_LINEAGE_MAX_STATES,
	reconcileFieldLineage,
} from "./field-lineage.ts";
import { formatFieldLineageSummary } from "./format-field-lineage.ts";
import type { FactsPolicy } from "./field-lineage-contract.ts";

interface CliOptions {
	readonly dataRoot: string;
	readonly factsRoot: string;
	readonly multiHopArtifact: string;
	readonly taskId: string;
	readonly targetTable: string;
	readonly writeObservationIds?: readonly string[];
	readonly fields: readonly string[];
	readonly factsPolicy: FactsPolicy;
	readonly maxDepth: number;
	readonly maxStates: number;
	readonly maxPaths: number;
	readonly output: string;
	readonly summaryOutput?: string;
	readonly timingOutput?: string;
	readonly prepareFacts: boolean;
}

function option(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function integerOption(args: readonly string[], name: string, fallback: number): number {
	const value = option(args, name);
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
	return parsed;
}

function parseCli(args: readonly string[]): CliOptions {
	const dataRoot = option(args, "--data-root");
	const factsRoot = option(args, "--facts-root");
	const multiHopArtifact = option(args, "--multi-hop-artifact");
	const taskId = option(args, "--task-id");
	const targetTable = option(args, "--target-table");
	const writeObservationIdsValue = option(args, "--write-observation-ids") ?? option(args, "--write-observation-id") ?? option(args, "--root-write-observation-id");
	const writeObservationIds = writeObservationIdsValue?.split(",").map((value) => value.trim()).filter(Boolean);
	const fields = (option(args, "--fields") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
	const output = option(args, "--output");
	const factsPolicy = (option(args, "--facts-policy") ?? "current-only") as FactsPolicy;
	if (!dataRoot || !factsRoot || !multiHopArtifact || !taskId || !targetTable || !output)
		throw new Error("usage: reconcile-field-lineage --data-root <path> --facts-root <facts-root> --multi-hop-artifact <json> --task-id <id> --target-table <qualified> [--write-observation-id <id[,id...]>] [--fields <a,b>] --output <json> [--summary-output <txt>] [--timing-output <json>] [--facts-policy current-only|allow-legacy-partial]");
	if (factsPolicy !== "current-only" && factsPolicy !== "allow-legacy-partial") throw new Error("--facts-policy is invalid");
	return {
		dataRoot,
		factsRoot,
		multiHopArtifact,
		taskId,
		targetTable,
		writeObservationIds,
		fields,
		factsPolicy,
		maxDepth: integerOption(args, "--max-depth", 8),
		maxStates: integerOption(args, "--max-states", DEFAULT_FIELD_LINEAGE_MAX_STATES),
		maxPaths: integerOption(args, "--max-paths", DEFAULT_FIELD_LINEAGE_MAX_PATHS),
		output,
		summaryOutput: option(args, "--summary-output"),
		timingOutput: option(args, "--timing-output"),
		prepareFacts: !args.includes("--no-prepare-facts"),
	};
}

function preflightRootFacts(
	factsRoot: string,
	taskId: string,
	factsPolicy: FactsPolicy,
): void {
	const load = createCurrentTaskBundleReader(factsRoot).load(taskId);
	if (load.state === "LEGACY_NOT_L1" && factsPolicy === "current-only") {
		const contractVersion = String(load.manifest?.schema_version ?? "MISSING");
		if (contractVersion !== MACHINE_FACTS_CONTRACT_VERSION)
			throw new Error(
				`MACHINE_FACTS_CONTRACT_INCOMPATIBLE: task ${taskId} has ${contractVersion}; current-only requires the active publisher contract (${MACHINE_FACTS_CONTRACT_VERSION})`,
			);
	}
	if (load.state !== "CURRENT_L1" && load.state !== "LEGACY_NOT_L1") {
		throw new Error(
			`MACHINE_FACTS_UNAVAILABLE: task ${taskId} facts state is ${load.state}; ${load.issues.join("; ")}`,
		);
	}
	const bindings = (load.records["output-field-bindings.jsonl"] ?? []).filter(
		(binding) =>
			binding.task_id === taskId && binding.binding_status === "RESOLVED",
	);
	if (bindings.length === 0) {
		throw new Error(
			`ROOT_OUTPUT_BINDINGS_MISSING: task ${taskId} has no RESOLVED output-field-bindings`,
		);
	}
}

export function runFieldLineageCli(options: CliOptions): ReturnType<typeof reconcileFieldLineage> {
	const timings = {
		table_lineage_read_ms: 0,
		task_path_index_ms: 0,
			table_catalog_ms: 0,
			machine_facts_prepare_ms: 0,
			machine_facts_index_ms: 0,
			reconcile_ms: 0,
	};
	let machineFactsPrepareBatches = 0;
	let reconcileCalls = 0;
	const tableLineageStarted = performance.now();
	const tableLineage = JSON.parse(readFileSync(resolve(options.multiHopArtifact), "utf8")) as Record<string, unknown>;
	timings.table_lineage_read_ms = performance.now() - tableLineageStarted;
	const taskPathIndexStarted = performance.now();
	const taskPathIndex = options.prepareFacts ? indexTaskInputPacks(options.dataRoot) : undefined;
	timings.task_path_index_ms = performance.now() - taskPathIndexStarted;
	const tableCatalogStarted = performance.now();
	const tableCatalog: PhysicalTableCatalog | undefined = options.prepareFacts
		? loadPhysicalTableCatalog(options.dataRoot, { lazyDdl: true })
		: undefined;
	timings.table_catalog_ms = performance.now() - tableCatalogStarted;
	const reconcile = (): ReturnType<typeof reconcileFieldLineage> => reconcileFieldLineage({
		dataRoot: options.dataRoot,
		factsRoot: options.factsRoot,
		tableCatalog,
		tableLineage,
		rootTaskId: options.taskId,
		rootTable: options.targetTable,
		rootWriteObservationIds: options.writeObservationIds,
		rootFields: options.fields,
		factsPolicy: options.factsPolicy,
		maxDepth: options.maxDepth,
		maxStates: options.maxStates,
		maxPaths: options.maxPaths,
		taskPathIndex,
	});
	const reconcileWithTiming = (): ReturnType<typeof reconcileFieldLineage> => {
		const started = performance.now();
		try {
			return reconcile();
		} finally {
			timings.reconcile_ms += performance.now() - started;
			reconcileCalls += 1;
		}
	};
	let artifact: ReturnType<typeof reconcileFieldLineage>;
	if (options.prepareFacts) {
		const available = new Set(taskPathIndex!.keys());
		const attempted = new Set<string>();
		const prepare = (taskIds: readonly string[]): void => {
			const pending = [...new Set(taskIds)]
				.filter((taskId) => available.has(taskId) && !attempted.has(taskId))
				.sort();
			if (pending.length === 0) return;
			for (const taskId of pending) attempted.add(taskId);
			machineFactsPrepareBatches += 1;
			const started = performance.now();
			try {
				const result = runInputPackMachineFacts({
					dataRoot: options.dataRoot,
					taskIds: pending,
					outputRoot: options.factsRoot,
					tableCatalog,
					taskPathIndex,
					indexMode: "auto",
				});
				timings.machine_facts_index_ms += result.timings.index_ms;
				const rootFailure = result.tasks.find((task) => task.task_id === options.taskId && task.state === "FAILED");
				if (rootFailure) throw new Error(rootFailure.failures.map((failure) => failure.message).join("; "));
				for (const failure of result.tasks.filter((task) => task.state === "FAILED"))
					process.stderr.write(`Machine Facts preparation skipped ${failure.task_id}: ${failure.failures.map((item) => item.message).join("; ")}\n`);
			} catch (error) {
				if (pending.includes(options.taskId)) throw error;
				process.stderr.write(`Machine Facts batch preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
			} finally {
				timings.machine_facts_prepare_ms += performance.now() - started;
			}
		};

		prepare([options.taskId]);
		preflightRootFacts(options.factsRoot, options.taskId, options.factsPolicy);
		artifact = reconcileWithTiming();
		while (true) {
			const missingTaskIds = artifact.gaps
				.filter((gap) => gap.reasonCode === "MACHINE_FACTS_UNAVAILABLE")
				.map((gap) => gap.taskId)
				.filter((taskId) => available.has(taskId) && !attempted.has(taskId));
			if (missingTaskIds.length === 0) break;
			prepare(missingTaskIds);
			artifact = reconcileWithTiming();
		}
	} else {
		preflightRootFacts(options.factsRoot, options.taskId, options.factsPolicy);
		artifact = reconcileWithTiming();
	}
	const output = resolve(options.output);
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, `${canonicalJson(artifact)}\n`, "utf8");
	if (options.summaryOutput) {
		const summary = resolve(options.summaryOutput);
		mkdirSync(dirname(summary), { recursive: true });
		writeFileSync(summary, formatFieldLineageSummary(artifact), "utf8");
	}
	if (options.timingOutput) {
		const timingOutput = resolve(options.timingOutput);
		mkdirSync(dirname(timingOutput), { recursive: true });
		writeFileSync(timingOutput, `${canonicalJson({
			schema_version: "field-lineage-timing-v1",
			phases_ms: timings,
			counters: {
				task_path_index_entries: taskPathIndex?.size ?? 0,
				table_catalog_entries: tableCatalog?.byQualifiedName.size ?? 0,
				machine_facts_prepare_batches: machineFactsPrepareBatches,
				reconcile_calls: reconcileCalls,
			},
		})}\n`, "utf8");
	}
	return artifact;
}

if (process.argv[1] && basename(process.argv[1]).startsWith("reconcile-field-lineage")) {
	const artifact = runFieldLineageCli(parseCli(process.argv.slice(2)));
	process.stdout.write(`${JSON.stringify({ output: resolve(option(process.argv.slice(2), "--output")!), status: artifact.overallStatus, counts: artifact.counts }, null, 2)}\n`);
}
