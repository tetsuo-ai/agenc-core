import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToString } from '../../../utils/staticRender.js'
import { Box } from '../../ink.js'

const harness = vi.hoisted(() => ({ platform: 'linux' }))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../keybindings/useShortcutDisplay.js', () => ({
  useShortcutDisplay: (_action: string, _context: string, fallback: string) =>
    fallback,
}))

vi.mock('../../keybindings/loadUserBindings.js', () => ({
  isKeybindingCustomizationEnabled: () => false,
}))

vi.mock('../../../utils/platform.js', () => ({
  getPlatform: () => harness.platform,
}))

vi.mock('../../../utils/config.js', () => ({
  getRuntimeState: () => {
    throw new Error('global runtime state must not be read while rendering help')
  },
}))

describe('PromptInputHelpMenu', () => {
  it('keeps one prefix row and two compact shortcut columns at narrow widths (<100)', async () => {
    const { PromptInputHelpMenu } = await import('./PromptInputHelpMenu.js')
    const output = await renderToString(
      <PromptInputHelpMenu runtimeState={{}} />,
      80,
    )

    const lines = output.split('\n')
    const slashLine = lines.find(line => line.includes('commands'))
    const escLine =
      lines.find(line => line.includes('clear the prompt'))
    const undoLine = lines.find(line => line.includes('undo'))

    for (const line of [slashLine, escLine, undoLine]) expect(line).toBeDefined()
    expect(slashLine).toContain('! shell command')
    expect(slashLine).toContain('@ attach a file')
    expect(slashLine).not.toMatch(/change mode/)
    expect(escLine).not.toMatch(/shell command|commands/)
    expect(undoLine).not.toMatch(/clear the prompt/)
    expect(lines.find(line => line.includes('change mode'))).toContain('switch model')
    expect(lines.filter(line => line.trim())).toHaveLength(7)
    expect(output).toContain('show the to-do list')
    expect(output).not.toContain('run in the background')
    expect(output).not.toContain('&')
  })

  it('puts prefix, editing and viewing groups side by side at wide widths (>=100)', async () => {
    const { PromptInputHelpMenu } = await import('./PromptInputHelpMenu.js')
    const output = await renderToString(
      <PromptInputHelpMenu runtimeState={{}} />,
      120,
    )

    // The first row of each group shares a visual row on wide terminals.
    const sharedRow = output
      .split('\n')
      .find(
        line =>
          line.includes('commands') &&
          line.includes('change mode') &&
          line.includes('switch model'),
      )
    expect(sharedRow).toBeDefined()
    expect(output).toContain('show the to-do list')
    expect(output).not.toContain('run in the background')
  })

  it('keeps shortcut rows separate while the transcript yields room in a short parent', async () => {
    const { PromptInputHelpMenu } = await import('./PromptInputHelpMenu.js')
    const output = await renderToString(
      <Box height={7} flexDirection="column">
        <Box flexGrow={1} flexShrink={1}><Box height={3} /></Box>
        <PromptInputHelpMenu runtimeState={{}} />
      </Box>,
      { columns: 80, rows: 24 },
    )
    const lines = output.split('\n')
    const actions = ['change mode', 'new line', 'clear the prompt', 'set the prompt aside', 'edit in your editor', 'undo']
    const rowIndexes = actions.map(action => lines.findIndex(line => line.includes(action)))
    expect(rowIndexes.every(index => index >= 0)).toBe(true)
    expect(new Set(rowIndexes).size).toBe(actions.length)
    expect(output).toContain('show the to-do list')
  })

  it.each(['linux', 'windows', 'macos'])('advertises both mode keys on %s', async platform => {
    harness.platform = platform
    const { PromptInputHelpMenu } = await import('./PromptInputHelpMenu.js')
    const output = await renderToString(
      <PromptInputHelpMenu runtimeState={{}} />,
      120,
    )

    expect(output).toContain(`shift+tab or ${platform === 'macos' ? 'option' : 'alt'}+m`)
    expect(output).toContain('change mode')
    expect(output).not.toContain('auto-accept edits')
    harness.platform = 'linux'
  })

  it.each(['linux', 'windows', 'macos'])('formats keyboard names and undo on %s', async platform => {
    const { formatHelpKey } = await import('./PromptInputHelpMenu.js')
    const modifier = platform === 'macos' ? 'option' : 'alt'
    expect(formatHelpKey('meta+m', platform)).toBe(`${modifier}+m`)
    expect(formatHelpKey('alt+p', platform)).toBe(`${modifier}+p`)
    expect(formatHelpKey('ctrl+_', platform)).toBe('ctrl+shift+-')
    expect(formatHelpKey('ctrl+shift+o', platform)).toBe('ctrl+shift+o')
  })
})
