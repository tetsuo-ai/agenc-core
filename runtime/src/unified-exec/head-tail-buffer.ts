export interface TruncatedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
}

export function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function maxCharsForTokens(maxOutputTokens: number | undefined): number {
  const tokens =
    typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)
      ? Math.max(1, Math.floor(maxOutputTokens))
      : 10_000;
  return tokens * 4;
}

export function truncateHeadTail(text: string, maxChars: number): TruncatedText {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }

  const safeMax = Math.max(64, maxChars);
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
