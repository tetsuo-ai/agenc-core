/**
 * Lean token-counting helpers used by the recovery subsystem. Mirrors
 * the slice of `utils/tokens.ts` actually referenced by recovery code:
 * `finalContextTokensFromLastResponse(messages)`.
 *
 * Walks `messages` from the tail looking for the most recent usage
 * record. When the usage carries server-side tool-loop iterations,
 * returns `iterations.at(-1).input_tokens + output_tokens` (the
 * server's final-window measurement). Otherwise falls back to
 * top-level `input_tokens + output_tokens`. Both paths exclude cache
 * tokens to match the upstream formula.
 */

interface UsageLike {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly iterations?:
    | ReadonlyArray<{
        readonly input_tokens: number;
        readonly output_tokens: number;
      }>
    | null;
}

function getTokenUsage(message: unknown): UsageLike | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as { usage?: UsageLike; message?: { usage?: UsageLike } };
  return m.usage ?? m.message?.usage;
}

export function finalContextTokensFromLastResponse(
  messages: ReadonlyArray<unknown>,
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const usage = getTokenUsage(messages[i]);
    if (!usage) continue;
    const iterations = usage.iterations;
    if (iterations && iterations.length > 0) {
      const last = iterations[iterations.length - 1]!;
      return last.input_tokens + last.output_tokens;
    }
    const input = usage.input_tokens ?? usage.promptTokens ?? 0;
    const output = usage.output_tokens ?? usage.completionTokens ?? 0;
    return input + output;
  }
  return 0;
}
