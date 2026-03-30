/** Human-readable label for a version row (0-based index). */
export function versionLabel(index: number, total: number): string {
  if (total <= 0) return 'Version';
  if (index === total - 1) return 'Latest';
  return `Version ${index + 1}`;
}
