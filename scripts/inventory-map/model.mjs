import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SCHEMA_VERSION = 1;
export const UNKNOWN_TOPIC = "__unknown";
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function textValue(value) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

export function taskId(value) {
  const id = textValue(value);
  return TASK_ID.test(id) ? id : null;
}

export function regionId(topic) {
  return `topic:${textValue(topic) || UNKNOWN_TOPIC}`;
}

/** Rules classify this reading view; they do not infer SQL processing semantics. */
export function loadRules(path) {
  const rules = JSON.parse(readFileSync(path, "utf8"));
  if (
    rules.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(rules.stages) ||
    rules.stages.length === 0
  ) {
    throw new Error("INVALID_MAP_RULES: schemaVersion/stages");
  }
  const ids = new Set();
  for (const stage of rules.stages) {
    if (
      !taskId(stage.id) ||
      !textValue(stage.label) ||
      !Number.isFinite(stage.order) ||
      !/^#[0-9a-f]{6}$/iu.test(stage.color ?? "") ||
      ids.has(stage.id)
    ) {
      throw new Error("INVALID_MAP_RULES: stage definition");
    }
    ids.add(stage.id);
  }
  if (!ids.has(rules.defaultStageId) || !Array.isArray(rules.topicRules)) {
    throw new Error("INVALID_MAP_RULES: defaultStageId/topicRules");
  }
  const compiled = rules.topicRules.map((rule) => {
    if (
      !ids.has(rule.stageId) ||
      (typeof rule.exact === "string") === (typeof rule.regex === "string")
    ) {
      throw new Error(
        "INVALID_MAP_RULES: each topic rule needs exact or regex and a valid stageId",
      );
    }
    return {
      ...rule,
      pattern: rule.regex === undefined ? null : new RegExp(rule.regex, "iu"),
    };
  });
  const hardLimits = {
    maxNodes: 150,
    maxEdges: 400,
    maxDepth: 4,
    maxPageSize: 100,
  };
  const limits = { ...hardLimits, ...rules.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      hardLimits[key] === undefined ||
      value > hardLimits[key]
    ) {
      throw new Error(`INVALID_MAP_RULES: limits.${key}`);
    }
  }
  return {
    document: rules,
    hash: sha256(canonicalJson(rules)),
    stages: [...rules.stages].sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
    ),
    limits,
    classify(topic) {
      const normalized = textValue(topic);
      return (
        compiled.find((rule) =>
          rule.pattern
            ? rule.pattern.test(normalized)
            : rule.exact === normalized,
        )?.stageId ?? rules.defaultStageId
      );
    },
  };
}

export function parseRelation(row) {
  const currentId = taskId(row.task_id);
  const direction = row.direction;
  if (
    !currentId ||
    !["up", "down"].includes(direction) ||
    row.depth !== 1 ||
    row.evidence_type !== `horae-relation-${direction}-depth-1`
  )
    return null;
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray(payload.rows)
  )
    return null;
  const reportedId = payload.task_id ?? payload.taskId;
  if (reportedId !== undefined && taskId(reportedId) !== currentId) return null;
  if (payload.direction !== undefined && payload.direction !== direction)
    return null;
  if (payload.depth !== undefined && payload.depth !== 1) return null;
  return { currentId, direction, rows: payload.rows };
}
