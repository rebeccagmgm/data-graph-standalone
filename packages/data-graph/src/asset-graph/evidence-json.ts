import { readFileSync } from "node:fs";

type JsonRecord = Record<string, unknown>;

export interface PublishedTask {
  taskId: string;
  path: string;
  evidencePath: string;
  cacheKey: string;
  contentHash: string;
  coverageStatus: string;
  taskCategory: string;
  taskName: string | null;
  failureReasonCode: string | null;
}

export interface PreparedManifest {
  tasks: PublishedTask[];
  taskIds: string[];
  summary: Record<string, number>;
  generatedAt: string;
}

export interface Evidence {
  bindings: JsonRecord[];
  statements: JsonRecord[];
  datasetIo: JsonRecord[];
  expressions: JsonRecord[];
  relations: JsonRecord[];
  materializations?: JsonRecord[];
  packPartition: Record<string, unknown> | null;
  packTarget: unknown;
  sqlSources: { slot: string; content: string; sha256: string }[];
}

export const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8"));
