import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from 'src/constants/oauth.js'
import {
  getIsNonInteractiveSession,
  getKairosActive,
  preferThirdPartyAuthentication,
} from '../bootstrap/state.js'
import {
  getAnthropicApiKeyWithSourceForContext,
  getAgenCAIOAuthTokens,
  handleOAuth401Error,
  hasProfileScope,
  type ProviderAuthReadContext,
} from './auth.js'
import { isInBundledMode } from './bundledMode.js'
import { getRuntimeState, updateRuntimeState } from './config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  type ModelSetting,
  parseUserSpecifiedModel,
} from './model/model.js'
import {
  getAPIProvider,
  getSelectedProviderEnvironment,
  getSelectedProviderName,
} from './model/providers.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'
import {
  getExecutionAuthoritySettings,
  getSettingsForSource,
  updateSettingsForSource,
} from './settings/settings.js'
import { createSignal } from './signal.js'
import type { ProviderEnvironment } from '../llm/provider-options.js'
import { createAxiosInstance } from './proxy.js'
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

export function isFastModeAvailableForContext(
  context: ProviderAuthReadContext,
): boolean {
  if (!isFastModeEnabledForContext(context)) {
    return false
  }
  return getFastModeUnavailableReasonForContext(context) === null
}

type AuthType = 'oauth' | 'api-key'

function getDisabledReasonMessage(
  disabledReason: FastModeDisabledReason,
  authType: AuthType,
): string {
  switch (disabledReason) {
    case 'free':
      return authType === 'oauth'
        ? 'Fast mode requires a paid subscription'
        : 'Fast mode unavailable during evaluation. Please purchase credits.'
    case 'preference':
      return 'Fast mode has been disabled by your organization'
    case 'extra_usage_disabled':
      // Only OAuth users can have extra_usage_disabled; console users don't have this concept
      return 'Fast mode requires extra usage billing · /extra-usage to enable'
    case 'network_error':
      return 'Fast mode unavailable due to network connectivity issues'
    case 'unknown':
      return 'Fast mode is currently unavailable'
  }
}

export function getFastModeUnavailableReason(): string | null {
  if (getAPIProvider() !== 'firstParty') {
    return 'Fast mode is not available on third-party providers'
  }

  return getFastModeUnavailableReasonForContext(boundFastModeReadContext())
}

export function getFastModeUnavailableReasonForContext(
  context: ProviderAuthReadContext,
): string | null {
  if (getAPIProvider(context.provider) !== 'firstParty') {
    return 'Fast mode is not available on third-party providers'
  }

  if (!isFastModeEnabledForContext(context)) {
    return 'Fast mode is not available'
  }

  const remoteConfigReason: string | null = null
  // Remote-config reason has priority over other reasons.
  if (remoteConfigReason !== null) {
    logForDebugging(`Fast mode unavailable: ${remoteConfigReason}`)
    return remoteConfigReason
  }

  // Previously, fast mode required the native binary (bun build). This is no
  // longer necessary, but we keep this option behind a flag just in case.
  if (!isInBundledMode() && false) {
    return 'Fast mode requires the native binary · Install from: https://agenc.tech/product/agenc-code'
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

  if (orgStatus.status === 'disabled') {
    if (
      orgStatus.reason === 'network_error' ||
      orgStatus.reason === 'unknown'
    ) {
      // The org check can fail behind corporate proxies that block the
      // endpoint. We add AGENC_SKIP_FAST_MODE_NETWORK_ERRORS=1 to
      // bypass this check in the CC binary. This is OK since we have
      // another check in the API to error out when disabled by org.
      if (
        isEnvTruthy(
          context.environment.AGENC_SKIP_FAST_MODE_NETWORK_ERRORS,
        )
      ) {
        return null
      }
    }
    const authType: AuthType =
      getAgenCAIOAuthTokens(
        context.home,
        context.environment,
      ) !== null
        ? 'oauth'
        : 'api-key'
    const reason = getDisabledReasonMessage(orgStatus.reason, authType)
    logForDebugging(`Fast mode unavailable: ${reason}`)
    return reason
  }

  return null
}

// @[MODEL LAUNCH]: Update supported Fast Mode models.
export const FAST_MODE_MODEL_DISPLAY = 'Opus 4.6'

export function getFastModeModel(): string {
  return 'opus' + (isOpus1mMergeEnabled() ? '[1m]' : '')
}

export function getInitialFastModeSetting(model: ModelSetting): boolean {
  return getInitialFastModeSettingForContext(model, boundFastModeReadContext())
}

export function getInitialFastModeSettingForContext(
  model: ModelSetting,
  context: ProviderAuthReadContext,
): boolean {
  if (!isFastModeEnabledForContext(context)) {
    return false
  }
  if (!isFastModeAvailableForContext(context)) {
    return false
  }
  if (!isFastModeSupportedByModelForContext(model, context)) {
    return false
  }
  const settings = getExecutionAuthoritySettings()
  return settings.fastMode === true
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
let hasLoggedCooldownExpiry = false

// --- Cooldown event listeners ---
export type CooldownReason = 'rate_limit' | 'overloaded'

const cooldownTriggered =
  createSignal<[resetAt: number, reason: CooldownReason]>()
const cooldownExpired = createSignal()
export const onCooldownTriggered = cooldownTriggered.subscribe
export const onCooldownExpired = cooldownExpired.subscribe

export function getFastModeRuntimeState(): FastModeRuntimeState {
  return getFastModeRuntimeStateForContext(selectedFastModeProviderContext())
}

export function getFastModeRuntimeStateForContext(
  context: FastModeProviderReadContext,
): FastModeRuntimeState {
  if (
    runtimeState.status === 'cooldown' &&
    Date.now() >= runtimeState.resetAt
  ) {
    if (isFastModeEnabledForContext(context) && !hasLoggedCooldownExpiry) {
      logForDebugging('Fast mode cooldown expired, re-enabling fast mode')
      hasLoggedCooldownExpiry = true
      cooldownExpired.emit()
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

export function triggerFastModeCooldownForContext(
  resetTimestamp: number,
  reason: CooldownReason,
  context: FastModeProviderReadContext,
): void {
  if (!isFastModeEnabledForContext(context)) {
    return
  }
  runtimeState = { status: 'cooldown', resetAt: resetTimestamp, reason }
  hasLoggedCooldownExpiry = false
  const cooldownDurationMs = resetTimestamp - Date.now()
  logForDebugging(
    `Fast mode cooldown triggered (${reason}), duration ${Math.round(cooldownDurationMs / 1000)}s`,
  )
  cooldownTriggered.emit(resetTimestamp, reason)
}

export function clearFastModeCooldown(): void {
  runtimeState = { status: 'active' }
}

/**
 * Called when the API rejects a fast mode request (e.g., 400 "Fast mode is
 * not enabled for your organization"). Permanently disables fast mode using
 * the same flow as when the prefetch discovers the org has it disabled.
 */
export function handleFastModeRejectedByAPI(): void {
  if (orgStatus.status === 'disabled') {
    return
  }
  orgStatus = { status: 'disabled', reason: 'preference' }
  void updateSettingsForSource('userSettings', { fastMode: undefined })
  updateRuntimeState(current => ({
    ...current,
    penguinModeOrgEnabled: false,
  }))
  orgFastModeChange.emit(false)
}

// --- Overage rejection listeners ---
// Fired when a 429 indicates fast mode was rejected because extra usage
// (overage billing) is not available. Distinct from org-level disabling.
const overageRejection = createSignal<[message: string]>()
export const onFastModeOverageRejection = overageRejection.subscribe

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
 * ran out of credits) and notifies with a reason-specific message.
 */
export function handleFastModeOverageRejection(reason: string | null): void {
  const message = getOverageDisabledMessage(reason)
  logForDebugging(
    `Fast mode overage rejection: ${reason ?? 'unknown'} — ${message}`,
  )
  // Disable fast mode permanently unless the user has ran out of credits
  if (!isOutOfCreditsReason(reason)) {
    void updateSettingsForSource('userSettings', { fastMode: undefined })
    updateRuntimeState(current => ({
      ...current,
      penguinModeOrgEnabled: false,
    }))
  }
  overageRejection.emit(message)
}

export function isFastModeCooldown(): boolean {
  return getFastModeRuntimeState().status === 'cooldown'
}

export function isFastModeCooldownForContext(
  context: FastModeProviderReadContext,
): boolean {
  return getFastModeRuntimeStateForContext(context).status === 'cooldown'
}

export function getFastModeState(
  model: ModelSetting,
  fastModeUserEnabled: boolean | undefined,
): 'off' | 'cooldown' | 'on' {
  return getFastModeStateForContext(
    model,
    fastModeUserEnabled,
    boundFastModeReadContext(),
  )
}

export function getFastModeStateForContext(
  model: ModelSetting,
  fastModeUserEnabled: boolean | undefined,
  context: ProviderAuthReadContext,
): 'off' | 'cooldown' | 'on' {
  const enabled =
    isFastModeEnabledForContext(context) &&
    isFastModeAvailableForContext(context) &&
    !!fastModeUserEnabled &&
    isFastModeSupportedByModelForContext(model, context)
  if (enabled && isFastModeCooldownForContext(context)) {
    return 'cooldown'
  }
  if (enabled) {
    return 'on'
  }
  return 'off'
}

// Disabled reason returned by the API. The API is the canonical source for why
// fast mode is disabled (free account, admin preference, extra usage not enabled).
export type FastModeDisabledReason =
  | 'free'
  | 'preference'
  | 'extra_usage_disabled'
  | 'network_error'
  | 'unknown'

// In-memory cache of the fast mode status from the API.
// Distinct from the user's fastMode app state — this represents
// whether the org *allows* fast mode and why it may be disabled.
// Modeled as a discriminated union so the invalid state
// (disabled without a reason) is unrepresentable.
type FastModeOrgStatus =
  | { status: 'pending' }
  | { status: 'enabled' }
  | { status: 'disabled'; reason: FastModeDisabledReason }

let orgStatus: FastModeOrgStatus = { status: 'pending' }

// Listeners notified when org-level fast mode status changes
const orgFastModeChange = createSignal<[orgEnabled: boolean]>()
export const onOrgFastModeChanged = orgFastModeChange.subscribe

type FastModeResponse = {
  enabled: boolean
  disabled_reason: FastModeDisabledReason | null
}

async function fetchFastModeStatus(
  auth: { accessToken: string } | { apiKey: string },
  environment: ProviderEnvironment,
): Promise<FastModeResponse> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/agenc_code_penguin_mode`
  const headers: Record<string, string> =
    'accessToken' in auth
      ? {
          Authorization: `Bearer ${auth.accessToken}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        }
      : { 'x-api-key': auth.apiKey }

  const response = await createAxiosInstance(environment).get<FastModeResponse>(
    endpoint,
    { headers },
  )
  return response.data
}

const PREFETCH_MIN_INTERVAL_MS = 30_000
let lastPrefetchAt = 0
let inflightPrefetch: Promise<void> | null = null

/**
 * Resolve orgStatus from the persisted cache without making any API calls.
 * Used when startup prefetches are throttled to avoid hitting the network
 * while still making fast mode availability checks work.
 */
export function resolveFastModeStatusFromCache(
  context: ProviderAuthReadContext,
): void {
  if (!isFastModeEnabledForContext(context)) {
    return
  }
  if (orgStatus.status !== 'pending') {
    return
  }
  const cachedEnabled = getRuntimeState().penguinModeOrgEnabled === true
  orgStatus =
    cachedEnabled
      ? { status: 'enabled' }
      : { status: 'disabled', reason: 'unknown' }
}

export async function prefetchFastModeStatus(
  context: ProviderAuthReadContext,
): Promise<void> {
  const { home, environment: providerEnvironment } = context
  // Skip network requests if nonessential traffic is disabled
  if (isEssentialTrafficOnly()) {
    return
  }

  if (!isFastModeEnabledForContext(context)) {
    return
  }

  if (inflightPrefetch) {
    logForDebugging(
      'Fast mode prefetch in progress, returning in-flight promise',
    )
    return inflightPrefetch
  }

  // Service key OAuth sessions lack user:profile scope → endpoint 403s.
  // Resolve orgStatus from cache and bail before burning the throttle window.
  // API key auth is unaffected.
  const apiKey = getAnthropicApiKeyWithSourceForContext(context).key
  const hasUsableOAuth =
    getAgenCAIOAuthTokens(home, providerEnvironment)?.accessToken &&
    hasProfileScope(home, providerEnvironment)
  if (!hasUsableOAuth && !apiKey) {
    const cachedEnabled = getRuntimeState().penguinModeOrgEnabled === true
    orgStatus =
      cachedEnabled
        ? { status: 'enabled' }
        : { status: 'disabled', reason: 'preference' }
    return
  }

  const now = Date.now()
  if (now - lastPrefetchAt < PREFETCH_MIN_INTERVAL_MS) {
    logForDebugging('Skipping fast mode prefetch, fetched recently')
    return
  }
  lastPrefetchAt = now

  const fetchWithCurrentAuth = async (): Promise<FastModeResponse> => {
    const currentTokens = getAgenCAIOAuthTokens(home, providerEnvironment)
    const auth =
      currentTokens?.accessToken && hasProfileScope(home, providerEnvironment)
        ? { accessToken: currentTokens.accessToken }
        : apiKey
          ? { apiKey }
          : null
    if (!auth) {
      throw new Error('No auth available')
    }
    return fetchFastModeStatus(auth, providerEnvironment)
  }

  async function doFetch(): Promise<void> {
    try {
      let status: FastModeResponse
      try {
        status = await fetchWithCurrentAuth()
      } catch (err) {
        const isAuthError =
          axios.isAxiosError(err) &&
          (err.response?.status === 401 ||
            (err.response?.status === 403 &&
              typeof err.response?.data === 'string' &&
              err.response.data.includes('OAuth token has been revoked')))
        if (isAuthError) {
          const failedAccessToken = getAgenCAIOAuthTokens(
            home,
            providerEnvironment,
          )?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(
              home,
              failedAccessToken,
              providerEnvironment,
            )
            status = await fetchWithCurrentAuth()
          } else {
            throw err
          }
        } else {
          throw err
        }
      }

      const previousEnabled =
        orgStatus.status !== 'pending'
          ? orgStatus.status === 'enabled'
          : getRuntimeState().penguinModeOrgEnabled
      orgStatus = status.enabled
        ? { status: 'enabled' }
        : {
            status: 'disabled',
            reason: status.disabled_reason ?? 'preference',
          }
      if (previousEnabled !== status.enabled) {
        // When org disables fast mode, permanently turn off the user's fast mode setting
        if (!status.enabled) {
          void updateSettingsForSource('userSettings', { fastMode: undefined })
        }
        updateRuntimeState(current => ({
          ...current,
          penguinModeOrgEnabled: status.enabled,
        }))
        orgFastModeChange.emit(status.enabled)
      }
      logForDebugging(
        `Org fast mode: ${status.enabled ? 'enabled' : `disabled (${status.disabled_reason ?? 'preference'})`}`,
      )
    } catch (err) {
      // On failure: ants default to enabled (don't block internal users).
      // External users: fall back to the cached penguinModeOrgEnabled value;
      // if no positive cache, disable with network_error reason.
      const cachedEnabled = getRuntimeState().penguinModeOrgEnabled === true
      orgStatus =
        cachedEnabled
          ? { status: 'enabled' }
          : { status: 'disabled', reason: 'network_error' }
      logForDebugging(
        `Failed to fetch org fast mode status, defaulting to ${orgStatus.status === 'enabled' ? 'enabled (cached)' : 'disabled (network_error)'}: ${err}`,
        { level: 'error' },
      )
    } finally {
      inflightPrefetch = null
    }
  }

  inflightPrefetch = doFetch()
  return inflightPrefetch
}
