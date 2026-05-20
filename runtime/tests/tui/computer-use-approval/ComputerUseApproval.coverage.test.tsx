import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type CapturedSelectProps = {
  options: Array<{ value: string }>
  onChange: (value: string) => void
  onCancel: () => void
}

const harness = vi.hoisted(() => ({
  execFileNoThrow: vi.fn(),
  selectProps: undefined as CapturedSelectProps | undefined,
}))

vi.mock('../components/CustomSelect/select.js', () => ({
  Select: (props: CapturedSelectProps) => {
    harness.selectProps = props
    return null
  },
}))

vi.mock('../components/design-system/Dialog.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  return {
    Dialog: ({ children }: { children: React.ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
  }
})

vi.mock('../../utils/execFileNoThrow.js', () => ({
  execFileNoThrow: harness.execFileNoThrow,
}))

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120

  return { stdout, stdin }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('ComputerUseApproval coverage', () => {
  beforeEach(() => {
    harness.execFileNoThrow.mockReset()
    harness.selectProps = undefined
  })

  it('offers missing macOS permission actions before retrying the request', async () => {
    const { createRoot } = await import('../ink.js')
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
            apps: [],
            requestedFlags: {},
            tccState: {
              accessibility: false,
              screenRecording: false,
            },
          }}
          onDone={onDone}
        />,
      )
      await sleep(25)

      expect(harness.selectProps?.options.map(option => option.value)).toEqual([
        'open_accessibility',
        'open_screen_recording',
        'retry',
      ])

      harness.selectProps!.onChange('open_accessibility')
      expect(harness.execFileNoThrow).toHaveBeenCalledWith(
        'open',
        [
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        ],
        { useCwd: false },
      )
      expect(onDone).not.toHaveBeenCalled()

      harness.selectProps!.onChange('open_screen_recording')
      expect(harness.execFileNoThrow).toHaveBeenLastCalledWith(
        'open',
        [
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        ],
        { useCwd: false },
      )
      expect(onDone).not.toHaveBeenCalled()

      harness.selectProps!.onChange('retry')
      expect(onDone).toHaveBeenCalledWith({
        granted: [],
        denied: [],
        flags: {},
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
