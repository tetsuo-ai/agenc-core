import { describe, expect, test, vi } from "vitest";

import { DeepSeekProvider } from "./index.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../../registry/provider-info.js";
import { DEEPSEEK_MODELS, DEEPSEEK_MODEL_ALIASES } from "../../registry/deepseek-models.js";
import { ModelMetadataResolver } from "../../model-metadata.js";
import { defaultConfig } from "../../../config/schema.js";
import { sessionConfigurationFromAgenCConfig } from "../../../session/configuration.js";
import type { LLMMessage } from "../../types.js";
import { bodyAt, createSuccessfulChatResponse, ECHO_TOOL, sseResponse } from "../openai-compatible-test-helpers.js";

describe("DeepSeekProvider", () => {
  test.each([...DEEPSEEK_MODELS, ...DEEPSEEK_MODEL_ALIASES])("$model preserves native effort and honors explicit output limits", ({ model }) => {
    const config = { ...defaultConfig(), model_provider: "deepseek", model, reasoning_effort: "max" as const };
    const resolver = new ModelMetadataResolver({ env: {} });
    const metadata = resolver.resolveSync({ provider: "deepseek", model, config });
    expect(metadata).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 64_000, maxOutputTokensUpperLimit: 384_000 });
    expect(resolver.resolveSync({ provider: "deepseek", model, config: { ...config, max_output_tokens: 8192 } }).maxOutputTokens).toBe(8192);
    const session = sessionConfigurationFromAgenCConfig({ config, provider: "deepseek", model, workspaceRoot: "/tmp/deepseek-contract" });
    expect(session.collaborationMode.reasoningEffort).toBe("max");
  });

  test.each(DEEPSEEK_MODELS.flatMap(({ model }) => (["low", "high", "max"] as const).map(reasoningEffort => ({ model, reasoningEffort }))))("$model sends native $reasoningEffort effort and replays reasoning across tool and user turns", async ({ model, reasoningEffort }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => createSuccessfulChatResponse("deepseek-contract")(model));
    const provider = new DeepSeekProvider({ apiKey: "deepseek-test", model, fetchImpl, tools: [ECHO_TOOL] });
    const provenance = { provider: "deepseek", model };
    const messages: LLMMessage[] = [
      { role: "user", content: "first task" },
      { role: "assistant", content: "first answer", providerReasoningContent: "first reasoning", providerReasoningProvenance: provenance },
      { role: "user", content: "check the result" },
      { role: "assistant", content: "", providerReasoningContent: "tool reasoning", providerReasoningProvenance: provenance,
        toolCalls: [{ id: "call_echo", name: "system.echo", arguments: '{"text":"ok"}' }] },
      { role: "tool", toolCallId: "call_echo", toolName: "system.echo", content: "ok" },
    ];
    await provider.chat(messages, { reasoningEffort, maxOutputTokens: 64_000, parallelToolCalls: true, toolChoice: "required" });
    const body = bodyAt(fetchImpl);
    expect(body).toMatchObject({ reasoning_effort: reasoningEffort, thinking: { type: "enabled" }, max_tokens: 64_000 });
    expect(body.parallel_tool_calls).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect((body.messages as Record<string, unknown>[]).filter(row => row.role === "assistant").map(row => row.reasoning_content)).toEqual(["first reasoning", "tool reasoning"]);
    const foreign = messages.map(row => row.role === "assistant" ? { ...row, providerReasoningProvenance: { provider: "agenc", model } } : row);
    await provider.chat(foreign, { reasoningEffort });
    expect((bodyAt(fetchImpl, 1).messages as Record<string, unknown>[]).filter(row => row.role === "assistant").every(row => row.reasoning_content === undefined)).toBe(true);
  });

  test.each([...DEEPSEEK_MODELS, ...DEEPSEEK_MODEL_ALIASES])("$model streams a complete tool call and carries its reasoning into the next request", async ({ model }) => {
    const frame = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "deepseek-stream", model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse([
        frame({ reasoning_content: "check with the tool" }),
        frame({ tool_calls: [{ index: 0, id: "call_echo", type: "function", function: { name: "system.echo", arguments: '{"text":' } }] }),
        frame({ tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }),
        frame({}, "tool_calls"), "data: [DONE]\n\n",
      ]))
      .mockResolvedValueOnce(createSuccessfulChatResponse("deepseek-done")(model, "done"));
    const provider = new DeepSeekProvider({ apiKey: "deepseek-test", model, fetchImpl, tools: [ECHO_TOOL] });
    const response = await provider.chatStream([{ role: "user", content: "check" }], () => undefined, { reasoningEffort: "max" });
    expect(response.toolCalls).toEqual([{ id: "call_echo", name: "system.echo", arguments: '{"text":"ok"}' }]);
    await provider.chat([
      { role: "user", content: "check" },
      { role: "assistant", content: response.content, toolCalls: response.toolCalls, providerReasoningContent: response.providerReasoningContent, providerReasoningProvenance: response.providerReasoningProvenance },
      { role: "tool", toolCallId: "call_echo", toolName: "system.echo", content: "ok" },
    ], { reasoningEffort: "max" });
    expect((bodyAt(fetchImpl, 1).messages as Record<string, unknown>[]).find(row => row.role === "assistant")?.reasoning_content).toBe("check with the tool");
  });

  test.each([DEEPSEEK_MODELS[0]!, ...DEEPSEEK_MODEL_ALIASES])("$model sends images and relays tool images as user input", async ({ model }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(createSuccessfulChatResponse("deepseek-image")(model));
    const provider = new DeepSeekProvider({ apiKey: "deepseek-test", model, fetchImpl, tools: [ECHO_TOOL] });
    const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,aW1hZ2U=" } };
    await provider.chat([
      { role: "user", content: [{ type: "text", text: "Inspect" }, image] },
      { role: "assistant", content: "", toolCalls: [{ id: "call_echo", name: "system.echo", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_echo", toolName: "system.echo", content: [{ type: "text", text: "Screenshot" }, image] },
    ]);
    const messages = bodyAt(fetchImpl).messages as Record<string, unknown>[];
    expect(messages[0]).toMatchObject({ role: "user", content: expect.arrayContaining([image]) });
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_echo", content: "Screenshot" });
    expect(messages[3]).toMatchObject({ role: "user", content: expect.arrayContaining([image]) });
  });

  test("does not claim V4.1 vision support for V4 Pro", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new DeepSeekProvider({ apiKey: "deepseek-test", model: "deepseek-v4-pro", fetchImpl });
    await expect(provider.chat([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] }]))
      .rejects.toThrow("does not support image input");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("maps reasoning_content responses through the compat adapter", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_deepseek",
          model: "deepseek-v4-pro",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "reasoning trace",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 2,
            total_tokens: 10,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const provider = new DeepSeekProvider({
      apiKey: "deepseek-test",
      model: "deepseek-v4-pro",
      fetchImpl,
    });

    const response = await provider.chat([{ role: "user", content: "hello" }]);

    expect(response.content).toBe("reasoning trace");
    expect(response.providerReasoningProvenance).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    const [requestUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(
      `${BUILT_IN_PROVIDER_BASE_URLS.deepseek}/chat/completions`,
    );
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer deepseek-test");
  });
});
