import type { ConfigStore } from '../../config/store.js'
import type { AppState } from '../../tui/state/AppState.js'
import { logForDebugging } from '../debug.js'
import {
  createDisabledAutoModeContext,
  createDisabledBypassPermissionsContext,
  removeOverlyBroadShellAllowRules,
  transitionPlanAutoMode,
} from '../../permissions/permission-mode.js'
import {
  applyPermissionRulesSnapshot,
  loadPermissionRulesSnapshot,
} from '../../permissions/settings.js'
import { errorMessage } from '../errors.js'
import { reasoningEffortToEffortLevel } from '../effort.js'
import { getInitialSettings } from './settings.js'

/** Project one canonical ConfigStore reload into the interactive AppState. */
export function applyConfigStoreChange(
  configStore: ConfigStore,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  const newSettings = getInitialSettings(configStore)

  logForDebugging('Canonical ConfigStore changed, updating app state')

  void loadPermissionRulesSnapshot({ configStore }).then(snapshot => {
    setAppState(prev => {
      let newContext = applyPermissionRulesSnapshot(
        prev.toolPermissionContext,
        snapshot,
      )

      if (
        process.env.USER_TYPE === 'ant' &&
        process.env.AGENC_ENTRYPOINT !== 'local-agent'
      ) {
        newContext = removeOverlyBroadShellAllowRules(newContext)
      }

      if (
        newContext.isBypassPermissionsModeAvailable &&
        snapshot.bypassPermissionsModeDisabled
      ) {
        newContext = createDisabledBypassPermissionsContext(newContext)
      }

      newContext = snapshot.disableAutoMode
        ? createDisabledAutoModeContext(newContext)
        : transitionPlanAutoMode(newContext)

      const prevEffort = reasoningEffortToEffortLevel(
        prev.settings.reasoning_effort,
      )
      const newEffort = reasoningEffortToEffortLevel(
        newSettings.reasoning_effort,
      )
      const effortChanged = prevEffort !== newEffort
      const prevSwarm = prev.settings.swarmMode
      const newSwarm = newSettings.swarmMode
      const swarmChanged = prevSwarm !== newSwarm

      return {
        ...prev,
        settings: newSettings,
        toolPermissionContext: newContext,
        ...(effortChanged && newEffort !== undefined
          ? { effortValue: newEffort }
          : {}),
        ...(swarmChanged && newSwarm !== undefined
          ? { swarmMode: newSwarm }
          : {}),
      }
    })
  }).catch(error => {
    logForDebugging(
      `Failed to reload canonical permission policy: ${errorMessage(error)}`,
      { level: 'error' },
    )
  })
}
