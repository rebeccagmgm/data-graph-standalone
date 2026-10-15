import {
  canonicalJson,
  sha256,
} from "../../../machine-facts/machine-facts-contract.ts";
import {
  globalExpressionId,
  globalRelationId,
} from "../../../machine-facts/plan-occurrence-id.ts";
import type { RootCriterion } from "./write-scoped-plan-inputs.ts";

export const SUBJECT_KINDS = ["PHYSICAL_FIELD", "RELATION_OCCURRENCE"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const EFFECT_KINDS = [
  "VALUE_CONTRIBUTION",
  "BRANCH_SELECTION",
  "ROW_MEMBERSHIP",
  "MULTIPLICITY",
  "GROUPING",
  "ORDERING",
  "WINDOW_CONTEXT",
  "SET_MEMBERSHIP",
  "RELATION_EXISTENCE",
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const OPERATOR_KINDS = [
  "PROJECT",
  "FILTER",
  "JOIN",
  "AGGREGATE",
  "DISTINCT",
  "SETOP",
  "WINDOW",
  "TOP_N",
  "SUBQUERY",
  "RELATION",
] as const;
export type OperatorKind = (typeof OPERATOR_KINDS)[number];

export const ROOT_DEPENDENCE_KINDS = [
  "VALUE_TO_TARGET",
  "CONTROL_TO_TARGET",
  "RELATION_TO_TARGET",
] as const;
export type RootDependenceKind = (typeof ROOT_DEPENDENCE_KINDS)[number];

export const LOCAL_EDGE_KINDS = [
  "VALUE_FLOW",
  "EXPRESSION_CONTROL",
  "ROWSET_CONTROL",
  "WINDOW_CONTEXT",
  "RELATION_CONTEXT",
] as const;
export type LocalEdgeKind = (typeof LOCAL_EDGE_KINDS)[number];

export const PATH_CERTAINTIES = [
  "CONFIRMED",
  "CONDITIONAL",
  "UNKNOWN",
] as const;
export type PathCertainty = (typeof PATH_CERTAINTIES)[number];

/** Support describes the semantic rule, not the evidence status of a path. */
export const SUPPORT_STATUSES = [
  "SUPPORTED",
  "UNKNOWN",
  "UNSUPPORTED",
] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const PROOF_REF_KINDS = [
  "CANONICAL_FACT",
  "SOURCE_SPAN",
  "SCHEMA",
  "READ_OCCURRENCE",
  "WRITE_OBSERVATION",
  "PRODUCER_BRIDGE",
  "SUPPORT_MATRIX",
  "CALCITE_OBSERVATION",
  "GAP",
  "NEGATIVE_PROOF",
] as const;
export type ProofRefKind = (typeof PROOF_REF_KINDS)[number];

export interface PhysicalFieldSubject {
  readonly subjectKind: "PHYSICAL_FIELD";
  readonly physicalFieldId: string;
}

export interface RelationOccurrenceSubject {
  readonly subjectKind: "RELATION_OCCURRENCE";
  readonly relationOccurrenceId: string;
}

export type SemanticSubject = PhysicalFieldSubject | RelationOccurrenceSubject;

export interface SemanticOccurrenceScope {
  readonly semanticScopeId: string;
  readonly taskId: string;
  readonly writeObservationId: string;
  readonly sqlSourceId: string;
  readonly writeStatementId: string;
  readonly statementId: string;
  readonly statementIndex: number;
  readonly rootRelationId: string;
  readonly localRootRelationId: string;
  readonly outputExpressionId: string;
  readonly localOutputExpressionId: string;
  readonly outputBindingId: string;
  readonly targetFieldBindingId: string;
  /** Owning operator relation for this semantic record. */
  readonly relationId: string;
  readonly localRelationId: string;
  readonly evidenceRefs: readonly string[];
}

type SemanticOccurrenceScopeIdentity = Omit<
  SemanticOccurrenceScope,
  "semanticScopeId" | "evidenceRefs"
>;

type SemanticWriteOccurrenceIdentity = Omit<
  SemanticOccurrenceScopeIdentity,
  "relationId" | "localRelationId"
>;

function ordered(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function makeScope(
  identity: SemanticOccurrenceScopeIdentity,
  evidenceRefs: readonly string[],
): SemanticOccurrenceScope {
  return {
    ...identity,
    semanticScopeId: idFor("semantic-scope", identity),
    evidenceRefs: ordered(evidenceRefs),
  };
}

/**
 * Stable identity of one local producer write/output. Owning operator
 * relations deliberately do not participate so adjacent local dependency
 * edges can be checked as one continuous write occurrence.
 */
export function semanticWriteOccurrenceKey(
  scope: SemanticOccurrenceScope,
): string {
  const identity: SemanticWriteOccurrenceIdentity = {
    taskId: scope.taskId,
    writeObservationId: scope.writeObservationId,
    sqlSourceId: scope.sqlSourceId,
    writeStatementId: scope.writeStatementId,
    statementId: scope.statementId,
    statementIndex: scope.statementIndex,
    rootRelationId: scope.rootRelationId,
    localRootRelationId: scope.localRootRelationId,
    outputExpressionId: scope.outputExpressionId,
    localOutputExpressionId: scope.localOutputExpressionId,
    outputBindingId: scope.outputBindingId,
    targetFieldBindingId: scope.targetFieldBindingId,
  };
  return canonicalJson(identity);
}

export function sameSemanticWriteOccurrence(
  left: SemanticOccurrenceScope,
  right: SemanticOccurrenceScope,
): boolean {
  return semanticWriteOccurrenceKey(left) === semanticWriteOccurrenceKey(right);
}

export function makeSemanticOccurrenceScope(input: {
  readonly rootCriterion: RootCriterion;
  readonly localRelationId?: string;
  readonly evidenceRefs?: readonly string[];
}): SemanticOccurrenceScope {
  const root = input.rootCriterion;
  const localRelationId = input.localRelationId ?? root.localRootRelationId;
  const relationId = globalRelationId(
    root.rootTaskId,
    root.statementIndex,
    localRelationId,
  );
  if (
    globalRelationId(root.rootTaskId, root.statementIndex, root.localRootRelationId) !== root.rootRelationId ||
    globalExpressionId(root.rootTaskId, root.statementIndex, root.localOutputExpressionId) !== root.outputExpressionId
  ) throw new Error(`SEMANTIC_SCOPE_ROOT_ROUNDTRIP_INVALID:${root.rootCriterionId}`);
  return makeScope({
    taskId: root.rootTaskId,
    writeObservationId: root.rootWriteObservationId,
    sqlSourceId: root.sqlSourceId,
    writeStatementId: root.writeStatementId,
    statementId: root.statementId,
    statementIndex: root.statementIndex,
    rootRelationId: root.rootRelationId,
    localRootRelationId: root.localRootRelationId,
    outputExpressionId: root.outputExpressionId,
    localOutputExpressionId: root.localOutputExpressionId,
    outputBindingId: root.outputBindingId,
    targetFieldBindingId: root.targetFieldBindingId,
    relationId,
    localRelationId,
  }, input.evidenceRefs ?? []);
}

export function semanticScopeForRelation(
  scope: SemanticOccurrenceScope,
  localRelationId: string,
  evidenceRefs: readonly string[] = [],
): SemanticOccurrenceScope {
  return makeScope({
    taskId: scope.taskId,
    writeObservationId: scope.writeObservationId,
    sqlSourceId: scope.sqlSourceId,
    writeStatementId: scope.writeStatementId,
    statementId: scope.statementId,
    statementIndex: scope.statementIndex,
    rootRelationId: scope.rootRelationId,
    localRootRelationId: scope.localRootRelationId,
    outputExpressionId: scope.outputExpressionId,
    localOutputExpressionId: scope.localOutputExpressionId,
    outputBindingId: scope.outputBindingId,
    targetFieldBindingId: scope.targetFieldBindingId,
    relationId: globalRelationId(scope.taskId, scope.statementIndex, localRelationId),
    localRelationId,
  }, [...scope.evidenceRefs, ...evidenceRefs]);
}

export function isCompleteSemanticOccurrenceScope(
  value: unknown,
  root?: RootCriterion,
): value is SemanticOccurrenceScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  const required = [
    "semanticScopeId",
    "taskId",
    "writeObservationId",
    "sqlSourceId",
    "writeStatementId",
    "statementId",
    "rootRelationId",
    "localRootRelationId",
    "outputExpressionId",
    "localOutputExpressionId",
    "outputBindingId",
    "targetFieldBindingId",
    "relationId",
    "localRelationId",
  ];
  if (required.some((field) => typeof scope[field] !== "string" || String(scope[field]).trim() === "")) return false;
  if (!Number.isInteger(scope.statementIndex) || Number(scope.statementIndex) < 0 || !Array.isArray(scope.evidenceRefs)) return false;
  const identity = {
    taskId: String(scope.taskId),
    writeObservationId: String(scope.writeObservationId),
    sqlSourceId: String(scope.sqlSourceId),
    writeStatementId: String(scope.writeStatementId),
    statementId: String(scope.statementId),
    statementIndex: Number(scope.statementIndex),
    rootRelationId: String(scope.rootRelationId),
    localRootRelationId: String(scope.localRootRelationId),
    outputExpressionId: String(scope.outputExpressionId),
    localOutputExpressionId: String(scope.localOutputExpressionId),
    outputBindingId: String(scope.outputBindingId),
    targetFieldBindingId: String(scope.targetFieldBindingId),
    relationId: String(scope.relationId),
    localRelationId: String(scope.localRelationId),
  };
  if (
    idFor("semantic-scope", identity) !== scope.semanticScopeId ||
    globalRelationId(identity.taskId, identity.statementIndex, identity.localRootRelationId) !== identity.rootRelationId ||
    globalExpressionId(identity.taskId, identity.statementIndex, identity.localOutputExpressionId) !== identity.outputExpressionId ||
    globalRelationId(identity.taskId, identity.statementIndex, identity.localRelationId) !== identity.relationId
  ) return false;
  return root === undefined || (
    identity.taskId === root.rootTaskId &&
    identity.writeObservationId === root.rootWriteObservationId &&
    identity.sqlSourceId === root.sqlSourceId &&
    identity.writeStatementId === root.writeStatementId &&
    identity.statementId === root.statementId &&
    identity.statementIndex === root.statementIndex &&
    identity.rootRelationId === root.rootRelationId &&
    identity.localRootRelationId === root.localRootRelationId &&
    identity.outputExpressionId === root.outputExpressionId &&
    identity.localOutputExpressionId === root.localOutputExpressionId &&
    identity.outputBindingId === root.outputBindingId &&
    identity.targetFieldBindingId === root.targetFieldBindingId
  );
}

export interface ProofRef {
  readonly proofRefId: string;
  readonly kind: ProofRefKind;
  readonly refId: string;
  readonly detail?: string;
}

export interface SemanticDependencyIdentity {
  readonly subject: SemanticSubject;
  readonly effectKind: EffectKind;
  readonly operatorKind: OperatorKind;
  readonly operatorVariant: string;
  readonly operatorRole: string;
  readonly localEdgeKind: LocalEdgeKind;
}

export interface SemanticDependencyDefinition extends SemanticDependencyIdentity {
  readonly dependencyId: string;
  readonly semanticScopeId?: string;
  readonly semanticScope?: SemanticOccurrenceScope;
  readonly supportStatus: SupportStatus;
  readonly proofRefs: readonly ProofRef[];
}

export interface SemanticDependencyApplication {
  readonly applicationId: string;
  readonly dependencyId: string;
  readonly rootCriterionId?: string;
  readonly semanticScopeId?: string;
  readonly semanticScope?: SemanticOccurrenceScope;
  /** Native relation occurrence that owns this application, when known. */
  readonly scopeRelationId?: string;
  readonly rootTargetFieldId: string;
  readonly rootDependenceKind: RootDependenceKind;
  readonly pathCertainty: PathCertainty;
  readonly proofRefs: readonly ProofRef[];
}

export interface SemanticDependencyEdge {
  readonly edgeId: string;
  readonly fromSubject: SemanticSubject;
  readonly toSubject: SemanticSubject;
  readonly dependencyId: string;
  readonly rootCriterionId?: string;
  readonly semanticScopeId?: string;
  readonly semanticScope?: SemanticOccurrenceScope;
  /** Native relation occurrence that owns this edge, when known. */
  readonly scopeRelationId?: string;
  readonly rootDependenceKind: RootDependenceKind;
  readonly localEdgeKind: LocalEdgeKind;
  readonly pathCertainty: PathCertainty;
  readonly proofRefs: readonly ProofRef[];
}

export interface SemanticDependencyIdInput extends SemanticDependencyIdentity {
  readonly namespace?: string;
  readonly semanticScopeId?: string;
}

function idFor(namespace: string, value: unknown): string {
  return `${namespace}:${sha256(canonicalJson(value))}`;
}

export function canonicalProofRefId(kind: ProofRefKind, refId: string): string {
  return idFor("proof-ref", { kind, refId });
}

export function createProofRef(
  kind: ProofRefKind,
  refId: string,
  detail?: string,
): ProofRef {
  const proofRefId = canonicalProofRefId(kind, refId);
  return detail === undefined
    ? { proofRefId, kind, refId }
    : { proofRefId, kind, refId, detail };
}

export function canonicalSemanticDependencyId(
  input: SemanticDependencyIdInput,
): string {
  const { namespace: _namespace, ...identity } = input;
  return idFor(input.namespace ?? "semantic-dependency", identity);
}

export function canonicalSemanticApplicationId(
  rootTargetFieldId: string,
  dependencyId: string,
  rootDependenceKind: RootDependenceKind,
  scopeRelationId?: string,
  occurrence?: {
    readonly rootCriterionId: string;
    readonly semanticScopeId: string;
  },
): string {
  return idFor("semantic-application", {
    rootTargetFieldId,
    dependencyId,
    rootDependenceKind,
    ...(scopeRelationId === undefined ? {} : { scopeRelationId }),
    ...(occurrence === undefined ? {} : occurrence),
  });
}

export function canonicalSemanticEdgeId(input: {
  readonly dependencyId: string;
  readonly fromSubject: SemanticSubject;
  readonly toSubject: SemanticSubject;
  readonly rootDependenceKind: RootDependenceKind;
  readonly localEdgeKind: LocalEdgeKind;
  readonly scopeRelationId?: string;
  readonly rootCriterionId?: string;
  readonly semanticScopeId?: string;
}): string {
  return idFor("semantic-edge", input);
}

export function makeSemanticDependencyDefinition(
  identity: SemanticDependencyIdentity,
  supportStatus: SupportStatus,
  proofRefs: readonly ProofRef[] = [],
  namespace?: string,
  semanticScope?: SemanticOccurrenceScope,
): SemanticDependencyDefinition {
  return {
    ...identity,
    dependencyId: canonicalSemanticDependencyId({
      ...identity,
      ...(namespace === undefined ? {} : { namespace }),
      ...(semanticScope === undefined ? {} : { semanticScopeId: semanticScope.semanticScopeId }),
    }),
    ...(semanticScope === undefined
      ? {}
      : { semanticScopeId: semanticScope.semanticScopeId, semanticScope }),
    supportStatus,
    proofRefs: [...proofRefs].sort((left, right) =>
      left.proofRefId.localeCompare(right.proofRefId),
    ),
  };
}
export function makeSemanticDependencyApplication(input: {
  readonly dependencyId: string;
  readonly scopeRelationId?: string;
  readonly rootTargetFieldId: string;
  readonly rootDependenceKind: RootDependenceKind;
  readonly pathCertainty: PathCertainty;
  readonly proofRefs?: readonly ProofRef[];
  readonly rootCriterionId?: string;
  readonly semanticScope?: SemanticOccurrenceScope;
}): SemanticDependencyApplication {
  return {
    ...input,
    applicationId: canonicalSemanticApplicationId(
      input.rootTargetFieldId,
      input.dependencyId,
      input.rootDependenceKind,
      input.scopeRelationId,
      input.rootCriterionId && input.semanticScope
        ? {
            rootCriterionId: input.rootCriterionId,
            semanticScopeId: input.semanticScope.semanticScopeId,
          }
        : undefined,
    ),
    ...(input.semanticScope === undefined
      ? {}
      : {
          semanticScopeId: input.semanticScope.semanticScopeId,
          semanticScope: input.semanticScope,
        }),
    proofRefs: [...(input.proofRefs ?? [])].sort((left, right) =>
      left.proofRefId.localeCompare(right.proofRefId),
    ),
  };
}

export function makeSemanticDependencyEdge(input: {
  readonly dependencyId: string;
  readonly fromSubject: SemanticSubject;
  readonly toSubject: SemanticSubject;
  readonly rootDependenceKind: RootDependenceKind;
  readonly localEdgeKind: LocalEdgeKind;
  readonly scopeRelationId?: string;
  readonly pathCertainty: PathCertainty;
  readonly proofRefs?: readonly ProofRef[];
  readonly rootCriterionId?: string;
  readonly semanticScope?: SemanticOccurrenceScope;
}): SemanticDependencyEdge {
  const identity = {
    dependencyId: input.dependencyId,
    fromSubject: input.fromSubject,
    toSubject: input.toSubject,
    rootDependenceKind: input.rootDependenceKind,
    localEdgeKind: input.localEdgeKind,
    ...(input.scopeRelationId === undefined ? {} : { scopeRelationId: input.scopeRelationId }),
    ...(input.rootCriterionId === undefined ? {} : { rootCriterionId: input.rootCriterionId }),
    ...(input.semanticScope === undefined ? {} : { semanticScopeId: input.semanticScope.semanticScopeId }),
  };
  return {
    ...input,
    edgeId: canonicalSemanticEdgeId(identity),
    ...(input.semanticScope === undefined
      ? {}
      : {
          semanticScopeId: input.semanticScope.semanticScopeId,
          semanticScope: input.semanticScope,
        }),
    proofRefs: [...(input.proofRefs ?? [])].sort((left, right) =>
      left.proofRefId.localeCompare(right.proofRefId),
    ),
  };
}

