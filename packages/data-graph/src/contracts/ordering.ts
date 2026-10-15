export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}
