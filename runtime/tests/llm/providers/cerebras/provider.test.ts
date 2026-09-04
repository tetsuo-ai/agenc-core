import { Buffer } from "node:buffer";

import { describe, expect, test, vi } from "vitest";

import { resolveProviderCapabilityEntry } from "../../capabilities.js";
import { createProvider, readProviderIdentity } from "../../provider.js";
import { resolveProviderCredentialAuthority } from "../../provider-options.js";
import {
  resolveModelCatalogMetadata,
  resolveRegisteredModelCatalogEntry,
} from "../../registry/model-catalog.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../registry/provider-info.js";
import type { LLMContentPart, LLMMessage, LLMTool } from "../../types.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../wire/capability-gating.js";
import { buildChatCompletionsRequest } from "../../wire/chat-completions.js";
import { CerebrasProvider } from "./index.js";

function successfulChat(
  model: string,
  content = "ok",
  extraMessage: Record<string, unknown> = {},
): Response {
  const payload = {
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content, ...extraMessage },
      },
    ],
    id: "chatcmpl_cerebras",
    model,
    usage: { completion_tokens: 1, prompt_tokens: 3, total_tokens: 4 },
  };
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(frames: readonly string[]): Response {
  const encode = new TextEncoder();
  const chunks = frames.map((frame) => encode.encode(frame));
  let nextChunk = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[nextChunk];
      nextChunk += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function createSuccessfulProvider(model: string) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(successfulChat(model));
  const provider = new CerebrasProvider({
    apiKey: "cerebras-test",
    model,
    fetchImpl,
  });
  return { fetchImpl, provider };
}

function requestBody<T>(fetchImpl: FetchMock, callIndex = 0): T {
  return JSON.parse(String(fetchImpl.mock.calls[callIndex]?.[1]?.body)) as T;
}

interface ReasoningExchange {
  readonly reasoning: string;
  readonly callId: string;
  readonly toolName: string;
  readonly result: string;
  readonly provider?: string;
  readonly model?: string;
}

function reasoningToolExchanges(
  destinationModel: string,
  exchanges: readonly ReasoningExchange[],
): LLMMessage[] {
  return exchanges.flatMap((exchange) => [
    {
      role: "assistant",
      content: "",
      providerReasoningContent: exchange.reasoning,
      providerReasoningProvenance: {
        provider: exchange.provider ?? "cerebras",
        model: exchange.model ?? destinationModel,
      },
      toolCalls: [
        {
          id: exchange.callId,
          name: exchange.toolName,
          arguments: "{}",
        },
      ],
    },
    {
      role: "tool",
      toolCallId: exchange.callId,
      toolName: exchange.toolName,
      content: exchange.result,
    },
  ]);
}

function toolResultConversation(
  userContent: LLMMessage["content"],
  text: string,
  imageUrls: readonly string[],
): LLMMessage[] {
  const imageParts: LLMContentPart[] = imageUrls.map((url) => ({
    type: "image_url",
    image_url: { url },
  }));
  return [
    { role: "user", content: userContent },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_read", name: "FileRead", arguments: "{}" }],
    },
    {
      role: "tool",
      toolCallId: "call_read",
      toolName: "FileRead",
      content: [{ type: "text", text }, ...imageParts],
    },
  ];
}

const ECHO_TOOL: LLMTool = {
  type: "function",
  function: {
    name: "system.echo",
    description: "Echo text.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
};

const VALID_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const VALID_JPEG_DATA_URI = `data:image/jpeg;base64,${Buffer.from([
  0xff,
  0xd8,
  0xff,
  0xd9,
]).toString("base64")}`;

describe("CerebrasProvider", () => {
  test("factory uses the Cerebras v2 chat endpoint and bearer auth", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.cerebras;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = createProvider("cerebras", {
      apiKey: "cerebras-test",
      extra: { fetchImpl },
    });

    expect(provider).toBeInstanceOf(CerebrasProvider);
    expect(readProviderIdentity(provider)).toBe("cerebras");

    await provider.chat([{ role: "user", content: "hello" }], {
      reasoningEffort: "high",
    });

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS.cerebras}/chat/completions`,
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer cerebras-test");
    expect(headers.get("x-cerebras-version-patch")).toBe("2");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model,
      stream: false,
      reasoning_effort: "high",
    });
    expect(body.service_tier).toBeUndefined();
    expect(body.max_completion_tokens).toBeTypeOf("number");
    expect(body.max_tokens).toBeUndefined();
  });

  test("passes an explicit service tier through to a dedicated endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("private-dedicated-model"),
    );
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      baseURL: "https://dedicated.cerebras.invalid/v1",
      model: "private-dedicated-model",
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }], {
      serviceTier: "priority",
    });

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      "https://dedicated.cerebras.invalid/v1/chat/completions",
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.service_tier).toBe("priority");
  });

  test("requires an explicit resolved Cerebras credential", () => {
    expect(() => createProvider("cerebras", {})).toThrow(/cerebras.*apiKey/i);
  });

  test("does not vend Cerebras credentials through managed auth", () => {
    const vendKey = vi.fn();
    expect(() =>
      createProvider("cerebras", {
        extra: {
          authBackend: { vendKey },
          sessionId: "session-cerebras",
        },
      }),
    ).toThrow(/cerebras.*apiKey/i);
    expect(vendKey).not.toHaveBeenCalled();
  });

  test("resolves only the canonical Cerebras credential and endpoint env", () => {
    const resolved = resolveProviderCredentialAuthority(
      "cerebras",
      { model: BUILT_IN_PROVIDER_DEFAULT_MODELS.cerebras },
      {
        CEREBRAS_API_KEY: "cerebras-environment-test",
        CEREBRAS_BASE_URL: "https://cerebras.invalid/v1",
        OPENAI_API_KEY: "must-not-cross-provider-boundary",
      },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "environment",
      provenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "CEREBRAS_API_KEY" }],
      },
    });
    expect(resolved.factoryOptions).toMatchObject({
      apiKey: "cerebras-environment-test",
      baseURL: "https://cerebras.invalid/v1",
    });
  });

  test.each([
    ["gpt-oss-120b", 131_072, 40_960, 40_960, false, false, false, ["low", "medium", "high"], "medium"],
    ["qwen-3.8-27b", 65_536, 8_000, 32_768, true, true, true, ["none", "low", "medium", "high"], "high"],
    ["gemma-4-31b", 131_072, 40_960, 40_960, false, true, true, ["none", "low", "medium", "high"], "none"],
  ] as const)(
    "registers %s with verified model metadata and capabilities",
    (
      model,
      contextWindow,
      maxOutputTokens,
      maxOutputTokensUpperLimit,
      cappedDefault,
      vision,
      parallel,
      reasoningLevels,
      defaultReasoningLevel,
    ) => {
      expect(BUILT_IN_PROVIDER_MODEL_CATALOG.cerebras).toContain(model);
      expect(resolveModelCatalogMetadata({ provider: "cerebras", model }))
        .toEqual({
          contextWindow,
          maxContextWindow: contextWindow,
          maxOutputTokens,
          maxOutputTokensUpperLimit,
          ...(cappedDefault
            ? { maxOutputTokensCappedDefault: true }
            : {}),
        });
      expect(resolveProviderCapabilityEntry({ provider: "cerebras", model }))
        .toMatchObject({
          supportsToolUse: true,
          supportsImageInput: vision,
          supportsVisionInput: vision,
          acceptsImageHistory: vision,
          supportsStructuredOutput: true,
          supportsStructuredOutputWithTools: false,
          supportsExtendedThinking: true,
          acceptsThinkingHistory: true,
          acceptsReasoningEffort: reasoningLevels.length > 0,
        });
      const catalogEntry = resolveRegisteredModelCatalogEntry({
        provider: "cerebras",
        model,
      });
      expect(catalogEntry).toMatchObject({
        supportedReasoningLevels: [...reasoningLevels],
        supportsParallelToolCalls: parallel,
        supportsStructuredOutputWithTools: false,
        additionalSpeedTiers: [],
      });
      expect(catalogEntry?.defaultReasoningLevel).toBe(defaultReasoningLevel);
    },
  );

  test("keeps Cerebras reasoning separate and replays it on the same model", async () => {
    const model = "qwen-3.8-27b";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successfulChat(model, "", {
          reasoning: "opaque Cerebras reasoning",
          tool_calls: [
            {
              id: "call_echo",
              type: "function",
              function: {
                name: "tool2__system_x2eecho",
                arguments: '{"text":"ok"}',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(successfulChat(model));
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model,
      tools: [ECHO_TOOL],
      fetchImpl,
    });

    const response = await provider.chat([
      { role: "user", content: "call echo" },
    ]);
    expect(response.content).toBe("");
    expect(response.thinking?.[0]?.text).toBe("opaque Cerebras reasoning");
    expect(response.providerReasoningContent).toBe(
      "opaque Cerebras reasoning",
    );
    expect(response.providerReasoningProvenance).toEqual({
      provider: "cerebras",
      model,
    });

    await provider.chat([
      { role: "user", content: "call echo" },
      {
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
        providerReasoningContent: response.providerReasoningContent,
        providerReasoningProvenance: response.providerReasoningProvenance,
      },
      {
        role: "tool",
        toolCallId: "call_echo",
        toolName: "system.echo",
        content: "ok",
      },
    ]);

    const replayBody = requestBody<{
      messages: Array<Record<string, unknown>>;
    }>(fetchImpl, 1);
    expect(replayBody.messages).toEqual([
      { role: "user", content: "call echo" },
      expect.objectContaining({
        role: "assistant",
        reasoning: "opaque Cerebras reasoning",
        tool_calls: expect.any(Array),
      }),
      {
        role: "tool",
        content: "ok",
        tool_call_id: "call_echo",
      },
    ]);
    expect(replayBody.messages[1]?.reasoning_content).toBeUndefined();
  });

  test.each(["gpt-oss-120b", "qwen-3.8-27b"] as const)(
    "preserves each hidden reasoning state through a multi-turn %s tool loop",
    async (model) => {
      const { fetchImpl, provider } = createSuccessfulProvider(model);

      await provider.chat([
        { role: "user", content: "complete both steps" },
        ...reasoningToolExchanges(model, [
          {
            reasoning: "reasoning for step one",
            callId: "call_one",
            toolName: "First",
            result: "first result",
          },
          {
            reasoning: "reasoning for step two",
            callId: "call_two",
            toolName: "Second",
            result: "second result",
          },
        ]),
        { role: "user", content: "finish" },
      ]);

      const body = requestBody<{
        messages: Array<Record<string, unknown>>;
      }>(fetchImpl);
      const assistantMessages = body.messages.filter(
        (message) => message.role === "assistant",
      );
      expect(assistantMessages).toEqual([
        expect.objectContaining({
          content: "",
          reasoning: "reasoning for step one",
          tool_calls: expect.any(Array),
        }),
        expect.objectContaining({
          content: "",
          reasoning: "reasoning for step two",
          tool_calls: expect.any(Array),
        }),
      ]);
      expect(JSON.stringify(body)).not.toContain("reasoning_content");
    },
  );

  test("never replays hidden reasoning across Cerebras models or providers", async () => {
    const model = "qwen-3.8-27b";
    const { fetchImpl, provider } = createSuccessfulProvider(model);

    await provider.chat([
      { role: "user", content: "continue safely" },
      ...reasoningToolExchanges(model, [
        {
          reasoning: "foreign provider state",
          callId: "call_foreign",
          toolName: "First",
          result: "foreign result",
          provider: "qwen",
        },
        {
          reasoning: "other Cerebras model state",
          callId: "call_other",
          toolName: "Second",
          result: "other result",
          model: "gpt-oss-120b",
        },
        {
          reasoning: "exact Cerebras model state",
          callId: "call_exact",
          toolName: "Third",
          result: "exact result",
        },
      ]),
      { role: "user", content: "finish" },
    ]);

    const body = requestBody<{
      messages: Array<Record<string, unknown>>;
    }>(fetchImpl);
    const assistantMessages = body.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistantMessages[0]?.reasoning).toBeUndefined();
    expect(assistantMessages[1]?.reasoning).toBeUndefined();
    expect(assistantMessages[2]?.reasoning).toBe(
      "exact Cerebras model state",
    );
    expect(JSON.stringify(body)).not.toContain("foreign provider state");
    expect(JSON.stringify(body)).not.toContain("other Cerebras model state");
  });

  test("streams delta.reasoning without mixing it into visible content", async () => {
    const model = "gpt-oss-120b";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        `data: {"model":"${model}","choices":[{"index":0,"delta":{"reasoning":"think"}}]}\n\n`,
        `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"done"}}]}\n\n`,
        'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model,
      fetchImpl,
    });

    const response = await provider.chatStream(
      [{ role: "user", content: "work" }],
      () => {},
    );

    expect(response.content).toBe("done");
    expect(response.thinking?.[0]?.text).toBe("think");
    expect(response.providerReasoningContent).toBe("think");
    expect(response.providerReasoningProvenance).toEqual({
      provider: "cerebras",
      model,
    });
  });

  test("uses the documented chat response_format for structured output", async () => {
    const model = "qwen-3.8-27b";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model, '{"answer":"ok"}'),
    );
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model,
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "answer as JSON" }],
      {
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
      },
    );

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "answer", strict: true },
    });
    expect(response.structuredOutput?.parsed).toEqual({ answer: "ok" });
  });

  test("falls back from strict mode without erasing unsupported schema constraints", async () => {
    const model = "qwen-3.8-27b";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model, '{"selected_candidate_ids":["memory-1"]}'),
    );
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model,
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "select relevant memories" }],
      {
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "agenc_memory_selector_v1",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                selected_candidate_ids: {
                  type: "array",
                  maxItems: 5,
                  items: { type: "string" },
                },
              },
              required: ["selected_candidate_ids"],
            },
          },
        },
      },
    );

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as {
      response_format: {
        json_schema: {
          strict: boolean;
          schema: Record<string, unknown>;
        };
      };
    };
    expect(body.response_format.json_schema.strict).toBe(false);
    expect(body.response_format.json_schema.schema).toMatchObject({
      properties: {
        selected_candidate_ids: {
          type: "array",
          maxItems: 5,
          items: { type: "string" },
        },
      },
    });
    expect(response.structuredOutput?.parsed).toEqual({
      selected_candidate_ids: ["memory-1"],
    });
  });

  test("rejects structured output combined with tools before HTTP", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model: "gpt-oss-120b",
      tools: [ECHO_TOOL],
      fetchImpl,
    });

    await expect(
      provider.chat([{ role: "user", content: "answer with a tool as JSON" }], {
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
      }),
    ).rejects.toThrow(/does not support combining structured outputs with function tools/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ["qwen-3.8-27b", "relay_as_user", true],
    ["gemma-4-31b", "relay_as_user", true],
    ["gpt-oss-120b", "strip", false],
    ["future-cerebras-model", "strip", false],
  ] as const)(
    "applies model-aware tool-result image policy for %s",
    async (model, policy, relaysImage) => {
      const { fetchImpl, provider } = createSuccessfulProvider(model);

      await provider.chat(
        toolResultConversation("inspect", "Image Size: 10x10.", [
          VALID_PNG_DATA_URI,
        ]),
      );

      const body = requestBody<{
        messages: Array<Record<string, unknown>>;
      }>(fetchImpl);
      expect(body.messages[2]).toEqual({
        role: "tool",
        content: "Image Size: 10x10.",
        tool_call_id: "call_read",
      });
      expect(JSON.stringify(body).includes("image_url")).toBe(relaysImage);
      expect(
        chatCompletionsCapabilityHintsForProvider("cerebras", model),
      ).toMatchObject({ toolResultImagePolicy: policy });
    },
  );

  test("accepts only base64 PNG and JPEG direct image inputs on vision models", async () => {
    const model = "qwen-3.8-27b";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model,
      fetchImpl,
    });

    await provider.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "compare these" },
          { type: "image_url", image_url: { url: VALID_PNG_DATA_URI } },
          { type: "image_url", image_url: { url: VALID_JPEG_DATA_URI } },
        ],
      },
    ]);

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as { messages: Array<{ content: unknown }> };
    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "compare these" },
      { type: "image_url", image_url: { url: VALID_PNG_DATA_URI } },
      { type: "image_url", image_url: { url: VALID_JPEG_DATA_URI } },
    ]);
  });

  test.each([
    "https://example.invalid/image.png",
    "data:image/webp;base64,UklGRg==",
    "data:image/gif;base64,R0lGODlh",
    "data:image/png;base64,R0lGODlh",
    "data:image/jpeg;base64,not-base64",
  ])("rejects unsupported direct image input before HTTP: %s", async (url) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model: "qwen-3.8-27b",
      fetchImpl,
    });

    await expect(
      provider.chat([
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url } }],
        },
      ]),
    ).rejects.toThrow(/base64 PNG or JPEG data URI/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["gpt-oss-120b", "private-dedicated-model"])(
    "rejects direct images before HTTP for text-only model %s",
    async (model) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new CerebrasProvider({
        apiKey: "cerebras-test",
        model,
        fetchImpl,
      });

      await expect(
        provider.chat([
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: VALID_PNG_DATA_URI } },
            ],
          },
        ]),
      ).rejects.toThrow(/does not support image input/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test("rejects more than ten direct images before HTTP", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model: "qwen-3.8-27b",
      fetchImpl,
    });

    await expect(
      provider.chat([
        {
          role: "user",
          content: Array.from({ length: 11 }, () => ({
            type: "image_url" as const,
            image_url: { url: VALID_PNG_DATA_URI },
          })),
        },
      ]),
    ).rejects.toThrow(/at most 10 images/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects direct image payloads above the 10 MiB request limit", async () => {
    const oversizedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(10 * 1024 * 1024 - 7),
    ]);
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model: "qwen-3.8-27b",
      fetchImpl,
    });

    await expect(
      provider.chat([
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${oversizedPng.toString("base64")}`,
              },
            },
          ],
        },
      ]),
    ).rejects.toThrow(/10 MiB total request payload limit/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("counts the complete encoded HTTP body toward the 10 MiB limit", () => {
    expect(() =>
      buildChatCompletionsRequest({
        model: "qwen-3.8-27b",
        messages: [
          { role: "user", content: "x".repeat(10 * 1024 * 1024) },
        ],
        tools: [],
        providerCapabilityHints:
          chatCompletionsCapabilityHintsForProvider(
            "cerebras",
            "qwen-3.8-27b",
          ),
      }),
    ).toThrow(/10 MiB total payload limit/i);
  });

  test("rejects images outside user messages before HTTP", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model: "qwen-3.8-27b",
      fetchImpl,
    });

    await expect(
      provider.chat([
        {
          role: "assistant",
          content: [
            { type: "image_url", image_url: { url: VALID_PNG_DATA_URI } },
          ],
        },
      ]),
    ).rejects.toThrow(/only in user messages/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("strips invalid tool media while preserving its textual result", async () => {
    const model = "qwen-3.8-27b";
    const { fetchImpl, provider } = createSuccessfulProvider(model);

    await provider.chat(
      toolResultConversation("inspect", "The tool result remains.", [
        "https://example.invalid/image.png",
        "data:image/webp;base64,UklGRg==",
        "data:image/gif;base64,R0lGODlh",
      ]),
    );

    const body = requestBody<{
      messages: Array<Record<string, unknown>>;
    }>(fetchImpl);
    expect(body.messages[2]).toEqual({
      role: "tool",
      content: "The tool result remains.",
      tool_call_id: "call_read",
    });
    expect(JSON.stringify(body)).not.toContain("image_url");
  });

  test("caps direct and tool-result images at ten total", async () => {
    const model = "qwen-3.8-27b";
    const { fetchImpl, provider } = createSuccessfulProvider(model);

    await provider.chat(
      toolResultConversation(
        Array.from({ length: 9 }, () => ({
          type: "image_url" as const,
          image_url: { url: VALID_PNG_DATA_URI },
        })),
        "two candidate images",
        [VALID_PNG_DATA_URI, VALID_JPEG_DATA_URI],
      ),
    );

    const body = requestBody<{
      messages: Array<Record<string, unknown>>;
    }>(fetchImpl);
    expect(body.messages[2]).toEqual({
      role: "tool",
      content: "two candidate images",
      tool_call_id: "call_read",
    });
    expect(JSON.stringify(body).match(/"type":"image_url"/gu)).toHaveLength(10);
  });

  test("drops tool-result images that would exceed the 10 MiB request total", async () => {
    const largePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(6 * 1024 * 1024),
    ]);
    const secondLargePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2 * 1024 * 1024),
    ]);
    const model = "qwen-3.8-27b";
    const { fetchImpl, provider } = createSuccessfulProvider(model);

    await provider.chat(
      toolResultConversation(
        [
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${largePng.toString("base64")}`,
            },
          },
        ],
        "image omitted, text retained",
        [`data:image/png;base64,${secondLargePng.toString("base64")}`],
      ),
    );

    const body = requestBody<{
      messages: Array<Record<string, unknown>>;
    }>(fetchImpl);
    expect(body.messages[2]).toEqual({
      role: "tool",
      content: "image omitted, text retained",
      tool_call_id: "call_read",
    });
    expect(JSON.stringify(body).match(/"type":"image_url"/gu)).toHaveLength(1);
  });

  test("keeps v2 tool controls model-safe and omits them without tools", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("gpt-oss-120b"),
    );
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model: "gpt-oss-120b",
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }], {
      toolChoice: "required",
      parallelToolCalls: true,
    });

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  test.each([
    ["gpt-oss-120b", "none", undefined, true, undefined],
    ["qwen-3.8-27b", "none", "none", true, true],
    ["qwen-3.8-27b", "low", "low", true, true],
    ["qwen-3.8-27b", "xhigh", undefined, true, true],
    ["gemma-4-31b", "high", "high", true, true],
    ["gemma-4-31b", "xhigh", undefined, true, true],
  ] as const)(
    "gates model-specific effort and parallel controls for %s / %s",
    async (
      model,
      requestedEffort,
      expectedEffort,
      requestedParallel,
      expectedParallel,
    ) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        successfulChat(model),
      );
      const provider = new CerebrasProvider({
        apiKey: "cerebras-test",
        model,
        tools: [ECHO_TOOL],
        fetchImpl,
      });

      await provider.chat([{ role: "user", content: "hello" }], {
        reasoningEffort: requestedEffort,
        parallelToolCalls: requestedParallel,
      });

      const body = JSON.parse(
        String(fetchImpl.mock.calls[0]?.[1]?.body),
      ) as Record<string, unknown>;
      expect(body.reasoning_effort).toBe(expectedEffort);
      expect(body.parallel_tool_calls).toBe(expectedParallel);
    },
  );

  test("rejects a non-adjacent API v2 tool-result sequence before dispatch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model: "qwen-3.8-27b",
      fetchImpl,
    });

    await expect(
      provider.chat([
        { role: "user", content: "use a tool" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_echo", name: "system.echo", arguments: "{}" },
          ],
        },
        { role: "user", content: "interleaved" },
        {
          role: "tool",
          toolCallId: "call_echo",
          toolName: "system.echo",
          content: "ok",
        },
      ]),
    ).rejects.toThrow(/followed immediately/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("keeps a complete parallel API v2 tool-result group contiguous", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("qwen-3.8-27b"),
    );
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model: "qwen-3.8-27b",
      fetchImpl,
    });

    await provider.chat([
      { role: "user", content: "use tools" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_first", name: "First", arguments: "{}" },
          { id: "call_second", name: "Second", arguments: "{}" },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_first",
        toolName: "First",
        content: "first result",
      },
      {
        role: "tool",
        toolCallId: "call_second",
        toolName: "Second",
        content: "second result",
      },
    ]);

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as { messages: Array<Record<string, unknown>> };
    expect(body.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ]);
    expect(body.messages.slice(2).map((message) => message.tool_call_id))
      .toEqual(["call_first", "call_second"]);
  });

  test("rejects duplicate API v2 tool-call ids before dispatch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model: "qwen-3.8-27b",
      fetchImpl,
    });

    await expect(
      provider.chat([
        { role: "user", content: "use tools" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_same", name: "system.echo", arguments: "{}" },
            { id: "call_same", name: "FileRead", arguments: "{}" },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_same",
          toolName: "system.echo",
          content: "ok",
        },
      ]),
    ).rejects.toThrow(/non-empty and unique/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("allows dedicated unknown models while failing closed on optional features", () => {
    const provider = createProvider("cerebras", {
      apiKey: "cerebras-test",
      model: "private-dedicated-model",
    });
    expect(provider).toBeInstanceOf(CerebrasProvider);
    expect(resolveProviderCapabilityEntry({
      provider: "cerebras",
      model: "private-dedicated-model",
    })).toMatchObject({
      supportsToolUse: true,
      supportsImageInput: false,
      supportsStructuredOutput: false,
      acceptsReasoningEffort: false,
    });
    expect(
      chatCompletionsCapabilityHintsForProvider(
        "cerebras",
        "private-dedicated-model",
      ),
    ).toMatchObject({
      replaysReasoningContent: false,
      reasoningContentField: "reasoning",
      toolResultImagePolicy: "strip",
    });
  });
});
