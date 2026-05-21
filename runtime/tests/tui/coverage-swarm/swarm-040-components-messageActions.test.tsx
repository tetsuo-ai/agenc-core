import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, describe, expect, test, vi } from 'vitest'

const probes = vi.hoisted(() => ({
  keybindingCalls: [] as Array<{
    handlers: Record<string, () => void>
    options: { context: string; isActive: boolean }
  }>,
  logEvent: vi.fn(),
}))

vi.mock('../keybindings/useKeybinding.js', () => ({
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context: string; isActive: boolean },
  ) => {
    probes.keybindingCalls.push({ handlers, options })
  },
}))

vi.mock('../../services/analytics/index', () => ({
  logEvent: probes.logEvent,
}))

import { Text } from '../ink.js'
import { createRoot, type Root } from '../ink/root.js'
import {
  MessageActionsBar,
  MessageActionsKeybindings,
  MessageActionsSelectedContext,
  type MessageActionCaps,
  type MessageActionsNav,
  type MessageActionsState,
  type NavigableMessage,
  copyTextOf,
  isNavigableMessage,
  stripSystemReminders,
  toolCallOf,
  useMessageActions,
  useSelectedMessageBg,
} from '../components/messageActions.js'

function createStreams(): {
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as ReturnType<typeof createStreams>['stdin']
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = 120
  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function createInkRoot(): Promise<{
  dispose: () => Promise<void>
  output: () => string
  root: Root
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

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    output: () => stripAnsi(output),
    root,
  }
}

function userText(text: string, extra: Record<string, unknown> = {}): NavigableMessage {
  return {
    type: 'user',
    uuid: `user-${text}`,
    message: { content: [{ type: 'text', text }] },
    ...extra,
  } as never
}

function assistantText(text: string): NavigableMessage {
  return {
    type: 'assistant',
    uuid: `assistant-${text}`,
    message: { content: [{ type: 'text', text }] },
  } as never
}

function assistantTool(
  name: string,
  input: Record<string, unknown>,
): NavigableMessage {
  return {
    type: 'assistant',
    uuid: `assistant-tool-${name}`,
    message: { content: [{ type: 'tool_use', name, input }] },
  } as never
}

function toolResult(content: unknown): NavigableMessage {
  return {
    type: 'user',
    uuid: 'tool-result',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content }],
    },
  } as never
}

function navWithSelected(selected: NavigableMessage | null): MessageActionsNav {
  return {
    enterCursor: vi.fn(),
    getSelected: vi.fn(() => selected),
    navigateBottom: vi.fn(),
    navigateNext: vi.fn(),
    navigateNextUser: vi.fn(),
    navigatePrev: vi.fn(),
    navigatePrevUser: vi.fn(),
    navigateTop: vi.fn(),
  }
}

type CapturedActions = ReturnType<typeof useMessageActions> & {
  cursor: MessageActionsState | null
  setCursor: React.Dispatch<React.SetStateAction<MessageActionsState | null>>
}

async function renderActionsHarness({
  caps,
  capture,
  initialCursor,
  nav,
}: {
  caps: MessageActionCaps
  capture: { current: CapturedActions | null }
  initialCursor: MessageActionsState | null
  nav: { current: MessageActionsNav | null }
}): Promise<{
  dispose: () => Promise<void>
}> {
  const rendered = await createInkRoot()

  function Harness(): React.ReactNode {
    const [cursor, setCursor] =
      React.useState<MessageActionsState | null>(initialCursor)
    const actions = useMessageActions(cursor, setCursor, nav, caps)
    capture.current = { ...actions, cursor, setCursor }
    return <Text>{cursor ? `${cursor.uuid}:${cursor.expanded}` : 'none'}</Text>
  }

  rendered.root.render(<Harness />)
  await sleep()

  return {
    dispose: rendered.dispose,
  }
}

describe('swarm 040 message action helpers', () => {
  afterEach(() => {
    probes.keybindingCalls = []
    vi.clearAllMocks()
  })

  test('classifies less common actionable and filtered message shapes', () => {
    expect(isNavigableMessage(assistantText('No response requested.'))).toBe(false)
    expect(isNavigableMessage(assistantTool('Read', { file_path: 123 }))).toBe(true)
    expect(isNavigableMessage(assistantTool('Unknown', { file_path: 'x' }))).toBe(false)

    expect(isNavigableMessage(userText('No response requested.'))).toBe(false)
    expect(
      isNavigableMessage(
        userText(
          '<system-reminder>hidden</system-reminder>\n<local-command-stdout>generated</local-command-stdout>',
        ),
      ),
    ).toBe(false)
    expect(isNavigableMessage(userText('kept prompt'))).toBe(true)

    expect(isNavigableMessage({ type: 'system', subtype: undefined } as never)).toBe(true)
    expect(
      isNavigableMessage({
        type: 'attachment',
        attachment: { type: 'hook_blocking_error' },
      } as never),
    ).toBe(true)
    expect(
      isNavigableMessage({
        type: 'attachment',
        attachment: { type: 'image' },
      } as never),
    ).toBe(false)
  })

  test('extracts tool calls and copy text for sparse payload variants', () => {
    expect(stripSystemReminders('  visible')).toBe('visible')
    expect(stripSystemReminders('<system-reminder>open')).toBe('<system-reminder>open')

    expect(toolCallOf(assistantText('plain'))).toBeUndefined()
    expect(
      toolCallOf({
        type: 'grouped_tool_use',
        toolName: 'Task',
        messages: [
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'not a tool' }] },
          },
        ],
      } as never),
    ).toBeUndefined()
    expect(
      toolCallOf({
        type: 'grouped_tool_use',
        toolName: 'Task',
        messages: [
          {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', input: { prompt: 'delegate' } }] },
          },
        ],
      } as never),
    ).toEqual({ name: 'Task', input: { prompt: 'delegate' } })

    expect(copyTextOf({ type: 'user', message: { content: [{ type: 'image' }] } } as never)).toBe('')
    expect(copyTextOf(assistantTool('Edit', { file_path: 'edited.ts' }))).toBe('edited.ts')
    expect(copyTextOf(assistantTool('Write', { file_path: 'written.ts' }))).toBe('written.ts')
    expect(copyTextOf(assistantTool('Task', { prompt: 'summarize' }))).toBe('summarize')
    expect(copyTextOf(assistantTool('Read', { file_path: 99 }))).toBe('')

    expect(
      copyTextOf({
        type: 'grouped_tool_use',
        results: [
          toolResult(undefined),
          { type: 'user', message: { content: [{ type: 'text', text: 'ignored' }] } },
          toolResult([{ type: 'image' }, { type: 'text', text: 'visible block' }]),
        ],
      } as never),
    ).toBe('visible block')

    expect(
      copyTextOf({
        type: 'collapsed_read_search',
        messages: [
          toolResult('direct result'),
          { type: 'assistant', message: { content: [{ type: 'text', text: 'ignored' }] } },
          {
            type: 'grouped_tool_use',
            results: [toolResult(null), toolResult([{ type: 'text', text: 'nested result' }])],
          },
        ],
      } as never),
    ).toBe('direct result\n\nnested result')

    expect(
      copyTextOf({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: [{ type: 'image' }, { type: 'text', text: 'typed command' }],
        },
      } as never),
    ).toBe('typed command')
    expect(copyTextOf({ type: 'attachment', attachment: { type: 'hook_error_during_execution' } } as never)).toBe(
      '[hook_error_during_execution]',
    )
  })
})

describe('swarm 040 message action rendering', () => {
  test('renders action bars across memoized and changed cursors', async () => {
    const rendered = await createInkRoot()
    const cursor: MessageActionsState = {
      expanded: false,
      msgType: 'system',
      uuid: 'system-message',
    }

    try {
      rendered.root.render(<MessageActionsBar cursor={cursor} />)
      await sleep()
      rendered.root.render(<MessageActionsBar cursor={cursor} />)
      await sleep()
      rendered.root.render(
        <MessageActionsBar
          cursor={{
            expanded: true,
            msgType: 'attachment',
            uuid: 'attachment-message',
          }}
        />,
      )
      await sleep()

      const output = rendered.output()
      expect(output).toContain('enter expand')
      expect(output).toContain('enter collapse')
      expect(output).toContain('c copy')
      expect(output).toContain('navigate')
      expect(output).toContain('esc back')
    } finally {
      await rendered.dispose()
    }
  })

  test('memoizes keybinding options until active state changes', async () => {
    const rendered = await createInkRoot()
    const handlers = { 'messageActions:next': vi.fn() }

    try {
      rendered.root.render(
        <MessageActionsKeybindings handlers={handlers} isActive={true} />,
      )
      await sleep()
      rendered.root.render(
        <MessageActionsKeybindings handlers={handlers} isActive={true} />,
      )
      await sleep()
      rendered.root.render(
        <MessageActionsKeybindings handlers={handlers} isActive={false} />,
      )
      await sleep()

      expect(probes.keybindingCalls).toHaveLength(3)
      expect(probes.keybindingCalls[0]?.options).toEqual({
        context: 'MessageActions',
        isActive: true,
      })
      expect(probes.keybindingCalls[1]?.options).toBe(
        probes.keybindingCalls[0]?.options,
      )
      expect(probes.keybindingCalls[2]?.options).toEqual({
        context: 'MessageActions',
        isActive: false,
      })
      expect(probes.keybindingCalls[2]?.options).not.toBe(
        probes.keybindingCalls[0]?.options,
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('reads selected background only from its context', async () => {
    function BgProbe(): React.ReactNode {
      return <Text>{useSelectedMessageBg() ?? 'none'}</Text>
    }

    const rendered = await createInkRoot()

    try {
      rendered.root.render(<BgProbe />)
      await sleep()
      rendered.root.render(
        <MessageActionsSelectedContext.Provider value={true}>
          <BgProbe />
        </MessageActionsSelectedContext.Provider>,
      )
      await sleep()

      expect(rendered.output()).toContain('none')
      expect(rendered.output()).toContain('messageActionsBackground')
    } finally {
      await rendered.dispose()
    }
  })
})

describe('swarm 040 useMessageActions', () => {
  test('keeps handlers stable while dispatching current cursor, nav, and caps', async () => {
    const capture = { current: null as CapturedActions | null }
    const nav = { current: null as MessageActionsNav | null }
    const caps: MessageActionCaps = {
      copy: vi.fn(),
      edit: vi.fn(async () => {}),
    }
    const rendered = await renderActionsHarness({
      caps,
      capture,
      initialCursor: null,
      nav,
    })

    try {
      const handlers = capture.current?.handlers
      expect(handlers).toBeDefined()

      capture.current?.enter()
      expect(probes.logEvent).toHaveBeenCalledWith(
        'tengu_message_actions_enter',
        {},
      )

      expect(() => {
        handlers?.['messageActions:prev']()
        handlers?.['messageActions:next']()
        handlers?.['messageActions:top']()
        handlers?.['messageActions:bottom']()
        handlers?.['messageActions:c']()
      }).not.toThrow()
      expect(caps.copy).not.toHaveBeenCalled()

      capture.current?.setCursor({
        expanded: false,
        msgType: 'system',
        uuid: 'sticky-system',
      })
      await sleep()
      handlers?.['messageActions:enter']()
      await sleep()
      expect(capture.current?.cursor).toMatchObject({ expanded: true })

      handlers?.['messageActions:escape']()
      await sleep()
      expect(capture.current?.cursor).toMatchObject({ expanded: false })

      capture.current?.setCursor({
        expanded: false,
        msgType: 'assistant',
        toolName: 'Unknown',
        uuid: 'unknown-tool',
      })
      await sleep()
      handlers?.['messageActions:p']()
      await sleep()
      expect(capture.current?.cursor).toMatchObject({ uuid: 'unknown-tool' })

      nav.current = navWithSelected(null)
      capture.current?.setCursor({
        expanded: false,
        msgType: 'user',
        uuid: 'missing-selected',
      })
      await sleep()
      handlers?.['messageActions:enter']()
      await sleep()
      expect(capture.current?.cursor).toMatchObject({ uuid: 'missing-selected' })

      nav.current = navWithSelected(assistantText('not a tool'))
      capture.current?.setCursor({
        expanded: false,
        msgType: 'assistant',
        toolName: 'Bash',
        uuid: 'primary-without-tool-call',
      })
      await sleep()
      handlers?.['messageActions:p']()
      await sleep()
      expect(caps.copy).not.toHaveBeenCalled()
      expect(capture.current?.cursor).toBeNull()

      nav.current = navWithSelected(assistantTool('Read', { file_path: 42 }))
      capture.current?.setCursor({
        expanded: false,
        msgType: 'assistant',
        toolName: 'Read',
        uuid: 'primary-empty-value',
      })
      await sleep()
      handlers?.['messageActions:p']()
      await sleep()
      expect(caps.copy).not.toHaveBeenCalled()
      expect(capture.current?.cursor).toBeNull()

      nav.current = navWithSelected(assistantText('copy from selected'))
      capture.current?.setCursor({
        expanded: false,
        msgType: 'assistant',
        uuid: 'copy-selected',
      })
      await sleep()
      handlers?.['messageActions:c']()
      await sleep()
      expect(caps.copy).toHaveBeenCalledWith('copy from selected')
      expect(capture.current?.cursor).toBeNull()

      handlers?.['messageActions:ctrlc']()
      await sleep()
      expect(capture.current?.cursor).toBeNull()
    } finally {
      await rendered.dispose()
    }
  })
})
