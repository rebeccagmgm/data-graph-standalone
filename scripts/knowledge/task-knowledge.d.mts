/** Public shape validated by task-knowledge.mjs at the JSON boundary. */
export interface KnowledgeObservation {
  kind: "expression" | "relation";
  id: string;
  label: string;
}

export interface TaskKnowledge {
  schemaVersion: 1;
  taskId: string;
  title: string;
  summary: string;
  boundary: string;
  tags: { topics: string[]; duties: string[] };
  review: { origin: "agent_curated"; status: "sql_reviewed_business_unconfirmed" };
  evidence: {
    path: string;
    slot: "query";
    querySha256: string;
    kind?: "published_evidence" | "retained_excerpt";
  };
  observations: KnowledgeObservation[];
  knowledgeId: string;
  knowledgeRevision: string;
  source: string;
  markdown: string;
  evidenceCheck: { status: "not_checked" };
}

export interface VerifiedKnowledgeObservation extends KnowledgeObservation {
  text: string;
  sourceSpan: { start: number; end: number };
  startLine: number;
  endLine: number;
}

export type VerifiedTaskKnowledge = Omit<TaskKnowledge, "observations" | "evidenceCheck"> & {
  observations: VerifiedKnowledgeObservation[];
  evidenceCheck: {
    status: "matched";
    sqlSha256: string;
    sourceKind: "published_evidence" | "retained_excerpt";
  };
};

export function resolveKnowledgeDataRoot(configPath?: string): Promise<string>;
export function loadTaskKnowledge(taskId: string, options?: { root?: string }): Promise<TaskKnowledge>;
export function verifyTaskKnowledge(record: TaskKnowledge | VerifiedTaskKnowledge, options?: { root?: string }): Promise<VerifiedTaskKnowledge>;
