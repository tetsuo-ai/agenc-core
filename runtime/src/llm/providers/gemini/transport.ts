import { resolveGeminiThinkingModel } from "../../registry/gemini-thinking-models.js";
import { REASONING_SILENCE_LIMIT_MS, transportSilenceFetch } from "../../transport-silence.js";

/** Google asks a Gemini 4 client to wait at least this long for a response. */
export const GEMINI_4_SILENCE_LIMIT_MS = REASONING_SILENCE_LIMIT_MS;

/** Other Gemini models keep the original fetch and every option unchanged. */
export function geminiTransportFetch(
  model: string,
  fetchImpl?: typeof fetch,
): typeof fetch | undefined {
  const registered = resolveGeminiThinkingModel(model)?.model;
  if (registered !== "gemini-4-argon" && registered !== "gemini-4-carbon") return fetchImpl;
  return transportSilenceFetch(fetchImpl);
}
