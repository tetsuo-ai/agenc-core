import { describe, expect, it } from "vitest";
import {
  analyzeSessionHistoryRequirements,
  clearResponsesContinuationResponseId,
  prepareResponsesContinuationRequest,
  recordResponsesContinuationResponse,
  resetResponsesContinuationState,
  validateHistoryCompatibility,
} from "./shape-request.js";
import type { ProviderModelCapabilities } from "./capabilities.js";

describe("analyzeSessionHistoryRequirements", () => {
  it("detects image, audio, and thinking requirements recursively, and no effort requirement", () => {
    const requirements = analyzeSessionHistoryRequirements({
      history: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "input_image", image_url: "file:///tmp/image.png" },
          ],
        },
        {
          role: "tool",
          content: {
            type: "audio_url",
            audio_url: { url: "file:///tmp/audio.wav" },
          },
        },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              summary: [
                { type: "text", text: "hidden reasoning" },
              ],
            },
          ],
        },
      ],
      sessionConfiguration: {
        collaborationMode: {
          reasoningEffort: "high",
        },
      },
    });

    // A switch keeps or drops the session's effort instead of refusing over it
    // (session/reasoning-effort-for-model.ts), so it is not a requirement.
    expect(requirements).toEqual({
      hasImageHistory: true,
      hasAudioHistory: true,
      hasThinkingHistory: true,
    });
  });
});

describe("validateHistoryCompatibility", () => {
  it("reports each missing capability explicitly", () => {
    const caps: ProviderModelCapabilities = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      acceptsImageHistory: false,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: true,
    };

    const result = validateHistoryCompatibility(caps, {
      hasImageHistory: true,
      hasAudioHistory: false,
      hasThinkingHistory: true,
    });

    expect(result.compatible).toBe(false);
    expect(result.missingCapabilities).toEqual([
      "image history",
      "thinking history",
    ]);
    expect(result.reason).toMatch(/anthropic \/ claude-sonnet-4-5/);
  });

  it("returns compatible when the provider can satisfy the current session requirements", () => {
    const caps: ProviderModelCapabilities = {
      provider: "openai",
      model: "gpt-5",
      acceptsImageHistory: true,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: true,
    };

    expect(
      validateHistoryCompatibility(caps, {
        hasImageHistory: true,
        hasAudioHistory: false,
        hasThinkingHistory: false,
      }),
    ).toEqual({
      compatible: true,
      missingCapabilities: [],
    });
  });

  it("does not refuse a model that takes no reasoning effort", () => {
    const caps: ProviderModelCapabilities = {
      provider: "openrouter",
      model: "openai/gpt-4.1",
      acceptsImageHistory: false,
      acceptsAudioHistory: false,
      acceptsThinkingHistory: false,
      acceptsReasoningEffort: false,
    };

    expect(
      validateHistoryCompatibility(caps, {
        hasImageHistory: false,
        hasAudioHistory: false,
        hasThinkingHistory: false,
      }),
    ).toEqual({ compatible: true, missingCapabilities: [] });
  });
});

describe("prepareResponsesContinuationRequest", () => {
  it("bounds the 71-character Goal reviewer session cache key", () => {
    const conversationId = "review-36890f9c5ed7d2ebcf12b0158fe131514af1bfad253f96f78fa514295e48182c";
    const body = { model: "gpt-5", input: [], store: false };
    const prepared = prepareResponsesContinuationRequest(body, { conversationId });

    expect(conversationId).toHaveLength(71);
    expect(prepared.request.prompt_cache_key).toHaveLength(64);
    expect(prepared.snapshot.prompt_cache_key).toBe(prepared.request.prompt_cache_key);
    expect(prepareResponsesContinuationRequest(body, { conversationId }).request)
      .toEqual(prepared.request);
    expect(prepareResponsesContinuationRequest(body, {
      conversationId: `${conversationId.slice(0, -1)}d`,
    }).request.prompt_cache_key).not.toBe(prepared.request.prompt_cache_key);
  });

  it.each([63, 64, 65, 71, 1_000])("bounds explicit cache keys of length %i", (length) => {
    const promptCacheKey = "k".repeat(length);
    const body = { input: [], prompt_cache_key: promptCacheKey };
    const prepared = prepareResponsesContinuationRequest(body, {
      conversationId: "fallback-session",
    });

    expect(prepared.request.prompt_cache_key).toHaveLength(Math.min(length, 64));
    if (length <= 64) {
      expect(prepared.request.prompt_cache_key).toBe(promptCacheKey);
    } else {
      expect(prepareResponsesContinuationRequest({
        ...body,
        prompt_cache_key: `${promptCacheKey.slice(0, -1)}z`,
      }, {}).request.prompt_cache_key).not.toBe(prepared.request.prompt_cache_key);
    }
    expect(prepareResponsesContinuationRequest(prepared.request, {}).request)
      .toEqual(prepared.request);
    expect(body.prompt_cache_key).toBe(promptCacheKey);
  });

  it("injects the session conversation id as prompt_cache_key", () => {
    const prepared = prepareResponsesContinuationRequest(
      {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        stream: true,
      },
      {
        conversationId: "conv-123",
      },
    );

    expect(prepared.request.prompt_cache_key).toBe("conv-123");
    expect(prepared.previousResponseId).toBeUndefined();
  });

  it("reuses previous_response_id only when the request is a strict extension", () => {
    const state = {
      conversationId: "conv-123",
    };
    recordResponsesContinuationResponse(
      state,
      {
        model: "gpt-5",
        prompt_cache_key: "conv-123",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        stream: true,
      },
      {
        id: "resp_1",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
        ],
      },
    );

    const prepared = prepareResponsesContinuationRequest(
      {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "follow up" }],
          },
        ],
        stream: true,
      },
      state,
    );

    expect(prepared.previousResponseId).toBe("resp_1");
    expect(prepared.request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "follow up" }],
      },
    ]);
  });

  it("falls back to a full request after I-2 clears the response id", () => {
    const state = {
      conversationId: "conv-123",
    };
    recordResponsesContinuationResponse(
      state,
      {
        model: "gpt-5",
        prompt_cache_key: "conv-123",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        stream: true,
      },
      {
        id: "resp_1",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
        ],
      },
    );

    clearResponsesContinuationResponseId(state);
    const prepared = prepareResponsesContinuationRequest(
      {
        model: "gpt-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "follow up" }],
          },
        ],
        stream: true,
      },
      state,
    );

    expect(prepared.previousResponseId).toBeUndefined();
    expect(prepared.request.input).toHaveLength(3);
  });

  it("full-resets the continuation state on provider/model boundary rebuilds", () => {
    const state = {
      conversationId: "conv-123",
    };
    recordResponsesContinuationResponse(
      state,
      {
        model: "gpt-5",
        prompt_cache_key: "conv-123",
        input: [{ type: "message", role: "user", content: [] }],
        stream: true,
      },
      {
        id: "resp_1",
        output: [{ type: "message", role: "assistant", content: [] }],
      },
    );

    resetResponsesContinuationState(state);

    expect(state.lastRequest).toBeUndefined();
    expect(state.lastResponseId).toBeUndefined();
    expect(state.lastResponseOutput).toBeUndefined();
  });
});
