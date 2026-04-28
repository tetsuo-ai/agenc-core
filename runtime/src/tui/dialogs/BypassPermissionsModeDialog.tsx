/**
 * BypassPermissionsModeDialog
 *
 * Ported from upstream. Confirmation gate the operator must clear before
 * AgenC enters `bypassPermissions` mode (the `PermissionMode` value
 * defined in `runtime/src/permissions/types.ts`).
 *
 * In `bypassPermissions` mode AgenC does NOT ask for approval before
 * running potentially dangerous tool calls, so the dialog spells out the
 * tradeoff and forces an explicit accept. Decline triggers `onDecline`,
 * which the host wires to a graceful shutdown so the operator never
 * lands in bypass mode by accident.
 */

import React, { useCallback } from 'react'

import { Box, Newline, Text } from '../ink-public.js'
import { Select } from '../design-system/CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'

type DialogValue = 'accept' | 'decline'

export interface BypassPermissionsModeDialogProps {
  /** Called when the operator explicitly accepts entering bypass mode. */
  readonly onAccept: () => void
  /**
   * Called when the operator declines, hits cancel, or otherwise exits
   * the dialog without accepting. The host is expected to abort the
   * mode transition (typically by exiting the process).
   */
  readonly onDecline: () => void
}

const OPTIONS: ReadonlyArray<{ value: DialogValue; label: string }> = [
  { value: 'decline', label: 'No, exit' },
  { value: 'accept', label: 'Yes, I accept' },
]

export function BypassPermissionsModeDialog({
  onAccept,
  onDecline,
}: BypassPermissionsModeDialogProps): React.ReactElement {
  const handleChange = useCallback(
    (value: DialogValue) => {
      if (value === 'accept') {
        onAccept()
      } else {
        onDecline()
      }
    },
    [onAccept, onDecline],
  )

  return (
    <Dialog
      title="WARNING: AgenC running in Bypass Permissions mode"
      color="error"
      onCancel={onDecline}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          In Bypass Permissions mode, AgenC will not ask for your approval
          before running potentially dangerous commands.
          <Newline />
          This mode should only be used in a sandboxed container or VM that
          has restricted internet access and can easily be restored if
          damaged.
        </Text>
        <Text>
          By proceeding, you accept all responsibility for actions taken
          while running in Bypass Permissions mode.
        </Text>
      </Box>
      <Select<DialogValue> options={OPTIONS} onChange={handleChange} />
    </Dialog>
  )
}

export default BypassPermissionsModeDialog
