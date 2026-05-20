import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  appState: { fileHistory: { entries: [] } },
  logEvent: vi.fn(),
  reset() {
    harness.logEvent.mockClear()
  },
}))

vi.mock('../../services/analytics/index.js', () => ({
  logEvent: harness.logEvent,
}))

vi.mock('../state/AppState.js', () => ({
  useAppState: (selector: (state: unknown) => unknown) =>
    selector(harness.appState),
}))

vi.mock('../../utils/fileHistory.js', () => ({
  fileHistoryCanRestore: () => false,
  fileHistoryEnabled: () => true,
  fileHistoryGetDiffStats: vi.fn(async () => ({
    deletions: 0,
    filesChanged: [],
    insertions: 0,
  })),
}))

vi.mock('../../utils/log.js', () => ({
  logError: vi.fn(),
}))

vi.mock('src/tui/hooks/useExitOnCtrlCDWithKeybindings.js', () => ({
  useExitOnCtrlCDWithKeybindings: () => ({
    keyName: 'ctrl+c',
    pending: false,
  }),
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}))

vi.mock('../keybindings/useKeybinding.js', () => ({
  useKeybinding: vi.fn(),
  useKeybindings: vi.fn(),
}))

vi.mock('./CustomSelect/select', () => ({
  Select: () => null,
}))

import { createRoot } from '../ink/root.js'
import type { Message, UserMessage } from '../../types/message.js'
import { MessageSelector } from './MessageSelector.js'

function userMessage(uuid: string, text: string): UserMessage {
  return {
    message: { content: [{ text, type: 'text' }] },
    timestamp: '2026-05-20T00:00:00.000Z',
    type: 'user',
    uuid,
  } as UserMessage
}

function assistantMessage(uuid: string, text: string): Message {
  return {
    message: { content: [{ text, type: 'text' }] },
    type: 'assistant',
    uuid,
  } as Message
}

function createStreams(): {
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
  stdout.resume()
  return { stdin, stdout }
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForOutput(
  output: () => string,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (output().includes(expected)) {
      return
    }
    await sleep(10)
  }

  throw new Error(`Timed out waiting for output: ${expected}`)
}

async function renderSelector(messages: Message[]): Promise<{
  dispose: () => Promise<void>
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
  root.render(
    <MessageSelector
      messages={messages}
      onClose={vi.fn()}
      onPreRestore={vi.fn()}
      onRestoreCode={vi.fn(async () => {})}
      onRestoreMessage={vi.fn(async () => {})}
      onSummarize={vi.fn(async () => {})}
    />,
  )
  await sleep()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    output: () => stripAnsi(output),
  }
}

describe('MessageSelector coverage for non-restorable pick-list rows', () => {
  beforeEach(() => {
    harness.reset()
  })

  test('shows terminal input text with a no-code-restore warning', async () => {
    const rendered = await renderSelector([
      userMessage('user-1', '<bash-input>npm test</bash-input>'),
      assistantMessage('assistant-1', 'done'),
    ])

    try {
      await waitForOutput(rendered.output, 'No code restore')

      expect(rendered.output()).toContain('! npm test')
      expect(rendered.output()).toContain('No code restore')
      expect(rendered.output()).toContain('(current)')
      expect(harness.logEvent).toHaveBeenCalledWith(
        'agenc_message_selector_opened',
        {},
      )
    } finally {
      await rendered.dispose()
    }
  })
})
