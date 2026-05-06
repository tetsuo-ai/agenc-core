// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
// @ts-expect-error -- temporary boundary: moved utility depends on not-yet-absorbed subsystem types.
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
// @ts-expect-error -- temporary boundary: moved utility depends on not-yet-absorbed subsystem types.
} from '../../services/analytics/index.js'
import {
  type AgenCCodeHint,
  hasShownHintThisSession,
  setPendingHint,
} from '../../errors/hints.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isPluginInstalled } from './installedPluginsManager.js'
import { getPluginById } from './marketplaceManager.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from './pluginIdentifier.js'
import { isPluginBlockedByPolicy } from './pluginPolicy.js'

type HintRecommendationState = { plugin?: string[]; disabled?: boolean }
type HintConfigShape = {
  // @ts-expect-error -- temporary boundary: moved utility depends on not-yet-absorbed subsystem types.
  agencCodeHints?: HintRecommendationState
  // @ts-expect-error -- temporary boundary: moved utility depends on not-yet-absorbed subsystem types.
  agencCodeHints?: HintRecommendationState // branding-scan: allow persisted legacy config key
}
const readHintState = (
  config: HintConfigShape,
): HintRecommendationState | undefined =>
  config.agencCodeHints ?? config.agencCodeHints // branding-scan: allow persisted legacy config key

/**
 * Hard cap on `agencCodeHints.plugin[]` — bounds config growth. Each shown
 * plugin appends one slug; past this point we stop prompting (and stop
 * appending) rather than let the config grow without limit.
 */
const MAX_SHOWN_PLUGINS = 100

export type PluginHintRecommendation = {
  pluginId: string
  pluginName: string
  marketplaceName: string
  pluginDescription?: string
  sourceCommand: string
}

/**
 * Pre-store gate called by shell tools when a `type="plugin"` hint is detected.
 * Drops the hint if:
 *
 *  - a dialog has already been shown this session
 *  - user has disabled hints
 *  - the shown-plugins list has hit the config-growth cap
 *  - plugin slug doesn't parse as `name@marketplace`
 *  - marketplace isn't official (hardcoded for v1)
 *  - plugin is already installed
 *  - plugin was already shown in a prior session
 *
 * Synchronous on purpose — shell tools shouldn't await a marketplace lookup
 * just to strip a stderr line. The async marketplace-cache check happens
 * later in resolvePluginHint (hook side).
 */
export function maybeRecordPluginHint(hint: AgenCCodeHint): void {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_lapis_finch', false)) return
  if (hasShownHintThisSession()) return

  const state = readHintState(getGlobalConfig() as HintConfigShape)
  if (state?.disabled) return

  const shown = state?.plugin ?? []
  if (shown.length >= MAX_SHOWN_PLUGINS) return

  const pluginId = hint.value
  const { name, marketplace } = parsePluginIdentifier(pluginId)
  if (!name || !marketplace) return
  if (!isOfficialMarketplaceName(marketplace)) return
  if (shown.includes(pluginId)) return
  if (isPluginInstalled(pluginId)) return
  if (isPluginBlockedByPolicy(pluginId)) return

  // Bound repeat lookups on the same slug — a CLI that emits on every
  // invocation shouldn't trigger N resolve cycles for the same plugin.
  if (triedThisSession.has(pluginId)) return
  triedThisSession.add(pluginId)

  setPendingHint(hint)
}

const triedThisSession = new Set<string>()

/** Test-only reset. */
export function _resetHintRecommendationForTesting(): void {
  triedThisSession.clear()
}

/**
 * Resolve the pending hint to a renderable recommendation. Runs the async
 * marketplace lookup that the sync pre-store gate skipped. Returns null if
 * the plugin isn't in the marketplace cache — the hint is discarded.
 */
export async function resolvePluginHint(
  hint: AgenCCodeHint,
): Promise<PluginHintRecommendation | null> {
  const pluginId = hint.value
  const { name, marketplace } = parsePluginIdentifier(pluginId)

  const pluginData = await getPluginById(pluginId)

  logEvent('tengu_plugin_hint_detected', {
    _PROTO_plugin_name: (name ??
      '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    _PROTO_marketplace_name: (marketplace ??
      '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    result: (pluginData
      ? 'passed'
      : 'not_in_cache') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  if (!pluginData) {
    logForDebugging(
      `[hintRecommendation] ${pluginId} not found in marketplace cache`,
    )
    return null
  }

  return {
    pluginId,
    pluginName: pluginData.entry.name,
    marketplaceName: marketplace ?? '',
    pluginDescription: pluginData.entry.description,
    sourceCommand: hint.sourceCommand,
  }
}

/**
 * Record that a prompt for this plugin was surfaced. Called regardless of
 * the user's yes/no response — show-once semantics.
 */
export function markHintPluginShown(pluginId: string): void {
  saveGlobalConfig(current => {
    const state = readHintState(current as HintConfigShape)
    const existing = state?.plugin ?? []
    if (existing.includes(pluginId)) return current
    return {
      ...current,
      agencCodeHints: {
        ...state,
        plugin: [...existing, pluginId],
      },
    }
  })
}

/** Called when the user picks "don't show plugin installation hints again". */
export function disableHintRecommendations(): void {
  saveGlobalConfig(current => {
    const state = readHintState(current as HintConfigShape)
    if (state?.disabled) return current
    return {
      ...current,
      agencCodeHints: { ...state, disabled: true },
    }
  })
}
