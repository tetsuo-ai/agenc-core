import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'

const diffCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('../../../../utils/log', () => ({
  logError: vi.fn(),
}))

vi.mock('../../../hooks/useTerminalSize', () => ({
  useTerminalSize: () => ({ columns: 12, rows: 24 }),
}))

vi.mock('./NotebookEditToolDiff', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  const { Text } = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    NotebookEditToolDiff: (props: Record<string, unknown>) => {
      diffCalls.push(props)
      return ReactActual.createElement(Text, null, `diff width ${props.width}`)
    },
  }
})

vi.mock('../FilePermissionDialog/FilePermissionDialog', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  const { Box, Text } = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    FilePermissionDialog: (props: Record<string, unknown>) =>
      ReactActual.createElement(
        Box,
        { flexDirection: 'column' },
        ReactActual.createElement(Text, null, props.title as string),
        props.question as React.ReactNode,
        props.content as React.ReactNode,
      ),
  }
})

vi.mock('../PermissionPrompt', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  const { Text } = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    PermissionPrompt: () => ReactActual.createElement(Text, null, 'Reject'),
  }
})

function makeProps(input: Record<string, unknown>) {
  return {
    toolUseConfirm: {
      input,
      tool: {
        name: 'NotebookEdit',
        isMcp: false,
        userFacingName: () => 'NotebookEdit',
      },
      assistantMessage: {
        message: { id: 'msg_1' },
      },
      description: '',
      toolUseContext: {},
      toolUseID: 'toolu_1',
      permissionResult: { behavior: 'ask' },
      permissionPromptStartTimeMs: 0,
      onUserInteraction: vi.fn(),
      onAbort: vi.fn(),
      onAllow: vi.fn(),
      onReject: vi.fn(),
      recheckPermission: vi.fn(),
    },
    toolUseContext: {},
    onDone: vi.fn(),
    onReject: vi.fn(),
    verbose: false,
    workerBadge: undefined,
  } as never
}

describe('NotebookEditPermissionRequest', () => {
  beforeEach(() => {
    diffCalls.length = 0
  })

  it('reports malformed NotebookEdit input instead of rendering an empty file prompt', async () => {
    const { NotebookEditPermissionRequest, parseNotebookEditInput } =
      await import('./NotebookEditPermissionRequest.js')

    const parsed = parseNotebookEditInput({ bad: true })
    expect(parsed.ok).toBe(false)

    const output = await renderToString(
      <NotebookEditPermissionRequest {...makeProps({ bad: true })} />,
      80,
    )

    expect(output).toContain('Invalid NotebookEdit input')
    expect(output).toContain('Reject')
    expect(diffCalls).toHaveLength(0)
  })

  it('sizes the notebook diff from terminal columns', async () => {
    const {
      NotebookEditPermissionRequest,
      getNotebookEditDiffWidth,
    } = await import('./NotebookEditPermissionRequest.js')

    expect(getNotebookEditDiffWidth(Number.NaN)).toBe(1)
    expect(getNotebookEditDiffWidth(0)).toBe(1)
    expect(getNotebookEditDiffWidth(6)).toBe(1)
    expect(getNotebookEditDiffWidth(12)).toBe(6)

    const output = await renderToString(
      <NotebookEditPermissionRequest
        {...makeProps({
          notebook_path: '/tmp/agenc-notebook.ipynb',
          cell_id: '0',
          new_source: 'print("new")',
          cell_type: 'code',
          edit_mode: 'replace',
        })}
      />,
      80,
    )

    expect(output).toContain('Edit notebook')
    expect(output).toContain('agenc-notebook.ipynb')
    expect(output).toContain('diff width 6')
    expect(diffCalls[0]?.width).toBe(6)
  })
})
