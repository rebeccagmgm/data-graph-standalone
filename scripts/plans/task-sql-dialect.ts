export type TaskSqlDialect = "databricks" | "duckdb";

/** Select the parser profile from the task's source-side SQL family. */
export function taskSqlDialect(taskCategory: string): TaskSqlDialect {
  const category = taskCategory.trim().toLowerCase();
  return (category.startsWith("oracle2") || category.startsWith("postgre"))
    ? "duckdb"
    : "databricks";
}
