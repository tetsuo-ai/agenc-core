/**
 * Local _deps stub for the gut/AgenC crossing of `../types/errors.js`.
 * `errors.ts` only needs the `RuntimeError` base class and the `RuntimeErrorCodes`
 * subset for LLM/chat-budget conditions.
 */

export const RuntimeErrorCodes = {
  LLM_PROVIDER_ERROR: "LLM_PROVIDER_ERROR",
  LLM_RATE_LIMIT: "LLM_RATE_LIMIT",
  LLM_RESPONSE_CONVERSION: "LLM_RESPONSE_CONVERSION",
  LLM_TOOL_CALL_ERROR: "LLM_TOOL_CALL_ERROR",
  LLM_TIMEOUT: "LLM_TIMEOUT",
  CHAT_BUDGET_EXCEEDED: "CHAT_BUDGET_EXCEEDED",
} as const;

export type RuntimeErrorCode =
  (typeof RuntimeErrorCodes)[keyof typeof RuntimeErrorCodes];

export class RuntimeError extends Error {
  public readonly code: RuntimeErrorCode;

  constructor(message: string, code: RuntimeErrorCode) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}
