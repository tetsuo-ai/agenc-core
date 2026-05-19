import { APIUserAbortError } from "@anthropic-ai/sdk";

export class AgenCError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AbortError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof AbortError ||
    error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function hasExactErrorMessage(
  error: unknown,
  message: string,
): boolean {
  return error instanceof Error && error.message === message;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function getErrnoCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

export function getErrnoPath(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "path" in error &&
    typeof error.path === "string"
  ) {
    return error.path;
  }
  return undefined;
}

export function shortErrorStack(error: unknown, maxFrames = 5): string {
  if (!(error instanceof Error)) return String(error);
  if (!error.stack) return error.message;

  const lines = error.stack.split("\n");
  const header = lines[0] ?? error.message;
  const frames = lines.slice(1).filter((line) => line.trim().startsWith("at "));
  if (frames.length <= maxFrames) return error.stack;
  return [header, ...frames.slice(0, maxFrames)].join("\n");
}

export function isFsInaccessible(
  error: unknown,
): error is NodeJS.ErrnoException {
  const code = getErrnoCode(error);
  return (
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ENOTDIR" ||
    code === "ELOOP"
  );
}

export type AxiosErrorKind =
  | "auth"
  | "timeout"
  | "network"
  | "http"
  | "other";

export class SDKError extends AgenCError {
  constructor(message: string) {
    super(message);
    this.name = "SDKError";
  }
}

export class SDKAuthenticationError extends SDKError {
  constructor(message?: string) {
    super(message ?? "Authentication failed");
    this.name = "SDKAuthenticationError";
  }
}

export class SDKBillingError extends SDKError {
  constructor(message?: string) {
    super(message ?? "Billing error - check subscription");
    this.name = "SDKBillingError";
  }
}

export class SDKRateLimitError extends SDKError {
  constructor(
    message?: string,
    readonly resetsAt?: number,
    readonly rateLimitType?: string,
  ) {
    super(message ?? "Rate limit exceeded");
    this.name = "SDKRateLimitError";
  }
}

export class SDKInvalidRequestError extends SDKError {
  constructor(message?: string) {
    super(message ?? "Invalid request");
    this.name = "SDKInvalidRequestError";
  }
}

export class SDKServerError extends SDKError {
  constructor(message?: string) {
    super(message ?? "Server error");
    this.name = "SDKServerError";
  }
}

export class SDKMaxOutputTokensError extends SDKError {
  constructor(message?: string) {
    super(message ?? "Max output tokens reached");
    this.name = "SDKMaxOutputTokensError";
  }
}

export type SDKAssistantMessageError =
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

export function sdkErrorFromType(
  errorType: SDKAssistantMessageError,
  message?: string,
): SDKError | AgenCError {
  switch (errorType) {
    case "authentication_failed":
      return new SDKAuthenticationError(message);
    case "billing_error":
      return new SDKBillingError(message);
    case "rate_limit":
      return new SDKRateLimitError(message);
    case "invalid_request":
      return new SDKInvalidRequestError(message);
    case "server_error":
      return new SDKServerError(message);
    case "max_output_tokens":
      return new SDKMaxOutputTokensError(message);
    default:
      return new AgenCError(message ?? "Unknown error");
  }
}

export function classifyAxiosError(error: unknown): {
  readonly kind: AxiosErrorKind;
  readonly status?: number;
  readonly message: string;
} {
  const message = errorMessage(error);
  if (
    !error ||
    typeof error !== "object" ||
    !("isAxiosError" in error) ||
    !error.isAxiosError
  ) {
    return { kind: "other", message };
  }

  const err = error as {
    response?: { status?: number };
    code?: string;
  };
  const status = err.response?.status;
  if (status === 401 || status === 403) return { kind: "auth", status, message };
  if (err.code === "ECONNABORTED") return { kind: "timeout", status, message };
  if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
    return { kind: "network", status, message };
  }
  return { kind: "http", status, message };
}
