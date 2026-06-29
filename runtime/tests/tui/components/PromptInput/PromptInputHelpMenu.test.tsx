import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToString } from '../../../utils/staticRender.js'

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

vi.mock('../../../utils/fastMode.js', () => ({
  isFastModeAvailable: () => false,
  isFastModeEnabled: () => false,
}))

vi.mock('../../../utils/platform.js', () => ({
  getPlatform: () => 'linux',
}))

describe('PromptInputHelpMenu', () => {
  it('stacks rows in a single column at narrow terminal widths (<100)', async () => {
    const { PromptInputHelpMenu } = await import('./PromptInputHelpMenu.js')
    const output = await renderToString(<PromptInputHelpMenu />, 80)

    const lines = output.split('\n')
    const bashLine = lines.find(line => line.includes('! for bash mode')) ?? ''
    const slashLine = lines.find(line => line.includes('/ for commands')) ?? ''
    const escLine =
      lines.find(line => line.includes('double tap esc to clear input')) ?? ''
    const undoLine = lines.find(line => line.includes('to undo')) ?? ''

    // Each shortcut hint should appear on its own line — no two columns
    // should share a single visual row at narrow widths.
    expect(bashLine).not.toMatch(/double tap esc/)
    expect(slashLine).not.toMatch(/to auto-accept edits|to cycle modes/)
    expect(escLine).not.toMatch(/! for bash mode|\/ for commands/)
    expect(undoLine).not.toMatch(/double tap esc/)
  })

  it('keeps the 3-column row layout at wide terminal widths (>=100)', async () => {
    const { PromptInputHelpMenu } = await import('./PromptInputHelpMenu.js')
    const output = await renderToString(<PromptInputHelpMenu />, 120)

    // At 120 columns, the first column's "! for bash mode" should appear
    // on the same visual row as the middle column's
    // "double tap esc to clear input".
    const sharedRow = output
      .split('\n')
      .find(
        line =>
          line.includes('! for bash mode') &&
          line.includes('double tap esc to clear input'),
      )
    expect(sharedRow).toBeDefined()
  })

  it('describes Shift+Tab as cycling modes', async () => {
    const { PromptInputHelpMenu } = await import('./PromptInputHelpMenu.js')
    const output = await renderToString(<PromptInputHelpMenu />, 120)

    expect(output).toContain('shift + tab to cycle modes')
    expect(output).not.toContain('shift + tab to auto-accept edits')
  })
})
