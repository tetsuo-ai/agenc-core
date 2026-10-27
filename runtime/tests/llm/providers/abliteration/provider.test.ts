/**
 * abliteration.ai as a built-in provider. The `/v1/models` fixture holds the
 * three rows of the authenticated live list (2026-10-22) and the Large Flash
 * metadata read on 2026-10-23, whose limits and
 * prices match docs.abliteration.ai, and four `fixture-*` rows shaped by the
 * OpenAPI schema (`PublicModelListResponse`): a locked model, a model that is
 * not ready, a model without tools, and a model the bundled catalog does not
 * know.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createProvider, KNOWN_PROVIDER_NAMES, readProviderIdentity, type ProviderName } from "../../../../src/llm/provider.js";
import { resolveProviderCredentialAuthority } from "../../../../src/llm/provider-options.js";
import {
  BUILT_IN_PROVIDER_MODEL_CATALOG,
  providerApiKeyEnvironmentLabel,
  resolveBuiltInProviderInfo,
} from "../../../../src/llm/registry/provider-info.js";
import {
  ABLITERATION_BASE_URL,
  ABLITERATION_DEFAULT_MODEL,
  ABLITERATION_MODELS,
  parseAbliterationModels,
} from "../../../../src/llm/registry/abliteration-models.js";
import { resolveRegisteredModelCatalogEntry } from "../../../../src/llm/registry/model-catalog.js";
import { clearPublishedModelCatalogs } from "../../../../src/llm/registry/published-model-catalog.js";
import { recordPublishedModelCosts } from "../../../../src/llm/registry/published-model-costs.js";
import { resolveProviderCapabilityEntry } from "../../../../src/llm/capabilities.js";
import { resolveReasoningEffort } from "../../../../src/llm/reasoning-effort.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../../src/llm/wire/capability-gating.js";
import { ModelMetadataResolver } from "../../../../src/llm/model-metadata.js";
import { resolveZeroDataRetentionStatus } from "../../../../src/llm/zero-data-retention.js";
import { EndpointMetadataCache } from "../../../../src/llm/endpoint-metadata-cache.js";
import { collectProviderAvailability } from "../../../../src/llm/discovery/provider-discovery.js";
import { modelOffersEffortOffForContext } from "../../../../src/utils/effort.js";
import { AGENC_DAEMON_CLIENT_ENV_KEYS } from "../../../../src/app-server/protocol/index.js";
import { AGENC_DAEMON_CLIENT_ENV_KEYS as SDK_DAEMON_CLIENT_ENV_KEYS } from "../../../../../packages/agenc-sdk/src/protocol-wire.generated.js";
import { snapshotProviderEnvironment } from "../../../../src/llm/provider-environment.js";
import { redactDurableSecrets } from "../../../../src/session/provider-replay-redaction.js";
import { isSecretEnvKey, SUBPROCESS_SECRET_ENV } from "../../../../src/utils/secretEnv.js";
import {
  computeUsdCostWithResolution,
  DEFAULT_MODEL_COSTS,
  resolveModelCostEntry,
  type ModelUsage,
} from "../../../../src/session/cost.js";
import {
  LLMFundsError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
} from "../../../../src/llm/errors.js";
import type { LLMMessage, LLMTool } from "../../../../src/llm/types.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/abliteration-models.json", import.meta.url), "utf8"));
const provider = "abliteration" as ProviderName;
const key = "ak_fixture_only_credential";
const V2 = "abliterated-model-large-v2";
const BASE = "abliterated-model";
const LARGE = "abliterated-model-large";
const FLASH = "abliterated-model-large-flash";
const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const tool: LLMTool = {
  type: "function",
  function: {
    name: "mcp.fixture.read",
    description: "Read a fixture",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

/** `ChatCompletionRequest` is a closed object (`additionalProperties: false`) in the OpenAPI schema. */
const DOCUMENTED_REQUEST_FIELDS = new Set([
  "model", "messages", "policy_ids", "stream", "max_tokens", "max_completion_tokens", "temperature",
  "top_p", "frequency_penalty", "presence_penalty", "logit_bias", "n", "seed", "stop", "stream_options",
  "thinking", "reasoning", "reasoning_effort", "include_reasoning", "safety_identifier", "user",
  "structuredOutputs", "tools", "tool_choice", "parallel_tool_calls", "functions", "function_call",
  "response_format", "modalities", "verbosity", "audio", "prediction", "metadata", "store",
  "service_tier", "prompt_cache_key", "prompt_cache_retention", "logprobs", "top_logprobs",
  "prompt_logprobs", "web_search_options", "cache_salt",
]);
/** `ChatCompletionMessage` is closed as well. */
const DOCUMENTED_MESSAGE_FIELDS = new Set([
  "role", "content", "reasoning", "reasoning_content", "name", "tool_call_id", "tool_calls",
  "function_call", "model_id",
]);

function expectDocumentedRequest(body: Record<string, unknown>): void {
  expect(Object.keys(body).filter(field => !DOCUMENTED_REQUEST_FIELDS.has(field))).toEqual([]);
  for (const message of body.messages as Array<Record<string, unknown>>) {
    expect(Object.keys(message).filter(field => !DOCUMENTED_MESSAGE_FIELDS.has(field))).toEqual([]);
  }
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const reply = (message: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => json({
  id: "chatcmpl_fixture", object: "chat.completion", created: 1, model: V2,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done", ...message } }],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, ...usage },
});
const sse = (chunks: readonly unknown[], done = true) => new Response(
  chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""),
  { headers: { "content-type": "text/event-stream" } },
);
/** Chat requests only; a `/models` read answers 503 so discovery keeps the bundled rows. */
function chatFetch(...responses: Response[]) {
  const chat = vi.fn<typeof fetch>();
  for (const response of responses) chat.mockResolvedValueOnce(response);
  const fetchImpl: typeof fetch = async (input, init) => String(input).endsWith("/models")
    ? json({ error: { type: "provider_error", code: "unavailable", message: "fixture", request_id: "req_models" } }, 503)
    : chat(input, init);
  return { fetchImpl, chat, body: (index = 0) => JSON.parse(String(chat.mock.calls[index]?.[1]?.body)) as Record<string, any> };
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  clearPublishedModelCatalogs();
  recordPublishedModelCosts("abliteration", new Map());
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe("abliteration.ai built-in provider", () => {
  test("registers the provider, both key names and the endpoint override", () => {
    expect(resolveBuiltInProviderInfo("abliteration")).toMatchObject({
      id: "abliteration",
      name: "abliteration.ai",
      defaultModel: V2,
      baseURL: "https://api.abliteration.ai/v1",
      credentials: { kind: "api-key", apiKey: { envVars: ["ABLIT_KEY", "ABLITERATION_API_KEY"], required: true } },
      baseURLEnvVars: ["ABLITERATION_BASE_URL"],
      onboarding: { access: "api-key" },
    });
    expect(ABLITERATION_BASE_URL).toBe("https://api.abliteration.ai/v1");
    expect(ABLITERATION_DEFAULT_MODEL).toBe(V2);
    expect(providerApiKeyEnvironmentLabel("abliteration")).toBe("ABLIT_KEY or ABLITERATION_API_KEY");
    // ABLIT_KEY is the documented name and wins; the long name works alone.
    const both = resolveProviderCredentialAuthority(provider, { model: V2 }, { ABLIT_KEY: "first", ABLITERATION_API_KEY: "second" });
    expect(both.factoryOptions.apiKey).toBe("first");
    const second = resolveProviderCredentialAuthority(provider, { model: V2 }, { ABLITERATION_API_KEY: "second" });
    expect(second.factoryOptions.apiKey).toBe("second");
    // Another provider's key is never borrowed.
    const none = resolveProviderCredentialAuthority(provider, { model: V2 }, { OPENAI_API_KEY: "wrong", OPENAI_COMPATIBLE_API_KEY: "wrong", VENICE_API_KEY: "wrong" });
    expect(none.factoryOptions.apiKey).toBeUndefined();
    const routed = resolveProviderCredentialAuthority(provider, { model: V2 }, { ABLIT_KEY: key, ABLITERATION_BASE_URL: "http://127.0.0.1:9/v1" });
    expect(routed.factoryOptions.baseURL).toBe("http://127.0.0.1:9/v1");
  });

  test("daemon ingress carries the keys and the endpoint, and tools never inherit a key", () => {
    for (const name of ["ABLIT_KEY", "ABLITERATION_API_KEY", "ABLITERATION_BASE_URL"]) {
      expect(AGENC_DAEMON_CLIENT_ENV_KEYS).toContain(name);
      expect(SDK_DAEMON_CLIENT_ENV_KEYS).toContain(name);
    }
    expect(snapshotProviderEnvironment({ ABLIT_KEY: key, ABLITERATION_API_KEY: key })).toMatchObject({ ABLIT_KEY: key, ABLITERATION_API_KEY: key });
    for (const name of ["ABLIT_KEY", "ABLITERATION_API_KEY"]) {
      expect(isSecretEnvKey(name)).toBe(true);
      expect(SUBPROCESS_SECRET_ENV).toContain(name);
    }
    expect(JSON.stringify(redactDurableSecrets({ envOverrides: { ABLIT_KEY: key } }, "rollout"))).not.toContain(key);
  });

  test("bundles the documented models with their limits, modalities and prices", async () => {
    expect(ABLITERATION_MODELS.map(model => [model.model, model.displayName])).toEqual([
      [V2, "Abliterated Large v2"], [BASE, "Abliterated Model"], [LARGE, "Abliterated Large"],
      [FLASH, "Abliterated Large Flash"],
    ]);
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.abliteration).toEqual([V2, BASE, LARGE, FLASH]);
    const expected = {
      [BASE]: { context: 262_144, output: 262_134, image: true, prices: [1, 0.1, 3] },
      [V2]: { context: 1_000_000, output: 999_990, image: false, prices: [3, 0.3, 5] },
      [LARGE]: { context: 1_000_000, output: 999_990, image: false, prices: [3, 0.3, 5] },
      [FLASH]: { context: 1_048_576, output: 262_144, image: true, prices: [1, 0.1, 2] },
    } as const;
    for (const [model, facts] of Object.entries(expected)) {
      const entry = resolveRegisteredModelCatalogEntry({ provider: "abliteration", model });
      expect(entry).toMatchObject({
        contextWindow: facts.context,
        maxContextWindow: facts.context,
        // AgenC reserves 64k a call; the documented maximum stays reachable.
        maxOutputTokens: 65_536,
        maxOutputTokensUpperLimit: facts.output,
        maxOutputTokensCappedDefault: true,
        inputModalities: facts.image ? ["text", "image"] : ["text"],
        supportsToolUse: true,
        supportsThinking: true,
        supportsParallelToolCalls: true,
      });
      const [input, cached, output] = facts.prices;
      expect(DEFAULT_MODEL_COSTS[`abliteration:${model}`]).toEqual({
        inputUsdPer1K: input / 1000,
        outputUsdPer1K: output / 1000,
        cachedInputUsdPer1K: cached / 1000,
        cachedInputIncludedInInputTokens: true,
      });
    }
    // A model the catalog does not know does not borrow a neighbour's row by prefix.
    expect(resolveRegisteredModelCatalogEntry({ provider: "abliteration", model: "abliterated-model-large-v3" })).toBeUndefined();
    // The session plans against the documented window and reserves 64k a call.
    expect(await new ModelMetadataResolver({ env: {} }).resolve({ provider: "abliteration", model: V2, config: {} })).toMatchObject({
      contextWindow: 1_000_000, maxOutputTokens: 65_536, maxOutputTokensUpperLimit: 999_990, usedFallbackModelMetadata: false,
    });
    expect(await new ModelMetadataResolver({ env: {} }).resolve({ provider: "abliteration", model: BASE, config: {} })).toMatchObject({
      contextWindow: 262_144, maxOutputTokens: 65_536, maxOutputTokensUpperLimit: 262_134, usedFallbackModelMetadata: false,
    });
    expect(await new ModelMetadataResolver({ env: {} }).resolve({ provider: "abliteration", model: FLASH, config: {} })).toMatchObject({
      contextWindow: 1_048_576, maxOutputTokens: 64_000, maxOutputTokensUpperLimit: 262_144, usedFallbackModelMetadata: false,
    });
  });

  test("Large Flash inherits abliteration's retention policy, including endpoint overrides", () => {
    const status = (model: string, env = {}) => resolveZeroDataRetentionStatus({ provider, model, env, config: {} });
    expect(status(FLASH)).toEqual(status(V2));
    expect(status(FLASH)).toMatchObject({ state: "zdr" });
    expect(status(FLASH, { ABLITERATION_BASE_URL: "https://proxy.example/v1" })).toMatchObject({ state: "unknown" });
  });

  test("offers each model's own reasoning modes and sends only those", () => {
    const contract = (model: string) => resolveReasoningEffort({ provider: "abliteration", model });
    expect(contract(BASE)).toMatchObject({ registered: true, levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] });
    expect(contract(BASE).defaultLevel).toBeUndefined();
    expect(contract(V2)).toMatchObject({ registered: true, levels: ["low", "high", "max"], defaultLevel: "high" });
    expect(contract(LARGE)).toMatchObject({ registered: true, levels: ["high", "max"], defaultLevel: "high" });
    expect(contract(FLASH)).toMatchObject({ registered: true, levels: ["none", "low", "high", "max"], defaultLevel: "high" });
    for (const model of [BASE, V2, LARGE, FLASH]) {
      const hints = chatCompletionsCapabilityHintsForProvider("abliteration", model);
      expect(hints.acceptsReasoningEffort).toBe(true);
      expect(hints.reasoningEffortAllowedValues).toEqual(new Set(contract(model).levels));
    }
  });

  test("gates image input to the base model and Large Flash", async () => {
    expect(resolveProviderCapabilityEntry({ provider: "abliteration", model: BASE })).toMatchObject({ supportsImageInput: true, acceptsImageHistory: true });
    expect(resolveProviderCapabilityEntry({ provider: "abliteration", model: FLASH })).toMatchObject({ supportsImageInput: true, acceptsImageHistory: true });
    for (const model of [V2, LARGE]) {
      expect(resolveProviderCapabilityEntry({ provider: "abliteration", model })).toMatchObject({ supportsImageInput: false, acceptsImageHistory: false });
    }
    const message: LLMMessage = { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: IMAGE } }] };
    const text = chatFetch();
    await expect(createProvider(provider, { apiKey: key, model: V2, extra: { fetchImpl: text.fetchImpl, maxRetries: 0 } })
      .chat([message])).rejects.toThrow("does not support image input");
    expect(text.chat).not.toHaveBeenCalled();
    for (const model of [BASE, FLASH]) {
      const vision = chatFetch(reply());
      await createProvider(provider, { apiKey: key, model, extra: { fetchImpl: vision.fetchImpl, maxRetries: 0 } }).chat([message]);
      expect(JSON.stringify(vision.body().messages)).toContain(IMAGE);
    }
  });

  test.each([V2, FLASH])("%s sends abliteration's request shape and streamed usage", async model => {
    const http = chatFetch(reply(), sse([
      { choices: [{ index: 0, delta: { content: "ok" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, prompt_tokens_details: { cached_tokens: 8 } } },
    ]));
    const client = createProvider(provider, { apiKey: key, model, extra: { fetchImpl: http.fetchImpl, maxRetries: 0 } });
    expect(readProviderIdentity(client)).toBe("abliteration");
    await client.chat([{ role: "user", content: "hi" }], {
      tools: [], toolChoice: "auto", parallelToolCalls: true, promptCacheKey: "session-7d2a9f", reasoningEffort: "high",
    });
    expect(String(http.chat.mock.calls[0]?.[0])).toBe("https://api.abliteration.ai/v1/chat/completions");
    expect(new Headers(http.chat.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${key}`);
    const plain = http.body(0);
    expect(plain).toMatchObject({ model, prompt_cache_key: "session-7d2a9f", reasoning_effort: "high" });
    expect(plain).not.toHaveProperty("thinking");
    expect(chatCompletionsCapabilityHintsForProvider(provider, model).sharesPromptPrefixAcrossSessions).not.toBe(true);
    expect(chatCompletionsCapabilityHintsForProvider(provider, model).promptCacheKeyScope).not.toBe("prefix");
    // Chat Completions rejects an empty tools array and a tool choice without tools.
    expect(plain).not.toHaveProperty("tools");
    expect(plain).not.toHaveProperty("tool_choice");
    expect(plain).not.toHaveProperty("parallel_tool_calls");
    expectDocumentedRequest(plain);
    const streamed = await client.chatStream!([{ role: "user", content: "hi" }], () => {}, { promptCacheKey: "session-7d2a9f" });
    const stream = http.body(1);
    expect(stream).toMatchObject({ stream: true, stream_options: { include_usage: true }, prompt_cache_key: "session-7d2a9f" });
    expectDocumentedRequest(stream);
    expect(streamed.usage).toMatchObject({ promptTokens: 12, cachedInputTokens: 8 });
  });

  test.each([V2, FLASH])("%s repeats the session cache key in the provider's routing header", async model => {
    const http = chatFetch(reply(), sse([
      { choices: [{ index: 0, delta: { content: "ok" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } },
    ]), reply(), reply(), reply());
    const header = (index: number) => new Headers(http.chat.mock.calls[index]?.[1]?.headers);
    const client = createProvider(provider, { apiKey: key, model, extra: { fetchImpl: http.fetchImpl, maxRetries: 0 } });
    await client.chat([{ role: "user", content: "hi" }], { promptCacheKey: "conv-7d2a9f" });
    expect(header(0).get("x-abliteration-session-id")).toBe("conv-7d2a9f");
    expect(http.body(0).prompt_cache_key).toBe("conv-7d2a9f");
    await client.chatStream!([{ role: "user", content: "hi" }], () => {}, { promptCacheKey: "conv-7d2a9f" });
    expect(header(1).get("x-abliteration-session-id")).toBe("conv-7d2a9f");
    expect(header(1).get("authorization")).toBe(`Bearer ${key}`);
    expect(header(1).get("accept")).toBe("text/event-stream");
    // A key over the 64-character wire limit is hashed once, for the body and the header alike.
    await client.chat([{ role: "user", content: "hi" }], { promptCacheKey: `conv-${"x".repeat(80)}` });
    expect(http.body(2).prompt_cache_key).toMatch(/^[0-9a-f]{64}$/u);
    expect(header(2).get("x-abliteration-session-id")).toBe(http.body(2).prompt_cache_key);
    // No key, no header.
    await client.chat([{ role: "user", content: "hi" }]);
    expect(header(3).has("x-abliteration-session-id")).toBe(false);
    expect(http.body(3)).not.toHaveProperty("prompt_cache_key");
    // A key a header cannot carry stays in the body only.
    await client.chat([{ role: "user", content: "hi" }], { promptCacheKey: "conv-été" });
    expect(http.body(4).prompt_cache_key).toBe("conv-été");
    expect(header(4).has("x-abliteration-session-id")).toBe(false);
  });

  test("no other provider sends the abliteration session header", async () => {
    for (const name of KNOWN_PROVIDER_NAMES.filter(name => name !== "abliteration")) {
      expect(chatCompletionsCapabilityHintsForProvider(name, undefined).promptCacheKeyHeaders).toBeUndefined();
      expect(chatCompletionsCapabilityHintsForProvider(name, undefined, { managedGateway: true }).promptCacheKeyHeaders).toBeUndefined();
    }
    for (const [name, model] of [["venice", "zai-org-glm-5-2"], ["openrouter", "deepseek/deepseek-v4.1-flash-1017"], ["deepseek", "deepseek-flash"]] as const) {
      expect(chatCompletionsCapabilityHintsForProvider(name, model).promptCacheKeyHeaders).toBeUndefined();
    }
    // Venice also sends prompt_cache_key; its requests carry no session header.
    const http = chatFetch(reply());
    await createProvider("venice", { apiKey: "venice-fixture", model: "zai-org-glm-5-2", extra: { fetchImpl: http.fetchImpl, maxRetries: 0 } })
      .chat([{ role: "user", content: "hi" }], { promptCacheKey: "conv-7d2a9f" });
    expect(http.body(0).prompt_cache_key).toBe("conv-7d2a9f");
    expect(new Headers(http.chat.mock.calls[0]?.[1]?.headers).has("x-abliteration-session-id")).toBe(false);
  });

  test("reads the reasoning trace as thinking, keeps it out of the answer, and does not replay it", async () => {
    const http = chatFetch(
      // The live API sends `reasoning` (2026-10-22).
      reply({ content: "Paris.", reasoning: "The capital of France." }),
      // The docs name it `reasoning_content`.
      reply({ content: "Lyon.", reasoning_content: "Another city." }),
      reply(),
    );
    const client = createProvider(provider, { apiKey: key, model: V2, extra: { fetchImpl: http.fetchImpl, maxRetries: 0 } });
    const first = await client.chat([{ role: "user", content: "Capital?" }]);
    expect(first.content).toBe("Paris.");
    expect(first.thinking?.map(block => block.text).join("")).toBe("The capital of France.");
    const second = await client.chat([{ role: "user", content: "Another?" }]);
    expect(second.content).toBe("Lyon.");
    expect(second.thinking?.map(block => block.text).join("")).toBe("Another city.");
    await client.chat([
      { role: "user", content: "Capital?" },
      { role: "assistant", content: first.content, providerReasoningContent: first.providerReasoningContent, providerReasoningProvenance: first.providerReasoningProvenance },
      { role: "user", content: "Thanks" },
    ]);
    const assistant = (http.body(2).messages as Array<Record<string, unknown>>).find(message => message.role === "assistant")!;
    expect(assistant).not.toHaveProperty("reasoning");
    expect(assistant).not.toHaveProperty("reasoning_content");
  });

  test("prices cached input at a tenth of the input rate", () => {
    const usage = (model: string, input: number, cached: number, output: number): ModelUsage => ({
      provider: "abliteration", model, inputTokens: input, outputTokens: output, cachedInputTokens: cached,
      cacheCreationInputTokens: 0, reasoningOutputTokens: 0, webSearchRequests: 0, totalTokens: input + output, turns: 1,
    });
    // 600k fresh at $3, 400k cached at $0.30 and 100k out at $5 per million.
    expect(computeUsdCostWithResolution(usage(V2, 1_000_000, 400_000, 100_000), DEFAULT_MODEL_COSTS))
      .toMatchObject({ known: true, matchedKey: `abliteration:${V2}` });
    expect(computeUsdCostWithResolution(usage(V2, 1_000_000, 400_000, 100_000), DEFAULT_MODEL_COSTS).costUsd).toBeCloseTo(2.42, 10);
    // 500k fresh at $1, 500k cached at $0.10 and 1M out at $3 per million.
    expect(computeUsdCostWithResolution(usage(BASE, 1_000_000, 500_000, 1_000_000), DEFAULT_MODEL_COSTS).costUsd).toBeCloseTo(3.55, 10);
    expect(computeUsdCostWithResolution(usage(FLASH, 1_000_000, 500_000, 100_000), DEFAULT_MODEL_COSTS).costUsd).toBeCloseTo(0.75, 10);
  });

  test("reads the live model list: available, ready models with their limits, modalities and prices", async () => {
    const models = parseAbliterationModels(fixture);
    // Locked, not-ready and tool-less models are left out; the default model leads.
    expect(models.map(model => model.model)).toEqual([V2, BASE, LARGE, FLASH, "fixture-new-model"]);
    expect(models.find(model => model.model === "fixture-new-model")).toMatchObject({
      displayName: "Fixture New Model", contextWindow: 524_288, maxOutputTokens: 524_278, vision: true, thinking: true,
      // Effort levels are not published; an unknown model is sent none.
      reasoningLevels: [],
      cost: { inputUsdPer1K: 0.002, outputUsdPer1K: 0.006, cachedInputUsdPer1K: 0.0002, cachedInputIncludedInInputTokens: true },
    });
    // The live rows agree with the bundled ones.
    for (const bundled of ABLITERATION_MODELS) {
      expect(models.find(model => model.model === bundled.model)).toEqual(bundled);
    }
    expect(parseAbliterationModels({ data: "not a list" })).toEqual([]);
    expect(parseAbliterationModels({ data: [{ id: "x", access: { available: true, locked: false }, is_ready: true, output_modalities: ["image"] }] })).toEqual([]);

    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture));
    // Without a key the list is never requested.
    expect(await new ModelMetadataResolver({ fetchImpl, env: {} }).discoverAbliterationModels({})).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    const discovered = await new ModelMetadataResolver({ fetchImpl, env: { ABLIT_KEY: key } }).discoverAbliterationModels({});
    expect(discovered?.map(model => model.model)).toEqual([V2, BASE, LARGE, FLASH, "fixture-new-model"]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.abliteration.ai/v1/models");
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${key}`);
    // The published rows and prices now answer for the live-only model.
    expect(resolveRegisteredModelCatalogEntry({ provider: "abliteration", model: "fixture-new-model" })).toMatchObject({
      contextWindow: 524_288, maxOutputTokens: 65_536, maxOutputTokensUpperLimit: 524_278, inputModalities: ["text", "image"], supportedReasoningLevels: [],
    });
    expect(resolveProviderCapabilityEntry({ provider: "abliteration", model: "fixture-new-model" })).toMatchObject({ supportsImageInput: true, acceptsReasoningEffort: false });
    expect(resolveModelCostEntry({ provider: "abliteration", model: "fixture-new-model" }, DEFAULT_MODEL_COSTS)?.entry).toMatchObject({ outputUsdPer1K: 0.006 });
    expect(chatCompletionsCapabilityHintsForProvider("abliteration", "fixture-new-model").acceptsReasoningEffort).toBe(false);
  });

  test("reads the live list with a key saved through /providers when no variable is set", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture));
    const saved = vi.fn((name: string) => name === "abliteration" ? "ak_saved_fixture" : undefined);
    const models = await new ModelMetadataResolver({ fetchImpl, env: {}, readSavedApiKey: saved }).discoverAbliterationModels({});
    expect(models?.map(model => model.model)).toEqual([V2, BASE, LARGE, FLASH, "fixture-new-model"]);
    expect(saved).toHaveBeenCalledWith("abliteration");
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer ak_saved_fixture");
    // A variable wins over the saved key.
    fetchImpl.mockClear();
    await new ModelMetadataResolver({ fetchImpl, env: { ABLITERATION_API_KEY: "ak_env_fixture" }, readSavedApiKey: saved, endpointCatalogs: new EndpointMetadataCache() })
      .discoverAbliterationModels({});
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer ak_env_fixture");
  });

  test("agenc providers reports a missing or present key without leaking it", async () => {
    const missing = await collectProviderAvailability({ config: {}, env: {}, checkLocal: false });
    expect(missing.entries.find(entry => entry.provider === "abliteration"))
      .toMatchObject({ credentialStatus: "missing", keyEnvVar: "ABLIT_KEY", model: V2 });
    const present = await collectProviderAvailability({ config: {}, env: { ABLITERATION_API_KEY: key }, checkLocal: false });
    expect(present.entries.find(entry => entry.provider === "abliteration"))
      // The report names the canonical variable; which alias supplied the key stays private.
      .toMatchObject({ credentialStatus: "present", keyEnvVar: "ABLIT_KEY", model: V2, usable: true });
    expect(JSON.stringify(present)).not.toContain(key);
  });

  test("offers /effort off on the base model and Large Flash", () => {
    expect(modelOffersEffortOffForContext(BASE, { provider: "abliteration" } as never)).toBe(true);
    expect(modelOffersEffortOffForContext(FLASH, { provider: "abliteration" } as never)).toBe(true);
    expect(modelOffersEffortOffForContext(V2, { provider: "abliteration" } as never)).toBe(false);
    expect(modelOffersEffortOffForContext(LARGE, { provider: "abliteration" } as never)).toBe(false);
  });

  test("refuses a model the live list does not offer, before inference", async () => {
    const chat = vi.fn<typeof fetch>().mockResolvedValue(reply());
    const fetchImpl: typeof fetch = async (input, init) => String(input).endsWith("/models") ? json(fixture) : chat(input, init);
    const client = createProvider(provider, { apiKey: key, model: "fixture-locked-model", extra: { fetchImpl, maxRetries: 0 } });
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow("fixture-locked-model is not available to this abliteration.ai API key");
    await expect(client.chatStream!([{ role: "user", content: "hi" }], () => {}, { model: "fixture-warming-model" }))
      .rejects.toThrow("fixture-warming-model is not available to this abliteration.ai API key");
    expect(chat).not.toHaveBeenCalled();
    // A listed model goes ahead.
    await client.chat([{ role: "user", content: "hi" }], { model: V2 });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  test("a policy block is a clear, final error and an unevaluated policy is retryable", async () => {
    const blocked = { error: { type: "policy_error", code: "policy_violation", message: "The request was blocked by a safety policy.", request_id: "req_abc123" } };
    const http = chatFetch(json(blocked, 403), sse([blocked], false), sse([
      { error: { type: "policy_error", code: "policy_evaluation_unavailable", message: "A policy could not be evaluated. Retry the request.", request_id: "req_def456" } },
    ], false));
    const client = createProvider(provider, { apiKey: key, model: V2, extra: { fetchImpl: http.fetchImpl, maxRetries: 0 } });
    const request = await client.chat([{ role: "user", content: "hi" }]).catch((error: unknown) => error as Error);
    expect(request).toBeInstanceOf(LLMProviderError);
    expect(request.name).toBe("LLMProviderError");
    expect(request.message).toContain("abliteration.ai blocked this request with a policy");
    expect(request.message).toContain("Sending the same input again is blocked again");
    expect(request.message).toContain("req_abc123");
    expect(request.message).not.toMatch(/authentication|api key/i);
    expect(http.chat).toHaveBeenCalledTimes(1);
    // A response blocked mid-stream ends the turn the same way.
    const streamed = await client.chatStream!([{ role: "user", content: "hi" }], () => {}).catch((error: unknown) => error as Error);
    expect(streamed).toBeInstanceOf(LLMProviderError);
    expect(streamed.message).toContain("abliteration.ai blocked this request with a policy");
    const unevaluated = await client.chatStream!([{ role: "user", content: "hi" }], () => {}).catch((error: unknown) => error as Error);
    expect(unevaluated).toBeInstanceOf(LLMServerError);
    expect(unevaluated.message).toContain("req_def456");
  });

  test("402 is a billing refusal and 429 honors Retry-After", async () => {
    // The errors page documents 402 as insufficient credits; the body code is not documented.
    const http = chatFetch(
      json({ error: { type: "billing_error", code: "fixture_billing_code", message: "Payment required.", request_id: "req_1" } }, 402),
      json({ error: { message: "Rate limit exceeded.", type: "rate_limit_error", param: null, code: "rate_limit_exceeded" } }, 429, { "retry-after": "7" }),
    );
    const client = createProvider(provider, { apiKey: key, model: V2, extra: { fetchImpl: http.fetchImpl, maxRetries: 0 } });
    const funds = await client.chat([{ role: "user", content: "hi" }]).catch((error: unknown) => error as LLMFundsError);
    expect(funds).toBeInstanceOf(LLMFundsError);
    expect(funds.statusCode).toBe(402);
    const limited = await client.chat([{ role: "user", content: "hi" }]).catch((error: unknown) => error as LLMRateLimitError);
    expect(limited).toBeInstanceOf(LLMRateLimitError);
    expect(limited.retryAfterMs).toBe(7_000);
  });

  test("round-trips a streamed tool call against a local abliteration.ai mock", async () => {
    const requests: { method: string; path: string; authorization?: string; session?: string | string[]; body: Record<string, any> }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ method: req.method!, path: req.url!, authorization: req.headers.authorization, session: req.headers["x-abliteration-session-id"], body });
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(fixture));
        return;
      }
      if (body.tools === undefined || !body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chatcmpl_2", object: "chat.completion", created: 1, model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "The fixture says ok.", reasoning: "Read the result." } }],
          usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46,
            prompt_tokens_details: { cached_tokens: 32, created_cache_tokens: 0, multimodal_tokens: null } } }));
        return;
      }
      // Frames as the live API streams them (2026-10-22): the trace in `delta.reasoning`.
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: "assistant", reasoning: "Read the fixture first." });
      send({ content: "Reading it." });
      send({ tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: body.tools[0].function.name, arguments: '{"path":' } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] });
      send({}, "tool_calls");
      res.write(`data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [],
        usage: { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39, prompt_tokens_details: { cached_tokens: 0, created_cache_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 5 } } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const client = createProvider(provider, { apiKey: key, baseURL, model: V2, tools: [tool], extra: { fetchImpl: fetch, maxRetries: 0 } });

    // Admission reads the live list first; the chat calls reuse it.
    await client.getExecutionProfile!({ model: V2 });
    const { maxOutputTokens } = await new ModelMetadataResolver({ env: {} }).resolve({ provider: "abliteration", model: V2, config: {} });
    const deltas: string[] = [];
    const first = await client.chatStream!([{ role: "user", content: "Read a.txt" }], chunk => { if (chunk.content) deltas.push(chunk.content); },
      { promptCacheKey: "conv_fixture", reasoningEffort: "high", maxOutputTokens });
    expect(first.content).toBe("Reading it.");
    expect(deltas.join("")).toBe("Reading it.");
    expect(first.thinking?.map(block => block.text).join("")).toBe("Read the fixture first.");
    expect(first.toolCalls).toEqual([{ id: "call_read", name: tool.function.name, arguments: '{"path":"a.txt"}' }]);
    expect(first.finishReason).toBe("tool_calls");
    expect(first.usage).toMatchObject({ promptTokens: 30, completionTokens: 9, cachedInputTokens: 0, reasoningOutputTokens: 5 });

    const second = await client.chat([
      { role: "user", content: "Read a.txt" },
      { role: "assistant", content: first.content, toolCalls: first.toolCalls, providerReasoningContent: first.providerReasoningContent, providerReasoningProvenance: first.providerReasoningProvenance },
      { role: "tool", toolCallId: "call_read", toolName: tool.function.name, content: "ok" },
    ], { tools: [], toolChoice: "auto", promptCacheKey: "conv_fixture", reasoningEffort: "high" });
    expect(second.content).toBe("The fixture says ok.");
    expect(second.usage).toMatchObject({ promptTokens: 40, cachedInputTokens: 32 });

    expect(requests.map(request => `${request.method} ${request.path}`)).toEqual([
      "GET /v1/models", "POST /v1/chat/completions", "POST /v1/chat/completions",
    ]);
    expect(requests.every(request => request.authorization === `Bearer ${key}`)).toBe(true);
    // Both chat requests carry the routing header with the body key; the model list read does not.
    expect(requests.map(request => request.session)).toEqual([undefined, "conv_fixture", "conv_fixture"]);
    const [, streamed, followUp] = requests;
    expect(streamed!.body).toMatchObject({
      model: V2, stream: true, stream_options: { include_usage: true }, prompt_cache_key: "conv_fixture", reasoning_effort: "high",
      max_tokens: 65_536,
      tools: [{ type: "function", function: { name: "mcp__fixture__read", parameters: tool.function.parameters } }],
    });
    expectDocumentedRequest(streamed!.body);
    expect(followUp!.body).not.toHaveProperty("tools");
    expect(followUp!.body).not.toHaveProperty("tool_choice");
    expect(followUp!.body.messages.map((message: Record<string, unknown>) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(followUp!.body.messages[1]).toMatchObject({ tool_calls: [{ id: "call_read", type: "function", function: { name: "mcp__fixture__read", arguments: '{"path":"a.txt"}' } }] });
    expect(followUp!.body.messages[1]).not.toHaveProperty("reasoning_content");
    expect(followUp!.body.messages[1]).not.toHaveProperty("reasoning");
    expectDocumentedRequest(followUp!.body);
    expect(JSON.stringify({ first, second })).not.toContain(key);
  });
});
