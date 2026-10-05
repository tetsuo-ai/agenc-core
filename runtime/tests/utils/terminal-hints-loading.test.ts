import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ componentLoads: 0, shortcut: 'ctrl+x' }))
vi.mock('../../src/tui/components/CtrlOToExpand.js', async original => {
  state.componentLoads++
  return original()
})
vi.mock('../../src/tui/keybindings/shortcutFormat.js', () => ({ getShortcutDisplay: () => state.shortcut }))

test('terminal text stays independent of the React component and reads the current shortcut', async () => {
  const { renderTruncatedContent } = await import('../../src/utils/terminal.js')
  const { ctrlOToExpand } = await import('../../src/utils/terminalHints.js')
  expect(state.componentLoads).toBe(0)
  const text = 'one\ntwo\nthree\nfour\nfive\nsix'
  expect(renderTruncatedContent(text, 80)).toContain('(ctrl+x to expand)')
  state.shortcut = 'alt+o'
  expect(ctrlOToExpand()).toContain('(alt+o to expand)')
  expect(renderTruncatedContent(text, 80, true)).not.toContain('to expand')
  expect(state.componentLoads).toBe(0)
  const component = await import('../../src/tui/components/CtrlOToExpand.js')
  expect(component.ctrlOToExpand).toBe(ctrlOToExpand)
  expect(state.componentLoads).toBe(1)
})
