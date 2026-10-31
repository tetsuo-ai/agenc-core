/**
 * Web search with an Ollama Cloud, OpenRouter or Venice session's own key,
 * for the model-facing WebSearch tool (a session-native step, like
 * DeepSeek's Search API). A session searches only with its own provider's
 * key; nothing here reads another provider's credential.
 *
 * - Ollama Cloud: `POST https://ollama.com/api/web_search` (title, url and a
 *   content snippet per result). 0.005 USD plus 0.001 USD per requested
 *   result, observed through `GET /api/usage?group_by=model` at 1, 3, 8 and
 *   10 results ("web_search", 2026-10-21).
 * - OpenRouter: the `web` plugin with the Exa engine on one chat completion
 *   with the session's model; results arrive as `url_citation` annotations
 *   and the response's `usage.cost` is the charge (Exa auto: 0.007 USD per
 *   request plus the model's tokens).
 * - Venice: `venice_parameters.enable_web_search: "on"` with citations on one
 *   chat completion with the session's model; results arrive in
 *   `venice_parameters.web_search_citations`. 10 USD per 1,000 searches plus
 *   the model's tokens at its listed price.
 *
 * Every failure is reported, never thrown, so the tool falls back to its
 * configured chain and says why.
 *
 * @see https://docs.ollama.com/capabilities/web-search
 * @see https://openrouter.ai/docs/guides/features/plugins/web-search
 * @see https://docs.venice.ai/overview/pricing
 * @module
 */

export const OLLAMA_WEB_SEARCH_URL = "https://ollama.com/api/web_search";
export const OLLAMA_WEB_FETCH_URL = "https://ollama.com/api/web_fetch";
/** Ollama search tariff observed through GET /api/usage, 2026-10-21. */
const OLLAMA_WEB_SEARCH_BASE_USD = 0.005;
const OLLAMA_WEB_SEARCH_RESULT_USD = 0.001;
/** OpenRouter's Exa engine in auto mode: USD per request, up to ten results. */
export const OPENROUTER_EXA_SEARCH_USD_PER_REQUEST = 0.007;
/** Venice: USD per web search request. */
export const VENICE_WEB_SEARCH_USD_PER_REQUEST = 0.01;
/** Ollama's API returns at most ten results. */
export const OLLAMA_WEB_SEARCH_MAX_RESULTS = 10;
/** Fee for the result limit sent to Ollama, including the API's bounds. */
export function ollamaWebSearchCostUsd(maxResults: number): number {
  return OLLAMA_WEB_SEARCH_BASE_USD +
    Math.max(1, Math.min(maxResults, OLLAMA_WEB_SEARCH_MAX_RESULTS)) * OLLAMA_WEB_SEARCH_RESULT_USD;
}

/** Upper bound of the prompt the search results add to a gateway's chat call. */
export const GATEWAY_SEARCH_PROMPT_TOKENS_CEILING = 20_000;
/** The answer is not used: only the results are. */
export const GATEWAY_SEARCH_MAX_OUTPUT_TOKENS = 256;

const SNIPPET_MAX_CHARS = 600;
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 4_000_000;

export interface GatewaySearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type GatewaySearchOutcome =
  | { readonly kind: "results"; readonly hits: readonly GatewaySearchHit[]; readonly costUsd: number | undefined }
  | { readonly kind: "empty"; readonly costUsd: number | undefined }
  | { readonly kind: "failed"; readonly reason: string; readonly costUsd: number | undefined };

/** USD per token for a model's input and output, when its price is known. */
export interface TokenRates {
  readonly inputUsdPerToken: number;
  readonly outputUsdPerToken: number;
}

interface CallOptions {
  readonly apiKey: string;
  readonly query: string;
  readonly maxResults: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /** The calling session's transport: proxy, client certificate and key, CA trust. */
  readonly fetchOptions?: Readonly<Record<string, unknown>>;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function hit(title: unknown, url: unknown, content: unknown): GatewaySearchHit | undefined {
  const link = httpsUrl(url);
  if (link === undefined) return undefined;
  return {
    title: (text(title) ?? link).slice(0, 300),
    url: link,
    snippet: (text(content) ?? "").replace(/\s+/g, " ").slice(0, SNIPPET_MAX_CHARS),
  };
}

function unique(hits: readonly (GatewaySearchHit | undefined)[], limit: number): readonly GatewaySearchHit[] {
  const seen = new Set<string>();
  const out: GatewaySearchHit[] = [];
  for (const entry of hits) {
    if (entry === undefined || seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

async function postJson(
  url: string,
  apiKey: string,
  body: Readonly<Record<string, unknown>>,
  options: Pick<CallOptions, "signal" | "fetchImpl" | "fetchOptions">,
): Promise<{ readonly status: number; readonly json?: unknown; readonly reason?: string }> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      ...(options.fetchOptions ?? {}),
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
    });
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_CHARS) return { status: response.status, reason: "response too large" };
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const message = text(record(record(json)?.error)?.message) ?? text(record(json)?.error) ?? raw.slice(0, 160);
      return { status: response.status, reason: `HTTP ${response.status}: ${message.replaceAll(apiKey, "[REDACTED]").slice(0, 160)}` };
    }
    return { status: response.status, json };
  } catch (error) {
    options.signal?.throwIfAborted();
    return { status: 0, reason: error instanceof Error ? error.message.slice(0, 160) : "request failed" };
  }
}

function tokenCost(usage: unknown, rates: TokenRates | undefined): number | undefined {
  const u = record(usage);
  if (rates === undefined || u === undefined) return undefined;
  const input = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const output = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  return input * rates.inputUsdPerToken + output * rates.outputUsdPerToken;
}

/** Ollama Cloud's web search API with the session's Ollama key. */
export async function runOllamaWebSearch(options: CallOptions): Promise<GatewaySearchOutcome> {
  const answer = await postJson(OLLAMA_WEB_SEARCH_URL, options.apiKey, {
    query: options.query,
    max_results: Math.max(1, Math.min(options.maxResults, OLLAMA_WEB_SEARCH_MAX_RESULTS)),
  }, options);
  if (answer.reason !== undefined) return { kind: "failed", reason: answer.reason, costUsd: undefined };
  const costUsd = ollamaWebSearchCostUsd(options.maxResults);
  const results = record(answer.json)?.results;
  if (!Array.isArray(results)) return { kind: "failed", reason: "no results array", costUsd };
  const hits = unique(results.map(entry => hit(record(entry)?.title, record(entry)?.url, record(entry)?.content)), options.maxResults);
  return hits.length > 0
    ? { kind: "results", hits, costUsd }
    : { kind: "empty", costUsd };
}

/** Ollama Cloud's web fetch API with the session's Ollama key: title and readable content of one page. */
export async function runOllamaWebFetch(
  options: Omit<CallOptions, "query" | "maxResults"> & { readonly url: string },
): Promise<{ readonly title?: string; readonly content: string } | { readonly error: string }> {
  const answer = await postJson(OLLAMA_WEB_FETCH_URL, options.apiKey, { url: options.url }, options);
  if (answer.reason !== undefined) return { error: answer.reason };
  const body = record(answer.json);
  const content = typeof body?.content === "string" ? body.content : undefined;
  if (content === undefined) return { error: "Ollama web fetch returned no content" };
  const title = text(body?.title);
  return { ...(title === undefined ? {} : { title }), content };
}

/**
 * OpenRouter's web plugin (Exa) on one chat completion with the session's
 * model and key. With zero data retention on (the default) the call carries
 * `provider.zdr` like the session's own requests. OpenRouter's ZDR covers the
 * model endpoint, not the search engine.
 */
export async function runOpenRouterWebSearch(options: CallOptions & {
  readonly baseURL: string;
  readonly model: string;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  /** Route the model call only to zero-data-retention endpoints, as the session does. */
  readonly zeroDataRetention?: boolean;
}): Promise<GatewaySearchOutcome> {
  const plugin: Record<string, unknown> = {
    id: "web",
    engine: "exa",
    max_results: Math.max(1, Math.min(options.maxResults, 10)),
    ...(options.allowedDomains !== undefined && options.allowedDomains.length > 0 ? { include_domains: [...options.allowedDomains] } : {}),
    ...(options.blockedDomains !== undefined && options.blockedDomains.length > 0 ? { exclude_domains: [...options.blockedDomains] } : {}),
  };
  const answer = await postJson(`${options.baseURL.replace(/\/+$/, "")}/chat/completions`, options.apiKey, {
    model: options.model,
    messages: [{ role: "user", content: options.query }],
    plugins: [plugin],
    max_tokens: GATEWAY_SEARCH_MAX_OUTPUT_TOKENS,
    usage: { include: true },
    stream: false,
    ...(options.zeroDataRetention === true ? { provider: { zdr: true } } : {}),
  }, options);
  if (answer.reason !== undefined) return { kind: "failed", reason: answer.reason, costUsd: undefined };
  const body = record(answer.json);
  const cost = typeof record(body?.usage)?.cost === "number" ? record(body?.usage)!.cost as number : undefined;
  const message = record(record((Array.isArray(body?.choices) ? body!.choices : [])[0])?.message);
  const annotations = Array.isArray(message?.annotations) ? message!.annotations : [];
  const hits = unique(annotations.map((entry) => {
    const citation = record(record(entry)?.url_citation);
    return citation === undefined ? undefined : hit(citation.title, citation.url, citation.content);
  }), options.maxResults);
  return hits.length > 0 ? { kind: "results", hits, costUsd: cost } : { kind: "empty", costUsd: cost };
}

/** Venice's web search on one chat completion with the session's model and key. */
export async function runVeniceWebSearch(options: CallOptions & {
  readonly baseURL: string;
  readonly model: string;
  readonly rates?: TokenRates;
}): Promise<GatewaySearchOutcome> {
  const answer = await postJson(`${options.baseURL.replace(/\/+$/, "")}/chat/completions`, options.apiKey, {
    model: options.model,
    messages: [{ role: "user", content: options.query }],
    max_tokens: GATEWAY_SEARCH_MAX_OUTPUT_TOKENS,
    stream: false,
    venice_parameters: {
      enable_web_search: "on",
      enable_web_citations: true,
      include_venice_system_prompt: false,
    },
  }, options);
  if (answer.reason !== undefined) return { kind: "failed", reason: answer.reason, costUsd: undefined };
  const body = record(answer.json);
  const tokens = tokenCost(body?.usage, options.rates);
  const cost = tokens === undefined ? undefined : VENICE_WEB_SEARCH_USD_PER_REQUEST + tokens;
  const citations = record(body?.venice_parameters)?.web_search_citations;
  const hits = unique((Array.isArray(citations) ? citations : []).map(entry =>
    hit(record(entry)?.title, record(entry)?.url, record(entry)?.content)), options.maxResults);
  return hits.length > 0 ? { kind: "results", hits, costUsd: cost } : { kind: "empty", costUsd: cost };
}
