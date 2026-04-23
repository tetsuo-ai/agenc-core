/**
 * Local _deps stub for the gut/openclaude crossing of
 * `../gateway/model-route.js`. Only `canonicalizeProviderModel` is
 * consumed by the LLM subsystem (xai-strict-filter), so we keep this
 * stub trimmed to that surface.
 */

import { normalizeGrokModel } from "./context-window.js";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function canonicalizeProviderModel(
  provider: unknown,
  model: unknown,
): string | undefined {
  const normalizedModel = normalizeText(model);
  if (!normalizedModel) return undefined;
  const normalizedProvider = normalizeText(provider)?.toLowerCase();
  if (normalizedProvider === "grok") {
    return normalizeGrokModel(normalizedModel) ?? normalizedModel;
  }
  return normalizedModel;
}
