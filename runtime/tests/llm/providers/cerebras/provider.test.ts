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
import type { LLMTool } from "../../types.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../wire/capability-gating.js";
import { CerebrasProvider } from "./index.js";

function successfulChat(
  model: string,
  content = "ok",
  extraMessage: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_cerebras",
      model,
      choices: [
        {
          message: { role: "assistant", content, ...extraMessage },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 1,
        total_tokens: 4,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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
      serviceTier: "priority",
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
      service_tier: "priority",
    });
    expect(body.max_completion_tokens).toBeTypeOf("number");
    expect(body.max_tokens).toBeUndefined();
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
    ["gpt-oss-120b", 131_072, 40_960, false, false, ["low", "medium", "high"], "medium"],
    ["qwen-3.8-27b", 65_536, 32_768, true, true, ["none", "low", "medium", "high"], "high"],
    ["gemma-4-31b", 131_072, 40_960, true, true, ["none", "low", "medium", "high"], "none"],
  ] as const)(
    "registers %s with verified model metadata and capabilities",
    (
      model,
      contextWindow,
      maxOutputTokens,
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
          maxOutputTokensUpperLimit: maxOutputTokens,
        });
      expect(resolveProviderCapabilityEntry({ provider: "cerebras", model }))
        .toMatchObject({
          supportsToolUse: true,
          supportsImageInput: vision,
          supportsVisionInput: vision,
          acceptsImageHistory: vision,
          supportsStructuredOutput: true,
          supportsStructuredOutputWithTools: true,
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
        additionalSpeedTiers: ["priority", "flex"],
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

    const replayBody = JSON.parse(
      String(fetchImpl.mock.calls[1]?.[1]?.body),
    ) as { messages: Array<Record<string, unknown>> };
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
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        successfulChat(model),
      );
      const provider = new CerebrasProvider({
        apiKey: "cerebras-test",
        model,
        fetchImpl,
      });

      await provider.chat([
        { role: "user", content: "complete both steps" },
        {
          role: "assistant",
          content: "",
          providerReasoningContent: "reasoning for step one",
          providerReasoningProvenance: { provider: "cerebras", model },
          toolCalls: [{ id: "call_one", name: "First", arguments: "{}" }],
        },
        {
          role: "tool",
          toolCallId: "call_one",
          toolName: "First",
          content: "first result",
        },
        {
          role: "assistant",
          content: "",
          providerReasoningContent: "reasoning for step two",
          providerReasoningProvenance: { provider: "cerebras", model },
          toolCalls: [{ id: "call_two", name: "Second", arguments: "{}" }],
        },
        {
          role: "tool",
          toolCallId: "call_two",
          toolName: "Second",
          content: "second result",
        },
        { role: "user", content: "finish" },
      ]);

      const body = JSON.parse(
        String(fetchImpl.mock.calls[0]?.[1]?.body),
      ) as { messages: Array<Record<string, unknown>> };
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
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new CerebrasProvider({
      apiKey: "cerebras-test",
      model,
      fetchImpl,
    });

    await provider.chat([
      { role: "user", content: "continue safely" },
      {
        role: "assistant",
        content: "",
        providerReasoningContent: "foreign provider state",
        providerReasoningProvenance: { provider: "qwen", model },
        toolCalls: [{ id: "call_foreign", name: "First", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "call_foreign",
        toolName: "First",
        content: "foreign result",
      },
      {
        role: "assistant",
        content: "",
        providerReasoningContent: "other Cerebras model state",
        providerReasoningProvenance: {
          provider: "cerebras",
          model: "gpt-oss-120b",
        },
        toolCalls: [{ id: "call_other", name: "Second", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "call_other",
        toolName: "Second",
        content: "other result",
      },
      {
        role: "assistant",
        content: "",
        providerReasoningContent: "exact Cerebras model state",
        providerReasoningProvenance: { provider: "cerebras", model },
        toolCalls: [{ id: "call_exact", name: "Third", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "call_exact",
        toolName: "Third",
        content: "exact result",
      },
      { role: "user", content: "finish" },
    ]);

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as { messages: Array<Record<string, unknown>> };
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
      tools: [ECHO_TOOL],
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

  test.each([
    ["qwen-3.8-27b", "relay_as_user", true],
    ["gemma-4-31b", "relay_as_user", true],
    ["gpt-oss-120b", "strip", false],
    ["future-cerebras-model", "strip", false],
  ] as const)(
    "applies model-aware tool-result image policy for %s",
    async (model, policy, relaysImage) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        successfulChat(model),
      );
      const provider = new CerebrasProvider({
        apiKey: "cerebras-test",
        model,
        fetchImpl,
      });

      await provider.chat([
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_read", name: "FileRead", arguments: "{}" }],
        },
        {
          role: "tool",
          toolCallId: "call_read",
          toolName: "FileRead",
          content: [
            { type: "text", text: "Image Size: 10x10." },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,dG9vbA==" },
            },
          ],
        },
      ]);

      const body = JSON.parse(
        String(fetchImpl.mock.calls[0]?.[1]?.body),
      ) as { messages: Array<Record<string, unknown>> };
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
