import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; props: Record<string, unknown> }>,
  features: new Set<string>(),
  fullscreen: false,
  logError: vi.fn(),
  reset() {
    harness.calls = []
    harness.features = new Set()
    harness.fullscreen = false
    harness.logError.mockClear()
  },
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.features.has(name),
}))

vi.mock('../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => harness.fullscreen,
}))

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 12, rows: 24 }),
}))

vi.mock('../../services/compact/snipProjection.js', () => ({
  isSnipBoundaryMessage: (message: { readonly subtype?: string }) =>
    message.subtype === 'snip_boundary',
}))

vi.mock('../../services/compact/snipCompact.js', () => ({
  isSnipMarkerMessage: (message: { readonly subtype?: string }) =>
    message.subtype === 'snip_marker',
}))

vi.mock('../message-renderers/SnipBoundaryMessage.js', async () => {
  return {
    SnipBoundaryMessage: (props: Record<string, unknown>) => {
      harness.calls.push({ name: 'SnipBoundaryMessage', props })
      return null
    },
  }
})

vi.mock('./Message.renderers.js', async () => {
  const ReactModule = await import('react')
  const renderer = (name: string) => (props: Record<string, unknown>) => {
    harness.calls.push({ name, props })
    return null
  }
  return {
    AdvisorMessage: renderer('AdvisorMessage'),
    AssistantRedactedThinkingMessage: renderer('AssistantRedactedThinkingMessage'),
    AssistantTextMessage: renderer('AssistantTextMessage'),
    AssistantThinkingMessage: renderer('AssistantThinkingMessage'),
    AssistantToolUseMessage: renderer('AssistantToolUseMessage'),
    AttachmentMessage: renderer('AttachmentMessage'),
    CollapsedReadSearchContent: renderer('CollapsedReadSearchContent'),
    CompactBoundaryMessage: renderer('CompactBoundaryMessage'),
    CompactSummary: renderer('CompactSummary'),
    ExpandShellOutputProvider: ({
      children,
    }: {
      readonly children?: React.ReactNode
    }) => {
      harness.calls.push({ name: 'ExpandShellOutputProvider', props: {} })
      return ReactModule.createElement(ReactModule.Fragment, null, children)
    },
    GroupedToolUseContent: renderer('GroupedToolUseContent'),
    OffscreenFreeze: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    SystemTextMessage: renderer('SystemTextMessage'),
    UserImageMessage: renderer('UserImageMessage'),
    UserTextMessage: renderer('UserTextMessage'),
    UserToolResultMessage: renderer('UserToolResultMessage'),
  }
})

import { createRoot } from '../ink/root.js'
import { Box } from '../ink.js'
import { ContentWidthProvider } from '../context/contentWidthContext.js'
import type { Props } from './Message.js'
import { Message } from './Message.js'

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

function baseProps(message: Props['message']): Props {
  return {
    addMargin: true,
    commands: [],
    inProgressToolUseIDs: new Set(['tool-live']),
    isStatic: false,
    isTranscriptMode: false,
    lookups: {
      erroredToolUseIDs: new Set(['tool-error']),
      resolvedToolUseIDs: new Set(['tool-ok']),
    },
    message,
    progressMessagesForMessage: [],
    shouldAnimate: true,
    shouldShowDot: true,
    tools: [] as never,
    verbose: true,
  } as Props
}

async function renderMessages(
  messages: Array<Props['message']>,
  overrides: Partial<Props> = {},
): Promise<{
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
    <Box flexDirection="column">
      {messages.map(message => (
        <Message
          key={message.uuid}
          {...baseProps(message)}
          {...overrides}
          message={message}
        />
      ))}
    </Box>,
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

describe('Message render dispatch', () => {
  beforeEach(() => {
    harness.reset()
  })

  test('routes attachment, user, system, grouped, and collapsed messages to their renderers', async () => {
    const user = {
      imagePasteIds: ['paste-1'],
      message: {
        content: [
          { text: 'hello', type: 'text' },
          { source: { data: 'abc', media_type: 'image/png', type: 'base64' }, type: 'image' },
          { content: 'done', tool_use_id: 'tool-1', type: 'tool_result' },
        ],
      },
      type: 'user',
      uuid: 'user-1',
    } as Props['message']
    const messages = [
      {
        attachment: { message: 'diagnostic', type: 'diagnostics' },
        type: 'attachment',
        uuid: 'attachment-1',
      },
      user,
      {
        isCompactSummary: true,
        message: { content: [{ text: 'summary', type: 'text' }] },
        type: 'user',
        uuid: 'compact-summary',
      },
      { subtype: 'compact_boundary', type: 'system', uuid: 'compact-boundary' },
      { content: 'local command', subtype: 'local_command', type: 'system', uuid: 'local-command' },
      { content: 'system text', subtype: 'notice', type: 'system', uuid: 'system-text' },
      {
        messages: [],
        toolName: 'Agent',
        type: 'grouped_tool_use',
        uuid: 'grouped-tool',
      },
      {
        messages: [],
        type: 'collapsed_read_search',
        uuid: 'collapsed-search',
      },
    ] as Array<Props['message']>

    const rendered = await renderMessages(messages, {
      latestBashOutputUUID: 'user-1',
    })

    try {
      expect(harness.calls.map(call => call.name)).toEqual(
        expect.arrayContaining([
          'ExpandShellOutputProvider',
          'AttachmentMessage',
          'UserTextMessage',
          'UserImageMessage',
          'UserToolResultMessage',
          'CompactSummary',
          'CompactBoundaryMessage',
          'SystemTextMessage',
          'GroupedToolUseContent',
          'CollapsedReadSearchContent',
        ]),
      )
      expect(
        harness.calls.find(call => call.name === 'UserToolResultMessage')?.props,
      ).toMatchObject({ width: 7 })
    } finally {
      await rendered.dispose()
    }
  })

  test('sizes user tool results from the message content width', async () => {
    const user = {
      message: {
        content: [
          { content: 'done', tool_use_id: 'tool-1', type: 'tool_result' },
        ],
      },
      type: 'user',
      uuid: 'user-content-width',
    } as Props['message']

    const rendered = await renderMessages([user], {
      containerWidth: 54,
    })

    try {
      expect(
        harness.calls.find(call => call.name === 'UserToolResultMessage')?.props,
      ).toMatchObject({ width: 49 })
    } finally {
      await rendered.dispose()
    }
  })

  test('falls back to inherited content width for user tool results', async () => {
    const user = {
      message: {
        content: [
          { content: 'done', tool_use_id: 'tool-1', type: 'tool_result' },
        ],
      },
      type: 'user',
      uuid: 'user-inherited-width',
    } as Props['message']

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

    try {
      root.render(
        <ContentWidthProvider width={63}>
          <Message {...baseProps(user)} message={user} />
        </ContentWidthProvider>,
      )
      await sleep()

      expect(stripAnsi(output)).toBeDefined()
      expect(
        harness.calls.find(call => call.name === 'UserToolResultMessage')?.props,
      ).toMatchObject({ width: 58 })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })

  test('routes assistant block variants and logs unknown block types', async () => {
    const assistant = {
      advisorModel: 'reviewer-model',
      message: {
        content: [
          { text: 'assistant text', type: 'text' },
          { id: 'tool-live', input: { command: 'pwd' }, name: 'Bash', type: 'tool_use' },
          { data: 'hidden', type: 'redacted_thinking' },
          { thinking: 'working', type: 'thinking' },
          { id: 'advisor-1', input: {}, name: 'advisor', type: 'server_tool_use' },
          {
            content: { text: 'advisor result', type: 'advisor_result' },
            tool_use_id: 'advisor-1',
            type: 'advisor_tool_result',
          },
          { type: 'unknown_block' },
        ],
      },
      type: 'assistant',
      uuid: 'assistant-1',
    } as Props['message']

    const rendered = await renderMessages([assistant], {
      isTranscriptMode: true,
      lastThinkingBlockId: 'assistant-1:99',
    })

    try {
      expect(harness.calls.map(call => call.name)).toEqual(
        expect.arrayContaining([
          'AssistantTextMessage',
          'AssistantToolUseMessage',
          'AssistantRedactedThinkingMessage',
          'AssistantThinkingMessage',
          'AdvisorMessage',
        ]),
      )
      expect(
        harness.calls.find(call => call.name === 'AssistantThinkingMessage')?.props,
      ).toMatchObject({ hideInTranscript: true })
      expect(harness.logError).toHaveBeenCalledWith(expect.any(Error))
      expect(harness.calls.some(call => call.name === 'AdvisorMessage')).toBe(true)
    } finally {
      await rendered.dispose()
    }
  })

  test('uses the connector-text feature branch when enabled', async () => {
    harness.features.add('CONNECTOR_TEXT')
    const messages = [
      {
        message: {
          content: [{ connector_text: 'from connector', type: 'connector_text' }],
        },
        type: 'assistant',
        uuid: 'assistant-connector',
      },
    ] as Array<Props['message']>

    const rendered = await renderMessages(messages)

    try {
      expect(harness.calls.map(call => call.name)).toEqual(
        expect.arrayContaining(['AssistantTextMessage']),
      )
      expect(
        harness.calls.find(call => call.name === 'AssistantTextMessage')?.props,
      ).toMatchObject({ param: { text: 'from connector', type: 'text' } })
    } finally {
      await rendered.dispose()
    }
  })

  test('suppresses fullscreen compact boundaries and non-verbose thinking blocks', async () => {
    harness.fullscreen = true
    const messages = [
      { subtype: 'compact_boundary', type: 'system', uuid: 'compact-boundary' },
      { subtype: 'microcompact_boundary', type: 'system', uuid: 'micro-boundary' },
      {
        message: {
          content: [
            { data: 'hidden', type: 'redacted_thinking' },
            { thinking: 'hidden', type: 'thinking' },
          ],
        },
        type: 'assistant',
        uuid: 'assistant-hidden-thinking',
      },
    ] as Array<Props['message']>

    const rendered = await renderMessages(messages, {
      verbose: false,
    })

    try {
      expect(harness.calls).toEqual([])
      expect(rendered.output()).not.toContain('CompactBoundaryMessage')
      expect(rendered.output()).not.toContain('AssistantThinkingMessage')
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores unknown top-level message types defensively', async () => {
    const rendered = await renderMessages([
      { type: 'future_message_type', uuid: 'future-message' },
    ] as Array<Props['message']>)

    try {
      expect(harness.calls).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })
})
