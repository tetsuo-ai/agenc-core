import type { AppState } from '../../tui/state/AppState.js'
import { logForDebugging } from 'src/utils/debug.js'
import { updateHooksConfigSnapshot } from '../hooks/hooksConfigSnapshot.js'
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
import type { SettingSource } from './constants.js'
import {
  getExecutionAuthoritySettings,
  getInitialSettings,
} from './settings.js'

/**
 * Apply a settings change to app state. Re-reads settings from disk,
 * reloads permissions and hooks, and pushes the new state.
 *
 * Used by both the interactive path (AppState.tsx via useSettingsChange) and
 * the headless/SDK path (print.ts direct subscribe) so that managed policy
 * / policy changes are fully applied in both modes.
 *
 * The settings cache is reset by the notifier (changeDetector.fanOut) before
 * listeners are iterated, so getInitialSettings() here reads fresh disk
 * state. Previously this function reset the cache itself, which — combined
 * with useSettingsChange's own reset — caused N disk reloads per notification
 * for N subscribers.
 *
 * Side-effects like clearing auth caches and applying env vars are handled by
 * `onChangeAppState` which fires when `settings` changes in state.
 */
export function applySettingsChange(
  source: SettingSource,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  const newSettings = getInitialSettings()
  const authoritySettings = getExecutionAuthoritySettings()

  logForDebugging(`Settings changed from ${source}, updating app state`)
  updateHooksConfigSnapshot()

  void loadPermissionRulesSnapshot().then(snapshot => {
    setAppState(prev => {
      let newContext = applyPermissionRulesSnapshot(
        prev.toolPermissionContext,
        snapshot,
      )

      // Internal operator sessions never accept a whole-shell durable grant.
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

      // Sync canonical reasoning_effort to top-level AppState when it changes
      // (e.g. via applyFlagSettings from IDE). Only propagate if the setting
      // itself changed — otherwise unrelated settings churn (e.g. tips
      // dismissal on startup) would clobber a --effort CLI flag value held in
      // AppState.
      const prevEffort = reasoningEffortToEffortLevel(
        prev.settings.reasoning_effort,
      )
      const newEffort = reasoningEffortToEffortLevel(
        authoritySettings.reasoning_effort,
      )
      const effortChanged = prevEffort !== newEffort
      const prevSwarm = prev.settings.swarmMode
      const newSwarm = authoritySettings.swarmMode
      const swarmChanged = prevSwarm !== newSwarm

      return {
        ...prev,
        settings: newSettings,
        toolPermissionContext: newContext,
        // Only propagate a defined new value — when the disk key is absent
        // (e.g. /effort max for non-ants writes undefined; --effort CLI flag),
        // prev.settings.reasoning_effort can be stale (internal writes suppress the
        // watcher that would resync AppState.settings), so effortChanged would
        // be true and we'd wipe a session-scoped value held in effortValue.
        ...(effortChanged && newEffort !== undefined
          ? { effortValue: newEffort }
          : {}),
        // swarmMode follows the same settings → AppState channel as
        // effortValue: /swarm writes the disk key, this mirrors it into
        // top-level AppState for the status bar and prompt attachment.
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
