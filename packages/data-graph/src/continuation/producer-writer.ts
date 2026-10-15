import type { TaskLocalFinalWrite } from "./task-local-projection.ts";

export interface ProducerIndexWriter {
  readonly taskId: string;
  /** Stable write-observation identity when the producer index carries it. */
  readonly writeObservationId?: string;
  readonly datasetNodeId?: string;
  readonly qualifiedName?: string;
  readonly outputQualification?: TaskLocalFinalWrite["outputQualification"];
  readonly partition?: readonly {
    readonly mayBeNull?: boolean;
    readonly alternatives?: readonly import("../../../../scripts/project-graph/task-local/partition-alternatives.ts").PartitionAlternative[];
    readonly column: string;
    readonly values: readonly string[];
    readonly partitionStatus?: string;
    readonly valueStatus?: string;
    readonly observedValue?: string | null;
    readonly expression?: string;
  }[];
}
