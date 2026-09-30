import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  buildAnthropicMessagesRequest,
  parseAnthropicMessagesResponse,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER,
} from "./messages-anthropic.js";
import { ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME } from "../structured-output.js";
import type { LLMMessage } from "../types.js";

/** A turn that reads two files in parallel, followed by both results. */
function parallelReadHistory(): LLMMessage[] {
  return [
    { role: "user", content: "read both files" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "toolu_a", name: "FileRead", arguments: "{\"file_path\":\"a.ts\"}" },
        { id: "toolu_b", name: "FileRead", arguments: "{\"file_path\":\"b.ts\"}" },
      ],
    },
    { role: "tool", toolCallId: "toolu_a", toolName: "FileRead", content: "A" },
    { role: "tool", toolCallId: "toolu_b", toolName: "FileRead", content: "B" },
  ];
}

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

describe("Sonnet 5.5 Messages API contract", () => {
  const model = "claude-sonnet-5-5";
  const messages = [{ role: "user" as const, content: "Call echo with ok." }];
  const tools = [{ type: "function" as const, function: {
    name: "echo", description: "Echo a value", parameters: { type: "object" },
  } }];

  test("keeps tools, effort, output cap and cached head identical across response detail levels", () => {
    const build = (modelVerbosity?: "low" | "medium" | "high") => buildAnthropicMessagesRequest({
      model, messages, tools, maxTokens: 4096,
      options: { systemPrompt: "STATIC_HEAD\n\n<!-- dynamic-boundary -->\n\nDYNAMIC_TAIL",
        responseDetailOverride: modelVerbosity, reasoningEffort: "high", toolChoice: "required" },
    });
    const inherited = build();
    for (const level of ["low", "medium", "high"] as const) {
      const candidate = build(level);
      expect(candidate.tools).toEqual(inherited.tools);
      expect(candidate.tool_choice).toEqual(inherited.tool_choice);
      expect(candidate.output_config).toEqual(inherited.output_config);
      expect(candidate.max_tokens).toEqual(inherited.max_tokens);
      expect(candidate.system).toEqual(inherited.system);
      expect(JSON.stringify(candidate.messages)).toContain("# Response Detail");
      expect(JSON.stringify(candidate.messages)).toContain("checks and test results, errors, blockers, and approval requests");
    }
    expect(JSON.stringify(inherited.messages)).not.toContain("# Response Detail");
    const inheritedConfig = buildAnthropicMessagesRequest({ model, messages, tools,
      options: { systemPrompt: "STATIC_HEAD", modelVerbosity: "high" } });
    expect(JSON.stringify(inheritedConfig)).not.toContain("# Response Detail");
  });
  test("keeps unset request bytes and output cap from the pre-detail builder", () => {
    const request = buildAnthropicMessagesRequest({
      model, messages: [{ role: "user", content: "hello" }], tools: [], maxTokens: 4096,
      options: { systemPrompt: "STATIC_HEAD\n\n<!-- dynamic-boundary -->\n\nDYNAMIC_TAIL" },
    });
    expect(createHash("sha256").update(JSON.stringify(request)).digest("hex"))
      .toBe("c66fb5c6b7879af6bf3a19d1a4f42fef4874824a4a2731d138d72d1d62a84ec6");
    expect(request.max_tokens).toBe(4096);
  });

  test("uses adaptive thinking with readable progress updates at every effort", () => {
    for (const reasoningEffort of [undefined, "low", "medium", "high", "xhigh", "max"] as const) {
      const body = buildAnthropicMessagesRequest({ model, messages, tools,
        options: { reasoningEffort, temperature: 0.1, toolChoice: "required", serviceTier: "priority" },
      });
      expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(body.output_config).toEqual(reasoningEffort ? { effort: reasoningEffort } : undefined);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("tool_choice");
      expect(body).not.toHaveProperty("speed");
    }
  });

  test("maps none to between_tools without unsupported additional fields or forced tools", () => {
    const body = buildAnthropicMessagesRequest({ model, messages, tools, options: {
      reasoningEffort: "none", toolChoice: { type: "function", name: "echo" },
    } });
    expect(body.thinking).toEqual({ type: "between_tools" });
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("tool_choice");
    expect(buildAnthropicMessagesRequest({ model, messages, tools, options: { toolChoice: "none" } }).tool_choice)
      .toEqual({ type: "none" });
  });

  test("does not force the structured-output tool", () => {
    const body = buildAnthropicMessagesRequest({ model, messages, tools: [], options: {
      structuredOutput: { schema: { type: "json_schema", name: "answer", schema: { type: "object" } } },
    } });
    expect(body.tools).toEqual([expect.objectContaining({ name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME })]);
    expect(body).not.toHaveProperty("tool_choice");
  });

  test("keeps thinking signatures out of conversation replay across models and edited prefixes", () => {
    const response = parseAnthropicMessagesResponse(model, {
      content: [
        { type: "thinking", thinking: "Calling echo.", signature: "model-bound-test-signature" },
        { type: "tool_use", id: "call_1", name: "echo", input: {} },
      ],
      stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 4 },
    }, { model, messages, tools });
    expect(response.thinking?.[0]).toMatchObject({ text: "Calling echo.", signature: "model-bound-test-signature" });
    // AgenC renders the summary but currently preserves no Anthropic opaque
    // replay state. Model-bound signatures therefore never cross a switch
    // or return with an edited system/tool/message prefix.
    expect(response.providerReasoningContent).toBeUndefined();
    for (const target of [model, "claude-sonnet-5", "claude-opus-5-5"]) {
      const body = buildAnthropicMessagesRequest({ model: target, tools,
        messages: [
          { role: "system", content: "Changed instructions." },
          ...messages,
          { role: "assistant", content: response.content, toolCalls: response.toolCalls },
          { role: "tool", toolCallId: "call_1", content: "ok" },
        ],
      });
      expect(JSON.stringify(body)).not.toContain("model-bound-test-signature");
      expect(JSON.stringify(body)).not.toContain("Calling echo.");
      expect(body.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: [
        { type: "tool_use", id: "call_1", name: "echo", input: {} },
      ] }));
    }
  });
});

describe("buildAnthropicMessagesRequest", () => {
  test("sends speed fast only for fast-mode models on the priority tier", () => {
    const build = (model: string, serviceTier?: "priority" | "flex") =>
      buildAnthropicMessagesRequest({
        model,
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        options: {
          ...(serviceTier !== undefined ? { serviceTier } : {}),
          maxOutputTokens: 1024,
        },
        maxTokens: 1024,
      });
    expect(build("claude-opus-5", "priority").speed).toBe("fast");
    expect(build("claude-opus-4-8", "priority").speed).toBe("fast");
    // Not a fast-mode model: the field would return an error, so it is never sent.
    expect(build("claude-sonnet-5", "priority")).not.toHaveProperty("speed");
    expect(build("claude-opus-4-7", "priority")).not.toHaveProperty("speed");
    // Flex and the default tier never ask for fast mode.
    expect(build("claude-opus-5", "flex")).not.toHaveProperty("speed");
    expect(build("claude-opus-5")).not.toHaveProperty("speed");
  });

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

  test("returns the results of one parallel tool turn in a single user message", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: parallelReadHistory(),
      tools: [],
      options: {
        systemPrompt: `static head\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER}\nbranch: main`,
      },
    });

    // The results answer the tool_use blocks in order, the breakpoint sits on
    // the last result, and the volatile tail follows every tool_result block.
    expect(request.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "read both files",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_a", name: "FileRead", input: { file_path: "a.ts" } },
          { type: "tool_use", id: "toolu_b", name: "FileRead", input: { file_path: "b.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "A" },
          {
            type: "tool_result",
            tool_use_id: "toolu_b",
            content: "B",
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: "<system-reminder>\nbranch: main\n</system-reminder>" },
        ],
      },
    ]);
    // The static head, the last user message and the last tool result.
    expect(countCacheControlBlocks(request)).toBe(3);
  });

  test("keeps the results of separate tool turns in separate user messages", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [
        ...parallelReadHistory(),
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "toolu_c", name: "FileRead", arguments: "{\"file_path\":\"c.ts\"}" },
          ],
        },
        { role: "tool", toolCallId: "toolu_c", toolName: "FileRead", content: "C" },
      ],
      tools: [],
    });

    const messages = request.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    // The earlier results keep their blocks and order; only the breakpoint
    // has moved on to the newest result.
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "A" },
        { type: "tool_result", tool_use_id: "toolu_b", content: "B" },
      ],
    });
    expect(messages[4]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_c",
          content: "C",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  });

  test("skipCacheWrite keeps the fork's cache marker on the result it was placed on", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: parallelReadHistory(),
      tools: [],
      options: { skipCacheWrite: true },
    });

    // The marker lands on the second-to-last message, the first result; the
    // fork's final result stays out of the cache.
    expect(countCacheControlBlocks(request)).toBe(1);
    expect((request.messages as Array<Record<string, unknown>>).at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_a",
          content: "A",
          cache_control: { type: "ephemeral" },
        },
        { type: "tool_result", tool_use_id: "toolu_b", content: "B" },
      ],
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

  test("encodes a named toolChoice with the same wire name as tools", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: "search memory" }],
      tools: [
        {
          type: "function",
          function: {
            name: "mcp.memory.search_nodes",
            description: "Search the memory graph.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      options: {
        toolChoice: { type: "function", name: "mcp.memory.search_nodes" },
      },
      maxTokens: 4096,
    });

    const tools = request.tools as Array<{ name: string }>;
    // Hardcoded literal on purpose: pins the wire contract.
    expect(tools[0]!.name).toBe("mcp__memory__search_nodes");
    // tool_choice must reference the encoded tools[] entry byte-for-byte,
    // never the dotted internal name the provider never saw.
    expect(request.tool_choice).toEqual({
      type: "tool",
      name: tools[0]!.name,
    });
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

  test("a fable-5 request carries NO thinking config while opus-4-8 runs adaptive thinking", () => {
    const fable = buildAnthropicMessagesRequest({
      ...baseInput,
      model: "claude-fable-5",
      options: { reasoningEffort: "high" },
    });
    expect(fable.thinking).toBeUndefined();
    expect(fable.output_config).toEqual({ effort: "high" });

    // Opus 4.8 returns 400 for `enabled` + `budget_tokens` ("Use
    // thinking.type.adaptive and output_config.effort"), probed 2026-09-11.
    const opus = buildAnthropicMessagesRequest({
      ...baseInput,
      model: "claude-opus-4-8",
      options: { reasoningEffort: "high" },
    });
    expect(opus.thinking).toEqual({ type: "adaptive" });
    expect(opus.output_config).toEqual({ effort: "high" });
  });

  test("each Claude generation gets the thinking control the API accepts", () => {
    const request = (model: string, reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "minimal") =>
      buildAnthropicMessagesRequest({
        ...baseInput,
        model,
        options: reasoningEffort === undefined ? {} : { reasoningEffort },
      });

    // Current lineup: Fable 5.1 omits the config, Opus 5 and Sonnet 5 run adaptive.
    expect(request("claude-fable-5-1", "max").thinking).toBeUndefined();
    expect(request("claude-fable-5-1", "max").output_config).toEqual({ effort: "max" });
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(request(model, "medium").thinking, model).toEqual({ type: "adaptive" });
      expect(request(model, "medium").output_config, model).toEqual({ effort: "medium" });
    }
    expect(request("us.anthropic.agenc-opus-5-v1", "low").thinking).toEqual({ type: "adaptive" });

    // Budgeted generations keep their config; effort only where the API takes it.
    expect(request("claude-opus-4-5-20251101", "high").thinking).toEqual({ type: "enabled", budget_tokens: 4095 });
    expect(request("claude-opus-4-5-20251101", "high").output_config).toEqual({ effort: "high" });
    for (const model of ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"]) {
      expect(request(model, "low").thinking, model).toEqual({ type: "enabled", budget_tokens: 2048 });
      expect(request(model, "low").output_config, model).toBeUndefined();
    }

    // No effort, no thinking config and no output_config, as before.
    expect(request("claude-opus-5").thinking).toBeUndefined();
    expect(request("claude-opus-5").output_config).toBeUndefined();
    // `minimal` is not on Claude's ladder; it rounds up to low.
    expect(request("claude-opus-5", "minimal").output_config).toEqual({ effort: "low" });
  });

  test("models that answer 400 to temperature never receive it", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      const request = buildAnthropicMessagesRequest({
        ...baseInput,
        model,
        options: { temperature: 0.2 },
      });
      expect(request.temperature, model).toBeUndefined();
    }
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      const request = buildAnthropicMessagesRequest({
        ...baseInput,
        model,
        options: { temperature: 0.2 },
      });
      expect(request.temperature, model).toBe(0.2);
    }
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

  test("fable-5 omits temperature (sampling params removed) while opus 4.6 keeps it", () => {
    const fable = buildAnthropicMessagesRequest({
      ...baseInput,
      model: "claude-fable-5",
      options: { temperature: 0.4 },
    });
    expect(fable.temperature).toBeUndefined();

    // Opus 4.8 and 4.7 dropped sampling parameters too (400, probed
    // 2026-09-11); Opus 4.6 is the newest Opus that still takes them.
    const opus = buildAnthropicMessagesRequest({
      ...baseInput,
      model: "claude-opus-4-6",
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

/**
 * Claude Opus 5.5 (platform.claude.com, 2026-09-22): thinking is always on
 * (`disabled` and `enabled` + budget_tokens return 400 at every effort
 * level), forced tool_choice returns 400 ("tool_choice: type "tool" and
 * "any" are not supported for this model"), non-default sampling parameters
 * return 400, all five effort levels are accepted, and fast mode is offered.
 * Claude Opus 5 keeps its adaptive surface. Not probed live yet.
 */
describe("buildAnthropicMessagesRequest: Claude Opus 5.5", () => {
  const turns = [{ role: "user" as const, content: "hello" }];
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

  test("never sends a thinking config and forwards every effort level unchanged", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const request = buildAnthropicMessagesRequest({
        model: "claude-opus-5-5",
        messages: turns,
        tools: [],
        options: { reasoningEffort: effort },
      });
      expect(request.thinking, effort).toBeUndefined();
      expect(request.output_config, effort).toEqual({ effort });
    }
    // `minimal` rounds up to low.
    expect(
      buildAnthropicMessagesRequest({
        model: "claude-opus-5-5",
        messages: turns,
        tools: [],
        options: { reasoningEffort: "minimal" },
      }).output_config,
    ).toEqual({ effort: "low" });
    // No effort configured: nothing is sent and the API applies medium.
    const bare = buildAnthropicMessagesRequest({
      model: "claude-opus-5-5",
      messages: turns,
      tools: [],
    });
    expect(bare.thinking).toBeUndefined();
    expect(bare.output_config).toBeUndefined();
    // Provider spellings take the same surface.
    for (const model of ["us.anthropic.agenc-opus-5-5-v1", "anthropic.claude-opus-5-5"]) {
      const request = buildAnthropicMessagesRequest({
        model,
        messages: turns,
        tools: [],
        options: { reasoningEffort: "xhigh" },
      });
      expect(request.thinking, model).toBeUndefined();
      expect(request.output_config, model).toEqual({ effort: "xhigh" });
    }
  });

  test("drops temperature and never forces a tool, with or without effort", () => {
    for (const options of [
      { temperature: 0.3, toolChoice: "required" as const },
      {
        temperature: 0.3,
        toolChoice: { type: "function" as const, name: "echo" },
      },
      {
        temperature: 0.3,
        toolChoice: "required" as const,
        reasoningEffort: "low" as const,
      },
    ]) {
      const request = buildAnthropicMessagesRequest({
        model: "claude-opus-5-5",
        messages: turns,
        tools,
        options,
      });
      expect(request.temperature).toBeUndefined();
      expect(request.tool_choice).toBeUndefined();
      expect((request.tools as Array<{ name: string }>).map((tool) => tool.name))
        .toEqual(["echo"]);
    }
  });

  test("offers the structured-output tool without forcing it", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-opus-5-5",
      messages: turns,
      tools: [],
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
    expect(
      (request.tools as Array<Record<string, unknown>>).map((tool) => tool.name),
    ).toEqual([ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME]);
    expect(request.tool_choice).toBeUndefined();
  });

  test("rides the priority tier as fast mode", () => {
    const request = (serviceTier?: "priority" | "flex") =>
      buildAnthropicMessagesRequest({
        model: "claude-opus-5-5",
        messages: turns,
        tools: [],
        options: serviceTier === undefined ? {} : { serviceTier },
      });
    expect(request("priority").speed).toBe("fast");
    expect(request("flex")).not.toHaveProperty("speed");
    expect(request()).not.toHaveProperty("speed");
  });

  test("keeps the served speed on the response usage", () => {
    const parse = (usage: Record<string, unknown>) =>
      parseAnthropicMessagesResponse(
        "claude-opus-5-5",
        {
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage,
        },
        { model: "claude-opus-5-5", messages: turns, tools: [] },
      ).usage;
    expect(parse({ input_tokens: 3, output_tokens: 1, speed: "fast" }).speed).toBe("fast");
    expect(parse({ input_tokens: 3, output_tokens: 1, speed: "standard" }).speed).toBe("standard");
    expect(parse({ input_tokens: 3, output_tokens: 1 })).not.toHaveProperty("speed");
    expect(parse({ input_tokens: 3, output_tokens: 1, speed: "turbo" })).not.toHaveProperty("speed");
  });

  test("Claude Opus 5 is not swept into the always-on surface", () => {
    for (const model of ["claude-opus-5", "us.anthropic.agenc-opus-5-v1"]) {
      const request = buildAnthropicMessagesRequest({
        model,
        messages: turns,
        tools: [],
        options: { reasoningEffort: "high" },
      });
      expect(request.thinking, model).toEqual({ type: "adaptive" });
      expect(request.output_config, model).toEqual({ effort: "high" });
    }
  });
});

describe("buildAnthropicMessagesRequest — thinking capability matrix", () => {
  const turns = [{ role: "user" as const, content: "hello" }];

  test("adaptive, always-on, and manual families emit valid request bodies", () => {
    const rows = [
      {
        label: "opus-4-7 medium at a 1024 cap",
        model: "claude-opus-4-7",
        maxTokens: 1024,
        effort: "medium" as const,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
      },
      {
        label: "opus-4-8 medium",
        model: "claude-opus-4-8",
        maxTokens: 4096,
        effort: "medium" as const,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
      },
      {
        label: "fable-5 medium omits thinking",
        model: "claude-fable-5",
        maxTokens: 4096,
        effort: "medium" as const,
        thinking: undefined,
        output_config: { effort: "medium" },
      },
      {
        label: "opus-4-5 high on the default cap",
        model: "claude-opus-4-5-20251101",
        maxTokens: undefined,
        effort: "high" as const,
        thinking: { type: "enabled", budget_tokens: 4095 },
        output_config: { effort: "high" },
      },
      {
        label: "sonnet-4-5 high under a 2048 cap",
        model: "claude-sonnet-4-5-20250929",
        maxTokens: 2048,
        effort: "high" as const,
        thinking: { type: "enabled", budget_tokens: 2047 },
        output_config: undefined,
      },
      {
        label: "unknown future model medium under a 1500 cap",
        model: "claude-future-unknown",
        maxTokens: 1500,
        effort: "medium" as const,
        thinking: { type: "enabled", budget_tokens: 1499 },
        output_config: undefined,
      },
    ];

    for (const row of rows) {
      const request = buildAnthropicMessagesRequest({
        model: row.model,
        messages: turns,
        tools: [],
        ...(row.maxTokens === undefined ? {} : { maxTokens: row.maxTokens }),
        options: { reasoningEffort: row.effort },
      });
      expect(request.thinking, row.label).toEqual(row.thinking);
      expect(request.output_config, row.label).toEqual(row.output_config);
    }
  });

  test("a 1024 output cap cannot carry a manual thinking budget", () => {
    expect(() =>
      buildAnthropicMessagesRequest({
        model: "claude-haiku-4-5-20251001",
        messages: turns,
        tools: [],
        maxTokens: 1024,
        options: { reasoningEffort: "high" },
      }),
    ).toThrow("budget_tokens >= 1024 and below max_tokens (1024)");
  });
});
