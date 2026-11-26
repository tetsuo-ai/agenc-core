import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ConfigStore } from "../../../../src/config/store.js";
import {
  resolveCanonicalStartupSelection,
  resolveDiscoveredStartupDefault,
} from "../../../../src/bin/startup-selection.js";
import { createProvider, readProviderIdentity, type ProviderName } from "../../../../src/llm/provider.js";
import { resolveProviderRuntimeAuthority } from "../../../../src/llm/provider-options.js";
import { BUILT_IN_PROVIDER_DEFINITIONS } from "../../../../src/llm/registry/provider-info.js";
import { StaticModelsManager } from "../../../../src/llm/models-manager.js";
import { collectProviderAvailability } from "../../../../src/llm/discovery/provider-discovery.js";
import { TrustedRouterProvider } from "../../../../src/llm/providers/trustedrouter/index.js";
import { trustedRouterFetch } from "../../../../src/llm/providers/trustedrouter/transport.js";
import { ModelRegistry } from "../../../../src/llm/model-registry.js";
import {
  parseTrustedRouterModels,
  TRUSTEDROUTER_BASE_URL,
  TRUSTEDROUTER_DEFAULT_MODEL,
  TRUSTEDROUTER_MODELS,
  trustedRouterDefaultModel,
} from "../../../../src/llm/registry/trustedrouter-models.js";
import { clearPublishedModelCatalogs } from "../../../../src/llm/registry/published-model-catalog.js";
import { recordPublishedModelCosts } from "../../../../src/llm/registry/published-model-costs.js";
import { AGENC_DAEMON_CLIENT_ENV_KEYS } from "../../../../src/app-server/protocol/index.js";
import { AGENC_DAEMON_CLIENT_ENV_KEYS as SDK_DAEMON_CLIENT_ENV_KEYS } from "../../../../../packages/agenc-sdk/src/protocol-wire.generated.js";
import { snapshotProviderEnvironment } from "../../../../src/llm/provider-environment.js";
import { redactDurableSecrets } from "../../../../src/session/provider-replay-redaction.js";
import { isSecretEnvKey, SUBPROCESS_SECRET_ENV } from "../../../../src/utils/secretEnv.js";
import {
  LLMAuthenticationError,
  LLMFundsError,
  LLMRateLimitError,
} from "../../../../src/llm/errors.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../fixtures/trustedrouter-models.json", import.meta.url), "utf8"),
);
const providerName = "trustedrouter" as ProviderName;
const key = "fake-trustedrouter-only-credential";
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  clearPublishedModelCatalogs();
  recordPublishedModelCosts("trustedrouter", new Map());
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

async function fakeServer(status = 200, payload = fixture) {
  const requests: {
    path: string;
    authorization?: string;
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, any>;
  }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push({
      path: req.url!,
      authorization: req.headers.authorization,
      headers: req.headers,
      body,
    });
    if (req.url === "/v1/models") {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    if (status !== 200) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (status === 429) {
        headers["x-ratelimit-reset-requests"] = String(Math.floor(Date.now() / 1000) + 2);
      }
      res.writeHead(status, headers);
      res.end(
        JSON.stringify({
          error:
            status === 401
              ? `Authentication failed: ${key}`
              : status === 402
                ? `Insufficient credits: ${key}`
                : `Rate limit exceeded: ${key}`,
        }),
      );
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "fake",
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      send({ reasoning: "Consider the tool." });
      send({ content: "Hello " });
      send({ content: "TrustedRouter" });
      send({
        tool_calls: [
          {
            index: 0,
            id: "call_echo",
            type: "function",
            function: { name: "echo", arguments: '{"value":' },
          },
        ],
      });
      send(
        {
          tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }],
        },
        "tool_calls",
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "fake",
          model: body.model,
          choices: [
            {
              message: {
                role: "assistant",
                content: "Done",
                reasoning_content: "Checked.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      );
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Missing server address");
  }
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests };
}

describe("TrustedRouter built-in provider", () => {
  test("rate-limit reset headers preserve their documented units and standard precedence", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
    for (const [headers, expected] of [
      [{ "x-ratelimit-reset-requests": "1000000007", "x-ratelimit-reset-tokens": "12" }, "12"],
      [{ "x-ratelimit-reset-requests": "1000000007" }, "7"],
      [{ "x-ratelimit-reset-requests": "1000000007000" }, "7"],
      [{ "x-ratelimit-reset-requests": "1000000007", "retry-after": "3" }, "3"],
      [{ "x-ratelimit-reset-requests": "invalid" }, null],
    ] as const) {
      const fetchImpl = trustedRouterFetch(
        async () => new Response('{"error":"limited"}', { status: 429, headers }),
        key,
      );
      expect(
        (await fetchImpl("http://127.0.0.1/v1/chat/completions")).headers.get("retry-after"),
      ).toBe(expected);
    }
  });

  test("daemon ingress carries TrustedRouter env vars and child processes treat the key as secret", () => {
    for (const name of ["TRUSTEDROUTER_API_KEY", "TRUSTEDROUTER_BASE_URL"]) {
      expect(AGENC_DAEMON_CLIENT_ENV_KEYS).toContain(name);
      expect(SDK_DAEMON_CLIENT_ENV_KEYS).toContain(name);
    }
    expect(snapshotProviderEnvironment({ TRUSTEDROUTER_API_KEY: key })).toMatchObject({
      TRUSTEDROUTER_API_KEY: key,
    });
    expect(isSecretEnvKey("TRUSTEDROUTER_API_KEY")).toBe(true);
    expect(SUBPROCESS_SECRET_ENV).toContain("TRUSTEDROUTER_API_KEY");
    expect(
      JSON.stringify(
        redactDurableSecrets({ envOverrides: { TRUSTEDROUTER_API_KEY: key } }, "rollout"),
      ),
    ).not.toContain(key);
  });

  test("filters internal, hidden, synthetic-monitor, and non-chat rows while exposing presets and nyte/* aliases", () => {
    const models = parseTrustedRouterModels(fixture);
    const ids = new Set(models.map((entry) => entry.model));

    // Hundreds of public chat models + presets + aliases are exposed.
    expect(models.filter((entry) => entry.aliasOf === undefined).length).toBeGreaterThan(450);
    expect(models.length).toBeGreaterThan(550);

    // Core routing presets lead the list.
    expect(models.slice(0, 6).map((entry) => entry.model)).toEqual([
      "trustedrouter/auto",
      "trustedrouter/zdr",
      "trustedrouter/e2e",
      "trustedrouter/fast",
      "trustedrouter/cheap",
      "trustedrouter/free",
    ]);

    // nyte/* aliases are exposed and resolve to their canonical presets.
    for (const alias of ["nyte/auto", "nyte/zdr", "nyte/e2e", "nyte/fast", "nyte/cheap", "nyte/free"]) {
      expect(ids.has(alias)).toBe(true);
    }
    expect(models.find((entry) => entry.model === "nyte/zdr")).toMatchObject({
      aliasOf: "trustedrouter/zdr",
      zeroDataRetention: true,
      supportsToolUse: true,
    });

    // All 4 exclusion flags are filtered out.
    expect(ids.has("trustedrouter/fixture-internal-only")).toBe(false);
    expect(ids.has("trustedrouter/fixture-synthetic-monitor")).toBe(false);
    for (const raw of fixture.data as any[]) {
      const tr = raw.trustedrouter ?? {};
      if (
        tr.internal_only === true ||
        tr.configuration_hidden === true ||
        tr.synthetic_monitor === true ||
        tr.supports_chat === false
      ) {
        expect(ids.has(raw.id)).toBe(false);
      }
    }
  });

  test("maps per-token pricing, tiered long-context rates, free models, and privacy facts", async () => {
    const models = new Map(parseTrustedRouterModels(fixture).map((entry) => [entry.model, entry]));

    expect(models.get("trustedrouter/auto")).toMatchObject({
      isDefault: true,
      zeroDataRetention: true,
      confidentialCompute: true,
      e2ee: true,
      supportsToolUse: true,
      supportsVision: true,
    });
    expect(models.get("trustedrouter/free")).toMatchObject({
      isFree: true,
      cost: { inputUsdPer1K: 0, outputUsdPer1K: 0 },
    });
    expect(models.get("trustedrouter/free")?.zeroDataRetention).toBeUndefined();

    // Standard-tier model does not falsely claim ZDR.
    const claude = models.get("anthropic/claude-opus-4.5")!;
    expect(claude.zeroDataRetention).toBeUndefined();
    expect(claude.cost).toEqual({
      inputUsdPer1K: 0.005275,
      outputUsdPer1K: 0.026375,
      cachedInputUsdPer1K: 0.0005275,
      cachedInputIncludedInInputTokens: true,
    });

    // Tiered long-context pricing maps into ModelCostEntry.longContext.
    const haiku = models.get("anthropic/claude-haiku-5.5")!;
    expect(haiku.cost).toEqual({
      inputUsdPer1K: 0.0001055,
      outputUsdPer1K: 0.0005275,
      cachedInputUsdPer1K: 0.00001055,
      cachedInputIncludedInInputTokens: true,
      longContext: {
        aboveInputTokens: 100_000,
        rates: {
          inputUsdPer1K: 0.0005275,
          outputUsdPer1K: 0.0026375,
          cachedInputUsdPer1K: 0.00005275,
          cachedInputIncludedInInputTokens: true,
        },
      },
    });

    const { baseURL } = await fakeServer();
    const registry = new ModelRegistry({
      config: { providers: { trustedrouter: { base_url: baseURL } } },
      metadata: { fetchImpl: fetch, env: { TRUSTEDROUTER_API_KEY: key } },
    });
    const entry = await registry.resolve({ provider: "trustedrouter", model: "anthropic/claude-haiku-5.5" });
    expect(entry.cost).toMatchObject({ known: true, entry: haiku.cost });
    expect(registry.modelCostRegistry()["trustedrouter:anthropic/claude-haiku-5.5"]).toEqual(haiku.cost);
    expect(entry.capabilities).toMatchObject({
      supportsToolUse: true,
      supportsImageInput: true,
      supportsExtendedThinking: true,
    });
  });

  test("provider-only startup uses trustedrouter/auto while explicit models stay pinned", async () => {
    const { baseURL } = await fakeServer();
    const home = mkdtempSync(join(tmpdir(), "agenc-trustedrouter-default-"));
    try {
      for (const explicit of [false, true]) {
        writeFileSync(
          join(home, "config.toml"),
          'config_version = 2\nmodel_provider = "trustedrouter"\n' +
            (explicit ? 'model = "trustedrouter/zdr"\n' : "") +
            `[providers.trustedrouter]\nbase_url = "${baseURL}"\n`,
        );
        const store = new ConfigStore({
          home,
          cwd: home,
          env: { AGENC_HOME: home },
        });
        await store.reload();
        const startup = resolveCanonicalStartupSelection({
          config: store.current(),
          env: {},
        });
        const selected = await resolveDiscoveredStartupDefault(
          startup,
          store.modelSelectionSource(),
          { fetchImpl: fetch, env: { TRUSTEDROUTER_API_KEY: key } },
        );
        expect(selected.model).toBe(explicit ? "trustedrouter/zdr" : TRUSTEDROUTER_DEFAULT_MODEL);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects filtered or mistyped models before inference while allowing aliases", async () => {
    const { baseURL, requests } = await fakeServer();
    for (const badModel of [
      "trustedrouter/fixture-internal-only",
      "trustedrouter/fixture-synthetic-monitor",
      "anthropic/claude-typpo",
    ]) {
      const provider = createProvider(providerName, {
        apiKey: key,
        baseURL,
        model: badModel,
        extra: { fetchImpl: fetch, maxRetries: 0 },
      });
      await expect(provider.chat([{ role: "user", content: "hello" }])).rejects.toThrow(
        `${badModel} is not an available TrustedRouter chat model.`,
      );
    }
    expect(requests.every((request) => request.path.endsWith("/models"))).toBe(true);

    // nyte/* alias is admitted and forwarded cleanly.
    const aliasProvider = createProvider(providerName, {
      apiKey: key,
      baseURL,
      model: "nyte/zdr",
      extra: { fetchImpl: fetch, maxRetries: 0 },
    });
    const res = await aliasProvider.chat([{ role: "user", content: "hello" }]);
    expect(res.content).toBe("Done");
    expect(requests.at(-1)?.body.model).toBe("nyte/zdr");
  });

  test("keeps a usable offline preset catalog when discovery fails", async () => {
    const { baseURL } = await fakeServer(503);
    const manager = new StaticModelsManager({
      config: {
        model_provider: "trustedrouter",
        providers: { trustedrouter: { base_url: baseURL } },
      },
      fallbackProvider: "trustedrouter",
      metadata: { fetchImpl: fetch, env: { TRUSTEDROUTER_API_KEY: key } },
    });
    expect(
      (await manager.listModels())
        .filter((model) => model.provider === "trustedrouter")
        .map((model) => model.slug),
    ).toEqual(TRUSTEDROUTER_MODELS.map((model) => model.model));
    expect(trustedRouterDefaultModel(TRUSTEDROUTER_MODELS)).toBe("trustedrouter/auto");
  });

  test("owns its credential and never falls back to a shared compatible key", async () => {
    expect(BUILT_IN_PROVIDER_DEFINITIONS).toHaveProperty("trustedrouter");
    expect(TRUSTEDROUTER_BASE_URL).toBe("https://api.trustedrouter.com/v1");
    const missing = await resolveProviderRuntimeAuthority(
      providerName,
      {},
      { OPENAI_COMPATIBLE_API_KEY: "wrong", OPENAI_API_KEY: "also-wrong", VENICE_API_KEY: "wrong" },
    );
    expect(missing.factoryOptions.apiKey).toBeUndefined();
    const present = await resolveProviderRuntimeAuthority(
      providerName,
      {},
      { TRUSTEDROUTER_API_KEY: key, TRUSTEDROUTER_BASE_URL: "http://127.0.0.1:9/v1" },
    );
    expect(present.factoryOptions.apiKey).toBe(key);
    expect(present.factoryOptions.baseURL).toBe("http://127.0.0.1:9/v1");
  });

  test("readiness lists TrustedRouter with missing and present credentials without leaking keys", async () => {
    const missing = await collectProviderAvailability({ config: {}, env: {}, checkLocal: false });
    expect(missing.entries.find((entry) => entry.provider === "trustedrouter")).toMatchObject({
      credentialStatus: "missing",
      keyEnvVar: "TRUSTEDROUTER_API_KEY",
      model: "trustedrouter/auto",
    });
    const { baseURL } = await fakeServer();
    const present = await collectProviderAvailability({
      config: { providers: { trustedrouter: { base_url: baseURL } } },
      env: { TRUSTEDROUTER_API_KEY: key },
      fetchImpl: fetch,
      checkLocal: false,
    });
    expect(present.entries.find((entry) => entry.provider === "trustedrouter")).toMatchObject({
      credentialStatus: "present",
      model: "trustedrouter/auto",
      usable: true,
    });
    expect(JSON.stringify(present)).not.toContain(key);
  });

  test("streaming text, reasoning, tool calls, and min_privacy extraBody round-trip without leaking keys", async () => {
    const { baseURL, requests } = await fakeServer();
    const traces: unknown[] = [];
    const provider = createProvider(providerName, {
      apiKey: key,
      baseURL,
      model: "trustedrouter/auto",
      tools: [
        {
          type: "function",
          function: {
            name: "echo",
            description: "Echo",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        },
      ],
      extra: {
        fetchImpl: fetch,
        maxRetries: 0,
        emitDiagnostic: (event: unknown) => traces.push(event),
      },
    });
    expect(readProviderIdentity(provider)).toBe("trustedrouter");
    const chunks: string[] = [];
    const response = await provider.chatStream!(
      [{ role: "user", content: "Call echo" }],
      (chunk) => {
        if (chunk.content) chunks.push(chunk.content);
      },
    );
    expect(response.content).toBe("Hello TrustedRouter");
    expect(chunks.join("")).toContain("Hello TrustedRouter");
    expect(response.toolCalls).toEqual([
      { id: "call_echo", name: "echo", arguments: '{"value":"ok"}' },
    ]);
    expect(response.thinking?.map((block) => block.text).join("")).toContain("Consider the tool.");

    const next = await provider.chat([
      { role: "user", content: "Call echo" },
      { role: "assistant", content: response.content, toolCalls: response.toolCalls },
      { role: "tool", content: "ok", toolCallId: "call_echo" },
    ]);
    expect(next.content).toBe("Done");

    for (const request of requests.filter((req) => req.path.endsWith("/chat/completions"))) {
      expect(request.body.model).toBe("trustedrouter/auto");
      expect(request.headers["http-referer"]).toBe("https://agenc.tech");
      expect(request.headers["x-title"]).toBe("AgenC");
    }

    // Direct provider extraBody preserves provider.min_privacy constraints (zdr/e2e).
    const zdrProvider = new TrustedRouterProvider({
      apiKey: key,
      baseURL,
      model: "anthropic/claude-opus-4.5",
      fetchImpl: fetch,
      maxRetries: 0,
      extraBody: { provider: { min_privacy: "zdr" } },
    });
    await zdrProvider.chat([{ role: "user", content: "hello" }]);
    expect(requests.at(-1)?.body.provider).toEqual({ min_privacy: "zdr" });
    expect(traces.length).toBeGreaterThan(0);
    expect(JSON.stringify({ response, next, traces })).not.toContain(key);
  });

  test.each([
    [401, LLMAuthenticationError],
    [402, LLMFundsError],
    [429, LLMRateLimitError],
  ] as const)("maps HTTP %s without exposing credentials", async (status, ErrorKind) => {
    const { baseURL } = await fakeServer(status);
    const provider = createProvider(providerName, {
      apiKey: key,
      baseURL,
      model: "trustedrouter/auto",
      extra: { fetchImpl: fetch, maxRetries: 0 },
    });
    const error = await provider.chat([{ role: "user", content: "hello" }]).catch((err) => err);
    expect(error).toBeInstanceOf(ErrorKind);
    expect(String(error)).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(key);
    if (error instanceof LLMRateLimitError) expect(error.retryAfterMs).toBeGreaterThan(0);
  });
});
