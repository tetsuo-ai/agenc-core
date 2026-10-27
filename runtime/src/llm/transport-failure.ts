import { LLMInvalidResponseError, LLMServerError, LLMStreamTruncatedError, LLMTimeoutError } from "./errors.js";

import type { TransportFailure } from "../contracts/turn-terminal.js";
export type { TransportFailure } from "../contracts/turn-terminal.js";

export function transportFailureOf(error: unknown): TransportFailure | undefined {
  const seen = new Set<object>();
  for (let depth = 0; depth < 12 && error !== null && typeof error === "object"; depth++) {
    if (seen.has(error)) break;
    seen.add(error);
    // A malformed response is not an upstream transport failure, even when
    // the adapter assigns it a synthetic 502 status.
    if (error instanceof LLMInvalidResponseError) return undefined;
    if (error instanceof LLMStreamTruncatedError) return { category: "stream_truncated" };
    if (error instanceof LLMTimeoutError) return { category: "timeout" };
    const value = error as { status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
    const status = value.statusCode ?? value.status;
    if (error instanceof LLMServerError || (typeof status === "number" && status >= 500 && status <= 599)) {
      return { category: "http_5xx", ...(typeof status === "number" ? { status } : {}) };
    }
    if (typeof value.code === "string" && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(value.code)) {
      return { category: "connection_lost" };
    }
    if (value.code === "ETIMEDOUT") return { category: "timeout" };
    error = value.cause;
  }
  return undefined;
}
