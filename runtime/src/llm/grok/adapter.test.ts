import { describe, expect, test, vi } from "vitest";

import type { LLMMessage, LLMTool } from "../types.js";
import { GrokProvider } from "./adapter.js";

function buildXaiResponse(id: string, text: string): Record<string, unknown> {
  return {
    id,
    status: "completed",
    incomplete_details: null,
    model: "grok-4-fast",
    output_text: text,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
  };
}

const TEST_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "FileRead",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
};

function withResponse<T>(data: T) {
  return {
    withResponse: async () => ({
      data,
      response: new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      request_id: null,
    }),
  };
}

function streamFromEvents(
  events: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe("GrokProvider incremental continuation", () => {
  const previousMessages: LLMMessage[] = [
    { role: "user", content: "hello" },
  ];
  const currentMessages: LLMMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "follow up" },
  ];

  test("honors request-scoped model overrides when building requests", () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
    });

    const built = (provider as any).buildRequestPlan(previousMessages, {
      model: "grok-4-0709",
    });

    expect(built.params.model).toBe("grok-4-0709");
  });

  test("reuses previous_response_id and retries chat with full history on expiry", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      emitWarning: (warning) => warnings.push(warning),
    });

    (provider as any).incrementalTracker.recordRequest(
      (provider as any).buildIncrementalRequestShape({
        model: "grok-4-fast",
        store: false,
      }),
      previousMessages,
    );
    (provider as any).incrementalTracker.recordResponse({
      previousResponseId: "resp_prev",
      itemsAdded: [{ role: "assistant", content: "hi" }],
      recordedAtMs: Date.now(),
    });

    const requestBodies: Record<string, unknown>[] = [];
    (provider as any).client = {
      responses: {
        create: vi
          .fn()
          .mockImplementationOnce((params: Record<string, unknown>) => {
            requestBodies.push(params);
            throw Object.assign(new Error("previous_response_id expired"), {
              status: 404,
            });
          })
          .mockImplementationOnce((params: Record<string, unknown>) => {
            requestBodies.push(params);
            return withResponse(buildXaiResponse("resp_next", "done"));
          }),
      },
    };

    const result = await provider.chat(currentMessages);

    expect(result.content).toBe("done");
    expect(requestBodies[0]?.previous_response_id).toBe("resp_prev");
    expect(JSON.stringify(requestBodies[0]?.input)).toContain("follow up");
    expect(JSON.stringify(requestBodies[0]?.input)).not.toContain("hello");
    expect(requestBodies[1]?.previous_response_id).toBeUndefined();
    expect(JSON.stringify(requestBodies[1]?.input)).toContain("hello");
    expect(JSON.stringify(requestBodies[1]?.input)).toContain("follow up");
    expect(warnings).toContainEqual(
      expect.objectContaining({
        cause: "previous_response_id_expired",
      }),
    );
  });

  test("reuses previous_response_id and retries streaming with full history on expiry", async () => {
    const warnings: Array<{ cause: string; message: string }> = [];
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      emitWarning: (warning) => warnings.push(warning),
    });

    (provider as any).incrementalTracker.recordRequest(
      (provider as any).buildIncrementalRequestShape({
        model: "grok-4-fast",
        store: false,
      }),
      previousMessages,
    );
    (provider as any).incrementalTracker.recordResponse({
      previousResponseId: "resp_prev_stream",
      itemsAdded: [{ role: "assistant", content: "hi" }],
      recordedAtMs: Date.now(),
    });

    const requestBodies: Record<string, unknown>[] = [];
    (provider as any).client = {
      responses: {
        create: vi
          .fn()
          .mockImplementationOnce((params: Record<string, unknown>) => {
            requestBodies.push(params);
            throw Object.assign(new Error("previous response not found"), {
              status: 404,
            });
          })
          .mockImplementationOnce((params: Record<string, unknown>) => {
            requestBodies.push(params);
            return withResponse(
              streamFromEvents([
                {
                  type: "response.completed",
                  response: buildXaiResponse("resp_stream_next", "stream done"),
                },
              ]),
            );
          }),
      },
    };

    const chunks: string[] = [];
    const result = await provider.chatStream(
      currentMessages,
      (chunk) => {
        if (chunk.content.length > 0) {
          chunks.push(chunk.content);
        }
      },
    );

    expect(result.content).toBe("stream done");
    expect(chunks).toEqual([]);
    expect(requestBodies[0]?.previous_response_id).toBe("resp_prev_stream");
    expect(JSON.stringify(requestBodies[0]?.input)).toContain("follow up");
    expect(JSON.stringify(requestBodies[0]?.input)).not.toContain("hello");
    expect(requestBodies[1]?.previous_response_id).toBeUndefined();
    expect(JSON.stringify(requestBodies[1]?.input)).toContain("hello");
    expect(JSON.stringify(requestBodies[1]?.input)).toContain("follow up");
    expect(warnings).toContainEqual(
      expect.objectContaining({
        cause: "previous_response_id_expired",
      }),
    );
  });

  test("preserves large tool result bodies in function_call_output input items", () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
    });

    const largeReadResult = [
      "1→# AgenC Shell Implementation Plan",
      "",
      `${"plan-line ".repeat(1200)}`,
      "1251→If this plan and the implementation ever disagree, the implementation is wrong until the plan and decision log are updated together.",
    ].join("\n");

    const built = (provider as any).buildRequestPlan([
      { role: "user", content: "can you read PLAN.md" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read_plan",
            name: "FileRead",
            arguments: JSON.stringify({ path: "PLAN.md" }),
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_read_plan",
        toolName: "FileRead",
        content: largeReadResult,
      },
    ] satisfies LLMMessage[]);

    const functionCallOutput = (built.params.input as Array<Record<string, unknown>>)
      .find((item) => item.type === "function_call_output");

    expect(functionCallOutput).toBeDefined();
    expect(functionCallOutput?.call_id).toBe("call_read_plan");
    expect(functionCallOutput?.output).toBe(largeReadResult);
    expect(String(functionCallOutput?.output)).toContain(
      "AgenC Shell Implementation Plan",
    );
    expect(String(functionCallOutput?.output)).toContain(
      "implementation is wrong until the plan and decision log are updated together.",
    );
  });

  test("does not retry completed text responses with tool_choice none", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      tools: [TEST_TOOL],
    });
    const text =
      "**Extending ShellState for M5: Adding shopt map. Writing shopt.h first.**";
    const requestBodies: Record<string, unknown>[] = [];
    const create = vi.fn((params: Record<string, unknown>) => {
      requestBodies.push(params);
      return withResponse(buildXaiResponse("resp_text", text));
    });
    (provider as any).client = {
      responses: { create },
    };

    const result = await provider.chat([
      { role: "user", content: "read state" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read_state",
            name: "FileRead",
            arguments: JSON.stringify({ file_path: "include/agenc/state.h" }),
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_read_state",
        toolName: "FileRead",
        content: "state header",
      },
    ]);

    expect(result.content).toBe(text);
    expect(create).toHaveBeenCalledTimes(1);
    expect(requestBodies[0]?.tool_choice).not.toBe("none");
  });

  test("does not replace streamed text with a tool-disabled retry", async () => {
    const provider = new GrokProvider({
      apiKey: "xai-test",
      model: "grok-4-fast",
      tools: [TEST_TOOL],
    });
    const text =
      "**Extending ShellState for M5: Adding shopt map. Writing shopt.h first.**";
    const create = vi.fn(() =>
      withResponse(
        streamFromEvents([
          {
            type: "response.output_text.delta",
            delta: text,
          },
          {
            type: "response.completed",
            response: buildXaiResponse("resp_stream_text", text),
          },
        ]),
      )
    );
    (provider as any).client = {
      responses: { create },
    };
    const chunks: string[] = [];

    const result = await provider.chatStream(
      [
        { role: "user", content: "read state" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_read_state",
              name: "FileRead",
              arguments: JSON.stringify({ file_path: "include/agenc/state.h" }),
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_read_state",
          toolName: "FileRead",
          content: "state header",
        },
      ],
      (chunk) => {
        if (chunk.content.length > 0) chunks.push(chunk.content);
      },
    );

    expect(result.content).toBe(text);
    expect(chunks).toEqual([text]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
