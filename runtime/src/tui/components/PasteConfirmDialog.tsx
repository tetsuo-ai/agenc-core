/**
 * Confirmation dialog for raw-paste bash submission.
 *
 * B-NEW2: when the burst detector flags stdin as a suspected paste (more
 * than ~50 chars in <50ms without BPM markers) and the user is in bash
 * mode, we surface this dialog before calling the bash backend with
 * `dangerouslyDisableSandbox: true`. Pressing `y` allows execution;
 * `n` or `Esc` aborts.
 */
import React from 'react'
import { Box, Text, useInput } from '../ink.js'

type Props = {
  command: string
  onDecide: (allow: boolean) => void
}

const PREVIEW_CHARS = 200

function previewCommand(command: string): string {
  const oneline = command.replace(/\s+/g, ' ').trim()
  if (oneline.length <= PREVIEW_CHARS) return oneline
  return `${oneline.slice(0, PREVIEW_CHARS)}…`
}

export function PasteConfirmDialog({ command, onDecide }: Props): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') {
      onDecide(false)
      return
    }
    if (input === 'y' || input === 'Y' || key.return) {
      onDecide(true)
    }
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
    >
      <Text color="yellow" bold>
        Suspected paste detected
      </Text>
      <Text>
        This bash command arrived as a burst of stdin without bracketed-paste
        markers. Confirm before executing.
      </Text>
      <Box marginTop={1}>
        <Text dimColor>{'$ '}</Text>
        <Text>{previewCommand(command)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          Press <Text bold color="green">y</Text> to run,{' '}
          <Text bold color="red">n</Text> or <Text bold>Esc</Text> to abort.
        </Text>
      </Box>
    </Box>
  )
}
