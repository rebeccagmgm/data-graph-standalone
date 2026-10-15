import { provePath } from './path-witness.mjs';

export function proveCopyPath(frozen, targetField) {
  const result = provePath(frozen, targetField, { copyOnly: true });
  if (result.status === 'PROVEN_WITHIN_SCOPE' && result.paths.length !== 1)
    return { ...result, status: 'NOT_EVALUABLE', reason: 'COPY_PATH_NOT_UNIQUE', paths: [] };
  return { ...result, path: result.paths[0] ?? null };
}
