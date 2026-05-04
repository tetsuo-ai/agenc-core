import * as React from 'react'

import { Box, Text, useInput } from '../../tui/ink.js'
import { useAppState, useSetAppState } from '../../tui/state/AppState.js'
import {
  clearFastModeCooldown,
  FAST_MODE_MODEL_DISPLAY,
  getFastModeModel,
  getFastModeRuntimeState,
  isFastModeSupportedByModel,
} from '../upstream/utils/fastMode.js'

type Props = {
  onDone: (result?: string) => void
  unavailableReason: string | null
}

function applyFastMode(
  enable: boolean,
  setAppState: ReturnType<typeof useSetAppState>,
): void {
  clearFastModeCooldown()
  setAppState(prev => {
    if (!enable) {
      return { ...prev, fastMode: false }
    }
    const needsModelSwitch = !isFastModeSupportedByModel(prev.mainLoopModel)
    return {
      ...prev,
      ...(needsModelSwitch
        ? {
            mainLoopModel: getFastModeModel(),
            mainLoopModelForSession: null,
          }
        : {}),
      fastMode: true,
    }
  })
}

export function FastModePicker({
  onDone,
  unavailableReason,
}: Props): React.ReactNode {
  const model = useAppState(state => state.mainLoopModel)
  const initialFastMode = useAppState(state => state.fastMode)
  const setAppState = useSetAppState()
  const [enabled, setEnabled] = React.useState(initialFastMode ?? false)
  const isUnavailable = unavailableReason !== null
  const runtimeState = getFastModeRuntimeState()

  const confirm = React.useCallback(() => {
    if (isUnavailable) return
    applyFastMode(enabled, setAppState)
    if (enabled) {
      const modelUpdated = !isFastModeSupportedByModel(model)
        ? `; model set to ${FAST_MODE_MODEL_DISPLAY}`
        : ''
      onDone(`Fast mode ON${modelUpdated}`)
    } else {
      onDone('Fast mode OFF')
    }
  }, [enabled, isUnavailable, model, onDone, setAppState])

  const cancel = React.useCallback(() => {
    onDone(initialFastMode ? 'Kept Fast mode ON' : 'Kept Fast mode OFF')
  }, [initialFastMode, onDone])

  useInput((input, key) => {
    if (key.escape) {
      cancel()
      return
    }
    if (key.return) {
      confirm()
      return
    }
    if (key.tab || input === ' ') {
      if (!isUnavailable) setEnabled(value => !value)
    }
  })

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box flexDirection="row" gap={2}>
        <Text bold>Fast mode</Text>
        <Text color={enabled ? 'fastMode' : undefined} bold={enabled}>
          {enabled ? 'ON' : 'OFF'}
        </Text>
        <Text dimColor>for {FAST_MODE_MODEL_DISPLAY}</Text>
      </Box>
      {unavailableReason ? (
        <Text color="error">{unavailableReason}</Text>
      ) : runtimeState.status === 'cooldown' ? (
        <Text color="warning">
          Fast mode is temporarily unavailable; try again later.
        </Text>
      ) : (
        <Text dimColor>Tab toggles, Enter confirms, Esc cancels</Text>
      )}
    </Box>
  )
}
