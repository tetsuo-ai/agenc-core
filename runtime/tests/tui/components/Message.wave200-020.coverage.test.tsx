import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; props: Record<string, unknown> }>,
  reset() {
    harness.calls = []
  },
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => false,
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 24, rows: 12 }),
}))

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
    isTranscriptMode: true,
    latestBashOutputUUID: 'user-cache',
    lookups: {
      erroredToolUseIDs: new Set(['advisor-error']),
      resolvedToolUseIDs: new Set(['advisor-1']),
    },
    message,
    progressMessagesForMessage: [],
    shouldAnimate: true,
    shouldShowDot: true,
    tools: [] as never,
    verbose: true,
    width: 44,
  } as Props
}

describe('Message compiler cache reuse', () => {
  test('reuses cached child elements when stable message props render again', async () => {
    harness.reset()

    const messages = [
      {
        attachment: { message: 'diagnostic', type: 'diagnostics' },
        type: 'attachment',
        uuid: 'attachment-cache',
      },
      {
        message: {
          content: [
            { text: 'prompt text', type: 'text' },
            {
              source: { data: 'abc', media_type: 'image/png', type: 'base64' },
              type: 'image',
            },
            { content: 'tool result', tool_use_id: 'tool-live', type: 'tool_result' },
          ],
        },
        type: 'user',
        uuid: 'user-cache',
      },
      {
        message: {
          content: [
            { text: 'assistant text', type: 'text' },
            { id: 'tool-live', input: { command: 'pwd' }, name: 'Bash', type: 'tool_use' },
            { data: 'hidden', type: 'redacted_thinking' },
            { thinking: 'visible thinking', type: 'thinking' },
            { id: 'advisor-1', input: {}, name: 'advisor', type: 'server_tool_use' },
          ],
        },
        advisorModel: 'advisor-model',
        type: 'assistant',
        uuid: 'assistant-cache',
      },
      { content: 'local command', subtype: 'local_command', type: 'system', uuid: 'local-cache' },
      { content: 'system text', subtype: 'notice', type: 'system', uuid: 'system-cache' },
      {
        messages: [],
        toolName: 'Agent',
        type: 'grouped_tool_use',
        uuid: 'grouped-cache',
      },
      {
        messages: [],
        type: 'collapsed_read_search',
        uuid: 'collapsed-cache',
      },
    ] as Array<Props['message']>
    const props = messages.map(message => baseProps(message))

    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    const renderStableMessages = () => (
      <Box flexDirection="column">
        {props.map(messageProps => (
          <Message key={messageProps.message.uuid} {...messageProps} />
        ))}
      </Box>
    )

    try {
      root.render(renderStableMessages())
      await sleep()

      const firstCallNames = harness.calls.map(call => call.name)
      expect(firstCallNames).toEqual(
        expect.arrayContaining([
          'AttachmentMessage',
          'ExpandShellOutputProvider',
          'UserTextMessage',
          'UserImageMessage',
          'UserToolResultMessage',
          'AssistantTextMessage',
          'AssistantToolUseMessage',
          'AssistantRedactedThinkingMessage',
          'AssistantThinkingMessage',
          'AdvisorMessage',
          'SystemTextMessage',
          'GroupedToolUseContent',
          'OffscreenFreeze',
          'CollapsedReadSearchContent',
        ]),
      )

      const callCountAfterFirstRender = harness.calls.length
      root.render(renderStableMessages())
      await sleep()

      expect(harness.calls).toHaveLength(callCountAfterFirstRender)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
