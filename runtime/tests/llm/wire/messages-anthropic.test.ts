import { describe, expect, test } from "vitest";
import {
  buildAnthropicMessagesRequest,
  parseAnthropicMessagesResponse,
} from "./messages-anthropic.js";
import { ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME } from "../structured-output.js";

function countCacheControlBlocks(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const current = Object.prototype.hasOwnProperty.call(record, "cache_control")
    ? 1
    : 0;
  return current +
    Object.values(record).reduce(
      (sum, item) => sum + countCacheControlBlocks(item),
      0,
    );
}

describe("buildAnthropicMessagesRequest", () => {
  test("merges request instructions into the system field", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "hello" },
      ],
      tools: [],
      options: {
        systemPrompt: "base instructions",
        maxOutputTokens: 8192,
      },
      maxTokens: 4096,
    });

    expect(request.system).toEqual([
      {
        type: "text",
        text: "base instructions",
      },
      {
        type: "text",
        text: "stable prefix",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(request.max_tokens).toBe(4096);
  });

  test("serializes request-scoped sampling controls", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        temperature: 0.4,
        stopSequences: ["END"],
      },
    });

    expect(request.temperature).toBe(0.4);
    expect(request.stop_sequences).toEqual(["END"]);
  });

  test("folds developer messages into system blocks and omits them from turns", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "previous ask" },
        { role: "developer", content: [{ type: "text", text: "realtime update" }] },
        { role: "user", content: "current ask" },
      ],
      tools: [],
      options: {
        systemPrompt: "base instructions",
      },
    });

    expect(request.system).toEqual([
      { type: "text", text: "base instructions" },
      { type: "text", text: "stable prefix" },
      {
        type: "text",
        text: "realtime update",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(request.messages).toEqual([
      {
        role: "user",
        content: "previous ask",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "current ask",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("adds a cache_control breakpoint to request instructions when they are the system prefix", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        { role: "user", content: "hello" },
      ],
      tools: [],
      options: {
        systemPrompt: "base instructions",
      },
    });

    expect(request.system).toEqual([
      {
        type: "text",
        text: "base instructions",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(countCacheControlBlocks(request.system)).toBe(1);
  });

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
              image_url: { url: "http://localhost/cat.png" },
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
                  url: "http://localhost/cat.png",
                },
              },
            ],
          },
        ],
      },
    ]);
  });

  test("serializes data-url tool result images as base64 content", () => {
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
              image_url: { url: "data:image/png;base64,YWJj" },
            },
          ],
        },
      ],
      tools: [],
    });

    expect(request.messages[2]).toEqual({
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
                type: "base64",
                media_type: "image/png",
                data: "YWJj",
              },
            },
          ],
        },
      ],
    });
  });

  test("serializes user images as image blocks and preserves cache_control breakpoints", () => {
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
            {
              type: "image_url",
              image_url: { url: "http://localhost/cat.png" },
            },
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
              url: "http://localhost/cat.png",
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

  test("serializes data-url user images as base64 image blocks", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,YWJj" },
            },
            { type: "text", text: "Describe the image" },
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
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "YWJj",
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

  test("serializes user PDFs as document blocks", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize this PDF" },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "JVBERi0xLjQK",
              },
              filename: "brief.pdf",
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
          { type: "text", text: "Summarize this PDF" },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0xLjQK",
            },
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("does not send unsupported data-url image formats as provider images", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/bmp;base64,YWJj" },
            },
            { type: "text", text: "Describe the image" },
          ],
        },
      ],
      tools: [],
    });

    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "[unsupported image]" },
          {
            type: "text",
            text: "Describe the image",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("normalizes strategic messages into at most three cache_control breakpoints", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "system.echo",
              arguments: "{\"text\":\"ok\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_1",
          toolName: "system.echo",
          content: "ok",
        },
        { role: "user", content: "continue" },
      ],
      tools: [],
    });

    expect(countCacheControlBlocks(request)).toBe(3);
    expect(request.system).toEqual([
      {
        type: "text",
        text: "stable prefix",
        cache_control: { type: "ephemeral" },
      },
    ]);
    const messages = request.messages as Array<Record<string, unknown>>;
    expect(messages.at(-2)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "ok",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "continue",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  test("skipCacheWrite shifts the conversation cache marker off the final fork message", () => {
    const request = buildAnthropicMessagesRequest({
      model: "test-model",
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "system.echo",
              arguments: "{\"text\":\"ok\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_1",
          toolName: "system.echo",
          content: "ok",
        },
        { role: "user", content: "continue" },
      ],
      tools: [],
      options: { skipCacheWrite: true },
    });

    expect(countCacheControlBlocks(request)).toBe(2);
    const messages = request.messages as Array<Record<string, unknown>>;
    expect(messages.at(-2)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "ok",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "continue",
    });
  });

  test("passes context management through the request body", () => {
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

  test("represents structured output as a forced tool_use", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
              },
              required: ["answer"],
            },
          },
        },
      },
    });

    expect(request.tools).toEqual([
      {
        name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
        description: "Return the final response in the requested structured format.",
        input_schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
          },
          required: ["answer"],
        },
      },
    ]);
    expect(request.tool_choice).toEqual({
      type: "tool",
      name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
    });
  });

  test("adds structured output as a normal tool when regular tools are present", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "inspect" }],
      tools: [
        {
          type: "function",
          function: {
            name: "system.echo",
            description: "Echo input.",
            parameters: { type: "object" },
          },
        },
      ],
      options: {
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: { type: "object" },
          },
        },
      },
    });

    expect(request.tools).toHaveLength(2);
    // `system.echo` ships in its bijectively encoded wire form
    // (mcp-tool-naming.ts) because Anthropic enforces
    // `^[a-zA-Z0-9_-]{1,64}$` on tool names. Literal pinned on purpose.
    expect(
      (request.tools as Array<Record<string, unknown>>).map(
        (tool) => tool.name,
      ),
    ).toEqual(["tool2__system_x2eecho", ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME]);
    expect(request.tool_choice).toBeUndefined();
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

  test("parses structured output tool_use without exposing it as a runtime tool call", () => {
    const response = parseAnthropicMessagesResponse(
      "claude-sonnet-4.5",
      {
        id: "msg_structured",
        model: "claude-sonnet-4.5",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_structured",
            name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
            input: { answer: "ok" },
          },
        ],
      },
      {
        model: "claude-sonnet-4.5",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        options: {
          structuredOutput: {
            schema: {
              type: "json_schema",
              name: "answer",
              schema: {
                type: "object",
                properties: {
                  answer: { type: "string" },
                },
                required: ["answer"],
              },
            },
          },
        },
      },
    );

    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe("stop");
    expect(response.structuredOutput).toEqual({
      type: "json_schema",
      name: "answer",
      rawText: "{\"answer\":\"ok\"}",
      parsed: { answer: "ok" },
    });
  });

  test("preserves extended-thinking blocks on the LLMResponse separate from content", () => {
    const response = parseAnthropicMessagesResponse(
      "claude-opus-4-7",
      {
        id: "msg_thinking",
        model: "claude-opus-4-7",
        stop_reason: "end_turn",
        content: [
          {
            type: "thinking",
            thinking: "Let me reason about this.",
            signature: "SIG==",
          },
          { type: "text", text: "Final answer." },
        ],
      },
      {
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      },
    );

    expect(response.content).toBe("Final answer.");
    expect(response.thinking).toBeDefined();
    expect(response.thinking).toHaveLength(1);
    expect(response.thinking?.[0]).toMatchObject({
      text: "Let me reason about this.",
      redacted: false,
      signature: "SIG==",
      kind: "thinking",
    });
  });

  test("preserves redacted_thinking blocks with redacted=true and the opaque data string", () => {
    const response = parseAnthropicMessagesResponse(
      "claude-opus-4-7",
      {
        id: "msg_redacted",
        model: "claude-opus-4-7",
        stop_reason: "end_turn",
        content: [
          { type: "redacted_thinking", data: "ENCRYPTEDOPAQUE" },
          { type: "text", text: "ok" },
        ],
      },
      {
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      },
    );

    expect(response.thinking).toHaveLength(1);
    expect(response.thinking?.[0]).toMatchObject({
      text: "ENCRYPTEDOPAQUE",
      redacted: true,
      kind: "thinking",
    });
    expect(response.content).toBe("ok");
  });

  test("response with no thinking blocks omits the thinking field entirely", () => {
    const response = parseAnthropicMessagesResponse(
      "claude-opus-4-7",
      {
        id: "msg_plain",
        model: "claude-opus-4-7",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hi" }],
      },
      {
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      },
    );

    expect(response.thinking).toBeUndefined();
  });
});

/**
 * Task 28: Claude Fable 5 request-surface family-awareness. The
 * Fable/Mythos 5 family has a DIFFERENT Messages API surface than the
 * Opus family (provider docs, verified 2026-07-08): thinking is always
 * on server-side (any explicit `thinking` config other than adaptive
 * returns a 400 — the param must be omitted), and sampling parameters
 * (`temperature`) are removed. The Opus (>= 4.6) path must stay exactly
 * as-is. These tests fail if someone routes fable through the opus
 * thinking path.
 */
describe("buildAnthropicMessagesRequest — fable/mythos 5 family", () => {
  const baseInput = {
    messages: [{ role: "user" as const, content: "hello" }],
    tools: [],
  };

  test("a fable-5 request carries NO thinking config while opus-4-8 keeps its config", () => {
    const fable = buildAnthropicMessagesRequest({
      ...baseInput,
      model: "claude-fable-5",
      options: { reasoningEffort: "high" },
    });
    expect(fable.thinking).toBeUndefined();

    // Opus family behavior is unchanged (kept exactly as-is).
    const opus = buildAnthropicMessagesRequest({
      ...baseInput,
      model: "claude-opus-4-8",
      options: { reasoningEffort: "high" },
    });
    expect(opus.thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    });
  });

  test("provider spellings of the family also omit the thinking config", () => {
    const request = buildAnthropicMessagesRequest({
      ...baseInput,
      model: "us.anthropic.agenc-fable-5-v1",
      options: { reasoningEffort: "medium" },
    });
    expect(request.thinking).toBeUndefined();
  });

  test("fable-5 omits forced tool_choice even without reasoningEffort (thinking is always on)", () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "echo",
          description: "Echo input.",
          parameters: { type: "object" },
        },
      },
    ];
    const fable = buildAnthropicMessagesRequest({
      messages: baseInput.messages,
      tools,
      model: "claude-fable-5",
      options: { toolChoice: "required" },
    });
    expect(fable.tool_choice).toBeUndefined();

    // A non-thinking opus request keeps the forced tool_choice.
    const opus = buildAnthropicMessagesRequest({
      messages: baseInput.messages,
      tools,
      model: "claude-opus-4-8",
      options: { toolChoice: "required" },
    });
    expect(opus.tool_choice).toEqual({ type: "any" });
  });

  test("fable-5 does not force the structured-output tool choice", () => {
    const request = buildAnthropicMessagesRequest({
      ...baseInput,
      model: "claude-fable-5",
      options: {
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: { type: "object" },
          },
        },
      },
    });
    // The structured-output tool is still offered…
    expect(
      (request.tools as Array<Record<string, unknown>>).map(
        (tool) => tool.name,
      ),
    ).toEqual([ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME]);
    // …but never force-selected (forced tool_choice with thinking 400s).
    expect(request.tool_choice).toBeUndefined();
  });

  test("fable-5 omits temperature (sampling params removed) while opus keeps it", () => {
    const fable = buildAnthropicMessagesRequest({
      ...baseInput,
      model: "claude-fable-5",
      options: { temperature: 0.4 },
    });
    expect(fable.temperature).toBeUndefined();

    const opus = buildAnthropicMessagesRequest({
      ...baseInput,
      model: "claude-opus-4-8",
      options: { temperature: 0.4 },
    });
    expect(opus.temperature).toBe(0.4);
  });

  test("the refusal stop reason parses to the content_filter finish reason", () => {
    const response = parseAnthropicMessagesResponse(
      "claude-fable-5",
      {
        id: "msg_refusal",
        model: "claude-fable-5",
        stop_reason: "refusal",
        content: [],
      },
      {
        model: "claude-fable-5",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    );
    expect(response.finishReason).toBe("content_filter");
    expect(response.content).toBe("");
  });
});
