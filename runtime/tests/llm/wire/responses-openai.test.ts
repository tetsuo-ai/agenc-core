import { describe, expect, test } from "vitest";
import type { LLMMessage, LLMTool } from "../types.js";
import {
  buildOpenAIResponsesRequest,
  parseOpenAIResponsesResponse,
} from "./responses-openai.js";

const TEST_TOOLS: LLMTool[] = [
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
        },
        required: ["cmd"],
      },
    },
  },
];

describe("buildOpenAIResponsesRequest", () => {
  test("keeps request instructions in the Responses instructions field", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "system", content: "stable prefix" },
        { role: "user", content: "hello" },
      ],
      tools: [],
      options: {
        systemPrompt: "base instructions",
        maxOutputTokens: 8192,
      },
    });

    expect(request.instructions).toBe("base instructions\n\nstable prefix");
    expect(request.max_output_tokens).toBe(8192);
  });

  test("serializes request-scoped temperature", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        temperature: 0.3,
      },
    });

    expect(request.temperature).toBe(0.3);
  });

  test("folds developer messages into instructions before current user input", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
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

    expect(request.instructions).toBe(
      "base instructions\n\nstable prefix\n\nrealtime update",
    );
    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "previous ask" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "current ask" }],
      },
    ]);
  });

  test("uses AgenC-style response items and disables store by default", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "look at this" },
        {
          role: "assistant",
          content: "working",
          toolCalls: [
            {
              id: "tool-1",
              name: "shell",
              arguments: "{\"cmd\":\"pwd\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "tool-1",
          toolName: "shell",
          content: "ok",
        },
      ],
      tools: TEST_TOOLS,
    });

    expect(request).toMatchObject({
      model: "gpt-5",
      instructions: "system prompt",
      stream: false,
      store: false,
    });
    expect(request.tools).toEqual([
      {
        type: "function",
        name: "shell",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string" },
          },
          required: ["cmd"],
        },
      },
    ]);
    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "look at this" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "working" }],
      },
      {
        type: "function_call",
        id: "fc_tool-1",
        call_id: "tool-1",
        name: "shell",
        arguments: "{\"cmd\":\"pwd\"}",
      },
      {
        type: "function_call_output",
        call_id: "tool-1",
        output: "ok",
      },
    ]);
  });

  test("drops orphan tool outputs before serializing responses input", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
        { role: "user", content: "run it" },
        {
          role: "tool",
          toolCallId: "call_missing",
          toolName: "shell",
          content: "done",
        },
      ],
      tools: TEST_TOOLS,
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "run it" }],
      },
    ]);
  });

  test("maps user images to input_image parts", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
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
      ],
      tools: [],
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect" },
          { type: "input_image", image_url: "data:image/png;base64,YWJj" },
        ],
      },
    ]);
  });

  test("maps user PDFs to input_file parts", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [
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
            },
          ],
        },
      ],
      tools: [],
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "summarize" },
          {
            type: "input_file",
            filename: "brief.pdf",
            file_data: "data:application/pdf;base64,JVBERi0xLjQK",
          },
        ],
      },
    ]);
  });

  test("preserves inline input_audio parts in responses input messages", () => {
    const request = buildOpenAIResponsesRequest({
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

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Transcribe this" },
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

  test("replays persisted data-url audio history as input_audio parts", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-audio",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              audio_url: {
                url: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10",
              },
            },
          ] as unknown as Array<Record<string, unknown>>,
        },
      ],
      tools: [],
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
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

  test("fails closed to a text placeholder when persisted audio references cannot be replayed", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-audio",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              audio_url: {
                url: "file:///tmp/example.wav",
              },
            },
          ] as unknown as Array<Record<string, unknown>>,
        },
      ],
      tools: [],
    });

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "[audio]" }],
      },
    ]);
  });

  test("forwards prompt_cache_key when the runtime shapes one for the session", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        promptCacheKey: "conv-123",
      },
    });

    expect(request.prompt_cache_key).toBe("conv-123");
  });

  test("forwards service_tier and text verbosity controls", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        serviceTier: "flex",
        modelVerbosity: "high",
      },
    });

    expect(request.service_tier).toBe("flex");
    expect(request.text).toEqual({ verbosity: "high" });
  });

  test("sends structured output schemas through Responses text.format", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        modelVerbosity: "low",
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: {
                answer: { type: "string" },
              },
            },
          },
        },
      },
    });

    expect(request.text).toEqual({
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          properties: {
            answer: { type: ["string", "null"] },
          },
          additionalProperties: false,
          required: ["answer"],
        },
      },
    });
  });

  test("forwards reasoning summary for reasoning-capable responses models", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        reasoningEffort: "high",
        reasoningSummary: "concise",
      },
    });

    expect(request.reasoning).toEqual({
      effort: "high",
      summary: "concise",
    });
  });

  test("omits reasoning summary when explicitly disabled", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      options: {
        reasoningSummary: "none",
      },
    });

    expect(request.reasoning).toBeUndefined();
  });

  test("preserves mixed text and image tool outputs as function_call_output content items", () => {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5",
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

    expect(request.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "inspect" }],
      },
      {
        type: "function_call",
        id: "fc_image",
        call_id: "call_image",
        name: "view_image",
        arguments: "{\"path\":\"/tmp/cat.png\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_image",
        output: [
          { type: "input_text", text: "Screenshot captured" },
          { type: "input_image", image_url: "data:image/png;base64,YWJj" },
        ],
      },
    ]);
  });
});

describe("parseOpenAIResponsesResponse", () => {
  const request = {
    model: "gpt-5",
    messages: [] as LLMMessage[],
    tools: TEST_TOOLS,
  };

  test("marks function-call outputs as tool_calls turns", () => {
    const response = parseOpenAIResponsesResponse(
      "gpt-5",
      {
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "shell",
            arguments: "{\"cmd\":\"pwd\"}",
          },
        ],
      },
      request,
    );

    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      {
        id: "call_1",
        name: "shell",
        arguments: "{\"cmd\":\"pwd\"}",
      },
    ]);
  });

  test("parses structured output from Responses output text", () => {
    const response = parseOpenAIResponsesResponse(
      "gpt-5",
      {
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "{\"answer\":\"ok\"}",
              },
            ],
          },
        ],
      },
      {
        model: "gpt-5",
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

    expect(response.structuredOutput).toEqual({
      type: "json_schema",
      name: "answer",
      rawText: "{\"answer\":\"ok\"}",
      parsed: { answer: "ok" },
    });
  });

  test("maps incomplete max_output_tokens to length", () => {
    const response = parseOpenAIResponsesResponse(
      "gpt-5",
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
      request,
    );

    expect(response.finishReason).toBe("length");
  });

  test("records responses endpoint markers in request metrics", () => {
    const response = parseOpenAIResponsesResponse(
      "gpt-5",
      {
        id: "resp_123",
        status: "completed",
        output: [],
      },
      request,
    );

    expect(response.requestMetrics).toMatchObject({
      endpoint: "/responses",
      responseId: "resp_123",
    });
  });
});
