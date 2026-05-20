import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test } from 'vitest'

import Text from '../ink/components/Text.js'
import { createRoot } from '../ink/root.js'
import type { Key } from '../ink.js'
import { parseBindings } from './parser.js'
import {
  KeybindingProvider,
  useKeybindingContext,
  useOptionalKeybindingContext,
  useRegisterKeybindingContext,
} from './KeybindingContext.js'
import type { KeybindingContextName, ParsedKeystroke } from './types.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: TestStdin
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 80
  ;(stdout as unknown as { rows: number }).rows = 24
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true

  return { stdout, stdin }
}

function key(overrides: Partial<Key> = {}): Key {
  return {
    backspace: false,
    ctrl: false,
    delete: false,
    downArrow: false,
    end: false,
    escape: false,
    fn: false,
    home: false,
    leftArrow: false,
    meta: false,
    pageDown: false,
    pageUp: false,
    return: false,
    rightArrow: false,
    shift: false,
    super: false,
    tab: false,
    upArrow: false,
    wheelDown: false,
    wheelUp: false,
    ...overrides,
  } as Key
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(message)
}

function OptionalProbe({ seen }: { seen: unknown[] }): React.ReactNode {
  seen.push(useOptionalKeybindingContext())
  return <Text>optional</Text>
}

function ActiveProbe({
  events,
}: {
  events: string[]
}): React.ReactNode {
  useRegisterKeybindingContext('Chat')
  const ctx = useKeybindingContext()

  React.useEffect(() => {
    events.push(ctx.getDisplayText('chat:submit', 'Chat') ?? 'missing-display')
    const resolved = ctx.resolve('x', key({ ctrl: true }), ['Chat'])
    events.push(resolved.type)
    if (resolved.type === 'chord_started') {
      ctx.setPendingChord(resolved.pending)
    }

    const unregister = ctx.registerHandler({
      action: 'chat:submit',
      context: 'Chat',
      handler: () => events.push('handler'),
    })
    events.push(String(ctx.invokeAction('chat:submit')))
    unregister()
    events.push(String(ctx.invokeAction('chat:submit')))
  }, [ctx, events])

  return <Text>active</Text>
}

describe('KeybindingContext', () => {
  test('returns undefined from the optional hook outside a provider', async () => {
    const seen: unknown[] = []
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(<OptionalProbe seen={seen} />)
      await waitForCondition(() => seen.length > 0, 'optional probe did not render')
      expect(seen[0]).toBeNull()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    }
  })

  test('provides display lookup, chord resolution, active contexts, and handlers', async () => {
    const bindings = parseBindings([
      {
        context: 'Chat',
        bindings: {
          enter: 'chat:submit',
          'ctrl+x ctrl+k': 'chat:killAgents',
        },
      },
    ])
    const pendingChordRef = { current: null as ParsedKeystroke[] | null }
    const activeContexts = new Set<KeybindingContextName>()
    const registryRef = { current: new Map() }
    const events: string[] = []
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <KeybindingProvider
          activeContexts={activeContexts}
          bindings={bindings}
          handlerRegistryRef={registryRef}
          pendingChord={pendingChordRef.current}
          pendingChordRef={pendingChordRef}
          registerActiveContext={context => activeContexts.add(context)}
          setPendingChord={pending => {
            pendingChordRef.current = pending
          }}
          unregisterActiveContext={context => activeContexts.delete(context)}
        >
          <ActiveProbe events={events} />
        </KeybindingProvider>,
      )

      await waitForCondition(
        () => events.includes('handler'),
        'registered keybinding handler did not run',
      )

      expect(activeContexts.has('Chat')).toBe(true)
      expect(pendingChordRef.current?.[0]?.key).toBe('x')
      expect(events).toEqual(['Enter', 'chord_started', 'handler', 'true', 'false'])
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    }

    expect(activeContexts.has('Chat')).toBe(false)
  })
})
