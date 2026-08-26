import {
  getIsNonInteractiveSession,
  getKairosActive,
  preferThirdPartyAuthentication,
} from '../bootstrap/state.js'
import type { ProviderAuthReadContext } from './auth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getDefaultMainLoopModelSetting,
  type ModelSetting,
  parseUserSpecifiedModel,
} from './model/model.js'
import {
  getAPIProvider,
  getSelectedProviderEnvironment,
  getSelectedProviderName,
} from './model/providers.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from './settings/settings.js'
import { getCurrentRuntimeSession } from '../session/current-session.js'

type FastModeProviderReadContext = Pick<
  ProviderAuthReadContext,
  'environment' | 'provider'
>

function selectedFastModeProviderContext(): FastModeProviderReadContext {
  return {
    environment: getSelectedProviderEnvironment(),
    provider: getSelectedProviderName(),
  }
}

function boundFastModeReadContext(): ProviderAuthReadContext {
  const session = getCurrentRuntimeSession()
  const configStore = session?.services.configStore
  const providerService = session?.services.providerService
  const binding = providerService?.current()
  if (
    session === null ||
    configStore === undefined ||
    providerService === undefined ||
    binding === undefined
  ) {
    throw new Error(
      'Fast mode requires session-owned home and provider authority',
    )
  }
  return Object.freeze({
    home: configStore.homeContext,
    environment: providerService.environment(),
    provider: binding.provider,
  })
}

export function isFastModeEnabled(): boolean {
  return isFastModeEnabledForContext(selectedFastModeProviderContext())
}

export function isFastModeEnabledForContext(
  context: FastModeProviderReadContext,
): boolean {
  if (getAPIProvider(context.provider) !== 'firstParty') {
    return false
  }
  return !isEnvTruthy(context.environment.AGENC_DISABLE_FAST_MODE)
}

export function isFastModeAvailable(): boolean {
  if (!isFastModeEnabled()) {
    return false
  }
  return getFastModeUnavailableReasonForContext(boundFastModeReadContext()) === null
}

function getFastModeUnavailableReasonForContext(
  context: ProviderAuthReadContext,
): string | null {
  if (getAPIProvider(context.provider) !== 'firstParty') {
    return 'Fast mode is not available on third-party providers'
  }

  if (!isFastModeEnabledForContext(context)) {
    return 'Fast mode is not available'
  }

  // Not available in the SDK unless explicitly opted in by its config layer.
  // Assistant daemon mode is exempt — it's first-party orchestration, and
  // kairosActive is set before this check runs (main.tsx:~1626 vs ~3249).
  if (
    getIsNonInteractiveSession() &&
    preferThirdPartyAuthentication() &&
    !getKairosActive()
  ) {
    const flagFastMode = getSettingsForSource('flagSettings')?.fastMode
    if (!flagFastMode) {
      const reason = 'Fast mode is not available in the Agent SDK'
      logForDebugging(`Fast mode unavailable: ${reason}`)
      return reason
    }
  }

  if (fastModeRejectedByProvider) {
    const reason = 'Fast mode has been disabled by your organization'
    logForDebugging(`Fast mode unavailable: ${reason}`)
    return reason
  }

  return null
}

export function isFastModeSupportedByModel(
  modelSetting: ModelSetting,
): boolean {
  return isFastModeSupportedByModelForContext(
    modelSetting,
    selectedFastModeProviderContext(),
  )
}

export function isFastModeSupportedByModelForContext(
  modelSetting: ModelSetting,
  context: FastModeProviderReadContext,
): boolean {
  if (!isFastModeEnabledForContext(context)) {
    return false
  }
  const model = modelSetting ?? getDefaultMainLoopModelSetting()
  const parsedModel = parseUserSpecifiedModel(model)
  const m = parsedModel.toLowerCase()
  // Fast mode: Opus 4.6/4.7/4.8. 4.8 is the durable fast-capable tier
  // (4.7 fast mode is deprecated upstream). Claude Fable 5 has NO fast mode
  // (provider docs, verified 2026-07-08) — deliberately excluded here.
  return (
    m.includes('opus-4-6') || m.includes('opus-4-7') || m.includes('opus-4-8')
  )
}

// --- Fast mode runtime state ---
// Separate from user preference (settings.fastMode). This tracks the actual
// operational state: whether we're actively sending fast speed or in cooldown
// after a rate limit.

export type FastModeRuntimeState =
  | { status: 'active' }
  | { status: 'cooldown'; resetAt: number; reason: CooldownReason }

let runtimeState: FastModeRuntimeState = { status: 'active' }

export type CooldownReason = 'rate_limit' | 'overloaded'

export function getFastModeRuntimeState(): FastModeRuntimeState {
  return getFastModeRuntimeStateForContext(selectedFastModeProviderContext())
}

function getFastModeRuntimeStateForContext(
  context: FastModeProviderReadContext,
): FastModeRuntimeState {
  if (
    runtimeState.status === 'cooldown' &&
    Date.now() >= runtimeState.resetAt
  ) {
    if (isFastModeEnabledForContext(context)) {
      logForDebugging('Fast mode cooldown expired, re-enabling fast mode')
    }
    runtimeState = { status: 'active' }
  }
  return runtimeState
}

export function triggerFastModeCooldown(
  resetTimestamp: number,
  reason: CooldownReason,
): void {
  return triggerFastModeCooldownForContext(
    resetTimestamp,
    reason,
    selectedFastModeProviderContext(),
  )
}

function triggerFastModeCooldownForContext(
  resetTimestamp: number,
  reason: CooldownReason,
  context: FastModeProviderReadContext,
): void {
  if (!isFastModeEnabledForContext(context)) {
    return
  }
  runtimeState = { status: 'cooldown', resetAt: resetTimestamp, reason }
  const cooldownDurationMs = resetTimestamp - Date.now()
  logForDebugging(
    `Fast mode cooldown triggered (${reason}), duration ${Math.round(cooldownDurationMs / 1000)}s`,
  )
}

/**
 * Called when the API rejects a fast mode request (e.g., 400 "Fast mode is
 * not enabled for your organization"). Permanently disables fast mode using
 * the persisted user preference and cached runtime capability.
 */
export function handleFastModeRejectedByAPI(): void {
  if (fastModeRejectedByProvider) {
    return
  }
  fastModeRejectedByProvider = true
  void updateSettingsForSource('userSettings', { fastMode: undefined })
}

function getOverageDisabledMessage(reason: string | null): string {
  switch (reason) {
    case 'out_of_credits':
      return 'Fast mode disabled · extra usage credits exhausted'
    case 'org_level_disabled':
    case 'org_service_level_disabled':
      return 'Fast mode disabled · extra usage disabled by your organization'
    case 'org_level_disabled_until':
      return 'Fast mode disabled · extra usage spending cap reached'
    case 'member_level_disabled':
      return 'Fast mode disabled · extra usage disabled for your account'
    case 'seat_tier_level_disabled':
    case 'seat_tier_zero_credit_limit':
    case 'member_zero_credit_limit':
      return 'Fast mode disabled · extra usage not available for your plan'
    case 'overage_not_provisioned':
    case 'no_limits_configured':
      return 'Fast mode requires extra usage billing · /extra-usage to enable'
    default:
      return 'Fast mode disabled · extra usage not available'
  }
}

function isOutOfCreditsReason(reason: string | null): boolean {
  return reason === 'org_level_disabled_until' || reason === 'out_of_credits'
}

/**
 * Called when a 429 indicates fast mode was rejected because extra usage
 * is not available. Permanently disables fast mode (unless the user has
 * ran out of credits) and logs a reason-specific message.
 */
export function handleFastModeOverageRejection(reason: string | null): void {
  const message = getOverageDisabledMessage(reason)
  logForDebugging(
    `Fast mode overage rejection: ${reason ?? 'unknown'} — ${message}`,
  )
  // Disable fast mode permanently unless the user has ran out of credits
  if (!isOutOfCreditsReason(reason)) {
    void updateSettingsForSource('userSettings', { fastMode: undefined })
  }
}

export function isFastModeCooldown(): boolean {
  return getFastModeRuntimeState().status === 'cooldown'
}

let fastModeRejectedByProvider = false
