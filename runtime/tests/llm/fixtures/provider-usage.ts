/**
 * Provider balance and usage bodies for the `/usage` tests.
 *
 * The *_LIVE bodies are the shapes the real endpoints returned on 2026-10-22
 * (read-only GETs, numbers kept, account identifiers removed, Ollama buckets
 * dropped). The legacy Ollama plan body is the one in Ollama's docs.
 */

export const OLLAMA_BALANCE_LIVE = {
  included: {
    balance_usd: 2.05155,
    allowance_usd: 2.5,
    period: {
      from: "2026-10-03T13:24:36.40391Z",
      until: "2026-11-03T13:24:36.40391Z",
    },
  },
  purchased: { balance_usd: 66.09085 },
};

/** https://docs.ollama.com/api/balance, "Legacy plans". */
export const OLLAMA_BALANCE_LEGACY = {
  included: {
    session: { remaining_percent: 75, resets_at: "2026-10-01T07:00:00Z" },
    weekly: { remaining_percent: 40, resets_at: "2026-10-05T00:00:00Z" },
  },
  purchased: { balance_usd: 25 },
};

export const OLLAMA_USAGE_24H_LIVE = {
  range: "24h",
  scope: "self",
  granularity: "hour",
  group_by: "model",
  from: "2026-10-21T13:00:00Z",
  until: "2026-10-22T13:28:22.04278777Z",
  totals: {
    request_count: 2562,
    usage_usd: 4.43475,
    input_tokens: 54504270,
    cached_input_tokens: 49866711,
    output_tokens: 870829,
    groups: [
      { model: "kimi-k3", request_count: 45, usage_usd: 1.13544, input_tokens: 1016416, cached_input_tokens: 764907, output_tokens: 10082 },
      { model: "glm-5.3", request_count: 253, usage_usd: 1.06644, input_tokens: 1513783, cached_input_tokens: 1262976, output_tokens: 87641 },
      { model: "deepseek-v4.1-flash:1017", request_count: 736, usage_usd: 0.98951, input_tokens: 45014185, cached_input_tokens: 42601556, output_tokens: 495811 },
      { model: "web_search", request_count: 9, usage_usd: 0.092, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    ],
    remainder: { request_count: 331, usage_usd: 0.24238, input_tokens: 2346494, cached_input_tokens: 1529286, output_tokens: 74094 },
  },
  buckets: [],
};

export const OLLAMA_USAGE_7D_LIVE = {
  range: "7d",
  scope: "self",
  granularity: "day",
  group_by: "model",
  from: "2026-10-15T00:00:00Z",
  until: "2026-10-22T13:28:22.0432255Z",
  totals: {
    request_count: 3356,
    usage_usd: 5.1612,
    input_tokens: 57981535,
    cached_input_tokens: 52592629,
    output_tokens: 1062080,
    groups: [
      { model: "glm-5.3", request_count: 283, usage_usd: 1.25718, input_tokens: 1801538, cached_input_tokens: 1536000, output_tokens: 110137 },
      { model: "kimi-k3", request_count: 62, usage_usd: 1.20449, input_tokens: 1074926, cached_input_tokens: 810188, output_tokens: 11128 },
      { model: "deepseek-v4.1-flash:1017", request_count: 1162, usage_usd: 1.17821, input_tokens: 46979597, cached_input_tokens: 44289924, output_tokens: 644189 },
      { model: "web_search", request_count: 14, usage_usd: 0.144, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    ],
    remainder: { request_count: 559, usage_usd: 0.35601, input_tokens: 3224398, cached_input_tokens: 2043064, output_tokens: 88839 },
  },
  buckets: [],
};

export const OPENROUTER_CREDITS_LIVE = {
  data: { total_credits: 65, total_usage: 9.183887503 },
};

export const OPENROUTER_KEY_LIVE = {
  data: {
    is_management_key: false,
    limit: null,
    limit_reset: null,
    limit_remaining: null,
    include_byok_in_limit: false,
    budgets: [],
    effective_budget: null,
    usage: 7.249584547,
    usage_daily: 4.691578161,
    usage_weekly: 5.448375309,
    usage_monthly: 5.452314385,
    byok_usage: 0,
    byok_usage_monthly: 0,
    is_free_tier: false,
    expires_at: "2027-02-19T10:23:08.335Z",
    free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 },
  },
};

export const DEEPSEEK_BALANCE_LIVE = {
  is_available: true,
  balance_infos: [
    { currency: "USD", total_balance: "120.69", granted_balance: "86.39", topped_up_balance: "34.30" },
  ],
};

export const VENICE_RATE_LIMITS_LIVE = {
  data: {
    accessPermitted: true,
    apiTier: { id: "paid", isCharged: true },
    balances: { USD: 39.59770742, DIEM: 0, BUNDLED_CREDITS: 0 },
    keyExpiration: null,
    nextEpochBegins: "2026-10-23T00:00:00.000Z",
    rateLimits: [{ apiModelId: "zai-org-glm-5-2", rateLimits: [{ amount: 500, type: "RPM" }] }],
  },
};

export const KIMI_BALANCE_LIVE = {
  code: 0,
  data: { available_balance: 0, voucher_balance: 0, cash_balance: -0.09476 },
  scode: "0x0",
  status: true,
};

export const ABLITERATION_CREDITS_LIVE = {
  data: { total_credits: 41, total_usage: 0.365214 },
};

export interface RecordedUsageRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly redirect: RequestRedirect | undefined;
}

export type UsageRoute =
  | { readonly status?: number; readonly json: unknown }
  | { readonly status?: number; readonly text: string }
  | { readonly hang: true }
  | { readonly reject: true };

/**
 * A fetch that answers by URL path. A `hang` route resolves only when the
 * request is aborted, the way a stalled connection does.
 */
export function usageFetch(routes: Readonly<Record<string, UsageRoute>>): {
  readonly fetchImpl: typeof fetch;
  readonly requests: RecordedUsageRequest[];
} {
  const requests: RecordedUsageRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      redirect: init?.redirect,
    });
    const parsed = new URL(url);
    const route = routes[`${parsed.host}${parsed.pathname}${parsed.search}`] ??
      routes[`${parsed.host}${parsed.pathname}`];
    if (route === undefined) return new Response("not found", { status: 404 });
    if ("reject" in route) throw new TypeError("fetch failed");
    if ("hang" in route) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    const body = "json" in route ? JSON.stringify(route.json) : route.text;
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

/** Every live-shaped endpoint on the providers' default hosts. */
export const LIVE_USAGE_ROUTES: Readonly<Record<string, UsageRoute>> = {
  "ollama.com/api/balance": { json: OLLAMA_BALANCE_LIVE },
  "ollama.com/api/usage?range=24h&group_by=model": { json: OLLAMA_USAGE_24H_LIVE },
  "ollama.com/api/usage?range=7d&group_by=model": { json: OLLAMA_USAGE_7D_LIVE },
  "openrouter.ai/api/v1/credits": { json: OPENROUTER_CREDITS_LIVE },
  "openrouter.ai/api/v1/key": { json: OPENROUTER_KEY_LIVE },
  "api.deepseek.com/user/balance": { json: DEEPSEEK_BALANCE_LIVE },
  "api.venice.ai/api/v1/api_keys/rate_limits": { json: VENICE_RATE_LIMITS_LIVE },
  "api.moonshot.ai/v1/users/me/balance": { json: KIMI_BALANCE_LIVE },
  "api.abliteration.ai/v1/credits": { json: ABLITERATION_CREDITS_LIVE },
};
