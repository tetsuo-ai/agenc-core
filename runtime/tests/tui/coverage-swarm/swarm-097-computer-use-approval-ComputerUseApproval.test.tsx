import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { ComputerUsePermissionRequest } from '../../utils/computerUse/approvalTypes.js'
import { createRoot } from '../ink.js'
import {
  ComputerUseApproval,
  getInitialComputerUseSelectedAppIds,
} from '../computer-use-approval/ComputerUseApproval.js'

type CapturedSelectProps = {
  options: Array<{
    description?: string
    label?: React.ReactNode
    value: string
  }>
  onCancel: () => void
  onChange: (value: string) => void
  visibleOptionCount?: number
}

type CapturedDialogProps = {
  onCancel: () => void
  title: string
}

type SentinelCategory = 'shell' | 'filesystem' | 'system_settings'

const harness = vi.hoisted(() => {
  const sentinels: Record<string, SentinelCategory | undefined> = {}

  return {
    dialogProps: undefined as CapturedDialogProps | undefined,
    execFileNoThrow: vi.fn(),
    getComputerUseSentinelCategory: vi.fn(
      (bundleId: string) => sentinels[bundleId],
    ),
    selectProps: undefined as CapturedSelectProps | undefined,
    sentinels,
  }
})

vi.mock('../components/CustomSelect/select.js', () => ({
  Select: (props: CapturedSelectProps) => {
    harness.selectProps = props
    return null
  },
}))

vi.mock('../components/design-system/Dialog.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    Dialog: ({
      children,
      onCancel,
      title,
    }: CapturedDialogProps & { children: React.ReactNode }) => {
      harness.dialogProps = { onCancel, title }
      return ReactActual.createElement(ReactActual.Fragment, null, children)
    },
  }
})

vi.mock('../../utils/execFileNoThrow.js', () => ({
  execFileNoThrow: harness.execFileNoThrow,
}))

vi.mock('../../utils/computerUse/approvalTypes.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../utils/computerUse/approvalTypes.js')>(
      '../../utils/computerUse/approvalTypes.js',
    )

  return {
    ...actual,
    getComputerUseSentinelCategory: harness.getComputerUseSentinelCategory,
  }
})

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS

function createStreams(): {
  stdin: TestStdin
  stdout: PassThrough
} {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough()

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  ;(stdout as unknown as { rows: number }).rows = 24
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function compactText(text: string): string {
  return text.replace(/\s+/g, '')
}

async function renderApproval(
  request: ComputerUsePermissionRequest,
  onDone = vi.fn(),
): Promise<{
  dispose: () => Promise<void>
  onDone: typeof onDone
  output: () => string
}> {
  let output = ''
  const { stdin, stdout } = createStreams()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  root.render(<ComputerUseApproval request={request} onDone={onDone} />)
  await sleep()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(5)
    },
    onDone,
    output: () => stripAnsi(output),
  }
}

beforeEach(() => {
  process.env.AGENC_TUI_GLYPHS = 'ascii'
  harness.dialogProps = undefined
  harness.execFileNoThrow.mockReset()
  harness.getComputerUseSentinelCategory.mockClear()
  harness.selectProps = undefined

  for (const key of Object.keys(harness.sentinels)) {
    delete harness.sentinels[key]
  }
})

afterEach(() => {
  vi.restoreAllMocks()

  if (previousGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = previousGlyphMode
  }
})

describe('ComputerUseApproval coverage swarm row 097', () => {
  test('selects only resolved apps that still need approval by default', () => {
    expect(
      getInitialComputerUseSelectedAppIds([
        {
          requestedName: 'Selectable',
          resolved: {
            bundleId: 'com.example.selectable',
            displayName: 'Selectable',
          },
        },
        {
          requestedName: 'Already Allowed',
          alreadyGranted: true,
          resolved: {
            bundleId: 'com.example.already',
            displayName: 'Already Allowed',
          },
        },
        {
          requestedName: 'Missing App',
        },
      ]),
    ).toEqual(['com.example.selectable'])
  })

  test('renders partial TCC state and cancels with a deny-all response', async () => {
    const rendered = await renderApproval({
      apps: [],
      requestedFlags: { clipboardRead: true },
      tccState: {
        accessibility: true,
        screenRecording: false,
      },
    })

    try {
      expect(harness.dialogProps?.title).toBe(
        'Computer Use needs macOS permissions',
      )
      expect(harness.selectProps?.options.map(option => option.value)).toEqual([
        'open_screen_recording',
        'retry',
      ])
      const output = compactText(rendered.output())
      expect(output).toContain('Accessibility:')
      expect(output).toContain('granted')
      expect(output).toContain('ScreenRecording:')
      expect(output).toContain('notgranted')

      harness.dialogProps!.onCancel()

      expect(rendered.onDone).toHaveBeenCalledWith({
        denied: [],
        flags: {},
        granted: [],
      })
    } finally {
      await rendered.dispose()
    }
  })

  test('returns granted, denied, and requested flag details after app toggles', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    harness.sentinels['com.example.shell'] = 'shell'
    harness.sentinels['com.example.files'] = 'filesystem'
    harness.sentinels['com.example.settings'] = 'system_settings'

    const rendered = await renderApproval({
      apps: [
        {
          requestedName: 'Terminal',
          resolved: {
            bundleId: 'com.example.shell',
            displayName: 'Terminal',
          },
        },
        {
          requestedName: 'File Manager',
          resolved: {
            bundleId: 'com.example.files',
            displayName: 'File Manager',
          },
        },
        {
          requestedName: 'System Settings',
          resolved: {
            bundleId: 'com.example.settings',
            displayName: 'System Settings',
          },
        },
        {
          requestedName: 'Missing App',
        },
        {
          requestedName: 'Already Allowed',
          alreadyGranted: true,
          resolved: {
            bundleId: 'com.example.already',
            displayName: 'Already Allowed',
          },
        },
      ],
      reason: 'Automated browser setup needs temporary app control.',
      requestedFlags: {
        clipboardRead: true,
        clipboardWrite: true,
        systemKeyCombos: true,
      },
      willHide: [{}, {}],
    })

    try {
      expect(harness.selectProps?.options.map(option => option.value)).toEqual([
        'app:com.example.shell',
        'app:com.example.files',
        'app:com.example.settings',
        'allow_selected',
        'deny',
      ])
      expect(harness.selectProps?.visibleOptionCount).toBe(5)
      expect(harness.selectProps?.options.map(option => option.description)).toEqual([
        '! equivalent to shell access',
        '! can read/write any file',
        '! can change system settings',
        undefined,
        undefined,
      ])

      const output = compactText(rendered.output())
      expect(output).toContain('Automatedbrowsersetupneedstemporaryappcontrol.')
      expect(output).toContain('MissingApp')
      expect(output).toContain('(notinstalled)')
      expect(output).toContain('AlreadyAllowed')
      expect(output).toContain('(alreadygranted)')
      expect(output).toContain('Alsorequested:')
      expect(output).toContain('clipboardRead')
      expect(output).toContain('clipboardWrite')
      expect(output).toContain('systemKeyCombos')
      expect(output).toContain('2otherappswillbehiddenwhileAgenCworks.')

      harness.selectProps!.onChange('app:com.example.shell')
      await sleep()
      harness.selectProps!.onChange('allow_selected')

      expect(rendered.onDone).toHaveBeenCalledWith({
        denied: [
          {
            bundleId: 'com.example.shell',
            reason: 'user_denied',
          },
          {
            bundleId: 'Missing App',
            reason: 'not_installed',
          },
        ],
        flags: {
          clipboardRead: true,
          clipboardWrite: true,
          systemKeyCombos: true,
        },
        granted: [
          {
            bundleId: 'com.example.files',
            displayName: 'File Manager',
            grantedAt: 1_700_000_000_000,
          },
          {
            bundleId: 'com.example.settings',
            displayName: 'System Settings',
            grantedAt: 1_700_000_000_000,
          },
        ],
      })
    } finally {
      await rendered.dispose()
    }
  })

  test('denies app approval requests from both the option and dialog cancel', async () => {
    const request: ComputerUsePermissionRequest = {
      apps: [
        {
          requestedName: 'Terminal',
          resolved: {
            bundleId: 'com.example.terminal',
            displayName: 'Terminal',
          },
        },
      ],
      requestedFlags: {
        systemKeyCombos: true,
      },
    }

    const deniedFromOption = await renderApproval(request)
    try {
      harness.selectProps!.onChange('deny')
      expect(deniedFromOption.onDone).toHaveBeenCalledWith({
        denied: [],
        flags: {},
        granted: [],
      })
    } finally {
      await deniedFromOption.dispose()
    }

    const deniedFromDialog = await renderApproval(request)
    try {
      harness.dialogProps!.onCancel()
      expect(deniedFromDialog.onDone).toHaveBeenCalledWith({
        denied: [],
        flags: {},
        granted: [],
      })
    } finally {
      await deniedFromDialog.dispose()
    }
  })
})
