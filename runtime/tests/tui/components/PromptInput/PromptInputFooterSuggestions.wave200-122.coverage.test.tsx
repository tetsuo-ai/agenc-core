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
  test('renders an inferred agent overlay window with overflow markers', async () => {
    const suggestions: SuggestionItem[] = Array.from({ length: 8 }, (_, index) => ({
      id: index === 1 ? `dm-user-${index}` : `agent-${index}`,
      displayText: `Agent ${index}`,
      description: `Handles phase ${index}`,
    }))

    const output = await renderToString(
      <PromptInputFooterSuggestions
        suggestions={suggestions}
        selectedSuggestion={4}
        overlay={true}
      />,
      { columns: 80, rows: 20 },
    )

    expect(output).toContain('AGENTS')
    expect(output).toContain('8 matches')
    expect(output).toContain('agent')
    expect(output).toContain('message')
    expect(output).toContain('↑ 2 more above')
    expect(output).toContain('↓ 1 more below')
    expect(output).toContain('* Agent 4 - Handles phase 4')
    expect(output).not.toContain('Agent 0')
    expect(output).not.toContain('Agent 7')
  })
})
