import type { RuntimeMessage } from "../../services/compact/types.js";
import { compactConversation } from "../../services/compact/compact.js";

export async function contextUsageCall(
  _args: string,
  context: {
    readonly messages?: RuntimeMessage[];
    readonly options?: {
      readonly contextWindowTokens?: number;
    };
  },
): Promise<{ readonly value: string }> {
  const messages = context.messages ?? [];
  const used = roughRuntimeTokenCount(messages);
  const window = context.options?.contextWindowTokens ?? 0;
  const percent = window > 0
    ? Math.min(100, Math.round((used / window) * 100))
    : 0;
  return {
    value: window > 0
      ? `Context: ${used.toLocaleString()} / ${window.toLocaleString()} tokens (${percent}%)`
      : `Context: ${used.toLocaleString()} estimated tokens`,
  };
}

export async function applyToolResultBudget(
  messages: RuntimeMessage[],
): Promise<{
  readonly messages: RuntimeMessage[];
  readonly newlyReplaced: readonly unknown[];
}> {
  return { messages, newlyReplaced: [] };
}

export async function applyCollapsesIfNeeded(
  messages: RuntimeMessage[],
): Promise<{ readonly messages: RuntimeMessage[]; readonly committed: number }> {
  return { messages, committed: 0 };
}

export async function recoverFromOverflow(
  messages: RuntimeMessage[],
): Promise<{ readonly messages: RuntimeMessage[]; readonly committed: number }> {
  if (messages.length < 4) return { messages, committed: 0 };
  const keepCount = Math.min(3, messages.length);
  const compacted = await compactConversation(
    messages,
    {},
    "Recover from a prompt-too-long provider response.",
  );
  return {
    messages: [
      compacted.boundaryMarker,
      ...compacted.summaryMessages,
      ...messages.slice(-keepCount),
    ],
    committed: 1,
  };
}

function roughRuntimeTokenCount(messages: readonly RuntimeMessage[]): number {
  return Math.ceil(
    messages.reduce(
      (total, message) => total + messageText(message).length,
      0,
    ) / 4,
  );
}

function messageText(message: RuntimeMessage): string {
  const content = message.message?.content ?? message.content ?? "";
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
}
