import type { LightVerbositySession } from "./openai-light-verbosity.js";

/**
 * Whether a session's main-loop calls are marked as a Light session's for the
 * `openai` provider, which then sends them over one WebSocket per session
 * unless `[providers.openai] transport` or `AGENC_OPENAI_TRANSPORT` says
 * otherwise. Measured on the platform API (gpt-6-luna) and on the ChatGPT
 * backend (gpt-6.1-terra, gpt-6.1-sol) on 2026-11-15: the wait for the first
 * event of a call fell from 0.38 to 0.11 s and from 0.81 to 0.39 s. No other
 * provider is ever marked, so their requests and options do not change.
 */
export function lightSessionUsesOpenAiSocket(
  session: LightVerbositySession,
  provider: string | undefined,
): boolean {
  const runtime = session.services?.runtimeOptions;
  return provider === "openai" && runtime?.lightMode === true && runtime.simpleMode !== true;
}
