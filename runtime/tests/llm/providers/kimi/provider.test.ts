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
import type { LLMMessage, LLMTool } from "../../types.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../wire/capability-gating.js";
import { usesLocalToolProfile } from "../../wire/capability-gating.js";
import {
  bodyAt,
  createSuccessfulChatResponse,
  ECHO_TOOL,
  ONE_PIXEL_PNG,
  sseResponse,
} from "../openai-compatible-test-helpers.js";
import { KIMI_CHAT_MODELS, KimiProvider } from "./index.js";

const successfulChat = createSuccessfulChatResponse("chatcmpl_kimi");

function reasoningRound(
  model: string,
  id: string,
  reasoning: string,
): readonly [LLMMessage, LLMMessage] {
  return [{
    role: "assistant",
    content: "",
    toolCalls: [{ id, name: "system.echo", arguments: '{"text":"ok"}' }],
    providerReasoningContent: reasoning,
    providerReasoningProvenance: { provider: "kimi", model },
  }, {
    role: "tool",
    toolCallId: id,
    toolName: "system.echo",
    content: "ok",
  }];
}

function compactionProjectionPrefix(): readonly [LLMMessage, LLMMessage] {
  const marker = {
    version: 1 as const,
    attempt_id: "compact-attempt",
    summary_sha256: "a".repeat(64),
  };
  return [{
    role: "developer",
    content: "authenticated compaction boundary",
    runtimeOnly: {
      compactionHistory: { ...marker, kind: "boundary" as const },
    },
  }, {
    role: "user",
    content: "compacted historical summary",
    runtimeOnly: {
      compactionHistory: { ...marker, kind: "summary" as const },
    },
  }];
}

describe("KimiProvider", () => {
  test("registers the exact global Moonshot catalog and isolated authority", () => {
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS.kimi).toBe("kimi-k3");
    expect(BUILT_IN_PROVIDER_BASE_URLS.kimi).toBe(
      "https://api.moonshot.ai/v1",
    );
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.kimi).toEqual([
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k2.6",
    ]);

    const authority = resolveProviderCredentialAuthority(
      "kimi",
      { model: "kimi-k3" },
      {
        MOONSHOT_API_KEY: "moonshot-test",
        MOONSHOT_BASE_URL: "https://attacker.invalid/v1",
        OPENAI_API_KEY: "must-not-cross-provider-boundary",
      },
    );
    expect(authority.factoryOptions).toMatchObject({ apiKey: "moonshot-test" });
    expect(authority.factoryOptions.baseURL).toBeUndefined();
    expect(resolveProviderCredentialAuthority(
      "kimi",
      { model: "kimi-k3" },
      { OPENAI_API_KEY: "must-not-cross-provider-boundary" },
    ).factoryOptions.apiKey).toBeUndefined();
  });

  test.each([
    ["kimi-k3", 1_048_576, 131_072, ["low", "high", "max"], "max"],
    ["kimi-k2.7-code", 262_144, undefined, [], undefined],
    ["kimi-k2.7-code-highspeed", 262_144, undefined, [], undefined],
    ["kimi-k2.6", 262_144, undefined, [], undefined],
  ] as const)(
    "registers %s with official context and reasoning controls",
    (model, contextWindow, maxOutputTokens, levels, defaultLevel) => {
      expect(resolveModelCatalogMetadata({ provider: "kimi", model }))
        .toMatchObject({
          contextWindow,
          maxContextWindow: contextWindow,
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        });
      expect(resolveRegisteredModelCatalogEntry({ provider: "kimi", model }))
        .toMatchObject({
          inputModalities: ["text", "image"],
          supportsToolUse: true,
          supportsStructuredOutputWithTools: model === "kimi-k2.7-code",
          supportedReasoningLevels: levels,
          ...(defaultLevel !== undefined
            ? { defaultReasoningLevel: defaultLevel }
            : {}),
        });
      expect(resolveProviderCapabilityEntry({ provider: "kimi", model }))
        .toMatchObject({
          supportsToolUse: true,
          supportsImageInput: true,
          acceptsImageHistory: true,
          supportsExtendedThinking: true,
          acceptsThinkingHistory: true,
          acceptsReasoningEffort: model === "kimi-k3",
        });
    },
  );

  test("factory sends K3's documented fields and omits fixed sampling controls", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k3"),
    );
    const provider = createProvider("kimi", {
      apiKey: "moonshot-test",
      extra: { fetchImpl, temperature: 0.2 },
    });
    expect(provider).toBeInstanceOf(KimiProvider);
    expect(readProviderIdentity(provider)).toBe("kimi");

    await provider.chat([{ role: "user", content: "hello" }], {
      temperature: 0.7,
      reasoningEffort: "max",
      toolChoice: "required",
      tools: [ECHO_TOOL],
    });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.moonshot.ai/v1/chat/completions",
    );
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Headers).get(
      "authorization",
    )).toBe("Bearer moonshot-test");
    expect(bodyAt(fetchImpl)).toMatchObject({
      model: "kimi-k3",
      max_completion_tokens: 131_072,
      reasoning_effort: "max",
      tool_choice: "required",
    });
    expect(bodyAt(fetchImpl).max_tokens).toBeUndefined();
    expect(bodyAt(fetchImpl).temperature).toBeUndefined();
    expect(bodyAt(fetchImpl).thinking).toBeUndefined();
  });

  test("caps K3 output at the documented maximum", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k3"),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      fetchImpl,
    });
    await provider.chat([{ role: "user", content: "long" }], {
      maxOutputTokens: 2_000_000,
    });
    expect(bodyAt(fetchImpl).max_completion_tokens).toBe(1_048_576);
  });

  test("keeps K3 required but normalizes named choices while thinking", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(successfulChat("kimi-k3"))
      .mockResolvedValueOnce(successfulChat("kimi-k3"));
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([{ role: "user", content: "required" }], {
      toolChoice: "required",
    });
    await provider.chat([{ role: "user", content: "named" }], {
      toolChoice: { name: "system.echo" },
    });
    expect(bodyAt(fetchImpl, 0).tool_choice).toBe("required");
    expect(bodyAt(fetchImpl, 1).tool_choice).toBe("auto");
  });

  test("rejects retired models and non-global Moonshot endpoints", () => {
    expect(() => new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k2-thinking",
    })).toThrow(/current global chat allowlist/i);
    expect(() => new KimiProvider({
      apiKey: "moonshot-test",
      model: "KIMI-K3",
    })).toThrow(/current global chat allowlist/i);
    expect(() => new KimiProvider({
      apiKey: "moonshot-test",
      model: " kimi-k3 ",
    })).toThrow(/current global chat allowlist/i);
    expect(() => new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      baseURL: "https://api.moonshot.cn/v1",
    })).toThrow(/bound to Moonshot's global endpoint/i);
    expect(() => new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      baseURL: "http://127.0.0.1:8787/v1",
    })).toThrow(/bound to Moonshot's global endpoint/i);
  });

  test.each(["kimi-k2.7-code", "kimi-k2.7-code-highspeed"])(
    "omits K2.7 reasoning controls and downgrades required tool choice for %s",
    async (model) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        successfulChat(model),
      );
      const provider = new KimiProvider({
        apiKey: "moonshot-test",
        model,
        tools: [ECHO_TOOL],
        fetchImpl,
      });
      await provider.chat([{ role: "user", content: "hello" }], {
        reasoningEffort: "high",
        toolChoice: "required",
      });
      expect(bodyAt(fetchImpl).reasoning_effort).toBeUndefined();
      expect(bodyAt(fetchImpl).thinking).toBeUndefined();
      expect(bodyAt(fetchImpl).tool_choice).toBe("auto");
      expect(bodyAt(fetchImpl).max_completion_tokens).toBe(32_768);
    },
  );

  test("normalizes named K2.x choices while thinking", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k2.7-code"),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k2.7-code",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([{ role: "user", content: "named" }], {
      toolChoice: { name: "system.echo" },
    });
    expect(bodyAt(fetchImpl).tool_choice).toBe("auto");
  });

  test("enables K2.6 thinking with full history preservation", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k2.6"),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k2.6",
      fetchImpl,
    });
    await provider.chat([{ role: "user", content: "hello" }]);
    expect(bodyAt(fetchImpl).thinking).toEqual({
      type: "enabled",
      keep: "all",
    });
  });

  test("replays every intact historical reasoning block only to identical provenance", async () => {
    const model = "kimi-k3";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model,
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([
      { role: "user", content: "first" },
      ...reasoningRound(model, "call_one", "reasoning one"),
      { role: "user", content: "second" },
      ...reasoningRound(model, "call_two", "reasoning two"),
    ]);
    const messages = bodyAt(fetchImpl).messages as Array<Record<string, unknown>>;
    expect(messages.filter((message) => message.role === "assistant"))
      .toMatchObject([
        { reasoning_content: "reasoning one" },
        { reasoning_content: "reasoning two" },
      ]);
  });

  test("never replays reasoning across a Kimi model or provider boundary", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k3"),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([
      { role: "user", content: "first" },
      ...reasoningRound("kimi-k2.7-code", "wrong_model", "wrong model"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "wrong_provider",
          name: "system.echo",
          arguments: '{"text":"ok"}',
        }],
        providerReasoningContent: "wrong provider",
        providerReasoningProvenance: {
          provider: "qwen",
          model: "kimi-k3",
        },
      },
      {
        role: "tool",
        toolCallId: "wrong_provider",
        toolName: "system.echo",
        content: "ok",
      },
    ]);
    const serialized = JSON.stringify(bodyAt(fetchImpl).messages);
    expect(serialized).not.toContain("wrong model");
    expect(serialized).not.toContain("wrong provider");
  });

  test("keeps reasoning replay when normalization only merges benign user context", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k3"),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([
      { role: "user", content: "context one" },
      { role: "user", content: "context two" },
      ...reasoningRound("kimi-k3", "call_current", "intact reasoning"),
    ]);
    expect(JSON.stringify(bodyAt(fetchImpl).messages)).toContain(
      "intact reasoning",
    );
  });

  test("drops every Kimi reasoning block after normalization changes history", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k3"),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([
      { role: "user", content: "first" },
      ...reasoningRound("kimi-k3", "call_one", "must not replay"),
      { role: "system", content: "[boundary] compacted history" },
    ]);
    expect(JSON.stringify(bodyAt(fetchImpl).messages)).not.toContain(
      "must not replay",
    );
  });

  test("preserves authoritative kept-tail and fresh reasoning after compaction", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k3"),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([
      ...compactionProjectionPrefix(),
      ...reasoningRound(
        "kimi-k3",
        "old_kept_call",
        "authoritative kept-tail reasoning",
      ),
      { role: "user", content: "fresh work after compaction" },
      ...reasoningRound("kimi-k3", "fresh_call_one", "fresh reasoning one"),
      ...reasoningRound("kimi-k3", "fresh_call_two", "fresh reasoning two"),
      { role: "user", content: "continue after restart" },
    ]);
    const serialized = JSON.stringify(bodyAt(fetchImpl).messages);
    expect(serialized).toContain("authoritative kept-tail reasoning");
    expect(serialized).toContain("fresh reasoning one");
    expect(serialized).toContain("fresh reasoning two");
  });

  test("drops Kimi reasoning if post-compaction tool topology needs repair", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k3"),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([
      ...compactionProjectionPrefix(),
      ...reasoningRound(
        "kimi-k3",
        "kept_call",
        "must not survive topology repair",
      ),
      {
        role: "tool",
        toolCallId: "orphan_call",
        toolName: "system.echo",
        content: "orphan",
      },
    ]);
    expect(JSON.stringify(bodyAt(fetchImpl).messages)).not.toContain(
      "must not survive topology repair",
    );
  });

  test.each(KIMI_CHAT_MODELS)(
    "enforces the private base64/ms:// vision contract for %s",
    async (model) => {
      const okFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(successfulChat(model))
        .mockResolvedValueOnce(successfulChat(model));
      const provider = new KimiProvider({
        apiKey: "moonshot-test",
        model,
        fetchImpl: okFetch,
      });
      await provider.chat([{
        role: "user",
        content: [{ type: "image_url", image_url: { url: ONE_PIXEL_PNG } }],
      }]);
      await provider.chat([{
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: "ms://uploaded-image-id" },
        }],
      }]);
      expect(JSON.stringify(bodyAt(okFetch, 0))).toContain(ONE_PIXEL_PNG);
      expect(JSON.stringify(bodyAt(okFetch, 1))).toContain(
        "ms://uploaded-image-id",
      );

      for (const url of [
        "https://example.com/secret.png",
        "data:image/svg+xml;base64,PHN2Zy8+",
        "data:image/tiff;base64,AA==",
      ]) {
        const rejectingFetch = vi.fn<typeof fetch>();
        const rejectingProvider = new KimiProvider({
          apiKey: "moonshot-test",
          model,
          fetchImpl: rejectingFetch,
        });
        await expect(rejectingProvider.chat([{
          role: "user",
          content: [{ type: "image_url", image_url: { url } }],
        }])).rejects.toThrow(/Kimi.*base64.*ms:\/\//i);
        expect(rejectingFetch).not.toHaveBeenCalled();
      }
    },
  );

  test("rechecks Moonshot's 100 MB limit after adding streaming fields", async () => {
    const originalByteLength = Buffer.byteLength.bind(Buffer);
    const byteLengthSpy = vi.spyOn(Buffer, "byteLength").mockImplementation((
      (value: Parameters<typeof Buffer.byteLength>[0],
      encoding?: Parameters<typeof Buffer.byteLength>[1]) => {
        if (
          typeof value === "string" &&
          value.includes('"stream":true')
        ) {
          return 100_000_001;
        }
        return originalByteLength(value, encoding);
      }
    ) as typeof Buffer.byteLength);
    try {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new KimiProvider({
        apiKey: "moonshot-test",
        model: "kimi-k3",
        fetchImpl,
      });
      await expect(provider.chatStream(
        [{ role: "user", content: "boundary" }],
        () => undefined,
      )).rejects.toThrow(/100 MB total payload limit/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      byteLengthSpy.mockRestore();
    }
  });

  test("preserves K2.7 tool-result image arrays on the tool message", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k2.7-code"),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k2.7-code",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_echo",
          name: "system.echo",
          arguments: '{"text":"inspect"}',
        }],
      },
      {
        role: "tool",
        toolCallId: "call_echo",
        toolName: "system.echo",
        content: [
          { type: "text", text: "result" },
          { type: "image_url", image_url: { url: ONE_PIXEL_PNG } },
        ],
      },
    ]);
    const messages = bodyAt(fetchImpl).messages as Array<Record<string, unknown>>;
    expect(messages[2]).toMatchObject({
      role: "tool",
      content: [
        { type: "text", text: "result" },
        { type: "image_url", image_url: { url: ONE_PIXEL_PNG } },
      ],
    });
  });

  test("uses native JSON Schema structured output and validates the result", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k3", '{"answer":"ok"}'),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      fetchImpl,
    });
    const response = await provider.chat([{ role: "user", content: "answer" }], {
      structuredOutput: {
        schema: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string", pattern: "^ok$" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(bodyAt(fetchImpl).response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema: {
          type: "object",
          properties: { answer: { type: "string", pattern: "^ok$" } },
          required: ["answer"],
          additionalProperties: false,
        },
        strict: true,
      },
    });
    expect(response.structuredOutput?.parsed).toEqual({ answer: "ok" });
  });

  test("supports the verified K2.7 Code tool-to-JSON-Schema loop", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(successfulChat(
        "kimi-k2.7-code",
        "",
        {
          reasoning_content: "inspect the tool input",
          tool_calls: [{
            id: "call_echo",
            type: "function",
            function: {
              name: "system.echo",
              arguments: '{"text":"probe"}',
            },
          }],
        },
        "tool_calls",
      ))
      .mockResolvedValueOnce(
        successfulChat("kimi-k2.7-code", '{"answer":"probe"}'),
      );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k2.7-code",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    const structuredOutput = {
      schema: {
        type: "json_schema" as const,
        name: "answer",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    };
    const first = await provider.chat([{ role: "user", content: "probe" }], {
      structuredOutput,
    });
    expect(first).toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_echo", name: "system.echo" }],
    });
    expect(bodyAt(fetchImpl, 0).response_format).toBeDefined();

    const second = await provider.chat([
      { role: "user", content: "probe" },
      {
        role: "assistant",
        content: "",
        toolCalls: first.toolCalls,
        providerReasoningContent: first.providerReasoningContent,
        providerReasoningProvenance: first.providerReasoningProvenance,
      },
      {
        role: "tool",
        toolCallId: "call_echo",
        toolName: "system.echo",
        content: "probe",
      },
    ], { structuredOutput });
    expect(second.structuredOutput?.parsed).toEqual({ answer: "probe" });
    expect(bodyAt(fetchImpl, 1).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "inspect the tool input",
      }),
    ]));
  });

  test.each([
    "kimi-k3",
    "kimi-k2.7-code-highspeed",
    "kimi-k2.6",
  ])("blocks unverified structured-output tool loops for %s", async (model) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model,
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await expect(provider.chat([{ role: "user", content: "probe" }], {
      structuredOutput: {
        schema: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object" },
        },
      },
    })).rejects.toThrow(/structured outputs with function tools.*not enabled/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("keeps full harness tools and fails before silently clipping past 128", async () => {
    const tools = Array.from({ length: 129 }, (_, index): LLMTool => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: "tool",
        parameters: { type: "object", properties: {} },
      },
    }));
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      tools,
      fetchImpl,
    });
    await expect(provider.chat([{ role: "user", content: "go" }]))
      .rejects.toThrow(/at most 128 tools.*deferred tool discovery/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(chatCompletionsCapabilityHintsForProvider("kimi", "kimi-k3"))
      .not.toMatchObject({ requiresGrammarSafeToolSchemas: true });
    expect(usesLocalToolProfile("kimi")).toBe(false);

    const fullFetch = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k3"),
    );
    const fullProvider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      tools: tools.slice(0, 128),
      fetchImpl: fullFetch,
    });
    await fullProvider.chat([{ role: "user", content: "go" }]);
    expect(bodyAt(fullFetch).tools).toHaveLength(128);
  });

  test("fails closed on malformed or unterminated Kimi SSE", async () => {
    const malformedFetch = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      "data: {not-json}\n\n",
      "data: [DONE]\n\n",
    ]));
    const malformedProvider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      fetchImpl: malformedFetch,
    });
    await expect(malformedProvider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).rejects.toThrow(/malformed JSON.*Kimi SSE/i);

    const noTerminalFetch = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const noTerminalProvider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      fetchImpl: noTerminalFetch,
    });
    await expect(noTerminalProvider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).rejects.toThrow(/explicit finish_reason/i);

    const trailingFragmentFetch = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"model":"kimi-k3","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
        "data: {unterminated",
      ]),
    );
    const trailingFragmentProvider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      fetchImpl: trailingFragmentFetch,
    });
    await expect(trailingFragmentProvider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).rejects.toThrow(/SSE stream ended with an unterminated event/i);
  });

  test("requires the exact tool_calls terminal reason for non-streaming calls", async () => {
    const toolMessage = {
      tool_calls: [{
        id: "call_echo",
        type: "function",
        function: { name: "system.echo", arguments: { text: "ok" } },
      }],
    };
    for (const finishReason of ["stop", "length", "unknown"]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        successfulChat("kimi-k3", "", toolMessage, finishReason),
      );
      const provider = new KimiProvider({
        apiKey: "moonshot-test",
        model: "kimi-k3",
        tools: [ECHO_TOOL],
        fetchImpl,
      });
      await expect(provider.chat([{ role: "user", content: "go" }]))
        .rejects.toThrow(/finish_reason(?:=tool_calls|.*unsupported)/i);
    }

    const validFetch = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("kimi-k3", "", toolMessage, "tool_calls"),
    );
    const validProvider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      tools: [ECHO_TOOL],
      fetchImpl: validFetch,
    });
    await expect(validProvider.chat([{ role: "user", content: "go" }]))
      .resolves.toMatchObject({
        finishReason: "tool_calls",
        toolCalls: [{
          id: "call_echo",
          name: "system.echo",
          arguments: '{"text":"ok"}',
        }],
      });
  });

  test("rejects partial streamed tool calls terminated by length", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_echo","type":"function","function":{"name":"system.echo","arguments":"{\\"text\\":\\"partial\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await expect(provider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).rejects.toThrow(/tool calls.*finish_reason=tool_calls/i);
  });

  test("captures streamed reasoning with exact Kimi model provenance", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"model":"kimi-k3","choices":[{"index":0,"delta":{"reasoning_content":"inspect "},"finish_reason":null}]}\n\n',
      'data: {"model":"kimi-k3","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      fetchImpl,
    });
    await expect(provider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).resolves.toMatchObject({
      content: "done",
      providerReasoningContent: "inspect ",
      providerReasoningProvenance: { provider: "kimi", model: "kimi-k3" },
      finishReason: "stop",
    });
  });

  test("accounts for Moonshot cached_tokens in JSON and nested SSE usage", async () => {
    const jsonFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({
        model: "kimi-k3",
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "done" },
        }],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 2,
          total_tokens: 13,
          cached_tokens: 7,
        },
      }),
      { headers: { "content-type": "application/json" } },
    ));
    const jsonProvider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      fetchImpl: jsonFetch,
    });
    await expect(jsonProvider.chat([{ role: "user", content: "go" }]))
      .resolves.toMatchObject({ usage: { cachedInputTokens: 7 } });

    const streamFetch = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"model":"kimi-k3","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop","usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13,"cached_tokens":7}}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const streamProvider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      fetchImpl: streamFetch,
    });
    await expect(streamProvider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).resolves.toMatchObject({ usage: { cachedInputTokens: 7 } });
  });

  test.each([200, 401])("checks native Kimi credential health through /models (%s)", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(
        status === 200 ? { data: [{ id: "kimi-k3" }] } : { error: "unauthorized" },
      ), { status, headers: { "content-type": "application/json" } }),
    );
    const provider = new KimiProvider({
      apiKey: "moonshot-test",
      model: "kimi-k3",
      fetchImpl,
    });
    await expect(provider.healthCheck()).resolves.toBe(status === 200);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.moonshot.ai/v1/models",
    );
  });
});
