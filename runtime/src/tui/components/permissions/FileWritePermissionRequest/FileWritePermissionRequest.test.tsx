import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(() => new Promise<string>(() => {})),
  readFileSync: vi.fn(() => {
    throw new Error('sync read should not run during render')
  }),
  readSync: vi.fn(() => {
    throw new Error('sync read should not run during render')
  }),
}))

const dialogCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('../../../../utils/fsOperations.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/fsOperations.js')>()
  return {
    ...actual,
    getFsImplementation: () => fsMock,
  }
})

vi.mock('../FilePermissionDialog/FilePermissionDialog', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  const { Box, Text } = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    FilePermissionDialog: (props: Record<string, any>) => {
      dialogCalls.push(props)
      props.ideDiffSupport?.getConfig(props.parseInput(props.toolUseConfirm.input))

      return ReactActual.createElement(
        Box,
        { flexDirection: 'column' },
        ReactActual.createElement(Text, null, props.title),
        props.content,
        props.question,
      )
    },
  }
})

vi.mock('../../design-system/LoadingState', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  const { Text } = await vi.importActual<typeof import('../../../ink.js')>(
    '../../../ink.js',
  )
  return {
    LoadingState: ({ message }: { message: string }) =>
      ReactActual.createElement(Text, null, message),
  }
})

function makeProps() {
  return {
    toolUseConfirm: {
      input: {
        file_path: '/tmp/agenc-file-write-permission-test.txt',
        content: 'new content\n',
      },
      tool: {
        name: 'Write',
        isMcp: false,
        userFacingName: () => 'Write',
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

describe('FileWritePermissionRequest', () => {
  beforeEach(() => {
    dialogCalls.length = 0
    fsMock.readFile.mockClear()
    fsMock.readFileSync.mockClear()
    fsMock.readSync.mockClear()
  })

  it('opens the permission dialog with a loading preview before any async file read resolves', async () => {
    const { FileWritePermissionRequest } = await import(
      './FileWritePermissionRequest.js'
    )

    const output = await renderToString(
      <FileWritePermissionRequest {...makeProps()} />,
      80,
    )

    expect(output).toContain('Write file')
    expect(output).toContain('Loading file preview')
    expect(dialogCalls[0]?.ideDiffSupport).toBeUndefined()
    expect(fsMock.readFileSync).not.toHaveBeenCalled()
    expect(fsMock.readSync).not.toHaveBeenCalled()
  })

  it('builds IDE diff config from loaded content without a synchronous reread', async () => {
    const { __fileWritePermissionRequestTest } = await import(
      './FileWritePermissionRequest.js'
    )
    const support =
      __fileWritePermissionRequestTest.createFileWriteIdeDiffSupport('old\n')

    const config = support.getConfig({
      file_path: '/tmp/agenc-file-write-permission-test.txt',
      content: 'new\n',
    })

    expect(config).toMatchObject({
      filePath: '/tmp/agenc-file-write-permission-test.txt',
      editMode: 'single',
      edits: [
        {
          old_string: 'old\n',
          new_string: 'new\n',
          replace_all: false,
        },
      ],
    })
    expect(fsMock.readFileSync).not.toHaveBeenCalled()
    expect(fsMock.readSync).not.toHaveBeenCalled()
  })
})
