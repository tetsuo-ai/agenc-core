/**
 * Local _deps stub for the gut/openclaude crossing of
 * `../../../services/api/openaiErrorClassification.js`. The OpenAI
 * provider adapter only consumes `classifyOpenAIHttpFailure` and
 * `buildOpenAICompatibilityErrorMessage`, so this stub exposes a
 * compact equivalent.
 */

export type OpenAICompatibilityFailureCategory =
  | "connection_refused"
  | "localhost_resolution_failed"
  | "request_timeout"
  | "network_error"
  | "auth_invalid"
  | "rate_limited"
  | "model_not_found"
  | "endpoint_not_found"
  | "context_overflow"
  | "tool_call_incompatible"
  | "malformed_provider_response"
  | "provider_unavailable"
  | "unknown";

export interface OpenAICompatibilityFailure {
  source: "network" | "http";
  category: OpenAICompatibilityFailureCategory;
  retryable: boolean;
  message: string;
  hint?: string;
  code?: string;
  status?: number;
}

const OPENAI_CATEGORY_MARKER_PREFIX = "[openai_category=";

function isContextOverflowMessage(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("too many tokens") ||
    lower.includes("request too large") ||
    lower.includes("context length") ||
    lower.includes("maximum context") ||
    lower.includes("input length") ||
    lower.includes("payload too large") ||
    lower.includes("prompt is too long")
  );
}

function isToolCompatibilityMessage(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("tool_calls") ||
    lower.includes("tool_call") ||
    lower.includes("tool_use") ||
    lower.includes("tool_result") ||
    lower.includes("function calling") ||
    lower.includes("function call")
  );
}

function isMalformedProviderResponse(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("<!doctype html") ||
    lower.includes("<html") ||
    lower.includes("invalid json") ||
    lower.includes("malformed") ||
    lower.includes("unexpected token") ||
    lower.includes("cannot parse") ||
    lower.includes("not valid json")
  );
}

function isModelNotFoundMessage(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("model") &&
    (lower.includes("not found") ||
      lower.includes("does not exist") ||
      lower.includes("unknown model") ||
      lower.includes("unavailable model"))
  );
}

export function formatOpenAICategoryMarker(
  category: OpenAICompatibilityFailureCategory,
): string {
  return `${OPENAI_CATEGORY_MARKER_PREFIX}${category}]`;
}

export function buildOpenAICompatibilityErrorMessage(
  baseMessage: string,
  failure: Pick<OpenAICompatibilityFailure, "category" | "hint">,
): string {
  const marker = formatOpenAICategoryMarker(failure.category);
  const hint = failure.hint ? ` Hint: ${failure.hint}` : "";
  return `${baseMessage} ${marker}${hint}`;
}

export function classifyOpenAIHttpFailure(options: {
  status: number;
  body: string;
}): OpenAICompatibilityFailure {
  const body = options.body ?? "";

  if (options.status === 401 || options.status === 403) {
    return {
      source: "http",
      category: "auth_invalid",
      retryable: false,
      status: options.status,
      message: body,
      code:
        options.status === 401
          ? "auth_invalid_api_key"
          : "auth_forbidden_org_project",
      hint:
        options.status === 401
          ? "Authentication failed. Verify the API key or OAuth token source for this provider."
          : "Request was forbidden. Verify OpenAI organization/project headers and that the account can access this model.",
    };
  }

  if (options.status === 429) {
    return {
      source: "http",
      category: "rate_limited",
      retryable: true,
      status: options.status,
      message: body,
      hint: "Provider rate-limited the request. Retry after backoff.",
    };
  }

  if (options.status === 404 && isModelNotFoundMessage(body)) {
    return {
      source: "http",
      category: "model_not_found",
      retryable: false,
      status: options.status,
      message: body,
      hint: "The selected model is not installed or not available on this endpoint.",
    };
  }

  if (options.status === 404) {
    return {
      source: "http",
      category: "endpoint_not_found",
      retryable: false,
      status: options.status,
      message: body,
      hint: "Endpoint was not found. Confirm OPENAI_BASE_URL includes /v1 for OpenAI-compatible local providers.",
    };
  }

  if (
    options.status === 413 ||
    ((options.status === 400 || options.status >= 500) &&
      isContextOverflowMessage(body))
  ) {
    return {
      source: "http",
      category: "context_overflow",
      retryable: false,
      status: options.status,
      message: body,
      hint: "Prompt context exceeded model/server limits. Reduce context or increase provider context length.",
    };
  }

  if (options.status === 400 && isToolCompatibilityMessage(body)) {
    return {
      source: "http",
      category: "tool_call_incompatible",
      retryable: false,
      status: options.status,
      message: body,
      hint: "Provider/model rejected tool-calling payload. Retry without tools or use a tool-capable model.",
    };
  }

  if (
    (options.status >= 200 &&
      options.status < 300 &&
      isMalformedProviderResponse(body)) ||
    (options.status >= 400 && isMalformedProviderResponse(body))
  ) {
    return {
      source: "http",
      category: "malformed_provider_response",
      retryable: false,
      status: options.status,
      message: body,
      hint: "Provider returned malformed or non-JSON response where JSON was expected.",
    };
  }

  if (options.status >= 500) {
    return {
      source: "http",
      category: "provider_unavailable",
      retryable: true,
      status: options.status,
      message: body,
      hint: "Provider reported a server-side failure. Retry after a short delay.",
    };
  }

  return {
    source: "http",
    category: "unknown",
    retryable: false,
    status: options.status,
    message: body,
  };
}
