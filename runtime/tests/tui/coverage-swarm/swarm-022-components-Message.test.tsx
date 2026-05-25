import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; props: Record<string, unknown> }>,
  columns: 12,
  features: new Set<string>(),
  fullscreen: false,
  logError: vi.fn(),
  reset() {
    harness.calls = []
    harness.columns = 12
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
  useTerminalSize: () => ({ columns: harness.columns, rows: 24 }),
}))

vi.mock('../../services/compact/snipProjection.js', () => ({
  isSnipBoundaryMessage: (message: { readonly subtype?: string }) =>
    message.subtype === 'snip_boundary',
}))

vi.mock('../../services/compact/snipCompact.js', () => ({
  isSnipMarkerMessage: (message: { readonly subtype?: string }) =>
    message.subtype === 'snip_marker',
}))

vi.mock('../message-renderers/SnipBoundaryMessage.js', () => ({
  SnipBoundaryMessage: (props: Record<string, unknown>) => {
    harness.calls.push({ name: 'SnipBoundaryMessage', props })
    return null
  },
}))

vi.mock('../components/Message.renderers.js', async () => {
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
    OffscreenFreeze: ({ children }: { readonly children?: React.ReactNode }) => {
      harness.calls.push({ name: 'OffscreenFreeze', props: {} })
      return ReactModule.createElement(ReactModule.Fragment, null, children)
    },
    SystemTextMessage: renderer('SystemTextMessage'),
    UserImageMessage: renderer('UserImageMessage'),
    UserTextMessage: renderer('UserTextMessage'),
    UserToolResultMessage: renderer('UserToolResultMessage'),
  }
})

import { Box } from '../ink.js'
import { createRoot } from '../ink/root.js'
import type { Props } from '../components/Message.js'
import {
  getToolResultMessageWidth,
  Message,
} from '../components/Message.js'

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

async function createMessageRoot(
  messages: Array<Props['message']>,
  overrides: Partial<Props> = {},
): Promise<{
  render: () => void
  dispose: () => Promise<void>
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  const messageProps = messages.map(message => ({
    ...baseProps(message),
    ...overrides,
    message,
  }))

  const render = () => {
    root.render(
      <Box flexDirection="column">
        {messageProps.map(props => (
          <Message
            key={props.message.uuid}
            {...props}
          />
        ))}
      </Box>,
    )
  }

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    render,
  }
}

async function renderMessages(
  messages: Array<Props['message']>,
  overrides: Partial<Props> = {},
): Promise<{ dispose: () => Promise<void> }> {
  const mounted = await createMessageRoot(messages, overrides)
  mounted.render()
  await sleep()
  return { dispose: mounted.dispose }
}

describe('Message coverage swarm row 022', () => {
  beforeEach(() => {
    harness.reset()
  })

  test('routes user continuation, transcript summary, fallback image ids, and narrow tool result widths', async () => {
    harness.columns = 3

    const messages = [
      {
        isCompactSummary: true,
        message: { content: [{ text: 'summary', type: 'text' }] },
        type: 'user',
        uuid: 'compact-summary',
      },
      {
        message: {
          content: [
            {
              source: { data: 'abc', media_type: 'image/png', type: 'base64' },
              type: 'image',
            },
            { content: 'done', tool_use_id: 'tool-1', type: 'tool_result' },
            { type: 'unknown_user_block' },
          ],
        },
        type: 'user',
        uuid: 'user-continuation',
      },
    ] as Array<Props['message']>

    const rendered = await renderMessages(messages, {
      isTranscriptMode: true,
      isUserContinuation: true,
      latestBashOutputUUID: 'other-user',
    })

    try {
      expect(getToolResultMessageWidth(0)).toBe(1)
      expect(harness.calls.find(call => call.name === 'CompactSummary')?.props).toMatchObject({
        screen: 'transcript',
      })
      expect(harness.calls.find(call => call.name === 'UserImageMessage')?.props).toMatchObject({
        addMargin: false,
        imageId: 1,
      })
      expect(
        harness.calls.find(call => call.name === 'UserToolResultMessage')?.props,
      ).toMatchObject({ width: 1 })
      expect(harness.calls.some(call => call.name === 'ExpandShellOutputProvider')).toBe(
        false,
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('routes compact, snip, local command, and text system messages', async () => {
    harness.features.add('HISTORY_SNIP')

    const messages = [
      { subtype: 'compact_boundary', type: 'system', uuid: 'compact-boundary' },
      { subtype: 'snip_boundary', type: 'system', uuid: 'snip-boundary' },
      { subtype: 'snip_marker', type: 'system', uuid: 'snip-marker' },
      {
        content: 'local command',
        subtype: 'local_command',
        type: 'system',
        uuid: 'local-command',
      },
      { content: 'system text', subtype: 'notice', type: 'system', uuid: 'system-text' },
    ] as Array<Props['message']>

    const mounted = await createMessageRoot(messages)

    try {
      mounted.render()
      await sleep()

      expect(harness.calls.map(call => call.name)).toEqual(
        expect.arrayContaining([
          'CompactBoundaryMessage',
          'SnipBoundaryMessage',
          'UserTextMessage',
          'SystemTextMessage',
        ]),
      )
      expect(harness.calls.some(call => call.props.message === messages[2])).toBe(false)

      expect(harness.calls.filter(call => call.name === 'UserTextMessage')).toHaveLength(1)
      expect(harness.calls.filter(call => call.name === 'SystemTextMessage')).toHaveLength(1)
    } finally {
      await mounted.dispose()
    }
  })

  test('routes connector fallback, thinking blocks, advisor blocks, and non-advisor server tool errors', async () => {
    harness.features.add('CONNECTOR_TEXT')

    const assistant = {
      advisorModel: 'reviewer-model',
      message: {
        content: [
          { connector_text: 'from connector', type: 'connector_text' },
          { text: 'regular text', type: 'text' },
          { id: 'tool-live', input: { command: 'pwd' }, name: 'Bash', type: 'tool_use' },
          { data: 'hidden', type: 'redacted_thinking' },
          { thinking: 'visible thinking', type: 'thinking' },
          { id: 'advisor-1', input: {}, name: 'advisor', type: 'server_tool_use' },
          { id: 'external-1', input: {}, name: 'web_search', type: 'server_tool_use' },
          { type: 'unknown_assistant_block' },
        ],
      },
      type: 'assistant',
      uuid: 'assistant-assorted',
    } as Props['message']

    const mounted = await createMessageRoot([assistant], {
      isTranscriptMode: true,
      lastThinkingBlockId: 'assistant-assorted:4',
      verbose: false,
    })

    try {
      mounted.render()
      await sleep()

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
        harness.calls.find(
          call =>
            call.name === 'AssistantTextMessage' &&
            (call.props.param as { text?: string }).text === 'from connector',
        )?.props,
      ).toMatchObject({ param: { text: 'from connector', type: 'text' } })
      expect(
        harness.calls.find(call => call.name === 'AssistantThinkingMessage')?.props,
      ).toMatchObject({ hideInTranscript: false })
      expect(harness.calls.find(call => call.name === 'AdvisorMessage')?.props).toMatchObject({
        advisorModel: 'reviewer-model',
        verbose: true,
      })
      expect(
        harness.logError.mock.calls.map(([error]) => (error as Error).message),
      ).toEqual(
        expect.arrayContaining([
          'Unable to render server tool block: server_tool_use',
          'Unable to render message type: unknown_assistant_block',
        ]),
      )

      expect(harness.calls.filter(call => call.name === 'AssistantTextMessage')).toHaveLength(
        2,
      )
      expect(harness.calls.filter(call => call.name === 'AssistantThinkingMessage')).toHaveLength(
        1,
      )
    } finally {
      await mounted.dispose()
    }
  })

  test('derives collapsed read search verbosity from transcript mode when verbose is false', async () => {
    const collapsed = {
      messages: [],
      type: 'collapsed_read_search',
      uuid: 'collapsed-search',
    } as Props['message']

    const transcriptRender = await renderMessages([collapsed], {
      isActiveCollapsedGroup: true,
      isTranscriptMode: true,
      verbose: false,
    })

    try {
      expect(
        harness.calls.find(call => call.name === 'CollapsedReadSearchContent')?.props,
      ).toMatchObject({
        isActiveGroup: true,
        verbose: true,
      })
    } finally {
      await transcriptRender.dispose()
    }

    harness.reset()

    const promptRender = await renderMessages([collapsed], {
      isTranscriptMode: false,
      verbose: false,
    })

    try {
      expect(
        harness.calls.find(call => call.name === 'CollapsedReadSearchContent')?.props,
      ).toMatchObject({
        isActiveGroup: undefined,
        verbose: false,
      })
    } finally {
      await promptRender.dispose()
    }
  })
})
