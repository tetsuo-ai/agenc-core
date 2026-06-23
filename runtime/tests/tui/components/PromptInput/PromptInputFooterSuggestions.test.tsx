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

  it('labels non-command suggestions by their active suggestion type', async () => {
    const suggestions: SuggestionItem[] = [
      {
        id: 'file-readme',
        displayText: 'README.md',
        description: 'Project readme',
      },
    ]

    const output = await renderToString(
      <PromptInputFooterSuggestions
        suggestions={suggestions}
        selectedSuggestion={0}
        suggestionType="file"
      />,
      80,
    )

    expect(output).toContain('FILES & RESOURCES')
    expect(output).toContain('file')
    expect(output).toContain('insert')
    expect(output).not.toContain('SLASH COMMANDS')
  })

  it('uses the full terminal width in overlay mode so the popup aligns with the composer', () => {
    // The overlay popup floats directly above the composer box, which is
    // width="100%". Matching that full width (with no horizontal margin) keeps
    // the popup border corners flush with the composer border corners below.
    expect(getSuggestionPopupWidth(80, true)).toBe(80)
    expect(getSuggestionPopupWidth(12, true)).toBe(12)
  })

  it('aligns the overlay popup border corners with its content rows', async () => {
    // Revert-sensitive guard for the inset-border bug: when the overlay popup
    // used `columns - 2` width plus `marginX={1}`, the box drew at columns 1..N-2
    // while the composer below spanned 0..N-1, so the popup looked inset and
    // off-centre. The corners (┌┐└┘) and the content-row bars (│) must share
    // the same left/right columns AND span the full terminal width.
    const columns = 80
    const suggestions: SuggestionItem[] = [
      {
        id: 'command-help',
        displayText: '/help',
        description: 'Show help and available commands',
      },
    ]

    const output = await renderToString(
      <PromptInputFooterSuggestions
        suggestions={suggestions}
        selectedSuggestion={0}
        overlay={true}
      />,
      columns,
    )

    const lines = output.split('\n').filter(line => /[┌┐└┘│]/.test(line))
    expect(lines.length).toBeGreaterThanOrEqual(3)

    const leftCols = new Set<number>()
    const rightCols = new Set<number>()
    for (const line of lines) {
      // Box-drawing chars on a row: leftmost border and rightmost border.
      const left = line.search(/[┌└│]/)
      const right = line.length - 1 - [...line].reverse().findIndex(c => '┐┘│'.includes(c))
      leftCols.add(left)
      rightCols.add(right)
    }

    // Every bordered row (top corner, content bars, bottom corner) shares the
    // same left edge and the same right edge — no inset content rows.
    expect(leftCols.size).toBe(1)
    expect(rightCols.size).toBe(1)
    // And the popup spans the full terminal width so it lines up with the
    // composer box below it (left edge at column 0).
    expect([...leftCols][0]).toBe(0)
    expect([...rightCols][0]).toBe(columns - 1)
  })

  it('clamps inline popup width to tiny terminals instead of forcing the old minimum', () => {
    expect(getSuggestionPopupWidth(80, false)).toBe(70)
    expect(getSuggestionPopupWidth(48, false)).toBe(38)
    expect(getSuggestionPopupWidth(12, false)).toBe(2)
    expect(getSuggestionPopupWidth(8, false)).toBe(1)
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
      expect(output).toContain('navigate ^v - insert Enter')
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
