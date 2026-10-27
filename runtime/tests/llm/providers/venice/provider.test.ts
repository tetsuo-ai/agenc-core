import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../../../src/config/store.js";
import { resolveCanonicalStartupSelection, resolveDiscoveredStartupDefault } from "../../../../src/bin/startup-selection.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createProvider, type ProviderName } from "../../../../src/llm/provider.js";
import { resolveProviderRuntimeAuthority } from "../../../../src/llm/provider-options.js";
import { BUILT_IN_PROVIDER_DEFINITIONS } from "../../../../src/llm/registry/provider-info.js";
import { StaticModelsManager } from "../../../../src/llm/models-manager.js";
import { collectProviderAvailability } from "../../../../src/llm/discovery/provider-discovery.js";
import { veniceFetch } from "../../../../src/llm/providers/venice/transport.js";
import { ModelRegistry } from "../../../../src/llm/model-registry.js";
import { parseVeniceModels, veniceDefaultModel, VENICE_MODELS, VENICE_TOOL_CALLS_NOT_DELIVERED } from "../../../../src/llm/registry/venice-models.js";
import { AGENC_DAEMON_CLIENT_ENV_KEYS } from "../../../../src/app-server/protocol/index.js";
import { snapshotProviderEnvironment } from "../../../../src/llm/provider-environment.js";
import { redactDurableSecrets } from "../../../../src/session/provider-replay-redaction.js";
import { isSecretEnvKey } from "../../../../src/utils/secretEnv.js";
import { LLMAuthenticationError, LLMRateLimitError } from "../../../../src/llm/errors.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/venice-models.json", import.meta.url), "utf8"));
const providerName = "venice" as ProviderName;
const key = "fake-venice-only-credential";
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});
async function fakeServer(status = 200, payload = fixture) {
  const requests: { path: string; authorization?: string; body: Record<string, any> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push({ path: req.url!, authorization: req.headers.authorization, body });
    if (req.url === "/api/v1/models") {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    if (status !== 200) {
      // Venice's live 429 (2026-10-22): reset headers are epoch milliseconds, no Retry-After.
      res.writeHead(status, { "content-type": "application/json", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": String(Date.now() + 2_000), "x-ratelimit-remaining-tokens": "1996448", "x-ratelimit-reset-tokens": String(Date.now() + 2_000) });
      res.end(JSON.stringify({ error: status === 401 ? `Authentication failed: ${key}` : `Rate limit exceeded: ${key}` }));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fake", model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ reasoning_content: "Consider the tool." });
      send({ content: "Hello " });
      send({ content: "Venice" });
      send({ tool_calls: [{ index: 0, id: "call_echo", type: "function", function: { name: "echo", arguments: '{"value":' } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }, "tool_calls");
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "fake", model: body.model, choices: [{ message: { role: "assistant", content: "Done", reasoning_content: "Checked." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing server address");
  return { baseURL: `http://127.0.0.1:${address.port}/api/v1`, requests };
}

describe("Venice built-in provider", () => {
  test("rate-limit reset headers become a short Retry-After for the used-up window", async () => {
    // Headers of a live Venice 429 captured 2026-10-22: both resets are epoch milliseconds.
    const nowMs = 1_792_657_891_047;
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const live = {
      "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1792657951032",
      "x-ratelimit-limit-tokens": "2000000", "x-ratelimit-remaining-tokens": "1996448", "x-ratelimit-reset-tokens": "1792657951035",
    };
    const nowS = Math.floor(nowMs / 1000);
    for (const [headers, expected] of [
      [live, "60"],
      // Only the token window is used up: its reset decides.
      [{ ...live, "x-ratelimit-remaining-requests": "57", "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": String(nowMs + 12_000) }, "12"],
      // No window reported as used up (an overloaded model): wait for the later reset.
      [{ ...live, "x-ratelimit-remaining-requests": "57" }, "60"],
      // Seconds-precision timestamps and plain delays are read too.
      [{ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": String(nowS + 7) }, "7"],
      [{ "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "12" }, "12"],
      [{ ...live, "retry-after": "3" }, "3"],
      [{ "x-ratelimit-reset-requests": "invalid" }, null],
      [{ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": String(nowMs - 5_000) }, null],
    ] as const) {
      const fetchImpl = veniceFetch(async () => new Response('{"error":"limited"}', { status: 429, headers }), key);
      expect((await fetchImpl("http://127.0.0.1/api/v1/chat/completions")).headers.get("retry-after")).toBe(expected);
    }
  });

  test("daemon ingress carries the Venice credential and child processes treat it as secret", () => {
    expect(AGENC_DAEMON_CLIENT_ENV_KEYS).toContain("VENICE_API_KEY");
    expect(snapshotProviderEnvironment({ VENICE_API_KEY: key })).toMatchObject({ VENICE_API_KEY: key });
    expect(isSecretEnvKey("VENICE_API_KEY")).toBe(true);
    expect(JSON.stringify(redactDurableSecrets({ envOverrides: { VENICE_API_KEY: key } }, "rollout"))).not.toContain(key);
  });

  test("maps pricing per million tokens and only documented private routes claim retention", async () => {
    const models = parseVeniceModels(fixture);
    const preferred = models.find(model => model.model === "zai-org-glm-5-2")!;
    expect(preferred).toMatchObject({ cost: { inputUsdPer1K: 0.0014, outputUsdPer1K: 0.0044, cachedInputUsdPer1K: 0.26 / 1000 }, privacy: "private", zeroDataRetention: true, supportsReasoning: true });
    expect(models.some(model => model.supportsVision)).toBe(true);
    expect(models.filter(model => model.privacy === "anonymized").every(model => model.zeroDataRetention === undefined)).toBe(true);
    const { baseURL } = await fakeServer();
    const registry = new ModelRegistry({ config: { providers: { venice: { base_url: baseURL } } }, metadata: { fetchImpl: fetch, env: { VENICE_API_KEY: key } } });
    const entry = await registry.resolve({ provider: "venice", model: preferred.model });
    expect(entry.cost).toMatchObject({ known: true, entry: preferred.cost });
    expect(registry.modelCostRegistry()[`venice:${preferred.model}`]).toEqual(preferred.cost);
    expect(entry.capabilities).toMatchObject({ supportsExtendedThinking: true, supportsToolUse: true });
  });

  test("prices every listed model from model_spec.pricing, including the long-context tier", () => {
    const models = new Map(parseVeniceModels(fixture).map(model => [model.model, model]));
    // Every tool-capable model in the 2026-10-15 list publishes a price.
    expect([...models.values()].every(model => model.cost !== undefined)).toBe(true);
    expect(models.get("deepseek-v4-flash")?.cost).toEqual({
      inputUsdPer1K: 0.138 / 1000, outputUsdPer1K: 0.275 / 1000,
      cachedInputUsdPer1K: 0.028 / 1000, cachedInputIncludedInInputTokens: true,
    });
    expect(models.get("qwen3-5-397b-a17b")?.cost).toEqual({ inputUsdPer1K: 0.75 / 1000, outputUsdPer1K: 4.5 / 1000 });
    // `extended` is the rate above context_token_threshold input tokens.
    expect(models.get("grok-4-5")?.cost?.longContext).toEqual({
      aboveInputTokens: 200_000,
      rates: { inputUsdPer1K: 4.53 / 1000, outputUsdPer1K: 13.6 / 1000, cachedInputUsdPer1K: 0.68 / 1000, cachedInputIncludedInInputTokens: true },
    });
    // No prompt caching is requested from Venice, so no cache write is priced.
    expect(models.get("claude-opus-5-5")?.cost).toEqual({
      inputUsdPer1K: 4 / 1000, outputUsdPer1K: 20 / 1000,
      cachedInputUsdPer1K: 0.2 / 1000, cachedInputIncludedInInputTokens: true,
    });
  });

  test("discovers the default trait instead of pinning the current model", async () => {
    const changed = structuredClone(fixture);
    for (const model of changed.data) model.model_spec.traits = [];
    const target = changed.data.find((model: any) => model.id === "qwen3-5-35b-a3b");
    target.model_spec.traits = ["function_calling_default"];
    expect(veniceDefaultModel(parseVeniceModels(changed))).toBe(target.id);
    const { baseURL } = await fakeServer(200, changed);
    const report = await collectProviderAvailability({ config: { providers: { venice: { base_url: baseURL } } }, env: { VENICE_API_KEY: key }, fetchImpl: fetch, checkLocal: false });
    expect(report.entries.find(entry => entry.provider === "venice")?.model).toBe(target.id);
  });

  test("provider-only startup follows the trait while explicit model choices stay pinned", async () => {
    const changed = structuredClone(fixture);
    for (const model of changed.data) model.model_spec.traits = [];
    const target = changed.data.find((model: any) => model.id === "qwen3-5-35b-a3b");
    target.model_spec.traits = ["function_calling_default"];
    const { baseURL } = await fakeServer(200, changed);
    const home = mkdtempSync(join(tmpdir(), "agenc-venice-default-"));
    try {
      for (const explicit of [false, true]) {
        for (const repeatProviderInEnv of [false, true]) {
        writeFileSync(join(home, "config.toml"), 'config_version = 2\nmodel_provider = "venice"\n' + (explicit ? 'model = "zai-org-glm-5-2"\n' : '') + `[providers.venice]\nbase_url = "${baseURL}"\n`);
        const env = { AGENC_HOME: home, ...(repeatProviderInEnv ? { AGENC_PROVIDER: "venice" } : {}) };
        const store = new ConfigStore({ home, cwd: home, env });
        await store.reload();
        const startup = resolveCanonicalStartupSelection({ config: store.current(), env });
        const selected = await resolveDiscoveredStartupDefault(startup, store.modelSelectionSource(), { fetchImpl: fetch, env: { VENICE_API_KEY: key } });
        expect(selected.model).toBe(explicit ? "zai-org-glm-5-2" : target.id);
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects models without function calling before inference", async () => {
    const unsupported = fixture.data.find((model: any) => !model.model_spec.capabilities.supportsFunctionCalling);
    const { baseURL, requests } = await fakeServer();
    const provider = createProvider(providerName, { apiKey: key, baseURL, model: unsupported.id, extra: { fetchImpl: fetch, maxRetries: 0 } });
    await expect(provider.chat([{ role: "user", content: "hello" }])).rejects.toThrow("supports function calling");
    expect(requests.every(request => request.path.endsWith("/models"))).toBe(true);
  });

  test("names a mistyped model before inference, now that selection accepts any Venice ID", async () => {
    const { baseURL, requests } = await fakeServer();
    const provider = createProvider(providerName, { apiKey: key, baseURL, model: "deepseek-v4-flsh", extra: { fetchImpl: fetch, maxRetries: 0 } });
    await expect(provider.chat([{ role: "user", content: "hello" }]))
      .rejects.toThrow("deepseek-v4-flsh is not an online Venice text model that supports function calling.");
    expect(requests.every(request => request.path.endsWith("/models"))).toBe(true);
  });

  test("keeps a small usable offline catalog when discovery fails", async () => {
    const { baseURL } = await fakeServer(503);
    const manager = new StaticModelsManager({ config: { model_provider: "venice", providers: { venice: { base_url: baseURL } } }, fallbackProvider: "venice", metadata: { fetchImpl: fetch, env: { VENICE_API_KEY: key } } });
    expect((await manager.listModels()).filter(model => model.provider === "venice").map(model => model.slug)).toEqual(VENICE_MODELS.map(model => model.model));
    expect(veniceDefaultModel(VENICE_MODELS)).toBe("zai-org-glm-5-2");
  });

  test("owns its credential and never falls back to a shared compatible key", async () => {
    expect(BUILT_IN_PROVIDER_DEFINITIONS).toHaveProperty("venice");
    const missing = await resolveProviderRuntimeAuthority(providerName, {}, { OPENAI_COMPATIBLE_API_KEY: "wrong", OPENAI_API_KEY: "also-wrong" });
    expect(missing.factoryOptions.apiKey).toBeUndefined();
    const present = await resolveProviderRuntimeAuthority(providerName, {}, { VENICE_API_KEY: key });
    expect(present.factoryOptions.apiKey).toBe(key);
  });

  test("discovery offers only tool-capable models and maps limits", async () => {
    const { baseURL, requests } = await fakeServer();
    const manager = new StaticModelsManager({ config: { model_provider: "venice", providers: { venice: { base_url: baseURL } } }, fallbackProvider: "venice", metadata: { fetchImpl: fetch, env: { VENICE_API_KEY: key } } });
    const models = (await manager.listModels()).filter(model => model.provider === "venice");
    const eligible = fixture.data.filter((model: any) => model.type === "text" && model.model_spec.capabilities.supportsFunctionCalling && !model.model_spec.offline &&
      !VENICE_TOOL_CALLS_NOT_DELIVERED.has(model.id));
    expect(models.map(model => model.slug).sort()).toEqual(eligible.map((model: any) => model.id).sort());
    const info = await manager.getModelInfoForProvider("venice", "zai-org-glm-5-2");
    expect(info).toMatchObject({ contextWindow: 1_000_000, maxOutputTokensUpperLimit: 131_072, supportsToolUse: true, supportedReasoningLevels: ["none", "high", "max"], defaultReasoningLevel: "max" });
    expect(requests.every(request => request.authorization === `Bearer ${key}`)).toBe(true);
  });

  test("readiness lists Venice with missing and present credentials without leaking keys", async () => {
    const report = await collectProviderAvailability({ config: {}, env: {}, checkLocal: false });
    expect(report.entries.find(entry => entry.provider === "venice")).toMatchObject({ credentialStatus: "missing", keyEnvVar: "VENICE_API_KEY" });
    const { baseURL } = await fakeServer();
    const present = await collectProviderAvailability({ config: { providers: { venice: { base_url: baseURL } } }, env: { VENICE_API_KEY: key }, fetchImpl: fetch, checkLocal: false });
    expect(present.entries.find(entry => entry.provider === "venice")).toMatchObject({ credentialStatus: "present", model: "zai-org-glm-5-2", usable: true });
    expect(JSON.stringify(present)).not.toContain(key);
  });

  test("streaming text, reasoning and tool calls round-trip with Venice policy on every request", async () => {
    const { baseURL, requests } = await fakeServer();
    const traces: unknown[] = [];
    const provider = createProvider(providerName, { apiKey: key, baseURL, model: "zai-org-glm-5-2", tools: [{ type: "function", function: { name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } }], extra: { fetchImpl: fetch, maxRetries: 0, emitDiagnostic: (event: unknown) => traces.push(event) } });
    const chunks: string[] = [];
    const response = await provider.chatStream!([{ role: "user", content: "Call echo" }], chunk => { if (chunk.content) chunks.push(chunk.content); });
    expect(response.content).toBe("Hello Venice");
    expect(chunks.join("")).toContain("Hello Venice");
    expect(response.toolCalls).toEqual([{ id: "call_echo", name: "echo", arguments: '{"value":"ok"}' }]);
    expect(response.thinking?.map(block => block.text).join("")).toContain("Consider the tool.");
    const next = await provider.chat([{ role: "user", content: "Call echo" }, { role: "assistant", content: response.content, toolCalls: response.toolCalls }, { role: "tool", content: "ok", toolCallId: "call_echo" }]);
    expect(next.content).toBe("Done");
    for (const request of requests.filter(request => request.path.endsWith("/chat/completions"))) {
      expect(request.body.model).toBe("zai-org-glm-5-2");
      expect(request.body.venice_parameters).toMatchObject({ include_venice_system_prompt: false, enable_web_search: "off", enable_web_scraping: false, enable_x_search: false });
    }
    expect(traces.length).toBeGreaterThan(0);
    expect(JSON.stringify({ response, next, traces })).not.toContain(key);
  });

  test.each([[401, LLMAuthenticationError], [429, LLMRateLimitError]] as const)("maps HTTP %s without exposing credentials", async (status, ErrorKind) => {
    const { baseURL } = await fakeServer(status);
    const provider = createProvider(providerName, { apiKey: key, baseURL, model: "zai-org-glm-5-2", extra: { fetchImpl: fetch, maxRetries: 0 } });
    const error = await provider.chat([{ role: "user", content: "hello" }]).catch(error => error);
    expect(error).toBeInstanceOf(ErrorKind);
    expect(String(error)).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(key);
    if (error instanceof LLMRateLimitError) {
      expect(error.retryAfterMs).toBeGreaterThan(0);
      // The wait is the window's real reset (about 2 s here), not a timestamp read as a delay.
      expect(error.retryAfterMs).toBeLessThanOrEqual(3_000);
    }
  });
});
