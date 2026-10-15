import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { redact } from "./evidence.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const list = (value) => (Array.isArray(value) ? value : []);
const normal = (value) =>
  String(value ?? "")
    .replace(/[`"\[\]]/g, "")
    .toLowerCase();
const unavailable = (artifact, reason) => ({
  available: false,
  taskId: String(artifact?.task_id ?? ""),
  cacheKey: artifact?.cache_key ?? null,
  reason,
});

function positiveInteger(value, name, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum)
    throw new Error(`Invalid ${name}`);
  return number;
}

// The indexed byte hashes and cache key pin every click to the same local artifact.
function loadArtifact(artifact) {
  if (!artifact?.projection_path || !artifact?.evidence_path)
    return unavailable(artifact, "EVIDENCE_UNAVAILABLE");
  let projectionBytes, evidenceBytes;
  try {
    projectionBytes = readFileSync(artifact.projection_path);
    evidenceBytes = readFileSync(artifact.evidence_path);
  } catch {
    return unavailable(artifact, "ARTIFACT_UNREADABLE");
  }
  if (hash(projectionBytes) !== artifact.projection_hash)
    return unavailable(artifact, "PROJECTION_HASH_MISMATCH");
  if (hash(evidenceBytes) !== artifact.evidence_hash)
    return unavailable(artifact, "EVIDENCE_HASH_MISMATCH");
  let envelope, evidence;
  try {
    envelope = JSON.parse(projectionBytes.toString("utf8"));
    evidence = JSON.parse(evidenceBytes.toString("utf8"));
  } catch {
    return unavailable(artifact, "ARTIFACT_INVALID_JSON");
  }
  if (
    envelope.cacheKey !== artifact.cache_key ||
    basename(artifact.evidence_path) !==
      `${artifact.cache_key}.evidence-v3.json`
  )
    return unavailable(artifact, "CACHE_KEY_MISMATCH");
  if (
    String(envelope.projection?.taskId) !== String(artifact.task_id) ||
    String(evidence.taskId) !== String(artifact.task_id)
  )
    return unavailable(artifact, "TASK_ID_MISMATCH");
  const sources = list(evidence.sqlSources);
  if (
    sources.some(
      (source) =>
        typeof source.content !== "string" ||
        hash(source.content) !== source.sha256,
    )
  )
    return unavailable(artifact, "SQL_HASH_MISMATCH");
  if (new Set(sources.map((source) => source.slot)).size !== sources.length)
    return unavailable(artifact, "SQL_SLOT_AMBIGUOUS");
  return {
    available: true,
    projection: envelope.projection,
    evidence,
    sources,
    source: {
      kind: "FIXED_TASK_PROJECTION",
      taskId: String(artifact.task_id),
      cacheKey: artifact.cache_key,
      projectionSha256: artifact.projection_hash,
      evidenceSha256: artifact.evidence_hash,
      coverageStatus: artifact.coverage_status,
      generatedAt: artifact.generated_at,
    },
  };
}

/** Read a line slice from the SQL retained alongside the pinned projection. */
export function readTaskSql(
  artifact,
  { lineStart = 1, lineCount = 100, slot = "query" } = {},
) {
  const start = positiveInteger(lineStart, "lineStart", 1000000);
  const count = positiveInteger(lineCount, "lineCount", 300);
  const loaded = loadArtifact(artifact);
  if (!loaded.available) return loaded;
  const source = loaded.sources.find((item) => item.slot === slot);
  if (!source) return unavailable(artifact, "SQL_SLOT_UNAVAILABLE");
  const safe = redact(source.content),
    lines = safe.split(/\r?\n/);
  return {
    available: true,
    taskId: String(artifact.task_id),
    cacheKey: artifact.cache_key,
    slot,
    sql: lines.slice(start - 1, start - 1 + count).join("\n"),
    lineStart: start,
    lineCount: Math.max(0, Math.min(count, lines.length - start + 1)),
    totalLines: lines.length,
    nextLine: start - 1 + count < lines.length ? start + count : null,
    contentSha256: source.sha256,
    redacted: safe !== source.content,
    source: { ...loaded.source, slot, contentSha256: source.sha256 },
  };
}

function expressionSource(expression, sources) {
  const slot = /:slot:([^:]+):statement:/.exec(
    expression?.statement_id ?? "",
  )?.[1];
  const sql = sources.find((item) => item.slot === slot);
  const span = expression?.source_span;
  if (
    !sql ||
    !span ||
    !Number.isInteger(span.start) ||
    !Number.isInteger(span.end) ||
    span.start < 0 ||
    span.end < span.start ||
    span.end > sql.content.length
  )
    return {
      sqlSlot: sql?.slot ?? null,
      sourceStart: null,
      sourceEnd: null,
      sourceLine: null,
      sourceEndLine: null,
    };
  return {
    sqlSlot: sql.slot,
    sourceStart: span.start,
    sourceEnd: span.end,
    sourceLine: sql.content.slice(0, span.start).split("\n").length,
    sourceEndLine: sql.content.slice(0, span.end).split("\n").length,
  };
}

function definitionFor(table, definitions, outputCount) {
  return (
    definitions.find(
      (definition) => normal(definition.qualifiedName) === normal(table),
    ) ??
    (outputCount === 1
      ? definitions.find(
          (definition) =>
            !definition.qualifiedName?.includes(".") &&
            normal(definition.qualifiedName) ===
              normal(table).split(".").at(-1),
        )
      : null)
  );
}

/** Output fields are selected through write bindings, never by expression name alone. */
export function readTaskAnalysis(
  artifact,
  { outputTable, outputColumn, limit = 80 } = {},
) {
  const maxFields = positiveInteger(limit, "limit", 300);
  const loaded = loadArtifact(artifact);
  if (!loaded.available) return loaded;
  const { projection, evidence, sources } = loaded;
  const nodes = new Map(
    list(projection.nodes).map((node) => [node.nodeId, node]),
  );
  const expressions = new Map(
    list(evidence.expressions).map((expression) => [
      expression.expression_id,
      expression,
    ]),
  );
  const writes = list(projection.nodes).filter(
    (node) =>
      node.nodeType === "TARGET_WRITE" &&
      node.properties?.writeObservationId &&
      node.properties?.qualifiedName,
  );
  const definitions = sources
    .filter((source) => source.slot === "create")
    .map((source) => parseDefinition(source.content));
  let totalFields = 0,
    emittedFields = 0;
  const outputs = [];
  for (const write of writes) {
    const table = write.properties.qualifiedName,
      writeObservationId = write.properties.writeObservationId;
    if (outputTable && normal(outputTable) !== normal(table)) continue;
    const bindings = list(evidence.bindings)
      .filter(
        (binding) =>
          binding.write_observation_id === writeObservationId &&
          normal(binding.target_dataset) === normal(table) &&
          (!binding.task_id ||
            String(binding.task_id) === String(artifact.task_id)) &&
          (!outputColumn ||
            normal(binding.target_field) === normal(outputColumn)),
      )
      .sort((a, b) => (a.target_ordinal ?? 0) - (b.target_ordinal ?? 0));
    const definition = definitionFor(table, definitions, writes.length);
    const fields = [];
    for (const binding of bindings) {
      totalFields++;
      if (emittedFields >= maxFields) continue;
      emittedFields++;
      const expression = expressions.get(binding.expression_id);
      const direct = list(projection.edges).filter(
        (edge) =>
          edge.edgeType === "FIELD_DIRECT" &&
          edge.toNodeId === write.nodeId &&
          edge.properties?.bindingId === binding.binding_id,
      );
      const inputs = new Map();
      for (const input of list(expression?.input_fields)) {
        if (!input.table || !input.column) continue;
        inputs.set(`${normal(input.table)}\0${normal(input.column)}`, {
          table: input.table,
          column: input.column,
          status: expression?.input_dependency_status ?? "UNKNOWN",
        });
      }
      const occurrences = [],
        directFields = new Set();
      for (const edge of direct) {
        const properties = nodes.get(edge.fromNodeId)?.properties;
        if (!properties?.qualifiedName || !properties.column) continue;
        const key = `${normal(properties.qualifiedName)}\0${normal(properties.column)}`;
        directFields.add(key);
        occurrences.push({
          ...inputs.get(key),
          table: properties.qualifiedName,
          column: properties.column,
          status:
            inputs.get(key)?.status ?? properties.identityStatus ?? "UNKNOWN",
          subtype: edge.properties.subtype ?? "UNKNOWN",
          occurrenceStatus:
            edge.properties.sourceReadOccurrenceStatus ?? "UNKNOWN",
          readOccurrenceId: edge.properties.sourceReadOccurrenceId ?? null,
          occurrenceReason: edge.properties.sourceReadOccurrenceReason ?? null,
          edgeId: edge.edgeId ?? null,
        });
      }
      const column = definition?.fields.find(
        (field) => normal(field.name) === normal(binding.target_field),
      );
      fields.push({
        name: binding.target_field,
        ...(column ? { type: column.type, comment: column.comment } : {}),
        bindingId: binding.binding_id,
        bindingStatus: binding.binding_status ?? "UNKNOWN",
        provenance: binding.evidence_kind ?? "UNKNOWN",
        expressionId: binding.expression_id ?? null,
        text: redact(
          expression?.expression_text ?? expression?.display_text ?? "",
        ),
        inputStatus: expression?.input_dependency_status ?? "UNKNOWN",
        inputs: [...inputs.entries()]
          .filter(([key]) => !directFields.has(key))
          .map(([, value]) => value)
          .concat(occurrences),
        unresolvedColumns: list(expression?.unresolved_input_columns),
        ...expressionSource(expression, sources),
      });
    }
    const controls = list(projection.edges).filter(
      (edge) =>
        edge.edgeType === "DATASET_CONTROL" && edge.toNodeId === write.nodeId,
    );
    const provenance = [
      ...new Set(bindings.map((binding) => binding.evidence_kind ?? "UNKNOWN")),
    ];
    outputs.push({
      table,
      writeObservationId,
      provenance:
        provenance.length === 1
          ? provenance[0]
          : provenance.length
            ? "MIXED"
            : "UNKNOWN",
      provenances: provenance,
      ...(evidence.packTarget &&
      normal(evidence.packTarget.qualifiedName) === normal(table)
        ? {
            partition: evidence.packPartition ?? null,
            partitionProvenance: "INPUT_PACK_CONFIGURATION",
          }
        : {}),
      fields,
      totalFields: bindings.length,
      controls: controls.slice(0, maxFields).map((edge) => {
        const properties = nodes.get(edge.fromNodeId)?.properties ?? {};
        return {
          scope: "DATASET",
          subtype: edge.properties?.subtype ?? "UNKNOWN",
          table: properties.qualifiedName ?? null,
          column: properties.column ?? null,
          relationId: edge.properties?.relationId ?? null,
          controlSide: edge.properties?.controlSide ?? "UNKNOWN",
          grain: edge.properties?.grain ?? "UNKNOWN",
        };
      }),
      controlsTruncated: controls.length > maxFields,
    });
  }
  return {
    available: true,
    taskId: String(artifact.task_id),
    cacheKey: artifact.cache_key,
    outputs,
    totalFields,
    truncated: totalFields > emittedFields,
    source: loaded.source,
    boundary:
      "字段按写入绑定关联；控制条件独立展示；静态证据不代表运行或业务验证。",
  };
}

// Small DDL lexer: quoted literals and nested type delimiters stay intact.
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    const start = i,
      quote = sql[i];
    if (["'", '"', "`", "["].includes(quote)) {
      const closing = quote === "[" ? "]" : quote;
      let value = "",
        closed = false;
      i++;
      while (i < sql.length) {
        if (sql[i] === closing) {
          if (sql[i + 1] === closing) {
            value += closing;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (sql[i] === "\\" && i + 1 < sql.length) {
          value += sql[i + 1];
          i += 2;
        } else value += sql[i++];
      }
      if (!closed) return null;
      tokens.push({
        value,
        kind: quote === "'" ? "string" : "identifier",
        start,
        end: i,
      });
    } else if (/[A-Za-z_\u0080-\uFFFF]/.test(sql[i])) {
      i++;
      while (i < sql.length && /[\w$\u0080-\uFFFF]/.test(sql[i])) i++;
      tokens.push({ value: sql.slice(start, i), kind: "word", start, end: i });
    } else {
      tokens.push({ value: sql[i++], kind: "symbol", start, end: i });
    }
  }
  return tokens;
}
const keyword = (token, value) =>
  token?.kind === "word" && token.value.toUpperCase() === value;
const identifier = (token) => ["word", "identifier"].includes(token?.kind);

function columnList(tokens, start, sql) {
  if (tokens[start]?.value !== "(") return null;
  let depth = 0,
    angle = 0,
    segmentStart = start + 1;
  const segments = [];
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "symbol") continue;
    if (token.value === "(") depth++;
    if (token.value === "<") angle++;
    if (token.value === ">") angle--;
    if (token.value === ")") {
      if (depth === 0) {
        if (segmentStart < i) segments.push(tokens.slice(segmentStart, i));
        return {
          fields: segments
            .map((segment) => parseColumn(segment, sql))
            .filter(Boolean),
          next: i + 1,
        };
      }
      depth--;
    }
    if (token.value === "," && depth === 0 && angle === 0) {
      segments.push(tokens.slice(segmentStart, i));
      segmentStart = i + 1;
    }
  }
  return null;
}

function parseColumn(tokens, sql) {
  if (
    !identifier(tokens[0]) ||
    !identifier(tokens[1]) ||
    ["CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK"].some((word) =>
      keyword(tokens[0], word),
    )
  )
    return null;
  let end = tokens.length,
    depth = 0,
    angle = 0,
    comment = "";
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      depth === 0 &&
      angle === 0 &&
      [
        "COMMENT",
        "NOT",
        "NULL",
        "DEFAULT",
        "PRIMARY",
        "REFERENCES",
        "CONSTRAINT",
        "UNIQUE",
        "CHECK",
        "GENERATED",
        "ENCODE",
      ].some((word) => keyword(token, word))
    ) {
      end = Math.min(end, i);
      if (keyword(token, "COMMENT") && tokens[i + 1]?.kind === "string")
        comment = tokens[i + 1].value;
    }
    if (token.kind !== "symbol") continue;
    if (token.value === "(") depth++;
    if (token.value === ")") depth--;
    if (token.value === "<") angle++;
    if (token.value === ">") angle--;
  }
  if (end <= 1) return null;
  return {
    name: tokens[0].value,
    type: redact(sql.slice(tokens[1].start, tokens[end - 1].end).trim()),
    comment: redact(comment),
  };
}

/** Extract explicit CREATE TABLE columns only; CTAS and view columns remain unknown. */
export function parseDefinition(input) {
  const sql = String(input ?? ""),
    tokens = tokenize(sql);
  const unknown = {
    objectType: "UNKNOWN",
    fields: [],
    description: "",
    parseStatus: "UNSUPPORTED",
  };
  if (!tokens) return { ...unknown, parseStatus: "INVALID" };
  let cursor = tokens.findIndex((token) => keyword(token, "CREATE"));
  if (cursor < 0) return unknown;
  cursor++;
  if (keyword(tokens[cursor], "OR") && keyword(tokens[cursor + 1], "REPLACE"))
    cursor += 2;
  while (
    ["EXTERNAL", "TEMP", "TEMPORARY", "MATERIALIZED"].some((word) =>
      keyword(tokens[cursor], word),
    )
  )
    cursor++;
  const objectType = keyword(tokens[cursor], "TABLE")
    ? "TABLE"
    : keyword(tokens[cursor], "VIEW")
      ? "VIEW"
      : "UNKNOWN";
  if (objectType === "UNKNOWN") return unknown;
  cursor++;
  if (
    keyword(tokens[cursor], "IF") &&
    keyword(tokens[cursor + 1], "NOT") &&
    keyword(tokens[cursor + 2], "EXISTS")
  )
    cursor += 3;
  if (!identifier(tokens[cursor]))
    return { ...unknown, objectType, parseStatus: "INVALID" };
  const names = [tokens[cursor++].value];
  while (tokens[cursor]?.value === "." && identifier(tokens[cursor + 1])) {
    names.push(tokens[cursor + 1].value);
    cursor += 2;
  }
  const result = { ...unknown, objectType, qualifiedName: names.join(".") };
  if (objectType !== "TABLE" || tokens[cursor]?.value !== "(") return result;
  const columns = columnList(tokens, cursor, sql);
  if (!columns) return { ...result, parseStatus: "INVALID" };
  const fields = [...columns.fields];
  cursor = columns.next;
  let description = "";
  for (let i = cursor; i < tokens.length && tokens[i].value !== ";"; i++) {
    if (keyword(tokens[i], "COMMENT")) {
      const next = tokens[i + 1]?.value === "=" ? tokens[i + 2] : tokens[i + 1];
      if (next?.kind === "string" && !description) description = next.value;
    }
    if (keyword(tokens[i], "PARTITIONED") && keyword(tokens[i + 1], "BY")) {
      const partition = columnList(tokens, i + 2, sql);
      if (!partition) return { ...result, parseStatus: "INVALID" };
      fields.push(
        ...partition.fields.map((field) => ({ ...field, partition: true })),
      );
      i = partition.next - 1;
    }
  }
  return {
    ...result,
    fields: fields.map((field, ordinal) => ({ ...field, ordinal })),
    description: redact(description),
    parseStatus: "PARSED",
  };
}
