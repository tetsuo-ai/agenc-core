import React, { useCallback } from 'react'
import { Box, Text } from '../ink-public.js'
import { Dialog } from '../design-system/Dialog.js'
import { Select } from '../design-system/CustomSelect/index.js'

type InvalidConfigDialogProps = {
  filePath: string
  errorDescription: string
  onExit: () => void
  onReset: () => void
}

/**
 * Dialog shown when the AgenC config file contains invalid JSON.
 *
 * Lets the user either exit the runtime to fix the file by hand or reset
 * the file to defaults. The caller owns the actual filesystem reset; this
 * component only renders the confirmation UI.
 */
export function InvalidConfigDialog({
  filePath,
  errorDescription,
  onExit,
  onReset,
}: InvalidConfigDialogProps): React.ReactElement {
  const handleSelect = useCallback(
    (value: string) => {
      if (value === 'exit') {
        onExit()
      } else {
        onReset()
      }
    },
    [onExit, onReset],
  )

  const options = [
    { label: 'Exit and fix manually', value: 'exit' },
    { label: 'Reset with default configuration', value: 'reset' },
  ]

  return (
    <Dialog title="Configuration Error" color="error" onCancel={onExit}>
      <Box flexDirection="column" gap={1}>
        <Text>
          The configuration file at <Text bold={true}>{filePath}</Text>{' '}
          contains invalid JSON.
        </Text>
        <Text>{errorDescription}</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold={true}>Choose an option:</Text>
        <Select
          options={options}
          onChange={handleSelect}
          onCancel={onExit}
        />
      </Box>
    </Dialog>
  )
}
