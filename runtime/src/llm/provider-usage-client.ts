/**
 * Read-only balance and usage lookups for `/usage`.
 *
 * Each provider here documents an endpoint that answers with the account's
 * balance or usage for the same API key the user already sends it for
 * inference. Every request is a GET to the origin the provider's chat adapter
 * would use for the resolved base URL, so a key never travels anywhere its
 * chat requests could not. OpenRouter, DeepSeek, Venice and abliteration.ai
 * send chat wherever their base URL points (registry default, config
 * `base_url` or environment override). The Ollama Cloud and Kimi adapters are
 * pinned to their own endpoints and refuse any other, so a different
 * configured endpoint gets no usage request at all.
 *
 * Bodies are read field by field against the documented shapes; anything
 * else in them is ignored. A failure carries only an HTTP status or a short
 * local reason, never response text, so nothing from a body or a key can
 * reach the screen through an error.
 *
 * Endpoints (checked 2026-10-22):
 * - Ollama Cloud: GET /api/balance and GET /api/usage
 *   (https://docs.ollama.com/api/balance, https://docs.ollama.com/api/cloud-usage)
 * - OpenRouter: GET /api/v1/credits and GET /api/v1/key
 *   (https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits,
 *   https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
 * - DeepSeek: GET /user/balance (https://api-docs.deepseek.com/api/get-user-balance)
 * - Venice: GET /api/v1/api_keys/rate_limits
 *   (https://docs.venice.ai/api-reference/endpoint/api_keys/rate_limits)
 * - Kimi: GET /v1/users/me/balance (https://platform.kimi.ai/docs/api/balance)
 * - abliteration.ai: GET /v1/credits
 *   (https://docs.abliteration.ai/api-reference/credits/get-the-credit-balance-for-the-api-keys-organization)
 */

import { OLLAMA_CLOUD_BASE_URL } from "./registry/ollama-cloud-models.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "./registry/provider-info.js";

/** Providers with a documented balance or usage API, in `/usage` order. */
export const PROVIDER_USAGE_SLUGS = Object.freeze([
  "ollama-cloud",
  "openrouter",
  "deepseek",
  "venice",
  "kimi",
  "abliteration",
] as const);

export type ProviderUsageSlug = (typeof PROVIDER_USAGE_SLUGS)[number];

export function isProviderUsageSlug(value: string): value is ProviderUsageSlug {
  return (PROVIDER_USAGE_SLUGS as readonly string[]).includes(value);
}

/** Short enough that one slow provider never holds `/usage` for long. */
const PROVIDER_USAGE_TIMEOUT_MS = 5_000;

/** Usage bodies are a few KB; anything far larger is not the documented shape. */
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TEXT_CHARS = 64;

export interface ProviderUsageTarget {
  readonly provider: ProviderUsageSlug;
  /** The resolved inference base URL for this provider. */
  readonly baseURL: string;
  /** Sent only as the Bearer credential; never rendered or returned. */
  readonly apiKey: string;
}

export interface ProviderUsageRequestOptions {
  /** Also read the detail-only endpoints (Ollama Cloud's 7-day usage). */
  readonly detail?: boolean;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Proxy and TLS options for the session environment (`getProxyFetchOptions`). */
  readonly fetchOptions?: Readonly<Record<string, unknown>>;
}

export type UsageRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export interface UsageMetrics {
  readonly requestCount: number;
  readonly usageUsd?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
}

export interface OllamaCloudLimit {
  readonly remainingPercent: number;
  readonly resetsAt?: string;
}

export type OllamaCloudIncluded =
  | {
      readonly kind: "credits";
      readonly balanceUsd: number;
      readonly allowanceUsd: number;
      readonly periodFrom?: string;
      readonly periodUntil?: string;
    }
  | {
      readonly kind: "limits";
      readonly session?: OllamaCloudLimit;
      readonly weekly?: OllamaCloudLimit;
    };

export interface OllamaCloudBalance {
  readonly included?: OllamaCloudIncluded;
  readonly purchasedUsd?: number;
}

export interface OllamaCloudUsageGroup extends UsageMetrics {
  readonly model: string;
}

export interface OllamaCloudUsage {
  readonly totals: UsageMetrics;
  readonly groups: readonly OllamaCloudUsageGroup[];
  readonly remainder?: UsageMetrics;
}

export interface OpenRouterKey {
  readonly usage?: number;
  readonly usageDaily?: number;
  readonly usageWeekly?: number;
  readonly usageMonthly?: number;
  readonly byokUsageMonthly?: number;
  /** Null when the key has no spending limit. */
  readonly limit?: number | null;
  readonly limitRemaining?: number | null;
  readonly limitReset?: string;
  readonly isFreeTier?: boolean;
  readonly freeModelRequests?: {
    readonly used: number;
    readonly limit: number;
  };
  readonly expiresAt?: string;
}

export interface CurrencyBalance {
  readonly currency: string;
  readonly total: number;
  readonly granted?: number;
  readonly toppedUp?: number;
}

export interface DeepSeekBalance {
  readonly isAvailable?: boolean;
  readonly balances: readonly CurrencyBalance[];
}

export interface VeniceBalance {
  readonly usd?: number;
  readonly diem?: number;
  readonly bundledCreditsUsd?: number;
  readonly accessPermitted?: boolean;
  readonly apiTier?: string;
  /** Null when the key never expires. */
  readonly keyExpiration?: string | null;
  readonly nextEpochBegins?: string;
}

/** USD: the Kimi adapter only talks to Moonshot's global platform. */
export interface KimiBalance {
  readonly available: number;
  readonly voucher?: number;
  readonly cash?: number;
}

/** OpenRouter and abliteration.ai: credits granted or bought, and spent, in USD. */
export interface CreditTotals {
  readonly totalCredits: number;
  readonly totalUsage: number;
}

export type ProviderUsageReport =
  | {
      readonly provider: "ollama-cloud";
      readonly balance: UsageRead<OllamaCloudBalance>;
      readonly last24h: UsageRead<OllamaCloudUsage>;
      readonly last7d?: UsageRead<OllamaCloudUsage>;
    }
  | {
      readonly provider: "openrouter";
      readonly credits: UsageRead<CreditTotals>;
      readonly key: UsageRead<OpenRouterKey>;
    }
  | { readonly provider: "deepseek"; readonly balance: UsageRead<DeepSeekBalance> }
  | { readonly provider: "venice"; readonly balance: UsageRead<VeniceBalance> }
  | { readonly provider: "kimi"; readonly balance: UsageRead<KimiBalance> }
  | { readonly provider: "abliteration"; readonly credits: UsageRead<CreditTotals> };

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? Math.round(number) : undefined;
}

/** DeepSeek sends amounts as decimal strings such as "110.00". */
function decimal(value: unknown): number | undefined {
  if (typeof value === "number") return finiteNumber(value);
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(value.trim())) return undefined;
  return finiteNumber(Number(value.trim()));
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// Control, format and bidirectional characters can repaint or reorder a
// terminal line; a provider string is display text only.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

/** A provider-supplied string made safe for one terminal line. */
export function displayText(value: unknown, maxChars = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(UNSAFE_TEXT_RE, "").trim();
  if (cleaned.length === 0) return undefined;
  const chars = Array.from(cleaned);
  return chars.length <= maxChars ? cleaned : `${chars.slice(0, maxChars - 1).join("")}…`;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V };
}

function parseMetrics(value: unknown): UsageMetrics | undefined {
  const item = record(value);
  const requestCount = count(item?.request_count);
  if (item === undefined || requestCount === undefined) return undefined;
  return {
    requestCount,
    ...optional("usageUsd", finiteNumber(item.usage_usd)),
    ...optional("inputTokens", count(item.input_tokens)),
    ...optional("cachedInputTokens", count(item.cached_input_tokens)),
    ...optional("outputTokens", count(item.output_tokens)),
  };
}

function parseOllamaLimit(value: unknown): OllamaCloudLimit | undefined {
  const item = record(value);
  const remainingPercent = finiteNumber(item?.remaining_percent);
  if (remainingPercent === undefined) return undefined;
  return {
    remainingPercent: Math.min(100, Math.max(0, remainingPercent)),
    ...optional("resetsAt", timestamp(item?.resets_at)),
  };
}

function parseOllamaIncluded(value: unknown): OllamaCloudIncluded | undefined {
  const included = record(value);
  if (included === undefined) return undefined;
  const balanceUsd = finiteNumber(included.balance_usd);
  const allowanceUsd = finiteNumber(included.allowance_usd);
  if (balanceUsd !== undefined && allowanceUsd !== undefined) {
    const period = record(included.period);
    return {
      kind: "credits",
      balanceUsd,
      allowanceUsd,
      ...optional("periodFrom", timestamp(period?.from)),
      ...optional("periodUntil", timestamp(period?.until)),
    };
  }
  // Legacy plans report session and weekly limits instead of credits.
  const session = parseOllamaLimit(included.session);
  const weekly = parseOllamaLimit(included.weekly);
  if (session === undefined && weekly === undefined) return undefined;
  return { kind: "limits", ...optional("session", session), ...optional("weekly", weekly) };
}

function parseOllamaCloudBalance(body: unknown): OllamaCloudBalance | undefined {
  const root = record(body);
  const included = parseOllamaIncluded(root?.included);
  const purchasedUsd = finiteNumber(record(root?.purchased)?.balance_usd);
  if (included === undefined && purchasedUsd === undefined) return undefined;
  return { ...optional("included", included), ...optional("purchasedUsd", purchasedUsd) };
}

function parseOllamaCloudUsage(body: unknown): OllamaCloudUsage | undefined {
  const totalsRecord = record(record(body)?.totals);
  const totals = parseMetrics(totalsRecord);
  if (totalsRecord === undefined || totals === undefined) return undefined;
  const groups = Array.isArray(totalsRecord.groups)
    ? totalsRecord.groups.flatMap((value): OllamaCloudUsageGroup[] => {
        const model = displayText(record(value)?.model);
        const metrics = parseMetrics(value);
        return model === undefined || metrics === undefined ? [] : [{ model, ...metrics }];
      })
    : [];
  return { totals, groups, ...optional("remainder", parseMetrics(totalsRecord.remainder)) };
}

function parseCreditTotals(body: unknown): CreditTotals | undefined {
  const data = record(record(body)?.data);
  const totalCredits = finiteNumber(data?.total_credits);
  const totalUsage = finiteNumber(data?.total_usage);
  return totalCredits === undefined || totalUsage === undefined
    ? undefined
    : { totalCredits, totalUsage };
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : finiteNumber(value);
}

function parseOpenRouterKey(body: unknown): OpenRouterKey | undefined {
  const data = record(record(body)?.data);
  if (data === undefined) return undefined;
  const free = record(data.free_model_daily_requests);
  const freeUsed = count(free?.used);
  const freeLimit = count(free?.limit);
  const key: OpenRouterKey = {
    ...optional("usage", finiteNumber(data.usage)),
    ...optional("usageDaily", finiteNumber(data.usage_daily)),
    ...optional("usageWeekly", finiteNumber(data.usage_weekly)),
    ...optional("usageMonthly", finiteNumber(data.usage_monthly)),
    ...optional("byokUsageMonthly", finiteNumber(data.byok_usage_monthly)),
    ...optional("limit", nullableNumber(data.limit)),
    ...optional("limitRemaining", nullableNumber(data.limit_remaining)),
    ...optional("limitReset", displayText(data.limit_reset, 16)),
    ...optional("isFreeTier", bool(data.is_free_tier)),
    ...optional(
      "freeModelRequests",
      freeUsed === undefined || freeLimit === undefined ? undefined : { used: freeUsed, limit: freeLimit },
    ),
    ...optional("expiresAt", timestamp(data.expires_at)),
  };
  return key.usage === undefined && key.limit === undefined ? undefined : key;
}

function parseDeepSeekBalance(body: unknown): DeepSeekBalance | undefined {
  const root = record(body);
  if (root === undefined || !Array.isArray(root.balance_infos)) return undefined;
  const balances = root.balance_infos.flatMap((value): CurrencyBalance[] => {
    const info = record(value);
    const currency = displayText(info?.currency, 8);
    const total = decimal(info?.total_balance);
    if (currency === undefined || total === undefined) return [];
    return [{
      currency,
      total,
      ...optional("granted", decimal(info?.granted_balance)),
      ...optional("toppedUp", decimal(info?.topped_up_balance)),
    }];
  });
  if (balances.length === 0 && root.balance_infos.length > 0) return undefined;
  return { ...optional("isAvailable", bool(root.is_available)), balances };
}

function parseVeniceBalance(body: unknown): VeniceBalance | undefined {
  const data = record(record(body)?.data);
  const balances = record(data?.balances);
  if (data === undefined || balances === undefined) return undefined;
  const usd = finiteNumber(balances.USD);
  const diem = finiteNumber(balances.DIEM);
  const bundledCreditsUsd = finiteNumber(balances.BUNDLED_CREDITS);
  if (usd === undefined && diem === undefined && bundledCreditsUsd === undefined) return undefined;
  return {
    ...optional("usd", usd),
    ...optional("diem", diem),
    ...optional("bundledCreditsUsd", bundledCreditsUsd),
    ...optional("accessPermitted", bool(data.accessPermitted)),
    ...optional("apiTier", displayText(record(data.apiTier)?.id, 24)),
    ...optional("keyExpiration", data.keyExpiration === null ? null : timestamp(data.keyExpiration)),
    ...optional("nextEpochBegins", timestamp(data.nextEpochBegins)),
  };
}

function parseKimiBalance(body: unknown): KimiBalance | undefined {
  const root = record(body);
  // `code` 0 and `status` true mark success; anything else is not a balance.
  if (root === undefined || root.code !== 0 || root.status === false) return undefined;
  const data = record(root.data);
  const available = finiteNumber(data?.available_balance);
  if (available === undefined) return undefined;
  return {
    available,
    ...optional("voucher", finiteNumber(data?.voucher_balance)),
    ...optional("cash", finiteNumber(data?.cash_balance)),
  };
}

function httpBase(baseURL: string): URL | undefined {
  try {
    const url = new URL(baseURL);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url;
  } catch {
    return undefined;
  }
}

/**
 * One endpoint under the provider's own base URL. `fromRoot` endpoints live
 * beside the versioned API (Ollama's `/api/*`, DeepSeek's `/user/balance`):
 * a trailing `/v1` is dropped and any proxy path prefix before it is kept.
 */
function providerUsageEndpoint(
  baseURL: string,
  path: string,
  options: { readonly fromRoot?: boolean } = {},
): string | undefined {
  const base = httpBase(baseURL);
  if (base === undefined) return undefined;
  const prefix = options.fromRoot === true
    ? base.pathname.replace(/\/v1$/u, "")
    : base.pathname;
  const [pathname, query] = path.split("?", 2);
  base.pathname = `${prefix}${pathname}`;
  if (query !== undefined) base.search = `?${query}`;
  return base.toString();
}

/**
 * The base URL the provider's chat adapter would use for `baseURL`, or
 * undefined when the adapter refuses it. Mirrors the factory, which trims the
 * configured value, and the pinned adapters: providers/ollama-cloud accepts
 * only OLLAMA_CLOUD_BASE_URL (any trailing slashes), providers/kimi only
 * Moonshot's global base URL with at most one trailing slash.
 */
function adapterBaseURL(provider: ProviderUsageSlug, baseURL: string): string | undefined {
  const configured = baseURL.trim() || BUILT_IN_PROVIDER_BASE_URLS[provider];
  switch (provider) {
    case "ollama-cloud":
      return configured.replace(/\/+$/u, "") === OLLAMA_CLOUD_BASE_URL ? OLLAMA_CLOUD_BASE_URL : undefined;
    case "kimi": {
      const pinned = BUILT_IN_PROVIDER_BASE_URLS.kimi;
      return configured === pinned || configured === `${pinned}/` ? pinned : undefined;
    }
    default:
      return configured;
  }
}

function failed<T>(reason: string): UsageRead<T> {
  return { ok: false, reason };
}

async function readBoundedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function getJson<T>(
  url: string | undefined,
  apiKey: string,
  options: ProviderUsageRequestOptions,
  parse: (body: unknown) => T | undefined,
): Promise<UsageRead<T>> {
  if (url === undefined) return failed("invalid base URL");
  const timeout = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? PROVIDER_USAGE_TIMEOUT_MS));
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      ...(options.fetchOptions ?? {}),
      method: "GET",
      // A redirect must not carry the bearer key anywhere else.
      redirect: "error",
      signal: timeout,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    } as RequestInit);
  } catch {
    return failed(timeout.aborted ? "timed out" : "network error");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return failed(`HTTP ${response.status}`);
  }
  let text: string | undefined;
  try {
    text = await readBoundedText(response);
  } catch {
    return failed(timeout.aborted ? "timed out" : "network error");
  }
  if (text === undefined) return failed("unexpected response");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failed("unexpected response");
  }
  const value = parse(body);
  return value === undefined ? failed("unexpected response") : { ok: true, value };
}

/** Read one provider's balance and usage. Never throws for a provider failure. */
export async function fetchProviderUsage(
  target: ProviderUsageTarget,
  options: ProviderUsageRequestOptions = {},
): Promise<ProviderUsageReport> {
  const { apiKey } = target;
  const baseURL = adapterBaseURL(target.provider, target.baseURL);
  const origin = baseURL === undefined ? undefined : httpBase(baseURL)?.origin;
  const get = <T>(path: string, parse: (body: unknown) => T | undefined, fromRoot = false) => {
    // An endpoint the chat adapter refuses never receives the key.
    if (baseURL === undefined) return Promise.resolve(failed<T>("custom endpoint"));
    const url = providerUsageEndpoint(baseURL, path, { fromRoot });
    const sameOrigin = url !== undefined && origin !== undefined && new URL(url).origin === origin;
    return getJson(sameOrigin ? url : undefined, apiKey, options, parse);
  };
  switch (target.provider) {
    case "ollama-cloud": {
      const [balance, last24h, last7d] = await Promise.all([
        get("/api/balance", parseOllamaCloudBalance, true),
        get("/api/usage?range=24h&group_by=model", parseOllamaCloudUsage, true),
        options.detail === true
          ? get("/api/usage?range=7d&group_by=model", parseOllamaCloudUsage, true)
          : Promise.resolve(undefined),
      ]);
      return { provider: "ollama-cloud", balance, last24h, ...optional("last7d", last7d) };
    }
    case "openrouter": {
      const [credits, key] = await Promise.all([
        get("/credits", parseCreditTotals),
        get("/key", parseOpenRouterKey),
      ]);
      return { provider: "openrouter", credits, key };
    }
    case "deepseek":
      return { provider: "deepseek", balance: await get("/user/balance", parseDeepSeekBalance, true) };
    case "venice":
      return { provider: "venice", balance: await get("/api_keys/rate_limits", parseVeniceBalance) };
    case "kimi":
      return {
        provider: "kimi",
        balance: await get("/users/me/balance", parseKimiBalance),
      };
    case "abliteration":
      return { provider: "abliteration", credits: await get("/credits", parseCreditTotals) };
  }
}
