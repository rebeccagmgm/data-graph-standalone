export type QueryName =
  | "get_project_topology"
  | "trace_project_upstream"
  | "explain_topology_edge"
  | "get_field_evidence"
  | "trace_field_value_path"
  | "explain_field_evidence_record"
  | "get_target_causal_overlay"
  | "get_target_causal_task_rollup"
  | "explain_target_causal_assessment";

export const QUERY_OPTIONS = new Set([
  "--query",
  "--node-type",
  "--edge-type",
  "--offset",
  "--limit",
  "--start-node-id",
  "--relation-layer",
  "--max-hops",
  "--max-nodes",
  "--max-edges",
  "--max-paths",
  "--edge-id",
  "--root-field",
  "--start-state-id",
  "--record-id",
  "--max-attachments",
  "--relation-status",
  "--channel",
  "--task-id",
  "--assessment-id",
  "--max-assessments",
]);

export function collectOptions(
  args: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (!allowed.has(option))
      throw new Error(`QUERY_INDEX_OPTION_UNKNOWN:${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`QUERY_INDEX_OPTION_VALUE_MISSING:${option}`);
    index += 1;
    values.set(option, [...(values.get(option) ?? []), value]);
  }
  return values;
}

export function validateQueryOptions(
  query: QueryName,
  values: ReadonlyMap<string, readonly string[]>,
): void {
  const allowedValues: Readonly<Record<string, readonly string[]>> = {
    "--node-type": [
      "PROJECT_SNAPSHOT",
      "TASK",
      "PHYSICAL_DATASET",
      "BOUNDARY",
      "PROJECT_SNAPSHOT_REF",
      "TASK_REF",
      "PHYSICAL_FIELD",
      "TARGET_WRITE",
      "FIELD_BINDING_STATE",
      "EXPRESSION",
      "READ_OCCURRENCE",
      "WRITE_OBSERVATION",
      "ROWSET_CONTROL",
      "CANDIDATE",
      "GAP",
    ],
    "--edge-type": [
      "HAS_ENTRY_TASK",
      "ROOT_REACHES_TASK",
      "READS",
      "WRITES",
      "PRODUCER_BRIDGE",
      "SCHEDULE_DEPENDS_ON",
      "HAS_BOUNDARY",
      "PROJECT_HAS_FIELD_EVIDENCE",
      "TASK_HAS_TARGET_WRITE",
      "WRITE_TARGETS_DATASET",
      "TARGET_WRITE_HAS_OUTPUT",
      "TASK_HAS_STATE",
      "STATE_IDENTIFIES_FIELD",
      "DATASET_HAS_FIELD",
      "STATE_COMPUTED_BY",
      "VALUE_FLOW",
      "VALUE_FLOW_READS_AT",
      "VALUE_FLOW_WRITTEN_BY",
      "CONTROL_ANNOTATES_STATE",
      "EVIDENCE_SCOPED_TO_TASK",
      "EVIDENCE_SCOPED_TO_FIELD",
      "EVIDENCE_SCOPED_TO_STATE",
    ],
    "--relation-layer": [
      "PROJECT",
      "PROJECTION_SCOPE",
      "DATA_PRODUCTION",
      "SCHEDULE",
      "BOUNDARY",
    ],
    "--relation-status": [
      "CONFIRMED_RELATED",
      "CONDITIONAL_RELATED",
      "PROVEN_UNRELATED",
      "UNKNOWN",
    ],
    "--channel": [
      "FIELD_VALUE",
      "EXPRESSION_CONTROL",
      "ROW_MEMBERSHIP",
      "MULTIPLICITY",
      "GROUPING",
      "SET_MEMBERSHIP",
      "ORDER_SELECTION",
      "WINDOW_EFFECT",
      "RELATION_EXISTENCE",
    ],
  };
  for (const [option, allowed] of Object.entries(allowedValues))
    for (const value of values.get(option) ?? [])
      if (!allowed.includes(value))
        throw new Error(`QUERY_INDEX_OPTION_VALUE_INVALID:${option}`);
  const requiredByQuery: Partial<Record<QueryName, readonly string[]>> = {
    trace_project_upstream: ["--start-node-id"],
    explain_topology_edge: ["--edge-id"],

    explain_field_evidence_record: ["--record-id"],

    get_target_causal_task_rollup: ["--task-id"],
    explain_target_causal_assessment: ["--assessment-id"],
  };
  for (const option of requiredByQuery[query] ?? [])
    requiredOne(values, option);
  if (
    query === "trace_field_value_path" &&
    (optionalOne(values, "--root-field") === undefined) ===
      (optionalOne(values, "--start-state-id") === undefined)
  )
    throw new Error("QUERY_INDEX_FIELD_TRACE_START_REQUIRED_EXACTLY_ONE");
  for (const [option, minimum, maximum] of [
    ["--offset", 0, Number.MAX_SAFE_INTEGER],
    [
      "--limit",
      1,
      query === "get_project_topology" ? 5_000 : Number.MAX_SAFE_INTEGER,
    ],
    [
      "--max-hops",
      query === "trace_project_upstream" ? 0 : 1,
      query === "trace_project_upstream" ? 100 : Number.MAX_SAFE_INTEGER,
    ],
    [
      "--max-nodes",
      1,
      query === "trace_project_upstream" ? 100_000 : Number.MAX_SAFE_INTEGER,
    ],
    [
      "--max-edges",
      1,
      query === "trace_project_upstream" ? 250_000 : Number.MAX_SAFE_INTEGER,
    ],
    [
      "--max-paths",
      1,
      query === "trace_project_upstream" ? 1_000_000 : Number.MAX_SAFE_INTEGER,
    ],
    ["--max-attachments", 1, Number.MAX_SAFE_INTEGER],
    ["--max-assessments", 1, Number.MAX_SAFE_INTEGER],
  ] as const)
    optionalInteger(values, option, minimum, maximum);
}

export function requiredOne(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
): string {
  const value = optionalOne(values, option);
  if (value === undefined)
    throw new Error(`QUERY_INDEX_OPTION_REQUIRED:${option}`);
  return value;
}

export function optionalOne(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
): string | undefined {
  const found = values.get(option);
  if (found === undefined) return undefined;
  if (found.length !== 1)
    throw new Error(`QUERY_INDEX_OPTION_DUPLICATE:${option}`);
  return found[0];
}

export function integerOption(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return optionalInteger(values, option, minimum, maximum) ?? fallback;
}

export function optionalInteger(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = optionalOne(values, option);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`QUERY_INDEX_OPTION_INTEGER_INVALID:${option}`);
  return parsed;
}

export const QUERY_OPTIONS_BY_NAME = new Set<QueryName>([
  "get_project_topology",
  "trace_project_upstream",
  "explain_topology_edge",
  "get_field_evidence",
  "trace_field_value_path",
  "explain_field_evidence_record",
  "get_target_causal_overlay",
  "get_target_causal_task_rollup",
  "explain_target_causal_assessment",
]);
