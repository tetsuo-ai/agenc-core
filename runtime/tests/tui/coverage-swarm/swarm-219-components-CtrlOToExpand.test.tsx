import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

const shortcutMocks = vi.hoisted(() => ({
  getShortcutDisplay: vi.fn(() => 'ctrl+alt+o'),
}))

vi.mock('../../../src/tui/keybindings/shortcutFormat.js', () => ({
  getShortcutDisplay: shortcutMocks.getShortcutDisplay,
}))

import { renderToString } from '../../../src/utils/staticRender.js'
import { Box, Text } from '../../../src/tui/ink.js'
import { KeybindingProvider } from '../../../src/tui/keybindings/KeybindingContext.js'
import { parseBindings } from '../../../src/tui/keybindings/parser.js'
import type {
  KeybindingContextName,
  ParsedKeystroke,
} from '../../../src/tui/keybindings/types.js'
import {
  CtrlOToExpand,
  SubAgentProvider,
  ctrlOToExpand,
} from '../../../src/tui/components/CtrlOToExpand.js'
import { InVirtualListContext } from '../../../src/tui/components/messageActions.js'

describe('CtrlOToExpand coverage swarm 219', () => {
  test('uses configured transcript shortcut text when keybindings are available', async () => {
    const output = await renderToString(
      <ConfiguredKeybindings>
        <Box flexDirection="column">
          <Box>
            <Text>configured </Text>
            <CtrlOToExpand />
          </Box>
          <Box>
            <Text>subagent </Text>
            <SubAgentProvider>
              <CtrlOToExpand />
            </SubAgentProvider>
          </Box>
          <InVirtualListContext.Provider value={true}>
            <Box>
              <Text>virtual </Text>
              <CtrlOToExpand />
            </Box>
          </InVirtualListContext.Provider>
        </Box>
      </ConfiguredKeybindings>,
      100,
    )

    expect(output).toContain('configured (ctrl+shift+o to expand)')
    expect(output).toContain('subagent')
    expect(output).toContain('virtual')
    expect(output).not.toContain('(ctrl+o to expand)')
    expect(output.match(/\bto expand\b/g) ?? []).toHaveLength(1)
  })

  test('falls back inside a provider with no matching transcript binding', async () => {
    const output = await renderToString(
      <ConfiguredKeybindings action="chat:submit">
        <CtrlOToExpand />
      </ConfiguredKeybindings>,
      80,
    )

    expect(output).toContain('(ctrl+o to expand)')
  })

  test('keeps rerendered hint output stable and formats the non-React helper', async () => {
    const output = await renderToString(
      <ConfiguredKeybindings>
        <RerenderProbe />
      </ConfiguredKeybindings>,
      100,
    )

    expect(output).toContain('rerender (ctrl+shift+o to expand)')
    expect(output.match(/\bto expand\b/g) ?? []).toHaveLength(1)
    expect(stripAnsi(ctrlOToExpand())).toBe('(ctrl+alt+o to expand)')
    expect(shortcutMocks.getShortcutDisplay).toHaveBeenCalledWith(
      'app:toggleTranscript',
      'Global',
      'ctrl+o',
    )
  })
})

function ConfiguredKeybindings({
  action = 'app:toggleTranscript',
  children,
}: {
  readonly action?: string
  readonly children: React.ReactNode
}): React.ReactElement {
  const activeContexts = React.useMemo(() => new Set<KeybindingContextName>(), [])
  const handlerRegistryRef = React.useRef(new Map())
  const pendingChordRef = React.useRef<ParsedKeystroke[] | null>(null)
  const [pendingChord, setPendingChordState] =
    React.useState<ParsedKeystroke[] | null>(null)
  const bindings = React.useMemo(
    () =>
      parseBindings([
        {
          context: 'Global',
          bindings: {
            'ctrl+shift+o': action,
          },
        },
      ]),
    [action],
  )
  const setPendingChord = React.useCallback(
    (pending: ParsedKeystroke[] | null) => {
      pendingChordRef.current = pending
      setPendingChordState(pending)
    },
    [],
  )

  return (
    <KeybindingProvider
      activeContexts={activeContexts}
      bindings={bindings}
      handlerRegistryRef={handlerRegistryRef}
      pendingChord={pendingChord}
      pendingChordRef={pendingChordRef}
      registerActiveContext={context => activeContexts.add(context)}
      setPendingChord={setPendingChord}
      unregisterActiveContext={context => activeContexts.delete(context)}
    >
      {children}
    </KeybindingProvider>
  )
}

function RerenderProbe(): React.ReactElement {
  const [, forceRerender] = React.useState(0)
  const stableSubAgentChild = React.useMemo(() => <CtrlOToExpand />, [])

  React.useLayoutEffect(() => {
    forceRerender(1)
  }, [])

  return (
    <Box>
      <Text>rerender </Text>
      <CtrlOToExpand />
      <SubAgentProvider>{stableSubAgentChild}</SubAgentProvider>
    </Box>
  )
}
