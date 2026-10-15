import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type GraphArtifactPointer = {
  version: string;
  manifestPath: string;
};

export function batchHashFromManifestPath(manifestPath: string): string {
  return basename(dirname(manifestPath));
}

export function pruneGraphArtifactHistory(
  graphOutputRoot: string,
  current: GraphArtifactPointer,
  references: readonly GraphArtifactPointer[] = [],
): {
  removedPublished: string[];
  removedBatches: string[];
  removedLegacy: string[];
} {
  const protectedPointers = [current, ...references];
  const keepVersions = new Set(
    protectedPointers.map((pointer) => pointer.version),
  );
  const keepBatches = new Set(
    protectedPointers.map((pointer) =>
      batchHashFromManifestPath(pointer.manifestPath),
    ),
  );
  const removedPublished: string[] = [];
  const removedBatches: string[] = [];
  const removedLegacy: string[] = [];

  const publishedRoot = join(graphOutputRoot, "published");
  if (existsSync(publishedRoot)) {
    for (const name of readdirSync(publishedRoot, { withFileTypes: true })) {
      if (!name.isDirectory() || keepVersions.has(name.name)) continue;
      rmSync(join(publishedRoot, name.name), { recursive: true, force: true });
      removedPublished.push(name.name);
    }
  }

  const batchesRoot = join(graphOutputRoot, "batches");
  if (existsSync(batchesRoot)) {
    for (const name of readdirSync(batchesRoot, { withFileTypes: true })) {
      if (!name.isDirectory() || keepBatches.has(name.name)) continue;
      rmSync(join(batchesRoot, name.name), { recursive: true, force: true });
      removedBatches.push(name.name);
    }
  }

  const legacyUnionContinuation = join(graphOutputRoot, "union-continuation");
  if (existsSync(legacyUnionContinuation)) {
    rmSync(legacyUnionContinuation, { recursive: true, force: true });
    removedLegacy.push("union-continuation");
  }

  return { removedPublished, removedBatches, removedLegacy };
}
