import type { AgenCConfig } from '../../config/schema.js'
import {
  providerModelCatalogIdentifiers,
  resolveBuiltInProviderSlug,
} from '../../llm/registry/provider-info.js'
import { isModelAlias, isModelFamilyAlias } from './aliases.js'
import {
  resolveConfiguredModelOverride,
  resolveProviderModelAlias,
} from './configs.js'

export type ModelAllowlistPolicy = Pick<
  AgenCConfig,
  'availableModels' | 'modelOverrides'
>

export class ModelNotAllowedError extends Error {
  readonly model: string

  constructor(model: string) {
    super(`model '${model}' is not allowed by managed availableModels policy`)
    this.name = 'ModelNotAllowedError'
    this.model = model
  }
}

export function resolveAllowedModelProjection(
  provider: string | undefined,
  projectedModel: string,
  policy: ModelAllowlistPolicy,
  fallbackModel?: string,
): string {
  if (isModelAllowed(provider, projectedModel, policy)) {
    return projectedModel
  }
  if (
    fallbackModel !== undefined &&
    fallbackModel !== projectedModel &&
    isModelAllowed(provider, fallbackModel, policy)
  ) {
    return fallbackModel
  }
  throw new ModelNotAllowedError(projectedModel)
}

/**
 * Check if a model belongs to a given family by checking if its name
 * (or resolved name) contains the family identifier.
 */
function modelBelongsToFamily(
  provider: string,
  model: string,
  family: string,
): boolean {
  if (model.includes(family)) {
    return true
  }
  // Resolve aliases like "best" → "claude-opus-4-6" to check family membership
  if (isModelAlias(model)) {
    const resolved = resolveProviderModelAlias(provider, model).toLowerCase()
    return resolved.includes(family)
  }
  return false
}

/**
 * Check if a model name starts with a prefix at a segment boundary.
 * The prefix must match up to the end of the name or a "-" separator.
 * e.g. "claude-opus-4-5" matches "claude-opus-4-5-20251101" but not "claude-opus-4-50".
 */
function prefixMatchesModel(modelName: string, prefix: string): boolean {
  if (!modelName.startsWith(prefix)) {
    return false
  }
  return modelName.length === prefix.length || modelName[prefix.length] === '-'
}

/**
 * Check if a model matches a version-prefix entry in the allowlist.
 * Supports shorthand like "opus-4-5" (mapped to "claude-opus-4-5") and
 * full prefixes like "claude-opus-4-5". Resolves input aliases before matching.
 */
function modelMatchesVersionPrefix(
  provider: string,
  model: string,
  entry: string,
): boolean {
  if (!/^(?:claude-)?(?:opus|sonnet|haiku)-\d/u.test(entry)) {
    return false
  }
  // Resolve the input model to a full name if it's an alias
  const resolvedModel = isModelAlias(model)
    ? resolveProviderModelAlias(provider, model).toLowerCase()
    : model

  // Try the entry as-is (e.g. "claude-opus-4-5")
  if (prefixMatchesModel(resolvedModel, entry)) {
    return true
  }
  // Try with "claude-" prefix (e.g. "opus-4-5" → "claude-opus-4-5")
  if (
    !entry.startsWith('claude-') &&
    prefixMatchesModel(resolvedModel, `claude-${entry}`)
  ) {
    return true
  }
  return false
}

/**
 * Check if a family alias is narrowed by more specific entries in the allowlist.
 * When the allowlist contains both "opus" and "opus-4-5", the specific entry
 * takes precedence — "opus" alone would be a wildcard, but "opus-4-5" narrows
 * it to only that version.
 */
function familyHasSpecificEntries(
  family: string,
  allowlist: string[],
): boolean {
  for (const entry of allowlist) {
    if (isModelFamilyAlias(entry)) {
      continue
    }
    // Check if entry is a version-qualified variant of this family
    // e.g., "opus-4-5" or "claude-opus-4-5-20251101" for the "opus" family
    // Must match at a segment boundary (followed by '-' or end) to avoid
    // false positives from unrelated identifiers containing the family name
    const idx = entry.indexOf(family)
    if (idx === -1) {
      continue
    }
    const afterFamily = idx + family.length
    if (afterFamily === entry.length || entry[afterFamily] === '-') {
      return true
    }
  }
  return false
}

/**
 * Check if a model is allowed by the final canonical managed policy.
 * If availableModels is not set, all models are allowed.
 *
 * Matching tiers:
 * 1. Family aliases ("opus", "sonnet", "haiku") — wildcard for the entire family,
 *    UNLESS more specific entries for that family also exist (e.g., "opus-4-5").
 *    In that case, the family wildcard is ignored and only the specific entries apply.
 * 2. Version prefixes ("opus-4-5", "claude-opus-4-5") — any build of that version
 * 3. Full model IDs ("claude-opus-4-5-20251101") — exact match only
 */
export function isModelAllowed(
  provider: string | undefined,
  model: string,
  policy: ModelAllowlistPolicy,
): boolean {
  const availableModels = policy.availableModels
  if (!availableModels) {
    return true // No restrictions
  }
  if (availableModels.length === 0) {
    return false // Empty allowlist blocks all user-specified models
  }

  const normalizedAllowlist = availableModels.map(m => m.trim().toLowerCase())
  const providerSlug = resolveBuiltInProviderSlug(provider)
  const identifiers = providerSlug === undefined
    ? [model]
    : providerModelCatalogIdentifiers(providerSlug, model)
  const normalizedModels = [...new Set(identifiers)].map(
    candidate =>
      resolveConfiguredModelOverride(candidate, policy.modelOverrides)
        .trim()
        .toLowerCase(),
  )

  const providerIdentity = providerSlug ?? provider ?? 'openai'
  return normalizedModels.some(normalizedModel =>
    normalizedModelAllowed(
      providerIdentity,
      normalizedModel,
      normalizedAllowlist,
    )
  )
}

function normalizedModelAllowed(
  provider: string,
  normalizedModel: string,
  normalizedAllowlist: string[],
): boolean {

  // Direct match (alias-to-alias or full-name-to-full-name)
  // Skip family aliases that have been narrowed by specific entries —
  // e.g., "opus" in ["opus", "opus-4-5"] should NOT directly match,
  // because the admin intends to restrict to opus 4.5 only.
  if (normalizedAllowlist.includes(normalizedModel)) {
    if (
      !isModelFamilyAlias(normalizedModel) ||
      !familyHasSpecificEntries(normalizedModel, normalizedAllowlist)
    ) {
      return true
    }
  }

  // Family-level aliases in the allowlist match any model in that family,
  // but only if no more specific entries exist for that family.
  // e.g., ["opus"] allows all opus, but ["opus", "opus-4-5"] only allows opus 4.5.
  for (const entry of normalizedAllowlist) {
    if (
      isModelFamilyAlias(entry) &&
      !familyHasSpecificEntries(entry, normalizedAllowlist) &&
      modelBelongsToFamily(provider, normalizedModel, entry)
    ) {
      return true
    }
  }

  // For non-family entries, do bidirectional alias resolution
  // If model is an alias, resolve it and check if the resolved name is in the list
  if (isModelAlias(normalizedModel)) {
    const resolved = resolveProviderModelAlias(
      provider,
      normalizedModel,
    ).toLowerCase()
    if (normalizedAllowlist.includes(resolved)) {
      return true
    }
  }

  // If any non-family alias in the allowlist resolves to the input model
  for (const entry of normalizedAllowlist) {
    if (!isModelFamilyAlias(entry) && isModelAlias(entry)) {
      const resolved = resolveProviderModelAlias(provider, entry).toLowerCase()
      if (resolved === normalizedModel) {
        return true
      }
    }
  }

  // Version-prefix matching: "opus-4-5" or "claude-opus-4-5" matches
  // "claude-opus-4-5-20251101" at a segment boundary
  for (const entry of normalizedAllowlist) {
    if (!isModelFamilyAlias(entry) && !isModelAlias(entry)) {
      if (modelMatchesVersionPrefix(provider, normalizedModel, entry)) {
        return true
      }
    }
  }

  return false
}
