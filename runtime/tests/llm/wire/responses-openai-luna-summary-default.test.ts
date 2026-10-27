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
