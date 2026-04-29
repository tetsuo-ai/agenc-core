/**
 * CostThresholdDialog
 *
 * Ported from upstream. Surfaced once the operator's session-cost ticker
 * crosses a configured threshold. Strictly informational: a single
 * "Got it, thanks!" acknowledgement that returns control via `onContinue`.
 *
 * Cost values are pure props — the dialog does not read AgenC's cost
 * telemetry directly. The host is expected to format `amountUsd` and
 * `providerLabel` from the live session before mounting.
 */

import React, { useCallback } from 'react'

import { Box, Text } from '../ink-public.js'
import { Select } from '../design-system/CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'

export interface CostThresholdDialogProps {
  /** Cost threshold the session has just crossed, in US dollars. */
  readonly amountUsd: number
  /**
   * Human label for the API the spend is attributed to, e.g. `"Anthropic
   * API"`, `"AWS Bedrock"`, `"OpenAI-compatible API"`. The host
   * computes this from the active provider before mounting.
   */
  readonly providerLabel: string
  /** Called when the operator dismisses the notice. */
  readonly onContinue: () => void
  /**
   * Called if the operator wants to abort instead of acknowledging.
   * Defaults to `onContinue` when unset.
   */
  readonly onAbort?: () => void
}

function formatAmount(amountUsd: number): string {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return '$0'
  }
  if (Number.isInteger(amountUsd)) {
    return `$${amountUsd}`
  }
  return `$${amountUsd.toFixed(2)}`
}

export function CostThresholdDialog({
  amountUsd,
  providerLabel,
  onContinue,
  onAbort,
}: CostThresholdDialogProps): React.ReactElement {
  const handleChange = useCallback(() => {
    onContinue()
  }, [onContinue])

  const handleCancel = useCallback(() => {
    if (onAbort) {
      onAbort()
    } else {
      onContinue()
    }
  }, [onAbort, onContinue])

  return (
    <Dialog
      title={`You've spent ${formatAmount(
        amountUsd,
      )} on the ${providerLabel} this session.`}
      onCancel={handleCancel}
    >
      <Box flexDirection="column">
        <Text>
          Cost threshold reached. AgenC keeps running, but consider whether to
          continue or wrap up the session.
        </Text>
      </Box>
      <Select
        options={[{ value: 'ok', label: 'Got it, thanks!' }]}
        onChange={handleChange}
      />
    </Dialog>
  )
}

export default CostThresholdDialog
