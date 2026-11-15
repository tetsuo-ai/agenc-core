import { resolveGeminiThinkingModel } from "../../registry/gemini-thinking-models.js";
import { canonicalGeminiModelName } from "./endpoint-plan.js";
import { REASONING_SILENCE_LIMIT_MS, transportSilenceFetch } from "../../transport-silence.js";

/** Google asks a Gemini 4 client to wait at least this long for a response. */
export const GEMINI_4_SILENCE_LIMIT_MS = REASONING_SILENCE_LIMIT_MS;

/**
 * The Gemini 4 models, by exact id. Hydrogen (released 2026-11-12, default
 * thinking level high, also takes xhigh) is named here so it has the wait
 * whether or not the model registry lists it yet.
 */
const GEMINI_4_SILENT_MODELS: ReadonlySet<string> = new Set([
  "gemini-4-argon",
  "gemini-4-carbon",
  "gemini-4-hydrogen",
]);

/** Other Gemini models keep the original fetch and every option unchanged. */
export function geminiTransportFetch(
  model: string,
  fetchImpl?: typeof fetch,
): typeof fetch | undefined {
  const id = resolveGeminiThinkingModel(model)?.model ?? canonicalGeminiModelName(model).trim().toLowerCase();
  if (!GEMINI_4_SILENT_MODELS.has(id)) return fetchImpl;
  return transportSilenceFetch(fetchImpl);
}
