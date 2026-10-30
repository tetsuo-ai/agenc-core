/**
 * DeepSeek Fetch API client for the model-facing web_fetch tool.
 *
 * DeepSeek's fetch is a plain REST endpoint (`POST /v1/tools/fetch`)
 * authenticated with the same key as its chat API. It takes one URL and
 * returns the page's title and its content as Markdown. DeepSeek's servers
 * load the page, so the request that leaves this machine goes to the
 * session's DeepSeek host, never to the page's host.
 *
 * Only the URL is sent. The caller decides whether a URL may go to DeepSeek
 * at all: {@link deepSeekFetchSkipReason} keeps local and non-public names,
 * IP addresses and URLs with credentials away from it, and web_fetch adds
 * its own permission, preapproval and DNS checks before calling
 * {@link runDeepSeekFetch}.
 *
 * @see https://api-docs.deepseek.com/guides/search
 * @see https://api-docs.deepseek.com/api/fetch
 * @module
 */

import { isIP } from "node:net";

import { sleep } from "../../../utils/sleep.js";
import {
  deepSeekHttpFailureReason,
  deepSeekRequestFailureReason,
  deepSeekTimeoutReason,
  deepSeekToolEndpoint,
  parseHttpUrl,
  record,
  resolveDeepSeekToolSetting,
  type DeepSeekToolSetting,
} from "./tool-api.js";

/** Session environment switch; it wins over `[providers.deepseek] web_fetch`. */
export const DEEPSEEK_WEB_FETCH_ENV = "AGENC_DEEPSEEK_WEB_FETCH";

/**
 * Price of one successful fetch: $0.75 per 1,000. DeepSeek bills a request
 * that returns HTTP 200 with page content; failures, empty pages and
 * timeouts are free.
 */
export const DEEPSEEK_FETCH_USD_PER_REQUEST = 0.00075;

/** The API rejects longer URLs with HTTP 400. */
export const DEEPSEEK_FETCH_MAX_URL_CHARS = 8_192;

/** Both attempts together, unless the caller passes its own timeout. */
export const DEEPSEEK_FETCH_TIMEOUT_MS = 30_000;
const DEEPSEEK_FETCH_MAX_TIMEOUT_MS = 120_000;

/** Wait before the one retry when DeepSeek sends no usable Retry-After. */
export const DEEPSEEK_FETCH_RETRY_DELAY_MS = 1_000;
/** A Retry-After above this is cut to it: the retry stays short. */
export const DEEPSEEK_FETCH_MAX_RETRY_DELAY_MS = 2_000;

/** A page above this is left to the local fetcher, which reads it bounded. */
const DEEPSEEK_FETCH_MAX_RESPONSE_BYTES = 8_000_000;
/** An error body only needs DeepSeek's short message. */
const DEEPSEEK_FETCH_MAX_ERROR_BYTES = 64_000;

/**
 * Name suffixes that never name a public site: mDNS, private-use and
 * reserved namespaces. Their URLs stay with the local fetcher.
 */
const NON_PUBLIC_NAME_SUFFIXES = Object.freeze([
  "local",
  "localhost",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "test",
  "invalid",
  "onion",
  "arpa",
]);

/**
 * `auto`: on for a deepseek session on DeepSeek's own API host; `on`: on for
 * every deepseek session, including a proxy base URL; `off`: never.
 */
export type DeepSeekWebFetchSetting = DeepSeekToolSetting;

export function resolveDeepSeekWebFetchSetting(
  environmentValue: string | undefined,
  configured: boolean | undefined,
): DeepSeekWebFetchSetting {
  return resolveDeepSeekToolSetting(environmentValue, configured);
}

/**
 * The fetch URL for a DeepSeek chat base URL, next to the search URL:
 * `/v1/tools/fetch` on DeepSeek's own host, and
 * `https://gw.example/deepseek/v1/tools/fetch` behind a proxy at
 * `https://gw.example/deepseek/v1`.
 */
export function deepSeekFetchEndpoint(baseURL: string): string | undefined {
  return deepSeekToolEndpoint(baseURL, "fetch");
}

/**
 * Why `url` must not be sent to DeepSeek, or undefined when it may be.
 * DeepSeek only gets an http(s) URL of at most 8,192 characters, without a
 * username or password, whose host is a public DNS name: no IP address, no
 * single-label name, and no local, private-use or reserved suffix. The
 * caller still resolves the name itself before sending it.
 */
export function deepSeekFetchSkipReason(url: string): string | undefined {
  const parsed = parseHttpUrl(url);
  if (parsed === undefined) return "not an http or https URL";
  if (url.length > DEEPSEEK_FETCH_MAX_URL_CHARS) {
    return `URL longer than ${DEEPSEEK_FETCH_MAX_URL_CHARS} characters`;
  }
  if (parsed.username !== "" || parsed.password !== "") return "URL with credentials";
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
  if (host.length === 0) return "URL without a host";
  if (isIP(host) !== 0) return "IP address host";
  const suffix = NON_PUBLIC_NAME_SUFFIXES.find(
    (name) => host === name || host.endsWith(`.${name}`),
  );
  if (suffix !== undefined) return `.${suffix} host`;
  return host.includes(".") ? undefined : "single-label host";
}

export type DeepSeekFetchOutcome =
  | {
      readonly kind: "content";
      /** The page title; empty when DeepSeek has none. */
      readonly title: string;
      /** The page as Markdown, never empty. */
      readonly content: string;
      /** HTTP 200 with page content: one billed request. */
      readonly billed: true;
      readonly attempts: number;
    }
  | { readonly kind: "empty"; readonly billed: false; readonly attempts: number }
  | {
      readonly kind: "failed";
      readonly reason: string;
      /** True only when DeepSeek answered 200 and AgenC could not use the body. */
      readonly billed: boolean;
      readonly attempts: number;
    };

export interface DeepSeekFetchRequest {
  /** From {@link deepSeekFetchEndpoint}. */
  readonly endpoint: string;
  /** The session's own DeepSeek key, sent only to the session's DeepSeek host. */
  readonly apiKey: string;
  /** A URL that passed {@link deepSeekFetchSkipReason} and the caller's checks. */
  readonly url: string;
  /** The admitted tool signal. Its abort is rethrown, never turned into a fallback. */
  readonly signal?: AbortSignal;
  /** Budget for both attempts together. Default 30 s, at most 120 s. */
  readonly timeoutMs?: number;
  /** Proxy/TLS options for the session environment (`getProxyFetchOptions`). */
  readonly fetchOptions?: Readonly<Record<string, unknown>>;
  /** Overrides the wait before the retry (tests). */
  readonly retryDelayMs?: number;
}

/** DeepSeek asks clients to wait and retry these: QPS limit, slow read, server side. */
export function isRetryableDeepSeekFetchStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * The wait before the one retry: a numeric Retry-After when DeepSeek sends
 * one, else one second, never more than two.
 */
export function deepSeekFetchRetryDelayMs(retryAfter: string | null): number {
  const seconds = retryAfter === null || retryAfter.trim() === ""
    ? Number.NaN
    : Number(retryAfter.trim());
  const wanted = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : DEEPSEEK_FETCH_RETRY_DELAY_MS;
  return Math.min(DEEPSEEK_FETCH_MAX_RETRY_DELAY_MS, Math.max(0, Math.round(wanted)));
}

interface BoundedBody {
  readonly text: string;
  readonly overflow: boolean;
}

async function readBodyBounded(response: Response, maxBytes: number): Promise<BoundedBody> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { text: "", overflow: true };
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: await response.text(), overflow: false };
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { text: "", overflow: true };
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return { text, overflow: false };
  } finally {
    reader.releaseLock();
  }
}

/**
 * Fetch one page. Never throws for a provider-side failure: the caller falls
 * back to its local fetcher with the returned reason. A 408, 429 or 5xx is
 * retried once after a short wait, within the same time budget. Only the
 * user's (or the admission kernel's) abort propagates.
 */
export async function runDeepSeekFetch(
  request: DeepSeekFetchRequest,
): Promise<DeepSeekFetchOutcome> {
  const timeoutMs = Math.max(
    1,
    Math.min(Math.floor(request.timeoutMs ?? DEEPSEEK_FETCH_TIMEOUT_MS), DEEPSEEK_FETCH_MAX_TIMEOUT_MS),
  );
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = request.signal
    ? AbortSignal.any([request.signal, timeout])
    : timeout;
  const failed = (reason: string, attempts: number, billed = false): DeepSeekFetchOutcome => ({
    kind: "failed",
    reason,
    billed,
    attempts,
  });
  const transportReason = (error: unknown): string => {
    request.signal?.throwIfAborted();
    return timeout.aborted
      ? deepSeekTimeoutReason(timeoutMs)
      : deepSeekRequestFailureReason(error, request.apiKey);
  };
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(request.endpoint, {
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
        body: JSON.stringify({ url: request.url }),
      } as RequestInit);
    } catch (error) {
      return failed(transportReason(error), attempt);
    }

    if (response.status !== 200) {
      let body = "";
      try {
        body = (await readBodyBounded(response, DEEPSEEK_FETCH_MAX_ERROR_BYTES)).text;
      } catch {
        request.signal?.throwIfAborted();
      }
      const reason = deepSeekHttpFailureReason(response.status, body, request.apiKey);
      if (attempt > 1) return failed(`${reason}, retried once`, attempt);
      if (!isRetryableDeepSeekFetchStatus(response.status)) return failed(reason, attempt);
      await sleep(
        request.retryDelayMs ?? deepSeekFetchRetryDelayMs(response.headers.get("retry-after")),
        signal,
      );
      request.signal?.throwIfAborted();
      // No time left for the retry: report the answer DeepSeek gave.
      if (timeout.aborted) return failed(reason, attempt);
      continue;
    }

    // HTTP 200. DeepSeek bills it when it carries page content, so a body
    // AgenC cannot read in full still counts as a billed request.
    let raw: BoundedBody;
    try {
      raw = await readBodyBounded(response, DEEPSEEK_FETCH_MAX_RESPONSE_BYTES);
    } catch (error) {
      return failed(transportReason(error), attempt, true);
    }
    if (raw.overflow) return failed("response too large", attempt, true);
    let page: Record<string, unknown> | undefined;
    try {
      page = record(JSON.parse(raw.text));
    } catch {
      page = undefined;
    }
    if (page === undefined || typeof page.content !== "string") {
      return failed("malformed response", attempt);
    }
    if (page.content.trim().length === 0) return { kind: "empty", billed: false, attempts: attempt };
    const title = typeof page.title === "string" ? page.title.replace(/\s+/gu, " ").trim() : "";
    return { kind: "content", title, content: page.content, billed: true, attempts: attempt };
  }
}
