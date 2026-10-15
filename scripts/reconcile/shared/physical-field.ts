export interface PhysicalFieldIdentity {
  readonly platform: string;
  readonly dataSource: string;
  readonly stableTableId: string;
  readonly qualifiedName: string;
  readonly column: string;
  readonly identityStatus: "SCHEMA_BACKED" | "TASK_LOCAL_SCHEMA_BACKED";
}

export function physicalFieldKey(field: PhysicalFieldIdentity): string {
  return [
    field.platform.trim().toLowerCase(),
    field.dataSource.trim().toLowerCase(),
    field.stableTableId.trim().toLowerCase(),
    field.qualifiedName.trim().toLowerCase(),
    field.column.trim().toLowerCase(),
  ].join("|");
}
