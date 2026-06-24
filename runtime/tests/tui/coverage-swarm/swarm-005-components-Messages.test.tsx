import { PassThrough } from 'node:stream'
import type { ReactNode } from 'react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  rows: [] as Array<{
    canAnimate: boolean
    hasContentAfter: boolean
    isUserContinuation: boolean
    lastThinkingBlockId: string | null
    latestBashOutputUUID: string | null
    type: string
    uuid: string
    verbose: boolean
  }>,
  dividers: [] as string[],
  features: new Set<string>(),
  hasContentAfterIndexResult: false,
  msgMarkers: [] as Array<{ label: string; role: string }>,
  progress: vi.fn(),
  streamingMarkdown: [] as string[],
  thinkingMessages: [] as string[],
  virtualCalls: [] as Array<{
    extractSearchText: (message: unknown) => string
    isItemClickable: (message: unknown) => boolean
    isItemExpanded: (message: unknown) => boolean
    messages: unknown[]
    onItemClick: (message: unknown) => void
    selectedIndex: number | undefined
  }>,
  reset() {
    harness.rows = []
    harness.dividers = []
    harness.features = new Set()
    harness.hasContentAfterIndexResult = false
    harness.msgMarkers = []
    harness.progress.mockClear()
    harness.streamingMarkdown = []
    harness.thinkingMessages = []
    harness.virtualCalls = []
  },
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.features.has(name),
}))

vi.mock('../../../src/bootstrap/state.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    flushInteractionTime: () => {},
    getActiveTimeCounter: () => null,
    getAllowedSettingSources: () => [],
    getFlagSettingsInline: () => null,
    getFlagSettingsPath: () => undefined,
    getIsRemoteMode: () => false,
  }
})

vi.mock('../../../src/tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 48, rows: 24 }),
}))

vi.mock('../../../src/tui/keybindings/useShortcutDisplay.js', () => ({
  useShortcutDisplay: () => 'Ctrl+E',
}))

vi.mock('../../../src/tui/ink/useTerminalNotification.js', async () => {
  const ReactModule = await import('react')
  const TerminalWriteContext = ReactModule.createContext<((data: string) => void) | null>(null)
  return {
    TerminalWriteContext,
    TerminalWriteProvider: TerminalWriteContext.Provider,
    useTerminalNotification: () => ({ progress: harness.progress }),
  }
})

vi.mock('../../../src/utils/config.js', () => ({
  getGlobalConfig: () => ({ terminalProgressBarEnabled: true }),
}))

vi.mock('../../../src/utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => false,
}))

vi.mock('../../../src/tui/startup/StatusNotices.js', () => ({
  StatusNotices: () => null,
}))

vi.mock('../../../src/tui/components/OffscreenFreeze.js', () => ({
  OffscreenFreeze: ({ children }: { readonly children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}))

vi.mock('../../../src/tui/components/v2/primitives.js', async () => {
  const { Text } = await import('../../../src/tui/ink.js')
  return {
    WelcomeColdPanel: () => React.createElement(Text, null, 'welcome'),
    Msg: ({
      role,
      label,
      children,
    }: {
      readonly role: string
      readonly label: string
      readonly children?: ReactNode
    }) => {
      harness.msgMarkers.push({ label, role })
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(Text, null, `▮ ${label.toUpperCase()}`),
        children,
      )
    },
  }
})

vi.mock('../../../src/tui/components/design-system/Divider.js', async () => {
  const { Text } = await import('../../../src/tui/ink.js')
  return {
    Divider: ({ title }: { readonly title: string }) => {
      harness.dividers.push(title)
      return React.createElement(Text, null, `divider:${title}`)
    },
  }
})

vi.mock('../../../src/tui/components/markdown/Markdown.js', async () => {
  const { Text } = await import('../../../src/tui/ink.js')
  return {
    StreamingMarkdown: ({ children }: { readonly children?: ReactNode }) => {
      harness.streamingMarkdown.push(String(children ?? ''))
      return React.createElement(Text, null, children)
    },
  }
})

vi.mock('../../../src/tui/components/v2/messagePrimitives.js', async () => {
  const { Text } = await import('../../../src/tui/ink.js')
  return {
    ThinkingMessage: ({
      param,
    }: {
      readonly param: { readonly thinking: string }
    }) => {
      harness.thinkingMessages.push(param.thinking)
      return React.createElement(Text, null, `thinking:${param.thinking}`)
    },
  }
})

vi.mock('../../../src/tui/components/MessageRow.js', async () => {
  const { Text } = await import('../../../src/tui/ink.js')
  return {
    hasContentAfterIndex: vi.fn(() => harness.hasContentAfterIndexResult),
    MessageRow: (props: {
      readonly canAnimate: boolean
      readonly hasContentAfter: boolean
      readonly isUserContinuation: boolean
      readonly lastThinkingBlockId?: string | null
      readonly latestBashOutputUUID?: string | null
      readonly message: { readonly type: string; readonly uuid: string }
      readonly verbose: boolean
    }) => {
      harness.rows.push({
        canAnimate: props.canAnimate,
        hasContentAfter: props.hasContentAfter,
        isUserContinuation: props.isUserContinuation,
        lastThinkingBlockId: props.lastThinkingBlockId ?? null,
        latestBashOutputUUID: props.latestBashOutputUUID ?? null,
        type: props.message.type,
        uuid: props.message.uuid,
        verbose: props.verbose,
      })
      return React.createElement(Text, null, `row:${props.message.uuid}`)
    },
  }
})

vi.mock('../../../src/tui/components/VirtualMessageList.js', async () => {
  const { Text } = await import('../../../src/tui/ink.js')
  return {
    VirtualMessageList: (props: {
      readonly extractSearchText: (message: unknown) => string
      readonly isItemClickable: (message: unknown) => boolean
      readonly isItemExpanded: (message: unknown) => boolean
      readonly messages: unknown[]
      readonly onItemClick: (message: unknown) => void
      readonly renderItem: (message: unknown, index: number) => ReactNode
      readonly selectedIndex?: number
    }) => {
      harness.virtualCalls.push({
        extractSearchText: props.extractSearchText,
        isItemClickable: props.isItemClickable,
        isItemExpanded: props.isItemExpanded,
        messages: props.messages,
        onItemClick: props.onItemClick,
        selectedIndex: props.selectedIndex,
      })
      const children = props.messages.flatMap((message, index) => {
        const rendered = props.renderItem(message, index)
        return Array.isArray(rendered) ? rendered : [rendered]
      })
      return React.createElement(
        React.Fragment,
        null,
        ...children,
        React.createElement(Text, null, `virtual:${props.messages.length}`),
      )
    },
  }
})

import { createRoot } from '../../../src/tui/ink/root.js'
import type { Tools } from '../../../src/tools/Tool.js'
import { Messages } from '../../../src/tui/components/Messages.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

function createStreams(): {
  stdin: TestStdin
  stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin
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

async function render(node: ReactNode): Promise<{
  dispose: () => Promise<void>
  rerender: (next: ReactNode) => Promise<void>
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  root.render(node)
  await sleep()
  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    rerender: async next => {
      root.render(next)
      await sleep()
    },
  }
}

const commands = []
const emptyQueue = []
const emptyTools = [] as unknown as Tools

const baseProps = {
  commands,
  conversationId: 'swarm-005',
  inProgressToolUseIDs: new Set<string>(),
  isLoading: false,
  isMessageSelectorVisible: false,
  messages: [],
  screen: 'main' as const,
  streamingToolUses: [],
  toolJSX: null,
  toolUseConfirmQueue: emptyQueue,
  tools: emptyTools,
  verbose: false,
}

function user(uuid: string, text: string) {
  return {
    message: { content: [{ text, type: 'text' }] },
    type: 'user',
    uuid,
  }
}

function assistantToolUse(uuid: string, id: string, name = 'Read') {
  return {
    message: {
      content: [{ id, input: { file_path: 'src/example.ts' }, name, type: 'tool_use' }],
    },
    type: 'assistant',
    uuid,
  }
}

function userToolResult(uuid: string, toolUseID: string, toolUseResult: unknown) {
  return {
    message: {
      content: [{ content: 'done', tool_use_id: toolUseID, type: 'tool_result' }],
    },
    toolUseResult,
    type: 'user',
    uuid,
  }
}

function latestVirtualCall() {
  const call = harness.virtualCalls.at(-1)
  expect(call).toBeDefined()
  return call!
}

describe('Messages coverage swarm row 005', () => {
  beforeEach(() => {
    harness.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('renders virtual rows with selection, dividers, streaming output, and derived row props', async () => {
    const messages = [
      user('bash-output', '<bash-stdout>ok'),
      user('next-user', 'next prompt'),
      assistantToolUse('tool-use-row', 'tool-read'),
      userToolResult('tool-result-row', 'tool-read', { text: 'done' }),
    ]
    const rendered = await render(
      <Messages
        {...baseProps}
        cursor={{ expanded: true, uuid: 'next-user' }}
        hidePastThinking={true}
        messages={messages}
        scrollRef={{ current: null }}
        streamingText="streaming answer"
        streamingThinking={{
          isStreaming: true,
          streamingEndedAt: 100,
          thinking: 'still thinking',
        }}
        toolJSX={{ jsx: null, shouldHidePromptInput: false }}
        unseenDivider={{ count: 1, firstUnseenUuid: 'next-user' }}
      />,
    )

    try {
      expect(harness.rows.map(row => row.uuid)).toContain('next-user')
      const nextUserRow = harness.rows.find(row => row.uuid === 'next-user')
      expect(nextUserRow).toMatchObject({
        canAnimate: false,
        isUserContinuation: true,
        lastThinkingBlockId: 'streaming',
        latestBashOutputUUID: 'bash-output',
        verbose: true,
      })
      expect(latestVirtualCall().selectedIndex).toBe(1)
      expect(harness.dividers).toContain('1 new message')
      expect(harness.streamingMarkdown).toContain('streaming answer')
      // The live (most-recent, still-streaming) assistant turn must carry the
      // same `▮ AGENC` identity marker as historical/settled turns, so the same
      // assistant message never flips between two identity markers across the
      // streaming→settled transition. Revert-sensitive: if the streaming render
      // falls back to a bare `●` marker (no Msg wrapper), this is empty.
      expect(harness.msgMarkers).toContainEqual({ label: 'agenc', role: 'agenc' })
      expect(harness.thinkingMessages).toContain('still thinking')
      expect(harness.progress).toHaveBeenCalledWith('completed')
    } finally {
      await rendered.dispose()
    }
  })

  test('classifies virtual-list click targets and caches tool-owned search text', async () => {
    const extractSearchText = vi.fn(() => 'Needle From Tool')
    const isResultTruncated = vi.fn(() => true)
    const tools = [
      {
        extractSearchText,
        isResultTruncated,
        name: 'Read',
      },
    ] as unknown as Tools
    const rendered = await render(
      <Messages
        {...baseProps}
        messages={[
          assistantToolUse('tool-use-row', 'tool-read'),
          userToolResult('tool-result-row', 'tool-read', { lines: 200 }),
        ]}
        scrollRef={{ current: null }}
        tools={tools}
      />,
    )

    try {
      const virtual = latestVirtualCall()
      const toolResultMessage = {
        message: {
          content: [{ tool_use_id: 'tool-read', type: 'tool_result' }],
        },
        toolUseResult: { lines: 200 },
        type: 'user',
        uuid: 'manual-tool-result',
      }

      expect(
        virtual.isItemClickable({ messages: [], type: 'collapsed_read_search', uuid: 'collapsed' }),
      ).toBe(true)
      expect(
        virtual.isItemClickable({
          message: {
            content: [
              {
                content: { text: 'ok', type: 'advisor_result' },
                tool_use_id: 'advisor-1',
                type: 'advisor_tool_result',
              },
            ],
          },
          type: 'assistant',
          uuid: 'advisor-result',
        }),
      ).toBe(true)
      expect(
        virtual.isItemClickable({
          message: {
            content: [
              {
                content: { encrypted_content: 'hidden', type: 'advisor_redacted_result' },
                tool_use_id: 'advisor-1',
                type: 'advisor_tool_result',
              },
            ],
          },
          type: 'assistant',
          uuid: 'advisor-redacted-result',
        }),
      ).toBe(false)
      expect(
        virtual.isItemClickable({
          message: { content: [{ text: 'plain', type: 'text' }] },
          type: 'assistant',
          uuid: 'assistant-text',
        }),
      ).toBe(false)
      expect(
        virtual.isItemClickable({
          message: {
            content: [{ is_error: true, tool_use_id: 'tool-read', type: 'tool_result' }],
          },
          toolUseResult: { lines: 200 },
          type: 'user',
          uuid: 'errored-result',
        }),
      ).toBe(false)
      expect(virtual.isItemClickable(toolResultMessage)).toBe(true)
      expect(isResultTruncated).toHaveBeenCalledWith({ lines: 200 })

      expect(virtual.extractSearchText(toolResultMessage)).toBe('needle from tool')
      expect(virtual.extractSearchText(toolResultMessage)).toBe('needle from tool')
      expect(extractSearchText).toHaveBeenCalledTimes(1)

      const expandableMessage = virtual.messages[0]!
      expect(virtual.isItemExpanded(expandableMessage)).toBe(false)
      virtual.onItemClick(expandableMessage)
      await sleep()
      expect(latestVirtualCall().isItemExpanded(expandableMessage)).toBe(true)
      latestVirtualCall().onItemClick(expandableMessage)
      await sleep()
      expect(latestVirtualCall().isItemExpanded(expandableMessage)).toBe(false)
    } finally {
      await rendered.dispose()
    }
  })

  test('renders transcript indicators for truncated and expanded histories', async () => {
    const manyMessages = Array.from({ length: 35 }, (_, index) =>
      user(`message-${index}`, `message ${index}`),
    )
    const truncated = await render(
      <Messages
        {...baseProps}
        messages={manyMessages}
        screen="transcript"
      />,
    )

    try {
      expect(harness.dividers.some(title => title.includes('to show 5 previous messages'))).toBe(true)
    } finally {
      await truncated.dispose()
    }

    harness.rows = []
    harness.dividers = []
    const expanded = await render(
      <Messages
        {...baseProps}
        messages={manyMessages}
        screen="transcript"
        showAllInTranscript={true}
      />,
    )

    try {
      expect(harness.dividers.some(title => title.includes('to hide 5 previous messages'))).toBe(true)
      expect(harness.rows).toHaveLength(35)
    } finally {
      await expanded.dispose()
    }
  })

  test('memoizes semantically equal collection props but rerenders changed streaming thinking', async () => {
    const contentBlock = {
      id: 'stream-tool',
      input: { command: 'pwd' },
      name: 'Read',
      type: 'tool_use',
    }
    const messages = [user('stable-user', 'hello')]
    const makeProps = () => ({
      ...baseProps,
      inProgressToolUseIDs: new Set(['stream-tool']),
      messages,
      onOpenRateLimitOptions: vi.fn(),
      streamingThinking: null,
      streamingToolUses: [{ contentBlock }],
      tools: [{ name: 'Read' }] as unknown as Tools,
      unseenDivider: { count: 2, firstUnseenUuid: 'missing' },
    })

    const rendered = await render(<Messages {...makeProps()} />)

    try {
      const rowCount = harness.rows.length
      await rendered.rerender(<Messages {...makeProps()} />)
      expect(harness.rows).toHaveLength(rowCount)

      await rendered.rerender(
        <Messages
          {...makeProps()}
          streamingThinking={{
            isStreaming: true,
            streamingEndedAt: 200,
            thinking: 'new thought',
          }}
        />,
      )
      expect(harness.rows.length).toBeGreaterThan(rowCount)
      expect(harness.thinkingMessages).toContain('new thought')
    } finally {
      await rendered.dispose()
    }
  })
})
