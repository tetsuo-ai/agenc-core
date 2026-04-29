/**
 * Per-tool permission dialog body for the Monitor tool.
 *
 * Ported from upstream. Monitor wraps a long-running shell command, so
 * the dialog mirrors the Bash variant shape — show command + optional
 * description and offer one-shot vs prefix-scope approval.
 */

import React, { useCallback, useMemo } from 'react'

import { Box, Text } from '../ink-public.js'
import { Select } from '../design-system/CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'

import type { PermissionRequestProps } from './PermissionRequest.js'

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function commandPrefix(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ''
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  if (tokens.length === 1) return `${tokens[0]}:*`
  return `${tokens[0]} ${tokens[1]}:*`
}

type SelectValue = 'yes' | 'yes-prefix' | 'no'

export const PermissionRequestMonitor: React.FC<PermissionRequestProps> = ({
  subject,
  onResolve,
  onCancel,
}) => {
  const command = coerceString(
    subject.toolInput.command ?? subject.toolInput.cmd,
  )
  const description = coerceString(
    subject.toolInput.description ?? subject.description ?? '',
  )
  const prefix = useMemo(() => commandPrefix(command), [command])

  const handleCancel = useCallback(() => {
    onResolve({ behavior: 'abort' })
    onCancel?.()
  }, [onCancel, onResolve])

  const handleChange = useCallback(
    (value: SelectValue) => {
      switch (value) {
        case 'yes':
          onResolve({ behavior: 'allow' })
          return
        case 'yes-prefix':
          onResolve({ behavior: 'allow-session', addRule: true })
          return
        case 'no':
          onResolve({ behavior: 'deny' })
          return
      }
    },
    [onResolve],
  )

  const options = useMemo(
    () => [
      { value: 'yes' as const, label: 'Yes' },
      ...(prefix
        ? [
            {
              value: 'yes-prefix' as const,
              label: `Yes, and don't ask again for ${prefix} this session`,
            },
          ]
        : []),
      { value: 'no' as const, label: 'No, tell AgenC what to do differently' },
    ],
    [prefix],
  )

  return (
    <Dialog title="Monitor" onCancel={handleCancel}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>{`Monitor(${command})`}</Text>
        {description ? <Text dimColor={true}>{description}</Text> : null}
      </Box>
      <Box flexDirection="column">
        <Select<SelectValue>
          options={options}
          onChange={handleChange}
          onCancel={handleCancel}
        />
      </Box>
    </Dialog>
  )
}

export default PermissionRequestMonitor
