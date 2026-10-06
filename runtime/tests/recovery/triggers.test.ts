import { describe, expect, test } from "vitest";
import {
  buildDefaultTriggerOrder,
  I10_TRIGGER_ORDER,
  type TriggerActions,
  type TriggerOutcome,
} from "./triggers.js";
import { buildInitialTurnState, type ToolUseBlock } from "../session/turn-state.js";
import { mkCtx } from "../../tests/fixtures.js";
import { LLMContextWindowExceededError, LLMProviderError } from "../llm/errors.js";
import type { Session } from "../session/session.js";

const NOOP_ACTIONS: TriggerActions = {
  async on413(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  async onMedia(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  async onMaxOutputTokens(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  async onStopHookBlocking(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  async onStreamingFallback(): Promise<TriggerOutcome> { return { kind: "pass" }; },
  async onFallbackError(): Promise<TriggerOutcome> { return { kind: "pass" }; },
};

describe("I-10 recovery trigger priority", () => {
  test("buildDefaultTriggerOrder matches documented I10_TRIGGER_ORDER array", () => {
    const triggers = buildDefaultTriggerOrder(NOOP_ACTIONS);
    expect(triggers.map((t) => t.name)).toEqual([...I10_TRIGGER_ORDER]);
  });

  test("exact I-10 priority list", () => {
    expect([...I10_TRIGGER_ORDER]).toEqual([
      "isWithheld413",
      "isWithheldMedia",
      "isWithheldMaxOutputTokens",
      "stopHookBlocking",
      "streamingFallbackOccured",
      "FallbackTriggeredError",
    ]);
  });
});

// Terminal-Bench 4.0, 2026-09-14: DeepSeek refused a 672k-token prompt plus a 384k output reservation as too long for
// its 1M window. The refusal reached the turn as a typed stream error, no trigger read it, and the turn failed instead
// of taking the bounded 413 collapse.
describe("context overflow thrown as a stream error", () => {
  const overflow = () => new LLMContextWindowExceededError(
    "deepseek",
    "This model's maximum context length is 1048576 tokens. However, you requested 1056296 tokens (672296 in the messages, 384000 in the completion).",
  );
  const firstMatch = (streamError: unknown, toolUseBlocks: ToolUseBlock[] = []) => {
    const state = buildInitialTurnState(mkCtx(), { role: "user", content: "go" });
    state.toolUseBlocks = toolUseBlocks;
    const ctx = { session: {} as Session, state, lastMessage: undefined, streamError };
    return buildDefaultTriggerOrder(NOOP_ACTIONS).find((trigger) => trigger.match(ctx))?.name;
  };

  test("a typed overflow before any tool call matches the 413 trigger", () => {
    expect(firstMatch(overflow())).toBe("isWithheld413");
  });

  test("a typed overflow after a tool call streamed matches no trigger", () => {
    expect(firstMatch(overflow(), [{ type: "tool_use", id: "tc-streamed", name: "Write", input: {} }]))
      .toBeUndefined();
  });

  test("a typed overflow carrying a partial response matches no trigger", () => {
    const partial = Object.assign(overflow(), { response: { finishReason: "error", partial: true } });
    expect(firstMatch(partial)).toBeUndefined();
  });

  test("an untyped provider error that only mentions the context length matches no trigger", () => {
    expect(firstMatch(new LLMProviderError("deepseek", "maximum context length exceeded", 400))).toBeUndefined();
  });
});
