import { useCallback } from 'react'

import {
  backgroundAll,
  hasForegroundTasks,
} from '../../tasks/LocalShellTask/LocalShellTask.js'
import type { SetAppState } from '../../tasks/Task.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { AppState } from '../state/AppStateStore.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'

type Props = {
  onBackgroundSession?: () => void
  isLoading?: boolean
}

export function markBackgroundTaskUsed<T extends { hasUsedBackgroundTask?: boolean }>(
  config: T,
): T & { hasUsedBackgroundTask: true } {
  return config.hasUsedBackgroundTask
    ? (config as T & { hasUsedBackgroundTask: true })
    : {
      ...config,
      hasUsedBackgroundTask: true,
    }
}

export function shouldActivateSessionBackgroundShortcut(hasForeground: boolean): boolean {
  return hasForeground
}

export function runSessionBackgroundShortcut(
  getAppState: () => AppState,
  setAppState: SetAppState,
  backgroundTasksDisabled = isEnvTruthy(process.env.AGENC_DISABLE_BACKGROUND_TASKS),
): boolean {
  if (backgroundTasksDisabled) {
    return false
  }

  const state = getAppState()
  if (!hasForegroundTasks(state)) {
    return false
  }

  backgroundAll(getAppState, setAppState)
  if (!getGlobalConfig().hasUsedBackgroundTask) {
    saveGlobalConfig(markBackgroundTaskUsed)
  }

  return true
}

/**
 * Handles Ctrl+B foreground-task backgrounding.
 *
 * Whole-session backgrounding is not mounted in AgenC. This component only
 * owns the foreground shell/agent task path.
 */
export function SessionBackgroundHint(_props: Props): null {
  const setAppState = useSetAppState()
  const appStateStore = useAppStateStore()
  const hasForeground = useAppState(hasForegroundTasks)

  const handleBackground = useCallback(() => {
    runSessionBackgroundShortcut(() => appStateStore.getState(), setAppState)
  }, [appStateStore, setAppState])

  useKeybinding('task:background', handleBackground, {
    context: 'Task',
    isActive: shouldActivateSessionBackgroundShortcut(hasForeground),
  })

  return null
}
