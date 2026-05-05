/**
 * Ports upstream `src/services/api/client.ts` request wrapping and
 * `src/services/api/fetchWithProxyRetry.ts` stale-connection retrying onto
 * AgenC's provider-neutral fetch surface.
 *
 * Why this lives here / shape difference from upstream:
 *   - Upstream constructs a specific SDK client with product auth headers.
 *     AgenC exposes a small JSON/text fetch wrapper for any provider adapter.
 *
 * Cross-cuts deliberately NOT carried:
 *   - OAuth/API-key discovery, Bedrock/Vertex/Foundry SDK construction,
 *     provider analytics headers, and proxy-specific keep-alive mutation.
 */

import { AgenCApiError, extractApiErrorMessage } from "./errors.js";
import {
  parseRetryAfterMs,
  shouldRetryApiError,
  withRetry,
  type WithRetryOptions,
} from "./retry.js";

const RETRYABLE_FETCH_ERROR_PATTERN =
  /socket connection was closed unexpectedly|ECONNRESET|EPIPE|socket hang up|Connection reset by peer|fetch failed/i;

export interface AgenCApiHttpClientConfig {
  readonly baseURL: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly retry?: WithRetryOptions;
}

export interface AgenCApiRequestOptions {
  readonly path?: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly retry?: WithRetryOptions;
}

export interface AgenCApiResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
}

export function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  return RETRYABLE_FETCH_ERROR_PATTERN.test(error.message);
}

export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly maxAttempts?: number;
    readonly onRetry?: (event: { readonly attempt: number; readonly error: unknown }) => void;
  } = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchImpl(input, init);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) {
        throw error;
      }
      options.onRetry?.({ attempt, error });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Fetch failed without an error object");
}

export function buildApiRequestUrl(
  baseURL: string,
  path = "",
  query?: Readonly<Record<string, string | number | boolean | undefined>>,
): URL {
  const url = new URL(baseURL);
  const basePath = url.pathname.replace(/\/+$/, "");
  const requestPath = path.replace(/^\/+/, "");
  url.pathname = requestPath
    ? `${basePath}/${requestPath}`.replace(/\/{2,}/g, "/")
    : basePath || "/";
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

export class AgenCApiHttpClient {
  private readonly config: AgenCApiHttpClientConfig;

  constructor(config: AgenCApiHttpClientConfig) {
    this.config = config;
  }

  async requestJson<T>(
    options: AgenCApiRequestOptions = {},
  ): Promise<AgenCApiResponse<T>> {
    const response = await this.requestRaw(options);
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const data =
      text.length > 0 && contentType.includes("application/json")
        ? (JSON.parse(text) as T)
        : (undefined as T);
    return {
      data,
      status: response.status,
      headers: response.headers,
      url: response.url,
    };
  }

  async requestText(
    options: AgenCApiRequestOptions = {},
  ): Promise<AgenCApiResponse<string>> {
    const response = await this.requestRaw(options);
    return {
      data: await response.text(),
      status: response.status,
      headers: response.headers,
      url: response.url,
    };
  }

  async requestRaw(options: AgenCApiRequestOptions = {}): Promise<Response> {
    const retryOptions = {
      ...(this.config.retry ?? {}),
      ...(options.retry ?? {}),
      signal: options.signal ?? options.retry?.signal ?? this.config.retry?.signal,
    } satisfies WithRetryOptions;

    return await withRetry(
      async () => {
        const response = await this.fetchResponse(options);
        if (!response.ok) {
          throw await createAgenCApiHttpError(response);
        }
        return response;
      },
      {
        ...retryOptions,
        retryStatuses: retryOptions.retryStatuses,
      },
    );
  }

  private async fetchResponse(
    options: AgenCApiRequestOptions,
  ): Promise<Response> {
    const url = buildApiRequestUrl(this.config.baseURL, options.path, options.query);
    const headers = new Headers(this.config.defaultHeaders ?? {});
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      headers.set(key, value);
    }

    let body: RequestInit["body"] | undefined;
    if (options.body !== undefined) {
      if (isNativeBodyInit(options.body)) {
        body = options.body;
      } else {
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
        body = JSON.stringify(options.body);
      }
    }

    const fetchImpl = this.config.fetchImpl ?? fetch;
    return await fetchImpl(url, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body,
      signal: options.signal,
    });
  }
}

async function createAgenCApiHttpError(response: Response): Promise<AgenCApiError> {
  const body = await readResponseBody(response);
  const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
  return new AgenCApiError(
    extractApiErrorMessage(body, `HTTP ${response.status}`),
    {
      status: response.status,
      headers: response.headers,
      body,
      retryAfterMs: retryAfter.delayMs,
      url: response.url,
    },
  );
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
    return text;
  } catch {
    return undefined;
  }
}

export function isRetryableHttpApiError(error: unknown): boolean {
  return shouldRetryApiError(error);
}

function isNativeBodyInit(value: unknown): value is NonNullable<RequestInit["body"]> {
  return (
    typeof value === "string" ||
    (typeof FormData !== "undefined" && value instanceof FormData) ||
    (typeof URLSearchParams !== "undefined" &&
      value instanceof URLSearchParams) ||
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
  );
}
