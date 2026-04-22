import { describe, expect, test } from "vitest";
import {
  buildAnthropicMessagesRequest,
  parseAnthropicMessagesResponse,
} from "./messages-anthropic.js";

describe("buildAnthropicMessagesRequest", () => {
  test("drops orphan tool results instead of synthesizing tool_use blocks", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
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
        content: [
          {
            type: "text",
            text: "run it",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("preserves text and image tool results inside anthropic tool_result content", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_image",
              name: "view_image",
              arguments: "{\"path\":\"/tmp/cat.png\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_image",
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

    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "inspect",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_image",
            name: "view_image",
            input: { path: "/tmp/cat.png" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_image",
            cache_control: { type: "ephemeral" },
            content: [
              { type: "text", text: "Screenshot captured" },
              {
                type: "image",
                source: {
                  type: "url",
                  url: "https://example.com/cat.png",
                },
              },
            ],
          },
        ],
      },
    ]);
  });

  test("serializes user images as Anthropic image blocks and preserves cache_control breakpoints", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        {
          role: "system",
          content: "You are helpful",
          cacheControl: "ephemeral",
        } as unknown as { role: "system"; content: string },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
            { type: "text", text: "Describe the image" },
          ],
          cacheControl: "ephemeral",
        } as unknown as {
          role: "user";
          content: Array<Record<string, unknown>>;
        },
      ],
      tools: [],
    });

    expect(request.system).toEqual([
      {
        type: "text",
        text: "You are helpful",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "url",
              url: "https://example.com/cat.png",
            },
          },
          {
            type: "text",
            text: "Describe the image",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("passes Anthropic context management through the request body", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      contextManagement: {
        edits: [
          {
            type: "clear_thinking_20251015",
            keep: "all",
          },
        ],
      },
    });

    expect(request.context_management).toEqual({
      edits: [
        {
          type: "clear_thinking_20251015",
          keep: "all",
        },
      ],
    });
  });

  test("records anthropic endpoint markers in request metrics", () => {
    const response = parseAnthropicMessagesResponse(
      "claude-sonnet-4.5",
      {
        id: "msg_123",
        model: "claude-sonnet-4.5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
      },
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    );

    expect(response.requestMetrics).toMatchObject({
      endpoint: "/messages",
      responseId: "msg_123",
    });
  });
});
