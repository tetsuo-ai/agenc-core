import { resolveRegisteredModelCatalogEntry } from "./registry/model-catalog.js";

export type LightVerbosity = "low" | "medium" | "high";

/**
 * GPT-6 family model ids on OpenAI (platform API and the ChatGPT backend):
 * gpt-6-luna, gpt-6-sol, gpt-6.1-terra, gpt-6.1-sol and later 6.x variants.
 */
const GPT6_FAMILY = /^gpt-6(?:\.\d+)?-[a-z0-9.-]+$/u;

export interface LightVerbositySession {
  readonly services?: {
    readonly runtimeOptions?: { readonly lightMode?: boolean; readonly simpleMode?: boolean };
  };
}

/**
 * The response detail a Light session sends when the user set none.
 *
 * Light sessions on the GPT-6 family ask for short answers through the native
 * `text.verbosity` field. The 2026-11-14 head-to-head on gpt-6.1-terra and
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
  if (!GPT6_FAMILY.test(id)) return undefined;
  const entry = resolveRegisteredModelCatalogEntry({ provider: "openai", model: id });
  if (entry === undefined || entry.model.toLowerCase() !== id || entry.supportsVerbosity !== true) {
    return undefined;
  }
  return "low";
}
