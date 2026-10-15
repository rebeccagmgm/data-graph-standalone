import type {
  ColumnRef,
  FilterRelation,
  JoinRelation,
  PlanFacts,
  PlanRelation,
  PredicateOperand,
  PredicateTree,
  ProjectRelation,
  ReadRelation,
  SourceSpan,
} from "./plan-contract.ts";

/** The disposition of one predicate subtree for one physical READ occurrence. */
export type ReadOccurrencePredicateDisposition =
  "CONSTRAINED" | "PARTIAL" | "UNKNOWN" | "IRRELEVANT";

/** Evidence for one source predicate subtree and one READ occurrence. */
export interface ReadOccurrencePredicateEvidence {
  readonly relationId: string;
  readonly relationType: "filter" | "join";
  /** The complete Filter/Join predicate tree, never the pruned tree only. */
  readonly predicateTree: PredicateTree | null;
  /** The AND unit or complete OR/NOT tree considered for this occurrence. */
  readonly assignedTree: PredicateTree | null;
  readonly sourceSpan: SourceSpan;
  readonly sourceExpression: string | null;
  /** Scope that owns the source Filter/Join, when PlanFacts provides it. */
  readonly scopeId: string | null;
  readonly relationPath: readonly string[];
  readonly appliesToOccurrence: boolean;
  readonly disposition: ReadOccurrencePredicateDisposition;
  readonly reasonCodes: readonly string[];
}

/** One physical ReadRelation occurrence with independently attributed predicates. */
export interface ReadOccurrenceResolution {
  /** Stable PlanFacts ReadRelation id; same table may have several ids. */
  readonly occurrenceId: string;
  readonly readRelationId: string;
  readonly table: string;
  readonly binding: string;
  /** Safe predicate subtrees combined with AND; null means no safe constraint. */
  readonly predicateTree: PredicateTree | null;
  readonly predicateEvidence: readonly ReadOccurrencePredicateEvidence[];
  /** Binding status is separate from Table Pack partition evaluation. */
  readonly bindingStatus: "UNCONSTRAINED" | "CONSTRAINED" | "UNKNOWN";
  readonly reasonCodes: readonly string[];
  readonly relationPath: readonly string[];
}

interface ReachableOccurrence {
  readonly read: ReadRelation;
  readonly relationPath: readonly string[];
  readonly barriers: readonly string[];
  /** Qualifiers visible on the path (CTE alias first, physical binding last). */
  readonly visibleBindings: readonly string[];
}

interface Reachability {
  readonly occurrences: readonly ReachableOccurrence[];
  readonly unresolvedReasons: readonly string[];
}

interface PredicateUnit {
  readonly tree: PredicateTree | null;
  readonly originalTree: PredicateTree | null;
  readonly relationTree: PredicateTree | null;
  readonly relationId: string;
  readonly relationType: "filter" | "join";
  readonly sourceSpan: SourceSpan;
  readonly sourceExpression: string | null;
  readonly scopeId: string | null;
  readonly reasonCodes: readonly string[];
  readonly disposition: "SAFE" | "UNKNOWN" | "IRRELEVANT";
  readonly tables: readonly string[];
  readonly qualifiers: readonly string[];
}

interface OccurrenceBuilder {
  readonly occurrenceId: string;
  readonly read: ReadRelation;
  readonly binding: string;
  readonly relationPath: readonly string[];
  readonly safeTrees: PredicateTree[];
  readonly evidence: ReadOccurrencePredicateEvidence[];
  readonly reasonCodes: Set<string>;
  readonly relationPaths: string[][];
  hasUnknownEvidence: boolean;
}

interface ReadOccurrenceContext {
  readonly occurrenceId: string;
  readonly read: ReadRelation;
  readonly binding: string;
  readonly anchorPath: readonly string[];
  readonly relationPath: readonly string[];
}

function normalize(value: string): string {
  return value.trim().replaceAll("`", "").replaceAll('"', "").toLowerCase();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function tableKey(value: string): string {
  return normalize(value);
}

function fieldKey(table: string, column: string): string {
  return `${tableKey(table)}.${normalize(column)}`;
}

function pathKey(path: readonly string[]): string {
  return path.join("\u0000");
}

function isSubsequence(
  needle: readonly string[],
  haystack: readonly string[],
): boolean {
  if (needle.length === 0) return true;
  let needleIndex = 0;
  for (const value of haystack) {
    if (value === needle[needleIndex]) needleIndex += 1;
    if (needleIndex === needle.length) return true;
  }
  return false;
}

function sourceSpanOf(relation: FilterRelation | JoinRelation): SourceSpan {
  return relation.span;
}

function relationTreeOf(
  relation: FilterRelation | JoinRelation,
): PredicateTree | null {
  return relation.type === "filter"
    ? (relation.predicate_tree ?? null)
    : (relation.condition_tree ?? null);
}

function relationExpressionOf(
  relation: FilterRelation | JoinRelation,
): string | null {
  return relation.type === "filter"
    ? relation.predicate_expr
    : relation.condition_expr;
}

function relationColumnsOf(
  relation: FilterRelation | JoinRelation,
): readonly ColumnRef[] {
  return relation.type === "filter"
    ? relation.predicate_columns
    : relation.condition_columns;
}

function relationContainsSubquery(
  relation: FilterRelation | JoinRelation,
): boolean {
  return relation.contains_subquery === true;
}

function physicalRefsOfOperand(
  operand: PredicateOperand,
): readonly ColumnRef[] {
  if (operand.kind === "COLUMN") return [operand.column];
  if (operand.kind === "OTHER") return operand.inputColumns;
  return [];
}

function columnsOfTree(tree: PredicateTree | null): readonly ColumnRef[] {
  if (!tree) return [];
  if (tree.kind === "AND" || tree.kind === "OR")
    return tree.children.flatMap((child) => columnsOfTree(child));
  if (tree.kind === "NOT") return columnsOfTree(tree.child);
  if (tree.kind === "ATOM") return tree.operands.flatMap(physicalRefsOfOperand);
  return [];
}

function physicalTablesOf(tree: PredicateTree | null): readonly string[] {
  return uniqueSorted(
    columnsOfTree(tree).flatMap((column) =>
      (column.physical ?? []).map((physical) => tableKey(physical.table)),
    ),
  );
}

function physicalTablesOfColumns(
  columns: readonly ColumnRef[],
): readonly string[] {
  return uniqueSorted(
    columns.flatMap((column) =>
      (column.physical ?? []).map((physical) => tableKey(physical.table)),
    ),
  );
}

function qualifiersOf(tree: PredicateTree | null): readonly string[] {
  return uniqueSorted(
    columnsOfTree(tree)
      .map((column) => column.qualifier)
      .filter((qualifier): qualifier is string => qualifier !== undefined)
      .map(normalize),
  );
}

function qualifiersOfColumns(columns: readonly ColumnRef[]): readonly string[] {
  return uniqueSorted(
    columns
      .map((column) => column.qualifier)
      .filter((qualifier): qualifier is string => qualifier !== undefined)
      .map(normalize),
  );
}

function hasUnresolvedColumn(tree: PredicateTree | null): boolean {
  return columnsOfTree(tree).some(
    (column) =>
      column.physical === null ||
      (column.resolution !== undefined && column.resolution !== "PHYSICAL"),
  );
}

function hasOtherOperand(tree: PredicateTree | null): boolean {
  if (!tree) return false;
  if (tree.kind === "AND" || tree.kind === "OR")
    return tree.children.some((child) => hasOtherOperand(child));
  if (tree.kind === "NOT") return hasOtherOperand(tree.child);
  return tree.kind === "ATOM"
    ? tree.operands.some((operand) => operand.kind === "OTHER")
    : false;
}

function hasNonLiteralPredicate(tree: PredicateTree | null): boolean {
  if (!tree) return false;
  if (tree.kind === "AND" || tree.kind === "OR")
    return tree.children.some((child) => hasNonLiteralPredicate(child));
  if (tree.kind === "NOT") return true;
  return tree.kind === "ATOM" && tree.operator === "OTHER";
}

function mergeSpan(children: readonly PredicateTree[]): SourceSpan {
  return {
    start: Math.min(...children.map((child) => child.span.start)),
    end: Math.max(...children.map((child) => child.span.end)),
  };
}

function andTree(children: readonly PredicateTree[]): PredicateTree | null {
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: "AND", children: [...children], span: mergeSpan(children) };
}

function flattenAnd(
  tree: PredicateTree | null,
): readonly (PredicateTree | null)[] {
  if (!tree) return [null];
  if (tree.kind !== "AND") return [tree];
  return tree.children.flatMap((child) => flattenAnd(child));
}

function treeHasPhysicalOrUnknownColumn(tree: PredicateTree): boolean {
  return hasUnresolvedColumn(tree) || physicalTablesOf(tree).length > 0;
}

function classifyTree(
  tree: PredicateTree | null,
  relation: FilterRelation | JoinRelation,
): {
  readonly disposition: "SAFE" | "UNKNOWN" | "IRRELEVANT";
  readonly tables: readonly string[];
  readonly qualifiers: readonly string[];
  readonly reasonCodes: readonly string[];
} {
  const relationColumns = relationColumnsOf(relation);
  const tables = tree
    ? physicalTablesOf(tree)
    : physicalTablesOfColumns(relationColumns);
  const qualifiers = tree
    ? qualifiersOf(tree)
    : qualifiersOfColumns(relationColumns);
  if (!tree)
    return {
      disposition: "UNKNOWN",
      tables,
      qualifiers,
      reasonCodes: [
        "READ_OCCURRENCE_PREDICATE_TREE_UNAVAILABLE",
        ...(relationColumns.some(
          (column) =>
            column.physical === null ||
            (column.resolution !== undefined &&
              column.resolution !== "PHYSICAL"),
        )
          ? ["READ_OCCURRENCE_COLUMN_PHYSICAL_ORIGIN_UNRESOLVED"]
          : []),
      ],
    };
  if (tree.kind === "OR") {
    const branchTables = tree.children.flatMap((child) =>
      physicalTablesOf(child),
    );
    const hasUnknownBranch = tree.children.some((child) => {
      const branchTablesOfChild = physicalTablesOf(child);
      return (
        hasUnresolvedColumn(child) ||
        hasOtherOperand(child) ||
        (branchTablesOfChild.length === 0 &&
          treeHasPhysicalOrUnknownColumn(child))
      );
    });
    if (hasUnknownBranch || new Set(branchTables).size > 1)
      return {
        disposition: "UNKNOWN",
        tables,
        qualifiers,
        reasonCodes: [
          new Set(branchTables).size > 1
            ? "READ_OCCURRENCE_OR_CROSS_TABLE_NOT_PUSHDOWN"
            : "READ_OCCURRENCE_OR_BRANCH_UNRESOLVED",
        ],
      };
    if (tables.length === 0 && hasOtherOperand(tree))
      return {
        disposition: "UNKNOWN",
        tables,
        qualifiers,
        reasonCodes: ["READ_OCCURRENCE_PREDICATE_OPERAND_UNSUPPORTED"],
      };
    return { disposition: "SAFE", tables, qualifiers, reasonCodes: [] };
  }
  if (tree.kind === "NOT")
    return {
      disposition: treeHasPhysicalOrUnknownColumn(tree)
        ? "UNKNOWN"
        : "IRRELEVANT",
      tables,
      qualifiers,
      reasonCodes: treeHasPhysicalOrUnknownColumn(tree)
        ? ["READ_OCCURRENCE_NOT_OPERATOR_UNSUPPORTED"]
        : [],
    };
  if (hasUnresolvedColumn(tree))
    return {
      disposition: "UNKNOWN",
      tables,
      qualifiers,
      reasonCodes: ["READ_OCCURRENCE_COLUMN_PHYSICAL_ORIGIN_UNRESOLVED"],
    };
  if (tables.length === 0) {
    if (hasOtherOperand(tree) || hasNonLiteralPredicate(tree))
      return {
        disposition: "UNKNOWN",
        tables,
        qualifiers,
        reasonCodes: ["READ_OCCURRENCE_PREDICATE_OPERAND_UNSUPPORTED"],
      };
    return { disposition: "IRRELEVANT", tables, qualifiers, reasonCodes: [] };
  }
  if (tables.length > 1)
    return {
      disposition: "UNKNOWN",
      tables,
      qualifiers,
      reasonCodes: ["READ_OCCURRENCE_CROSS_TABLE_PREDICATE_NOT_PUSHDOWN"],
    };
  return { disposition: "SAFE", tables, qualifiers, reasonCodes: [] };
}

function directProjectExpression(
  expression: ProjectRelation["expressions"][number],
  table: string,
  column: string,
): boolean {
  if (expression.aggregate === true || expression.window === true) return false;
  if (
    expression.expr_kind !== "column" &&
    expression.output_name_status !== "STAR_EXPANSION"
  )
    return false;
  return (expression.input_columns ?? []).some(
    (input) =>
      input.resolution === "PHYSICAL" &&
      (input.physical ?? []).some(
        (physical) =>
          fieldKey(physical.table, physical.column) === fieldKey(table, column),
      ),
  );
}

function crossesUnsafeBoundary(
  candidate: ReachableOccurrence,
  tree: PredicateTree,
  byId: ReadonlyMap<string, PlanRelation>,
): string | null {
  const fields = columnsOfTree(tree)
    .flatMap((column) =>
      (column.physical ?? []).map((physical) => ({
        table: physical.table,
        column: physical.column,
      })),
    )
    .filter(
      (field) => tableKey(field.table) === tableKey(candidate.read.table),
    );
  for (const relationId of candidate.relationPath) {
    const relation = byId.get(relationId);
    if (!relation) continue;
    if (relation.type === "aggregate")
      return "READ_OCCURRENCE_AGGREGATE_BOUNDARY_NOT_PUSHDOWN";
    if (relation.type === "expand")
      return "READ_OCCURRENCE_EXPAND_BOUNDARY_NOT_PUSHDOWN";
    if (relation.type === "other")
      return "READ_OCCURRENCE_UNMODELED_SCOPE_BOUNDARY";
    if (relation.type !== "project") continue;
    if (
      fields.length === 0 ||
      fields.every((field) =>
        relation.expressions.some((expression) =>
          directProjectExpression(expression, field.table, field.column),
        ),
      )
    )
      continue;
    return "READ_OCCURRENCE_PROJECT_OUTPUT_NOT_DIRECT";
  }
  return candidate.barriers[0] ?? null;
}

function dedupeReachable(
  values: readonly ReachableOccurrence[],
): readonly ReachableOccurrence[] {
  const byPath = new Map<string, ReachableOccurrence>();
  for (const value of values) {
    const key = `${value.read.id}\u0000${pathKey(value.relationPath)}`;
    const previous = byPath.get(key);
    if (!previous) {
      byPath.set(key, value);
      continue;
    }
    const previousPath = previous.relationPath.length;
    if (value.relationPath.length < previousPath) byPath.set(key, value);
  }
  return [...byPath.values()].sort(
    (left, right) =>
      left.read.id.localeCompare(right.read.id) ||
      pathKey(left.relationPath).localeCompare(pathKey(right.relationPath)),
  );
}

function readRelationReachability(
  relationId: string,
  byId: ReadonlyMap<string, PlanRelation>,
  bindings: ReadonlyMap<
    string,
    readonly { target_relation_id: string | null }[]
  >,
  stack = new Set<string>(),
  path: readonly string[] = [],
): Reachability {
  if (stack.has(relationId))
    return {
      occurrences: [],
      unresolvedReasons: ["READ_OCCURRENCE_RELATION_GRAPH_CYCLE"],
    };
  const relation = byId.get(relationId);
  if (!relation)
    return {
      occurrences: [],
      unresolvedReasons: ["READ_OCCURRENCE_RELATION_NOT_FOUND"],
    };
  const nextStack = new Set(stack);
  nextStack.add(relationId);
  const nextPath = [...path, relationId];
  if (relation.type === "read") {
    if (!relation.is_cte)
      return {
        occurrences: [
          {
            read: relation,
            relationPath: nextPath,
            barriers: [],
            visibleBindings: uniqueSorted(
              nextPath.flatMap((id) => {
                const pathRelation = byId.get(id);
                return pathRelation?.type === "read"
                  ? [pathRelation.binding]
                  : [];
              }),
            ),
          },
        ],
        unresolvedReasons: [],
      };
    const targets = bindings.get(relation.id) ?? [];
    if (targets.length === 0)
      return {
        occurrences: [],
        unresolvedReasons: ["READ_OCCURRENCE_CTE_SCOPE_MAPPING_MISSING"],
      };
    const childResults = targets.map((target) =>
      target.target_relation_id
        ? readRelationReachability(
            target.target_relation_id,
            byId,
            bindings,
            nextStack,
            nextPath,
          )
        : {
            occurrences: [],
            unresolvedReasons: ["READ_OCCURRENCE_CTE_SCOPE_MAPPING_UNRESOLVED"],
          },
    );
    return {
      occurrences: dedupeReachable(
        childResults.flatMap((result) => result.occurrences),
      ),
      unresolvedReasons: uniqueSorted(
        childResults.flatMap((result) => result.unresolvedReasons),
      ),
    };
  }
  const childIds: readonly string[] =
    relation.type === "join"
      ? [relation.left, relation.right]
      : relation.type === "setop"
        ? relation.branches
        : relation.source
          ? [relation.source]
          : [];
  if (childIds.length === 0)
    return {
      occurrences: [],
      unresolvedReasons: ["READ_OCCURRENCE_RELATION_INPUT_MISSING"],
    };
  const childResults = childIds.map((childId) =>
    readRelationReachability(childId, byId, bindings, nextStack, nextPath),
  );
  const barriers =
    relation.type === "aggregate"
      ? ["READ_OCCURRENCE_AGGREGATE_BOUNDARY_NOT_PUSHDOWN"]
      : relation.type === "expand"
        ? ["READ_OCCURRENCE_EXPAND_BOUNDARY_NOT_PUSHDOWN"]
        : relation.type === "other"
          ? ["READ_OCCURRENCE_UNMODELED_SCOPE_BOUNDARY"]
          : [];
  return {
    occurrences: dedupeReachable(
      childResults.flatMap((result) =>
        result.occurrences.map((occurrence) => ({
          ...occurrence,
          barriers: [...occurrence.barriers, ...barriers],
        })),
      ),
    ),
    unresolvedReasons: uniqueSorted(
      childResults.flatMap((result) => result.unresolvedReasons),
    ),
  };
}

function referencePathsForScope(
  scopeId: string,
  bindingsByTargetScope: ReadonlyMap<string, readonly string[]>,
  byId: ReadonlyMap<string, PlanRelation>,
  stack = new Set<string>(),
): readonly (readonly string[])[] {
  if (stack.has(scopeId)) return [];
  const nextStack = new Set(stack);
  nextStack.add(scopeId);
  const references = bindingsByTargetScope.get(scopeId) ?? [];
  const paths: string[][] = [];
  for (const relationId of references) {
    const relation = byId.get(relationId);
    if (!relation || relation.type !== "read" || relation.is_cte !== true)
      continue;
    const parentScope = relation.scope_id;
    const parentPaths = parentScope
      ? referencePathsForScope(
          parentScope,
          bindingsByTargetScope,
          byId,
          nextStack,
        )
      : [];
    if (parentPaths.length === 0) paths.push([relationId]);
    else
      for (const parentPath of parentPaths)
        paths.push([...parentPath, relationId]);
  }
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = pathKey(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function occurrenceContexts(
  plan: PlanFacts,
  physicalReads: readonly ReadRelation[],
  byId: ReadonlyMap<string, PlanRelation>,
): readonly ReadOccurrenceContext[] {
  const bindingsByTargetScope = new Map<string, string[]>();
  for (const binding of plan.scope_bindings ?? []) {
    if (!binding.target_scope_id) continue;
    const current = bindingsByTargetScope.get(binding.target_scope_id) ?? [];
    current.push(binding.relation_id);
    bindingsByTargetScope.set(binding.target_scope_id, current);
  }
  const contexts: ReadOccurrenceContext[] = [];
  for (const read of physicalReads) {
    const anchorPaths = read.scope_id
      ? referencePathsForScope(read.scope_id, bindingsByTargetScope, byId)
      : [];
    const paths = anchorPaths.length > 0 ? anchorPaths : [[]];
    for (const anchorPath of paths) {
      const anchorRelations = anchorPath
        .map((relationId) => byId.get(relationId))
        .filter(
          (relation): relation is ReadRelation => relation?.type === "read",
        );
      const binding = anchorRelations.at(-1)?.binding ?? read.binding;
      const relationPath = [...anchorPath, read.id];
      const occurrenceId = anchorPath.length
        ? `${anchorPath.join("->")}=>${read.id}`
        : read.id;
      contexts.push({
        occurrenceId,
        read,
        binding,
        anchorPath,
        relationPath,
      });
    }
  }
  const seen = new Set<string>();
  return contexts.filter((context) => {
    if (seen.has(context.occurrenceId)) return false;
    seen.add(context.occurrenceId);
    return true;
  });
}

function contextsForReachable(
  occurrence: ReachableOccurrence,
  contextsByRead: ReadonlyMap<string, readonly ReadOccurrenceContext[]>,
): readonly ReadOccurrenceContext[] {
  const contexts = contextsByRead.get(occurrence.read.id) ?? [];
  if (contexts.length <= 1) return contexts;
  const anchored = contexts.filter(
    (context) =>
      context.anchorPath.length > 0 &&
      isSubsequence(context.anchorPath, occurrence.relationPath),
  );
  return anchored.length > 0 ? anchored : contexts;
}

function contextualOccurrence(
  occurrence: ReachableOccurrence,
  context: ReadOccurrenceContext,
): ReachableOccurrence {
  if (context.anchorPath.length === 0) return occurrence;
  if (isSubsequence(context.anchorPath, occurrence.relationPath))
    return occurrence;
  return {
    ...occurrence,
    relationPath: [...context.anchorPath, ...occurrence.relationPath],
  };
}

function addEvidence(
  builder: OccurrenceBuilder,
  unit: PredicateUnit,
  occurrence: ReachableOccurrence,
  disposition: ReadOccurrencePredicateDisposition,
  applies: boolean,
  reasonCodes: readonly string[],
  includeUnitReasonCodes = true,
): void {
  const reasons = uniqueSorted([
    ...(includeUnitReasonCodes ? unit.reasonCodes : []),
    ...reasonCodes,
  ]);
  builder.evidence.push({
    relationId: unit.relationId,
    relationType: unit.relationType,
    predicateTree: unit.relationTree,
    assignedTree: unit.tree,
    sourceSpan: unit.sourceSpan,
    sourceExpression: unit.sourceExpression,
    scopeId: unit.scopeId,
    relationPath: occurrence.relationPath,
    appliesToOccurrence: applies,
    disposition,
    reasonCodes: reasons,
  });
  for (const reason of reasons) builder.reasonCodes.add(reason);
  if (disposition === "UNKNOWN") builder.hasUnknownEvidence = true;
}

function buildUnits(
  relation: FilterRelation | JoinRelation,
): readonly PredicateUnit[] {
  const tree = relationTreeOf(relation);
  const relationType = relation.type;
  const sourceSpan = sourceSpanOf(relation);
  const sourceExpression = relationExpressionOf(relation);
  return flattenAnd(tree).map((unitTree) => {
    const classification = classifyTree(unitTree, relation);
    const reasonCodes =
      classification.disposition === "UNKNOWN" &&
      relationContainsSubquery(relation)
        ? ["READ_OCCURRENCE_CORRELATED_SUBQUERY_NOT_PUSHDOWN"]
        : classification.reasonCodes;
    return {
      tree: classification.disposition === "SAFE" ? unitTree : null,
      originalTree: unitTree,
      relationTree: tree,
      relationId: relation.id,
      relationType,
      sourceSpan,
      sourceExpression,
      scopeId: relation.scope_id ?? null,
      reasonCodes,
      disposition: classification.disposition,
      tables: classification.tables,
      qualifiers: classification.qualifiers,
    };
  });
}

function isSetopDistributed(
  unit: PredicateUnit,
  reachable: readonly ReachableOccurrence[],
  byId: ReadonlyMap<string, PlanRelation>,
): boolean {
  if (
    unit.relationType !== "filter" ||
    unit.tables.length < 2 ||
    unit.originalTree?.kind !== "ATOM" ||
    unit.disposition !== "UNKNOWN"
  )
    return false;
  const reasonCodes = new Set(unit.reasonCodes);
  if (!reasonCodes.has("READ_OCCURRENCE_CROSS_TABLE_PREDICATE_NOT_PUSHDOWN"))
    return false;
  const candidates = reachable.filter((candidate) =>
    unit.tables.includes(tableKey(candidate.read.table)),
  );
  return (
    candidates.length > 0 &&
    new Set(candidates.map((candidate) => tableKey(candidate.read.table)))
      .size === new Set(unit.tables).size &&
    candidates.every((candidate) =>
      candidate.relationPath.some(
        (relationId) => byId.get(relationId)?.type === "setop",
      ),
    )
  );
}

function candidatesForUnit(
  unit: PredicateUnit,
  reachable: readonly ReachableOccurrence[],
): {
  readonly targets: readonly ReachableOccurrence[];
  readonly ambiguous: readonly ReachableOccurrence[];
} {
  if (unit.tables.length === 0)
    return { targets: [], ambiguous: [...reachable] };
  const table = unit.tables[0]!;
  const byTable = reachable.filter(
    (candidate) => tableKey(candidate.read.table) === table,
  );
  if (byTable.length === 0) return { targets: [], ambiguous: [...reachable] };
  if (unit.qualifiers.length === 0)
    return byTable.length === 1
      ? { targets: byTable, ambiguous: [] }
      : { targets: [], ambiguous: byTable };
  const byBinding = byTable.filter((candidate) =>
    candidate.visibleBindings.some((binding) =>
      unit.qualifiers.includes(normalize(binding)),
    ),
  );
  if (byBinding.length === 1) return { targets: byBinding, ambiguous: [] };
  // A derived-table/CTE alias is not the base ReadRelation binding.  When the
  // physical table has exactly one reachable occurrence, the scope mapping
  // makes that boundary unambiguous even though the visible qualifier changed.
  return byTable.length === 1
    ? { targets: byTable, ambiguous: [] }
    : { targets: [], ambiguous: byTable };
}

function appendRelation(
  relation: FilterRelation | JoinRelation,
  byId: ReadonlyMap<string, PlanRelation>,
  bindings: ReadonlyMap<
    string,
    readonly { target_relation_id: string | null }[]
  >,
  contextsByRead: ReadonlyMap<string, readonly ReadOccurrenceContext[]>,
  builders: ReadonlyMap<string, OccurrenceBuilder>,
): void {
  const sourceIds =
    relation.type === "join"
      ? [relation.left, relation.right]
      : relation.source
        ? [relation.source]
        : [];
  const reachable = sourceIds
    .map((sourceId) => readRelationReachability(sourceId, byId, bindings))
    .reduce<Reachability>(
      (accumulator, next) => ({
        occurrences: dedupeReachable([
          ...accumulator.occurrences,
          ...next.occurrences,
        ]),
        unresolvedReasons: uniqueSorted([
          ...accumulator.unresolvedReasons,
          ...next.unresolvedReasons,
        ]),
      }),
      { occurrences: [], unresolvedReasons: [] },
    );
  const units = buildUnits(relation);
  const forEachContext = (
    occurrence: ReachableOccurrence,
    callback: (
      builder: OccurrenceBuilder,
      contextual: ReachableOccurrence,
    ) => void,
  ): void => {
    for (const context of contextsForReachable(occurrence, contextsByRead)) {
      const builder = builders.get(context.occurrenceId);
      if (!builder) continue;
      callback(builder, contextualOccurrence(occurrence, context));
    }
  };
  if (reachable.occurrences.length === 0) {
    // A missing edge is a scope-local failure.  Do not broadcast it to every
    // physical READ in the document: unrelated scopes must retain their own
    // evidence and binding status.  With no scope_id there is no safe target,
    // so the unresolved condition is intentionally not attached to any READ.
    const scopeBuilders = relation.scope_id
      ? [...builders.values()].filter(
          (builder) => builder.read.scope_id === relation.scope_id,
        )
      : [];
    for (const builder of scopeBuilders) {
      for (const unit of units)
        addEvidence(
          builder,
          unit,
          {
            read: builder.read,
            relationPath: builder.relationPath,
            barriers: [],
            visibleBindings: [builder.binding],
          },
          "UNKNOWN",
          false,
          uniqueSorted([
            "READ_OCCURRENCE_SCOPE_REACHABILITY_UNKNOWN",
            ...reachable.unresolvedReasons,
          ]),
        );
    }
    return;
  }
  for (const unit of units) {
    const candidates = candidatesForUnit(unit, reachable.occurrences);
    if (unit.disposition === "IRRELEVANT") {
      for (const occurrence of reachable.occurrences) {
        forEachContext(occurrence, (builder, contextual) =>
          addEvidence(builder, unit, contextual, "IRRELEVANT", false, []),
        );
      }
      continue;
    }
    if (unit.disposition === "UNKNOWN") {
      if (isSetopDistributed(unit, reachable.occurrences, byId)) {
        for (const occurrence of reachable.occurrences) {
          if (!unit.tables.includes(tableKey(occurrence.read.table))) continue;
          const barrier = unit.originalTree
            ? crossesUnsafeBoundary(occurrence, unit.originalTree, byId)
            : "READ_OCCURRENCE_PREDICATE_TREE_UNAVAILABLE";
          forEachContext(occurrence, (builder, contextual) => {
            if (barrier) {
              addEvidence(builder, unit, contextual, "UNKNOWN", false, [
                barrier,
              ]);
              return;
            }
            if (unit.originalTree) builder.safeTrees.push(unit.originalTree);
            builder.relationPaths.push([...contextual.relationPath]);
            addEvidence(
              builder,
              unit,
              contextual,
              "CONSTRAINED",
              true,
              ["READ_OCCURRENCE_SETOP_BRANCH_DISTRIBUTED"],
              false,
            );
          });
        }
        continue;
      }
      const occurrences =
        unit.tables.length > 0
          ? reachable.occurrences.filter((candidate) =>
              unit.tables.includes(tableKey(candidate.read.table)),
            )
          : reachable.occurrences;
      for (const occurrence of occurrences) {
        forEachContext(occurrence, (builder, contextual) =>
          addEvidence(builder, unit, contextual, "UNKNOWN", false, []),
        );
      }
      continue;
    }
    if (candidates.targets.length === 0) {
      for (const occurrence of candidates.ambiguous) {
        forEachContext(occurrence, (builder, contextual) =>
          addEvidence(builder, unit, contextual, "UNKNOWN", false, [
            unit.tables.length > 1
              ? "READ_OCCURRENCE_CROSS_TABLE_PREDICATE_NOT_PUSHDOWN"
              : "READ_OCCURRENCE_BINDING_AMBIGUOUS",
          ]),
        );
      }
      continue;
    }
    for (const occurrence of reachable.occurrences) {
      const isTarget = candidates.targets.some(
        (candidate) =>
          candidate.read.id === occurrence.read.id &&
          pathKey(candidate.relationPath) === pathKey(occurrence.relationPath),
      );
      const barrier = unit.tree
        ? crossesUnsafeBoundary(occurrence, unit.tree, byId)
        : "READ_OCCURRENCE_PREDICATE_TREE_UNAVAILABLE";
      forEachContext(occurrence, (builder, contextual) => {
        if (!isTarget) {
          addEvidence(builder, unit, contextual, "IRRELEVANT", false, []);
          return;
        }
        if (barrier) {
          addEvidence(builder, unit, contextual, "UNKNOWN", false, [barrier]);
          return;
        }
        if (unit.tree) builder.safeTrees.push(unit.tree);
        builder.relationPaths.push([...contextual.relationPath]);
        addEvidence(builder, unit, contextual, "CONSTRAINED", true, []);
      });
    }
  }
}

function sourceRelations(
  plan: PlanFacts,
): readonly (FilterRelation | JoinRelation)[] {
  return plan.relations.filter(
    (relation): relation is FilterRelation | JoinRelation =>
      relation.type === "filter" || relation.type === "join",
  );
}

/**
 * Resolve every physical ReadRelation occurrence without deduplicating by
 * table name.  Relation paths and scope_bindings are the only traversal
 * authority; physical ColumnRef origins select a predicate's occurrence.
 */
export function resolveReadOccurrences(
  plan: PlanFacts,
): readonly ReadOccurrenceResolution[] {
  const byId = new Map(
    plan.relations.map((relation) => [relation.id, relation]),
  );
  const physicalReads = plan.relations.filter(
    (relation): relation is ReadRelation =>
      relation.type === "read" && relation.is_cte !== true,
  );
  const contexts = occurrenceContexts(plan, physicalReads, byId);
  const contextsByRead = new Map<string, ReadOccurrenceContext[]>();
  for (const context of contexts) {
    const current = contextsByRead.get(context.read.id) ?? [];
    current.push(context);
    contextsByRead.set(context.read.id, current);
  }
  const builders = new Map<string, OccurrenceBuilder>();
  for (const context of contexts)
    builders.set(context.occurrenceId, {
      occurrenceId: context.occurrenceId,
      read: context.read,
      binding: context.binding,
      relationPath: context.relationPath,
      safeTrees: [],
      evidence: [],
      reasonCodes: new Set<string>(),
      relationPaths: [],
      hasUnknownEvidence: false,
    });
  const bindings = new Map<
    string,
    readonly { target_relation_id: string | null }[]
  >();
  for (const binding of plan.scope_bindings ?? []) {
    const current = bindings.get(binding.relation_id) ?? [];
    bindings.set(binding.relation_id, [
      ...current,
      { target_relation_id: binding.target_relation_id },
    ]);
  }
  for (const relation of sourceRelations(plan))
    appendRelation(relation, byId, bindings, contextsByRead, builders);
  return [...builders.values()]
    .map((builder) => {
      const relationPaths = [...builder.relationPaths];
      const path = relationPaths.sort(
        (left, right) =>
          left.length - right.length || left.join().localeCompare(right.join()),
      )[0] ?? [...builder.relationPath];
      return {
        occurrenceId: builder.occurrenceId,
        readRelationId: builder.read.id,
        table: builder.read.table,
        binding: builder.binding,
        predicateTree: andTree(builder.safeTrees),
        predicateEvidence: builder.evidence,
        bindingStatus:
          builder.hasUnknownEvidence && builder.safeTrees.length === 0
            ? ("UNKNOWN" as const)
            : builder.safeTrees.length > 0
              ? ("CONSTRAINED" as const)
              : ("UNCONSTRAINED" as const),
        reasonCodes: uniqueSorted([...builder.reasonCodes]),
        relationPath: path,
      } satisfies ReadOccurrenceResolution;
    })
    .sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId));
}

/** Descriptive alias for callers that want the predicate-binding wording. */
export const resolveReadOccurrencePredicates = resolveReadOccurrences;
