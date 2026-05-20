import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const analytics = vi.hoisted(() => ({
  logEvent: vi.fn(),
}))

vi.mock('../../services/analytics/index', () => ({
  logEvent: analytics.logEvent,
}))

import { createRoot } from '../ink/root.js'
import {
  type MessageActionCaps,
  type MessageActionsNav,
  type MessageActionsState,
  type NavigableMessage,
  useMessageActions,
} from './messageActions.js'

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

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

function assistantText(text: string): NavigableMessage {
  return {
    type: 'assistant',
    uuid: `assistant-${text}`,
    message: { content: [{ type: 'text', text }] },
  } as never
}

function userText(text: string): NavigableMessage {
  return {
    type: 'user',
    uuid: `user-${text}`,
    message: { content: [{ type: 'text', text }] },
  } as never
}

async function renderHookHarness(initialCursor: MessageActionsState): Promise<{
  caps: MessageActionCaps
  cursor: () => MessageActionsState | null
  dispose: () => Promise<void>
  handlers: () => ReturnType<typeof useMessageActions>
  nav: MessageActionsNav
  setCursor: (next: MessageActionsState | null) => Promise<void>
}> {
  let currentCursor: MessageActionsState | null = initialCursor
  let latest: ReturnType<typeof useMessageActions> | undefined
  let setCursorExternal:
    | React.Dispatch<React.SetStateAction<MessageActionsState | null>>
    | undefined

  const caps = {
    copy: vi.fn(),
    edit: vi.fn(async () => {}),
  } satisfies MessageActionCaps
  const nav = {
    enterCursor: vi.fn(),
    getSelected: vi.fn(() => null),
    navigateBottom: vi.fn(),
    navigateNext: vi.fn(),
    navigateNextUser: vi.fn(),
    navigatePrev: vi.fn(),
    navigatePrevUser: vi.fn(),
    navigateTop: vi.fn(),
  } satisfies MessageActionsNav
  const navRef = { current: nav }
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    const [cursor, setCursor] =
      React.useState<MessageActionsState | null>(initialCursor)
    currentCursor = cursor
    setCursorExternal = setCursor
    latest = useMessageActions(cursor, setCursor, navRef, caps)
    return null
  }

  root.render(<Harness />)
  await sleep()

  return {
    caps,
    cursor: () => currentCursor,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    handlers: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    nav,
    setCursor: async next => {
      if (setCursorExternal === undefined) {
        throw new Error('hook setter did not render')
      }
      setCursorExternal(next)
      await sleep()
    },
  }
}

describe('useMessageActions coverage', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  test('dispatches navigation and message action handlers from the current cursor', async () => {
    const rendered = await renderHookHarness({
      expanded: false,
      msgType: 'grouped_tool_use',
      toolName: 'Agent',
      uuid: 'grouped-agent',
    })

    try {
      rendered.handlers().enter()
      expect(analytics.logEvent).toHaveBeenCalledTimes(1)
      expect(rendered.nav.enterCursor).toHaveBeenCalledTimes(1)

      rendered.handlers().handlers['messageActions:prev']()
      rendered.handlers().handlers['messageActions:next']()
      rendered.handlers().handlers['messageActions:prevUser']()
      rendered.handlers().handlers['messageActions:nextUser']()
      rendered.handlers().handlers['messageActions:top']()
      rendered.handlers().handlers['messageActions:bottom']()
      expect(rendered.nav.navigatePrev).toHaveBeenCalledTimes(1)
      expect(rendered.nav.navigateNext).toHaveBeenCalledTimes(1)
      expect(rendered.nav.navigatePrevUser).toHaveBeenCalledTimes(1)
      expect(rendered.nav.navigateNextUser).toHaveBeenCalledTimes(1)
      expect(rendered.nav.navigateTop).toHaveBeenCalledTimes(1)
      expect(rendered.nav.navigateBottom).toHaveBeenCalledTimes(1)

      rendered.handlers().handlers['messageActions:enter']()
      await sleep()
      expect(rendered.cursor()).toMatchObject({ expanded: true })

      rendered.handlers().handlers['messageActions:escape']()
      await sleep()
      expect(rendered.cursor()).toMatchObject({ expanded: false })

      rendered.handlers().handlers['messageActions:p']()
      await sleep()
      expect(rendered.cursor()).toMatchObject({ expanded: false })

      rendered.handlers().handlers['messageActions:escape']()
      await sleep()
      expect(rendered.cursor()).toBeNull()

      rendered.handlers().handlers['messageActions:c']()
      expect(rendered.caps.copy).not.toHaveBeenCalled()

      await rendered.setCursor({
        expanded: false,
        msgType: 'assistant',
        toolName: 'Tmux',
        uuid: 'assistant-tmux',
      })
      rendered.nav.getSelected = vi.fn(() =>
        assistantTool('Tmux', { args: ['list-sessions', '-F', '#S'] }),
      )
      rendered.handlers().handlers['messageActions:p']()
      await sleep()
      expect(rendered.caps.copy).toHaveBeenLastCalledWith(
        'tmux list-sessions -F #S',
      )
      expect(rendered.cursor()).toBeNull()

      await rendered.setCursor({
        expanded: false,
        msgType: 'assistant',
        toolName: 'Bash',
        uuid: 'assistant-without-selection',
      })
      rendered.nav.getSelected = vi.fn(() => null)
      rendered.handlers().handlers['messageActions:p']()
      await sleep()
      expect(rendered.cursor()).toMatchObject({
        uuid: 'assistant-without-selection',
      })

      await rendered.setCursor({
        expanded: false,
        msgType: 'assistant',
        uuid: 'assistant-copy',
      })
      rendered.nav.getSelected = vi.fn(() => assistantText('answer text'))
      rendered.handlers().handlers['messageActions:c']()
      await sleep()
      expect(rendered.caps.copy).toHaveBeenLastCalledWith('answer text')
      expect(rendered.cursor()).toBeNull()

      await rendered.setCursor({
        expanded: false,
        msgType: 'user',
        uuid: 'user-edit',
      })
      rendered.nav.getSelected = vi.fn(() => userText('edit me'))
      rendered.handlers().handlers['messageActions:enter']()
      await sleep()
      expect(rendered.caps.edit).toHaveBeenCalledWith(userText('edit me'))
      expect(rendered.cursor()).toBeNull()

      await rendered.setCursor({
        expanded: false,
        msgType: 'system',
        uuid: 'system-no-primary',
      })
      rendered.handlers().handlers['messageActions:p']()
      await sleep()
      expect(rendered.cursor()).toMatchObject({ uuid: 'system-no-primary' })

      rendered.handlers().handlers['messageActions:ctrlc']()
      await sleep()
      expect(rendered.cursor()).toBeNull()
    } finally {
      await rendered.dispose()
    }
  })
})
