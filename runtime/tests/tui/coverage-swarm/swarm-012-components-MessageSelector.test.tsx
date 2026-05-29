import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

type CapturedSelectProps = {
  defaultFocusValue?: string
  isDisabled?: boolean
  onCancel: () => void
  onChange: (value: string) => void | Promise<void>
  onFocus: (value: string) => void
  options: Array<{
    label: string
    onChange?: (value: string) => void
    value: string
  }>
}

const harness = vi.hoisted(() => ({
  appState: { fileHistory: { entries: [] } },
  canRestore: true,
  columns: 80,
  diffStats: {
    deletions: 1,
    filesChanged: ['/tmp/alpha.ts', '/tmp/beta.ts'],
    insertions: 2,
  },
  exitPending: false,
  fileHistoryEnabled: true,
  keybindings: {} as Record<string, () => unknown>,
  logError: vi.fn(),
  selectProps: null as CapturedSelectProps | null,
  reset() {
    harness.canRestore = true
    harness.columns = 80
    harness.diffStats = {
      deletions: 1,
      filesChanged: ['/tmp/alpha.ts', '/tmp/beta.ts'],
      insertions: 2,
    }
    harness.exitPending = false
    harness.fileHistoryEnabled = true
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
  fileHistoryCanRestore: () => harness.canRestore,
  fileHistoryEnabled: () => harness.fileHistoryEnabled,
  fileHistoryGetDiffStats: vi.fn(async () => harness.diffStats),
}))

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
}))

vi.mock('src/tui/hooks/useExitOnCtrlCDWithKeybindings.js', () => ({
  useExitOnCtrlCDWithKeybindings: () => ({
    keyName: 'ctrl+c',
    pending: harness.exitPending,
  }),
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: harness.columns, rows: 24 }),
}))

vi.mock('../keybindings/useKeybinding.js', () => ({
  useKeybinding: (name: string, handler: () => unknown) => {
    harness.keybindings[name] = handler
  },
  useKeybindings: (handlers: Record<string, () => unknown>) => {
    Object.assign(harness.keybindings, handlers)
  },
}))

vi.mock('../components/spinner/Spinner.js', async () => {
  const { Text } = await import('../ink.js')

  return {
    Spinner: () => React.createElement(Text, null, 'spin'),
  }
})

vi.mock('../components/CustomSelect/select', async () => {
  const { Text } = await import('../ink.js')

  return {
    Select: (props: CapturedSelectProps) => {
      harness.selectProps = props

      return React.createElement(
        React.Fragment,
        null,
        props.options.map(option =>
          React.createElement(Text, { key: option.value }, option.label),
        ),
      )
    },
  }
})

import { createRoot } from '../ink/root.js'
import type { Message, UserMessage } from '../../types/message.js'
import {
  buildMessageSelectorFileHistoryMetadata,
  computeMessageOptionTextWidth,
  MessageSelector,
  messagesAfterAreOnlySynthetic,
} from '../components/MessageSelector.js'

function userMessage(
  uuid: string,
  text: string,
  overrides: Partial<UserMessage> = {},
): UserMessage {
  return {
    message: { content: [{ text, type: 'text' }] },
    timestamp: '2026-05-20T00:00:00.000Z',
    type: 'user',
    uuid,
    ...overrides,
  } as UserMessage
}

function userStringMessage(uuid: string, content: string): UserMessage {
  return userMessage(uuid, '', {
    message: { content },
  } as Partial<UserMessage>)
}

function assistantMessage(uuid: string, text: string): Message {
  return {
    message: { content: [{ text, type: 'text' }] },
    type: 'assistant',
    uuid,
  } as Message
}

function toolResultMessage(uuid: string, toolUseResult?: unknown): Message {
  return {
    message: {
      content: [{ content: 'done', tool_use_id: uuid, type: 'tool_result' }],
    },
    toolUseResult,
    type: 'user',
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output().includes(expected)) return
    await sleep(10)
  }

  throw new Error(`Timed out waiting for output: ${expected}`)
}

async function waitForSelectOption(value: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (harness.selectProps?.options.some(option => option.value === value)) {
      return
    }
    await sleep(10)
  }

  throw new Error(`Timed out waiting for option: ${value}`)
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

describe('MessageSelector coverage-swarm row 012', () => {
  beforeEach(() => {
    harness.reset()
  })

  test('covers metadata edge cases and synthetic tail fallthroughs', () => {
    expect(computeMessageOptionTextWidth(12, -4)).toBe(12)

    const first = userMessage('user-1', 'restore from here')
    const current = userMessage('current-message', '')
    const metadata = buildMessageSelectorFileHistoryMetadata({
      canRestoreMessage: () => true,
      currentUUID: current.uuid as never,
      fileHistory: {} as never,
      isFileHistoryEnabled: true,
      messageOptions: [first, current],
      messages: [
        first,
        toolResultMessage('edit-1', {
          filePath: '/tmp/reused.ts',
          structuredPatch: [{ lines: ['+one', '-old'] }],
        }),
        toolResultMessage('edit-2', {
          filePath: '/tmp/reused.ts',
          structuredPatch: [{ lines: ['+two'] }],
        }),
        toolResultMessage('bad-edit', {
          filePath: '/tmp/bad.ts',
          structuredPatch: [{}],
        }),
      ],
    })

    expect(metadata[first.uuid]).toEqual({
      deletions: 1,
      filesChanged: ['/tmp/reused.ts', '/tmp/bad.ts'],
      insertions: 2,
    })
    expect(
      messagesAfterAreOnlySynthetic(
        [
          first,
          undefined,
          {
            message: { content: [] },
            type: 'tombstone',
            uuid: 'tombstone-message',
          },
        ] as never,
        0,
      ),
    ).toBe(true)
  })

  test('selecting the virtual current prompt closes without restore', async () => {
    const onClose = vi.fn()
    const rendered = await renderSelector({
      messages: [userMessage('user-1', 'previous prompt')],
      onClose,
    })

    try {
      harness.keybindings['messageSelector:select']?.()
      await sleep()

      expect(onClose).toHaveBeenCalledTimes(1)
      expect(rendered.output()).toContain('(current)')
    } finally {
      await rendered.dispose()
    }
  })

  test('shows direct conversation restore failures when file history is disabled', async () => {
    harness.fileHistoryEnabled = false
    const selected = userMessage('user-1', 'restore this conversation')
    const onClose = vi.fn()
    const onPreRestore = vi.fn()
    const onRestoreMessage = vi.fn(async () => {
      throw new Error('conversation exploded')
    })
    const rendered = await renderSelector({
      messages: [selected, assistantMessage('assistant-1', 'reply')],
      onClose,
      onPreRestore,
      onRestoreMessage,
    })

    try {
      harness.keybindings['messageSelector:up']?.()
      await sleep()
      harness.keybindings['messageSelector:select']?.()
      await waitForOutput(rendered.output, 'Failed to restore the conversation:')

      expect(onPreRestore).toHaveBeenCalledTimes(1)
      expect(onRestoreMessage).toHaveBeenCalledWith(selected)
      expect(onClose).not.toHaveBeenCalled()
      expect(harness.logError).toHaveBeenCalledWith(expect.any(Error))
      expect(rendered.output()).toContain('conversation exploded')
    } finally {
      await rendered.dispose()
    }
  })

  test('backs out of non-preselected confirmation via escape and nevermind', async () => {
    harness.diffStats = {
      deletions: 0,
      filesChanged: [],
      insertions: 0,
    }
    const selected = userMessage('user-1', 'restore candidate')
    const onClose = vi.fn()
    const rendered = await renderSelector({
      messages: [selected, assistantMessage('assistant-1', 'reply')],
      onClose,
    })

    try {
      harness.keybindings['messageSelector:up']?.()
      await sleep()
      harness.keybindings['messageSelector:select']?.()
      await waitForSelectOption('nevermind')

      harness.keybindings['confirm:no']?.()
      await sleep()
      expect(onClose).not.toHaveBeenCalled()
      expect(rendered.output()).toContain('Restore the code and/or conversation')

      harness.keybindings['messageSelector:select']?.()
      await waitForSelectOption('nevermind')
      await harness.selectProps?.onChange('nevermind')
      await sleep()

      expect(onClose).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('submits summarize-from without feedback while the spinner is visible', async () => {
    const selected = userMessage('user-1', 'summarize from here')
    const onClose = vi.fn()
    const onPreRestore = vi.fn()
    let finishSummarize: (() => void) | undefined
    const onSummarize = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishSummarize = resolve
        }),
    )
    const rendered = await renderSelector({
      messages: [selected, assistantMessage('assistant-1', 'reply')],
      onClose,
      onPreRestore,
      onSummarize,
      preselectedMessage: selected,
    })

    try {
      await waitForSelectOption('summarize')
      const summarize = harness.selectProps?.options.find(
        option => option.value === 'summarize',
      )
      summarize?.onChange?.('   ')

      const pendingChange = harness.selectProps?.onChange('summarize')
      await waitForOutput(rendered.output, 'Summarizing')

      expect(onPreRestore).toHaveBeenCalledTimes(1)
      expect(onSummarize).toHaveBeenCalledWith(selected, undefined, 'from')

      finishSummarize?.()
      await pendingChange
      await sleep()

      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      finishSummarize?.()
      await rendered.dispose()
    }
  })

  test('reports combined code and conversation restore failures', async () => {
    const selected = userMessage('user-1', 'restore both')
    const onClose = vi.fn()
    const onRestoreCode = vi.fn(async () => {
      throw new Error('code failed')
    })
    const onRestoreMessage = vi.fn(async () => {
      throw new Error('conversation failed')
    })
    const rendered = await renderSelector({
      messages: [selected, assistantMessage('assistant-1', 'reply')],
      onClose,
      onRestoreCode,
      onRestoreMessage,
      preselectedMessage: selected,
    })

    try {
      await waitForSelectOption('both')
      await harness.selectProps?.onChange('both')
      await waitForOutput(
        rendered.output,
        'Failed to restore the conversation and code:',
      )

      expect(onRestoreCode).toHaveBeenCalledWith(selected)
      expect(onRestoreMessage).toHaveBeenCalledWith(selected)
      expect(onClose).not.toHaveBeenCalled()
      expect(harness.logError).toHaveBeenCalledTimes(2)
    } finally {
      await rendered.dispose()
    }
  })

  test('renders pick-list file metadata, no-change metadata, and pending exit copy', async () => {
    harness.exitPending = true
    const first = userMessage('user-1', 'first prompt')
    const second = userMessage('user-2', 'second prompt')
    const rendered = await renderSelector({
      messages: [
        first,
        toolResultMessage('edit-1', {
          filePath: '/tmp/one.ts',
          structuredPatch: [{ lines: ['+new', '-old'] }],
        }),
        second,
      ],
    })

    try {
      await waitForOutput(rendered.output, 'No code changes')

      expect(rendered.output()).toContain('one.ts')
      expect(rendered.output()).toContain('+1')
      expect(rendered.output()).toContain('-1')
      expect(rendered.output()).toContain('No code changes')
      expect(rendered.output()).toContain('Press ctrl+c again to exit')
    } finally {
      await rendered.dispose()
    }
  })

  test('renders command message variants and empty preselected prompts', async () => {
    harness.fileHistoryEnabled = false
    const slashCommand = userMessage(
      'user-1',
      '<command-message>deploy</command-message><command-args>prod</command-args>',
    )
    const skillCommand = userMessage(
      'user-2',
      '<command-message>review</command-message><skill-format>true</skill-format>',
    )
    const commands = await renderSelector({
      messages: [slashCommand, skillCommand],
    })

    try {
      expect(commands.output()).toContain('/deploy prod')
      expect(commands.output()).toContain('$review')
    } finally {
      await commands.dispose()
    }

    const empty = userStringMessage('empty-message', '    ')
    const emptyRendered = await renderSelector({
      messages: [empty, userMessage('valid-message', 'valid prompt')],
      preselectedMessage: empty,
    })

    try {
      await waitForOutput(emptyRendered.output, 'The conversation will be forked.')
      expect(emptyRendered.output()).toContain('Restore conversation')
    } finally {
      await emptyRendered.dispose()
    }
  })

  test('renders no-file and many-file restore descriptions', async () => {
    const selected = userMessage('user-1', 'restore code')
    harness.diffStats = {
      deletions: 0,
      filesChanged: [''],
      insertions: 0,
    }
    const noFile = await renderSelector({
      messages: [selected, assistantMessage('assistant-1', 'reply')],
      preselectedMessage: selected,
    })

    try {
      await waitForOutput(noFile.output, 'nothing will be restored')
      expect(noFile.output()).toContain('The code has not changed')
    } finally {
      await noFile.dispose()
    }

    harness.diffStats = {
      deletions: 3,
      filesChanged: ['/tmp/first.ts', '/tmp/second.ts', '/tmp/third.ts'],
      insertions: 7,
    }
    const manyFiles = await renderSelector({
      messages: [selected, assistantMessage('assistant-1', 'reply')],
      preselectedMessage: selected,
    })

    try {
      await waitForOutput(manyFiles.output, 'first.ts and 2 other files')
      expect(manyFiles.output()).toContain('first.ts and 2 other files')
    } finally {
      await manyFiles.dispose()
    }
  })
})
