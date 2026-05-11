import figures from 'figures'
import { describe, expect, it, vi } from 'vitest'
import { renderToString } from '../../../utils/staticRender.js'
import {
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

  it('expands the full description under the selected slash-command row', async () => {
    const longDescription =
      'Run diagnostics across MCP, auth, sandbox, plugins, and the daemon; ' +
      'reports degraded subsystems with remediation steps for each issue.'
    const suggestions: SuggestionItem[] = [
      {
        id: 'command-help',
        displayText: '/help',
        description: 'Show help',
      },
      {
        id: 'command-doctor',
        displayText: '/doctor',
        description: longDescription,
      },
    ]

    const output = await renderToString(
      <PromptInputFooterSuggestions
        suggestions={suggestions}
        selectedSuggestion={1}
      />,
      80,
    )

    // The selected row exposes the tail of the description that the
    // single-line layout would have truncated.
    expect(output).toContain('plugins')
    expect(output).toContain('remediation')

    // The non-selected row stays single-line: no expanded line should
    // appear immediately below /help.
    const lines = output.split('\n')
    const helpLineIdx = lines.findIndex(line => line.includes('/help'))
    expect(helpLineIdx).toBeGreaterThanOrEqual(0)
    const nextLine = lines[helpLineIdx + 1] ?? ''
    expect(nextLine.includes('Show help')).toBe(false)
  })

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

    const visibleLines = output
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.length > 0)
    expect(visibleLines).toHaveLength(1)
    expect(visibleLines[0]).toContain('/noop')
  })
})
