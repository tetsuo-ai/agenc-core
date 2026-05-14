import figures from 'figures'
import { describe, expect, it, vi } from 'vitest'
import { renderToString } from '../../../utils/staticRender.js'
import {
  getSuggestionPopupWidth,
  PromptInputFooterSuggestions,
  type SuggestionItem,
} from './PromptInputFooterSuggestions.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

describe('PromptInputFooterSuggestions', () => {
  it('renders a visible marker for the selected suggestion', async () => {
    const suggestions: SuggestionItem[] = [
      {
        id: 'command-help',
        displayText: '/help',
        description: 'Show help',
      },
      {
        id: 'command-doctor',
        displayText: '/doctor',
        description: 'Run diagnostics',
      },
    ]

    const output = await renderToString(
      <PromptInputFooterSuggestions
        suggestions={suggestions}
        selectedSuggestion={1}
      />,
      80,
    )

    expect(output).toContain(`${figures.pointer} /doctor`)
    expect(output).toContain('  /help')
  })

  it('renders the selected slash-command description exactly once', async () => {
    const description = 'Clear session history and caches'
    const suggestions: SuggestionItem[] = [
      {
        id: 'command-help',
        displayText: '/help',
        description: 'Show help',
      },
      {
        id: 'command-clear',
        displayText: '/clear',
        description,
      },
    ]

    const output = await renderToString(
      <PromptInputFooterSuggestions
        suggestions={suggestions}
        selectedSuggestion={1}
      />,
      80,
    )

    const lines = output.split('\n')
    const selectedRows = lines.filter(line => line.includes(description))
    expect(selectedRows).toHaveLength(1)
    expect(selectedRows[0]).toContain(`${figures.pointer} /clear`)

    const selectedLineWidth = selectedRows[0]?.length ?? 0
    expect(selectedLineWidth).toBeGreaterThan(60)
  })

  it.each([48, 80, 120])(
    'keeps the command header run hint visible at %i columns',
    async columns => {
      const suggestions: SuggestionItem[] = [
        {
          id: 'command-help',
          displayText: '/help',
          description: 'Show help',
        },
      ]

      const output = await renderToString(
        <PromptInputFooterSuggestions
          suggestions={suggestions}
          selectedSuggestion={0}
        />,
        columns,
      )

      expect(output).toContain('navigate ↑↓ · run ↵')
    },
  )

  it('omits the expanded line when the selected row has no description', async () => {
    const suggestions: SuggestionItem[] = [
      {
        id: 'command-noop',
        displayText: '/noop',
      },
    ]

    const output = await renderToString(
      <PromptInputFooterSuggestions
        suggestions={suggestions}
        selectedSuggestion={0}
      />,
      80,
    )

    expect(output).toContain('SLASH COMMANDS')
    expect(output).toContain('/noop')
    expect(output).not.toContain('undefined')
  })

  it('uses full overlay width so the popup background can cover the overlay row', () => {
    expect(getSuggestionPopupWidth(80, true)).toBe(78)
    expect(getSuggestionPopupWidth(12, true)).toBe(10)
  })

  it('renders ASCII glyphs when requested', async () => {
    const previousGlyphMode = process.env.AGENC_TUI_GLYPHS
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    try {
      const suggestions: SuggestionItem[] = [
        {
          id: 'mcp-resource-docs',
          displayText: 'docs',
          description: 'Project docs',
        },
      ]

      const output = await renderToString(
        <PromptInputFooterSuggestions
          suggestions={suggestions}
          selectedSuggestion={0}
          overlay={true}
        />,
        80,
      )

      expect(output).toContain('> * docs')
      expect(output).toContain('navigate ^v - run Enter')
      expect(output).not.toContain('◇')
      expect(output).not.toContain('❯')
      expect(output).not.toContain('↵')
    } finally {
      if (previousGlyphMode === undefined) {
        delete process.env.AGENC_TUI_GLYPHS
      } else {
        process.env.AGENC_TUI_GLYPHS = previousGlyphMode
      }
    }
  })
})
