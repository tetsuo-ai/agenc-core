import { describe, expect, test } from "vitest";
import {
  buildChatCompletionsRequest,
  parseChatCompletionsResponse,
} from "./chat-completions.js";

describe("buildChatCompletionsRequest", () => {
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

  test("preserves mixed text and image tool results and disables store", () => {
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

    expect(request.store).toBe(false);
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
});
