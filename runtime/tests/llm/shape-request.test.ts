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
  it("detects image, audio, thinking, and reasoning-effort requirements recursively", () => {
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

    expect(requirements).toEqual({
      hasImageHistory: true,
      hasAudioHistory: true,
      hasThinkingHistory: true,
      reasoningEffortRequested: true,
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
      reasoningEffortRequested: true,
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
        reasoningEffortRequested: true,
      }),
    ).toEqual({
      compatible: true,
      missingCapabilities: [],
    });
  });

  it("surfaces reasoning effort as a user-facing compatibility requirement", () => {
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
        reasoningEffortRequested: true,
      }),
    ).toEqual({
      compatible: false,
      missingCapabilities: ["reasoning effort"],
      reason:
        "openrouter / openai/gpt-4.1 cannot satisfy this session's reasoning effort requirements",
    });
  });
});

describe("prepareResponsesContinuationRequest", () => {
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
