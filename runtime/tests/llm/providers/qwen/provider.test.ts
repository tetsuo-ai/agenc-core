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
import { QwenProvider, QwenTokenPlanProvider } from "./index.js";

function successfulChat(
  model: string,
  content = "ok",
  extraMessage: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_qwen",
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

const TOOLS: readonly LLMTool[] = [
  {
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
  },
  {
    type: "function",
    function: {
      name: "Agent",
      description: "Delegate a task.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
      },
    },
  },
];

const LONG_MCP_SHARED_PREFIX = `mcp.plugin:${"shared-segment-".repeat(5)}`;
const LONG_MCP_TOOL_NAMES = [
  `${LONG_MCP_SHARED_PREFIX}alpha.fetch_record`,
  `${LONG_MCP_SHARED_PREFIX}bravo.fetch_record`,
] as const;

function thinkingToolLoopMessages(
  provider: "qwen" | "qwen-token-plan",
  model: string,
) {
  return [
    { role: "user" as const, content: "inspect the workspace" },
    {
      role: "assistant" as const,
      content: "",
      providerReasoningContent: "opaque thinking continuity",
      providerReasoningProvenance: { provider, model },
      toolCalls: [
        {
          id: "call_echo",
          name: "system.echo",
          arguments: '{"text":"ok"}',
        },
      ],
    },
    {
      role: "tool" as const,
      toolCallId: "call_echo",
      toolName: "system.echo",
      content: "ok",
    },
    { role: "user" as const, content: "continue" },
  ];
}

describe.each([
  {
    id: "qwen" as const,
    key: "sk-ws-test",
    Provider: QwenProvider,
  },
  {
    id: "qwen-token-plan" as const,
    key: "sk-sp-test",
    Provider: QwenTokenPlanProvider,
  },
])("$id provider", ({ id, key, Provider }) => {
  test("preserves the caller fetch implementation, endpoint, and bearer", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS[id];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = createProvider(id, { apiKey: key, extra: { fetchImpl } });

    expect(provider).toBeInstanceOf(Provider);
    expect(readProviderIdentity(provider)).toBe(id);
    await expect(
      provider.chat([{ role: "user", content: "hello" }]),
    ).resolves.toMatchObject({ content: "ok", model });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS[id]}/chat/completions`,
    );
    expect((init?.headers as Headers).get("authorization")).toBe(
      `Bearer ${key}`,
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model, stream: false });
    expect(body.max_completion_tokens).toBeTypeOf("number");
    expect(body.max_tokens).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  test("keeps the complete harness tool catalog and Qwen-safe choices", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS[id];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new Provider({
      apiKey: key,
      model,
      tools: [...TOOLS],
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "use tools" }], {
      toolChoice: "required",
      parallelToolCalls: true,
    });

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as { tools: unknown[]; tool_choice: string; parallel_tool_calls: boolean };
    expect(body.tools).toHaveLength(TOOLS.length);
    expect(body.tool_choice).toBe("required");
    expect(body.enable_thinking).toBe(false);
    expect(body.parallel_tool_calls).toBe(true);
    expect(
      chatCompletionsCapabilityHintsForProvider(id, model),
    ).toMatchObject({
      toolResultImagePolicy: "relay_as_user",
      replaysReasoningContent: true,
      disablesThinkingForForcedToolChoice: true,
    });
  });

  test("preserves named tool choice while disabling hybrid thinking", async () => {
    const model = "qwen3.7-max";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new Provider({
      apiKey: key,
      model,
      tools: [...TOOLS],
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "delegate" }], {
      toolChoice: { type: "function", name: "Agent" },
      reasoningEffort: "xhigh",
    });

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "Agent" },
    });
    expect(body.enable_thinking).toBe(false);
    expect(body.preserve_thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual([
      "enable_thinking",
      "max_completion_tokens",
      "messages",
      "model",
      "stream",
      "tool_choice",
      "tools",
    ]);
  });

  test.each(["qwen3.7-max", "qwen3.6-flash"])(
    "sends preserve_thinking for a %s non-streaming tool continuation",
    async (model) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        successfulChat(model),
      );
      const provider = new Provider({
        apiKey: key,
        model,
        tools: [...TOOLS],
        fetchImpl,
      });

      await provider.chat(thinkingToolLoopMessages(id, model), {
        toolChoice: "auto",
        parallelToolCalls: true,
      });

      const body = JSON.parse(
        String(fetchImpl.mock.calls[0]?.[1]?.body),
      ) as Record<string, unknown>;
      expect(body).toMatchObject({
        model,
        stream: false,
        preserve_thinking: true,
        tool_choice: "auto",
        parallel_tool_calls: true,
      });
      expect(body.enable_thinking).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      expect(Object.keys(body).sort()).toEqual([
        "max_completion_tokens",
        "messages",
        "model",
        "parallel_tool_calls",
        "preserve_thinking",
        "stream",
        "tool_choice",
        "tools",
      ]);
      expect(body.messages).toEqual([
        { role: "user", content: "inspect the workspace" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "opaque thinking continuity",
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
        },
        { role: "tool", content: "ok", tool_call_id: "call_echo" },
        { role: "user", content: "continue" },
      ]);
    },
  );

  test.each(["qwen3.7-max", "qwen3.6-flash"])(
    "sends preserve_thinking for a %s streaming tool continuation",
    async (model) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        sseResponse([
          `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"done"}}]}\n\n`,
          'data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      );
      const provider = new Provider({
        apiKey: key,
        model,
        tools: [...TOOLS],
        fetchImpl,
      });

      await provider.chatStream(
        thinkingToolLoopMessages(id, model),
        () => {},
        { toolChoice: "auto" },
      );

      const body = JSON.parse(
        String(fetchImpl.mock.calls[0]?.[1]?.body),
      ) as Record<string, unknown>;
      expect(body).toMatchObject({
        model,
        stream: true,
        preserve_thinking: true,
        tool_choice: "auto",
        stream_options: { include_usage: true },
      });
      expect(body.enable_thinking).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
      expect(Object.keys(body).sort()).toEqual([
        "max_completion_tokens",
        "messages",
        "model",
        "preserve_thinking",
        "stream",
        "stream_options",
        "tool_choice",
        "tools",
      ]);
    },
  );

  test("keeps qwen3.8 reasoning_effort controls independent", async () => {
    const model = "qwen3.8-max";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new Provider({ apiKey: key, model, fetchImpl });

    await provider.chat([{ role: "user", content: "reason carefully" }], {
      reasoningEffort: "xhigh",
    });

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("xhigh");
    expect(body.preserve_thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual([
      "max_completion_tokens",
      "messages",
      "model",
      "reasoning_effort",
      "stream",
    ]);
  });

  test("round-trips two overlength MCP names that share a prefix", async () => {
    const model = "qwen3.8-max";
    const longTools: LLMTool[] = LONG_MCP_TOOL_NAMES.map((name) => ({
      type: "function",
      function: {
        name,
        description: `Run ${name}`,
        parameters: { type: "object", properties: {} },
      },
    }));
    let selectedWireName = "";
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tools: Array<{ function: { name: string } }>;
          tool_choice: { function: { name: string } };
        };
        const wireNames = body.tools.map((tool) => tool.function.name);
        expect(wireNames).toHaveLength(2);
        expect(new Set(wireNames).size).toBe(2);
        expect(wireNames.every((name) => name.length <= 64)).toBe(true);
        expect(wireNames.every((name) => /^toolh__/.test(name))).toBe(true);
        selectedWireName = wireNames[1]!;
        expect(body.tool_choice.function.name).toBe(selectedWireName);
        return successfulChat(model, "", {
          tool_calls: [
            {
              id: "call_long",
              type: "function",
              function: { name: selectedWireName, arguments: "{}" },
            },
          ],
        });
      },
    );
    const provider = new Provider({
      apiKey: key,
      model,
      tools: longTools,
      fetchImpl,
    });

    const response = await provider.chat(
      [{ role: "user", content: "use the second plugin tool" }],
      {
        toolChoice: {
          type: "function",
          name: LONG_MCP_TOOL_NAMES[1],
        },
      },
    );

    expect(selectedWireName).toMatch(/^toolh__/);
    expect(response.toolCalls).toEqual([
      { id: "call_long", name: LONG_MCP_TOOL_NAMES[1], arguments: "{}" },
    ]);
  });

  test("round-trips an overlength MCP name on the streaming path", async () => {
    const model = "qwen3.8-max";
    const longTools: LLMTool[] = LONG_MCP_TOOL_NAMES.map((name) => ({
      type: "function",
      function: {
        name,
        description: `Run ${name}`,
        parameters: { type: "object", properties: {} },
      },
    }));
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tools: Array<{ function: { name: string } }>;
        };
        const selectedWireName = body.tools[0]!.function.name;
        return sseResponse([
          `data: {"model":"${model}","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_stream_long","type":"function","function":{"name":"${selectedWireName}","arguments":"{}"}}]}}]}\n\n`,
          'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ]);
      },
    );
    const provider = new Provider({
      apiKey: key,
      model,
      tools: longTools,
      fetchImpl,
    });

    const response = await provider.chatStream(
      [{ role: "user", content: "stream the first plugin tool" }],
      () => {},
    );

    expect(response.toolCalls).toEqual([
      {
        id: "call_stream_long",
        name: LONG_MCP_TOOL_NAMES[0],
        arguments: "{}",
      },
    ]);
  });

  test("sends vision input and relays tool images after string tool output", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS[id];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model, "image inspected"),
    );
    const provider = new Provider({ apiKey: key, model, fetchImpl });

    await provider.chat([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect" },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,aW1hZ2U=" },
          },
        ],
      },
      {
        role: "assistant",
        content: "",
        providerReasoningContent: "opaque-reasoning-state",
        providerReasoningProvenance: { provider: id, model },
        toolCalls: [
          { id: "call_read", name: "FileRead", arguments: "{}" },
        ],
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
    expect(body.messages[0]).toMatchObject({
      role: "user",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "image_url" }),
      ]),
    });
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "opaque-reasoning-state",
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      content: "Image Size: 10x10.",
      tool_call_id: "call_read",
    });
    expect(body.messages[3]).toMatchObject({
      role: "user",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "image_url" }),
      ]),
    });
  });

  test("preserves reasoning_content across a tool-call response", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS[id];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model, "", {
        reasoning_content: "provider replay token",
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
    );
    const provider = new Provider({ apiKey: key, model, fetchImpl });

    const response = await provider.chat([
      { role: "user", content: "call echo" },
    ]);

    expect(response.providerReasoningContent).toBe("provider replay token");
    expect(response.providerReasoningProvenance).toEqual({
      provider: id,
      model,
    });
    expect(response.thinking?.[0]?.text).toBe("provider replay token");
    expect(response.toolCalls).toEqual([
      { id: "call_echo", name: "system.echo", arguments: '{"text":"ok"}' },
    ]);
  });

  test("streams visible text and hidden reasoning without mixing them", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS[id];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        `data: {"model":"${model}","choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}\n\n`,
        `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"done"}}]}\n\n`,
        'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new Provider({ apiKey: key, model, fetchImpl });

    const response = await provider.chatStream(
      [{ role: "user", content: "work" }],
      () => {},
    );

    expect(response.content).toBe("done");
    expect(response.thinking?.[0]?.text).toBe("think");
    expect(response.providerReasoningContent).toBe("think");
    expect(response.providerReasoningProvenance).toEqual({
      provider: id,
      model,
    });
    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("never replays reasoning from another provider or model", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS[id];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new Provider({ apiKey: key, model, fetchImpl });

    await provider.chat([
      { role: "user", content: "continue the tool loop" },
      {
        role: "assistant",
        content: "",
        providerReasoningContent: "private DeepSeek reasoning",
        providerReasoningProvenance: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
        },
        toolCalls: [{ id: "call_read", name: "FileRead", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "call_read",
        toolName: "FileRead",
        content: "done",
      },
      {
        role: "assistant",
        content: "old Qwen state",
        providerReasoningContent: "private state from another Qwen model",
        providerReasoningProvenance: {
          provider: id,
          model: "qwen3.8-flash",
        },
      },
      {
        role: "assistant",
        content: "legacy unbound state",
        providerReasoningContent: "legacy opaque state without provenance",
      },
      { role: "user", content: "finish" },
    ]);

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as { messages: Array<Record<string, unknown>> };
    const assistantMessages = body.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(3);
    expect(assistantMessages[0]?.reasoning_content).toBeUndefined();
    expect(assistantMessages[1]?.reasoning_content).toBeUndefined();
    expect(assistantMessages[2]?.reasoning_content).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private DeepSeek reasoning");
    expect(JSON.stringify(body)).not.toContain(
      "private state from another Qwen model",
    );
    expect(JSON.stringify(body)).not.toContain(
      "legacy opaque state without provenance",
    );
  });

  test("strips tool-result images for qwen3.7-max", async () => {
    const model = "qwen3.7-max";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new Provider({ apiKey: key, model, fetchImpl });

    await provider.chat([
      { role: "user", content: "read the result" },
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
    expect(JSON.stringify(body)).not.toContain("image_url");
    expect(
      chatCompletionsCapabilityHintsForProvider(id, model),
    ).toMatchObject({ toolResultImagePolicy: "strip" });
  });

  test("keeps image-only tool results text-only for qwen3.7-max", async () => {
    const model = "qwen3.7-max";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new Provider({ apiKey: key, model, fetchImpl });

    await provider.chat([
      { role: "user", content: "read the result" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_read", name: "FileRead", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "call_read",
        toolName: "FileRead",
        content: [{
          type: "image_url",
          image_url: { url: "data:image/png;base64,dG9vbA==" },
        }],
      },
    ]);

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as { messages: Array<Record<string, unknown>> };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2]).toEqual({
      role: "tool",
      content:
        "[Tool returned image content; this model does not accept image input.]",
      tool_call_id: "call_read",
    });
    expect(JSON.stringify(body)).not.toContain("image_url");
  });

  test("strips tool-result images on the qwen3.7-max streaming path", async () => {
    const model = "qwen3.7-max";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        `data: {"model":"${model}","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n`,
        'data: {"choices":[{"index":0,"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new Provider({ apiKey: key, model, fetchImpl });

    await provider.chatStream([
      { role: "user", content: "read the result" },
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
    ], () => {});

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as { messages: Array<Record<string, unknown>> };
    expect(body.messages[2]).toEqual({
      role: "tool",
      content: "Image Size: 10x10.",
      tool_call_id: "call_read",
    });
    expect(JSON.stringify(body)).not.toContain("image_url");
  });
});

describe("QwenCloud registration and fail-closed routing", () => {
  test.each(["qwen", "qwen-token-plan"] as const)(
    "registers %s models with authoritative context and capabilities",
    (provider) => {
      expect(BUILT_IN_PROVIDER_DEFAULT_MODELS[provider]).toBe("qwen3.8-max");
      expect(BUILT_IN_PROVIDER_MODEL_CATALOG[provider]).toContain(
        "qwen3.8-max",
      );
      expect(
        resolveModelCatalogMetadata({ provider, model: "qwen3.8-max" }),
      ).toEqual({
        contextWindow: 1_000_000,
        maxContextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        maxOutputTokensUpperLimit: 131_072,
      });
      expect(
        resolveRegisteredModelCatalogEntry({
          provider,
          model: "qwen3.8-max",
        }),
      ).toMatchObject({
        inputModalities: ["text", "image"],
        supportsToolUse: true,
        supportsParallelToolCalls: true,
        supportsStructuredOutput: false,
        supportedReasoningLevels: ["low", "medium", "xhigh"],
        defaultReasoningLevel: "xhigh",
      });
      expect(
        resolveProviderCapabilityEntry({ provider, model: "qwen3.8-max" }),
      ).toMatchObject({
        supportsToolUse: true,
        supportsImageInput: true,
        acceptsImageHistory: true,
        supportsStructuredOutput: false,
        supportsExtendedThinking: true,
        acceptsThinkingHistory: true,
        acceptsReasoningEffort: true,
      });
    },
  );

  test("keeps a text-only model from claiming vision", () => {
    expect(
      resolveProviderCapabilityEntry({
        provider: "qwen-token-plan",
        model: "qwen3.7-max",
      }),
    ).toMatchObject({ supportsImageInput: false, acceptsImageHistory: false });
  });

  test.each([
    ["qwen", "qwen3.7-flash", true],
    ["qwen", "qwen3.6-plus", true],
    ["qwen-token-plan", "qwen3.7-max", true],
    ["qwen-token-plan", "qwen3.6-flash", true],
    ["qwen-token-plan", "qwen3.7-flash", false],
    ["qwen-token-plan", "qwen3.6-plus", false],
  ] as const)(
    "%s thinking-history capability for %s is %s",
    (provider, model, expected) => {
      expect(
        resolveProviderCapabilityEntry({ provider, model }),
      ).toMatchObject({
        supportsExtendedThinking: expected,
        acceptsThinkingHistory: expected,
        acceptsReasoningEffort: false,
      });
      expect(
        chatCompletionsCapabilityHintsForProvider(provider, model)
          .preservesThinkingHistory === true,
      ).toBe(expected);
    },
  );

  test.each(["qwen", "qwen-token-plan"] as const)(
    "fails closed on tool-result images for an unknown %s model",
    (provider) => {
      expect(
        chatCompletionsCapabilityHintsForProvider(
          provider,
          "future-unregistered-model",
        ),
      ).toMatchObject({ toolResultImagePolicy: "strip" });
    },
  );

  test("keeps billing keys and endpoints isolated", () => {
    expect(
      () =>
        new QwenProvider({ apiKey: "sk-sp-test", model: "qwen3.8-max" }),
    ).toThrow(/Token Plan.*select qwen-token-plan/i);
    expect(
      () =>
        new QwenTokenPlanProvider({
          apiKey: "sk-ws-test",
          model: "qwen3.8-max",
        }),
    ).toThrow(/dedicated sk-sp/i);
    expect(
      () =>
        new QwenProvider({
          apiKey: "sk-ws-test",
          model: "qwen3.8-max",
          baseURL:
            "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        }),
    ).toThrow(/cannot use the qwen-token-plan endpoint/i);
  });

  test("rejects generation models on the chat transport", () => {
    expect(
      () =>
        new QwenProvider({
          apiKey: "sk-ws-test",
          model: "qwen-image-3.0",
        }),
    ).toThrow(/not a chat-completions model.*ImagineImage/i);
    expect(
      () =>
        new QwenTokenPlanProvider({
          apiKey: "sk-sp-test",
          model: "wan2.7-image",
        }),
    ).toThrow(/not a chat-completions model.*ImagineImage/i);
    expect(
      () =>
        new QwenTokenPlanProvider({
          apiKey: "sk-sp-test",
          model: "some-third-party-model",
        }),
    ).toThrow(/not in the current Token Plan Qwen chat allowlist/i);
  });

  test("resolves independent canonical environment authority", () => {
    const payGo = resolveProviderCredentialAuthority(
      "qwen",
      { model: "qwen3.8-max" },
      {
        DASHSCOPE_API_KEY: "sk-ws-environment",
        DASHSCOPE_BASE_URL: "https://paygo.invalid/v1",
      },
    );
    const tokenPlan = resolveProviderCredentialAuthority(
      "qwen-token-plan",
      { model: "qwen3.8-max" },
      {
        QWEN_TOKEN_PLAN_API_KEY: "sk-sp-environment",
        QWEN_TOKEN_PLAN_BASE_URL: "https://plan.invalid/v1",
      },
    );

    expect(payGo.factoryOptions).toMatchObject({
      apiKey: "sk-ws-environment",
      baseURL: "https://paygo.invalid/v1",
    });
    expect(tokenPlan.factoryOptions).toMatchObject({
      apiKey: "sk-sp-environment",
      baseURL: "https://plan.invalid/v1",
    });
    expect(payGo.credential).toMatchObject({
      provenance: {
        fields: [{ role: "apiKey", envVar: "DASHSCOPE_API_KEY" }],
      },
    });
    expect(tokenPlan.credential).toMatchObject({
      provenance: {
        fields: [{ role: "apiKey", envVar: "QWEN_TOKEN_PLAN_API_KEY" }],
      },
    });
  });
});
