import {partitionOptions, type PartitionSelection} from "../../data-graph/src/asset-graph/partition-selection";
import type {GraphNode} from "./types";
export function partitionFields(fields: GraphNode[], selection?: PartitionSelection) {
  if (!selection) return fields;
  return fields.filter(field => {
    const [option] = partitionOptions([{taskId: field.taskId ?? "", writeId: field.writeId ?? "", targetId: "", datasetId: selection.datasetId, partition: Array.isArray(field.detail?.partition) ? field.detail.partition : []}]);
    return option && selection.optionIds.includes(option.id);
  });
}
