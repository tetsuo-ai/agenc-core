import * as settingsModule from '../settings/settings.js'

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

/** Managed policy is the only authority that may suppress every hook source. */
export function shouldDisableAllHooksIncludingManaged(): boolean {
  return (
    settingsModule.getSettingsForSource('policySettings')?.disableAllHooks ===
    true
  )
}
