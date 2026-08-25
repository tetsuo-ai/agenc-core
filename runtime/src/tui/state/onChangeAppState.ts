import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { applyConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import type { AppState } from './AppStateStore.js'

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // mainLoopModel: remove it from settings?
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel === null
  ) {
    // Remove from settings
    void updateSettingsForSource('userSettings', { model: undefined })
    setMainLoopModelOverride(null)
  }

  // mainLoopModel: add it to settings?
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel !== null
  ) {
    // Save to settings
    void updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    setMainLoopModelOverride(newState.mainLoopModel)

  }

  // Re-apply the canonical shell environment when it changes.
  if (newState.settings !== oldState.settings) {
    try {
      // This is additive-only: new vars are added, existing may be overwritten, nothing is deleted
      if (
        newState.settings.shell_environment_policy !==
        oldState.settings.shell_environment_policy
      ) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}
