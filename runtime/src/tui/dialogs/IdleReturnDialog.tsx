/**
 * IdleReturnDialog
 *
 * Ported from upstream. Pops when the operator returns to a session
 * after a long idle window; offers to continue, start a fresh
 * conversation (clear context), dismiss, or never ask again.
 *
 * Idle minutes and total token count are pure props — the host computes
 * them from session state before mounting.
 */

import React, { useCallback, useMemo } from 'react'

import { Box, Text } from '../ink-public.js'
import { Select } from '../design-system/CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'

export type IdleReturnAction = 'continue' | 'clear' | 'dismiss' | 'never'

export interface IdleReturnDialogProps {
  /** How long the operator was idle before returning, in minutes. */
  readonly idleMinutes: number
  /**
   * Total prompt-side tokens accumulated for the conversation up to
   * the moment the dialog opens. Used to nudge the operator toward
   * `clear` when the conversation is heavy.
   */
  readonly totalInputTokens: number
  /**
   * Called when the operator picks an action — including
   * `'continue'`, `'clear'`, or `'never'`. Cancelling the dialog
   * resolves with `'dismiss'`.
   */
  readonly onContinue: (action: IdleReturnAction) => void
  /**
   * Called if the operator hard-aborts (e.g. Ctrl-C). Defaults to
   * resolving `onContinue('dismiss')` when unset.
   */
  readonly onAbort?: () => void
}

function formatIdleDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) {
    return '< 1m'
  }
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = Math.floor(minutes % 60)
  if (remainingMinutes === 0) {
    return `${hours}h`
  }
  return `${hours}h ${remainingMinutes}m`
}

function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return '0'
  }
  if (tokens < 1_000) {
    return String(Math.round(tokens))
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

const OPTIONS: ReadonlyArray<{ value: IdleReturnAction; label: string }> = [
  { value: 'continue', label: 'Continue this conversation' },
  { value: 'clear', label: 'Send message as a new conversation' },
  { value: 'never', label: "Don't ask me again" },
]

export function IdleReturnDialog({
  idleMinutes,
  totalInputTokens,
  onContinue,
  onAbort,
}: IdleReturnDialogProps): React.ReactElement {
  const formattedIdle = useMemo(
    () => formatIdleDuration(idleMinutes),
    [idleMinutes],
  )
  const formattedTokens = useMemo(
    () => formatTokenCount(totalInputTokens),
    [totalInputTokens],
  )

  const handleCancel = useCallback(() => {
    if (onAbort) {
      onAbort()
    } else {
      onContinue('dismiss')
    }
  }, [onAbort, onContinue])

  const handleChange = useCallback(
    (value: IdleReturnAction) => {
      onContinue(value)
    },
    [onContinue],
  )

  return (
    <Dialog
      title={`You've been away ${formattedIdle} and this conversation is ${formattedTokens} tokens.`}
      onCancel={handleCancel}
    >
      <Box flexDirection="column">
        <Text>
          If this is a new task, clearing context will save usage and be
          faster.
        </Text>
      </Box>
      <Select<IdleReturnAction>
        options={OPTIONS}
        onChange={handleChange}
        onCancel={handleCancel}
      />
    </Dialog>
  )
}

export default IdleReturnDialog
