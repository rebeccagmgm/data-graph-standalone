import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { TableMetadata } from "./table-metadata.ts";

export interface TargetDdl {
  table: string;
  writeId?: string;
  status: "AVAILABLE" | "UNAVAILABLE" | "CHANGED";
  content?: string;
  collectedAt?: string;
  source?: string;
}
interface Binding {
  table?: unknown;
  writeId?: unknown;
  outputScope?: string;
  metadata?: Omit<TableMetadata, "metadataCatalog">;
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith("../") && !part.startsWith("..\\") && !isAbsolute(part);
}

/** Read only catalog-selected, hash-matched material; never accept a client file path. */
export function readTargetDdls(tablesRoot: string, bindings: readonly Binding[]): TargetDdl[] {
  const seen = new Set<string>();
  return bindings.filter(binding => binding.outputScope === "FINAL").flatMap(binding => {
    const metadata = binding.metadata;
    const identity = metadata?.identity;
    const table = identity?.qualifiedName || String(binding.table || "目标表未明确");
    const writeId = typeof binding.writeId === "string" ? binding.writeId : undefined;
    const key = JSON.stringify([writeId, identity, table]);
    if (seen.has(key)) return [];
    seen.add(key);
    const result: TargetDdl = { table, writeId, status: "UNAVAILABLE" };
    if (!identity?.platform || !identity.dataSource || !identity.qualifiedName || !identity.stableTableId ||
        metadata?.table.status !== "AVAILABLE" || !metadata.sourcePath || !metadata.ddlHash) return [result];
    try {
      const root = realpathSync(tablesRoot);
      const path = resolve(root, metadata.sourcePath, "ddl.sql");
      if (!inside(root, path)) return [result];
      const realPath = realpathSync(path);
      if (!inside(root, realPath) || statSync(realPath).size > 2 * 1024 * 1024) return [result];
      const bytes = readFileSync(realPath);
      if (createHash("sha256").update(bytes).digest("hex") !== metadata.ddlHash)
        return [{ ...result, status: "CHANGED" }];
      return [{ ...result, status: "AVAILABLE", content: bytes.toString("utf8"),
        source: "Table Input Pack", collectedAt: metadata.collectedAt }];
    } catch {
      return [result];
    }
  });
}
