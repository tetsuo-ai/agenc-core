/**
 * Per-tool permission dialog body for shell-style tools (Bash, PowerShell,
 * `system.bash`).
 *
 * Ported from upstream. Renders the proposed command with a session-scope
 * prefix suggestion ("allow this command and similar prefixes") and an
 * abort affordance, then delegates the actual decision back to the
 * caller via `onResolve`.
 *
 * No backend classifier wiring or analytics calls — the upstream variants
 * pulled in a heavy auto-approve subsystem that AgenC owns separately
 * under `runtime/src/permissions/classifier.ts`. The lead can layer that
 * in at the overlay integration point.
 */

import React, { useCallback, useMemo } from 'react'

import { Box, Text } from '../ink-public.js'
import { Select } from '../design-system/CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'

import type { PermissionRequestProps } from './PermissionRequest.js'

const MAX_PREVIEW_LINES = 8

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function extractCommand(input: Record<string, unknown>): string {
  return coerceString(input.command ?? input.cmd ?? input.script)
}

function extractDescription(
  input: Record<string, unknown>,
  fallback?: string,
): string {
  return coerceString(input.description ?? fallback ?? '')
}

function truncate(value: string, maxLines: number): string {
  if (!value) return ''
  const lines = value.split('\n')
  if (lines.length <= maxLines) return value
  return `${lines.slice(0, maxLines).join('\n')}\n…`
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

export const PermissionRequestBash: React.FC<PermissionRequestProps> = ({
  subject,
  onResolve,
  onCancel,
}) => {
  const command = extractCommand(subject.toolInput)
  const description = extractDescription(subject.toolInput, subject.description)
  const prefix = useMemo(() => commandPrefix(command), [command])
  const preview = useMemo(
    () => truncate(command, MAX_PREVIEW_LINES),
    [command],
  )

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
    <Dialog
      title="Bash command"
      subtitle={description ? truncate(description, 1) : undefined}
      onCancel={handleCancel}
    >
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text>{preview.length > 0 ? preview : '(empty command)'}</Text>
        </Box>
        {description ? (
          <Text dimColor={true}>{description}</Text>
        ) : null}

      </Box>
      <Box flexDirection="column">
        <Text>Do you want to proceed?</Text>
        <Select<SelectValue>
          options={options}
          onChange={handleChange}
          onCancel={handleCancel}
        />
      </Box>
    </Dialog>
  )
}

export default PermissionRequestBash
