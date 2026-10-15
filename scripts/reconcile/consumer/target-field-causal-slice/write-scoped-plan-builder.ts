import {
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import { Schema, SqlSession } from "sqllens";
import { sha256 } from "../../../machine-facts/machine-facts-contract.ts";
import {
  globalExpressionId,
  globalRelationId,
  localExpressionId,
  localRelationId,
} from "../../../machine-facts/plan-occurrence-id.ts";
import * as planAdapter from "../../../plans/plan-adapter.ts";
import type {
  ExprSpec,
  PlanFacts,
  PlanRelation,
} from "../../../plans/plan-contract.ts";
import {
  maskWithInsertTargetForParser,
  sanitizeSqlForParser,
} from "../../../plans/parser-sql-input.ts";
import type { CurrentBundleLoad } from "../../../query/current-task-bundle.ts";
import { isCanonicalTargetWriteBundle } from "../target-write-evidence-resolver.ts";
import {
  makeWriteScopedPlanInputGap,
  type RootCriterion,
  type WriteScopedPlanInputGap,
} from "./write-scoped-plan-inputs.ts";

export interface WriteScopedPlan {
  readonly sqlSourceId: string;
  readonly statementId: string;
  readonly statementIndex: number;
  readonly plan: PlanFacts;
  readonly rootCriteria: readonly RootCriterion[];
}

export interface BuildWriteScopedPlansInput {
  readonly rootCriteria: readonly RootCriterion[];
  readonly load: CurrentBundleLoad;
  readonly schema: Schema;
}

export interface WriteScopedPlanBuildResult {
  readonly plans: readonly WriteScopedPlan[];
  readonly gaps: readonly WriteScopedPlanInputGap[];
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function manifestInput(load: CurrentBundleLoad, key: string): string | null {
  const inputs = load.manifest?.inputs;
  if (typeof inputs !== "object" || inputs === null) return null;
  return text((inputs as Record<string, unknown>)[key]);
}

function manifestDialect(load: CurrentBundleLoad): string | null {
  const method = load.manifest?.method;
  return typeof method === "object" && method !== null
    ? text((method as Record<string, unknown>).dialect)
    : null;
}

function safeSnapshotPath(factsRoot: string, locator: string): string | null {
  if (isAbsolute(locator)) return null;
  const root = resolve(factsRoot);
  const candidate = resolve(root, locator);
  const relation = relative(root, candidate);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..\\`) ||
    relation.startsWith("../") ||
    isAbsolute(relation) ||
    !existsSync(candidate)
  ) return null;
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const realRelation = relative(realRoot, realCandidate);
    return realRelation !== "" &&
        realRelation !== ".." &&
        !realRelation.startsWith(`..\\`) &&
        !realRelation.startsWith("../") &&
        !isAbsolute(realRelation)
      ? realCandidate
      : null;
  } catch {
    return null;
  }
}

function proofRefs(load: CurrentBundleLoad, root: RootCriterion): readonly string[] {
  return [...new Set([
    ...root.evidenceRefs,
    root.sqlSourceId,
    root.rootCriterionId,
    ...(text(load.evidence["manifest.json"])
      ? [text(load.evidence["manifest.json"])!]
      : []),
  ])].sort((left, right) => left.localeCompare(right));
}

function gap(
  load: CurrentBundleLoad,
  root: RootCriterion,
  reasonCode: WriteScopedPlanInputGap["reasonCode"],
  message: string,
): WriteScopedPlanInputGap {
  return makeWriteScopedPlanInputGap({
    rootCriterionId: root.rootCriterionId,
    taskId: root.rootTaskId,
    targetTableKey: root.targetTableKey,
    writeObservationId: root.rootWriteObservationId,
    targetFieldName: root.targetFieldName,
    reasonCode,
    message,
    evidenceRefs: proofRefs(load, root),
  });
}

function expressionsFor(
  relation: PlanRelation,
  role: string,
): readonly ExprSpec[] | null {
  if (role === "PROJECT_EXPRESSION" && relation.type === "project")
    return relation.expressions ?? [];
  if (role === "AGGREGATE_MEASURE" && relation.type === "aggregate")
    return relation.measures ?? [];
  if (role === "SETOP_OUTPUT" && relation.type === "setop") return [];
  return null;
}

function criterionMatchesPlan(
  root: RootCriterion,
  plan: PlanFacts,
): boolean {
  if (plan.meta.statement_index !== root.statementIndex) return false;
  const localRelation = localRelationId(
    root.rootTaskId,
    root.statementIndex,
    root.rootRelationId,
  );
  const localExpression = localExpressionId(
    root.rootTaskId,
    root.statementIndex,
    root.outputExpressionId,
  );
  if (
    !localRelation ||
    !localExpression ||
    localRelation !== root.localRootRelationId ||
    localExpression !== root.localOutputExpressionId ||
    globalRelationId(root.rootTaskId, root.statementIndex, localRelation) !== root.rootRelationId ||
    globalExpressionId(root.rootTaskId, root.statementIndex, localExpression) !== root.outputExpressionId ||
    !plan.roots.includes(localRelation)
  ) return false;
  const relation = plan.relations.find((item) => item.id === localRelation);
  if (!relation) return false;
  const expressions = expressionsFor(relation, root.expressionRole);
  if (expressions === null) return false;
  const expectedLocalExpression = `${localRelation}:expression:${root.expressionRole.toLowerCase()}:${root.sourceOrdinal}`;
  if (expectedLocalExpression !== localExpression) return false;
  if (root.expressionRole === "SETOP_OUTPUT") {
    const outputs = relation.type === "setop" && Array.isArray(relation.output_columns)
      ? relation.output_columns.map(String)
      : [];
    const output = outputs[root.sourceOrdinal];
    return output !== undefined &&
      (root.producerOutputName === null || output.toLowerCase() === root.producerOutputName.toLowerCase());
  }
  const expression = expressions[root.sourceOrdinal];
  return expression !== undefined &&
    (root.producerOutputName === null ||
      text(expression.output)?.toLowerCase() === root.producerOutputName.toLowerCase());
}

function groupKey(root: RootCriterion): string {
  return `${root.sqlSourceId}\u0000${root.statementId}\u0000${root.statementIndex}`;
}

/** Build exactly one restored Plan Facts graph per proven producer statement. */
export function buildWriteScopedPlans(
  input: BuildWriteScopedPlansInput,
): WriteScopedPlanBuildResult {
  const gaps: WriteScopedPlanInputGap[] = [];
  const eligible: RootCriterion[] = [];
  const manifestSnapshot = manifestInput(input.load, "sql_snapshot");
  const manifestHash = manifestInput(input.load, "sql_sha256");
  const dialect = manifestDialect(input.load);
  const manifestTaskId = text(input.load.manifest?.task_id);

  for (const root of input.rootCriteria) {
    if (
      !isCanonicalTargetWriteBundle(input.load, root.rootTaskId) ||
      root.rootTaskId !== input.load.taskId ||
      root.rootTaskId !== manifestTaskId ||
      !manifestSnapshot ||
      root.sqlSnapshot !== manifestSnapshot
    ) {
      gaps.push(gap(
        input.load,
        root,
        "SQL_SNAPSHOT_MISSING_OR_UNSAFE",
        "root criterion does not reference the current Machine Facts SQL snapshot",
      ));
      continue;
    }
    if (
      !manifestHash ||
      root.sqlSha256 !== manifestHash ||
      root.sqlSourceId !== `sql:${root.rootTaskId}:${manifestHash}`
    ) {
      gaps.push(gap(
        input.load,
        root,
        "SQL_SNAPSHOT_HASH_MISMATCH",
        "root criterion SQL hash/source does not match the current Machine Facts manifest",
      ));
      continue;
    }
    eligible.push(root);
  }
  if (eligible.length === 0)
    return { plans: [], gaps: gaps.sort((left, right) => left.gapId.localeCompare(right.gapId)) };

  const snapshotPath = safeSnapshotPath(input.load.factsRoot, manifestSnapshot!);
  if (!snapshotPath) {
    for (const root of eligible)
      gaps.push(gap(
        input.load,
        root,
        "SQL_SNAPSHOT_MISSING_OR_UNSAFE",
        "current Machine Facts SQL snapshot is missing or outside factsRoot",
      ));
    return { plans: [], gaps: gaps.sort((left, right) => left.gapId.localeCompare(right.gapId)) };
  }
  const sqlBytes = readFileSync(snapshotPath);
  if (sha256(sqlBytes) !== manifestHash) {
    for (const root of eligible)
      gaps.push(gap(
        input.load,
        root,
        "SQL_SNAPSHOT_HASH_MISMATCH",
        "current Machine Facts SQL snapshot bytes do not match the manifest hash",
      ));
    return { plans: [], gaps: gaps.sort((left, right) => left.gapId.localeCompare(right.gapId)) };
  }
  if (!dialect) {
    for (const root of eligible)
      gaps.push(gap(
        input.load,
        root,
        "PLAN_BUILD_FAILED",
        "Machine Facts manifest does not declare the parser dialect",
      ));
    return { plans: [], gaps: gaps.sort((left, right) => left.gapId.localeCompare(right.gapId)) };
  }

  const sql = sqlBytes.toString("utf8");
  let sourceSession: ReturnType<typeof SqlSession.create>;
  let planSession: ReturnType<typeof SqlSession.create>;
  let restore: ReturnType<typeof sanitizeSqlForParser>["restore"];
  let planSqlText: string;
  try {
    const parserSql = sanitizeSqlForParser(sql);
    const planSql = sanitizeSqlForParser(maskWithInsertTargetForParser(parserSql.sql));
    sourceSession = SqlSession.create(parserSql.sql, dialect as never, { schema: input.schema });
    planSession = SqlSession.create(planSql.sql, dialect as never, { schema: input.schema });
    restore = parserSql.restore;
    planSqlText = planSql.sql;
  } catch (error) {
    for (const root of eligible)
      gaps.push(gap(
        input.load,
        root,
        "PLAN_BUILD_FAILED",
        `immutable SQL snapshot cannot be parsed: ${error instanceof Error ? error.message : String(error)}`,
      ));
    return { plans: [], gaps: gaps.sort((left, right) => left.gapId.localeCompare(right.gapId)) };
  }

  const groups = new Map<string, RootCriterion[]>();
  for (const root of eligible) {
    const values = groups.get(groupKey(root)) ?? [];
    values.push(root);
    groups.set(groupKey(root), values);
  }
  const plans: WriteScopedPlan[] = [];
  for (const roots of [...groups.values()].sort((left, right) =>
    groupKey(left[0]!).localeCompare(groupKey(right[0]!)),
  )) {
    const first = roots[0]!;
    const sourceCell = sourceSession.doc.statements[first.statementIndex];
    const planCell = planSession.doc.statements[first.statementIndex];
    if (!sourceCell || !planCell) {
      for (const root of roots)
        gaps.push(gap(
          input.load,
          root,
          "PLAN_STATEMENT_MISSING",
          `immutable SQL snapshot has no statement at index ${root.statementIndex}`,
        ));
      continue;
    }
    let plan: PlanFacts;
    try {
      plan = restore(planAdapter.buildPlanFacts(planCell, planSqlText, {
        statement_index: first.statementIndex,
        dialect,
        schema: input.schema,
        include_expression_dependencies: true,
      }));
    } catch (error) {
      for (const root of roots)
        gaps.push(gap(
          input.load,
          root,
          "PLAN_BUILD_FAILED",
          `statement ${root.statementId} Plan Facts build failed: ${error instanceof Error ? error.message : String(error)}`,
        ));
      continue;
    }
    const matched = roots.filter((root) => criterionMatchesPlan(root, plan));
    for (const root of roots)
      if (!matched.includes(root))
        gaps.push(gap(
          input.load,
          root,
          "PLAN_SCOPE_MISMATCH",
          "rebuilt Plan Facts does not match the proven statement/relation/expression occurrence",
        ));
    if (matched.length > 0)
      plans.push({
        sqlSourceId: first.sqlSourceId,
        statementId: first.statementId,
        statementIndex: first.statementIndex,
        plan,
        rootCriteria: matched.sort((left, right) => left.rootCriterionId.localeCompare(right.rootCriterionId)),
      });
  }
  return {
    plans,
    gaps: gaps.sort((left, right) => left.gapId.localeCompare(right.gapId)),
  };
}
