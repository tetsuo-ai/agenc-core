import {
  getModelStrings as getModelStringsState,
  setModelStrings as setModelStringsState,
} from '../../bootstrap/state.js'
import { getExecutionAuthoritySettings } from '../settings/settings.js'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  modelConfigIdForProvider,
  resolveConfiguredModelOverride,
  type CanonicalModelId,
  type ModelKey,
} from './configs.js'
import { getAPIProvider } from './providers.js'

/**
 * Maps each model version to its provider-specific model ID string.
 * Derived from ALL_MODEL_CONFIGS — adding a model there extends this type.
 */
export type ModelStrings = Record<ModelKey, string>

const MODEL_KEYS = Object.keys(ALL_MODEL_CONFIGS) as ModelKey[]

function getBuiltinModelStrings(provider: string): ModelStrings {
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    out[key] = modelConfigIdForProvider(provider, key)
  }
  return out
}

/**
 * Layer user-configured modelOverrides (from config.toml) on top of the
 * provider-derived model strings. Overrides are keyed by canonical first-party
 * model ID (e.g. "claude-opus-4-6") and map to arbitrary provider-specific
 * strings — typically Bedrock inference profile ARNs.
 */
function applyModelOverrides(ms: ModelStrings): ModelStrings {
  const overrides = getExecutionAuthoritySettings().modelOverrides
  if (!overrides) {
    return ms
  }
  const out = { ...ms }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    const key = CANONICAL_ID_TO_KEY[canonicalId as CanonicalModelId]
    if (key && override) {
      out[key] = override
    }
  }
  return out
}

/**
 * Resolve an overridden model ID (e.g. a Bedrock ARN) back to its canonical
 * first-party model ID. If the input doesn't match any current override value,
 * it is returned unchanged. Safe to call during module init (no-ops if settings
 * aren't loaded yet).
 */
export function resolveOverriddenModel(modelId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getExecutionAuthoritySettings().modelOverrides
  } catch {
    return modelId
  }
  return resolveConfiguredModelOverride(modelId, overrides)
}

export function getModelStrings(): ModelStrings {
  let ms = getModelStringsState() as ModelStrings | null
  if (ms === null) {
    ms = getBuiltinModelStrings(getAPIProvider())
    setModelStringsState(ms)
  }
  return applyModelOverrides(ms)
}
