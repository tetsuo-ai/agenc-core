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
import { ZaiCodingPlanProvider, ZaiProvider } from "./index.js";

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

const ONE_PIXEL_PNG =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function successfulChat(
  model: string,
  content = "ok",
  extraMessage: Record<string, unknown> = {},
  finishReason = "stop",
): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl_zai",
    model,
    choices: [{
      finish_reason: finishReason,
      message: { role: "assistant", content, ...extraMessage },
    }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }), { headers: { "content-type": "application/json" } });
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const chunks = frames.map((frame) => encoder.encode(frame));
  let next = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function bodyAt(
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>,
  index = 0,
): Record<string, unknown> {
  return JSON.parse(String(fetchImpl.mock.calls[index]?.[1]?.body)) as Record<
    string,
    unknown
  >;
}

describe("ZaiProvider", () => {
  test("routes the isolated Coding Plan provider to its own endpoint and key", async () => {
    const model = "glm-5.3";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const resolved = resolveProviderCredentialAuthority(
      "zai-coding-plan",
      { model },
      {
        ZAI_API_KEY: "must-not-cross-from-payg",
        ZAI_BASE_URL: "https://payg.invalid/api/paas/v4",
        ZAI_CODING_PLAN_API_KEY: "coding-plan-test",
        ZAI_CODING_PLAN_BASE_URL:
          "https://coding.invalid/api/coding/paas/v4",
      },
    );
    expect(resolved.factoryOptions).toMatchObject({
      apiKey: "coding-plan-test",
      baseURL: "https://coding.invalid/api/coding/paas/v4",
    });

    const provider = createProvider("zai-coding-plan", {
      apiKey: "coding-plan-test",
      extra: { fetchImpl },
    });
    expect(provider).toBeInstanceOf(ZaiCodingPlanProvider);
    expect(readProviderIdentity(provider)).toBe("zai-coding-plan");

    await provider.chat([{ role: "user", content: "hello" }], {
      reasoningEffort: "max",
      tools: [ECHO_TOOL],
      toolChoice: "required",
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS["zai-coding-plan"]}/chat/completions`,
    );
    expect((init?.headers as Headers).get("authorization"))
      .toBe("Bearer coding-plan-test");
    expect(bodyAt(fetchImpl)).toMatchObject({
      model,
      reasoning_effort: "max",
      thinking: { type: "enabled", clear_thinking: true },
      tool_choice: "auto",
    });
  });

  test("keeps Coding Plan model and endpoint authority fail-closed", () => {
    expect(() => new ZaiCodingPlanProvider({
      apiKey: "coding-plan-test",
      model: "glm-5.2",
    })).toThrow(/coding plan.*glm-5\.3.*allowlist/i);
    expect(() => new ZaiCodingPlanProvider({
      apiKey: "coding-plan-test",
      model: "glm-5.3",
      baseURL: "https://api.z.ai/api/paas/v4",
    })).toThrow(/zai-coding-plan.*zai endpoint.*matching keys and base urls/i);
    expect(() => new ZaiProvider({
      apiKey: "payg-test",
      model: "glm-5.3",
      baseURL: "https://api.z.ai/api/coding/paas/v4",
    })).toThrow(/zai.*zai-coding-plan endpoint.*matching keys and base urls/i);
  });

  test("registers the documented GLM-5.3 Coding Plan family", () => {
    expect(BUILT_IN_PROVIDER_DEFAULT_MODELS["zai-coding-plan"])
      .toBe("glm-5.3");
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG["zai-coding-plan"])
      .toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(resolveModelCatalogMetadata({
      provider: "zai-coding-plan",
      model: "glm-5.3",
    })).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    });
    expect(resolveProviderCapabilityEntry({
      provider: "zai-coding-plan",
      model: "glm-5.3",
    })).toMatchObject({
      supportsToolUse: true,
      supportsImageInput: false,
      supportsStructuredOutput: true,
      supportsStructuredOutputWithTools: true,
      supportsExtendedThinking: true,
      acceptsReasoningEffort: true,
    });
    expect(resolveProviderCapabilityEntry({
      provider: "zai-coding-plan",
      model: "glm-5.3-flash",
    })).toMatchObject({
      supportsToolUse: true,
      supportsImageInput: true,
      acceptsImageHistory: true,
      supportsStructuredOutput: true,
      supportsExtendedThinking: true,
    });
    expect(resolveRegisteredModelCatalogEntry({
      provider: "zai-coding-plan",
      model: "glm-5.3",
    })).toMatchObject({
      supportedReasoningLevels: ["low", "high", "max"],
      defaultReasoningLevel: "max",
    });
  });

  test("factory uses the canonical Z.ai chat endpoint and bearer auth", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.zai;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = createProvider("zai", {
      apiKey: "zai-test",
      extra: { fetchImpl },
    });

    expect(provider).toBeInstanceOf(ZaiProvider);
    expect(readProviderIdentity(provider)).toBe("zai");

    await provider.chat([{ role: "user", content: "hello" }], {
      reasoningEffort: "max",
      toolChoice: "required",
      parallelToolCalls: true,
      stopSequences: ["first", "second"],
      tools: [ECHO_TOOL],
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS.zai}/chat/completions`,
    );
    expect((init?.headers as Headers).get("authorization"))
      .toBe("Bearer zai-test");
    expect(bodyAt(fetchImpl)).toMatchObject({
      model,
      stream: false,
      max_tokens: 32_000,
      reasoning_effort: "max",
      thinking: { type: "enabled", clear_thinking: true },
      tool_choice: "auto",
      stop: ["first"],
    });
    expect(bodyAt(fetchImpl).max_completion_tokens).toBeUndefined();
    expect(bodyAt(fetchImpl).parallel_tool_calls).toBeUndefined();
  });

  test("passes through non-image Z.ai chat model ids outside the curated catalog", async () => {
    const model = "glm-5.2";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model,
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "hello" }]);

    expect(bodyAt(fetchImpl).model).toBe(model);
  });

  test("uses json_object and locally validates the requested output schema", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("glm-5.3", '{"answer":"ok"}'),
    );
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "answer" }], {
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
    });

    expect(bodyAt(fetchImpl).response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(bodyAt(fetchImpl).messages)).toContain(
      "Return only one JSON object matching this JSON Schema",
    );
    expect(response.structuredOutput?.parsed).toEqual({ answer: "ok" });
  });

  test("supports a Coding Plan structured-output tool loop and validates only the final answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(successfulChat("glm-5.3", "", {
        tool_calls: [{
          id: "call_echo",
          type: "function",
          function: {
            name: "tool2__system_x2eecho",
            arguments: { text: "probe" },
          },
        }],
      }, "tool_calls"))
      .mockResolvedValueOnce(successfulChat(
        "glm-5.3",
        '{"answer":"probe"}',
      ));
    const provider = new ZaiCodingPlanProvider({
      apiKey: "coding-plan-test",
      model: "glm-5.3",
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
        },
      },
    };

    const first = await provider.chat(
      [{ role: "user", content: "echo probe, then answer" }],
      { structuredOutput },
    );
    expect(first.finishReason).toBe("tool_calls");
    expect(first.structuredOutput).toBeUndefined();

    const final = await provider.chat([
      { role: "user", content: "echo probe, then answer" },
      { role: "assistant", content: "", toolCalls: first.toolCalls },
      {
        role: "tool",
        toolCallId: "call_echo",
        toolName: "system.echo",
        content: "probe",
      },
    ], { structuredOutput });
    expect(final.structuredOutput?.parsed).toEqual({ answer: "probe" });
    for (let index = 0; index < 2; index += 1) {
      expect(bodyAt(fetchImpl, index)).toMatchObject({
        response_format: { type: "json_object" },
      });
      expect(bodyAt(fetchImpl, index).tools).toBeDefined();
    }
  });

  test("requires the canonical credential and never crosses provider envs", () => {
    expect(() => createProvider("zai", {})).toThrow(/zai.*apiKey/i);
    const resolved = resolveProviderCredentialAuthority(
      "zai",
      { model: "glm-5.3" },
      {
        ZAI_API_KEY: "zai-environment-test",
        ZAI_BASE_URL: "https://zai.invalid/api/paas/v4",
        OPENAI_API_KEY: "must-not-cross-provider-boundary",
      },
    );
    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "environment",
      provenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "ZAI_API_KEY" }],
      },
    });
    expect(resolved.factoryOptions).toMatchObject({
      apiKey: "zai-environment-test",
      baseURL: "https://zai.invalid/api/paas/v4",
    });
  });

  test.each([
    ["glm-5.3", false, 0],
    ["glm-5.3-flash", true, 1],
  ] as const)(
    "registers %s with official limits and capabilities",
    (model, vision, priority) => {
      expect(BUILT_IN_PROVIDER_MODEL_CATALOG.zai).toContain(model);
      expect(resolveModelCatalogMetadata({ provider: "zai", model }))
        .toEqual({
          contextWindow: 1_000_000,
          maxContextWindow: 1_000_000,
          maxOutputTokens: 131_072,
          maxOutputTokensUpperLimit: 131_072,
        });
      expect(resolveProviderCapabilityEntry({ provider: "zai", model }))
        .toMatchObject({
          supportsToolUse: true,
          supportsImageInput: vision,
          supportsVisionInput: vision,
          acceptsImageHistory: vision,
          supportsStructuredOutput: true,
          supportsStructuredOutputWithTools: true,
          supportsExtendedThinking: true,
          acceptsThinkingHistory: true,
          acceptsReasoningEffort: true,
        });
      expect(resolveRegisteredModelCatalogEntry({ provider: "zai", model }))
        .toMatchObject({
          supportedReasoningLevels: ["low", "high", "max"],
          defaultReasoningLevel: "max",
          supportsParallelToolCalls: false,
          priority,
        });
    },
  );

  test("keeps reasoning hidden and replays it only to the same model", async () => {
    const model = "glm-5.3";
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(successfulChat(model, "", {
        reasoning_content: "opaque GLM reasoning",
        tool_calls: [{
          id: "call_echo",
          type: "function",
          function: {
            name: "tool2__system_x2eecho",
            arguments: { text: "ok" },
          },
        }],
      }, "tool_calls"))
      .mockResolvedValueOnce(successfulChat(model));
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model,
      tools: [ECHO_TOOL],
      fetchImpl,
    });

    const first = await provider.chat([
      { role: "user", content: "call echo" },
    ]);
    expect(first.content).toBe("");
    expect(first.thinking?.[0]?.text).toBe("opaque GLM reasoning");
    expect(first.toolCalls).toEqual([{
      id: "call_echo",
      name: "system.echo",
      arguments: '{"text":"ok"}',
    }]);

    await provider.chat([
      { role: "user", content: "call echo" },
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
        content: "ok",
      },
    ]);

    const replay = bodyAt(fetchImpl, 1) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(replay.messages[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "opaque GLM reasoning",
    });
    expect(bodyAt(fetchImpl, 1).thinking).toEqual({
      type: "enabled",
      clear_thinking: false,
    });
  });

  test("clears stale Z.AI reasoning after the adjacent tool continuation", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("glm-5.3"),
    );
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([
      { role: "user", content: "call echo" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_old",
          name: "system.echo",
          arguments: '{"text":"old"}',
        }],
        providerReasoningContent: "old opaque reasoning",
        providerReasoningProvenance: {
          provider: "zai",
          model: "glm-5.3",
        },
      },
      {
        role: "tool",
        toolCallId: "call_old",
        toolName: "system.echo",
        content: "old",
      },
      { role: "user", content: "now answer a new question" },
    ]);

    expect(bodyAt(fetchImpl).thinking).toEqual({
      type: "enabled",
      clear_thinking: true,
    });
    expect(JSON.stringify(bodyAt(fetchImpl).messages))
      .not.toContain("old opaque reasoning");
  });

  test("replays every intact reasoning block in a multi-round tool chain", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("glm-5.3"),
    );
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    const provenance = { provider: "zai", model: "glm-5.3" } as const;
    const messages: LLMMessage[] = [
      { role: "user", content: "run two tools" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_one",
          name: "system.echo",
          arguments: '{"text":"one"}',
        }],
        providerReasoningContent: "reasoning one",
        providerReasoningProvenance: provenance,
      },
      {
        role: "tool",
        toolCallId: "call_one",
        toolName: "system.echo",
        content: "one",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_two",
          name: "system.echo",
          arguments: '{"text":"two"}',
        }],
        providerReasoningContent: "reasoning two",
        providerReasoningProvenance: provenance,
      },
      {
        role: "tool",
        toolCallId: "call_two",
        toolName: "system.echo",
        content: "two",
      },
    ];

    await provider.chat(messages);

    expect(bodyAt(fetchImpl).thinking).toEqual({
      type: "enabled",
      clear_thinking: false,
    });
    const wire = bodyAt(fetchImpl).messages as Array<Record<string, unknown>>;
    expect(wire.filter((message) => message.role === "assistant"))
      .toMatchObject([
        { reasoning_content: "reasoning one" },
        { reasoning_content: "reasoning two" },
      ]);
  });

  test("clears the whole reasoning chain when a runtime boundary was normalized", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("glm-5.3"),
    );
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await provider.chat([
      { role: "user", content: "call a tool" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_before_boundary",
          name: "system.echo",
          arguments: '{"text":"old"}',
        }],
        providerReasoningContent: "must not cross compaction",
        providerReasoningProvenance: {
          provider: "zai",
          model: "glm-5.3",
        },
      },
      {
        role: "tool",
        toolCallId: "call_before_boundary",
        toolName: "system.echo",
        content: "old",
      },
      { role: "system", content: "[boundary] compacted history" },
    ]);

    expect(bodyAt(fetchImpl).thinking).toEqual({
      type: "enabled",
      clear_thinking: true,
    });
    expect(JSON.stringify(bodyAt(fetchImpl).messages))
      .not.toContain("must not cross compaction");
  });

  test("replays only the positional active chain when older fingerprints collide", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("glm-5.3"),
    );
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    const repeatedAssistant = {
      role: "assistant" as const,
      content: "",
      toolCalls: [{
        id: "reused_call_id",
        name: "system.echo",
        arguments: '{"text":"same"}',
      }],
      providerReasoningContent: "identical opaque reasoning",
      providerReasoningProvenance: {
        provider: "zai",
        model: "glm-5.3",
      },
    };
    await provider.chat([
      { role: "user", content: "old turn" },
      { ...repeatedAssistant },
      {
        role: "tool",
        toolCallId: "reused_call_id",
        toolName: "system.echo",
        content: "same",
      },
      { role: "user", content: "current turn" },
      { ...repeatedAssistant },
      {
        role: "tool",
        toolCallId: "reused_call_id",
        toolName: "system.echo",
        content: "same",
      },
    ]);

    const wire = (bodyAt(fetchImpl).messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === "assistant");
    expect(wire).toHaveLength(2);
    expect(wire[0]?.reasoning_content).toBeUndefined();
    expect(wire[1]?.reasoning_content).toBe("identical opaque reasoning");
  });

  test("preserves OpenAI-compatible image input for GLM-5.3-Flash", async () => {
    const model = "glm-5.3-flash";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new ZaiProvider({ apiKey: "zai-test", model, fetchImpl });
    const imageUrl = ONE_PIXEL_PNG;

    await provider.chat([{
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    }]);

    expect(JSON.stringify(bodyAt(fetchImpl))).toContain(imageUrl);
    expect(chatCompletionsCapabilityHintsForProvider("zai", model))
      .toMatchObject({ toolResultImagePolicy: "relay_as_user" });
    expect(chatCompletionsCapabilityHintsForProvider("zai", "glm-5.3"))
      .toMatchObject({ toolResultImagePolicy: "strip" });
  });

  test.each(["glm-5.3", "glm-5.2"])(
    "rejects direct image input on text-only Z.ai chat model %s before HTTP",
    async (model) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new ZaiProvider({
        apiKey: "zai-test",
        model,
        fetchImpl,
      });

      await expect(provider.chat([{
        role: "user",
        content: [
          { type: "text", text: "describe" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
          },
        ],
      }])).rejects.toThrow(/does not support image input/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["WebP", "data:image/webp;base64,UklGRg=="],
    ["oversized dimensions", (() => {
      const bytes = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        .copy(bytes);
      Buffer.from("IHDR", "ascii").copy(bytes, 12);
      bytes.writeUInt32BE(6_001, 16);
      bytes.writeUInt32BE(1, 20);
      return `data:image/png;base64,${bytes.toString("base64")}`;
    })()],
  ] as const)(
    "rejects unsupported Flash image input (%s) before HTTP",
    async (_name, imageUrl) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = new ZaiProvider({
        apiKey: "zai-test",
        model: "glm-5.3-flash",
        fetchImpl,
      });

      await expect(provider.chat([{
        role: "user",
        content: [{ type: "image_url", image_url: { url: imageUrl } }],
      }])).rejects.toThrow(/JPEG or PNG under 5 MiB.*6000x6000/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test("strips unsupported tool-result images before relaying to Flash", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("glm-5.3-flash"),
    );
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3-flash",
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
          { type: "text", text: "unsupported image omitted" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/result.gif" },
          },
        ],
      },
    ]);

    const serializedMessages = JSON.stringify(bodyAt(fetchImpl).messages);
    expect(serializedMessages).toContain("unsupported image omitted");
    expect(serializedMessages).not.toContain("result.gif");
  });

  test("enables Z.ai tool streaming without undocumented stream_options", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"model":"glm-5.3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_stream","function":{"name":"tool2__system_x2eecho","arguments":{"text":"ok"}}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ]));
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      () => undefined,
    );

    expect(response.toolCalls).toEqual([{
      id: "call_stream",
      name: "system.echo",
      arguments: '{"text":"ok"}',
    }]);
    expect(bodyAt(fetchImpl)).toMatchObject({
      stream: true,
      tool_stream: true,
      thinking: { type: "enabled", clear_thinking: true },
    });
    expect(bodyAt(fetchImpl).stream_options).toBeUndefined();
  });

  test.each([
    ["glm-5.3", []],
    ["glm-4.5", [ECHO_TOOL]],
  ] as const)(
    "omits tool_stream for unsupported/no-tool stream %s",
    async (model, tools) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
        `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n`,
        "data: [DONE]\n\n",
      ]));
      const provider = new ZaiProvider({
        apiKey: "zai-test",
        model,
        tools: [...tools],
        fetchImpl,
      });

      await provider.chatStream(
        [{ role: "user", content: "hello" }],
        () => undefined,
      );

      expect(bodyAt(fetchImpl).tool_stream).toBeUndefined();
    },
  );

  test.each([
    ["zai", 200, true],
    ["zai", 401, false],
    ["zai-coding-plan", 200, true],
    ["zai-coding-plan", 401, false],
  ] as const)("validates %s health through /models (%s)", async (
    providerName,
    status,
    healthy,
  ) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(
        status === 200 ? { data: [{ id: "glm-5.3" }] } : { error: "unauthorized" },
      ), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = providerName === "zai"
      ? new ZaiProvider({
          apiKey: "zai-test",
          model: "glm-5.3",
          fetchImpl,
        })
      : new ZaiCodingPlanProvider({
          apiKey: "coding-plan-test",
          model: "glm-5.3",
          fetchImpl,
        });
    await expect(provider.healthCheck()).resolves.toBe(healthy);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      providerName === "zai"
        ? "https://api.z.ai/api/paas/v4/models"
        : "https://api.z.ai/api/coding/paas/v4/models",
    );
  });

  test.each([
    ["sensitive", "content_filter"],
    ["network_error", "error"],
  ] as const)(
    "normalizes the Z.ai %s finish reason",
    async (finishReason, expected) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({
          model: "glm-5.3",
          choices: [{
            finish_reason: finishReason,
            message: { role: "assistant", content: "partial" },
          }],
        }), { headers: { "content-type": "application/json" } }),
      );
      const provider = new ZaiProvider({
        apiKey: "zai-test",
        model: "glm-5.3",
        fetchImpl,
      });

      const response = await provider.chat([{ role: "user", content: "go" }]);
      expect(response.finishReason).toBe(expected);
    },
  );

  test.each(["zai", "zai-coding-plan"] as const)(
    "maps non-stream %s context-window terminal reasons to overflow errors",
    async (providerName) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({
          model: "glm-5.3",
          choices: [{
            finish_reason: "model_context_window_exceeded",
            message: { role: "assistant", content: "partial" },
          }],
        }), { headers: { "content-type": "application/json" } }),
      );
      const provider = providerName === "zai"
        ? new ZaiProvider({ apiKey: "payg-test", model: "glm-5.3", fetchImpl })
        : new ZaiCodingPlanProvider({
            apiKey: "coding-plan-test",
            model: "glm-5.3",
            fetchImpl,
          });
      await expect(provider.chat([{ role: "user", content: "go" }]))
        .rejects.toMatchObject({ name: "LLMContextWindowExceededError" });
    },
  );

  test("maps streamed context-window terminal reasons to overflow errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"model":"glm-5.3","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"model_context_window_exceeded"}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const provider = new ZaiProvider({
      apiKey: "payg-test",
      model: "glm-5.3",
      fetchImpl,
    });
    await expect(provider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).rejects.toMatchObject({ name: "LLMContextWindowExceededError" });
  });

  test.each([
    ["sensitive", "content_filter"],
    ["network_error", "error"],
  ] as const)(
    "drops non-stream tool calls on terminal %s",
    async (finishReason, expected) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({
          model: "glm-5.3",
          choices: [{
            finish_reason: finishReason,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call_blocked",
                type: "function",
                function: {
                  name: "system.echo",
                  arguments: { text: "must not run" },
                },
              }],
            },
          }],
        }), { headers: { "content-type": "application/json" } }),
      );
      const provider = new ZaiProvider({
        apiKey: "zai-test",
        model: "glm-5.3",
        tools: [ECHO_TOOL],
        fetchImpl,
      });

      const response = await provider.chat([{ role: "user", content: "go" }]);

      expect(response.finishReason).toBe(expected);
      expect(response.toolCalls).toEqual([]);
    },
  );

  test("drops streamed partial tool calls on a terminal network_error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"model":"glm-5.3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_blocked","function":{"name":"system.echo","arguments":{"text":"must not run"}}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"network_error"}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    const chunks: Array<{ toolCalls?: readonly unknown[] }> = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "go" }],
      (chunk) => chunks.push(chunk),
    );

    expect(response.finishReason).toBe("error");
    expect(response.toolCalls).toEqual([]);
    expect(chunks.every((chunk) => !chunk.toolCalls?.length)).toBe(true);
  });

  test.each(["zai", "zai-coding-plan"] as const)(
    "fails closed when a %s stream ends without finish_reason or [DONE]",
    async (providerName) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
        'data: {"model":"glm-5.3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_partial","function":{"name":"system.echo","arguments":{"text":"must not run"}}}]}}]}\n\n',
      ]));
      const provider = providerName === "zai"
        ? new ZaiProvider({
            apiKey: "payg-test",
            model: "glm-5.3",
            tools: [ECHO_TOOL],
            fetchImpl,
          })
        : new ZaiCodingPlanProvider({
            apiKey: "coding-plan-test",
            model: "glm-5.3",
            tools: [ECHO_TOOL],
            fetchImpl,
          });

      await expect(provider.chatStream(
        [{ role: "user", content: "go" }],
        () => undefined,
      )).rejects.toThrow(/without.*finish_reason/i);
    },
  );

  test("does not let [DONE] authorize an unfinished streamed tool call", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"model":"glm-5.3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_partial","function":{"name":"system.echo","arguments":{"text":"must not run"}}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const provider = new ZaiProvider({
      apiKey: "payg-test",
      model: "glm-5.3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await expect(provider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).rejects.toThrow(/tool calls.*finish_reason=tool_calls/i);
  });

  test("does not treat [DONE] as a text completion without finish_reason", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"model":"glm-5.3","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const provider = new ZaiProvider({
      apiKey: "payg-test",
      model: "glm-5.3",
      fetchImpl,
    });
    await expect(provider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).rejects.toThrow(/without an explicit finish_reason/i);
  });

  test("rejects malformed Z.AI SSE instead of skipping a missing terminal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"model":"glm-5.3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_partial","function":{"name":"system.echo","arguments":"{\\"text\\":\\"must not run\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}]\n\n',
      "data: [DONE]\n\n",
    ]));
    const provider = new ZaiProvider({
      apiKey: "payg-test",
      model: "glm-5.3",
      tools: [ECHO_TOOL],
      fetchImpl,
    });
    await expect(provider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).rejects.toThrow(/malformed JSON.*SSE/i);
  });

  test.each([undefined, "stop", "bogus"])(
    "rejects non-stream tool calls with finish_reason %s",
    async (finishReason) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        model: "glm-5.3",
        choices: [{
          ...(finishReason !== undefined
            ? { finish_reason: finishReason }
            : {}),
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_unfinished",
              type: "function",
              function: { name: "system.echo", arguments: { text: "no" } },
            }],
          },
        }],
      }), { headers: { "content-type": "application/json" } }),
      );
      const provider = new ZaiProvider({
        apiKey: "payg-test",
        model: "glm-5.3",
        tools: [ECHO_TOOL],
        fetchImpl,
      });
      await expect(provider.chat([{ role: "user", content: "go" }]))
        .rejects.toThrow(/tool calls.*finish_reason=tool_calls/i);
    },
  );

  test.each(["stop", "bogus"])(
    "rejects streamed tool calls finalized with %s",
    async (finishReason) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
        'data: {"model":"glm-5.3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_partial","function":{"name":"system.echo","arguments":{"text":"must not run"}}}]}}]}\n\n',
        `data: {"choices":[{"index":0,"delta":{},"finish_reason":"${finishReason}"}]}\n\n`,
        "data: [DONE]\n\n",
      ]));
      const provider = new ZaiProvider({
        apiKey: "payg-test",
        model: "glm-5.3",
        tools: [ECHO_TOOL],
        fetchImpl,
      });
      await expect(provider.chatStream(
        [{ role: "user", content: "go" }],
        () => undefined,
      )).rejects.toThrow(/tool calls.*finish_reason=tool_calls/i);
    },
  );

  test("rejects conflicting streamed terminal reasons", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]));
    const provider = new ZaiProvider({
      apiKey: "payg-test",
      model: "glm-5.3",
      fetchImpl,
    });
    await expect(provider.chatStream(
      [{ role: "user", content: "go" }],
      () => undefined,
    )).rejects.toThrow(/conflicting finish_reason/i);
  });

  test("rejects an unknown non-stream finish reason even without tools", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        model: "glm-5.3",
        choices: [{
          finish_reason: "future_unknown_reason",
          message: { role: "assistant", content: "unsafe default" },
        }],
      }), { headers: { "content-type": "application/json" } }),
    );
    const provider = new ZaiProvider({
      apiKey: "payg-test",
      model: "glm-5.3",
      fetchImpl,
    });
    await expect(provider.chat([{ role: "user", content: "go" }]))
      .rejects.toThrow(/unsupported finish_reason.*future_unknown_reason/i);
  });

  test.each(["zai", "zai-coding-plan"] as const)(
    "maps Z.AI code 1113 for %s to a non-retryable billing/config error",
    async (providerName) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({
          error: { code: "1113", message: "Insufficient balance" },
        }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      );
      const provider = providerName === "zai"
        ? new ZaiProvider({
            apiKey: "payg-test",
            model: "glm-5.3",
            fetchImpl,
          })
        : new ZaiCodingPlanProvider({
            apiKey: "coding-plan-test",
            model: "glm-5.3",
            fetchImpl,
          });

      const error = await provider.chat([{ role: "user", content: "go" }])
        .then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({
        name: "LLMProviderError",
        providerName,
      });
      expect(error).not.toMatchObject({ name: "LLMRateLimitError" });
      expect(String(error)).toMatch(/code 1113.*billing.*zai-coding-plan/i);
    },
  );

  test("fails before HTTP when the tool catalog exceeds Z.ai's 128-function limit", async () => {
    const tools = Array.from({ length: 130 }, (_, index): LLMTool => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `Tool ${index}`,
        parameters: { type: "object", properties: {} },
      },
    }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("glm-5.3"),
    );
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      tools,
      fetchImpl,
    });

    await expect(provider.chat([{ role: "user", content: "use a tool" }]))
      .rejects.toThrow(/at most 128 tools.*received 130.*deferred tool discovery/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(["glm-image", "zai/cogview-4-250304"])(
    "rejects non-chat image model %s before any request",
    (model) => {
      const fetchImpl = vi.fn<typeof fetch>();
      expect(() => new ZaiProvider({
        apiKey: "zai-test",
        model,
        fetchImpl,
      })).toThrow(/not a chat-completions model.*ImagineImage/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test("rejects per-call image model overrides before chat or streaming HTTP", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      fetchImpl,
    });

    await expect(provider.chat([{ role: "user", content: "hello" }], {
      model: "glm-image",
    })).rejects.toThrow(/not a chat-completions model.*ImagineImage/i);
    await expect(provider.chatStream(
      [{ role: "user", content: "hello" }],
      () => undefined,
      { model: "cogview-4-250304" },
    )).rejects.toThrow(/not a chat-completions model.*ImagineImage/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects temperatures outside Z.ai's documented 0..1 range", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      temperature: 1.5,
      fetchImpl,
    })).toThrow(/temperature must be between 0 and 1/i);

    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      fetchImpl,
    });
    await expect(provider.chat([{ role: "user", content: "hello" }], {
      temperature: 1.01,
    })).rejects.toThrow(/temperature must be between 0 and 1/i);
    await expect(provider.chatStream(
      [{ role: "user", content: "hello" }],
      () => undefined,
      { temperature: -0.01 },
    )).rejects.toThrow(/temperature must be between 0 and 1/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("sends configured temperature and lets a per-call value override it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      successfulChat("glm-5.3")
    );
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      temperature: 0.7,
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "configured" }]);
    await provider.chat([{ role: "user", content: "override" }], {
      temperature: 0.2,
    });

    expect(bodyAt(fetchImpl, 0).temperature).toBe(0.7);
    expect(bodyAt(fetchImpl, 1).temperature).toBe(0.2);
  });

  test("rejects a tool call outside the capped advertised catalog", async () => {
    const tools = Array.from({ length: 1 }, (_, index): LLMTool => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `Tool ${index}`,
        parameters: { type: "object", properties: {} },
      },
    }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat("glm-5.3", "", {
        tool_calls: [{
          id: "call_unadvertised",
          type: "function",
          function: { name: "tool_1", arguments: {} },
        }],
      }, "tool_calls"),
    );
    const provider = new ZaiProvider({
      apiKey: "zai-test",
      model: "glm-5.3",
      tools,
      fetchImpl,
    });

    await expect(provider.chat([{ role: "user", content: "use a tool" }]))
      .rejects.toThrow(/unadvertised tool name.*tool_1/i);
  });

  test.each(["none", "minimal", "medium", "xhigh"] as const)(
    "strips unsupported reasoning effort %s",
    async (reasoningEffort) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        successfulChat("glm-5.3"),
      );
      const provider = new ZaiProvider({
        apiKey: "zai-test",
        model: "glm-5.3",
        fetchImpl,
      });
      await provider.chat([{ role: "user", content: "hello" }], {
        reasoningEffort,
      });
      expect(bodyAt(fetchImpl).reasoning_effort).toBeUndefined();
      expect(bodyAt(fetchImpl).thinking).toEqual({
        type: "enabled",
        clear_thinking: true,
      });
    },
  );
});
