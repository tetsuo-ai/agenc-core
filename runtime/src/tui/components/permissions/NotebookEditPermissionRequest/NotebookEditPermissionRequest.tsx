// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { basename } from 'path'
import React, { useCallback, useMemo } from 'react'
import type { z } from 'zod/v4'

import { NotebookEditTool } from '../../../../tools/NotebookEditTool/NotebookEditTool'
import { logError } from '../../../../utils/log' // upstream-import: keep target is owned by another Z-PURGE item
import { Box, Text } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog'
import { PermissionDialog } from '../PermissionDialog'
import { PermissionPrompt } from '../PermissionPrompt'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { NotebookEditToolDiff } from './NotebookEditToolDiff'

type NotebookEditInput = z.infer<typeof NotebookEditTool.inputSchema>

type NotebookEditParseResult =
  | { ok: true; input: NotebookEditInput }
  | { ok: false; message: string }

type MalformedNotebookEditInputDialogProps = PermissionRequestProps & {
  message: string
}

export function getNotebookEditDiffWidth(columns: number): number {
  const safeColumns = Number.isFinite(columns)
    ? Math.max(0, Math.trunc(columns))
    : 0
  return Math.max(1, safeColumns - 6)
}

export function parseNotebookEditInput(input: unknown): NotebookEditParseResult {
  const result = NotebookEditTool.inputSchema.safeParse(input)
  if (!result.success) {
    const message = result.error.message
    logError(new Error(`Failed to parse notebook edit input: ${message}`))
    return {
      ok: false,
      message,
    }
  }

  return {
    ok: true,
    input: result.data,
  }
}

function parseNotebookEditInputOrThrow(input: unknown): NotebookEditInput {
  return NotebookEditTool.inputSchema.parse(input)
}

function MalformedNotebookEditInputDialog({
  message,
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: MalformedNotebookEditInputDialogProps): React.ReactNode {
  const handleReject = useCallback(
    (feedback?: string) => {
      toolUseConfirm.onReject(feedback)
      onReject()
      onDone()
    },
    [onDone, onReject, toolUseConfirm],
  )

  const handleSelect = useCallback(
    (_value: 'no', feedback?: string) => {
      handleReject(feedback)
    },
    [handleReject],
  )

  const options = useMemo(
    () =>
      [
        {
          label: 'No',
          value: 'no',
          feedbackConfig: {
            type: 'reject',
          },
        },
      ] as const,
    [],
  )

  return (
    <PermissionDialog title="Edit notebook" workerBadge={workerBadge}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text color="error" bold={true}>
            Invalid NotebookEdit input
          </Text>
          <Text dimColor={true}>{message}</Text>
        </Box>
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={() => handleReject()}
          question="Reject this malformed notebook edit request?"
          toolAnalyticsContext={{
            toolName: toolUseConfirm.tool.name,
            isMcp: toolUseConfirm.tool.isMcp ?? false,
          }}
        />
      </Box>
    </PermissionDialog>
  )
}

export function NotebookEditPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  const { columns } = useTerminalSize()
  const parsed = parseNotebookEditInput(props.toolUseConfirm.input)

  if (!parsed.ok) {
    return (
      <MalformedNotebookEditInputDialog {...props} message={parsed.message} />
    )
  }

  const {
    notebook_path,
    edit_mode,
    cell_type,
    cell_id,
    new_source,
  } = parsed.input
  const language = cell_type === 'markdown' ? 'markdown' : 'python'
  const editTypeText =
    edit_mode === 'insert'
      ? 'insert this cell into'
      : edit_mode === 'delete'
        ? 'delete this cell from'
        : 'make this edit to'
  const fileName = basename(notebook_path)
  const diffWidth = getNotebookEditDiffWidth(columns)

  return (
    <FilePermissionDialog
      toolUseConfirm={props.toolUseConfirm}
      toolUseContext={props.toolUseContext}
      onDone={props.onDone}
      onReject={props.onReject}
      workerBadge={props.workerBadge}
      title="Edit notebook"
      question={
        <Text>
          Do you want to {editTypeText}{' '}
          <Text bold={true}>{fileName}</Text>?
        </Text>
      }
      content={
        <NotebookEditToolDiff
          notebook_path={notebook_path}
          cell_id={cell_id}
          new_source={new_source}
          cell_type={cell_type}
          edit_mode={edit_mode}
          verbose={props.verbose}
          width={diffWidth}
        />
      }
      path={notebook_path}
      completionType="tool_use_single"
      languageName={language}
      parseInput={parseNotebookEditInputOrThrow}
    />
  )
}

export const __notebookEditPermissionRequestTest = {
  getNotebookEditDiffWidth,
  parseNotebookEditInput,
}
