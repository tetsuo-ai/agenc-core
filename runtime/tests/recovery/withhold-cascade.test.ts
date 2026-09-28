import { describe, expect, test } from "vitest";

import { LLMContextWindowExceededError } from "../../src/llm/errors.js";
import { isRecoverableContextOverflowStreamError } from "../../src/recovery/api-errors.js";
import {
  evaluateWithholdCascade,
  markContextCollapseAttempted,
  resetContextCollapseAttempted,
} from "../../src/recovery/withhold-cascading.js";
import type { AssistantMessage, TurnState } from "../../src/session/turn-state.js";

function overflow(): LLMContextWindowExceededError {
  return new LLMContextWindowExceededError(
    "deepseek",
    "This model's maximum context length is 1048576 tokens.",
  );
}

function state(toolUseBlocks: TurnState["toolUseBlocks"] = []): TurnState {
  return { toolUseBlocks } as TurnState;
}

function withheld413(): AssistantMessage {
  return {
    uuid: "assistant-413",
    role: "assistant",
    text: "",
    toolCalls: [],
    apiError: "context_window_exceeded",
  };
}

describe("isRecoverableContextOverflowStreamError", () => {
  test("matches a typed overflow before any tool call streams", () => {
    expect(isRecoverableContextOverflowStreamError(state(), overflow())).toBe(
      true,
    );
  });

  test("rejects a partial response or a streamed tool call", () => {
    const partial = Object.assign(overflow(), {
      response: { finishReason: "error", partial: true },
    });
    expect(isRecoverableContextOverflowStreamError(state(), partial)).toBe(
      false,
    );
    expect(
      isRecoverableContextOverflowStreamError(
        state([{ type: "tool_use", id: "tc-1", name: "Write", input: {} }]),
        overflow(),
      ),
    ).toBe(false);
  });

  test("rejects an untyped error", () => {
    expect(
      isRecoverableContextOverflowStreamError(state(), new Error("too long")),
    ).toBe(false);
    expect(isRecoverableContextOverflowStreamError(state(), undefined)).toBe(
      false,
    );
  });
});

describe("evaluateWithholdCascade", () => {
  test("routes the first withheld 413 to collapse drain", () => {
    expect(evaluateWithholdCascade(state(), withheld413())).toEqual({
      kind: "route_to_collapse_drain",
      reason: "413_first_attempt",
    });
  });

  test("routes a typed overflow stream error the same way when no message exists", () => {
    expect(evaluateWithholdCascade(state(), undefined, overflow())).toEqual({
      kind: "route_to_collapse_drain",
      reason: "413_first_attempt",
    });
  });

  test("surfaces 413 after collapse already ran", () => {
    const turn = state();
    markContextCollapseAttempted(turn);
    expect(evaluateWithholdCascade(turn, withheld413())).toEqual({
      kind: "not_withheld",
      reason: "413_after_collapse_drain",
    });
    resetContextCollapseAttempted(turn);
    expect(evaluateWithholdCascade(turn, withheld413())).toEqual({
      kind: "route_to_collapse_drain",
      reason: "413_first_attempt",
    });
  });

  test("fails closed without a withheld 413 or recoverable overflow", () => {
    expect(evaluateWithholdCascade(state(), undefined)).toEqual({
      kind: "not_withheld",
      reason: "no_last_message",
    });
    expect(
      evaluateWithholdCascade(state(), {
        uuid: "assistant-ok",
        role: "assistant",
        text: "ok",
        toolCalls: [],
      }),
    ).toEqual({
      kind: "not_withheld",
      reason: "not_withheld_413",
    });
  });
});
