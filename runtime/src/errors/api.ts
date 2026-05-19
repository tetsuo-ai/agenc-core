import type { SDKAssistantMessageError } from "./runtime.js";

export type AgenCSystemAPIErrorMessage = {
  readonly type: "system";
  readonly subtype: "api_error";
  readonly level: "error";
  readonly uuid?: string;
  readonly timestamp?: string;
  readonly cause?: Error;
  readonly error: unknown;
  readonly retryInMs: number;
  readonly retryAttempt: number;
  readonly maxRetries: number;
};

export const API_ERROR_MESSAGE_PREFIX = "API Error";
export const PROMPT_TOO_LONG_ERROR_MESSAGE = "Prompt is too long";
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = "Credit balance is too low";
export const INVALID_API_KEY_ERROR_MESSAGE = "Not logged in - please run /login";
export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL =
  "Invalid API key - fix external API key";
export const TOKEN_REVOKED_ERROR_MESSAGE =
  "OAuth token revoked - please run /login";
export const REPEATED_529_ERROR_MESSAGE = "Repeated 529 Overloaded errors";
export const API_TIMEOUT_ERROR_MESSAGE = "Request timed out";

const HTML_API_ERROR_MESSAGE =
  "Received an HTML response from the API instead of JSON. Check provider endpoint, proxy, or login status.";

const SSL_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CERT_REVOKED",
  "CERT_REJECTED",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_CHAIN_TOO_LONG",
  "PATH_LENGTH_EXCEEDED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
]);

export type ConnectionErrorDetails = {
  readonly code: string;
  readonly message: string;
  readonly isSSLError: boolean;
};

export type AgenCApiErrorKind =
  | "aborted"
  | "api_timeout"
  | "auth_error"
  | "client_error"
  | "connection_error"
  | "context_overflow"
  | "image_too_large"
  | "network_error"
  | "pdf_password_protected"
  | "pdf_too_large"
  | "prompt_too_long"
  | "rate_limit"
  | "server_error"
  | "server_overload"
  | "tool_use_mismatch"
  | "unknown";

export interface AgenCApiErrorOptions {
  readonly status?: number;
  readonly headers?: Headers;
  readonly body?: unknown;
  readonly retryAfterMs?: number;
  readonly url?: string;
  readonly kind?: AgenCApiErrorKind;
  readonly cause?: unknown;
}

export class AgenCApiError extends Error {
  readonly status?: number;
  readonly headers?: Headers;
  readonly body?: unknown;
  readonly retryAfterMs?: number;
  readonly url?: string;
  readonly kind: AgenCApiErrorKind;
  override readonly cause?: unknown;

  constructor(message: string, options: AgenCApiErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AgenCApiError";
    this.status = options.status;
    this.headers = options.headers;
    this.body = options.body;
    this.retryAfterMs = options.retryAfterMs;
    this.url = options.url;
    this.kind =
      options.kind ??
      classifyApiErrorLike({
        status: options.status,
        message,
      });
    this.cause = options.cause;
  }
}

export function extractConnectionErrorDetails(
  error: unknown,
): ConnectionErrorDetails | null {
  if (!error || typeof error !== "object") return null;

  let current: unknown = error;
  let depth = 0;
  while (current && depth < 5) {
    if (
      current instanceof Error &&
      "code" in current &&
      typeof current.code === "string"
    ) {
      return {
        code: current.code,
        message: current.message,
        isSSLError: SSL_ERROR_CODES.has(current.code),
      };
    }

    if (
      current instanceof Error &&
      "cause" in current &&
      current.cause !== current
    ) {
      current = current.cause;
      depth += 1;
    } else {
      break;
    }
  }

  return null;
}

export function getSSLErrorHint(error: unknown): string | null {
  const details = extractConnectionErrorDetails(error);
  if (!details?.isSSLError) return null;
  return `SSL certificate error (${details.code}). If you are behind a corporate proxy or TLS-intercepting firewall, set NODE_EXTRA_CA_CERTS to your CA bundle path, or ask IT to allowlist the provider endpoint. Run /doctor for details.`;
}

function sanitizeMessageHTML(message: string): string {
  if (/<!doctype\s+html|<html\b/i.test(message)) {
    const titleMatch = message.match(/<title[^>]*>([^<]+)<\/title>/i);
    return titleMatch?.[1]?.trim() ?? HTML_API_ERROR_MESSAGE;
  }
  return message;
}

export function redactSensitiveAPIText(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bAuthorization\s*:\s*[^\r\n]+/gi, "Authorization: [REDACTED]")
    .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, "Cookie: [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]");
}

function sanitizeAPIMessage(message: string): string {
  return redactSensitiveAPIText(sanitizeMessageHTML(message));
}

export function sanitizeAPIError(error: unknown): string {
  const message = readMessage(error);
  if (!message) return "";
  return sanitizeAPIMessage(message);
}

function sanitizeNonEmptyMessage(message: unknown): string | null {
  if (typeof message !== "string" || message.length === 0) return null;
  const sanitized = sanitizeAPIMessage(message);
  return sanitized.length > 0 ? sanitized : null;
}

type NestedAPIError = {
  readonly error?: {
    readonly message?: string;
    readonly error?: { readonly message?: string };
  };
};

function hasNestedError(value: unknown): value is NestedAPIError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null
  );
}

function extractNestedErrorMessage(error: unknown): string | null {
  if (!hasNestedError(error)) return null;

  const deepMsg = error.error?.error?.message;
  const deepSanitized = sanitizeNonEmptyMessage(deepMsg);
  if (deepSanitized) return deepSanitized;

  const msg = error.error?.message;
  const sanitized = sanitizeNonEmptyMessage(msg);
  if (sanitized) return sanitized;

  return null;
}

function extractBodyErrorMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;

  const record = error as {
    readonly body?: unknown;
    readonly data?: unknown;
    readonly response?: { readonly data?: unknown; readonly body?: unknown };
  };
  const candidates = [
    record.body,
    record.data,
    record.response?.data,
    record.response?.body,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const direct = sanitizeNonEmptyMessage(candidate);
    if (direct) return direct;
    const nested = extractNestedErrorMessage(candidate);
    if (nested) return nested;
  }

  return null;
}

export function formatAPIError(error: unknown): string {
  const connectionDetails = extractConnectionErrorDetails(error);
  if (connectionDetails) {
    const { code, isSSLError } = connectionDetails;

    if (code === "ETIMEDOUT") {
      return "Request timed out. Check your internet connection and proxy settings";
    }

    if (isSSLError) {
      switch (code) {
        case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
        case "UNABLE_TO_GET_ISSUER_CERT":
        case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
          return "Unable to connect to API: SSL certificate verification failed. Check your proxy or corporate SSL certificates";
        case "CERT_HAS_EXPIRED":
          return "Unable to connect to API: SSL certificate has expired";
        case "CERT_REVOKED":
          return "Unable to connect to API: SSL certificate has been revoked";
        case "DEPTH_ZERO_SELF_SIGNED_CERT":
        case "SELF_SIGNED_CERT_IN_CHAIN":
          return "Unable to connect to API: Self-signed certificate detected. Check your proxy or corporate SSL certificates";
        case "ERR_TLS_CERT_ALTNAME_INVALID":
        case "HOSTNAME_MISMATCH":
          return "Unable to connect to API: SSL certificate hostname mismatch";
        case "CERT_NOT_YET_VALID":
          return "Unable to connect to API: SSL certificate is not yet valid";
        default:
          return `Unable to connect to API: SSL error (${code})`;
      }
    }
  }

  const rawMessage = readMessage(error);
  if (rawMessage === "Connection error.") {
    if (connectionDetails?.code) {
      return `Unable to connect to API (${connectionDetails.code})`;
    }
    return "Unable to connect to API. Check your internet connection";
  }

  const bodyMessage = extractBodyErrorMessage(error);
  if (bodyMessage) return bodyMessage;

  if (!rawMessage) {
    return (
      extractNestedErrorMessage(error) ??
      `API error (status ${readStatus(error) ?? "unknown"})`
    );
  }

  const sanitized = sanitizeAPIError(error);
  return sanitized.length > 0 ? sanitized : rawMessage;
}

export function startsWithApiErrorPrefix(text: string): boolean {
  return (
    text.startsWith(API_ERROR_MESSAGE_PREFIX) ||
    text.startsWith(`Please run /login - ${API_ERROR_MESSAGE_PREFIX}`) ||
    text.startsWith(`Please run /login · ${API_ERROR_MESSAGE_PREFIX}`)
  );
}

export function parsePromptTooLongTokenCounts(rawMessage: string): {
  readonly actualTokens: number | undefined;
  readonly limitTokens: number | undefined;
} {
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  );
  return {
    actualTokens: match ? Number.parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? Number.parseInt(match[2]!, 10) : undefined,
  };
}

export function getPromptTooLongTokenGap(
  rawMessage: string,
): number | undefined {
  const { actualTokens, limitTokens } =
    parsePromptTooLongTokenCounts(rawMessage);
  if (actualTokens === undefined || limitTokens === undefined) return undefined;
  const gap = actualTokens - limitTokens;
  return gap > 0 ? gap : undefined;
}

export function isMediaSizeError(raw: string): boolean {
  return (
    (raw.includes("image exceeds") && raw.includes("maximum")) ||
    (raw.includes("image dimensions exceed") && raw.includes("many-image")) ||
    /maximum of \d+ PDF pages/.test(raw)
  );
}

export function extractApiErrorMessage(
  body: unknown,
  fallback: string,
): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return sanitizeAPIError({ message: record.message });
    }
    if (typeof record.error === "string" && record.error.trim()) {
      return sanitizeAPIError({ message: record.error });
    }
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string" && nested.message.trim()) {
        return sanitizeAPIError({ message: nested.message });
      }
      if (typeof nested.type === "string" && nested.type.trim()) {
        return sanitizeAPIError({ message: nested.type });
      }
    }
  }
  if (typeof body === "string" && body.trim()) {
    return sanitizeAPIError({ message: body });
  }
  return fallback;
}

export function classifyApiError(error: unknown): AgenCApiErrorKind {
  const unwrapped = unwrapCannotRetryError(error);
  if (unwrapped !== error) return classifyApiError(unwrapped);
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  const message = readMessage(error) ?? String(error ?? "");
  if (message === "Request was aborted.") return "aborted";
  if (message.includes(REPEATED_529_ERROR_MESSAGE)) return "server_overload";
  return classifyApiErrorLike({ status: readStatus(error), message });
}

export function categorizeRetryableAPIError(error: {
  readonly status?: number;
  readonly message?: string;
}): SDKAssistantMessageError {
  if (
    error.status === 529 ||
    error.message?.includes('"type":"overloaded_error"')
  ) {
    return "rate_limit";
  }
  if (error.status === 429) return "rate_limit";
  if (error.status === 401 || error.status === 403) {
    return "authentication_failed";
  }
  if (error.status !== undefined && error.status >= 408) return "server_error";
  return "unknown";
}

function classifyApiErrorLike(args: {
  readonly status?: number;
  readonly message: string;
}): AgenCApiErrorKind {
  const lower = args.message.toLowerCase();
  if (args.status === 429) return "rate_limit";
  if (args.status === 529 || lower.includes("overloaded_error")) {
    return "server_overload";
  }
  if (args.status === 401 || args.status === 403) return "auth_error";
  if (args.status === 408 || lower.includes("timeout")) return "api_timeout";
  if (
    args.status === 413 ||
    lower.includes("prompt is too long") ||
    lower.includes("context length") ||
    lower.includes("maximum context") ||
    lower.includes("input length") ||
    lower.includes("payload too large")
  ) {
    return lower.includes("prompt is too long")
      ? "prompt_too_long"
      : "context_overflow";
  }
  if (/maximum of \d+ pdf pages/i.test(args.message)) return "pdf_too_large";
  if (lower.includes("pdf specified is password protected")) {
    return "pdf_password_protected";
  }
  if (
    args.message.includes("image exceeds") ||
    args.message.includes("image dimensions exceed")
  ) {
    return "image_too_large";
  }
  if (
    lower.includes("`tool_use` ids were found without `tool_result`") ||
    lower.includes("unexpected `tool_use_id` found")
  ) {
    return "tool_use_mismatch";
  }
  if (lower.includes("econn") || lower.includes("socket")) {
    return "connection_error";
  }
  if (lower.includes("network") || lower.includes("fetch failed")) {
    return "network_error";
  }
  if (args.status !== undefined && args.status >= 500) return "server_error";
  if (args.status !== undefined && args.status >= 400) return "client_error";
  return "unknown";
}

function readMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return undefined;
}

function readStatus(error: unknown): number | undefined {
  const raw =
    error && typeof error === "object"
      ? (error as { status?: unknown; statusCode?: unknown }).status ??
        (error as { statusCode?: unknown }).statusCode
      : undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function unwrapCannotRetryError(error: unknown): unknown {
  if (
    error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "CannotRetryError" &&
    "originalError" in error
  ) {
    return (error as { originalError: unknown }).originalError;
  }
  return error;
}
