/**
 * DeepSeek Search API client for the model-facing WebSearch tool.
 *
 * DeepSeek's web search is a plain REST endpoint (`POST /v1/tools/search`)
 * authenticated with the same key as its chat API. It takes no model
 * parameter, so it serves deepseek-flash and deepseek-v4-pro alike, and it
 * runs only when the model calls WebSearch: the query is the model's own.
 * The Responses API `web_search` tool, by contrast, only works on
 * deepseek-v4-pro and is ignored on deepseek-flash.
 *
 * @see https://api-docs.deepseek.com/guides/search
 * @see https://api-docs.deepseek.com/api/search
 * @module
 */

import {
  clip,
  deepSeekHttpFailureReason,
  deepSeekRequestFailureReason,
  deepSeekTimeoutReason,
  deepSeekToolEndpoint,
  parseHttpUrl,
  record,
  resolveDeepSeekToolSetting,
  text,
  type DeepSeekToolSetting,
} from "./tool-api.js";

export { isOfficialDeepSeekApiHost } from "./tool-api.js";

/** Session environment switch; it wins over `[providers.deepseek] web_search`. */
export const DEEPSEEK_WEB_SEARCH_ENV = "AGENC_DEEPSEEK_WEB_SEARCH";

/** Price of one successful search: $0.75 per 1,000 (empty results are free). */
export const DEEPSEEK_SEARCH_USD_PER_REQUEST = 0.00075;

/** The API rejects longer queries with HTTP 400. Counted in code points. */
export const DEEPSEEK_SEARCH_MAX_QUERY_CHARS = 128;

/** Model-facing cap on each result's `summary` (the API returns up to ~2.5K chars). */
export const DEEPSEEK_SEARCH_SUMMARY_MAX_CHARS = 600;

const DEEPSEEK_SEARCH_TIMEOUT_MS = 30_000;
const DEEPSEEK_SEARCH_MAX_RESPONSE_CHARS = 2_000_000;
const MIN_QUERY_CHARS_WITH_DOMAIN_OPERATORS = 24;

/**
 * `auto`: on for a deepseek session on DeepSeek's own API host when no
 * search endpoint is configured; `on`: on for every deepseek session;
 * `off`: never.
 */
export type DeepSeekWebSearchSetting = DeepSeekToolSetting;

export function resolveDeepSeekWebSearchSetting(
  environmentValue: string | undefined,
  configured: boolean | undefined,
): DeepSeekWebSearchSetting {
  return resolveDeepSeekToolSetting(environmentValue, configured);
}

/**
 * The search URL for a DeepSeek chat base URL (see
 * {@link deepSeekToolEndpoint}): `https://gw.example/deepseek/v1` becomes
 * `https://gw.example/deepseek/v1/tools/search`.
 */
export function deepSeekSearchEndpoint(baseURL: string): string | undefined {
  return deepSeekToolEndpoint(baseURL, "search");
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

function shortenToCodePoints(text: string, max: number): string {
  const points = codePoints(text);
  if (points.length <= max) return text;
  const head = points.slice(0, max).join("");
  const lastSpace = head.lastIndexOf(" ");
  return (lastSpace >= Math.floor(head.length / 2) ? head.slice(0, lastSpace) : head).trim();
}

export interface DeepSeekSearchQuery {
  /** The text sent as `query`, at most 128 code points. */
  readonly query: string;
  /** True when the model's own words had to be cut to fit. */
  readonly shortened: boolean;
}

/**
 * Fit the model's query, plus `site:` / `-site:` operators for its domain
 * filters when they leave room for the words, into DeepSeek's 128-character
 * query limit. Results are filtered by domain afterwards either way.
 */
export function buildDeepSeekSearchQuery(
  query: string,
  filters: {
    readonly allowedDomains: readonly string[];
    readonly blockedDomains: readonly string[];
  },
): DeepSeekSearchQuery {
  const words = query.trim().replace(/\s+/gu, " ");
  const operators = [
    filters.allowedDomains.map((domain) => `site:${domain}`).join(" OR "),
    filters.blockedDomains.map((domain) => `-site:${domain}`).join(" "),
  ].filter((part) => part.length > 0).join(" ");
  const room = DEEPSEEK_SEARCH_MAX_QUERY_CHARS - codePoints(operators).length - 1;
  const useOperators =
    operators.length > 0 && room >= MIN_QUERY_CHARS_WITH_DOMAIN_OPERATORS;
  const budget = useOperators ? room : DEEPSEEK_SEARCH_MAX_QUERY_CHARS;
  const base = shortenToCodePoints(words, budget);
  return {
    query: useOperators ? `${base} ${operators}` : base,
    shortened: base !== words,
  };
}

/** One result as the model sees it. */
export interface DeepSeekSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly summary?: string;
  /** Publication time as DeepSeek reports it (RFC 3339, UTC). */
  readonly date?: string;
  readonly site?: string;
}

export type DeepSeekSearchOutcome =
  | {
      readonly kind: "results";
      readonly hits: readonly DeepSeekSearchHit[];
      /** HTTP 200 with a non-empty `results` array: one billed request. */
      readonly billed: true;
    }
  | { readonly kind: "empty"; readonly billed: false }
  | { readonly kind: "failed"; readonly reason: string; readonly billed: false };

/** Summaries are page extracts in Markdown; heading marks only cost tokens. */
function summaryText(value: unknown): string | undefined {
  const plain = typeof value === "string"
    ? value.replace(/(^|\n)\s{0,3}#{1,6}\s+/gu, "$1")
    : value;
  const collapsed = text(plain);
  return collapsed === undefined
    ? undefined
    : clip(collapsed, DEEPSEEK_SEARCH_SUMMARY_MAX_CHARS);
}

function isUsableResultUrl(raw: string): boolean {
  return parseHttpUrl(raw) !== undefined;
}

/** Map one Search API response body to model-facing hits. */
export function parseDeepSeekSearchResults(body: unknown): {
  readonly hits: readonly DeepSeekSearchHit[];
  /** Length of the raw `results` array; DeepSeek bills when it is non-zero. */
  readonly resultCount: number;
} | undefined {
  const results = record(body)?.results;
  if (!Array.isArray(results)) return undefined;
  const hits: DeepSeekSearchHit[] = [];
  const seen = new Set<string>();
  for (const entry of results) {
    const item = record(entry);
    const url = text(item?.url);
    if (item === undefined || url === undefined || !isUsableResultUrl(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const summary = summaryText(item.summary);
    const date = text(item.date);
    const site = text(item.site_name);
    hits.push({
      title: text(item.title) ?? url,
      url,
      snippet: text(item.snippet) ?? "",
      ...(summary !== undefined ? { summary } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(site !== undefined ? { site } : {}),
    });
  }
  return { hits, resultCount: results.length };
}

export interface DeepSeekSearchRequest {
  /** From {@link deepSeekSearchEndpoint}. */
  readonly endpoint: string;
  /** The session's own DeepSeek key, sent only to the session's DeepSeek host. */
  readonly apiKey: string;
  /** From {@link buildDeepSeekSearchQuery}. */
  readonly query: string;
  /** 1 to 50; the price does not depend on it. */
  readonly count: number;
  /** The admitted tool signal. Its abort is rethrown, never turned into a fallback. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Proxy/TLS options for the session environment (`getProxyFetchOptions`). */
  readonly fetchOptions?: Readonly<Record<string, unknown>>;
}

/**
 * Run one search. Never throws for a provider-side failure: the caller falls
 * back to its keyless chain with the returned reason. Only the user's (or the
 * admission kernel's) abort propagates.
 */
export async function runDeepSeekSearch(
  request: DeepSeekSearchRequest,
): Promise<DeepSeekSearchOutcome> {
  const timeoutMs = request.timeoutMs ?? DEEPSEEK_SEARCH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
  const signal = request.signal
    ? AbortSignal.any([request.signal, timeout])
    : timeout;
  const failed = (reason: string): DeepSeekSearchOutcome => ({
    kind: "failed",
    reason,
    billed: false,
  });
  let status: number;
  let body: string;
  try {
    const response = await fetch(request.endpoint, {
      ...(request.fetchOptions ?? {}),
      method: "POST",
      // A redirect must not carry the bearer key anywhere else.
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "agenc-runtime/0.2",
      },
      body: JSON.stringify({
        query: request.query,
        count: Math.max(1, Math.min(50, Math.floor(request.count))),
      }),
    } as RequestInit);
    status = response.status;
    body = await response.text();
  } catch (error) {
    request.signal?.throwIfAborted();
    if (timeout.aborted) return failed(deepSeekTimeoutReason(timeoutMs));
    return failed(deepSeekRequestFailureReason(error, request.apiKey));
  }
  if (status !== 200) return failed(deepSeekHttpFailureReason(status, body, request.apiKey));
  if (body.length > DEEPSEEK_SEARCH_MAX_RESPONSE_CHARS) {
    return failed("response too large");
  }
  let parsed: ReturnType<typeof parseDeepSeekSearchResults>;
  try {
    parsed = parseDeepSeekSearchResults(JSON.parse(body));
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) return failed("malformed response");
  if (parsed.resultCount === 0) return { kind: "empty", billed: false };
  return { kind: "results", hits: parsed.hits, billed: true };
}
