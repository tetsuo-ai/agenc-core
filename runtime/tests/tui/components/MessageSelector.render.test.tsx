import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  appState: { fileHistory: { entries: [] } },
  diffStats: {
    deletions: 2,
    filesChanged: ['/tmp/foo.ts', '/tmp/bar.ts'],
    insertions: 5,
  },
  fileHistoryEnabled: true,
  fileHistoryGetDiffStats: vi.fn(),
  keybindings: {} as Record<string, () => unknown>,
  logError: vi.fn(),
  selectProps: null as null | {
    onCancel: () => void
    onChange: (value: string) => void
    onFocus: (value: string) => void
    options: Array<{
      label: string
      onChange?: (value: string) => void
      value: string
    }>
  },
  reset() {
    harness.diffStats = {
      deletions: 2,
      filesChanged: ['/tmp/foo.ts', '/tmp/bar.ts'],
      insertions: 5,
    }
    harness.fileHistoryEnabled = true
    harness.fileHistoryGetDiffStats.mockReset()
    harness.fileHistoryGetDiffStats.mockResolvedValue(harness.diffStats)
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
  fileHistoryEnabled: () => harness.fileHistoryEnabled,
  fileHistoryGetDiffStats: harness.fileHistoryGetDiffStats,
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
    Select: (props: typeof harness.selectProps) => {
      harness.selectProps = props
      return ReactModule.createElement(
        ReactModule.Fragment,
        null,
        props?.options.map(option =>
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

describe('MessageSelector render paths', () => {
  beforeEach(() => {
    harness.reset()
  })

  test('renders the empty state and closes through the confirmation escape binding', async () => {
    harness.fileHistoryEnabled = false
    const onClose = vi.fn()
    const rendered = await renderSelector({ messages: [], onClose })

    try {
      expect(rendered.output()).toContain('Nothing to rewind to yet.')
      harness.keybindings['confirm:no']?.()
      expect(onClose).toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('selects an earlier message and directly restores conversation when file history is disabled', async () => {
    harness.fileHistoryEnabled = false
    const first = userMessage('user-1', 'restore from this prompt')
    const messages = [first, assistantMessage('assistant-1', 'reply')]
    const onPreRestore = vi.fn()
    const onRestoreMessage = vi.fn(async () => {})
    const onClose = vi.fn()
    const rendered = await renderSelector({
      messages,
      onClose,
      onPreRestore,
      onRestoreMessage,
    })

    try {
      expect(rendered.output()).toContain(
        'Restore and fork the conversation to the point before',
      )
      harness.keybindings['messageSelector:up']?.()
      await sleep()
      harness.keybindings['messageSelector:select']?.()
      await sleep()

      expect(onPreRestore).toHaveBeenCalled()
      expect(onRestoreMessage).toHaveBeenCalledWith(first)
      expect(onClose).toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('confirms preselected code and conversation restore with diff stats', async () => {
    const selected = userMessage('user-1', 'restore code too')
    const onPreRestore = vi.fn()
    const onRestoreCode = vi.fn(async () => {})
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
      await sleep()
      expect(rendered.output()).toContain('Restore code and conversation')
      expect(rendered.output()).toContain('foo.ts and bar.ts')

      harness.selectProps?.onFocus('both')
      harness.selectProps?.onChange('both')
      await sleep()

      expect(onPreRestore).toHaveBeenCalled()
      expect(onRestoreCode).toHaveBeenCalledWith(selected)
      expect(onRestoreMessage).toHaveBeenCalledWith(selected)
      expect(onClose).toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('logs rejected selected-message diff metadata and falls back to conversation restore', async () => {
    const error = new Error('diff metadata unavailable')
    harness.fileHistoryGetDiffStats.mockRejectedValueOnce(error)
    const selected = userMessage('user-1', 'restore with missing metadata')
    const rendered = await renderSelector({
      messages: [selected, assistantMessage('assistant-1', 'reply')],
    })

    try {
      harness.keybindings['messageSelector:up']?.()
      await sleep()
      harness.keybindings['messageSelector:select']?.()
      await sleep()

      expect(harness.fileHistoryGetDiffStats).toHaveBeenCalledWith(
        harness.appState.fileHistory,
        selected.uuid,
      )
      expect(harness.logError).toHaveBeenCalledWith(error)
      expect(rendered.output()).toContain('Restore conversation')
      expect(rendered.output()).not.toContain('Restore code')
    } finally {
      await rendered.dispose()
    }
  })

  test('logs rejected preselected diff metadata and renders conversation-only restore', async () => {
    const error = new Error('preselected diff metadata failed')
    harness.fileHistoryGetDiffStats.mockRejectedValueOnce(error)
    const selected = userMessage('user-1', 'preselected missing metadata')
    const rendered = await renderSelector({
      messages: [selected, assistantMessage('assistant-1', 'reply')],
      preselectedMessage: selected,
    })

    try {
      await sleep()

      expect(harness.fileHistoryGetDiffStats).toHaveBeenCalledWith(
        harness.appState.fileHistory,
        selected.uuid,
      )
      expect(harness.logError).toHaveBeenCalledWith(error)
      expect(rendered.output()).toContain('Restore conversation')
      expect(rendered.output()).not.toContain('Restore code')
    } finally {
      await rendered.dispose()
    }
  })

  test('submits summarize-up-to feedback and renders summarize failures', async () => {
    const selected = userMessage('user-1', 'summarize this region')
    const onSummarize = vi.fn(async () => {
      throw new Error('summary failed')
    })
    const rendered = await renderSelector({
      messages: [selected, assistantMessage('assistant-1', 'reply')],
      onSummarize,
      preselectedMessage: selected,
    })

    try {
      await sleep()
      const summarizeUpTo = harness.selectProps?.options.find(
        option => option.value === 'summarize_up_to',
      )
      summarizeUpTo?.onChange?.('keep this decision')
      await sleep()
      harness.selectProps?.onFocus('summarize_up_to')
      harness.selectProps?.onChange('summarize_up_to')
      await sleep()

      expect(onSummarize).toHaveBeenCalledWith(
        selected,
        'keep this decision',
        'up_to',
      )
      expect(harness.logError).toHaveBeenCalledWith(expect.any(Error))
      expect(rendered.output()).toContain('Failed to summarize:')
    } finally {
      await rendered.dispose()
    }
  })
})
