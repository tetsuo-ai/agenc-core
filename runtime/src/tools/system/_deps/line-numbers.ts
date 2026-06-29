/**
 * Compact `cat -n` style line-number prefixer used by the system filesystem
 * read tool.
 *
 * Mirrors the compatibility `addLineNumbers` helper from `src/utils/file.ts` but
 * stays within the lean tools surface so the system tools do not pull in
 * the compatibility `src/utils/file.ts` graph (feature-flag deps that
 * no longer exist in the gut runtime).
 *
 * The compact `N→` format is the standard format here — the killswitch
 * for the padded `     N->` form lived in the feature gate that
 * was removed alongside the rest of the compatibility tools.
 */
export function addLineNumbers({
  content,
  // 1-indexed
  startLine,
}: {
  content: string;
  startLine: number;
}): string {
  if (!content) {
    return "";
  }

  const lines = content.split(/\r?\n/);
  return lines
    .map((line, index) => `${index + startLine}→${line}`)
    .join("\n");
}
