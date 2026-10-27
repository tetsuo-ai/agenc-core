import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnvSnapshot } from "../../src/config/env.js";
import { resolveHomeContext, type HomeContext } from "../../src/config/home.js";
import type { ConfigStore } from "../../src/config/store.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
import type { SecureStorageData } from "../../src/utils/secureStorage/index.js";
import {
  LIVE_USAGE_ROUTES,
  OLLAMA_BALANCE_LEGACY,
  usageFetch,
  type UsageRoute,
} from "../llm/fixtures/provider-usage.js";

const secureStorageModulePath = "../../src/utils/secureStorage/index.js";

let testRoot = "";
let secureStorage = new Map<string, SecureStorageData>();

function storageKey(home: HomeContext): string {
  return [home.identityKey, home.oauthFileSuffix, home.secureStorageAccount].join("\0");
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "agenc-provider-usage-"));
  secureStorage = new Map();
  vi.resetModules();
  vi.doMock(secureStorageModulePath, () => ({
    getSecureStorage: (home: HomeContext) => {
      const read = () => structuredClone(secureStorage.get(storageKey(home)) ?? {});
      return {
        name: "provider-usage-test",
        read,
        readFresh: read,
        readAsync: async () => read(),
        update: (data: SecureStorageData) => {
          secureStorage.set(storageKey(home), structuredClone(data));
          return { success: true };
        },
        delete: () => secureStorage.delete(storageKey(home)),
      };
    },
    withSecureStorageDisplaySnapshot: <T>(_home: HomeContext, operation: () => T): T => operation(),
  }));
});

afterEach(async () => {
  vi.doUnmock(secureStorageModulePath);
  vi.resetModules();
  await rm(testRoot, { recursive: true, force: true });
});

async function agencHome(): Promise<HomeContext> {
  const path = join(testRoot, "agenc-home");
  await mkdir(path, { recursive: true });
  return resolveHomeContext({ AGENC_HOME: path }, { platformHome: testRoot });
}

async function context(environment: EnvSnapshot, config: unknown = {}): Promise<SlashCommandContext> {
  const homeContext = await agencHome();
  const configStore = { homeContext, current: () => config } as unknown as ConfigStore;
  return {
    session: { services: { configStore, providerEnvironment: Object.freeze({ ...environment }) } },
    argsRaw: "",
    cwd: testRoot,
    home: testRoot,
    configStore,
  } as unknown as SlashCommandContext;
}

const NOW = new Date("2026-10-22T13:30:00Z");

interface RenderCase {
  readonly environment?: EnvSnapshot;
  readonly config?: unknown;
  readonly columns?: number;
  readonly routes?: Readonly<Record<string, UsageRoute>>;
  readonly styled?: boolean;
}

function renderOptions(fetchImpl: typeof fetch, input: RenderCase) {
  return {
    columns: input.columns ?? 120,
    styled: input.styled ?? false,
    now: NOW,
    timeZone: "UTC",
    timeoutMs: 30,
    fetchImpl,
  };
}

async function section(input: RenderCase) {
  const { readProviderUsageSection } = await import("../../src/commands/provider-usage.js");
  const fake = usageFetch(input.routes ?? LIVE_USAGE_ROUTES);
  const text = await readProviderUsageSection(
    await context(input.environment ?? {}, input.config),
    renderOptions(fake.fetchImpl, input),
  );
  return { text, requests: fake.requests };
}

async function detail(argument: string, input: RenderCase) {
  const { readProviderUsageDetail } = await import("../../src/commands/provider-usage.js");
  const fake = usageFetch(input.routes ?? LIVE_USAGE_ROUTES);
  const result = await readProviderUsageDetail(
    await context(input.environment ?? {}, input.config),
    argument,
    renderOptions(fake.fetchImpl, input),
  );
  return { result, requests: fake.requests };
}

function text(result: { readonly kind: string }): string {
  if (result.kind !== "text" || !("text" in result) || typeof result.text !== "string") {
    throw new Error(`expected a text result, got ${JSON.stringify(result)}`);
  }
  return result.text;
}

/** The TUI shows the text in a box with a border and one column of padding per side. */
function expectFits(rendered: string, columns: number): void {
  for (const line of rendered.split("\n")) {
    expect(line.length, line).toBeLessThanOrEqual(columns - 4);
  }
}

const FOUR_KEYS = {
  OLLAMA_API_KEY: "ollama-key-0001",
  OPENROUTER_API_KEY: "openrouter-key-0002",
  DEEPSEEK_API_KEY: "deepseek-key-0003",
  ABLIT_KEY: "ablit-key-0004",
};

describe("/usage providers section", () => {
  it("lists only providers with a key and reads only their hosts", async () => {
    const { text: rendered, requests } = await section({ environment: FOUR_KEYS, columns: 120 });
    expect(rendered).toBe([
      "Providers",
      "Ollama Cloud      plan: $2.05 of $2.50 left (resets Nov 3)",
      "                  purchased: $66.09",
      "                  last 24h: 2,562 requests · $4.43 · 55.4M tokens (91% cached)",
      "                  top models: kimi-k3 $1.14 · glm-5.3 $1.07",
      "OpenRouter        credits: $55.82 left of $65.00",
      "DeepSeek          balance: $120.69",
      "abliteration.ai   credits: $40.63 left of $41.00",
    ].join("\n"));
    expectFits(rendered, 120);
    expect([...new Set(requests.map((request) => new URL(request.url).host))].sort()).toEqual([
      "api.abliteration.ai",
      "api.deepseek.com",
      "ollama.com",
      "openrouter.ai",
    ]);
    const keyFor = Object.fromEntries(requests.map((request) => [new URL(request.url).host, request.authorization]));
    expect(keyFor).toEqual({
      "ollama.com": "Bearer ollama-key-0001",
      "openrouter.ai": "Bearer openrouter-key-0002",
      "api.deepseek.com": "Bearer deepseek-key-0003",
      "api.abliteration.ai": "Bearer ablit-key-0004",
    });
    for (const key of Object.values(FOUR_KEYS)) expect(rendered).not.toContain(key);
  });

  it("wraps at the separators at 80 columns", async () => {
    const { text: rendered } = await section({ environment: FOUR_KEYS, columns: 80 });
    expect(rendered).toBe([
      "Providers",
      "Ollama Cloud      plan: $2.05 of $2.50 left (resets Nov 3)",
      "                  purchased: $66.09",
      "                  last 24h: 2,562 requests · $4.43",
      "                    55.4M tokens (91% cached)",
      "                  top models: kimi-k3 $1.14 · glm-5.3 $1.07",
      "OpenRouter        credits: $55.82 left of $65.00",
      "DeepSeek          balance: $120.69",
      "abliteration.ai   credits: $40.63 left of $41.00",
    ].join("\n"));
    expectFits(rendered, 80);
  });

  it("stacks each provider above its lines at 50 columns", async () => {
    const { text: rendered } = await section({ environment: FOUR_KEYS, columns: 50 });
    expect(rendered).toBe([
      "Providers",
      "Ollama Cloud",
      "  plan: $2.05 of $2.50 left (resets Nov 3)",
      "  purchased: $66.09",
      "  last 24h: 2,562 requests · $4.43",
      "    55.4M tokens (91% cached)",
      "  top models: kimi-k3 $1.14 · glm-5.3 $1.07",
      "OpenRouter",
      "  credits: $55.82 left of $65.00",
      "DeepSeek",
      "  balance: $120.69",
      "abliteration.ai",
      "  credits: $40.63 left of $41.00",
    ].join("\n"));
    expectFits(rendered, 50);
  });

  it("gives each failing provider one dim line and still shows the others", async () => {
    const routes: Readonly<Record<string, UsageRoute>> = {
      ...LIVE_USAGE_ROUTES,
      "ollama.com/api/balance": { status: 401, json: { error: "unauthorized" } },
      "ollama.com/api/usage?range=24h&group_by=model": { status: 401, json: { error: "unauthorized" } },
      "openrouter.ai/api/v1/credits": { status: 404, text: "missing" },
      "openrouter.ai/api/v1/key": { text: "{\"data\":" },
      "api.deepseek.com/user/balance": { hang: true },
    };
    const plain = await section({ environment: FOUR_KEYS, routes, columns: 120 });
    expect(plain.text).toBe([
      "Providers",
      "Ollama Cloud      usage unavailable (HTTP 401)",
      "OpenRouter        usage unavailable (unexpected response)",
      "DeepSeek          usage unavailable (timed out)",
      "abliteration.ai   credits: $40.63 left of $41.00",
    ].join("\n"));
    const narrow = await section({ environment: FOUR_KEYS, routes, columns: 50 });
    expect(narrow.text.split("\n").slice(0, 4)).toEqual([
      "Providers",
      "Ollama Cloud: usage unavailable (HTTP 401)",
      "OpenRouter: usage unavailable (unexpected",
      "  response)",
    ]);
    expectFits(narrow.text, 50);
    const styled = await section({ environment: FOUR_KEYS, routes, columns: 120, styled: true });
    expect(styled.text.split("\n")).toEqual([
      "\u001b[1mProviders\u001b[22m",
      "\u001b[2mOllama Cloud      usage unavailable (HTTP 401)\u001b[22m",
      "\u001b[2mOpenRouter        usage unavailable (unexpected response)\u001b[22m",
      "\u001b[2mDeepSeek          usage unavailable (timed out)\u001b[22m",
      "abliteration.ai   credits: $40.63 left of $41.00",
    ]);
  });

  it("keeps the balance when only Ollama's usage read fails", async () => {
    const { text: rendered } = await section({
      environment: { OLLAMA_API_KEY: "ollama-key-0001" },
      routes: {
        ...LIVE_USAGE_ROUTES,
        "ollama.com/api/usage?range=24h&group_by=model": { status: 429, json: { error: "slow down" } },
      },
    });
    expect(rendered).toBe([
      "Providers",
      "Ollama Cloud   plan: $2.05 of $2.50 left (resets Nov 3)",
      "               purchased: $66.09",
      "               last 24h: unavailable (HTTP 429)",
    ].join("\n"));
  });

  it("uses a saved BYOK key and the configured or overridden endpoint", async () => {
    const home = await agencHome();
    secureStorage.set(storageKey(home), {
      localAuth: {
        byokKeys: {
          venice: { provider: "venice", apiKey: "saved-venice-key", savedAt: "2026-10-22T00:00:00.000Z" },
        },
      },
    } as SecureStorageData);
    const routes: Readonly<Record<string, UsageRoute>> = {
      "api.venice.ai/api/v1/api_keys/rate_limits": LIVE_USAGE_ROUTES["api.venice.ai/api/v1/api_keys/rate_limits"]!,
      "gw.example/deepseek/user/balance": LIVE_USAGE_ROUTES["api.deepseek.com/user/balance"]!,
      "ablit-proxy.example/v1/credits": LIVE_USAGE_ROUTES["api.abliteration.ai/v1/credits"]!,
    };
    const { text: rendered, requests } = await section({
      environment: {
        DEEPSEEK_API_KEY: "deepseek-key-0003",
        DEEPSEEK_BASE_URL: "https://gw.example/deepseek/v1",
        ABLITERATION_API_KEY: "ablit-key-0004",
      },
      config: { providers: { abliteration: { base_url: "https://ablit-proxy.example/v1" } } },
      routes,
    });
    expect(rendered).toBe([
      "Providers",
      "DeepSeek          balance: $120.69",
      "Venice AI         balance: $39.60",
      "abliteration.ai   credits: $40.63 left of $41.00",
    ].join("\n"));
    expect(requests.map((request) => [request.url, request.authorization]).sort()).toEqual([
      ["https://ablit-proxy.example/v1/credits", "Bearer ablit-key-0004"],
      ["https://api.venice.ai/api/v1/api_keys/rate_limits", "Bearer saved-venice-key"],
      ["https://gw.example/deepseek/user/balance", "Bearer deepseek-key-0003"],
    ]);
  });

  it("never sends a key to a custom Ollama Cloud or Kimi endpoint and keeps the overrides other adapters honor", async () => {
    const environment = {
      OLLAMA_API_KEY: "ollama-key-0001",
      MOONSHOT_API_KEY: "kimi-key-0005",
      OPENROUTER_API_KEY: "openrouter-key-0002",
      OPENROUTER_BASE_URL: "http://127.0.0.1:8080/or/api/v1",
      VENICE_API_KEY: "venice-key-0004",
    };
    const config = {
      providers: {
        "ollama-cloud": { base_url: "https://collector.example/v1" },
        kimi: { base_url: "https://api.moonshot.cn/v1" },
        venice: { base_url: "https://venice-proxy.example/api/v1" },
      },
    };
    // Every endpoint answers, so a request that should not happen would succeed.
    const routes: Readonly<Record<string, UsageRoute>> = {
      "collector.example/api/balance": LIVE_USAGE_ROUTES["ollama.com/api/balance"]!,
      "collector.example/api/usage?range=24h&group_by=model": LIVE_USAGE_ROUTES["ollama.com/api/usage?range=24h&group_by=model"]!,
      "collector.example/api/usage?range=7d&group_by=model": LIVE_USAGE_ROUTES["ollama.com/api/usage?range=7d&group_by=model"]!,
      "api.moonshot.cn/v1/users/me/balance": LIVE_USAGE_ROUTES["api.moonshot.ai/v1/users/me/balance"]!,
      "127.0.0.1:8080/or/api/v1/credits": LIVE_USAGE_ROUTES["openrouter.ai/api/v1/credits"]!,
      "127.0.0.1:8080/or/api/v1/key": LIVE_USAGE_ROUTES["openrouter.ai/api/v1/key"]!,
      "venice-proxy.example/api/v1/api_keys/rate_limits": LIVE_USAGE_ROUTES["api.venice.ai/api/v1/api_keys/rate_limits"]!,
    };
    const summary = await section({ environment, config, routes });
    expect(summary.text).toBe([
      "Providers",
      "Ollama Cloud      usage unavailable (custom endpoint)",
      "OpenRouter        credits: $55.82 left of $65.00",
      "Venice AI         balance: $39.60",
      "Kimi (Moonshot)   usage unavailable (custom endpoint)",
    ].join("\n"));
    expect(summary.requests.map((request) => `${new URL(request.url).host} ${request.authorization}`).sort()).toEqual([
      "127.0.0.1:8080 Bearer openrouter-key-0002",
      "127.0.0.1:8080 Bearer openrouter-key-0002",
      "venice-proxy.example Bearer venice-key-0004",
    ]);
    for (const name of ["ollama", "kimi"]) {
      const { result, requests } = await detail(name, { environment, config, routes });
      expect(text(result).split("\n").slice(1)).toEqual(["usage unavailable (custom endpoint)"]);
      expect(requests).toEqual([]);
    }
  });

  it("says which providers it can read when none is connected, without a request", async () => {
    const { text: rendered, requests } = await section({ environment: { MISTRAL_API_KEY: "mistral-key" }, columns: 80 });
    expect(rendered).toBe([
      "Providers",
      "No provider with a usage API is connected. /usage can read Ollama Cloud,",
      "OpenRouter, DeepSeek, Venice AI, Kimi (Moonshot) and abliteration.ai.",
    ].join("\n"));
    expect(requests).toEqual([]);
  });

  it("shows a legacy Ollama plan's session and weekly limits", async () => {
    const routes = { ...LIVE_USAGE_ROUTES, "ollama.com/api/balance": { json: OLLAMA_BALANCE_LEGACY } };
    const summary = await section({ environment: { OLLAMA_API_KEY: "k" }, routes });
    expect(summary.text.split("\n").slice(0, 3)).toEqual([
      "Providers",
      "Ollama Cloud   plan: session 75% left (resets Oct 1, 07:00) · week 40% left (resets Oct 5)",
      "               purchased: $25.00",
    ]);
    const { result } = await detail("ollama", { environment: { OLLAMA_API_KEY: "k" }, routes });
    expect(text(result).split("\n").slice(0, 4)).toEqual([
      "Ollama Cloud",
      "session      75% left, resets Oct 1, 07:00",
      "week         40% left, resets Oct 5",
      "purchased    $25.00",
    ]);
  });
});

describe("/usage <provider>", () => {
  it("shows Ollama Cloud in detail with 7 days, models and web search", async () => {
    const wide = await detail("ollama", { environment: { OLLAMA_API_KEY: "ollama-key-0001" }, columns: 120 });
    expect(text(wide.result)).toBe([
      "Ollama Cloud",
      "plan         $2.05 of $2.50 left",
      "period       Oct 3 to Nov 3",
      "purchased    $66.09",
      "last 24h     2,562 requests · $4.43 · 55.4M tokens (91% cached)",
      "last 7d      3,356 requests · $5.16 · 59.0M tokens (91% cached)",
      "web search   14 requests · $0.14 in the last 7d",
      "",
      "Models, last 7d",
      "glm-5.3                    $1.26 · 283 requests · 1.9M tokens",
      "kimi-k3                    $1.20 · 62 requests · 1.1M tokens",
      "deepseek-v4.1-flash:1017   $1.18 · 1,162 requests · 47.6M tokens",
      "other models               $0.36 · 559 requests · 3.3M tokens",
    ].join("\n"));
    expect(wide.requests.map((request) => request.url).sort()).toEqual([
      "https://ollama.com/api/balance",
      "https://ollama.com/api/usage?range=24h&group_by=model",
      "https://ollama.com/api/usage?range=7d&group_by=model",
    ]);
    const narrow = await detail("ollama-cloud", { environment: { OLLAMA_API_KEY: "ollama-key-0001" }, columns: 50 });
    expect(text(narrow.result)).toBe([
      "Ollama Cloud",
      "plan: $2.05 of $2.50 left",
      "period: Oct 3 to Nov 3",
      "purchased: $66.09",
      "last 24h: 2,562 requests · $4.43",
      "  55.4M tokens (91% cached)",
      "last 7d: 3,356 requests · $5.16",
      "  59.0M tokens (91% cached)",
      "web search: 14 requests · $0.14 in the last 7d",
      "",
      "Models, last 7d",
      "glm-5.3: $1.26 · 283 requests · 1.9M tokens",
      "kimi-k3: $1.20 · 62 requests · 1.1M tokens",
      "deepseek-v4.1-flash:1017: $1.18",
      "  1,162 requests · 47.6M tokens",
      "other models: $0.36 · 559 requests",
      "  3.3M tokens",
    ].join("\n"));
    expectFits(text(narrow.result), 50);
  });

  it("shows each other provider's documented fields", async () => {
    const environment = {
      OPENROUTER_API_KEY: "a",
      DEEPSEEK_API_KEY: "b",
      VENICE_API_KEY: "c",
      MOONSHOT_API_KEY: "d",
      ABLIT_KEY: "e",
    };
    const rendered = await Promise.all(["openrouter", "deepseek", "venice", "kimi", "abliteration"].map(async (name) =>
      text((await detail(name, { environment, columns: 80 })).result)));
    expect(rendered).toEqual([
      [
        "OpenRouter",
        "credits       $55.82 left of $65.00",
        "used          $9.18",
        "this key      $4.69 today · $5.45 this week · $5.45 this month",
        "              $7.25 in total",
        "key limit     none",
        "free models   0 of 1,000 requests used today",
        "key expires   Feb 19, 2027",
      ].join("\n"),
      [
        "DeepSeek",
        "balance     $120.69",
        "granted     $86.39",
        "topped up   $34.30",
        "API calls   allowed",
      ].join("\n"),
      [
        "Venice AI",
        "USD               $39.60",
        "DIEM              0.00 (refreshes Oct 23)",
        "bundled credits   $0.00",
        "API tier          paid",
        "API access        allowed",
        "key expires       never",
      ].join("\n"),
      [
        "Kimi (Moonshot)",
        "available   $0.00",
        "voucher     $0.00",
        "cash        -$0.09 (owed)",
      ].join("\n"),
      [
        "abliteration.ai",
        "credits   $40.63 left of $41.00",
        "used      $0.37",
      ].join("\n"),
    ]);
  });

  it("falls back to the key's own spend when OpenRouter refuses the account credits", async () => {
    const routes = { ...LIVE_USAGE_ROUTES, "openrouter.ai/api/v1/credits": { status: 403, json: { error: "management key" } } };
    const summary = await section({ environment: { OPENROUTER_API_KEY: "a" }, routes });
    expect(summary.text).toBe("Providers\nOpenRouter   this key: $5.45 used this month");
    const { result } = await detail("openrouter", { environment: { OPENROUTER_API_KEY: "a" }, routes, styled: true });
    expect(text(result).split("\n").slice(0, 3)).toEqual([
      "\u001b[1mOpenRouter\u001b[22m",
      "\u001b[2mcredits       unavailable (HTTP 403)\u001b[22m",
      "this key      $4.69 today · $5.45 this week · $5.45 this month · $7.25 in total",
    ]);
  });

  it("explains a provider without a key, one without a usage API, and an unknown name", async () => {
    const { result: missing, requests } = await detail("ablit", {});
    expect(missing).toEqual({ kind: "error", message: "Unknown provider \"ablit\". Try ollama, openrouter, deepseek, venice, kimi, abliteration." });
    expect((await detail("abliteration", {})).result).toEqual({
      kind: "text",
      text: "abliteration.ai is not connected. Set ABLIT_KEY or ABLITERATION_API_KEY, or connect it in /provider.",
    });
    expect((await detail("OLLAMA", {})).result).toEqual({
      kind: "text",
      text: "Ollama Cloud is not connected. Set OLLAMA_API_KEY, or connect it in /provider.",
    });
    expect((await detail("mistral", { environment: { MISTRAL_API_KEY: "m" } })).result).toEqual({
      kind: "text",
      text: "Mistral has no balance or usage API that works with an API key.",
    });
    expect((await detail("xai", {})).result).toMatchObject({ kind: "error", message: expect.stringContaining("Unknown provider \"xai\"") });
    expect((await detail("\u001b[31mred", {})).result).toMatchObject({ kind: "error", message: expect.stringContaining("\"[31mred\"") });
    expect(requests).toEqual([]);
  });
});
