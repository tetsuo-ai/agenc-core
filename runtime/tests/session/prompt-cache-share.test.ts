import { describe, expect, test } from "vitest";
import {
  EMPTY_PROMPT_CACHE_TALLY,
  addPromptCacheUsage,
  promptCacheSharePercent,
  type PromptCacheTally,
} from "../../src/session/prompt-cache-share.js";
import {
  appendSessionTranscriptBatchForTesting,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
  type SessionTranscriptEvent,
} from "../../src/tui/session-transcript.js";

type Call = Readonly<Record<string, unknown>>;

/** A `token_count` payload as stream-model emits it for one provider call. */
function call(provider: string, promptTokens: number, cachedInputTokens?: number, extra: Call = {}): Call {
  return {
    provider,
    model: "model",
    promptTokens,
    completionTokens: 10,
    totalTokens: promptTokens + 10,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...extra,
  };
}

function tally(...calls: readonly Call[]): PromptCacheTally {
  return calls.reduce(addPromptCacheUsage, EMPTY_PROMPT_CACHE_TALLY);
}

describe("prompt cache share", () => {
  test("is hidden until a call reports usage", () => {
    expect(promptCacheSharePercent(EMPTY_PROMPT_CACHE_TALLY)).toBeNull();
  });

  test("divides cached input by all input over the session", () => {
    // DeepSeek counts cache hits inside prompt_tokens: the first call misses,
    // the next two are served from cache.
    expect(promptCacheSharePercent(tally(
      call("deepseek", 1000, 0),
      call("deepseek", 1000, 1000),
      call("deepseek", 1000, 1000),
    ))).toBe(67);
  });

  test("counts cache reads that Anthropic reports outside input tokens", () => {
    // input_tokens 10, cache read 9000, cache write 500: 9,510 input tokens.
    const anthropic = call("anthropic", 10, 9000, {
      cacheCreationInputTokens: 500, completionTokens: 200, totalTokens: 9710,
    });
    expect(promptCacheSharePercent(tally(anthropic))).toBe(95);
    // Bedrock's total may leave cache tokens out; the input stays 9,510.
    const bedrock = call("amazon-bedrock", 10, 9000, {
      cacheCreationInputTokens: 500, completionTokens: 200, totalTokens: 210,
    });
    expect(promptCacheSharePercent(tally(bedrock))).toBe(95);
  });

  test("rounds to a whole percent and shows 100 only for a full hit", () => {
    expect(promptCacheSharePercent(tally(call("openai", 1000, 996)))).toBe(99);
    expect(promptCacheSharePercent(tally(call("openai", 1000, 995)))).toBe(99);
    expect(promptCacheSharePercent(tally(call("openai", 1000, 994)))).toBe(99);
    expect(promptCacheSharePercent(tally(call("openai", 1000, 985)))).toBe(99);
    expect(promptCacheSharePercent(tally(call("openai", 1000, 984)))).toBe(98);
    expect(promptCacheSharePercent(tally(call("openai", 1000, 1000)))).toBe(100);
    expect(promptCacheSharePercent(tally(call("openai", 1000, 4)))).toBe(0);
    expect(promptCacheSharePercent(tally(call("openai", 1000, 5)))).toBe(1);
  });

  test("shows 0% for a provider that reports a zero cached count", () => {
    expect(promptCacheSharePercent(tally(call("venice", 4000, 0)))).toBe(0);
  });

  test("is hidden for providers that never report cached tokens", () => {
    expect(promptCacheSharePercent(tally(call("groq", 4000), call("groq", 4000)))).toBeNull();
  });

  test("is hidden for local models even when the runtime reports reuse", () => {
    for (const provider of ["ollama", "lmstudio", "openai-compatible"]) {
      expect(promptCacheSharePercent(tally(call(provider, 4000, 3000))), provider).toBeNull();
    }
  });

  test("follows the provider of the latest call and counts only providers that report cache", () => {
    const deepseek = tally(call("deepseek", 1000, 0), call("deepseek", 1000, 1000));
    expect(promptCacheSharePercent(deepseek)).toBe(50);
    // A switch to a provider without cache counts hides the share...
    const afterGroq = addPromptCacheUsage(deepseek, call("groq", 8000));
    expect(promptCacheSharePercent(afterGroq)).toBeNull();
    // ...and its input does not dilute the share when DeepSeek is back.
    const back = addPromptCacheUsage(afterGroq, call("deepseek", 2000, 2000));
    expect(promptCacheSharePercent(back)).toBe(75);
    // Local calls never count either.
    expect(promptCacheSharePercent(tally(call("ollama", 9000, 9000), call("deepseek", 1000, 500)))).toBe(50);
  });

  test("keeps the session's provider when a call carries no provider metadata", () => {
    // MCP sampling reports usage without naming the provider.
    const { provider: _omitted, ...unnamed } = call("deepseek", 1000, 1000);
    const local = addPromptCacheUsage(tally(call("ollama", 1000, 0)), unnamed);
    expect(local.latestProvider).toBe("ollama");
    expect(promptCacheSharePercent(local)).toBeNull();
    const deepseek = addPromptCacheUsage(tally(call("deepseek", 1000, 0)), unnamed);
    expect(deepseek.latestProvider).toBe("deepseek");
    expect(promptCacheSharePercent(deepseek)).toBe(50);
  });

  test("normalizes provider metadata spellings", () => {
    expect(promptCacheSharePercent(tally(call("DeepSeek", 1000, 0), call("deepseek", 1000, 1000)))).toBe(50);
    expect(promptCacheSharePercent(tally(call("xai", 1000, 250)))).toBe(25);
  });

  test("returns a new tally and leaves the previous one unchanged", () => {
    const before = tally(call("deepseek", 1000, 0));
    const snapshot = structuredClone(before);
    const after = addPromptCacheUsage(before, call("deepseek", 1000, 1000));
    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
    expect(promptCacheSharePercent(before)).toBe(0);
    expect(promptCacheSharePercent(after)).toBe(50);
  });
});

describe("session transcript prompt cache tally", () => {
  function tokenCount(seq: number, payload: Call): SessionTranscriptEvent {
    return { id: `token-${seq}`, seq, type: "token_count", payload };
  }

  test("is cumulative for the session across eviction, clears and out-of-order batches", () => {
    let state = createSessionTranscriptStateForTesting([tokenCount(1, call("deepseek", 1000, 0))]);
    state = appendSessionTranscriptBatchForTesting(state, Array.from({ length: 4100 }, (_, index) => ({
      type: "warning", id: `padding-${index}`, seq: index + 2, payload: { message: "padding" },
    })));
    // The first call's event left the ring buffer; its tokens still count.
    expect(state.events.some((event) => "type" in event && event.type === "token_count")).toBe(false);
    state = appendSessionTranscriptEventForTesting(state, tokenCount(4102, call("deepseek", 1000, 1000)));
    expect(promptCacheSharePercent(state.promptCache)).toBe(50);
    state = appendSessionTranscriptBatchForTesting(state, [
      { type: "history_cleared", id: "clear", seq: 4103, payload: {} },
      tokenCount(4104, call("deepseek", 1000, 1000)),
      // Out of order: rebuilds the stored window, still counted once.
      tokenCount(3, call("deepseek", 1000, 1000)),
    ]);
    expect(promptCacheSharePercent(state.promptCache)).toBe(75);
    // A replayed event is not counted again.
    state = appendSessionTranscriptEventForTesting(state, tokenCount(4104, call("deepseek", 1000, 1000)));
    expect(promptCacheSharePercent(state.promptCache)).toBe(75);
  });

  test("reads the event-log shape and the phase-event shape alike", () => {
    const state = createSessionTranscriptStateForTesting([
      { type: "token_count", id: "a", seq: 1, payload: call("openai", 1000, 0) },
      { id: "b", msg: { type: "token_count", payload: call("openai", 1000, 1000) } },
    ]);
    expect(promptCacheSharePercent(state.promptCache)).toBe(50);
  });
});
