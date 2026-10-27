import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import {
  PromptInputFooterSuggestions,
  type SuggestionItem,
} from './PromptInputFooterSuggestions.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

describe('PromptInputFooterSuggestions wave200-122 coverage', () => {
  test('renders a windowed agent list under a fullscreen row budget', async () => {
    const suggestions: SuggestionItem[] = Array.from({ length: 8 }, (_, index) => ({
      id: index === 1 ? `dm-user-${index}` : `agent-${index}`,
      displayText: `Agent ${index}`,
      description: `Handles phase ${index}`,
    }))

    const output = await renderToString(
      <PromptInputFooterSuggestions
        suggestions={suggestions}
        selectedSuggestion={4}
        availableRows={5}
      />,
      { columns: 80, rows: 20 },
    )
    const rows = output.split('\n').filter(line => line.trim().length > 0)

    expect(rows).toHaveLength(5)
    expect(output).toContain('› * Agent 4 - Handles phase 4')
    expect(output).toContain('Agent 2')
    expect(output).toContain('Agent 6')
    expect(output).not.toContain('Agent 0')
    expect(output).not.toContain('Agent 7')
    expect(output).not.toContain('AGENTS')
    expect(output).not.toContain('matches')
    expect(output).not.toContain('more above')
    expect(output).not.toContain('more below')
  })
})
