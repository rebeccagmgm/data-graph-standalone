import type { ReadPartitionScope } from "../../../../../evidence/sql-read-scope.ts";
import type { ProducerTableIdentity } from "../../../../../reconcile/producer/producer-index.ts";
import type { WriterCatalogPort } from "../../../../../query/writer-catalog.ts";
import type { HoraeScheduleRelationLookup } from "../schedule-preference.ts";

export type ReadScopeLookupResult =
  | { readonly kind: "OK"; readonly scope: ReadPartitionScope }
  | {
    readonly kind: "UNAVAILABLE";
    readonly reasonCode: "READ_SCOPE_UNAVAILABLE" | "SOURCE_ENDPOINT_BOUNDARY";
  };

export interface ContinuationPorts {
  readonly scheduleLookup: HoraeScheduleRelationLookup | null;
  readonly writerCatalog: WriterCatalogPort | null;
  readonly taskCategoryFor: (consumerTaskId: string) => string | null;
  readonly readScopeFor: (input: {
    readonly consumerTaskId: string;
    readonly readOccurrenceId: string;
    readonly qualifiedName: string;
  }) => ReadScopeLookupResult;
  readonly tableIdentityFor: (input: {
    readonly consumerTaskId: string;
    readonly qualifiedName: string;
  }) => ProducerTableIdentity;
}
