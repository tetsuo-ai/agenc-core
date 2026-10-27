import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  renderToAnsiString,
  renderToString,
} from '../../../utils/staticRender.js'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import { getTheme, type ThemeName } from '../../../utils/theme.js'
import {
  getSuggestionListWidth,
  PromptInputFooterSuggestions,
  type SuggestionItem,
} from './PromptInputFooterSuggestions.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

/** Column of the typed text in the prompt band: margin 2, padding 1, glyph 2. */
const PROMPT_TEXT_COLUMN = 5

const BUILTINS: SuggestionItem[] = [
  { id: 'agents:local', displayText: '/agents', description: 'Manage agents (opens a picker)' },
  { id: 'budget:local', displayText: '/budget', description: 'Show or set the task budget' },
  { id: 'clear:local', displayText: '/clear', description: 'Clear session history and caches' },
  { id: 'compact:local', displayText: '/compact', description: 'Compact the current conversation' },
  { id: 'compact-retain:local', displayText: '/compact-retain', description: 'Extend a compaction rollback-retention deadline' },
  { id: 'config:local', displayText: '/config', description: 'Manage configuration (opens a picker)' },
  { id: 'cost:local', displayText: '/cost', description: 'Show session cost and token usage' },
]

/** A shared catalog the size of the one that produced "1917 matches". */
function catalog(count: number): SuggestionItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `skill-${index}:userSettings`,
    displayText: `/vendor-${String(index).padStart(4, '0')}-guide`,
    tag: 'user',
    description: `Synthetic skill ${index}`,
  }))
}

function render(
  suggestions: SuggestionItem[],
  selectedSuggestion: number,
  options: { columns?: number; rows?: number; availableRows?: number } = {},
): Promise<string> {
  return renderToString(
    <PromptInputFooterSuggestions
      suggestions={suggestions}
      selectedSuggestion={selectedSuggestion}
      availableRows={options.availableRows}
    />,
    { columns: options.columns ?? 80, rows: options.rows ?? 30 },
  )
}

function lines(output: string): string[] {
  return output.split('\n').filter(line => line.trim().length > 0)
}

type Cell = {
  readonly ch: string
  readonly fg: string | undefined
  readonly bg: string | undefined
  readonly bold: boolean
}

/** Replay SGR codes over one rendered line and keep each cell's style. */
function styledCells(line: string): Cell[] {
  const cells: Cell[] = []
  let fg: string | undefined
  let bg: string | undefined
  let bold = false
  const tokens = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|([^\x1b])/gu
  for (const match of line.matchAll(tokens)) {
    if (match[2] !== undefined) {
      cells.push({ ch: match[2], fg, bg, bold })
      continue
    }
    if (match[1] === undefined) continue
    const codes = match[1] === '' ? [0] : match[1].split(';').map(Number)
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index]
      if (code === 0) {
        fg = undefined
        bg = undefined
        bold = false
      } else if (code === 1) bold = true
      else if (code === 22) bold = false
      else if (code === 39) fg = undefined
      else if (code === 49) bg = undefined
      else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
        const color = `rgb(${codes[index + 2]},${codes[index + 3]},${codes[index + 4]})`
        if (code === 38) fg = color
        else bg = color
        index += 4
      }
    }
  }
  return cells
}

function cellsText(cells: readonly Cell[]): string {
  return cells.map(cell => cell.ch).join('')
}

function token(theme: ThemeName, name: 'muted3' | 'text' | 'inactive' | 'promptBackground'): string {
  return getTheme(theme)[name].replace(/\s+/gu, '')
}

describe('PromptInputFooterSuggestions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('draws only rows: no frame, title, count, scroll markers or key hints', async () => {
    const suggestions = [...BUILTINS, ...catalog(1_800)]
    const output = await render(suggestions, 3)

    const rows = lines(output)
    expect(rows).toHaveLength(6)
    expect(output).not.toMatch(/[┌┐└┘│─]/u)
    expect(output).not.toContain('SLASH COMMANDS')
    expect(output).not.toMatch(/\d+ match/u)
    expect(output).not.toContain('more above')
    expect(output).not.toContain('more below')
    expect(output).not.toContain('navigate')
    expect(output).not.toContain('esc close')
    expect(output).not.toContain('type to filter')
  })

  it('marks the selected row with › and lines names up under the prompt text', async () => {
    const output = await render(BUILTINS.slice(0, 3), 1)
    const rows = lines(output)

    expect(rows[1]).toMatch(/^ {3}› \/budget/u)
    expect(rows[0]).toMatch(/^ {5}\/agents/u)
    expect(rows[2]).toMatch(/^ {5}\/clear/u)
    expect(output.match(/›/gu)).toHaveLength(1)
    expect(output).not.toContain('❯')
    for (const row of rows) {
      expect(row.indexOf('/')).toBe(PROMPT_TEXT_COLUMN)
    }
  })

  it('sizes the name column to the longest visible name plus two spaces', async () => {
    const rows = lines(await render(BUILTINS.slice(2, 6), 0))
    const longest = Math.max(...BUILTINS.slice(2, 6).map(item => item.displayText.length))

    for (const row of rows) {
      const descriptionColumn = row.search(/[A-Z]/u)
      expect(descriptionColumn).toBe(PROMPT_TEXT_COLUMN + longest + 2)
    }
  })

  it('does not widen the name column for a long name outside the window', async () => {
    const suggestions: SuggestionItem[] = [
      ...BUILTINS.slice(0, 3),
      ...catalog(10),
      { id: 'long:userSettings', displayText: '/a-very-long-skill-name-that-is-not-visible', description: 'Hidden' },
    ]
    const rows = lines(await render(suggestions, 0))

    expect(rows.join('\n')).not.toContain('a-very-long')
    const longestVisible = Math.max(
      ...suggestions.slice(0, 6).map(item => item.displayText.length),
    )
    expect(rows[0]!.indexOf('Manage agents')).toBe(PROMPT_TEXT_COLUMN + longestVisible + 2)
  })

  it('keeps the window around the selection as it moves through a long list', async () => {
    const suggestions = [...BUILTINS, ...catalog(1_800)]
    const output = await render(suggestions, 500)
    const rows = lines(output)

    expect(rows).toHaveLength(6)
    expect(output).toContain('› /vendor-0493-guide')
    expect(output).not.toContain('/agents')
  })

  it('shows no more rows than the caller can give', async () => {
    const suggestions = [...BUILTINS, ...catalog(20)]
    expect(lines(await render(suggestions, 0, { availableRows: 3 }))).toHaveLength(3)
    expect((await render(suggestions, 0, { availableRows: 0 })).trim()).toBe('')
  })

  it('truncates descriptions to the row instead of wrapping', async () => {
    const output = await render(BUILTINS, 0, { columns: 40 })
    const rows = output.split('\n').filter(line => line.trim().length > 0)

    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(40)
    }
    expect(output).toContain('…')
  })

  it('uses the ASCII marker when ASCII glyphs are requested', async () => {
    vi.stubEnv('AGENC_TUI_GLYPHS', 'ascii')
    const output = await render(BUILTINS.slice(0, 2), 0)

    expect(lines(output)[0]).toMatch(/^ {3}> \/agents/u)
    expect(output).not.toContain('›')
  })

  it('keeps file, resource and agent rows on one line with their icon', async () => {
    const longPath = '/repo/packages/deep/nested/src/components/VeryLongComponentFileName.tsx'
    const output = await render(
      [
        { id: 'file-long', displayText: longPath, description: 'Detailed   TypeScript   component file' },
        { id: 'file-readme', displayText: 'README.md' },
        { id: 'agent-reviewer', displayText: 'reviewer', description: 'Reviews diffs' },
      ],
      0,
    )
    const rows = lines(output)

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatch(/^ {3}› \+ /u)
    expect(rows[0]).toContain(' - Detailed TypeScript')
    expect(output).not.toContain(longPath)
    expect(rows[1]).toMatch(/^ {5}\+ README\.md$/u)
    expect(rows[2]).toMatch(/^ {5}\* reviewer - Reviews diffs$/u)
  })

  it('renders nothing for an empty list', async () => {
    expect((await render([], 0)).trim()).toBe('')
  })

  it('matches the prompt band width', () => {
    expect(getSuggestionListWidth(80)).toBe(76)
    expect(getSuggestionListWidth(5)).toBe(1)
    expect(getSuggestionListWidth(2)).toBe(1)
  })

  describe.each(['olive', 'light', 'dark'] as const)('in the %s theme', theme => {
    async function renderColored(selected: number): Promise<Cell[][]> {
      const ansi = await renderToAnsiString(
        <ThemeProvider initialState={theme}>
          <PromptInputFooterSuggestions
            suggestions={BUILTINS.slice(0, 3)}
            selectedSuggestion={selected}
          />
        </ThemeProvider>,
        { columns: 80, rows: 30, color: true },
      )
      return ansi
        .split('\n')
        .map(styledCells)
        .filter(cells => cellsText(cells).trim().length > 0)
    }

    it('fills only the selected row, with a muted gray from the theme', async () => {
      const rows = await renderColored(1)
      const listWidth = getSuggestionListWidth(80)
      const selected = rows.find(cells => cellsText(cells).includes('›'))!
      const others = rows.filter(cells => cells !== selected)

      // The fill spans the prompt band's width and nothing outside it.
      const filled = selected.slice(2, 2 + listWidth)
      expect(new Set(filled.map(cell => cell.bg))).toEqual(new Set([token(theme, 'muted3')]))
      expect(selected.slice(0, 2).every(cell => cell.bg === undefined)).toBe(true)
      for (const cells of others) {
        expect(cells.every(cell => cell.bg === undefined)).toBe(true)
      }
      // A gray step, not an inverse bar, and never the prompt band's own fill.
      expect(token(theme, 'muted3')).not.toBe(token(theme, 'text'))
      expect(token(theme, 'muted3')).not.toBe(token(theme, 'promptBackground'))
    })

    it('makes the selected name bold in full ink and dims only other descriptions', async () => {
      const rows = await renderColored(1)
      const selected = rows.find(cells => cellsText(cells).includes('›'))!
      const other = rows.find(cells => cellsText(cells).includes('/agents'))!
      const at = (cells: Cell[], text: string): Cell => cells[cellsText(cells).indexOf(text)]!

      expect(at(selected, '›')).toMatchObject({ fg: token(theme, 'text'), bold: true })
      expect(at(selected, '/budget')).toMatchObject({ fg: token(theme, 'text'), bold: true })
      expect(at(selected, 'Show or set')).toMatchObject({ fg: token(theme, 'text'), bold: false })
      expect(at(other, '/agents')).toMatchObject({ fg: token(theme, 'text'), bold: false })
      expect(at(other, 'Manage agents')).toMatchObject({ fg: token(theme, 'inactive'), bold: false })
    })
  })

})
