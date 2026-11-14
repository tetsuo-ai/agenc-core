import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childModelProfile } from "../../../src/agents/provider-selector-profiles.js";
import { modelCapabilityTags } from "../../../src/commands/model-capability-tags.js";
import { readModelMenuSnapshot } from "../../../src/commands/model-menu-snapshot.js";
import { readProvidersHubModels } from "../../../src/commands/providers-hub-snapshot.js";
import type { SlashCommandContext } from "../../../src/commands/types.js";
import { resolveHomeContext } from "../../../src/config/home.js";
import { buildProviderModelCatalog, resolveProviderModelInput } from "../../../src/config/provider-model-authority.js";
import { resolveProviderModelCapabilities } from "../../../src/llm/capabilities.js";
import { ModelMetadataResolver } from "../../../src/llm/model-metadata.js";
import { assertModelCatalogSelection } from "../../../src/llm/model-catalog-selection.js";
import { LLMCapabilityError } from "../../../src/llm/errors.js";
import { QwenProvider, QwenTokenPlanProvider } from "../../../src/llm/providers/qwen/index.js";
import { resolveReasoningEffort } from "../../../src/llm/reasoning-effort.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { resolveProviderStructuredOutputMode } from "../../../src/llm/structured-output.js";
import { roughTokenCountEstimationForProvider } from "../../../src/llm/token-estimation.js";
import type { LLMChatOptions, LLMMessage, LLMTool } from "../../../src/llm/types.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { buildChatCompletionsRequest } from "../../../src/llm/wire/chat-completions.js";
import { computeUsdCostWithResolution, DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../../../src/session/cost.js";
import { resolveSessionReasoningEffort } from "../../../src/session/session-reasoning-effort.js";
import { reasoningEffortForModel } from "../../../src/session/reasoning-effort-for-model.js";
import { resolveProviderModelSelection } from "../../../src/session/provider-model-selection.js";
import * as effortSettings from "../../../src/utils/effort.js";

const provider = "qwen-token-plan";
const canonical = "qwen4-max-preview";
const alias = "qwen4.0-max-preview";
const ids = [canonical, alias] as const;
const efforts = ["none", "minimal", "low", "medium", "xhigh"] as const;
const lowEffortCases = ids.flatMap(model => (["none", "minimal"] as const).map(effort => ({ model, effort })));
const homes: string[] = [];
const tool: LLMTool = { type: "function", function: {
  name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
} };

function fixture(model: string) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(JSON.stringify({
    id: "chatcmpl-preview", model: alias,
    choices: [{ message: { role: "assistant", content: JSON.parse(String(init?.body)).response_format ? '{"ok":true}' : "OK",
      reasoning_content: "Check the result." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 15 } },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const instance = new QwenTokenPlanProvider({
    apiKey: "fixture", model, baseURL: "http://127.0.0.1:1/compatible-mode/v1", fetchImpl,
  });
  return { instance, fetchImpl, body: () => JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body)) };
}

describe("Qwen4 Max Preview, documentation checked 2026-11-13, no live calls", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-14T00:00:00Z") }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it.each(ids)("registers the exact Token Plan contract for %s", model => {
    expect(resolveRegisteredModelCatalogEntry({ provider, model })).toMatchObject({
      model, displayName: "Qwen4 Max Preview", contextWindow: 1_000_000, maxContextWindow: 1_000_000,
      maxOutputTokens: 393_216, inputModalities: ["text", "image"], supportsToolUse: true,
      supportsParallelToolCalls: true, supportsStructuredOutput: false, supportsSearchTool: false,
      supportedReasoningLevels: efforts, defaultReasoningLevel: "xhigh", retiresOn: "2026-11-25",
      visibility: model === canonical ? "list" : "none",
    });
    expect(resolveRegisteredModelCatalogEntry({ provider: "qwen", model })).toBeUndefined();
    expect(resolveRegisteredModelCatalogEntry({ provider, model: `${model}-future` })).toBeUndefined();
    expect(() => new QwenProvider({ model, apiKey: "fixture", fetchImpl: vi.fn() })).toThrow(/Token Plan only/i);
  });

  it("offers one preview picker row with a retirement tag", () => {
    const catalog = buildProviderModelCatalog({});
    expect(catalog[provider]?.filter(id => ids.includes(id as typeof canonical))).toEqual([canonical]);
    expect(catalog.qwen).not.toContain(canonical);
    expect(catalog.qwen).not.toContain(alias);
    expect(modelCapabilityTags(provider, canonical)).toBe("vision · thinking · retires 2026-11-25");
  });

  it.each([
    ["2026-11-24T23:59:59.999Z", false],
    ["2026-11-25T00:00:00.000Z", true],
    ["2026-11-25T16:00:00.000Z", true],
    ["2026-11-26T00:00:00.000Z", true],
    ["2027-01-01T00:00:00.000Z", true],
  ] as const)("offers and admits the preview only before Core's UTC retirement date at %s", (now, retired) => {
    vi.setSystemTime(new Date(now));
    const path = mkdtempSync(join(tmpdir(), "qwen4-retirement-"));
    homes.push(path);
    const environment = { AGENC_HOME: path };
    const context = { argsRaw: "", cwd: path, session: {
      state: { unsafePeek: () => ({ sessionConfiguration: {
        provider: { slug: provider }, collaborationMode: { model: "qwen3.8-max" },
      }, history: [] }) },
      activeTurn: { unsafePeek: () => null },
      services: { providerEnvironment: environment, configStore: {
        homeContext: resolveHomeContext(environment, { platformHome: path }), current: () => ({}),
      } },
    } } as unknown as SlashCommandContext;
    const offered = readModelMenuSnapshot(context).rows
      .filter(row => row.provider === provider && row.selectable).map(row => row.displayModel);
    const hub = readProvidersHubModels(context, provider).map(row => row.model);
    expect(offered.includes(canonical)).toBe(!retired);
    expect(hub.includes(canonical)).toBe(!retired);
    expect(offered).not.toContain(alias);
    expect(hub).not.toContain(alias);
    for (const model of ids) {
      expect(modelCapabilityTags(provider, model)).toContain(`${retired ? "retired" : "retires"} 2026-11-25`);
      const select = () => assertModelCatalogSelection({}, provider, model, {});
      const switchModel = () => resolveProviderModelSelection({}, { provider, model: "qwen3.8-max" }, { model }, {});
      if (retired) {
        expect(select).toThrow(`retired '${model}' on 2026-11-25`);
        expect(switchModel).toThrow(`retired '${model}' on 2026-11-25`);
      } else {
        expect(select).not.toThrow();
        expect(switchModel()).toMatchObject({ provider, model });
      }
    }
  });

  it.each(ids)("resolves %s with the full combined output reservation", model => {
    expect(resolveProviderModelInput({}, provider, model)).toEqual({ provider, model });
    const metadata = new ModelMetadataResolver({ env: {} }).resolveSync({ provider, model, config: {} });
    expect(metadata).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 393_216, maxOutputTokensUpperLimit: 393_216 });
    // Alibaba maps xhigh to 262,144 thinking tokens. The default leaves 131,072 for the answer.
    expect(metadata.maxOutputTokens! - 262_144).toBe(131_072);
  });

  it.each(ids)("keeps %s thinking and image history on the Token Plan", model => {
    expect(resolveProviderModelCapabilities({ provider, model })).toMatchObject({
      supportsToolUse: true, supportsImageInput: true, acceptsImageHistory: true,
      supportsExtendedThinking: true, acceptsThinkingHistory: true, acceptsReasoningEffort: true,
    });
    expect(chatCompletionsCapabilityHintsForProvider(provider, model)).toMatchObject({
      replaysReasoningContent: true, preservesThinkingHistory: true,
    });
  });

  it.each(ids)("sends only the canonical effort values for %s", model => {
    const contract = resolveReasoningEffort({ provider, model });
    expect(contract).toMatchObject({ registered: true, acceptsChatEffort: true, levels: efforts, defaultLevel: "xhigh" });
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const body = buildChatCompletionsRequest({ model, messages: [], tools: [],
        options: { reasoningEffort: effort }, providerCapabilityHints: chatCompletionsCapabilityHintsForProvider(provider, model) });
      expect(body.reasoning_effort).toBe(effort === "minimal" ? "low"
        : efforts.includes(effort as typeof efforts[number]) ? effort : undefined);
      expect(body).not.toHaveProperty("thinking_budget");
    }
    expect(resolveSessionReasoningEffort("max", efforts, { provider, model })).toBe("xhigh");
  });

  it.each(lowEffortCases)("preserves configured and carried $effort in $model request bodies", async ({ model, effort }) => {
    const { instance, body } = fixture(model);
    const levels = resolveRegisteredModelCatalogEntry({ provider, model })?.supportedReasoningLevels;
    expect(reasoningEffortForModel({ provider, model, reasoningEffort: effort })).toEqual({ reasoningEffort: effort });
    vi.spyOn(effortSettings, "getInitialEffortSetting").mockReturnValue(effort);
    for (const requested of [effort, undefined]) {
      const resolved = resolveSessionReasoningEffort(requested, levels, { provider, model });
      expect(resolved).toBe(effort);
      await instance.chat([{ role: "user", content: "OK" }], { reasoningEffort: resolved });
      expect(body()).toEqual({ model, stream: false, messages: [{ role: "user", content: "OK" }],
        max_completion_tokens: 393_216, preserve_thinking: true, reasoning_effort: effort === "minimal" ? "low" : "none" });
    }
  });

  it.each(lowEffortCases)("maps $effort on streamed $model request overrides", async ({ model, effort }) => {
    const { instance, fetchImpl, body } = fixture("qwen3.8-max");
    fetchImpl.mockImplementation(async () => new Response(
      `data: ${JSON.stringify({ id: "preview", model, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ));
    await instance.chatStream([{ role: "user", content: "OK" }], () => {}, { model, reasoningEffort: effort });
    expect(body()).toMatchObject({ model, stream: true, reasoning_effort: effort === "minimal" ? "low" : "none" });
    expect(body()).not.toHaveProperty("thinking_budget");
    expect(body()).not.toHaveProperty("enable_thinking");
  });

  it.each(ids)("uses the Qwen tokenizer estimate and strong routing prior for %s", model => {
    expect(roughTokenCountEstimationForProvider("x".repeat(380), { provider, model })).toBe(100);
    expect(childModelProfile(provider, model)).toBeDefined();
    expect(childModelProfile(provider, model)).toBe(childModelProfile(provider, "qwen3.8-max"));
    expect(childModelProfile("qwen", model)).toBeUndefined();
  });

  it.each(ids)("accounts for %s as plan usage without inventing a PAYG price", model => {
    const price = resolveModelCostEntry({ provider, model }, DEFAULT_MODEL_COSTS);
    expect(price).toMatchObject({ key: `${provider}:${model}`,
      entry: { inputUsdPer1K: 0, outputUsdPer1K: 0, label: "plan", localZeroCost: true } });
    expect(resolveModelCostEntry({ provider: "qwen", model }, DEFAULT_MODEL_COSTS)).toBeNull();
    expect(computeUsdCostWithResolution({ provider, model, inputTokens: 100, outputTokens: 20,
      cachedInputTokens: 40, cacheCreationInputTokens: 0, reasoningOutputTokens: 15,
      webSearchRequests: 0, totalTokens: 120, turns: 1 }, DEFAULT_MODEL_COSTS)).toMatchObject({ known: true, costUsd: 0 });
  });

  it.each(ids)("accepts %s and snapshots a default request with reasoning replay", async model => {
    const { instance, fetchImpl, body } = fixture(model);
    const messages: LLMMessage[] = [
      { role: "user", content: "Check." },
      { role: "assistant", content: "Checked.", providerReasoningContent: "Inspect the input.",
        providerReasoningProvenance: { provider, model } },
      { role: "user", content: "Continue." },
    ];
    const response = await instance.chat(messages, { reasoningEffort: "xhigh" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:1/compatible-mode/v1/chat/completions");
    expect({ ...body(), model: canonical }).toMatchInlineSnapshot(`
      {
        "max_completion_tokens": 393216,
        "messages": [
          {
            "content": "Check.",
            "role": "user",
          },
          {
            "content": "Checked.",
            "reasoning_content": "Inspect the input.",
            "role": "assistant",
          },
          {
            "content": "Continue.",
            "role": "user",
          },
        ],
        "model": "qwen4-max-preview",
        "preserve_thinking": true,
        "reasoning_effort": "xhigh",
        "stream": false,
      }
    `);
    expect(body().model).toBe(model);
    expect(response.providerReasoningContent).toBe("Check the result.");
    expect(response.providerReasoningProvenance).toEqual({ provider, model });
    expect(response.usage).toMatchObject({ promptTokens: 100, completionTokens: 20, reasoningOutputTokens: 15 });
  });

  it("honors explicit output caps and bounds oversized requests for either ID and overrides", async () => {
    const { instance, body } = fixture(canonical);
    for (const model of ids) {
      for (const maxOutputTokens of [8192, 393_216, 500_000]) {
        await instance.chat([{ role: "user", content: "OK" }], { model, maxOutputTokens });
        expect(body().max_completion_tokens).toBe(Math.min(maxOutputTokens, 393_216));
        expect(body()).not.toHaveProperty("max_tokens");
        expect(body()).not.toHaveProperty("thinking_budget");
      }
    }
  });

  it("keeps images and tools on the new request", async () => {
    const { instance, body } = fixture(canonical);
    const options: LLMChatOptions = { tools: [tool], toolChoice: "auto", parallelToolCalls: true, reasoningEffort: "low" };
    await instance.chat([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] }], options);
    expect(body()).toMatchObject({ tools: [tool], tool_choice: "auto", parallel_tool_calls: true, reasoning_effort: "low",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] }] });
  });

  it.each(ids)("refuses JSON Schema locally for %s before fetching", async model => {
    const { instance, fetchImpl } = fixture(model);
    expect(resolveProviderStructuredOutputMode({ provider, model, api: "chat_completions" })).toBe("unsupported");
    await expect(instance.chat([{ role: "user", content: "Return JSON." }], {
      structuredOutput: { enabled: true, schema: { name: "result", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } },
    })).rejects.toBeInstanceOf(LLMCapabilityError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(ids)("streams %s tool calls and replays their thinking in the tool-result round trip", async model => {
    const { instance, fetchImpl, body } = fixture(model);
    fetchImpl.mockImplementationOnce(async () => new Response([
      { choices: [{ index: 0, delta: { reasoning_content: "Call echo." } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "echo", arguments: '{"value":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        completion_tokens_details: { reasoning_tokens: 15 } } },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }));
    const messages: LLMMessage[] = [{ role: "user", content: "Call echo." }];
    const response = await instance.chatStream(messages, vi.fn(), { tools: [tool], reasoningEffort: "medium" });
    expect(body()).toMatchObject({ model, max_completion_tokens: 393_216, stream: true,
      stream_options: { include_usage: true }, reasoning_effort: "medium" });
    expect(body()).not.toHaveProperty("tool_stream");
    expect(response.toolCalls).toMatchObject([{ id: "call-1", name: "echo", arguments: '{"value":"ok"}' }]);
    expect(response.usage).toMatchObject({ completionTokens: 20, reasoningOutputTokens: 15 });
    await instance.chat([...messages, { role: "assistant", content: response.content,
      toolCalls: response.toolCalls, providerReasoningContent: response.providerReasoningContent,
      providerReasoningProvenance: response.providerReasoningProvenance },
    { role: "tool", toolCallId: "call-1", content: "ok" }], { tools: [tool], reasoningEffort: "medium" });
    expect(body().messages[1]).toMatchObject({ reasoning_content: "Call echo.", tool_calls: [
      { id: "call-1", type: "function", function: { name: "echo", arguments: '{"value":"ok"}' } },
    ] });
    expect(body().messages[2]).toMatchObject({ role: "tool", tool_call_id: "call-1", content: "ok" });
  });

  it("retains the hybrid tool rule without sending effort alongside disabled thinking", async () => {
    const { instance, body } = fixture(canonical);
    await instance.chat([{ role: "user", content: "Call echo." }], { tools: [tool], toolChoice: "required", reasoningEffort: "xhigh" });
    expect(body()).toMatchObject({ tool_choice: "required", enable_thinking: false, max_completion_tokens: 393_216 });
    expect(body()).not.toHaveProperty("reasoning_effort");
    expect(body()).not.toHaveProperty("thinking_budget");
  });
});
