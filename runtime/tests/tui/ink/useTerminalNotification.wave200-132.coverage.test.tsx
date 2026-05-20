import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import {
  type TerminalNotification,
  TerminalWriteProvider,
  useTerminalNotification,
} from './useTerminalNotification.js'

const terminalHarness = vi.hoisted(() => ({
  progressAvailable: false,
}))

vi.mock('../../../utils/env.js', () => ({
  env: { terminal: 'xterm' },
}))

vi.mock('./terminal.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./terminal.js')>()
  return {
    ...actual,
    isProgressReportingAvailable: () => terminalHarness.progressAvailable,
  }
})

const originalTmux = process.env['TMUX']
const originalSty = process.env['STY']

afterEach(() => {
  terminalHarness.progressAvailable = false

  if (originalTmux === undefined) {
    delete process.env['TMUX']
  } else {
    process.env['TMUX'] = originalTmux
  }

  if (originalSty === undefined) {
    delete process.env['STY']
  } else {
    process.env['STY'] = originalSty
  }
})

function osc(...parts: (number | string)[]): string {
  return `\x1b]${parts.join(';')}\x07`
}

function CaptureNotification({
  onCapture,
}: {
  readonly onCapture: (notification: TerminalNotification) => void
}): null {
  onCapture(useTerminalNotification())
  return null
}

async function renderNotificationHarness(
  writes: string[],
): Promise<TerminalNotification> {
  let captured: TerminalNotification | undefined

  delete process.env['TMUX']
  delete process.env['STY']

  await renderToString(
    <TerminalWriteProvider value={data => writes.push(data)}>
      <CaptureNotification onCapture={notification => (captured = notification)} />
    </TerminalWriteProvider>,
    20,
  )

  if (captured === undefined) {
    throw new Error('terminal notification hook did not render')
  }

  return captured
}

describe('useTerminalNotification wave200 coverage', () => {
  test('writes terminal notifications and gates progress OSC sequences', async () => {
    const writes: string[] = []
    const notification = await renderNotificationHarness(writes)

    notification.progress('running', 42)
    expect(writes).toEqual([])

    notification.notifyITerm2({ message: 'build passed', title: 'AgenC' })
    notification.notifyITerm2({ message: 'plain notice' })
    notification.notifyKitty({ id: 7, message: 'job complete', title: 'Worker' })
    notification.notifyGhostty({ message: 'ready', title: 'Session' })
    notification.notifyBell()

    terminalHarness.progressAvailable = true
    notification.progress(null)
    notification.progress('completed')
    notification.progress('error', -4.5)
    notification.progress('indeterminate')
    notification.progress('running', 100.5)
    notification.progress('running')

    expect(writes).toEqual([
      osc(9, '\n\nAgenC:\nbuild passed'),
      osc(9, '\n\nplain notice'),
      osc(99, 'i=7:d=0:p=title', 'Worker'),
      osc(99, 'i=7:p=body', 'job complete'),
      osc(99, 'i=7:d=1:a=focus', ''),
      osc(777, 'notify', 'Session', 'ready'),
      '\x07',
      osc(9, 4, 0, ''),
      osc(9, 4, 0, ''),
      osc(9, 4, 2, 0),
      osc(9, 4, 3, ''),
      osc(9, 4, 1, 100),
      osc(9, 4, 1, 0),
    ])
  })
})
