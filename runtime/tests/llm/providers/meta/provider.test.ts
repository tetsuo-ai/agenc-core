import { describe, expect, test, vi } from "vitest";

import { resolveProviderCapabilityEntry } from "../../capabilities.js";
import { createProvider, readProviderIdentity } from "../../provider.js";
import { resolveProviderCredentialAuthority } from "../../provider-options.js";
import { MetaProvider } from "./index.js";
import {
  resolveModelCatalogMetadata,
  resolveRegisteredModelCatalogEntry,
} from "../../registry/model-catalog.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
} from "../../registry/provider-info.js";
import { getTokenizerConfigForProvider } from "../../token-estimation.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../wire/capability-gating.js";
import type { LLMTool, LLMToolChoice } from "../../types.js";

function successfulChat(model: string, content = "ok"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_meta",
      model,
      choices: [
        {
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 1,
        total_tokens: 4,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("MetaProvider", () => {
  const echoTool: LLMTool = {
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

  test("factory uses Meta chat completions with bearer auth", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.meta;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => successfulChat(model));
    const provider = createProvider("meta", {
      apiKey: "meta-test",
      extra: { fetchImpl },
    });

    expect(provider).toBeInstanceOf(MetaProvider);
    expect(readProviderIdentity(provider)).toBe("meta");

    const response = await provider.chat([{ role: "user", content: "hello" }]);
    expect(response.content).toBe("ok");

    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS.meta}/chat/completions`,
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer meta-test");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model, stream: false });
    expect(body.max_completion_tokens).toBeTypeOf("number");
    expect(body.max_tokens).toBeUndefined();
  });

  test("requires an explicit resolved Meta credential", () => {
    expect(() => createProvider("meta", {})).toThrow(/meta.*apiKey/i);
  });

  test.each(BUILT_IN_PROVIDER_MODEL_CATALOG.meta)(
    "registers and routes chat model %s",
    async (model) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        successfulChat(model),
      );
      const provider = new MetaProvider({
        apiKey: "meta-test",
        model,
        fetchImpl,
      });

      await provider.chat(
        [{ role: "user", content: "hello" }],
        { maxOutputTokens: 131_072 },
      );

      const [, init] = fetchImpl.mock.calls[0] ?? [];
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe(model);
      expect(body.max_completion_tokens).toBe(131_072);
      expect(body.max_tokens).toBeUndefined();
      expect(resolveModelCatalogMetadata({ provider: "meta", model })).toEqual({
        contextWindow: 1_048_576,
        maxContextWindow: 1_048_576,
        maxOutputTokens: 131_072,
        maxOutputTokensUpperLimit: 131_072,
      });
      expect(resolveProviderCapabilityEntry({ provider: "meta", model }))
        .toMatchObject({
          supportsToolUse: true,
          supportsStructuredOutput: true,
          supportsStructuredOutputWithTools: true,
          supportsImageInput: true,
          supportsVisionInput: true,
          acceptsImageHistory: true,
          supportsProviderNativeWebSearch: false,
          acceptsReasoningEffort: true,
        });
      expect(
        resolveRegisteredModelCatalogEntry({ provider: "meta", model }),
      ).toMatchObject({
        supportedReasoningLevels: [
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
        ],
        defaultReasoningLevel: "medium",
        inputModalities: ["text", "image"],
        supportsParallelToolCalls: true,
        supportsStructuredOutput: true,
      });
    },
  );

  test("forwards only Meta's accepted reasoning levels", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.meta;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => successfulChat(model));
    const provider = new MetaProvider({ apiKey: "meta-test", model, fetchImpl });

    await provider.chat(
      [{ role: "user", content: "reason carefully" }],
      { reasoningEffort: "xhigh" },
    );
    await provider.chat(
      [{ role: "user", content: "reason carefully" }],
      { reasoningEffort: "none" },
    );

    const acceptedBody = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    const rejectedBody = JSON.parse(
      String(fetchImpl.mock.calls[1]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(acceptedBody.reasoning_effort).toBe("xhigh");
    expect(rejectedBody.reasoning_effort).toBeUndefined();

    const hints = chatCompletionsCapabilityHintsForProvider("meta", model);
    expect(hints.acceptsReasoningEffort).toBe(true);
    expect([...(hints.reasoningEffortAllowedValues ?? [])]).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test.each([
    ["auto", "auto", "auto", true],
    ["required", "required", "auto", true],
    [
      "named",
      { type: "function", name: "system.echo" },
      "auto",
      true,
    ],
    ["none", "none", undefined, false],
  ] as const satisfies ReadonlyArray<
    readonly [string, LLMToolChoice, "auto" | undefined, boolean]
  >)("applies Meta's auto-only tool choice contract for %s", async (
    _label,
    toolChoice,
    expectedToolChoice,
    expectsTools,
  ) => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.meta;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new MetaProvider({
      apiKey: "meta-test",
      model,
      tools: [echoTool],
      fetchImpl,
    });

    await provider.chat(
      [{ role: "user", content: "use a tool" }],
      {
        toolChoice,
        ...(toolChoice === "none" ? { parallelToolCalls: true } : {}),
      },
    );

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.tool_choice).toBe(expectedToolChoice);
    if (expectsTools) {
      expect(body.tools).toBeInstanceOf(Array);
    } else {
      expect(body.tools).toBeUndefined();
      expect(body.parallel_tool_calls).toBeUndefined();
    }
  });

  test("strips unsupported stop sequences while keeping parallel tool calls", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.meta;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model),
    );
    const provider = new MetaProvider({
      apiKey: "meta-test",
      model,
      tools: [echoTool],
      fetchImpl,
    });

    await provider.chat([{ role: "user", content: "use tools" }], {
      parallelToolCalls: true,
      stopSequences: ["END"],
    });

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.stop).toBeUndefined();
    expect(
      chatCompletionsCapabilityHintsForProvider("meta", model),
    ).toMatchObject({
      toolChoicePolicy: "auto_only",
      toolResultImagePolicy: "relay_as_user",
      acceptsStopSequences: false,
    });
  });

  test("sends direct user image input in Meta's supported schema with tools", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.meta;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model, JSON.stringify({ answer: "ok" })),
    );
    const provider = new MetaProvider({
      apiKey: "meta-test",
      model,
      tools: [echoTool],
      fetchImpl,
    });

    await provider.chat(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aW1hZ2U=" },
            },
          ],
        },
      ],
      {
        structuredOutput: {
          schema: {
            type: "json_schema",
            name: "answer",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        },
      },
    );

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.tools).toBeInstanceOf(Array);
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "answer", strict: true },
    });
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aW1hZ2U=" },
          },
        ],
      },
    ]);
  });

  test("relays multimodal tool results as supported user image input", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.meta;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model, "A cat is shown."),
    );
    const provider = new MetaProvider({
      apiKey: "meta-test",
      model,
      tools: [echoTool],
      fetchImpl,
    });

    await provider.chat([
      { role: "user", content: "Inspect the image" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read_image",
            name: "FileRead",
            arguments: '{"file_path":"/tmp/cat.png"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_read_image",
        toolName: "FileRead",
        content: [
          { type: "text", text: "Image Size: 640x480." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,Y2F0" },
          },
          { type: "text", text: "Read image successfully." },
        ],
      },
    ]);

    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.messages).toEqual([
      { role: "user", content: "Inspect the image" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_read_image",
            type: "function",
            function: {
              name: "FileRead",
              arguments: '{"file_path":"/tmp/cat.png"}',
            },
          },
        ],
      },
      {
        role: "tool",
        content: "Image Size: 640x480.\nRead image successfully.",
        tool_call_id: "call_read_image",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Image returned by tool FileRead." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,Y2F0" },
          },
        ],
      },
    ]);
  });

  test("keeps parallel tool results contiguous before relaying their images", async () => {
    const model = BUILT_IN_PROVIDER_DEFAULT_MODELS.meta;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      successfulChat(model, "Both images are visible."),
    );
    const provider = new MetaProvider({
      apiKey: "meta-test",
      model,
      fetchImpl,
    });

    await provider.chat([
      { role: "user", content: "Compare both images" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_first",
            name: "FileRead",
            arguments: '{"file_path":"/tmp/first.png"}',
          },
          {
            id: "call_second",
            name: "FileRead",
            arguments: '{"file_path":"/tmp/second.png"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_first",
        toolName: "FileRead",
        content: [
          { type: "text", text: "First image." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,Zmlyc3Q=" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_second",
        toolName: "FileRead",
        content: [
          { type: "text", text: "Second image." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,c2Vjb25k" },
          },
        ],
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
      "user",
    ]);
    expect(body.messages.slice(2, 4)).toEqual([
      {
        role: "tool",
        content: "First image.",
        tool_call_id: "call_first",
      },
      {
        role: "tool",
        content: "Second image.",
        tool_call_id: "call_second",
      },
    ]);
    expect(body.messages[4]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Image returned by tool FileRead." },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,Zmlyc3Q=" },
        },
        { type: "text", text: "Image returned by tool FileRead." },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,c2Vjb25k" },
        },
      ],
    });
  });

  test("resolves the Meta credential and endpoint from canonical env", () => {
    const resolved = resolveProviderCredentialAuthority(
      "meta",
      { model: BUILT_IN_PROVIDER_DEFAULT_MODELS.meta },
      {
        MODEL_API_KEY: "meta-environment-test",
        META_BASE_URL: "https://meta.invalid/v1",
      },
    );

    expect(resolved.credential).toMatchObject({
      status: "ready",
      mode: "api-key",
      source: "environment",
      provenance: {
        kind: "environment",
        fields: [{ role: "apiKey", envVar: "MODEL_API_KEY" }],
      },
    });
    expect(resolved.factoryOptions).toMatchObject({
      apiKey: "meta-environment-test",
      baseURL: "https://meta.invalid/v1",
    });
  });

  test("uses an explicit conservative Muse token estimate", () => {
    expect(
      getTokenizerConfigForProvider({
        provider: "meta",
        model: BUILT_IN_PROVIDER_DEFAULT_MODELS.meta,
      }),
    ).toMatchObject({ modelFamily: "meta", bytesPerToken: 4 });
  });

  test("does not expose Meta media endpoints as session LLMs", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.meta).not.toContain(
      "muse-image-1.0",
    );
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.meta).not.toContain(
      "muse-voice-transcribe-1.0",
    );
    expect(
      resolveProviderCapabilityEntry({
        provider: "meta",
        model: "unknown-meta-model",
      }).acceptsReasoningEffort,
    ).toBe(false);
  });
});
