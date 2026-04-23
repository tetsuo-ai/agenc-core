/**
 * Error helpers for the OpenAI/Anthropic API surface compact recovery
 * uses. Re-exports the gut equivalents from
 * `runtime/src/recovery/api-errors.ts` plus the upstream-named helpers
 * compact code expects.
 */

export {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isPromptTooLongMessage,
  isWithheld413Message,
} from "../../../recovery/api-errors.js";

const API_ERROR_PREFIXES = [
  "API Error",
  "OpenAI API error",
  "Anthropic API error",
  "Provider error",
];

export function startsWithApiErrorPrefix(message: string): boolean {
  if (typeof message !== "string") return false;
  return API_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

const PROMPT_TOO_LONG_TOKEN_RE =
  /(\d+)\s*tokens?[^\d]*(?:exceeds|over|above)[^\d]*(\d+)/i;

export function getPromptTooLongTokenGap(message: string): number {
  if (typeof message !== "string") return 0;
  const match = PROMPT_TOO_LONG_TOKEN_RE.exec(message);
  if (!match || !match[1] || !match[2]) return 0;
  const actual = Number.parseInt(match[1], 10);
  const limit = Number.parseInt(match[2], 10);
  if (!Number.isFinite(actual) || !Number.isFinite(limit)) return 0;
  return Math.max(0, actual - limit);
}
