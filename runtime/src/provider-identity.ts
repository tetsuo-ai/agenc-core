/**
 * Canonical provider identity authority.
 *
 * Runtime selection accepts canonical slugs only. Retired spellings are
 * translated exclusively by the explicit config-v1 migration path; every live
 * ingress receives an actionable error instead of a compatibility alias.
 */

export const RETIRED_PROVIDER_SELECTOR_REPLACEMENTS = Object.freeze({
  xai: "grok",
  custom: "openai-compatible",
  openai_compatible: "openai-compatible",
} as const);

export type RetiredProviderSelector =
  keyof typeof RETIRED_PROVIDER_SELECTOR_REPLACEMENTS;

export class RetiredProviderSelectorError extends Error {
  readonly selector: RetiredProviderSelector;
  readonly replacement: string;

  constructor(
    selector: RetiredProviderSelector,
    replacement: string,
    boundary = "provider selection",
  ) {
    super(
      `retired provider selector "${selector}" is not accepted at ${boundary}; ` +
        `use "${replacement}" instead`,
    );
    this.name = "RetiredProviderSelectorError";
    this.selector = selector;
    this.replacement = replacement;
  }
}

function normalizedProviderText(
  provider: string | undefined,
): string | undefined {
  const normalized = provider?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalize provider labels carried only as historical/upstream metadata.
 * Never use this function for provider selection.
 */
export function normalizeProviderMetadataIdentity(
  provider: string | undefined,
): string | undefined {
  const normalized = normalizedProviderText(provider);
  // Upstream catalogs and historical events use both company/API spellings.
  // This is metadata compatibility only; live selectors go through the strict
  // normalizeProviderIdentity boundary below and reject `xai`.
  return normalized === "xai" || normalized === "x-ai" ? "grok" : normalized;
}

/**
 * Normalize a live provider identity without aliasing it.
 *
 * Arbitrary configured slugs remain valid identities; only the three retired
 * selector spellings are rejected. Built-in membership is resolved by the
 * provider registry, not by this neutral module.
 */
export function normalizeProviderIdentity(
  provider: string | undefined,
  boundary = "provider selection",
): string | undefined {
  const normalized = normalizedProviderText(provider);
  if (normalized === undefined) return undefined;
  if (Object.hasOwn(RETIRED_PROVIDER_SELECTOR_REPLACEMENTS, normalized)) {
    const selector = normalized as RetiredProviderSelector;
    throw new RetiredProviderSelectorError(
      selector,
      RETIRED_PROVIDER_SELECTOR_REPLACEMENTS[selector],
      boundary,
    );
  }
  return normalized;
}

/** Explicit-migration-only translation for retired provider selectors. */
export function migrateRetiredProviderSelector(
  provider: string | undefined,
): string | undefined {
  const normalized = normalizedProviderText(provider);
  if (normalized === undefined) return undefined;
  return Object.hasOwn(RETIRED_PROVIDER_SELECTOR_REPLACEMENTS, normalized)
    ? RETIRED_PROVIDER_SELECTOR_REPLACEMENTS[
        normalized as RetiredProviderSelector
      ]
    : normalized;
}

export function isRetiredProviderSelector(
  provider: string | undefined,
): provider is RetiredProviderSelector {
  const normalized = normalizedProviderText(provider);
  return normalized !== undefined &&
    Object.hasOwn(RETIRED_PROVIDER_SELECTOR_REPLACEMENTS, normalized);
}
