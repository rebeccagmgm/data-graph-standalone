const compareSourceSchemas = (left, right) =>
  right.tasks - left.tasks || left.schema.localeCompare(right.schema);

const compareTaskIds = (left, right) =>
  String(left).localeCompare(String(right), "en", { numeric: true });

/**
 * Produces a bounded, source-topic view from the already-published table
 * relation snapshot. It deliberately does not infer object types, fields, or
 * business tags: those require scoped metadata and knowledge evidence.
 */
export function buildSourceTopicAnalysis({ definition, flows, schemas }) {
  const sourceSchemaPrefix = definition?.sourceSchemaPrefix;
  const targetSchema = definition?.targetSchema;
  if (!sourceSchemaPrefix || !targetSchema)
    throw new Error("Source-topic definition needs a schema prefix and target schema");

  const schemaByName = new Map(schemas.map((schema) => [schema.schema, schema]));
  const ingress = flows
    .filter(
      (flow) =>
        flow.to === targetSchema && flow.from.startsWith(sourceSchemaPrefix),
    )
    .map((flow) => {
      const summary = schemaByName.get(flow.from);
      if (!summary)
        throw new Error(`Missing schema summary for source topic member: ${flow.from}`);
      return {
        schema: flow.from,
        tasks: flow.tasks,
        taskIds: [...flow.taskIds].sort(compareTaskIds),
        tables: summary.tables,
      };
    })
    .sort(compareSourceSchemas);

  const uniqueIngressTaskIds = [
    ...new Set(ingress.flatMap((schema) => schema.taskIds)),
  ].sort(compareTaskIds);
  return {
    id: definition.id,
    title: definition.title,
    targetSchema,
    sourceSchemaPrefix,
    sourceSchemas: ingress,
    tableIdentities: ingress.reduce((total, schema) => total + schema.tables, 0),
    directionTaskCount: ingress.reduce((total, schema) => total + schema.tasks, 0),
    uniqueIngressTaskIds,
  };
}
