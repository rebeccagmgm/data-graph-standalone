type JsonRecord = Record<string, unknown>;

export interface TaskDefaultSchema {
  readonly schema: string;
  readonly evidenceSources: readonly ("TASK_NAME" | "TASK_TARGET")[];
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? null : trimmed;
}

function normalizeQualifiedName(value: string): string {
  return value.replaceAll("`", "").replaceAll('"', "").trim().toLowerCase();
}

function schemaFromQualifiedName(value: unknown): string | null {
  const normalized = stringValue(value);
  if (!normalized) return null;
  const parts = normalizeQualifiedName(normalized).split(".");
  if (parts.length < 2 || parts.some((part) => part === "")) return null;
  return parts.slice(0, -1).join(".");
}

/**
 * The Task Pack's qualified task name is the scheduler-side default-schema
 * evidence. A qualified task target may corroborate it, but a conflicting target makes
 * the default ambiguous and therefore unusable for binding bare SQL names.
 */
/** True when a SQL table token still carries `${…}` placeholders. */
export function isSqlTemplateTableReference(value: string): boolean {
  const normalized = normalizeQualifiedName(value);
  return normalized.includes("${") || normalized.includes("}");
}

/** Lexical bare Hive identifier; excludes templates and punctuation. */
export function isBareHiveTableIdentifier(value: string): boolean {
  const normalized = normalizeQualifiedName(value);
  return /^[a-z_][a-z0-9_$]*$/iu.test(normalized);
}

export function inferTaskDefaultSchema(
  task: unknown,
): TaskDefaultSchema | null {
  const taskRecord = asRecord(task);
  if (!taskRecord) return null;
  const taskNameSchema = schemaFromQualifiedName(taskRecord.taskName);
  if (!taskNameSchema) return null;

  const target = asRecord(taskRecord.target);
  const targetSchema = schemaFromQualifiedName(
    target ? target.qualifiedName : taskRecord.target,
  );
  if (targetSchema && targetSchema !== taskNameSchema) return null;

  return {
    schema: taskNameSchema,
    evidenceSources: targetSchema
      ? ["TASK_NAME", "TASK_TARGET"]
      : ["TASK_NAME"],
  };
}

export function qualifyBareTableName(
  qualifiedName: string,
  defaultSchema: TaskDefaultSchema | null,
): string {
  const normalized = normalizeQualifiedName(qualifiedName);
  if (
    normalized.includes(".") ||
    !defaultSchema ||
    isSqlTemplateTableReference(normalized) ||
    !isBareHiveTableIdentifier(normalized)
  )
    return normalized;
  return `${defaultSchema.schema}.${normalized}`;
}
