import {
  subtreeContains,
  type RelationTreeIndex,
} from "../../../../project-graph/task-local/field-evidence/relation-tree.ts";

export type ControlScope = "FIELD_SCOPED" | "DATASET_SCOPED" | "SCOPE_DISJOINT";

export interface ControlScopeInput {
  readonly relationTree: RelationTreeIndex;
  readonly valueSourceRelationId: string | null;
  readonly controlRelationId: string;
  readonly controlSubtype: string;
  readonly joinType: string;
  readonly leftRelationId: string | null;
  readonly rightRelationId: string | null;
}

function setopBranchId(
  index: RelationTreeIndex,
  relationId: string,
): string | null {
  for (const relation of index.relations.values()) {
    if (relation.relationType !== "setop") continue;
    for (const branchId of relation.setopBranches) {
      if (subtreeContains(index, branchId, relationId)) return branchId;
    }
  }
  return null;
}

function provablyDifferentSetopBranches(
  index: RelationTreeIndex,
  leftRelationId: string,
  rightRelationId: string,
): boolean {
  const leftBranch = setopBranchId(index, leftRelationId);
  const rightBranch = setopBranchId(index, rightRelationId);
  if (!leftBranch || !rightBranch) return false;
  return leftBranch !== rightBranch;
}

export function computeControlScope(input: ControlScopeInput): ControlScope {
  const valueRelationId = input.valueSourceRelationId;
  if (!valueRelationId) return "DATASET_SCOPED";

  if (
    provablyDifferentSetopBranches(
      input.relationTree,
      input.controlRelationId,
      valueRelationId,
    )
  ) {
    return "SCOPE_DISJOINT";
  }

  const subtype = input.controlSubtype.toUpperCase();
  if (subtype === "FILTER" || subtype === "GROUP_BY") {
    return "DATASET_SCOPED";
  }

  if (subtype !== "JOIN") return "DATASET_SCOPED";

  const joinType = input.joinType.toUpperCase();
  if (joinType === "INNER" || joinType === "N/A") {
    return "DATASET_SCOPED";
  }

  const leftId = input.leftRelationId;
  const rightId = input.rightRelationId;
  if (!leftId || !rightId) return "DATASET_SCOPED";

  const inLeft = subtreeContains(input.relationTree, leftId, valueRelationId);
  const inRight = subtreeContains(input.relationTree, rightId, valueRelationId);

  if (joinType === "LEFT") {
    if (inRight && !inLeft) return "FIELD_SCOPED";
    if (inLeft && !inRight) return "DATASET_SCOPED";
  } else if (joinType === "RIGHT") {
    if (inLeft && !inRight) return "FIELD_SCOPED";
    if (inRight && !inLeft) return "DATASET_SCOPED";
  } else if (joinType === "FULL") {
    if ((inRight && !inLeft) || (inLeft && !inRight)) return "FIELD_SCOPED";
  }

  return "DATASET_SCOPED";
}
