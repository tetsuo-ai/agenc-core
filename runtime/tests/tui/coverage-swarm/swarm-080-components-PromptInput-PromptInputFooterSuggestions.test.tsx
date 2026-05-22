import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from 'src/utils/staticRender.js'
import {
  PromptInputFooterSuggestions,
  type SuggestionItem,
  type SuggestionType,
} from 'src/tui/components/PromptInput/PromptInputFooterSuggestions.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

beforeEach(() => {
  vi.stubEnv('AGENC_TUI_GLYPHS', 'ascii')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function renderSuggestions(
  suggestions: SuggestionItem[],
  options: {
    columns?: number
    overlay?: boolean
    rows?: number
    selectedSuggestion?: number
    suggestionType?: SuggestionType
  } = {},
): Promise<string> {
  return renderToString(
    <PromptInputFooterSuggestions
      suggestions={suggestions}
      selectedSuggestion={options.selectedSuggestion ?? 0}
      overlay={options.overlay}
      suggestionType={options.suggestionType}
    />,
    {
      columns: options.columns ?? 80,
      rows: options.rows ?? 20,
    },
  )
}

describe('PromptInputFooterSuggestions coverage swarm row 080', () => {
  test('renders nothing for empty suggestions', async () => {
    await expect(renderSuggestions([]).then(output => output.trim())).resolves.toBe('')
  })

  test.each([
    ['shell', 'SHELL COMPLETIONS', 'shell', 'complete'],
    ['custom-title', 'SESSION TITLES', 'session', 'resume'],
    ['slack-channel', 'SLACK CHANNELS', 'channel', 'mention'],
    ['none', 'SUGGESTIONS', 'suggestion', 'select'],
  ] as const)(
    'renders explicit %s copy in the header and keyboard hint',
    async (suggestionType, title, label, acceptVerb) => {
      const output = await renderSuggestions(
        [
          {
            id: `${suggestionType}-first`,
            displayText: 'candidate',
            description: 'Primary candidate',
          },
        ],
        { suggestionType },
      )

      expect(output).toContain(title)
      expect(output).toContain('1 match')
      expect(output).toContain(label)
      expect(output).toContain(`navigate ^v - ${acceptVerb} Enter`)
    },
  )

  test('infers directory suggestions and uses terminal height for inline overflow', async () => {
    const suggestions: SuggestionItem[] = Array.from(
      { length: 4 },
      (_, index) => ({
        id: `directory-${index}`,
        displayText: `dir-${index}`,
        description: `Directory   number ${index}`,
      }),
    )

    const output = await renderSuggestions(suggestions, {
      columns: 64,
      rows: 4,
      selectedSuggestion: 2,
    })

    expect(output).toContain('DIRECTORIES')
    expect(output).toContain('4 matches')
    expect(output).toContain('directory')
    expect(output).toContain('navigate ^v - insert Enter')
    expect(output).toContain('^ 2 more above')
    expect(output).toContain('v 1 more below')
    expect(output).toContain('> dir-2')
    expect(output).toContain('Directory number 2')
    expect(output).not.toContain('dir-0')
    expect(output).not.toContain('dir-3')
  })

  test('truncates long file paths and keeps unified rows single-line', async () => {
    const longPath =
      '/repo/packages/deep/nested/src/components/VeryLongComponentFileName.tsx'
    const output = await renderSuggestions(
      [
        {
          id: 'file-long',
          displayText: longPath,
          description: 'Detailed   TypeScript   component file',
        },
        {
          id: 'file-readme',
          displayText: 'README.md',
        },
      ],
      {
        columns: 80,
        selectedSuggestion: 0,
      },
    )

    expect(output).toContain('FILES & RESOURCES')
    expect(output).toContain('> + ')
    expect(output).toContain(' - Detailed TypeScript')
    expect(output).toContain('  + README.md')
    expect(output).not.toContain(longPath)
  })

  test('keeps fallback suggestions usable with an out-of-range selection', async () => {
    const output = await renderSuggestions(
      [
        {
          id: 'custom-alpha',
          displayText: 'alpha',
          tag: 'hot',
          description: 'Alpha   branch   details',
          color: 'success',
        },
        {
          id: 'custom-beta',
          displayText: 'beta',
          description: 'Beta branch details',
        },
      ],
      {
        selectedSuggestion: 99,
      },
    )

    expect(output).toContain('SUGGESTIONS')
    expect(output).toContain('2 matches')
    expect(output).toContain('navigate ^v - select Enter')
    expect(output).toContain('[hot] Alpha branch details')
    expect(output).toContain('beta')
    expect(output).not.toContain('> alpha')
    expect(output).not.toContain('> beta')
  })
})
