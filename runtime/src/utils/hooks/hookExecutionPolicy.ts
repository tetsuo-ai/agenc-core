import * as settingsModule from '../settings/settings.js'
import { isHookExecutionSuppressed } from '../../hooks/runtime-policy.js'

/**
 * Whether non-managed registered hooks are suppressed by policy.
 *
 * Canonical command hooks are resolved and executed by ConfiguredHooksRuntime.
 * This policy only filters the distinct registered callback/plugin/session
 * sources owned by the callback runtime in utils/hooks.ts.
 */
export function shouldAllowManagedHooksOnly(): boolean {
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  if (policySettings?.allowManagedHooksOnly === true) {
    return true
  }

  return (
    settingsModule.getExecutionAuthoritySettings().disableAllHooks === true &&
    policySettings?.disableAllHooks !== true
  )
}

/**
 * Canonical hard policy for every hook source.
 *
 * Bare mode is immutable owner authority. Managed policy remains the only
 * settings source that may suppress managed hooks as well as user hooks.
 */
export function shouldDisableAllHooksIncludingManaged(): boolean {
  return (
    isHookExecutionSuppressed() ||
    settingsModule.getSettingsForSource('policySettings')?.disableAllHooks ===
    true
  )
}
