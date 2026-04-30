/**
 * Neutral session shims used by code that still has lifecycle hooks around
 * compaction boundaries. AgenC owns the real compaction state; this file
 * only keeps unrelated session modules from importing the removed AgenC tree.
 */

let lastSummarizedMessageId: string | undefined;

export function notifyCompaction(
  _querySource?: unknown,
  _agentId?: unknown,
): void {
  // Prompt-cache break detection is owned by the AgenC API service.
}

export function setLastSummarizedMessageId(value: string | undefined): void {
  lastSummarizedMessageId = value;
}

export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId;
}
