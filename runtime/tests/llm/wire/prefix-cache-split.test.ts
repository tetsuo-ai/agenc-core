/**
 * Task 5: prefix-cache split for the OpenAI/xAI wires.
 *
 * Both providers cache on the leading bytes of the request (OpenAI:
 * "place static content at the beginning and variable content at the
 * end"; xAI: "never modify earlier messages — only append"). The
 * volatile tail of the assembled system prompt (timestamp, git state)
 * previously sat at the FRONT of every request, so the prefix diverged
 * every turn and the growing conversation was never served from cache.
 *
 * These tests pin the split: across two consecutive turns the
 * serialized prefix (instructions/static system + earlier messages) is
 * byte-identical, with dynamic content only in the final item.
 */
import { describe, expect, it } from "vitest";

import {
  splitSystemPromptOnDynamicBoundary,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER,
} from "./shared.js";
import { buildOpenAIResponsesRequest } from "./responses-openai.js";
import { GrokProvider } from "../providers/grok/adapter.js";
import type { LLMMessage } from "../types.js";

const STATIC_HEAD = "You are AgenC. Follow the project instructions.";

function promptAt(timestamp: string): string {
  return `${STATIC_HEAD}\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\nNow: ${timestamp}\nBranch: main`;
}

type BuildParamsAccess = {
  buildParams: (
    messages: readonly LLMMessage[],
    options?: Record<string, unknown>,
  ) => { params: Record<string, unknown> };
};

describe("splitSystemPromptOnDynamicBoundary", () => {
  it("splits on the marker", () => {
    const { staticPrefix, dynamicSuffix } = splitSystemPromptOnDynamicBoundary(
      promptAt("2026-07-07T00:00:00Z"),
    );
    expect(staticPrefix).toBe(STATIC_HEAD);
    expect(dynamicSuffix).toBe("Now: 2026-07-07T00:00:00Z\nBranch: main");
  });

  it("treats a marker-less prompt as fully static", () => {
    expect(splitSystemPromptOnDynamicBoundary("plain prompt")).toEqual({
      staticPrefix: "plain prompt",
    });
    expect(splitSystemPromptOnDynamicBoundary(undefined)).toEqual({});
    expect(splitSystemPromptOnDynamicBoundary("   ")).toEqual({});
  });
});

describe("OpenAI Responses wire keeps the request prefix stable across turns", () => {
  function requestFor(turnMessages: LLMMessage[], timestamp: string) {
    return buildOpenAIResponsesRequest({
      model: "gpt-test",
      messages: turnMessages,
      tools: [],
      options: { systemPrompt: promptAt(timestamp) },
    });
  }

  it("instructions carry only the static head; dynamic content is the final input item", () => {
    const turn1: LLMMessage[] = [{ role: "user", content: "first" }];
    const turn2: LLMMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ];
    const request1 = requestFor(turn1, "T1");
    const request2 = requestFor(turn2, "T2");

    expect(request1.instructions).toBe(STATIC_HEAD);
    // Byte-identical across turns despite different timestamps.
    expect(request2.instructions).toBe(request1.instructions);

    const input1 = request1.input as Array<Record<string, unknown>>;
    const input2 = request2.input as Array<Record<string, unknown>>;
    const last1 = input1.at(-1);
    const last2 = input2.at(-1);
    expect(last1).toEqual({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "Now: T1\nBranch: main" }],
    });
    expect(JSON.stringify(last2)).toContain("Now: T2");

    // The serialized prefix (everything before the dynamic tail) of
    // turn 2 begins with turn 1's serialized prefix.
    const prefix1 = JSON.stringify(input1.slice(0, -1));
    const prefix2 = JSON.stringify(input2.slice(0, -1));
    expect(
      prefix2.startsWith(prefix1.slice(0, prefix1.length - 1)),
    ).toBe(true);
  });
});

describe("grok adapter keeps the request prefix stable across turns", () => {
  function paramsFor(turnMessages: LLMMessage[], timestamp: string) {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
    });
    return (provider as unknown as BuildParamsAccess).buildParams(
      turnMessages,
      { systemPrompt: promptAt(timestamp) },
    ).params;
  }

  it("static system leads, dynamic tail is the final input item", () => {
    const turn1: LLMMessage[] = [{ role: "user", content: "first" }];
    const turn2: LLMMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ];
    const input1 = paramsFor(turn1, "T1").input as Array<
      Record<string, unknown>
    >;
    const input2 = paramsFor(turn2, "T2").input as Array<
      Record<string, unknown>
    >;

    // First item: the static head only — byte-identical across turns.
    expect(JSON.stringify(input1[0])).toContain(STATIC_HEAD);
    expect(JSON.stringify(input1[0])).not.toContain("Now: T1");
    expect(JSON.stringify(input2[0])).toBe(JSON.stringify(input1[0]));

    // Last item: the dynamic tail (per-turn).
    expect(JSON.stringify(input1.at(-1))).toContain("Now: T1");
    expect(JSON.stringify(input2.at(-1))).toContain("Now: T2");
    expect(JSON.stringify(input2.at(-1))).not.toContain(STATIC_HEAD);

    // Turn 2's serialized prefix extends turn 1's.
    const prefix1 = JSON.stringify(input1.slice(0, -1));
    const prefix2 = JSON.stringify(input2.slice(0, -1));
    expect(
      prefix2.startsWith(prefix1.slice(0, prefix1.length - 1)),
    ).toBe(true);
  });

  it("marker-less prompts keep the legacy single leading system message", () => {
    const input = paramsFor(
      [{ role: "user", content: "hello" }],
      "unused",
    );
    const legacyProvider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4.3",
    });
    const legacy = (legacyProvider as unknown as BuildParamsAccess).buildParams(
      [{ role: "user", content: "hello" }],
      { systemPrompt: "plain prompt with no marker" },
    ).params.input as Array<Record<string, unknown>>;
    expect(JSON.stringify(legacy[0])).toContain("plain prompt with no marker");
    expect(JSON.stringify(legacy.at(-1))).toContain("hello");
    void input;
  });
});
