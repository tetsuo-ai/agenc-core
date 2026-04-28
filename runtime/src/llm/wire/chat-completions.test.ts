import { describe, expect, test } from "vitest";
import {
  buildChatCompletionsRequest,
  collectChatCompletionsRequestMetadata,
  parseChatCompletionsResponse,
} from "./chat-completions.js";

describe("buildChatCompletionsRequest", () => {
  test("serializes request instructions as the first system message only", () => {
    const request = buildChatCompletionsRequest({
      model: "qwen-local",
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "hello" },
        { role: "system", content: "late runtime note" },
        { role: "user", content: "continue" },
      ],
      tools: [],
      options: {
        systemPrompt: "base instructions",
      },
    });

    expect(request.messages).toEqual([
      {
        role: "system",
        content: "base instructions\n\nstable prefix",
      },
      {
        role: "user",
        content: "hello\n\ncontinue",
      },
    ]);
  });

  test("always sends a positive output-token budget", () => {
    const request = buildChatCompletionsRequest({
      model: "qwen-local",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        maxOutputTokens: 0,
      },
    });

    expect(request.max_tokens).toBe(4096);
  });

  test("can target max_completion_tokens for providers that require it", () => {
    const request = buildChatCompletionsRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      maxTokens: 8192,
      maxTokenField: "max_completion_tokens",
    });

    expect(request.max_completion_tokens).toBe(8192);
    expect("max_tokens" in request).toBe(false);
  });

  test("collects request metadata without logging prompt bodies", () => {
    const request = buildChatCompletionsRequest({
      model: "qwen-local",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "FileRead",
            description: "read",
            parameters: { type: "object" },
          },
        },
      ],
      maxTokens: 2048,
    });

    expect(collectChatCompletionsRequestMetadata(request)).toMatchObject({
      model: "qwen-local",
      messageCount: 1,
      roleSequence: ["user"],
      maxTokens: 2048,
      maxTokenField: "max_tokens",
      toolsAttached: true,
      toolCount: 1,
    });
  });

  test("drops orphan tool results instead of synthesizing assistant tool_calls", () => {
    const request = buildChatCompletionsRequest({
      model: "gpt-4.1",
      messages: [
        { role: "user", content: "run it" },
        {
          role: "tool",
          toolCallId: "call_missing",
          toolName: "shell",
          content: "done",
        },
      ],
      tools: [],
    });

    expect(request.messages).toEqual([
      {
        role: "user",
        content: "run it",
      },
    ]);
  });

  test("preserves mixed text and image tool results without forcing store", () => {
    const request = buildChatCompletionsRequest({
      model: "gpt-4.1",
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "view_image",
              arguments: "{\"path\":\"/tmp/cat.png\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_1",
          toolName: "view_image",
          content: [
            { type: "text", text: "Screenshot captured" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/cat.png" },
            },
          ],
        },
      ],
      tools: [],
    });

    expect("store" in request).toBe(false);
    expect(request.stream).toBe(false);
    expect(request.messages).toEqual([
      {
        role: "user",
        content: "inspect",
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "view_image",
              arguments: "{\"path\":\"/tmp/cat.png\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "Screenshot captured" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/cat.png" },
          },
        ],
      },
    ]);
  });

  test("preserves inline input_audio parts for OpenAI-compatible audio models", () => {
    const request = buildChatCompletionsRequest({
      model: "gpt-audio",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this" },
            {
              type: "input_audio",
              input_audio: {
                data: "UklGRiQAAABXQVZFZm10",
                format: "wav",
              },
            },
          ] as unknown as Array<Record<string, unknown>>,
        },
      ],
      tools: [],
    });

    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this" },
          {
            type: "input_audio",
            input_audio: {
              data: "UklGRiQAAABXQVZFZm10",
              format: "wav",
            },
          },
        ],
      },
    ]);
  });

  test("records chat completions endpoint markers in request metrics", () => {
    const response = parseChatCompletionsResponse(
      "gpt-4.1",
      {
        id: "chatcmpl_123",
        choices: [
          {
            message: {
              role: "assistant",
              content: "ok",
            },
            finish_reason: "stop",
          },
        ],
      },
      {
        model: "gpt-4.1",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    );

    expect(response.requestMetrics).toMatchObject({
      endpoint: "/chat/completions",
      responseId: "chatcmpl_123",
    });
  });

  test("forwards service_tier to OpenAI-compatible chat completions providers", () => {
    const request = buildChatCompletionsRequest({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        serviceTier: "fast",
      },
    });

    expect(request.service_tier).toBe("fast");
  });

  test("falls back to DeepSeek reasoning_content when content is absent", () => {
    const response = parseChatCompletionsResponse(
      "deepseek-reasoner",
      {
        id: "chatcmpl_deepseek",
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "reasoning trace",
            },
            finish_reason: "stop",
          },
        ],
      },
      {
        model: "deepseek-reasoner",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    );

    expect(response.content).toBe("reasoning trace");
  });
});
