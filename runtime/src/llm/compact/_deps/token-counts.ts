/**
 * Lean token-counting helpers compact uses. Mirrors the upstream
 * `services/tokenEstimation.ts` + `utils/tokens.ts` API surfaces with
 * a char/4 rough estimator — good enough for compaction thresholding
 * and shrink-ratio assertions.
 */

const CHARS_PER_TOKEN = 4;

interface UsageLike {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
}

interface MessageLike {
  readonly content?: unknown;
  readonly message?: { readonly usage?: UsageLike; readonly content?: unknown };
  readonly usage?: UsageLike;
  readonly type?: string;
}

function contentToText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if ("text" in part && typeof (part as { text?: unknown }).text === "string") {
            return (part as { text: string }).text;
          }
          if ("content" in part) return contentToText((part as { content: unknown }).content);
        }
        return "";
      })
      .join("");
  }
  if (typeof content === "object" && content !== null) {
    if ("text" in content && typeof (content as { text?: unknown }).text === "string") {
      return (content as { text: string }).text;
    }
  }
  return "";
}

export function roughTokenCountEstimation(text: string | unknown): number {
  const str = typeof text === "string" ? text : contentToText(text);
  if (!str) return 0;
  return Math.ceil(str.length / CHARS_PER_TOKEN);
}

export function roughTokenCountEstimationForMessages(
  messages: ReadonlyArray<MessageLike>,
): number {
  let total = 0;
  for (const m of messages) {
    const content = m.content ?? m.message?.content;
    total += roughTokenCountEstimation(content);
  }
  return total;
}

export function getTokenUsage(message: MessageLike): UsageLike | undefined {
  return message.usage ?? message.message?.usage;
}

export function tokenCountFromLastAPIResponse(
  messages: ReadonlyArray<MessageLike>,
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const usage = getTokenUsage(messages[i]!);
    if (!usage) continue;
    if (typeof usage.totalTokens === "number") return usage.totalTokens;
    const input = usage.input_tokens ?? usage.promptTokens ?? 0;
    const output = usage.output_tokens ?? usage.completionTokens ?? 0;
    const cacheCreate = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const total = input + output + cacheCreate + cacheRead;
    if (total > 0) return total;
  }
  return 0;
}

export function tokenCountWithEstimation(
  messages: ReadonlyArray<MessageLike>,
): number {
  const fromAPI = tokenCountFromLastAPIResponse(messages);
  if (fromAPI > 0) return fromAPI;
  return roughTokenCountEstimationForMessages(messages);
}
