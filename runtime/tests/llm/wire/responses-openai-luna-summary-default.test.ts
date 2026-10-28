import { describe, expect, test } from "vitest";
import type { LLMMessage } from "../../../src/llm/types.js";
import {
  buildOpenAIResponsesRequest,
  extractOpenAIReasoningReplay,
  type OpenAIResponsesRequestOptions,
} from "../../../src/llm/wire/responses-openai.js";
import {
  llmMessageToDurableResponseItem,
  responseItemToLlmMessage,
} from "../../../src/session/message-history-conversion.js";

const request: OpenAIResponsesRequestOptions = {
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "Read the project." }],
  tools: [],
  reasoningReplayProvider: "openai",
};

describe("Luna API summary defaults", () => {
  test.each(["medium", "max"] as const)(
    "keeps %s effort and encrypted replay without adding a summary request",
    (reasoningEffort) => {
      for (const metadata of [
        {},
        { reasoningSummary: "none" as const, reasoningSummaryIsDefault: true as const },
      ]) {
        const body = buildOpenAIResponsesRequest({
          ...request,
          maxOutputTokens: 128_000,
          options: { reasoningEffort, ...metadata },
        });
        expect(body.reasoning).toEqual({ effort: reasoningEffort });
        expect(body.include).toEqual(["reasoning.encrypted_content"]);
        expect(body.max_output_tokens).toBe(128_000);
        expect(body.store).toBe(false);
      }
    },
  );

  test.each(["none", "auto", "concise", "detailed"] as const)(
    "retains the explicit %s summary setting",
    (reasoningSummary) => {
      const body = buildOpenAIResponsesRequest({
        ...request,
        options: { reasoningEffort: "medium", reasoningSummary },
      });
      expect(body.reasoning).toEqual({
        effort: "medium",
        ...(reasoningSummary === "none" ? {} : { summary: reasoningSummary }),
      });
    },
  );

  test("keeps existing defaults for ChatGPT and other models", () => {
    for (const route of [
      { chatgptBackend: true },
      { model: "gpt-6-sol" },
      { reasoningReplayProvider: "another-provider" },
    ]) {
      expect(buildOpenAIResponsesRequest({
        ...request,
        ...route,
        options: { reasoningEffort: "medium" },
      }).reasoning).toEqual({ effort: "medium", summary: "auto" });
    }
  });

  test("replays reasoning with an empty summary after persistence and restore", () => {
    const reasoning = {
      type: "reasoning",
      id: "rs_luna_without_summary",
      summary: [],
      encrypted_content: "synthetic-luna-reasoning",
    };
    const assistant: LLMMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_read", name: "read", arguments: "{}" }],
      ...extractOpenAIReasoningReplay([reasoning], request),
    };
    const restored = responseItemToLlmMessage(JSON.parse(JSON.stringify(
      llmMessageToDurableResponseItem(assistant),
    )));
    const body = buildOpenAIResponsesRequest({
      ...request,
      messages: [
        ...request.messages,
        restored,
        { role: "tool", toolCallId: "call_read", content: "Project contents." },
      ],
      options: { reasoningEffort: "medium" },
    });
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.input).toContainEqual(reasoning);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });
});

/**
 * GPT-6.1 Terra spends extra time on automatic summaries the same way. On
 * 2026-10-28 the first visible output came 0.59 s later with
 * `summary: "auto"` than without it on the same prompt (median of 8 pairs),
 * and 16 paired Light runs of 8 coding tasks finished 2.4 s faster and
 * 6 percent cheaper without it (147 fewer output tokens per task, 16 of 16
 * solved either way). Terra keeps its own summary default on the platform
 * API, like Luna.
 */
describe("Terra API summary defaults", () => {
  const terra: OpenAIResponsesRequestOptions = { ...request, model: "gpt-6.1-terra" };

  test.each(["low", "medium", "max"] as const)("sends %s effort and replay without a summary request", (reasoningEffort) => {
    for (const metadata of [{}, { reasoningSummary: "none" as const, reasoningSummaryIsDefault: true as const }]) {
      const body = buildOpenAIResponsesRequest({ ...terra, options: { reasoningEffort, ...metadata } });
      expect(body.reasoning).toEqual({ effort: reasoningEffort });
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
    }
  });

  test("an omitted effort runs Terra's medium default, still without a summary request", () => {
    expect(buildOpenAIResponsesRequest({ ...terra, options: {} }).reasoning).toBeUndefined();
  });

  test.each(["auto", "concise", "detailed"] as const)("retains the explicit %s summary", (reasoningSummary) => {
    expect(buildOpenAIResponsesRequest({ ...terra, options: { reasoningEffort: "medium", reasoningSummary } }).reasoning)
      .toEqual({ effort: "medium", summary: reasoningSummary });
  });

  test("keeps auto on the ChatGPT backend and for GPT-6.1 Sol", () => {
    expect(buildOpenAIResponsesRequest({ ...terra, chatgptBackend: true, options: { reasoningEffort: "medium" } }).reasoning)
      .toEqual({ effort: "medium", summary: "auto" });
    expect(buildOpenAIResponsesRequest({ ...terra, model: "gpt-6.1-sol", options: { reasoningEffort: "medium" } }).reasoning)
      .toEqual({ effort: "medium", summary: "auto" });
  });
});
