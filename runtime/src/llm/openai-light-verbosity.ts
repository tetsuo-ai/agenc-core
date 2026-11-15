import { resolveRegisteredModelCatalogEntry } from "./registry/model-catalog.js";

export type LightVerbosity = "low" | "medium" | "high";

/**
 * The OpenAI models whose Light sessions default to low verbosity: the two the
 * 2026-11-14 head-to-head measured (platform API and the ChatGPT backend).
 * gpt-6-luna is not one of them: in the 0.19.34 release race (rc34) and its
 * A/B (rd34) low verbosity made Luna Light slower and saved no tokens.
 */
const LOW_VERBOSITY_MODELS: ReadonlySet<string> = new Set(["gpt-6.1-terra", "gpt-6.1-sol"]);

export interface LightVerbositySession {
  readonly services?: {
    readonly runtimeOptions?: { readonly lightMode?: boolean; readonly simpleMode?: boolean };
  };
}

/**
 * The response detail a Light session sends when the user set none.
 *
 * Light sessions on gpt-6.1-terra and gpt-6.1-sol ask for short answers through
 * the native `text.verbosity` field. The 2026-11-14 head-to-head on gpt-6.1-terra and
 * gpt-6.1-sol showed AgenC writing 31 to 44% more output tokens than a harness
 * that sends `text.verbosity: "low"`, and being 14 to 23% slower. The field
 * sits outside `instructions` and `input`, so it never changes the cached
 * prefix. A configured `model_verbosity` always wins; `medium` restores the
 * API default. Only models whose catalog entry supports native verbosity get
 * the default, so no request gains a fallback prompt section from it.
 */
export function defaultLightModelVerbosity(
  session: LightVerbositySession,
  provider: string | undefined,
  model: string | undefined,
): LightVerbosity | undefined {
  const runtime = session.services?.runtimeOptions;
  if (runtime?.lightMode !== true || runtime.simpleMode === true) return undefined;
  if (provider !== "openai" || model === undefined) return undefined;
  const id = model.trim().toLowerCase();
  if (!LOW_VERBOSITY_MODELS.has(id)) return undefined;
  const entry = resolveRegisteredModelCatalogEntry({ provider: "openai", model: id });
  if (entry === undefined || entry.model.toLowerCase() !== id || entry.supportsVerbosity !== true) {
    return undefined;
  }
  return "low";
}
