import {
  createFieldEvidenceQueryContext,
  fieldEvidenceGoldenRequired,
  fieldEvidenceQueryRoots,
  primaryFinalWrite,
} from "./impact-query-harness.ts";
import {
  validateFieldImpactResult,
  type FieldImpactAnchor,
  type FieldImpactResult,
} from "./impact-result-contract.ts";

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function parsePositiveInt(value: string | undefined, optionName: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`FIELD_EVIDENCE_QUERY_${optionName}_INVALID`);
  }
  return parsed;
}

export interface FieldEvidenceQueryInput {
  readonly configPath?: string;
  readonly profile?: string;
  readonly taskId: string;
  readonly outputColumn: string;
  readonly writeObservationId?: string;
  readonly maxDepth?: number;
  readonly maxEdges?: number;
  readonly maxFrontier?: number;
  readonly expandCandidates?: boolean;
}

export function runFieldEvidenceQuery(input: FieldEvidenceQueryInput): FieldImpactResult {
  const roots = fieldEvidenceQueryRoots({ configPath: input.configPath, profile: input.profile });
  if (!roots) {
    if (fieldEvidenceGoldenRequired()) {
      throw new Error("FIELD_EVIDENCE_GOLDEN_DATA_MISSING");
    }
    throw new Error("FIELD_EVIDENCE_QUERY_DATA_MISSING");
  }

  const context = createFieldEvidenceQueryContext(roots);
  const projection = context.projectionForTask(input.taskId);
  const writeObservationId = input.writeObservationId?.trim()
    ?? primaryFinalWrite(projection)?.writeObservationId;
  if (!writeObservationId) {
    throw new Error("FIELD_EVIDENCE_QUERY_ANCHOR_WRITE_MISSING");
  }

  const anchor: FieldImpactAnchor = {
    taskId: input.taskId,
    writeObservationId,
    outputColumn: input.outputColumn,
  };

  const result = context.runImpactQuery(anchor, {
    maxDepth: input.maxDepth,
    budget: {
      maxEdges: input.maxEdges,
      maxFrontier: input.maxFrontier,
    },
    expandCandidates: input.expandCandidates,
  });

  return validateFieldImpactResult(result);
}

export function main(argv = process.argv.slice(2)): void {
  const taskId = option(argv, "--task-id")
    ?? process.env.FIELD_EVIDENCE_QUERY_TASK_ID?.trim();
  const outputColumn = option(argv, "--column")
    ?? process.env.FIELD_EVIDENCE_QUERY_COLUMN?.trim();
  if (!taskId) {
    throw new Error("FIELD_EVIDENCE_QUERY_TASK_ID_REQUIRED");
  }
  if (!outputColumn) {
    throw new Error("FIELD_EVIDENCE_QUERY_COLUMN_REQUIRED");
  }

  const result = runFieldEvidenceQuery({
    configPath: option(argv, "--config"),
    profile: option(argv, "--profile"),
    taskId,
    outputColumn,
    writeObservationId: option(argv, "--write-observation-id"),
    maxDepth: parsePositiveInt(option(argv, "--max-depth"), "MAX_DEPTH"),
    maxEdges: parsePositiveInt(option(argv, "--max-edges"), "MAX_EDGES"),
    maxFrontier: parsePositiveInt(option(argv, "--max-frontier"), "MAX_FRONTIER"),
    expandCandidates: flag(argv, "--expand-candidates"),
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("query-cli.ts")) {
  main();
}
