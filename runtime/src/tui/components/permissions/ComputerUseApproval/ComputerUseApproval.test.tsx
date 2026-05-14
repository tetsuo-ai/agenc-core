import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const selectProps = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        options: Array<{ value: string }>
        onChange: (value: string) => void
        onCancel: () => void
      },
}))

vi.mock('../../CustomSelect/select.js', () => ({
  Select: (props: {
    options: Array<{ value: string }>
    onChange: (value: string) => void
    onCancel: () => void
  }) => {
    selectProps.current = props
    return null
  },
}))

vi.mock('../../design-system/Dialog.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  return {
    Dialog: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
  }
})

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120

  return { stdout, stdin }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('ComputerUseApproval', () => {
  beforeEach(() => {
    selectProps.current = undefined
  })

  it('lets users toggle individual apps before approving the request', async () => {
    const { createRoot } = await import('../../../ink.js')
    const { ComputerUseApproval } = await import('./ComputerUseApproval.js')
    const onDone = vi.fn()
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <ComputerUseApproval
          request={{
            apps: [
              {
                requestedName: 'One',
                resolved: {
                  bundleId: 'com.example.one',
                  displayName: 'One',
                },
              },
              {
                requestedName: 'Two',
                resolved: {
                  bundleId: 'com.example.two',
                  displayName: 'Two',
                },
              },
            ],
            requestedFlags: { clipboardRead: true },
          }}
          onDone={onDone}
        />,
      )
      await sleep(25)

      expect(selectProps.current?.options.map(option => option.value)).toEqual([
        'app:com.example.one',
        'app:com.example.two',
        'allow_selected',
        'deny',
      ])

      selectProps.current!.onChange('app:com.example.two')
      await sleep(25)
      selectProps.current!.onChange('allow_selected')

      expect(onDone).toHaveBeenCalledWith({
        granted: [
          expect.objectContaining({
            bundleId: 'com.example.one',
            displayName: 'One',
          }),
        ],
        denied: [
          {
            bundleId: 'com.example.two',
            reason: 'user_denied',
          },
        ],
        flags: { clipboardRead: true },
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
