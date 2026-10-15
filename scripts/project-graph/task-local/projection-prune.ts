import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export type ProjectionReference = {
  taskId: string;
  cacheKey: string;
};

export function projectionVersionPrefix(cacheKey: string, fileName: string): boolean {
  return fileName === `${cacheKey}.json`
    || fileName === `${cacheKey}.evidence-v2.json`
    || fileName === `${cacheKey}.evidence-v3.json`
    || fileName === `${cacheKey}.evidence-v4.json`
    || fileName === `${cacheKey}.evidence.json`;
}

function isProjectionVersionArtifact(fileName: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\.evidence(?:-v[234])?)?\.json$/.test(fileName);
}

export function pruneTaskProjectionVersions(
  projectionRoot: string,
  taskId: string,
  cacheKey: string,
  protectedCacheKeys: ReadonlySet<string> = new Set(),
): { removedVersionFiles: string[] } {
  const versionsDir = join(resolve(projectionRoot), "tasks", taskId, "versions");
  if (!existsSync(versionsDir)) return { removedVersionFiles: [] };

  const removedVersionFiles: string[] = [];
  for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !isProjectionVersionArtifact(entry.name) ||
      projectionVersionPrefix(cacheKey, entry.name) ||
      [...protectedCacheKeys].some((key) => projectionVersionPrefix(key, entry.name))
    )
      continue;
    const path = join(versionsDir, entry.name);
    rmSync(path, { force: true });
    removedVersionFiles.push(entry.name);
  }
  return { removedVersionFiles };
}

function readCurrentProjectionCacheKey(
  projectionRoot: string,
  taskId: string,
): string | null {
  const path = join(resolve(projectionRoot), "tasks", taskId, "task-local-projection.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { cacheKey?: unknown };
    return typeof parsed.cacheKey === "string" && parsed.cacheKey ? parsed.cacheKey : null;
  } catch {
    return null;
  }
}

export function pruneAllTaskProjectionVersions(
  projectionRoot: string,
  references: readonly ProjectionReference[] = [],
): {
  prunedTasks: number;
  removedVersionFiles: number;
} {
  const tasksRoot = join(resolve(projectionRoot), "tasks");
  if (!existsSync(tasksRoot)) return { prunedTasks: 0, removedVersionFiles: 0 };

  let prunedTasks = 0;
  let removedVersionFiles = 0;
  const protectedByTask = new Map<string, Set<string>>();
  for (const reference of references) {
    const keys = protectedByTask.get(reference.taskId) ?? new Set<string>();
    keys.add(reference.cacheKey);
    protectedByTask.set(reference.taskId, keys);
  }
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cacheKey = readCurrentProjectionCacheKey(projectionRoot, entry.name);
    if (!cacheKey) continue;
    const result = pruneTaskProjectionVersions(
      projectionRoot,
      entry.name,
      cacheKey,
      protectedByTask.get(entry.name),
    );
    if (result.removedVersionFiles.length === 0) continue;
    prunedTasks++;
    removedVersionFiles += result.removedVersionFiles.length;
  }
  return { prunedTasks, removedVersionFiles };
}

/** Read immutable batch manifests referenced by every active graph profile. */
export function readActiveProjectionReferences(
  graphRoot: string,
): ProjectionReference[] | null {
  const references = new Map<string, ProjectionReference>();
  if (!existsSync(graphRoot)) return [];
  for (const profile of readdirSync(graphRoot, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue;
    for (const pointerName of ["current.json", "prepared.json"]) {
      const pointerPath = join(graphRoot, profile.name, pointerName);
      if (!existsSync(pointerPath)) continue;
      try {
        const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as {
          manifestPath?: unknown;
        };
        if (
          typeof pointer.manifestPath !== "string" ||
          !existsSync(pointer.manifestPath)
        )
          return null;
        const manifest = JSON.parse(readFileSync(pointer.manifestPath, "utf8")) as {
          tasks?: { taskId?: unknown; cacheKey?: unknown }[];
        };
        for (const task of manifest.tasks ?? [])
          if (typeof task.taskId === "string" && typeof task.cacheKey === "string")
            references.set(`${task.taskId}|${task.cacheKey}`, {
              taskId: task.taskId,
              cacheKey: task.cacheKey,
            });
      } catch {
        // A malformed pointer is not proof that its artifacts are disposable.
        return null;
      }
    }
  }
  return [...references.values()];
}

export function pruneTaskProjectionVersionsFromEnvelopePath(
  projectionRoot: string,
  envelopePath: string,
): { removedVersionFiles: string[] } {
  const envelope = JSON.parse(readFileSync(envelopePath, "utf8")) as {
    cacheKey?: string;
    cacheKeyParts?: { taskId?: string };
  };
  const taskId = envelope.cacheKeyParts?.taskId;
  const cacheKey = envelope.cacheKey;
  if (!taskId || !cacheKey) return { removedVersionFiles: [] };
  return pruneTaskProjectionVersions(projectionRoot, taskId, cacheKey);
}
