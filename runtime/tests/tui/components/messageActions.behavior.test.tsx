import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { Text } from '../ink.js'
import { createRoot } from '../ink/root.js'
import {
  InVirtualListContext,
  MessageActionsBar,
  MessageActionsKeybindings,
  MessageActionsSelectedContext,
  type MessageActionsNav,
  type MessageActionsState,
  copyTextOf,
  isNavigableMessage,
  stripSystemReminders,
  toolCallOf,
  useMessageActions,
  useSelectedMessageBg,
} from './messageActions.js'

const actionProbe = vi.hoisted(() => ({
  keybindingCalls: [] as Array<{
    handlers: Record<string, () => void>
    options: { context: string; isActive: boolean }
  }>,
}))

vi.mock('../keybindings/useKeybinding.js', () => ({
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context: string; isActive: boolean },
  ) => {
    actionProbe.keybindingCalls.push({ handlers, options })
  },
}))

function userText(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'user',
    uuid: `user-${text}`,
    message: { content: [{ type: 'text', text }] },
    ...extra,
  }
}

function assistantText(text: string) {
  return {
    type: 'assistant',
    uuid: `assistant-${text}`,
    message: { content: [{ type: 'text', text }] },
  }
}

function assistantTool(name: string, input: Record<string, unknown>) {
  return {
    type: 'assistant',
    uuid: `assistant-tool-${name}`,
    message: { content: [{ type: 'tool_use', name, input }] },
  }
}

function attachment(type: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'attachment',
    uuid: `attachment-${type}`,
    attachment: { type, ...extra },
  }
}

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
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  return { stdin, stdout }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for message action state')
}

type CapturedActions = ReturnType<typeof useMessageActions> & {
  cursor: MessageActionsState | null
}

function ActionsHarness({
  caps,
  capture,
  initialCursor,
  nav,
}: {
  caps: Parameters<typeof useMessageActions>[3]
  capture: { current: CapturedActions | null }
  initialCursor: MessageActionsState | null
  nav: MessageActionsNav
}): React.ReactNode {
  const [cursor, setCursor] = React.useState(initialCursor)
  const navRef = React.useRef<MessageActionsNav | null>(nav)
  navRef.current = nav
  const actions = useMessageActions(cursor, setCursor, navRef, caps)
  capture.current = { ...actions, cursor }
  return <Text>{cursor ? `${cursor.msgType}:${cursor.expanded}` : 'none'}</Text>
}

async function renderActionHarness(
  node: React.ReactNode,
  run: () => Promise<void>,
): Promise<string> {
  let output = ''
  const { stdin, stdout } = createStreams()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(node)
    await waitFor(() => output.length > 0)
    await run()
    await new Promise(resolve => setTimeout(resolve, 20))
    return stripAnsi(output)
  } finally {
    root.unmount()
    stdin.end()
  }
}

function toolResult(content: unknown) {
  return {
    type: 'user',
    uuid: 'tool-result',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content }],
    },
  }
}

describe('message action text helpers', () => {
  test('strips leading system-reminder blocks from user-authored text', () => {
    expect(
      stripSystemReminders(
        '  <system-reminder>ignore this</system-reminder>\n<system-reminder>and this</system-reminder>\nactual prompt',
      ),
    ).toBe('actual prompt')

    expect(stripSystemReminders('<system-reminder>unterminated')).toBe(
      '<system-reminder>unterminated',
    )
  })

  test('extracts primary tool-call inputs from assistant and grouped messages', () => {
    expect(toolCallOf(assistantTool('Bash', { command: 'npm test' }) as never)).toEqual({
      name: 'Bash',
      input: { command: 'npm test' },
    })

    const grouped = {
      type: 'grouped_tool_use',
      toolName: 'Agent',
      messages: [
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', input: { prompt: 'fix it' } }] },
        },
      ],
      results: [],
    }

    expect(toolCallOf(grouped as never)).toEqual({
      name: 'Agent',
      input: { prompt: 'fix it' },
    })
    expect(toolCallOf(userText('plain') as never)).toBeUndefined()
  })

  test('extracts all primary input variants used by copy actions', () => {
    expect(copyTextOf(assistantTool('NotebookEdit', { notebook_path: 'nb.ipynb' }) as never)).toBe('nb.ipynb')
    expect(copyTextOf(assistantTool('Grep', { pattern: 'TODO' }) as never)).toBe('TODO')
    expect(copyTextOf(assistantTool('Glob', { pattern: '*.ts' }) as never)).toBe('*.ts')
    expect(copyTextOf(assistantTool('WebFetch', { url: 'https://example.invalid' }) as never)).toBe('https://example.invalid')
    expect(copyTextOf(assistantTool('WebSearch', { query: 'coverage' }) as never)).toBe('coverage')
    expect(copyTextOf(assistantTool('Agent', { prompt: 'inspect' }) as never)).toBe('inspect')
    expect(copyTextOf(assistantTool('Tmux', { args: ['new', '-s', 'dev'] }) as never)).toBe('tmux new -s dev')
    expect(copyTextOf(assistantTool('Tmux', { args: 'bad' }) as never)).toBe('')
  })

  test('copies useful text for each navigable message family', () => {
    expect(
      copyTextOf(
        userText(
          '<system-reminder>hidden</system-reminder>\nvisible user prompt',
        ) as never,
      ),
    ).toBe('visible user prompt')
    expect(copyTextOf(assistantText('assistant answer') as never)).toBe(
      'assistant answer',
    )
    expect(
      copyTextOf(assistantTool('Read', { file_path: '/tmp/file.ts' }) as never),
    ).toBe('/tmp/file.ts')
    expect(copyTextOf(assistantTool('Unknown', { value: 'ignored' }) as never)).toBe('')

    expect(
      copyTextOf({
        type: 'grouped_tool_use',
        results: [
          toolResult('first result'),
          toolResult([{ type: 'text', text: 'second result' }, { type: 'image' }]),
        ],
      } as never),
    ).toBe('first result\n\nsecond result')

    expect(
      copyTextOf({
        type: 'collapsed_read_search',
        messages: [
          toolResult('read result'),
          {
            type: 'grouped_tool_use',
            results: [toolResult([{ type: 'text', text: 'nested result' }])],
          },
          assistantText('ignored assistant'),
        ],
      } as never),
    ).toBe('read result\n\nnested result')

    expect(copyTextOf({ type: 'system', content: 'system content' } as never)).toBe(
      'system content',
    )
    expect(copyTextOf({ type: 'system', error: new Error('bad') } as never)).toBe(
      'Error: bad',
    )
    expect(copyTextOf({ type: 'system', subtype: 'bridge_status' } as never)).toBe(
      'bridge_status',
    )
    expect(
      copyTextOf({
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: 'queued prompt' },
      } as never),
    ).toBe('queued prompt')
    expect(
      copyTextOf({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }],
        },
      } as never),
    ).toBe('one\ntwo')
    expect(
      copyTextOf({
        type: 'attachment',
        attachment: { type: 'diagnostics' },
      } as never),
    ).toBe('[diagnostics]')
  })
})

describe('isNavigableMessage', () => {
  test('accepts meaningful assistant and user messages', () => {
    expect(isNavigableMessage(assistantText('answer') as never)).toBe(true)
    expect(isNavigableMessage(assistantText('') as never)).toBe(false)
    expect(isNavigableMessage({ type: 'assistant', message: { content: [] } } as never)).toBe(false)
    expect(isNavigableMessage(assistantTool('Bash', { command: 'pwd' }) as never)).toBe(true)
    expect(isNavigableMessage(assistantTool('Unknown', {}) as never)).toBe(false)

    expect(isNavigableMessage(userText('real prompt') as never)).toBe(true)
    expect(isNavigableMessage({ type: 'user', message: { content: [{ type: 'image' }] } } as never)).toBe(false)
    expect(isNavigableMessage(userText('meta', { isMeta: true }) as never)).toBe(false)
    expect(isNavigableMessage(userText('summary', { isCompactSummary: true }) as never)).toBe(false)
    expect(
      isNavigableMessage(
        userText('<system-reminder>hidden</system-reminder>\n<command-message>slash</command-message>') as never,
      ),
    ).toBe(false)
  })

  test('filters passive system and attachment messages', () => {
    expect(isNavigableMessage({ type: 'system', subtype: 'bridge_status' } as never)).toBe(true)
    for (const subtype of [
      'api_metrics',
      'stop_hook_summary',
      'turn_duration',
      'memory_saved',
      'agents_killed',
      'away_summary',
      'thinking',
    ]) {
      expect(isNavigableMessage({ type: 'system', subtype } as never)).toBe(false)
    }
    expect(isNavigableMessage({ type: 'grouped_tool_use' } as never)).toBe(true)
    expect(isNavigableMessage({ type: 'collapsed_read_search' } as never)).toBe(true)
    for (const type of [
      'queued_command',
      'diagnostics',
      'hook_blocking_error',
      'hook_error_during_execution',
    ]) {
      expect(isNavigableMessage(attachment(type) as never)).toBe(true)
    }
    expect(isNavigableMessage(attachment('image') as never)).toBe(false)
  })
})

describe('message action UI and hooks', () => {
  test('renders applicable action labels and shared navigation hints', async () => {
    const assistantOutput = await renderToString(
      <MessageActionsBar
        cursor={{
          uuid: 'assistant-tool',
          msgType: 'assistant',
          expanded: false,
          toolName: 'Bash',
        }}
      />,
      100,
    )

    expect(assistantOutput).toContain('c copy')
    expect(assistantOutput).toContain('p copy command')
    expect(assistantOutput).toContain('navigate')
    expect(assistantOutput).toContain('esc back')

    const collapsedOutput = await renderToString(
      <MessageActionsBar
        cursor={{
          uuid: 'collapsed',
          msgType: 'collapsed_read_search',
          expanded: false,
        }}
      />,
      100,
    )
    expect(collapsedOutput).toContain('enter expand')

    const expandedOutput = await renderToString(
      <MessageActionsBar
        cursor={{
          uuid: 'collapsed',
          msgType: 'collapsed_read_search',
          expanded: true,
        }}
      />,
      100,
    )
    expect(expandedOutput).toContain('enter collapse')
  })

  test('registers message action keybindings with the active context', async () => {
    actionProbe.keybindingCalls = []
    const handlers = { 'messageActions:next': vi.fn() }

    await renderToString(
      <MessageActionsKeybindings handlers={handlers} isActive={true} />,
      80,
    )

    expect(actionProbe.keybindingCalls).toContainEqual({
      handlers,
      options: {
        context: 'MessageActions',
        isActive: true,
      },
    })
  })

  test('exposes selected message background only through context', async () => {
    function BgProbe() {
      return <Text>{useSelectedMessageBg() ?? 'none'}</Text>
    }

    await expect(renderToString(<BgProbe />, 80)).resolves.toContain('none')
    await expect(
      renderToString(
        <MessageActionsSelectedContext.Provider value={true}>
          <BgProbe />
        </MessageActionsSelectedContext.Provider>,
        80,
      ),
    ).resolves.toContain('messageActionsBackground')
  })

  test('dispatches navigation, copy-primary, and enter actions from stable handlers', async () => {
    const capture = { current: null as CapturedActions | null }
    const caps = {
      copy: vi.fn(),
      edit: vi.fn(async () => {}),
    }
    const nav = {
      enterCursor: vi.fn(),
      navigatePrev: vi.fn(),
      navigateNext: vi.fn(),
      navigatePrevUser: vi.fn(),
      navigateNextUser: vi.fn(),
      navigateTop: vi.fn(),
      navigateBottom: vi.fn(),
      getSelected: () => assistantTool('Bash', { command: 'npm test' }) as never,
    }

    await renderActionHarness(
      <ActionsHarness
        caps={caps}
        capture={capture}
        initialCursor={{
          uuid: 'assistant-tool',
          msgType: 'assistant',
          expanded: false,
          toolName: 'Bash',
        }}
        nav={nav}
      />,
      async () => {
        await waitFor(() => capture.current !== null)
        capture.current?.enter()
        capture.current?.handlers['messageActions:prev']?.()
        capture.current?.handlers['messageActions:next']?.()
        capture.current?.handlers['messageActions:prevUser']?.()
        capture.current?.handlers['messageActions:nextUser']?.()
        capture.current?.handlers['messageActions:top']?.()
        capture.current?.handlers['messageActions:bottom']?.()
        capture.current?.handlers['messageActions:p']?.()
        capture.current?.handlers['messageActions:p']?.()
      },
    )

    expect(nav.enterCursor).toHaveBeenCalledTimes(1)
    expect(nav.navigatePrev).toHaveBeenCalledTimes(1)
    expect(nav.navigateNext).toHaveBeenCalledTimes(1)
    expect(nav.navigatePrevUser).toHaveBeenCalledTimes(1)
    expect(nav.navigateNextUser).toHaveBeenCalledTimes(1)
    expect(nav.navigateTop).toHaveBeenCalledTimes(1)
    expect(nav.navigateBottom).toHaveBeenCalledTimes(1)
    expect(caps.copy).toHaveBeenCalledWith('npm test')
  })

  test('toggles sticky actions, collapses on escape, clears on ctrl-c, and edits users', async () => {
    const collapsedCapture = { current: null as CapturedActions | null }
    const caps = {
      copy: vi.fn(),
      edit: vi.fn(async () => {}),
    }
    const nav = {
      enterCursor: vi.fn(),
      navigatePrev: vi.fn(),
      navigateNext: vi.fn(),
      navigatePrevUser: vi.fn(),
      navigateNextUser: vi.fn(),
      navigateTop: vi.fn(),
      navigateBottom: vi.fn(),
      getSelected: () => ({
        type: 'collapsed_read_search',
        messages: [],
        uuid: 'collapsed',
      }) as never,
    }

    await renderActionHarness(
      <ActionsHarness
        caps={caps}
        capture={collapsedCapture}
        initialCursor={{
          uuid: 'collapsed',
          msgType: 'collapsed_read_search',
          expanded: false,
        }}
        nav={nav}
      />,
      async () => {
        await waitFor(() => collapsedCapture.current !== null)
        collapsedCapture.current?.handlers['messageActions:enter']?.()
        await waitFor(() => collapsedCapture.current?.cursor?.expanded === true)
        collapsedCapture.current?.handlers['messageActions:escape']?.()
        await waitFor(() => collapsedCapture.current?.cursor?.expanded === false)
        collapsedCapture.current?.handlers['messageActions:ctrlc']?.()
        await waitFor(() => collapsedCapture.current?.cursor === null)
      },
    )

    const userCapture = { current: null as CapturedActions | null }
    await renderActionHarness(
      <ActionsHarness
        caps={caps}
        capture={userCapture}
        initialCursor={{
          uuid: 'user',
          msgType: 'user',
          expanded: false,
        }}
        nav={{
          ...nav,
          getSelected: () => userText('edit me') as never,
        }}
      />,
      async () => {
        await waitFor(() => userCapture.current !== null)
        userCapture.current?.handlers['messageActions:enter']?.()
      },
    )

    expect(caps.edit).toHaveBeenCalledWith(userText('edit me'))
  })
})
