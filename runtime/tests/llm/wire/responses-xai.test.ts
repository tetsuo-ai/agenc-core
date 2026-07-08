import { describe, expect, test } from "vitest";

import type { LLMMessage, LLMTool } from "../types.js";
import {
  buildXaiResponsesInputItems,
  buildXaiResponsesRequest,
  resolveXaiResponsesToolChoice,
  toXaiResponsesTools,
  XAI_ENCRYPTED_REASONING_INCLUDE,
} from "./responses-xai.js";

// Wire form of `system.echo` under the bijective MCP tool-name encoding
// (mcp-tool-naming.ts) — xAI enforces `^[a-zA-Z0-9_-]{1,64}$` on function
// names. Hardcoded literal on purpose so this test pins the wire contract.
const TEST_TOOL_WIRE_NAME = "tool2__system_x2eecho";

const TEST_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "system.echo",
    description: "Echo text.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

describe("responses-xai wire shim", () => {
  test("maps assistant tool calls and tool outputs to xAI Responses items", () => {
    const built = buildXaiResponsesInputItems([
      { role: "user", content: "run echo" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_echo",
            name: "system.echo",
            arguments: "{\"text\":\"hi\"}",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_echo",
        toolName: "system.echo",
        content: "hi",
      },
    ]);

    expect(built).toEqual({
      hasImages: false,
      input: [
        { role: "user", content: "run echo" },
        {
          type: "function_call",
          call_id: "call_echo",
          name: TEST_TOOL_WIRE_NAME,
          arguments: "{\"text\":\"hi\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_echo",
          output: "hi",
        },
      ],
    });
  });

  test("maps developer messages to system input items before the current user turn", () => {
    const built = buildXaiResponsesInputItems([
      { role: "user", content: "previous ask" },
      { role: "developer", content: [{ type: "text", text: "realtime update" }] },
      { role: "user", content: "current ask" },
    ]);

    expect(built).toEqual({
      hasImages: false,
      input: [
        { role: "user", content: "previous ask" },
        {
          role: "system",
          content: [{ type: "input_text", text: "realtime update" }],
        },
        { role: "user", content: "current ask" },
      ],
    });
  });

  test("injects multimodal tool-result images as a follow-up user item", () => {
    const messages: LLMMessage[] = [
      {
        role: "tool",
        toolCallId: "call_screenshot",
        toolName: "screenshot",
        content: [
          { type: "text", text: "captured" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,abc" },
          },
        ],
      },
    ];

    const built = buildXaiResponsesInputItems(messages);

    expect(built.hasImages).toBe(true);
    expect(built.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_screenshot",
        output: "captured",
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Here is the screenshot from the tool result above.",
          },
          {
            type: "input_image",
            image_url: "data:image/png;base64,abc",
          },
        ],
      },
    ]);
  });

  test("maps user data-url images to xAI input_image parts", () => {
    const built = buildXaiResponsesInputItems([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,YWJj" },
          },
        ],
      },
    ]);

    expect(built).toEqual({
      hasImages: true,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "inspect" },
            { type: "input_image", image_url: "data:image/png;base64,YWJj" },
          ],
        },
      ],
    });
  });

  test("uses extracted PDF text for local PDF attachments in xAI Responses", () => {
    const built = buildXaiResponsesInputItems([
      {
        role: "user",
        content: [
          { type: "text", text: "summarize" },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0xLjQK",
              },
              filename: "brief.pdf",
              fallbackText: "Extracted PDF text",
              fallbackTextTruncated: false,
            },
          ],
        },
    ]);

    expect(built).toEqual({
      hasImages: false,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize" },
            {
              type: "input_text",
              text:
                '<attached_pdf_text filename="brief.pdf" media_type="application/pdf" truncated="false">\nExtracted PDF text\n</attached_pdf_text>',
            },
          ],
        },
      ],
    });
  });

  test("passes xAI file references through as input_file parts", () => {
    const built = buildXaiResponsesInputItems([
      {
        role: "user",
        content: [
          { type: "text", text: "summarize" },
          {
            type: "input_file",
            file_url: "https://docs.x.ai/assets/api-examples/documents/report.pdf",
          },
        ] as unknown as LLMMessage["content"],
      },
    ]);

    expect(built).toEqual({
      hasImages: false,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "summarize" },
            {
              type: "input_file",
              file_url:
                "https://docs.x.ai/assets/api-examples/documents/report.pdf",
            },
          ],
        },
      ],
    });
  });

  test("builds flat xAI function tools and documented request controls", () => {
    const tools = toXaiResponsesTools([TEST_TOOL]);
    const request = buildXaiResponsesRequest({
      model: "grok-4-fast",
      messages: [{ role: "user", content: "hello" }],
      tools,
      options: {
        promptCacheKey: "session-1",
        includeEncryptedReasoning: true,
        parallelToolCalls: false,
        toolChoice: {
          type: "function",
          name: "system.echo",
        },
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: { type: "object", additionalProperties: false },
            strict: true,
          },
        },
      },
    });

    expect(request).toMatchObject({
      model: "grok-4-fast",
      store: false,
      prompt_cache_key: "session-1",
      include: [XAI_ENCRYPTED_REASONING_INCLUDE],
      parallel_tool_calls: false,
      // NOTE: tool_choice is currently NOT run through the MCP wire-name
      // encoding (normalizeXaiResponsesToolChoice passes the name through),
      // so a named tool_choice for a dotted tool references a name the
      // provider never saw in `tools`. This pins today's behavior; if the
      // shim starts encoding tool_choice too, update this to
      // TEST_TOOL_WIRE_NAME.
      tool_choice: {
        type: "function",
        function: { name: "system.echo" },
      },
      tools: [
        {
          type: "function",
          name: TEST_TOOL_WIRE_NAME,
          description: "Echo text.",
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          strict: true,
        },
      },
    });
  });

  test("preserves required tool_choice", () => {
    expect(resolveXaiResponsesToolChoice("required")).toBe("required");
  });
});
