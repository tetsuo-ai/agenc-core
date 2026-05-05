/**
 * Runtime dependency helpers for the compact service.
 *
 * Source snapshot: `src/services/compact/*` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 *
 * The dependency boundary deliberately stays strict-safe: no imports from
 * `runtime/src/agenc/**`, `runtime/src/tui/**`, attachments, or
 * session-memory implementation modules.
 */

import {
  roughTokenCountEstimationForMessages,
  type TokenizerProviderHint,
} from "../../../llm/token-estimation.js";
import type { CompactContext, RuntimeMessage } from "../types.js";

export function estimateMessagesTokens(
  messages: readonly RuntimeMessage[],
  context?: CompactContext,
): number {
  return roughTokenCountEstimationForMessages(messages, providerHint(context));
}

export function messageText(message: RuntimeMessage): string {
  return stringifyContent(message.message?.content ?? message.content ?? "");
}

export function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return JSON.stringify(part);
    }).join("\n");
  }
  return JSON.stringify(content ?? "");
}

export function positiveInteger(value: string | undefined): number | undefined {
  const parsed = positiveNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

export function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function providerHint(context: CompactContext | undefined): TokenizerProviderHint {
  return {
    provider: context?.provider?.name,
    model: context?.options?.mainLoopModel,
  };
}
