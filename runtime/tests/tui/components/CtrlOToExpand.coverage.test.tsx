import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

const shortcutMocks = vi.hoisted(() => ({
  getShortcutDisplay: vi.fn(() => 'cmd+e'),
}))

vi.mock('../keybindings/shortcutFormat.js', () => ({
  getShortcutDisplay: shortcutMocks.getShortcutDisplay,
}))

import { renderToString } from '../../utils/staticRender.js'
import { Box, Text } from '../ink.js'
import {
  CtrlOToExpand,
  SubAgentProvider,
  ctrlOToExpand,
} from './CtrlOToExpand.js'
import { InVirtualListContext } from './messageActions.js'

describe('CtrlOToExpand coverage', () => {
  test('renders the expand hint only outside suppressed contexts', async () => {
    const output = await renderToString(
      <Box flexDirection="column">
        <Box>
          <Text>visible </Text>
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
      </Box>,
      100,
    )

    expect(output).toContain('visible (ctrl+o to expand)')
    expect(output).toContain('subagent')
    expect(output).toContain('virtual')
    expect(output.match(/\bto expand\b/g) ?? []).toHaveLength(1)

    expect(stripAnsi(ctrlOToExpand())).toBe('(cmd+e to expand)')
    expect(shortcutMocks.getShortcutDisplay).toHaveBeenCalledWith(
      'app:toggleTranscript',
      'Global',
      'ctrl+o',
    )
  })
})
