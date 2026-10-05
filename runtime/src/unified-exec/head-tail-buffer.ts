export interface TruncatedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
}

/**
 * The most one exec result carries, whatever max_output_tokens asks for: the
 * 25,000-token cap FileRead and MCP results have.
 */
const OUTPUT_TOKENS_CEILING = 25_000;

export function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The char budget of one exec result, stdout and stderr together:
 * max_output_tokens (10,000 when unset, at most OUTPUT_TOKENS_CEILING) at
 * 4 chars per token.
 */
export function maxCharsForTokens(maxOutputTokens: number | undefined): number {
  const tokens =
    typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)
      ? Math.min(
          OUTPUT_TOKENS_CEILING,
          Math.max(1, Math.floor(maxOutputTokens)),
        )
      : 10_000;
  return tokens * 4;
}

/**
 * Truncates texts that share one budget of `maxChars`, each keeping its own
 * head, tail and omitted-chars marker. The budget is split with max-min
 * fairness: the shortest text is served first and takes at most an equal
 * share of what is left, and a share it does not use passes on to the longer
 * texts. A proportional split would starve a tiny stderr exit-summary when
 * stdout floods; this keeps the short text whole and truncates only the texts
 * that need it.
 */
export function truncateHeadTailTogether(
  texts: readonly string[],
  maxChars: number,
): TruncatedText[] {
  const budgets: number[] = [];
  const shortestFirst = texts
    .map((_, index) => index)
    .sort((left, right) => texts[left].length - texts[right].length);
  let remainingChars = maxChars;
  let remainingTexts = shortestFirst.length;
  for (const index of shortestFirst) {
    const share = Math.floor(remainingChars / remainingTexts);
    budgets[index] = Math.min(texts[index].length, share);
    remainingChars -= budgets[index];
    remainingTexts -= 1;
  }
  return texts.map((text, index) => truncateHeadTail(text, budgets[index]));
}

function truncateHeadTail(text: string, maxChars: number): TruncatedText {
  // Never truncates below 64 chars: a text that short stays whole instead of
  // being cut around a marker that would report a negative omitted count.
  const safeMax = Math.max(64, maxChars);
  if (text.length <= safeMax) {
    return { text, truncated: false, originalChars: text.length };
  }

  const marker = `\n[... omitted ${text.length - safeMax} chars ...]\n`;
  const available = Math.max(1, safeMax - marker.length);
  const headChars = Math.ceil(available * 0.55);
  const tailChars = Math.max(1, available - headChars);

  return {
    text: `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`,
    truncated: true,
    originalChars: text.length,
  };
}
