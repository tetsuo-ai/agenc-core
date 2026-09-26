/**
 * Session-tail caching.
 *
 * The dynamic tail of the system prompt (client rendering, memory
 * directories, environment) is assembled once per session, yet the xAI,
 * OpenAI Responses and Anthropic wires send it after the conversation on
 * every request, where it is never read from the prompt cache. With session
 * tail caching on, the request builder marks where the session-fixed part
 * ends and the per-request part (the permission section and per-turn
 * guidance) begins, and those wires move the session-fixed part right after
 * the static head, inside the cached prefix.
 *
 * It is on by default for Grok, where it was measured. OpenAI and Anthropic
 * use it with `AGENC_CACHE_SESSION_TAIL=1`; `AGENC_CACHE_SESSION_TAIL=0` turns
 * it off everywhere. The request builder reads the switch from the session's
 * environment, which a client sets per session (the key is in
 * AGENC_DAEMON_CLIENT_ENV_KEYS so it reaches daemon-owned sessions).
 *
 * @module
 */

import { SYSTEM_PROMPT_VOLATILE_BOUNDARY } from "../prompts/system-prompt-boundary.js";
import { isEnvDefinedFalsy, isEnvTruthy } from "../utils/envBoolean.js";

export const CACHE_SESSION_TAIL_ENV = "AGENC_CACHE_SESSION_TAIL";

/** Providers whose wire places the session-fixed tail after the static head. */
const SESSION_TAIL_PROVIDERS: ReadonlySet<string> = new Set(["grok", "openai", "anthropic"]);
/** Of those, the ones where it is on unless switched off (measured on Grok 4.6). */
const SESSION_TAIL_DEFAULT_PROVIDERS: ReadonlySet<string> = new Set(["grok"]);

export function sessionTailCacheEnabled(
  env: Readonly<Record<string, string | undefined>> | undefined,
  providerId: string | undefined,
): boolean {
  if (providerId === undefined) return false;
  const provider = providerId.trim().toLowerCase();
  if (!SESSION_TAIL_PROVIDERS.has(provider)) return false;
  const value = env?.[CACHE_SESSION_TAIL_ENV];
  if (isEnvDefinedFalsy(value)) return false;
  return isEnvTruthy(value) || SESSION_TAIL_DEFAULT_PROVIDERS.has(provider);
}

/**
 * Append per-request instructions after the volatile marker. The marker is
 * added once: when `stable` already ends its session-fixed part with one
 * (per-turn guidance was placed there), the parts follow it directly.
 */
export function appendVolatileInstructions(
  stable: string,
  volatileParts: readonly string[],
): string {
  const parts = volatileParts.map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return stable;
  const head = stable.trim();
  return head.includes(SYSTEM_PROMPT_VOLATILE_BOUNDARY)
    ? [head, ...parts].join("\n\n")
    : [head, SYSTEM_PROMPT_VOLATILE_BOUNDARY, ...parts].filter((part) => part.length > 0).join("\n\n");
}
