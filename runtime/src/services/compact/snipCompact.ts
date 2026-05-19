/**
 * Snip compact conservative surface.
 *
 * Source snapshot: `src/services/compact/snipCompact.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

import type { RuntimeMessage } from "./types.js";
import { estimateMessagesTokens } from "./_deps/runtime.js";

export function snipCompact(
  messages: readonly RuntimeMessage[],
  options: {
    readonly targetTokenCount?: number;
    readonly keepPrefixCount?: number;
    readonly keepSuffixCount?: number;
  } = {},
): { readonly messages: readonly RuntimeMessage[]; readonly tokensFreed: number } {
  const before = estimateMessagesTokens(messages);
  const targetTokenCount = options.targetTokenCount;
  if (
    targetTokenCount === undefined ||
    before <= targetTokenCount ||
    messages.length <= 2
  ) {
    return { messages, tokensFreed: 0 };
  }

  const keepPrefixCount = Math.max(1, options.keepPrefixCount ?? 1);
  const keepSuffixCount = Math.max(1, options.keepSuffixCount ?? 4);
  const prefix = messages.slice(0, keepPrefixCount);
  const suffixStart = Math.max(keepPrefixCount, messages.length - keepSuffixCount);
  const compacted = [
    ...prefix,
    {
      role: "user" as const,
      type: "user",
      isMeta: true,
      content: "[Earlier conversation snipped before compaction]",
      message: {
        role: "user",
        content: "[Earlier conversation snipped before compaction]",
      },
    },
    ...messages.slice(suffixStart),
  ];
  const after = estimateMessagesTokens(compacted);
  return {
    messages: compacted,
    tokensFreed: Math.max(0, before - after),
  };
}
