import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

type CapturedSelectProps = {
  defaultFocusValue?: string
  onChange: (value: string) => void | Promise<void>
  onFocus: (value: string) => void
  options: Array<{
    label: string
    value: string
  }>
}

const harness = vi.hoisted(() => ({
  appState: { fileHistory: { entries: [] } },
  diffStats: {
    deletions: 1,
    filesChanged: ['/tmp/failing.ts'],
    insertions: 3,
  },
  keybindings: {} as Record<string, () => unknown>,
  logError: vi.fn(),
  selectProps: null as CapturedSelectProps | null,
  reset() {
    harness.diffStats = {
      deletions: 1,
      filesChanged: ['/tmp/failing.ts'],
      insertions: 3,
    }
    harness.keybindings = {}
    harness.logError.mockClear()
    harness.selectProps = null
  },
}))

vi.mock('../state/AppState.js', () => ({
  useAppState: (selector: (state: unknown) => unknown) =>
    selector(harness.appState),
}))

vi.mock('../../utils/fileHistory.js', () => ({
  fileHistoryCanRestore: () => true,
  fileHistoryEnabled: () => true,
  fileHistoryGetDiffStats: vi.fn(async () => harness.diffStats),
}))

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
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
  useKeybinding: (name: string, handler: () => unknown) => {
    harness.keybindings[name] = handler
  },
  useKeybindings: (handlers: Record<string, () => unknown>) => {
    Object.assign(harness.keybindings, handlers)
  },
}))

vi.mock('./CustomSelect/select', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../ink.js')

  return {
    Select: (props: CapturedSelectProps) => {
      harness.selectProps = props

      return ReactModule.createElement(
        ReactModule.Fragment,
        null,
        props.options.map(option =>
          ReactModule.createElement(Text, { key: option.value }, option.label),
        ),
      )
    },
  }
})

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

async function waitForSelectOption(value: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (harness.selectProps?.options.some(option => option.value === value)) {
      return
    }
    await sleep(10)
  }

  throw new Error(`Timed out waiting for restore option: ${value}`)
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

async function renderSelector(props: {
  messages: Message[]
  onClose?: () => void
  onPreRestore?: () => void
  onRestoreCode?: (message: UserMessage) => Promise<void>
  onRestoreMessage?: (message: UserMessage) => Promise<void>
  onSummarize?: (
    message: UserMessage,
    feedback?: string,
    direction?: 'from' | 'up_to',
  ) => Promise<void>
  preselectedMessage?: UserMessage
}): Promise<{
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
      messages={props.messages}
      onClose={props.onClose ?? vi.fn()}
      onPreRestore={props.onPreRestore ?? vi.fn()}
      onRestoreCode={props.onRestoreCode ?? vi.fn(async () => {})}
      onRestoreMessage={props.onRestoreMessage ?? vi.fn(async () => {})}
      onSummarize={props.onSummarize ?? vi.fn(async () => {})}
      preselectedMessage={props.preselectedMessage}
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

describe('MessageSelector coverage', () => {
  beforeEach(() => {
    harness.reset()
  })

  test('reports code-only restore failures without restoring the conversation', async () => {
    const selected = userMessage('user-1', 'restore only the code')
    const onPreRestore = vi.fn()
    const onRestoreCode = vi.fn(async () => {
      throw new Error('restore exploded')
    })
    const onRestoreMessage = vi.fn(async () => {})
    const onClose = vi.fn()
    const rendered = await renderSelector({
      messages: [selected, assistantMessage('assistant-1', 'reply')],
      onClose,
      onPreRestore,
      onRestoreCode,
      onRestoreMessage,
      preselectedMessage: selected,
    })

    try {
      await waitForSelectOption('code')
      harness.selectProps?.onFocus('code')
      await sleep()

      expect(rendered.output()).toContain('The conversation will be unchanged.')
      expect(rendered.output()).toContain('The code will be restored')

      await harness.selectProps?.onChange('code')
      await waitForOutput(rendered.output, 'Failed to restore the code:')

      expect(onPreRestore).toHaveBeenCalledTimes(1)
      expect(onRestoreCode).toHaveBeenCalledWith(selected)
      expect(onRestoreMessage).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect(harness.logError).toHaveBeenCalledWith(expect.any(Error))
      expect(rendered.output()).toContain('Error: restore exploded')
    } finally {
      await rendered.dispose()
    }
  })
})
