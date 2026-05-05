/**
 * Compact prompt formatting.
 *
 * Source snapshot: `src/services/compact/prompt.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

export function stripAnalysisTags(text: string): string {
  return text.replace(/<analysis>[\s\S]*?<\/analysis>/gu, "").trim();
}

export function formatCompactSummary(summary: string): string {
  return `<summary>\n${stripAnalysisTags(summary)}\n</summary>`;
}
