import type { TurnState } from "../session/turn-state.js";
import type { LLMMessage } from "../llm/types.js";

const runtimeCorrectionPrompts = new WeakSet<LLMMessage>();

/** This cap is turn-scoped, not reset by successful tools or other recovery. */
export const MAX_TEXT_TOOL_CALL_CORRECTIONS = 2;

export interface TextToolCallCorrection {
  readonly toolName: string;
  readonly reason: "invalid_arguments" | "not_advertised";
}

/** Persist only a small data identity, never model arguments or error prose. */
export function readTextToolCallCorrection(value: unknown): TextToolCallCorrection | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(key => key !== "toolName" && key !== "reason") ||
    typeof candidate.toolName !== "string" ||
    candidate.toolName.length > 256 ||
    !/^[A-Za-z0-9_.:-]+$/.test(candidate.toolName) ||
    (candidate.reason !== "invalid_arguments" && candidate.reason !== "not_advertised") ||
    (candidate.reason === "not_advertised" && !/^mcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/.test(candidate.toolName))
  ) return undefined;
  return { toolName: candidate.toolName, reason: candidate.reason };
}

export function textToolCallCorrectionPrompt(correction: TextToolCallCorrection): string {
  const name = JSON.stringify(correction.toolName);
  const failure = correction.reason === "not_advertised"
    ? `Your previous response attempted ${name}, which is not in this request's available tool catalog. No tool was executed. Use system.searchTools to discover that exact tool and follow the returned selection/loading instructions before calling it. Never invent or directly call an unavailable tool.`
    : `Your previous response attempted ${name}, but its arguments did not match the advertised schema. No tool was executed. Correct the arguments using the exact currently advertised tool schema, including all required fields. Use an actual tool call, not an explanation or JSON example.`;
  return `${failure} Existing permissions and user instructions still apply. If the tool cannot be used, explain the limitation plainly; do not claim that the action succeeded.`;
}

export function injectTextToolCallCorrection(state: TurnState): void {
  const correction = readTextToolCallCorrection(state.textToolCallCorrection);
  if (!correction) throw new Error("Missing validated tool-call correction checkpoint.");
  const prompt: LLMMessage = {
    role: "user",
    content: textToolCallCorrectionPrompt(correction),
    runtimeOnly: { excludeFromDurableHistory: true },
  };
  runtimeCorrectionPrompts.add(prompt);
  state.messages.push(prompt);
}

export function currentTextToolCallCorrectionPrompt(state: TurnState): LLMMessage | undefined {
  return state.messages.find(message => runtimeCorrectionPrompts.has(message));
}

/** Only the current pending sample needs this ephemeral prompt. Removing it
 * after that sample keeps later live and reconstructed checkpoint requests
 * identical, rather than accumulating invisible prompts across retries. */
export function clearTextToolCallCorrectionPrompt(state: TurnState, consumed: LLMMessage | undefined): number | undefined {
  if (!consumed || !runtimeCorrectionPrompts.has(consumed)) return undefined;
  const index = state.messages.indexOf(consumed);
  if (index < 0) return undefined;
  state.messages.splice(index, 1);
  return index;
}

/** Schedules a new normal admitted sample; never retries inside the provider. */
export function recoverRejectedTextToolCall(state: TurnState): void {
  if (!state.pendingTextToolCallCorrection) return;
  state.textToolCallCorrection = state.pendingTextToolCallCorrection;
  state.pendingTextToolCallCorrection = undefined;
  if (!Number.isSafeInteger(state.textToolCallCorrectionCount) || state.textToolCallCorrectionCount < 0 ||
      state.textToolCallCorrectionCount >= MAX_TEXT_TOOL_CALL_CORRECTIONS) {
    state.textToolCallCorrectionFailure = "The model repeatedly returned an invalid or unavailable tool call. No rejected call was executed. Tool-call correction is exhausted; the requested action did not complete.";
    state.transition = undefined;
    return;
  }
  state.textToolCallCorrectionCount += 1;
  injectTextToolCallCorrection(state);
  state.transition = { reason: "text_tool_call_correction" };
}
