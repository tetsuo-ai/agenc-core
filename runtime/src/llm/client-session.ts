/**
 * Turn-scoped HTTP client session for provider adapters.
 *
 * Keeps transport concerns out of provider-specific request shaping.
 *
 * @module
 */

export interface ProviderHttpClientSessionConfig {
  readonly providerName: string;
  readonly baseURL: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface ProviderHttpRequestOptions {
  readonly path: string;
  readonly method?: "GET" | "POST" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ProviderHttpJsonResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
}

export class ProviderHttpError extends Error {
  readonly providerName: string;
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
  readonly body?: unknown;

  constructor(args: {
    providerName: string;
    status: number;
    headers: Headers;
    url: string;
    message: string;
    body?: unknown;
  }) {
    super(args.message);
    this.name = "ProviderHttpError";
    this.providerName = args.providerName;
    this.status = args.status;
    this.headers = args.headers;
    this.url = args.url;
    this.body = args.body;
  }
}

function resolveTimeoutMs(
  defaultTimeoutMs: number | undefined,
  requestTimeoutMs: number | undefined,
): number | undefined {
  const normalize = (value: number | undefined): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (value <= 0) return undefined;
    return Math.max(1, Math.floor(value));
  };

  const resolvedDefault = normalize(defaultTimeoutMs);
  const resolvedRequest = normalize(requestTimeoutMs);
  if (resolvedDefault === undefined) return resolvedRequest;
  if (resolvedRequest === undefined) return resolvedDefault;
  return Math.min(resolvedDefault, resolvedRequest);
}

function mergeAbortSignals(
  outerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { readonly signal?: AbortSignal; readonly cleanup: () => void } {
  const timeoutController =
    timeoutMs !== undefined ? new AbortController() : undefined;
  const linkedController =
    outerSignal !== undefined || timeoutController !== undefined
      ? new AbortController()
      : undefined;

  let timeoutId: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  if (timeoutController !== undefined) {
    timeoutId = setTimeout(() => {
      timeoutController.abort(
        new Error(`provider request timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  }

  if (linkedController !== undefined) {
    const abortLinked = (reason?: unknown) => {
      if (!linkedController.signal.aborted) {
        linkedController.abort(reason);
      }
    };

    if (outerSignal !== undefined) {
      onAbort = () => abortLinked(outerSignal.reason);
      if (outerSignal.aborted) {
        abortLinked(outerSignal.reason);
      } else {
        outerSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (timeoutController !== undefined) {
      if (timeoutController.signal.aborted) {
        abortLinked(timeoutController.signal.reason);
      } else {
        timeoutController.signal.addEventListener(
          "abort",
          () => abortLinked(timeoutController.signal.reason),
          { once: true },
        );
      }
    }
  }

  return {
    signal: linkedController?.signal ?? outerSignal,
    cleanup: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (outerSignal !== undefined && onAbort !== undefined) {
        outerSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function readErrorBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      return await response.json();
    }
    const text = await response.text();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function errorMessageFromBody(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const direct =
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : undefined;
    if (direct) return direct;
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      const nestedMessage =
        typeof nested.message === "string" ? nested.message : undefined;
      if (nestedMessage) return nestedMessage;
      const nestedType = typeof nested.type === "string" ? nested.type : "";
      if (nestedType) return nestedType;
    }
  }
  if (typeof body === "string" && body.trim().length > 0) {
    return body.trim();
  }
  return `HTTP ${status}`;
}

export class ProviderHttpClientSession {
  private readonly config: ProviderHttpClientSessionConfig;

  constructor(config: ProviderHttpClientSessionConfig) {
    this.config = config;
  }

  async requestJson<T>(
    options: ProviderHttpRequestOptions,
  ): Promise<ProviderHttpJsonResponse<T>> {
    const method = options.method ?? "POST";
    const url = new URL(options.path, this.config.baseURL);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    const headers = new Headers(this.config.defaultHeaders ?? {});
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      headers.set(key, value);
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }

    const fetchImpl = this.config.fetchImpl ?? fetch;
    const timeoutMs = resolveTimeoutMs(this.config.timeoutMs, options.timeoutMs);
    const { signal, cleanup } = mergeAbortSignals(options.signal, timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        const errorBody = await readErrorBody(response);
        throw new ProviderHttpError({
          providerName: this.config.providerName,
          status: response.status,
          headers: response.headers,
          url: response.url,
          body: errorBody,
          message: errorMessageFromBody(response.status, errorBody),
        });
      }

      const data = contentType.includes("application/json")
        ? (await response.json()) as T
        : (undefined as T);
      return {
        data,
        status: response.status,
        headers: response.headers,
        url: response.url,
      };
    } finally {
      cleanup();
    }
  }
}
