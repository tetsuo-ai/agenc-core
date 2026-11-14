import { describe, expect, it } from "vitest";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { buildPrompt } from "src/session/run-turn.js";
import type { TurnContext, ModelInfo } from "src/session/turn-context.js";

/**
 * Revert-sensitive regression test for gap-hunt #3 finding #35 on
 * `session/run-turn.ts`.
 *
 * #35 buildPrompt must NOT hard-default unknown models to serial tool calls.
 *     When the catalog omits supportsParallelToolCalls it infers from the
 *     PROVIDER FAMILY for known-parallel providers (anthropic/openai) while
 *     leaving genuinely-unknown support unset.
 *
 * (Finding #36 — making the time-based microcompact retention window live —
 * was reverted: enabling it preserves every result within clearAfterMs, which
 * defeats microcompact's context-bounding during rapid tool bursts and
 * violates the runtime-session.compact-contract behavior. Left as a deliberate
 * follow-up.)
 */

function turnContextWith(params: {
  readonly supportsParallelToolCalls?: boolean;
  readonly modelProviderId?: string;
}): TurnContext {
  const modelInfo = {
    slug: "test-model",
    effectiveContextWindowPercent: 100,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
    ...(params.supportsParallelToolCalls !== undefined
      ? { supportsParallelToolCalls: params.supportsParallelToolCalls }
      : {}),
  } as unknown as ModelInfo;
  return {
    modelInfo,
    modelProviderId: params.modelProviderId,
    dynamicTools: [],
  } as unknown as TurnContext;
}

describe("gaphunt3 #35 — buildPrompt provider-aware parallelToolCalls", () => {
  it("infers parallel=true for a known-parallel provider when the catalog flag is unset", () => {
    // Catalog silent (supportsParallelToolCalls undefined) + anthropic family:
    // before the fix this was `?? false` and forced serial tool calls.
    const promptAnthropic = buildPrompt(
      [{ role: "user", content: "read three files" }],
      [],
      turnContextWith({ modelProviderId: "anthropic" }),
      "base",
    );
    expect(promptAnthropic.parallelToolCalls).toBe(true);

    const promptOpenAI = buildPrompt(
      [{ role: "user", content: "read three files" }],
      [],
      turnContextWith({ modelProviderId: "openai" }),
      "base",
    );
    expect(promptOpenAI.parallelToolCalls).toBe(true);
  });

  it("omits the parallel policy when provider support is unknown", () => {
    // Let the provider choose its default when support is unknown.
    const prompt = buildPrompt(
      [{ role: "user", content: "hi" }],
      [],
      turnContextWith({ modelProviderId: "some-custom-endpoint" }),
      "base",
    );
    expect(prompt.parallelToolCalls).toBeUndefined();
    expect(buildChatCompletionsRequest({ model: "test-model", messages: prompt.input,
      tools: prompt.tools, options: { parallelToolCalls: prompt.parallelToolCalls },
    })).not.toHaveProperty("parallel_tool_calls");
  });

  it("respects an explicit catalog flag over the provider heuristic", () => {
    // Explicit false must win even for a known-parallel family.
    const forcedOff = buildPrompt(
      [{ role: "user", content: "hi" }],
      [],
      turnContextWith({
        modelProviderId: "anthropic",
        supportsParallelToolCalls: false,
      }),
      "base",
    );
    expect(forcedOff.parallelToolCalls).toBe(false);
    expect(buildChatCompletionsRequest({ model: "test-model", messages: forcedOff.input,
      tools: forcedOff.tools, options: { parallelToolCalls: forcedOff.parallelToolCalls },
    })).toHaveProperty("parallel_tool_calls", false);

    // Explicit true must win even for an unknown family.
    const forcedOn = buildPrompt(
      [{ role: "user", content: "hi" }],
      [],
      turnContextWith({
        modelProviderId: "some-custom-endpoint",
        supportsParallelToolCalls: true,
      }),
      "base",
    );
    expect(forcedOn.parallelToolCalls).toBe(true);
  });
});
