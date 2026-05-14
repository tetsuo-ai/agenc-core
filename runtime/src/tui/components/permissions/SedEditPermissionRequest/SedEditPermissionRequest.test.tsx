import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(() => new Promise<string>(() => {})),
  readSync: vi.fn(() => ({
    buffer: Buffer.from('old content\n'),
    bytesRead: Buffer.byteLength('old content\n'),
  })),
}))

vi.mock('../../../../utils/fsOperations.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../../utils/fsOperations.js')>()
  return {
    ...actual,
    getFsImplementation: () => fsMock,
  }
})

vi.mock('../../design-system/LoadingState.js', async () => {
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
    sedInfo: {
      filePath: '/tmp/agenc-sed-permission-test.txt',
      pattern: 'old',
      replacement: 'new',
      flags: '',
      extendedRegex: false,
    },
    toolUseConfirm: {
      input: {
        command: "sed -i 's/old/new/' /tmp/agenc-sed-permission-test.txt",
      },
      tool: {
        name: 'system.bash',
        isMcp: false,
        userFacingName: () => 'Bash',
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

describe('SedEditPermissionRequest', () => {
  beforeEach(() => {
    fsMock.readFile.mockClear()
    fsMock.readSync.mockClear()
  })

  it('renders a loading permission dialog while the file preview is still pending', async () => {
    const { SedEditPermissionRequest } = await import(
      './SedEditPermissionRequest.js'
    )

    const output = await renderToString(
      <SedEditPermissionRequest {...makeProps()} />,
      80,
    )

    expect(output).toContain('Edit file')
    expect(output).toContain('agenc-sed-permission-test.txt')
    expect(output).toContain('Loading edit preview...')
    expect(fsMock.readFile).toHaveBeenCalled()
  })
})
