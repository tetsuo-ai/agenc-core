import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { BedrockProvider } from "./index.js";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function eventStreamFrame(payload: Record<string, unknown>): Uint8Array {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const totalLength = 16 + payloadBytes.length;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, 0, false);
  view.setUint32(8, 0, false);
  frame.set(payloadBytes, 12);
  view.setUint32(totalLength - 4, 0, false);
  return frame;
}

function eventStreamResponse(
  events: readonly Record<string, unknown>[],
  status = 200,
): Response {
  return new Response(concatBytes(...events.map(eventStreamFrame)), {
    status,
    headers: { "content-type": "application/vnd.amazon.eventstream" },
  });
}

function payloadHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("providers/bedrock", () => {
  it("serializes Converse requests and signs them with AWS SigV4", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "signed response" }],
          },
        },
        stopReason: "end_turn",
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          cacheReadInputTokens: 2,
          cacheWriteInputTokens: 1,
        },
      }),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "session-token",
      region: "us-west-2",
      model: "amazon.nova-pro-v1:0",
      temperature: 0.2,
      fetchImpl,
      now: () => new Date("2024-01-02T03:04:05Z"),
    });

    const response = await provider.chat(
      [
        { role: "system", content: "system instructions" },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "calling tool",
          toolCalls: [
            {
              id: "call-1",
              name: "lookup",
              arguments: "{\"query\":\"AgenC\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "lookup",
          content: "tool result",
        },
      ],
      {
        systemPrompt: "runtime instructions",
        maxOutputTokens: 128,
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a value.",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "blocked",
              description: "Should not be sent.",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        toolRouting: { allowedToolNames: ["lookup"] },
        toolChoice: { type: "function", name: "lookup" },
        temperature: 0.4,
        stopSequences: ["END"],
      },
    );

    expect(response).toMatchObject({
      content: "signed response",
      finishReason: "stop",
      model: "amazon.nova-pro-v1:0",
      usage: {
        promptTokens: 12,
        completionTokens: 4,
        totalTokens: 16,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
    });
    expect(response.requestMetrics).toMatchObject({
      messageCount: 4,
      toolCount: 1,
      toolNames: ["lookup"],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse",
    );
    expect(init?.method).toBe("POST");

    const bodyText = String(init?.body);
    const request = JSON.parse(bodyText) as Record<string, unknown>;
    expect(request).toMatchObject({
      system: [
        { text: "runtime instructions" },
        { text: "system instructions" },
      ],
      messages: [
        { role: "user", content: [{ text: "hello" }] },
        {
          role: "assistant",
          content: [
            { text: "calling tool" },
            {
              toolUse: {
                toolUseId: "call-1",
                name: "lookup",
                input: { query: "AgenC" },
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "call-1",
                content: [{ text: "tool result" }],
                status: "success",
              },
            },
          ],
        },
      ],
      inferenceConfig: {
        maxTokens: 128,
        temperature: 0.4,
        stopSequences: ["END"],
      },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "lookup",
              description: "Look up a value.",
              inputSchema: {
                json: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"],
                },
              },
            },
          },
        ],
        toolChoice: { tool: { name: "lookup" } },
      },
    });

    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("host")).toBe(
      "bedrock-runtime.us-west-2.amazonaws.com",
    );
    expect(headers.get("x-amz-date")).toBe("20240102T030405Z");
    expect(headers.get("x-amz-security-token")).toBe("session-token");
    expect(headers.get("x-amz-content-sha256")).toBe(payloadHash(bodyText));
    expect(headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20240102/us-west-2/bedrock/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, " +
        "Signature=14b03391fc44fbb9113c2e9314b5088756f27cbf2ebb6894bf6ec5aae8bb0713",
    );
  });

  it("encodes dotted MCP tool names across tools, toolChoice, and replayed toolUse, and decodes responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        output: {
          message: {
            role: "assistant",
            content: [
              {
                toolUse: {
                  toolUseId: "call-2",
                  // The model echoes the encoded wire name; the parser
                  // must decode it back to the dotted internal form.
                  name: "mcp__memory__search_nodes",
                  input: { query: "next" },
                },
              },
            ],
          },
        },
        stopReason: "tool_use",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      }),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      region: "us-west-2",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
      now: () => new Date("2024-01-02T03:04:05Z"),
    });

    const response = await provider.chat(
      [
        { role: "user", content: "search" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "mcp.memory.search_nodes",
              arguments: "{\"query\":\"AgenC\"}",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "mcp.memory.search_nodes",
          content: "prior result",
        },
      ],
      {
        tools: [
          {
            type: "function",
            function: {
              name: "mcp.memory.search_nodes",
              description: "Search the memory graph.",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
              },
            },
          },
        ],
        toolChoice: { type: "function", name: "mcp.memory.search_nodes" },
      },
    );

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const request = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: unknown }>;
      toolConfig: {
        tools: Array<{ toolSpec: { name: string } }>;
        toolChoice: { tool: { name: string } };
      };
    };

    // The Converse ToolSpecification name pattern is `[a-zA-Z0-9_-]+`
    // (1-64 chars) — dots are rejected, so the dotted internal name must
    // ship in the bijective wire encoding. Hardcoded literal on purpose:
    // pins the wire contract.
    expect(request.toolConfig.tools[0]!.toolSpec.name).toBe(
      "mcp__memory__search_nodes",
    );
    // toolChoice must reference the encoded toolSpec entry byte-for-byte.
    expect(request.toolConfig.toolChoice).toEqual({
      tool: { name: request.toolConfig.tools[0]!.toolSpec.name },
    });
    // Replayed assistant toolUse blocks carry the encoded name too, so the
    // conversation history matches the toolSpec catalog.
    expect(request.messages[1]!.content).toEqual([
      {
        toolUse: {
          toolUseId: "call-1",
          name: "mcp__memory__search_nodes",
          input: { query: "AgenC" },
        },
      },
    ]);
    // The response parser decodes the echoed wire name back to the
    // dotted internal-registry form before dispatch.
    expect(response.toolCalls).toEqual([
      {
        id: "call-2",
        name: "mcp.memory.search_nodes",
        arguments: "{\"query\":\"next\"}",
      },
    ]);
  });

  it("decodes encoded MCP tool names from ConverseStream tool blocks", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      eventStreamResponse([
        { messageStart: { role: "assistant" } },
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: {
              toolUse: {
                toolUseId: "toolu-2",
                name: "mcp__memory__search_nodes",
              },
            },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: "{\"query\":\"status\"}" } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: "tool_use" } },
      ]),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
      now: () => new Date("2024-01-02T03:04:05Z"),
    });

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      () => {},
    );

    expect(response.toolCalls).toEqual([
      {
        id: "toolu-2",
        name: "mcp.memory.search_nodes",
        arguments: "{\"query\":\"status\"}",
      },
    ]);
  });

  it("encodes reserved characters in model identifiers before signing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "custom model response" }],
          },
        },
        stopReason: "end_turn",
      }),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      region: "us-west-2",
      model:
        "arn:aws:bedrock:us-west-2:123456789012:provisioned-model/abc123",
      fetchImpl,
      now: () => new Date("2024-01-02T03:04:05Z"),
    });

    await provider.chat([{ role: "user", content: "hello" }]);

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/" +
        "arn%3Aaws%3Abedrock%3Aus-west-2%3A123456789012%3Aprovisioned-model%2Fabc123" +
        "/converse",
    );
    expect(new Headers(init?.headers as HeadersInit).get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20240102\/us-west-2\/bedrock\/aws4_request, /,
    );
  });

  it("uses request-scoped model overrides for URL signing and response metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "override response" }],
          },
        },
        stopReason: "end_turn",
      }),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      region: "us-west-2",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
      now: () => new Date("2024-01-02T03:04:05Z"),
    });

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "amazon.nova-lite-v1:0" },
    );

    const [requestUrl] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse",
    );
    expect(response.model).toBe("amazon.nova-lite-v1:0");
  });

  it("serializes empty text messages without blank content blocks", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          output: {
            message: {
              role: "assistant",
              content: [{ text: "placeholder accepted" }],
            },
          },
          stopReason: "end_turn",
        }),
      ),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "" }]);
    await provider.chat([{ role: "user", content: "   \n\t" }]);

    for (const [, init] of fetchImpl.mock.calls) {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: Array<{ text?: string }> }>;
      };
      expect(request.messages[0]?.content).toEqual([
        { text: "[empty message]" },
      ]);
    }
  });

  it("rejects unsupported non-tool message content before sending", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
    });

    await expect(
      provider.chat([
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
        },
      ]),
    ).rejects.toThrow(/unsupported user message content/);
    await expect(
      provider.chat([
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "AA==",
              },
            },
          ],
        },
      ]),
    ).rejects.toThrow(/unsupported user message content/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serializes empty tool results without blank text blocks", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "tool result accepted" }],
          },
        },
        stopReason: "end_turn",
      }),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
    });

    await provider.chat([
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "lookup",
        content: "   ",
      },
    ]);

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const request = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: Array<{ toolResult?: { content: unknown } }> }>;
    };
    expect(request.messages[0]?.content[0]?.toolResult?.content).toEqual([
      { json: null },
    ]);
  });

  it("serializes tool-call-only assistant turns without placeholder text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "accepted" }],
          },
        },
        stopReason: "end_turn",
      }),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
    });

    await provider.chat([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "lookup", arguments: "{\"query\":\"status\"}" },
        ],
      },
    ]);

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const request = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(request.messages[0]?.content).toEqual([
      {
        toolUse: {
          toolUseId: "call-1",
          name: "lookup",
          input: { query: "status" },
        },
      },
    ]);
  });

  it("rejects a filtered-out specific tool choice before sending", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
    });

    await expect(
      provider.chat(
        [{ role: "user", content: "hello" }],
        {
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                description: "Look up a value.",
                parameters: { type: "object", properties: {} },
              },
            },
            {
              type: "function",
              function: {
                name: "blocked",
                description: "Blocked by routing.",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          toolRouting: { allowedToolNames: ["lookup"] },
          toolChoice: { type: "function", name: "blocked" },
        },
      ),
    ).rejects.toThrow(/toolChoice references unavailable tool: blocked/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on malformed replayed tool call arguments", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
    });

    await expect(
      provider.chat([
        {
          role: "assistant",
          content: "calling tool",
          toolCalls: [
            { id: "call-1", name: "lookup", arguments: "{\"query\"" },
          ],
        },
      ]),
    ).rejects.toThrow(/malformed tool call arguments/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("streams ConverseStream text, tool input, final tool calls, and usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      eventStreamResponse([
        { messageStart: { role: "assistant" } },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: "Need " },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: "a lookup." },
          },
        },
        {
          contentBlockStart: {
            contentBlockIndex: 1,
            start: {
              toolUse: {
                toolUseId: "toolu-1",
                name: "lookup",
              },
            },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { toolUse: { input: "{\"query\"" } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { toolUse: { input: ":\"status\"}" } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 1 } },
        { messageStop: { stopReason: "tool_use" } },
        {
          metadata: {
            usage: {
              inputTokens: 3,
              outputTokens: 2,
              totalTokens: 5,
              cacheReadInputTokens: 1,
              cacheWriteInputTokens: 1,
            },
          },
        },
      ]),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
      now: () => new Date("2024-01-02T03:04:05Z"),
    });
    const chunks: Array<Record<string, unknown>> = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push(chunk as unknown as Record<string, unknown>),
    );

    expect(response.finishReason).toBe("tool_calls");
    expect(response.content).toBe("Need a lookup.");
    expect(response.usage).toMatchObject({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
      cachedInputTokens: 1,
      cacheCreationInputTokens: 1,
    });
    expect(response.requestMetrics.stream).toBe(true);
    expect(response.toolCalls).toEqual([
      {
        id: "toolu-1",
        name: "lookup",
        arguments: "{\"query\":\"status\"}",
      },
    ]);
    expect(chunks).toMatchObject([
      { content: "Need ", done: false },
      { content: "a lookup.", done: false },
      {
        content: "",
        done: false,
        toolInputBlockStart: {
          callId: "toolu-1",
          index: 1,
          contentBlock: {
            type: "tool_use",
            id: "toolu-1",
            name: "lookup",
            input: {},
          },
        },
      },
      {
        content: "",
        done: false,
        toolInputDelta: {
          callId: "toolu-1",
          index: 1,
          partialJson: "{\"query\"",
        },
      },
      {
        content: "",
        done: false,
        toolInputDelta: {
          callId: "toolu-1",
          index: 1,
          partialJson: ":\"status\"}",
        },
      },
      {
        content: "",
        done: false,
        toolCalls: [
          {
            id: "toolu-1",
            name: "lookup",
            arguments: "{\"query\":\"status\"}",
          },
        ],
      },
      {
        content: "",
        done: true,
        toolCalls: [
          {
            id: "toolu-1",
            name: "lookup",
            arguments: "{\"query\":\"status\"}",
          },
        ],
      },
    ]);
    const [requestUrl] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse-stream",
    );
  });

  it("emits only the done chunk for tool-call-only stream responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      eventStreamResponse([
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: {
              toolUse: {
                toolUseId: "toolu-1",
                name: "lookup",
              },
            },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: "{\"query\":\"status\"}" } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: "tool_use" } },
      ]),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
    });
    const chunks: Array<Record<string, unknown>> = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push(chunk as unknown as Record<string, unknown>),
    );

    expect(response.content).toBe("");
    expect(chunks).toMatchObject([
      {
        content: "",
        done: false,
        toolInputBlockStart: {
          callId: "toolu-1",
          index: 0,
        },
      },
      {
        content: "",
        done: false,
        toolInputDelta: {
          callId: "toolu-1",
          index: 0,
          partialJson: "{\"query\":\"status\"}",
        },
      },
      {
        content: "",
        done: false,
        toolCalls: [
          {
            id: "toolu-1",
            name: "lookup",
            arguments: "{\"query\":\"status\"}",
          },
        ],
      },
      {
        content: "",
        done: true,
        toolCalls: [
          {
            id: "toolu-1",
            name: "lookup",
            arguments: "{\"query\":\"status\"}",
          },
        ],
      },
    ]);
  });

  it("surfaces ConverseStream event errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      eventStreamResponse([
        {
          modelStreamErrorException: {
            message: "model stream broke",
          },
        },
      ]),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
    });

    await expect(
      provider.chatStream([{ role: "user", content: "hello" }], () => {}),
    ).rejects.toThrow(/model stream broke/);
  });

  it("surfaces Bedrock HTTP errors with the provider message", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ message: "The security token included in the request is invalid." }, 403),
    );
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      model: "amazon.nova-pro-v1:0",
      fetchImpl,
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow(
      /HTTP 403.*security token included in the request is invalid/i,
    );
  });

  it("fails closed when credentials are incomplete", async () => {
    const provider = new BedrockProvider({
      accessKeyId: "AKIDEXAMPLE",
      model: "amazon.nova-pro-v1:0",
    });

    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow(/AWS_ACCESS_KEY_ID.*AWS_SECRET_ACCESS_KEY/);
    await expect(provider.healthCheck()).resolves.toBe(false);
  });
});
