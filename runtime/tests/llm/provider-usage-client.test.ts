import { describe, expect, it } from "vitest";

import {
  displayText,
  fetchProviderUsage,
  type ProviderUsageReport,
  type ProviderUsageSlug,
} from "../../src/llm/provider-usage-client.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../../src/llm/registry/provider-info.js";
import {
  LIVE_USAGE_ROUTES,
  OLLAMA_BALANCE_LEGACY,
  usageFetch,
  type UsageRoute,
} from "./fixtures/provider-usage.js";

const KEY = "sk-usage-test-key-0123456789";

function target(provider: ProviderUsageSlug, baseURL = BUILT_IN_PROVIDER_BASE_URLS[provider]) {
  return { provider, baseURL, apiKey: KEY };
}

async function read(
  provider: ProviderUsageSlug,
  routes: Readonly<Record<string, UsageRoute>> = LIVE_USAGE_ROUTES,
  options: { readonly baseURL?: string; readonly detail?: boolean; readonly timeoutMs?: number } = {},
) {
  const fake = usageFetch(routes);
  const report = await fetchProviderUsage(target(provider, options.baseURL), {
    fetchImpl: fake.fetchImpl,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { report, requests: fake.requests };
}

function failureReasons(report: ProviderUsageReport): string[] {
  return Object.values(report).flatMap((value) =>
    value !== null && typeof value === "object" && "ok" in value && value.ok === false ? [value.reason] : []);
}

describe("provider usage client", () => {
  it("reads every documented endpoint with the session key, GET only, and refuses redirects", async () => {
    const urls: string[] = [];
    for (const provider of ["ollama-cloud", "openrouter", "deepseek", "venice", "kimi", "abliteration"] as const) {
      const { report, requests } = await read(provider, LIVE_USAGE_ROUTES, { detail: true });
      expect(failureReasons(report)).toEqual([]);
      for (const request of requests) {
        expect(request).toMatchObject({ method: "GET", authorization: `Bearer ${KEY}`, redirect: "error" });
        urls.push(request.url);
      }
    }
    expect(urls.sort()).toEqual([
      "https://api.abliteration.ai/v1/credits",
      "https://api.deepseek.com/user/balance",
      "https://api.moonshot.ai/v1/users/me/balance",
      "https://api.venice.ai/api/v1/api_keys/rate_limits",
      "https://ollama.com/api/balance",
      "https://ollama.com/api/usage?range=24h&group_by=model",
      "https://ollama.com/api/usage?range=7d&group_by=model",
      "https://openrouter.ai/api/v1/credits",
      "https://openrouter.ai/api/v1/key",
    ]);
  });

  it("parses the documented fields of each live-shaped body", async () => {
    expect((await read("ollama-cloud", LIVE_USAGE_ROUTES, { detail: true })).report).toEqual({
      provider: "ollama-cloud",
      balance: {
        ok: true,
        value: {
          included: {
            kind: "credits",
            balanceUsd: 2.05155,
            allowanceUsd: 2.5,
            periodFrom: "2026-10-03T13:24:36.403Z",
            periodUntil: "2026-11-03T13:24:36.403Z",
          },
          purchasedUsd: 66.09085,
        },
      },
      last24h: {
        ok: true,
        value: expect.objectContaining({
          totals: {
            requestCount: 2562,
            usageUsd: 4.43475,
            inputTokens: 54504270,
            cachedInputTokens: 49866711,
            outputTokens: 870829,
          },
          remainder: expect.objectContaining({ requestCount: 331, usageUsd: 0.24238 }),
        }),
      },
      last7d: { ok: true, value: expect.objectContaining({ totals: expect.objectContaining({ requestCount: 3356 }) }) },
    });
    expect((await read("openrouter")).report).toEqual({
      provider: "openrouter",
      credits: { ok: true, value: { totalCredits: 65, totalUsage: 9.183887503 } },
      key: {
        ok: true,
        value: {
          usage: 7.249584547,
          usageDaily: 4.691578161,
          usageWeekly: 5.448375309,
          usageMonthly: 5.452314385,
          byokUsageMonthly: 0,
          limit: null,
          limitRemaining: null,
          isFreeTier: false,
          freeModelRequests: { used: 0, limit: 1000 },
          expiresAt: "2027-02-19T10:23:08.335Z",
        },
      },
    });
    expect((await read("deepseek")).report).toEqual({
      provider: "deepseek",
      balance: {
        ok: true,
        value: { isAvailable: true, balances: [{ currency: "USD", total: 120.69, granted: 86.39, toppedUp: 34.3 }] },
      },
    });
    expect((await read("venice")).report).toEqual({
      provider: "venice",
      balance: {
        ok: true,
        value: {
          usd: 39.59770742,
          diem: 0,
          bundledCreditsUsd: 0,
          accessPermitted: true,
          apiTier: "paid",
          keyExpiration: null,
          nextEpochBegins: "2026-10-23T00:00:00.000Z",
        },
      },
    });
    expect((await read("kimi")).report).toEqual({
      provider: "kimi",
      balance: { ok: true, value: { available: 0, voucher: 0, cash: -0.09476 } },
    });
    expect((await read("abliteration")).report).toEqual({
      provider: "abliteration",
      credits: { ok: true, value: { totalCredits: 41, totalUsage: 0.365214 } },
    });
  });

  it("reads a legacy Ollama plan's session and weekly limits", async () => {
    const { report } = await read("ollama-cloud", {
      ...LIVE_USAGE_ROUTES,
      "ollama.com/api/balance": { json: OLLAMA_BALANCE_LEGACY },
    });
    expect(report).toMatchObject({
      balance: {
        ok: true,
        value: {
          included: {
            kind: "limits",
            session: { remainingPercent: 75, resetsAt: "2026-10-01T07:00:00.000Z" },
            weekly: { remainingPercent: 40, resetsAt: "2026-10-05T00:00:00.000Z" },
          },
          purchasedUsd: 25,
        },
      },
    });
  });

  it("keeps a configured endpoint's host and path prefix", async () => {
    const routes = {
      "gw.example/deepseek/user/balance": LIVE_USAGE_ROUTES["api.deepseek.com/user/balance"]!,
      "127.0.0.1:8080/or/api/v1/credits": LIVE_USAGE_ROUTES["openrouter.ai/api/v1/credits"]!,
      "127.0.0.1:8080/or/api/v1/key": LIVE_USAGE_ROUTES["openrouter.ai/api/v1/key"]!,
    };
    const deepseek = await read("deepseek", routes, { baseURL: "https://gw.example/deepseek/v1/" });
    expect(deepseek.requests.map((request) => request.url)).toEqual(["https://gw.example/deepseek/user/balance"]);
    expect(failureReasons(deepseek.report)).toEqual([]);
    const openrouter = await read("openrouter", routes, { baseURL: "http://127.0.0.1:8080/or/api/v1?x=1#y" });
    expect(openrouter.requests.map((request) => request.url).sort()).toEqual([
      "http://127.0.0.1:8080/or/api/v1/credits",
      "http://127.0.0.1:8080/or/api/v1/key",
    ]);
    expect(failureReasons(openrouter.report)).toEqual([]);
  });

  it("reports HTTP statuses, timeouts, network errors and malformed bodies without body text or the key", async () => {
    const cases: ReadonlyArray<readonly [UsageRoute, string]> = [
      [{ status: 401, json: { error: `invalid key ${KEY}` } }, "HTTP 401"],
      [{ status: 404, text: "<html>missing</html>" }, "HTTP 404"],
      [{ status: 503, json: { error: "credit_balance_unavailable" } }, "HTTP 503"],
      [{ hang: true }, "timed out"],
      [{ reject: true }, "network error"],
      [{ text: "{not json" }, "unexpected response"],
      [{ json: { data: { total_credits: "41" } } }, "unexpected response"],
      [{ text: "x".repeat(1_000_001) }, "unexpected response"],
    ];
    for (const [route, reason] of cases) {
      const { report } = await read("abliteration", { "api.abliteration.ai/v1/credits": route }, { timeoutMs: 25 });
      expect(report).toEqual({ provider: "abliteration", credits: { ok: false, reason } });
      expect(JSON.stringify(report)).not.toContain(KEY);
    }
  });

  it("rejects Kimi error envelopes and DeepSeek non-numeric amounts", async () => {
    const kimi = await read("kimi", {
      "api.moonshot.ai/v1/users/me/balance": {
        json: { code: 1, data: { available_balance: 5 }, status: false },
      },
    });
    expect(kimi.report).toEqual({ provider: "kimi", balance: { ok: false, reason: "unexpected response" } });
    const deepseek = await read("deepseek", {
      "api.deepseek.com/user/balance": {
        json: { is_available: true, balance_infos: [{ currency: "USD", total_balance: "lots" }] },
      },
    });
    expect(deepseek.report).toEqual({ provider: "deepseek", balance: { ok: false, reason: "unexpected response" } });
  });

  it("never sends the key to an endpoint the pinned Ollama Cloud or Kimi adapter refuses", async () => {
    const refused = [
      ["ollama-cloud", "https://collector.example/v1"],
      ["ollama-cloud", "https://ollama.com.collector.example/v1"],
      ["ollama-cloud", "http://ollama.com/v1"],
      ["ollama-cloud", "https://ollama.com"],
      ["kimi", "https://api.moonshot.cn/v1"],
      ["kimi", "https://collector.example/v1"],
      ["kimi", "https://api.moonshot.ai/v1//"],
    ] as const;
    for (const [provider, baseURL] of refused) {
      const { report, requests } = await read(provider, LIVE_USAGE_ROUTES, { baseURL, detail: true });
      expect(requests, `${provider} ${baseURL}`).toEqual([]);
      const reasons = failureReasons(report);
      expect(reasons.length).toBeGreaterThan(0);
      expect(new Set(reasons)).toEqual(new Set(["custom endpoint"]));
    }
  });

  it("reads usage only where each provider's chat adapter would send chat", async () => {
    const { createProvider } = await import("../../src/llm/provider.js");
    const candidates: Readonly<Record<ProviderUsageSlug, readonly string[]>> = {
      "ollama-cloud": [
        "https://ollama.com/v1",
        "https://ollama.com/v1/",
        " https://ollama.com/v1// ",
        "https://collector.example/v1",
        "http://ollama.com/v1",
        "https://ollama.com",
      ],
      kimi: [
        "https://api.moonshot.ai/v1",
        "https://api.moonshot.ai/v1/",
        "https://api.moonshot.ai/v1//",
        "https://api.moonshot.cn/v1",
        "https://collector.example/v1",
      ],
      openrouter: ["https://openrouter.ai/api/v1", "http://127.0.0.1:8080/or/api/v1"],
      deepseek: ["https://api.deepseek.com/v1", "https://gw.example/deepseek/v1"],
      venice: ["https://api.venice.ai/api/v1", "https://venice-proxy.example/api/v1"],
      abliteration: ["https://api.abliteration.ai/v1", "https://ablit-proxy.example/v1"],
    };
    for (const [provider, baseURLs] of Object.entries(candidates) as Array<[ProviderUsageSlug, readonly string[]]>) {
      for (const baseURL of baseURLs) {
        let adapterAccepts = true;
        try {
          createProvider(provider, { apiKey: KEY, baseURL });
        } catch {
          adapterAccepts = false;
        }
        const { requests } = await read(provider, {}, { baseURL });
        expect(requests.length > 0, `${provider} ${JSON.stringify(baseURL)}`).toBe(adapterAccepts);
        const origins = [...new Set(requests.map((request) => new URL(request.url).origin))];
        expect(origins).toEqual(adapterAccepts ? [new URL(baseURL.trim()).origin] : []);
      }
    }
  });

  it("refuses a base URL that is not http or https before sending the key", async () => {
    const { report, requests } = await read("venice", LIVE_USAGE_ROUTES, { baseURL: "file:///etc/passwd" });
    expect(report).toEqual({ provider: "venice", balance: { ok: false, reason: "invalid base URL" } });
    expect(requests).toEqual([]);
  });

  it("strips terminal control and bidirectional characters from provider strings", async () => {
    const { report } = await read("ollama-cloud", {
      ...LIVE_USAGE_ROUTES,
      "ollama.com/api/usage?range=24h&group_by=model": {
        json: {
          totals: {
            request_count: 1,
            groups: [{ model: "evil\u001b[2J\u202emodel\u0007", request_count: 1 }],
          },
        },
      },
    });
    expect(report).toMatchObject({
      last24h: { ok: true, value: { groups: [{ model: "evil[2Jmodel", requestCount: 1 }] } },
    });
    expect(displayText("a".repeat(80), 10)).toBe("aaaaaaaaa\u2026");
    expect(displayText("\u200b\u2066")).toBeUndefined();
  });
});
