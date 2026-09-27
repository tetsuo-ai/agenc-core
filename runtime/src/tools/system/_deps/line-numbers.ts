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
import { isEnvTruthy } from "../../../utils/envBoolean.js";

/**
 * Measurement switch: number only the first line of a read, every tenth line
 * and the last line. Line numbers are about 17% of FileRead tokens in the
 * coding-eval rollouts, and a reader counts from the nearest number. It is
 * read from the session environment when the session's tools are built.
 */
export const SPARSE_LINE_NUMBERS_ENV = "AGENC_SPARSE_LINE_NUMBERS";

export function sparseLineNumbersEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return isEnvTruthy(env[SPARSE_LINE_NUMBERS_ENV]);
}

export function addLineNumbers({
  content,
  // 1-indexed
  startLine,
  sparse = false,
}: {
  content: string;
  startLine: number;
  /** Number only the first line, every tenth line and the last line. */
  sparse?: boolean;
}): string {
  if (!content) {
    return "";
  }

  const lines = content.split(/\r?\n/);
  const last = lines.length - 1;
  return lines
    .map((line, index) => {
      const lineNumber = index + startLine;
      return !sparse || index === 0 || index === last || lineNumber % 10 === 0
        ? `${lineNumber}→${line}`
        : line;
    })
    .join("\n");
}
