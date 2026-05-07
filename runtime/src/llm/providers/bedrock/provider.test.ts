import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { BedrockProvider } from "./index.js";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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
      inferenceConfig: { maxTokens: 128, temperature: 0.2 },
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
        "Signature=fce0b51b3833e2186a19397da2d5eb962c1dc56afed0a03ca0373fee8efdb852",
    );
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

  it("parses toolUse responses and exposes chatStream as a non-streaming fallback", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        output: {
          message: {
            role: "assistant",
            content: [
              { text: "Need a lookup." },
              {
                toolUse: {
                  toolUseId: "toolu-1",
                  name: "lookup",
                  input: { query: "status" },
                },
              },
            ],
          },
        },
        stopReason: "tool_use",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
        },
      }),
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
    expect(response.toolCalls).toEqual([
      {
        id: "toolu-1",
        name: "lookup",
        arguments: "{\"query\":\"status\"}",
      },
    ]);
    expect(chunks).toEqual([
      { content: "Need a lookup.", done: false },
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
