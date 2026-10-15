/**
 * Compatibility boundary for existing graph consumers. Metadata now comes
 * exclusively from the rebuildable SQLite catalog; no request-time Input Pack
 * scan or DDL parse remains here.
 */
export {
  defaultTableMetadataCatalogRoot,
  TableMetadataCatalog as TableMetadataResolver,
  TABLE_METADATA_CATALOG_SCHEMA_VERSION,
} from "./table-metadata-catalog.ts";
export type {
  CatalogField,
  MetadataCatalogState,
  MetadataIdentity,
  MetadataSearchIdentity,
  MetadataStatus,
  MetadataValue,
  TableMetadata,
} from "./table-metadata-catalog.ts";
