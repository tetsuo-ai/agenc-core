/**
 * Local _deps stub for the gut/openclaude crossing of
 * `../utils/tokenBudget.js`. Only the message helper is consumed by the
 * llm token-budget code; full parser stayed in the openclaude port.
 */

export function getBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  const fmt = (n: number): string =>
    new Intl.NumberFormat("en-US").format(n);
  return `Stopped at ${pct}% of token target (${fmt(turnTokens)} / ${fmt(budget)}). Keep working — do not summarize.`;
}
