import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { applyConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import type { AppState } from './AppStateStore.js'

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
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
