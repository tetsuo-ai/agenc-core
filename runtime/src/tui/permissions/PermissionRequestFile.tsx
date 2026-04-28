/**
 * Per-tool permission dialog body for file write/edit tools.
 *
 * Ported from upstream. Renders the target file path plus a tight diff
 * preview when one is available (Edit semantics) or a content snippet
 * (Write semantics), then asks the operator to allow once / allow for
 * the session / deny.
 */

import React, { useCallback, useMemo } from 'react'

import { Box, Text } from '../ink-public.js'
import { Select } from '../design-system/CustomSelect/index.js'
import { Dialog } from '../design-system/Dialog.js'

import type { PermissionRequestProps } from './PermissionRequest.js'

const MAX_PREVIEW_LINES = 6

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function truncate(value: string, maxLines: number): string {
  if (!value) return ''
  const lines = value.split('\n')
  if (lines.length <= maxLines) return value
  return `${lines.slice(0, maxLines).join('\n')}\n…`
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length
}

function extractPath(input: Record<string, unknown>): string {
  return coerceString(
    input.file_path ??
      input.filePath ??
      input.path ??
      input.notebook_path ??
      input.target,
  )
}

function extractEdit(input: Record<string, unknown>): {
  readonly mode: 'edit' | 'write'
  readonly oldText: string
  readonly newText: string
  readonly content: string
} {
  const oldText = coerceString(input.old_string ?? input.oldText ?? input.old_text)
  const newText = coerceString(input.new_string ?? input.newText ?? input.new_text)
  const content = coerceString(input.content ?? input.text ?? input.source)
  if (oldText.length > 0 || newText.length > 0) {
    return { mode: 'edit', oldText, newText, content }
  }
  return { mode: 'write', oldText: '', newText: '', content }
}

type SelectValue = 'yes' | 'yes-session' | 'no'

export const PermissionRequestFile: React.FC<PermissionRequestProps> = ({
  subject,
  onResolve,
  onCancel,
}) => {
  const path = extractPath(subject.toolInput)
  const edit = useMemo(
    () => extractEdit(subject.toolInput),
    [subject.toolInput],
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
        case 'yes-session':
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
      { value: 'yes' as const, label: 'Yes, apply this change' },
      {
        value: 'yes-session' as const,
        label: 'Yes, and stop asking about this file for the session',
      },
      { value: 'no' as const, label: 'No, tell AgenC what to do differently' },
    ],
    [],
  )

  const titleVerb = edit.mode === 'edit' ? 'Edit file' : 'Write file'

  return (
    <Dialog
      title={titleVerb}
      subtitle={path || '(no path)'}
      onCancel={handleCancel}
    >
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text dimColor={true}>{`path · ${path || '(none)'}`}</Text>
        {edit.mode === 'edit' ? (
          <>
            <Text dimColor={true}>{`diff · -${countLines(edit.oldText)} / +${countLines(
              edit.newText,
            )} lines`}</Text>
            <Text dimColor={true}>before</Text>
            <Box borderStyle="round" paddingX={1} flexDirection="column">
              <Text>{truncate(edit.oldText, MAX_PREVIEW_LINES) || '(empty)'}</Text>
            </Box>
            <Text dimColor={true}>after</Text>
            <Box borderStyle="round" paddingX={1} flexDirection="column">
              <Text>{truncate(edit.newText, MAX_PREVIEW_LINES) || '(empty)'}</Text>
            </Box>
          </>
        ) : (
          <Box borderStyle="round" paddingX={1} flexDirection="column">
            <Text>
              {truncate(edit.content, MAX_PREVIEW_LINES) || '(empty content)'}
            </Text>
          </Box>
        )}
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

export default PermissionRequestFile
